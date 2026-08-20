// 调度规格的校验与预览（阶段 4 面板所需的数据接口，纯逻辑）。
//
// 面板上的 cron/时区表单需要一个「我这么填对不对、接下来什么时候触发」的即时答案。
// 这个答案必须由**服务端**给：真正决定触发时刻的就是 recurrence.js，让前端另算一套
// 迟早会和后端不一致（那是最难查的一类 bug——表单预览说 9:00，实际 10:00 触发）。
//
// 两个刻意的设计：
//   1. **一次返回全部错误**，而不是遇到第一个就返回。表单要标出所有填错的地方，
//      让用户来回改五次不是好体验。
//   2. **预览返回绝对时刻 + 墙上时间**。用户关心「我这边几点」（墙上时间），
//      而调度系统需要绝对时刻。两个都给，谁都别猜。
import { nextOccurrence, parseCron, describeRecurrence, normalizeTimezone, systemTimezone } from './recurrence.js'

export const PREVIEW_KINDS = Object.freeze(['once', 'interval', 'daily', 'weekly', 'monthly', 'cron'])

const MAX_PREVIEW = 20
const DEFAULT_PREVIEW = 5

export class ScheduleSpecError extends Error {
  constructor(code, message) {
    super(message)
    this.name = 'ScheduleSpecError'
    this.code = code
  }
}

function error(field, code, message) {
  return { field, code, message }
}

/**
 * 校验并规范化一份调度规格。
 * @param {object} spec — { kind, due_at?, time?, weekday?, day_of_month?, cron?, seconds?, timezone? }
 * @returns {{ok: boolean, kind: string, config: object, description: string, timezone: string, errors: object[]}}
 */
export function validateScheduleSpec(spec = {}) {
  const errors = []
  const kind = String(spec?.kind ?? 'once').trim().toLowerCase()
  if (!PREVIEW_KINDS.includes(kind)) {
    return {
      ok: false,
      kind,
      config: {},
      description: '',
      timezone: systemTimezone(),
      errors: [error('kind', 'UNKNOWN_KIND', `unknown kind "${kind}"; expected one of ${PREVIEW_KINDS.join(', ')}`)],
    }
  }

  // 时区：给了就必须合法。不合法时**不静默降级**——降级会让「每天 9 点」落在别的时区，
  // 而用户不会发现自己打错了（这条规矩在创建路径上也一样）。
  let timezone = null
  if (spec.timezone !== undefined && spec.timezone !== null && String(spec.timezone).trim() !== '') {
    timezone = normalizeTimezone(spec.timezone)
    if (!timezone) {
      errors.push(error('timezone', 'UNKNOWN_TIMEZONE', `unknown timezone "${spec.timezone}"; use an IANA name like Asia/Shanghai or UTC`))
    }
  }
  const effectiveTimezone = timezone || systemTimezone()

  const config = {}
  if (timezone) config.timezone = timezone

  if (kind === 'once') {
    const raw = String(spec.due_at ?? '').trim()
    if (!raw) {
      errors.push(error('due_at', 'DUE_AT_REQUIRED', 'kind=once needs due_at as an ISO 8601 timestamp'))
    } else {
      const date = new Date(raw)
      if (Number.isNaN(date.getTime())) {
        errors.push(error('due_at', 'INVALID_DUE_AT', 'due_at must be a valid ISO 8601 timestamp, for example 2026-04-21T06:00:00+08:00'))
      } else if (date.getTime() <= Date.now()) {
        // 不是格式问题而是语义问题，单独给码：表单应该提示「请选一个将来的时间」
        errors.push(error('due_at', 'DUE_AT_IN_PAST', 'due_at must be later than now'))
      } else {
        config.due_at = date.toISOString()
      }
    }
  } else if (kind === 'interval') {
    const seconds = Number(spec.seconds)
    if (!Number.isInteger(seconds) || seconds < 1) {
      errors.push(error('seconds', 'INVALID_SECONDS', 'kind=interval needs a whole number of seconds >= 1'))
    } else {
      config.seconds = seconds
    }
  } else if (kind === 'cron') {
    const raw = String(spec.cron ?? '').trim()
    if (!raw) {
      errors.push(error('cron', 'CRON_REQUIRED', 'kind=cron needs a five-field expression'))
    } else {
      try {
        // 规范化后再存/再预览：宏展开、步长展开、覆盖全域写回 `*`
        config.cron = parseCron(raw).normalized
      } catch (err) {
        errors.push(error('cron', err?.code || 'INVALID_CRON', err?.message || String(err)))
      }
    }
  } else {
    // daily / weekly / monthly：共用 time，weekly 还要 weekday，monthly 还要 day_of_month
    const time = String(spec.time ?? '').trim()
    const timeMatch = time.match(/^(\d{1,2}):(\d{2})$/)
    if (!timeMatch || Number(timeMatch[1]) > 23 || Number(timeMatch[2]) > 59) {
      errors.push(error('time', 'INVALID_TIME', 'time must be HH:MM (24-hour), for example 09:00'))
    } else {
      // 一位小时规范化成两位，让存下去的形态唯一
      config.time = `${String(Number(timeMatch[1])).padStart(2, '0')}:${timeMatch[2]}`
    }

    if (kind === 'weekly') {
      const weekday = Number(spec.weekday)
      if (!Number.isInteger(weekday) || weekday < 0 || weekday > 6) {
        errors.push(error('weekday', 'INVALID_WEEKDAY', 'weekday must be an integer from 0 to 6 (0=Sunday)'))
      } else {
        config.weekday = weekday
      }
    }
    if (kind === 'monthly') {
      const day = Number(spec.day_of_month)
      if (!Number.isInteger(day) || day < 1 || day > 31) {
        errors.push(error('day_of_month', 'INVALID_DAY_OF_MONTH', 'day_of_month must be an integer from 1 to 31'))
      } else {
        config.day_of_month = day
      }
    }
  }

  const ok = errors.length === 0
  return {
    ok,
    kind,
    config,
    timezone: effectiveTimezone,
    description: ok && kind !== 'once' ? describeRecurrence(kind, config) : '',
    errors,
  }
}

/**
 * 预览接下来的触发时刻。
 * @returns {{ok: boolean, occurrences: Array<{at: string, local: string, in_ms: number}>, errors: object[]}}
 */
export function previewOccurrences(spec = {}, { count = DEFAULT_PREVIEW, from = new Date() } = {}) {
  const validated = validateScheduleSpec(spec)
  if (!validated.ok) return { ok: false, occurrences: [], errors: validated.errors, spec: validated }

  const wanted = Math.max(1, Math.min(MAX_PREVIEW, Number(count) || DEFAULT_PREVIEW))
  const occurrences = []

  if (validated.kind === 'once') {
    const date = new Date(validated.config.due_at)
    occurrences.push(describeInstant(date, validated.timezone, from))
    return { ok: true, occurrences, errors: [], spec: validated }
  }

  let cursor = from
  for (let i = 0; i < wanted; i++) {
    let next
    try {
      next = nextOccurrence({ kind: validated.kind, config: validated.config, from: cursor, timezone: validated.timezone })
    } catch (err) {
      // 预览算不出来不是「规格非法」（校验已过），而是这个规格在未来一段时间内没有触发点
      return {
        ok: false,
        occurrences,
        errors: [error('spec', err?.code || 'NO_OCCURRENCE', err?.message || String(err))],
        spec: validated,
      }
    }
    occurrences.push(describeInstant(next, validated.timezone, from))
    cursor = next
  }
  return { ok: true, occurrences, errors: [], spec: validated }
}

function describeInstant(date, timezone, from) {
  return {
    at: date.toISOString(),
    // 墙上时间：用户问的是「我这边几点」，只有绝对时刻等于没说
    local: formatLocal(date, timezone),
    in_ms: Math.max(0, date.getTime() - from.getTime()),
  }
}

/** 用 Intl 的部件拼 `YYYY-MM-DD HH:MM`——比自己减时区偏移可靠，也自带 DST 处理。 */
export function formatLocal(date, timezone) {
  try {
    const parts = new Intl.DateTimeFormat('en-CA', {
      timeZone: timezone || systemTimezone(),
      hour12: false,
      year: 'numeric', month: '2-digit', day: '2-digit',
      hour: '2-digit', minute: '2-digit',
    }).formatToParts(date)
    const get = type => parts.find(p => p.type === type)?.value ?? ''
    return `${get('year')}-${get('month')}-${get('day')} ${String(Number(get('hour')) % 24).padStart(2, '0')}:${get('minute')}`
  } catch {
    return date.toISOString()
  }
}

/** 给表单用的字段说明（前端不用自己维护一份枚举）。 */
export function scheduleFieldSpec() {
  return {
    kinds: [...PREVIEW_KINDS],
    fields: {
      once: ['due_at'],
      interval: ['seconds'],
      daily: ['time'],
      weekly: ['time', 'weekday'],
      monthly: ['time', 'day_of_month'],
      cron: ['cron'],
    },
    optional: ['timezone'],
    weekday_names: ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'],
    cron_example: '*/15 9-17 * * 1-5',
    today: new Date().toISOString(),
  }
}
