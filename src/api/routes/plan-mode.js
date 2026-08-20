import { jsonResponse } from '../utils.js'
import { planModeStateForUI } from '../../runtime/plan-mode.js'
import { enterPlanMode, exitPlanMode } from '../../runtime/plan-mode.js'
import { emitEvent } from '../../events.js'

// 计划模式（阶段 3.3）的 REST 面。
//   GET  /plan-mode   —— 现在在不在计划模式、什么时候进来的
//   POST /plan-mode   —— { on: true|false } 切换（Brain UI 的开关走这里）
//
// 模型那侧走 enter_plan_mode / exit_plan_mode 两个工具；这里是给 UI 用的同一个开关。
// 两条路都改同一份 runtime_flags，不存在「UI 关了但工具以为还开着」的分叉。
export async function handlePlanModeRoutes(req, res, url) {
  if (url.pathname !== '/plan-mode') return false

  if (req.method === 'GET') {
    jsonResponse(res, 200, { ok: true, plan_mode: planModeStateForUI() })
    return true
  }

  if (req.method === 'POST') {
    const body = await readJsonBody(req)
    if (typeof body?.on !== 'boolean') {
      jsonResponse(res, 400, {
        ok: false,
        code: 'ON_REQUIRED',
        error: 'POST /plan-mode needs { on: true|false }',
      })
      return true
    }
    const before = planModeStateForUI().on
    const state = body.on ? enterPlanMode({ source: 'ui' }) : exitPlanMode()
    // 只有真的变化了才发事件：UI 重复提交同一个状态不该在思考流里刷出两行。
    if (before !== state.on) {
      emitEvent('plan_mode_changed', { ...planModeStateForUI(), source: 'ui' })
    }
    jsonResponse(res, 200, { ok: true, plan_mode: planModeStateForUI(), changed: before !== state.on })
    return true
  }

  return false
}

function readJsonBody(req) {
  return new Promise((resolve) => {
    let raw = ''
    req.on('data', (chunk) => {
      raw += chunk
      if (raw.length > 1024 * 1024) {
        try { req.destroy() } catch {}
        resolve(null)
      }
    })
    req.on('end', () => {
      if (!raw) return resolve(null)
      try { resolve(JSON.parse(raw)) } catch { resolve(null) }
    })
    req.on('error', () => resolve(null))
  })
}
