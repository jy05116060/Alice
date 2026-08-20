'use strict'

const assert = require('node:assert/strict')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const { createBrowserDataStore, normalizeClearRequest } = require('./browser-data.cjs')

async function run() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'alice-browser-data-'))
  const nowMs = Date.parse('2026-07-26T05:00:00.000Z')
  const clearCalls = []
  const targetSession = {
    clearData: async options => clearCalls.push(options),
    cookies: { flushStore: async () => { targetSession.flushed = true } },
  }
  const store = createBrowserDataStore({
    historyFile: path.join(root, 'browser', 'history.json'),
    getSession: () => targetSession,
    now: () => nowMs,
  })

  store.recordVisit({ url: 'https://old.example/path', title: 'Old', visitedAt: nowMs - 8 * 24 * 60 * 60 * 1000 })
  store.recordVisit({ url: 'https://recent.example/a', title: 'Recent', visitedAt: nowMs - 30 * 60 * 1000 })
  store.recordVisit({ url: 'https://recent.example/b', title: 'Recent 2', visitedAt: nowMs - 5 * 60 * 1000 })
  assert.equal(store.getHistoryForTest().length, 3)

  const recentResult = await store.clearData({ dataTypes: ['history'], timeRange: 'last_hour' })
  assert.equal(recentResult.historyEntriesRemoved, 2)
  assert.deepEqual(store.getHistoryForTest().map(entry => entry.url), ['https://old.example/path'])
  assert.equal(clearCalls.length, 0, 'history deletion does not touch the persistent Electron profile')

  await store.clearData({
    dataTypes: ['cookies', 'site_data'],
    timeRange: 'all_time',
    origins: ['https://example.com/path'],
  })
  assert.deepEqual(clearCalls, [{
    dataTypes: ['cookies', 'fileSystems', 'indexedDB', 'localStorage', 'serviceWorkers', 'webSQL'],
    origins: ['https://example.com'],
    originMatchingMode: 'origin-in-all-contexts',
  }])
  assert.equal(targetSession.flushed, true)

  assert.throws(
    () => normalizeClearRequest({ dataTypes: ['cookies'], timeRange: 'last_hour' }, nowMs),
    error => error?.code === 'PROFILE_TIME_RANGE_UNSUPPORTED',
    'cookie/login deletion must never silently widen a requested time range',
  )
  assert.throws(
    () => normalizeClearRequest({ dataTypes: ['history'], timeRange: 'custom', since: 'not-a-date' }, nowMs),
    /ISO-8601/,
  )

  fs.rmSync(root, { recursive: true, force: true })
  console.log('browser data tests passed')
}

run().catch(error => {
  console.error(error)
  process.exitCode = 1
})
