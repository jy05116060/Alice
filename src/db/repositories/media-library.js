import { getDB } from '../connection.js'

export function upsertMediaHistory({ kind, url, title = '', videoId = null, platform = null }) {
  const db = getDB()
  const now = new Date().toISOString()
  db.prepare(`
    INSERT INTO media_history (kind, url, title, video_id, platform, played_at)
    VALUES (?, ?, ?, ?, ?, ?)
    ON CONFLICT(url) DO UPDATE SET
      title     = excluded.title,
      played_at = excluded.played_at
  `).run(kind, url, title, videoId || null, platform || null, now)
}

export function getMediaHistory(limit = 30) {
  const db = getDB()
  return db.prepare(`
    SELECT * FROM media_history ORDER BY played_at DESC LIMIT ?
  `).all(limit)
}

export function upsertMusicTrack({ title = '', artist = '', album = '', filePath, duration = 0, lrc = '', cover = '', sourceUrl = '' }) {
  const db = getDB()
  db.prepare(`
    INSERT INTO music_library (title, artist, album, file_path, duration, lrc, cover, source_url)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(file_path) DO UPDATE SET
      title      = excluded.title,
      artist     = excluded.artist,
      album      = excluded.album,
      duration   = excluded.duration,
      lrc        = CASE WHEN excluded.lrc != '' THEN excluded.lrc ELSE lrc END,
      cover      = CASE WHEN excluded.cover != '' THEN excluded.cover ELSE cover END,
      source_url = CASE WHEN excluded.source_url != '' THEN excluded.source_url ELSE source_url END
  `).run(title, artist, album, filePath, duration, lrc, cover, sourceUrl)
  return db.prepare(`SELECT * FROM music_library WHERE file_path = ?`).get(filePath)
}

export function getMusicTrack(id) {
  return getDB().prepare(`SELECT * FROM music_library WHERE id = ?`).get(id)
}

export function searchMusicLibrary(query, limit = 20) {
  const db = getDB()
  const tokens = String(query || '').trim().split(/\s+/).filter(Boolean)
  if (!tokens.length) return []
  const clauses = tokens.map(() => '(title LIKE ? OR artist LIKE ? OR album LIKE ?)')
  const params = []
  for (const t of tokens) { const like = `%${t}%`; params.push(like, like, like) }
  return db.prepare(`
    SELECT * FROM music_library
    WHERE ${clauses.join(' AND ')}
    ORDER BY added_at DESC LIMIT ?
  `).all(...params, limit)
}

export function listMusicLibrary(limit = 50) {
  return getDB().prepare(`SELECT * FROM music_library ORDER BY added_at DESC LIMIT ?`).all(limit)
}

export function updateMusicLrc(id, lrc) {
  getDB().prepare(`UPDATE music_library SET lrc = ? WHERE id = ?`).run(lrc, id)
}

export function deleteMusicTrack(id) {
  getDB().prepare(`DELETE FROM music_library WHERE id = ?`).run(id)
}
