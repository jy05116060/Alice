// 工作流运行的**进程内**登记表（阶段 3.4，工作流面板的数据源）。
//
// 为什么需要它：工作流引擎把进度经事件总线推给思考流，但用户**看不到**一份可查的
// 运行清单——跑过几次、哪几次失败、失败在哪、每一项子代理成没成，全都只发生在
// 思考流的滚动条目里，滚过去就没了。这个模块就是那份「去哪儿看」。
//
// **诚实声明（面板必须写出来）**：这里是**内存态**。进程一重启就清空，它不是历史
// 记录，也不落库。看一眼就能确认的旁证：`src/db/` 下没有任何 workflow 表，引擎里
// 也没有把运行写进编排存储；events.js 只把 workflow_start / workflow_end 两条
// 事件落进 brain_ui_events（那是给思考流回放用的，只有起止，没有每项状态）。
// 面板因此只声称「本次进程内的运行」，绝不把它包装成持久历史。
//
// 分工（与 worktree-panel / compaction-panel 同一条硬约束）：展示字段（阶段耗时、
// 每项状态、计数、截断标记）一律由这里算好，面板只负责摆出来。面板跑在浏览器里，
// import 不到 src/runtime/。
//
// 还有个刻意的克制：**只读登记，不改引擎的执行语义**。所有写入都是 best-effort——
// 观测失败绝不能让一次运行失败（与 events.js 里 emitEvent 的纪律一致）。

/** 进程内最多保留多少次运行。老的先淘汰：面板看的是「最近发生了什么」。 */
const MAX_RUNS = 50
/** 单次运行最多留多少条 log。脚本可以播报几千条，全留着会把内存和面板一起拖垮。 */
const MAX_LOGS_PER_RUN = 200
/** 单次运行最多留多少个 agent() 条目（引擎上限是 maxTotalAgents，默认 64）。 */
const MAX_ITEMS_PER_RUN = 512

/** runId → 运行记录。Map 保持插入顺序，最新的排最后。 */
const runs = new Map()

function nowMs() {
  return Date.now()
}

function safeId(value) {
  return typeof value === 'string' && value ? value : null
}

/**
 * 登记一次运行的开始。
 * @returns {string|null} 登记成功返回 run id；参数不成立返回 null（调用方不必分支）。
 */
export function beginWorkflowRun({ runId, name, description, phases, limits } = {}) {
  const id = safeId(runId)
  if (!id) return null
  const record = {
    runId: id,
    name: typeof name === 'string' && name ? name : 'workflow',
    description: typeof description === 'string' ? description : '',
    declaredPhases: Array.isArray(phases)
      ? phases.map(p => (typeof p === 'string' ? p : p && typeof p.title === 'string' ? p.title : '')).filter(Boolean)
      : [],
    limits: limits && typeof limits === 'object' ? limits : null,
    status: 'running',
    code: null,
    error: null,
    startedAt: nowMs(),
    endedAt: null,
    logs: [],
    logsOmitted: 0,
    phases: [],
    items: [],
    itemsOmitted: 0,
  }
  runs.set(id, record)
  while (runs.size > MAX_RUNS) {
    const oldest = runs.keys().next()
    if (oldest.done) break
    runs.delete(oldest.value)
  }
  return id
}

function record(runId) {
  const id = safeId(runId)
  if (!id) return null
  return runs.get(id) || null
}

/**
 * 关闭当前阶段（下一次 phase() 或运行结束时调用），并开一个新的。
 *
 * 同一标题只占**一行**（按标题去重）：脚本可以在循环里反复 phase("审一遍")，
 * 每调一次就新开一行的话内存和面板都会被刷爆。去重后 `visits` 如实记「进入过几次」，
 * 时间仍是**第一段**的真实起止——宁可少说一段，也不把多段的墙钟拼成一段假耗时。
 */
export function noteWorkflowPhase(runId, title) {
  const entry = record(runId)
  if (!entry) return
  const label = typeof title === 'string' && title ? title : ''
  closePhase(entry, entry.phases.at(-1), nowMs())
  const existing = label ? entry.phases.find(p => p.title === label) : null
  if (existing) {
    existing.visits += 1
    return
  }
  entry.phases.push({ title: label, startedAt: nowMs(), visits: 1, completed: 0, failed: 0, running: 0 })
}

function closePhase(entry, phase, at) {
  if (!phase || typeof phase.endedAt === 'number') return
  phase.endedAt = at
}

export function noteWorkflowLog(runId, message) {
  const entry = record(runId)
  if (!entry) return
  if (entry.logs.length >= MAX_LOGS_PER_RUN) {
    entry.logsOmitted += 1
    return
  }
  entry.logs.push(typeof message === 'string' ? message : String(message ?? ''))
}

function makeItem(info, fallbackSeq) {
  return {
    seq: Number.isSafeInteger(info.seq) ? info.seq : fallbackSeq,
    label: typeof info.label === 'string' ? info.label : '',
    phase: typeof info.phase === 'string' && info.phase ? info.phase : null,
    childId: typeof info.childId === 'string' ? info.childId : null,
    status: 'running',
    at: nowMs(),
  }
}

/**
 * 记下一项子代理。
 *
 * 引擎会在两个地方报同一项：**真正发起时**（为了运行中的那一项在面板里也是「跑着」）
 * 和子代理返回时（补 childId 与最终结果）。所以这里按 seq 去重：已有一行就只补详情，
 * 不再新增——否则一次扇出会被登记成两倍条数。
 */
export function noteWorkflowAgentStart(runId, info = {}) {
  const entry = record(runId)
  if (!entry) return
  const seq = Number.isSafeInteger(info.seq) ? info.seq : null
  if (seq !== null) {
    const existing = entry.items.find(i => i.seq === seq)
    if (existing) {
      if (typeof info.label === 'string' && info.label) existing.label = info.label
      if (typeof info.phase === 'string' && info.phase) existing.phase = info.phase
      if (typeof info.childId === 'string' && info.childId) existing.childId = info.childId
      return
    }
  }
  if (entry.items.length >= MAX_ITEMS_PER_RUN) {
    entry.itemsOmitted += 1
    return
  }
  entry.items.push(makeItem(info, entry.items.length + 1))
}

export function noteWorkflowAgentEnd(runId, info = {}) {
  const entry = record(runId)
  if (!entry) return
  const seq = Number.isSafeInteger(info.seq) ? info.seq : null
  let item = seq === null ? null : entry.items.find(i => i.seq === seq)
  if (!item) {
    // 没找到对应的 agentStart（引擎正常不会这样，但登记是 best-effort）：
    // 只有还装得下、而且知道自己是哪一号时才补一条；**绝不**退回去改别人的条目
    // ——把上一项标成失败比少一条记录糟得多。
    if (seq === null || entry.items.length >= MAX_ITEMS_PER_RUN) {
      entry.itemsOmitted += 1
      return
    }
    item = makeItem(info, seq)
    entry.items.push(item)
  }
  // 引擎在 agentEnd 里只给 outcome（completed / failed），拿不到子代理自己的
  // 错误正文——那就不编一个「原因」出来，如实只标状态，运行级的错误另给。
  item.status = info.outcome === 'completed' ? 'completed' : 'failed'
  item.at = nowMs()
}

/**
 * 登记运行的结束。失败/被截断一律如实落下来（ok=false 时带 code 与 error），
 * 绝不因为「跑完了」就统一写成成功。
 */
export function endWorkflowRun(runId, { ok, code, error, agentsStarted, durationMs } = {}) {
  const entry = record(runId)
  if (!entry) return
  const at = nowMs()
  entry.status = ok === true ? 'completed' : 'error'
  entry.code = ok === true ? null : (typeof code === 'string' && code ? code : 'WORKFLOW_FAILED')
  entry.error = ok === true ? null : (typeof error === 'string' && error ? error : null)
  entry.endedAt = at
  if (Number.isSafeInteger(agentsStarted) && agentsStarted > 0) entry.agentsStarted = agentsStarted
  if (Number.isFinite(durationMs) && durationMs >= 0) entry.reportedDurationMs = durationMs
  closePhase(entry, entry.phases.at(-1), at)
  // 运行已经结束，却没有任何 agentEnd 的条目：引擎没回报它的结果。
  // 说「未知」，不说「失败」也不说「成功」。
  for (const item of entry.items) {
    if (item.status === 'running') item.status = 'unknown'
  }
}

function bumpCounters(entry) {
  for (const phase of entry.phases) {
    phase.completed = 0
    phase.failed = 0
    phase.running = 0
  }
  const byTitle = new Map(entry.phases.map(p => [p.title, p]))
  for (const item of entry.items) {
    const phase = item.phase ? byTitle.get(item.phase) : null
    if (!phase) continue
    if (item.status === 'completed') phase.completed += 1
    else if (item.status === 'failed') phase.failed += 1
    else if (item.status === 'running') phase.running += 1
  }
}

/**
 * 把内部记录映射成**面板要的展示字段**（服务端算，面板不重写规则）。
 *
 * 关键取舍：
 *   · 耗时只在两个地方是**真的**——整轮（startedAt→endedAt / 现在）和每个阶段
 *     （阶段切换的时间戳之差）。单条 agent 的耗时引擎没有回报，就不给数字，
 *     宁可没有也不要编一个 0 ms 出来。
 *   · 结束运行里仍是 running 的项一律降级成 unknown（见 endWorkflowRun）。
 *   · logs 被截断就带 logs_omitted，面板如实写「还有 N 条没显示」。
 */
export function summarizeWorkflowRun(entry) {
  if (!entry) return null
  bumpCounters(entry)
  const endAt = typeof entry.endedAt === 'number' ? entry.endedAt : nowMs()
  const counts = { completed: 0, failed: 0, running: 0, unknown: 0 }
  for (const item of entry.items) {
    if (counts[item.status] === undefined) counts.unknown += 1
    else counts[item.status] += 1
  }
  const agentsStarted = Number.isSafeInteger(entry.agentsStarted)
    ? Math.max(entry.agentsStarted, entry.items.length + entry.itemsOmitted)
    : entry.items.length + entry.itemsOmitted
  return {
    run_id: entry.runId,
    name: entry.name,
    description: entry.description,
    status: entry.status,
    status_label: entry.status === 'running' ? 'running' : entry.status === 'completed' ? 'completed' : 'failed',
    ok: entry.status === 'completed',
    code: entry.code,
    error: entry.error,
    started_at: entry.startedAt,
    ended_at: entry.endedAt,
    // 耗时优先用引擎自己量的那一份（就是它回给调用方的 durationMs），
    // 没有时（合成/测试登记）退回本地时间戳之差。两者不会互相矛盾。
    duration_ms: Number.isFinite(entry.reportedDurationMs)
      ? Math.max(0, Math.round(entry.reportedDurationMs))
      : Math.max(0, (typeof entry.endedAt === 'number' ? entry.endedAt : endAt) - entry.startedAt),
    // 运行中时耗时还在长：面板据此决定要不要把这一栏标成「进行中」。
    live: entry.status === 'running',
    agents_started: agentsStarted,
    agents_omitted: entry.itemsOmitted,
    counts,
    declared_phases: entry.declaredPhases.slice(),
    phases: entry.phases.map(phase => ({
      title: phase.title,
      visits: phase.visits,
      started_at: phase.startedAt,
      ended_at: typeof phase.endedAt === 'number' ? phase.endedAt : null,
      duration_ms: typeof phase.endedAt === 'number'
        ? Math.max(0, phase.endedAt - phase.startedAt)
        : Math.max(0, endAt - phase.startedAt),
      live: typeof phase.endedAt !== 'number',
      completed: phase.completed,
      failed: phase.failed,
      running: phase.running,
    })),
    items: entry.items.map(item => ({
      seq: item.seq,
      label: item.label,
      phase: item.phase,
      child_id: item.childId,
      status: item.status,
      at: item.at,
    })),
    logs: entry.logs.slice(),
    logs_omitted: entry.logsOmitted,
    limits: entry.limits,
    // 面板要写出来的那句话：「只显示本次进程内的运行，重启后清空」。
    process_scoped: true,
  }
}

/** 全部运行，**最新的排最前**（面板打开就想看刚刚那次）。 */
export function listWorkflowRuns() {
  const out = []
  for (const entry of runs.values()) out.push(summarizeWorkflowRun(entry))
  return out.reverse()
}

export function getWorkflowRun(runId) {
  return summarizeWorkflowRun(record(runId))
}

/** 计数：面板摘要行要「共 N 次，其中 M 次还在跑」。 */
export function workflowRunStats() {
  let running = 0
  for (const entry of runs.values()) if (entry.status === 'running') running += 1
  return { total: runs.size, running, capacity: MAX_RUNS }
}

/** 仅测试用：清空登记表。 */
export function clearWorkflowRuns() {
  runs.clear()
}
