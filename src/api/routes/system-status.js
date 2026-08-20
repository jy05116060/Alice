/**
 * routes/system-status.js
 * 「电脑动态」面板的后端接口。
 *
 *   GET /system-status            取一份系统状态快照（1.5s 节流缓存）
 *   GET /system-status?refresh=1  跳过节流，强制重新采样
 *
 * 返回形状见 src/system-status.js 的 getSystemStatus()。
 * 电池与进程榜是后台异步刷新的，首次调用可能为 null/pending，下一轮轮询即补齐。
 */

import { getSystemStatus, primeSystemStatus } from '../../system-status.js'
import { jsonResponse } from '../utils.js'

const FORCE_RE = /^(1|true|yes)$/i

export async function handleSystemStatusRoutes(req, res, url) {
  if (req.method !== 'GET') return false

  if (url.pathname === '/system-status') {
    try {
      const force = FORCE_RE.test(url.searchParams.get('refresh') || '')
      const status = await getSystemStatus({ force })
      jsonResponse(res, 200, { ok: true, ...status })
    } catch (err) {
      jsonResponse(res, 500, { ok: false, error: err?.message || String(err) })
    }
    return true
  }

  // 面板打开时先预热一次，让电池/进程榜尽早进缓存，避免首屏两格空着
  if (url.pathname === '/system-status/prime') {
    try {
      primeSystemStatus()
      jsonResponse(res, 200, { ok: true })
    } catch (err) {
      jsonResponse(res, 500, { ok: false, error: err?.message || String(err) })
    }
    return true
  }

  return false
}
