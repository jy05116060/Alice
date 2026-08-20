// 面向外部客户端的 stdio 协议层（阶段 6.6 的**最小子集**）。
//
// 计划里对 ACP/SDK 的结论是「建议暂缓，如确有需求先只做 headless + 最小子集」。
// 这里就是那个最小子集：**行分隔的 JSON-RPC 风格协议**，一个进程处理一次 `run`。
//
// 刻意不做的（并写在这里，免得以后有人以为漏了）：
//   - 不做多轮会话。一次请求一个任务，答完就退出。多轮要引入会话生命周期、
//     并发与取消语义，那是完整 ACP 的工作量；脚本式调用用不上。
//   - 不实现 ACP 规范的全部方法与流式推送。方法名保持中性，不假装兼容某个规范。
//   - 不做鉴权：它只监听调用方的 stdin/stdout，进程边界本身就是权限边界。
//
// 协议（每行一个 JSON）：
//   请求：{"id": <任意>, "method": "capabilities" | "ping" | "run", "params": {...}}
//   成功：{"id": <同请求>, "result": {...}}
//   失败：{"id": <同请求>, "error": {"code": "...", "message": "..."}}
//   `run` 的 params：{ task: string, fresh_session?: boolean, timeout_ms?: number }
//
// 纯函数放这里，便于直接测；真正的进程接线在 src/stdio-profile.js。
export const PROTOCOL_VERSION = '1'

export const METHODS = Object.freeze(['ping', 'capabilities', 'run'])

export const ERROR_CODES = Object.freeze({
  PARSE_ERROR: 'PARSE_ERROR',
  INVALID_REQUEST: 'INVALID_REQUEST',
  METHOD_NOT_FOUND: 'METHOD_NOT_FOUND',
  INVALID_PARAMS: 'INVALID_PARAMS',
  RUN_FAILED: 'RUN_FAILED',
  INTERNAL_ERROR: 'INTERNAL_ERROR',
})

const MAX_LINE_BYTES = 1024 * 1024
const MAX_TASK_CHARS = 100_000

/** 客户端能用什么、不能用什么——说清楚边界比让调用方试出来好。 */
export function capabilityManifest({ version = '' } = {}) {
  return {
    protocol_version: PROTOCOL_VERSION,
    app_version: version || null,
    methods: [...METHODS],
    // 「一次一进程」是有意的限制，必须写进能力清单
    session_model: 'one-shot',
    notes: [
      'Each process handles one run request, then exits. Spawn a new process for the next task.',
      'Requests and responses are single-line JSON on stdin/stdout.',
      'Tools that need a human (approval prompts, ask_user_question, plan review) report themselves unavailable instead of hanging.',
    ],
  }
}

/**
 * 解析一行请求。
 * @returns {{ok: true, request: {id, method, params}} | {ok: false, id: any, code: string, message: string}}
 */
export function parseRequestLine(line) {
  const raw = String(line ?? '').trim()
  if (!raw) {
    return { ok: false, id: null, code: ERROR_CODES.INVALID_REQUEST, message: 'empty request line' }
  }
  if (Buffer.byteLength(raw, 'utf8') > MAX_LINE_BYTES) {
    return { ok: false, id: null, code: ERROR_CODES.INVALID_REQUEST, message: 'request line is too large' }
  }
  let parsed
  try {
    parsed = JSON.parse(raw)
  } catch (error) {
    return { ok: false, id: null, code: ERROR_CODES.PARSE_ERROR, message: `invalid JSON: ${error.message}` }
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    return { ok: false, id: null, code: ERROR_CODES.INVALID_REQUEST, message: 'a request must be a JSON object' }
  }
  // id 原样回传（可能是数字或字符串）；缺 id 也接受，回 null——不因为缺 id 就丢弃请求，
  // 那样调用方只会看到「没有响应」而不知道错在哪
  const id = parsed.id === undefined ? null : parsed.id
  const method = typeof parsed.method === 'string' ? parsed.method.trim() : ''
  if (!method) {
    return { ok: false, id, code: ERROR_CODES.INVALID_REQUEST, message: 'request is missing "method"' }
  }
  if (!METHODS.includes(method)) {
    return { ok: false, id, code: ERROR_CODES.METHOD_NOT_FOUND, message: `unknown method "${method}"; supported: ${METHODS.join(', ')}` }
  }
  return { ok: true, request: { id, method, params: parsed.params && typeof parsed.params === 'object' ? parsed.params : {} } }
}

/** 校验 `run` 的参数。 */
export function validateRunParams(params = {}) {
  const task = typeof params.task === 'string' ? params.task.trim() : ''
  if (!task) {
    return { ok: false, code: ERROR_CODES.INVALID_PARAMS, message: 'run needs a non-empty "task" string' }
  }
  if (task.length > MAX_TASK_CHARS) {
    return { ok: false, code: ERROR_CODES.INVALID_PARAMS, message: `"task" is too long (limit ${MAX_TASK_CHARS} characters)` }
  }
  const timeoutMs = Number(params.timeout_ms)
  return {
    ok: true,
    value: {
      task,
      // 默认**全新会话**：与 headless 同一个取舍（不污染用户正在聊的对话）
      freshSession: params.fresh_session !== false,
      timeoutMs: Number.isFinite(timeoutMs) && timeoutMs >= 1000 ? Math.round(timeoutMs) : 300_000,
    },
  }
}

/** 一行响应文本（**不含换行**，由调用方决定怎么写）。 */
export function encodeMessage(message) {
  return JSON.stringify(message)
}

export function buildResult(id, result) {
  return { id: id ?? null, result }
}

export function buildError(id, code, message, detail = null) {
  return { id: id ?? null, error: { code, message, ...(detail ? { detail } : {}) } }
}

/**
 * 把内部的一次运行结果包成协议响应。
 * 内部形状（headless 的 JSON 输出）与协议形状是两回事，这里做唯一一次转换，
 * 免得调用方在两种形状之间猜。
 */
export function packageRunResult(id, runResult = {}) {
  const ok = runResult?.ok === true
  if (!ok) {
    return buildError(id, ERROR_CODES.RUN_FAILED, runResult?.error || 'the run did not produce an answer', {
      ...(runResult?.duration_ms !== undefined ? { duration_ms: runResult.duration_ms } : {}),
      ...(runResult?.session_dir ? { session_dir: runResult.session_dir } : {}),
    })
  }
  return buildResult(id, {
    answer: String(runResult.answer ?? ''),
    ...(runResult.duration_ms !== undefined ? { duration_ms: runResult.duration_ms } : {}),
    ...(runResult.session_dir ? { session_dir: runResult.session_dir } : {}),
    ...(runResult.converter ? { converter: runResult.converter } : {}),
  })
}
