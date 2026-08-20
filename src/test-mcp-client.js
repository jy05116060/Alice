// End-to-end MCP Client MVP test using a real stdio MCP server.
//
// Run: node src/test-mcp-client.js

import fs from 'fs'
import os from 'os'
import path from 'path'
import { fileURLToPath } from 'url'

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'alice-mcp-'))
process.env.ALICE_USER_DIR = tmp

let failed = 0
function assert(condition, label, detail = '') {
  if (condition) {
    console.log(`PASS: ${label}`)
  } else {
    failed += 1
    process.exitCode = 1
    console.error(`FAIL: ${label}${detail ? `\n  ${detail}` : ''}`)
  }
}

function parseJson(value) {
  try { return JSON.parse(String(value || '')) } catch { return null }
}

const serverPath = fileURLToPath(new URL('./test-mcp-server.js', import.meta.url))

// 收尾时用来释放 SQLite 句柄（见文件末尾 finally 的说明）。捕获失败不致命：
// 若 better-sqlite3 ABI 不匹配，db.js 本身就没加载成功，也就没有句柄要关。
let closeDBForTest = null
try { ({ closeDBForTest } = await import('./db.js')) } catch {}

const { paths } = await import('./paths.js')
const { getMcpServersConfig, setMcpServersConfig } = await import('./mcp/config.js')
const {
  getMcpStatus,
  getMcpToolSchema,
  listMcpTools,
  reconcileMcpClients,
  searchMcpTools,
  shutdownMcpClients,
} = await import('./mcp/client-manager.js')
const { evaluateToolPolicy } = await import('./capabilities/tool-policy.js')
const { executeTool } = await import('./capabilities/executor.js')

try {
  const baseConfig = {
    id: 'test_server',
    name: '测试 MCP',
    enabled: true,
    transport: 'stdio',
    command: process.execPath,
    args: [serverPath],
    env: { MCP_TEST_SECRET: 'mcp-secret-value' },
    allowedTools: [],
    allowAutonomousReadOnly: false,
    timeoutMs: 10_000,
  }
  setMcpServersConfig({ servers: [baseConfig] })

  const storedText = fs.readFileSync(paths.mcpServersFile, 'utf-8')
  assert(!storedText.includes('mcp-secret-value'), 'MCP env secret is not stored in plaintext server config')
  const publicConfig = getMcpServersConfig()
  assert(publicConfig.servers[0]?.env?.MCP_TEST_SECRET === '[configured]', 'MCP env secret is masked in public settings')

  await reconcileMcpClients()
  const status = getMcpStatus()
  const testServerStatus = status.servers.find(server => server.id === 'test_server')
  assert(testServerStatus?.status === 'connected', 'stdio MCP server connects', JSON.stringify(status))
  assert(testServerStatus?.loadedToolCount === 2 && status.toolCount >= 2,
    'tools/list loads both user MCP tools alongside built-ins', JSON.stringify(status))

  const tools = listMcpTools()
  const echo = tools.find(tool => tool.remoteName === 'echo')
  const mutate = tools.find(tool => tool.remoteName === 'mutate')
  assert(!!echo?.name?.startsWith('mcp__test_server__echo'), 'MCP tool gets a stable namespaced alias', JSON.stringify(tools))
  assert(!!getMcpToolSchema(echo?.name)?.function?.parameters?.properties?.text, 'MCP inputSchema adapts to Alice function schema')
  assert(searchMcpTools('测试 echo').some(tool => tool.name === echo?.name), 'MCP tools participate in catalog search')

  const found = parseJson(await executeTool('find_tool', { query: '测试 echo' }, { source: 'test' }))
  assert(found?.loaded?.includes(echo?.name), 'find_tool dynamically loads the MCP schema', JSON.stringify(found))

  const result = parseJson(await executeTool(echo.name, { text: 'hello' }, { source: 'test' }))
  assert(result?.ok === true, 'MCP tools/call succeeds through the unified executor', JSON.stringify(result))
  assert(result?.content?.[0]?.text === 'echo:hello;secret:yes', 'MCP text result and encrypted env reach the child server', JSON.stringify(result))
  assert(result?.structured_content?.echoed === 'hello', 'MCP structuredContent is preserved', JSON.stringify(result))

  const autonomousDefault = evaluateToolPolicy(echo.name, {}, { autonomous: true })
  assert(autonomousDefault.allowed === false, 'autonomous Tick denies MCP tools by default')
  const userDriven = evaluateToolPolicy(mutate.name, {}, { autonomous: false })
  assert(userDriven.allowed === true && userDriven.risk === 'high', 'destructive MCP annotation raises audit risk on user turns')

  setMcpServersConfig({
    servers: [{
      ...baseConfig,
      env: { MCP_TEST_SECRET: '[configured]' },
      allowAutonomousReadOnly: true,
    }],
  })
  await reconcileMcpClients()
  const reloadedTools = listMcpTools()
  const reloadedEcho = reloadedTools.find(tool => tool.remoteName === 'echo')
  const reloadedMutate = reloadedTools.find(tool => tool.remoteName === 'mutate')
  assert(evaluateToolPolicy(reloadedEcho.name, {}, { autonomous: true }).allowed === true,
    'explicit server opt-in allows annotated read-only tools during autonomous work')
  assert(evaluateToolPolicy(reloadedMutate.name, {}, { autonomous: true }).allowed === false,
    'destructive MCP tools remain denied during autonomous work')
} finally {
  await shutdownMcpClients()
  // Windows 上 better-sqlite3 若仍持有临时目录里的 jarvis.db，rmSync 会抛
  // EBUSY: resource busy or locked, unlink ...jarvis.db。那只是收尾清理失败，
  // 与任何断言无关；但它抛在 finally 里会覆盖掉前面全部 PASS，把进程退出码变成 1
  // （表现为「打印成功却退出 1」）。所以先关句柄再删，删不掉也只保留临时目录、
  // 打印其路径，不让清理噪声污染测试结论。
  try { closeDBForTest?.() } catch {}
  try {
    fs.rmSync(tmp, { recursive: true, force: true })
  } catch (err) {
    console.warn(`[test-mcp-client] temp dir kept (${err?.code || err?.message}): ${tmp}`)
  }
}

if (failed === 0) console.log('All MCP Client MVP tests passed.')
