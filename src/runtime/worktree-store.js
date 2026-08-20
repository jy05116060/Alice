// 会话内创建过的 worktree 记录（阶段 5）。
//
// 为什么需要记：DSH 把「当前工作树」放在会话上下文里（checkout 时用 `[hash]/[dirname]` 指认）。
// 爱丽丝是**一个长驻 Agent、多个工作树**，没有「每会话一个工作树」这层结构，所以
// 「现在哪些隔离区开着」必须显式存下来，否则：
//   - checkout 时模型得自己记路径（忘一次就得去 `git worktree list` 里猜哪个是自己的）；
//   - 面板/用户看不到自己名下开着几个隔离区。
import { getDB } from '../db/connection.js'

let ensured = false

export function ensureWorktreeTable() {
  if (ensured) return
  const db = getDB()
  db.exec(`
    CREATE TABLE IF NOT EXISTS worktrees (
      id          INTEGER PRIMARY KEY AUTOINCREMENT,
      repo_root   TEXT NOT NULL,
      path        TEXT NOT NULL,
      branch      TEXT NOT NULL,
      base_branch TEXT,
      base_commit TEXT,
      status      TEXT NOT NULL DEFAULT 'open',
      created_at  TEXT NOT NULL,
      closed_at   TEXT,
      UNIQUE(path)
    );
    CREATE INDEX IF NOT EXISTS idx_worktrees_open ON worktrees(status, id DESC);
  `)
  ensured = true
}

function hydrate(row) {
  if (!row) return null
  return {
    id: row.id,
    repoRoot: row.repo_root,
    path: row.path,
    branch: row.branch,
    baseBranch: row.base_branch,
    baseCommit: row.base_commit,
    status: row.status,
    createdAt: row.created_at,
    closedAt: row.closed_at,
  }
}

export function recordWorktree({ repoRoot, path, branch, baseBranch = null, baseCommit = null }) {
  ensureWorktreeTable()
  const db = getDB()
  // 同一个路径重复登记（先关掉再建、或上次没清干净）就覆盖为 open，而不是插两行。
  db.prepare(`
    INSERT INTO worktrees (repo_root, path, branch, base_branch, base_commit, status, created_at, closed_at)
    VALUES (?, ?, ?, ?, ?, 'open', ?, NULL)
    ON CONFLICT(path) DO UPDATE SET
      repo_root = excluded.repo_root,
      branch = excluded.branch,
      base_branch = excluded.base_branch,
      base_commit = excluded.base_commit,
      status = 'open',
      created_at = excluded.created_at,
      closed_at = NULL
  `).run(repoRoot, path, branch, baseBranch, baseCommit, new Date().toISOString())
  return hydrate(db.prepare('SELECT * FROM worktrees WHERE path = ?').get(path))
}

export function closeWorktreeRecord(path) {
  ensureWorktreeTable()
  getDB().prepare(`
    UPDATE worktrees SET status = 'closed', closed_at = ?
    WHERE path = ? AND status = 'open'
  `).run(new Date().toISOString(), String(path))
}

export function listOpenWorktrees({ repoRoot = null } = {}) {
  ensureWorktreeTable()
  const db = getDB()
  if (repoRoot) {
    return db.prepare(`SELECT * FROM worktrees WHERE status = 'open' AND repo_root = ? ORDER BY id DESC`)
      .all(repoRoot).map(hydrate)
  }
  return db.prepare(`SELECT * FROM worktrees WHERE status = 'open' ORDER BY id DESC`).all().map(hydrate)
}

export function getOpenWorktreeByPath(path) {
  ensureWorktreeTable()
  return hydrate(getDB().prepare(`
    SELECT * FROM worktrees WHERE status = 'open' AND path = ?
  `).get(String(path)))
}

/**
 * 只有一个开着的工作树时返回它，否则 null。
 * `checkout_worktree` 允许省略路径，靠的就是这个——但**只在唯一时才自动选**：
 * 有多个还替模型猜，猜错就会回收掉错的隔离区。
 */
export function soleOpenWorktree({ repoRoot = null } = {}) {
  const open = listOpenWorktrees({ repoRoot })
  return open.length === 1 ? open[0] : null
}

export function _resetWorktreeStoreForTest() {
  ensured = false
}
