import { emitEvent } from '../events.js'

// 待处理交互登记表：把「工具想跟用户要一个答复」变成一条可被 UI 接管、
// 也可被 REST 轮询/作答的挂起记录。
//
// 机制照搬 DeepSeek Harness Desktop 的 pending-interaction：
//   1. 宿主侧先拦下——工具调用挂起，不返回；
//   2. 前端收到一条 interaction_request，接管输入区渲染卡片；
//   3. 用户作答 → 走 REST 回来 → 这里 resolve → 工具继续跑；
//   4. 超时或放弃 → reject，工具拿到错误码，由模型自己决定下一步。
//
// 两种 kind：
//   approval —— 工具越权申请（对齐 dsh-client-ui-approval）
//   question —— 模型提问（对齐 dsh-tool-ask-user）

const pendingInteractions = new Map()
const DEFAULT_TIMEOUT_MS = 10 * 60 * 1000
let sequence = 0

export function listPendingInteractions() {
  return [...pendingInteractions.values()].map((record) => record.view)
}

export function getPendingInteraction(id) {
  const key = String(id || '').trim()
  if (!key) return null
  return pendingInteractions.get(key) || null
}

export function createPendingInteraction({
  kind,
  toolName = null,
  toolLabel = null,
  callId = null,
  reason = null,
  questions = [],
  detail = null,
  permissionLabel = null,
  suggestion = null,
  options = [],
  timeoutMs,
} = {}) {
  if (kind !== 'approval' && kind !== 'question') {
    throw new Error(`unsupported pending interaction kind: ${kind}`)
  }

  sequence += 1
  const id = `${kind}-${Date.now().toString(36)}-${sequence}`
  const view = {
    id,
    kind,
    toolName,
    toolLabel,
    callId,
    reason,
    questions,
    detail,
    permissionLabel,
    suggestion,
    options,
    createdAt: Date.now(),
  }

  let settle
  const result = new Promise((resolve, reject) => {
    settle = { resolve, reject }
  })
  const record = { id, kind, view, result, settled: false, timer: null }

  // 没人 await 时也不能变成 unhandled rejection：超时可能在调用方还没挂上
  // 处理器的瞬间触发，那会直接打崩进程。
  result.catch(() => {})

  const finish = (action) => {
    if (record.settled) return false
    record.settled = true
    pendingInteractions.delete(id)
    if (record.timer) {
      clearTimeout(record.timer)
      record.timer = null
    }
    emitEvent('interaction_settled', { id, kind })
    action()
    return true
  }

  record.answer = (answer) => finish(() => settle.resolve(answer))
  record.cancel = (message) => finish(() => settle.reject(
    Object.assign(new Error(message || '用户放弃了这次交互'), { code: 'INTERACTION_CANCELLED' }),
  ))

  const limit = Number.isFinite(timeoutMs) ? timeoutMs : DEFAULT_TIMEOUT_MS
  if (limit > 0) {
    record.timer = setTimeout(() => {
      finish(() => settle.reject(
        Object.assign(new Error('等待用户答复超时'), { code: 'INTERACTION_TIMEOUT' }),
      ))
    }, limit)
    if (typeof record.timer.unref === 'function') record.timer.unref()
  }

  pendingInteractions.set(id, record)
  emitEvent('interaction_request', view)
  return record
}
