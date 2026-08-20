// 长期目标（goal）的持久化存储（阶段 3.1，对齐 DSH persisted goal）。
//
// 与 set_task 的分工：task 是「这一次要做完的步骤清单」，goal 是「跨多轮、跨重启
// 都要自己往前推的目标」。所以 goal 需要三样 task 没有的东西：
//   1. revision —— 乐观锁。目标可能在模型不知情时被改过（另一轮的自己、或用户
//      直接改），拿着旧 revision 提交必须被拒，而不是覆盖掉新状态。
//   2. 轮数账本 —— 自动续轮是有预算的，烧完就停，防止一个人自己无限往下跑。
//   3. armed_epoch —— 「已上膛」只在本进程内有效。进程重启后旧目标自动解除续行，
//      必须由人（或明确要求继续的那一轮）重新授权，否则重启一次就自己接着跑。
import { getDB } from '../db/connection.js'

export const GOAL_STATUS = Object.freeze({
  ACTIVE: 'active',
  PAUSED: 'paused',
  BLOCKED: 'blocked',
  COMPLETE: 'complete',
})

export const GOAL_TERMINAL_STATUSES = Object.freeze([GOAL_STATUS.COMPLETE])

let ensured = false
export function ensureGoalTable() {
  if (ensured) return
  const db = getDB()
  db.exec(`
    CREATE TABLE IF NOT EXISTS goals (
      goal_id        TEXT PRIMARY KEY,
      objective      TEXT NOT NULL,
      status         TEXT NOT NULL DEFAULT 'active',
      revision       INTEGER NOT NULL DEFAULT 1,
      rounds_started INTEGER NOT NULL DEFAULT 0,
      rounds_total   INTEGER NOT NULL DEFAULT 0,
      max_rounds     INTEGER,
      progress_note  TEXT NOT NULL DEFAULT '',
      blocked_reason TEXT,
      pause_reason   TEXT,
      armed_epoch    TEXT,
      created_at     TEXT NOT NULL,
      updated_at     TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_goals_status ON goals(status);
    CREATE INDEX IF NOT EXISTS idx_goals_updated ON goals(updated_at);
  `)
  migrateGoalTable()
  ensured = true
}

// 迁移：给**已存在**的 goals 表补 rounds_total（累计自动轮次，跨所有授权只增不减）。
//
// 两个动作，顺序不能反：
//   1. 用 PRAGMA table_info 判断列在不在——SQLite 的 ADD COLUMN 不幂等，重复加会抛错，
//      而 ensureGoalTable 每次进程启动都会走到这里（真出错就该让上层看见，
//      而不是吞掉之后让后面每一条读写都报「no such column」）。
//   2. 回填：老行的 rounds_total 默认是 0，但它的 rounds_started 可能已经是 3。
//      不回填的话，界面上就会冒出「累计 0 轮 · 本轮 3/12」这种自相矛盾的数字。
//      回填取 max(现有值, rounds_started)——只增不减，对已经正确的行是 no-op。
export function migrateGoalTable() {
  const db = getDB()
  const cols = db.prepare('PRAGMA table_info(goals)').all()
  const have = new Set(cols.map(c => c.name))
  if (!have.has('rounds_total')) {
    db.exec('ALTER TABLE goals ADD COLUMN rounds_total INTEGER NOT NULL DEFAULT 0')
  }
  db.prepare(
    'UPDATE goals SET rounds_total = rounds_started WHERE rounds_total < rounds_started',
  ).run()
}

function nowIso() {
  return new Date().toISOString()
}

export function insertGoal({
  goalId,
  objective,
  status = GOAL_STATUS.ACTIVE,
  revision = 1,
  roundsStarted = 0,
  roundsTotal = 0,
  maxRounds = null,
  progressNote = '',
  armedEpoch = null,
  createdAt = null,
}) {
  ensureGoalTable()
  const stamp = createdAt || nowIso()
  getDB().prepare(`
    INSERT INTO goals
      (goal_id, objective, status, revision, rounds_started, rounds_total, max_rounds, progress_note,
       blocked_reason, pause_reason, armed_epoch, created_at, updated_at)
    VALUES
      (@goalId, @objective, @status, @revision, @roundsStarted, @roundsTotal, @maxRounds, @progressNote,
       NULL, NULL, @armedEpoch, @createdAt, @updatedAt)
  `).run({
    goalId,
    objective,
    status,
    revision,
    roundsStarted,
    roundsTotal,
    maxRounds,
    progressNote,
    armedEpoch,
    createdAt: stamp,
    updatedAt: stamp,
  })
}

export function loadGoalRow(goalId) {
  ensureGoalTable()
  return getDB().prepare('SELECT * FROM goals WHERE goal_id = ?').get(goalId) || null
}

// 当前目标 = 最近一条未完成的目标。爱丽丝是单一意识，所以同一时刻只应该有一个
// 非终态目标；管理者会强制这个不变量，这里只做「最近一条」的读取。
export function loadCurrentGoalRow() {
  ensureGoalTable()
  const placeholders = GOAL_TERMINAL_STATUSES.map(() => '?').join(', ')
  const open = getDB().prepare(
    `SELECT * FROM goals WHERE status NOT IN (${placeholders})
     ORDER BY datetime(updated_at) DESC, rowid DESC LIMIT 1`,
  ).get(...GOAL_TERMINAL_STATUSES)
  if (open) return open
  return getDB().prepare(
    'SELECT * FROM goals ORDER BY datetime(updated_at) DESC, rowid DESC LIMIT 1',
  ).get() || null
}

export function listGoalRows({ limit = 50 } = {}) {
  ensureGoalTable()
  return getDB().prepare(
    'SELECT * FROM goals ORDER BY datetime(updated_at) DESC, rowid DESC LIMIT ?',
  ).all(limit)
}

// 整行写入。CAS 由管理者负责：调用方必须已经比对过 revision。
export function updateGoalRow(goalId, patch = {}) {
  ensureGoalTable()
  const row = loadGoalRow(goalId)
  if (!row) return null
  const next = { ...row, ...patch, updated_at: nowIso() }
  getDB().prepare(`
    UPDATE goals SET
      objective      = @objective,
      status         = @status,
      revision       = @revision,
      rounds_started = @rounds_started,
      rounds_total   = @rounds_total,
      max_rounds     = @max_rounds,
      progress_note  = @progress_note,
      blocked_reason = @blocked_reason,
      pause_reason   = @pause_reason,
      armed_epoch    = @armed_epoch,
      updated_at     = @updated_at
    WHERE goal_id = @goal_id
  `).run({
    goal_id: goalId,
    objective: next.objective,
    status: next.status,
    revision: next.revision,
    rounds_started: next.rounds_started,
    rounds_total: next.rounds_total ?? next.rounds_started ?? 0,
    max_rounds: next.max_rounds,
    progress_note: next.progress_note ?? '',
    blocked_reason: next.blocked_reason ?? null,
    pause_reason: next.pause_reason ?? null,
    armed_epoch: next.armed_epoch ?? null,
    updated_at: next.updated_at,
  })
  return loadGoalRow(goalId)
}

export function deleteGoalRow(goalId) {
  ensureGoalTable()
  getDB().prepare('DELETE FROM goals WHERE goal_id = ?').run(goalId)
}

// 测试清理用：只清目标表，不动别的数据。
export function clearGoalRows() {
  ensureGoalTable()
  getDB().prepare('DELETE FROM goals').run()
}

export function hydrateGoalRow(row) {
  if (!row) return null
  return {
    goalId: row.goal_id,
    objective: row.objective,
    status: row.status,
    revision: row.revision,
    roundsStarted: row.rounds_started,
    roundsTotal: row.rounds_total ?? row.rounds_started ?? 0,
    maxRounds: row.max_rounds,
    progressNote: row.progress_note || '',
    blockedReason: row.blocked_reason || '',
    pauseReason: row.pause_reason || '',
    armedEpoch: row.armed_epoch || null,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  }
}
