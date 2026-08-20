import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { runComparison } from './compare-network-captures.mjs'

const testRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'alice-network-compare-'))
try {
  const secret = 'comparison-input-secret'
  const chromeFile = path.join(testRoot, 'chrome.har')
  const aliceFile = path.join(testRoot, 'alice.json')
  const reportFile = path.join(testRoot, 'report.md')
  const jsonFile = path.join(testRoot, 'comparison.json')
  fs.writeFileSync(chromeFile, JSON.stringify({
    log: {
      entries: [{
        startedDateTime: '2026-07-26T00:00:00.000Z',
        request: {
          method: 'GET',
          url: `https://example.com/search?token=${secret}`,
          headers: [{ name: 'User-Agent', value: 'Chrome/Test' }],
        },
        response: { status: 200, httpVersion: 'h2', headers: [], content: {} },
      }],
    },
  }))
  fs.writeFileSync(aliceFile, JSON.stringify({
    kind: 'alice-network-audit',
    source: 'electron-webcontents-cdp',
    events: [{
      name: 'Network.requestWillBeSent',
      requestKey: 'r1',
      tMs: 0,
      data: {
        method: 'GET',
        url: {
          scheme: 'https',
          host: 'example.com',
          port: null,
          path: '/search',
          query: [{ name: 'token', value: { present: true, length: secret.length, sha256: 'redacted' } }],
        },
        headers: {
          order: ['user-agent'],
          fields: [{ name: 'user-agent', redacted: false, value: 'Electron/Test' }],
        },
      },
    }],
  }))

  const result = runComparison({
    chrome: chromeFile,
    alice: aliceFile,
    output: reportFile,
    'json-output': jsonFile,
  })
  assert.equal(fs.existsSync(reportFile), true)
  assert.equal(fs.existsSync(jsonFile), true)
  assert.match(result.report, /执行摘要/)
  assert.match(result.report, /采集工具自身污染/)
  assert.equal(fs.readFileSync(reportFile, 'utf8').includes(secret), false)
  assert.equal(fs.readFileSync(jsonFile, 'utf8').includes(secret), false)
  console.log('network capture comparison CLI tests passed')
} finally {
  if (path.basename(testRoot).startsWith('alice-network-compare-')) {
    fs.rmSync(testRoot, { recursive: true, force: true })
  }
}
