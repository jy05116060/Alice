'use strict'

const assert = require('node:assert/strict')
const { EventEmitter } = require('node:events')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const {
  CdpNetworkRecorder,
  createNetworkDiagnostics,
} = require('./network-diagnostics.cjs')

class FakeDebugger extends EventEmitter {
  constructor() {
    super()
    this.attached = false
    this.commands = []
  }

  isAttached() { return this.attached }
  attach(version) {
    assert.equal(version, '1.3')
    this.attached = true
  }
  detach() {
    this.attached = false
    this.emit('detach', {}, 'target closed')
  }
  async sendCommand(method, params) {
    this.commands.push({ method, params })
    if (method === 'Runtime.evaluate') {
      return {
        result: {
          value: {
            location: 'https://www.example.com/search?token=page-secret',
            navigator: {
              userAgent: 'Mozilla/5.0 Electron/33.0',
              webdriver: false,
              language: 'zh-CN',
              languages: ['zh-CN'],
              platform: 'MacIntel',
              userAgentData: {
                brands: [{ brand: 'Chromium', version: '130' }],
                mobile: false,
                platform: 'macOS',
              },
            },
            document: { visibilityState: 'visible', hasFocus: true },
            viewport: { innerWidth: 1200, innerHeight: 800, devicePixelRatio: 2 },
          },
        },
      }
    }
    return {}
  }
}

async function run() {
  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'alice-network-diagnostics-'))
  try {
    const debuggerApi = new FakeDebugger()
    const webContents = {
      id: 42,
      debugger: debuggerApi,
      isDestroyed: () => false,
      openDevToolsCalls: [],
      openDevTools(options) { this.openDevToolsCalls.push(options) },
    }
    let clock = 0
    const recorder = new CdpNetworkRecorder({
      webContents,
      outputDir: tempRoot,
      now: () => new Date('2026-07-26T00:00:00.000Z'),
      monotonicNow: () => clock,
    })
    await recorder.start()
    assert.deepEqual(debuggerApi.commands.map(item => item.method), ['Network.enable', 'Runtime.evaluate'])

    const secret = 'sensitive-signature-value'
    clock = 10
    debuggerApi.emit('message', {}, 'Network.requestWillBeSent', {
      requestId: 'raw-request-id',
      documentURL: `https://www.example.com/?account=${secret}`,
      type: 'Fetch',
      initiator: { type: 'script', url: `https://www.example.com/app.js?nonce=${secret}` },
      request: {
        url: `https://www.example.com/api/search?token=${secret}`,
        method: 'POST',
        hasUserGesture: false,
        hasPostData: true,
        postData: `{"token":"${secret}"}`,
        headers: {
          'User-Agent': 'Mozilla/5.0 Electron/33.0',
          Cookie: `session=${secret}`,
          Authorization: `Bearer ${secret}`,
          'X-S': secret,
          'Content-Type': 'application/json',
        },
      },
    })
    clock = 20
    debuggerApi.emit('message', {}, 'Network.requestWillBeSentExtraInfo', {
      requestId: 'raw-request-id',
      headers: { Cookie: `session=${secret}` },
      associatedCookies: [{
        cookie: { name: 'session', value: secret, domain: '.example.com', partitionKey: { topLevelSite: 'https://example.com' } },
        blockedReasons: ['ThirdPartyPhaseout'],
      }],
    })
    clock = 30
    debuggerApi.emit('message', {}, 'Network.responseReceived', {
      requestId: 'raw-request-id',
      type: 'Fetch',
      response: {
        url: `https://www.example.com/api/search?token=${secret}`,
        status: 200,
        protocol: 'h2',
        remoteIPAddress: '203.0.113.10',
        remotePort: 443,
        headers: { 'Set-Cookie': `session=${secret}; Secure` },
        securityDetails: { protocol: 'TLS 1.3', cipher: 'AES_128_GCM' },
      },
    })
    clock = 40
    debuggerApi.emit('message', {}, 'Network.webSocketFrameSent', {
      requestId: 'raw-request-id',
      response: { opcode: 1, mask: true, payloadData: secret },
    })
    clock = 50
    const result = await recorder.stop()
    assert.equal(fs.existsSync(result.path), true)
    const written = fs.readFileSync(result.path, 'utf8')
    assert.equal(written.includes(secret), false)
    assert.equal(written.includes('raw-request-id'), false)
    assert.equal(written.includes('203.0.113.10'), false)
    assert.match(written, /Electron\/33\.0/)
    assert.match(written, /ThirdPartyPhaseout/)
    assert.deepEqual(debuggerApi.commands.map(item => item.method), [
      'Network.enable',
      'Runtime.evaluate',
      'Runtime.evaluate',
      'Network.disable',
    ])

    const diagnostics = createNetworkDiagnostics({
      enabled: true,
      getWebContents: () => webContents,
      outputDir: tempRoot,
    })
    await diagnostics.openDevTools()
    assert.deepEqual(webContents.openDevToolsCalls, [{ mode: 'detach', activate: true }])
    const disabled = createNetworkDiagnostics({
      enabled: false,
      getWebContents: () => webContents,
      outputDir: tempRoot,
    })
    await assert.rejects(() => disabled.start(), /disabled/)
  } finally {
    if (path.basename(tempRoot).startsWith('alice-network-diagnostics-')) {
      fs.rmSync(tempRoot, { recursive: true, force: true })
    }
  }
  console.log('network diagnostics tests passed')
}

run().catch(error => {
  console.error(error)
  process.exitCode = 1
})
