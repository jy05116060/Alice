// 进程内子代理的持久化存储（阶段 1，对齐 DSH session persistence）。
// 可续期子代理的对话历史在这里落盘：进程重启 / 冷恢复后，下一条消息到达时
// 从这里重建 messages，再交给 runAgentLoop 继续。
import { getDB } from '../db/connection.js'

export const SUBAGENT_MODE = Object.freeze({
  ONESHOT: 'oneshot',
  CONTINUABLE: 'continuable',
})
export const SUBAGENT_STATUS = Object.freeze({
  RUNNING: 'running',
  IDLE: 'idle',
  DONE: 'done',
  ERROR: 'error',
})

let ensured = false
export function ensureSubagentTable() {
  if (ensured) return
  const db = getDB()
  db.exec(`
    CREATE TABLE IF NOT EXISTS subagent_sessions (
      child_id       TEXT PRIMARY KEY,
      mode           TEXT NOT NULL,
      status         TEXT NOT NULL DEFAULT 'idle',
      provider       TEXT,
      model          TEXT,
      description    TEXT NOT NULL DEFAULT '',
      messages       TEXT NOT NULL,
      parent_session TEXT,
      depth          INTEGER NOT NULL DEFAULT 0,
      tool_calls     INTEGER NOT NULL DEFAULT 0,
      created_at     TEXT NOT NULL,
      updated_at     TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_subagent_parent ON subagent_sessions(parent_session);
    CREATE INDEX IF NOT EXISTS idx_subagent_status ON subagent_sessions(status);
  `)
  ensured = true
}

function nowIso() {
  return new Date().toISOString()
}

export function saveSubagentSession({
  childId,
  mode,
  status,
  provider = null,
  model = null,
  description = '',
  messages = [],
  parentSession = null,
  depth = 0,
  toolCalls = 0,
  createdAt = null,
}) {
  ensureSubagentTable()
  const db = getDB()
  const existing = createdAt ? null : db.prepare('SELECT created_at FROM subagent_sessions WHERE child_id = ?').get(childId)
  const firstCreatedAt = createdAt || existing?.created_at || nowIso()
  db.prepare(`
    INSERT INTO subagent_sessions
      (child_id, mode, status, provider, model, description, messages, parent_session, depth, tool_calls, created_at, updated_at)
    VALUES
      (@childId, @mode, @status, @provider, @model, @description, @messages, @parentSession, @depth, @toolCalls, @createdAt, @updatedAt)
    ON CONFLICT(child_id) DO UPDATE SET
      status      = excluded.status,
      provider    = excluded.provider,
      model       = excluded.model,
      description = excluded.description,
      messages    = excluded.messages,
      depth       = excluded.depth,
      tool_calls  = excluded.tool_calls,
      updated_at  = excluded.updated_at
  `).run({
    childId,
    mode,
    status,
    provider,
    model,
    description,
    messages: JSON.stringify(messages),
    parentSession,
    depth,
    toolCalls,
    createdAt: firstCreatedAt,
    updatedAt: nowIso(),
  })
}

export function loadSubagentSession(childId) {
  ensureSubagentTable()
  const row = getDB().prepare('SELECT * FROM subagent_sessions WHERE child_id = ?').get(childId)
  return hydrate(row)
}

function hydrate(row) {
  if (!row) return null
  let messages = []
  try { messages = JSON.parse(row.messages || '[]') } catch { messages = [] }
  return {
    childId: row.child_id,
    mode: row.mode,
    status: row.status,
    provider: row.provider,
    model: row.model,
    description: row.description,
    messages,
    parentSession: row.parent_session,
    depth: row.depth,
    toolCalls: row.tool_calls,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  }
}

// 列出某父会话下（或全部）子代理摘要，不含 messages 正文（roster / UI 用）。
export function listSubagentRows({ parentSession = null, includeDone = false } = {}) {
  ensureSubagentTable()
  const db = getDB()
  let rows
  if (parentSession) {
    rows = db.prepare(
      `SELECT * FROM subagent_sessions WHERE parent_session = ?
       ORDER BY datetime(created_at) ASC`,
    ).all(parentSession)
  } else {
    rows = db.prepare('SELECT * FROM subagent_sessions ORDER BY datetime(created_at) ASC').all()
  }
  return rows
    .filter(row => includeDone || row.status !== SUBAGENT_STATUS.DONE)
    .map((row) => ({
      childId: row.child_id,
      mode: row.mode,
      status: row.status,
      provider: row.provider,
      model: row.model,
      description: row.description,
      parentSession: row.parent_session,
      depth: row.depth,
      toolCalls: row.tool_calls,
      createdAt: row.created_at,
      updatedAt: row.updated_at,
    }))
}

export function deleteSubagentSession(childId) {
  ensureSubagentTable()
  getDB().prepare('DELETE FROM subagent_sessions WHERE child_id = ?').run(childId)
}
