import assert from 'node:assert/strict'
import { runRepositoryTest } from './test-db-repository-helper.js'

await runRepositoryTest('db-thread-state', async () => {
  const repository = await import('./db/repositories/thread-state.js')
  const now = new Date().toISOString()

  repository.saveFocusStack([{
    topic: ['refactor'],
    startedAt: now,
    startedAtTick: 1,
    lastSeenTick: 2,
    hitCount: 3,
    conclusions: ['repository boundary'],
  }])
  assert.deepEqual(repository.loadFocusStack(), [{
    topic: ['refactor'],
    startedAt: now,
    startedAtTick: 1,
    lastSeenTick: 2,
    hitCount: 3,
    conclusions: ['repository boundary'],
  }])

  repository.saveThreadState({
    threads: [{
      id: 'thread-1',
      topic: ['database'],
      signature: ['database', 'refactor'],
      label: 'DB refactor',
      createdAt: now,
      lastEventAt: now,
    }],
    foregroundId: 'thread-1',
    commitments: [{ id: 'commitment-1', threadId: 'thread-1', text: 'finish tests', createdAt: now }],
  })
  const state = repository.loadThreadState()
  assert.equal(state.foregroundId, 'thread-1')
  assert.deepEqual(state.threads[0].signature, ['database', 'refactor'])
  assert.equal(state.commitments[0].threadId, 'thread-1')
})
