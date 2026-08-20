// 台风数据模块：服务端适配中央气象台台风网的公开数据。
// 前端只消费稳定的普通 JSON，避免耦合上游 JSONP 的数组下标格式。
const NMC_BASE = 'https://typhoon.nmc.cn/weatherservice/typhoon/jsons'
const FETCH_TIMEOUT_MS = 12_000
const CACHE_TTL_MS = 10 * 60 * 1000
const PANEL_CONTEXT_TTL_MS = 60 * 60 * 1000
const USER_AGENT = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/126 Safari/537.36'

const LEVEL_LABELS = {
  TD: '热带低压', TS: '热带风暴', STS: '强热带风暴', TY: '台风',
  STY: '强台风', SuperTY: '超强台风', EXTD: '温带气旋',
}

let cache = null
let inFlight = null
let panelActiveUntilMs = 0
let panelState = { active: false, updatedAtMs: 0, openedAtMs: 0, openEventPending: false, source: 'startup' }

function unwrapJsonp(raw = '') {
  const text = String(raw || '').trim()
  const start = text.indexOf('(')
  const end = text.lastIndexOf(')')
  if (start < 0 || end <= start) throw new Error('中央气象台台风数据格式异常')
  return JSON.parse(text.slice(start + 1, end))
}

async function fetchJsonp(url) {
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS)
  try {
    const res = await fetch(url, { headers: { 'User-Agent': USER_AGENT }, signal: controller.signal })
    if (!res.ok) throw new Error(`中央气象台请求失败 (${res.status})`)
    return unwrapJsonp(await res.text())
  } finally {
    clearTimeout(timer)
  }
}

function toNumber(value, fallback = null) {
  const n = Number(value)
  return Number.isFinite(n) ? n : fallback
}

function formatNmcTime(value = '') {
  const text = String(value)
  if (!/^\d{10}(?:\d{2})?$/.test(text)) return text || null
  const minutes = text.length === 12 ? text.slice(10, 12) : '00'
  return `${text.slice(0, 4)}-${text.slice(4, 6)}-${text.slice(6, 8)} ${text.slice(8, 10)}:${minutes}`
}

function parseWindCircles(rows = []) {
  return (Array.isArray(rows) ? rows : []).map(row => ({
    level: String(row?.[0] || '').replace('KTS', ' kt'),
    northeastKm: toNumber(row?.[1], 0), southeastKm: toNumber(row?.[2], 0),
    southwestKm: toNumber(row?.[3], 0), northwestKm: toNumber(row?.[4], 0),
  })).filter(row => row.level)
}

function parsePoint(row) {
  if (!Array.isArray(row)) return null
  const lon = toNumber(row[4])
  const lat = toNumber(row[5])
  if (lon == null || lat == null) return null
  return {
    time: formatNmcTime(row[1]), timestampMs: toNumber(row[2]), level: row[3] || '',
    levelLabel: LEVEL_LABELS[row[3]] || row[3] || '热带气旋', lon, lat,
    pressureHpa: toNumber(row[6]), windSpeedMs: toNumber(row[7]),
    direction: row[8] || '', moveSpeedKmh: toNumber(row[9]), windCircles: parseWindCircles(row[10]),
  }
}

function parseForecasts(row) {
  const centers = row?.[11]
  if (!centers || typeof centers !== 'object') return []
  return Object.entries(centers).flatMap(([agency, points]) => (Array.isArray(points) ? points : []).map(point => ({
    agency, hours: toNumber(point?.[0]), time: formatNmcTime(point?.[1]), lon: toNumber(point?.[2]), lat: toNumber(point?.[3]),
    pressureHpa: toNumber(point?.[4]), windSpeedMs: toNumber(point?.[5]), level: point?.[7] || '', levelLabel: LEVEL_LABELS[point?.[7]] || point?.[7] || '',
  })).filter(point => point.lon != null && point.lat != null))
}

export function parseTyphoonDetail(payload = {}) {
  const typhoon = payload?.typhoon
  if (!Array.isArray(typhoon)) return null
  const track = (Array.isArray(typhoon[8]) ? typhoon[8] : []).map(parsePoint).filter(Boolean)
  if (!track.length) return null
  const current = track[track.length - 1]
  const latestRaw = typhoon[8][typhoon[8].length - 1]
  const forecasts = parseForecasts(latestRaw)
  return {
    id: String(typhoon[0]), englishName: typhoon[1] || '', name: typhoon[2] || typhoon[1] || '未命名台风',
    number: String(typhoon[3] || typhoon[4] || ''), status: typhoon[7] || '',
    active: typhoon[7] === 'start', current, track: track.slice(-48), forecasts,
    updatedAt: latestRaw?.[12]?.[1] || current.time,
  }
}

export function parseTyphoonList(payload = {}) {
  const rows = Array.isArray(payload?.typhoonList) ? payload.typhoonList : []
  return rows.map(row => ({ id: String(row?.[0] || ''), status: row?.[7] || '', name: row?.[2] || row?.[1] || '' }))
    .filter(item => item.id && item.status === 'start')
}

async function fetchTyphoons() {
  const year = new Date().getFullYear()
  const listPayload = await fetchJsonp(`${NMC_BASE}/list_${year}?t=${Date.now()}`)
  const active = parseTyphoonList(listPayload)
  const details = await Promise.all(active.slice(0, 6).map(async item => {
    const detail = await fetchJsonp(`${NMC_BASE}/view_${encodeURIComponent(item.id)}?t=${Date.now()}`)
    return parseTyphoonDetail(detail)
  }))
  return {
    ok: true, source: '中央气象台台风网', sourceUrl: 'https://typhoon.nmc.cn/',
    fetchedAt: new Date().toISOString(), fetchedAtMs: Date.now(), refreshMinutes: 10,
    typhoons: details.filter(Boolean),
  }
}

export async function getTyphoons({ force = false, viewed = false } = {}) {
  if (viewed) noteTyphoonPanelViewed()
  if (!force && cache && Date.now() - cache.fetchedAtMs < CACHE_TTL_MS) return cache
  if (inFlight) return inFlight
  inFlight = fetchTyphoons().then(result => {
    cache = result
    return result
  }).catch(err => {
    if (cache) return { ...cache, stale: true, error: err.message }
    throw err
  }).finally(() => { inFlight = null })
  return inFlight
}

export function noteTyphoonPanelViewed() {
  // viewed 只表示页面正在取数，不能被当成一次新的“打开面板”事件。
  // 仅在面板已经明确处于打开状态时刷新兼容 TTL。
  if (panelState.active) panelActiveUntilMs = Date.now() + PANEL_CONTEXT_TTL_MS
  return getTyphoonPanelState()
}

export function setTyphoonPanelState({ active, source = 'unknown' } = {}) {
  if (typeof active !== 'boolean') return getTyphoonPanelState()
  const now = Date.now()
  const justOpened = active && !panelState.active
  panelState = {
    active,
    updatedAtMs: now,
    openedAtMs: justOpened ? now : (active ? panelState.openedAtMs : 0),
    openEventPending: justOpened ? true : (active ? panelState.openEventPending : false),
    source,
  }
  panelActiveUntilMs = active ? now + PANEL_CONTEXT_TTL_MS : 0
  return getTyphoonPanelState()
}

export function getTyphoonPanelState() {
  const now = Date.now()
  const remaining = Math.max(0, panelActiveUntilMs - now)
  const justOpened = panelState.active && panelState.openEventPending
  return {
    ...panelState,
    updatedAt: panelState.updatedAtMs ? new Date(panelState.updatedAtMs).toISOString() : null,
    openedAt: panelState.openedAtMs ? new Date(panelState.openedAtMs).toISOString() : null,
    justOpened,
    contextActive: panelState.active,
    contextTtlSeconds: panelState.active ? Math.round(remaining / 1000) : 0,
  }
}

export function consumeTyphoonPanelOpenEvent() {
  const state = getTyphoonPanelState()
  if (!state.justOpened) return null
  panelState = { ...panelState, openEventPending: false }
  return { openedAt: state.openedAt, source: state.source }
}

const TYPHOON_QUERY_RE = /台风|热带气旋|风圈|路径|登陆|台风预警/i

export async function buildTyphoonRuntimeContext(message = '') {
  const state = getTyphoonPanelState()
  if (!state.contextActive && !TYPHOON_QUERY_RE.test(String(message || ''))) return ''
  const data = await getTyphoons()
  const rows = data.typhoons.map(item => {
    const c = item.current
    return `${item.number ? `${item.number}号` : ''}${item.name}：${c.levelLabel}，${c.lat}°N ${c.lon}°E，中心气压 ${c.pressureHpa || '—'} hPa，近中心最大风速 ${c.windSpeedMs || '—'} m/s，${c.direction || '—'} ${c.moveSpeedKmh || '—'} km/h`
  })
  const openEvent = consumeTyphoonPanelOpenEvent()
  const panelLine = openEvent
    ? `Panel event: The typhoon monitoring panel was just opened at ${openEvent.openedAt}. This is a one-time opening event and has now been acknowledged.`
    : state.active
      ? `Panel state: The typhoon monitoring panel is currently open. It was opened at ${state.openedAt}; do not treat this as a new opening event.`
      : 'Panel state: The typhoon monitoring panel is not currently open; context was included because the user asked about typhoons.'
  if (!rows.length) return `## Typhoon Context\n${panelLine}\nSource: Central Meteorological Observatory typhoon feed. No active typhoons are currently listed by the source.`
  return `## Typhoon Context\n${panelLine}\nSource: Central Meteorological Observatory typhoon feed. This is system-fetched background, not a user request. Fetched at: ${data.fetchedAt}${data.stale ? ' (stale cache)' : ''}\n\n${rows.join('\n')}`
}
