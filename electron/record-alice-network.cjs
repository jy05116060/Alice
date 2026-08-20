'use strict'

const assert = require('node:assert/strict')
const fs = require('node:fs')
const http = require('node:http')
const os = require('node:os')
const path = require('node:path')
const { app, BaseWindow, WebContentsView, webContents } = require('electron')
const { configureIsolatedSession } = require('./browser-embed-host.cjs')
const { CdpNetworkRecorder } = require('./network-diagnostics.cjs')

const targetUrl = process.argv[2] || 'https://www.baidu.com/'
const outputDir = path.resolve(process.argv[3] || path.join(__dirname, '..', 'data', 'network-audits'))
const testUserData = fs.mkdtempSync(path.join(os.tmpdir(), 'alice-agent-capture-'))
app.setPath('userData', testUserData)
app.commandLine.appendSwitch('remote-debugging-address', '127.0.0.1')
app.commandLine.appendSwitch('remote-debugging-port', '0')

function waitForActivePort(timeoutMs = 10_000) {
  const filename = path.join(testUserData, 'DevToolsActivePort')
  const startedAt = Date.now()
  return new Promise((resolve, reject) => {
    const poll = () => {
      try {
        const port = Number(fs.readFileSync(filename, 'utf8').split(/\r?\n/, 1)[0])
        if (Number.isInteger(port) && port > 0) return resolve(port)
      } catch {}
      if (Date.now() - startedAt >= timeoutMs) return reject(new Error('Electron DevTools port timed out'))
      setTimeout(poll, 50)
    }
    poll()
  })
}

function getTargets(port) {
  return new Promise((resolve, reject) => {
    const request = http.get({ hostname: '127.0.0.1', port, path: '/json/list', timeout: 2_000 }, response => {
      const chunks = []
      response.on('data', chunk => chunks.push(chunk))
      response.on('end', () => {
        try { resolve(JSON.parse(Buffer.concat(chunks).toString('utf8'))) }
        catch (error) { reject(error) }
      })
    })
    request.on('timeout', () => request.destroy(new Error('CDP target lookup timed out')))
    request.on('error', reject)
  })
}

app.whenReady().then(async () => {
  let windowHost
  let view
  let recorder
  let embeddedHandle
  try {
    windowHost = new BaseWindow({ width: 1280, height: 840, show: true })
    view = new WebContentsView({
      webPreferences: {
        partition: 'persist:alice-browser',
        sandbox: true,
        nodeIntegration: false,
        contextIsolation: true,
        webSecurity: true,
        allowRunningInsecureContent: false,
        navigateOnDragDrop: false,
        webviewTag: false,
        plugins: false,
      },
    })
    const { assertWebUrlAllowed } = await import(path.join(
      __dirname,
      '..',
      'src',
      'capabilities',
      'tools',
      'web',
      'url-policy.js',
    ))
    const nativeNetworkGuard = configureIsolatedSession(view.webContents.session, {
      assertRequestAllowed: url => assertWebUrlAllowed(url, { allowPrivateNetwork: false }),
      installNativeRequestGuard: true,
    })
    assert.equal(nativeNetworkGuard, true, 'native Electron request guard is unavailable')
    windowHost.contentView.addChildView(view)
    view.setBounds({ x: 0, y: 0, width: 1280, height: 840 })
    await view.webContents.loadURL('about:blank')

    const port = await waitForActivePort()
    const targets = await getTargets(port)
    const target = targets.find(candidate => {
      try { return webContents.fromDevToolsTargetId(candidate.id) === view.webContents }
      catch { return false }
    })
    assert.ok(target?.id, 'embedded WebContentsView target is unavailable')

    recorder = new CdpNetworkRecorder({
      webContents: view.webContents,
      outputDir,
      source: 'alice-electron-playwright-cdp',
    })
    await recorder.start()

    const root = path.resolve(__dirname, '..')
    const [{ connectEmbeddedPlaywright }, { createBuiltInEmbeddedPlaywrightConfig }] = await Promise.all([
      import(path.join(root, 'src', 'mcp', 'embedded-playwright-connection.js')),
      import(path.join(root, 'src', 'mcp', 'playwright-server.js')),
    ])
    embeddedHandle = await connectEmbeddedPlaywright({
      target: {
        cdpEndpoint: `http://127.0.0.1:${port}`,
        targetId: target.id,
        webContentsId: view.webContents.id,
        nativeNetworkGuard: true,
      },
      mcpConfig: createBuiltInEmbeddedPlaywrightConfig({
        resourcesDir: root,
        sandboxDir: testUserData,
        allowPrivateNetwork: false,
        nativeNetworkGuard: true,
      }),
    })
    const navigation = await embeddedHandle.client.callTool({
      name: 'browser_navigate',
      arguments: { url: targetUrl },
    })
    if (navigation.isError) throw new Error('Playwright navigation reported an error')
    await new Promise(resolve => setTimeout(resolve, 10_000))
    const result = await recorder.stop({ reason: 'baidu-read-only-comparison' })
    recorder = null
    console.log(`SAVED ${result.path}`)
  } finally {
    try { await recorder?.stop({ reason: 'capture-cleanup' }) } catch {}
    try { await embeddedHandle?.close() } catch {}
    try { view?.webContents.close() } catch {}
    try { windowHost?.destroy() } catch {}
    if (path.basename(testUserData).startsWith('alice-agent-capture-')) {
      try { fs.rmSync(testUserData, { recursive: true, force: true }) } catch {}
    }
    app.quit()
  }
}).catch(error => {
  console.error(error?.stack || error?.message || error)
  app.exit(1)
})
