'use strict'

// Trusted Playwright MCP init-page hook. This is not an Agent-facing browser
// tool: it only restores Alice's request-level private-network policy for
// every page, subresource, redirect target, and WebSocket opened by the
// official MCP-managed browser context.
const INSTALLED = Symbol.for('alice.playwrightPageRequestGuardInstalled')

async function installPageGuard({ page }) {
  if (process.env.ALICE_BROWSER_PRIVATE_NETWORK === '1') return
  if (!page || page[INSTALLED]) return
  page[INSTALLED] = true

  const [
    { assertWebUrlAllowed },
    { config },
  ] = await Promise.all([
    import('../capabilities/tools/web/url-policy.js'),
    import('../config.js'),
  ])
  const allowPrivateNetwork = () => (
    process.env.ALICE_BROWSER_PRIVATE_NETWORK === '1'
    || (
      process.env.ALICE_BROWSER_PRIVATE_NETWORK !== '0'
      && config.security?.browserPrivateNetwork === true
    )
  )

  // Keep the guard page-scoped. Electron exposes the privileged Brain UI and
  // the embedded browser as pages in one CDP BrowserContext even when they use
  // different StoragePartitions. Context-wide interception would therefore
  // modify or block Brain UI traffic.
  if (typeof page.routeWebSocket === 'function') {
    await page.routeWebSocket('**/*', async webSocket => {
      try {
        const parsed = new URL(String(webSocket.url()))
        if (!['ws:', 'wss:'].includes(parsed.protocol) || parsed.username || parsed.password) {
          throw new Error('unsafe WebSocket URL')
        }
        parsed.protocol = parsed.protocol === 'wss:' ? 'https:' : 'http:'
        await assertWebUrlAllowed(parsed.href, { allowPrivateNetwork })
        webSocket.connectToServer()
      } catch {
        await Promise.resolve(
          webSocket.close({ code: 1008, reason: 'Blocked by Alice browser network policy' }),
        ).catch(() => {})
      }
    })
  }

  await page.route('**/*', async route => {
    try {
      await assertWebUrlAllowed(route.request().url(), { allowPrivateNetwork })
      await route.continue()
    } catch {
      await route.abort('blockedbyclient').catch(() => {})
    }
  })
}

// Playwright MCP loads init-page modules as `const { default: func } =
// require(path)`, so expose an explicit default property from CommonJS.
module.exports = { default: installPageGuard }
