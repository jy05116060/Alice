'use strict'

const crypto = require('node:crypto')

const SAFE_HEADER_VALUES = new Set([
  'accept',
  'accept-encoding',
  'accept-language',
  'cache-control',
  'content-type',
  'dnt',
  'host',
  'origin',
  'pragma',
  'priority',
  'purpose',
  'referer',
  'sec-ch-ua',
  'sec-ch-ua-arch',
  'sec-ch-ua-bitness',
  'sec-ch-ua-full-version',
  'sec-ch-ua-full-version-list',
  'sec-ch-ua-mobile',
  'sec-ch-ua-model',
  'sec-ch-ua-platform',
  'sec-ch-ua-platform-version',
  'sec-fetch-dest',
  'sec-fetch-mode',
  'sec-fetch-site',
  'sec-fetch-user',
  'upgrade-insecure-requests',
  'user-agent',
  'x-requested-with',
])

const SENSITIVE_HEADER_NAME = /(?:^|[-_])(?:auth(?:orization)?|cookie|credential|csrf|passport|secret|session|sign(?:ature)?|ticket|token|captcha|xsec)(?:$|[-_])|^(?:x-s|x-t)$/i
const DYNAMIC_PATH_SEGMENT = /^(?:\d{5,}|[0-9a-f]{12,}|[0-9a-f]{8}-[0-9a-f-]{20,}|[A-Za-z0-9_-]{24,})$/i
const IDENTIFIER_PATH_PARENTS = new Set(['account', 'accounts', 'member', 'members', 'profile', 'profiles', 'user', 'users'])
const DIAGNOSTIC_HEADER_NAMES = [
  'user-agent',
  'sec-ch-ua',
  'sec-ch-ua-mobile',
  'sec-ch-ua-platform',
  'accept-language',
  'origin',
  'referer',
  'sec-fetch-dest',
  'sec-fetch-mode',
  'sec-fetch-site',
  'sec-fetch-user',
]

function sha256(value) {
  return crypto.createHash('sha256').update(String(value)).digest('hex')
}

function valueType(value) {
  const text = String(value ?? '')
  if (!text) return 'empty'
  if (/^-?\d+(?:\.\d+)?$/.test(text)) return 'number'
  if (/^(?:true|false|null|undefined)$/i.test(text)) return 'literal'
  if (/^[0-9a-f]{8}-[0-9a-f-]{20,}$/i.test(text)) return 'uuid'
  if (/^[A-Za-z0-9+/_=-]{20,}$/.test(text)) return 'opaque'
  if (/^[\x20-\x7e]+$/.test(text)) return 'text'
  return 'unicode'
}

function describeValue(value, { encoding = 'utf8' } = {}) {
  const text = String(value ?? '')
  return {
    present: value !== undefined && value !== null,
    type: valueType(text),
    length: Buffer.byteLength(text, encoding),
    sha256: sha256(text),
  }
}

function sanitizePathname(pathname) {
  const segments = String(pathname || '/').split('/')
  const sanitized = segments.map((segment, index) => {
    if (!segment) return segment
    let decoded = segment
    try { decoded = decodeURIComponent(segment) } catch {}
    let previous = segments[index - 1] || ''
    try { previous = decodeURIComponent(previous) } catch {}
    if (
      DYNAMIC_PATH_SEGMENT.test(decoded)
      || decoded.length > 72
      || /[^\x20-\x7e]/.test(decoded)
      || (IDENTIFIER_PATH_PARENTS.has(previous.toLowerCase()) && !/^(?:me|self|current)$/i.test(decoded))
    ) {
      const description = describeValue(decoded)
      return `<dynamic:${description.type}:${description.length}:${description.sha256.slice(0, 12)}>`
    }
    return segment
  })
  return sanitized.join('/') || '/'
}

function sanitizeHostname(hostname) {
  const raw = String(hostname || '').toLowerCase()
  if (!raw) return null
  if (/^(?:\d{1,3}\.){3}\d{1,3}$/.test(raw) || raw.includes(':')) {
    const description = describeValue(raw)
    return `<address:${raw.includes(':') ? 'ipv6' : 'ipv4'}:${description.sha256.slice(0, 12)}>`
  }
  return raw.split('.').map(label => {
    if (!DYNAMIC_PATH_SEGMENT.test(label) && label.length <= 40) return label
    const description = describeValue(label)
    return `<dynamic-host:${description.length}:${description.sha256.slice(0, 12)}>`
  }).join('.')
}

function sanitizeUrl(value) {
  const raw = String(value || '')
  if (/^data:/i.test(raw)) {
    const comma = raw.indexOf(',')
    const descriptor = comma >= 0 ? raw.slice(5, comma) : raw.slice(5)
    const payload = comma >= 0 ? raw.slice(comma + 1) : ''
    const [mimeType, ...parameters] = descriptor.split(';')
    return {
      scheme: 'data',
      host: null,
      port: null,
      path: '<inline-data>',
      query: [],
      fragmentPresent: false,
      data: {
        mimeType: mimeType.toLowerCase() || null,
        base64: parameters.some(parameter => parameter.toLowerCase() === 'base64'),
        payload: describeValue(payload),
      },
    }
  }
  if (/^blob:/i.test(raw)) {
    const inner = raw.slice(5)
    let origin = null
    try {
      const innerUrl = new URL(inner)
      origin = {
        scheme: innerUrl.protocol.replace(/:$/, ''),
        host: sanitizeHostname(innerUrl.hostname),
        port: innerUrl.port || null,
      }
    } catch {}
    return {
      scheme: 'blob',
      host: origin?.host || null,
      port: origin?.port || null,
      path: '<opaque-blob-url>',
      query: [],
      fragmentPresent: false,
      origin,
      value: describeValue(inner),
    }
  }
  try {
    const parsed = new URL(raw)
    const scheme = parsed.protocol.replace(/:$/, '')
    if (!['http', 'https', 'ws', 'wss'].includes(scheme)) {
      return {
        scheme,
        host: null,
        port: null,
        path: scheme === 'about' && parsed.pathname === 'blank' ? 'blank' : '<opaque-url>',
        query: [],
        fragmentPresent: Boolean(parsed.hash),
        value: describeValue(raw),
      }
    }
    const query = []
    for (const [name, queryValue] of parsed.searchParams) {
      query.push({ name, value: describeValue(queryValue) })
    }
    return {
      scheme,
      host: sanitizeHostname(parsed.hostname),
      port: parsed.port || null,
      path: sanitizePathname(parsed.pathname),
      query,
      fragmentPresent: Boolean(parsed.hash),
    }
  } catch {
    return {
      scheme: 'invalid',
      host: null,
      port: null,
      path: '<unparseable>',
      query: [],
      fragmentPresent: raw.includes('#'),
      value: describeValue(raw),
    }
  }
}

function sanitizeStoredUrl(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return value
  if (value.scheme === 'data') {
    return {
      scheme: 'data',
      host: null,
      port: null,
      path: '<inline-data>',
      query: [],
      fragmentPresent: false,
      data: {
        mimeType: value.data?.mimeType || null,
        base64: value.data?.base64 ?? null,
        payload: value.data?.payload || describeValue(JSON.stringify({
          host: value.host,
          path: value.path,
          query: value.query,
        })),
      },
    }
  }
  if (value.scheme === 'blob') {
    return {
      scheme: 'blob',
      host: null,
      port: null,
      path: '<opaque-blob-url>',
      query: [],
      fragmentPresent: false,
      value: value.value || describeValue(JSON.stringify(value)),
    }
  }
  return value
}

function resanitizeCapture(value) {
  if (Array.isArray(value)) return value.map(resanitizeCapture)
  if (!value || typeof value !== 'object') return value
  if (
    typeof value.scheme === 'string'
    && Object.hasOwn(value, 'path')
    && Object.hasOwn(value, 'query')
  ) {
    return sanitizeStoredUrl(value)
  }
  return Object.fromEntries(Object.entries(value).map(([key, nested]) => [key, resanitizeCapture(nested)]))
}

function headerPairs(headers) {
  if (Array.isArray(headers)) {
    return headers.map(header => [String(header?.name || ''), String(header?.value || '')])
  }
  if (!headers || typeof headers !== 'object') return []
  return Object.entries(headers).map(([name, value]) => [String(name), String(value ?? '')])
}

function cookieHeaderSummary(value) {
  const text = String(value || '')
  const names = text.split(';').map(part => part.trim().split('=', 1)[0]).filter(Boolean)
  return {
    ...describeValue(text),
    itemCount: names.length,
    names,
  }
}

function setCookieHeaderSummary(value) {
  const text = String(value || '')
  const names = text.split(/\r?\n/).map(line => line.trim().split('=', 1)[0]).filter(Boolean)
  return {
    ...describeValue(text),
    itemCount: names.length,
    names,
  }
}

function sanitizeHeaderValue(name, value) {
  const lowerName = String(name || '').toLowerCase()
  if (lowerName === 'cookie') return { redacted: true, kind: 'cookie', metadata: cookieHeaderSummary(value) }
  if (lowerName === 'set-cookie') return { redacted: true, kind: 'set-cookie', metadata: setCookieHeaderSummary(value) }
  if (SENSITIVE_HEADER_NAME.test(lowerName)) {
    return { redacted: true, kind: 'sensitive', metadata: describeValue(value) }
  }
  if (lowerName === 'origin' || lowerName === 'referer') {
    return { redacted: false, kind: 'url', value: sanitizeUrl(value) }
  }
  if (lowerName === 'content-type') {
    const [mimeType, ...parameters] = String(value ?? '').split(';')
    const normalizedParameters = parameters.map(parameter => {
      const [rawName, ...rawValue] = parameter.trim().split('=')
      const parameterName = rawName.toLowerCase()
      const parameterValue = rawValue.join('=').trim()
      if (parameterName === 'charset') return `${parameterName}=${parameterValue}`
      return `${parameterName}=<${describeValue(parameterValue).sha256.slice(0, 12)}>`
    }).filter(Boolean)
    return {
      redacted: false,
      kind: 'diagnostic',
      value: [mimeType.trim().toLowerCase(), ...normalizedParameters].filter(Boolean).join('; '),
    }
  }
  if (SAFE_HEADER_VALUES.has(lowerName)) {
    return { redacted: false, kind: 'diagnostic', value: String(value ?? '') }
  }
  return { redacted: true, kind: 'unlisted', metadata: describeValue(value) }
}

function sanitizeHeaders(headers, { orderSource = Array.isArray(headers) ? 'har-array' : 'cdp-object-enumeration' } = {}) {
  const pairs = headerPairs(headers).filter(([name]) => name)
  return {
    orderObserved: pairs.length > 0,
    orderSource,
    wireOrderGuaranteed: false,
    order: pairs.map(([name]) => name.toLowerCase()),
    fields: pairs.map(([name, value]) => ({
      name: name.toLowerCase(),
      ...sanitizeHeaderValue(name, value),
    })),
  }
}

function sanitizeCookie(cookie = {}, blockedReasons = []) {
  const partitionKey = cookie.partitionKey && typeof cookie.partitionKey === 'object'
    ? {
        topLevelSite: cookie.partitionKey.topLevelSite
          ? sanitizeUrl(cookie.partitionKey.topLevelSite)
          : null,
        hasCrossSiteAncestor: cookie.partitionKey.hasCrossSiteAncestor ?? null,
      }
    : null
  return {
    name: String(cookie.name || ''),
    value: describeValue(cookie.value),
    domain: cookie.domain ? describeValue(cookie.domain) : null,
    path: cookie.path ? sanitizePathname(cookie.path) : null,
    sameSite: cookie.sameSite || null,
    secure: cookie.secure ?? null,
    httpOnly: cookie.httpOnly ?? null,
    partitionKey,
    blockedReasons: [...blockedReasons].map(String),
  }
}

function sanitizeAssociatedCookies(cookies) {
  if (!Array.isArray(cookies)) return []
  return cookies.map(item => sanitizeCookie(item?.cookie || {}, item?.blockedReasons || []))
}

function parseSetCookieName(value) {
  const first = String(value || '').split(';', 1)[0]
  const equals = first.indexOf('=')
  return equals > 0 ? first.slice(0, equals).trim() : ''
}

function sanitizeBlockedResponseCookies(cookies) {
  if (!Array.isArray(cookies)) return []
  return cookies.map(item => ({
    name: item?.cookie?.name || parseSetCookieName(item?.cookieLine),
    cookieLine: describeValue(item?.cookieLine),
    blockedReasons: [...(item?.blockedReasons || [])].map(String),
  }))
}

function sanitizeInitiator(initiator = {}) {
  const frames = []
  let stack = initiator.stack
  let depth = 0
  while (stack && depth < 8) {
    for (const frame of stack.callFrames || []) {
      frames.push({
        functionName: String(frame.functionName || '').slice(0, 160),
        url: sanitizeUrl(frame.url),
        lineNumber: Number(frame.lineNumber) || 0,
        columnNumber: Number(frame.columnNumber) || 0,
      })
      if (frames.length >= 24) break
    }
    if (frames.length >= 24) break
    stack = stack.parent
    depth += 1
  }
  return {
    type: initiator.type || null,
    url: initiator.url ? sanitizeUrl(initiator.url) : null,
    lineNumber: Number.isFinite(initiator.lineNumber) ? initiator.lineNumber : null,
    columnNumber: Number.isFinite(initiator.columnNumber) ? initiator.columnNumber : null,
    stack: frames,
  }
}

function sanitizeRemoteAddress(ipAddress, port) {
  if (!ipAddress) return null
  return {
    family: String(ipAddress).includes(':') ? 'ipv6' : 'ipv4',
    address: describeValue(ipAddress),
    port: Number.isFinite(Number(port)) ? Number(port) : null,
  }
}

function sanitizeSecurityDetails(details) {
  if (!details || typeof details !== 'object') return null
  return {
    protocol: details.protocol || null,
    keyExchange: details.keyExchange || null,
    keyExchangeGroup: details.keyExchangeGroup || null,
    cipher: details.cipher || null,
    encryptedClientHello: details.encryptedClientHello ?? null,
    certificateTransparencyCompliance: details.certificateTransparencyCompliance || null,
  }
}

function sanitizeTiming(timing) {
  if (!timing || typeof timing !== 'object') return null
  const safe = {}
  for (const [name, value] of Object.entries(timing)) {
    if (name === 'requestTime') continue
    if (typeof value === 'number' && Number.isFinite(value)) safe[name] = Math.round(value * 1000) / 1000
  }
  return safe
}

function endpointKey(request) {
  const url = request?.url || {}
  const port = url.port ? `:${url.port}` : ''
  return `${request?.method || 'GET'} ${url.scheme || 'unknown'}://${url.host || 'unknown'}${port}${url.path || '/'}`
}

function firstHeaderValue(headers, name) {
  const field = headers?.fields?.find(item => item.name === name && item.redacted === false)
  if (!field) return null
  return typeof field.value === 'string' ? field.value : field.value
}

function aggregateRecorderCapture(capture) {
  const byKey = new Map()
  for (const event of capture.events || []) {
    if (!event.requestKey) continue
    const current = byKey.get(event.requestKey) || {
      key: event.requestKey,
      tMs: event.tMs,
      request: null,
      requestExtra: null,
      response: null,
      responseExtra: null,
      finished: null,
      failed: null,
    }
    if (event.name === 'Network.requestWillBeSent') current.request = event.data
    if (event.name === 'Network.requestWillBeSentExtraInfo') current.requestExtra = event.data
    if (event.name === 'Network.responseReceived') current.response = event.data
    if (event.name === 'Network.responseReceivedExtraInfo') current.responseExtra = event.data
    if (event.name === 'Network.loadingFinished') current.finished = event.data
    if (event.name === 'Network.loadingFailed') current.failed = event.data
    byKey.set(event.requestKey, current)
  }
  return [...byKey.values()].filter(item => item.request).map(item => ({
    ...item,
    request: {
      ...item.request,
      headers: item.requestExtra?.headers || item.request.headers,
    },
    response: item.response
      ? { ...item.response, headers: item.responseExtra?.headers || item.response.headers }
      : null,
  }))
}

function normalizeHarCapture(har) {
  const entries = Array.isArray(har?.log?.entries) ? har.log.entries : []
  const baseTime = entries.reduce((min, entry) => {
    const time = Date.parse(entry?.startedDateTime || '')
    return Number.isFinite(time) ? Math.min(min, time) : min
  }, Infinity)
  return entries.map((entry, index) => {
    const request = entry.request || {}
    const response = entry.response || {}
    const postText = request.postData?.text
    const requestHeaders = sanitizeHeaders(request.headers)
    const responseHeaders = sanitizeHeaders(response.headers)
    const started = Date.parse(entry.startedDateTime || '')
    return {
      key: `r${index + 1}`,
      tMs: Number.isFinite(started) && Number.isFinite(baseTime) ? Math.max(0, started - baseTime) : index,
      request: {
        url: sanitizeUrl(request.url),
        method: String(request.method || 'GET').toUpperCase(),
        resourceType: entry._resourceType || null,
        initiator: entry._initiator ? sanitizeInitiator(entry._initiator) : null,
        hasUserGesture: null,
        headers: requestHeaders,
        postData: postText == null
          ? { present: Boolean(request.postData), mimeType: String(request.postData?.mimeType || '').split(';', 1)[0] || null }
          : { present: true, mimeType: String(request.postData?.mimeType || '').split(';', 1)[0] || null, ...describeValue(postText) },
      },
      requestExtra: null,
      response: {
        status: Number(response.status) || 0,
        statusText: response.statusText ? describeValue(response.statusText) : null,
        headers: responseHeaders,
        mimeType: response.content?.mimeType || null,
        protocol: response.httpVersion || entry._protocol || null,
        remoteAddress: sanitizeRemoteAddress(entry.serverIPAddress, null),
        connectionId: entry.connection ? describeValue(entry.connection) : null,
        connectionReused: null,
        fromDiskCache: Boolean(entry._fromDiskCache),
        fromServiceWorker: Boolean(entry._fromServiceWorker),
        fromPrefetchCache: Boolean(entry._fromPrefetchCache),
        securityDetails: sanitizeSecurityDetails(entry._securityDetails),
      },
      responseExtra: null,
      finished: response._transferSize == null ? null : { encodedDataLength: response._transferSize },
      failed: response.status === 0
        ? { errorText: describeValue(response._error || 'HAR response status 0') }
        : null,
      timings: entry.timings || null,
    }
  })
}

function normalizeCapture(capture, { label = 'capture' } = {}) {
  let requests
  let pageSnapshots = []
  let source
  if (capture?.kind === 'alice-network-audit' && Array.isArray(capture.events)) {
    requests = aggregateRecorderCapture(capture)
    pageSnapshots = Array.isArray(capture.pageSnapshots) ? capture.pageSnapshots : []
    source = capture.source || 'electron-webcontents-cdp'
  } else if (Array.isArray(capture?.log?.entries)) {
    requests = normalizeHarCapture(capture)
    source = 'har'
  } else {
    throw new TypeError(`${label} is not a supported Alice audit JSON or HAR file`)
  }
  const firstRequestMs = requests.reduce((minimum, request) => {
    const time = Number(request.tMs)
    return Number.isFinite(time) ? Math.min(minimum, time) : minimum
  }, Infinity)
  const normalizedRequests = requests.map(request => ({
    ...request,
    tMs: Number.isFinite(Number(request.tMs)) && Number.isFinite(firstRequestMs)
      ? Math.max(0, Math.round((Number(request.tMs) - firstRequestMs) * 1000) / 1000)
      : request.tMs,
  }))
  return {
    label,
    source,
    requestCount: requests.length,
    pageSnapshots,
    requests: normalizedRequests.map(request => ({ ...request, endpoint: endpointKey(request.request) })),
  }
}

function countBy(values) {
  const counts = {}
  for (const value of values) {
    const key = value == null || value === '' ? '<unknown>' : String(value)
    counts[key] = (counts[key] || 0) + 1
  }
  return Object.fromEntries(Object.entries(counts).sort(([a], [b]) => a.localeCompare(b)))
}

function unique(values) {
  return [...new Set(values.filter(value => value !== null && value !== undefined))]
}

function uniqueComparable(values) {
  return unique(values.map(value => {
    if (value === null || value === undefined) return null
    return typeof value === 'string' ? value : JSON.stringify(value)
  }))
}

function endpointNoiseKind(endpoint, requests) {
  if (/(?:^|[/._-])(?:ad|ads|advert|commercial|promotion|recommend|feed|rank|experiment|abtest)(?:[/._-]|$)/i.test(endpoint)) {
    return 'recommendation-or-ad'
  }
  const types = new Set(requests.map(item => String(item.request?.resourceType || '').toLowerCase()))
  if ([...types].every(type => ['font', 'image', 'media', 'script', 'stylesheet'].includes(type))) {
    return 'cache-sensitive-static-resource'
  }
  if (/\.(?:avif|css|gif|ico|jpe?g|js|mjs|png|svg|webp|woff2?)(?:$|\?)/i.test(endpoint)) {
    return 'cache-sensitive-static-resource'
  }
  return null
}

function partitionEndpointDifferences(endpoints, normalized) {
  const requestMap = new Map()
  for (const item of normalized.requests) {
    const list = requestMap.get(item.endpoint) || []
    list.push(item)
    requestMap.set(item.endpoint, list)
  }
  const material = []
  const normalizedNoise = []
  for (const endpoint of endpoints) {
    const kind = endpointNoiseKind(endpoint, requestMap.get(endpoint) || [])
    if (kind) normalizedNoise.push({ endpoint, kind })
    else material.push(endpoint)
  }
  return { material, normalizedNoise }
}

function percentile(numbers, fraction) {
  if (!numbers.length) return null
  const sorted = [...numbers].sort((a, b) => a - b)
  const index = Math.min(sorted.length - 1, Math.max(0, Math.round((sorted.length - 1) * fraction)))
  return Math.round(sorted[index] * 1000) / 1000
}

function summarizeCapture(normalized) {
  const requests = normalized.requests
  const sortedTimes = requests.map(item => Number(item.tMs)).filter(Number.isFinite).sort((a, b) => a - b)
  const gaps = sortedTimes.slice(1).map((time, index) => time - sortedTimes[index])
  const headerNames = new Set()
  for (const item of requests) {
    for (const name of item.request?.headers?.order || []) headerNames.add(name)
  }
  const snapshots = normalized.pageSnapshots.map(item => item?.value || item).filter(Boolean)
  const diagnosticHeaders = {}
  for (const name of DIAGNOSTIC_HEADER_NAMES) {
    diagnosticHeaders[name] = uniqueComparable(
      requests.map(item => firstHeaderValue(item.request?.headers, name)),
    )
  }
  return {
    source: normalized.source,
    requests: requests.length,
    endpoints: countBy(requests.map(item => item.endpoint)),
    methods: countBy(requests.map(item => item.request?.method)),
    resourceTypes: countBy(requests.map(item => item.request?.resourceType)),
    protocols: countBy(requests.map(item => item.response?.protocol)),
    statuses: countBy(requests.map(item => item.failed ? 'failed' : item.response?.status)),
    cache: {
      disk: requests.filter(item => item.response?.fromDiskCache).length,
      serviceWorker: requests.filter(item => item.response?.fromServiceWorker).length,
      prefetch: requests.filter(item => item.response?.fromPrefetchCache).length,
    },
    timeline: {
      firstRequestMs: sortedTimes[0] ?? null,
      lastRequestMs: sortedTimes.at(-1) ?? null,
      firstUserGestureRequestMs: requests.find(item => item.request?.hasUserGesture === true)?.tMs ?? null,
      interRequestGapMs: {
        p10: percentile(gaps, 0.1),
        median: percentile(gaps, 0.5),
        p90: percentile(gaps, 0.9),
      },
      firstEndpoints: requests.slice(0, 50).map(item => item.endpoint),
    },
    transport: {
      reusedConnections: requests.filter(item => item.response?.connectionReused === true).length,
      newConnections: requests.filter(item => item.response?.connectionReused === false).length,
      tlsProtocols: countBy(requests.map(item => item.response?.securityDetails?.protocol)),
      ciphers: countBy(requests.map(item => item.response?.securityDetails?.cipher)),
      remoteAddressFamilies: countBy(requests.map(item => item.response?.remoteAddress?.family)),
    },
    cookies: {
      requestHeaderPresent: requests.filter(item => item.request?.headers?.order?.includes('cookie')).length,
      blockedRequestCookies: requests.reduce((sum, item) => sum + (item.requestExtra?.associatedCookies || []).filter(cookie => cookie.blockedReasons?.length).length, 0),
      blockedResponseCookies: requests.reduce((sum, item) => sum + (item.responseExtra?.blockedCookies || []).length, 0),
      partitionedRequestCookies: requests.reduce((sum, item) => sum + (item.requestExtra?.associatedCookies || []).filter(cookie => cookie.partitionKey).length, 0),
      partitionKeysObserved: requests.filter(item => item.responseExtra?.cookiePartitionKey).length,
    },
    hasUserGesture: countBy(requests.map(item => item.request?.hasUserGesture == null ? '<unavailable>' : item.request.hasUserGesture)),
    requestHeaderNames: [...headerNames].sort(),
    requestHeaderOrderSignatures: countBy(requests.map(item => item.request?.headers?.order?.join('|'))),
    queryParameterNames: unique(requests.flatMap(item => item.request?.url?.query?.map(query => query.name) || [])).sort(),
    diagnosticHeaders,
    fingerprintHeaders: {
      userAgent: unique(requests.map(item => firstHeaderValue(item.request?.headers, 'user-agent'))),
      secChUa: unique(requests.map(item => firstHeaderValue(item.request?.headers, 'sec-ch-ua'))),
      secChUaPlatform: unique(requests.map(item => firstHeaderValue(item.request?.headers, 'sec-ch-ua-platform'))),
      acceptLanguage: unique(requests.map(item => firstHeaderValue(item.request?.headers, 'accept-language'))),
    },
    pageEnvironment: snapshots,
  }
}

function difference(left, right) {
  const rightSet = new Set(right)
  return left.filter(value => !rightSet.has(value))
}

function detectRiskSignals(chromeSummary, aliceSummary) {
  const signals = []
  const aliceUa = aliceSummary.fingerprintHeaders.userAgent.join(' ')
  const aliceBrands = aliceSummary.fingerprintHeaders.secChUa.join(' ')
  const chromeWebdriverValues = chromeSummary.pageEnvironment
    .map(snapshot => snapshot.navigator?.webdriver)
    .filter(value => value !== undefined && value !== null)
  const aliceWebdriverValues = aliceSummary.pageEnvironment
    .map(snapshot => snapshot.navigator?.webdriver)
    .filter(value => value !== undefined && value !== null)

  if (/electron/i.test(aliceUa) || /electron/i.test(aliceBrands)) {
    signals.push({ level: '极高', fact: true, signal: 'UA 或 Client Hints 直接包含 Electron 品牌。' })
  }
  if (
    aliceWebdriverValues.includes(true)
    && chromeWebdriverValues.includes(false)
    && !chromeWebdriverValues.includes(true)
  ) {
    signals.push({ level: '极高', fact: true, signal: '仅爱丽丝页面环境快照中 navigator.webdriver 为 true。' })
  } else if (aliceWebdriverValues.includes(true) && chromeWebdriverValues.includes(true)) {
    signals.push({
      level: '低',
      fact: true,
      signal: '两组页面环境快照中的 navigator.webdriver 都为 true；该字段在本次采集中不能区分两组，且应检查 CDP 启动参数造成的污染。',
    })
  } else if (aliceWebdriverValues.includes(true) && chromeWebdriverValues.length === 0) {
    signals.push({
      level: '极高',
      fact: true,
      signal: '爱丽丝页面环境快照中 navigator.webdriver 为 true；基线 HAR 不含此字段，不能据此声称“仅爱丽丝”为 true。',
    })
  }
  if (
    chromeSummary.fingerprintHeaders.userAgent.length
    && aliceSummary.fingerprintHeaders.userAgent.length
    && JSON.stringify(chromeSummary.fingerprintHeaders.userAgent) !== JSON.stringify(aliceSummary.fingerprintHeaders.userAgent)
  ) {
    signals.push({ level: '高', fact: true, signal: '两组 User-Agent 不一致，可被低成本服务端规则直接分组。' })
  }
  if (
    chromeSummary.fingerprintHeaders.secChUa.length
    && aliceSummary.fingerprintHeaders.secChUa.length
    && JSON.stringify(chromeSummary.fingerprintHeaders.secChUa) !== JSON.stringify(aliceSummary.fingerprintHeaders.secChUa)
  ) {
    signals.push({ level: '高', fact: true, signal: '两组 sec-ch-ua 品牌/版本不一致。' })
  }
  const chromeHeaders = chromeSummary.requestHeaderNames
  const aliceHeaders = aliceSummary.requestHeaderNames
  const chromeOnly = difference(chromeHeaders, aliceHeaders)
  const aliceOnly = difference(aliceHeaders, chromeHeaders)
  if (chromeOnly.length || aliceOnly.length) {
    signals.push({
      level: '中',
      fact: true,
      signal: `请求头字段集合不同（人工基线独有 ${chromeOnly.length}，爱丽丝独有 ${aliceOnly.length}）。`,
    })
  }
  if (JSON.stringify(chromeSummary.protocols) !== JSON.stringify(aliceSummary.protocols)) {
    signals.push({ level: '中', fact: false, signal: '协议分布不同；可能来自客户端栈，也可能只是缓存、连接或采集条件差异。' })
  }
  if (!signals.length) {
    signals.push({ level: '低', fact: false, signal: '在当前已采字段中没有形成明确自动化指纹；这不等于平台无法从请求体或行为序列识别。' })
  }
  return signals
}

function compareCaptures(chromeCapture, aliceCapture) {
  const chrome = normalizeCapture(chromeCapture, { label: 'chrome' })
  const alice = normalizeCapture(aliceCapture, { label: 'alice' })
  const chromeSummary = summarizeCapture(chrome)
  const aliceSummary = summarizeCapture(alice)
  const endpointsOnlyInChrome = difference(Object.keys(chromeSummary.endpoints), Object.keys(aliceSummary.endpoints))
  const endpointsOnlyInAlice = difference(Object.keys(aliceSummary.endpoints), Object.keys(chromeSummary.endpoints))
  const chromeEndpointDiff = partitionEndpointDifferences(endpointsOnlyInChrome, chrome)
  const aliceEndpointDiff = partitionEndpointDifferences(endpointsOnlyInAlice, alice)
  return {
    schemaVersion: 1,
    kind: 'alice-network-comparison',
    normalized: true,
    redacted: true,
    chrome: chromeSummary,
    alice: aliceSummary,
    differences: {
      endpointsOnlyInChrome,
      endpointsOnlyInAlice,
      materialEndpointsOnlyInChrome: chromeEndpointDiff.material,
      materialEndpointsOnlyInAlice: aliceEndpointDiff.material,
      normalizedEndpointNoise: {
        chrome: chromeEndpointDiff.normalizedNoise,
        alice: aliceEndpointDiff.normalizedNoise,
      },
      requestHeadersOnlyInChrome: difference(chromeSummary.requestHeaderNames, aliceSummary.requestHeaderNames),
      requestHeadersOnlyInAlice: difference(aliceSummary.requestHeaderNames, chromeSummary.requestHeaderNames),
      queryParameterNamesOnlyInChrome: difference(chromeSummary.queryParameterNames, aliceSummary.queryParameterNames),
      queryParameterNamesOnlyInAlice: difference(aliceSummary.queryParameterNames, chromeSummary.queryParameterNames),
      diagnosticHeaders: { chrome: chromeSummary.diagnosticHeaders, alice: aliceSummary.diagnosticHeaders },
      fingerprintHeaders: {
        chrome: chromeSummary.fingerprintHeaders,
        alice: aliceSummary.fingerprintHeaders,
      },
      protocols: { chrome: chromeSummary.protocols, alice: aliceSummary.protocols },
      transport: { chrome: chromeSummary.transport, alice: aliceSummary.transport },
      cookieState: { chrome: chromeSummary.cookies, alice: aliceSummary.cookies },
      hasUserGesture: { chrome: chromeSummary.hasUserGesture, alice: aliceSummary.hasUserGesture },
      timeline: { chrome: chromeSummary.timeline, alice: aliceSummary.timeline },
      requestHeaderOrderSignatures: {
        chrome: chromeSummary.requestHeaderOrderSignatures,
        alice: aliceSummary.requestHeaderOrderSignatures,
        caveat: 'HAR/CDP 均不保证这是最终 HTTP/2、HTTP/3 或线上线序；只能比较采集 API 暴露的顺序。',
      },
    },
    riskSignals: detectRiskSignals(chromeSummary, aliceSummary),
    limitations: [
      'HAR 通常不包含 navigator.webdriver、精确 hasUserGesture、Cookie 分区详情或完整连接/TLS 信息。',
      '为避免保存敏感信息，本工具不保留请求/响应正文；正文中的行为遥测只能由接口出现与时序间接推断。',
      '推荐流、广告、随机实验和缓存状态会造成请求数量差异，不能单独作为自动化结论。',
    ],
  }
}

module.exports = {
  SAFE_HEADER_VALUES,
  SENSITIVE_HEADER_NAME,
  aggregateRecorderCapture,
  compareCaptures,
  describeValue,
  endpointKey,
  normalizeCapture,
  sanitizeAssociatedCookies,
  sanitizeBlockedResponseCookies,
  sanitizeCookie,
  sanitizeHeaders,
  sanitizeHostname,
  sanitizeInitiator,
  sanitizePathname,
  sanitizeRemoteAddress,
  resanitizeCapture,
  sanitizeSecurityDetails,
  sanitizeTiming,
  sanitizeUrl,
  sha256,
  summarizeCapture,
}
