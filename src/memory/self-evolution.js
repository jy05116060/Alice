import { getConfig, setConfig, getMemoryByMemId } from '../db.js'

const STATE_KEY = 'self_evolution_state_v1'
const STATE_VERSION = 1
const MAX_RECENT = 24
const PROMPT_MAX_AGE_MS = 7 * 24 * 60 * 60 * 1000

const ACTIONABLE_TAGS = new Set([
  'kind:procedure',
  'kind:constraint',
  'kind:failure_lesson',
  'kind:policy',
])

const ACTIONABLE_EVENT_TYPES = new Set([
  'self_constraint',
])

const ACTIONABLE_MEM_ID_RE = /^(procedure|constraint|policy|lesson|rule)_/i

function defaultState() {
  return {
    version: STATE_VERSION,
    enabled: true,
    total_events: 0,
    learned_count: 0,
    last_at: null,
    recent: [],
  }
}

function safeJsonArray(value) {
  if (Array.isArray(value)) return value
  if (!value) return []
  try {
    const parsed = JSON.parse(value)
    return Array.isArray(parsed) ? parsed : []
  } catch {
    return []
  }
}

function safeJsonObject(value) {
  if (!value) return null
  if (typeof value === 'object') return value
  try {
    const parsed = JSON.parse(value)
    return parsed && typeof parsed === 'object' ? parsed : null
  } catch {
    return null
  }
}

function normalizeState(raw) {
  const parsed = safeJsonObject(raw) || {}
  const recent = Array.isArray(parsed.recent) ? parsed.recent : []
  return {
    ...defaultState(),
    ...parsed,
    version: STATE_VERSION,
    enabled: parsed.enabled !== false,
    total_events: Math.max(0, Number(parsed.total_events) || 0),
    learned_count: Math.max(0, Number(parsed.learned_count) || 0),
    recent: recent
      .filter(entry => entry && entry.mem_id)
      .slice(0, MAX_RECENT),
  }
}

function saveState(state) {
  const normalized = normalizeState(state)
  normalized.recent = normalized.recent.slice(0, MAX_RECENT)
  setConfig(STATE_KEY, JSON.stringify(normalized))
  return normalized
}

function truncate(text, max = 220) {
  const value = String(text || '').replace(/\s+/g, ' ').trim()
  return value.length > max ? `${value.slice(0, max - 1)}...` : value
}

function tagKind(tags = []) {
  const kindTag = tags.find(tag => String(tag).startsWith('kind:'))
  if (!kindTag) return ''
  return String(kindTag).slice('kind:'.length)
}

function memoryToEntry(memory, source = {}) {
  const tags = safeJsonArray(memory.tags).map(String)
  const kind = tagKind(tags)
    || (memory.event_type === 'self_constraint' ? 'constraint' : '')
    || ((memory.mem_id || '').match(ACTIONABLE_MEM_ID_RE)?.[1] || 'policy').toLowerCase()
  return {
    mem_id: memory.mem_id || source.mem_id || `row:${memory.id}`,
    kind,
    action: source.action || 'observed',
    title: truncate(memory.title || memory.content || source.title || 'Self-evolution update', 96),
    content: truncate(memory.content || source.content || '', 240),
    salience: Number(memory.salience || source.salience || 3),
    tags,
    learned_at: new Date().toISOString(),
  }
}

export function getSelfEvolutionState() {
  return normalizeState(getConfig(STATE_KEY))
}

export function getSelfEvolutionSnapshot({ maxRecent = MAX_RECENT } = {}) {
  const state = getSelfEvolutionState()
  return {
    enabled: state.enabled,
    version: state.version,
    total_events: state.total_events,
    learned_count: state.learned_count,
    last_at: state.last_at,
    recent: state.recent.slice(0, Math.max(0, Math.min(Number(maxRecent) || MAX_RECENT, MAX_RECENT))),
  }
}

export function resetSelfEvolutionState() {
  return saveState(defaultState())
}

export function isSelfEvolutionMemory(memory = {}) {
  if (!memory || typeof memory !== 'object') return false
  const tags = safeJsonArray(memory.tags).map(String)
  if (tags.some(tag => ACTIONABLE_TAGS.has(tag))) return true
  if (ACTIONABLE_EVENT_TYPES.has(memory.event_type || memory.type)) return true
  return ACTIONABLE_MEM_ID_RE.test(memory.mem_id || '')
}

export function recordSelfEvolutionFromMemories(memories = [], { emitEvent = null } = {}) {
  if (!Array.isArray(memories) || memories.length === 0) return []

  const state = getSelfEvolutionState()
  if (state.enabled === false) return []

  const learned = []
  const seen = new Set()

  for (const item of memories) {
    const memId = item?.mem_id || item?.id
    if (!memId || seen.has(memId)) continue
    seen.add(memId)

    let full = null
    try {
      full = getMemoryByMemId(memId)
    } catch {}
    const memory = full || item
    if (!isSelfEvolutionMemory(memory)) continue
    learned.push(memoryToEntry(memory, item))
  }

  if (learned.length === 0) return []

  const now = new Date().toISOString()
  const byId = new Map()
  for (const entry of learned) byId.set(entry.mem_id, entry)
  for (const entry of state.recent) {
    if (!byId.has(entry.mem_id)) byId.set(entry.mem_id, entry)
  }

  const nextRecent = [...byId.values()]
    .sort((a, b) => String(b.learned_at || '').localeCompare(String(a.learned_at || '')))
    .slice(0, MAX_RECENT)

  const nextState = saveState({
    ...state,
    total_events: state.total_events + learned.length,
    learned_count: nextRecent.length,
    last_at: now,
    recent: nextRecent,
  })

  if (typeof emitEvent === 'function') {
    emitEvent('self_evolution', {
      count: learned.length,
      entries: learned,
      summary: getSelfEvolutionSnapshot({ maxRecent: 5 }),
    })
  }

  return learned.map(entry => ({ ...entry, total_events: nextState.total_events }))
}

export function formatSelfEvolutionForPrompt({
  maxRecent = 3,
  maxAgeMs = PROMPT_MAX_AGE_MS,
} = {}) {
  const state = getSelfEvolutionState()
  if (state.enabled === false || state.recent.length === 0) return ''

  const cutoff = Date.now() - maxAgeMs
  const recent = state.recent
    .filter(entry => {
      if (!entry?.learned_at) return true
      const t = Date.parse(entry.learned_at)
      return Number.isNaN(t) || t >= cutoff
    })
    .slice(0, Math.max(1, Math.min(Number(maxRecent) || 3, 8)))

  if (recent.length === 0) return ''

  const lines = recent.map(entry => {
    const title = entry.title ? `${entry.title}: ` : ''
    return `- [${entry.kind || 'policy'}] ${entry.mem_id}: ${title}${entry.content || ''}`
  })

  return [
    'Self-evolution loop is active. It stores reusable procedures, constraints, and failure lessons as long-term policy memories. It does not rewrite source code or change permissions by itself.',
    'Recent behavior updates:',
    ...lines,
    'Use this as provenance. Turn-specific guidance still comes from <active-policies> when a learned policy matches the current situation.',
  ].join('\n')
}
