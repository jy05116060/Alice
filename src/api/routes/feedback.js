import { jsonResponse, readJsonBody } from '../utils.js'
import {
  getMessageFeedback,
  getMessageFeedbackBatch,
  getMessageFeedbackStats,
  setMessageFeedback,
} from '../../db/repositories/message-feedback.js'

// 消息反馈（赞 / 踩）的 REST 面。对齐 DeepSeek Harness Desktop 的回复操作行：
// 反馈落库，不是浏览器本地状态，换台机器也还在。
//   POST /feedback/message    —— 写 / 改 / 撤销一条反馈（rating 传空串即撤销）
//   GET  /feedback/message    —— 读一条（?key=）或一批（?keys=a,b,c）
//   GET  /feedback/stats      —— 汇总

function normalizeKey(value) {
  return String(value ?? '').trim()
}

export async function handleFeedbackRoutes(req, res, url) {
  const pathname = url.pathname

  if (pathname === '/feedback/message' && req.method === 'GET') {
    const keys = url.searchParams.get('keys')
    if (keys) {
      const list = keys.split(',').map(normalizeKey).filter(Boolean).slice(0, 500)
      jsonResponse(res, 200, { ok: true, ratings: getMessageFeedbackBatch(list) })
      return true
    }
    const key = normalizeKey(url.searchParams.get('key'))
    if (!key) {
      jsonResponse(res, 400, { ok: false, error: 'key or keys is required' })
      return true
    }
    jsonResponse(res, 200, { ok: true, feedback: getMessageFeedback(key) })
    return true
  }

  if (pathname === '/feedback/message' && req.method === 'POST') {
    let body
    try {
      body = await readJsonBody(req, { maxBytes: 64 * 1024 })
    } catch (err) {
      jsonResponse(res, 400, { ok: false, error: err?.message || 'invalid body' })
      return true
    }
    try {
      const saved = setMessageFeedback({
        messageKey: body.message_key ?? body.messageKey,
        rating: body.rating,
        conversationId: body.conversation_id ?? body.conversationId ?? null,
        threadId: body.thread_id ?? body.threadId ?? null,
        comment: body.comment ?? '',
      })
      jsonResponse(res, 200, { ok: true, ...saved })
    } catch (err) {
      jsonResponse(res, 400, { ok: false, error: err?.message || 'failed to save feedback' })
    }
    return true
  }

  if (pathname === '/feedback/stats' && req.method === 'GET') {
    jsonResponse(res, 200, { ok: true, stats: getMessageFeedbackStats() })
    return true
  }

  return false
}
