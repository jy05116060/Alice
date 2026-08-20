import { jsonResponse } from '../utils.js'
import { listSubagents, interruptSubagent, forgetSubagent, getSubagentLimits, SUBAGENT_DEFAULT_TOOLS } from '../../runtime/subagent-manager.js'

// 子代理的 REST 面（阶段 1）：Brain UI / 局域网客户端从这里看名册、喊停。
//   GET  /subagents                    —— 名册 + 上限 + 默认工具集
//   POST /subagents/:id/interrupt      —— 中止正在跑的那一轮（清空排队消息）
//   POST /subagents/:id/forget         —— 中止并删除落盘的对话历史
export async function handleSubagentRoutes(req, res, url) {
  const pathname = url.pathname

  if (req.method === 'GET' && pathname === '/subagents') {
    jsonResponse(res, 200, {
      ok: true,
      limits: getSubagentLimits(),
      default_tools: SUBAGENT_DEFAULT_TOOLS,
      subagents: listSubagents({ includeDone: url.searchParams.get('include_done') === 'true' }),
    })
    return true
  }

  const match = pathname.match(/^\/subagents\/([^/]+)\/(interrupt|forget)$/)
  if (req.method === 'POST' && match) {
    const childId = decodeURIComponent(match[1])
    const action = match[2]
    const result = action === 'forget' ? forgetSubagent({ childId }) : interruptSubagent({ childId })
    // 不存在的子代理是 404，而不是静默成功——调用方需要知道没打到东西。
    jsonResponse(res, result.ok ? 200 : 404, result)
    return true
  }

  return false
}
