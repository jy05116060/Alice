import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

// 调度增强的落库/工具层测试（阶段 4）。用临时库，不碰真实数据：
//   npm run test-schedule
// 纯递推算法（cron / 时区 / DST）在 test-recurrence.js，那边不需要数据库。
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'blm-schedule-'))
process.env.ALICE_USER_DIR = tmp
process.env.ALICE_RESOURCES_DIR = process.cwd()

let closeDBForTest = null

try {
  const dbModule = await import('./db.js')
  closeDBForTest = dbModule.closeDBForTest
  const { execManageReminder } = await import('./capabilities/tools/reminders.js')
  const { buildReminderMessage, groupRunsByTarget, reminderRunIdsOf } = await import('./runtime/reminder-delivery.js')
  const { mostRecentMissedOccurrence, nextOccurrence } = await import('./runtime/recurrence.js')

  const ctx = { visibleTargetIds: ['ID:000001'] }

  // ── 1. 用工具建 cron 提醒：表达式被规范化后入库 ──────────────────────
  {
    const out = await execManageReminder({
      action: 'create', kind: 'cron', cron: '@daily', task: '每天早上汇报天气',
      timezone: 'Asia/Shanghai',
    }, ctx)
    assert.match(out, /周期提醒已创建/, `创建应成功，got: ${out}`)
    assert.match(out, /cron 0 0 \* \* \*/, 'list 文案要显示规范化后的表达式')
    assert.match(out, /Asia\/Shanghai/, '跨时区要标出时区')

    const rows = dbModule.listPendingReminders(10)
    const cron = rows.find(r => r.recurrence_type === 'cron')
    assert.ok(cron, 'cron 提醒应已入库')
    const config = JSON.parse(cron.recurrence_config)
    assert.equal(config.cron, '0 0 * * *', '宏在入库前展开成五字段')
    assert.equal(config.timezone, 'Asia/Shanghai', '时区随配置一起存')
    // 上海每天 0:00 = UTC 前一天 16:00
    assert.match(cron.due_at, /T16:00:00\.000Z$/, `due_at 必须是绝对时刻，got ${cron.due_at}`)
  }

  // ── 2. 秒级 interval ─────────────────────────────────────────────────
  {
    const out = await execManageReminder({
      action: 'create', kind: 'interval', seconds: 90, task: '每 90 秒看一眼队列',
    }, ctx)
    assert.match(out, /interval/, out)
    assert.match(out, /每 90 秒/)
    const row = dbModule.listPendingReminders(10).find(r => r.recurrence_type === 'interval')
    assert.equal(JSON.parse(row.recurrence_config).seconds, 90)
    const delta = Date.parse(row.due_at) - Date.now()
    assert.ok(delta > 80_000 && delta <= 95_000, `间隔 90 秒应落在未来 ~90 秒，got ${delta}ms`)
  }

  // ── 3. 坏输入：cron 写错 / 时区拼错 / 秒数不合法，都必须抛错且不写库 ──
  {
    const before = dbModule.listPendingReminders(50).length
    const cases = [
      [{ action: 'create', kind: 'cron', cron: '61 * * * *', task: 'x' }, /61|outside/],
      [{ action: 'create', kind: 'cron', cron: '* * * *', task: 'x' }, /5 fields|exactly/],
      [{ action: 'create', kind: 'cron', cron: '0 0 9 * * *', task: 'x' }, /interval/],
      [{ action: 'create', kind: 'daily', time: '09:00', timezone: 'Not/AZone', task: 'x' }, /unknown timezone/],
      [{ action: 'create', kind: 'interval', seconds: 1.5, task: 'x' }, /whole number/],
      [{ action: 'create', kind: 'interval', seconds: 0, task: 'x' }, /whole number/],
      [{ action: 'create', kind: 'nonsense', task: 'x' }, /unknown kind/],
    ]
    for (const [args, pattern] of cases) {
      let caught = null
      try { await execManageReminder(args, ctx) } catch (error) { caught = error }
      assert.ok(caught, `${JSON.stringify(args)} 应当抛错（而不是留下坏数据）`)
      assert.match(caught.message, pattern, `${JSON.stringify(args)} 的错误信息要说清原因，got: ${caught.message}`)
    }
    assert.equal(dbModule.listPendingReminders(50).length, before, '所有失败路径都不能写库')
  }

  // ── 4. update：原地改，保留 id 与历史 ────────────────────────────────
  {
    const created = await execManageReminder({
      action: 'create', kind: 'daily', time: '09:00', timezone: 'UTC', task: '原始任务',
    }, ctx)
    const id = Number(created.match(/#(\d+)/)[1])
    const original = dbModule.getReminderById(id)

    // 只改时间：kind 与 task 不动
    const updated = await execManageReminder({ action: 'update', id, time: '10:30' }, ctx)
    assert.match(updated, /已更新/, updated)
    assert.match(updated, /触发时间/)
    const after = dbModule.getReminderById(id)
    assert.equal(after.id, original.id, 'id 必须保持不变（历史与引用都挂在它上面）')
    assert.equal(after.task, '原始任务', '没让改的字段不能被顺手清掉')
    assert.equal(after.recurrence_type, 'daily', 'kind 不变')
    assert.equal(JSON.parse(after.recurrence_config).time, '10:30')
    assert.equal(JSON.parse(after.recurrence_config).timezone, 'UTC', '没让改的配置项要沿用')
    assert.equal(new Date(after.due_at).getUTCHours(), 10, '新时间真的生效了')
    assert.equal(new Date(after.due_at).getUTCMinutes(), 30)
    assert.ok(after.created_at === original.created_at)

    // 改任务
    await execManageReminder({ action: 'update', id, task: '改过的任务' }, ctx)
    assert.equal(dbModule.getReminderById(id).task, '改过的任务')

    // 换递推方式：daily → cron
    await execManageReminder({ action: 'update', id, kind: 'cron', cron: '*/30 * * * *' }, ctx)
    const asCron = dbModule.getReminderById(id)
    assert.equal(asCron.recurrence_type, 'cron')
    assert.equal(JSON.parse(asCron.recurrence_config).cron, '0,30 * * * *', '规范化存储把步长展开')

    // 没有任何要改的字段 → 明确拒绝，别假装成功
    const noop = await execManageReminder({ action: 'update', id }, ctx)
    assert.match(noop, /没有任何改动/)

    // 不存在的 id / 已取消的
    assert.match(await execManageReminder({ action: 'update', id: 99999, time: '10:00' }, ctx), /未找到/)
    dbModule.cancelReminder(id)
    assert.match(await execManageReminder({ action: 'update', id, time: '11:00' }, ctx), /无法修改/)
  }

  // ── 5. 投递历史：写入、按目标/提醒过滤、保留上限 ─────────────────────
  {
    assert.deepEqual(dbModule.listDeliveryHistory({ limit: 5 }), [], '干净状态没有回执')

    dbModule.recordDelivery({
      reminderId: 1, runId: 11, userId: 'ID:000001', channel: 'TUI',
      content: '早上好', delivered: true, verified: true,
    })
    dbModule.recordDelivery({
      reminderId: 1, runId: 12, userId: 'ID:000001', channel: 'TUI',
      content: '', delivered: false, verified: false, error: 'no verified delivery',
    })
    dbModule.recordDelivery({
      reminderId: 2, runId: 13, userId: 'ID:000002', channel: 'WECHAT',
      content: '另一个人的提醒', delivered: true, verified: true,
    })

    const all = dbModule.listDeliveryHistory({ limit: 10 })
    assert.equal(all.length, 3)
    assert.equal(all[0].reminder_id, 2, '倒序：最新的在前')
    const mine = dbModule.listDeliveryHistory({ limit: 10, userId: 'ID:000001' })
    assert.equal(mine.length, 2, '按目标过滤')
    const forOne = dbModule.listDeliveryHistory({ limit: 10, reminderId: 1 })
    assert.equal(forOne.length, 2, '按提醒过滤')
    const failed = dbModule.listDeliveryHistory({ limit: 10, reminderId: 1 }).find(r => r.delivered === 0)
    assert.equal(failed.error, 'no verified delivery', '失败也要留回执——用户问「为什么没到」时答案是这里')
    assert.equal(all.find(r => r.run_id === 11).verified, 1)

    // limit 被夹在合理范围（防止一次拉爆）
    assert.equal(dbModule.listDeliveryHistory({ limit: 99999 }).length, 3)

    // 保留上限：写 210 条后只留最近 200 条
    for (let i = 0; i < 210; i++) {
      dbModule.recordDelivery({ reminderId: 9, runId: 1000 + i, userId: 'ID:000001', content: `h${i}`, delivered: true, verified: true })
    }
    const kept = dbModule.listDeliveryHistory({ limit: 200 })
    assert.equal(kept.length, 200, '硬上限 200 条')
    assert.equal(kept[0].content, 'h209', '留下的必须是最新的那批')
    assert.equal(kept.some(r => r.run_id === 11), false, '最老的已被裁掉')
  }

  // ── 6. 漏跑补发：每个重复任务只补最近一次 ───────────────────────────
  {
    const now = new Date('2026-07-08T10:00:00.000Z')
    // 每天 UTC 9:00，停机从 7-06 09:00 到 7-08 10:00 → 只补 7-08 那次
    const missed = mostRecentMissedOccurrence({
      kind: 'daily', config: { time: '09:00', timezone: 'UTC' },
      after: '2026-07-06T09:00:00.000Z', before: now,
    })
    assert.equal(missed.toISOString(), '2026-07-08T09:00:00.000Z', '只补最近一次，不补三次')

    // 补发之后 due_at 应推到未来（用真实的物化路径验一次）
    const created = dbModule.createReminder({
      userId: 'ID:000001',
      dueAt: '2026-07-06T09:00:00.000Z',
      task: '日报',
      systemMessage: '{"type":"reminder"}',
      recurrenceType: 'daily',
      recurrenceConfig: { time: '09:00', timezone: 'UTC' },
    })
    const reminderId = Number(created.lastInsertRowid)
    const overdue = dbModule.getOverdueReminders('2026-07-08T10:00:00.000Z', { minLagMs: 60_000, limit: 10 })
    assert.ok(overdue.some(r => r.id === reminderId), '过期未物化的提醒要被捞出来')

    const run = dbModule.materializeReminderRun({
      reminder: dbModule.getReminderById(reminderId),
      firedAt: now.toISOString(),
      occurrenceDueAt: missed.toISOString(),
      expectedDueAt: '2026-07-06T09:00:00.000Z',
      nextDueAt: nextOccurrence({
        kind: 'daily', config: { time: '09:00', timezone: 'UTC' }, from: now,
      }).toISOString(),
    })
    assert.equal(run.due_at, '2026-07-08T09:00:00.000Z', '补的是「当时该发生的那一次」')
    const advanced = dbModule.getReminderById(reminderId)
    assert.equal(advanced.status, 'pending', '重复任务补发后仍然待触发')
    assert.equal(advanced.due_at, '2026-07-09T09:00:00.000Z', 'due_at 推到下一次正常触发点')

    // 刚到期一分钟内的不该被当成「漏跑」（正常路径会处理）
    const fresh = dbModule.createReminder({
      userId: 'ID:000001', dueAt: '2026-07-08T09:59:30.000Z', task: '刚到期', systemMessage: '{}',
    })
    const justDue = dbModule.getOverdueReminders('2026-07-08T10:00:00.000Z', { minLagMs: 60_000, limit: 50 })
    assert.equal(justDue.some(r => r.id === Number(fresh.lastInsertRowid)), false,
      '刚到期 30 秒的走正常路径，不算漏跑')
  }

  // ── 7. 合并：同一收件人同一时刻的多件事 ─────────────────────────────
  {
    const runs = [
      { id: 1, user_id: 'ID:000001', task: '提醒喝水', reminder_id: 10, attempts: 1 },
      { id: 2, user_id: 'ID:000001', task: '发日报', reminder_id: 11, attempts: 2 },
      { id: 3, user_id: 'ID:000001', task: '看一眼天气', reminder_id: 12, attempts: 1 },
    ]
    const { content, extra } = buildReminderMessage(runs)
    assert.match(content, /3 件事/)
    assert.match(content, /1\. 提醒喝水/)
    assert.match(content, /3\. 看一眼天气/)
    assert.match(content, /不要把它们当成互不相关的任务各说一遍/, '要给模型「一起处理」的指令')
    assert.equal(extra.reminderMergedCount, 3)

    // 单条不要被套上「合并」的措辞
    const single = buildReminderMessage([runs[0]])
    assert.equal(single.content, '提醒喝水')
    assert.deepEqual(single.extra, {})
    assert.equal(buildReminderMessage([]).content, '')

    // 分组：同收件人的在一起，且保持原顺序
    const grouped = groupRunsByTarget([
      runs[0], { id: 4, user_id: 'ID:000002', task: '别人的事' }, runs[1], runs[2],
    ])
    assert.equal(grouped.length, 2)
    assert.deepEqual(grouped[0].map(r => r.id), [1, 2, 3], '同收件人的保持原有先后')
    assert.deepEqual(grouped[1].map(r => r.id), [4])

    // run id 列表：批处理与单条两条路径都要认
    assert.deepEqual(reminderRunIdsOf({ reminderRunIds: [7, 8] }), [7, 8])
    assert.deepEqual(reminderRunIdsOf({ reminderRunId: 7 }), [7], '只有单条 id 的历史路径也要能用')
    assert.deepEqual(reminderRunIdsOf({ reminderRunIds: [], reminderRunId: 9 }), [9], '空数组回退到单条')
    assert.deepEqual(reminderRunIdsOf({}), [], '都没有就是空——调用方据此跳过')
    assert.deepEqual(reminderRunIdsOf(null), [])
  }

  // ── 8. 合并消息的 run 必须能整批结清（防「卡在 running」）────────────
  {
    const reminder = dbModule.createReminder({
      userId: 'ID:000001', dueAt: '2026-07-10T09:00:00.000Z', task: 'A', systemMessage: '{}',
    })
    const reminderId = Number(reminder.lastInsertRowid)
    const second = dbModule.createReminder({
      userId: 'ID:000001', dueAt: '2026-07-10T09:00:00.000Z', task: 'B', systemMessage: '{}',
    })
    const runA = dbModule.materializeReminderRun({
      reminder: dbModule.getReminderById(reminderId), firedAt: '2026-07-10T09:00:01.000Z',
    })
    const runB = dbModule.materializeReminderRun({
      reminder: dbModule.getReminderById(Number(second.lastInsertRowid)), firedAt: '2026-07-10T09:00:01.000Z',
    })
    const claimed = dbModule.claimRunnableReminderRuns('2026-07-10T09:00:02.000Z', 10)
      .filter(r => r.id === runA.id || r.id === runB.id)
    assert.equal(claimed.length, 2)

    const msg = { reminderRunIds: claimed.map(r => r.id), reminderId }
    for (const runId of reminderRunIdsOf(msg)) dbModule.completeReminderRun(runId)
    assert.equal(dbModule.getReminderRunById(runA.id).status, 'succeeded')
    assert.equal(dbModule.getReminderRunById(runB.id).status, 'succeeded', '合并消息要整批结清，不能只结第一条')
  }

  // ── 9. list 输出仍然可用（回归）──────────────────────────────────────
  {
    const out = await execManageReminder({ action: 'list' }, ctx)
    assert.match(out, /待触发提醒/)
    assert.match(out, /#\d+/, 'list 每行要带 id，否则用户没法引用去改/取消')
  }

  console.log('PASS scheduling: cron/interval/timezone creation, in-place update, delivery history, catch-up, and merged delivery')
} finally {
  closeDBForTest?.()
  fs.rmSync(tmp, { recursive: true, force: true })
}
