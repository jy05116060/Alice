#!/usr/bin/env node
// 爱丽丝的 stdio 入口。一个进程，两种协议，共用同一个 stdin/stdout：
//
//   1. **ACP（Agent Client Protocol）最小规范** —— JSON-RPC 2.0 over stdio。
//      initialize → session/new → session/prompt（可多轮）→ session/update 流式通知，
//      另有 session/load / session/cancel / authenticate 与标准错误码。这是默认协议。
//   2. **旧的 v1 自定义协议** —— `{id, method:'run'|'ping'|'capabilities'}`，一次一进程。
//      老脚本还在用，**必须继续可用**。分流方式见 detectProtocolVersion()。
//
//   echo '{"jsonrpc":"2.0","id":1,"method":"initialize","params":{}}' | node src/stdio.js
//
// 为什么两种协议能共存而不打架：旧协议的顶层信封里**没有** `jsonrpc` 字段，
// 新协议按 JSON-RPC 2.0 一定带 `jsonrpc:"2.0"`。所以「有没有 jsonrpc 字段」
// 就是一个无歧义的分流判据，不需要用户加开关，也不需要猜。
//
// ── 三个必须记住的坑（都踩过，别回退）────────────────────────────────────
//
//  1. **响应必须当场写，不能等后面的 await。** 每次跑一轮都要 import index.js，
//     而 index.js 跑完 headless 会立刻 `process.exit()`——`await import()` 之后的
//     代码永远不会执行。第一版就是把协议响应写在那之后，表现为「请求没有响应、
//     进程直接退出」。所以：拿到结果的那一刻就写 stdout（见 runInternalTurn 与 legacy 分支）。
//
//  2. **子进程里同样要当场写。** 子进程用 `process.stdout.write` 劫持来捕获 index.js
//     打出的那段 JSON，捕获的瞬间就把它转成协议消息转发给父进程。理由同上。
//
//  3. **stdout 只能是协议流。** index.js 的启动日志走 stdout，会污染 JSON-RPC。
//     子进程模式把日志转到 stderr；父进程只在 stderr 上打诊断。
import { spawn } from 'node:child_process'
import { existsSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import {
  ACP_ERRORS,
  ACP_PROTOCOL_VERSION,
  ACP_ERRORS as _ACP_ERRORS,
  AcpServer,
  buildErrorResponse,
  buildResponse,
  capabilityManifest,
  parseJsonRpcLine,
} from './runtime/acp-protocol.js'
import {
  ERROR_CODES,
  buildError,
  buildResult,
  capabilityManifest as legacyCapabilityManifest,
  encodeMessage,
  packageRunResult,
  parseRequestLine,
  validateRunParams,
} from './runtime/stdio-protocol.js'
import { defaultSessionDir, prepareHeadlessSession } from './runtime/headless-session.js'
import { getAppVersion } from './version.js'

const __filename = fileURLToPath(import.meta.url)
const REPO_ROOT = path.resolve(path.dirname(__filename), '..')
const MAX_STDIN_BYTES = 8 * 1024 * 1024
const DEFAULT_TURN_TIMEOUT_MS = 5 * 60 * 1000

/** 诊断一律走 stderr：stdout 是协议流，混进一个字都会让客户端解析失败。 */
function log(message) {
  process.stderr.write(`[stdio] ${message}\n`)
}

function writeMessage(message) {
  process.stdout.write(`${encodeMessage(message)}\n`)
}

/** 子进程模式下用来跟父进程说话的私有信封。刻意不复用 ACP 形状：它是内部管道，不是协议。 */
function writeInternal(message) {
  process.stdout.write(`${JSON.stringify(message)}\n`)
}

// ── argv ────────────────────────────────────────────────────────────────────

/**
 * 解析入口参数。刻意**不**接受 --keep-session 之外的东西：
 * 这是协议服务端，不是 CLI，多一个开关就多一份要维护的语义。
 */
export function parseStdioArgs(argv = []) {
  const options = {
    token: null,
    sessionRoot: null,
    protocol: 'auto',
    turnTimeoutMs: DEFAULT_TURN_TIMEOUT_MS,
    echoBackend: false,
    echoDelayMs: 5,
    internalTurn: false,
  }
  for (let i = 0; i < argv.length; i++) {
    const arg = String(argv[i] ?? '')
    if (arg === '--token') { options.token = String(argv[++i] ?? ''); continue }
    if (arg.startsWith('--token=')) { options.token = arg.slice('--token='.length); continue }
    if (arg === '--session-root') { options.sessionRoot = String(argv[++i] ?? ''); continue }
    if (arg.startsWith('--session-root=')) { options.sessionRoot = arg.slice('--session-root='.length); continue }
    if (arg === '--protocol') { options.protocol = String(argv[++i] ?? 'auto'); continue }
    if (arg.startsWith('--protocol=')) { options.protocol = arg.slice('--protocol='.length); continue }
    if (arg === '--turn-timeout-ms') { options.turnTimeoutMs = Number(argv[++i]); continue }
    if (arg === '--legacy') { options.protocol = 'legacy'; continue }
    if (arg === '--acp') { options.protocol = 'acp'; continue }
    // 自测后端：不起真实运行时，用一个确定性的本地回复。给离线端到端测试用，
    // 与仓库里的 capability-demo.js 同一性质——是**自测**，不是「假装成模型」。
    if (arg === '--echo-backend') { options.echoBackend = true; continue }
    // 自测后端的每块间隔。默认 5ms（够快）；调大是为了一件事——让
    // 「session/cancel 真的打断了一个**正在进行**的轮次」可以被确定性地测到。
    // 不调大就只能靠抢时序，那种测试今天过明天红。
    if (arg === '--echo-delay-ms') { options.echoDelayMs = Number(argv[++i]); continue }
    if (arg.startsWith('--echo-delay-ms=')) { options.echoDelayMs = Number(arg.slice('--echo-delay-ms='.length)); continue }
    // 内部：作为一次「跑一轮」的子进程被父进程拉起。不要在文档里教用户用。
    if (arg === '--internal-turn') { options.internalTurn = true; continue }
  }
  return options
}

// ── stdin ───────────────────────────────────────────────────────────────────

/**
 * 逐行读 stdin（NDJSON）。**不是**读完再处理：
 * ACP 是多轮的，一次请求一次响应；读完整段再回等于把多轮退化成一次性。
 * 所以这里做增量切分——收到一个 `\n` 就交给上层处理一条。
 */
function readLines(onLine, onEnd) {
  let buffer = ''
  let total = 0
  let overflowed = false
  process.stdin.setEncoding('utf8')
  process.stdin.on('data', (chunk) => {
    if (overflowed) return
    total += Buffer.byteLength(chunk, 'utf8')
    if (total > MAX_STDIN_BYTES) {
      overflowed = true
      writeMessage(buildErrorResponse(null, ACP_ERRORS.INVALID_REQUEST, 'stdin exceeded the size limit'))
      onEnd({ tooLarge: true })
      return
    }
    buffer += chunk
    let index
    while ((index = buffer.indexOf('\n')) >= 0) {
      const line = buffer.slice(0, index)
      buffer = buffer.slice(index + 1)
      onLine(line)
    }
  })
  process.stdin.on('end', () => {
    if (overflowed) return
    if (buffer.trim()) onLine(buffer)
    onEnd({})
  })
  process.stdin.on('error', () => onEnd({}))
}

// ── 分流 ────────────────────────────────────────────────────────────────────

/**
 * 判断一行属于哪套协议。
 *
 * 判据是**结构化**的，不是猜：
 *   - `--protocol legacy|acp` 显式指定时以它为准；
 *   - 否则看顶层有没有 `jsonrpc` 字段：ACP 按 JSON-RPC 2.0 必有，旧协议必无。
 *
 * 特意**不**按「方法名认识不认识」来分流：那会让 `session/prompt` 出现在旧协议信封里
 * 时被当成 METHOD_NOT_FOUND，而调用方其实只是写漏了 `jsonrpc`——报「信封不对」
 * 比报「方法不存在」有用得多。
 */
export function detectProtocolVersion(rawLine, explicit = 'auto') {
  if (explicit === 'legacy' || explicit === 'acp') return explicit
  const raw = String(rawLine ?? '').trim()
  if (!raw) return 'acp'
  try {
    const parsed = JSON.parse(raw)
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed) && Object.prototype.hasOwnProperty.call(parsed, 'jsonrpc')) {
      return 'acp'
    }
  } catch {
    // 坏 JSON：交给 ACP 解析器去报 -32700（标准码），别在分流阶段就吞掉
    return 'acp'
  }
  return 'legacy'
}

// ── 内部：跑一轮（子进程）─────────────────────────────────────────────────

/**
 * 在子进程里跑一轮真实运行时，并把**流式分块**与最终结果回传给父进程。
 *
 * 为什么是子进程：headless 分支跑完就 `process.exit()`，而 ACP 服务端必须活着等下一轮。
 * 与其把 index.js 的退出路径改成可重入（那是这个仓库最重的文件，风险极高），
 * 不如让「一轮」保持它本来的形态——一个进程——由父进程负责会话生命周期。
 *
 * 回传格式（内部 NDJSON，父进程解析）：
 *   {"t":"chunk","text":"..."}     ← 模型 token 流，边到边发
 *   {"t":"thought","text":"..."}   ← 推理过程流
 *   {"t":"result","ok":true,...}   ← 一轮结束
 */
function spawnTurnProcess({ task, sessionDir, timeoutMs, echoBackend, echoDelayMs, signal, onChunk, onThought }) {
  return new Promise((resolve) => {
    const args = [
      __filename,
      '--internal-turn',
      ...(echoBackend ? ['--echo-backend'] : []),
      ...(echoBackend && Number.isFinite(echoDelayMs) ? ['--echo-delay-ms', String(echoDelayMs)] : []),
      ...(sessionDir ? ['--session-root', sessionDir] : []),
      '--turn-timeout-ms', String(timeoutMs),
    ]
    const child = spawn(process.execPath, args, {
      cwd: REPO_ROOT,
      env: {
        ...process.env,
        ALICE_USER_DIR: sessionDir || process.env.ALICE_USER_DIR || REPO_ROOT,
        ALICE_ACP_TURN_TASK: task,
        ALICE_ACP_TURN_TIMEOUT_MS: String(timeoutMs),
      },
      stdio: ['ignore', 'pipe', 'pipe'],
    })

    let settled = false
    let buffer = ''
    let sawResult = false
    let stderrTail = ''

    const finish = (value) => {
      if (settled) return
      settled = true
      if (signal) signal.removeEventListener('abort', onAbort)
      clearTimeout(timer)
      resolve(value)
    }

    const onAbort = () => {
      try { child.kill('SIGKILL') } catch { /* 已经退了 */ }
      finish({ ok: false, aborted: true, answer: '', error: 'cancelled by session/cancel', durationMs: 0 })
    }
    if (signal) {
      if (signal.aborted) { onAbort(); return }
      signal.addEventListener('abort', onAbort, { once: true })
    }

    const timer = setTimeout(() => {
      try { child.kill('SIGKILL') } catch { /* 已经退了 */ }
      finish({ ok: false, answer: '', error: `the turn timed out after ${timeoutMs} ms`, durationMs: timeoutMs })
    }, timeoutMs + 15_000)
    timer.unref?.()

    child.stdout.setEncoding('utf8')
    child.stdout.on('data', (chunk) => {
      buffer += chunk
      let index
      while ((index = buffer.indexOf('\n')) >= 0) {
        const line = buffer.slice(0, index).trim()
        buffer = buffer.slice(index + 1)
        if (!line) continue
        let message = null
        try { message = JSON.parse(line) } catch { continue }
        if (message.t === 'chunk') { if (!sawResult) onChunk?.(message.text) }
        else if (message.t === 'thought') { if (!sawResult) onThought?.(message.text) }
        else if (message.t === 'result') {
          sawResult = true
          finish({ ...message, ok: message.ok !== false })
        }
      }
    })
    child.stderr.setEncoding('utf8')
    child.stderr.on('data', (chunk) => { stderrTail = `${stderrTail}${chunk}`.slice(-4000) })
    child.on('error', (error) => {
      finish({ ok: false, answer: '', error: `could not start the turn process: ${error.message}`, durationMs: 0 })
    })
    child.on('close', (code) => {
      if (sawResult) return
      finish({
        ok: false,
        answer: '',
        error: stderrTail.trim().split('\n').filter(Boolean).slice(-1)[0]
          || `the turn process exited with code ${code} without producing a result`,
        durationMs: 0,
      })
    })
  })
}

/**
 * 生产用的「跑一轮」后端。会话目录由调用方（AcpServer 的 turnRunner 包装）给出，
 * 这样同一个 ACP 会话的每一轮都落在**同一个 user dir** 上——DB 里的对话历史因此累积，
 * 下一轮的运行时能从中看到上一轮。这是上下文延续的第一条腿；第二条腿是
 * acp-protocol.js 里的 composeTurnTask（显式把 transcript 拼进任务）。
 */
export function createRuntimeTurnRunner({ turnTimeoutMs = DEFAULT_TURN_TIMEOUT_MS, echoBackend = false, echoDelayMs = 5 } = {}) {
  return async ({ task, sessionDir, signal, onChunk, onThought }) => {
    const result = await spawnTurnProcess({
      task, sessionDir, timeoutMs: turnTimeoutMs, echoBackend, echoDelayMs, signal, onChunk, onThought,
    })
    return {
      answer: result.answer || '',
      stopReason: result.aborted ? 'cancelled' : undefined,
      durationMs: result.duration_ms ?? result.durationMs,
      sessionDir: result.session_dir || result.sessionDir,
      ok: result.ok !== false,
      error: result.error,
    }
  }
}

/**
 * 会话目录 = 这个 ACP 会话的 user dir。首轮创建，后续复用。
 *
 * 为什么要「临时目录 + 拷贝凭据」而不是直接用真实库：与 headless 同一个取舍——
 * 脚本/客户端不该把内容写进用户正在聊的那条对话里。凭据（config.json / llm/）
 * 会拷过去，所以权限与模型行为跟本体一致。
 */
function makeSessionDirResolver({ sessionRoot }) {
  const assigned = new Map()
  return (session) => {
    const existing = assigned.get(session.sessionId)
    if (existing) return existing
    let dir
    if (sessionRoot) {
      dir = path.join(path.resolve(sessionRoot), session.sessionId)
    } else {
      dir = defaultSessionDir()
    }
    const prepared = prepareHeadlessSession({
      sourceUserDir: process.env.ALICE_USER_DIR || process.cwd(),
      sessionDir: dir,
    })
    assigned.set(session.sessionId, prepared.sessionDir)
    log(`session ${session.sessionId}: user dir ${prepared.sessionDir} (carried: ${prepared.carried.join(', ') || 'none'})`)
    if (prepared.missing.includes('config.json')) {
      log(`session ${session.sessionId}: WARNING no config.json carried over — the run will have no model credential`)
    }
    return prepared.sessionDir
  }
}

// ── 内部模式：一次真实运行 ────────────────────────────────────────────────

/**
 * `--internal-turn`：跑一轮，把分块与结果以内部信封写到 stdout。
 *
 * **坑 1 在这里同样适用**：index.js 跑完会 process.exit()，
 * 所以结果必须在 `process.stdout.write` 劫持回调里**当场**写出去。
 */
async function runInternalTurn(options) {
  const task = String(process.env.ALICE_ACP_TURN_TASK || '').trim()
  const timeoutMs = Number(process.env.ALICE_ACP_TURN_TIMEOUT_MS) || options.turnTimeoutMs || DEFAULT_TURN_TIMEOUT_MS
  const startedAt = Date.now()
  const sessionDir = options.sessionRoot ? path.resolve(options.sessionRoot) : (process.env.ALICE_USER_DIR || REPO_ROOT)

  if (options.echoBackend) {
    await runEchoTurn({ task, startedAt, sessionDir, delayMs: options.echoDelayMs })
    return 0
  }
  if (!task) {
    writeInternal({ t: 'result', ok: false, answer: '', error: 'no task was given to the turn process', duration_ms: 0 })
    return 2
  }

  process.env.ALICE_USER_DIR = sessionDir
  process.env.ALICE_HEADLESS = '1'
  process.env.ALICE_HEADLESS_TASK = task
  process.env.ALICE_HEADLESS_TIMEOUT_MS = String(timeoutMs)
  process.env.ALICE_HEADLESS_JSON = '1'
  process.env.ALICE_HEADLESS_SESSION_DIR = sessionDir

  // 真实流式：爱丽丝的运行时在模型调用期间会发 stream_chunk（mode='text' 即正文）。
  // 在 import index.js **之前**订阅——events.js 是单例模块，这里注册的观察者
  // 与 index.js 内部用的是同一份。于是模型的 token 流一到就被转成内部 chunk 发给父进程。
  const { addEventListener } = await import('./events.js')
  let streamMode = null
  const offEvents = addEventListener((type, data) => {
    if (type === 'stream_start') { streamMode = data?.mode || null; return }
    if (type === 'stream_chunk') {
      if (data?.mode !== 'text') return
      writeInternal({ t: 'chunk', text: String(data?.text ?? '') })
      return
    }
    if (type === 'stream_end') { streamMode = null }
    void streamMode
  })

  // 坑 1 + 坑 3：劫持 stdout。index.js 的启动日志本来是往 stdout 打的，
  // 但那会污染协议流，所以非结果行一律转投 stderr；结果行**当场**转成内部信封。
  const originalWrite = process.stdout.write.bind(process.stdout)
  let responded = false
  process.stdout.write = (chunk, ...rest) => {
    const text = typeof chunk === 'string' ? chunk : Buffer.from(chunk).toString('utf8')
    const trimmed = text.trim()
    const looksLikeResult = trimmed.startsWith('{')
      && (trimmed.includes('"answer"') || trimmed.includes('"session_dir"'))
    if (looksLikeResult && !responded) {
      responded = true
      let parsed = null
      try { parsed = JSON.parse(trimmed) } catch { /* 落到下面的兜底 */ }
      const payload = parsed
        ? {
            t: 'result',
            ok: parsed.ok === true,
            answer: String(parsed.answer ?? ''),
            session_dir: parsed.session_dir,
            duration_ms: parsed.duration_ms,
            ...(parsed.error ? { error: parsed.error } : {}),
          }
        : { t: 'result', ok: false, answer: '', error: 'the run finished without a parseable result', duration_ms: Date.now() - startedAt }
      // ← 就是这里。写在 await import 之后 = 永远发不出去。
      writeInternal(payload)
      offEvents()
      return true
    }
    if (responded) return true
    return originalWrite.call(process.stderr, chunk, ...rest)
  }

  try {
    await import('./index.js')
  } catch (error) {
    process.stdout.write = originalWrite
    offEvents()
    writeInternal({ t: 'result', ok: false, answer: '', error: error?.message || String(error), duration_ms: Date.now() - startedAt })
    return 1
  }

  // 走到这里说明 index.js 没有自己退出（异常路径）。补一个明确的错误，绝不静默返回。
  process.stdout.write = originalWrite
  offEvents()
  if (!responded) {
    writeInternal({ t: 'result', ok: false, answer: '', error: 'the runtime exited without producing a result', duration_ms: Date.now() - startedAt })
  }
  return responded ? 0 : 1
}

/**
 * 自测后端：不起真实运行时，用一个**确定性**的回复，并真的分块吐出来。
 *
 * 它不是模型。它的用途是让「ACP 分帧 + 多轮 + 流式 + 鉴权 + 错误码」这条链路
 * 可以在**没有模型凭据、不花钱、不联网**的前提下被端到端断言。
 * 回复里刻意带上从任务文本中提取的「上下文回执」，这样多轮是否真的延续了上下文
 * 可以从回复内容本身看出来，而不是只看两个响应都返回了。
 */
async function runEchoTurn({ task, startedAt, sessionDir, delayMs = 5 }) {
  const lines = String(task || '').split('\n')
  const sawMarker = /## Earlier turns in this session/.test(task || '')
  const earlierUser = []
  for (let i = 0; i < lines.length; i++) {
    const m = lines[i].match(/^user:\s*(.*)$/)
    if (m) earlierUser.push(m[1])
  }
  const currentIndex = lines.findIndex(l => /^## Current request$/.test(l))
  const current = currentIndex >= 0 ? lines.slice(currentIndex + 1).join('\n').trim() : String(task || '').trim()

  const body = [
    `echo-backend received: ${current}`,
    sawMarker
      ? `context carried over: ${earlierUser.length} earlier user turn(s) [${earlierUser.join(' | ')}]`
      : 'context carried over: none (first turn in this session)',
    `session dir: ${sessionDir}`,
  ].join('\n')

  writeInternal({ t: 'thought', text: 'echo-backend: no model was called' })
  const gap = Number.isFinite(delayMs) && delayMs >= 0 ? delayMs : 5
  for (const piece of splitForEcho(body)) {
    writeInternal({ t: 'chunk', text: piece })
    await new Promise(resolve => setTimeout(resolve, gap))
  }
  writeInternal({ t: 'result', ok: true, answer: body, session_dir: sessionDir, duration_ms: Date.now() - startedAt })
  return 0
}

/** 按行切块，保证块数 > 1（流式断言要的是「真的多块」）。 */
function splitForEcho(text) {
  const pieces = String(text).split('\n').filter(Boolean).map(line => `${line}\n`)
  if (pieces.length >= 2) return pieces
  const value = String(text)
  return [value.slice(0, Math.ceil(value.length / 2)), value.slice(Math.ceil(value.length / 2))].filter(Boolean)
}

// ── 旧协议（一次一进程） ──────────────────────────────────────────────────

/**
 * 旧的 v1 协议：`{id, method:'run'|'ping'|'capabilities'}`。
 *
 * 沿用原实现的做法——设好 headless 环境变量后 import index.js，把它的 JSON 结果
 * **接住**并包成协议响应。这里同样受坑 1 约束：响应在捕获的当下写。
 */
async function runLegacy(line, options) {
  const parsed = parseRequestLine(line)
  if (!parsed.ok) {
    writeMessage(buildError(parsed.id, parsed.code, parsed.message))
    return 2
  }
  const { id, method, params } = parsed.request

  if (method === 'ping') {
    writeMessage(buildResult(id, { pong: true, protocol_version: legacyCapabilityManifest().protocol_version }))
    return 0
  }
  if (method === 'capabilities') {
    writeMessage(buildResult(id, legacyCapabilityManifest({ version: getAppVersion() })))
    return 0
  }

  // method === 'run'
  const validated = validateRunParams(params)
  if (!validated.ok) {
    writeMessage(buildError(id, validated.code, validated.message))
    return 2
  }
  const { task, freshSession, timeoutMs } = validated.value

  let sessionDir = null
  if (freshSession) {
    sessionDir = defaultSessionDir()
    const prepared = prepareHeadlessSession({
      sourceUserDir: process.env.ALICE_USER_DIR || process.cwd(),
      sessionDir,
    })
    sessionDir = prepared.sessionDir
    if (prepared.missing.includes('config.json')) {
      writeMessage(buildError(id, ERROR_CODES.RUN_FAILED, 'no model credential found in the source user directory', {
        session_dir: sessionDir,
      }))
      return 1
    }
  }

  process.env.ALICE_USER_DIR = sessionDir || process.env.ALICE_USER_DIR || process.cwd()
  process.env.ALICE_HEADLESS = '1'
  process.env.ALICE_HEADLESS_TASK = task
  process.env.ALICE_HEADLESS_TIMEOUT_MS = String(timeoutMs)
  process.env.ALICE_HEADLESS_JSON = '1'
  if (sessionDir) process.env.ALICE_HEADLESS_SESSION_DIR = sessionDir

  // 同坑 1：响应必须在捕获的当下写出去。
  const originalWrite = process.stdout.write.bind(process.stdout)
  let responded = false
  process.stdout.write = (chunk, ...rest) => {
    const text = typeof chunk === 'string' ? chunk : Buffer.from(chunk).toString('utf8')
    const trimmed = text.trim()
    const looksLikeResult = trimmed.startsWith('{')
      && (trimmed.includes('"answer"') || trimmed.includes('"session_dir"'))
    if (looksLikeResult && !responded) {
      responded = true
      let captured = null
      try { captured = JSON.parse(trimmed) } catch { /* 落到下面的兜底错误 */ }
      const message = captured
        ? packageRunResult(id, captured)
        : buildError(id, ERROR_CODES.RUN_FAILED, 'the run finished without a parseable result')
      originalWrite(`${encodeMessage(message)}\n`)
      return true
    }
    if (responded) return true // 响应之后的日志丢掉，保持输出干净
    return originalWrite(chunk, ...rest)
  }

  try {
    await import('./index.js')
  } catch (error) {
    process.stdout.write = originalWrite
    writeMessage(buildError(id, ERROR_CODES.INTERNAL_ERROR, error?.message || String(error)))
    return 1
  }

  process.stdout.write = originalWrite
  if (!responded) {
    writeMessage(buildError(id, ERROR_CODES.RUN_FAILED, 'the runtime exited without producing a result'))
  }
  return responded ? 0 : 1
}

// ── ACP 服务端模式 ────────────────────────────────────────────────────────

function runAcpServer(options) {
  const version = getAppVersion()
  const token = options.token ?? process.env.ALICE_ACP_TOKEN ?? ''
  const resolveSessionDir = makeSessionDirResolver({ sessionRoot: options.sessionRoot })

  const emit = (message) => writeMessage(message)

  const runtimeRunner = createRuntimeTurnRunner({
    turnTimeoutMs: options.turnTimeoutMs,
    echoBackend: options.echoBackend,
    echoDelayMs: options.echoDelayMs,
  })

  const server = new AcpServer({
    version,
    token,
    log,
    emit,
    turnRunner: async (context) => {
      const sessionDir = resolveSessionDir(context.session)
      return runtimeRunner({ ...context, sessionDir })
    },
  })

  return new Promise((resolve) => {
    let pending = Promise.resolve()
    let exitCode = 0
    let legacyInFlight = false
    readLines(
      (line) => {
        const trimmed = String(line ?? '').trim()
        if (!trimmed) return
        // 旧协议分流。旧协议的语义是「一次一进程、跑完就退」，所以这里接手之后
        // 不再回到 ACP 循环——runLegacy 会自己 import index.js 并让进程退出。
        //
        // 为什么把旧协议也接在这条增量读取的循环上，而不是另开一个「读全量」入口：
        // 入口只能有一个，否则「这行属于哪套协议」就得在两条路上各判一次，
        // 判据一多必然分叉。判据只有一处（detectProtocolVersion），分流也只有一处。
        if (detectProtocolVersion(trimmed, options.protocol) === 'legacy') {
          if (legacyInFlight) {
            log('a second legacy request arrived; the legacy protocol handles one request per process — ignoring it')
            return
          }
          legacyInFlight = true
          pending = pending.then(() => runLegacy(trimmed, options))
            .then((code) => { exitCode = code })
            .catch((error) => {
              writeMessage(buildError(null, ERROR_CODES.INTERNAL_ERROR, error?.message || String(error)))
              exitCode = 1
            })
          return
        }
        const parsed = parseJsonRpcLine(trimmed)
        if (!parsed.ok) {
          writeMessage(buildErrorResponse(parsed.id, parsed.code, parsed.message))
          return
        }

        // **通知不走串行链。** 这是 cancel 能被真正打断的前提，别改回去。
        //
        // 原先所有行都塞进同一条 pending 链。那条理由对**请求**成立：stdio 传输没有
        // 并发请求语义，且 session/prompt 会持续往外推 session/update，并发处理会让
        // 通知与响应的顺序错乱。但它对**通知**不成立——session/cancel 的全部意义
        // 就是「在那一轮还在飞的时候插进去」。被 pending 排队意味着要等 prompt 结束
        // 才出队，那时 activeTurns 里已经没有条目，取消永远是个空操作：
        // 调用方收到一条格式完全合法的响应，实际上什么都没打断。
        if (parsed.request.isNotification) {
          server.handle(parsed.request).catch((error) => {
            log(`notification dispatch failed: ${error?.stack || error}`)
          })
          return
        }

        pending = pending.then(async () => {
          const response = await server.handle(parsed.request)
          if (response) writeMessage(response)
        }).catch((error) => {
          log(`dispatch failed: ${error?.stack || error}`)
          exitCode = 1
        })
      },
      () => {
        pending.then(() => resolve(exitCode))
      },
    )
  })
}

// ── 入口 ────────────────────────────────────────────────────────────────────

async function main() {
  const options = parseStdioArgs(process.argv.slice(2))

  if (options.internalTurn) {
    return runInternalTurn(options)
  }

  // 显式 --legacy：整条管道按旧协议解释，一次一进程。
  if (options.protocol === 'legacy') {
    const input = await readAllStdin()
    const line = String(input || '').split('\n').map(l => l.trim()).find(Boolean) || ''
    return runLegacy(line, options)
  }

  return runAcpServer(options)
}

/** 旧协议是「读完全部 stdin 再处理」——它的语义本来就是一次一进程。 */
function readAllStdin() {
  return new Promise((resolve) => {
    let size = 0
    const chunks = []
    process.stdin.setEncoding('utf8')
    process.stdin.on('data', (chunk) => {
      size += Buffer.byteLength(chunk, 'utf8')
      if (size > MAX_STDIN_BYTES) { resolve(''); return }
      chunks.push(chunk)
    })
    process.stdin.on('end', () => resolve(chunks.join('')))
    process.stdin.on('error', () => resolve(''))
  })
}

main().then((code) => {
  // index.js 自己会 process.exit，所以走到这里说明是协议层正常收尾的
  if (typeof code === 'number') process.exit(code)
}).catch((error) => {
  writeMessage(buildErrorResponse(null, ACP_ERRORS.INTERNAL_ERROR, error?.message || String(error)))
  process.exit(1)
})
