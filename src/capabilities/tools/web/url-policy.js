import dns from 'node:dns/promises'
import net from 'node:net'

export class WebUrlPolicyError extends Error {
  constructor(code, message, cause) {
    super(message, cause ? { cause } : undefined)
    this.name = 'WebUrlPolicyError'
    this.code = code
  }
}

export function normalizeWebHttpUrl(value, { optional = false, allowAboutBlank = false } = {}) {
  if ((value === undefined || value === null || value === '') && optional) return null
  const raw = String(value || '').trim()
  if (allowAboutBlank && raw === 'about:blank') return raw

  let parsed
  try {
    parsed = new URL(raw)
  } catch {
    throw new WebUrlPolicyError('INVALID_ARGUMENT', `Invalid URL: ${raw}`)
  }
  if (!['http:', 'https:'].includes(parsed.protocol)) {
    throw new WebUrlPolicyError('URL_BLOCKED', `Unsupported URL protocol: ${parsed.protocol}`)
  }
  if (parsed.username || parsed.password) {
    throw new WebUrlPolicyError('URL_BLOCKED', 'URLs containing credentials are not allowed')
  }
  return parsed.href
}

export function isPrivateNetworkAddress(address) {
  const value = String(address || '').toLowerCase().split('%')[0]
  if (net.isIP(value) === 4) {
    const bytes = value.split('.').map(Number)
    return bytes[0] === 10 || bytes[0] === 127 || bytes[0] === 0
      || (bytes[0] === 169 && bytes[1] === 254)
      || (bytes[0] === 172 && bytes[1] >= 16 && bytes[1] <= 31)
      || (bytes[0] === 192 && bytes[1] === 168)
      || (bytes[0] === 100 && bytes[1] >= 64 && bytes[1] <= 127)
      || (bytes[0] === 198 && [18, 19].includes(bytes[1]))
      || bytes[0] >= 224
  }
  if (net.isIP(value) === 6) {
    if (value.startsWith('::ffff:') && net.isIP(value.slice(7)) === 4) {
      return isPrivateNetworkAddress(value.slice(7))
    }
    const mappedHex = value.match(/^::ffff:([0-9a-f]{1,4}):([0-9a-f]{1,4})$/)
    if (mappedHex) {
      const high = Number.parseInt(mappedHex[1], 16)
      const low = Number.parseInt(mappedHex[2], 16)
      return isPrivateNetworkAddress(`${high >> 8}.${high & 255}.${low >> 8}.${low & 255}`)
    }
    return value === '::' || value === '::1' || value.startsWith('fc') || value.startsWith('fd')
      || /^fe[89ab]/.test(value) || value.startsWith('ff')
      || value.startsWith('::ffff:127.') || value.startsWith('::ffff:10.')
      || value.startsWith('::ffff:192.168.')
  }
  return false
}

export async function assertWebUrlAllowed(value, options = {}) {
  const normalized = normalizeWebHttpUrl(value, {
    optional: options.optional,
    allowAboutBlank: options.allowAboutBlank,
  })
  if (normalized === null || normalized === 'about:blank') return normalized

  const allowPrivateNetwork = typeof options.allowPrivateNetwork === 'function'
    ? options.allowPrivateNetwork() === true
    : options.allowPrivateNetwork === true
  if (allowPrivateNetwork) return normalized

  const parsed = new URL(normalized)
  const hostname = parsed.hostname.replace(/^\[|\]$/g, '').toLowerCase()
  if (hostname === 'localhost' || hostname.endsWith('.localhost') || isPrivateNetworkAddress(hostname)) {
    throw new WebUrlPolicyError('PRIVATE_NETWORK_BLOCKED', `Private or local network URL is disabled: ${parsed.hostname}`)
  }

  const resolver = options.hostnameResolver || (name => dns.lookup(name, { all: true, verbatim: true }))
  let addresses
  try {
    addresses = await resolver(hostname)
  } catch (error) {
    throw new WebUrlPolicyError('DNS_FAILED', `Could not resolve browser URL host: ${hostname}`, error)
  }
  const records = Array.isArray(addresses) ? addresses : [addresses]
  if (records.length === 0) {
    throw new WebUrlPolicyError('DNS_FAILED', `Browser URL host returned no addresses: ${hostname}`)
  }
  if (records.some(record => isPrivateNetworkAddress(record?.address || record))) {
    throw new WebUrlPolicyError('PRIVATE_NETWORK_BLOCKED', `Browser URL resolves to a private or local address: ${hostname}`)
  }
  return normalized
}
