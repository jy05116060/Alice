// 长期目标的语义层（阶段 3.1，对齐 DSH goal）。
//
// 一句话概括三条纪律：
//   1. 一个目标在改之前，必须先把它的 revision 报回来——目标可能在模型不知情时
//      被改过，拿旧视图覆盖新状态是「静默丢工作」。
//   2. 自动续轮有预算（max_rounds），烧完就停。目标是「跨轮推进」，不是「无限自转」。
//   3. 「已上膛」只活在本进程里。进程重启后旧目标自动解除续行，必须有人再明确说
//      「继续」才重新上膛——否则重启一次它就自己接着跑，用户根本没同意。
import { config } from '../config.js'
import {
  GOAL_STATUS,
  GOAL_TERMINAL_STATUSES,
  ensureGoalTable,
  insertGoal,
  loadGoalRow,
  loadCurrentGoalRow,
  listGoalRows,
  updateGoalRow,
  clearGoalRows,
  hydrateGoalRow,
} from './goal-store.js'

// 一个目标要走到 blocked，至少要真的自己试过 3 轮。
// 「试了一轮就报卡住」通常不是卡住，是不想干。
export const MIN_BLOCKED_ROUNDS = 3

export const GOAL_ACTION = Object.freeze({
  EDIT: 'edit',
  NOTE: 'note',
  PAUSE: 'pause',
  RESUME: 'resume',
  COMPLETE: 'complete',
  BLOCKED: 'blocked',
})

// 「已上膛」的令牌：本进程唯一。存进 DB 的 epoch 与本进程不一致 = 上一世留下的，
// 自动视为未上膛（重启解除续行）。不需要任何启动时的清理调用，也就不会因为
// 初始化顺序而漏掉。
const PROCESS_EPOCH = `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`

// 改「目标是什么」或「还要不要继续」的动作，必须有人亲口说。
// complete / blocked / note 相反：它们正是自动续轮里模型该做的事，自主轮必须能做。
const HUMAN_ONLY_ACTIONS = new Set([GOAL_ACTION.EDIT, GOAL_ACTION.PAUSE, GOAL_ACTION.RESUME])

let currentGoalId = null
let loaded = false

function isTerminal(goal) {
  return !!goal && GOAL_TERMINAL_STATUSES.includes(goal.status)
}

function effectiveArmed(goal) {
  if (!goal) return false
  if (isTerminal(goal)) return false
  if (goal.status !== GOAL_STATUS.ACTIVE) return false
  return goal.armedEpoch === PROCESS_EPOCH
}

export function decorateGoal(goal) {
  if (!goal) return null
  return {
    ...goal,
    armed: effectiveArmed(goal),
    roundsRemaining: Number.isSafeInteger(goal.maxRounds) && goal.maxRounds > 0
      ? Math.max(0, goal.maxRounds - goal.roundsStarted)
      : null,
  }
}

// 读当前目标。缓存的是 id，实体每次从库里取——目标是低频对象，宁可多读一次
// SQLite 也不要让缓存和库分叉（自动续轮正是靠状态判断该不该跑）。
export function getCurrentGoal() {
  try {
    ensureGoalTable()
  } catch {
    return null
  }
  if (!loaded || currentGoalId === null) {
    const row = loadCurrentGoalRow()
    currentGoalId = row?.goal_id || null
    loaded = true
  } else if (!loadGoalRow(currentGoalId)) {
    // 缓存里的目标被删了（测试清理 / 外部改写）：回到「最近一条」。
    const fresh = loadCurrentGoalRow()
    currentGoalId = fresh?.goal_id || null
  }
  if (currentGoalId === null) return null
  return decorateGoal(hydrateGoalRow(loadGoalRow(currentGoalId)))
}

export function listGoals({ limit = 20 } = {}) {
  try {
    ensureGoalTable()
    return listGoalRows({ limit }).map(row => decorateGoal(hydrateGoalRow(row)))
  } catch {
    return []
  }
}

export function isGoalArmed() {
  const goal = getCurrentGoal()
  return !!goal && goal.armed === true
}

function defaultMaxRounds() {
  const configured = Number(config?.goal?.maxRounds)
  return Number.isSafeInteger(configured) && configured > 0 ? configured : 12
}

function newGoalId() {
  return `goal-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`
}

/**
 * 建目标。同一时刻只允许一个非终态目标——目标多了就没人推得动，
 * 而且「当前目标」会变成随机挑一个。
 */
export function createGoal({ objective, maxRounds = null, progressNote = '' } = {}) {
  const text = String(objective || '').trim()
  if (!text) {
    return { ok: false, code: 'INVALID_OBJECTIVE', error: 'a goal needs a concrete objective in one sentence' }
  }
  const existing = getCurrentGoal()
  if (existing && !isTerminal(existing)) {
    return {
      ok: false,
      code: 'GOAL_EXISTS',
      error: `there is already an open goal (${existing.goalId}, revision ${existing.revision}): ${existing.objective}. Close it first — update_goal action=complete, or action=blocked with the reason it cannot proceed. If the user changed the objective, action=edit is the right move.`,
      goal: existing,
    }
  }
  const resolvedMax = Number.isSafeInteger(maxRounds) && maxRounds > 0 ? maxRounds : defaultMaxRounds()
  const goalId = newGoalId()
  insertGoal({
    goalId,
    objective: text,
    status: GOAL_STATUS.ACTIVE,
    revision: 1,
    roundsStarted: 0,
    roundsTotal: 0,
    maxRounds: resolvedMax,
    progressNote: String(progressNote || '').trim(),
    armedEpoch: PROCESS_EPOCH,
  })
  currentGoalId = goalId
  loaded = true
  return { ok: true, goal: getCurrentGoal() }
}

/**
 * 改目标。所有改动都要带 revision（乐观锁）。
 * @param {object} params
 * @param {string} params.action  edit | note | pause | resume | complete | blocked
 * @param {boolean} [params.autonomous] 是否来自自主轮（Tick / 定时任务）
 */
export function updateGoal({
  goalId = null,
  revision = null,
  action,
  objective = null,
  progressNote = null,
  blockedReason = null,
  pauseReason = null,
  autonomous = false,
} = {}) {
  const act = String(action || '').trim().toLowerCase()
  if (!Object.values(GOAL_ACTION).includes(act)) {
    return {
      ok: false,
      code: 'INVALID_ACTION',
      error: `action must be one of ${Object.values(GOAL_ACTION).join(', ')}`,
    }
  }
  const goal = getCurrentGoal()
  if (!goal) {
    return { ok: false, code: 'NO_GOAL', error: 'there is no goal to update' }
  }
  if (goalId && goalId !== goal.goalId) {
    return {
      ok: false,
      code: 'GOAL_NOT_FOUND',
      error: `no goal ${goalId}. The open goal is ${goal.goalId}.`,
      goal,
    }
  }
  if (!Number.isSafeInteger(revision) || revision < 1) {
    return {
      ok: false,
      code: 'REVISION_REQUIRED',
      error: `update_goal requires the exact revision you read (current is ${goal.revision}). Call get_goal first.`,
      goal,
    }
  }
  if (revision !== goal.revision) {
    return {
      ok: false,
      code: 'REVISION_CONFLICT',
      error: `revision ${revision} is stale — the goal has moved on since you read it.`,
      goal,
    }
  }

  // 「需要人亲口说」的三种改动：自主轮不得自行决定。resume 尤其危险——
  // 那是「再次授权自动推进」，自己给自己续命就等于没有预算。
  if (autonomous && HUMAN_ONLY_ACTIONS.has(act)) {
    return {
      ok: false,
      code: 'HUMAN_REQUEST_REQUIRED',
      error: `action=${act} changes what the goal is or whether it continues, so it requires a direct user request. In an automatic round you may only advance the objective (note), complete it, or mark it blocked.`,
      goal,
    }
  }

  if (isTerminal(goal)) {
    return { ok: false, code: 'GOAL_COMPLETE', error: 'this goal is already complete', goal }
  }

  const patch = { revision: goal.revision + 1 }

  if (act === GOAL_ACTION.EDIT) {
    const text = String(objective || '').trim()
    if (!text) {
      return { ok: false, code: 'INVALID_OBJECTIVE', error: 'action=edit requires the new objective text', goal }
    }
    patch.objective = text
    if (progressNote !== null) patch.progress_note = String(progressNote).trim()
    patch.pause_reason = null
  } else if (act === GOAL_ACTION.NOTE) {
    const note = String(progressNote || '').trim()
    if (!note) {
      return { ok: false, code: 'NOTE_REQUIRED', error: 'action=note requires progress_note: where the objective now stands, in one or two lines', goal }
    }
    patch.progress_note = note.slice(0, 1200)
  } else if (act === GOAL_ACTION.PAUSE) {
    patch.status = GOAL_STATUS.PAUSED
    patch.armed_epoch = null
    patch.pause_reason = String(pauseReason || 'paused by request').trim()
  } else if (act === GOAL_ACTION.RESUME) {
    // 重新上膛 = 重新计预算。人既然再次授权继续，就该给一段新的轮数，
    // 而不是拿上次烧剩的零头把人卡住。
    // **注意这里刻意只重置 rounds_started，不动 rounds_total**：后者是跨所有授权的
    // 累计账，它只增不减。resume 让「本轮」归零是换预算，不该让「累计」跟着倒退——
    // 那正是用户看到的「2/12 → 点继续 → 0/12，看起来像进度错了」。
    patch.status = GOAL_STATUS.ACTIVE
    patch.armed_epoch = PROCESS_EPOCH
    patch.rounds_started = 0
    patch.pause_reason = null
    patch.blocked_reason = null
  } else if (act === GOAL_ACTION.COMPLETE) {
    patch.status = GOAL_STATUS.COMPLETE
    patch.armed_epoch = null
    patch.pause_reason = null
  } else if (act === GOAL_ACTION.BLOCKED) {
    const reason = String(blockedReason || '').trim()
    if (!reason) {
      return {
        ok: false,
        code: 'BLOCKED_REASON_REQUIRED',
        error: 'action=blocked requires blocked_reason: the concrete condition that persists and prevents progress',
        goal,
      }
    }
    if (goal.roundsStarted < MIN_BLOCKED_ROUNDS) {
      return {
        ok: false,
        code: 'BLOCKED_TOO_EARLY',
        error: `blocked is not available yet: this goal has used ${goal.roundsStarted} of the ${MIN_BLOCKED_ROUNDS} rounds that must be spent before a blocking condition counts as persistent. Keep working the objective, or pause it and ask the user for a decision only they can make.`,
        goal,
      }
    }
    patch.status = GOAL_STATUS.BLOCKED
    patch.armed_epoch = null
    patch.blocked_reason = reason
    patch.pause_reason = null
  }

  updateGoalRow(goal.goalId, patch)
  const next = getCurrentGoal()
  return { ok: true, action: act, goal: next }
}

/**
 * 消耗一轮自动续轮预算。返回是否真的消耗了。
 * 未上膛 / 已终态 / 预算烧完时都不消耗，也不报错——自动轮只是不该再排下一轮。
 */
export function consumeGoalRound() {
  const goal = getCurrentGoal()
  if (!goal || !goal.armed) return { consumed: false, goal }
  const spent = goal.roundsStarted + 1
  // 两个账本一起加：rounds_started 是本轮授权的预算（resume 会归零），
  // rounds_total 是跨所有授权的累计（只增不减）。两者必须同步 +1，否则界面上的
  // 「累计 X · 本轮 Y/Z」会互相打架。
  const spentTotal = (Number.isSafeInteger(goal.roundsTotal) ? goal.roundsTotal : goal.roundsStarted) + 1
  const patch = { rounds_started: spent, rounds_total: spentTotal }
  let exhausted = false
  if (Number.isSafeInteger(goal.maxRounds) && goal.maxRounds > 0 && spent >= goal.maxRounds) {
    // 预算烧完：目标本身仍然 active（它没失败），但不再自动排下一轮。
    // 解除上膛改了语义，所以要动 revision。
    exhausted = true
    patch.armed_epoch = null
    patch.pause_reason = `automatic continuation budget exhausted (${spent}/${goal.maxRounds} rounds)`
    patch.revision = goal.revision + 1
  }
  updateGoalRow(goal.goalId, patch)
  return { consumed: true, exhausted, goal: getCurrentGoal() }
}

/**
 * 自动续轮时塞进 Tick 的那段话。没上膛就返回空串（调用方据此决定不消耗轮数）。
 */
export function formatGoalRoundBlock() {
  const goal = getCurrentGoal()
  if (!goal || !goal.armed) return ''
  const nextRound = goal.roundsStarted + 1
  const budget = Number.isSafeInteger(goal.maxRounds) && goal.maxRounds > 0
    ? `${nextRound}/${goal.maxRounds}`
    : `${nextRound}/unbounded`
  const lines = [
    '',
    `[GOAL ROUND ${budget}] objective: ${goal.objective}`,
    `goal_id: ${goal.goalId} · revision: ${goal.revision} · rounds already spent: ${goal.roundsStarted}`,
  ]
  if (goal.progressNote) lines.push(`where you left off: ${goal.progressNote}`)
  lines.push(
    'This is an automatic continuation round for the objective above. Make real progress on it now — produce something (a file, a check, a verified answer), not a plan restating the plan.',
    'Then record where you got to so the next round does not re-derive it: update_goal action=note progress_note="..."',
    'And say your judgment with the tool, not only in prose:',
    '  • objective achieved → update_goal action=complete',
    '  • genuinely stuck on a condition that has already persisted for at least 3 rounds → update_goal action=blocked with blocked_reason',
    '  • needs a decision only the user can make → stop advancing and say the question plainly in your reply so the user sees it',
    'Do not ask the user for something you already know. Do not end a round with zero output and no judgment.',
    'Note that editing the objective, pausing, or resuming needs a direct user request, so you cannot do those from this round.',
  )
  return `\n${lines.join('\n')}`
}

// 供 API / UI 使用。
export function goalSnapshot() {
  const goal = getCurrentGoal()
  return {
    goal,
    armed: !!goal && goal.armed === true,
    // 累计自动轮次：跨所有授权只增不减（goal.roundsStarted 是**本次授权**内的）。
    // 单独在快照顶层再给一次，是因为它是横幅上最容易被读错的那个数。
    roundsTotal: goal ? goal.roundsTotal : null,
    processEpoch: PROCESS_EPOCH,
  }
}

export function resetGoalState() {
  currentGoalId = null
  loaded = false
}

// 仅供测试：把库和缓存都清干净。
export function _resetGoalsForTest() {
  clearGoalRows()
  resetGoalState()
}
