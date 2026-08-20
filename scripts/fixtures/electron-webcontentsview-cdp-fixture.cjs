const fs = require('fs')
const http = require('http')
const path = require('path')
const {
  app,
  BrowserWindow,
  WebContentsView,
  session,
} = require('electron')

const cdpPort = Number(process.env.ALICE_CDP_SPIKE_PORT || 0)
const readyFile = process.env.ALICE_CDP_SPIKE_READY_FILE || ''
const persistentPartition = 'persist:alice-browser-cdp-spike'

if (!Number.isInteger(cdpPort) || cdpPort <= 0) {
  throw new Error('ALICE_CDP_SPIKE_PORT must contain a positive integer')
}

if (process.env.ALICE_CDP_SPIKE_USER_DATA) {
  app.setPath('userData', path.resolve(process.env.ALICE_CDP_SPIKE_USER_DATA))
}

// Electron exposes one app-wide DevTools endpoint. The production spike uses a
// loopback-only random port; it must never be bound to a LAN interface.
app.commandLine.appendSwitch('remote-debugging-address', '127.0.0.1')
app.commandLine.appendSwitch('remote-debugging-port', String(cdpPort))

let smallWindow
let largeWindow
let browserView
let browserSession
let activeHost = 'small'
let contentServer
let contentBaseUrl

function html(title, marker) {
  return `<!doctype html>
<meta charset="utf-8">
<title>${title}</title>
<main>
  <h1>${marker}</h1>
  <label>Search <input aria-label="Search" value=""></label>
  <button type="button" onclick="document.body.dataset.clicked='yes'">Run</button>
</main>`
}

function moveBrowserView(host) {
  const nextWindow = host === 'large' ? largeWindow : smallWindow
  const previousWindow = activeHost === 'large' ? largeWindow : smallWindow
  if (previousWindow && !previousWindow.isDestroyed()) {
    try { previousWindow.contentView.removeChildView(browserView) } catch {}
  }
  nextWindow.contentView.addChildView(browserView)
  browserView.setBounds(host === 'large'
    ? { x: 18, y: 18, width: 980, height: 640 }
    : { x: 18, y: 18, width: 540, height: 304 })
  activeHost = host
}

async function state() {
  const browserContents = browserView?.webContents
  const brainContents = smallWindow?.webContents
  const browserDestroyed = !browserContents || browserContents.isDestroyed()
  const brainDestroyed = !brainContents || brainContents.isDestroyed()
  const cookies = await session.fromPartition(persistentPartition).cookies.get({
    domain: 'example.com',
  }).catch(() => [])
  return {
    pid: process.pid,
    cdpPort,
    contentBaseUrl,
    activeHost,
    browserWebContentsId: browserDestroyed ? null : browserContents.id,
    browserUrl: browserDestroyed ? '' : browserContents.getURL(),
    brainWebContentsId: brainDestroyed ? null : brainContents.id,
    brainUrl: brainDestroyed ? '' : brainContents.getURL(),
    persistentPartition,
    exampleCookies: cookies.map(cookie => ({
      name: cookie.name,
      value: cookie.value,
      expirationDate: cookie.expirationDate,
    })),
  }
}

function writeJson(response, status, payload) {
  response.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'cache-control': 'no-store',
  })
  response.end(JSON.stringify(payload))
}

async function startContentServer() {
  contentServer = http.createServer(async (request, response) => {
    const url = new URL(request.url, 'http://127.0.0.1')
    if (url.pathname === '/brain') {
      response.writeHead(200, { 'content-type': 'text/html; charset=utf-8' })
      response.end(html('Alice Brain UI spike', 'ALICE_BRAIN_UI_DO_NOT_AUTOMATE'))
      return
    }
    if (url.pathname === '/browser') {
      response.writeHead(200, { 'content-type': 'text/html; charset=utf-8' })
      response.end(html('Alice browser surface spike', 'ALICE_BROWSER_SURFACE'))
      return
    }
    if (url.pathname === '/state') {
      writeJson(response, 200, await state())
      return
    }
    if (url.pathname === '/move') {
      const host = url.searchParams.get('host')
      if (!['small', 'large'].includes(host)) {
        writeJson(response, 400, { error: 'host must be small or large' })
        return
      }
      moveBrowserView(host)
      writeJson(response, 200, await state())
      return
    }
    if (url.pathname === '/quit') {
      await browserSession?.cookies.flushStore().catch(() => {})
      browserSession?.flushStorageData()
      writeJson(response, 200, { ok: true })
      setImmediate(() => app.quit())
      return
    }
    writeJson(response, 404, { error: 'not found' })
  })
  await new Promise((resolve, reject) => {
    contentServer.once('error', reject)
    contentServer.listen(0, '127.0.0.1', resolve)
  })
  const address = contentServer.address()
  contentBaseUrl = `http://127.0.0.1:${address.port}`
}

async function createFixture() {
  await startContentServer()

  const safePreferences = {
    contextIsolation: true,
    nodeIntegration: false,
    sandbox: true,
  }
  smallWindow = new BrowserWindow({
    show: false,
    width: 620,
    height: 400,
    webPreferences: {
      ...safePreferences,
      // Check whether Electron can keep the privileged Brain UI out of the
      // app-wide remote-debugging target catalog.
      devTools: false,
    },
  })
  largeWindow = new BrowserWindow({
    show: false,
    width: 1040,
    height: 700,
    webPreferences: {
      ...safePreferences,
      devTools: false,
    },
  })

  // A separate persistent Electron StoragePartition becomes a separate
  // Playwright BrowserContext. That is the key isolation boundary for the
  // programmatic MCP connection tested by the parent script.
  browserSession = session.fromPartition(persistentPartition, {
    cache: true,
  })
  browserView = new WebContentsView({
    webPreferences: {
      ...safePreferences,
      devTools: true,
      session: browserSession,
    },
  })
  browserView.webContents.setWindowOpenHandler(() => ({ action: 'deny' }))
  smallWindow.webContents.setWindowOpenHandler(() => ({ action: 'deny' }))

  await Promise.all([
    smallWindow.loadURL(`${contentBaseUrl}/brain?target=brain-ui`),
    largeWindow.loadURL('about:blank'),
    browserView.webContents.loadURL(`${contentBaseUrl}/browser?target=browser-surface`),
  ])
  moveBrowserView('small')

  if (readyFile) {
    fs.mkdirSync(path.dirname(readyFile), { recursive: true })
    fs.writeFileSync(readyFile, JSON.stringify(await state(), null, 2))
  }
}

app.whenReady().then(createFixture).catch(error => {
  console.error(error)
  process.exitCode = 1
  app.quit()
})

app.on('window-all-closed', event => {
  // Keep the fixture deterministic if an attached MCP mistakenly closes the
  // Brain UI window. The parent process is responsible for shutdown.
  event.preventDefault()
})

app.on('before-quit', () => {
  try { contentServer?.close() } catch {}
})
