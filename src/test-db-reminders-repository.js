import assert from 'node:assert/strict'
import { runRepositoryTest } from './test-db-repository-helper.js'

await runRepositoryTest('db-reminders', async () => {
  const reminders = await import('./db/repositories/reminders.js')
  const first = reminders.createReminder({
    userId: '000001',
    dueAt: '2026-07-13T08:00:00.000Z',
    task: 'first task',
    systemMessage: 'first message',
  })
  const second = reminders.createReminder({
    userId: 'ID:000001',
    dueAt: '2026-07-13T09:00:00.000Z',
    task: 'second task',
    systemMessage: 'second message',
    recurrenceType: 'daily',
    recurrenceConfig: { hour: 9 },
  })

  assert.equal(reminders.getReminderById(first.lastInsertRowid).user_id, 'ID:000001')
  assert.equal(reminders.findMergeableOneOffReminder('000001', '2026-07-13T08:00').id, first.lastInsertRowid)
  assert.equal(reminders.appendReminderTask(first.lastInsertRowid, 'extra', 'merged').changes, 1)
  assert.equal(reminders.getDueReminders('2026-07-13T08:30:00.000Z')[0].task, 'first task; extra')
  assert.equal(reminders.getNextPendingReminder().id, first.lastInsertRowid)
  assert.equal(reminders.advanceReminderDueAt(second.lastInsertRowid, '2026-07-14T09:00:00.000Z').changes, 1)
  assert.equal(reminders.markReminderFired(first.lastInsertRowid, '2026-07-13T08:01:00.000Z').changes, 1)
  assert.equal(reminders.cancelReminder(second.lastInsertRowid, '2026-07-13T08:02:00.000Z').changes, 1)
  assert.deepEqual(reminders.listPendingReminders(), [])
  assert.equal(reminders.getReminderById(999999), null)
})
