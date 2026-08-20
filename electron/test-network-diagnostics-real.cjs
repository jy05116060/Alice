'use strict'

const assert = require('node:assert/strict')
const fs = require('node:fs')
const http = require('node:http')
const os = require('node:os')
const path = require('node:path')
const { app, BaseWindow, WebContentsView } = require('electron')
const { CdpNetworkRecorder } = require('./network-diagnostics.cjs')

const testRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'alice-network-real-'))
app.setPath('userData', testRoot)

function listen(server) {
  return new Promise((resolve, reject) => {
    server.once('error', reject)
    server.listen(0, '127.0.0.1', () => resolve(server.address().port))
  })
}

app.whenReady().then(async () => {
  const secret = 'real-recorder-secret-should-never-be-written'
  let windowHost
  let view
  let recorder
  let server
  try {
    let resolveApi
    const apiSeen = new Promise(resolve => { resolveApi = resolve })
    server = http.createServer((request, response) => {
      if (request.url?.startsWith('/api')) {
        request.resume()
        request.on('end', resolveApi)
        response.writeHead(200, {
          'Content-Type': 'application/json',
          'Set-Cookie': `session=${secret}; HttpOnly; SameSite=Lax`,
        })
        response.end('{"ok":true}')
        return
      }
      response.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' })
      response.end(`<!doctype html><script>
        fetch('/api?token=${secret}', {
          method: 'POST',
          headers: { authorization: 'Bearer ${secret}', 'content-type': 'application/json' },
          body: JSON.stringify({ token: '${secret}' })
        });
      </script>`)
    })
    const port = await listen(server)

    windowHost = new BaseWindow({ width: 800, height: 600, show: false })
    view = new WebContentsView({
      webPreferences: {
        partition: `alice-network-test-${process.pid}`,
        sandbox: true,
        contextIsolation: true,
        nodeIntegration: false,
      },
    })
    windowHost.contentView.addChildView(view)
    view.setBounds({ x: 0, y: 0, width: 800, height: 600 })
    await view.webContents.loadURL('about:blank')
    recorder = new CdpNetworkRecorder({
      webContents: view.webContents,
      outputDir: path.join(testRoot, 'network-audits'),
    })
    await recorder.start()
    await view.webContents.loadURL(`http://127.0.0.1:${port}/`)
    await Promise.race([
      apiSeen,
      new Promise((_, reject) => setTimeout(() => reject(new Error('local test API request timed out')), 5_000)),
    ])
    const result = await recorder.stop({ reason: 'real-integration-test' })
    recorder = null
    const written = fs.readFileSync(result.path, 'utf8')
    assert.equal(written.includes(secret), false, 'raw URL/header/body/cookie values must never reach disk')
    const capture = JSON.parse(written)
    assert.ok(capture.events.some(event => event.name === 'Network.requestWillBeSent'))
    assert.ok(capture.events.some(event => event.name === 'Network.requestWillBeSentExtraInfo'))
    assert.ok(capture.events.some(event => event.name === 'Network.responseReceived'))
    assert.ok(capture.events.some(event => event.name === 'Network.loadingFinished'))
    const stopSnapshot = capture.pageSnapshots.find(snapshot => snapshot.stage === 'stop')?.value
    assert.match(stopSnapshot?.navigator?.userAgent || '', /Electron\/33\./)
    assert.equal(stopSnapshot?.navigator?.webdriver, false)
    console.log('real Electron network diagnostics test passed')
  } finally {
    try { await recorder?.stop({ reason: 'test-cleanup' }) } catch {}
    try { view?.webContents.close() } catch {}
    try { windowHost?.destroy() } catch {}
    try { await new Promise(resolve => server?.close(resolve)) } catch {}
    if (path.basename(testRoot).startsWith('alice-network-real-')) {
      try { fs.rmSync(testRoot, { recursive: true, force: true }) } catch {}
    }
    app.quit()
  }
}).catch(error => {
  console.error(error)
  app.exit(1)
})
