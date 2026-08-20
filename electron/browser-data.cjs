'use strict'

const fs = require('fs')
const path = require('path')

const HISTORY_VERSION = 1
const MAX_HISTORY_ENTRIES = 20_000
const DATA_TYPES = new Set(['history', 'cookies', 'site_data', 'cache'])
const TIME_RANGES_MS = Object.freeze({
  last_hour: 60 * 60 * 1000,
  last_day: 24 * 60 * 60 * 1000,
  last_7_days: 7 * 24 * 60 * 60 * 1000,
  last_30_days: 30 * 24 * 60 * 60 * 1000,
})

function parseTimestamp(value, label) {
  if (value == null || value === '') return null
  const timestamp = Date.parse(String(value))
  if (!Number.isFinite(timestamp)) throw new TypeError(`${label} must be a valid ISO-8601 timestamp`)
  return timestamp
}

function normalizeOrigins(values) {
  if (values == null) return []
  if (!Array.isArray(values)) throw new TypeError('origins must be an array')
  return [...new Set(values.map(value => {
    const parsed = new URL(String(value || ''))
    if (!['http:', 'https:'].includes(parsed.protocol)) {
      throw new TypeError('origins must contain only HTTP(S) origins')
    }
    return parsed.origin
  }))]
}

function normalizeClearRequest(options = {}, now = Date.now()) {
  if (!options || typeof options !== 'object' || Array.isArray(options)) {
    throw new TypeError('browser data clear options must be an object')
  }
  if (!Array.isArray(options.dataTypes) || options.dataTypes.length === 0) {
    throw new TypeError('dataTypes must contain at least one browser data type')
  }
  const dataTypes = [...new Set(options.dataTypes.map(value => String(value || '').trim().toLowerCase()))]
  const unsupported = dataTypes.filter(value => !DATA_TYPES.has(value))
  if (unsupported.length) throw new TypeError(`unsupported browser data type: ${unsupported.join(', ')}`)

  const timeRange = String(options.timeRange || '').trim().toLowerCase()
  if (!['last_hour', 'last_day', 'last_7_days', 'last_30_days', 'all_time', 'custom'].includes(timeRange)) {
    throw new TypeError('timeRange must be last_hour, last_day, last_7_days, last_30_days, all_time, or custom')
  }

  let since = Number.NEGATIVE_INFINITY
  let before = Number.POSITIVE_INFINITY
  if (timeRange === 'custom') {
    since = parseTimestamp(options.since, 'since')
    before = parseTimestamp(options.before, 'before') ?? Number(now)
    if (since == null) throw new TypeError('since is required for a custom time range')
    if (since >= before) throw new RangeError('since must be earlier than before')
  } else if (timeRange !== 'all_time') {
    since = Number(now) - TIME_RANGES_MS[timeRange]
    before = Number(now)
  }

  const profileDataTypes = dataTypes.filter(value => value !== 'history')
  if (profileDataTypes.length && timeRange !== 'all_time') {
    const error = new Error('Electron cannot reliably clear cookies, login/site data, or cache by creation time; use all_time or clear history only')
    error.code = 'PROFILE_TIME_RANGE_UNSUPPORTED'
    throw error
  }

  return Object.freeze({
    dataTypes,
    timeRange,
    since,
    before,
    origins: normalizeOrigins(options.origins),
  })
}

function entryOrigin(entry) {
  try { return new URL(entry.url).origin } catch { return '' }
}

function createBrowserDataStore({
  historyFile,
  getSession,
  now = () => Date.now(),
  logger = console,
} = {}) {
  if (!historyFile) throw new TypeError('historyFile is required')
  if (typeof getSession !== 'function') throw new TypeError('getSession is required')

  let loaded = false
  let history = []

  function loadHistory() {
    if (loaded) return history
    loaded = true
    try {
      const parsed = JSON.parse(fs.readFileSync(historyFile, 'utf8'))
      const entries = Array.isArray(parsed) ? parsed : parsed?.entries
      history = (Array.isArray(entries) ? entries : [])
        .filter(entry => entry && typeof entry.url === 'string' && Number.isFinite(entry.visitedAt))
        .slice(-MAX_HISTORY_ENTRIES)
    } catch (error) {
      if (error?.code !== 'ENOENT') logger.warn?.('[browser-data] unable to read history:', error?.message || error)
      history = []
    }
    return history
  }

  function persistHistory() {
    fs.mkdirSync(path.dirname(historyFile), { recursive: true })
    const temporary = `${historyFile}.tmp`
    fs.writeFileSync(temporary, JSON.stringify({ version: HISTORY_VERSION, entries: history }, null, 2))
    fs.renameSync(temporary, historyFile)
  }

  function recordVisit({ url, title = '', visitedAt = now() } = {}) {
    let normalizedUrl
    try {
      const parsed = new URL(String(url || ''))
      if (!['http:', 'https:'].includes(parsed.protocol)) return false
      normalizedUrl = parsed.href
    } catch {
      return false
    }
    const timestamp = Number(visitedAt)
    if (!Number.isFinite(timestamp)) return false
    loadHistory()
    const previous = history.at(-1)
    const entry = {
      url: normalizedUrl,
      title: String(title || '').trim().slice(0, 500),
      visitedAt: timestamp,
    }
    if (previous?.url === entry.url && Math.abs(previous.visitedAt - timestamp) < 2_000) {
      history[history.length - 1] = { ...previous, ...entry, title: entry.title || previous.title || '' }
    } else {
      history.push(entry)
      if (history.length > MAX_HISTORY_ENTRIES) history = history.slice(-MAX_HISTORY_ENTRIES)
    }
    try { persistHistory() } catch (error) {
      logger.warn?.('[browser-data] unable to persist history:', error?.message || error)
      return false
    }
    return true
  }

  async function clearData(options = {}) {
    const request = normalizeClearRequest(options, now())
    const result = {
      ok: true,
      dataTypes: request.dataTypes,
      timeRange: request.timeRange,
      origins: request.origins,
      historyEntriesRemoved: 0,
      profileDataCleared: [],
    }

    if (request.dataTypes.includes('history')) {
      loadHistory()
      const originalLength = history.length
      const originFilter = new Set(request.origins)
      history = history.filter(entry => {
        const inTimeRange = entry.visitedAt >= request.since && entry.visitedAt < request.before
        const inOriginScope = originFilter.size === 0 || originFilter.has(entryOrigin(entry))
        return !(inTimeRange && inOriginScope)
      })
      result.historyEntriesRemoved = originalLength - history.length
      persistHistory()
    }

    const electronDataTypes = []
    if (request.dataTypes.includes('cookies')) electronDataTypes.push('cookies')
    if (request.dataTypes.includes('site_data')) {
      electronDataTypes.push('fileSystems', 'indexedDB', 'localStorage', 'serviceWorkers', 'webSQL')
    }
    if (request.dataTypes.includes('cache')) electronDataTypes.push('cache')
    if (electronDataTypes.length) {
      const targetSession = getSession()
      if (!targetSession || typeof targetSession.clearData !== 'function') {
        throw new Error('persistent browser session is unavailable')
      }
      await targetSession.clearData({
        dataTypes: [...new Set(electronDataTypes)],
        ...(request.origins.length ? {
          origins: request.origins,
          originMatchingMode: 'origin-in-all-contexts',
        } : {}),
      })
      if (request.dataTypes.includes('cookies')) await targetSession.cookies?.flushStore?.()
      result.profileDataCleared = request.dataTypes.filter(value => value !== 'history')
    }
    return result
  }

  function getHistoryForTest() {
    return loadHistory().map(entry => ({ ...entry }))
  }

  return { recordVisit, clearData, getHistoryForTest }
}

module.exports = {
  DATA_TYPES,
  TIME_RANGES_MS,
  createBrowserDataStore,
  normalizeClearRequest,
}
