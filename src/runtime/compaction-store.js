// 会话压缩（阶段 3.2）的持久化层。
//
// 最重要的约束：**原始对话（conversations 表）一行都不动**。
// 压缩只产出「派生给模型的视图」所需的一条摘要 + 一个边界 id：
//   视图 = [摘要消息] + conversations 中 id > covers_through_id 的那些行
// 所以历史永远可重放、可回看；压缩是可撤销的（删掉这行即回到原始视图），
// 也不会因为压缩失败而丢对话。
//
// 每次压缩写一行（而不是就地更新），因此天然保留压缩链：covers_through_id
// 单调不减，历史上任何一次压缩后的视图都能由「那一行 + 原文」重建。
import { getDB } from '../db/connection.js'

let ensured = false

export function ensureCompactionTable() {
  if (ensured) return
  const db = getDB()
  db.exec(`
    CREATE TABLE IF NOT EXISTS compactions (
      compaction_id     INTEGER PRIMARY KEY AUTOINCREMENT,
      covers_from_id    INTEGER,
      covers_through_id INTEGER NOT NULL,
      summary           TEXT    NOT NULL DEFAULT '',
      message_count     INTEGER NOT NULL DEFAULT 0,
      chars_before      INTEGER NOT NULL DEFAULT 0,
      summary_chars     INTEGER NOT NULL DEFAULT 0,
      input_tokens      INTEGER NOT NULL DEFAULT 0,
      trigger           TEXT    NOT NULL DEFAULT 'auto',
      created_at        TEXT    NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_compactions_through ON compactions(covers_through_id);
  `)
  ensured = true
}

function hydrate(row) {
  if (!row) return null
  return {
    compactionId: row.compaction_id,
    coversFromId: row.covers_from_id,
    coversThroughId: row.covers_through_id,
    summary: row.summary || '',
    messageCount: row.message_count,
    charsBefore: row.chars_before,
    summaryChars: row.summary_chars,
    inputTokens: row.input_tokens,
    trigger: row.trigger,
    createdAt: row.created_at,
  }
}

export function insertCompaction({
  coversFromId = null,
  coversThroughId,
  summary = '',
  messageCount = 0,
  charsBefore = 0,
  inputTokens = 0,
  trigger = 'auto',
  createdAt = null,
} = {}) {
  if (!Number.isSafeInteger(coversThroughId)) {
    throw new Error('insertCompaction requires an integer coversThroughId')
  }
  ensureCompactionTable()
  const db = getDB()
  const text = String(summary || '')
  const info = db.prepare(`
    INSERT INTO compactions
      (covers_from_id, covers_through_id, summary, message_count, chars_before, summary_chars, input_tokens, trigger, created_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    Number.isSafeInteger(coversFromId) ? coversFromId : null,
    coversThroughId,
    text,
    messageCount,
    charsBefore,
    text.length,
    inputTokens,
    trigger,
    createdAt || new Date().toISOString(),
  )
  return hydrate(db.prepare('SELECT * FROM compactions WHERE compaction_id = ?').get(info.lastInsertRowid))
}

// 生效的那一行 = covers_through_id 最大的那一行（不是 created_at 最大：
// 边界才是视图的定义；同一毫秒写两行时按 id 定序才不会歧义）。
export function loadActiveCompaction() {
  ensureCompactionTable()
  const db = getDB()
  return hydrate(db.prepare(
    'SELECT * FROM compactions ORDER BY covers_through_id DESC, compaction_id DESC LIMIT 1',
  ).get())
}

export function loadCompactionById(compactionId) {
  ensureCompactionTable()
  const db = getDB()
  return hydrate(db.prepare('SELECT * FROM compactions WHERE compaction_id = ?').get(compactionId))
}

export function listCompactions({ limit = 20 } = {}) {
  ensureCompactionTable()
  const db = getDB()
  return db.prepare('SELECT * FROM compactions ORDER BY compaction_id DESC LIMIT ?')
    .all(limit)
    .map(hydrate)
}

/**
 * 整条压缩链（由旧到新）。
 *
 * 为什么展示面板要整条链而不是最近 N 条：每次压缩的「本次新增段」= 上一次边界之后到
 * 这一次边界之间。只取最近 N 条的话，最老的那一条没有上一条可比，它算出来的「新增段」
 * 就是错的（要么把整段历史算成它压的，要么因为累计条数对不上而误报原文缺失）。
 * 因此链本身要全取；只在下发时按 limit 切片。
 */
export function listAllCompactions() {
  ensureCompactionTable()
  return getDB().prepare('SELECT * FROM compactions ORDER BY compaction_id ASC').all().map(hydrate)
}

export function clearCompactions() {
  ensureCompactionTable()
  getDB().prepare('DELETE FROM compactions').run()
}

/**
 * 读被压缩覆盖过的**原文行**，只取算 token / 时间跨度需要的列。
 *
 * 为什么面板需要它：`compactions` 表只存了「压掉多少字符」（chars_before 累计值）与
 * 摘要正文，没有存原文——原文本来就在 conversations 里，存第二份迟早对不上。
 * 所以「压掉了多少 token」只能现查着算，口径与 runtime 用的估算是同一份
 * （compaction-view.estimateMessagesTokens），这样面板上的数字和模型当时的视图才是一回事。
 *
 * 只读，不改 conversations 一行（这是本模块的头号约束）。
 */
export function listConversationRowsInRange({ fromId = 0, throughId = 0 } = {}) {
  const from = Number.isSafeInteger(fromId) ? fromId : 0
  const through = Number.isSafeInteger(throughId) ? throughId : 0
  if (through <= 0) return []
  return getDB().prepare(`
    SELECT id, role, from_id, content, timestamp
    FROM conversations
    WHERE id >= ? AND id <= ?
    ORDER BY id ASC
  `).all(Math.max(0, from), through)
}

export function _resetCompactionStateForTest() {
  ensured = false
}
