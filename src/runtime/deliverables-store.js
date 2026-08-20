// 交付物登记（阶段 6.2）。
//
// 为什么需要登记，而不是「工具返回路径就完事」：
//   UI 上那张卡片要能被点开（用系统默认程序打开）。为此必须有一个 **服务端** 动作，
//   而这个动作一旦接受任意路径，就成了「通过局域网让爱丽丝打开机器上任何文件」的原语。
//   所以打开接口只认**登记过的**路径——登记这件事本身就是授权。
// 为什么落库而不是只放内存：页面刷新、进程重启之后卡片还得能点开。
import { getDB } from '../db/connection.js'
import { baseName, canOpen, formatSize, iconForKind } from './deliverable-card.js'

let ensured = false

export function ensureDeliverablesTable() {
  if (ensured) return
  const db = getDB()
  db.exec(`
    CREATE TABLE IF NOT EXISTS deliverables (
      path         TEXT PRIMARY KEY,
      description  TEXT NOT NULL DEFAULT '',
      size_bytes   INTEGER NOT NULL DEFAULT 0,
      kind         TEXT NOT NULL DEFAULT 'file',
      presented_at TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_deliverables_presented ON deliverables(presented_at DESC);
  `)
  ensured = true
}

function hydrate(row) {
  if (!row) return null
  return {
    path: row.path,
    description: row.description || '',
    sizeBytes: row.size_bytes,
    kind: row.kind,
    presentedAt: row.presented_at,
  }
}

export function recordDeliverable({ path, description = '', sizeBytes = 0, kind = 'file', at = null }) {
  ensureDeliverablesTable()
  const db = getDB()
  db.prepare(`
    INSERT INTO deliverables (path, description, size_bytes, kind, presented_at)
    VALUES (?, ?, ?, ?, ?)
    ON CONFLICT(path) DO UPDATE SET
      description = excluded.description,
      size_bytes = excluded.size_bytes,
      kind = excluded.kind,
      presented_at = excluded.presented_at
  `).run(String(path), String(description || ''), sizeBytes, kind, at || new Date().toISOString())
  return hydrate(db.prepare('SELECT * FROM deliverables WHERE path = ?').get(String(path)))
}

export function listDeliverables({ limit = 20 } = {}) {
  ensureDeliverablesTable()
  const safeLimit = Math.max(1, Math.min(100, Number(limit) || 20))
  return getDB().prepare('SELECT * FROM deliverables ORDER BY presented_at DESC LIMIT ?')
    .all(safeLimit)
    .map(hydrate)
}

/**
 * 对外（REST / 面板 / 事件）的视图形状。放在这里而不是路由里，是为了让「卡片长什么样」
 * 只有一份定义——路由和 UI 各写一份映射，迟早会出现字段名或 kind 对不上的分歧。
 *
 * 卡片的**展示字段在这里算好**（文件名、大小文案、图标、能否打开）而不是让前端算：
 * Brain UI 只能加载 /src/ui/brain-ui/ 下的文件，拿不到 runtime 模块。与其让前端复制
 * 一套图标表和大小换算，不如把结果发下去。
 */
export function deliverableView(row) {
  if (!row) return null
  return {
    path: row.path,
    name: baseName(row.path),
    description: row.description,
    size_bytes: row.sizeBytes,
    size_text: formatSize(row.sizeBytes),
    kind: row.kind,
    icon: iconForKind(row.kind),
    can_open: canOpen(row),
    presented_at: row.presentedAt,
  }
}

export function listDeliverableViews({ limit = 20 } = {}) {
  return listDeliverables({ limit }).map(deliverableView)
}

/** 打开动作的授权判定：只有登记过的路径才算数。 */
export function isRegisteredDeliverable(path) {
  ensureDeliverablesTable()
  const row = getDB().prepare('SELECT path FROM deliverables WHERE path = ?').get(String(path))
  return !!row
}

export function forgetDeliverable(path) {
  ensureDeliverablesTable()
  return getDB().prepare('DELETE FROM deliverables WHERE path = ?').run(String(path))
}

export function clearDeliverables() {
  ensureDeliverablesTable()
  getDB().prepare('DELETE FROM deliverables').run()
}

export function _resetDeliverablesStateForTest() {
  ensured = false
}
