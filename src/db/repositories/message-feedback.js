import { getDB } from '../connection.js'

// 消息反馈（赞 / 踩）。对齐 DeepSeek Harness Desktop 的回复操作行：
// 反馈是真实落库的，不是浏览器本地状态。
//
// message_key 由前端给出，形如 `${conversationId}:${timestamp}`，一台机器一条。
// rating 传空字符串表示撤销反馈。

const ALLOWED = new Set(['like', 'dislike'])

export function setMessageFeedback({ messageKey, rating, conversationId = null, threadId = null, comment = '' } = {}) {
  const key = String(messageKey || '').trim()
  if (!key) throw new Error('messageKey is required')

  const value = String(rating || '').trim()
  const db = getDB()

  if (!value) {
    db.prepare(`DELETE FROM message_feedback WHERE message_key = ?`).run(key)
    return { messageKey: key, rating: '' }
  }
  if (!ALLOWED.has(value)) throw new Error(`unsupported rating: ${value}`)

  db.prepare(`
    INSERT INTO message_feedback (message_key, rating, conversation_id, thread_id, comment)
    VALUES (?, ?, ?, ?, ?)
    ON CONFLICT(message_key) DO UPDATE SET
      rating          = excluded.rating,
      conversation_id = excluded.conversation_id,
      thread_id       = excluded.thread_id,
      comment         = excluded.comment,
      updated_at      = datetime('now')
  `).run(
    key,
    value,
    Number.isFinite(conversationId) ? conversationId : null,
    threadId == null ? null : String(threadId),
    String(comment || '').slice(0, 1000),
  )
  return { messageKey: key, rating: value }
}

export function getMessageFeedback(messageKey) {
  const key = String(messageKey || '').trim()
  if (!key) return null
  try {
    return getDB().prepare(
      `SELECT message_key, rating, conversation_id, thread_id, comment, updated_at
       FROM message_feedback WHERE message_key = ?`
    ).get(key) || null
  } catch (err) {
    console.warn('[message_feedback] read failed:', err.message)
    return null
  }
}

export function getMessageFeedbackBatch(keys = []) {
  const list = (Array.isArray(keys) ? keys : []).map(k => String(k || '').trim()).filter(Boolean)
  if (list.length === 0) return {}
  try {
    const placeholders = list.map(() => '?').join(',')
    const rows = getDB().prepare(
      `SELECT message_key, rating FROM message_feedback WHERE message_key IN (${placeholders})`
    ).all(...list)
    return Object.fromEntries(rows.map(r => [r.message_key, r.rating]))
  } catch (err) {
    console.warn('[message_feedback] batch read failed:', err.message)
    return {}
  }
}

export function getMessageFeedbackStats() {
  try {
    return getDB().prepare(
      `SELECT rating, COUNT(*) AS count FROM message_feedback GROUP BY rating`
    ).all()
  } catch (err) {
    console.warn('[message_feedback] stats failed:', err.message)
    return []
  }
}
