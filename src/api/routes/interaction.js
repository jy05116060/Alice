import { jsonResponse, readJsonBody } from '../utils.js'
import { getPendingInteraction, listPendingInteractions } from '../../interaction/pending.js'

// 待处理交互的 REST 面：前端接管输入区后，用户的选择从这里回到宿主。
//   GET  /interaction/pending            —— 列出当前挂起的申请/提问（刷新页面后靠它恢复）
//   POST /interaction/:id/answer         —— 提交答复
//   POST /interaction/:id/cancel         —— 放弃整组交互

function normalizeSelected(value) {
  if (!Array.isArray(value)) return []
  return value.map((item) => String(item ?? '').trim()).filter(Boolean)
}

function normalizeAnswer(body) {
  const rawAnswers = Array.isArray(body?.answers) ? body.answers : null
  if (rawAnswers) {
    return {
      outcome: null,
      answers: rawAnswers.map((entry) => {
        const custom = typeof entry?.custom === 'string' && entry.custom.trim() ? entry.custom.trim() : undefined
        return {
          id: String(entry?.id ?? '').trim(),
          selected: normalizeSelected(entry?.selected),
          ...(custom === undefined ? {} : { custom }),
        }
      }),
    }
  }
  return { outcome: String(body?.outcome ?? '').trim(), answers: null }
}

export async function handleInteractionRoutes(req, res, url) {
  const pathname = url.pathname

  if (req.method === 'GET' && pathname === '/interaction/pending') {
    jsonResponse(res, 200, { ok: true, pending: listPendingInteractions() })
    return true
  }

  const answerMatch = pathname.match(/^\/interaction\/([^/]+)\/answer$/)
  if (req.method === 'POST' && answerMatch) {
    const record = getPendingInteraction(decodeURIComponent(answerMatch[1]))
    if (!record) {
      jsonResponse(res, 404, { ok: false, error: 'no such pending interaction' })
      return true
    }

    let body
    try {
      body = await readJsonBody(req, { maxBytes: 256 * 1024 })
    } catch (err) {
      jsonResponse(res, 400, { ok: false, error: err?.message || 'invalid body' })
      return true
    }

    const answer = normalizeAnswer(body)
    if (record.kind === 'approval') {
      if (answer.outcome !== 'allowed-once' && answer.outcome !== 'rejected') {
        jsonResponse(res, 400, { ok: false, error: 'approval requires outcome "allowed-once" or "rejected"' })
        return true
      }
    } else if (!answer.answers || answer.answers.length === 0) {
      jsonResponse(res, 400, { ok: false, error: 'question requires a non-empty answers array' })
      return true
    }

    const accepted = record.answer(answer)
    jsonResponse(res, accepted ? 200 : 409, { ok: accepted, id: record.id })
    return true
  }

  const cancelMatch = pathname.match(/^\/interaction\/([^/]+)\/cancel$/)
  if (req.method === 'POST' && cancelMatch) {
    const record = getPendingInteraction(decodeURIComponent(cancelMatch[1]))
    if (!record) {
      jsonResponse(res, 404, { ok: false, error: 'no such pending interaction' })
      return true
    }
    const cancelled = record.cancel()
    jsonResponse(res, cancelled ? 200 : 409, { ok: cancelled, id: record.id })
    return true
  }

  return false
}
