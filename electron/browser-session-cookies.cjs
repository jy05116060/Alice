'use strict'

const fs = require('node:fs')
const path = require('node:path')

const MAX_BACKUP_BYTES = 5 * 1024 * 1024
const MAX_SESSION_COOKIES = 5_000
const BACKUP_VERSION = 1

function cookieUrl(cookie) {
  const hostname = String(cookie?.domain || '').replace(/^\./, '')
  if (!hostname) throw new TypeError('cookie domain is unavailable')
  const pathname = String(cookie?.path || '/').startsWith('/') ? String(cookie.path || '/') : '/'
  return `${cookie?.secure ? 'https' : 'http'}://${hostname}${pathname}`
}

function restorableCookie(cookie) {
  return {
    url: cookieUrl(cookie),
    name: String(cookie.name || ''),
    value: String(cookie.value || ''),
    ...(cookie.domain ? { domain: String(cookie.domain) } : {}),
    path: String(cookie.path || '/'),
    secure: cookie.secure === true,
    httpOnly: cookie.httpOnly === true,
    ...(cookie.sameSite && cookie.sameSite !== 'unspecified' ? { sameSite: cookie.sameSite } : {}),
  }
}

function createBrowserSessionCookieStore({
  backupFile,
  getSession,
  safeStorage,
  logger = console,
  saveDelayMs = 250,
} = {}) {
  if (!backupFile) throw new TypeError('backupFile is required')
  if (typeof getSession !== 'function') throw new TypeError('getSession is required')
  if (!safeStorage) throw new TypeError('safeStorage is required')

  let timer = null
  let listening = false
  let saving = Promise.resolve()

  function encryptionAvailable() {
    try { return safeStorage.isEncryptionAvailable() === true } catch { return false }
  }

  async function saveNow() {
    if (!encryptionAvailable()) {
      logger.warn?.('[browser-profile] secure cookie storage is unavailable; session-cookie backup skipped')
      return { saved: 0, secure: false }
    }
    const targetSession = getSession()
    const cookies = await targetSession.cookies.get({})
    const sessionCookies = cookies.filter(cookie => cookie?.session === true).slice(0, MAX_SESSION_COOKIES)
    const payload = JSON.stringify({
      version: BACKUP_VERSION,
      cookies: sessionCookies.map(restorableCookie),
    })
    const encrypted = safeStorage.encryptString(payload)
    fs.mkdirSync(path.dirname(backupFile), { recursive: true })
    const temporary = `${backupFile}.tmp`
    fs.writeFileSync(temporary, encrypted, { mode: 0o600 })
    fs.renameSync(temporary, backupFile)
    return { saved: sessionCookies.length, secure: true }
  }

  function flush() {
    if (timer) {
      clearTimeout(timer)
      timer = null
    }
    const next = saving.catch(() => {}).then(saveNow)
    saving = next.then(() => undefined, () => undefined)
    return next
  }

  function scheduleSave() {
    if (timer) clearTimeout(timer)
    timer = setTimeout(() => {
      timer = null
      flush().catch(error => {
        logger.warn?.('[browser-profile] unable to persist session cookies:', error?.message || error)
      })
    }, Math.max(0, Number(saveDelayMs) || 0))
  }

  async function restore() {
    if (!encryptionAvailable()) return { restored: 0, secure: false }
    let encrypted
    try {
      const stat = fs.statSync(backupFile)
      if (!stat.isFile() || stat.size <= 0 || stat.size > MAX_BACKUP_BYTES) return { restored: 0, secure: true }
      encrypted = fs.readFileSync(backupFile)
    } catch (error) {
      if (error?.code === 'ENOENT') return { restored: 0, secure: true }
      throw error
    }
    const parsed = JSON.parse(safeStorage.decryptString(encrypted))
    const cookies = Array.isArray(parsed?.cookies) ? parsed.cookies.slice(0, MAX_SESSION_COOKIES) : []
    const targetSession = getSession()
    let restored = 0
    for (const cookie of cookies) {
      try {
        await targetSession.cookies.set(restorableCookie(cookie))
        restored += 1
      } catch {
        // A malformed or newly-invalid domain must not prevent other login
        // cookies from being restored.
      }
    }
    await targetSession.cookies.flushStore()
    return { restored, secure: true }
  }

  function start() {
    if (listening) return
    listening = true
    getSession().cookies.on('changed', scheduleSave)
  }

  return { restore, start, flush }
}

module.exports = {
  BACKUP_VERSION,
  MAX_BACKUP_BYTES,
  MAX_SESSION_COOKIES,
  cookieUrl,
  createBrowserSessionCookieStore,
  restorableCookie,
}
