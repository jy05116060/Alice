import assert from 'node:assert/strict'
import {
  assertWebUrlAllowed,
  isPrivateNetworkAddress,
  normalizeWebHttpUrl,
} from './capabilities/tools/web/url-policy.js'

assert.equal(normalizeWebHttpUrl('https://example.com/docs'), 'https://example.com/docs')
assert.throws(() => normalizeWebHttpUrl('file:///etc/passwd'), error => error?.code === 'URL_BLOCKED')
assert.throws(() => normalizeWebHttpUrl('https://user:secret@example.com'), error => error?.code === 'URL_BLOCKED')

for (const address of [
  '0.0.0.0',
  '10.0.0.1',
  '100.64.0.1',
  '127.0.0.1',
  '169.254.169.254',
  '172.16.0.1',
  '192.168.1.1',
  '198.18.0.1',
  '::',
  '::1',
  '::ffff:127.0.0.1',
  '::ffff:7f00:1',
  'fc00::1',
  'fe80::1',
]) {
  assert.equal(isPrivateNetworkAddress(address), true, `${address} should be private`)
}
assert.equal(isPrivateNetworkAddress('93.184.216.34'), false)
assert.equal(isPrivateNetworkAddress('2606:2800:220:1:248:1893:25c8:1946'), false)

await assert.rejects(
  assertWebUrlAllowed('http://localhost:3721'),
  error => error?.code === 'PRIVATE_NETWORK_BLOCKED',
)
await assert.rejects(
  assertWebUrlAllowed('https://intranet.example', {
    hostnameResolver: async () => [{ address: '10.20.30.40' }],
  }),
  error => error?.code === 'PRIVATE_NETWORK_BLOCKED',
)
assert.equal(
  await assertWebUrlAllowed('https://example.com/path', {
    hostnameResolver: async () => [{ address: '93.184.216.34' }],
  }),
  'https://example.com/path',
)
assert.equal(
  await assertWebUrlAllowed('http://127.0.0.1:3721', { allowPrivateNetwork: true }),
  'http://127.0.0.1:3721/',
)

console.log('test-web-url-policy passed')
