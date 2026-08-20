import { jsonResponse, readJsonBody } from '../utils.js'
import { goalSnapshot, listGoals } from '../../runtime/goal-manager.js'
import { execUpdateGoal } from '../../capabilities/tools/goals.js'

// 目标的 REST 面（阶段 3.1）。UI 需要在页面刷新后重新拿到目标状态——
// SSE 只推变化，刷新那一刻的历史得从这里取。
//   GET  /goal                —— 当前目标 + 是否上膛
//   GET  /goal?include_done=1 —— 附带最近收尾的目标
//   POST /goal                —— 写入口（本轮补，见下方说明）
export async function handleGoalRoutes(req, res, url) {
  if (url.pathname !== '/goal') return false

  // ── 写入口 ────────────────────────────────────────────────────────────
  // 阶段 3.1 当时只做了 GET 与 update_goal 工具，**HTTP 写入口漏了**——后果是
  // 界面上的「继续 / 暂停 / 标记完成」点下去必错（没有路由接）。这里补上。
  //
  // 关键一点：这个入口的调用者**是人**（他点了按钮）。goal-manager 用 `autonomous`
  // 判定「人类专属动作」（edit/pause/resume）是否被模型擅自调用，所以这里刻意
  // **不带 autonomous**——它不是绕过那条规矩，它就是那条规矩指定的人类通道。
  if (req.method === 'POST') {
    // 注意契约：utils.js 的 readJsonBody **直接返回解析后的对象**（不是 {body, error}），
    // 且 JSON 非法时**抛异常**。第一版按 schedules.js 里那个同名局部函数（返回 {body,error}）
    // 来解构，于是 body 恒为 undefined，下一行读 body.action 就抛 TypeError，
    // 穿出处理器被框架兜底成 500 —— 界面上就是那句
    // "Cannot read properties of undefined (reading 'action')"。
    let body = null
    try {
      body = await readJsonBody(req, { maxBytes: 32 * 1024 })
    } catch (err) {
      jsonResponse(res, 400, { ok: false, code: 'BAD_BODY', error: `could not read the request body: ${err?.message || err}` })
      return true
    }
    if (!body || typeof body !== 'object' || Array.isArray(body)) {
      jsonResponse(res, 400, { ok: false, code: 'BAD_BODY', error: 'request body must be a JSON object' })
      return true
    }
    if (!body.action) {
      jsonResponse(res, 400, { ok: false, code: 'MISSING_ACTION', error: 'a goal update needs an "action"' })
      return true
    }
    // 注意 execUpdateGoal 是**工具执行器**：它的契约是「返回给模型的 JSON 字符串」，
    // 失败时返回 {ok:false,...} 而**不抛异常**。所以必须解析它、按 ok 判定，
    // 不能 try/catch 了事——那样失败会变成 {ok:true, action:undefined} 的假成功。
    let parsed = null
    try {
      parsed = JSON.parse(await execUpdateGoal(body, { source: 'ui' }))
    } catch (err) {
      jsonResponse(res, 500, { ok: false, code: 'UPDATE_CRASHED', error: err?.message || String(err) })
      return true
    }

    if (!parsed || parsed.ok !== true) {
      // 乐观锁冲突不是「请求坏了」，是「别处已经改过了」——单独给 409，界面据此
      // 重读再试（返回 400 会让界面以为参数写错了）。
      const code = parsed?.code || 'UPDATE_FAILED'
      const status = code === 'REVISION_CONFLICT' ? 409 : (code === 'GOAL_NOT_FOUND' ? 404 : 400)
      jsonResponse(res, status, {
        ok: false,
        code,
        error: parsed?.error || 'the goal update was rejected',
        ...(parsed?.revision !== undefined ? { revision: parsed.revision } : {}),
      })
      return true
    }

    // 成功后就地重读快照，而不是把工具返回值转一遍：这样 GET 与 POST 返回的形状
    // 天然一致（同一个 shapeGoal），界面不必区分两条来源。
    const after = goalSnapshot()
    jsonResponse(res, 200, {
      ok: true,
      action: parsed.action,
      message: parsed.note,
      goal: after.goal ? shapeGoal(after.goal) : null,
      armed: after.armed,
    })
    return true
  }

  if (req.method !== 'GET') return false
  const snapshot = goalSnapshot()
  jsonResponse(res, 200, {
    ok: true,
    armed: snapshot.armed,
    goal: snapshot.goal ? shapeGoal(snapshot.goal) : null,
    // 接受 true/1/yes：这个参数拼错的后果是「静默不返回历史」，很难查，
    // 所以宁可放宽一点。
    ...(['true', '1', 'yes'].includes(String(url.searchParams.get('include_done') || '').toLowerCase())
      ? {
        recent: listGoals({ limit: 10 }).map(goal => ({
          goal_id: goal.goalId,
          objective: goal.objective,
          status: goal.status,
          revision: goal.revision,
          rounds_started: goal.roundsStarted,
          rounds_total: goal.roundsTotal,
          max_rounds: goal.maxRounds,
          updated_at: goal.updatedAt,
        })),
      }
      : {}),
  })
  return true
}

/**
 * 目标的对外形状。GET 与 POST 共用一份：两处各写一个映射，迟早有一个漏字段
 * （界面上就是「点了按钮之后某些信息消失了」这种很难查的现象）。
 */
function shapeGoal(goal) {
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
    progress_note: goal.progressNote,
    blocked_reason: goal.blockedReason,
    pause_reason: goal.pauseReason,
    created_at: goal.createdAt,
    updated_at: goal.updatedAt,
  }
}
