import { getDB } from '../connection.js'
import { CANONICAL_USER_ID, normalizeConversationPartyId } from '../utils.js'

export function createReminder({ userId, dueAt, task, systemMessage, source = '', recurrenceType = null, recurrenceConfig = null }) {
  const db = getDB()
  const normalizedUserId = normalizeConversationPartyId(userId || CANONICAL_USER_ID)
  const configStr = recurrenceConfig ? JSON.stringify(recurrenceConfig) : null
  return db.prepare(`
    INSERT INTO reminders (user_id, due_at, task, system_message, status, source, recurrence_type, recurrence_config)
    VALUES (?, ?, ?, ?, 'pending', ?, ?, ?)
  `).run(normalizedUserId, dueAt, task, systemMessage, source, recurrenceType, configStr)
}

export function findMergeableOneOffReminder(userId, dueAtIsoMinute) {
  const db = getDB()
  const normalizedUserId = normalizeConversationPartyId(userId || CANONICAL_USER_ID)
  return db.prepare(`
    SELECT * FROM reminders
    WHERE status = 'pending'
      AND recurrence_type IS NULL
      AND user_id = ?
      AND substr(due_at, 1, 16) = ?
    ORDER BY id ASC
    LIMIT 1
  `).get(normalizedUserId, dueAtIsoMinute) || null
}

export function appendReminderTask(id, additionalTask, newSystemMessage) {
  const db = getDB()
  const row = db.prepare(`SELECT task FROM reminders WHERE id = ?`).get(id)
  if (!row) return { changes: 0 }
  const mergedTask = `${row.task}; ${additionalTask}`
  return db.prepare(`
    UPDATE reminders
    SET task = ?, system_message = ?
    WHERE id = ? AND status = 'pending'
  `).run(mergedTask, newSystemMessage, id)
}

export function getDueReminders(now = new Date().toISOString(), limit = 20) {
  const db = getDB()
  return db.prepare(`
    SELECT * FROM reminders
    WHERE status = 'pending' AND due_at <= ?
    ORDER BY due_at ASC, id ASC
    LIMIT ?
  `).all(now, limit)
}

export function markReminderFired(id, firedAt = new Date().toISOString()) {
  const db = getDB()
  return db.prepare(`
    UPDATE reminders
    SET status = 'fired', fired_at = ?
    WHERE id = ? AND status = 'pending'
  `).run(firedAt, id)
}

export function advanceReminderDueAt(id, nextDueAtIso) {
  const db = getDB()
  return db.prepare(`
    UPDATE reminders
    SET due_at = ?
    WHERE id = ? AND status = 'pending'
  `).run(nextDueAtIso, id)
}

export function cancelReminder(id, cancelledAt = new Date().toISOString()) {
  const db = getDB()
  return db.prepare(`
    UPDATE reminders
    SET status = 'cancelled', cancelled_at = ?
    WHERE id = ? AND status = 'pending'
  `).run(cancelledAt, id)
}

/**
 * 就地修改一条待触发提醒（阶段 4）。
 * 只改传进来的字段——「把每天 9 点改成 10 点」不该顺手把 task 或目标用户清空。
 * id、created_at、以及它已经产生的 reminder_runs 全部保留：历史投递记录不能因为
 * 改个时间就断掉。
 */
export function updateReminder(id, patch = {}) {
  const db = getDB()
  const sets = []
  const values = []
  if (typeof patch.task === 'string') { sets.push('task = ?'); values.push(patch.task) }
  if (typeof patch.systemMessage === 'string') { sets.push('system_message = ?'); values.push(patch.systemMessage) }
  if (typeof patch.dueAt === 'string') { sets.push('due_at = ?'); values.push(patch.dueAt) }
  if (typeof patch.userId === 'string') { sets.push('user_id = ?'); values.push(normalizeConversationPartyId(patch.userId)) }
  if (patch.recurrenceType !== undefined) { sets.push('recurrence_type = ?'); values.push(patch.recurrenceType) }
  if (patch.recurrenceConfig !== undefined) {
    sets.push('recurrence_config = ?')
    values.push(patch.recurrenceConfig ? JSON.stringify(patch.recurrenceConfig) : null)
  }
  if (sets.length === 0) return { changes: 0 }
  values.push(id)
  return db.prepare(`
    UPDATE reminders SET ${sets.join(', ')}
    WHERE id = ? AND status = 'pending'
  `).run(...values)
}

/**
 * 启动补发用：到期时刻已经过去、但还没被物化成 run 的提醒。
 * `minLagMs` 把「刚刚到期、正常路径会处理」的那些排除掉，只捞出真正被停机错过的。
 */
export function getOverdueReminders(now = new Date().toISOString(), { minLagMs = 60000, limit = 50 } = {}) {
  const db = getDB()
  const threshold = new Date(Date.parse(now) - minLagMs).toISOString()
  return db.prepare(`
    SELECT * FROM reminders
    WHERE status = 'pending' AND due_at <= ?
    ORDER BY due_at ASC, id ASC
    LIMIT ?
  `).all(threshold, limit)
}

export function listPendingReminders(limit = 50) {
  const db = getDB()
  return db.prepare(`
    SELECT * FROM reminders
    WHERE status = 'pending'
    ORDER BY due_at ASC, id ASC
    LIMIT ?
  `).all(limit)
}

export function getReminderById(id) {
  const db = getDB()
  return db.prepare(`SELECT * FROM reminders WHERE id = ?`).get(id) || null
}

export function getNextPendingReminder() {
  const db = getDB()
  return db.prepare(`
    SELECT * FROM reminders
    WHERE status = 'pending'
    ORDER BY due_at ASC, id ASC
    LIMIT 1
  `).get() || null
}

/**
 * 把一次到期物化成一条可执行的 L3 run。
 *
 * 三个时刻是分开的，补发场景（阶段 4）需要它们不同：
 *   expectedDueAt   —— 库里**现在**应该是哪个到期时刻（并发守卫的比对基准）
 *   occurrenceDueAt —— 这条 run 代表的**是**哪一次触发（进 run 行、也进唯一键）
 *   nextDueAt       —— 物化之后把提醒推到哪个未来时刻（null = 一次性，标记 fired）
 * 平时三者相同（都用 reminder.due_at），所以老调用点不用改。
 */
export function materializeReminderRun({
  reminder,
  firedAt,
  nextDueAt = null,
  occurrenceDueAt: occurrenceOverride = null,
  expectedDueAt: expectedOverride = null,
} = {}) {
  const db = getDB()
  const expectedDueAt = String(expectedOverride || reminder?.due_at || '')
  const occurrenceDueAt = String(occurrenceOverride || expectedDueAt)
  if (!reminder?.id || !expectedDueAt || !occurrenceDueAt) return null

  const materialize = db.transaction(() => {
    const inserted = db.prepare(`
      INSERT OR IGNORE INTO reminder_runs
        (reminder_id, user_id, task, due_at, status, available_at)
      VALUES (?, ?, ?, ?, 'pending', ?)
    `).run(
      reminder.id,
      normalizeConversationPartyId(reminder.user_id || CANONICAL_USER_ID),
      String(reminder.task || ''),
      occurrenceDueAt,
      occurrenceDueAt,
    )

    if (!inserted.changes) {
      return db.prepare(`
        SELECT * FROM reminder_runs WHERE reminder_id = ? AND due_at = ?
      `).get(reminder.id, occurrenceDueAt) || null
    }

    const reminderUpdate = nextDueAt
      ? db.prepare(`
          UPDATE reminders
          SET due_at = ?
          WHERE id = ? AND status = 'pending' AND due_at = ?
        `).run(nextDueAt, reminder.id, expectedDueAt)
      : db.prepare(`
          UPDATE reminders
          SET status = 'fired', fired_at = ?
          WHERE id = ? AND status = 'pending' AND due_at = ?
        `).run(firedAt, reminder.id, expectedDueAt)

    if (!reminderUpdate.changes) {
      throw new Error(`Reminder #${reminder.id} changed while materializing its L3 run`)
    }

    return db.prepare(`SELECT * FROM reminder_runs WHERE id = ?`).get(inserted.lastInsertRowid) || null
  })

  return materialize()
}

export function recoverInterruptedReminderRuns(now = new Date().toISOString()) {
  return getDB().prepare(`
    UPDATE reminder_runs
    SET status = 'retry',
        available_at = ?,
        claimed_at = NULL,
        last_error = CASE
          WHEN last_error = '' THEN 'runtime restarted before completion'
          ELSE last_error
        END
    WHERE status = 'running'
  `).run(now)
}

export function claimRunnableReminderRuns(now = new Date().toISOString(), limit = 20) {
  const db = getDB()
  const safeLimit = Math.max(1, Math.min(100, Number(limit) || 20))
  const claim = db.transaction(() => {
    const rows = db.prepare(`
      SELECT *
      FROM reminder_runs
      WHERE status IN ('pending', 'retry') AND available_at <= ?
      ORDER BY available_at ASC, id ASC
      LIMIT ?
    `).all(now, safeLimit)

    const claimed = []
    const update = db.prepare(`
      UPDATE reminder_runs
      SET status = 'running',
          attempts = attempts + 1,
          claimed_at = ?,
          last_error = ''
      WHERE id = ? AND status IN ('pending', 'retry')
    `)
    const read = db.prepare(`SELECT * FROM reminder_runs WHERE id = ?`)
    for (const row of rows) {
      if (!update.run(now, row.id).changes) continue
      const current = read.get(row.id)
      if (current) claimed.push(current)
    }
    return claimed
  })
  return claim()
}

export function completeReminderRun(id, finishedAt = new Date().toISOString()) {
  return getDB().prepare(`
    UPDATE reminder_runs
    SET status = 'succeeded',
        finished_at = ?,
        claimed_at = NULL,
        last_error = ''
    WHERE id = ? AND status = 'running'
  `).run(finishedAt, id)
}

export function retryReminderRun(id, error, availableAt = new Date().toISOString()) {
  return getDB().prepare(`
    UPDATE reminder_runs
    SET status = 'retry',
        available_at = ?,
        claimed_at = NULL,
        last_error = ?
    WHERE id = ? AND status = 'running'
  `).run(availableAt, String(error || '').slice(0, 2000), id)
}

export function failReminderRun(id, error, finishedAt = new Date().toISOString()) {
  return getDB().prepare(`
    UPDATE reminder_runs
    SET status = 'failed',
        finished_at = ?,
        claimed_at = NULL,
        last_error = ?
    WHERE id = ? AND status = 'running'
  `).run(finishedAt, String(error || '').slice(0, 2000), id)
}

export function getReminderRunById(id) {
  return getDB().prepare(`SELECT * FROM reminder_runs WHERE id = ?`).get(id) || null
}

export function getNextPendingReminderRun() {
  return getDB().prepare(`
    SELECT * FROM reminder_runs
    WHERE status IN ('pending', 'retry')
    ORDER BY available_at ASC, id ASC
    LIMIT 1
  `).get() || null
}

// ── 投递历史（阶段 4）────────────────────────────────────────────────────
// reminder_runs 记的是「这一轮执行得怎么样」（重试/失败/成功），那是调度账本。
// delivery_history 记的是「用户到底收到了什么」——两者不是一回事：一轮执行可以
// 成功但投递被吞（L3 完成要求已验证的非 ack 投递），而用户来问「你昨天到底发没发」
// 时，要查的是投递回执，不是执行状态。
//
// 保留策略：默认 30 天 / 200 条。历史是给人查的，不是审计日志——无限增长只会让
// 表越来越大而没有人看。两个上限取「或」：既不过期太多条，也不留太久。
const DELIVERY_HISTORY_MAX_AGE_MS = 30 * 24 * 60 * 60 * 1000
const DELIVERY_HISTORY_MAX_ROWS = 200

export function recordDelivery({
  reminderId = null,
  runId = null,
  userId = null,
  channel = '',
  content = '',
  delivered = false,
  verified = false,
  error = '',
  at = new Date().toISOString(),
} = {}) {
  const db = getDB()
  const info = db.prepare(`
    INSERT INTO delivery_history
      (reminder_id, run_id, user_id, channel, content, delivered, verified, error, created_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    Number.isInteger(reminderId) ? reminderId : null,
    Number.isInteger(runId) ? runId : null,
    userId ? normalizeConversationPartyId(userId) : null,
    String(channel || ''),
    String(content || '').slice(0, 4000),
    delivered ? 1 : 0,
    verified ? 1 : 0,
    String(error || '').slice(0, 2000),
    at,
  )
  pruneDeliveryHistory(at)
  return info.lastInsertRowid
}

/** 保留策略：超龄或超量都删。删除按下标而不是时间，保证「最多 200 条」是硬上限。 */
export function pruneDeliveryHistory(now = new Date().toISOString()) {
  const db = getDB()
  const cutoff = new Date(Date.parse(now) - DELIVERY_HISTORY_MAX_AGE_MS).toISOString()
  const byAge = db.prepare('DELETE FROM delivery_history WHERE created_at < ?').run(cutoff)
  const byCount = db.prepare(`
    DELETE FROM delivery_history
    WHERE id NOT IN (SELECT id FROM delivery_history ORDER BY id DESC LIMIT ?)
  `).run(DELIVERY_HISTORY_MAX_ROWS)
  return { removed: byAge.changes + byCount.changes }
}

export function listDeliveryHistory({ limit = 50, reminderId = null, userId = null } = {}) {
  const db = getDB()
  const safeLimit = Math.max(1, Math.min(200, Number(limit) || 50))
  const where = []
  const values = []
  if (Number.isInteger(reminderId)) { where.push('reminder_id = ?'); values.push(reminderId) }
  if (userId) { where.push('user_id = ?'); values.push(normalizeConversationPartyId(userId)) }
  values.push(safeLimit)
  return db.prepare(`
    SELECT * FROM delivery_history
    ${where.length ? `WHERE ${where.join(' AND ')}` : ''}
    ORDER BY id DESC
    LIMIT ?
  `).all(...values)
}
