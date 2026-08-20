import { getDB } from '../connection.js'

export function insertRecallAudit({
  turn_label = null,
  from_id = null,
  channel = null,
  query_text = '',
  matched_mem_ids = [],
  chosen_count = 0,
  event_type_dist = {},
  latency_ms = null,
  source = null,
} = {}) {
  try {
    const ids = Array.isArray(matched_mem_ids) ? matched_mem_ids : []
    getDB().prepare(`
      INSERT INTO recall_audit (
        turn_label, from_id, channel, query_text,
        matched_mem_ids, matched_count, chosen_count,
        event_type_dist, latency_ms, source
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      turn_label,
      from_id,
      channel,
      (query_text || '').slice(0, 1000),
      JSON.stringify(ids),
      ids.length,
      chosen_count,
      JSON.stringify(event_type_dist || {}),
      latency_ms,
      source
    )
  } catch (err) {
    console.warn('[recall_audit] insert failed:', err.message)
  }
}

export function insertExtractAudit({
  turn_label = null,
  from_id = null,
  channel = null,
  turn_summary = '',
  extracted_mem_ids = [],
  event_type_dist = {},
  latency_ms = null,
  skipped = false,
  skip_reason = null,
} = {}) {
  try {
    const ids = Array.isArray(extracted_mem_ids) ? extracted_mem_ids : []
    getDB().prepare(`
      INSERT INTO extract_audit (
        turn_label, from_id, channel, turn_summary,
        extracted_mem_ids, extracted_count,
        event_type_dist, latency_ms, skipped, skip_reason
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      turn_label,
      from_id,
      channel,
      (turn_summary || '').slice(0, 500),
      JSON.stringify(ids),
      ids.length,
      JSON.stringify(event_type_dist || {}),
      latency_ms,
      skipped ? 1 : 0,
      skip_reason
    )
  } catch (err) {
    console.warn('[extract_audit] insert failed:', err.message)
  }
}

export function getRecentRecallAudits(limit = 50) {
  try {
    return getDB().prepare(`SELECT * FROM recall_audit ORDER BY id DESC LIMIT ?`).all(limit)
  } catch (err) {
    console.warn('[recall_audit] read failed:', err.message)
    return []
  }
}

export function getRecentExtractAudits(limit = 50) {
  try {
    return getDB().prepare(`SELECT * FROM extract_audit ORDER BY id DESC LIMIT ?`).all(limit)
  } catch (err) {
    console.warn('[extract_audit] read failed:', err.message)
    return []
  }
}

export function getRecallAuditStats({ sinceIso = null } = {}) {
  try {
    const sinceClause = sinceIso ? 'WHERE created_at >= ?' : ''
    const args = sinceIso ? [sinceIso] : []
    return getDB().prepare(`
      SELECT
        COUNT(*) AS total,
        AVG(matched_count) AS avg_matched,
        AVG(chosen_count)  AS avg_chosen,
        AVG(latency_ms)    AS avg_latency_ms,
        MAX(latency_ms)    AS max_latency_ms,
        SUM(CASE WHEN matched_count = 0 THEN 1 ELSE 0 END) AS zero_match_count
      FROM recall_audit ${sinceClause}
    `).get(...args)
  } catch (err) {
    console.warn('[recall_audit] stats failed:', err.message)
    return null
  }
}

export function getExtractAuditStats({ sinceIso = null } = {}) {
  try {
    const sinceClause = sinceIso ? 'WHERE created_at >= ?' : ''
    const args = sinceIso ? [sinceIso] : []
    return getDB().prepare(`
      SELECT
        COUNT(*)            AS total,
        AVG(extracted_count) AS avg_extracted,
        AVG(latency_ms)      AS avg_latency_ms,
        SUM(skipped)         AS skipped_count
      FROM extract_audit ${sinceClause}
    `).get(...args)
  } catch (err) {
    console.warn('[extract_audit] stats failed:', err.message)
    return null
  }
}
