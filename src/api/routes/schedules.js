import { jsonResponse, readRawBody, decodeRequestBody } from '../utils.js'
import {
  listPendingReminders,
  listDeliveryHistory,
} from '../../db.js'
import { describeRecurrence, normalizeTimezone } from '../../runtime/recurrence.js'
import { execManageReminder } from '../../capabilities/tools/reminders.js'
import {
  previewOccurrences,
  scheduleFieldSpec,
  validateScheduleSpec,
} from '../../runtime/schedule-preview.js'

// 调度面板的数据接口（阶段 4 面板所需，阶段 6 补做）。
//   GET  /schedules              —— 目录：待触发任务 + 投递历史 + 表单字段说明
//   POST /schedules/validate     —— cron/时区表单的校验与预览
//
// 为什么不复用工具层的 `manage_reminder list`：那是给**模型**看的自然语言文本；
// 面板需要结构化字段（规范化后的 cron、时区、下一次触发、投递回执）。两者服务对象不同，
// 硬套一份只会让两边都别扭。但**描述文案共用 describeRecurrence**——同一件事只有一份措辞。
export async function handleScheduleRoutes(req, res, url) {
  if (req.method === 'GET' && url.pathname === '/schedules') {
    const includeHistory = url.searchParams.get('history') !== 'false'
    const historyLimit = clampLimit(url.searchParams.get('history_limit'), 50, 200)

    const reminders = listPendingReminders(clampLimit(url.searchParams.get('limit'), 50, 200))
    jsonResponse(res, 200, {
      ok: true,
      fields: scheduleFieldSpec(),
      reminders: reminders.map(describeRow),
      ...(includeHistory
        ? {
          delivery_history: listDeliveryHistory({ limit: historyLimit }).map(row => ({
            id: row.id,
            reminder_id: row.reminder_id,
            run_id: row.run_id,
            user_id: row.user_id,
            channel: row.channel,
            delivered: row.delivered === 1,
            verified: row.verified === 1,
            error: row.error || '',
            created_at: row.created_at,
          })),
        }
        : {}),
    })
    return true
  }

  if (req.method === 'POST' && url.pathname === '/schedules/validate') {
    const { body, error } = await readJsonBody(req)
    if (error) {
      jsonResponse(res, 400, { ok: false, code: 'BAD_BODY', error })
      return true
    }
    const count = Number(body.preview_count)
    const result = previewOccurrences(body, {
      count: Number.isFinite(count) ? Number(count) : 5,
    })
    // 校验失败返回 200 而不是 4xx：这不是「请求坏了」，而是「这份规格有错」，
    // 表单需要拿到 errors 逐字段标注。用状态码区分「接口失败」和「用户填错」。
    jsonResponse(res, 200, {
      ok: result.ok,
      kind: result.spec?.kind ?? null,
      config: result.spec?.config ?? {},
      timezone: result.spec?.timezone ?? null,
      description: result.spec?.description ?? '',
      occurrences: result.occurrences,
      errors: result.errors,
    })
    return true
  }

  // 单条规格的纯校验（不带预览）：表单边输入边校验时用得上
  if (req.method === 'POST' && url.pathname === '/schedules/check') {
    const { body, error } = await readJsonBody(req)
    if (error) {
      jsonResponse(res, 400, { ok: false, code: 'BAD_BODY', error })
      return true
    }
    const validated = validateScheduleSpec(body)
    jsonResponse(res, 200, {
      ok: validated.ok,
      kind: validated.kind,
      config: validated.config,
      timezone: validated.timezone,
      description: validated.description,
      errors: validated.errors,
      // 时区是不是「用户显式给的」也报出来：表单要能把这一项标成可选
      timezone_explicit: !!normalizeTimezone(body?.timezone),
    })
    return true
  }

  // 创建/取消（收敛自原 /workspace/reminders）。
  // 复用语工具层的 execManageReminder：它已经处理了时区校验、cron 规范化、一次性提醒
  // 的同分钟合并。**不重写一份**——两份实现迟早对不上，而「提醒到底什么时候响」是最
  // 不能对不上的东西。
  if (req.method === 'POST' && url.pathname === '/schedules') {
    const { body, error } = await readJsonBody(req)
    if (error) {
      jsonResponse(res, 400, { ok: false, code: 'BAD_BODY', error })
      return true
    }
    let message = ''
    try {
      message = await execManageReminder({ ...body, action: 'create' }, {
        visibleTargetIds: body.target_id ? [body.target_id] : [],
      })
    } catch (error) {
      // 工具层对坏输入是 throw（cron 写错、时区拼错）。这不是服务器故障，是**用户填错**，
      // 所以 400 + 错误码，而不是 500。
      jsonResponse(res, 400, { ok: false, code: error?.code || 'CREATE_FAILED', error: error?.message || String(error) })
      return true
    }
    jsonResponse(res, 200, { ok: true, message, reminders: listPendingReminders(100).map(describeRow) })
    return true
  }

  if (req.method === 'DELETE' && url.pathname.startsWith('/schedules/')) {
    const id = Number(url.pathname.slice('/schedules/'.length))
    if (!Number.isInteger(id) || id <= 0) {
      jsonResponse(res, 400, { ok: false, code: 'INVALID_ID', error: 'invalid reminder id' })
      return true
    }
    const message = await execManageReminder({ action: 'cancel', id })
    jsonResponse(res, 200, { ok: true, message, reminders: listPendingReminders(100).map(describeRow) })
    return true
  }

  return false
}

/** 一行的对外形状（目录与创建/取消的返回值共用，避免两处各写一份映射）。 */
function describeRow(row) {
  const config = parseConfig(row.recurrence_config)
  return {
    id: row.id,
    user_id: row.user_id,
    task: row.task,
    status: row.status,
    due_at: row.due_at,
    recurrence_type: row.recurrence_type,
    recurrence_config: config,
    timezone: config.timezone || null,
    description: row.recurrence_type ? describeRecurrence(row.recurrence_type, config) : 'once',
  }
}

/**
 * 读一个 JSON 对象体。
 * @returns {{body?: object, error?: string}} —— 失败时**必须**给出原因：
 * 第一版把底层异常吞成 null，结果接口只回一句「必须是 JSON 对象」，
 * 真正的原因（读流出错 / JSON 语法错）全都看不到，排查只能靠猜。
 */
async function readJsonBody(req) {
  let raw
  try {
    raw = await readRawBody(req, { maxBytes: 256 * 1024 })
  } catch (error) {
    return { error: `could not read the request body: ${error?.message || error}` }
  }
  if (!raw || raw.length === 0) return { body: {} }
  // charset 用框架已有的判断（和 workspace.js 那批路由同一套），不自己假设 UTF-8
  let text
  try {
    text = decodeRequestBody(raw, req.headers?.['content-type'])
  } catch {
    text = raw.toString('utf8')
  }
  let parsed
  try {
    parsed = JSON.parse(text)
  } catch (error) {
    return { error: `invalid JSON body: ${error.message}${text.length < 200 ? ` (received: ${text})` : ''}` }
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    return { error: 'request body must be a JSON object' }
  }
  return { body: parsed }
}

function parseConfig(raw) {
  try {
    const parsed = JSON.parse(raw || '{}')
    return parsed && typeof parsed === 'object' ? parsed : {}
  } catch {
    return {}
  }
}

function clampLimit(raw, fallback, max) {
  const n = Number(raw)
  if (!Number.isFinite(n) || n <= 0) return fallback
  return Math.max(1, Math.min(max, Math.round(n)))
}
