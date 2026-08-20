import { deleteSecret, getSecret, hasSecret, setSecret } from './capabilities/secret-store.js'

const PROVIDER = 'amap'
const KEY_REF = 'map-service:amap:js-key'
const SECURITY_REF = 'map-service:amap:security-code'

export function getMapServiceSettings() {
  const keyConfigured = hasSecret(KEY_REF)
  const securityConfigured = hasSecret(SECURITY_REF)
  return {
    provider: PROVIDER,
    configured: keyConfigured && securityConfigured,
    keyConfigured,
    securityConfigured,
  }
}

export function setMapServiceSettings({ jsKey, securityCode, clear = false } = {}) {
  if (clear) {
    deleteSecret(KEY_REF)
    deleteSecret(SECURITY_REF)
    return getMapServiceSettings()
  }

  const key = String(jsKey || '').trim()
  const code = String(securityCode || '').trim()
  if (key) setSecret(KEY_REF, key)
  if (code) setSecret(SECURITY_REF, code)
  return getMapServiceSettings()
}

export function getMapRuntimeConfig() {
  const settings = getMapServiceSettings()
  return {
    provider: PROVIDER,
    configured: settings.configured,
    jsKey: settings.configured ? getSecret(KEY_REF) : '',
    servicePath: '/_AMapService',
  }
}

export function getAmapSecurityCode() {
  return getSecret(SECURITY_REF)
}

