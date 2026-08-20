import assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'

import {
  createSinglePageContextFacade,
  findEmbeddedBrowserPage,
  normalizeEmbeddedBrowserTarget,
} from './embedded-playwright-connection.js'

function fakePage(targetId) {
  const page = new EventEmitter()
  page.targetId = targetId
  page.closed = false
  page.routeCalls = 0
  page.routeWebSocketCalls = 0
  page.unrouteCalls = 0
  page.unrouteAllCalls = 0
  page.initScriptCalls = 0
  page.isClosed = () => page.closed
  page.route = async () => { page.routeCalls += 1 }
  page.routeWebSocket = async () => { page.routeWebSocketCalls += 1 }
  page.unroute = async () => { page.unrouteCalls += 1 }
  page.unrouteAll = async () => { page.unrouteAllCalls += 1 }
  page.addInitScript = async () => { page.initScriptCalls += 1 }
  return page
}

const brainPage = fakePage('brain-target')
const browserPage = fakePage('browser-target')
const rawContext = new EventEmitter()
rawContext.pages = () => [brainPage, browserPage]
rawContext.newPageCalls = 0
rawContext.closeCalls = 0
rawContext.routeCalls = 0
rawContext.routeWebSocketCalls = 0
rawContext.newPage = async () => { rawContext.newPageCalls += 1 }
rawContext.close = async () => { rawContext.closeCalls += 1 }
rawContext.route = async () => { rawContext.routeCalls += 1 }
rawContext.routeWebSocket = async () => { rawContext.routeWebSocketCalls += 1 }
rawContext.newCDPSession = async page => ({
  async send(method) {
    assert.equal(method, 'Target.getTargetInfo')
    return { targetInfo: { targetId: page.targetId } }
  },
  async detach() {},
})
const browser = { contexts: () => [rawContext] }

const target = normalizeEmbeddedBrowserTarget({
  cdpEndpoint: 'http://127.0.0.1:49200/json/version',
  targetId: 'browser-target',
  webContentsId: 42,
})
assert.equal(target.cdpEndpoint, 'http://127.0.0.1:49200')
assert.throws(
  () => normalizeEmbeddedBrowserTarget({
    cdpEndpoint: 'http://192.168.1.8:9222',
    targetId: 'browser-target',
    webContentsId: 42,
  }),
  /loopback/,
  'non-loopback CDP endpoints must be rejected',
)

const found = await findEmbeddedBrowserPage(browser, target.targetId)
assert.equal(found.page, browserPage, 'exact DevTools target id selects the embedded page')

const facade = createSinglePageContextFacade(rawContext, browserPage)
assert.deepEqual(facade.pages(), [browserPage], 'facade exposes only the selected embedded page')
await facade.route('**/*', () => {})
await facade.routeWebSocket('**/*', () => {})
await facade.unroute('**/*')
await facade.unrouteAll()
await facade.addInitScript({ content: '' })
assert.equal(browserPage.routeCalls, 1)
assert.equal(browserPage.routeWebSocketCalls, 1)
assert.equal(browserPage.unrouteCalls, 1)
assert.equal(browserPage.unrouteAllCalls, 1)
assert.equal(browserPage.initScriptCalls, 1)
assert.equal(rawContext.routeCalls, 0, 'facade never installs context-wide HTTP routes')
assert.equal(rawContext.routeWebSocketCalls, 0, 'facade never installs context-wide WebSocket routes')

await assert.rejects(
  () => facade.newPage(),
  /one managed page/,
  'facade prevents another Electron target from entering the MCP tab set',
)
await facade.close()
assert.equal(rawContext.closeCalls, 0, 'facade close cannot close the Electron BrowserContext')

let observedUnexpectedPage = false
facade.on('page', () => { observedUnexpectedPage = true })
rawContext.emit('page', brainPage)
assert.equal(observedUnexpectedPage, false, 'raw Electron page events do not cross the facade')

console.log('test-embedded-playwright-connection passed')
