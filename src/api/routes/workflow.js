import { jsonResponse } from '../utils.js'
import {
  listWorkflowRuns,
  getWorkflowRun,
  workflowRunStats,
} from '../../runtime/workflow-runs.js'

// 工作流运行面板的数据接口（阶段 3.4）。
//   GET /workflow/runs       —— 本次进程内的运行清单（最新在前）
//   GET /workflow/runs/:id   —— 单次运行的详情（阶段 / 每项 / 日志 / 错误）
//
// **只读端点**：这里不触发运行、不取消运行、不改运行。工作流的启动入口只有工具层
// 的 workflow 工具（模型调用），面板是纯粹的观察窗——多一个「从 UI 起工作流」的入口
// 就多一条「谁来批准这次扇出」的规则，而那是另一个设计问题，不在这一步里。
//
// 为什么展示字段在服务端算：面板跑在浏览器里，**import 不到 src/runtime/**（主进程代码）。
// 「阶段耗时、每项状态、计数、日志截断」只能是这里映射下发的；口径只有一份，
// 就是 workflow-runs.js 的 summarizeWorkflowRun()——面板不重写任何规则。
//
// **诚实声明**：数据源是内存登记表，进程重启即清空。响应用 process_scoped=true 把这件事
// 显式告诉调用方（面板据此在界面上写明「只显示本次进程内的运行，重启后清空」），
// 绝不让用户以为这是持久历史。落库的只有 brain_ui_events 里的 workflow_start/end
// 两条事件（给思考流回放用），它们不含每项状态，不在这里冒充运行清单。

// 面板一次最多看多少次运行。登记表本身只留最近 50 次，这里再夹一道，
// 挡住 ?limit=100000 这类请求。
const LIST_LIMIT_DEFAULT = 50
const LIST_LIMIT_MAX = 50

export async function handleWorkflowRoutes(req, res, url) {
  const path = url.pathname
  if (path !== '/workflow/runs' && !path.startsWith('/workflow/runs/')) return false
  if (req.method !== 'GET') return false

  if (path === '/workflow/runs') {
    const requested = Number.parseInt(url.searchParams?.get?.('limit') ?? '', 10)
    const limit = Number.isFinite(requested) && requested > 0
      ? Math.min(requested, LIST_LIMIT_MAX)
      : LIST_LIMIT_DEFAULT
    const all = listWorkflowRuns()
    const stats = workflowRunStats()
    const runs = all.slice(0, limit)
    jsonResponse(res, 200, {
      ok: true,
      count: runs.length,
      total: stats.total,
      running: stats.running,
      capacity: stats.capacity,
      limit,
      // 还有没下发的运行 → 面板要如实说「只显示最近 N 次」。
      truncated: runs.length < all.length,
      process_scoped: true,
      runs,
    })
    return true
  }

  const rawId = path.slice('/workflow/runs/'.length)
  const runId = rawId.includes('/') ? '' : decodeURIComponent(rawId)
  if (!runId) return false

  const run = getWorkflowRun(runId)
  if (!run) {
    jsonResponse(res, 404, {
      ok: false,
      code: 'WORKFLOW_RUN_NOT_FOUND',
      error: `no workflow run "${runId}" in this process — the registry only holds runs from the current process and is cleared on restart`,
    })
    return true
  }
  jsonResponse(res, 200, { ok: true, process_scoped: true, run })
  return true
}
