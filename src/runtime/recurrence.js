// 递推时刻计算引擎（阶段 4）——纯函数，不碰数据库。
//
// 爱丽丝原来只有 once/daily/weekly/monthly，且全部按**进程本地时区**算
// （`next.setHours(...)`）。两处不够用：
//   1. 没有 cron。「每周一三五 9 点」「每月最后一个工作日」这类需求，
//      用 daily/weekly/monthly 三种形状表达不出来。
//   2. 没有时区。「每天 9 点」在用户换了机器、或进程跑在 UTC 容器里时就错了——
//      而"9 点"从来指的是**用户那边的 9 点**，不是进程那台机器的 9 点。
//
// 所以这一版把「时刻」和「墙上时间」明确分开：配置里存的是**墙上时间 + 时区**，
// 每次递推都换算成绝对时刻存库（due_at 永远是 UTC ISO）。
//
// DST（夏令时）是这里唯一真正难的东西，两条规矩：
//   - 跳过的墙钟时间（春季前跳，2:30 不存在）：**跳过**那次触发，不硬凑。
//   - 重复的墙钟时间（秋季回拨，1:30 出现两次）：取**第一次**。
//     这是 cron 的通行取舍；两次都触发会让「每天一次」变成「那天两次」，更糟。
// 判定方式不是猜偏移，而是「换算出 UTC → 再换回墙上时间 → 对得上才算存在」。
// 猜偏移的做法在 DST 边界上会静默算错一小时，而那正好是用户唯一会发现的时候。

export const RECURRENCE_KINDS = Object.freeze(['once', 'interval', 'daily', 'weekly', 'monthly', 'cron'])

export class RecurrenceError extends Error {
  constructor(code, message) {
    super(message)
    this.name = 'RecurrenceError'
    this.code = code
  }
}

// ── 时区 ──────────────────────────────────────────────────────────────────
const formatterCache = new Map()

function formatterFor(timezone) {
  let f = formatterCache.get(timezone)
  if (!f) {
    f = new Intl.DateTimeFormat('en-US', {
      timeZone: timezone,
      hour12: false,
      year: 'numeric', month: '2-digit', day: '2-digit',
      hour: '2-digit', minute: '2-digit', second: '2-digit',
    })
    formatterCache.set(timezone, f)
  }
  return f
}

export function systemTimezone() {
  try {
    return Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC'
  } catch {
    return 'UTC'
  }
}

/** 合法 IANA 时区名返回原名，否则返回 null（不抛——调用方要能优雅降级）。 */
export function normalizeTimezone(value) {
  const tz = String(value ?? '').trim()
  if (!tz) return null
  try {
    formatterFor(tz).format(new Date())
    return tz
  } catch {
    return null
  }
}

/** 时区解析：没给或不合法就用进程本地时区（保持历史行为，不因拼错时区而拒绝创建）。 */
export function resolveTimezone(value) {
  return normalizeTimezone(value) || systemTimezone()
}

/** 某个绝对时刻在指定时区里的墙上时间。 */
export function getZonedParts(date, timezone) {
  const tz = resolveTimezone(timezone)
  const parts = formatterFor(tz).formatToParts(date)
  const get = type => Number(parts.find(p => p.type === type)?.value)
  // hour 可能是 "24"（hour12:false 在部分 ICU 版本上会把 00:xx 报成 24:xx）
  const hour = get('hour') % 24
  const p = {
    year: get('year'),
    month: get('month'),
    day: get('day'),
    hour,
    minute: get('minute'),
    second: get('second'),
  }
  p.weekday = new Date(Date.UTC(p.year, p.month - 1, p.day)).getUTCDay()
  return p
}

/**
 * 墙上时间 → 绝对时刻。
 * 做法：先假设它就是 UTC，量出这个时刻在目标时区里的偏移，修正，再量一遍
 * （DST 边界上偏移会变，所以要迭代；两次足够收敛）。
 * @returns {{date: Date, exists: boolean}} exists=false 表示这个墙上时间在该时区**不存在**
 *          （春季前跳被跳过的那一小时），调用方应当跳过它。
 */
export function zonedWallTimeToUtc({ year, month, day, hour = 0, minute = 0, second = 0 }, timezone) {
  const tz = resolveTimezone(timezone)
  const target = Date.UTC(year, month - 1, day, hour, minute, second)
  let ts = target
  for (let i = 0; i < 3; i++) {
    const p = getZonedParts(new Date(ts), tz)
    const asUtc = Date.UTC(p.year, p.month - 1, p.day, p.hour, p.minute, p.second)
    const diff = asUtc - target
    if (diff === 0) break
    ts -= diff
  }
  const date = new Date(ts)
  // 对得上才算存在：跳过的墙钟时间会被换算成别的时刻，round-trip 过不了。
  const check = getZonedParts(date, tz)
  const exists = check.year === year && check.month === month && check.day === day
    && check.hour === hour && check.minute === minute
  return { date, exists }
}

function nextDayParts({ year, month, day }, step = 1) {
  const d = new Date(Date.UTC(year, month - 1, day + step))
  return { year: d.getUTCFullYear(), month: d.getUTCMonth() + 1, day: d.getUTCDate() }
}

// ── cron ──────────────────────────────────────────────────────────────────
const MONTH_NAMES = { JAN: 1, FEB: 2, MAR: 3, APR: 4, MAY: 5, JUN: 6, JUL: 7, AUG: 8, SEP: 9, OCT: 10, NOV: 11, DEC: 12 }
const DAY_NAMES = { SUN: 0, MON: 1, TUE: 2, WED: 3, THU: 4, FRI: 5, SAT: 6 }

const CRON_MACROS = {
  '@yearly': '0 0 1 1 *',
  '@annually': '0 0 1 1 *',
  '@monthly': '0 0 1 * *',
  '@weekly': '0 0 * * 0',
  '@daily': '0 0 * * *',
  '@midnight': '0 0 * * *',
  '@hourly': '0 * * * *',
}

function parseCronField(raw, { name, min, max, names = null, allowSevenAsZero = false }) {
  const field = String(raw ?? '').trim()
  if (!field) throw new RecurrenceError('CRON_FIELD_EMPTY', `${name} field is empty`)

  const values = new Set()
  const normalize = (token) => {
    const upper = token.toUpperCase()
    if (names && Object.prototype.hasOwnProperty.call(names, upper)) return names[upper]
    if (!/^\d+$/.test(token)) {
      throw new RecurrenceError('CRON_BAD_TOKEN', `${name} field has an unrecognized value: ${token}`)
    }
    let n = Number(token)
    if (allowSevenAsZero && n === 7) n = 0
    if (n < min || n > max) {
      throw new RecurrenceError('CRON_OUT_OF_RANGE', `${name} field value ${token} is outside ${min}-${max}`)
    }
    return n
  }

  for (const part of field.split(',')) {
    const chunk = part.trim()
    if (!chunk) throw new RecurrenceError('CRON_BAD_TOKEN', `${name} field has an empty list item`)
    const [rangePart, stepPart] = chunk.split('/')
    let step = 1
    if (stepPart !== undefined) {
      if (!/^\d+$/.test(stepPart) || Number(stepPart) < 1) {
        throw new RecurrenceError('CRON_BAD_STEP', `${name} field has an invalid step: ${stepPart}`)
      }
      step = Number(stepPart)
    }
    let from
    let to
    if (rangePart === '*') {
      from = min
      to = max
    } else if (rangePart.includes('-')) {
      const [a, b] = rangePart.split('-')
      from = normalize(a)
      to = normalize(b)
      if (from > to) {
        throw new RecurrenceError('CRON_BAD_RANGE', `${name} field has a reversed range: ${rangePart}`)
      }
    } else {
      from = normalize(rangePart)
      // 单值带步长（如 5/10）在 Vixie cron 里等价于 5-max/10
      to = stepPart !== undefined ? max : from
    }
    for (let v = from; v <= to; v += step) values.add(v)
  }

  if (values.size === 0) throw new RecurrenceError('CRON_EMPTY_FIELD', `${name} field matched no values`)
  return values
}

function formatCronField(values, { min, max }) {
  const sorted = [...values].sort((a, b) => a - b)
  // 覆盖整个取值域就写回 `*`：`*` 和 `0-59`（或 `JAN-DEC`）是同一件事，
  // 规范化存储必须让它们落到同一个字符串上，否则「同一条表达式」会有多种写法。
  if (sorted.length === max - min + 1 && sorted[0] === min && sorted[sorted.length - 1] === max) {
    return '*'
  }
  // 一律输出数字：`MON,TUE` 好读，但数字形式任何 cron 解析器都认，
  // 用户把这条表达式复制到别处也不会因为实现不支持英文简写而失效。
  return sorted.join(',')
}

/**
 * 解析五字段 Vixie 表达式。
 * 支持：`*`、单值、范围 a-b、列表 a,b,c、步长（星号或范围后跟 /n）、
 * 月份与星期的英文简写、以及 @daily 等常见宏（宏在解析期展开，
 * 所以**规范化存储**存的是展开后的五字段）。
 * 六字段（带秒）明确拒绝并指路 interval：秒级需求用 interval，语义更直白。
 */
export function parseCron(expression) {
  const raw = String(expression ?? '').trim()
  if (!raw) throw new RecurrenceError('CRON_EMPTY', 'cron expression is empty')

  const lower = raw.toLowerCase()
  const expanded = CRON_MACROS[lower] || raw
  const fields = expanded.trim().split(/\s+/)
  if (fields.length === 6) {
    throw new RecurrenceError(
      'CRON_SIX_FIELDS',
      'six-field cron (with seconds) is not supported; use kind=interval with seconds for sub-minute schedules',
    )
  }
  if (fields.length !== 5) {
    throw new RecurrenceError(
      'CRON_FIELD_COUNT',
      `a cron expression needs exactly 5 fields (minute hour day-of-month month day-of-week), got ${fields.length}`,
    )
  }

  const [minuteRaw, hourRaw, domRaw, monthRaw, dowRaw] = fields
  const minute = parseCronField(minuteRaw, { name: 'minute', min: 0, max: 59 })
  const hour = parseCronField(hourRaw, { name: 'hour', min: 0, max: 23 })
  const dom = parseCronField(domRaw, { name: 'day-of-month', min: 1, max: 31 })
  const month = parseCronField(monthRaw, { name: 'month', min: 1, max: 12, names: MONTH_NAMES })
  const dow = parseCronField(dowRaw, { name: 'day-of-week', min: 0, max: 6, names: DAY_NAMES, allowSevenAsZero: true })

  return {
    minute,
    hour,
    dom,
    month,
    dow,
    // Vixie 的日规则：dom 和 dow **都**被限制时取「或」，只限制一个时取那个。
    // 这不是怪癖，是 cron 的既定语义（`0 0 1 * 1` = 每月 1 号**或**每周一）。
    domRestricted: domRaw.trim() !== '*',
    dowRestricted: dowRaw.trim() !== '*',
    normalized: [
      formatCronField(minute, { min: 0, max: 59 }),
      formatCronField(hour, { min: 0, max: 23 }),
      formatCronField(dom, { min: 1, max: 31 }),
      formatCronField(month, { min: 1, max: 12 }),
      formatCronField(dow, { min: 0, max: 6 }),
    ].join(' '),
  }
}

export function cronDayMatches(parsed, { dom, dow }) {
  if (parsed.domRestricted && parsed.dowRestricted) return parsed.dom.has(dom) || parsed.dow.has(dow)
  if (parsed.domRestricted) return parsed.dom.has(dom)
  if (parsed.dowRestricted) return parsed.dow.has(dow)
  return true
}

// 上限：8 年。闰年 2 月 29 号最长要等 8 年（2096→2104 这种跨世纪例外更长，
// 那种情况下明确报错，而不是无限循环）。
const CRON_MAX_DAYS = 366 * 8

/** cron 的下一次触发（严格晚于 from）。 */
export function nextCronOccurrence(parsed, { from = new Date(), timezone = null } = {}) {
  const tz = resolveTimezone(timezone)
  const start = getZonedParts(from, tz)
  const hours = [...parsed.hour].sort((a, b) => a - b)
  const minutes = [...parsed.minute].sort((a, b) => a - b)

  let cursor = { year: start.year, month: start.month, day: start.day }
  for (let dayOffset = 0; dayOffset <= CRON_MAX_DAYS; dayOffset++) {
    if (parsed.month.has(cursor.month)) {
      const probe = new Date(Date.UTC(cursor.year, cursor.month - 1, cursor.day))
      const dow = probe.getUTCDay()
      if (cronDayMatches(parsed, { dom: cursor.day, dow })) {
        for (const hour of hours) {
          for (const minute of minutes) {
            const { date, exists } = zonedWallTimeToUtc({ ...cursor, hour, minute }, tz)
            if (!exists) continue // DST 跳过的墙钟时间：跳过这次，不硬凑
            if (date.getTime() > from.getTime()) return date
          }
        }
      }
    }
    cursor = nextDayParts(cursor)
  }
  throw new RecurrenceError(
    'CRON_NO_OCCURRENCE',
    `cron expression "${parsed.normalized}" has no occurrence within 8 years`,
  )
}

// ── 统一入口 ──────────────────────────────────────────────────────────────
function parseHourMinute(value, label = 'time') {
  const m = String(value ?? '').trim().match(/^(\d{1,2}):(\d{2})$/)
  if (!m) throw new RecurrenceError('BAD_TIME', `${label} must use HH:MM format, for example 09:00`)
  const hour = Number(m[1])
  const minute = Number(m[2])
  if (hour > 23 || minute > 59) throw new RecurrenceError('BAD_TIME', `${label} is outside the valid range`)
  return { hour, minute }
}

/**
 * 下一次触发时刻（严格晚于 from）。
 * @param {object} o
 * @param {string} o.kind        —— once/interval/daily/weekly/monthly/cron
 * @param {object} o.config      —— 形状随 kind：{time,weekday,day_of_month,cron,seconds,timezone}
 * @param {Date}   [o.from]
 * @param {string} [o.timezone]  —— 覆盖 config.timezone
 * @returns {Date}
 */
export function nextOccurrence({ kind, config = {}, from = new Date(), timezone = null } = {}) {
  const tz = resolveTimezone(timezone || config.timezone)

  if (kind === 'interval') {
    const seconds = Number(config.seconds)
    // 只收整数秒：调度粒度本来就到不了亚秒，静默取整会让「我设了 1.4 秒」
    // 和实际行为（1 秒）对不上。宁可明确拒绝。
    if (!Number.isInteger(seconds) || seconds < 1) {
      throw new RecurrenceError(
        'BAD_INTERVAL',
        `interval needs a whole number of seconds >= 1, got ${JSON.stringify(config.seconds)}`,
      )
    }
    // 间隔是「从现在起 N 秒」，和时区无关——这也是它不受 DST 影响的原因。
    return new Date(from.getTime() + seconds * 1000)
  }

  if (kind === 'cron') {
    const parsed = typeof config.cron === 'object' && config.cron?.minute
      ? config.cron
      : parseCron(config.cron)
    return nextCronOccurrence(parsed, { from, timezone: tz })
  }

  if (kind === 'daily' || kind === 'weekly' || kind === 'monthly') {
    const { hour, minute } = parseHourMinute(config.time)
    const start = getZonedParts(from, tz)

    const candidateAt = (parts) => {
      const { date, exists } = zonedWallTimeToUtc({ ...parts, hour, minute }, tz)
      return exists ? date : null
    }

    if (kind === 'daily') {
      // 最多往前找 8 天：DST 可能让某一天的那个墙钟时间不存在。
      let cursor = { year: start.year, month: start.month, day: start.day }
      for (let i = 0; i < 8; i++) {
        const date = candidateAt(cursor)
        if (date && date.getTime() > from.getTime()) return date
        cursor = nextDayParts(cursor)
      }
      throw new RecurrenceError('NO_OCCURRENCE', 'no daily occurrence found within 8 days')
    }

    if (kind === 'weekly') {
      const targetWeekday = Number(config.weekday)
      if (!Number.isInteger(targetWeekday) || targetWeekday < 0 || targetWeekday > 6) {
        throw new RecurrenceError('BAD_WEEKDAY', 'weekday must be an integer from 0 to 6 (0=Sunday)')
      }
      let cursor = { year: start.year, month: start.month, day: start.day }
      for (let i = 0; i < 15; i++) { // 14 天覆盖「今天刚好是那天但已过点」+ DST
        const probe = new Date(Date.UTC(cursor.year, cursor.month - 1, cursor.day))
        if (probe.getUTCDay() === targetWeekday) {
          const date = candidateAt(cursor)
          if (date && date.getTime() > from.getTime()) return date
        }
        cursor = nextDayParts(cursor)
      }
      throw new RecurrenceError('NO_OCCURRENCE', 'no weekly occurrence found within 15 days')
    }

    const targetDay = Number(config.day_of_month)
    if (!Number.isInteger(targetDay) || targetDay < 1 || targetDay > 31) {
      throw new RecurrenceError('BAD_DAY_OF_MONTH', 'day_of_month must be an integer from 1 to 31')
    }
    // 没有 31 号的月份直接跳到下一个有它的月（历史行为，保持不变）
    let year = start.year
    let month = start.month
    for (let i = 0; i < 13; i++) {
      const lastDay = new Date(Date.UTC(year, month, 0)).getUTCDate()
      if (targetDay <= lastDay) {
        const date = candidateAt({ year, month, day: targetDay })
        if (date && date.getTime() > from.getTime()) return date
      }
      month++
      if (month > 12) { month = 1; year++ }
    }
    throw new RecurrenceError('NO_OCCURRENCE', 'no monthly occurrence found within 13 months')
  }

  throw new RecurrenceError('UNKNOWN_KIND', `unknown recurrence kind: ${kind}`)
}

/**
 * 人类可读的递推描述（list 输出与 UI 共用；一处措辞，两处一致）。
 */
export function describeRecurrence(kind, config = {}) {
  const tz = normalizeTimezone(config.timezone)
  const suffix = tz && tz !== systemTimezone() ? ` (${tz})` : ''
  if (kind === 'interval') return `每 ${config.seconds} 秒`
  if (kind === 'cron') {
    let normalized = config.cron
    try {
      normalized = typeof config.cron === 'object' && config.cron?.normalized
        ? config.cron.normalized
        : parseCron(config.cron).normalized
    } catch { /* 表达式坏了就原样显示，让用户看见问题 */ }
    return `cron ${normalized}${suffix}`
  }
  if (kind === 'daily') return `每天 ${config.time}${suffix}`
  if (kind === 'weekly') {
    const names = ['周日', '周一', '周二', '周三', '周四', '周五', '周六']
    return `每${names[config.weekday] ?? config.weekday} ${config.time}${suffix}`
  }
  if (kind === 'monthly') return `每月 ${config.day_of_month} 号 ${config.time}${suffix}`
  if (kind === 'once') return '一次性'
  return kind
}

/**
 * 补发用：算出「如果进程没停，最近一次本该在哪触发」。
 * 只补最近一次——停了三天不该一口气补三次（那会连着打扰用户三次，
 * 而用户真正需要知道的是"有这么件事还等着"）。
 * @returns {Date|null} 落在 (after, before] 区间里的最近一次触发时刻
 */
export function mostRecentMissedOccurrence({ kind, config = {}, after, before = new Date(), timezone = null } = {}) {
  if (!after) return null
  const afterDate = after instanceof Date ? after : new Date(after)
  if (Number.isNaN(afterDate.getTime())) return null
  const beforeDate = before instanceof Date ? before : new Date(before)

  // interval 直接用算术算，不走迭代：停了一天、间隔 1 秒的配置迭代五千次也走不到头，
  // 而这里一次除法就精确了。
  if (kind === 'interval') {
    const step = Number(config.seconds) * 1000
    if (!Number.isFinite(step) || step < 1) return null
    const elapsed = beforeDate.getTime() - afterDate.getTime()
    if (elapsed < 0) return null
    const n = Math.floor(elapsed / step)
    const ts = afterDate.getTime() + n * step
    return ts > afterDate.getTime() - 1 && ts <= beforeDate.getTime() ? new Date(ts) : null
  }

  // 其余递推按天粒度，五千次步进足够覆盖十几年。
  // 游标刻意从 after 前 1 秒起步：nextOccurrence 是**严格**晚于 from 的，
  // 而「due_at 本身就被错过了」是最常见的补发场景，不能因为严格性把它跳掉。
  let cursor = new Date(afterDate.getTime() - 1000)
  let last = null
  for (let i = 0; i < 5000; i++) {
    let next
    try {
      next = nextOccurrence({ kind, config, from: cursor, timezone })
    } catch {
      return last
    }
    if (next.getTime() > beforeDate.getTime()) return last
    last = next
    cursor = next
  }
  return last
}
