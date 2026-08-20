import assert from 'assert'

// 递推引擎（阶段 4）测试——纯函数，零依赖，普通 node 即可：
//   npm run test-recurrence
const {
  RecurrenceError,
  parseCron,
  cronDayMatches,
  nextCronOccurrence,
  nextOccurrence,
  describeRecurrence,
  mostRecentMissedOccurrence,
  getZonedParts,
  zonedWallTimeToUtc,
  normalizeTimezone,
  resolveTimezone,
  systemTimezone,
} = await import('./runtime/recurrence.js')

const at = iso => new Date(iso)
const iso = d => d.toISOString()

try {
  // ── 1. 时区解析与墙上时间 ─────────────────────────────────────────────
  {
    assert.equal(normalizeTimezone('Asia/Shanghai'), 'Asia/Shanghai')
    assert.equal(normalizeTimezone('UTC'), 'UTC')
    assert.equal(normalizeTimezone('America/New_York'), 'America/New_York')
    assert.equal(normalizeTimezone('Not/AZone'), null, '非法时区名返回 null，不抛')
    assert.equal(normalizeTimezone(''), null)
    assert.equal(normalizeTimezone(null), null)
    assert.equal(resolveTimezone('Not/AZone'), systemTimezone(), '非法时区降级到系统时区，而不是拒绝创建')
    assert.ok(systemTimezone().length > 0)

    // 同一个绝对时刻，在不同时区里的墙上时间不同
    const instant = at('2026-07-10T04:00:00.000Z')
    assert.equal(getZonedParts(instant, 'Asia/Shanghai').hour, 12, 'UTC+8，July → 东八区 12 点')
    assert.equal(getZonedParts(instant, 'UTC').hour, 4)
    assert.equal(getZonedParts(instant, 'America/New_York').hour, 0, '纽约夏令时 UTC-4 → 0 点')
    assert.equal(getZonedParts(instant, 'Asia/Shanghai').day, 10)
    assert.equal(getZonedParts(instant, 'Asia/Shanghai').weekday, 5, '2026-07-10 是周五')

    // 墙上时间 → 绝对时刻
    const { date, exists } = zonedWallTimeToUtc({ year: 2026, month: 7, day: 10, hour: 9, minute: 30 }, 'Asia/Shanghai')
    assert.equal(exists, true)
    assert.equal(iso(date), '2026-07-10T01:30:00.000Z', '东八区 9:30 = UTC 1:30')
    // 回来对得上
    const back = getZonedParts(date, 'Asia/Shanghai')
    assert.equal(back.hour, 9)
    assert.equal(back.minute, 30)

    // 纽约的冬夏偏移不同：同一天号、同一钟点，UTC 时刻必须差一小时
    const winter = zonedWallTimeToUtc({ year: 2026, month: 1, day: 15, hour: 9, minute: 0 }, 'America/New_York')
    const summer = zonedWallTimeToUtc({ year: 2026, month: 7, day: 15, hour: 9, minute: 0 }, 'America/New_York')
    assert.equal(iso(winter.date), '2026-01-15T14:00:00.000Z', '冬令时 UTC-5')
    assert.equal(iso(summer.date), '2026-07-15T13:00:00.000Z', '夏令时 UTC-4')
  }

  // ── 2. cron 解析：字段形态与规范化 ───────────────────────────────────
  {
    const every5 = parseCron('*/5 * * * *')
    assert.deepEqual([...every5.minute].sort((a, b) => a - b), [0, 5, 10, 15, 20, 25, 30, 35, 40, 45, 50, 55])
    assert.equal(every5.normalized, '0,5,10,15,20,25,30,35,40,45,50,55 * * * *', '规范化存储把步长展开')
    assert.equal(every5.domRestricted, false)
    assert.equal(every5.dowRestricted, false)

    const list = parseCron('0 9,18 * * 1-5')
    assert.deepEqual([...list.hour].sort((a, b) => a - b), [9, 18])
    assert.deepEqual([...list.dow].sort((a, b) => a - b), [1, 2, 3, 4, 5])
    assert.equal(list.normalized, '0 9,18 * * 1,2,3,4,5')

    assert.deepEqual([...parseCron('0 0-6/2 * * *').hour].sort((a, b) => a - b), [0, 2, 4, 6], '范围带步长')
    assert.deepEqual([...parseCron('10/20 * * * *').minute].sort((a, b) => a - b), [10, 30, 50],
      '单值带步长 = 从该值到上界')

    // 英文简写（模型很爱写）
    const named = parseCron('0 9 * JAN-MAR MON,WED')
    assert.deepEqual([...named.month].sort((a, b) => a - b), [1, 2, 3])
    assert.deepEqual([...named.dow].sort((a, b) => a - b), [1, 3])

    // 7 = 周日
    assert.deepEqual([...parseCron('0 0 * * 7').dow], [0])
    assert.deepEqual([...parseCron('0 0 * * SUN').dow], [0])

    // 宏在解析期展开
    assert.equal(parseCron('@daily').normalized, '0 0 * * *')
    assert.equal(parseCron('@DAILY').normalized, '0 0 * * *', '宏大小写不敏感')
    assert.equal(parseCron('@hourly').normalized, '0 * * * *')
    assert.equal(parseCron('@weekly').normalized, '0 0 * * 0')
    assert.equal(parseCron('@monthly').normalized, '0 0 1 * *')
    assert.equal(parseCron('@yearly').normalized, '0 0 1 1 *')

    // 多空格 / 前后空白
    assert.equal(parseCron('  0   9  *  *  *  ').normalized, '0 9 * * *')
  }

  // ── 3. cron 解析：错误必须说清哪里错 ─────────────────────────────────
  {
    const cases = [
      ['', 'CRON_EMPTY'],
      ['* * * *', 'CRON_FIELD_COUNT'],
      ['* * * * * *', 'CRON_SIX_FIELDS'],
      ['60 * * * *', 'CRON_OUT_OF_RANGE'],
      ['* 24 * * *', 'CRON_OUT_OF_RANGE'],
      ['* * 0 * *', 'CRON_OUT_OF_RANGE'],
      ['* * * 13 *', 'CRON_OUT_OF_RANGE'],
      ['* * * * 8', 'CRON_OUT_OF_RANGE'],
      ['*/0 * * * *', 'CRON_BAD_STEP'],
      ['5-1 * * * *', 'CRON_BAD_RANGE'],
      ['abc * * * *', 'CRON_BAD_TOKEN'],
      ['* * * * *@', 'CRON_BAD_TOKEN'],
      ['1,,2 * * * *', 'CRON_BAD_TOKEN'],
    ]
    for (const [expr, code] of cases) {
      let caught = null
      try { parseCron(expr) } catch (error) { caught = error }
      assert.ok(caught, `"${expr}" 应该报错`)
      assert.equal(caught.code, code, `"${expr}" 的错误码应为 ${code}，实际 ${caught.code}: ${caught.message}`)
      assert.ok(caught instanceof RecurrenceError)
    }
    // 六字段的报错要指路 interval
    let six = null
    try { parseCron('0 0 9 * * *') } catch (error) { six = error }
    assert.ok(/interval/.test(six.message), '拒绝六字段时要告诉模型改用 interval')
  }

  // ── 4. cron 的日规则（Vixie 的「或」）────────────────────────────────
  {
    const both = parseCron('0 0 1 * 1') // 每月 1 号 或 每周一
    assert.equal(cronDayMatches(both, { dom: 1, dow: 3 }), true, '1 号命中 dom')
    assert.equal(cronDayMatches(both, { dom: 15, dow: 1 }), true, '周一命中 dow')
    assert.equal(cronDayMatches(both, { dom: 15, dow: 3 }), false, '都不是就不命中')

    const domOnly = parseCron('0 0 1 * *')
    assert.equal(cronDayMatches(domOnly, { dom: 1, dow: 1 }), true)
    assert.equal(cronDayMatches(domOnly, { dom: 2, dow: 1 }), false, '只限制 dom 时 dow 不参与')

    const dowOnly = parseCron('0 0 * * 1')
    assert.equal(cronDayMatches(dowOnly, { dom: 2, dow: 1 }), true)
    assert.equal(cronDayMatches(dowOnly, { dom: 1, dow: 2 }), false, '只限制 dow 时 dom 不参与')

    const none = parseCron('0 0 * * *')
    assert.equal(cronDayMatches(none, { dom: 31, dow: 6 }), true, '两个都不限制 → 每天')
  }

  // ── 5. cron 的下一次触发 ──────────────────────────────────────────────
  {
    // 每 5 分钟
    const every5 = parseCron('*/5 * * * *')
    const from = at('2026-07-10T04:03:00.000Z')
    assert.equal(iso(nextCronOccurrence(every5, { from, timezone: 'UTC' })), '2026-07-10T04:05:00.000Z')
    // 正好踩在触发点上：下一次是下一个，不是同一个（严格晚于）
    assert.equal(iso(nextCronOccurrence(every5, { from: at('2026-07-10T04:05:00.000Z'), timezone: 'UTC' })),
      '2026-07-10T04:10:00.000Z')

    // 时区：上海每天早上 9 点 → UTC 1 点
    const daily9 = parseCron('0 9 * * *')
    const nextSh = nextCronOccurrence(daily9, { from: at('2026-07-10T00:00:00.000Z'), timezone: 'Asia/Shanghai' })
    assert.equal(iso(nextSh), '2026-07-10T01:00:00.000Z', '上海 9:00 = UTC 1:00')

    // 工作日 9 点：周五晚上 → 下周一
    const weekdays = parseCron('0 9 * * 1-5')
    const fridayNight = at('2026-07-10T14:00:00.000Z') // 上海周五 22:00
    const nextWorkday = nextCronOccurrence(weekdays, { from: fridayNight, timezone: 'Asia/Shanghai' })
    assert.equal(iso(nextWorkday), '2026-07-13T01:00:00.000Z', '跳过周末，落到周一（UTC 7-13 是周一）')
    assert.equal(getZonedParts(nextWorkday, 'Asia/Shanghai').weekday, 1)

    // 跨月：每月 1 号
    const monthly = parseCron('0 0 1 * *')
    assert.equal(iso(nextCronOccurrence(monthly, { from: at('2026-07-15T00:00:00.000Z'), timezone: 'UTC' })),
      '2026-08-01T00:00:00.000Z')

    // 闰年 2 月 29：跨到下一个闰年，不是报错
    const leap = parseCron('0 0 29 2 *')
    const nextLeap = nextCronOccurrence(leap, { from: at('2026-03-01T00:00:00.000Z'), timezone: 'UTC' })
    assert.equal(iso(nextLeap), '2028-02-29T00:00:00.000Z')

    // 找不到就报错，不无限循环
    let noOcc = null
    try { nextCronOccurrence(parseCron('0 0 30 2 *'), { from: at('2026-01-01T00:00:00.000Z'), timezone: 'UTC' }) }
    catch (error) { noOcc = error }
    assert.ok(noOcc, '2 月 30 日永远不存在，必须报错而不是死循环')
    assert.equal(noOcc.code, 'CRON_NO_OCCURRENCE')
  }

  // ── 6. DST：跳过的墙钟时间要跳过，不能硬凑 ───────────────────────────
  {
    // 纽约 2026-03-08 02:00→03:00 前跳，2:30 这个墙钟时间不存在
    const missing = zonedWallTimeToUtc({ year: 2026, month: 3, day: 8, hour: 2, minute: 30 }, 'America/New_York')
    assert.equal(missing.exists, false, '2:30 被 DST 跳过，必须报 exists=false')

    // 每天 2:30 的 cron：3 月 8 日那次跳过，落到 3 月 9 日
    const at230 = parseCron('30 2 * * *')
    const next = nextCronOccurrence(at230, { from: at('2026-03-07T12:00:00.000Z'), timezone: 'America/New_York' })
    const parts = getZonedParts(next, 'America/New_York')
    assert.equal(parts.day, 9, '3-08 的 2:30 不存在，应落到 3-09')
    assert.equal(parts.hour, 2)
    assert.equal(parts.minute, 30)

    // daily 递推同样跳过
    const daily = nextOccurrence({
      kind: 'daily', config: { time: '02:30', timezone: 'America/New_York' },
      from: at('2026-03-07T12:00:00.000Z'),
    })
    assert.equal(getZonedParts(daily, 'America/New_York').day, 9)

    // 秋季回拨（11-01 01:00 出现两次）：取第一次，不重复触发
    const once_ = zonedWallTimeToUtc({ year: 2026, month: 11, day: 1, hour: 1, minute: 30 }, 'America/New_York')
    assert.equal(once_.exists, true)
    const back = getZonedParts(once_.date, 'America/New_York')
    assert.equal(back.hour, 1)
    assert.equal(back.minute, 30, '回拨的钟点取第一次，round-trip 仍然对得上')
  }

  // ── 7. daily / weekly / monthly 的时区正确性 ─────────────────────────
  {
    // 同一句「每天 9:00」，在不同时区必须落在不同的绝对时刻
    const sh = nextOccurrence({ kind: 'daily', config: { time: '09:00', timezone: 'Asia/Shanghai' }, from: at('2026-07-10T00:00:00.000Z') })
    const ny = nextOccurrence({ kind: 'daily', config: { time: '09:00', timezone: 'America/New_York' }, from: at('2026-07-10T00:00:00.000Z') })
    assert.equal(iso(sh), '2026-07-10T01:00:00.000Z')
    assert.equal(iso(ny), '2026-07-10T13:00:00.000Z')
    assert.notEqual(iso(sh), iso(ny))

    // 不传时区 = 进程本地时区（历史行为不变）
    const local = nextOccurrence({ kind: 'daily', config: { time: '09:00' }, from: at('2026-07-10T00:00:00.000Z') })
    assert.equal(getZonedParts(local, systemTimezone()).hour, 9)

    // weekly：指定周几
    const weekly = nextOccurrence({
      kind: 'weekly', config: { time: '08:00', weekday: 3, timezone: 'UTC' },
      from: at('2026-07-10T00:00:00.000Z'), // 周五
    })
    assert.equal(iso(weekly), '2026-07-15T08:00:00.000Z', '下一个周三是 7-15')
    assert.equal(getZonedParts(weekly, 'UTC').weekday, 3)

    // monthly：没有 31 号的月份跳到下一个有它的月
    const monthly = nextOccurrence({
      kind: 'monthly', config: { time: '10:00', day_of_month: 31, timezone: 'UTC' },
      from: at('2026-04-05T00:00:00.000Z'),
    })
    assert.equal(iso(monthly), '2026-05-31T10:00:00.000Z', '4 月没有 31 号 → 5-31')

    // 参数校验：一位小时是合理的、也是原实现就接受的写法，按宽进处理
    assert.equal(
      getZonedParts(nextOccurrence({ kind: 'daily', config: { time: '9:00', timezone: 'UTC' }, from: at('2026-07-10T00:00:00.000Z') }), 'UTC').hour,
      9,
      '9:00 与 09:00 等价，不该拒绝',
    )
    for (const [cfg, code] of [
      [{ time: '25:00' }, 'BAD_TIME'],
      [{ time: '12:60' }, 'BAD_TIME'],
      [{ time: '9' }, 'BAD_TIME'],
      [{ time: '09:0' }, 'BAD_TIME'],
      [{ time: '0900' }, 'BAD_TIME'],
      [{ time: '' }, 'BAD_TIME'],
      [{ time: undefined }, 'BAD_TIME'],
    ]) {
      let caught = null
      try { nextOccurrence({ kind: 'daily', config: cfg, from: at('2026-07-10T00:00:00.000Z') }) } catch (e) { caught = e }
      assert.equal(caught?.code, code, `${JSON.stringify(cfg)} 应报 ${code}，实际 ${caught?.code}`)
    }
    let badWeekday = null
    try {
      nextOccurrence({ kind: 'weekly', config: { time: '08:00', weekday: 9 }, from: new Date() })
    } catch (e) { badWeekday = e }
    assert.equal(badWeekday?.code, 'BAD_WEEKDAY')

    let badDay = null
    try {
      nextOccurrence({ kind: 'monthly', config: { time: '08:00', day_of_month: 0 }, from: new Date() })
    } catch (e) { badDay = e }
    assert.equal(badDay?.code, 'BAD_DAY_OF_MONTH')
  }

  // ── 8. 秒级 interval ─────────────────────────────────────────────────
  {
    const from = at('2026-07-10T00:00:00.000Z')
    assert.equal(iso(nextOccurrence({ kind: 'interval', config: { seconds: 30 }, from })), '2026-07-10T00:00:30.000Z')
    assert.equal(iso(nextOccurrence({ kind: 'interval', config: { seconds: 3600 }, from })), '2026-07-10T01:00:00.000Z')
    // 间隔与时区无关：同一 from、同一 seconds，任何时区下都是同一绝对时刻
    assert.equal(
      iso(nextOccurrence({ kind: 'interval', config: { seconds: 45, timezone: 'Asia/Shanghai' }, from })),
      iso(nextOccurrence({ kind: 'interval', config: { seconds: 45, timezone: 'America/New_York' }, from })),
    )
    for (const seconds of [0, -5, 1.4, 'x', null, undefined, NaN]) {
      let caught = null
      try { nextOccurrence({ kind: 'interval', config: { seconds }, from }) } catch (e) { caught = e }
      assert.equal(caught?.code, 'BAD_INTERVAL', `seconds=${seconds} 应被拒`)
    }
    let fractional = null
    try { nextOccurrence({ kind: 'interval', config: { seconds: 1.4 }, from }) } catch (e) { fractional = e }
    assert.ok(/whole number/.test(fractional.message), '拒绝小数秒时说清「只收整数秒」')

    let unknown = null
    try { nextOccurrence({ kind: 'hourly', config: {}, from }) } catch (e) { unknown = e }
    assert.equal(unknown?.code, 'UNKNOWN_KIND')
  }

  // ── 9. 描述文案（list 输出与 UI 共用）────────────────────────────────
  {
    assert.equal(describeRecurrence('interval', { seconds: 30 }), '每 30 秒')
    assert.equal(describeRecurrence('daily', { time: '09:00' }), '每天 09:00')
    assert.equal(describeRecurrence('weekly', { time: '09:00', weekday: 1 }), '每周一 09:00')
    assert.equal(describeRecurrence('monthly', { time: '09:00', day_of_month: 15 }), '每月 15 号 09:00')
    assert.equal(describeRecurrence('cron', { cron: '*/5 * * * *' }), 'cron 0,5,10,15,20,25,30,35,40,45,50,55 * * * *')
    assert.equal(describeRecurrence('once', {}), '一次性')
    // 非系统时区要把时区标出来，否则用户不知道"9 点"是哪儿的 9 点
    const described = describeRecurrence('daily', { time: '09:00', timezone: 'America/New_York' })
    if (systemTimezone() !== 'America/New_York') {
      assert.ok(/America\/New_York/.test(described), `跨时区必须标注时区，got: ${described}`)
    }
    assert.equal(describeRecurrence('daily', { time: '09:00', timezone: systemTimezone() }), '每天 09:00',
      '就是本机时区时不啰嗦')
  }

  // ── 10. 漏跑补发：只补最近一次 ───────────────────────────────────────
  {
    // 间隔 60 秒，停了 10 分钟 → 最近一次在 before 前 0 秒（整除）
    const recent = mostRecentMissedOccurrence({
      kind: 'interval', config: { seconds: 60 },
      after: at('2026-07-10T00:00:00.000Z'),
      before: at('2026-07-10T00:10:00.000Z'),
    })
    assert.equal(iso(recent), '2026-07-10T00:10:00.000Z')

    // after 的语义是「计划到期时刻」：它本身已经过期就该补发，
    // 哪怕还没过满一个间隔（那正是最常见的补发场景：进程在触发点前一刻挂了）。
    assert.equal(iso(mostRecentMissedOccurrence({
      kind: 'interval', config: { seconds: 3600 },
      after: at('2026-07-10T00:00:00.000Z'),
      before: at('2026-07-10T00:10:00.000Z'),
    })), '2026-07-10T00:00:00.000Z', '到期时刻已过就该补，不需要等满一个间隔')

    // 到期时刻还在未来 → 没有错过的
    assert.equal(mostRecentMissedOccurrence({
      kind: 'interval', config: { seconds: 3600 },
      after: at('2026-07-10T01:00:00.000Z'),
      before: at('2026-07-10T00:10:00.000Z'),
    }), null, '还没到期就没什么可补的')

    // 每天 9:00（UTC），停了三天 → 只补最近那一次，不是三次
    const missed = mostRecentMissedOccurrence({
      kind: 'daily', config: { time: '09:00', timezone: 'UTC' },
      after: at('2026-07-06T09:00:00.000Z'),
      before: at('2026-07-08T10:00:00.000Z'),
    })
    assert.equal(iso(missed), '2026-07-08T09:00:00.000Z', '只补最近一次（7-08），不是 7-07/7-08 两次')

    // due_at 本身就被错过了（最常见的补发场景）
    const itself = mostRecentMissedOccurrence({
      kind: 'daily', config: { time: '09:00', timezone: 'UTC' },
      after: at('2026-07-08T09:00:00.000Z'),
      before: at('2026-07-08T12:00:00.000Z'),
    })
    assert.equal(iso(itself), '2026-07-08T09:00:00.000Z', 'due_at 自己就在区间内，要补上')

    // cron 同理
    const missedCron = mostRecentMissedOccurrence({
      kind: 'cron', config: { cron: '0 9 * * 1-5', timezone: 'UTC' },
      after: at('2026-07-10T09:00:00.000Z'), // 周五
      before: at('2026-07-13T12:00:00.000Z'), // 下周一中午
    })
    assert.equal(iso(missedCron), '2026-07-13T09:00:00.000Z', '周末没有触发，补最近的周一那次')

    // 参数缺失不炸
    assert.equal(mostRecentMissedOccurrence({ kind: 'daily', config: { time: '09:00' }, after: null }), null)
    assert.equal(mostRecentMissedOccurrence({ kind: 'daily', config: { time: '09:00' }, after: 'garbage' }), null)
    assert.equal(mostRecentMissedOccurrence({ kind: 'interval', config: { seconds: 0 }, after: at('2026-07-10T00:00:00.000Z') }), null)
  }

  console.log('test-recurrence: all assertions passed')
} catch (error) {
  console.error(error)
  process.exitCode = 1
}
