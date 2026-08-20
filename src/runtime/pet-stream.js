// 桌宠的**订阅总线和 SSE 帧协议**。
//
// 性能契约（这个文件存在的主要理由）：**没人看就不干活**。
// 桌宠窗口关掉 / 用户禁用桌宠后，Rust 侧（这里是 Electron 侧）会断开 SSE；当**最后一个**
// sink 断开时，这里必须注销全部宿主订阅并清空累积状态——否则桌宠会永远在后台替一个
// 不存在的窗口折叠每个 token，而这正是「安装后 CPU 一直在跳」的经典成因。
//
// 反向契约同样明确：**第一个** sink 接入时才挂订阅（懒挂载），所以没装桌宠的用户
// 完全不受影响（一帧事件都不多折叠）。
//
// 与 events.js 的分工：events.js 是全局事件总线（广播给所有 brain-ui）；
// 这里是**单个消费者的转发器**，只服务桌宠，两边的 sink 集合相互独立、互不干扰。

import { emitEvent, addEventListener } from '../events.js'
import { createPetSessionReducer } from './pet-state.js'

/** SSE 重连间隔提示（毫秒）：只在**首帧**随数据一起发出。 */
export const SSE_RETRY_MS = 1000
/** 心跳注释帧间隔（毫秒）：防止代理/空闲断开。 */
export const SSE_KEEPALIVE_MS = 15000
/** 心跳注释文本，与数据帧区分开（以 `:` 开头，客户端不会当作数据解析）。 */
export const SSE_KEEPALIVE_COMMENT = 'keepalive'

/** 已接入的 SSE 消费者（断开即移除）。 */
const sinks = new Set()
/** 会话出生标记：首次出现的 id 推 `create`，此后只推增量 `update`。 */
const knownSessions = new Set()
/** 会话总线监听注销句柄；undefined = 当前无消费者、未挂载。 */
let disposeSessionBus

/** 仅供测试/诊断：当前挂着的消费者数量。 */
export function sinkCount() {
  return sinks.size
}

/** 仅供测试/诊断：宿主订阅是否处于挂载状态。 */
export function isSessionBusAttached() {
  return disposeSessionBus !== undefined
}

function setSessionBusDispose(dispose) {
  disposeSessionBus = dispose
}

/** 注销会话总线监听并丢弃会话标记（幂等）。 */
function closeSessionBus() {
  const dispose = disposeSessionBus
  disposeSessionBus = undefined
  dispose?.()
  knownSessions.clear()
}

/** 插件卸载收尾：结束在途连接、注销监听、丢弃标记。 */
export function clearHostRuntime() {
  const open = [...sinks]
  sinks.clear()
  closeSessionBus()
  reducer.clear()
  for (const sink of open) sink.close()
}

/** 会话总线 → 展示态帧的累计态机（per-session Map 由 reducer 闭包持有）。 */
const reducer = createPetSessionReducer(publish)

/** 把一帧增量广播给全部消费者（写失败由各自的关闭回调清理）。 */
function publish(action, payload) {
  const frame = JSON.stringify({ action, payload })
  for (const sink of sinks) sink.push(frame)
}

/**
 * 接入一个消费者。返回的注销函数在**最后一个**消费者离开时触发真正的收工。
 */
export function startPetStream(sink) {
  sinks.add(sink)
  attachSessionBus()
  return () => {
    sinks.delete(sink)
    // 还有人在看就不收工；归零才注销订阅 + 清空状态（性能契约）。
    if (sinks.size > 0) return
    closeSessionBus()
    reducer.clear()
  }
}

/**
 * 首个消费者接入：挂载宿主事件桥（幂等）。
 *
 * **诚实说明（重要架构差异）**：DSH 那套 `session/event` / `session/disposed` /
 * `agent/status` / `agent/assistant-stream` 四条宿主事件在爱丽丝里**并不存在**
 * （爱丽丝没有 DSH 的会话对象模型，全库 grep 无任何一处 emit 这四个名字）。
 * 所以这里不是「订阅同名事件」，而是**把爱丽丝已有的事件总线翻译成 reducer 的契约束入**。
 * 对应关系在 `HOST_EVENT_BRIDGE` 里有逐条注释；翻译层是这一个函数，别处不许再转一次。
 *
 * 契约等价性：DSH 的四条 → 爱丽丝的实际事件
 * - `session/event`(turn/start|step/start|tool/*|turn/end|approval/*) → `message_received`
 *   / `tool_preparing` / `tool_call` / `response` / `error`（见下）
 * - `agent/assistant-stream`(逐 token reasoning/text 增量) → `stream_start` / `stream_chunk` / `stream_end`
 * - `agent/status → idle` → 无直接等价物，用 `response`（回合终态）兜底
 * - `session/disposed` → 爱丽丝没有「会话对象被销毁」这一事实，**不对等实现**（见报告）
 *
 * **注意 `addEventListener` 的签名**：它是 `addEventListener(handler)`，回调拿
 * `(type, data, ts)`——**只有一个**「监听器」参数，不是 `(type, handler)` 那种按类型注册。
 * 所以这张表是「事件名 → 翻译函数」的**路由表**，由下面这**一个**监听器按类型分发。
 * （踩过的坑：写成 `addEventListener(type, handler)` 会把字符串当 handler 传进去，
 * 而 `addEventListener` 对非函数静默返回空注销句柄——订阅会全部丢失且不报错。）
 */
function attachSessionBus() {
  if (isSessionBusAttached()) return
  const dispose = addEventListener((type, data) => {
    const handler = HOST_EVENT_BRIDGE[type]
    if (!handler) return
    try {
      handler(data ?? {})
    } catch {
      // 翻译失败绝不能冒泡：events.js 的 emitEvent 会吞掉它，但这里显式兜住，
      // 让「桌宠翻译出错」不会影响主流程，也不会静默吞掉其它订阅者的异常。
    }
  })
  setSessionBusDispose(() => {
    try { dispose() } catch { /* 注销失败不能阻断收工 */ }
  })
}

/**
 * 爱丽丝事件 → 桌宠会话增量的**唯一**翻译层。
 *
 * 爱丽丝是「单会话 agent」（一个进程跑一条对话主线），没有 DSH 的多会话对象，
 * 因此这里用固定会话 id `PET_SESSION_ID` 把整条主线当成一个会话。
 * 这是**近似实现**，不是逐字复刻：DSH 的桌宠能同时显示多个会话的气泡，
 * 爱丽丝这版只显示当前主线——如实标注在报告里。
 */
export const PET_SESSION_ID = 'alice-main'

/** 桌宠看到的会话身份：爱丽丝没有 cwd/title 的会话级元数据，这里按主进程视角给。 */
function hostPeer(running) {
  return {
    id: PET_SESSION_ID,
    origin: 'alice',
    title: undefined,
    displayTitle: undefined,
    cwd: undefined,
    running,
  }
}

/** 首次出现时建 create 帧，之后只走增量。 */
function ensureSession(running) {
  if (knownSessions.has(PET_SESSION_ID)) return
  knownSessions.add(PET_SESSION_ID)
  reducer.create(hostPeer(running))
}

function applyToHost(type, data) {
  ensureSession(data?.running === true)
  reducer.apply(hostPeer(data?.running === true), {
    type,
    seq: 0,
    time: Date.now(),
    data: data ?? {},
  })
}

/**
 * 逐条翻译表。键是爱丽丝的既有事件名，值是翻译函数。
 *
 * 关键取舍（都在报告里如实标注）：
 * - 爱丽丝**没有** `reasoning-delta` 这种「思维链增量」通道。`stream_chunk` 在
 *   `mode === 'reasoning'` 时携带的 text 是**模型输出的推理段正文**，语义上最接近
 *   DSH 的 reasoning 增量，因此映射为 `assistant/chunk` 的 `reasoning-delta`；
 *   `mode === 'text'`（最终答复）映射为 `text-delta`。
 * - 爱丽丝**没有** `approval/asked` 的等价物（审批走 Scene/UI 信号，不走事件总线，
 *   且没有稳定 id），所以审批等待态**未接线**——见报告「未实现」档。
 * - `turn/start` 由 `message_received` 触发（爱丽丝每轮开头必发）。
 * - `turn/end` 由 `response`（正常收尾）或 `error`（失败）触发。
 *   `response` 的终局按 DSH 语义给 `reason: {kind:'completed'}`。
 */
const HOST_EVENT_BRIDGE = {
  // 爱丽丝每轮开头发 message_received → DSH 的 turn/start。
  // 同时按 user/message 语义置 turnActive（DSH 里这两条是分开的事件）。
  message_received: (data) => {
    ensureSession(true)
    applyToHost('turn/start', { running: true })
    if (data?.turn_id || data?.input) {
      reducer.apply(hostPeer(true), {
        type: 'user/message',
        seq: 0,
        time: Date.now(),
        data: { source: { kind: 'user' } },
      })
    }
  },

  // 工具即将执行（参数未知阶段）：入 Map 时**还没有 arguments**，用 name 占位。
  tool_preparing: (data) => {
    if (!data?.name) return
    applyToHost('tool/call', { callId: data.name, name: data.name, arguments: undefined })
  },

  // 工具完整执行结果：先落定参数（若此前只有 preparing 占位），再出栈。
  tool_call: (data) => {
    if (!data?.name) return
    const args = data.args === undefined ? undefined : JSON.stringify(data.args)
    applyToHost('tool/call', { callId: data.name, name: data.name, arguments: args })
    applyToHost('tool/result', { callId: data.name })
  },

  // 流开始：模式决定后续 chunk 归到哪条通道。
  stream_start: (data) => {
    ensureSession(true)
    hostStreamMode = data?.mode ?? null
  },

  // 逐 token 增量 → reasoning-delta / text-delta（见上方取舍说明）。
  stream_chunk: (data) => {
    if (typeof data?.text !== 'string' || !data.text) return
    ensureSession(true)
    const mode = data?.mode ?? hostStreamMode
    const chunkType = mode === 'text' ? 'text-delta' : 'reasoning-delta'
    reducer.chunk({ id: PET_SESSION_ID }, { type: chunkType, text: data.text })
  },

  stream_end: () => {
    hostStreamMode = null
  },

  // 回合正常收尾：DSH 的 turn/end + reason.kind='completed'。
  //
  // **顺序很关键**：正文必须在 `turn/end` **之前**喂进去。
  // `assistant/message` 会把 `running` 置回 true（那是 DSH 的语义：收到助手消息
  // 说明这轮还在进行）；若放在 turn/end 之后，已经收尾的回合会被重新点亮成
  // 「一直在跑」——这是本轮实现里抓到的一个真实缺陷。
  response: (data) => {
    hostStreamMode = null
    if (typeof data?.content === 'string' && data.content) {
      ensureSession(true)
      reducer.apply(hostPeer(true), {
        type: 'assistant/message',
        seq: 0,
        time: Date.now(),
        data: { message: { content: [{ type: 'text', text: data.content }] } },
      })
    }
    applyToHost('turn/end', { running: false, reason: { kind: 'completed' } })
    finishHostSession()
  },

  // 回合失败：DSH 的 turn/end + reason.kind='error' + error.message。
  error: (data) => {
    hostStreamMode = null
    applyToHost('turn/end', {
      running: false,
      reason: { kind: 'error', error: { message: data?.error ?? data?.label ?? 'error' } },
    })
    finishHostSession()
  },

  // 被更高优先级消息抢占：回合中断，走 DSH 的 settleIdle 分支（reason 无 kind）。
  processing_preempted: () => {
    hostStreamMode = null
    applyToHost('turn/end', { running: false, reason: {} })
    finishHostSession()
  },
}

/** 当前流通道模式（stream_start 设定，stream_end/收尾清空）。 */
let hostStreamMode = null

/** 回合收尾后：把它留在 idle 兜底之外——事件总线已给终态，不再重复推帧。 */
function finishHostSession() {
  hostStreamMode = null
}

/**
 * SSE 帧写出器：把 `{action, payload}` 编码成线上格式。
 * 帧格式 `data: {...}\n\n`；`retry: 1000` 只在**首个数据帧**发出
 * （Rust/Electron 侧把空 `data:` 行也当一帧 JSON 解析，所以不能只发 retry 字段）。
 */
export function createSseWriter(res) {
  let retrySent = false
  return function writeFrame(action, payload) {
    const data = JSON.stringify({ action, payload })
    if (retrySent) {
      res.write(`data: ${data}\n\n`)
      return
    }
    retrySent = true
    res.write(`retry: ${SSE_RETRY_MS}\ndata: ${data}\n\n`)
  }
}

/** 启动保活心跳；返回停止函数。 */
export function startKeepalive(res) {
  const timer = setInterval(() => {
    try {
      res.write(`: ${SSE_KEEPALIVE_COMMENT}\n\n`)
    } catch {
      clearInterval(timer)
    }
  }, SSE_KEEPALIVE_MS)
  if (typeof timer.unref === 'function') timer.unref()
  return () => clearInterval(timer)
}

/** 全局事件总线句柄，供路由在无消费者时判断「有没有人在看」。 */
export { emitEvent }
