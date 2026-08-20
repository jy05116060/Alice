import { nowTimestamp } from '../../time.js'
import { createReminder, findMergeableOneOffReminder, appendReminderTask, listPendingReminders, getReminderById, cancelReminder, updateReminder, normalizeConversationPartyId } from '../../db.js'
import { emitEvent } from '../../events.js'
import { PRIMARY_USER_ID } from '../../identity.js'
import {
  describeRecurrence,
  nextOccurrence,
  normalizeTimezone,
  parseCron,
} from '../../runtime/recurrence.js'

function parseReminderDueAt(value) {
  if (!value || typeof value !== 'string') {
    throw new Error('due_at was not provided')
  }
  const dueAt = new Date(value.trim())
  if (Number.isNaN(dueAt.getTime())) {
    throw new Error('due_at must be a valid ISO 8601 absolute time, for example 2026-04-21T06:00:00+08:00')
  }
  return dueAt
}

// 周期提醒：根据 type/config 计算下一次触发时间（晚于 fromDate）。
// 阶段 4 起真正的算法在 runtime/recurrence.js（纯函数、可硬测）：支持 cron 五字段、
// IANA 时区、秒级 interval，并正确处理 DST。这里只保留这层薄封装——
// index.js / executor.js 都还在用这个签名，改签名会把改动面扩大到没必要的地方。
export function calculateNextDueAt(type, config, fromDate = new Date()) {
  return nextOccurrence({ kind: type, config: config || {}, from: fromDate })
}

/** 把工具参数整理成 recurrence_config（含规范化后的 cron 与解析后的时区）。 */
function buildRecurrenceConfig(kind, args) {
  const config = {}
  const timezone = normalizeTimezone(args.timezone)
  if (args.timezone && !timezone) {
    // 时区拼错时**不静默降级**：那会让「每天 9 点」变成用户时区的 9 点或 UTC 的 9 点，
    // 而且用户永远不会发现自己拼错了。宁可让模型把名字改对。
    throw new Error(`unknown timezone "${args.timezone}"; use an IANA name like Asia/Shanghai or UTC`)
  }
  if (timezone) config.timezone = timezone

  if (kind === 'daily') {
    config.time = args.time
  } else if (kind === 'weekly') {
    config.time = args.time
    config.weekday = args.weekday
  } else if (kind === 'monthly') {
    config.time = args.time
    config.day_of_month = args.day_of_month
  } else if (kind === 'cron') {
    // 解析一次只为拿到规范化形式存库；解析失败就把错误原样抛给模型
    // （错误信息里带了出错字段，模型能自己改对）。
    config.cron = parseCron(args.cron).normalized
  } else if (kind === 'interval') {
    config.seconds = Number(args.seconds)
  } else {
    throw new Error(`unknown kind "${kind}", expected once/daily/weekly/monthly/cron/interval`)
  }
  return config
}

function buildSystemMessage(targetId, taskText) {
  // Legacy storage field retained for database compatibility. Runtime
  // execution uses the structured L3 reminder-run payload instead of injecting
  // an English "I am the system" message into a user-role conversation turn.
  return JSON.stringify({
    type: 'reminder',
    target_id: targetId,
    task: taskText,
  })
}

function formatReminderRow(r) {
  // 描述文案统一由 recurrence.describeRecurrence 提供（list 输出与 UI 共用一份措辞，
  // 否则「每 30 秒」在工具输出和面板里会是两种说法）。
  const recurrence = r.recurrence_type
    ? `[${r.recurrence_type}] ${describeRecurrence(r.recurrence_type, parseRecurrenceConfig(r))}`
    : '[once]'
  return `#${r.id} ${recurrence} 下次 ${r.due_at} → ${r.user_id}：${r.task}`
}

function parseRecurrenceConfig(row) {
  try {
    return JSON.parse(row?.recurrence_config || '{}') || {}
  } catch {
    return {}
  }
}

export async function execManageReminder(args, context = {}) {
  const action = args.action || (args.due_at || args.kind ? 'create' : null)
  if (!action) return '错误：未提供 action（create/list/update/cancel）'

  if (action === 'list') {
    const rows = listPendingReminders(50)
    if (!rows.length) return '当前没有待触发的提醒。'
    return `共 ${rows.length} 条待触发提醒：\n` + rows.map(formatReminderRow).join('\n')
  }

  if (action === 'cancel') {
    const id = Number(args.id)
    if (!Number.isInteger(id) || id <= 0) return '错误：cancel 需要提供合法的提醒 id'
    const existing = getReminderById(id)
    if (!existing) return `错误：未找到提醒 #${id}`
    if (existing.status !== 'pending') return `错误：提醒 #${id} 当前状态为 ${existing.status}，无法取消`
    const result = cancelReminder(id)
    if (!result.changes) return `错误：取消提醒 #${id} 失败`
    emitEvent('reminder_cancelled', { id, user_id: existing.user_id, task: existing.task })
    return `提醒 #${id} 已取消（${existing.task}）`
  }

  if (action === 'update') {
    return execUpdateReminder(args)
  }

  if (action !== 'create') return `错误：未知 action "${action}"，仅支持 create/list/update/cancel`

  const { task } = args
  if (!task?.trim()) return '错误：未提供 task'
  const taskText = task.trim()
  const fallbackTargetId = context.visibleTargetIds?.[0] || context.allowedTargetIds?.[0] || PRIMARY_USER_ID
  const resolvedTargetId = normalizeConversationPartyId(args.target_id || fallbackTargetId)

  const kind = args.kind || 'once'

  if (kind === 'once') {
    const dueAt = parseReminderDueAt(args.due_at)
    if (dueAt.getTime() <= Date.now()) throw new Error('提醒时间必须晚于当前时间')
    const isoDueAt = dueAt.toISOString()
    const minuteKey = isoDueAt.slice(0, 16)

    const mergeTarget = findMergeableOneOffReminder(resolvedTargetId, minuteKey)
    if (mergeTarget) {
      const mergedTaskText = `${mergeTarget.task}; ${taskText}`
      const newSystemMessage = buildSystemMessage(resolvedTargetId, mergedTaskText)
      const r = appendReminderTask(mergeTarget.id, taskText, newSystemMessage)
      if (!r.changes) return `错误：合并提醒 #${mergeTarget.id} 失败`
      emitEvent('reminder_merged', { id: mergeTarget.id, user_id: resolvedTargetId, due_at: mergeTarget.due_at, task: mergedTaskText })
      return `已合并到现有提醒 #${mergeTarget.id}（同时间），合并后任务：${mergedTaskText}`
    }

    const result = createReminder({
      userId: resolvedTargetId,
      dueAt: isoDueAt,
      task: taskText,
      systemMessage: buildSystemMessage(resolvedTargetId, taskText),
      source: `tool:manage_reminder@${nowTimestamp()}`,
    })
    emitEvent('reminder_created', { id: Number(result.lastInsertRowid), user_id: resolvedTargetId, due_at: isoDueAt, task: taskText })
    return `提醒已创建：#${result.lastInsertRowid}，将在 ${isoDueAt} 触发，目标用户 ${resolvedTargetId}`
  }

  // 周期提醒（daily / weekly / monthly / cron / interval）
  const config = buildRecurrenceConfig(kind, args)
  // 先解析再入库：错误（cron 写错、时区拼错）要作为工具结果回到模型手里，
  // 而不是留下一行永远算不出下次触发的坏数据。
  const nextDate = calculateNextDueAt(kind, config)
  const isoDueAt = nextDate.toISOString()
  const result = createReminder({
    userId: resolvedTargetId,
    dueAt: isoDueAt,
    task: taskText,
    systemMessage: buildSystemMessage(resolvedTargetId, taskText),
    source: `tool:manage_reminder@${nowTimestamp()}`,
    recurrenceType: kind,
    recurrenceConfig: config,
  })
  emitEvent('reminder_created', { id: Number(result.lastInsertRowid), user_id: resolvedTargetId, due_at: isoDueAt, task: taskText, recurrence_type: kind, recurrence_config: config })
  return `周期提醒已创建：#${result.lastInsertRowid} (${kind})，${describeRecurrence(kind, config)}，下次触发 ${isoDueAt}，目标用户 ${resolvedTargetId}`
}

/**
 * 就地改一条提醒（阶段 4）。
 * 保留 id 与它已经产生的 reminder_runs 历史——「把每天 9 点改成 10 点」不应该
 * 表现为「删一条建一条」，否则历史投递记录会跟着断掉，用户也拿不到稳定的 id 去引用。
 */
function execUpdateReminder(args) {
  const id = Number(args.id)
  if (!Number.isInteger(id) || id <= 0) return '错误：update 需要提供合法的提醒 id'
  const existing = getReminderById(id)
  if (!existing) return `错误：未找到提醒 #${id}`
  if (existing.status !== 'pending') return `错误：提醒 #${id} 当前状态为 ${existing.status}，无法修改`

  const patch = {}
  const changes = []

  if (typeof args.task === 'string' && args.task.trim() && args.task.trim() !== existing.task) {
    patch.task = args.task.trim()
    patch.systemMessage = buildSystemMessage(existing.user_id, patch.task)
    changes.push('任务')
  }
  if (args.target_id) {
    const target = normalizeConversationPartyId(args.target_id)
    if (target !== existing.user_id) {
      patch.userId = target
      patch.systemMessage = buildSystemMessage(target, patch.task || existing.task)
      changes.push('目标用户')
    }
  }

  // 改时间：kind 不变就按新参数算下次触发；给了 kind 就是换一种递推方式。
  const nextKind = args.kind || existing.recurrence_type || 'once'
  const timeTouched = args.kind || args.due_at || args.time || args.weekday
    || args.day_of_month || args.cron || args.seconds || args.timezone
  if (timeTouched) {
    if (nextKind === 'once') {
      const dueAt = parseReminderDueAt(args.due_at)
      if (dueAt.getTime() <= Date.now()) return '错误：提醒时间必须晚于当前时间'
      patch.dueAt = dueAt.toISOString()
      patch.recurrenceType = null
      patch.recurrenceConfig = null
      changes.push('触发时间')
    } else {
      // 只改一部分时，其余沿用原配置：用户说「改成 10 点」不该把周几重置掉。
      const merged = { ...parseRecurrenceConfig(existing), ...(args.kind ? {} : {}) }
      const base = args.kind ? {} : merged
      const config = buildRecurrenceConfig(nextKind, {
        ...base,
        ...(args.time !== undefined ? { time: args.time } : {}),
        ...(args.weekday !== undefined ? { weekday: args.weekday } : {}),
        ...(args.day_of_month !== undefined ? { day_of_month: args.day_of_month } : {}),
        ...(args.cron !== undefined ? { cron: args.cron } : {}),
        ...(args.seconds !== undefined ? { seconds: args.seconds } : {}),
        ...(args.timezone !== undefined ? { timezone: args.timezone } : {}),
      })
      patch.dueAt = calculateNextDueAt(nextKind, config).toISOString()
      patch.recurrenceType = nextKind
      patch.recurrenceConfig = config
      changes.push('触发时间')
    }
  }

  if (changes.length === 0) return `提醒 #${id} 没有任何改动（未提供要修改的字段）`

  const result = updateReminder(id, patch)
  if (!result.changes) return `错误：修改提醒 #${id} 失败`

  const updated = getReminderById(id)
  emitEvent('reminder_updated', {
    id,
    user_id: updated.user_id,
    due_at: updated.due_at,
    task: updated.task,
    recurrence_type: updated.recurrence_type,
    changed: changes,
  })
  return `提醒 #${id} 已更新（${changes.join('、')}）：${formatReminderRow(updated)}`
}


