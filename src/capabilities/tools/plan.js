// 计划模式工具的执行体（阶段 3.3）。
import {
  buildPlanReviewQuestions,
  enterPlanMode,
  exitPlanMode,
  getPlanModeState,
  markPlanSubmitted,
  planModeStateForUI,
  readPlanReviewVerdict,
} from '../../runtime/plan-mode.js'
import { execAskUserQuestion } from './interaction.js'
import { emitEvent } from '../../events.js'

function isAutonomous(context = {}) {
  return context.autonomous === true
}

export async function execEnterPlanMode(args = {}, context = {}) {
  // 自主轮不得自己切进计划模式：那会让正在干活的自己突然什么都不能做，
  // 而且「计划先行」是用户对节奏的要求，不是模型能替用户决定的。
  if (isAutonomous(context)) {
    return JSON.stringify({
      ok: false,
      code: 'HUMAN_REQUEST_REQUIRED',
      error: 'entering plan mode requires a direct user request; an autonomous turn cannot decide to stop making changes',
    })
  }
  const state = enterPlanMode({ source: 'model' })
  emitEvent('plan_mode_changed', { ...planModeStateForUI(), reason: args.reason || '' })
  return JSON.stringify({
    ok: true,
    plan_mode: planModeStateForUI(),
    note: 'Plan mode is on. The tools that change anything are now unavailable. Explore, ask what you must, then submit the finished plan with exit_plan_mode.',
    ...(args.reason ? { reason: args.reason } : {}),
  })
}

export async function execExitPlanMode(args = {}, context = {}) {
  if (!getPlanModeState().on) {
    // 不在计划模式时调用：不要「顺手就当成功」，那是静默的状态漂移。
    return JSON.stringify({
      ok: false,
      code: 'NOT_IN_PLAN_MODE',
      error: 'plan mode is not active, so there is no plan to submit',
    })
  }
  const plan = String(args.plan ?? '').trim()
  if (!plan) {
    return JSON.stringify({
      ok: false,
      code: 'PLAN_REQUIRED',
      error: 'exit_plan_mode needs the plan text — it is shown to the user as the review card',
    })
  }

  markPlanSubmitted()
  emitEvent('plan_submitted', { plan_chars: plan.length, plan })

  // 复用 ask_user_question 的挂起机制，而不是另造一张评审卡：
  // 同样的「发卡 → 挂起 → 答案以工具结果回来」契约，UI 那边零改动。
  const answerRaw = await execAskUserQuestion({
    questions: buildPlanReviewQuestions(plan),
  }, context)

  let answer = null
  try {
    answer = JSON.parse(answerRaw)
  } catch {
    answer = null
  }

  if (!answer?.ok) {
    // 没有 UI 客户端（或调用被中断）：**绝不能**因此自动退出计划模式。
    // 用户没看到计划就放开闸门 = 计划模式失效。把情况如实告诉模型，让它改用正文呈交。
    return JSON.stringify({
      ok: false,
      code: answer?.code || 'REVIEW_UNAVAILABLE',
      error: `${answer?.error || 'the plan review card could not be shown'}. Plan mode is still active and nothing was approved. Present the plan as a normal message and ask the user to start the work when they are ready.`,
      plan_mode: planModeStateForUI(),
    })
  }

  const { verdict, text } = readPlanReviewVerdict(answer.answers)
  if (verdict === 'approved') {
    const state = exitPlanMode()
    emitEvent('plan_mode_changed', { ...planModeStateForUI(), verdict: 'approved' })
    return JSON.stringify({
      ok: true,
      verdict: 'approved',
      plan_mode: planModeStateForUI(),
      note: 'Approved. Plan mode is off — execute the plan now, in order.',
    })
  }

  // 打回：留在计划模式，让反馈直接回到模型手里继续改。
  emitEvent('plan_review_rejected', { feedback: text })
  return JSON.stringify({
    ok: true,
    verdict: 'rejected',
    feedback: text,
    plan_mode: planModeStateForUI(),
    note: 'The user did not approve. Plan mode is still active; revise the plan using their feedback and submit it again with exit_plan_mode.',
  })
}
