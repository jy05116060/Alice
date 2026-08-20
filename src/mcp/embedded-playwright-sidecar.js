import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js'
import { createConnection } from '@playwright/mcp'
import { chromium } from 'playwright'
import navigationExposure from './playwright-official-navigation.cjs'

import {
  createSinglePageContextFacade,
  findEmbeddedBrowserPage,
  normalizeEmbeddedBrowserTarget,
} from './embedded-playwright-connection.js'

const { exposeOfficialNavigationTools } = navigationExposure

function readJsonEnvironment(name) {
  const value = String(process.env[name] || '').trim()
  if (!value) throw new Error(`${name} is required`)
  return JSON.parse(value)
}

async function main() {
  exposeOfficialNavigationTools()
  const target = normalizeEmbeddedBrowserTarget(
    readJsonEnvironment('ALICE_EMBEDDED_PLAYWRIGHT_TARGET'),
  )
  const mcpConfig = readJsonEnvironment('ALICE_EMBEDDED_PLAYWRIGHT_CONFIG')
  const browser = await chromium.connectOverCDP(target.cdpEndpoint, { timeout: 15_000 })
  const { context, page } = await findEmbeddedBrowserPage(browser, target.targetId)
  const facade = createSinglePageContextFacade(context, page)
  const server = await createConnection(mcpConfig, async () => facade)
  const transport = new StdioServerTransport()

  // Never call browser.close(), context.close(), or page.close(). The Electron
  // host owns the live browser surface; terminating this sidecar only drops its
  // CDP socket and leaves that page, session, and UI intact.
  process.once('SIGTERM', () => process.exit(0))
  process.once('SIGINT', () => process.exit(0))
  process.stdin.once('end', () => process.exit(0))
  await server.connect(transport)
}

main().catch(error => {
  console.error(error?.stack || error?.message || String(error))
  process.exit(1)
})
