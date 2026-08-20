// SSH 远程机器托管 —— 纯逻辑核心（无 I/O、无网络、无 ssh2 依赖）。
//
// 移植自 DSH `dsh-tauri-ssh`（行为复刻，不抄代码）。这里只放**可以在没有 SSH 服务器
// 的环境里被完整验证**的部分：传输层信封的阶梯判定、机器记录投影、失败分类、
// shell 引用、隧道 cookie 头改写。
//
// 为什么把这些单独放一个文件：SSH 的真实握手/隧道/远程安装在本机无法端到端验证，
// 但上面这些是与远端无关的**纯函数**，它们的正确性恰恰是最容易出错、也最值得断言的地方
// （见 test-ssh-remote.js）。把纯逻辑与传输层分开，测试不必拉起任何 socket。

import crypto from 'crypto'

// ── 常量 ────────────────────────────────────────────────────────────────────

export const DEFAULT_SSH_PORT = 22
export const DEFAULT_REMOTE_PORT = 3080

/** 传输层请求体上限。超过即 400，不再尝试解析。 */
export const MAX_REQUEST_BYTES = 64 * 1024

/** 隧道请求头改写上限。超过即 fail-open（不注入，原样透传）。 */
export const TUNNEL_HEAD_CAP = 64 * 1024

/** 每台机器的事件环形缓冲容量。 */
export const EVENT_RING_CAPACITY = 500

/** 事件 stage 取值（9 个，固定集合）。 */
export const EVENT_STAGES = Object.freeze([
  'probe', 'download', 'verify', 'install', 'launch', 'ready', 'failed', 'auth', 'reconnect',
])

/** 重连默认参数（与 DSH ConfigSchema 默认值对齐）。 */
export const RECONNECT_DEFAULTS = Object.freeze({
  reconnectInitialDelayMs: 1000,
  reconnectMaxDelayMs: 20000,
  reconnectMaxAttempts: 6,
})

// ── 业务错误 ────────────────────────────────────────────────────────────────

/**
 * 带业务码的错误。传输层把它转成 **HTTP 200** + `{ok:false,error:{code,message}}`——
 * 业务失败不是传输失败，用 5xx 会让调用方的重试/告警逻辑全部误判。
 */
export class SshError extends Error {
  constructor(code, message) {
    super(message)
    this.name = 'SshError'
    this.code = code
  }
}

// ── 机器记录投影 ─────────────────────────────────────────────────────────────

/**
 * 把一条原始记录投影成机器档案。**必填字段缺失即返回 undefined（整行静默丢弃）**——
 * 不是抛错、不是补默认值。半条记录（比如有 host 没 user）连都连不上，
 * 与其在连接时才炸，不如在投影时就当作不存在。
 * @returns {object|undefined}
 */
export function machineProfileOf(raw) {
  if (typeof raw !== 'object' || raw === null) return undefined
  if (typeof raw.id !== 'string' || raw.id === '') return undefined
  if (typeof raw.name !== 'string') return undefined
  if (typeof raw.host !== 'string' || raw.host === '') return undefined
  if (typeof raw.user !== 'string') return undefined

  return {
    id: raw.id,
    name: raw.name,
    host: raw.host,
    port: typeof raw.port === 'number' ? raw.port : DEFAULT_SSH_PORT,
    user: raw.user,
    remotePort: typeof raw.remotePort === 'number' ? raw.remotePort : DEFAULT_REMOTE_PORT,
    // 下面这些是「非空才写入」：空串与缺失等价，都不产出该键。
    ...(typeof raw.password === 'string' && raw.password !== '' ? { password: raw.password } : {}),
    ...(typeof raw.passphrase === 'string' && raw.passphrase !== '' ? { passphrase: raw.passphrase } : {}),
    ...(typeof raw.profileName === 'string' && raw.profileName !== '' ? { profileName: raw.profileName } : {}),
    ...(typeof raw.startCommand === 'string' && raw.startCommand !== '' ? { startCommand: raw.startCommand } : {}),
    ...(typeof raw.color === 'string' && raw.color !== '' ? { color: raw.color } : {}),
    // tintBorder 是**严格 true 才写入**：'true' / 1 都不算。
    ...(raw.tintBorder === true ? { tintBorder: true } : {}),
  }
}

/**
 * 把存储字典投影成 id → 档案的 Map。
 * **键与记录 id 不符的行静默丢弃**：字典被手工编辑过、或 id 被改过时，
 * 以记录自身的 id 为准会让「删除 A 却删掉 B」这类错位删除发生。
 * @returns {Map<string, object>}
 */
export function machinesOf(value) {
  const profiles = new Map()
  if (typeof value !== 'object' || value === null) return profiles
  for (const [key, raw] of Object.entries(value)) {
    const profile = machineProfileOf(raw)
    if (profile === undefined) continue
    if (profile.id !== key) continue
    profiles.set(key, profile)
  }
  return profiles
}

/**
 * 读取持久化状态。**损坏/缺失一律回落默认值，绝不抛异常**。
 * SSH 托管默认关闭：一个坏掉的 machines.json 绝不能让整个 API 起不来。
 * @returns {{enabled: boolean, machines: object}}
 */
export function parseStateFile(text) {
  const fallback = { enabled: false, machines: {} }
  if (typeof text !== 'string' || text === '') return fallback
  let parsed
  try {
    parsed = JSON.parse(text)
  } catch {
    return fallback
  }
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) return fallback
  const machines = (typeof parsed.machines === 'object' && parsed.machines !== null && !Array.isArray(parsed.machines))
    ? parsed.machines
    : {}
  return { enabled: parsed.enabled === true, machines }
}

// ── 失败分类 ────────────────────────────────────────────────────────────────

/** 网络层「根本连不上」的错误码。 */
const UNREACHABLE_CODES = new Set([
  'ENOTFOUND', 'EAI_AGAIN', 'ECONNREFUSED', 'ETIMEDOUT',
  'EHOSTUNREACH', 'ENETUNREACH', 'ECONNRESET',
])

function isUnreachable(error) {
  const code = error?.code
  if (code !== undefined && UNREACHABLE_CODES.has(code)) return true
  const message = typeof error?.message === 'string' ? error.message : ''
  return /timed?\s?out|connection refused|econnrefused|no route to host|name or service not known|getaddrinfo/i.test(message)
}

/**
 * 把一次连接失败归类。操作者能据此知道**该去修什么**：
 * 换网络、补 key、还是改密码。
 * @returns {'unreachable'|'key-rejected'|'password-rejected'|'other'}
 */
export function classifyConnectFailure(error, passwordOffered) {
  const message = error instanceof Error ? error.message : String(error)
  if (isUnreachable(error instanceof Error ? error : new Error(message))) return 'unreachable'
  if (/all configured authentication methods failed|authentication failed|no supported authentication/i.test(message)) {
    return passwordOffered ? 'password-rejected' : 'key-rejected'
  }
  return 'other'
}

/** 面向操作者的失败文案。逐字复刻，包含 unreachable 空消息的回落串。 */
export function describeConnectFailure(kind, error) {
  const message = error instanceof Error ? error.message : String(error)
  switch (kind) {
    case 'key-rejected':
      return 'authentication failed: no key or ssh-agent was accepted — check your keys or store a password for this machine'
    case 'password-rejected':
      return 'authentication failed: the stored password was rejected — update the stored password'
    case 'unreachable':
      return `host unreachable: ${message === '' ? 'SSH connection failed' : message}`
    default:
      return message === '' ? 'SSH connection failed' : message
  }
}

// ── 凭据脱敏 ────────────────────────────────────────────────────────────────

/**
 * 把面向操作者的字符串里出现的凭据全部替换成 `***`。
 *
 * 任何回传给 UI / 日志 / 错误消息的字符串都必须过这里。SSH 的失败信息经常
 * 原样带上认证细节，密码一旦进了错误串就会顺着日志、崩溃上报、截图一路泄漏出去。
 * 短串（长度 < 4）不脱敏：把 'a' 这种单字符密码全局替换会把整条消息打成马赛克，
 * 反而丢掉诊断价值；这类密码本身也不具备被意外泄漏的熵。
 * @param {string} text
 * @param {object} [profile] 机器档案（含 password/passphrase）
 */
export function redacted(text, profile) {
  let out = typeof text === 'string' ? text : String(text ?? '')
  if (!profile || typeof profile !== 'object') return out
  for (const secret of [profile.password, profile.passphrase]) {
    if (typeof secret !== 'string' || secret.length < 4) continue
    out = out.split(secret).join('***')
  }
  return out
}

// ── shell 引用 ──────────────────────────────────────────────────────────────

/**
 * 单引号包裹 + 内部单引号转义。远程命令的**每一个**插值都必须过这里。
 *
 * `'` → `'\''`（结束当前单引号段、插入一个转义单引号、重新开段）。
 * 少了这层，一个带单引号的 profileName 就能在远端拼出任意命令。
 */
export function shQuote(value) {
  return `'${String(value).replace(/'/g, `'\\''`)}'`
}

/** 所有远程命令的统一包装：走登录 shell，让远端的 PATH/环境与交互式登录一致。 */
export function loginShell(command) {
  return `sh -lc ${shQuote(command)}`
}

/** profileName 只允许 `^[\w-]+$`，否则回落 `remote`（它会被拼进远程路径与命令行）。 */
export function safeProfileName(value) {
  const text = typeof value === 'string' ? value : ''
  return /^[\w-]+$/.test(text) ? text : 'remote'
}

// ── 隧道 cookie 注入 ─────────────────────────────────────────────────────────

/**
 * 往一个 HTTP 请求头里注入隧道 cookie。**这是整个移植最容易写错的一处**，
 * 因为它改的是逐行结构而不是文本：
 *
 *  - 按 `\r\n` 切行（不是 `\n`，HTTP 头就是 CRLF）
 *  - 判 upgrade：只要有一行 `Connection: upgrade` 就是 WebSocket 握手
 *  - **删掉所有已有的 `Cookie:` 行**（不去重的话会有两个 Cookie 头，
 *    服务端可能取到旧的那个，鉴权随机失败）
 *  - 非 upgrade 时删掉 `Connection:` 行，稍后自己插一条 `Connection: close`
 *    （隧道里每个连接只跑一个请求，keep-alive 会让远端连接挂住不释放）
 *  - Cookie 插在**索引 1**（索引 0 是请求行），非 upgrade 时 `Connection: close`
 *    插在**索引 2**（紧跟 Cookie 之后）
 *  - upgrade 时**绝不动** `Connection: Upgrade`，否则 WebSocket 握手直接失败
 *
 * @param {string} head 原始请求头（含请求行）
 * @param {string} cookie `name=value` 形态
 * @returns {string} 改写后的请求头
 */
export function injectCookieHead(head, cookie) {
  const lines = String(head).split('\r\n')
  const isUpgrade = lines.some((line) => /^connection:\s*upgrade/i.test(line))
  const kept = lines.filter((line) => !/^cookie:/i.test(line) && (isUpgrade || !/^connection:/i.test(line)))
  kept.splice(1, 0, `Cookie: ${cookie}`)
  if (!isUpgrade) kept.splice(2, 0, 'Connection: close')
  return kept.join('\r\n')
}

/**
 * 头部超过上限时 **fail-open**：不注入、原样透传。
 *
 * 宁可丢掉隧道鉴权（`?token=` URL 仍是兜底），也不能因为一个异常巨大的
 * Cookie 头把用户的请求整个卡死——可用性优先于这条加固。
 */
export function shouldInjectCookie(head) {
  return Buffer.byteLength(String(head), 'utf8') <= TUNNEL_HEAD_CAP
}

/** 从 `set-cookie` 取值：第一个 `;` 之前的部分，空则 undefined。 */
export function cookiePairOf(setCookieHeader) {
  const raw = Array.isArray(setCookieHeader) ? setCookieHeader[0] : setCookieHeader
  if (typeof raw !== 'string') return undefined
  const pair = raw.split(';')[0]?.trim()
  return !pair ? undefined : pair
}

/**
 * 从认证 URL 铸造隧道 cookie。**一次 GET，不跟随 303**——
 * 跟随重定向会把 token 带到一个不需要它的地址上，且拿到的是重定向后的响应头。
 */
export async function mintTunnelCookie(authenticatedUrl, { timeoutMs = 3000, getImpl } = {}) {
  const get = getImpl ?? (await import('http')).get
  return new Promise((resolve) => {
    let settled = false
    const done = (value) => { if (!settled) { settled = true; resolve(value) } }
    let request
    try {
      request = get(authenticatedUrl, (response) => {
        response.resume()
        done(cookiePairOf(response.headers?.['set-cookie']))
      })
    } catch {
      done(undefined)
      return
    }
    request.on('error', () => done(undefined))
    request.setTimeout(timeoutMs, () => {
      request.destroy()
      done(undefined)
    })
  })
}

// ── loopback 判定 ───────────────────────────────────────────────────────────

/**
 * 只有这三个地址算 loopback。`::ffff:127.0.0.1` 是 IPv4-mapped IPv6，
 * Node 在双栈 socket 上就是这么报的，不认它会把本机请求全挡在 403 外面。
 */
export function isLoopbackPeer(address) {
  const value = typeof address === 'string' ? address.trim().toLowerCase() : ''
  if (value === '127.0.0.1' || value === '::1' || value === '::ffff:127.0.0.1') return true
  return false
}

// ── 指纹 ────────────────────────────────────────────────────────────────────

/** ssh-keygen 风格的指纹：`SHA256:` + base64（**去掉尾部 padding**）。 */
export function fingerprintHostKey(key) {
  const buf = Buffer.isBuffer(key) ? key : Buffer.from(key)
  return `SHA256:${crypto.createHash('sha256').update(buf).digest('base64').replace(/=+$/, '')}`
}

// ── ProxyJump ───────────────────────────────────────────────────────────────

/** 解析 `[user@]alias[:port]`。user 与 port 只在存在时写入。 */
export function parseProxyJumpHop(token) {
  let rest = String(token)
  let user
  const at = rest.lastIndexOf('@')
  if (at !== -1) {
    user = rest.slice(0, at)
    rest = rest.slice(at + 1)
  }
  let port
  const colon = rest.lastIndexOf(':')
  if (colon !== -1 && /^\d+$/.test(rest.slice(colon + 1))) {
    port = Number(rest.slice(colon + 1))
    rest = rest.slice(0, colon)
  }
  return { alias: rest, ...(user === undefined ? {} : { user }), ...(port === undefined ? {} : { port }) }
}

/** `ProxyJump` 值的 hop 列表。逗号分隔，空白项丢弃。 */
export function parseProxyJumpChain(value) {
  if (typeof value !== 'string' || value.trim() === '') return []
  return value.split(',').map((part) => part.trim()).filter((part) => part !== '').map(parseProxyJumpHop)
}

// ── 重连退避 ────────────────────────────────────────────────────────────────

/** `min(initial * 2^(attempt-1), max)`。attempt 从 1 起。 */
export function reconnectDelayMs(attempt, {
  reconnectInitialDelayMs = RECONNECT_DEFAULTS.reconnectInitialDelayMs,
  reconnectMaxDelayMs = RECONNECT_DEFAULTS.reconnectMaxDelayMs,
} = {}) {
  const n = Math.max(1, Math.floor(attempt))
  return Math.min(reconnectInitialDelayMs * (2 ** (n - 1)), reconnectMaxDelayMs)
}

/** 超过上限即放弃。 */
export function shouldGiveUp(attempt, { reconnectMaxAttempts = RECONNECT_DEFAULTS.reconnectMaxAttempts } = {}) {
  return attempt > reconnectMaxAttempts
}

// ── 事件环形缓冲 ─────────────────────────────────────────────────────────────

/**
 * 每机器一份的内存环形缓冲。**不持久化**——它是「这台机器此刻在干什么」的
 * 实时视图，重启后重新探测即可，落盘只会留下过期的假象。
 * 容量固定 500，超出即丢最旧的。
 */
export class EventRing {
  constructor(machineId, capacity = EVENT_RING_CAPACITY) {
    this.machineId = machineId
    this.capacity = capacity
    this.events = []
    this.seq = 0
  }

  /** 追加一条事件，返回它的 seq。 */
  push({ stage, line, terminal, reason } = {}) {
    this.seq += 1
    const event = {
      seq: this.seq,
      ts: new Date().toISOString(),
      machineId: this.machineId,
      stage,
      line: line === undefined ? '' : String(line),
      ...(terminal === undefined ? {} : { terminal }),
      ...(reason === undefined ? {} : { reason }),
    }
    this.events.push(event)
    if (this.events.length > this.capacity) {
      this.events.splice(0, this.events.length - this.capacity)
    }
    return event
  }

  /** 取 seq > sinceSeq 的事件。**读取不改变任何状态**（游标由调用方自持）。 */
  since(sinceSeq) {
    const from = typeof sinceSeq === 'number' && Number.isFinite(sinceSeq) ? sinceSeq : 0
    return {
      events: this.events.filter((event) => event.seq > from),
      nextSeq: this.seq + 1,
    }
  }
}

// ── 传输层信封 ───────────────────────────────────────────────────────────────
// 阶梯顺序**固定**，先判的永远不会被后判的覆盖。返回值的 shape：
//   {kind:'reject', status, body}  —— 传输层错误，用对应 HTTP 状态码
//   {kind:'cors', status:204}      —— OPTIONS 预检
//   {kind:'dispatch', method, payload}
//
// 第 7 条（业务异常 → HTTP 200）不在这里，它在真正调用 handler 的地方——
// 那里才知道 handler 抛了什么。

/** 允许的 Origin：本机 GUI 与打包后的 file:// 页面。 */
export function isAllowedTunnelOrigin(origin) {
  if (!origin || origin === 'null') return true
  try {
    const parsed = new URL(origin)
    return ['127.0.0.1', 'localhost', '::1'].includes(parsed.hostname)
  } catch {
    return false
  }
}

/**
 * 对一个已解析的请求跑前 6 条预分发台阶。
 * @param {{method:string, remoteAddress:string, origin?:string, bodyText?:string, bodyBytes?:number}} req
 */
export function preflight(req) {
  const method = String(req?.method ?? '').toUpperCase()

  // 1. 非 loopback —— 最先判。这条 API 能在目标机上开隧道、跑远程命令，
  //    绝不能从局域网可达。放在 CORS/OPTIONS 之前是因为预检请求同样不该被外部触达。
  if (!isLoopbackPeer(req?.remoteAddress)) {
    return { kind: 'reject', status: 403, body: { ok: false, error: { code: 'forbidden', message: 'this API is loopback-only' } } }
  }

  // 2. OPTIONS 预检。Origin 不在允许表 → 403；否则 204 + CORS。
  if (method === 'OPTIONS') {
    if (!isAllowedTunnelOrigin(req?.origin)) {
      return { kind: 'reject', status: 403, body: { ok: false, error: { code: 'forbidden', message: 'origin not allowed' } } }
    }
    return { kind: 'cors', status: 204 }
  }

  // 3. 非 POST。
  if (method !== 'POST') {
    return { kind: 'reject', status: 405, body: { ok: false, error: { code: 'method-not-allowed', message: 'POST only' } } }
  }

  // 4. 体超限或 JSON 非法。
  const bytes = typeof req?.bodyBytes === 'number' ? req.bodyBytes : Buffer.byteLength(String(req?.bodyText ?? ''), 'utf8')
  if (bytes > MAX_REQUEST_BYTES) {
    return { kind: 'reject', status: 400, body: { ok: false, error: { code: 'bad-request', message: 'malformed JSON body' } } }
  }
  let parsed
  try {
    parsed = JSON.parse(String(req?.bodyText ?? ''))
  } catch {
    return { kind: 'reject', status: 400, body: { ok: false, error: { code: 'bad-request', message: 'malformed JSON body' } } }
  }
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    return { kind: 'reject', status: 400, body: { ok: false, error: { code: 'bad-request', message: 'malformed JSON body' } } }
  }

  // 5. method 缺失/空。
  const rpc = parsed.method
  if (typeof rpc !== 'string' || rpc === '') {
    return { kind: 'reject', status: 400, body: { ok: false, error: { code: 'bad-request', message: 'missing method' } } }
  }

  // 6. 未知方法由调用方在自己的方法表里判（这里不知道有哪些 handler）。
  return { kind: 'dispatch', method: rpc, payload: parsed.payload }
}

/** 第 6 条：未知方法。 */
export function unknownMethod(method) {
  return { status: 404, body: { ok: false, error: { code: 'unknown-method', message: `unknown method "${method}"` } } }
}

/**
 * 第 7 条：业务异常 → **HTTP 200** + `{ok:false,error}`。
 * 传输层已经成功了（请求收到了、解析了、分发了），失败发生在业务里；
 * 用 5xx 会让所有客户端把「机器连不上」误判成「后端挂了」。
 */
export function businessFailure(error) {
  if (error instanceof SshError) {
    return { status: 200, body: { ok: false, error: { code: error.code, message: error.message } } }
  }
  const message = error instanceof Error ? error.message : String(error)
  return { status: 200, body: { ok: false, error: { code: 'internal', message } } }
}

/** 成功信封。 */
export function success(value) {
  return { status: 200, body: { ok: true, value } }
}
