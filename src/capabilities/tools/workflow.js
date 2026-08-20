// 工作流工具的推理期执行体（阶段 2 + 后台形态）。
// 结果以普通工具结果回到父 Agent 手里；进度经 SSE 推进思考流。
import {
  runWorkflow,
  startWorkflowInBackground,
  backgroundWorkflowCount,
  isWorkflowRunId,
  MAX_BACKGROUND_WORKFLOWS,
} from '../../runtime/workflow-engine.js'
import { getWorkflowRun, listWorkflowRuns } from '../../runtime/workflow-runs.js'

// 回给模型的正文上限：脚本可能返回很大的数组，但父对话的上下文是稀缺资源。
const MAX_RESULT_CHARS = 12000

// ── 诚实声明（必须出现在工具描述里，见 schemas/workflow.js）──────────────────
// 运行状态与结果来自 workflow-runs.js 的**进程内**登记表：一次进程只留最近 50 次，
// 重启即清空。所以 workflow_status 只保证「本次进程里还查得到」，不是持久历史，
// 也没有跨重启的 run id。函数名常量放在这里，工具结果与描述共用同一句话。
export const WORKFLOW_STATUS_SCOPE_NOTE =
  'workflow runs are recorded in memory only: this answer is scoped to the current process, a restart clears it, and there is no cross-restart history.'

function failureHint(code) {
  return code === 'WORKFLOW_TIMEOUT'
    ? 'The run hit its wall-clock deadline and its children were aborted. Split it into smaller runs.'
    : code === 'RESULT_UNSERIALIZABLE'
      ? 'Return only plain JSON data: objects, arrays, strings, numbers, booleans, null.'
      : code === 'AGENT_CAP' || code === 'ITEM_CAP'
        ? 'Reduce the fan-out, or raise the workflow limits in config.'
        : 'Fix the script per the error above, then run it again.'
}

/** 运行结果的正文封套（异步与后台两条路径共用，口径只有一份）。 */
function resultEnvelope(result) {
  if (!result.ok) {
    return JSON.stringify({
      ok: false,
      code: result.code || 'WORKFLOW_FAILED',
      error: result.error || 'the workflow did not complete',
      run_id: result.runId || null,
      agents_started: result.agentsStarted ?? 0,
      phases: result.phases || [],
      duration_ms: result.durationMs ?? 0,
      hint: failureHint(result.code),
    })
  }
  // 返回值可能很大。截断时必须截 JSON 文本本身，而不是截完再 parse——
  // 否则截断的 JSON 一定解析失败。
  const serialized = JSON.stringify(result.value)
  const fits = typeof serialized === 'string' && serialized.length <= MAX_RESULT_CHARS
  return JSON.stringify({
    ok: true,
    run_id: result.runId,
    name: result.name,
    ...(fits
      ? { value: serialized === undefined ? null : JSON.parse(serialized) }
      : {
        value_json_head: String(serialized).slice(0, MAX_RESULT_CHARS),
        value_note: `the return value is ${serialized.length} chars of JSON and was truncated; project fewer fields in the script or aggregate before returning`,
      }),
    agents_started: result.agentsStarted,
    duration_ms: result.durationMs,
    phases: result.phases,
    logs: (result.logs || []).slice(-20),
  })
}

export async function execWorkflow(args = {}, context = {}) {
  const script = typeof args.script === 'string' ? args.script : ''
  if (!script.trim()) {
    return JSON.stringify({ ok: false, code: 'EMPTY_SCRIPT', error: 'workflow requires a non-empty script' })
  }
  if (!args.meta || typeof args.meta !== 'object') {
    return JSON.stringify({ ok: false, code: 'INVALID_META', error: 'workflow requires a meta object with name and description' })
  }

  // 后台形态：立刻返回 run id，引擎继续在后台驱动。
  // 只允许 run_in_background === true 这一种真值写法；不确定的值按前台处理并**说明**，
  // 免得模型以为「没写成 true 也还是后台」。
  if (args.run_in_background === true) {
    const started = await startWorkflowInBackground({
      script,
      meta: args.meta,
      args: args.args === undefined ? null : args.args,
      // 父轮上下文（含父信号）**不进后台运行**：本轮一结束它的 signal 就 abort 了，
      // 传进去等于一起步就被砍。后台运行只受自己的 deadline 与进程退出约束。
      parentContext: {},
      signal: null,
    })
    if (!started.ok) {
      return JSON.stringify({
        ok: false,
        code: started.code || 'WORKFLOW_BACKGROUND_START_FAILED',
        error: started.error || 'the workflow could not be started in the background',
        run_id: started.runId || null,
        background_running: started.background_running ?? null,
        background_limit: started.background_limit ?? MAX_BACKGROUND_WORKFLOWS,
        hint: 'poll it with workflow_status(action="status", run_id=...), or run the same script in the foreground',
        scope: WORKFLOW_STATUS_SCOPE_NOTE,
      })
    }
    return JSON.stringify({
      ok: true,
      background: true,
      run_id: started.runId,
      name: started.name,
      status: started.status || 'running',
      concurrency_cap: started.concurrency,
      background_running: started.background_running,
      background_limit: started.background_limit,
      note: 'This run continues in the background and does not block this turn. Poll it with workflow_status(action="status", run_id="' + started.runId + '"); wait for status "completed" or "error" before using its result.',
      scope: WORKFLOW_STATUS_SCOPE_NOTE,
    })
  }

  const result = await runWorkflow({
    script,
    meta: args.meta,
    args: args.args === undefined ? null : args.args,
    parentContext: context,
    signal: context.signal || null,
  })
  const envelope = JSON.parse(resultEnvelope(result))
  if (args.run_in_background !== undefined && args.run_in_background !== false) {
    envelope.note = `run_in_background=${JSON.stringify(args.run_in_background)} is not a boolean true, so this ran in the foreground and blocked the turn. Pass true to run it in the background.`
  }
  return JSON.stringify(envelope)
}

/**
 * workflow_status：按 run id 查一次运行的状态与结果，或者列出本次进程内的运行。
 *
 * 这是后台形态的查询半：`workflow` 后台返回 run id 之后，模型靠它拿终态与结果。
 * 数据源就是 workflow-panel 用的那份登记表（workflow-runs.js），所以工具看到的和
 * 面板看到的**永远一致**——不存在两套口径。
 *
 * **诚实边界**：登记表是内存态。进程重启后这里只有「本次进程内的运行」，
 * 查一个不存在的 id 会明确回 WORKFLOW_RUN_NOT_FOUND 并说明原因，
 * 绝不把一个「查不到」粉饰成「还在跑」。
 */
export async function execWorkflowStatus(args = {}) {
  const action = String(args.action ?? 'status').trim().toLowerCase() || 'status'

  if (action === 'list') {
    const limit = Number.isSafeInteger(args.limit) && args.limit > 0 ? Math.min(args.limit, 50) : 10
    const all = listWorkflowRuns()
    return JSON.stringify({
      ok: true,
      action: 'list',
      count: all.length,
      shown: Math.min(limit, all.length),
      running: all.filter(run => run.status === 'running').length,
      background_running: backgroundWorkflowCount(),
      runs: all.slice(0, limit).map(run => ({
        run_id: run.run_id,
        name: run.name,
        status: run.status,
        ok: run.ok,
        code: run.code,
        error: run.error,
        agents_started: run.agents_started,
        counts: run.counts,
        duration_ms: run.duration_ms,
        live: run.live,
        started_at: run.started_at,
        ended_at: run.ended_at,
      })),
      scope: WORKFLOW_STATUS_SCOPE_NOTE,
    })
  }

  if (action !== 'status') {
    return JSON.stringify({
      ok: false,
      code: 'INVALID_ACTION',
      error: `unknown action "${action}" (supported: status, list)`,
    })
  }

  const runId = typeof args.run_id === 'string' ? args.run_id.trim() : ''
  if (!runId) {
    return JSON.stringify({ ok: false, code: 'RUN_ID_REQUIRED', error: 'workflow_status action="status" requires run_id' })
  }
  if (!isWorkflowRunId(runId)) {
    return JSON.stringify({
      ok: false,
      code: 'INVALID_RUN_ID',
      error: `"${runId}" is not a workflow run id (they look like wf-<base36 time>-<n>)`,
    })
  }

  const run = getWorkflowRun(runId)
  if (!run) {
    // 两种可能：本来就写错了（从未存在），或者进程重启过（登记表清空）。
    // 区分不了就**如实说两种可能**，不要替调用方猜一个。
    return JSON.stringify({
      ok: false,
      code: 'WORKFLOW_RUN_NOT_FOUND',
      run_id: runId,
      error: `no workflow run "${runId}" in this process. Either the id is wrong, or the process restarted — the registry is in-memory only and is cleared on restart.`,
      scope: WORKFLOW_STATUS_SCOPE_NOTE,
    })
  }

  return JSON.stringify({
    ok: true,
    action: 'status',
    run_id: run.run_id,
    name: run.name,
    status: run.status,
    done: run.status !== 'running',
    ok_completed: run.ok === true,
    code: run.code,
    error: run.error,
    agents_started: run.agents_started,
    counts: run.counts,
    duration_ms: run.duration_ms,
    live: run.live,
    started_at: run.started_at,
    ended_at: run.ended_at,
    declared_phases: run.declared_phases,
    phases: run.phases.map(phase => ({
      title: phase.title,
      live: phase.live,
      duration_ms: phase.duration_ms,
      completed: phase.completed,
      failed: phase.failed,
      running: phase.running,
    })),
    // 每一项的最终状态：后台运行跑完之后，这就是「哪一项成了、哪一项没成」。
    items: run.items.map(item => ({ seq: item.seq, label: item.label, phase: item.phase, status: item.status })),
    logs: run.logs.slice(-20),
    logs_omitted: run.logs_omitted,
    scope: WORKFLOW_STATUS_SCOPE_NOTE,
  })
}
