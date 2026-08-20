// 计划模式（阶段 3.3，对齐 DSH plan mode）。
//
// 要解决的问题：模型最常见的失败不是「做不到」，而是「你要的是方案，它直接动手了」。
// 光在提示里写「先给方案」没用——那是建议，模型可以不听，而且改错了东西是没法撤销的。
// 计划模式把它变成**闸门**：在计划模式下，会改变世界的工具直接不可用（tool-router
// 不注入、tool-policy 硬拒、executor 执行前再拦一道），模型只能读、只能问、只能写计划。
//
// 三层强制力：
//   1. tool-router —— 不把变异类工具递给模型。省 token，也避免「看得见摸不着」的挫败。
//   2. tool-policy —— 硬拒并给出原因。这是真正的闸门（executor 每次执行前都会问它）。
//   3. 提示块 —— 告诉模型现在在计划模式、该做什么（探索→设计→提交计划）。
// 权威闸门是第 2 层：第 1 层只是体验优化，第 3 层只是说明。
//
// 与 goal 的进程纪元语义**刻意相反**：
//   goal 用 armed_epoch 让重启后**自动解除**续行——自主行动的代价高，重启后必须先获得授权。
//   计划模式则让重启后**保持**在计划模式——变异的代价高，重启后宁可不许动手，
//   等用户明确说「开始做」再放开。两者都是「让风险大的那一侧在重启后回到安全态」。
import { deleteRuntimeFlag, getRuntimeFlag, setRuntimeFlag } from './plan-mode-store.js'

const PLAN_MODE_KEY = 'plan_mode'

// 计划模式下**仍然允许**的工具。判断规则是「高风险 ≠ 禁止」，而是：
//   被禁 = 风险为 high/medium 且不在下面这张白名单里。
// 新工具默认 classifyTool() 返回 'medium'，也就是**默认在计划模式下被禁**——
// 这是刻意选的方向：漏禁一个变异工具（它就真改了东西），比多禁一个只读工具
// （模型换条路读，或直接告诉用户）代价大得多。
const PLAN_ALLOWED_TOOLS = new Set([
  // ── 说话：计划模式的核心动作就是「把计划讲给用户听」 ──
  'send_message',
  'express',
  'ask_user_question',
  // ── 研究：不能改世界，但必须能读世界，否则计划是凭空编的 ──
  'web_search',
  'web_read',
  'fetch_url',
  'browser_read',
  'browser_snapshot',
  'browser_find',
  'browser_take_screenshot',
  'browser_console_messages',
  'browser_set_display_mode',
  'browser_navigate',
  'browser_navigate_back',
  'browser_navigate_forward',
  'browser_reload',
  'browser_tabs',
  'browser_close',
  'browser_wait_for',
  'search_memory',
  'probe_memory',
  'recall_memory',
  'find_tool',
  // ── 界面：把方案画给用户看 ──
  'ui_set',
  'open_doc_panel',
  // ── 自己的账本：目标与任务的读写不改动外部世界 ──
  'create_goal',
  'update_goal',
  'get_goal',
  // ── 派活：子代理/工作流里的每一次工具调用同样要过本闸门，
  //    所以「在计划模式下派出去做调研」是安全的，而且正是计划需要的。 ──
  'run_subagent',
  'spawn_subagent',
  'subagent_message',
  'subagent_interrupt',
  'subagent_list',
  'workflow',
  // ── 计划模式自己的出口 ──
  'enter_plan_mode',
  'exit_plan_mode',
])

// 只读档已经硬禁的那些（写文件、跑命令、装东西、改安全档……）在计划模式下同样禁，
// 这里不重复列举：tool-policy 会把 isToolDisabledInReadonly 与上面这张白名单**一起**用。
// 只有「只读档没禁、但计划模式必须禁」的少数几个需要点名——
// 它们是「不改文件但改世界」的那类：
const PLAN_EXTRA_BLOCKED_TOOLS = new Set([
  'manage_reminder',
  'schedule_reminder',
  'manage_prefetch_task',
  'manage_information_subscription',
  'set_tick_interval',
  'system_browser_open',
  'system_music',
  'speak',
  'generate_lyrics',
  'generate_music',
  'generate_image',
  'run_capability',
  'run_api_capability',
  'manage_api_capability',
  'upsert_memory',
  'merge_memories',
  'browser_click',
  'browser_type',
  'browser_fill_form',
  'browser_select_option',
  'browser_press_key',
  'browser_drag',
  'browser_handle_dialog',
  'browser_clear_data',
  'music',
  'media_mode',
])

export const PLAN_MODE_STATE = Object.freeze({
  OFF: 'off',
  ON: 'on',
})

function parseState(raw) {
  if (!raw) return null
  try {
    const parsed = JSON.parse(raw)
    return parsed && typeof parsed === 'object' ? parsed : null
  } catch {
    return null
  }
}

export function getPlanModeState() {
  try {
    const state = parseState(getRuntimeFlag(PLAN_MODE_KEY))
    if (!state?.on) return { on: false, enteredAt: null, source: null, planSubmittedAt: null }
    return {
      on: true,
      enteredAt: state.entered_at || null,
      source: state.source || 'unknown',
      planSubmittedAt: state.plan_submitted_at || null,
    }
  } catch {
    // 读不出来时**不能**默认「在计划模式」——那会让爱丽丝在数据库损坏时彻底不能干活。
    // 默认关闭；真正需要计划模式的用户会立刻发现并要求重开，而不是莫名其妙什么都不能做。
    return { on: false, enteredAt: null, source: null, planSubmittedAt: null }
  }
}

export function isPlanMode() {
  return getPlanModeState().on === true
}

/** 进入计划模式。已进入时是幂等的（刷新时间戳，不重复记 entered_at）。 */
export function enterPlanMode({ source = 'user', at = null } = {}) {
  const now = at || new Date().toISOString()
  const current = getPlanModeState()
  const state = {
    on: true,
    entered_at: current.on ? current.enteredAt : now,
    source: current.on ? current.source : source,
    plan_submitted_at: current.planSubmittedAt,
  }
  setRuntimeFlag(PLAN_MODE_KEY, JSON.stringify(state))
  return getPlanModeState()
}

export function exitPlanMode({ at = null } = {}) {
  const now = at || new Date().toISOString()
  const current = getPlanModeState()
  if (!current.on) return { ...current, changed: false }
  // 刻意**不删**这一行而是写成 off：保留「这次计划模式什么时候进来的、怎么进来的」，
  // 事后排查「它为什么一直不动手」时这是唯一的线索。
  setRuntimeFlag(PLAN_MODE_KEY, JSON.stringify({
    on: false,
    entered_at: current.enteredAt,
    source: current.source,
    plan_submitted_at: current.planSubmittedAt,
    exited_at: now,
  }))
  return { ...getPlanModeState(), changed: true }
}

export function markPlanSubmitted({ at = null } = {}) {
  const current = getPlanModeState()
  if (!current.on) return current
  setRuntimeFlag(PLAN_MODE_KEY, JSON.stringify({
    on: true,
    entered_at: current.enteredAt,
    source: current.source,
    plan_submitted_at: at || new Date().toISOString(),
  }))
  return getPlanModeState()
}

export function resetPlanMode() {
  deleteRuntimeFlag(PLAN_MODE_KEY)
  return getPlanModeState()
}

/**
 * 计划模式下这个工具还能用吗？纯函数，不碰数据库。
 * @param {string} name
 * @param {{readonlyBlocked?: (name: string) => boolean, riskOf?: (name: string) => string}} deps
 *   —— 只读档的硬禁清单与风险分级由调用方注入，避免本模块反向依赖 capabilities 层。
 */
export function isToolBlockedInPlanMode(name, deps = {}) {
  const tool = String(name || '')
  if (!tool) return false
  if (PLAN_ALLOWED_TOOLS.has(tool)) return false
  if (PLAN_EXTRA_BLOCKED_TOOLS.has(tool)) return true
  // 只读档已经认定「会改变世界」的，计划模式一律继承。
  if (deps.readonlyBlocked?.(tool)) return true
  // 剩下的按风险分级：high/medium 默认禁，low 放行。
  const risk = deps.riskOf?.(tool) || 'medium'
  return risk === 'high' || risk === 'medium'
}

export function planModeStateForUI() {
  const state = getPlanModeState()
  return {
    on: state.on,
    entered_at: state.enteredAt,
    source: state.source,
    plan_submitted_at: state.planSubmittedAt,
  }
}

// ── 提示块 ────────────────────────────────────────────────────────────────
// 只在计划模式激活时进 system prompt。位置稳定、内容稳定，所以它不会每轮抖动
// 提示缓存（切换计划模式本身是低频动作，那一次失效可以接受）。
export const PLAN_MODE_BLOCK = `## Plan Mode Is Active

You are planning, not executing. Nothing you do now may change the world — the tools that could (writing files, running commands, installing, sending anything outward beyond your reply, mutating browser state, scheduling) are **not available in this turn**, and asking for them will be refused.

What you should do instead:
- Explore enough to make the plan real: read the files, search the web, look at the current state. A plan built without looking is a guess, and a guess is worse than no plan.
- Ask the user the questions you genuinely cannot answer yourself, using ask_user_question. Do not guess at a decision that is theirs to make.
- Then write the plan itself: what you will change, in what order, which files or systems are involved, what could go wrong, and how you will verify it worked. Be concrete enough that someone else could execute it — vague plans ("improve the error handling") do not count.
- When the plan is ready, submit it with exit_plan_mode. The user reviews it there. If they approve, plan mode ends and you execute; if they send it back with feedback, you stay in plan mode and revise.

Do not describe this mode or these rules to the user. They already know — they turned it on. Just plan.`

export function formatPlanModeBlock() {
  return isPlanMode() ? PLAN_MODE_BLOCK : ''
}

// ── 计划评审（复用 ask_user_question）──────────────────────────────────────
export const PLAN_REVIEW_QUESTION_ID = 'plan_review'

export function buildPlanReviewQuestions(planText) {
  const plan = String(planText || '').trim()
  return [{
    id: PLAN_REVIEW_QUESTION_ID,
    header: '计划评审',
    question: `是否按这份计划执行？\n\n${plan}`,
    options: [
      { label: '批准，开始执行 (Recommended)', description: '退出计划模式，按这份计划动手' },
      { label: '先别动，我有修改意见', description: '留在计划模式，你继续说哪里要改' },
    ],
  }]
}

/** 用户选了哪个？（复用 ask_user_question 的答案形状） */
export function readPlanReviewVerdict(answers = {}) {
  const raw = answers?.[PLAN_REVIEW_QUESTION_ID]
  const text = Array.isArray(raw) ? raw.join(' ') : String(raw ?? '')
  if (!text) return { verdict: 'unknown', text: '' }
  // 批准 / 打回都靠标签文本判断：选项标签是我们自己写的，模型与用户看到的是同一份。
  if (/批准|开始执行|approve|go ahead|proceed/i.test(text)) return { verdict: 'approved', text }
  return { verdict: 'rejected', text }
}

export function _resetPlanModeForTest() {
  resetPlanMode()
}
