// 会话压缩的运行时策略（阶段 3.2）：什么时候压、压哪一份、谁来压。
//
// 分工：
//   compaction-view.js   —— 纯算式（估算、压力、边界、视图）
//   compaction-store.js  —— 落库
//   compaction.js        —— 调 LLM 跑一次压缩 + 上下文窗口解析
//   本模块                —— 触发器与在飞状态（index.js 只跟这一层打交道）
//
// 三条策略决定，都是「别让压缩本身惹麻烦」：
//  1. **背后跑，不占用户延迟**：自动压缩在当轮 LLM 调用**之后**才发起，不阻塞回复。
//     新边界从**下一轮**开始生效。代价是「压力已超」的那一轮仍然按旧视图发出去，
//     这是刻意的取舍：为了少压一轮而让用户多等一次摘要调用，不划算。
//  2. **一次只跑一次**：压缩要调一次 LLM，并发跑两次既浪费又会互相覆盖边界。
//     在飞期间的触发一律 no-op（返回 skipped='in-flight'）。
//  3. **同一次用量不重复触发**：压力信号来自上一轮的 usage，那份读数是**压缩前**量的。
//     不做记号的话，压缩完的下一轮会拿着同一份过期读数再压一次。所以记下
//     「这轮触发时用的 usage 时间戳」，下次必须拿到**更新的一份**读数才允许再触发。
//     这样既不靠定时器，也不会形成压缩循环。
import { getLastUsage } from '../llm.js'
import {
  evaluateCompactionPressure,
  estimateMessagesTokens,
} from './compaction-view.js'
import {
  loadActiveCompaction,
  listCompactions,
} from './compaction-store.js'
import { resolveContextWindowAsync, runCompaction } from './compaction.js'

let inFlight = null
let lastTriggeredUsageAt = 0

/** 同步读出生效的压缩行，供 buildLLMMessages 构造视图。失败一律当「没有压缩」。 */
export function loadCompactionForView() {
  try {
    return loadActiveCompaction()
  } catch {
    return null
  }
}

function resolveSignal(usage) {
  const usageAt = Number(usage?.at) || 0
  return {
    inputTokens: Number.isFinite(usage?.inputTokens) && usage.inputTokens > 0 ? usage.inputTokens : null,
    usageAt,
  }
}

/**
 * 判断当前压力状态，不产生副作用。给自动触发和 UI/接口查询共用。
 */
export async function assessCompactionPressure({ estimatedTokens = 0 } = {}) {
  const { config } = await import('../config.js')
  const contextWindow = await resolveContextWindowAsync(config)
  const usage = getLastUsage()
  const { inputTokens, usageAt } = resolveSignal(usage)
  const verdict = evaluateCompactionPressure({
    inputTokens,
    estimatedTokens,
    contextWindow,
    thresholdRatio: config?.compaction?.thresholdRatio ?? 0.7,
  })
  return { ...verdict, contextWindow, usageAt, enabled: config?.compaction?.enabled !== false }
}

/**
 * 当轮 LLM 调用之后调用。压力超阈值就在**背后**发起一次压缩。
 * 不 await（调用方不需要等它），失败只记事件不抛。
 */
export function maybeAutoCompact({ rows = [], currentMsg = null, actionLog = [] } = {}) {
  if (inFlight) return { skipped: 'in-flight' }
  const estimatedTokens = estimateMessagesTokens(rows)
  // 先做同步可判的部分，避免每次轮次都无谓地 await 配置/供应商探测。
  const promise = (async () => {
    const pressure = await assessCompactionPressure({ estimatedTokens })
    if (!pressure.enabled) return { skipped: 'disabled' }
    if (!pressure.needed) return { skipped: pressure.reason, pressure }
    // 同一份 usage 读数只能触发一次（见文件头第 3 条）。
    if (pressure.usageAt <= lastTriggeredUsageAt) {
      return { skipped: 'same-usage-reading', pressure }
    }
    lastTriggeredUsageAt = pressure.usageAt
    return runAndAnnounce({
      rows,
      currentMsg,
      actionLog,
      trigger: 'auto',
      inputTokens: pressure.inputTokens,
      pressure,
    })
  })().catch(error => ({ skipped: 'error', error: error?.message || String(error) }))

  inFlight = promise
  promise.finally(() => { if (inFlight === promise) inFlight = null })
  return promise
}

async function runAndAnnounce({ rows, currentMsg, actionLog, trigger, inputTokens, pressure = null }) {
  announce('compaction_start', { trigger, pressure })
  const result = await runCompaction({ rows, currentMsg, trigger, inputTokens, actionLog })
  announce('compaction_end', {
    trigger,
    ok: result?.ok === true,
    skipped: result?.skipped || null,
    error: result?.error || null,
    covered_now: result?.coveredNow ?? null,
    covered_total: result?.coveredTotal ?? null,
    released_chars: result?.releasedChars ?? null,
    released_tokens: result?.releasedTokens ?? null,
    covers_through_id: result?.compaction?.coversThroughId ?? null,
  })
  return result
}

function announce(type, data) {
  try {
    // 事件只是观测：拿不到 events 模块/库也不该影响压缩本身，所以这里保持同步尽力而为。
    import('../events.js')
      .then(({ emitEvent }) => emitEvent(type, data))
      .catch(() => {})
  } catch { /* 观测失败不影响压缩 */ }
}

/**
 * 手动压缩（REST / 面板触发）。等待结果，调用方要拿到「压了多少」。
 * 与自动触发共用在飞闸门：正在跑就返回 in-flight，而不是排队等第二次。
 */
export async function compactNow({ rows = [], currentMsg = null, actionLog = [] } = {}) {
  if (inFlight) {
    const running = await inFlight.catch(() => ({ skipped: 'error' }))
    return { ...running, skipped: running?.ok ? undefined : 'in-flight' }
  }
  const usage = getLastUsage()
  const { inputTokens } = resolveSignal(usage)
  const promise = runAndAnnounce({
    rows,
    currentMsg,
    actionLog,
    trigger: 'manual',
    inputTokens,
  }).catch(error => ({ skipped: 'error', error: error?.message || String(error) }))
  inFlight = promise
  try {
    return await promise
  } finally {
    if (inFlight === promise) inFlight = null
  }
}

export function compactionStatus() {
  return {
    inFlight: !!inFlight,
    active: loadActiveCompaction(),
    history: listCompactions({ limit: 10 }),
  }
}

export function _resetCompactionRuntimeForTest() {
  inFlight = null
  lastTriggeredUsageAt = 0
}
