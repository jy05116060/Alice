// 会话级运行时标志的持久化（阶段 3.3 起用；键值表，别的会话态也能复用）。
//
// 为什么需要一个通用 kv 表而不是塞进 config：config 是**用户配置**（供应商、档位、
// 阈值），它是「这个人希望爱丽丝怎么运行」；这里存的是**会话状态**（现在处于计划模式
// 吗、什么时候进来的）。两者混在一起会出现「点错一个按钮把配置文件写脏」和
// 「导出配置时带走了此刻的临时状态」这类问题。
import { getDB } from '../db/connection.js'

let ensured = false

export function ensureRuntimeFlagsTable() {
  if (ensured) return
  const db = getDB()
  db.exec(`
    CREATE TABLE IF NOT EXISTS runtime_flags (
      key        TEXT PRIMARY KEY,
      value      TEXT NOT NULL DEFAULT '',
      updated_at TEXT NOT NULL
    );
  `)
  ensured = true
}

export function setRuntimeFlag(key, value) {
  ensureRuntimeFlagsTable()
  getDB().prepare(`
    INSERT INTO runtime_flags (key, value, updated_at) VALUES (?, ?, ?)
    ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at
  `).run(String(key), typeof value === 'string' ? value : JSON.stringify(value), new Date().toISOString())
}

export function getRuntimeFlag(key, fallback = null) {
  ensureRuntimeFlagsTable()
  const row = getDB().prepare('SELECT value FROM runtime_flags WHERE key = ?').get(String(key))
  return row ? row.value : fallback
}

export function deleteRuntimeFlag(key) {
  ensureRuntimeFlagsTable()
  getDB().prepare('DELETE FROM runtime_flags WHERE key = ?').run(String(key))
}

export function listRuntimeFlags() {
  ensureRuntimeFlagsTable()
  return getDB().prepare('SELECT key, value, updated_at FROM runtime_flags ORDER BY key').all()
}

export function _resetRuntimeFlagsForTest() {
  ensured = false
}
