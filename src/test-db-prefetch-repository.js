import assert from 'node:assert/strict'
import { runRepositoryTest } from './test-db-repository-helper.js'

await runRepositoryTest('db-prefetch', async ({ getDB }) => {
  const prefetch = await import('./db/repositories/prefetch.js')

  prefetch.savePrefetchCache('weather', 'sunny', 60, ['daily'])
  assert.equal(prefetch.getValidPrefetchCache()[0].content, 'sunny')
  getDB().prepare(`UPDATE prefetch_cache SET expires_at = ? WHERE source = ?`)
    .run('2000-01-01T00:00:00.000Z', 'weather')
  prefetch.clearExpiredPrefetchCache()
  assert.equal(getDB().prepare(`SELECT COUNT(*) AS count FROM prefetch_cache`).get().count, 0)

  prefetch.upsertPrefetchTask({ source: 'news', label: 'News', url: 'https://example.com', tags: ['headlines'] })
  prefetch.upsertPrefetchTask({ source: 'news', label: 'Daily News', url: 'https://example.com/daily', ttlMinutes: 30 })
  assert.equal(prefetch.listPrefetchTasks()[0].label, 'Daily News')
  assert.equal(prefetch.getEnabledPrefetchTasks().length, 1)
  assert.equal(prefetch.removePrefetchTask('news'), true)
  assert.equal(prefetch.removePrefetchTask('missing'), false)
})
