import { jsonResponse } from '../utils.js'
import { isRegisteredDeliverable, listDeliverableViews } from '../../runtime/deliverables-store.js'
import { openPathNatively, revealPathNatively } from '../../runtime/native-open.js'

// 交付物 REST 面（阶段 6.2）。
//   GET  /deliverables        —— 最近登记过的交付物（页面刷新后卡片还能画出来）
//   POST /deliverables/open   —— 用系统默认程序打开
//   POST /deliverables/reveal —— 在文件管理器里定位
//
// 安全要害：这两个 POST **只认登记过的路径**。否则它们就是「通过局域网让爱丽丝打开
// 机器上任意文件」的原语——而且打开一个文件可能触发默认程序去执行/渲染它，后果不可控。
// 登记（present 工具）本身就是用户可见的授权动作：卡片出现在界面上，用户点它。
export async function handleDeliverableRoutes(req, res, url) {
  if (req.method === 'GET' && url.pathname === '/deliverables') {
    const limit = Number(url.searchParams.get('limit')) || 20
    jsonResponse(res, 200, { ok: true, deliverables: listDeliverableViews({ limit }) })
    return true
  }

  if (req.method === 'POST' && (url.pathname === '/deliverables/open' || url.pathname === '/deliverables/reveal')) {
    const body = await readJsonBody(req)
    const target = String(body?.path ?? '').trim()
    if (!target) {
      jsonResponse(res, 400, { ok: false, code: 'PATH_REQUIRED', error: 'needs { path }' })
      return true
    }
    if (!isRegisteredDeliverable(target)) {
      // 明确区分「没登记」与「登记了但打不开」：前者是安全问题（或调用方在猜路径），
      // 后者是环境问题。混成一句话会让排查方向完全错。
      jsonResponse(res, 403, {
        ok: false,
        code: 'NOT_A_DELIVERABLE',
        error: 'that path was never presented as a deliverable, so it cannot be opened from here',
      })
      return true
    }
    const action = url.pathname.endsWith('/reveal') ? revealPathNatively : openPathNatively
    const result = await action(target)
    jsonResponse(res, result.ok ? 200 : 500, result)
    return true
  }

  return false
}

function readJsonBody(req) {
  return new Promise((resolve) => {
    let raw = ''
    req.on('data', (chunk) => {
      raw += chunk
      if (raw.length > 64 * 1024) { try { req.destroy() } catch {}; resolve(null) }
    })
    req.on('end', () => {
      if (!raw) return resolve(null)
      try { resolve(JSON.parse(raw)) } catch { resolve(null) }
    })
    req.on('error', () => resolve(null))
  })
}
