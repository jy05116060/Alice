'use strict'

const assert = require('node:assert/strict')
const fs = require('node:fs')
const http = require('node:http')
const os = require('node:os')
const path = require('node:path')
const { app, BaseWindow, WebContentsView, webContents } = require('electron')

const testUserData = fs.mkdtempSync(path.join(os.tmpdir(), 'alice-embed-cdp-'))
app.setPath('userData', testUserData)
app.commandLine.appendSwitch('remote-debugging-address', '127.0.0.1')
app.commandLine.appendSwitch('remote-debugging-port', '0')

function waitForActivePort(timeoutMs = 5_000) {
  const filePath = path.join(testUserData, 'DevToolsActivePort')
  const startedAt = Date.now()
  return new Promise((resolve, reject) => {
    const poll = () => {
      try {
        const port = Number(fs.readFileSync(filePath, 'utf8').split(/\r?\n/)[0])
        if (Number.isInteger(port) && port > 0) return resolve(port)
      } catch {}
      if (Date.now() - startedAt >= timeoutMs) {
        reject(new Error(`Electron did not create ${filePath}`))
        return
      }
      setTimeout(poll, 50)
    }
    poll()
  })
}

function getTargets(port) {
  return new Promise((resolve, reject) => {
    const request = http.get({ hostname: '127.0.0.1', port, path: '/json/list' }, response => {
      const chunks = []
      response.on('data', chunk => chunks.push(chunk))
      response.on('end', () => {
        try { resolve(JSON.parse(Buffer.concat(chunks).toString('utf8'))) }
        catch (error) { reject(error) }
      })
    })
    request.on('error', reject)
  })
}

app.whenReady().then(async () => {
  let window
  let externalWindow
  let view
  let embeddedHandle
  try {
    window = new BaseWindow({ width: 480, height: 320, show: false })
    view = new WebContentsView({
      webPreferences: {
        partition: 'persist:alice-browser',
        sandbox: true,
        contextIsolation: true,
        nodeIntegration: false,
      },
    })
    window.contentView.addChildView(view)
    view.setBounds({ x: 0, y: 0, width: 480, height: 320 })
    await view.webContents.loadURL('about:blank')

    const port = await waitForActivePort()
    const targets = await getTargets(port)
    const match = targets.find(candidate => {
      try { return webContents.fromDevToolsTargetId(candidate.id) === view.webContents }
      catch { return false }
    })
    assert.ok(match?.id, 'embedded WebContentsView must have a resolvable DevTools target')
    const root = path.resolve(__dirname, '..')
    const [{ connectEmbeddedPlaywright }, { createBuiltInEmbeddedPlaywrightConfig }] = await Promise.all([
      import(path.join(root, 'src', 'mcp', 'embedded-playwright-connection.js')),
      import(path.join(root, 'src', 'mcp', 'playwright-server.js')),
    ])
    embeddedHandle = await connectEmbeddedPlaywright({
      target: {
        cdpEndpoint: `http://127.0.0.1:${port}`,
        targetId: match.id,
        webContentsId: view.webContents.id,
      },
      mcpConfig: createBuiltInEmbeddedPlaywrightConfig({
        resourcesDir: root,
        sandboxDir: testUserData,
        allowPrivateNetwork: false,
      }),
    })
    const navigation = await embeddedHandle.client.callTool({
      name: 'browser_navigate',
      arguments: { url: 'https://example.com/?alice=self-sidecar' },
    })
    assert.match(
      navigation.content?.find(item => item.type === 'text')?.text || '',
      /Example Domain/,
      'sidecar must navigate the WebContentsView from the same Electron app',
    )
    await embeddedHandle.close()
    embeddedHandle = null
    assert.equal(view.webContents.isDestroyed(), false, 'closing sidecar must preserve the Electron page')
    const originalWebContents = view.webContents
    window.contentView.removeChildView(view)
    externalWindow = new BaseWindow({ width: 800, height: 600, show: false })
    externalWindow.contentView.addChildView(view)
    view.setBounds({ x: 0, y: 0, width: 800, height: 600 })
    assert.equal(view.webContents, originalWebContents, 'reparenting must preserve the same WebContents')
    console.log(`browser embed CDP test passed on loopback port ${port}`)
  } finally {
    try { await embeddedHandle?.close() } catch {}
    try { view?.webContents.close() } catch {}
    try { externalWindow?.destroy() } catch {}
    try { window?.destroy() } catch {}
    app.quit()
  }
}).catch(error => {
  console.error(error)
  app.exit(1)
})
