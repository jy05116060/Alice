// 长期目标工具的推理期执行体（阶段 3.1）。
import {
  createGoal,
  updateGoal,
  getCurrentGoal,
  listGoals,
  GOAL_ACTION,
} from '../../runtime/goal-manager.js'
import { emitEvent } from '../../events.js'

function announce(type, goal, extra = {}) {
  try {
    emitEvent(type, {
      goal_id: goal?.goalId || null,
      objective: goal?.objective || '',
      status: goal?.status || null,
      revision: goal?.revision ?? null,
      rounds_started: goal?.roundsStarted ?? null,
      rounds_total: goal?.roundsTotal ?? null,
      max_rounds: goal?.maxRounds ?? null,
      armed: goal?.armed === true,
      progress_note: goal?.progressNote || '',
      blocked_reason: goal?.blockedReason || '',
      pause_reason: goal?.pauseReason || '',
      ...extra,
    })
  } catch { /* 观测失败不影响目标本身 */ }
}

function goalPayload(goal) {
  if (!goal) return null
  return {
    goal_id: goal.goalId,
    objective: goal.objective,
    status: goal.status,
    revision: goal.revision,
    rounds_started: goal.roundsStarted,
    rounds_total: goal.roundsTotal,
    max_rounds: goal.maxRounds,
    rounds_remaining: goal.roundsRemaining,
    armed: goal.armed,
    progress_note: goal.progressNote || '',
    blocked_reason: goal.blockedReason || '',
    pause_reason: goal.pauseReason || '',
    updated_at: goal.updatedAt,
  }
}

function isAutonomous(context = {}) {
  return context.autonomous === true
}

export async function execCreateGoal(args = {}, context = {}) {
  // 自主轮不得凭空立目标：目标是「用户交给我的长期事」，没有用户说话就没有来源。
  // tool-router 已经不在 Tick 轮暴露它，这里是第二道。
  if (isAutonomous(context)) {
    return JSON.stringify({
      ok: false,
      code: 'HUMAN_REQUEST_REQUIRED',
      error: 'creating a goal requires a direct user request; an autonomous turn cannot commit itself to a new long-running objective',
    })
  }
  const result = createGoal({
    objective: args.objective,
    maxRounds: Number.isSafeInteger(args.max_rounds) ? args.max_rounds : null,
    progressNote: args.progress_note,
  })
  if (!result.ok) {
    return JSON.stringify({
      ok: false,
      code: result.code,
      error: result.error,
      ...(result.goal ? { goal: goalPayload(result.goal) } : {}),
    })
  }
  announce('goal_created', result.goal)
  return JSON.stringify({
    ok: true,
    goal: goalPayload(result.goal),
    note: `Goal created. The runtime will keep spending automatic rounds on it (${result.goal.maxRounds} max) until you complete it, it is blocked, or the budget runs out. Each round starts from the objective and your progress_note — so keep the note current with update_goal action=note.`,
  })
}

export async function execUpdateGoal(args = {}, context = {}) {
  const result = updateGoal({
    goalId: args.goal_id || null,
    revision: Number.isSafeInteger(args.revision) ? args.revision : null,
    action: args.action,
    objective: args.objective ?? null,
    progressNote: args.progress_note ?? null,
    blockedReason: args.blocked_reason ?? null,
    pauseReason: args.pause_reason ?? null,
    autonomous: isAutonomous(context),
  })
  if (!result.ok) {
    return JSON.stringify({
      ok: false,
      code: result.code,
      error: result.error,
      ...(result.goal ? { goal: goalPayload(result.goal) } : {}),
    })
  }
  const action = result.action
  const goal = result.goal
  announce('goal_updated', goal, { action })
  const hints = {
    [GOAL_ACTION.NOTE]: 'Recorded. The next automatic round will start from this note.',
    [GOAL_ACTION.COMPLETE]: 'Goal closed. No further automatic rounds will be spent on it.',
    [GOAL_ACTION.BLOCKED]: 'Goal marked blocked with the reason recorded. It will not advance on its own.',
    [GOAL_ACTION.PAUSE]: 'Goal paused; automatic rounds stop until it is resumed.',
    [GOAL_ACTION.RESUME]: 'Goal rearmed with a fresh round budget. Automatic rounds resume.',
    [GOAL_ACTION.EDIT]: 'Objective updated. Automatic rounds now pursue the new objective.',
  }
  return JSON.stringify({
    ok: true,
    action,
    goal: goalPayload(goal),
    note: hints[action] || 'Goal updated.',
  })
}

export async function execGetGoal(args = {}) {
  const goal = getCurrentGoal()
  const payload = {
    ok: true,
    goal: goalPayload(goal),
    note: goal
      ? (goal.armed
        ? 'This goal is armed: automatic continuation rounds are running.'
        : 'This goal is not armed: no automatic rounds until the user asks to continue and you call update_goal action=resume (or the goal is no longer active).')
      : 'There is no goal. Use create_goal only when the user has given you a long-running objective.',
  }
  if (args.include_finished === true) payload.recent = listGoals({ limit: 10 }).map(goalPayload)
  return JSON.stringify(payload)
}
