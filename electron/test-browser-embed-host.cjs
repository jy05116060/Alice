'use strict'

const assert = require('node:assert/strict')
const { EventEmitter } = require('node:events')
const {
  BROWSER_EMBED_PARTITION,
  createBrowserEmbedHost,
  isAllowedWebUrl,
  isTrustedGoogleOauthPopupUrl,
  normalizeBounds,
} = require('./browser-embed-host.cjs')

class FakeSession extends EventEmitter {
  constructor() {
    super()
    this.webRequest = {
      onBeforeRequest: (filter, handler) => {
        this.beforeRequestFilter = filter
        this.beforeRequestHandler = handler
      },
    }
  }
  setPermissionRequestHandler(handler) { this.permissionRequestHandler = handler }
  setPermissionCheckHandler(handler) { this.permissionCheckHandler = handler }
}

class FakeWebContents extends EventEmitter {
  constructor() {
    super()
    this.id = 42
    this.session = new FakeSession()
    this.url = ''
    this.loadCalls = []
    this.insertCssCalls = []
    this.removedCssKeys = []
    this.nextCssKey = 0
    this.destroyed = false
  }

  setWindowOpenHandler(handler) { this.windowOpenHandler = handler }
  isDestroyed() { return this.destroyed }
  getURL() { return this.url }
  getTitle() { return this.title || '' }
  async loadURL(url) {
    this.loadCalls.push(url)
    this.emit('did-start-navigation', {}, url, false, true)
    this.url = url
    this.emit('did-navigate', {}, url)
    this.emit('did-finish-load')
    this.emit('did-stop-loading')
  }
  async insertCSS(css, options) {
    const key = `css-${++this.nextCssKey}`
    this.insertCssCalls.push({ css, options, key })
    return key
  }
  async removeInsertedCSS(key) { this.removedCssKeys.push(key) }
  setZoomFactor(value) { this.zoomFactor = value }
  close() { this.destroyed = true }
}

class FakeView {
  constructor() {
    this.visible = true
    this.bounds = null
    this.radius = null
    this.background = null
  }

  setVisible(value) { this.visible = value }
  setBounds(value) { this.bounds = { ...value } }
  setBorderRadius(value) { this.radius = value }
  setBackgroundColor(value) { this.background = value }
}

class FakeWebContentsView extends FakeView {
  static instances = []

  constructor(options) {
    super()
    this.options = options
    this.webContents = new FakeWebContents()
    FakeWebContentsView.instances.push(this)
  }
}

class FakeContentView {
  constructor() { this.children = [] }
  addChildView(view) {
    if (!this.children.includes(view)) this.children.push(view)
  }
  removeChildView(view) {
    this.children = this.children.filter(child => child !== view)
  }
}

class FakeWindow extends EventEmitter {
  constructor({ x = 0, y = 0, width = 1000, height = 700, show = false } = {}) {
    super()
    this.contentView = new FakeContentView()
    this.contentBounds = { x, y, width, height }
    this.contentBoundsCalls = []
    this.visible = show
    this.destroyed = false
  }

  getContentBounds() { return { ...this.contentBounds } }
  setContentBounds(value, animate = false) {
    const previous = this.contentBounds
    this.contentBounds = { ...value }
    this.contentBoundsCalls.push({ bounds: { ...value }, animate })
    if (previous.x !== value.x || previous.y !== value.y) this.emit('move')
    if (previous.width !== value.width || previous.height !== value.height) this.emit('resize')
  }
  setBounds(value, animate = false) { this.setContentBounds(value, animate) }
  isDestroyed() { return this.destroyed }
  show() { this.visible = true }
  hide() { this.visible = false }
  focus() {}
  destroy() {
    this.destroyed = true
    this.emit('closed')
  }
}

class FakeBaseWindow extends FakeWindow {
  static instances = []

  constructor(options) {
    super(options)
    this.options = options
    FakeBaseWindow.instances.push(this)
  }
}

async function waitUntil(predicate, message) {
  for (let attempt = 0; attempt < 50; attempt += 1) {
    if (predicate()) return
    await new Promise(resolve => setImmediate(resolve))
  }
  throw new Error(message)
}

function requestDecision(targetSession, url) {
  return new Promise(resolve => targetSession.beforeRequestHandler({ url }, resolve))
}

async function run() {
  assert.equal(isAllowedWebUrl('https://example.com/path'), true)
  assert.equal(isAllowedWebUrl('http://127.0.0.1:3721/'), true)
  assert.equal(isAllowedWebUrl('file:///tmp/private'), false)
  assert.equal(isAllowedWebUrl('javascript:alert(1)'), false)
  assert.equal(isTrustedGoogleOauthPopupUrl('https://accounts.google.com/gsi/select?client_id=test'), true)
  assert.equal(isTrustedGoogleOauthPopupUrl('https://accounts.google.evil.example/gsi/select'), false)
  assert.equal(isTrustedGoogleOauthPopupUrl('http://accounts.google.com/gsi/select'), false)
  assert.deepEqual(
    normalizeBounds({ x: 10.25, y: 20.5, width: 300.25, height: 200 }, { width: 1000, height: 700 }),
    { x: 10, y: 20, width: 301, height: 201 },
  )
  assert.deepEqual(
    normalizeBounds({ x: 900, y: 0, width: 103, height: 100 }, { width: 1000, height: 700 }),
    { x: 900, y: 0, width: 103, height: 100 },
    'a card transition may move a bounded native view beyond the right edge',
  )
  assert.deepEqual(
    normalizeBounds({ x: 1024, y: 0, width: 500, height: 300 }, { width: 1000, height: 700 }),
    { x: 1024, y: 0, width: 500, height: 300 },
    'the first off-screen card animation frame stays inside its bounded horizontal budget',
  )
  assert.throws(
    () => normalizeBounds({ x: 1131, y: 0, width: 100, height: 100 }, { width: 1000, height: 700 }),
    /transition budget/,
  )
  assert.deepEqual(
    normalizeBounds({ x: 0, y: 0, width: 1001.5, height: 701.5 }, { width: 1000, height: 700 }),
    { x: 0, y: 0, width: 1002, height: 702 },
    'sub-pixel zoom rounding may retain the transition tolerance outside the native bounds',
  )

  const warnings = []
  const navigations = []
  const diagnosticInputs = []
  const host = createBrowserEmbedHost({
    WebContentsView: FakeWebContentsView,
    View: FakeView,
    BaseWindow: FakeBaseWindow,
    logger: { warn: (...args) => warnings.push(args) },
    platform: 'win32',
    onNavigation: entry => navigations.push(entry),
    nativeRequestGuard: true,
    onDiagnosticInput: input => {
      diagnosticInputs.push(input)
      return input?.key === 'F12' && input?.shift === true
    },
    assertNavigationAllowed: async url => {
      const parsed = new URL(url)
      if (['localhost', '127.0.0.1', '::1'].includes(parsed.hostname)) {
        throw new Error('private or local network target is disabled')
      }
      return parsed.href
    },
    transitionDurationMs: 480,
    waitForTransition: async () => {},
  })
  const mainWindow = new FakeWindow({ x: 100, y: 80 })
  const primedState = await host.prime(mainWindow)
  assert.equal(primedState.visible, false)
  assert.equal(primedState.webContentsId, 42)
  assert.equal(primedState.zoomFactor, 1)
  assert.deepEqual(
    FakeWebContentsView.instances[0].webContents.loadCalls,
    ['about:blank#alice-browser-42'],
    'prime must commit a renderer before Playwright attaches over CDP',
  )
  const cardState = await host.update(mainWindow, {
    mode: 'card',
    visible: true,
    bounds: { x: 20, y: 30, width: 640, height: 360 },
    radius: 20,
    url: 'https://example.com',
    interactive: false,
  })

  assert.equal(FakeWebContentsView.instances.length, 1)
  const view = FakeWebContentsView.instances[0]
  assert.equal(view.options.webPreferences.partition, BROWSER_EMBED_PARTITION)
  assert.equal(view.options.webPreferences.sandbox, true)
  assert.equal(view.options.webPreferences.nodeIntegration, false)
  assert.equal(view.options.webPreferences.contextIsolation, true)
  assert.equal(Object.hasOwn(view.options.webPreferences, 'preload'), false)
  assert.deepEqual(cardState.bounds, { x: 20, y: 30, width: 640, height: 360 })
  assert.equal(cardState.mode, 'card')
  assert.equal(cardState.url, 'https://example.com/')
  assert.equal(cardState.zoomFactor, 0.5)
  assert.equal(view.webContents.zoomFactor, 0.5)
  assert.equal(view.webContents.insertCssCalls.length, 2,
    'Windows card mode reapplies its compact scrollbar style after navigation')
  assert.equal(view.webContents.insertCssCalls.at(-1).options.cssOrigin, 'user')
  assert.match(view.webContents.insertCssCalls.at(-1).css, /::-webkit-scrollbar/)
  assert.match(view.webContents.insertCssCalls.at(-1).css, /display: none !important/)
  assert.match(view.webContents.insertCssCalls.at(-1).css, /width: 0 !important/)
  assert.match(view.webContents.insertCssCalls.at(-1).css, /height: 0 !important/)
  assert.equal(view.visible, true)
  assert.equal(view.radius, 20)
  assert.equal(mainWindow.contentView.children[0], view)
  assert.equal(mainWindow.contentView.children[1].visible, true)

  let diagnosticShortcutPrevented = false
  view.webContents.emit(
    'before-input-event',
    { preventDefault: () => { diagnosticShortcutPrevented = true } },
    { type: 'keyDown', key: 'F12', shift: true },
  )
  assert.equal(diagnosticShortcutPrevented, true, 'embedded-page diagnostic shortcuts are handled before the input shield')
  assert.equal(diagnosticInputs.length, 1)

  assert.equal(typeof view.webContents.windowOpenHandler, 'function')
  assert.equal(view.webContents.session.permissionCheckHandler(), false)
  let permissionResult = true
  view.webContents.session.permissionRequestHandler(null, 'geolocation', result => { permissionResult = result })
  assert.equal(permissionResult, false)
  let downloadPrevented = false
  let downloadCancelled = false
  view.webContents.session.emit(
    'will-download',
    { preventDefault: () => { downloadPrevented = true } },
    { cancel: () => { downloadCancelled = true } },
  )
  assert.equal(downloadPrevented, true)
  assert.equal(downloadCancelled, true)
  assert.deepEqual(view.webContents.session.beforeRequestFilter.urls, [
    'http://*/*',
    'https://*/*',
    'ws://*/*',
    'wss://*/*',
  ])
  assert.deepEqual(
    await requestDecision(view.webContents.session, 'https://example.com/public.js'),
    { cancel: false },
    'native Electron request guard allows a public subresource without Playwright routing',
  )
  assert.deepEqual(
    await requestDecision(view.webContents.session, 'http://127.0.0.1/private'),
    { cancel: true },
    'native Electron request guard blocks a private HTTP subresource or redirect',
  )
  assert.deepEqual(
    await requestDecision(view.webContents.session, 'ws://127.0.0.1/events'),
    { cancel: true },
    'native Electron request guard also blocks a private WebSocket',
  )
  let navigationPrevented = false
  view.webContents.emit('will-navigate', {
    url: 'file:///etc/passwd',
    preventDefault: () => { navigationPrevented = true },
  })
  assert.equal(navigationPrevented, true)

  const target = host.getTarget()
  assert.deepEqual(target, {
    webContentsId: 42,
    partition: BROWSER_EMBED_PARTITION,
    url: 'https://example.com/',
    debugUrl: 'https://example.com/',
    mode: 'card',
    visible: true,
    nativeNetworkGuard: true,
  })

  await host.update(mainWindow, {
    mode: 'card',
    visible: true,
    bounds: { x: 25, y: 35, width: 600, height: 340 },
    radius: 18,
    url: 'https://example.com',
    interactive: true,
  })
  assert.equal(view.webContents.loadCalls.length, 2, 'layout updates must not reload the page')
  assert.equal(mainWindow.contentView.children[1].visible, false, 'interactive mode removes the input shield')

  view.webContents.url = 'https://example.org/after-playwright'
  view.webContents.emit('did-navigate', {}, view.webContents.url)
  await host.update(mainWindow, {
    mode: 'card',
    visible: true,
    bounds: { x: 25, y: 35, width: 600, height: 340 },
    radius: 18,
    url: 'https://example.org/after-playwright',
    interactive: true,
  })
  assert.equal(view.webContents.loadCalls.length, 2, 'Playwright navigation must not be loaded a second time')
  assert.ok(navigations.some(entry => entry.url === 'https://example.org/after-playwright'),
    'an ordinary same-page navigation remains in the one managed WebContents and is recorded')

  const popupDecision = view.webContents.windowOpenHandler({
    url: 'https://example.net/target-blank-destination',
    disposition: 'foreground-tab',
  })
  assert.deepEqual(popupDecision, { action: 'deny' }, 'target=_blank never creates a second WebContents')
  const popupTakeover = await host.consumeWindowOpenNavigation()
  assert.equal(popupTakeover.ok, true)
  assert.equal(popupTakeover.finalUrl, 'https://example.net/target-blank-destination')
  assert.equal(view.webContents.getURL(), popupTakeover.finalUrl,
    'a safe target=_blank URL navigates the current managed page in place')

  const googlePopupDecision = view.webContents.windowOpenHandler({
    url: 'https://accounts.google.com/gsi/select?client_id=test',
    disposition: 'new-popup',
  })
  assert.equal(googlePopupDecision.action, 'allow',
    'Google OAuth keeps its opener-preserving user-operated popup')
  assert.equal(googlePopupDecision.overrideBrowserWindowOptions.webPreferences.partition, BROWSER_EMBED_PARTITION)
  assert.equal(googlePopupDecision.overrideBrowserWindowOptions.webPreferences.nodeIntegration, false)
  const googlePopup = await host.consumeWindowOpenNavigation()
  assert.equal(googlePopup.kind, 'google_oauth_popup')
  assert.equal(googlePopup.ok, true)
  assert.equal(view.webContents.getURL(), popupTakeover.finalUrl,
    'opening Google OAuth does not replace the managed X page')

  for (const dangerousUrl of [
    'javascript:alert(1)',
    'file:///etc/passwd',
    'http://127.0.0.1:3721/private',
  ]) {
    assert.deepEqual(view.webContents.windowOpenHandler({ url: dangerousUrl }), { action: 'deny' })
    const blockedTakeover = await host.consumeWindowOpenNavigation()
    assert.equal(blockedTakeover.ok, false, `${dangerousUrl} is rejected instead of navigating`)
    assert.equal(view.webContents.getURL(), popupTakeover.finalUrl,
      'a rejected popup target leaves the controlled page unchanged')
  }

  const cardScrollbarCssKey = view.webContents.insertCssCalls.at(-1).key
  const cardScrollbarInsertCount = view.webContents.insertCssCalls.length
  const windowState = await host.update(mainWindow, {
    mode: 'window',
    visible: true,
    radius: 99,
    interactive: true,
    transition: true,
  })
  assert.equal(FakeWebContentsView.instances.length, 1, 'large mode must reuse the same WebContentsView')
  assert.equal(FakeBaseWindow.instances.length, 1)
  assert.equal(FakeBaseWindow.instances[0].options.frame, true)
  assert.equal(FakeBaseWindow.instances[0].options.titleBarStyle, 'default')
  assert.equal(FakeBaseWindow.instances[0].options.closable, true)
  assert.equal(FakeBaseWindow.instances[0].options.movable, true)
  assert.equal(mainWindow.contentView.children.includes(view), false)
  assert.equal(FakeBaseWindow.instances[0].contentView.children[0], view)
  assert.equal(FakeBaseWindow.instances[0].visible, true)
  assert.equal(windowState.mode, 'window')
  assert.equal(windowState.radius, 0)
  assert.equal(windowState.zoomFactor, 1)
  assert.equal(view.webContents.zoomFactor, 1)
  assert.deepEqual(view.webContents.removedCssKeys, [cardScrollbarCssKey],
    'large-window mode restores the normal page scrollbar')
  assert.equal(windowState.transitioning, false)
  assert.deepEqual(FakeBaseWindow.instances[0].contentBoundsCalls.slice(0, 2), [
    {
      bounds: { x: 125, y: 115, width: 600, height: 340 },
      animate: false,
    },
    {
      bounds: { x: 0, y: 0, width: 1280, height: 840 },
      animate: true,
    },
  ], 'card-to-window transition starts at the card screen rectangle and expands natively')
  assert.equal(view.webContents.loadCalls.length, 3, 'switching hosts must not reload the page')

  let closePrevented = false
  FakeBaseWindow.instances[0].emit('close', {
    preventDefault() { closePrevented = true },
  })
  const dismissedWindowState = host.getState(mainWindow)
  assert.equal(closePrevented, true, 'the native close button must dismiss instead of destroying the page')
  assert.equal(FakeBaseWindow.instances[0].visible, false)
  assert.equal(dismissedWindowState.visible, false)
  assert.equal(dismissedWindowState.webContentsId, windowState.webContentsId)
  assert.equal(view.webContents.isDestroyed(), false)

  await host.update(mainWindow, {
    mode: 'window',
    visible: true,
    interactive: true,
  })
  assert.equal(FakeBaseWindow.instances[0].visible, true, 'the same large browser can be shown again')
  assert.equal(host.getState(mainWindow).webContentsId, windowState.webContentsId)

  FakeBaseWindow.instances[0].setContentBounds({ x: 70, y: 55, width: 1080, height: 720 })

  await host.update(mainWindow, {
    mode: 'card',
    visible: true,
    bounds: { x: 0, y: 0, width: 500, height: 300 },
    radius: 16,
    interactive: false,
    transition: true,
  })
  assert.equal(FakeWebContentsView.instances.length, 1)
  assert.equal(mainWindow.contentView.children[0], view)
  assert.equal(FakeBaseWindow.instances[0].visible, false)
  assert.equal(view.webContents.zoomFactor, 500 / 1280)
  assert.equal(view.webContents.insertCssCalls.length, cardScrollbarInsertCount + 1,
    'returning to the card restores the compact scrollbar without reloading')
  assert.deepEqual(FakeBaseWindow.instances[0].contentBoundsCalls.at(-1), {
    bounds: { x: 100, y: 80, width: 500, height: 300 },
    animate: true,
  }, 'window-to-card transition shrinks to the final card screen rectangle')
  assert.equal(view.webContents.loadCalls.length, 3, 'reverse host switching also preserves the page')

  await host.update(mainWindow, {
    mode: 'window',
    visible: true,
    interactive: true,
    transition: true,
  })
  assert.deepEqual(FakeBaseWindow.instances[0].contentBoundsCalls.at(-1), {
    bounds: { x: 70, y: 55, width: 1080, height: 720 },
    animate: true,
  }, 'returning to the large browser restores the user-adjusted large-window bounds')
  await host.update(mainWindow, {
    mode: 'card',
    visible: true,
    bounds: { x: 0, y: 0, width: 500, height: 300 },
    radius: 16,
    interactive: false,
    transition: true,
  })

  const replacementWindow = new FakeWindow()
  assert.equal(host.transferMainWindow(mainWindow, replacementWindow), true)
  assert.equal(replacementWindow.contentView.children[0], view)
  assert.equal(FakeWebContentsView.instances.length, 1)

  await assert.rejects(
    host.update(mainWindow, {
      mode: 'card',
      visible: true,
      bounds: { x: 0, y: 0, width: 500, height: 300 },
      url: 'file:///tmp/not-allowed',
    }),
    /http/,
  )
  await assert.rejects(
    host.update(mainWindow, {
      mode: 'floating',
      visible: true,
      bounds: { x: 0, y: 0, width: 500, height: 300 },
    }),
    /mode/,
  )

  host.hide(replacementWindow)
  assert.equal(host.getState(replacementWindow).visible, false)
  host.releaseWindow(replacementWindow)
  assert.equal(view.webContents.destroyed, false, 'closing the main window must preserve the MCP target')
  assert.equal(host.getTarget().webContentsId, 42)

  const reopenedWindow = new FakeWindow()
  const reopenedState = await host.prime(reopenedWindow)
  assert.equal(reopenedState.webContentsId, 42)
  assert.equal(FakeWebContentsView.instances.length, 1, 'reopening must reattach the existing WebContentsView')
  assert.equal(reopenedWindow.contentView.children[0], view)

  const closedState = host.closePage()
  assert.equal(view.webContents.destroyed, true, 'browser close must destroy the live WebContents')
  assert.equal(closedState.webContentsId, null)
  assert.equal(host.getTarget(), null)

  const afterCloseWindow = new FakeWindow()
  const afterCloseState = await host.prime(afterCloseWindow)
  assert.equal(FakeWebContentsView.instances.length, 2, 'a later browser action creates a fresh WebContentsView')
  assert.equal(afterCloseState.partition, BROWSER_EMBED_PARTITION,
    'the fresh page continues using the same persistent profile partition')

  host.destroyAll()
  assert.equal(FakeWebContentsView.instances[1].webContents.destroyed, true)
  assert.equal(host.getTarget(), null)
  assert.equal(warnings.length, 5, 'native request and popup policy blocks are observable')
  assert.equal(
    warnings.filter(args => String(args[0]).includes('blocked new-window navigation')).length,
    3,
  )
  assert.equal(
    warnings.filter(args => String(args[0]).includes('blocked network request')).length,
    2,
  )

  const transitionResolvers = []
  const interruptHost = createBrowserEmbedHost({
    WebContentsView: FakeWebContentsView,
    View: FakeView,
    BaseWindow: FakeBaseWindow,
    waitForTransition: () => new Promise(resolve => transitionResolvers.push(resolve)),
  })
  const interruptMainWindow = new FakeWindow({ x: 40, y: 30 })
  await interruptHost.prime(interruptMainWindow)
  await interruptHost.update(interruptMainWindow, {
    mode: 'card',
    visible: true,
    bounds: { x: 10, y: 15, width: 500, height: 300 },
    interactive: false,
  })
  await interruptHost.update(interruptMainWindow, {
    mode: 'window',
    visible: true,
    interactive: true,
  })
  const interruptedView = FakeWebContentsView.instances.at(-1)
  const interruptWindow = FakeBaseWindow.instances.at(-1)
  const shrinkPromise = interruptHost.update(interruptMainWindow, {
    mode: 'card',
    visible: true,
    bounds: { x: 10, y: 15, width: 500, height: 300 },
    interactive: false,
    transition: true,
  })
  await waitUntil(
    () => transitionResolvers.length === 1,
    'window-to-card transition did not start',
  )
  const expandAgainPromise = interruptHost.update(interruptMainWindow, {
    mode: 'window',
    visible: true,
    interactive: true,
    transition: true,
  })
  await waitUntil(
    () => transitionResolvers.length === 2,
    'a reversed card transition did not start the return animation',
  )
  assert.deepEqual(interruptWindow.contentBoundsCalls.at(-1), {
    bounds: { x: 0, y: 0, width: 1280, height: 840 },
    animate: true,
  }, 'interrupting a shrink restores the remembered large-window target')
  transitionResolvers.splice(0).forEach(resolve => resolve())
  await Promise.all([shrinkPromise, expandAgainPromise])
  const interruptedState = interruptHost.getState(interruptMainWindow)
  assert.equal(interruptedState.mode, 'window')
  assert.equal(interruptedState.transitioning, false)
  assert.equal(interruptWindow.contentView.children[0], interruptedView)
  assert.equal(interruptedView.webContents.loadCalls.length, 1, 'an interrupted reversal must not reload the page')
  interruptHost.destroyAll()

  const temporaryPartition = 'alice-browser-temporary-test'
  const temporaryHost = createBrowserEmbedHost({
    WebContentsView: FakeWebContentsView,
    View: FakeView,
    BaseWindow: FakeBaseWindow,
    getPartition: () => temporaryPartition,
  })
  const temporaryWindow = new FakeWindow()
  const temporaryState = await temporaryHost.prime(temporaryWindow)
  assert.equal(temporaryState.partition, temporaryPartition)
  assert.equal(FakeWebContentsView.instances.at(-1).options.webPreferences.partition, temporaryPartition,
    'declining secure storage can use an in-memory browser partition')
  temporaryHost.destroyAll()

  console.log('browser embed host tests passed')
}

run().catch(error => {
  console.error(error)
  process.exitCode = 1
})
