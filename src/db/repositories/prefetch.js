import { getDB } from '../connection.js'

export function savePrefetchCache(source, content, ttlMinutes, tags = []) {
  const db = getDB()
  const now = new Date()
  const fetched_at = now.toISOString()
  const expires_at = new Date(now.getTime() + ttlMinutes * 60 * 1000).toISOString()
  db.prepare(`
    INSERT INTO prefetch_cache (source, content, fetched_at, expires_at, tags)
    VALUES (?, ?, ?, ?, ?)
    ON CONFLICT(source) DO UPDATE SET
      content    = excluded.content,
      fetched_at = excluded.fetched_at,
      expires_at = excluded.expires_at,
      tags       = excluded.tags
  `).run(source, content, fetched_at, expires_at, JSON.stringify(tags))
}

export function getValidPrefetchCache() {
  const db = getDB()
  const now = new Date().toISOString()
  return db.prepare(`
    SELECT * FROM prefetch_cache
    WHERE expires_at > ?
    ORDER BY fetched_at DESC
  `).all(now)
}

export function clearExpiredPrefetchCache() {
  const db = getDB()
  const now = new Date().toISOString()
  db.prepare(`DELETE FROM prefetch_cache WHERE expires_at <= ?`).run(now)
}

export function upsertPrefetchTask({ source, label, url, ttlMinutes = 60, tags = [] }) {
  const db = getDB()
  const now = new Date().toISOString()
  db.prepare(`
    INSERT INTO prefetch_tasks (source, label, url, ttl_minutes, tags, enabled, updated_at)
    VALUES (?, ?, ?, ?, ?, 1, ?)
    ON CONFLICT(source) DO UPDATE SET
      label       = excluded.label,
      url         = excluded.url,
      ttl_minutes = excluded.ttl_minutes,
      tags        = excluded.tags,
      enabled     = 1,
      updated_at  = excluded.updated_at
  `).run(source, label, url, ttlMinutes, JSON.stringify(tags), now)
}

export function removePrefetchTask(source) {
  const db = getDB()
  const result = db.prepare(`DELETE FROM prefetch_tasks WHERE source = ?`).run(source)
  return result.changes > 0
}

export function listPrefetchTasks() {
  const db = getDB()
  return db.prepare(`SELECT * FROM prefetch_tasks ORDER BY created_at ASC`).all()
}

export function getEnabledPrefetchTasks() {
  const db = getDB()
  return db.prepare(`SELECT * FROM prefetch_tasks WHERE enabled = 1 ORDER BY created_at ASC`).all()
}
