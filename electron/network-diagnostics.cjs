'use strict'

const fs = require('node:fs')
const path = require('node:path')
const {
  describeValue,
  sanitizeAssociatedCookies,
  sanitizeBlockedResponseCookies,
  sanitizeHeaders,
  sanitizeInitiator,
  sanitizeRemoteAddress,
  sanitizeSecurityDetails,
  sanitizeTiming,
  sanitizeUrl,
} = require('./network-audit-utils.cjs')

const NETWORK_EVENTS = new Set([
  'Network.requestWillBeSent',
  'Network.requestWillBeSentExtraInfo',
  'Network.responseReceived',
  'Network.responseReceivedExtraInfo',
  'Network.loadingFinished',
  'Network.loadingFailed',
  'Network.webSocketCreated',
  'Network.webSocketWillSendHandshakeRequest',
  'Network.webSocketHandshakeResponseReceived',
  'Network.webSocketFrameSent',
  'Network.webSocketFrameReceived',
  'Network.webSocketClosed',
  'Network.webSocketFrameError',
])

const PAGE_SNAPSHOT_EXPRESSION = `(() => {
  const uaData = navigator.userAgentData;
  return {
    location: location.href,
    navigator: {
      userAgent: navigator.userAgent,
      webdriver: navigator.webdriver,
      language: navigator.language,
      languages: Array.from(navigator.languages || []),
      platform: navigator.platform,
      userAgentData: uaData ? {
        brands: Array.from(uaData.brands || []).map(item => ({ brand: item.brand, version: item.version })),
        mobile: uaData.mobile,
        platform: uaData.platform,
      } : null,
    },
    document: {
      visibilityState: document.visibilityState,
      hasFocus: document.hasFocus(),
    },
    viewport: {
      innerWidth,
      innerHeight,
      outerWidth,
      outerHeight,
      devicePixelRatio,
      screenWidth: screen.width,
      screenHeight: screen.height,
    },
  };
})()`

function sanitizePageSnapshot(value) {
  if (!value || typeof value !== 'object') return null
  return {
    location: sanitizeUrl(value.location),
    navigator: {
      userAgent: String(value.navigator?.userAgent || ''),
      webdriver: value.navigator?.webdriver ?? null,
      language: String(value.navigator?.language || ''),
      languages: Array.isArray(value.navigator?.languages)
        ? value.navigator.languages.map(String).slice(0, 16)
        : [],
      platform: String(value.navigator?.platform || ''),
      userAgentData: value.navigator?.userAgentData
        ? {
            brands: Array.isArray(value.navigator.userAgentData.brands)
              ? value.navigator.userAgentData.brands.map(item => ({
                  brand: String(item?.brand || ''),
                  version: String(item?.version || ''),
                })).slice(0, 16)
              : [],
            mobile: Boolean(value.navigator.userAgentData.mobile),
            platform: String(value.navigator.userAgentData.platform || ''),
          }
        : null,
    },
    document: {
      visibilityState: String(value.document?.visibilityState || ''),
      hasFocus: Boolean(value.document?.hasFocus),
    },
    viewport: Object.fromEntries(
      Object.entries(value.viewport || {})
        .filter(([, number]) => typeof number === 'number' && Number.isFinite(number))
        .map(([name, number]) => [name, number]),
    ),
  }
}

function payloadMetadata(payloadData, opcode) {
  if (payloadData == null) return { present: false }
  const encoding = Number(opcode) === 2 ? 'base64' : 'utf8'
  let length
  try { length = Buffer.byteLength(String(payloadData), encoding) } catch { length = String(payloadData).length }
  return {
    ...describeValue(payloadData, { encoding }),
    length,
    encoding,
  }
}

function postDataMetadata(request = {}) {
  const mimeType = String(request.headers?.['Content-Type'] || request.headers?.['content-type'] || '')
    .split(';', 1)[0]
    .trim()
    .toLowerCase()
  if (request.postData != null) {
    return {
      ...describeValue(request.postData),
      mimeType,
    }
  }
  return {
    present: Boolean(request.hasPostData),
    type: null,
    length: null,
    sha256: null,
    mimeType,
  }
}

function safeProtocolText(value) {
  const text = String(value || '')
  if (!text) return ''
  if (/^net::ERR_[A-Z0-9_]+$/.test(text)) return text
  if (/^(?:OK|Created|Accepted|No Content|Partial Content|Moved Permanently|Found|Not Modified|Bad Request|Unauthorized|Forbidden|Not Found|Conflict|Gone|Too Many Requests|Internal Server Error|Bad Gateway|Service Unavailable|Gateway Timeout|WebSocket Protocol Handshake)$/i.test(text)) {
    return text
  }
  return describeValue(text)
}

class CdpNetworkRecorder {
  constructor({
    webContents,
    outputDir,
    logger = console,
    fsImpl = fs,
    now = () => new Date(),
    monotonicNow = () => Number(process.hrtime.bigint()) / 1e6,
    maxEvents = 100_000,
    source = 'electron-webcontents-cdp',
  }) {
    if (!webContents || !webContents.debugger) throw new TypeError('embedded webContents debugger is required')
    this.webContents = webContents
    this.outputDir = outputDir
    this.logger = logger
    this.fs = fsImpl
    this.now = now
    this.monotonicNow = monotonicNow
    this.maxEvents = maxEvents
    this.source = source
    this.started = false
    this.stopped = false
    this.attachedByRecorder = false
    this.startMonotonic = 0
    this.requestSequence = 0
    this.connectionSequence = 0
    this.requestKeys = new Map()
    this.connectionKeys = new Map()
    this.outputPath = null
    this.capture = null
    this._onMessage = this._onMessage.bind(this)
    this._onDetach = this._onDetach.bind(this)
  }

  async start() {
    if (this.started && !this.stopped) return this.capture
    if (this.webContents.isDestroyed?.()) throw new Error('embedded browser page is closed')
    if (this.webContents.debugger.isAttached()) {
      throw new Error('embedded page already has an Electron debugger attached; close DevTools or the other debugger first')
    }

    const startedAt = this.now()
    this.startMonotonic = this.monotonicNow()
    this.capture = {
      schemaVersion: 1,
      kind: 'alice-network-audit',
      source: this.source,
      redactedBeforeWrite: true,
      observerOnly: true,
      startedAt: startedAt.toISOString(),
      endedAt: null,
      durationMs: null,
      stopReason: null,
      tool: {
        cdpProtocolVersion: '1.3',
        responseBodiesCaptured: false,
        requestInterceptionEnabled: false,
        cacheConfigurationChanged: false,
        payloadPolicy: 'metadata-only',
      },
      pageSnapshots: [],
      events: [],
      droppedEventCount: 0,
      errors: [],
    }

    this.webContents.debugger.attach('1.3')
    this.attachedByRecorder = true
    this.webContents.debugger.on('message', this._onMessage)
    this.webContents.debugger.on('detach', this._onDetach)
    try {
      await this.webContents.debugger.sendCommand('Network.enable')
      this.started = true
      await this.capturePageSnapshot('start')
      return this.capture
    } catch (error) {
      this._removeListeners()
      if (this.attachedByRecorder && this.webContents.debugger.isAttached()) {
        try { this.webContents.debugger.detach() } catch {}
      }
      this.attachedByRecorder = false
      throw error
    }
  }

  relativeTime() {
    return Math.max(0, Math.round((this.monotonicNow() - this.startMonotonic) * 1000) / 1000)
  }

  requestKey(requestId, { create = false, redirect = false } = {}) {
    const id = String(requestId || '')
    if (!id) return null
    if (create && (!this.requestKeys.has(id) || redirect)) {
      this.requestSequence += 1
      this.requestKeys.set(id, `r${this.requestSequence}`)
    }
    return this.requestKeys.get(id) || null
  }

  connectionKey(connectionId) {
    if (connectionId == null || connectionId === '') return null
    const id = String(connectionId)
    if (!this.connectionKeys.has(id)) {
      this.connectionSequence += 1
      this.connectionKeys.set(id, `c${this.connectionSequence}`)
    }
    return this.connectionKeys.get(id)
  }

  sanitizeResponse(response = {}) {
    return {
      url: sanitizeUrl(response.url),
      status: Number(response.status) || 0,
      statusText: safeProtocolText(response.statusText),
      headers: sanitizeHeaders(response.headers),
      headersTextOmitted: Boolean(response.headersText),
      mimeType: response.mimeType || null,
      charset: response.charset || null,
      protocol: response.protocol || null,
      remoteAddress: sanitizeRemoteAddress(response.remoteIPAddress, response.remotePort),
      connectionId: this.connectionKey(response.connectionId),
      connectionReused: response.connectionReused ?? null,
      fromDiskCache: Boolean(response.fromDiskCache),
      fromServiceWorker: Boolean(response.fromServiceWorker),
      fromPrefetchCache: Boolean(response.fromPrefetchCache),
      fromEarlyHints: Boolean(response.fromEarlyHints),
      serviceWorkerResponseSource: response.serviceWorkerResponseSource || null,
      responseTimePresent: Number.isFinite(response.responseTime),
      timing: sanitizeTiming(response.timing),
      securityState: response.securityState || null,
      securityDetails: sanitizeSecurityDetails(response.securityDetails),
    }
  }

  sanitizeEvent(method, params = {}) {
    switch (method) {
      case 'Network.requestWillBeSent': {
        const request = params.request || {}
        return {
          requestKey: this.requestKey(params.requestId, {
            create: true,
            redirect: Boolean(params.redirectResponse),
          }),
          data: {
            url: sanitizeUrl(request.url),
            documentUrl: sanitizeUrl(params.documentURL),
            method: String(request.method || 'GET').toUpperCase(),
            resourceType: params.type || null,
            initiator: sanitizeInitiator(params.initiator),
            hasUserGesture: request.hasUserGesture ?? null,
            headers: sanitizeHeaders(request.headers),
            postData: postDataMetadata(request),
            redirectResponse: params.redirectResponse ? this.sanitizeResponse(params.redirectResponse) : null,
          },
        }
      }
      case 'Network.requestWillBeSentExtraInfo':
        return {
          // CDP explicitly does not guarantee whether ExtraInfo or the base
          // event arrives first. Allocate the normalized key on either side.
          requestKey: this.requestKey(params.requestId, { create: true }),
          data: {
            headers: sanitizeHeaders(params.headers),
            headersTextOmitted: Boolean(params.headersText),
            associatedCookies: sanitizeAssociatedCookies(params.associatedCookies),
            connectTiming: sanitizeTiming(params.connectTiming),
            clientSecurityState: params.clientSecurityState ? {
              initiatorIsSecureContext: params.clientSecurityState.initiatorIsSecureContext ?? null,
              initiatorIPAddressSpace: params.clientSecurityState.initiatorIPAddressSpace || null,
              privateNetworkRequestPolicy: params.clientSecurityState.privateNetworkRequestPolicy || null,
            } : null,
            siteHasCookieInOtherPartition: params.siteHasCookieInOtherPartition ?? null,
          },
        }
      case 'Network.responseReceived':
        return {
          requestKey: this.requestKey(params.requestId, { create: true }),
          data: { ...this.sanitizeResponse(params.response), resourceType: params.type || null },
        }
      case 'Network.responseReceivedExtraInfo':
        return {
          requestKey: this.requestKey(params.requestId, { create: true }),
          data: {
            statusCode: Number(params.statusCode) || 0,
            headers: sanitizeHeaders(params.headers),
            headersTextOmitted: Boolean(params.headersText),
            blockedCookies: sanitizeBlockedResponseCookies(params.blockedCookies),
            cookiePartitionKey: params.cookiePartitionKey ? {
              topLevelSite: params.cookiePartitionKey.topLevelSite
                ? sanitizeUrl(params.cookiePartitionKey.topLevelSite)
                : null,
              hasCrossSiteAncestor: params.cookiePartitionKey.hasCrossSiteAncestor ?? null,
            } : null,
            cookiePartitionKeyOpaque: params.cookiePartitionKeyOpaque ?? null,
          },
        }
      case 'Network.loadingFinished':
        return {
          requestKey: this.requestKey(params.requestId, { create: true }),
          data: { encodedDataLength: Number(params.encodedDataLength) || 0 },
        }
      case 'Network.loadingFailed':
        return {
          requestKey: this.requestKey(params.requestId, { create: true }),
          data: {
            resourceType: params.type || null,
            errorText: safeProtocolText(params.errorText),
            canceled: Boolean(params.canceled),
            blockedReason: params.blockedReason || null,
            corsErrorStatus: params.corsErrorStatus || null,
          },
        }
      case 'Network.webSocketCreated':
        return {
          requestKey: this.requestKey(params.requestId, { create: true }),
          data: { url: sanitizeUrl(params.url), initiator: sanitizeInitiator(params.initiator) },
        }
      case 'Network.webSocketWillSendHandshakeRequest':
        return {
          requestKey: this.requestKey(params.requestId, { create: true }),
          data: { headers: sanitizeHeaders(params.request?.headers) },
        }
      case 'Network.webSocketHandshakeResponseReceived':
        return {
          requestKey: this.requestKey(params.requestId, { create: true }),
          data: {
            status: Number(params.response?.status) || 0,
            statusText: safeProtocolText(params.response?.statusText),
            headers: sanitizeHeaders(params.response?.headers),
            requestHeaders: sanitizeHeaders(params.response?.requestHeaders),
            headersTextOmitted: Boolean(params.response?.headersText || params.response?.requestHeadersText),
          },
        }
      case 'Network.webSocketFrameSent':
      case 'Network.webSocketFrameReceived':
        return {
          requestKey: this.requestKey(params.requestId, { create: true }),
          data: {
            opcode: Number(params.response?.opcode) || 0,
            mask: Boolean(params.response?.mask),
            payload: payloadMetadata(params.response?.payloadData, params.response?.opcode),
          },
        }
      case 'Network.webSocketClosed':
        return { requestKey: this.requestKey(params.requestId, { create: true }), data: {} }
      case 'Network.webSocketFrameError':
        return {
          requestKey: this.requestKey(params.requestId, { create: true }),
          data: { errorMessage: describeValue(params.errorMessage) },
        }
      default:
        return null
    }
  }

  _onMessage(_event, method, params) {
    if (this.stopped || !NETWORK_EVENTS.has(method)) return
    if (this.capture.events.length >= this.maxEvents) {
      this.capture.droppedEventCount += 1
      return
    }
    try {
      const sanitized = this.sanitizeEvent(method, params)
      if (!sanitized) return
      this.capture.events.push({
        name: method,
        tMs: this.relativeTime(),
        requestKey: sanitized.requestKey,
        data: sanitized.data,
      })
    } catch (error) {
      this.capture.errors.push({
        stage: 'sanitize-event',
        event: method,
        error: describeValue(String(error?.message || error).slice(0, 500)),
      })
    }
  }

  _onDetach(_event, reason) {
    if (this.stopped) return
    this.attachedByRecorder = false
    this.stop({ reason: `debugger-detached:${String(reason || 'unknown')}`, disableNetwork: false })
      .then(result => {
        this.logger.info?.(`[network-diagnostics] debugger detached; redacted capture saved to ${result.path}`)
      })
      .catch(error => {
        this.logger.error?.('[network-diagnostics] unable to finalize detached capture:', error?.message || error)
      })
  }

  async capturePageSnapshot(stage) {
    if (!this.webContents.debugger.isAttached()) return null
    try {
      const result = await this.webContents.debugger.sendCommand('Runtime.evaluate', {
        expression: PAGE_SNAPSHOT_EXPRESSION,
        returnByValue: true,
        awaitPromise: false,
        userGesture: false,
      })
      const snapshot = sanitizePageSnapshot(result?.result?.value)
      if (snapshot) this.capture.pageSnapshots.push({ stage, tMs: this.relativeTime(), value: snapshot })
      return snapshot
    } catch (error) {
      this.capture.errors.push({
        stage: `page-snapshot:${stage}`,
        error: describeValue(String(error?.message || error).slice(0, 500)),
      })
      return null
    }
  }

  _removeListeners() {
    this.webContents.debugger.removeListener('message', this._onMessage)
    this.webContents.debugger.removeListener('detach', this._onDetach)
  }

  writeCapture() {
    if (this.outputPath) return this.outputPath
    this.fs.mkdirSync(this.outputDir, { recursive: true })
    const safeTimestamp = this.capture.startedAt.replace(/[:.]/g, '-')
    const filename = `alice-network-${safeTimestamp}.json`
    const destination = path.join(this.outputDir, filename)
    const temporary = `${destination}.tmp`
    this.fs.writeFileSync(temporary, `${JSON.stringify(this.capture, null, 2)}\n`, { mode: 0o600 })
    this.fs.renameSync(temporary, destination)
    this.outputPath = destination
    return destination
  }

  async stop({ reason = 'manual', disableNetwork = true } = {}) {
    if (this.stopped) return { path: this.outputPath, capture: this.capture }
    this.stopped = true
    if (this.webContents.debugger.isAttached()) {
      await this.capturePageSnapshot('stop')
      if (disableNetwork) {
        try { await this.webContents.debugger.sendCommand('Network.disable') } catch {}
      }
    }
    this._removeListeners()
    if (this.attachedByRecorder && this.webContents.debugger.isAttached()) {
      try { this.webContents.debugger.detach() } catch {}
    }
    this.attachedByRecorder = false
    const endedAt = this.now()
    this.capture.endedAt = endedAt.toISOString()
    this.capture.durationMs = this.relativeTime()
    this.capture.stopReason = reason
    const outputPath = this.writeCapture()
    return { path: outputPath, capture: this.capture }
  }
}

function createNetworkDiagnostics({
  enabled,
  getWebContents,
  outputDir,
  logger = console,
  RecorderClass = CdpNetworkRecorder,
} = {}) {
  let recorder = null

  function clearStoppedRecorder() {
    if (recorder?.stopped) recorder = null
  }

  function requireEnabled() {
    if (!enabled) {
      throw new Error('network diagnostics are disabled; use a development build or set ALICE_NETWORK_DIAGNOSTICS=1 before launch')
    }
  }

  function requireWebContents() {
    const contents = getWebContents?.()
    if (!contents || contents.isDestroyed?.()) throw new Error('open the embedded browser page before using network diagnostics')
    return contents
  }

  return {
    enabled: Boolean(enabled),
    isRecording: () => Boolean(recorder && !recorder.stopped),
    async openDevTools() {
      requireEnabled()
      clearStoppedRecorder()
      if (recorder) throw new Error('stop the network recording before opening embedded-page DevTools')
      const contents = requireWebContents()
      contents.openDevTools({ mode: 'detach', activate: true })
      return { ok: true, webContentsId: contents.id }
    },
    async start() {
      requireEnabled()
      clearStoppedRecorder()
      if (recorder) return { recording: true, startedAt: recorder.capture?.startedAt || null }
      const contents = requireWebContents()
      const nextRecorder = new RecorderClass({ webContents: contents, outputDir, logger })
      await nextRecorder.start()
      recorder = nextRecorder
      logger.info?.('[network-diagnostics] recording embedded page (observer-only, redacted before write)')
      return { recording: true, startedAt: recorder.capture.startedAt }
    },
    async stop(reason = 'manual') {
      requireEnabled()
      clearStoppedRecorder()
      if (!recorder) return { recording: false, path: null }
      const current = recorder
      recorder = null
      const result = await current.stop({ reason })
      logger.info?.(`[network-diagnostics] redacted capture saved to ${result.path}`)
      return { recording: false, path: result.path }
    },
    async toggle() {
      clearStoppedRecorder()
      return recorder ? this.stop('manual-shortcut') : this.start()
    },
    async dispose() {
      clearStoppedRecorder()
      if (!recorder) return null
      const current = recorder
      recorder = null
      return current.stop({ reason: 'application-exit' })
    },
  }
}

module.exports = {
  CdpNetworkRecorder,
  NETWORK_EVENTS,
  PAGE_SNAPSHOT_EXPRESSION,
  createNetworkDiagnostics,
  payloadMetadata,
  postDataMetadata,
  safeProtocolText,
  sanitizePageSnapshot,
}
