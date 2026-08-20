'use strict'

const assert = require('node:assert/strict')
const {
  compareCaptures,
  describeValue,
  sanitizeHeaders,
  sanitizeUrl,
} = require('./network-audit-utils.cjs')

const secret = 'secret-account-token-123456789'
const cookie = 'a=private-cookie-value; session=private-session-value'
const url = sanitizeUrl(`https://www.example.com/api/user/1234567890?token=${secret}&keyword=%E7%A7%98%E5%AF%86#private`)
assert.equal(url.path, '/api/user/<dynamic:number:10:c775e7b757ed>')
assert.deepEqual(url.query.map(item => item.name), ['token', 'keyword'])
assert.equal(JSON.stringify(url).includes(secret), false)
assert.equal(JSON.stringify(url).includes('秘密'), false)

const headers = sanitizeHeaders({
  'User-Agent': 'Chrome/Test',
  Cookie: cookie,
  Authorization: `Bearer ${secret}`,
  'X-S': secret,
  'X-Unknown-Account': secret,
  Referer: `https://www.example.com/search?q=${secret}`,
})
const serializedHeaders = JSON.stringify(headers)
assert.match(serializedHeaders, /Chrome\/Test/)
assert.equal(serializedHeaders.includes(secret), false)
assert.equal(serializedHeaders.includes('private-cookie-value'), false)
assert.deepEqual(headers.fields.find(item => item.name === 'cookie').metadata.names, ['a', 'session'])
assert.equal(headers.fields.find(item => item.name === 'authorization').redacted, true)
assert.equal(headers.fields.find(item => item.name === 'x-s').redacted, true)
assert.equal(headers.fields.find(item => item.name === 'x-unknown-account').redacted, true)
assert.equal(headers.orderSource, 'cdp-object-enumeration')
assert.equal(sanitizeHeaders([{ name: 'Accept', value: '*/*' }]).orderSource, 'har-array')
assert.equal(describeValue(secret).length, Buffer.byteLength(secret))
const inlineImage = sanitizeUrl(`data:image/png;base64,${secret}`)
assert.equal(inlineImage.path, '<inline-data>')
assert.equal(JSON.stringify(inlineImage).includes(secret), false)
const blobUrl = sanitizeUrl(`blob:https://example.com/${secret}`)
assert.equal(blobUrl.path, '<opaque-blob-url>')
assert.equal(JSON.stringify(blobUrl).includes(secret), false)

const chromeHar = {
  log: {
    entries: [{
      startedDateTime: '2026-07-26T00:00:00.000Z',
      _resourceType: 'xhr',
      request: {
        method: 'POST',
        url: `https://www.example.com/api/search?token=${secret}`,
        headers: [
          { name: 'User-Agent', value: 'Mozilla/5.0 Chrome/140.0' },
          { name: 'Cookie', value: cookie },
        ],
        postData: { mimeType: 'application/json', text: `{"account":"${secret}"}` },
      },
      response: {
        status: 200,
        statusText: 'OK',
        httpVersion: 'h2',
        headers: [{ name: 'Set-Cookie', value: `session=${secret}; Secure` }],
        content: { mimeType: 'application/json' },
      },
      timings: { wait: 10 },
      serverIPAddress: '203.0.113.9',
      connection: 'conn-secret',
    }],
  },
}

const aliceCapture = {
  kind: 'alice-network-audit',
  source: 'electron-webcontents-cdp',
  pageSnapshots: [{ value: { navigator: { webdriver: true } } }],
  events: [
    {
      name: 'Network.requestWillBeSent',
      tMs: 0,
      requestKey: 'r1',
      data: {
        method: 'POST',
        url: sanitizeUrl(`https://www.example.com/api/search?token=${secret}`),
        resourceType: 'XHR',
        headers: sanitizeHeaders({
          'User-Agent': 'Mozilla/5.0 Electron/33.0',
          Cookie: cookie,
        }),
        hasUserGesture: false,
        postData: describeValue(`{"account":"${secret}"}`),
      },
    },
    {
      name: 'Network.responseReceived',
      tMs: 12,
      requestKey: 'r1',
      data: { status: 200, protocol: 'h2', headers: sanitizeHeaders({}) },
    },
  ],
}

const comparison = compareCaptures(chromeHar, aliceCapture)
assert.equal(comparison.chrome.requests, 1)
assert.equal(comparison.alice.requests, 1)
assert.ok(comparison.riskSignals.some(item => item.level === '极高' && /Electron/.test(item.signal)))
assert.ok(comparison.riskSignals.some(item => item.level === '极高' && /webdriver/.test(item.signal)))
assert.ok(comparison.riskSignals.some(item => /基线 HAR 不含此字段/.test(item.signal)))
assert.equal(JSON.stringify(comparison).includes(secret), false)
assert.equal(JSON.stringify(comparison).includes('private-cookie-value'), false)
assert.deepEqual(comparison.differences.endpointsOnlyInChrome, [])

const chromeCdpCapture = {
  ...aliceCapture,
  source: 'chrome-cdp-observer',
  pageSnapshots: [{ value: { navigator: { webdriver: true } } }],
  events: aliceCapture.events.map(event => ({
    ...event,
    data: event.name === 'Network.requestWillBeSent'
      ? {
          ...event.data,
          headers: sanitizeHeaders({ 'User-Agent': 'Mozilla/5.0 Chrome/151.0' }),
        }
      : event.data,
  })),
}
const bothWebdriverTrue = compareCaptures(chromeCdpCapture, aliceCapture)
assert.equal(
  bothWebdriverTrue.riskSignals.some(item => item.level === '极高' && /webdriver/.test(item.signal)),
  false,
)
assert.ok(bothWebdriverTrue.riskSignals.some(item => item.level === '低' && /两组.*webdriver/.test(item.signal)))

const explicitChromeFalse = {
  ...chromeCdpCapture,
  pageSnapshots: [{ value: { navigator: { webdriver: false } } }],
}
const onlyAliceTrue = compareCaptures(explicitChromeFalse, aliceCapture)
assert.ok(onlyAliceTrue.riskSignals.some(item => item.level === '极高' && /仅爱丽丝.*webdriver/.test(item.signal)))

console.log('network audit utility tests passed')
