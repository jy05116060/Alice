import { getDB } from '../connection.js'

const FOCUS_STACK_RESTORE_TTL_MS = 24 * 60 * 60 * 1000
const THREAD_LOAD_WINDOW_MS = 7 * 24 * 60 * 60 * 1000

function rowToThread(r) {
  const topic = JSON.parse(r.topic || '[]')
  const signature = JSON.parse(r.signature || '[]')
  return {
    id: r.id,
    topic,
    signature: signature.length > 0 ? signature : [...topic],
    label: r.label || '',
    summary: r.summary || '',
    conclusions: JSON.parse(r.conclusions || '[]'),
    status: r.status || 'open',
    createdAt: r.created_at,
    lastEventAt: r.last_event_at,
    lastEventTick: r.last_event_tick || 0,
    hitCount: r.hit_count || 1,
    lastSummaryAt: r.last_summary_at || '',
  }
}

export function loadFocusStack() {
  const db = getDB()
  try {
    const rows = db.prepare(`SELECT * FROM focus_stack ORDER BY depth ASC`).all()
    if (rows.length > 0) {
      const newest = rows
        .map(r => Date.parse(r.updated_at || r.started_at || ''))
        .filter(Number.isFinite)
        .sort((a, b) => b - a)[0]
      if (Number.isFinite(newest) && Date.now() - newest > FOCUS_STACK_RESTORE_TTL_MS) {
        db.prepare(`DELETE FROM focus_stack`).run()
        console.log('[focus-persist] dropped stale persisted focus_stack on startup')
        return []
      }
    }
    return rows.map(r => ({
      topic: JSON.parse(r.topic || '[]'),
      startedAt: r.started_at,
      startedAtTick: r.started_at_tick,
      lastSeenTick: r.last_seen_tick,
      hitCount: r.hit_count,
      conclusions: JSON.parse(r.conclusions || '[]'),
    }))
  } catch {
    return []
  }
}

export function saveFocusStack(stack) {
  const db = getDB()
  try {
    const tx = db.transaction((frames) => {
      db.prepare(`DELETE FROM focus_stack`).run()
      const insert = db.prepare(`
        INSERT INTO focus_stack (depth, topic, started_at, started_at_tick, last_seen_tick, hit_count, conclusions)
        VALUES (?, ?, ?, ?, ?, ?, ?)
      `)
      for (let i = 0; i < frames.length; i++) {
        const f = frames[i]
        insert.run(
          i,
          JSON.stringify(f.topic || []),
          f.startedAt || new Date().toISOString(),
          f.startedAtTick || 0,
          f.lastSeenTick || 0,
          f.hitCount || 1,
          JSON.stringify(f.conclusions || [])
        )
      }
    })
    tx(stack || [])
  } catch (err) {
    console.warn('[focus-persist] saveFocusStack failed:', err.message)
  }
}

export function loadThreadState() {
  const db = getDB()
  try {
    const threadRows = db.prepare(`SELECT * FROM threads`).all()
    if (threadRows.length === 0) return null
    const commitmentRows = db.prepare(`SELECT * FROM commitments WHERE status = 'open'`).all()
    const openThreadIds = new Set(commitmentRows.map(r => r.thread_id))
    const cutoff = Date.now() - THREAD_LOAD_WINDOW_MS
    const threads = threadRows
      .filter(r => openThreadIds.has(r.id) || (Date.parse(r.last_event_at || '') || 0) >= cutoff)
      .map(rowToThread)
    const fgRow = db.prepare(`SELECT value FROM thread_state WHERE key = 'foregroundId'`).get()
    let foregroundId = fgRow?.value || null
    if (foregroundId && !threads.some(t => t.id === foregroundId)) foregroundId = null
    const commitments = commitmentRows.map(r => ({
      id: r.id,
      threadId: r.thread_id,
      text: r.text || '',
      status: r.status || 'open',
      channel: r.channel || '',
      createdAt: r.created_at,
      closedAt: r.closed_at || null,
    }))
    return { threads, foregroundId, commitments }
  } catch {
    return null
  }
}

export function saveThreadState(threadState) {
  const db = getDB()
  const ts = threadState || {}
  try {
    const tx = db.transaction(() => {
      const upsertThread = db.prepare(`
        INSERT INTO threads (id, topic, signature, label, summary, conclusions, status, created_at, last_event_at, last_event_tick, hit_count, last_summary_at, updated_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, datetime('now'))
        ON CONFLICT(id) DO UPDATE SET
          topic = excluded.topic, signature = excluded.signature, label = excluded.label, summary = excluded.summary,
          conclusions = excluded.conclusions, status = excluded.status,
          last_event_at = excluded.last_event_at, last_event_tick = excluded.last_event_tick,
          hit_count = excluded.hit_count, last_summary_at = excluded.last_summary_at,
          updated_at = datetime('now')
      `)
      for (const t of (ts.threads || [])) {
        upsertThread.run(
          t.id,
          JSON.stringify(t.topic || []),
          JSON.stringify(t.signature || t.topic || []),
          t.label || '',
          t.summary || '',
          JSON.stringify(t.conclusions || []),
          t.status || 'open',
          t.createdAt || new Date().toISOString(),
          t.lastEventAt || new Date().toISOString(),
          t.lastEventTick || 0,
          t.hitCount || 1,
          t.lastSummaryAt || ''
        )
      }
      const upsertCommitment = db.prepare(`
        INSERT INTO commitments (id, thread_id, text, status, channel, created_at, closed_at)
        VALUES (?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(id) DO UPDATE SET
          thread_id = excluded.thread_id, text = excluded.text, status = excluded.status,
          channel = excluded.channel, closed_at = excluded.closed_at
      `)
      for (const c of (ts.commitments || [])) {
        upsertCommitment.run(
          c.id, c.threadId, c.text || '', c.status || 'open',
          c.channel || '', c.createdAt || new Date().toISOString(), c.closedAt || null
        )
      }
      db.prepare(`
        INSERT INTO thread_state (key, value) VALUES ('foregroundId', ?)
        ON CONFLICT(key) DO UPDATE SET value = excluded.value
      `).run(ts.foregroundId || '')
      if (Array.isArray(ts.mergedAwayIds)) {
        const close = db.prepare(`UPDATE threads SET status = 'merged', updated_at = datetime('now') WHERE id = ?`)
        for (const id of ts.mergedAwayIds) close.run(id)
      }
    })
    tx()
  } catch (err) {
    console.warn('[thread-persist] saveThreadState failed:', err.message)
  }
}
