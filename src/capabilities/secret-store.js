import crypto from 'crypto'
import fs from 'fs'
import path from 'path'
import { createRequire } from 'module'
import { paths } from '../paths.js'

const STORE_VERSION = 1
const SAFE_STORAGE_SCHEME = 'electron-safe-storage'
const FALLBACK_SCHEME = 'aes-256-gcm'
const PLAIN_SCHEME = 'plain'
const require = createRequire(import.meta.url)

function nowIso() {
  return new Date().toISOString()
}

function readJsonFile(file, fallback) {
  try {
    const parsed = JSON.parse(fs.readFileSync(file, 'utf-8'))
    return parsed && typeof parsed === 'object' ? parsed : fallback
  } catch {
    return fallback
  }
}

function writeJsonFile(file, value) {
  const tmp = `${file}.tmp`
  fs.mkdirSync(path.dirname(file), { recursive: true })
  fs.writeFileSync(tmp, JSON.stringify(value, null, 2), { encoding: 'utf-8', mode: 0o600 })
  try { fs.chmodSync(tmp, 0o600) } catch {}
  fs.renameSync(tmp, file)
}

function readStore() {
  const parsed = readJsonFile(paths.apiCapabilitySecretsFile, null)
  if (parsed && parsed.version === STORE_VERSION && parsed.secrets && typeof parsed.secrets === 'object') {
    return migratePlainSecrets(parsed)
  }
  return { version: STORE_VERSION, secrets: {} }
}

function migratePlainSecrets(store) {
  let changed = false
  const secrets = store?.secrets && typeof store.secrets === 'object' ? store.secrets : {}
  for (const [key, record] of Object.entries(secrets)) {
    if (!record || record.scheme !== PLAIN_SCHEME) continue
    const value = String(record.value || '')
    if (!value) continue
    secrets[key] = {
      ...encryptSecret(value),
      updatedAt: nowIso(),
    }
    changed = true
  }
  if (changed) writeStore(store)
  return store
}

function writeStore(store) {
  writeJsonFile(paths.apiCapabilitySecretsFile, {
    version: STORE_VERSION,
    secrets: store?.secrets && typeof store.secrets === 'object' ? store.secrets : {},
  })
}

function getSafeStorage() {
  if (!process.versions?.electron) return null
  try {
    const safeStorage = require('electron')?.safeStorage
    if (safeStorage?.isEncryptionAvailable?.()) return safeStorage
  } catch {}
  return null
}

function approveSafeStorageAccess(purpose = 'saved-secrets') {
  const request = globalThis.aliceRequestSafeStorageAccessSync
  if (typeof request !== 'function') return true
  try { return request(purpose) === true } catch { return false }
}

function readFallbackMasterKey() {
  try {
    const raw = fs.readFileSync(paths.apiCapabilitySecretKeyFile, 'utf-8').trim()
    const key = Buffer.from(raw, 'base64')
    if (key.length >= 32) return key.subarray(0, 32)
  } catch {}

  const key = crypto.randomBytes(32)
  fs.mkdirSync(path.dirname(paths.apiCapabilitySecretKeyFile), { recursive: true })
  fs.writeFileSync(paths.apiCapabilitySecretKeyFile, key.toString('base64'), { encoding: 'utf-8', mode: 0o600 })
  try { fs.chmodSync(paths.apiCapabilitySecretKeyFile, 0o600) } catch {}
  return key
}

function encryptSecret(value) {
  const text = String(value || '')
  const safeStorage = getSafeStorage()
  if (safeStorage && approveSafeStorageAccess('saved-secrets')) {
    return {
      scheme: SAFE_STORAGE_SCHEME,
      value: safeStorage.encryptString(text).toString('base64'),
    }
  }

  const key = readFallbackMasterKey()
  const iv = crypto.randomBytes(12)
  const cipher = crypto.createCipheriv(FALLBACK_SCHEME, key, iv)
  const encrypted = Buffer.concat([cipher.update(text, 'utf-8'), cipher.final()])
  return {
    scheme: FALLBACK_SCHEME,
    iv: iv.toString('base64'),
    tag: cipher.getAuthTag().toString('base64'),
    value: encrypted.toString('base64'),
  }
}

function decryptSecret(record) {
  if (!record || typeof record !== 'object') return ''
  try {
    if (record.scheme === SAFE_STORAGE_SCHEME) {
      if (!approveSafeStorageAccess('saved-secrets')) return ''
      const safeStorage = getSafeStorage()
      if (!safeStorage) return ''
      return safeStorage.decryptString(Buffer.from(String(record.value || ''), 'base64'))
    }
    if (record.scheme === FALLBACK_SCHEME) {
      const key = readFallbackMasterKey()
      const decipher = crypto.createDecipheriv(FALLBACK_SCHEME, key, Buffer.from(String(record.iv || ''), 'base64'))
      decipher.setAuthTag(Buffer.from(String(record.tag || ''), 'base64'))
      return Buffer.concat([
        decipher.update(Buffer.from(String(record.value || ''), 'base64')),
        decipher.final(),
      ]).toString('utf-8')
    }
    if (record.scheme === PLAIN_SCHEME) return String(record.value || '')
  } catch {}
  return ''
}

export function setSecret(ref, value) {
  const key = String(ref || '').trim()
  const secret = String(value || '')
  if (!key) throw new Error('secret ref required')
  if (!secret) {
    deleteSecret(key)
    return false
  }
  const store = readStore()
  store.secrets[key] = {
    ...encryptSecret(secret),
    updatedAt: nowIso(),
  }
  writeStore(store)
  return true
}

export function getSecret(ref) {
  const key = String(ref || '').trim()
  if (!key) return ''
  return decryptSecret(readStore().secrets[key])
}

export function hasSecret(ref) {
  const key = String(ref || '').trim()
  if (!key) return false
  const store = readJsonFile(paths.apiCapabilitySecretsFile, null)
  const record = store?.version === STORE_VERSION && store?.secrets?.[key]
  // Configuration/status checks must not decrypt a value: they run during
  // startup and must never trigger a macOS Keychain password prompt.
  return Boolean(record && typeof record === 'object' && String(record.value || ''))
}

export function deleteSecret(ref) {
  const key = String(ref || '').trim()
  if (!key) return false
  const store = readStore()
  if (!Object.prototype.hasOwnProperty.call(store.secrets, key)) return false
  delete store.secrets[key]
  writeStore(store)
  return true
}

export const __internal = {
  FALLBACK_SCHEME,
  PLAIN_SCHEME,
  SAFE_STORAGE_SCHEME,
  decryptSecret,
  encryptSecret,
}
