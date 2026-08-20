import { insertBrainUiEvent } from './db.js'

// 内部事件总线：SSE 客户端管理 + 事件广播
const sseClients = new Set()
const SSE_REPLAY_LIMIT = 600
const SSE_REPLAY_TTL_MS = 5 * 60 * 1000
const recentEvents = []
let nextEventId = 1

const BRAIN_UI_HISTORY_TYPES = new Set([
  'message_received',
  'tick',
  'scheduled_task',
  'scheduled_task_completed',
  'scheduled_task_retry',
  'scheduled_task_failed',
  'stream_start',
  'stream_end',
  'tool_preparing',
  'tool_executing',
  'tool_call',
  'response',
  'llm_usage',
  'processing_preempted',
  'llm_retry',
  'message_requeued',
  'message_dropped',
  'error',
  'protocol_violation',
  // 子代理（阶段 1）：只持久化起止，不落高频的 subagent_activity——
  // 目的是刷新后还能看到「派过活、结果如何」，而不是重放每一步。
  'subagent_start',
  'subagent_end',
  // 工作流（阶段 2）：同样只落起止。
  'workflow_start',
  'workflow_end',
  // 目标（阶段 3.1）：只落状态变化与轮次，不落每一轮的正文。
  'goal_created',
  'goal_updated',
  'goal_round',
  // 会话压缩（阶段 3.2）：只落起止与统计，摘要正文走 GET /compaction 按需取
  // （它可能很长，塞进历史事件会让 Brain UI 的历史回放变重）。
  'compaction_start',
  'compaction_end',
  // 计划模式（阶段 3.3）：进出、计划呈交、评审被打回。
  // plan_submitted 要落全文——它是用户要评审的东西，只存统计没法回放。
  'plan_mode_changed',
  'plan_submitted',
  'plan_review_rejected',
  // 交付物卡片（阶段 6.2）：要落历史——页面刷新后卡片得能重新画出来，
  // 而它承载的是「模型交付了什么」，属于该留下来的记录。
  'deliverables_presented',
  // GitHub webhook（阶段 6.4）：收到 / 被拒 / 未订阅。要落历史——
  // 「webhook 到底有没有到」是配置这类集成时第一个要回答的问题。
  'github_webhook_received',
  'github_webhook_rejected',
  'github_webhook_ignored',
  'github_webhook_failed',
])
let activeBrainUiPath = null

function persistBrainUiEvent(type, data, ts) {
  if (type === 'message_received') {
    if (activeBrainUiPath === 'l2' || activeBrainUiPath === 'l3') {
      try {
        insertBrainUiEvent({
          timestamp: ts,
          path: activeBrainUiPath,
          eventType: 'processing_preempted',
          payload: {
            reason: activeBrainUiPath === 'l3'
              ? '收到用户消息，定时任务让路'
              : '收到用户消息，心跳让路',
          },
        })
      } catch (err) {
        console.warn('[brain-ui-history] preemption persist failed:', err?.message || err)
      }
    }
    activeBrainUiPath = 'l1'
    try {
      insertBrainUiEvent({ timestamp: ts, path: 'l1', eventType: type, payload: data })
    } catch (err) {
      console.warn('[brain-ui-history] L1 start persist failed:', err?.message || err)
    }
    return
  }
  if (type === 'tick') activeBrainUiPath = 'l2'
  if (type === 'scheduled_task') activeBrainUiPath = 'l3'
  const eventPath = activeBrainUiPath
  const shouldPersist = (eventPath === 'l1' || eventPath === 'l2' || eventPath === 'l3') && BRAIN_UI_HISTORY_TYPES.has(type)

  if (shouldPersist) {
    try {
      insertBrainUiEvent({ timestamp: ts, path: eventPath, eventType: type, payload: data })
    } catch (err) {
      // 观测历史是 best-effort；写库失败绝不能阻断意识循环或 SSE。
      console.warn('[brain-ui-history] persist failed:', err?.message || err)
    }
  }

  if (type === 'response' || type === 'processing_preempted' || type === 'message_dropped' || type === 'protocol_violation') {
    activeBrainUiPath = null
  }
}

// 新客户端连上时需立即补发的"粘性"事件（如启动自检音效）
const stickyEvents = new Map()  // type → { data, ts }

export function setStickyEvent(type, data) {
  stickyEvents.set(type, { data, ts: new Date().toISOString() })
}

export function clearStickyEvent(type) {
  stickyEvents.delete(type)
}

// 发送所有待补发事件给指定 SSE 客户端（连接建立时调用）
export function flushStickyEvents(res) {
  for (const [type, { data, ts }] of stickyEvents) {
    try { res.write(`data: ${JSON.stringify({ type, data, ts })}\n\n`) } catch (_) {}
  }
}

function pruneRecentEvents(now = Date.now()) {
  while (
    recentEvents.length > SSE_REPLAY_LIMIT
    || (recentEvents[0] && now - recentEvents[0].createdAt > SSE_REPLAY_TTL_MS)
  ) {
    recentEvents.shift()
  }
}

function writeSSEEvent(res, event) {
  res.write(`id: ${event.id}\ndata: ${event.payload}\n\n`)
}

export function flushEventsSince(res, lastEventId = 0) {
  const normalized = Number(lastEventId) || 0
  if (normalized <= 0) return { replayed: 0, oldestEventId: recentEvents[0]?.id || 0 }
  pruneRecentEvents()
  let replayed = 0
  for (const event of recentEvents) {
    if (event.id <= normalized) continue
    try {
      writeSSEEvent(res, event)
      replayed++
    } catch {
      break
    }
  }
  return {
    replayed,
    oldestEventId: recentEvents[0]?.id || 0,
    latestEventId: recentEvents.at(-1)?.id || 0,
  }
}

export function getLatestEventId() {
  return recentEvents.at(-1)?.id || 0
}

export function addSSEClient(res) {
  sseClients.add(res)
}

export function removeSSEClient(res) {
  sseClients.delete(res)
}

// 当前连着的 brain-ui 数量。待处理交互靠它判断「有没有人在看」：
// 没有客户端时挂起一个工具调用只会让模型白等，所以那边要退回直接拒绝。
export function getSSEClientCount() {
  return sseClients.size
}

// 进程内事件观察者（阶段 6）。给 headless 这类**没有 SSE 客户端**的调用方用：
// 它需要拿到本轮最终回答，但没有浏览器可连。刻意不做成 SSE 那样的事件流——
// 只是一个同步回调集合，返回退订函数。
// 观察者抛错不影响主流程：观测失败绝不能毁掉被观测的那一轮。
const eventObservers = new Set()

export function addEventListener(handler) {
  if (typeof handler !== 'function') return () => {}
  eventObservers.add(handler)
  return () => { eventObservers.delete(handler) }
}

export function emitEvent(type, data) {
  const ts = new Date().toISOString()
  persistBrainUiEvent(type, data, ts)
  const id = nextEventId++
  const payload = JSON.stringify({ type, data, ts, event_id: id })
  recentEvents.push({ id, payload, createdAt: Date.now() })
  pruneRecentEvents()
  // 观察者跑在 SSE 早退之前：没有 UI 连着时它们**更**需要拿到事件。
  for (const handler of eventObservers) {
    try { handler(type, data, ts) } catch { /* 观测失败不影响主流程 */ }
  }
  if (sseClients.size === 0) return
  const event = { id, payload }
  for (const res of sseClients) {
    try {
      writeSSEEvent(res, event)
    } catch (_) {
      sseClients.delete(res)
    }
  }
}
