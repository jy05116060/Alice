import fs from 'fs'
import os from 'os'
import path from 'path'

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'alice-playwright-mcp-'))
process.env.ALICE_USER_DIR = tmp
process.env.ALICE_RESOURCES_DIR = tmp

let failed = 0
function assert(condition, label, detail = '') {
  if (condition) {
    console.log(`PASS: ${label}`)
    return
  }
  failed += 1
  process.exitCode = 1
  console.error(`FAIL: ${label}${detail ? `\n  ${detail}` : ''}`)
}

function parseJson(value) {
  try { return JSON.parse(String(value || '')) } catch { return null }
}

const {
  BUILTIN_PLAYWRIGHT_ALLOWED_TOOLS,
  BUILTIN_PLAYWRIGHT_BLOCKED_ORIGINS,
  BUILTIN_PLAYWRIGHT_INTERACTIVE_ID,
  BUILTIN_PLAYWRIGHT_READER_ID,
  createBuiltInEmbeddedPlaywrightConfig,
  createBuiltInPlaywrightServer,
} = await import('./playwright-server.js')
const {
  __internal: mcpInternal,
  executeBuiltInPlaywrightTool,
  executeMcpTool,
  getMcpStatus,
  getMcpToolSchema,
  listMcpTools,
  reconcileMcpClients,
  shutdownBuiltInPlaywright,
  shutdownMcpClients,
} = await import('./client-manager.js')
const { config } = await import('../config.js')

const advertisedTools = [
  {
    name: 'browser_navigate',
    description: 'Navigate',
    inputSchema: {
      type: 'object',
      properties: { url: { type: 'string' } },
      required: ['url'],
    },
    annotations: { readOnlyHint: false, destructiveHint: true },
  },
  {
    name: 'browser_snapshot',
    description: 'Snapshot',
    inputSchema: { type: 'object', properties: {} },
    annotations: { readOnlyHint: true, destructiveHint: false },
  },
  ...['browser_navigate_forward', 'browser_reload'].map(name => ({
    name,
    description: name,
    inputSchema: { type: 'object', properties: {} },
    annotations: { readOnlyHint: false, destructiveHint: true },
  })),
  {
    name: 'browser_click',
    description: 'Click',
    inputSchema: {
      type: 'object',
      properties: { element: { type: 'string' }, ref: { type: 'string' } },
      required: ['element', 'ref'],
    },
    annotations: { readOnlyHint: false, destructiveHint: true },
  },
  {
    name: 'browser_close',
    description: 'Close browser',
    inputSchema: { type: 'object', properties: {} },
    annotations: { readOnlyHint: false, destructiveHint: false },
  },
  {
    name: 'browser_tabs',
    description: 'Manage tabs',
    inputSchema: {
      type: 'object',
      properties: {
        action: { type: 'string', enum: ['list', 'new', 'close', 'select'] },
        index: { type: 'number' },
      },
      required: ['action'],
    },
    annotations: { readOnlyHint: false, destructiveHint: false },
  },
  ...[
    'browser_run_code_unsafe',
    'browser_evaluate',
    'browser_file_upload',
    'browser_drop',
    'browser_network_requests',
    'browser_network_request',
  ].map(name => ({
    name,
    description: `Unsafe ${name}`,
    inputSchema: { type: 'object', properties: {} },
    annotations: {},
  })),
]

class FakeTransport {
  constructor(params) {
    this.params = params
    this.stderr = { on() {} }
  }
}

class FakeClient {
  static calls = []
  static instances = []

  constructor() {
    FakeClient.instances.push(this)
  }

  setNotificationHandler() {}

  async connect(transport) {
    this.transport = transport
  }

  async listTools() {
    return { tools: advertisedTools }
  }

  async callTool(request) {
    FakeClient.calls.push({ request, args: this.transport.params.args })
    if (request.name === 'browser_take_screenshot' && request.arguments?.filename) {
      fs.mkdirSync(this.transport.params.cwd, { recursive: true })
      fs.writeFileSync(
        path.join(this.transport.params.cwd, request.arguments.filename),
        Buffer.from('fake-png'),
      )
    }
    return {
      content: [{
        type: 'text',
        text: request.name === 'browser_navigate'
          ? 'called:browser_navigate\n- Page URL: https://example.com/search?q=alice\n- Page Title: Alice Search'
          : `called:${request.name}`,
      }],
      structuredContent: { called: request.name },
    }
  }

  async close() {
    this.onclose?.()
  }
}

const deps = {
  ClientClass: FakeClient,
  TransportClass: FakeTransport,
  builtInOptions: {
    cliPath: path.join(tmp, 'playwright-mcp-cli.js'),
    command: '/fake/electron',
    resourcesDir: tmp,
    userDir: tmp,
    sandboxDir: path.join(tmp, 'sandbox'),
    env: {
      PLAYWRIGHT_BROWSERS_PATH: path.join(tmp, 'browsers'),
      UNRELATED_SECRET: 'must-not-leak',
    },
    electronRuntime: true,
  },
}

try {
  const interactive = createBuiltInPlaywrightServer({
    role: 'interactive',
    ...deps.builtInOptions,
  })
  assert(interactive.id === BUILTIN_PLAYWRIGHT_INTERACTIVE_ID, 'interactive server has a reserved stable id')
  assert(interactive.command === '/fake/electron', 'packaged server uses the supplied Electron executable')
  assert(interactive.env.ELECTRON_RUN_AS_NODE === '1', 'packaged Electron child runs in Node mode')
  assert(interactive.env.UNRELATED_SECRET === undefined, 'built-in child receives only explicit Playwright environment')
  assert(interactive.env.ALICE_BROWSER_PRIVATE_NETWORK === '0',
    'child request guard defaults to private-network blocked')
  assert(interactive.args.includes('--user-data-dir'), 'interactive server uses a persistent profile')
  assert(interactive.args.includes('--config')
    && interactive.args[interactive.args.indexOf('--config') + 1]
      .endsWith('src/mcp/playwright-shared-profile.json'),
  'built-in server restores the previous Chromium session when display modes switch')
  assert(interactive.args.includes('--init-page')
    && interactive.args[interactive.args.indexOf('--init-page') + 1].endsWith('src/mcp/playwright-page-guard.cjs'),
    'built-in server installs Alice request-level URL guard')
  assert(interactive.args.includes('--browser')
    && interactive.args[interactive.args.indexOf('--browser') + 1] === 'chromium',
    'built-in server selects the bundled Chrome for Testing channel')
  assert(interactive.args.includes('--snapshot-mode')
    && interactive.args[interactive.args.indexOf('--snapshot-mode') + 1] === 'full',
    'navigation and action results automatically include fresh accessibility snapshots')
  assert(interactive.args.includes('--blocked-origins')
    && BUILTIN_PLAYWRIGHT_BLOCKED_ORIGINS.every(origin => (
      interactive.args[interactive.args.indexOf('--blocked-origins') + 1].includes(origin)
    )),
    'private-network-disabled server installs the documented origin guardrail')
  assert(!interactive.args.includes('--headless') && !interactive.args.includes('--isolated'),
    'interactive server remains headed and persistent')
  assert(interactive.cwd === path.join(tmp, 'sandbox', 'browser-output', 'interactive'),
    'Playwright filesystem scope is rooted in its dedicated Alice sandbox output directory')
  assert(listMcpTools().some(tool => tool.name === 'browser_navigate' && tool.builtIn === true)
    && getMcpToolSchema('browser_navigate')?.function?.parameters?.required?.includes('url'),
  'trusted official schemas remain discoverable before the first MCP connection')
  assert(['browser_navigate_forward', 'browser_reload'].every(name => (
    BUILTIN_PLAYWRIGHT_ALLOWED_TOOLS.includes(name)
    && listMcpTools().some(tool => tool.name === name && tool.builtIn === true)
    && getMcpToolSchema(name)
  )), 'forward and reload expose trusted official schemas before connection')

  const coldStartNavigation = parseJson(await executeMcpTool(
    'browser_navigate',
    { url: 'https://example.com/cold-start' },
    {
      mcpDeps: deps,
      webUrlPolicyOptions: {
        hostnameResolver: async () => [{ address: '93.184.216.34' }],
      },
    },
  ))
  assert(coldStartNavigation?.ok === true
    && coldStartNavigation?.remote_tool === 'browser_navigate',
  'a discovered built-in browser tool lazily connects instead of returning unknown tool',
  JSON.stringify(coldStartNavigation))

  const normalizedTargetArgs = mcpInternal.normalizeBuiltInPlaywrightArgs('browser_fill_form', {
    fields: [
      { name: 'query', type: 'textbox', target: 'ref=e36', value: 'OpenAI' },
      { name: 'scope', type: 'combobox', target: '[ref=e41]', value: 'All' },
    ],
  })
  assert(normalizedTargetArgs?.fields?.[0]?.target === 'e36'
    && normalizedTargetArgs?.fields?.[1]?.target === 'e41',
  'wrapped snapshot refs are normalized recursively for form fields',
  JSON.stringify(normalizedTargetArgs))
  const selectorArgs = mcpInternal.normalizeBuiltInPlaywrightArgs('browser_type', {
    target: 'input#kw:visible',
    text: 'OpenAI',
  })
  assert(selectorArgs?.target === 'input#kw:visible',
    'real CSS selectors are not changed by snapshot-ref normalization',
    JSON.stringify(selectorArgs))

  const beforeWrappedRefClick = FakeClient.calls.length
  await executeMcpTool(
    'browser_click',
    { element: 'Search', target: 'ref=e63' },
    { mcpDeps: deps },
  )
  const wrappedRefClickCall = FakeClient.calls.slice(beforeWrappedRefClick)
    .find(call => call.request?.name === 'browser_click')
  assert(wrappedRefClickCall?.request?.arguments?.target === 'e63',
    'the MCP execution boundary sends a raw snapshot ref instead of ref=e63',
    JSON.stringify(wrappedRefClickCall))
  await shutdownMcpClients()

  const automaticSnapshotPath = path.join(interactive.cwd, 'page-auto-test.yml')
  fs.writeFileSync(automaticSnapshotPath, '- textbox "Search" [ref=e1]\n- button "Submit" [ref=e2]\n')
  const hydrated = parseJson(mcpInternal.formatMcpToolResult({
    alias: 'browser_navigate',
    remoteName: 'browser_navigate',
    serverId: interactive.id,
    serverName: interactive.name,
  }, {
    content: [{
      type: 'text',
      text: '### Snapshot\n- [Snapshot](page-auto-test.yml)',
    }],
  }, { serverConfig: interactive }))
  const hydratedText = hydrated?.content?.[0]?.text || ''
  assert(hydratedText.includes('textbox "Search" [ref=e1]')
    && !hydratedText.includes('[Snapshot](page-auto-test.yml)'),
  'built-in result adapter automatically inlines the official snapshot artifact',
  hydratedText)
  assert(mcpInternal.readPlaywrightSnapshotFile(interactive.cwd, automaticSnapshotPath)
    ?.includes('textbox "Search"'),
  'snapshot hydration accepts a legitimate absolute artifact path')
  assert(mcpInternal.readPlaywrightSnapshotFile(interactive.cwd, automaticSnapshotPath.slice(1))
    ?.includes('textbox "Search"'),
  'snapshot hydration repairs the macOS absolute-path form missing its leading slash')

  const outsideSnapshot = path.join(tmp, 'page-outside.yml')
  fs.writeFileSync(outsideSnapshot, 'SECRET_OUTSIDE_SNAPSHOT_ROOT')
  const outsideResult = parseJson(mcpInternal.formatMcpToolResult({
    alias: 'browser_navigate',
    remoteName: 'browser_navigate',
    serverId: interactive.id,
    serverName: interactive.name,
  }, {
    content: [{
      type: 'text',
      text: `### Snapshot\n- [Snapshot](${outsideSnapshot})`,
    }],
  }, { serverConfig: interactive }))
  assert(!JSON.stringify(outsideResult).includes('SECRET_OUTSIDE_SNAPSHOT_ROOT'),
    'automatic snapshot hydration cannot read outside the dedicated MCP output directory')
  assert(mcpInternal.readPlaywrightSnapshotFile(interactive.cwd, '../page-outside.yml') === null,
    'snapshot hydration rejects directory traversal')
  const escapingSymlink = path.join(interactive.cwd, 'page-symlink-escape.yml')
  fs.symlinkSync(outsideSnapshot, escapingSymlink)
  assert(mcpInternal.readPlaywrightSnapshotFile(interactive.cwd, 'page-symlink-escape.yml') === null,
    'snapshot hydration rejects a symlink escaping the output directory')

  const reader = createBuiltInPlaywrightServer({
    role: 'reader',
    ...deps.builtInOptions,
  })
  assert(reader.id === BUILTIN_PLAYWRIGHT_READER_ID, 'reader server has a reserved stable id')
  const interactiveProfileDir = interactive.args[interactive.args.indexOf('--user-data-dir') + 1]
  const readerProfileDir = reader.args[reader.args.indexOf('--user-data-dir') + 1]
  assert(reader.args.includes('--headless') && !reader.args.includes('--isolated'),
    'reader server is headless without an ephemeral isolated context')
  assert(reader.args.includes('--user-data-dir')
    && readerProfileDir.endsWith(path.join('browser-profiles', 'playwright-mcp-interactive'))
    && readerProfileDir === interactiveProfileDir
    && reader.persistent === true
    && reader.catalogVisible === false,
  'card and window modes share one persistent browser profile while the reader stays hidden')

  const privateNetworkServer = createBuiltInPlaywrightServer({
    role: 'interactive',
    ...deps.builtInOptions,
    allowPrivateNetwork: true,
  })
  assert(!privateNetworkServer.args.includes('--blocked-origins'),
    'explicit Alice private-network permission removes the origin guardrail')
  assert(privateNetworkServer.env.ALICE_BROWSER_PRIVATE_NETWORK === '1',
    'explicit private-network permission also disables the request-level guard')

  const userServer = {
    id: 'user_server',
    name: 'User MCP',
    enabled: true,
    transport: 'stdio',
    command: '/fake/node',
    args: ['/fake/user-server.js'],
    cwd: '',
    env: {},
    allowedTools: [],
    allowAutonomousReadOnly: false,
    timeoutMs: 10_000,
  }
  const clientsBeforeCatalogReconcile = FakeClient.instances.length
  await reconcileMcpClients([userServer], deps)
  const eagerlyConnectedClients = FakeClient.instances.slice(clientsBeforeCatalogReconcile)
  assert(
    eagerlyConnectedClients.length === 1
      && eagerlyConnectedClients[0].transport?.params?.args?.[0] === '/fake/user-server.js',
    'loading the MCP catalog connects user servers without eagerly starting built-in Playwright',
  )

  const tools = listMcpTools()
  assert(tools.some(tool => tool.name === 'browser_navigate' && tool.builtIn === true),
    'built-in Playwright tools use their native remote names', JSON.stringify(tools))
  assert(tools.some(tool => tool.name === 'mcp__user_server__browser_navigate' && tool.builtIn === false),
    'user MCP tools remain namespaced', JSON.stringify(tools))
  assert(!tools.some(tool => [
    'browser_run_code_unsafe',
    'browser_evaluate',
    'browser_file_upload',
    'browser_drop',
    'browser_network_requests',
    'browser_network_request',
  ].includes(tool.name)), 'unsafe official Playwright tools are absent from the native catalog', JSON.stringify(tools))
  assert(BUILTIN_PLAYWRIGHT_ALLOWED_TOOLS.every(name => ![
    'browser_run_code_unsafe',
    'browser_evaluate',
    'browser_file_upload',
    'browser_drop',
    'browser_network_requests',
    'browser_network_request',
  ].includes(name)), 'fixed allowlist excludes code, upload, drop, and network-detail tools')
  assert(getMcpToolSchema('browser_navigate')?.function?.parameters?.required?.includes('url'),
    'native Playwright schema is available to the unified tool catalog')

  const result = parseJson(await executeBuiltInPlaywrightTool(
    'browser_navigate',
    { url: 'https://example.com' },
    {
      mcpDeps: deps,
      webUrlPolicyOptions: {
        hostnameResolver: async () => [{ address: '93.184.216.34' }],
      },
    },
  ))
  assert(result?.ok === true && result?.remote_tool === 'browser_navigate',
    'internal interactive API calls an allowed remote tool', JSON.stringify(result))
  for (const name of ['browser_navigate_forward', 'browser_reload']) {
    const navigationResult = parseJson(await executeBuiltInPlaywrightTool(name, {}, { mcpDeps: deps }))
    assert(navigationResult?.ok === true && navigationResult?.remote_tool === name
      && FakeClient.calls.at(-1)?.request?.name === name,
    `${name} is actually dispatched to the official Playwright MCP client`,
    JSON.stringify(navigationResult))
  }

  const beforePrivateCall = FakeClient.calls.length
  const privateNavigation = parseJson(await executeMcpTool(
    'browser_navigate',
    { url: 'http://127.0.0.1:3721/private' },
    { mcpDeps: deps },
  ))
  assert(privateNavigation?.ok === false
    && privateNavigation?.code === 'PRIVATE_NETWORK_BLOCKED',
    'native browser navigation applies Alice private-network URL policy',
    JSON.stringify(privateNavigation))
  assert(FakeClient.calls.length === beforePrivateCall,
    'blocked private-network navigation never reaches MCP client')

  const beforeBlockedCall = FakeClient.calls.length
  const blocked = parseJson(await executeBuiltInPlaywrightTool(
    'browser_evaluate',
    { function: '() => process.env' },
    { mcpDeps: deps },
  ))
  assert(blocked?.ok === false && /not allowed/.test(blocked?.error || ''),
    'internal API rejects a forbidden remote tool', JSON.stringify(blocked))
  assert(FakeClient.calls.length === beforeBlockedCall, 'forbidden remote tool never reaches MCP client')

  const connectedInteractiveClient = [...FakeClient.instances].reverse().find(client => (
    client.transport?.params?.args?.includes('--user-data-dir')
    && !client.transport?.params?.args?.includes('--headless')
  ))
  connectedInteractiveClient.onclose?.()
  assert(listMcpTools().some(tool => tool.name === 'browser_navigate'),
    'unexpected built-in disconnect preserves the trusted native schema for recovery')
  const recovered = parseJson(await executeMcpTool(
    'browser_snapshot',
    {},
    { mcpDeps: deps },
  ))
  assert(recovered?.ok === true && FakeClient.instances.length >= 3,
    'next native call reconnects an unexpectedly closed built-in server',
    JSON.stringify(recovered))

  config.security.browserPrivateNetwork = true
  const privateResult = parseJson(await executeMcpTool(
    'browser_snapshot',
    {},
    { mcpDeps: deps },
  ))
  const latestInteractiveClient = [...FakeClient.instances].reverse().find(client => (
    client.transport?.params?.args?.includes('--user-data-dir')
    && !client.transport?.params?.args?.includes('--headless')
  ))
  assert(privateResult?.ok === true
    && !latestInteractiveClient?.transport?.params?.args?.includes('--blocked-origins'),
    'native call reconciles the built-in process when private-network permission changes',
    JSON.stringify(privateResult))
  config.security.browserPrivateNetwork = false

  const beforeReaderHandoff = FakeClient.calls.length
  const readerResult = parseJson(await executeBuiltInPlaywrightTool(
    'browser_snapshot',
    {},
    { mode: 'reader', mcpDeps: deps },
  ))
  assert(readerResult?.ok === true && readerResult?.server_id === BUILTIN_PLAYWRIGHT_READER_ID,
    'internal API lazily starts and calls the persistent card reader', JSON.stringify(readerResult))
  assert(!listMcpTools().some(tool => tool.serverId === BUILTIN_PLAYWRIGHT_READER_ID),
    'reader tools stay hidden after the reader connects')
  const readerHandoffCalls = FakeClient.calls.slice(beforeReaderHandoff)
  assert(readerHandoffCalls[0]?.request?.name === 'browser_close'
    && !readerHandoffCalls[0]?.args?.includes('--headless')
    && readerHandoffCalls[1]?.request?.name === 'browser_snapshot'
    && readerHandoffCalls[1]?.args?.includes('--headless'),
  'switching to card mode gracefully closes the headed context before opening the shared profile',
  JSON.stringify(readerHandoffCalls))

  const cardResult = parseJson(await executeMcpTool(
    'browser_navigate',
    { url: 'https://example.com/search?q=alice' },
    {
      browserDisplayMode: 'card',
      mcpDeps: deps,
      webUrlPolicyOptions: {
        hostnameResolver: async () => [{ address: '93.184.216.34' }],
      },
    },
  ))
  assert(cardResult?.ok === true
    && cardResult?.server_id === BUILTIN_PLAYWRIGHT_READER_ID
    && cardResult?.browser_preview?.state === 'ready'
    && cardResult?.browser_preview?.image_url?.startsWith('/browser-preview?file='),
  'card display routes the native browser action through the headless reader and returns a real preview',
  JSON.stringify(cardResult))
  assert(cardResult?.browser_preview?.url === 'https://example.com/search?q=alice'
    && cardResult?.browser_preview?.title === 'Alice Search',
  'card preview carries current page metadata for the compact browser chrome',
  JSON.stringify(cardResult?.browser_preview))
  const cardCalls = FakeClient.calls.slice(-2)
  assert(cardCalls[0]?.request?.name === 'browser_navigate'
    && cardCalls[1]?.request?.name === 'browser_take_screenshot'
    && cardCalls.every(call => call.args.includes('--headless')),
  'card display captures its preview inside the same headless reader session',
  JSON.stringify(cardCalls))

  const cardStatus = getMcpStatus()
  assert(cardStatus.builtInPlaywright?.interactive?.status === 'disconnected'
    && cardStatus.builtInPlaywright?.interactive?.headed === true,
    'card mode releases the headed process before taking shared-profile ownership',
    JSON.stringify(cardStatus))
  assert(cardStatus.builtInPlaywright?.reader?.status === 'connected'
    && cardStatus.builtInPlaywright?.reader?.lazy === true,
    'status identifies the lazily connected reader server', JSON.stringify(cardStatus))

  const beforeWindowHandoff = FakeClient.calls.length
  const windowResult = parseJson(await executeMcpTool(
    'browser_snapshot',
    {},
    { browserDisplayMode: 'window', mcpDeps: deps },
  ))
  const windowHandoffCalls = FakeClient.calls.slice(beforeWindowHandoff)
  const windowStatus = getMcpStatus()
  const latestReaderClient = [...FakeClient.instances].reverse().find(client => (
    client.transport?.params?.args?.includes('--headless')
  ))
  const resumedInteractiveClient = [...FakeClient.instances].reverse().find(client => (
    client.transport?.params?.args?.includes('--user-data-dir')
    && !client.transport?.params?.args?.includes('--headless')
  ))
  assert(windowResult?.ok === true
    && windowStatus.builtInPlaywright?.interactive?.status === 'connected'
    && windowStatus.builtInPlaywright?.reader?.status === 'disconnected',
  'switching back to the large window hands the shared profile to the headed process',
  JSON.stringify(windowStatus))
  assert(windowHandoffCalls[0]?.request?.name === 'browser_close'
    && windowHandoffCalls[0]?.args?.includes('--headless')
    && windowHandoffCalls[1]?.request?.name === 'browser_snapshot'
    && !windowHandoffCalls[1]?.args?.includes('--headless'),
  'switching to window mode gracefully closes the card context before opening the shared profile',
  JSON.stringify(windowHandoffCalls))
  assert(
    latestReaderClient?.transport?.params?.args?.[
      latestReaderClient.transport.params.args.indexOf('--user-data-dir') + 1
    ] === resumedInteractiveClient?.transport?.params?.args?.[
      resumedInteractiveClient.transport.params.args.indexOf('--user-data-dir') + 1
    ],
    'both runtime modes launch against the exact same persistent user-data-dir',
  )

  const embeddedTarget = {
    cdpEndpoint: 'http://127.0.0.1:49200',
    targetId: 'embedded-target',
    webContentsId: 42,
    url: 'https://example.com/',
    nativeNetworkGuard: true,
  }
  let embeddedPageLive = true
  let embeddedHostCloseCount = 0
  let pendingWindowOpenTakeover = null
  const embeddedBridge = {
    async getTarget() { return embeddedPageLive ? embeddedTarget : null },
    peekTarget() { return embeddedPageLive ? embeddedTarget : null },
    closePage() {
      embeddedPageLive = false
      embeddedHostCloseCount += 1
      return { partition: embeddedTarget.partition, webContentsId: null }
    },
    async consumeWindowOpenNavigation() {
      const result = pendingWindowOpenTakeover
      pendingWindowOpenTakeover = null
      return result
    },
  }
  let embeddedConnectCount = 0
  let embeddedCloseCount = 0
  let embeddedConfig
  const connectEmbeddedPlaywrightFn = async ({ target, mcpConfig }) => {
    embeddedConnectCount += 1
    embeddedConfig = mcpConfig
    const client = new FakeClient()
    client.transport = { params: { args: ['embedded-webcontentsview'] } }
    return {
      client,
      page: {
        url: () => 'https://example.com/live-embedded-page',
        title: async () => 'Live embedded page',
      },
      transport: null,
      target,
      async close() {
        embeddedCloseCount += 1
        await client.close()
      },
    }
  }
  const embeddedDeps = {
    ...deps,
    embeddedBrowserBridge: embeddedBridge,
    connectEmbeddedPlaywrightFn,
    resolveEmbeddedBrowserTargetFn: async () => embeddedTarget,
  }
  const embeddedDisplayState = { mode: 'card' }
  const beforeEmbeddedCalls = FakeClient.calls.length
  const embeddedCard = parseJson(await executeMcpTool(
    'browser_navigate',
    { url: 'https://example.com/native' },
    {
      browserDisplayMode: 'card',
      browserDisplayState: embeddedDisplayState,
      mcpDeps: embeddedDeps,
      webUrlPolicyOptions: {
        hostnameResolver: async () => [{ address: '93.184.216.34' }],
      },
    },
  ))
  const embeddedCalls = FakeClient.calls.slice(beforeEmbeddedCalls)
  assert(embeddedCard?.ok === true
    && embeddedCard?.server_id === BUILTIN_PLAYWRIGHT_INTERACTIVE_ID
    && embeddedCard?.browser_preview?.mode === 'card'
    && embeddedCard?.browser_preview?.state === 'ready'
    && embeddedCard?.browser_preview?.native_view === true
    && embeddedCard?.browser_preview?.renderer === 'webcontentsview'
    && embeddedCard?.browser_preview?.web_contents_id === 42
    && !embeddedCard?.browser_preview?.image_url,
  'card mode uses the native WebContentsView connection and returns ready metadata without a screenshot',
  JSON.stringify(embeddedCard))
  assert(embeddedCalls.at(-1)?.request?.name === 'browser_navigate'
    && !embeddedCalls.some(call => call.request?.name === 'browser_take_screenshot'),
  'native browser preview does not take an extra screenshot',
  JSON.stringify(embeddedCalls))
  assert(embeddedConfig?.browser?.initPage?.length === 0
    && embeddedConfig?.network?.blockedOrigins?.length === 0,
  'embedded MCP avoids Playwright routing when the Electron session owns the native network guard',
  JSON.stringify(embeddedConfig))
  const fallbackEmbeddedConfig = createBuiltInEmbeddedPlaywrightConfig({
    resourcesDir: tmp,
    sandboxDir: tmp,
    allowPrivateNetwork: false,
    nativeNetworkGuard: false,
  })
  assert(fallbackEmbeddedConfig.browser.initPage?.[0]?.endsWith('src/mcp/playwright-page-guard.cjs')
    && fallbackEmbeddedConfig.network.blockedOrigins?.includes('http://127.0.0.1:*'),
  'embedded MCP keeps the Playwright network guard when no native guard is confirmed',
  JSON.stringify(fallbackEmbeddedConfig))

  const embeddedWindow = parseJson(await executeMcpTool(
    'browser_snapshot',
    {},
    {
      browserDisplayMode: 'card',
      browserDisplayState: Object.assign(embeddedDisplayState, { mode: 'window' }),
      mcpDeps: embeddedDeps,
    },
  ))
  assert(embeddedWindow?.ok === true
    && embeddedWindow?.browser_preview?.mode === 'window'
    && embeddedWindow?.browser_preview?.url === 'https://example.com/live-embedded-page'
    && embeddedWindow?.browser_preview?.title === 'Live embedded page'
    && embeddedConnectCount === 1,
  'a live per-turn mode switch reuses one embedded connection and changes subsequent preview presentation',
  JSON.stringify({ embeddedWindow, embeddedConnectCount }))

  pendingWindowOpenTakeover = {
    ok: true,
    requestedUrl: 'https://example.net/target-blank',
    finalUrl: 'https://example.net/final-target',
  }
  const beforePopupClick = FakeClient.calls.length
  const popupClick = parseJson(await executeMcpTool(
    'browser_click',
    { element: 'opens in new tab', ref: 'e42' },
    { browserDisplayMode: 'window', mcpDeps: embeddedDeps },
  ))
  const popupCalls = FakeClient.calls.slice(beforePopupClick)
  assert(popupClick?.ok === true
    && popupClick?.browser_preview?.url === 'https://example.net/final-target'
    && popupClick?.content?.some(item => String(item?.text || '').includes('https://example.net/final-target'))
    && popupCalls[0]?.request?.name === 'browser_click'
    && popupCalls[1]?.request?.name === 'browser_snapshot',
  'target=_blank click reports the final in-place URL and a fresh official snapshot',
  JSON.stringify({ popupClick, popupCalls }))

  pendingWindowOpenTakeover = {
    ok: true,
    kind: 'google_oauth_popup',
    requestedUrl: 'https://accounts.google.com/gsi/select?client_id=test',
    finalUrl: 'https://accounts.google.com/gsi/select?client_id=test',
  }
  const beforeGooglePopupClick = FakeClient.calls.length
  const googlePopupClick = parseJson(await executeMcpTool(
    'browser_click',
    { element: 'Continue with Google', ref: 'e44' },
    { browserDisplayMode: 'window', mcpDeps: embeddedDeps },
  ))
  const googlePopupCalls = FakeClient.calls.slice(beforeGooglePopupClick)
  assert(googlePopupClick?.ok === true
    && googlePopupClick?.content?.some(item => /user-operated window/.test(item?.text || ''))
    && googlePopupClick?.structured_content?.window_open_takeover?.kind === 'google_oauth_popup'
    && googlePopupCalls.length === 1
    && googlePopupCalls[0]?.request?.name === 'browser_click',
  'Google OAuth popup is handed to the user without pretending the managed X page navigated',
  JSON.stringify({ googlePopupClick, googlePopupCalls }))

  pendingWindowOpenTakeover = { ok: false, error: 'Private or local network URL is disabled' }
  const blockedPopupClick = parseJson(await executeMcpTool(
    'browser_click',
    { element: 'unsafe link', ref: 'e43' },
    { browserDisplayMode: 'window', mcpDeps: embeddedDeps },
  ))
  assert(blockedPopupClick?.ok === false
    && blockedPopupClick?.content?.some(item => /blocked by Alice URL policy/.test(item?.text || '')),
  'a dangerous target=_blank click is reported as blocked rather than successful',
  JSON.stringify(blockedPopupClick))

  const beforeForbiddenTabCall = FakeClient.calls.length
  const forbiddenTabClose = parseJson(await executeMcpTool(
    'browser_tabs',
    { action: 'close', index: 0 },
    { browserDisplayMode: 'card', mcpDeps: embeddedDeps },
  ))
  assert(forbiddenTabClose?.ok === false
    && /creating or closing tabs is disabled/.test(forbiddenTabClose?.error || '')
    && FakeClient.calls.length === beforeForbiddenTabCall,
  'embedded MCP cannot close the sole Electron-owned page',
  JSON.stringify(forbiddenTabClose))

  const embeddedClose = parseJson(await executeMcpTool(
    'browser_close',
    {},
    { browserDisplayMode: 'card', mcpDeps: embeddedDeps },
  ))
  assert(embeddedClose?.ok === true
    && embeddedClose?.page_destroyed === true
    && embeddedClose?.profile_data_preserved === true
    && embeddedClose?.browser_preview?.state === 'closed'
    && embeddedHostCloseCount === 1
    && embeddedCloseCount === 1,
  'browser_close detaches MCP and truly destroys the live embedded page without clearing its profile',
  JSON.stringify({ embeddedClose, embeddedHostCloseCount, embeddedCloseCount }))

  const embeddedCloseAgain = parseJson(await executeMcpTool(
    'browser_close',
    {},
    { browserDisplayMode: 'card', mcpDeps: embeddedDeps },
  ))
  assert(embeddedCloseAgain?.ok === true
    && embeddedCloseAgain?.already_closed === true
    && embeddedConnectCount === 1
    && embeddedHostCloseCount === 1,
  'closing an already closed embedded browser does not create a replacement page',
  JSON.stringify({ embeddedCloseAgain, embeddedConnectCount, embeddedHostCloseCount }))

  const beforeEmbeddedShutdown = FakeClient.calls.length
  await shutdownBuiltInPlaywright({ role: 'interactive' })
  assert(embeddedCloseCount === 1
    && !FakeClient.calls.slice(beforeEmbeddedShutdown).some(call => call.request?.name === 'browser_close'),
  'shutdown after a real close does not recreate or re-close the embedded page')

  await shutdownBuiltInPlaywright({ role: 'reader' })
  assert(getMcpStatus().builtInPlaywright?.reader?.status === 'idle',
    'reader process can be shut down independently after an internal read')
} finally {
  await shutdownMcpClients()
  fs.rmSync(tmp, { recursive: true, force: true })
}

if (failed === 0) console.log('All built-in Playwright MCP tests passed.')
