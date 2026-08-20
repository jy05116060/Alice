import assert from 'node:assert/strict'
import { runRepositoryTest } from './test-db-repository-helper.js'

await runRepositoryTest('db-audits', async () => {
  const audits = await import('./db/repositories/audits.js')

  audits.insertRecallAudit({
    turn_label: 'turn-1',
    query_text: 'query',
    matched_mem_ids: ['mem-1', 'mem-2'],
    chosen_count: 1,
    latency_ms: 12,
  })
  audits.insertExtractAudit({
    turn_label: 'turn-1',
    turn_summary: 'summary',
    extracted_mem_ids: ['mem-3'],
    skipped: true,
    skip_reason: 'test',
  })

  assert.equal(audits.getRecentRecallAudits()[0].matched_count, 2)
  assert.equal(audits.getRecentExtractAudits()[0].extracted_count, 1)
  assert.equal(audits.getRecallAuditStats().total, 1)
  assert.equal(audits.getRecallAuditStats().avg_chosen, 1)
  assert.equal(audits.getExtractAuditStats().total, 1)
  assert.equal(audits.getExtractAuditStats().skipped_count, 1)
})
