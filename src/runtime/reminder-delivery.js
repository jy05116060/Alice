// 提醒投递的纯逻辑（阶段 4）——独立成模块是为了能直接测：
// 合并措辞和「一批 run 的 id 列表」看着简单，但它们决定了
// 「同时间多件事会不会连着打扰用户三次」和「合并后 run 会不会卡在 running」，
// 埋在 index.js 里就只能靠跑整个进程去验。
// 依赖注入方式与仓库其它模块一致：只收数据，不碰数据库、不发消息。

/**
 * 一条消息对应的一批 reminder_run id。
 * 兼容两条历史路径：单条消息只有 reminderRunId（老的），合并消息带 reminderRunIds。
 */
export function reminderRunIdsOf(msg) {
  if (Array.isArray(msg?.reminderRunIds) && msg.reminderRunIds.length > 0) return msg.reminderRunIds
  return msg?.reminderRunId ? [msg.reminderRunId] : []
}

/**
 * 把同一收件人、同一时间点到期的一批 run 合成一条消息内容。
 * 单条时原样返回任务文本（不要给普通的单条提醒套上「合并」的措辞）。
 */
export function buildReminderMessage(runs = []) {
  const list = Array.isArray(runs) ? runs.filter(Boolean) : []
  if (list.length === 0) return { content: '', extra: {} }
  if (list.length === 1) return { content: list[0].task, extra: {} }
  const lines = list.map((run, index) => `${index + 1}. ${run.task}`)
  return {
    content: [
      `同一个时间点上到期了 ${list.length} 件事（收件人相同），合并成这一轮处理：`,
      ...lines,
      '',
      '请一起处理并给用户一条统一的回复，不要把它们当成互不相关的任务各说一遍。',
    ].join('\n'),
    extra: { reminderMergedCount: list.length },
  }
}

/**
 * 按收件人把一批 run 分组，并保持原有顺序（claimRunnableReminderRuns 已按可用时间排序，
 * 分组时要保住它，否则同一收件人的多件事会被打乱先后）。
 * @returns {Array<Array<object>>} 分组后的 run 数组，组间按首次出现顺序
 */
export function groupRunsByTarget(runs = []) {
  const grouped = new Map()
  for (const run of Array.isArray(runs) ? runs : []) {
    const key = run?.user_id || ''
    if (!grouped.has(key)) grouped.set(key, [])
    grouped.get(key).push(run)
  }
  return [...grouped.values()]
}
