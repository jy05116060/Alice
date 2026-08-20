// Agent hooks 桥接（阶段 6.5）：读 Claude Code 的 hooks 配置，把「阻塞 / 附加上下文」
// 事件接到爱丽丝的**工具流水线**上。
//
// 为什么值得做：用户可能已经在 Claude Code 里攒了一套规矩——「改 .env 之前拦一下」、
// 「每次写完文件跑一次 lint 并把结果告诉我」。那些规矩不该因为换了 Agent 就失效。
// 读同一份配置是最省事也最不容易跑偏的桥接方式（比起让用户再抄一遍）。
//
// 四条安全/健壮性规矩：
//   1. **默认关闭**。这会在每次工具调用时执行外部命令。默认开启等于把一个
//      「配置文件里写什么就执行什么」的机制静默打开——必须由用户明确开启。
//   2. **hook 失败绝不阻断流水线**。超时、命令不存在、输出不是 JSON、配置写坏了，
//      一律降级为「没有 hook」并继续。唯一的例外是**明确表示要阻塞**（退出码 2 或
//      `decision: "block"`）——那是它的本职。
//   3. **配置读取有缓存**。每次工具调用都读盘 + parse 是纯浪费；只有在配置变化
//      （mtime 变了）或超过 TTL 时才重新读。
//   4. **只支持能解释清楚的语义**。退出码 2 = 阻塞且把 stderr 作为理由；JSON 里的
//      `decision: "block"` 同理；`hookSpecificOutput.additionalContext` 作为附加
//      上下文回给模型。其余情况按「成功但没说什么」处理，不猜。
//
// 目前接入的事件：PreToolUse（可阻塞 / 附加上下文）、PostToolUse（附加上下文）。
// 读得到但**尚未接入**的：UserPromptSubmit / Stop / SessionStart 等——它们不在工具
// 流水线上，需要各自的挂点，留待后续（配置照常解析，只是不触发）。
import { exec } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

export const HOOK_EVENTS = Object.freeze({
  PRE_TOOL_USE: 'PreToolUse',
  POST_TOOL_USE: 'PostToolUse',
})

export const WIRED_EVENTS = Object.freeze([HOOK_EVENTS.PRE_TOOL_USE, HOOK_EVENTS.POST_TOOL_USE])
export const READ_ONLY_EVENTS = Object.freeze(['UserPromptSubmit', 'Stop', 'SubagentStop', 'Notification', 'PreCompact', 'SessionStart', 'SessionEnd'])

const CONFIG_TTL_MS = 15_000
// 导出以便测试与文档引用同一份事实（第一版忘了导出，测试里读到 undefined，
// 于是断言在比较「10000 === undefined」——这种错看着像测试写错，其实是模块没导出）
export const DEFAULT_TIMEOUT_MS = 10_000
const MAX_COMMAND_CHARS = 4000
const MAX_OUTPUT_CHARS = 8000

// ── 配置读取 ──────────────────────────────────────────────────────────────
const cache = new Map()

/** 候选配置文件：项目级 + 用户级（后者优先级更低，与 Claude Code 的合并方向一致）。 */
export function hookConfigPaths({ cwd = process.cwd(), homeDir = os.homedir() } = {}) {
  return [
    path.join(homeDir, '.claude', 'settings.json'),
    path.join(homeDir, '.claude', 'settings.local.json'),
    path.join(cwd, '.claude', 'settings.json'),
    path.join(cwd, '.claude', 'settings.local.json'),
  ]
}

function readJsonSafe(file) {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'))
  } catch {
    return null
  }
}

/**
 * 规范化一条 matcher 项。
 * Claude Code 的形状是 `{ matcher, hooks: [{ type, command, timeout }] }`，
 * 也接受直接给一个命令字符串的简写（用户手写配置时很常见）。
 */
export function normalizeMatcherEntry(entry) {
  if (!entry || typeof entry !== 'object') return null
  const matcher = typeof entry.matcher === 'string' && entry.matcher.trim() ? entry.matcher.trim() : '*'
  const rawHooks = Array.isArray(entry.hooks) ? entry.hooks : []
  const hooks = []
  for (const hook of rawHooks) {
    if (!hook) continue
    // 简写：{ "command": "..." } 或直接字符串
    const command = typeof hook === 'string'
      ? hook
      : (typeof hook?.command === 'string' ? hook.command : '')
    if (!command.trim()) continue
    // type 不是 command 的（比如 prompt 类）暂时跳过：我们只支持能解释清楚的命令类
    if (typeof hook === 'object' && hook.type && hook.type !== 'command') continue
    const timeout = Number(hook?.timeout)
    hooks.push({
      command: command.trim().slice(0, MAX_COMMAND_CHARS),
      // Claude Code 的 timeout 以**秒**为单位
      timeoutMs: Number.isFinite(timeout) && timeout > 0 ? Math.min(timeout * 1000, 120_000) : DEFAULT_TIMEOUT_MS,
    })
  }
  if (hooks.length === 0) return null
  return { matcher, hooks }
}

/** 从一份配置对象里取出 hooks 段并规范化。 */
export function normalizeHookConfig(raw) {
  const source = raw?.hooks
  if (!source || typeof source !== 'object') return {}
  const normalized = {}
  for (const [event, entries] of Object.entries(source)) {
    if (!Array.isArray(entries)) continue
    const list = entries.map(normalizeMatcherEntry).filter(Boolean)
    if (list.length > 0) normalized[event] = list
  }
  return normalized
}

/**
 * 读取并合并各配置文件里的 hooks。
 * 后读的（项目级）覆盖先读的（用户级）——同事件同名 matcher 以更具体的那份为准。
 * @returns {{hooks: object, sources: string[], errors: string[]}}
 */
export function loadHookConfig({ cwd = process.cwd(), homeDir = os.homedir(), _read = readJsonSafe, _stat = null } = {}) {
  const files = hookConfigPaths({ cwd, homeDir })
  const merged = {}
  const sources = []
  const errors = []

  for (const file of files) {
    if (_stat ? _stat(file) === null : !fs.existsSync(file)) continue
    const raw = _read(file)
    if (raw === null) { errors.push(file); continue }
    const normalized = normalizeHookConfig(raw)
    sources.push(file)
    for (const [event, entries] of Object.entries(normalized)) {
      const existing = merged[event] || []
      // 同 matcher 的以更具体的那份为准（项目级覆盖用户级）
      const replaced = new Set(entries.map(e => e.matcher))
      merged[event] = [...existing.filter(e => !replaced.has(e.matcher)), ...entries]
    }
  }
  return { hooks: merged, sources, errors }
}

/**
 * 带缓存的读取：配置没变就不重复读盘。
 * 注意把所有参数**原样转交**给 loadHookConfig——包括 `_read` / `_stat` 这两个注入点。
 * 第一版漏了转交，结果是「缓存测试里 reads 一直是 0」，断言看着通过其实什么都没测到：
 * 注入点没接到消费方，比没有注入点更糟，因为它让人以为测过了。
 */
export function loadHookConfigCached(options = {}) {
  const { cwd = process.cwd(), homeDir = os.homedir(), now = Date.now(), ...rest } = options
  const key = `${cwd}::${homeDir}`
  const hit = cache.get(key)
  if (hit && now - hit.at < CONFIG_TTL_MS) return hit.value
  const value = loadHookConfig({ cwd, homeDir, ...rest })
  cache.set(key, { at: now, value })
  return value
}

export function _clearHookConfigCache() {
  cache.clear()
}

// ── matcher 匹配 ──────────────────────────────────────────────────────────
/**
 * matcher 与工具名的匹配。Claude Code 的 matcher 是**正则**，`*` 表示全部。
 * 匹配失败（正则写错）当作不匹配并如实报告——一个写坏的正则不该让所有工具调用都变慢。
 * @returns {{match: boolean, error?: string}}
 */
export function matcherMatches(matcher, toolName) {
  const m = String(matcher ?? '').trim()
  const name = String(toolName ?? '')
  if (!m || m === '*') return { match: true }
  if (m === name) return { match: true }
  // `A|B` 这类正则写法交给 RegExp；纯工具名在上面已经命中
  try {
    return { match: new RegExp(m).test(name) }
  } catch (error) {
    return { match: false, error: `invalid matcher "${m}": ${error.message}` }
  }
}

/** 挑出某个事件下、与这个工具名匹配的全部 hook。 */
export function selectHooks(hookConfig, event, toolName) {
  const entries = hookConfig?.[event]
  if (!Array.isArray(entries)) return { hooks: [], errors: [] }
  const hooks = []
  const errors = []
  for (const entry of entries) {
    const verdict = matcherMatches(entry.matcher, toolName)
    if (verdict.error) { errors.push(verdict.error); continue }
    if (!verdict.match) continue
    for (const hook of entry.hooks) hooks.push({ ...hook, matcher: entry.matcher })
  }
  return { hooks, errors }
}

// ── 执行 ──────────────────────────────────────────────────────────────────
function runCommand(command, payload, timeoutMs) {
  return new Promise((resolve) => {
    // 这里是全仓库唯一**故意经过 shell** 的地方，而且是必要的：hook 的 `command`
    // 字段本来就是一个 shell 片段（管道、&&、引号都是用户写的），不走 shell 就没法执行。
    // 风险由「默认关闭 + 执行的是用户自己写的配置」承担。
    //
    // 用 `exec` 而不是 `execFile('cmd', ['/d','/s','/c', cmd])`：后者会踩 cmd 的引号剥离
    // 规则——带引号的路径会被当成从 cwd 拼出来的相对路径（实测报错长这样：
    // `Cannot find module 'D:\repo\"C:\...\ctx.cjs"'`）。exec 内部就是 `cmd /d /s /c`，
    // 但替我们做对了 Windows 那一层引号转义。
    try {
      const child = exec(command, {
        timeout: timeoutMs,
        windowsHide: true,
        maxBuffer: 1024 * 1024,
        env: { ...process.env, CLAUDE_PROJECT_DIR: process.cwd() },
      }, (error, stdout, stderr) => {
        resolve({
          exitCode: error ? (typeof error.code === 'number' ? error.code : 1) : 0,
          timedOut: error?.killed === true,
          stdout: String(stdout || ''),
          stderr: String(stderr || ''),
        })
      })
      if (payload !== null) child.stdin?.end(payload)
    } catch (error) {
      resolve({ exitCode: 1, timedOut: false, stdout: '', stderr: error?.message || String(error) })
    }
  })
}

/** 解析 hook 的输出：JSON 输出优先，其次纯文本 stdout 当作附加上下文。 */
export function interpretHookOutput({ exitCode, stdout, stderr, timedOut = false }) {
  const out = String(stdout || '').trim()
  const err = String(stderr || '').trim()

  if (timedOut) return { blocked: false, reason: '', additionalContext: '', error: 'hook timed out' }

  let parsed = null
  if (out.startsWith('{') || out.startsWith('[')) {
    try { parsed = JSON.parse(out) } catch { parsed = null }
  }

  const jsonBlock = parsed && typeof parsed === 'object' && !Array.isArray(parsed)
    ? parsed.decision === 'block' || parsed.decision === 'deny'
    : false
  const jsonContext = parsed && typeof parsed === 'object'
    ? String(parsed?.hookSpecificOutput?.additionalContext ?? parsed?.additionalContext ?? '')
    : ''

  // 阻塞：退出码 2 是 Claude Code 的约定（stderr 作为理由），JSON decision 是另一种写法
  if (exitCode === 2 || jsonBlock) {
    return {
      blocked: true,
      reason: (err || String(parsed?.reason || '')).slice(0, 2000) || 'a hook blocked this tool call',
      additionalContext: jsonContext.slice(0, MAX_OUTPUT_CHARS),
      error: '',
    }
  }

  // 其它非零退出码：非阻塞错误。Claude Code 的语义就是这样——它可能只是脚本自身出错，
  // 不该因为别人的脚本坏了就拦住工具。如实记下来。
  const context = (jsonContext || (parsed ? '' : out)).slice(0, MAX_OUTPUT_CHARS)
  return {
    blocked: false,
    reason: '',
    additionalContext: context,
    error: exitCode === 0 ? '' : (err || `hook exited with code ${exitCode}`),
  }
}

/**
 * 跑一个事件下的所有匹配 hook。
 * @returns {Promise<{blocked: boolean, reason: string, contexts: string[], errors: string[], ran: number}>}
 */
export async function runHooks({
  event,
  toolName,
  payload,
  hookConfig,
  timeoutMs = null,
  _run = runCommand,
} = {}) {
  const { hooks, errors: selectErrors } = selectHooks(hookConfig, event, toolName)
  const result = { blocked: false, reason: '', contexts: [], errors: [...selectErrors], ran: 0 }
  if (hooks.length === 0) return result

  const stdin = JSON.stringify(payload ?? {}, null, 2)
  for (const hook of hooks) {
    const outcome = await _run(hook.command, stdin, timeoutMs ?? hook.timeoutMs)
    result.ran += 1
    const interpreted = interpretHookOutput(outcome)
    if (interpreted.additionalContext) result.contexts.push(interpreted.additionalContext)
    if (interpreted.error) result.errors.push(interpreted.error)
    if (interpreted.blocked) {
      // 第一个说「停」的 hook 就停：已经表达了拒绝，后面的没必要再跑
      result.blocked = true
      result.reason = interpreted.reason
      return result
    }
  }
  return result
}

/** 组装 PreToolUse / PostToolUse 的标准输入（形状对齐 Claude Code，脚本才好复用）。 */
export function buildHookPayload({
  event,
  toolName,
  toolArgs = {},
  toolResult = null,
  sessionId = '',
  cwd = process.cwd(),
} = {}) {
  const payload = {
    session_id: String(sessionId || ''),
    transcript_path: '',
    cwd,
    hook_event_name: event,
    tool_name: String(toolName || ''),
    tool_input: toolArgs || {},
  }
  if (event === HOOK_EVENTS.POST_TOOL_USE) {
    payload.tool_response = typeof toolResult === 'string' ? toolResult.slice(0, MAX_OUTPUT_CHARS) : toolResult
  }
  return payload
}

export function hookStatus({ cwd = process.cwd(), homeDir = os.homedir() } = {}) {
  const { hooks, sources, errors } = loadHookConfig({ cwd, homeDir })
  const summary = {}
  for (const [event, entries] of Object.entries(hooks)) {
    summary[event] = entries.reduce((n, e) => n + e.hooks.length, 0)
  }
  return { sources, errors, events: summary, wired: [...WIRED_EVENTS], readOnly: [...READ_ONLY_EVENTS] }
}
