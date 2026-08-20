import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

// 调度面板数据接口（阶段 6 补做）测试：校验/预览的纯逻辑 + 路由行为。
// 用临时库，不碰真实数据：
//   npm run test:schedule-preview
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'blm-sched-preview-'))
process.env.ALICE_USER_DIR = tmp
process.env.ALICE_RESOURCES_DIR = process.cwd()

let closeDBForTest = null

try {
  const dbModule = await import('./db.js')
  closeDBForTest = dbModule.closeDBForTest
  const {
    formatLocal,
    previewOccurrences,
    scheduleFieldSpec,
    validateScheduleSpec,
  } = await import('./runtime/schedule-preview.js')
  const { handleScheduleRoutes } = await import('./api/routes/schedules.js')

  const future = new Date(Date.now() + 3600_000).toISOString()

  // ── 1. 校验：正常规格 ─────────────────────────────────────────────────
  {
    const cron = validateScheduleSpec({ kind: 'cron', cron: '@daily', timezone: 'Asia/Shanghai' })
    assert.equal(cron.ok, true, JSON.stringify(cron.errors))
    assert.equal(cron.config.cron, '0 0 * * *', '宏要展开成五字段再预览/入库')
    assert.equal(cron.config.timezone, 'Asia/Shanghai')
    assert.equal(cron.timezone, 'Asia/Shanghai')
    assert.ok(/Asia\/Shanghai/.test(cron.description), `描述要带时区: ${cron.description}`)

    const daily = validateScheduleSpec({ kind: 'daily', time: '9:00' })
    assert.equal(daily.ok, true)
    assert.equal(daily.config.time, '09:00', '一位小时要规范成两位（存下去的形态唯一）')

    const weekly = validateScheduleSpec({ kind: 'weekly', time: '08:30', weekday: 3 })
    assert.equal(weekly.ok, true)
    assert.equal(weekly.config.weekday, 3)

    const monthly = validateScheduleSpec({ kind: 'monthly', time: '10:00', day_of_month: 31 })
    assert.equal(monthly.ok, true)
    assert.equal(monthly.config.day_of_month, 31)

    const interval = validateScheduleSpec({ kind: 'interval', seconds: 90 })
    assert.equal(interval.ok, true)
    assert.equal(interval.config.seconds, 90)

    const once = validateScheduleSpec({ kind: 'once', due_at: future })
    assert.equal(once.ok, true)
    assert.equal(once.config.due_at, new Date(future).toISOString(), '一次性要规范化成 ISO')
    assert.equal(once.description, '', '一次性没有递推描述')

    // 不传 kind 时默认 once
    assert.equal(validateScheduleSpec({ due_at: future }).kind, 'once')
  }

  // ── 2. 校验：错误路径，且要一次报全 ───────────────────────────────────
  {
    const unknown = validateScheduleSpec({ kind: 'hourly' })
    assert.equal(unknown.ok, false)
    assert.equal(unknown.errors[0].code, 'UNKNOWN_KIND')
    assert.ok(/expected one of/.test(unknown.errors[0].message))

    // 时区拼错不静默降级（降级会让「每天 9 点」落在别的时区而用户不知道）
    const badTz = validateScheduleSpec({ kind: 'daily', time: '09:00', timezone: 'Not/AZone' })
    assert.equal(badTz.ok, false)
    assert.equal(badTz.errors[0].code, 'UNKNOWN_TIMEZONE')
    assert.equal(badTz.errors[0].field, 'timezone')

    // **一次报全**：weekly 缺 time 又给了非法 weekday，两条都要在
    const multi = validateScheduleSpec({ kind: 'weekly', time: '25:00', weekday: 9 })
    assert.equal(multi.ok, false)
    const codes = multi.errors.map(e => e.code).sort()
    assert.deepEqual(codes, ['INVALID_TIME', 'INVALID_WEEKDAY'], `要一次报全: ${JSON.stringify(multi.errors)}`)
    assert.deepEqual(multi.errors.map(e => e.field).sort(), ['time', 'weekday'], '错误要能定位到字段')

    // 过去的 due_at 单独给码（不是格式错，是语义错——表单该提示「选将来的时间」）
    const past = validateScheduleSpec({ kind: 'once', due_at: '2020-01-01T00:00:00Z' })
    assert.equal(past.errors[0].code, 'DUE_AT_IN_PAST')
    const badDue = validateScheduleSpec({ kind: 'once', due_at: 'not a date' })
    assert.equal(badDue.errors[0].code, 'INVALID_DUE_AT')
    assert.equal(validateScheduleSpec({ kind: 'once' }).errors[0].code, 'DUE_AT_REQUIRED')

    // cron 的错误码要原样带回来（模型/用户能据此改）
    assert.equal(validateScheduleSpec({ kind: 'cron' }).errors[0].code, 'CRON_REQUIRED')
    const sixField = validateScheduleSpec({ kind: 'cron', cron: '0 0 9 * * *' })
    assert.equal(sixField.errors[0].code, 'CRON_SIX_FIELDS')
    assert.ok(/interval/.test(sixField.errors[0].message), '要指路 interval')
    assert.equal(validateScheduleSpec({ kind: 'cron', cron: '61 * * * *' }).errors[0].code, 'CRON_OUT_OF_RANGE')

    // interval 只收整数秒
    assert.equal(validateScheduleSpec({ kind: 'interval', seconds: 1.5 }).errors[0].code, 'INVALID_SECONDS')
    assert.equal(validateScheduleSpec({ kind: 'interval' }).errors[0].code, 'INVALID_SECONDS')

    // monthly 的日号范围
    assert.equal(validateScheduleSpec({ kind: 'monthly', time: '09:00', day_of_month: 32 }).errors[0].code, 'INVALID_DAY_OF_MONTH')
  }

  // ── 3. 预览：绝对时刻 + 墙上时间 ──────────────────────────────────────
  {
    const from = new Date('2026-07-10T00:00:00.000Z')
    const daily = previewOccurrences({ kind: 'daily', time: '09:00', timezone: 'Asia/Shanghai' }, { count: 3, from })
    assert.equal(daily.ok, true, JSON.stringify(daily.errors))
    assert.equal(daily.occurrences.length, 3)
    assert.equal(daily.occurrences[0].at, '2026-07-10T01:00:00.000Z', '上海 9:00 = UTC 1:00')
    assert.equal(daily.occurrences[0].local, '2026-07-10 09:00', '墙上时间要按用户时区给')
    assert.ok(daily.occurrences[0].in_ms > 0)
    // 连续三次应该是每天一次
    assert.equal(daily.occurrences[1].local, '2026-07-11 09:00')
    assert.equal(daily.occurrences[2].local, '2026-07-12 09:00')

    // cron：每 15 分钟
    const cron = previewOccurrences({ kind: 'cron', cron: '*/15 * * * *', timezone: 'UTC' }, { count: 4, from })
    assert.equal(cron.ok, true)
    assert.deepEqual(cron.occurrences.map(o => o.at), [
      '2026-07-10T00:15:00.000Z',
      '2026-07-10T00:30:00.000Z',
      '2026-07-10T00:45:00.000Z',
      '2026-07-10T01:00:00.000Z',
    ])

    // interval：与时区无关
    const interval = previewOccurrences({ kind: 'interval', seconds: 60 }, { count: 2, from })
    assert.deepEqual(interval.occurrences.map(o => o.at), ['2026-07-10T00:01:00.000Z', '2026-07-10T00:02:00.000Z'])

    // once：只有一条
    const once = previewOccurrences({ kind: 'once', due_at: '2099-01-01T00:00:00.000Z' }, { count: 5, from })
    assert.equal(once.occurrences.length, 1)

    // 预览条数被夹住（表单不该一次拉 1000 条）
    assert.equal(previewOccurrences({ kind: 'daily', time: '09:00' }, { count: 999, from }).occurrences.length, 20)
    assert.equal(previewOccurrences({ kind: 'daily', time: '09:00' }, { count: 0, from }).occurrences.length, 5, '0 退回默认')

    // 校验不过时预览也不给结果（而不是给一份基于坏规格的假预览）
    const bad = previewOccurrences({ kind: 'cron', cron: 'not a cron' }, { from })
    assert.equal(bad.ok, false)
    assert.deepEqual(bad.occurrences, [])
    assert.ok(bad.errors.length > 0)

    // 未来无触发点：算不出来要如实报告，而不是给空数组当成功
    const noOccurrence = previewOccurrences({ kind: 'cron', cron: '0 0 30 2 *', timezone: 'UTC' }, { count: 2, from })
    assert.equal(noOccurrence.ok, false)
    assert.ok(noOccurrence.errors.some(e => /NO_OCCURRENCE|occurrence/.test(e.code + e.message)))

    // formatLocal 对 DST 也对（用纽约跨夏令时验证）
    assert.equal(formatLocal(new Date('2026-03-08T07:00:00.000Z'), 'America/New_York'), '2026-03-08 03:00',
      '前跳之后 07:00Z 是当地 03:00')
  }

  // ── 4. 表单字段说明（前端不该自己维护一份枚举）────────────────────────
  {
    const spec = scheduleFieldSpec()
    assert.deepEqual(spec.kinds, ['once', 'interval', 'daily', 'weekly', 'monthly', 'cron'])
    assert.deepEqual(spec.fields.weekly, ['time', 'weekday'])
    assert.deepEqual(spec.fields.monthly, ['time', 'day_of_month'])
    assert.deepEqual(spec.optional, ['timezone'])
    assert.equal(spec.weekday_names.length, 7)
    assert.ok(spec.cron_example.includes('*'))
  }

  // ── 5. 路由行为 ───────────────────────────────────────────────────────
  {
    const call = async (method, pathname, body) => {
      const url = new URL(`http://127.0.0.1:3000${pathname}`)
      let status = null
      let payload = null
      const res = {
        writeHead(code) { status = code },
        setHeader() {},
        end(chunk) { payload = chunk ? JSON.parse(chunk) : null },
      }
      const req = {
        method,
        headers: { 'content-type': 'application/json' },
        on(event, handler) {
          if (event === 'data' && body !== undefined) handler(Buffer.from(JSON.stringify(body), 'utf8'))
          if (event === 'end') handler()
        },
      }
      const handled = await handleScheduleRoutes(req, res, url)
      return { handled, status, payload }
    }

    // 目录：结构完整（即使一条任务都没有）
    const catalog = await call('GET', '/schedules')
    assert.equal(catalog.handled, true)
    assert.equal(catalog.status, 200)
    assert.ok(Array.isArray(catalog.payload.reminders))
    assert.ok(Array.isArray(catalog.payload.delivery_history))
    assert.ok(catalog.payload.fields.kinds.length > 0, '目录要带上表单字段说明')

    // 造一条周期提醒 + 一条投递回执，确认目录能读出来
    dbModule.createReminder({
      userId: 'ID:000001',
      dueAt: '2099-01-01T01:00:00.000Z',
      task: '每天汇报',
      systemMessage: '{}',
      recurrenceType: 'daily',
      recurrenceConfig: { time: '09:00', timezone: 'Asia/Shanghai' },
    })
    dbModule.recordDelivery({
      reminderId: 1, runId: 7, userId: 'ID:000001', channel: 'TUI',
      content: '已送达', delivered: true, verified: true,
    })
    const withRows = await call('GET', '/schedules')
    assert.equal(withRows.payload.reminders.length, 1)
    const row = withRows.payload.reminders[0]
    assert.equal(row.recurrence_type, 'daily')
    assert.equal(row.timezone, 'Asia/Shanghai')
    assert.ok(/每天 09:00/.test(row.description), `描述要与工具输出一致: ${row.description}`)
    assert.equal(withRows.payload.delivery_history.length, 1)
    assert.equal(withRows.payload.delivery_history[0].delivered, true)
    assert.equal(withRows.payload.delivery_history[0].verified, true)
    // history=false 时不该带历史（面板分开加载）
    const noHistory = await call('GET', '/schedules?history=false')
    assert.equal('delivery_history' in noHistory.payload, false)

    // 校验+预览
    const preview = await call('POST', '/schedules/validate', { kind: 'cron', cron: '@hourly', timezone: 'UTC', preview_count: 2 })
    assert.equal(preview.status, 200)
    assert.equal(preview.payload.ok, true)
    assert.equal(preview.payload.config.cron, '0 * * * *', '返回的应当是规范化后的表达式')
    assert.equal(preview.payload.occurrences.length, 2)

    // 规格有错：**仍然 200**，但 ok:false + errors（表单要逐字段标注）
    const invalid = await call('POST', '/schedules/validate', { kind: 'cron', cron: 'nope' })
    assert.equal(invalid.status, 200, '用户填错不是接口失败，不该用 4xx')
    assert.equal(invalid.payload.ok, false)
    assert.ok(invalid.payload.errors.length > 0)
    assert.ok(invalid.payload.errors[0].field === 'cron')

    // 纯校验
    const check = await call('POST', '/schedules/check', { kind: 'weekly', time: '08:00', weekday: 1 })
    assert.equal(check.payload.ok, true)
    assert.equal(check.payload.timezone_explicit, false, '没给时区时要说清是「用了系统时区」')

    // 创建：走工具层的校验（cron 规范化、时区校验都复用同一份实现）
    const created = await call('POST', '/schedules', {
      kind: 'cron', cron: '@daily', timezone: 'UTC', task: '每天汇总', target_id: 'ID:000001',
    })
    assert.equal(created.status, 200, JSON.stringify(created.payload))
    assert.equal(created.payload.ok, true)
    const createdRow = created.payload.reminders.find(r => r.task === '每天汇总')
    assert.ok(createdRow, '创建后目录里应能看到它')
    assert.equal(createdRow.recurrence_config.cron, '0 0 * * *', '存下去的应当是规范化后的表达式')
    assert.equal(createdRow.timezone, 'UTC')
    assert.ok(/cron/.test(createdRow.description), `描述要与工具输出一致: ${createdRow.description}`)

    // 填错：工具层 throw，路由转成 400（**用户填错不是服务器故障**）
    const badCreate = await call('POST', '/schedules', { kind: 'cron', cron: 'not a cron', task: 'x' })
    assert.equal(badCreate.status, 400)
    assert.equal(badCreate.payload.ok, false)
    assert.ok(/cron|field/i.test(badCreate.payload.error), `错误信息要说清哪里错: ${badCreate.payload.error}`)
    const badTz = await call('POST', '/schedules', { kind: 'daily', time: '09:00', timezone: 'Nope/Nope', task: 'x' })
    assert.equal(badTz.status, 400)
    assert.ok(/timezone/i.test(badTz.payload.error))

    // 取消
    const cancelled = await call('DELETE', `/schedules/${createdRow.id}`)
    assert.equal(cancelled.status, 200)
    assert.equal(cancelled.payload.reminders.some(r => r.id === createdRow.id), false, '取消后不该还在待触发列表里')
    // 非法 id
    assert.equal((await call('DELETE', '/schedules/abc')).status, 400)
    assert.equal((await call('DELETE', '/schedules/0')).status, 400)

    // 其它路径 / 方法不认领（POST /schedules 现在是真路由，所以改用别的方法验证）
    assert.equal((await call('GET', '/schedule')).handled, false)
    assert.equal((await call('PUT', '/schedules')).handled, false)
    assert.equal((await call('POST', '/schedules/validate/extra')).handled, false)
  }

  console.log('PASS schedule-preview: validation collecting all errors, occurrence preview with local wall time, field spec, and catalog/validate routes')
} finally {
  closeDBForTest?.()
  try { fs.rmSync(tmp, { recursive: true, force: true }) } catch { /* 清理失败不影响结论 */ }
}
