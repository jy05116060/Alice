import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js'
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js'
import { createConnection } from '@playwright/mcp'
import { chromium } from 'playwright'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import navigationExposure from './playwright-official-navigation.cjs'

const { exposeOfficialNavigationTools } = navigationExposure

const LOOPBACK_HOSTS = new Set(['127.0.0.1', 'localhost', '[::1]'])
const TARGET_ID_RE = /^[A-Za-z0-9._:-]{1,160}$/
const browserAttachments = new Map()
const SIDECAR_ENTRY = path.join(path.dirname(fileURLToPath(import.meta.url)), 'embedded-playwright-sidecar.js')
const SIDECAR_ENV_NAMES = Object.freeze([
  'ALICE_BROWSER_PRIVATE_NETWORK',
  'ALICE_BUNDLED_PLAYWRIGHT',
  'ALICE_RESOURCES_DIR',
  'ALICE_USER_DIR',
  'ComSpec',
  'HOME',
  'LOCALAPPDATA',
  'PATH',
  'PLAYWRIGHT_BROWSERS_PATH',
  'PLAYWRIGHT_HOST_PLATFORM_OVERRIDE',
  'SystemRoot',
  'TEMP',
  'TMP',
  'TMPDIR',
  'USERPROFILE',
])

export function getEmbeddedBrowserBridge({
  bridge = globalThis.aliceBrowserEmbedBridge,
} = {}) {
  return bridge && typeof bridge.getTarget === 'function' ? bridge : null
}

export function normalizeEmbeddedBrowserTarget(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error('embedded browser target is unavailable')
  }
  const endpoint = new URL(String(value.cdpEndpoint || ''))
  if (!['http:', 'https:'].includes(endpoint.protocol) || !LOOPBACK_HOSTS.has(endpoint.hostname)) {
    throw new Error('embedded browser CDP endpoint must use loopback HTTP')
  }
  const targetId = String(value.targetId || '').trim()
  if (!TARGET_ID_RE.test(targetId)) {
    throw new Error('embedded browser DevTools target is unavailable')
  }
  const webContentsId = Number(value.webContentsId)
  if (!Number.isInteger(webContentsId) || webContentsId <= 0) {
    throw new Error('embedded browser webContents id is unavailable')
  }
  return Object.freeze({
    ...value,
    cdpEndpoint: endpoint.origin,
    targetId,
    webContentsId,
  })
}

async function attachBrowser(endpoint, chromiumApi = chromium) {
  const cached = browserAttachments.get(endpoint)
  if (cached) {
    const browser = await cached.catch(() => null)
    if (browser?.isConnected?.()) return browser
    browserAttachments.delete(endpoint)
  }

  const pending = chromiumApi.connectOverCDP(endpoint, {
    timeout: 10_000,
  })
  browserAttachments.set(endpoint, pending)
  try {
    const browser = await pending
    browser.once?.('disconnected', () => {
      if (browserAttachments.get(endpoint) === pending) browserAttachments.delete(endpoint)
    })
    return browser
  } catch (error) {
    if (browserAttachments.get(endpoint) === pending) browserAttachments.delete(endpoint)
    throw error
  }
}

export async function resolvePageTargetId(context, page) {
  const session = await context.newCDPSession(page)
  try {
    const result = await session.send('Target.getTargetInfo')
    return String(result?.targetInfo?.targetId || '')
  } finally {
    await session.detach().catch(() => {})
  }
}

export async function findEmbeddedBrowserPage(browser, targetId) {
  const pages = browser.contexts().flatMap(context => (
    context.pages().map(page => ({ context, page }))
  ))
  for (const entry of pages) {
    if (entry.page.isClosed()) continue
    try {
      if (await resolvePageTargetId(entry.context, entry.page) === targetId) return entry
    } catch {}
  }
  throw new Error(`embedded browser page target "${targetId}" was not found`)
}

// Electron exposes all WebContents as pages in one CDP BrowserContext, even
// when they use different StoragePartitions. Playwright MCP accepts a context,
// not a page, so present a deliberately narrow context facade containing only
// the WebContentsView page selected by its exact DevTools target id.
export function createSinglePageContextFacade(context, allowedPage) {
  let facade
  facade = new Proxy(context, {
    get(target, property) {
      if (property === 'pages') {
        return () => allowedPage.isClosed() ? [] : [allowedPage]
      }
      if (property === 'newPage') {
        return async () => {
          throw new Error('Alice embedded browser supports one managed page')
        }
      }
      if (property === 'route') return (...args) => allowedPage.route(...args)
      if (property === 'unroute') return (...args) => allowedPage.unroute(...args)
      if (property === 'unrouteAll') return (...args) => allowedPage.unrouteAll(...args)
      if (property === 'routeWebSocket') return (...args) => allowedPage.routeWebSocket(...args)
      if (property === 'addInitScript') return (...args) => allowedPage.addInitScript(...args)
      // The Electron host owns page/context lifetime. MCP disposal and config
      // reconciliation must only detach the in-memory protocol connection.
      if (property === 'close') return async () => {}
      if (['on', 'addListener', 'once'].includes(property)) {
        return (eventName, listener) => {
          // Popup creation is denied by the Electron host. Do not let another
          // Electron WebContents enter this managed MCP context.
          if (eventName !== 'page') target[property](eventName, listener)
          return facade
        }
      }
      if (['off', 'removeListener'].includes(property)) {
        return (eventName, listener) => {
          if (eventName !== 'page') target[property](eventName, listener)
          return facade
        }
      }
      const member = Reflect.get(target, property, target)
      return typeof member === 'function' ? member.bind(target) : member
    },
  })
  return facade
}

export async function resolveEmbeddedBrowserTarget({
  bridge = getEmbeddedBrowserBridge(),
} = {}) {
  if (!bridge) return null
  return normalizeEmbeddedBrowserTarget(await bridge.getTarget())
}

export async function connectEmbeddedPlaywrightInProcess({
  target,
  mcpConfig,
  ClientClass = Client,
  createConnectionFn = createConnection,
  chromiumApi = chromium,
  createTransportPair = () => InMemoryTransport.createLinkedPair(),
} = {}) {
  exposeOfficialNavigationTools()
  const safeTarget = normalizeEmbeddedBrowserTarget(target)
  const browser = await attachBrowser(safeTarget.cdpEndpoint, chromiumApi)
  const { context, page } = await findEmbeddedBrowserPage(browser, safeTarget.targetId)
  const browserContext = createSinglePageContextFacade(context, page)
  const server = await createConnectionFn(mcpConfig, async () => browserContext)
  const [clientTransport, serverTransport] = createTransportPair()
  const client = new ClientClass({ name: 'alice', version: '2.1.0' })

  try {
    await Promise.all([
      server.connect(serverTransport),
      client.connect(clientTransport),
    ])
  } catch (error) {
    await client.close().catch(() => {})
    await server.close().catch(() => {})
    throw error
  }

  return {
    browser,
    browserContext,
    client,
    page,
    server,
    target: safeTarget,
    transport: clientTransport,
    async close() {
      // Intentionally do not call browser.close(), context.close(), or
      // page.close(): those would destroy the live Electron UI surface.
      await client.close().catch(() => {})
      await server.close().catch(() => {})
    },
  }
}

function sidecarEnvironment(target, mcpConfig, source = process.env) {
  const env = {}
  for (const name of SIDECAR_ENV_NAMES) {
    if (source[name]) env[name] = String(source[name])
  }
  env.ALICE_EMBEDDED_PLAYWRIGHT_TARGET = JSON.stringify(target)
  env.ALICE_EMBEDDED_PLAYWRIGHT_CONFIG = JSON.stringify(mcpConfig || {})
  // In packaged builds process.execPath is Electron. Node mode lets the same
  // signed executable run this small ESM sidecar without starting another app.
  if (process.versions.electron) env.ELECTRON_RUN_AS_NODE = '1'
  return env
}

export async function connectEmbeddedPlaywrightSidecar({
  target,
  mcpConfig,
  ClientClass = Client,
  TransportClass = StdioClientTransport,
  command = process.execPath,
  sidecarPath = SIDECAR_ENTRY,
  env = process.env,
  connectTimeoutMs = 20_000,
  logger = console,
} = {}) {
  const safeTarget = normalizeEmbeddedBrowserTarget(target)
  const client = new ClientClass({ name: 'alice', version: '2.1.0' })
  const transport = new TransportClass({
    command,
    args: [sidecarPath],
    env: sidecarEnvironment(safeTarget, mcpConfig, env),
    stderr: 'pipe',
  })
  transport.stderr?.on?.('data', chunk => {
    const message = String(chunk || '').trim()
    if (message) logger.warn?.(`[embedded-playwright] ${message.slice(0, 2000)}`)
  })

  let timer
  try {
    await Promise.race([
      client.connect(transport),
      new Promise((_, reject) => {
        timer = setTimeout(
          () => reject(new Error(`embedded Playwright sidecar timed out after ${connectTimeoutMs}ms`)),
          connectTimeoutMs,
        )
      }),
    ])
  } catch (error) {
    await client.close().catch(() => {})
    throw error
  } finally {
    clearTimeout(timer)
  }

  return {
    browser: null,
    browserContext: null,
    client,
    page: null,
    server: null,
    target: safeTarget,
    transport,
    async close() {
      await client.close().catch(() => {})
    },
  }
}

export async function connectEmbeddedPlaywright(options = {}) {
  const useSidecar = options.useSidecar ?? Boolean(process.versions.electron)
  return useSidecar
    ? connectEmbeddedPlaywrightSidecar(options)
    : connectEmbeddedPlaywrightInProcess(options)
}

export const __internal = {
  TARGET_ID_RE,
  SIDECAR_ENTRY,
  SIDECAR_ENV_NAMES,
  attachBrowser,
  browserAttachments,
  sidecarEnvironment,
}
