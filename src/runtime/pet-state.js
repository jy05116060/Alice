// 桌宠的**核心状态机**：把 agent 的会话增量事件折叠成一份「宠物现在该显示什么」的展示态。
//
// 为什么要有这个文件（而不是把逻辑塞进路由）：桌宠**不是静态装饰图**。它要实时回答
// 四个问题——agent 在干什么（搜索/编辑/测试/执行命令）、正在想什么、任务做到哪了、
// 是不是在等你回答。这些答案全部来自会话事件流，所以真正的价值在这一层折叠里，
// 窗口和 SSE 只是把它摆出来。也因此这层是**纯函数**：不碰 IO、不碰时钟（时钟可注入），
// 可以被单测逐条钉死。
//
// 设计纪律（与 workflow-runs.js / events.js 一致）：
// - 所有导出**无副作用**，成员可单独测；
// - `handler`（推送给 sink 的回调）抛错绝不冒泡——观测失败不能毁掉被观测的那一轮；
// - 本模块**不持有** sink 集合，sink 的引用计数在 pet-stream.js 里，避免两处状态。

/** 推理文本保留的尾部字符数：气泡只显示「最近在想什么」，不是完整思维链。 */
export const PET_REASONING_TAIL_WINDOW = 120
/** 推理文本推送节流间隔（ms）：状态实时累积，但最多每 500ms 推一次最新尾部。 */
export const PET_REASONING_PUSH_INTERVAL_MS = 500
/** 助手正文保留的尾部字符数。 */
export const PET_ASSISTANT_TEXT_WINDOW = 1000
/** 任务文案最大**码点**数。 */
export const PET_TASK_TEXT_MAX = 40
/** 省略号：截断时追加，让用户知道「后面还有」。 */
const ELLIPSIS = '\u2026'

/**
 * 需要折叠 + 去重的边界事件。**增量 chunk（`assistant/chunk`）刻意不在其中**：
 * 它按 token 到达，走节流通道，不能每个 token 都 fold 一遍全套字段。
 */
export const FOLDABLE_EVENTS = new Set([
  'turn/start',
  'step/start',
  'assistant/message',
  'tool/call',
  'tool/result',
  'user/message',
  'turn/end',
  'session/title',
  'approval/asked',
  'approval/decided',
])

/**
 * 为一次会话建立累计态。未提供 `peer` 时按空会话处理（调用方不必先判空）。
 */
export function createPetSessionState(id, peer) {
  const source = peer && typeof peer === 'object' ? peer : {}
  return {
    id,
    origin: source.origin,
    title: source.title,
    displayTitle: source.displayTitle,
    cwd: source.cwd,
    running: source.running ?? false,
    turnActive: false,
    stepActive: false,
    openTools: new Map(),
    reasoningTail: '',
    assistantText: '',
    firstSeqAt: 0,
  }
}

/** 工具名 → 活动分类。**顺序即优先级**：`read_file` 归 searching 而不是 editing。 */
export function toolActivityOf(name) {
  const value = String(name || '').toLowerCase()
  if (/search|grep|find|glob|web|read|fetch|open/.test(value)) return 'searching'
  if (/write|edit|patch|replace|create|move|delete/.test(value)) return 'editing'
  if (/test|check|lint|build|verify/.test(value)) return 'testing'
  if (/shell|bash|exec|command|terminal|powershell|pwsh/.test(value)) return 'commanding'
  return 'using-tool'
}

/**
 * 本轮是不是 goal **自动续跑轮**：只有 `kind === "goal"` 且 `round > 0` 才算。
 * `round === 0` 是用户手动 `/goal` 触发的那一轮，终局语义按普通回合处理。
 */
export function isGoalRoundEvent(data) {
  const source = data && typeof data === 'object' ? data.source : null
  return source != null
    && source.kind === 'goal'
    && typeof source.round === 'number'
    && source.round > 0
}

/**
 * `update_goal` 调用声明的收尾动作。`edit`/`pause`/`resume` **不算收尾**；
 * `args` 不是合法 JSON 时返回 undefined（宁可不判，也不要猜）。
 */
export function goalClosingOf(name, args) {
  if (name !== 'update_goal') return undefined
  try {
    const action = JSON.parse(args ?? '').action
    return action === 'complete' || action === 'blocked' ? action : undefined
  } catch {
    return undefined
  }
}

/**
 * 回合终局档位。**goal 续跑轮的中间轮只到 `result`**——目标还在推进，
 * 不该摆出「大功告成」的庆祝姿态；非 goal 轮才是 `success`。
 */
export function completedStatus(state) {
  if (!state.goalRound) return 'success'
  if (state.goalClosing === 'blocked') return 'error'
  return state.goalClosing === 'complete' ? 'success' : 'result'
}

/**
 * 从 todo 列表提取当前任务文案。
 *
 * 取**最后一个** in_progress：agent 常把新步骤标 in_progress 却忘标上一步 completed，
 * 取第一个会让文案永远停在最早那步。没有进行中项时回落第一个 pending。
 *
 * 按**码点**截断（`Array.from` 而非 `slice`）：`slice` 会劈开代理对，
 * 把 emoji 或生僻汉字切成半个字符，显示成乱码方块。
 */
export function currentTaskFromTodo(data) {
  const todos = Array.isArray(data?.todos) ? data.todos : []
  const current = todos.findLast(todo => todo?.status === 'in_progress')
    ?? todos.find(todo => todo?.status === 'pending')
  const content = Array.from(String(current?.content ?? '').trim())
  if (!content.length) return undefined
  return content.length > PET_TASK_TEXT_MAX
    ? `${content.slice(0, PET_TASK_TEXT_MAX).join('')}${ELLIPSIS}`
    : content.join('')
}

/** 工具名 → liveActivity 展示对象（统一携带 name + args）。 */
function toolActivity(name, args) {
  return name ? { kind: 'tool', name, args } : { kind: 'tool' }
}

/**
 * 从 tool 事件里取调用 id：`tool/call` 直接给 `data.callId`；`tool/result` 的
 * callId 藏在 `data.message` 的多个可能位置（source.callId / content[].toolCallId /
 * message.toolCallId | callId）。取不到就返回空串——调用方据此回落到「清空全部」。
 */
export function toolCallIdOf(event, fallback = '') {
  const data = event?.data
  const message = data?.message
  const content = Array.isArray(message?.content)
    ? message.content.find(item => item && item.toolCallId)
    : undefined
  const callId = message?.source?.callId
    ?? content?.toolCallId
    ?? message?.toolCallId
    ?? message?.callId
    ?? data?.callId
  return String(callId ?? fallback)
}

/**
 * 判断工具名是不是「等用户回答」的问答工具（approval/澄清/确认类），
 * 而不是普通脚本——避免把 code_review / allowlist_files 误判成等待态。
 *
 * 按**整 token** 匹配（`\b` 切不开 snake_case），而非子串。
 */
export function isUserQuestionTool(name) {
  const tokens = String(name || '').toLowerCase().split(/[^a-z0-9]+/u).filter(Boolean)
  if (!tokens.length) return false

  const asks = new Set([
    'ask', 'asking', 'request', 'requests', 'requesting',
    'require', 'requires', 'prompt', 'needs', 'need', 'seek', 'seeks', 'get', 'gets',
  ])
  const filler = new Set(['for', 'from', 'the', 'a', 'an'])
  const userWords = new Set(['user', 'human', 'me'])
  const nouns = new Set([
    'question', 'questions', 'input', 'answer', 'answers', 'decision', 'decisions',
    'confirmation', 'approval', 'permission', 'authorization', 'authorisation',
    'consent', 'clarify', 'clarification', 'help',
  ])

  // user_question / ask_human / request_user_input …：user/human/me 紧邻一个名词
  const hasUserNoun = tokens.some((token, index) =>
    userWords.has(token) && nouns.has(tokens[index + 1] ?? ''))

  // question_from_user / decision_from_human …
  const hasNounFromUser = tokens.some((token, index) =>
    nouns.has(token) && tokens[index + 1] === 'from' && userWords.has(tokens[index + 2] ?? ''))

  // ask(ing) [the] user (question) / request (for) confirmation …
  const hasAsk = tokens.some((token, index) => {
    if (!asks.has(token)) return false
    let cursor = index + 1
    while (cursor < tokens.length && (filler.has(tokens[cursor]) || userWords.has(tokens[cursor]))) {
      if (userWords.has(tokens[cursor])) {
        const next = tokens[cursor + 1]
        return !next || nouns.has(next)
      }
      cursor += 1
    }
    return cursor < tokens.length && nouns.has(tokens[cursor])
  })

  const strong = tokens.some(token => token === 'authorize' || token === 'authorise' || token === 'consent')
  const submitsPlanForApproval = tokens.some((token, index) =>
    token === 'exit' && tokens[index + 1] === 'plan' && tokens[index + 2] === 'mode')

  return hasUserNoun || hasNounFromUser || hasAsk || strong || submitsPlanForApproval
}

/**
 * 从累计态 fold 出给桌宠窗口的载荷。
 *
 * 状态优先级**不可调换**：错误 > 等待 > 运行。理由——「等用户回答」比「在跑」更需要
 * 立刻被看到；而一旦有错误，宠物必须显示错误，哪怕进程还标着 running。
 */
export function foldPetPayload(state) {
  const firstTool = state.openTools.values().next().value
  const liveActivity = state.running && firstTool !== undefined
    ? toolActivity(firstTool.name, firstTool.args)
    : state.running && state.reasoningTail.length > 0
      ? { kind: 'reasoning', text: state.reasoningTail }
      : undefined

  let status
  // ⚠️ **优先级顺序是契约，别调换**：error > waiting > running。
  // 「等用户回答」必须压过「进程还在跑」——否则桌宠会一直显示在跑，
  // 用户不知道其实是在等自己。已用变异测试验证：调换顺序会让 2 条断言变红。
  if (state.lastAgentError) status = 'error'
  else if (state.waitingKind) status = 'waiting'
  else if (state.running || state.turnActive) status = 'running'

  return {
    id: state.id,
    origin: state.origin,
    title: state.title ?? state.displayTitle,
    displayTitle: state.displayTitle,
    message: state.assistantText || undefined,
    status,
    activity: status,
    phase: state.waitingKind,
    running: state.running,
    lastAgentError: state.lastAgentError,
    workStatus: state.workStatus,
    task: state.task,
    toolActivity: state.toolActivity,
    liveActivity,
  }
}

/**
 * 两份载荷是否「对用户而言没有区别」——相同就不推送，省掉无谓的重绘。
 * 逐个字段 `Object.is`：`undefined` 与 `undefined` 相等，但 `undefined` 与 `null` 不等。
 */
export function payloadEqual(a, b) {
  return Object.is(a.status, b.status)
    && Object.is(a.activity, b.activity)
    && Object.is(a.phase, b.phase)
    && Object.is(a.running, b.running)
    && Object.is(a.message, b.message)
    && Object.is(a.lastAgentError, b.lastAgentError)
    && Object.is(a.origin, b.origin)
    && Object.is(a.title, b.title)
    && Object.is(a.displayTitle, b.displayTitle)
    && Object.is(a.workStatus, b.workStatus)
    && Object.is(a.task, b.task)
    && Object.is(a.toolActivity, b.toolActivity)
    && Object.is(a.liveActivity?.kind, b.liveActivity?.kind)
    && Object.is(a.liveActivity?.text, b.liveActivity?.text)
    && Object.is(a.liveActivity?.name, b.liveActivity?.name)
    && Object.is(a.liveActivity?.command, b.liveActivity?.command)
    && Object.is(a.liveActivity?.path, b.liveActivity?.path)
    && Object.is(a.liveActivity?.args, b.liveActivity?.args)
}

/**
 * 把累计态落定为「回合已收尾、空闲」：清掉回合内的一切瞬时态。
 * `turn/end` 的中断分支与 `agent/status → idle` 兜底共用同一份语义——
 * 否则两条收尾路径会漂移出「一条清干净、另一条残留 thinking」这种只在真实中断时复现的差异。
 */
export function settleIdle(state) {
  state.turnActive = false
  state.stepActive = false
  state.running = false
  state.openTools.clear()
  state.reasoningTail = ''
  state.assistantText = ''
  state.waitingKind = undefined
  state.waitingApprovalId = undefined
  state.waitingCallId = undefined
  state.workStatus = undefined
  state.lastAgentError = undefined
  state.goalRound = false
  state.goalClosing = undefined
}

/** 会话是否仍处于「回合内」——只有这种状态才允许被 idle 兜底改写。 */
export function inTurn(state) {
  return Boolean(state.running || state.turnActive || state.stepActive)
}

/**
 * 单次会话增量事件的 reducer。
 * @returns 变化后的载荷；**无变化返回 null**（调用方据此不转发）。
 */
export function reduceSessionEvent(state, event) {
  const t = event?.type
  const data = event?.data ?? {}

  switch (t) {
    case 'turn/start':
      state.turnActive = true
      state.running = true
      state.reasoningTail = ''
      state.assistantText = ''
      state.waitingKind = undefined
      state.waitingApprovalId = undefined
      state.waitingCallId = undefined
      state.lastAgentError = undefined
      state.workStatus = 'thinking'
      state.task = undefined
      break

    case 'step/start':
    case 'assistant/chunk': {
      state.stepActive = true
      state.running = true
      if (t === 'step/start' && !state.waitingKind && state.openTools.size === 0) {
        state.workStatus = 'thinking'
      }
      if (t === 'assistant/chunk') {
        const chunk = data.chunk
        if (chunk?.type === 'reasoning-delta' && typeof chunk.text === 'string' && chunk.text) {
          state.reasoningTail = (state.reasoningTail + chunk.text).slice(-PET_REASONING_TAIL_WINDOW)
          if (!state.waitingKind && state.openTools.size === 0) state.workStatus = 'thinking'
          return foldPetPayload(state)
        }
        if (chunk?.type === 'text-delta' && typeof chunk.text === 'string' && chunk.text) {
          state.assistantText = (state.assistantText + chunk.text).slice(-PET_ASSISTANT_TEXT_WINDOW)
        }
        // ⚠️ **这不是 bug，别顺手改**：text-delta 只累积、**不产生载荷**（返回 null）。
        // 这是 DSH 的原语义——正文靠 `assistant/message` / `turn/end` 这类 fold 事件
        // 才带出来。若改成「每段 text-delta 都推一帧」，会让气泡按 token 抖动，
        // 而 reasoning 通道那套 500ms 节流管不到它。
        return null
      }
      break
    }

    case 'assistant/message': {
      state.stepActive = true
      state.running = true
      const text = (data.message?.content)
        ?.filter(block => block?.type === 'text' && typeof block.text === 'string')
        .map(block => block.text)
        .join('')
      if (text) state.assistantText = text.slice(-PET_ASSISTANT_TEXT_WINDOW)
      if (!state.waitingKind && state.openTools.size === 0) state.workStatus = 'thinking'
      break
    }

    case 'tool/call': {
      const call = data
      const name = call.name
      const closing = goalClosingOf(name, call.arguments)
      if (closing) state.goalClosing = closing
      if (name) {
        state.openTools.set(call.callId ?? name, { name, args: call.arguments })
      }
      state.running = true
      if (name && isUserQuestionTool(name)) {
        // 在等用户回答：立刻切 waiting，别让宠物看起来还在埋头干活。
        state.waitingKind = 'user-question'
        state.waitingCallId = call.callId ?? name
        state.workStatus = 'waiting'
      } else {
        if (name) state.toolActivity = toolActivityOf(name)
        state.workStatus = 'working'
      }
      break
    }

    case 'tool/result': {
      const callId = toolCallIdOf(event)
      if (callId) {
        state.openTools.delete(callId)
        if (callId === state.waitingCallId) {
          state.waitingKind = undefined
          state.waitingCallId = undefined
        }
      } else {
        // 拿不到 id 就没法精确出栈，只能整体清空——宁可少显示一个工具，
        // 也不要永远挂着一个已经不存在的工具让宠物卡在「正在用工具」。
        state.openTools.clear()
      }
      if (state.openTools.size > 0) {
        state.workStatus = 'working'
        state.toolActivity = toolActivityOf(state.openTools.values().next().value?.name)
      } else {
        state.workStatus = state.waitingKind ? 'waiting' : 'result'
      }
      break
    }

    case 'approval/asked': {
      const id = String(data.id ?? '')
      state.waitingKind = 'approval'
      state.waitingApprovalId = id
      state.running = true
      state.workStatus = 'waiting'
      break
    }

    case 'approval/decided': {
      const id = String(data.id ?? '')
      // 只清**匹配**的那一次审批：可能有多个审批并存，误清会让宠物提前离开等待态。
      if (!state.waitingApprovalId || id !== state.waitingApprovalId) return null
      state.waitingApprovalId = undefined
      state.waitingKind = undefined
      state.workStatus = state.openTools.size > 0 ? 'working' : 'thinking'
      break
    }

    case 'user/message':
      if (isGoalRoundEvent(data)) state.goalRound = true
      state.running = true
      state.turnActive = true
      if (state.waitingCallId !== undefined) {
        state.waitingKind = undefined
        state.waitingCallId = undefined
        state.workStatus = state.openTools.size > 0 ? 'working' : 'thinking'
      }
      break

    case 'todo/write': {
      const task = currentTaskFromTodo(data)
      if (task === state.task) return null
      state.task = task
      return foldPetPayload(state)
    }

    case 'session/title': {
      const title = data.title
      if (typeof title === 'string' && title) {
        state.title = title
        state.displayTitle = title
      }
      break
    }

    case 'turn/end': {
      state.turnActive = false
      state.stepActive = false
      state.running = false
      state.openTools.clear()
      state.reasoningTail = ''
      state.assistantText = ''
      state.waitingApprovalId = undefined
      state.waitingCallId = undefined
      const reason = data.reason
      if (reason?.kind === 'blocked') {
        state.waitingKind = 'blocked'
        state.workStatus = 'waiting'
      } else {
        state.waitingKind = undefined
        if (reason?.kind === 'completed') {
          state.workStatus = completedStatus(state)
          state.lastAgentError = undefined
        } else if (reason?.kind === 'error' || reason?.kind === 'max-tokens' || reason?.kind === 'timeout') {
          state.workStatus = 'error'
          state.lastAgentError = reason.error?.message ?? reason.kind
        } else {
          settleIdle(state)
        }
      }
      state.goalRound = false
      state.goalClosing = undefined
      break
    }

    default:
      break
  }

  if (!FOLDABLE_EVENTS.has(t)) return null
  return foldPetPayload(state)
}

/**
 * 每会话的累计态 + 「上次推了什么」，负责**节流**与**去重**，只在展示态真的变化时回调。
 *
 * 节流只作用于推理增量：`assistant/chunk` 且 liveActivity 是 reasoning 时，
 * 距上次推送不足 `PET_REASONING_PUSH_INTERVAL_MS` 就丢弃这一帧——
 * 状态照常累积，只是不推。别的变化（工具、任务、状态）不受节流影响，必须实时。
 *
 * @param handle - 变化时回调 `(action, payload)`。
 * @param opts.now - 可注入时钟（ms），供单测确定性地推进时间。
 */
export function createPetSessionReducer(handle, opts) {
  const now = opts?.now ?? (() => Date.now())
  const states = new Map()
  const lastSent = new Map()
  const lastReasoningPushAt = new Map()

  const emit = (action, payload) => {
    try {
      handle(action, payload)
    } catch {
      // 推送失败不能毁掉被观测的那一轮（与 events.js 的 emitEvent 同一条纪律）。
    }
  }

  const applyEvent = (peer, event) => {
    let state = states.get(peer.id)
    if (state === undefined) {
      state = createPetSessionState(peer.id, peer)
      states.set(peer.id, state)
    }
    state.title = peer.title ?? state.title
    state.displayTitle = peer.displayTitle ?? state.displayTitle
    state.origin = peer.origin ?? state.origin
    state.cwd = peer.cwd ?? state.cwd

    const payload = reduceSessionEvent(state, event)
    if (payload === null) return

    if (event.type === 'assistant/chunk' && payload.liveActivity?.kind === 'reasoning') {
      const at = now()
      if (at - (lastReasoningPushAt.get(peer.id) ?? 0) < PET_REASONING_PUSH_INTERVAL_MS) return
      lastReasoningPushAt.set(peer.id, at)
    }

    const previous = lastSent.get(peer.id)
    if (previous && payloadEqual(previous, payload)) return
    lastSent.set(peer.id, payload)
    emit('update', payload)
  }

  return {
    create(peer) {
      const state = createPetSessionState(peer.id, peer)
      states.set(peer.id, state)
      const payload = foldPetPayload(state)
      lastSent.set(peer.id, payload)
      emit('create', payload)
    },
    apply: applyEvent,
    chunk(peer, chunk) {
      applyEvent(peer, { type: 'assistant/chunk', seq: 0, time: now(), data: { chunk } })
    },
    /** agent 空闲兜底：只有仍在回合内才收尾，避免误改已经空闲的会话。 */
    idle(id) {
      const state = states.get(id)
      if (state === undefined || !inTurn(state)) return
      settleIdle(state)
      const payload = foldPetPayload(state)
      const previous = lastSent.get(id)
      if (previous && payloadEqual(previous, payload)) return
      lastSent.set(id, payload)
      emit('update', payload)
    },
    remove(id) {
      states.delete(id)
      lastSent.delete(id)
      lastReasoningPushAt.delete(id)
      emit('remove', { id })
    },
    clear() {
      states.clear()
      lastSent.clear()
      lastReasoningPushAt.clear()
    },
    /** 仅供测试/诊断：窥视累计态，不改变任何行为。 */
    stateOf(id) {
      return states.get(id)
    },
  }
}
