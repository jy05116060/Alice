import { emitEvent } from '../../events.js'
import { handleSocialWebhook, isSocialWebhookPath } from '../../social/webhooks.js'
import { getClawbotQR, logoutClawbot, sendClawbotMessage } from '../../social/wechat-clawbot.js'
import { getFeishuStatus } from '../../social/feishu-ws.js'
import { getClawbotNotifyTarget } from '../../config.js'
import { jsonResponse, readJsonBody } from '../utils.js'

function checkLocalOrToken(req, res, url, requireLocalOrToken) {
  if (typeof requireLocalOrToken === 'function') return requireLocalOrToken(req, res, url)
  jsonResponse(res, 403, { ok: false, error: 'forbidden' })
  return false
}

// 通知目标打码：只露前 4 位与域名部分，够自查又不至于把完整 userId 撒出去。
function maskNotifyTarget(userId) {
  const id = String(userId || '').trim()
  if (!id) return null
  const at = id.indexOf('@')
  const head = id.slice(0, 4)
  return at > 0 ? `${head}…${id.slice(at)}` : `${head}…`
}

export async function handleSocialRoutes(req, res, url, { hasAllowedAccess, requireLocalOrToken } = {}) {
  if (req.method === 'GET' && url.pathname === '/social/wechat-clawbot/qr') {
    if (!hasAllowedAccess?.(req, url)) {
      jsonResponse(res, 403, { ok: false, error: 'forbidden' })
      return true
    }
    jsonResponse(res, 200, { ok: true, ...getClawbotQR() })
    return true
  }

  // ── 主动微信通知 ────────────────────────────────────────────────────
  // GET  /notify/wechat          自查：连接状态 + 已存目标（打码）
  // POST /notify/wechat {text}   取已存目标 → ClawBot 主动发一条文本
  // 目标 userId 由入站消息自动记录（见 social/wechat-clawbot.js 的 handleClawbotInboundMessage）。
  if (req.method === 'GET' && url.pathname === '/notify/wechat') {
    if (!hasAllowedAccess?.(req, url)) {
      jsonResponse(res, 403, { ok: false, error: 'forbidden' })
      return true
    }
    const target = getClawbotNotifyTarget()
    jsonResponse(res, 200, {
      ok: true,
      connected: getClawbotQR().status,
      target: maskNotifyTarget(target),
      hasTarget: !!target,
    })
    return true
  }

  if (req.method === 'POST' && url.pathname === '/notify/wechat') {
    if (!checkLocalOrToken(req, res, url, requireLocalOrToken)) return true
    let body = {}
    try {
      body = await readJsonBody(req)
    } catch {
      jsonResponse(res, 400, { ok: false, error: 'invalid json body' })
      return true
    }
    const text = String(body?.text ?? '').trim()
    const mediaPath = String(body?.mediaPath ?? '').trim()
    if (!text && !mediaPath) {
      jsonResponse(res, 400, { ok: false, error: 'text or mediaPath is required' })
      return true
    }
    const target = getClawbotNotifyTarget()
    if (!target) {
      jsonResponse(res, 409, { ok: false, error: 'no notify target yet (wait for an inbound wechat message)' })
      return true
    }
    try {
      const payload = mediaPath ? { mediaPath, text: text || undefined } : { text }
      const result = await sendClawbotMessage(target, payload)
      if (!result?.ok) {
        jsonResponse(res, 502, { ok: false, error: result?.reason || result?.error || 'send failed', connected: getClawbotQR().status })
        return true
      }
      jsonResponse(res, 200, { ok: true, target: maskNotifyTarget(target), length: text.length, kind: result?.kind || 'text' })
    } catch (err) {
      jsonResponse(res, 502, { ok: false, error: err?.message || String(err) })
    }
    return true
  }

  if (req.method === 'GET' && url.pathname === '/social/feishu/status') {
    if (!hasAllowedAccess?.(req, url)) {
      jsonResponse(res, 403, { ok: false, error: 'forbidden' })
      return true
    }
    const configured = !!(process.env.FEISHU_APP_ID && process.env.FEISHU_APP_SECRET)
    jsonResponse(res, 200, { ok: true, status: getFeishuStatus(), configured })
    return true
  }

  if (req.method === 'POST' && url.pathname === '/social/wechat-clawbot/logout') {
    if (!checkLocalOrToken(req, res, url, requireLocalOrToken)) return true
    logoutClawbot()
    emitEvent('social_status', { platform: 'wechat-clawbot', status: 'idle' })
    jsonResponse(res, 200, { ok: true })
    return true
  }

  if (isSocialWebhookPath(url.pathname)) {
    await handleSocialWebhook(req, res, url)
    return true
  }

  return false
}
