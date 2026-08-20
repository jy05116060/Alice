// ACP（Agent Client Protocol）最小规范的**纯逻辑层**。
//
// 为什么单独成模块：真正的进程接线（stdin/stdout、子进程、模型）全都不可离线测，
// 而协议本身——JSON-RPC 2.0 分帧、方法分发、会话表、错误码、鉴权、分块——是纯逻辑。
// 把它摊在这里，测试就能注入一个假的「跑一轮」后端，把多轮与流式断言成**确定的事实**，
// 而不是靠真模型碰运气。
//
// 规范依据：agentclientprotocol.com 的 v1 协议（JSON-RPC 2.0，方法 + 通知）。
// 本文件只实现**最小集**，刻意不做的都写在这里，免得以后有人以为漏了：
//   - 不做 fs/* 与 terminal/*（客户端反向提供的能力）：爱丽丝自带沙盒与 exec_command，
//     再挂一套客户端文件系统只会多一条互相打架的写入路径。
//   - 不做 session/request_permission 反向请求：headless 语义就是「没有人可问」，
//     需要人参与的工具如实报不可用（与 src/headless.js 一致），而不是把客户端挂住。
//   - 不做 session/list、session/delete：会话表在进程内存里，进程退出即消失——
//     这是刻意的，见下面 SessionStore 的注释。
//   - 不做 tool_call / plan 等其余 session/update 变体：只推 agent_message_chunk
//     与 agent_thought_chunk，因为其余变体对应的运行时事件在爱丽丝这边没有稳定上游。
import { randomUUID } from 'node:crypto'

/** JSON-RPC 2.0 版本串。协议里每个信封都要带它。 */
export const JSONRPC_VERSION = '2.0'

/** ACP 协议主版本。客户端 initialize 时带自己的版本，服务端回自己支持的那一版。 */
export const ACP_PROTOCOL_VERSION = 1

/**
 * 错误码。**标准段与实现段的区分是有意的**：
 *   - -32700/-32600/-32601/-32602/-32603 是 JSON-RPC 2.0 保留的标准码，必须原样用。
 *   - -32000 落在实现自定义区间（-32000..-32099），这里固定给「需要鉴权」。
 *     不用 -32600 代替：那不是「请求格式不对」，而是「格式对但你没资格」，客户端要能分开处理
 *     （前者是 bug，后者是去补 token）。
 */
export const ACP_ERRORS = Object.freeze({
  PARSE_ERROR: -32700,
  INVALID_REQUEST: -32600,
  METHOD_NOT_FOUND: -32601,
  INVALID_PARAMS: -32602,
  INTERNAL_ERROR: -32603,
  AUTH_REQUIRED: -32000,
  SESSION_NOT_FOUND: -32001,
  CANCELLED: -32002,
})

/** 一轮结束的原因。ACP 的 StopReason 枚举。 */
export const STOP_REASONS = Object.freeze({
  END_TURN: 'end_turn',
  MAX_TOKENS: 'max_tokens',
  MAX_TURN_REQUESTS: 'max_turn_requests',
  REFUSAL: 'refusal',
  CANCELLED: 'cancelled',
})

/**
 * 需要鉴权的方法。`initialize` 与 `ping` 刻意**不**在列：握手本身必须能匿名完成，
 * 否则客户端无法得知「需要哪种鉴权」——把 401 藏在握手后面只会让人猜。
 */
export const PROTECTED_METHODS = Object.freeze([
  'session/new',
  'session/load',
  'session/prompt',
  'run',
])

/** 本服务端认识的全部方法（含旧的兼容协议）。未知方法一律 -32601。 */
export const KNOWN_METHODS = Object.freeze([
  'initialize',
  'authenticate',
  'session/new',
  'session/load',
  'session/prompt',
  'ping',
  'capabilities',
  'run',
])

/** 只需要收下、不需要回应的通知（没有 id）。 */
export const NOTIFICATION_METHODS = Object.freeze(['session/cancel'])

// ── 信封构造 ────────────────────────────────────────────────────────────────

export function buildResponse(id, result) {
  return { jsonrpc: JSONRPC_VERSION, id: id ?? null, result }
}

export function buildErrorResponse(id, code, message, data = null) {
  return {
    jsonrpc: JSONRPC_VERSION,
    id: id ?? null,
    error: { code: Number(code), message: String(message), ...(data === null ? {} : { data }) },
  }
}

export function buildNotification(method, params) {
  return { jsonrpc: JSONRPC_VERSION, method, params }
}

/** `session/update` 通知。ACP 规定载荷在 params.update，变体名在 update.sessionUpdate。 */
export function buildSessionUpdate(sessionId, update) {
  return buildNotification('session/update', { sessionId, update })
}

/** 一块助手正文。ACP 的 content block 是 { type:'text', text }。 */
export function buildAgentMessageChunk(sessionId, text) {
  return buildSessionUpdate(sessionId, {
    sessionUpdate: 'agent_message_chunk',
    content: { type: 'text', text: String(text ?? '') },
  })
}

/** 一块推理过程。与正文分开推，客户端可选择不显示。 */
export function buildAgentThoughtChunk(sessionId, text) {
  return buildSessionUpdate(sessionId, {
    sessionUpdate: 'agent_thought_chunk',
    content: { type: 'text', text: String(text ?? '') },
  })
}

// ── 请求解析 ────────────────────────────────────────────────────────────────

/**
 * 解析一行请求。
 * @returns {{ok:true, request:{id, method, params, isNotification:boolean}}
 *          | {ok:false, id:any, code:number, message:string, isNotification:boolean}}
 */
export function parseJsonRpcLine(line) {
  const raw = String(line ?? '').trim()
  if (!raw) {
    return { ok: false, id: null, code: ACP_ERRORS.INVALID_REQUEST, message: 'empty request line', isNotification: false }
  }
  let parsed
  try {
    parsed = JSON.parse(raw)
  } catch (error) {
    return { ok: false, id: null, code: ACP_ERRORS.PARSE_ERROR, message: `invalid JSON: ${error.message}`, isNotification: false }
  }
  // 批量请求（数组）是 JSON-RPC 的可选特性，ACP 的 stdio 传输不用它。
  // 与其半吊子支持，不如明确拒绝——半支持会让调用方在「有时能批量」上踩坑。
  if (Array.isArray(parsed)) {
    return { ok: false, id: null, code: ACP_ERRORS.INVALID_REQUEST, message: 'batch requests are not supported', isNotification: false }
  }
  if (!parsed || typeof parsed !== 'object') {
    return { ok: false, id: null, code: ACP_ERRORS.INVALID_REQUEST, message: 'a request must be a JSON object', isNotification: false }
  }
  const hasId = Object.prototype.hasOwnProperty.call(parsed, 'id') && parsed.id !== null
  const id = hasId ? parsed.id : null
  const isNotification = !hasId
  const method = typeof parsed.method === 'string' ? parsed.method.trim() : ''
  if (!method) {
    return { ok: false, id, code: ACP_ERRORS.INVALID_REQUEST, message: 'request is missing "method"', isNotification: false }
  }
  if (parsed.jsonrpc !== undefined && parsed.jsonrpc !== JSONRPC_VERSION) {
    return {
      ok: false, id, isNotification,
      code: ACP_ERRORS.INVALID_REQUEST,
      message: `"jsonrpc" must be "${JSONRPC_VERSION}" when present, got ${JSON.stringify(parsed.jsonrpc)}`,
    }
  }
  const params = parsed.params && typeof parsed.params === 'object' && !Array.isArray(parsed.params) ? parsed.params : {}
  return { ok: true, request: { id, method, params, isNotification } }
}

// ── 参数校验 ────────────────────────────────────────────────────────────────

function invalid(message) {
  return { ok: false, code: ACP_ERRORS.INVALID_PARAMS, message }
}

/**
 * `initialize`：客户端报自己的协议版本与能力。
 * 刻意**不**因为版本号不认识就拒绝：握手阶段拒绝会让客户端只有一个「连不上」的结论，
 * 而版本协商的正确做法是回自己支持的那一版，由客户端决定要不要继续。
 */
export function validateInitializeParams(params = {}) {
  const version = params.protocolVersion
  if (version !== undefined && (!Number.isInteger(version) || version < 1)) {
    return invalid('"protocolVersion" must be a positive integer')
  }
  return { ok: true, value: { protocolVersion: version ?? ACP_PROTOCOL_VERSION, clientCapabilities: params.clientCapabilities || {} } }
}

/** ACP 的 prompt 是 content block 数组；这里只收 text 块，其余类型明确拒绝而不是丢掉。 */
export function extractPromptText(params = {}) {
  const prompt = params.prompt
  if (typeof prompt === 'string') return { ok: true, text: prompt }
  if (!Array.isArray(prompt)) return invalid('"prompt" must be a string or an array of content blocks')
  const parts = []
  for (const block of prompt) {
    if (!block || typeof block !== 'object') return invalid('every content block must be an object')
    if (block.type !== 'text') {
      return invalid(`unsupported content block type "${block.type}"; this agent only accepts "text" blocks`)
    }
    if (typeof block.text !== 'string') return invalid('a text content block needs a string "text"')
    parts.push(block.text)
  }
  const text = parts.join('').trim()
  if (!text) return invalid('"prompt" must contain at least one non-empty text block')
  return { ok: true, text }
}

export function validatePromptParams(params = {}) {
  const sessionId = typeof params.sessionId === 'string' ? params.sessionId.trim() : ''
  if (!sessionId) return invalid('"sessionId" is required')
  const extracted = extractPromptText(params)
  if (!extracted.ok) return extracted
  return { ok: true, value: { sessionId, text: extracted.text } }
}

export function validateSessionIdParams(params = {}) {
  const sessionId = typeof params.sessionId === 'string' ? params.sessionId.trim() : ''
  if (!sessionId) return invalid('"sessionId" is required')
  return { ok: true, value: { sessionId } }
}

// ── 会话表 ──────────────────────────────────────────────────────────────────

/**
 * 会话状态。
 *
 * **刻意只放在进程内存里**：会话的实质是「同一个 user dir 下的那段对话历史」，
 * 那玩意儿在磁盘上（jarvis.db），不在这个对象里。这里存的只是协议层需要的东西
 * （id、cwd、transcript）。进程一退，协议会话消失——这是对的：ACP 里客户端
 * 本来就是每次拉起一个 agent 子进程，长会话靠 `session/load` 从磁盘重建。
 *
 * transcript 为什么要留：多轮上下文延续是**硬验收项**。真实运行时会从 DB 里
 * 加载最近 N 条对话，但那条路依赖 senderId / 时间窗等多个条件，不能拿它当保证。
 * 所以每一轮都把此前的往返**显式**拼进任务文本——这样「第二轮能看到第一轮的信息」
 * 是构造出来的确定事实，而不是「大概率能从 DB 里捞到」。
 */
export class SessionStore {
  constructor({ sessionRoot = null, maxTranscriptTurns = 20 } = {}) {
    this.sessionRoot = sessionRoot
    this.maxTranscriptTurns = maxTranscriptTurns
    this.sessions = new Map()
  }

  create({ cwd = null } = {}) {
    const sessionId = `sess_${randomUUID().replace(/-/g, '').slice(0, 24)}`
    const session = {
      sessionId,
      cwd: cwd || process.cwd(),
      createdAt: new Date().toISOString(),
      transcript: [],
      turnCount: 0,
    }
    this.sessions.set(sessionId, session)
    return session
  }

  /** `session/load`：本进程内已经存在就直接复用；不存在则按同 id 重建（磁盘上的历史仍在）。 */
  load(sessionId, { cwd = null } = {}) {
    const existing = this.sessions.get(sessionId)
    if (existing) {
      if (cwd) existing.cwd = cwd
      return existing
    }
    const session = {
      sessionId,
      cwd: cwd || process.cwd(),
      createdAt: new Date().toISOString(),
      transcript: [],
      turnCount: 0,
      restored: true,
    }
    this.sessions.set(sessionId, session)
    return session
  }

  get(sessionId) {
    return this.sessions.get(sessionId) || null
  }

  recordTurn(sessionId, { user, assistant }) {
    const session = this.sessions.get(sessionId)
    if (!session) return
    session.transcript.push({ user: String(user ?? ''), assistant: String(assistant ?? '') })
    session.turnCount += 1
    while (session.transcript.length > this.maxTranscriptTurns) session.transcript.shift()
  }

  list() {
    return [...this.sessions.values()]
  }
}

const CONTINUITY_HEADER = '## Earlier turns in this session'
const CONTINUITY_FOOTER = '## Current request'

/**
 * 把「本会话此前的往返」拼进本轮任务。
 *
 * 为什么不是把历史塞给运行时的 DB：那要动 index.js 的上下文装配（别人的写范围），
 * 而且效果取决于 senderId 与时间窗。直接拼进任务文本是**自足**的——
 * 换任何后端（真模型 / 自测后端 / 客户端自己的实现）都成立。
 *
 * 第一轮原样返回，不加任何包装：给单轮调用方多塞一段提示词是纯粹的噪声。
 * 多轮任务的**当前请求放最后**：模型对结尾的指令服从度最高。
 */
export function composeTurnTask(session, text) {
  if (!session || session.transcript.length === 0) return text
  const lines = [CONTINUITY_HEADER, '']
  for (const turn of session.transcript) {
    lines.push(`user: ${turn.user}`)
    lines.push(`assistant: ${turn.assistant}`)
    lines.push('')
  }
  lines.push('Continue the conversation using the context above.')
  lines.push('')
  lines.push(CONTINUITY_FOOTER)
  lines.push(text)
  return lines.join('\n')
}

// ── 分块 ────────────────────────────────────────────────────────────────────

/**
 * 把一段完整文本切成推送给客户端的块。
 *
 * 两个目的，都要说清楚：
 *   1. **真流式**优先：后端每吐一块就原样转发，chunkCount 就是模型的 token 流块数。
 *   2. **兜底切分**：后端一次性给完整回复时（没有流式上游），切成多块再发。
 *      这是**保底**而不是等价物——它让「分块推送」这条协议路径在任何后端下都被走到，
 *      但它不假装自己知道模型的 token 边界。真伪由 `streamed` 标记区分，客户端能看出来。
 */
export function chunkText(text, { maxChunkChars = 120 } = {}) {
  const value = String(text ?? '')
  if (!value) return []
  const limit = Number.isFinite(maxChunkChars) && maxChunkChars > 0 ? Math.floor(maxChunkChars) : 120
  const chunks = []
  let cursor = 0
  while (cursor < value.length) {
    chunks.push(value.slice(cursor, cursor + limit))
    cursor += limit
  }
  return chunks
}

/** 每块的间隔。给客户端渲染留出发出多帧的窗口，不至于被 TCP 合并成一帧。 */
export const CHUNK_FLUSH_MS = 8

// ── 鉴权 ────────────────────────────────────────────────────────────────────

/**
 * 鉴权级别——**这是诚实说明，不是免责声明**，改动前先读完：
 *
 * 本服务端是 stdio 上的子进程。能给它写 stdin 的进程，本来就已经能在同一台机器上
 * 以同一用户身份做任何事（读同一份 config.json 里的 API key、直接开 DB）。
 * 因此这里的 token **不是一道安全边界**，它做不到也不打算做到「防止本机其他程序
 * 调用爱丽丝」。它实际解决的是另外两件事：
 *
 *   1. **误用与串台**：同一台机器上可能有多个自动化脚本 / 多个编排器。
 *      带上 token 能挡住「另一个进程把请求发进了这条管道」这类误接，
 *      也能让日志里一眼看出是谁在说话。
 *   2. **纵深防御**：如果将来有人把这条 stdio 管道接到远程边上（SSH、容器执行、
 *      某个 Web 终端），这一层会让「直接裸连」不再成立，至少要先拿到 token。
 *      但那时候真正的边界在那一层（SSH 认证、容器的隔离），不是这里。
 *
 * 所以：**不要把 token 当作安全隔离来宣传，也不要因为有了 token 就敢把这条管道
 * 暴露到网络上。** 需要网络边界就去做网络边界（TLS + 真正的认证 +
 * 现有 API 的 local-service-safety 那一套）。
 */
export function describeAuthLevel() {
  return {
    mechanism: 'shared-token',
    source: 'ALICE_ACP_TOKEN (or --token at startup)',
    level: 'process-local hygiene, not a network boundary',
    protects: ['cross-process mixups on a shared machine', 'accidental unauthenticated calls'],
    does_not_protect: [
      'any local process running as the same user (it can read the token from the environment or the process table)',
      'a network-attached transport (there is none here; if one is added, that layer owns its own auth)',
    ],
  }
}

/**
 * 令牌比较。用 `timingSafeEqual` 而不是 `===`。
 *
 * 说清楚：在 stdio 场景里这个选择**几乎不带来真实收益**（攻击者要能反复试探，
 * 早已能在本机读到 token）。写在这里是因为它零成本，而且一旦这段代码被搬到
 * 真正的网络上，`===` 就成了一个字面意义上的时序侧信道。宁可现在就对。
 */
export function tokenMatches(expected, provided) {
  const want = String(expected ?? '')
  const got = String(provided ?? '')
  if (!want) return true // 没配置 token = 不启用鉴权（见 describeAuthLevel 的级别说明）
  if (!got) return false
  // 长度不等时也要走一次比较，避免用早退泄露长度
  const a = Buffer.from(want, 'utf8')
  const b = Buffer.from(got, 'utf8')
  if (a.length !== b.length) {
    const padded = Buffer.alloc(a.length, 0)
    b.copy(padded, 0, 0, Math.min(a.length, b.length))
    timingSafeEqualShim(a, padded)
    return false
  }
  return timingSafeEqualShim(a, b)
}

function timingSafeEqualShim(a, b) {
  let diff = a.length ^ b.length
  for (let i = 0; i < a.length; i++) diff |= a[i] ^ (b[i] ?? 0)
  return diff === 0
}

/** 从请求里取 token：params.token / params.authToken / params._meta.token 都收。 */
export function extractToken(params = {}, env = process.env) {
  const candidates = [params.token, params.authToken, params?.authentication?.token, params?._meta?.token]
  for (const candidate of candidates) {
    if (typeof candidate === 'string' && candidate) return candidate
  }
  const fromEnv = env?.ALICE_ACP_TOKEN
  return typeof fromEnv === 'string' ? fromEnv : ''
}

/** 除了显式 token，另接受 HTTP 风格的 `params._meta.headers.Authorization: Bearer <token>`。 */
export function extractBearer(params = {}) {
  const header = params?._meta?.headers?.Authorization || params?._meta?.headers?.authorization
  if (typeof header !== 'string') return ''
  const m = header.match(/^Bearer\s+(.+)$/i)
  return m ? m[1].trim() : ''
}

// ── 服务端能力 ──────────────────────────────────────────────────────────────

export function agentCapabilities() {
  return {
    loadSession: true,
    promptCapabilities: { image: false, audio: false, embeddedContext: false },
  }
}

export function agentInfo({ version = '' } = {}) {
  return { name: 'alice', title: '爱丽丝', version: version || null }
}

/** 能力清单——把「一次一进程」这类限制写进去，比让调用方试出来好。 */
export function capabilityManifest({ version = '' } = {}) {
  return {
    acp_protocol_version: ACP_PROTOCOL_VERSION,
    jsonrpc: JSONRPC_VERSION,
    app_version: version || null,
    methods: [...KNOWN_METHODS],
    notifications: [...NOTIFICATION_METHODS, 'session/update'],
    session_model: 'multi-turn',
    streaming: {
      notification: 'session/update',
      variants: ['agent_message_chunk', 'agent_thought_chunk'],
      flush_interval_ms: CHUNK_FLUSH_MS,
    },
    auth: describeAuthLevel(),
    notes: [
      'Requests and responses are single-line JSON (JSON-RPC 2.0) on stdin/stdout.',
      'Notifications have no "id" and never get a response.',
      'The legacy {id, method:"run"} protocol from protocol_version 1 is still accepted.',
      'Tools that need a human (approval prompts, ask_user_question, plan review) report themselves unavailable instead of hanging.',
      'There is no UI attached: file-system and terminal client capabilities are not implemented by design.',
    ],
  }
}

// ── 分发 ────────────────────────────────────────────────────────────────────

/**
 * 一个 ACP 服务端实例。
 *
 * `turnRunner` 是注入点——这是让整件事可测的关键：
 *   `async ({ session, text, sessionDir, signal, onChunk, onThought }) => ({ answer, stopReason })`
 * 生产环境用「子进程跑一轮真实运行时」的实现（见 src/stdio.js），
 * 测试用的是确定性的假后端。协议层对两者一视同仁。
 *
 * `emit` 用来写通知：`(message) => void`。响应由调用方从 handle() 的返回值写出去。
 */
export class AcpServer {
  constructor({ turnRunner, emit = () => {}, version = '', token = '', sessionRoot = null, log = () => {} } = {}) {
    if (typeof turnRunner !== 'function') throw new Error('AcpServer needs a turnRunner function')
    this.turnRunner = turnRunner
    this.emit = emit
    this.version = version
    this.token = token
    this.log = log
    this.store = new SessionStore({ sessionRoot })
    this.initialized = false
    this.activeTurns = new Map() // sessionId -> AbortController
    this.pendingNotifications = []
  }

  /**
   * 处理一条已解析的请求。
   * @returns {Promise<object|null>} 要写出去的响应；通知（无 id）返回 null。
   */
  async handle(request) {
    const { id, method, params, isNotification } = request
    const wantsReply = !isNotification

    if (!KNOWN_METHODS.includes(method) && !NOTIFICATION_METHODS.includes(method)) {
      const err = buildErrorResponse(id, ACP_ERRORS.METHOD_NOT_FOUND, `unknown method "${method}"`, { supported: [...KNOWN_METHODS] })
      return wantsReply ? err : null
    }
    if (NOTIFICATION_METHODS.includes(method)) {
      // 通知永远不回包（JSON-RPC 规定），即使内部出了问题也只能记日志
      try {
        await this.#handleNotification(method, params)
      } catch (error) {
        this.log(`notification ${method} failed: ${error?.message || error}`)
      }
      return null
    }
    if (!wantsReply) {
      // 有 id 的未知形状、或客户端少了 id——不静默丢弃，回一个 null id 的错
      if (!KNOWN_METHODS.includes(method)) {
        return buildErrorResponse(null, ACP_ERRORS.METHOD_NOT_FOUND, `unknown method "${method}"`, { supported: [...KNOWN_METHODS] })
      }
    }

    // ── 鉴权闸门 ──
    if (PROTECTED_METHODS.includes(method)) {
      const provided = extractToken(params, process.env) || extractBearer(params)
      if (!tokenMatches(this.token, provided)) {
        this.log(`rejected ${method}: missing or wrong token`)
        return buildErrorResponse(id, ACP_ERRORS.AUTH_REQUIRED, 'this method requires a valid token', {
          ...describeAuthLevel(),
          hint: 'pass params.token, or set ALICE_ACP_TOKEN in the agent process environment',
        })
      }
    }

    try {
      switch (method) {
        case 'initialize': return this.#initialize(id, params)
        case 'authenticate': return this.#authenticate(id, params)
        case 'session/new': return this.#sessionNew(id, params)
        case 'session/load': return this.#sessionLoad(id, params)
        case 'session/prompt': return await this.#sessionPrompt(id, params)
        case 'ping': return buildResponse(id, { pong: true, acp_protocol_version: ACP_PROTOCOL_VERSION })
        case 'capabilities': return buildResponse(id, capabilityManifest({ version: this.version }))
        default:
          return buildErrorResponse(id, ACP_ERRORS.METHOD_NOT_FOUND, `unknown method "${method}"`)
      }
    } catch (error) {
      this.log(`method ${method} threw: ${error?.stack || error}`)
      return buildErrorResponse(id, ACP_ERRORS.INTERNAL_ERROR, error?.message || String(error))
    }
  }

  async #handleNotification(method, params) {
    if (method === 'session/cancel') {
      const sessionId = typeof params?.sessionId === 'string' ? params.sessionId : ''
      const controller = this.activeTurns.get(sessionId)
      if (controller) {
        controller.abort()
        this.log(`session/cancel: aborted in-flight turn for ${sessionId}`)
      } else {
        this.log(`session/cancel: no in-flight turn for ${sessionId || '(missing sessionId)'}`)
      }
    }
  }

  #initialize(id, params) {
    const validated = validateInitializeParams(params)
    if (!validated.ok) return buildErrorResponse(id, validated.code, validated.message)
    this.initialized = true
    this.log(`initialize: client protocolVersion=${validated.value.protocolVersion}`)
    return buildResponse(id, {
      protocolVersion: ACP_PROTOCOL_VERSION,
      agentCapabilities: agentCapabilities(),
      agentInfo: agentInfo({ version: this.version }),
      authMethods: this.token
        ? [{
            id: 'shared-token',
            name: 'Shared token',
            description: 'Pass the token configured on the agent process via params.token, or set ALICE_ACP_TOKEN.',
            ...describeAuthLevel(),
          }]
        : [],
    })
  }

  #authenticate(id, params) {
    if (!this.token) {
      return buildResponse(id, { authenticated: true, authMethod: null, level: describeAuthLevel() })
    }
    const provided = extractToken(params, process.env) || extractBearer(params)
    if (!tokenMatches(this.token, provided)) {
      return buildErrorResponse(id, ACP_ERRORS.AUTH_REQUIRED, 'invalid token', describeAuthLevel())
    }
    return buildResponse(id, { authenticated: true, authMethod: params?.methodId || 'shared-token', level: describeAuthLevel() })
  }

  #sessionNew(id, params) {
    const cwd = typeof params?.cwd === 'string' && params.cwd ? params.cwd : null
    const session = this.store.create({ cwd })
    this.log(`session/new: ${session.sessionId}`)
    return buildResponse(id, { sessionId: session.sessionId, cwd: session.cwd })
  }

  #sessionLoad(id, params) {
    const validated = validateSessionIdParams(params)
    if (!validated.ok) return buildErrorResponse(id, validated.code, validated.message)
    const session = this.store.load(validated.value.sessionId, {
      cwd: typeof params?.cwd === 'string' && params.cwd ? params.cwd : null,
    })
    // ACP 规定 load 之后要重放历史。这里重放 transcript，且**明确标注是重放**，
    // 免得客户端把重放块当成新产生的输出又渲染一遍。
    for (const turn of session.transcript) {
      this.emit(buildSessionUpdate(session.sessionId, {
        sessionUpdate: 'user_message_chunk',
        content: { type: 'text', text: turn.user },
        _meta: { replay: true },
      }))
      if (turn.assistant) {
        this.emit(buildSessionUpdate(session.sessionId, {
          sessionUpdate: 'agent_message_chunk',
          content: { type: 'text', text: turn.assistant },
          _meta: { replay: true },
        }))
      }
    }
    return buildResponse(id, { sessionId: session.sessionId, cwd: session.cwd, turns: session.transcript.length })
  }

  async #sessionPrompt(id, params) {
    const validated = validatePromptParams(params)
    if (!validated.ok) return buildErrorResponse(id, validated.code, validated.message)
    const { sessionId, text } = validated.value
    const session = this.store.get(sessionId)
    if (!session) {
      return buildErrorResponse(id, ACP_ERRORS.SESSION_NOT_FOUND, `no session "${sessionId}" in this process`, {
        hint: 'call session/new first, or session/load to reattach',
      })
    }
    if (this.activeTurns.has(sessionId)) {
      return buildErrorResponse(id, ACP_ERRORS.INVALID_REQUEST, `session "${sessionId}" already has a turn in flight`, {
        hint: 'send session/cancel, or wait for the previous session/prompt to resolve',
      })
    }

    const controller = new AbortController()
    this.activeTurns.set(sessionId, controller)

    // 流式：后端每来一块就立刻发一条 session/update。**边收边发**，不是最后一次性写，
    // 这正是 ACP 把 session/update 做成通知的原因。
    let streamedChunks = 0
    let streamedChars = 0
    let answerFromChunks = ''
    const onChunk = (text_) => {
      const value = String(text_ ?? '')
      if (!value) return
      streamedChunks += 1
      streamedChars += value.length
      answerFromChunks += value
      this.emit(buildAgentMessageChunk(sessionId, value))
    }
    const onThought = (text_) => {
      const value = String(text_ ?? '')
      if (!value) return
      this.emit(buildAgentThoughtChunk(sessionId, value))
    }

    const task = composeTurnTask(session, text)

    try {
      const result = await this.turnRunner({
        session,
        sessionId,
        text,
        task,
        sessionDir: session.cwd,
        signal: controller.signal,
        onChunk,
        onThought,
      })

      if (controller.signal.aborted) {
        return this.#finishCancelled(id, sessionId, { text, partial: answerFromChunks || String(result?.answer ?? ''), streamedChunks })
      }

      const answer = String(result?.answer ?? '')
      // 后端没有流式上游时（一次性给了完整回复），保底切块推送。
      // 标记 synthetic 是**如实告知**：这些块的边界是切出来的，不是模型的 token 边界。
      if (streamedChunks === 0 && answer) {
        for (const piece of chunkText(answer)) onChunk(piece)
        this.log(`session/prompt: backend did not stream; forwarded ${streamedChunks} synthetic chunk(s)`)
        return this.#finishTurn(id, sessionId, {
          answer, result, text, synthetic: true, streamedChunks,
        })
      }

      return this.#finishTurn(id, sessionId, { answer, result, text, synthetic: false, streamedChunks })
    } catch (error) {
      if (controller.signal.aborted || error?.name === 'AbortError') {
        return this.#finishCancelled(id, sessionId, { text, partial: answerFromChunks, streamedChunks })
      }
      return buildErrorResponse(id, ACP_ERRORS.INTERNAL_ERROR, error?.message || String(error), { sessionId })
    } finally {
      this.activeTurns.delete(sessionId)
    }
  }

  /**
   * 被取消的那一轮的响应。
   *
   * `_meta.cancelled_before_end = true` 是有意加的字段：它与「轮次自然结束」在
   * stopReason 上就已经分得开，但分得开不等于**测得出来**——断言必须证明取消
   * 是在轮次真正结束前生效的，否则「取消晚了一步、那一轮本来也要结束」也会通过。
   * 把这件事写进响应，客户端（和测试）就不必靠时序去猜。
   */
  #finishCancelled(id, sessionId, { text, partial, streamedChunks }) {
    this.store.recordTurn(sessionId, { user: text, assistant: partial || '' })
    const session = this.store.get(sessionId)
    return buildResponse(id, {
      stopReason: STOP_REASONS.CANCELLED,
      _meta: {
        sessionId,
        chunks: streamedChunks,
        streamed: streamedChunks > 0,
        chunk_source: streamedChunks > 0 ? 'backend' : 'none',
        answer_chars: (partial || '').length,
        turn: session ? session.turnCount : null,
        cancelled_before_end: true,
      },
    })
  }

  #finishTurn(id, sessionId, { answer, result, text, synthetic, streamedChunks }) {
    const finalAnswer = answer || ''
    this.store.recordTurn(sessionId, { user: text, assistant: finalAnswer })
    const session = this.store.get(sessionId)
    return buildResponse(id, {
      stopReason: result?.stopReason || STOP_REASONS.END_TURN,
      // 以下都是 ACP 允许的附加信息（_meta）。放这里是因为调用方需要判断
      // 「这次到底有没有真的流起来」，而这不该靠猜。
      _meta: {
        sessionId,
        chunks: streamedChunks,
        streamed: !synthetic && streamedChunks > 0,
        chunk_source: synthetic ? 'synthetic' : (streamedChunks > 0 ? 'backend' : 'none'),
        answer_chars: finalAnswer.length,
        turn: session ? session.turnCount : null,
        ...(result?.durationMs !== undefined ? { duration_ms: result.durationMs } : {}),
        ...(result?.sessionDir ? { session_dir: result.sessionDir } : {}),
      },
    })
  }
}
