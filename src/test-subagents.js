import assert from 'assert'
import fs from 'fs'
import path from 'path'

// 进程内子代理（阶段 1）测试。
// 需要 better-sqlite3（Electron ABI），所以用 ELECTRON_RUN_AS_NODE 跑：
//   npm run test:subagents
const { SANDBOX_ROOT } = await import('./capabilities/sandbox.js')
const { validateJsonSchema } = await import('./runtime/json-schema-lite.js')
const {
  SUBAGENT_DEFAULT_TOOLS,
  runSubagentTask,
  spawnContinuableSubagent,
  deliverSubagentMessage,
  interruptSubagent,
  listSubagents,
  forgetSubagent,
  getSubagentLimits,
} = await import('./runtime/subagent-manager.js')
const { loadSubagentSession } = await import('./runtime/subagent-store.js')
const { evaluateToolPolicy } = await import('./capabilities/tool-policy.js')
const { TOOL_SCHEMAS } = await import('./capabilities/builtin-tools.js')
const { selectTools } = await import('./memory/tool-router.js')
const { config } = await import('./config.js')

const created = []          // 需要在结束时清理的子代理
const probeName = '__subagent_probe.txt'
let probePath = null

function cleanup() {
  for (const id of created) {
    try { forgetSubagent({ childId: id }) } catch { /* 忽略 */ }
  }
  if (probePath) {
    try { fs.rmSync(probePath, { force: true }) } catch { /* 忽略 */ }
  }
}

// 假模型：按脚本逐轮返回。脚本项 {content} 或 {toolCalls:[...]}，可选 defer（Promise）。
function makeModel(script) {
  let index = 0
  return async () => {
    const entry = typeof script === 'function' ? script(index) : script[Math.min(index, script.length - 1)]
    index += 1
    if (entry?.defer) await entry.defer
    return {
      content: entry?.content || '',
      toolCalls: entry?.toolCalls || [],
      outputItems: [],
      incomplete: false,
      aborted: false,
    }
  }
}

function tick(ms = 20) {
  return new Promise(resolve => setTimeout(resolve, ms))
}

async function liveChildId() {
  for (let i = 0; i < 100; i++) {
    const live = listSubagents().find(s => s.live && s.status === 'running')
    if (live) return live.childId
    await tick(10)
  }
  throw new Error('no running sub-agent appeared')
}

try {
  // ── 1. JSON Schema 迷你校验器 ────────────────────────────────────────────
  const schema = {
    type: 'object',
    properties: { title: { type: 'string' }, score: { type: 'integer' } },
    required: ['title'],
    additionalProperties: false,
  }
  assert.equal(validateJsonSchema({ title: 'a', score: 1 }, schema).valid, true)
  assert.equal(validateJsonSchema({ title: 'a' }, schema).valid, true)
  assert.equal(validateJsonSchema({ score: 1 }, schema).valid, false, 'missing required')
  assert.equal(validateJsonSchema({ title: 'a', extra: 1 }, schema).valid, false, 'additionalProperties:false')
  assert.equal(validateJsonSchema({ title: 2 }, schema).valid, false, 'wrong type')
  assert.equal(validateJsonSchema({ title: 'a', score: 1.5 }, schema).valid, false, 'integer rejects float')
  assert.equal(validateJsonSchema('x', { enum: ['x', 'y'] }).valid, true)
  assert.equal(validateJsonSchema('z', { enum: ['x', 'y'] }).valid, false)
  assert.equal(validateJsonSchema(5, { oneOf: [{ type: 'string' }, { type: 'integer' }] }).valid, true)
  assert.equal(validateJsonSchema(true, { oneOf: [{ type: 'string' }, { type: 'integer' }] }).valid, false)
  assert.equal(validateJsonSchema([1, 2], { type: 'array', items: { type: 'integer' } }).valid, true)
  assert.equal(validateJsonSchema([1, 'x'], { type: 'array', items: { type: 'integer' } }).valid, false)

  // ── 2. 工具 schema 已注册，且默认工具集不含通信/委派工具 ──────────────────
  for (const name of ['run_subagent', 'spawn_subagent', 'subagent_message', 'subagent_interrupt', 'subagent_list']) {
    assert.ok(TOOL_SCHEMAS[name], `${name} should be a registered built-in tool`)
    assert.equal(TOOL_SCHEMAS[name].function.name, name)
  }
  assert.equal(SUBAGENT_DEFAULT_TOOLS.includes('send_message'), false,
    'sub-agents must not be able to message the user')
  assert.equal(SUBAGENT_DEFAULT_TOOLS.includes('delegate_to_agent'), false,
    'sub-agents must not be able to delegate further')
  assert.equal(SUBAGENT_DEFAULT_TOOLS.includes('spawn_subagent'), false,
    'sub-agents must not be able to spawn sub-agents')
  assert.ok(SUBAGENT_DEFAULT_TOOLS.includes('read_file') && SUBAGENT_DEFAULT_TOOLS.includes('run_command'))

  // ── 3. 递归闸门：子代理不得派子代理（仍在完全权限档之前生效）────────────
  const recursive = evaluateToolPolicy('run_subagent', { prompt: 'x' }, { subagent: true })
  assert.equal(recursive.allowed, false, 'sub-agent spawning another sub-agent must be denied')
  assert.equal(recursive.noApproval, true, 'the recursive denial must not pop an approval card')
  assert.equal(
    evaluateToolPolicy('subagent_message', { child_id: 'a', message: 'b' }, { subagent: true }).allowed,
    false,
    'sub-agent driving another sub-agent must be denied',
  )
  assert.equal(
    evaluateToolPolicy('delegate_to_agent', {}, { subagent: true }).allowed,
    false,
    'sub-agent must not use external agent delegation',
  )

  // ── 4. 深度限制：深度 1 的子代理不能再派活 ───────────────────────────────
  const tooDeep = await runSubagentTask({
    prompt: 'nested',
    parentContext: { subagentDepth: 1 },
    _streamOnceForTest: makeModel([{ content: 'should not run' }]),
  })
  assert.equal(tooDeep.ok, false)
  assert.equal(tooDeep.code, 'SUBAGENT_LIMIT')
  assert.ok(/maxDepth/.test(tooDeep.error), 'depth error should name maxDepth')

  // ── 5. 一次性子代理：正常返回 ────────────────────────────────────────────
  const simple = await runSubagentTask({
    prompt: 'say hi',
    description: 'Greet',
    _streamOnceForTest: makeModel([{ content: 'hello from child' }]),
  })
  assert.equal(simple.ok, true)
  assert.equal(simple.content, 'hello from child')
  assert.equal(simple.stopReason, 'finished')
  assert.equal(simple.structured, null)
  assert.ok(simple.childId.startsWith('sa-'))

  // 一次性子代理完成后不在默认名册里（历史仍在库中）
  const rosterAfterOneshot = listSubagents()
  assert.equal(rosterAfterOneshot.some(s => s.childId === simple.childId), false,
    'a finished one-shot sub-agent should not linger in the default roster')
  assert.ok(loadSubagentSession(simple.childId), 'its conversation should still be persisted')

  // ── 6. 工具调用回环：子代理真的执行了工具并拿到结果 ──────────────────────
  probePath = path.join(SANDBOX_ROOT, probeName)
  fs.writeFileSync(probePath, 'probe-content-42', 'utf8')
  const withTool = await runSubagentTask({
    prompt: 'read the probe file',
    _streamOnceForTest: makeModel([
      { toolCalls: [{ id: 'c1', name: 'read_file', arguments: JSON.stringify({ path: probeName }) }] },
      { content: 'the file says probe-content-42' },
    ]),
  })
  assert.equal(withTool.ok, true)
  assert.equal(withTool.toolCalls, 1, 'one tool call should have executed')
  assert.equal(withTool.content, 'the file says probe-content-42')
  const outputItem = withTool.messages.find(m => m.type === 'function_call_output')
  assert.ok(outputItem, 'the tool result must be replayed back as function_call_output')
  assert.equal(outputItem.call_id, 'c1')
  assert.ok(String(outputItem.output).includes('probe-content-42'), 'the real file content must be in the result')

  // ── 7. 结构化结果：合规 → structured；不合规 → 明确报错而不是假装成功 ────
  const resultSchema = {
    type: 'object',
    properties: { answer: { type: 'string' } },
    required: ['answer'],
    additionalProperties: false,
  }
  const structuredOk = await runSubagentTask({
    prompt: 'give structured output',
    resultSchema,
    _streamOnceForTest: makeModel([{ content: '```json\n{"answer":"42"}\n```' }]),
  })
  assert.equal(structuredOk.ok, true)
  assert.deepEqual(structuredOk.structured, { answer: '42' }, 'fenced JSON should be parsed and validated')

  const structuredBad = await runSubagentTask({
    prompt: 'give structured output',
    resultSchema,
    _streamOnceForTest: makeModel([{ content: '{"wrong":1}' }]),
  })
  assert.equal(structuredBad.ok, false)
  assert.equal(structuredBad.schemaError !== null, true, 'schema violation must be reported')
  assert.equal(structuredBad.structured, null, 'no structured value on violation')

  const notJson = await runSubagentTask({
    prompt: 'give structured output',
    resultSchema,
    _streamOnceForTest: makeModel([{ content: 'just prose' }]),
  })
  assert.equal(notJson.ok, false)
  assert.ok(/JSON/.test(notJson.schemaError), 'non-JSON answer should say so')

  // ── 8. 可续期子代理：追问时保留历史 ──────────────────────────────────────
  const continuableModel = makeModel([{ content: 'first answer' }, { content: 'second answer' }])
  const spawned = await spawnContinuableSubagent({
    prompt: 'do the first part',
    description: 'Two rounds',
    _streamOnceForTest: continuableModel,
  })
  created.push(spawned.childId)
  assert.equal(spawned.ok, true)
  assert.equal(spawned.content, 'first answer')
  assert.equal(spawned.status, 'idle', 'a continuable sub-agent waits idle after a turn')

  const rosterWithLive = listSubagents()
  const liveEntry = rosterWithLive.find(s => s.childId === spawned.childId)
  assert.ok(liveEntry, 'a live continuable sub-agent should appear in the roster')
  assert.equal(liveEntry.live, true)
  assert.equal(liveEntry.mode, 'continuable')

  const followUp = await deliverSubagentMessage({ childId: spawned.childId, message: 'now the second part' })
  assert.equal(followUp.ok, true)
  assert.equal(followUp.content, 'second answer')

  const stored = loadSubagentSession(spawned.childId)
  const texts = stored.messages.filter(m => m.role === 'user' || m.role === 'assistant').map(m => m.content)
  assert.ok(texts.includes('do the first part'), 'the first task should stay in the conversation')
  assert.ok(texts.includes('now the second part'), 'the follow-up should be appended')

  // ── 9. 运行中发消息 → 排队（不丢），当前轮结束后自动跑 ──────────────────
  let release
  const gate = new Promise(resolve => { release = resolve })
  let concurrentPeak = 0
  let concurrentNow = 0
  const slowModel = async () => {
    concurrentNow += 1
    concurrentPeak = Math.max(concurrentPeak, concurrentNow)
    try {
      if (!release.__used) {
        release.__used = true
        await gate
        return { content: 'slow finished', toolCalls: [], outputItems: [], incomplete: false, aborted: false }
      }
      return { content: 'queued finished', toolCalls: [], outputItems: [], incomplete: false, aborted: false }
    } finally {
      concurrentNow -= 1
    }
  }

  const slowSpawn = spawnContinuableSubagent({ prompt: 'slow task', _streamOnceForTest: slowModel })
  const slowId = await liveChildId()
  created.push(slowId)

  const queued = await deliverSubagentMessage({ childId: slowId, message: 'queued follow-up' })
  assert.equal(queued.queued, true, 'a message arriving mid-turn must be queued, not lost')
  assert.equal(queued.queuedCount, 1)

  release()
  await slowSpawn
  // 排队消息由 drainPending 异步接管：轮询等它跑完
  let drained = null
  for (let i = 0; i < 100; i++) {
    await tick(20)
    const record = loadSubagentSession(slowId)
    const done = record?.messages?.some(m => m.role === 'assistant' && m.content === 'queued finished')
    if (done) { drained = record; break }
  }
  assert.ok(drained, 'the queued message should eventually run')
  assert.equal(concurrentPeak, 1, 'the same sub-agent must never run two turns at once')

  // ── 10. 中断 ─────────────────────────────────────────────────────────────
  // 假模型必须像真实流一样尊重 signal：被 abort 时以 AbortError 结束，
  // 否则这一轮永远不会退出（真实 streamOnce 就是这么做的）。
  const interruptSpawn = spawnContinuableSubagent({
    prompt: 'long task',
    _streamOnceForTest: ({ signal }) => new Promise((resolve, reject) => {
      const fail = () => reject(Object.assign(new Error('aborted'), { name: 'AbortError' }))
      if (signal?.aborted) return fail()
      signal?.addEventListener('abort', fail, { once: true })
    }),
  })
  const interruptId = await liveChildId()
  created.push(interruptId)
  const interrupted = interruptSubagent({ childId: interruptId })
  assert.equal(interrupted.ok, true)
  assert.equal(interrupted.interrupted, true, 'an actively running sub-agent should report interrupted')
  const interruptedTurn = await interruptSpawn
  assert.equal(interruptedTurn.ok, false, 'an interrupted turn must not report success')
  assert.equal(interruptedTurn.stopReason, 'aborted')

  // ── 11. 名册与限制信息 ──────────────────────────────────────────────────
  const limits = getSubagentLimits()
  assert.equal(limits.maxDepth, 1)
  assert.equal(limits.maxActive, 8)
  assert.ok(limits.running >= 0)

  // ── 12. 按需注入：真实用户轮可见，自主 Tick 不可见 ───────────────────────
  const userTurn = selectTools({ messageBody: '帮我看看这个项目', isTick: false })
  assert.ok(userTurn.includes('run_subagent'), 'run_subagent should be exposed on a real user turn')
  assert.ok(userTurn.includes('spawn_subagent'))
  assert.ok(userTurn.includes('subagent_list'))
  const tickTurn = selectTools({ messageBody: '', isTick: true })
  assert.equal(tickTurn.includes('run_subagent'), false, 'a heartbeat must not expose subagent spawning')

  // ── 13. 配置开关：enabled=false 时整套不注入 ────────────────────────────
  const previousEnabled = config.subagent.enabled
  config.subagent.enabled = false
  try {
    const disabledTurn = selectTools({ messageBody: '帮我看看这个项目', isTick: false })
    assert.equal(disabledTurn.includes('run_subagent'), false,
      'subagent.enabled=false must remove the whole tool family')
  } finally {
    config.subagent.enabled = previousEnabled
  }

  // ── 14. 未知 / 一次性子代理不能被追问 ───────────────────────────────────
  const unknown = await deliverSubagentMessage({ childId: 'sa-does-not-exist', message: 'hi' })
  assert.equal(unknown.ok, false)
  assert.equal(unknown.code, 'NO_SUCH_SUBAGENT')
  const oneshotContinue = await deliverSubagentMessage({ childId: simple.childId, message: 'hi again' })
  assert.equal(oneshotContinue.ok, false)
  assert.equal(oneshotContinue.code, 'NOT_CONTINUABLE')

  // ── 15. REST 面：名册可读、能喊停、未知 id 返回 404 ─────────────────────
  const { handleSubagentRoutes } = await import('./api/routes/subagents.js')
  const makeRes = () => ({
    status: 0,
    body: null,
    writeHead(status) { this.status = status },
    end(payload) { try { this.body = JSON.parse(payload) } catch { this.body = payload } },
  })
  const call = async (method, pathname, search = '') => {
    const res = makeRes()
    const url = new URL(`http://127.0.0.1${pathname}${search}`)
    const handled = await handleSubagentRoutes({ method }, res, url)
    return { handled, ...res }
  }

  const roster = await call('GET', '/subagents')
  assert.equal(roster.handled, true, 'GET /subagents should be handled by the subagent routes')
  assert.equal(roster.status, 200)
  assert.equal(roster.body.ok, true)
  assert.equal(roster.body.limits.maxDepth, 1)
  assert.ok(Array.isArray(roster.body.subagents))
  assert.ok(roster.body.default_tools.includes('read_file'))

  const missed = await call('POST', '/subagents/sa-nope/interrupt')
  assert.equal(missed.status, 404, 'interrupting an unknown sub-agent must be a 404, not a silent ok')
  assert.equal(missed.body.ok, false)

  const forgotten = await call('POST', `/subagents/${encodeURIComponent(spawned.childId)}/forget`)
  assert.equal(forgotten.status, 200)
  assert.equal(forgotten.body.ok, true)
  assert.equal(loadSubagentSession(spawned.childId), null, 'forget must delete the saved conversation')

  const notOurs = await call('GET', '/something-else')
  assert.equal(notOurs.handled, false, 'unrelated paths must fall through to other routers')

  console.log('test-subagents: all assertions passed')
} finally {
  cleanup()
}
