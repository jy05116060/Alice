import assert from 'assert'
import fsSync from 'fs'
import path from 'path'
import os from 'os'

// 进度写文件而不是 stdout：Electron 被管道接住时 stdout 是块缓冲的，
// 进程一旦卡死就什么都看不到，排查会变成瞎猜。写到临时目录，不污染仓库。
const PROGRESS_LOG = path.join(os.tmpdir(), 'blm-test-workflow-progress.log')
try { fsSync.writeFileSync(PROGRESS_LOG, '') } catch { /* 非致命 */ }
function mark(label) {
  try { fsSync.appendFileSync(PROGRESS_LOG, `${label}\n`) } catch { /* 非致命 */ }
  if (process.env.WF_TEST_VERBOSE) console.log(`[wf-test] ${label}`)
}

// 工作流编排引擎（阶段 2）测试。
// 需要 better-sqlite3（Electron ABI），所以用 ELECTRON_RUN_AS_NODE 跑：
//   npm run test:workflow
const { runWorkflow, validateWorkflowMeta, WORKFLOW_LIMITS_DEFAULT } = await import('./runtime/workflow-engine.js')
const { checkSchemaSubset, assertObjectSchema, validateJsonSchema } = await import('./runtime/json-schema-lite.js')
const { TOOL_SCHEMAS } = await import('./capabilities/builtin-tools.js')
const { selectTools } = await import('./memory/tool-router.js')
const { evaluateToolPolicy, classifyTool } = await import('./capabilities/tool-policy.js')
const { isFullAccessMode, config } = await import('./config.js')
const { execWorkflow } = await import('./capabilities/tools/workflow.js')
const { execRunSubagent } = await import('./capabilities/tools/subagents.js')

const META = { name: 'test-workflow', description: 'engine test' }

// 默认的 agent 桩：按 prompt 返回可预测的结果，绝不碰网络。
function stubAgent(handler) {
  return async ({ prompt, schema, label, signal }) => handler({ prompt, schema, label, signal })
}

// 全部走 stub 的快捷入口。
function run(script, { args = null, limits = null, meta = META, agent = null, signal = null } = {}) {
  mark(`run: ${String(script).replace(/\s+/g, ' ').trim().slice(0, 64)}`)
  return runWorkflow({
    script, meta, args, limits, signal,
    _runAgentForTest: agent || stubAgent(({ prompt }) => ({
      stopReason: 'completed', structured: undefined, text: `echo:${prompt}`, childId: 'sa-stub',
    })),
  })
}

try {
  // ── 1. meta 校验 ────────────────────────────────────────────────────────
  assert.deepEqual(
    { name: validateWorkflowMeta({ name: 'audit-repos', description: 'x' }).name },
    { name: 'audit-repos' },
  )
  for (const bad of [null, {}, { name: 'x' }, { description: 'x' }, { name: 'Not_Kebab', description: 'x' }]) {
    assert.throws(
      () => validateWorkflowMeta(bad),
      error => error.code === 'INVALID_META' && /name|description|object|kebab-case/.test(error.message),
      `bad meta should reject: ${JSON.stringify(bad)}`,
    )
  }
  const badMeta = await runWorkflow({ script: 'return 1', meta: { name: 'x' } })
  assert.equal(badMeta.ok, false)
  assert.equal(badMeta.code, 'INVALID_META')

  // ── 2. 空脚本 / 超大脚本 ───────────────────────────────────────────────
  const empty = await runWorkflow({ script: '   ', meta: META })
  assert.equal(empty.code, 'EMPTY_SCRIPT')
  const huge = await runWorkflow({ script: 'x'.repeat(300), meta: META, limits: { maxScriptChars: 100 } })
  assert.equal(huge.code, 'SCRIPT_TOO_LARGE')

  // ── 3. 语法错误 → SCRIPT_PARSE ─────────────────────────────────────────
  const parseFail = await run('return ((((')
  assert.equal(parseFail.ok, false)
  assert.equal(parseFail.code, 'SCRIPT_PARSE')

  // ── 4. 返回值 + args（args 必须是本 realm 的原生对象）─────────────────
  const simple = await run('return { doubled: args.n * 2, keys: Object.keys(args) }', { args: { n: 21, extra: true } })
  assert.equal(simple.ok, true)
  assert.deepEqual(simple.value, { doubled: 42, keys: ['n', 'extra'] })

  const noArgs = await run('return { isNull: args === null }')
  assert.deepEqual(noArgs.value, { isNull: true })

  // 脚本可以自己声明 const args 而不与全局冲突
  const shadow = await run('const args = 5; return args')
  assert.equal(shadow.ok, true)
  assert.equal(shadow.value, 5)

  // ── 5. agent()：无 schema 返回正文，有 schema 返回校验过的对象 ──────────
  const textRun = await run('const a = await agent("say hi"); return { a }')
  assert.equal(textRun.ok, true)
  assert.deepEqual(textRun.value, { a: 'echo:say hi' })
  assert.equal(textRun.agentsStarted, 1)

  const schemaRun = await run(
    'const a = await agent("structured", { schema: { type: "object", properties: { n: { type: "integer" } }, required: ["n"], additionalProperties: false } }); return a',
    {
      agent: stubAgent(() => ({
        stopReason: 'completed', structured: { n: 7 }, text: 'ignored', childId: 'sa-s',
      })),
    },
  )
  assert.equal(schemaRun.ok, true)
  assert.deepEqual(schemaRun.value, { n: 7 })

  // 带 schema 但没拿到合规结构化结果 → 该项为 null（不是致命错误）
  const schemaMissing = await run(
    'const a = await agent("s", { schema: { type: "object", properties: { n: { type: "integer" } } } }); return { a, isNull: a === null }',
    { agent: stubAgent(() => ({ stopReason: 'completed', structured: undefined, text: 'prose', childId: 'sa-s' })) },
  )
  assert.deepEqual(schemaMissing.value, { a: null, isNull: true })

  // ── 6. 子代理自己失败 → null（普通失败，不致命）────────────────────────
  const childFailed = await run('const a = await agent("boom"); return { a, isNull: a === null }', {
    agent: stubAgent(() => ({ stopReason: 'error', structured: undefined, text: '', childId: 'sa-f' })),
  })
  assert.equal(childFailed.ok, true)
  assert.deepEqual(childFailed.value, { a: null, isNull: true })

  // ── 7. 致命错误：参数写错 / 未知选项 / 延迟选项 / schema 越界 / provider ──
  const cases = [
    ['await agent("")', /non-empty prompt/, 'INVALID_ARGUMENT'],
    ['await agent(123)', /non-empty prompt/, 'INVALID_ARGUMENT'],
    ['await agent("p", { bogus: 1 })', /not recognized/, 'UNSUPPORTED_OPTION'],
    ['await agent("p", { label: 5 })', /must be a string/, 'INVALID_ARGUMENT'],
    ['await agent("p", { effort: "high" })', /deferred/, 'UNSUPPORTED_OPTION'],
    ['await agent("p", { schema: { type: "string" } })', /object-rooted|must be "object"/, 'UNSUPPORTED_SCHEMA'],
    ['await agent("p", { schema: { type: "object", wat: 1 } })', /not a supported keyword/, 'UNSUPPORTED_SCHEMA'],
    ['await agent("p", { provider: "somewhere-else" })', /provider override is not supported/, 'UNSUPPORTED_OPTION'],
  ]
  for (const [line, pattern, code] of cases) {
    const res = await run(`return await ${line}`)
    assert.equal(res.ok, false, `should fail: ${line}`)
    assert.equal(res.code, code, `code for ${line}: got ${res.code} (${res.error})`)
    assert.match(res.error, pattern, `message for ${line}`)
  }

  // 致命错误在 parallel 里会重新抛出（不是变 null），脚本可以显式捕获并看到 code
  const fatalInParallel = await run(`
    try { await parallel([() => agent("p", { bogus: 1 })]) }
    catch (e) { return { caught: e.code, fatal: e.fatal === true } }
    return { caught: null }
  `)
  assert.deepEqual(fatalInParallel.value, { caught: 'UNSUPPORTED_OPTION', fatal: true })
  // ……不被捕获时整个脚本失败
  const fatalUncaught = await run('return await parallel([() => agent("p", { bogus: 1 })])')
  assert.equal(fatalUncaught.ok, false)
  assert.equal(fatalUncaught.code, 'UNSUPPORTED_OPTION')

  // ── 8. parallel：普通抛错 → 该项 null，其他项照常 ───────────────────────
  const par = await run(`
    const out = await parallel([
      async () => 1,
      async () => { throw new Error("boom") },
      async () => 3,
    ])
    return { out }
  `)
  assert.deepEqual(par.value, { out: [1, null, 3] })

  // ── 9. pipeline：无栅栏、prev 首轮即 item、stage 收 (prev,item,index) ───
  const pipe = await run(`
    const out = await pipeline(["a", "b"],
      (prev, item, index) => prev + "|" + item + "|" + index,
      (prev) => prev.toUpperCase(),
    )
    return { out }
  `)
  assert.deepEqual(pipe.value, { out: ['A|A|0', 'B|B|1'] })

  // stage 抛错 → 该 item null，其余 item 不受影响；后续 stage 被跳过
  const pipeThrow = await run(`
    const seen = []
    const out = await pipeline([1, 2, 3],
      (prev) => { if (prev === 2) throw new Error("bad item"); return prev * 10 },
      (prev) => { seen.push(prev); return prev + 1 },
    )
    return { out, seen }
  `)
  assert.deepEqual(pipeThrow.value.out, [11, null, 31])
  assert.deepEqual(pipeThrow.value.seen, [10, 30], 'a nulled item must skip its remaining stages')

  // parallel/pipeline 的参数校验
  for (const [line, pattern] of [
    ['await parallel("nope")', /array of zero-argument functions/],
    ['await parallel([1, 2])', /item 0 is not a function/],
    ['await pipeline("nope", () => 1)', /items array/],
    ['await pipeline([1])', /at least one stage/],
    ['await pipeline([1], "nope")', /stage 0 is not a function/],
    ['await parallel([])', null],
    ['await pipeline([], () => 1)', null],
  ]) {
    const res = await run(`return await ${line}`)
    if (pattern === null) {
      assert.equal(res.ok, true, `should be accepted: ${line} — ${res.error}`)
    } else {
      assert.equal(res.ok, false, `should fail: ${line}`)
      assert.match(res.error, pattern, `message for ${line}`)
    }
  }

  // ── 10. phase() 粘性 + 覆盖；log() 收集 ────────────────────────────────
  const seenAgents = []
  const phased = await run(`
    phase("scan")
    await agent("one", { label: "first" })
    await agent("two", { label: "second", phase: "override" })
    phase("report")
    await agent("three", { label: "third" })
    log("done scanning")
    return true
  `, { agent: stubAgent(({ label }) => { seenAgents.push(label); return { stopReason: 'completed', structured: undefined, text: 'ok', childId: 'sa-p' } }) })
  assert.equal(phased.ok, true)
  assert.deepEqual(seenAgents, ['first', 'second', 'third'])
  assert.deepEqual(phased.phases, ['scan', 'report'])
  assert.ok(phased.logs.includes('done scanning'))

  const badPhase = await run('phase("")')
  assert.equal(badPhase.code, 'INVALID_ARGUMENT')
  const badLog = await run('log(5)')
  assert.equal(badLog.code, 'INVALID_ARGUMENT')

  // ── 11. 上限：item 数 / agent 总数 / 并发 ───────────────────────────────
  const itemCap = await run('return await parallel(new Array(6).fill(() => 1))', { limits: { maxItemsPerCall: 4 } })
  assert.equal(itemCap.ok, false)
  assert.equal(itemCap.code, 'ITEM_CAP')

  const agentCap = await run(
    'for (let i = 0; i < 5; i++) await agent("p" + i); return true',
    { limits: { maxTotalAgents: 3 } },
  )
  assert.equal(agentCap.ok, false)
  assert.equal(agentCap.code, 'AGENT_CAP')
  assert.equal(agentCap.agentsStarted, 3, 'the cap counts the agents actually started')

  let peak = 0
  let live = 0
  const concurrent = await run(
    'return await parallel([1,2,3,4,5,6].map(i => () => agent("p" + i)))',
    {
      limits: { maxConcurrentAgents: 2 },
      agent: async ({ prompt }) => {
        live += 1
        peak = Math.max(peak, live)
        await new Promise(resolve => setTimeout(resolve, 15))
        live -= 1
        return { stopReason: 'completed', structured: undefined, text: prompt, childId: 'sa-c' }
      },
    },
  )
  assert.equal(concurrent.ok, true)
  assert.equal(concurrent.value.length, 6)
  assert.equal(peak, 2, `concurrency ceiling must hold (peak was ${peak})`)

  // ── 12. 返回值必须是可无损 JSON 化的纯数据 ──────────────────────────────
  for (const [line, label] of [
    ['return { fn: () => 1 }', 'function'],
    ['return { d: new Date() }', 'Date'],
    ['return { m: new Map() }', 'Map'],
    ['return { u: undefined }', 'undefined'],
    ['return { n: NaN }', 'NaN'],
    ['return { i: 1n }', 'bigint'],
    ['const c = {}; c.self = c; return c', 'cycle'],
    ['return { s: Symbol("x") }', 'symbol'],
  ]) {
    const res = await run(line)
    assert.equal(res.ok, false, `should reject ${label}`)
    assert.equal(res.code, 'RESULT_UNSERIALIZABLE', `code for ${label}: ${res.code} (${res.error})`)
  }
  // 合法值照样通过
  const legal = await run('return { a: [1, "x", true, null], b: { c: 2 } }')
  assert.equal(legal.ok, true)
  assert.deepEqual(legal.value, { a: [1, 'x', true, null], b: { c: 2 } })

  // 脚本没有 return → null
  const noReturn = await run('const x = 1')
  assert.equal(noReturn.ok, true)
  assert.equal(noReturn.value, null)

  // ── 13. 沙箱：没有 Node 能力，动态代码生成也被关掉 ──────────────────────
  const sandbox = await run(`
    return {
      require: typeof require,
      process: typeof process,
      setTimeout: typeof setTimeout,
      console: typeof console,
      module: typeof module,
      evalBlocked: (() => { try { new Function("return 1"); return false } catch { return true } })(),
      evalBlocked2: (() => { try { eval("1"); return false } catch { return true } })(),
      // agent 是本 realm 的包装函数，它的 constructor 就是本 realm 的 Function；
      // codeGeneration 关掉后，拿它当逃逸通道会被当场拒绝。
      agentCtorBlocked: (() => { try { agent.constructor("return 1"); return false } catch { return true } })(),
      // 宿主函数（桥）则连 constructor 都摸不到。
      hostFnCtor: __BLM_BRIDGE__.agent.constructor === undefined,
      bridgeCtor: __BLM_BRIDGE__.constructor === undefined,
    }
  `)
  assert.equal(sandbox.ok, true, `sandbox script should run: ${sandbox.error}`)
  assert.deepEqual(sandbox.value, {
    require: 'undefined',
    process: 'undefined',
    setTimeout: 'undefined',
    console: 'undefined',
    module: 'undefined',
    evalBlocked: true,
    evalBlocked2: true,
    agentCtorBlocked: true,
    hostFnCtor: true,
    bridgeCtor: true,
  })

  // ── 14. 超时：墙钟到点即失败，子代理被中止 ──────────────────────────────
  const timeout = await run('await new Promise(() => {}); return 1', { limits: { deadlineMs: 150 } })
  assert.equal(timeout.ok, false)
  assert.equal(timeout.code, 'WORKFLOW_TIMEOUT')

  // ── 15. 真实默认链路：走阶段 1 的子代理（用注入的假模型，不碰网络）──────
  mark('15a: default agent path')
  const defaultPath = await runWorkflow({
    script: 'const a = await agent("hi there"); return { a, started: true }',
    meta: META,
    _streamOnceForTest: async () => ({ content: 'from real subagent path', toolCalls: [], outputItems: [], incomplete: false, aborted: false }),
  })
  assert.equal(defaultPath.ok, true, `default agent path failed: ${defaultPath.error}`)
  assert.deepEqual(defaultPath.value, { a: 'from real subagent path', started: true })
  assert.equal(defaultPath.agentsStarted, 1)

  // 真实链路 + schema：结构化结果要经过子代理的 JSON 解析与校验，不是桩里塞进去的。
  const schemaDefaultPath = await runWorkflow({
    script: 'const a = await agent("give me n", { schema: { type: "object", properties: { n: { type: "integer" } }, required: ["n"], additionalProperties: false } }); return { a, isNull: a === null }',
    meta: META,
    _streamOnceForTest: async () => ({ content: '```json\n{"n": 11}\n```', toolCalls: [], outputItems: [], incomplete: false, aborted: false }),
  })
  assert.equal(schemaDefaultPath.ok, true, `schema path failed: ${schemaDefaultPath.error}`)
  assert.deepEqual(schemaDefaultPath.value, { a: { n: 11 }, isNull: false })

  // 子代理答了不合规的 JSON → 该项为 null（普通失败，不致命）
  const schemaMismatchPath = await runWorkflow({
    script: 'const a = await agent("n", { schema: { type: "object", properties: { n: { type: "integer" } }, required: ["n"] } }); return { a, isNull: a === null }',
    meta: META,
    _streamOnceForTest: async () => ({ content: '{"n": "not-a-number"}', toolCalls: [], outputItems: [], incomplete: false, aborted: false }),
  })
  assert.equal(schemaMismatchPath.ok, true)
  assert.deepEqual(schemaMismatchPath.value, { a: null, isNull: true })

  // 父级 abort 会传导到子代理
  mark('15b: abort propagation')
  const controller = new AbortController()
  const abortRun = runWorkflow({
    script: 'return await agent("never")',
    meta: META,
    signal: controller.signal,
    _streamOnceForTest: ({ signal }) => new Promise((resolve, reject) => {
      mark(`15b: stream entered, alreadyAborted=${signal?.aborted === true}`)
      const fail = () => { mark('15b: stream rejected by abort'); reject(Object.assign(new Error('aborted'), { name: 'AbortError' })) }
      if (signal?.aborted) return fail()
      signal?.addEventListener('abort', fail, { once: true })
    }),
  })
  setTimeout(() => { mark('15b: parent abort fired'); controller.abort('test') }, 30)
  const aborted = await abortRun
  mark('15b: run returned')
  assert.equal(aborted.ok, true, 'an aborted child resolves to null, it does not crash the run')
  assert.equal(aborted.value, null)

  // ── 16. 工具面：schema 已注册、按需注入、子代理不得用工作流 ─────────────
  mark('16: tool surface')
  assert.ok(TOOL_SCHEMAS.workflow, 'workflow should be a registered built-in tool')
  assert.equal(TOOL_SCHEMAS.workflow.function.name, 'workflow')

  const userTurn = selectTools({ messageBody: '审计一下这些文件', isTick: false })
  assert.ok(userTurn.includes('workflow'), 'workflow should be exposed on a real user turn')
  const tickTurn = selectTools({ messageBody: '', isTick: true })
  assert.equal(tickTurn.includes('workflow'), false, 'a heartbeat must not expose workflow')

  const prevWorkflowEnabled = config.workflow.enabled
  config.workflow.enabled = false
  try {
    assert.equal(selectTools({ messageBody: '审计', isTick: false }).includes('workflow'), false,
      'workflow.enabled=false must remove the tool')
  } finally {
    config.workflow.enabled = prevWorkflowEnabled
  }

  assert.equal(evaluateToolPolicy('workflow', { script: 'x', meta: META }, { subagent: true }).allowed, false,
    'a sub-agent must not run a workflow (no recursive fan-out)')

  // 自主轮是第二道独立闸门（不依赖 tool-router 的注入判断）。
  const autonomousVerdict = evaluateToolPolicy('workflow', { script: 'x', meta: META }, { autonomous: true })
  if (isFullAccessMode()) {
    // 完全权限档的语义是「不要再问我」，这一档不拦（与其它工具一致）。
    assert.equal(autonomousVerdict.allowed, true)
  } else {
    assert.equal(autonomousVerdict.allowed, false, 'an autonomous turn must not start a workflow')
    assert.match(autonomousVerdict.reason || '', /user-driven|autonomous/i)
  }
  assert.equal(classifyTool('workflow'), 'high', 'workflow fans out many agents; it must be classified high')

  // ══ 17. 后台形态（run_in_background）═════════════════════════════════════
  //
  // 这一组钉的是后台形态的四条承重墙。每条都能真的失败，不是恒真断言：
  //   a) 工具面：schema 有 run_in_background，且「进程内可查、重启即失」写进了描述；
  //   b) 立刻返回：调用在子代理还挂着一项都没返回时就返回，并且状态是 running——
  //      只要有人把它改回 await，`inFlight === 0` 这条就红；
  //   c) 终态可查：跑完后 workflow_status 能拿到 completed/error 与逐项结果——
  //      只要登记表没被结算（或 status 查询读错了地方），这条就红；
  //   d) 失败不冒泡：一次后台致命失败之后，进程既没有 unhandledRejection 也没有
  //      uncaughtException，登记表里则是 error——把 catch 去掉，这条立刻红。
  // 并发上限只用纯逻辑跑（不碰数据库），放在文件末尾那一段里。
  mark('17: background mode')
  {
    const {
      startWorkflowInBackground, backgroundWorkflowCount, isWorkflowRunId, MAX_BACKGROUND_WORKFLOWS,
    } = await import('./runtime/workflow-engine.js')
    const { getWorkflowRun, clearWorkflowRuns } = await import('./runtime/workflow-runs.js')
    const { execWorkflowStatus } = await import('./capabilities/tools/workflow.js')
    const { workflowSchemas } = await import('./capabilities/schemas/workflow.js')

    // 17a. 工具面：签名里有这个开关，描述里诚实说清「只在本次进程内可查」
    const bgProp = workflowSchemas.workflow.function.parameters.properties.run_in_background
    assert.equal(bgProp?.type, 'boolean', 'schema 必须暴露 run_in_background: boolean')
    assert.ok(workflowSchemas.workflow.function.parameters.required.includes('script'), 'script 仍是必填')
    assert.equal(workflowSchemas.workflow.function.parameters.required.includes('run_in_background'), false,
      '后台是可选开关，不是必填')
    assert.match(workflowSchemas.workflow.function.description, /in memory only/,
      '工具描述必须写明登记表是内存态')
    assert.match(workflowSchemas.workflow.function.description, /restart clears/i,
      '工具描述必须写明重启即失——绝不能让人以为后台运行可以跨重启查')
    assert.ok(workflowSchemas.workflow_status, 'workflow_status 工具必须注册（后台的查询半）')
    assert.equal(workflowSchemas.workflow_status.function.name, 'workflow_status')
    assert.ok(TOOL_SCHEMAS.workflow_status, 'workflow_status 必须进内置工具表（否则模型拿不到 schema）')
    assert.match(workflowSchemas.workflow_status.function.description, /IN-MEMORY ONLY/,
      '查询工具的描述必须写明进程内可查、重启即失')

    // 17b. 立刻返回：**跑起来但还没跑完**的时候就返回了。
    // 子代理挂在一个手动闸门上，闸门只在下面的 finally 里放；所以「后台调用返回」
    // 只可能发生在不 await 到结束的情况下。
    //
    // 两个刻意的设计：
    //   · 返回本身用 Promise.race 加**明确超时**（BACKGROUND_RETURN_TIMEOUT_MS）：
    //     有人把实现改回 await，这里会**断言失败**，而不是把测试挂到天荒地老
    //     （挂住只会被 sweep 判 TIMEOUT，看不出是哪一条坏）。
    //   · 闸门在 finally 里放：无论断言在哪一行炸掉，都不能把一个后台运行永远卡住
    //     ——那会留下活着的 handle，进程退不出去（本仓库踩过这个坑）。
    clearWorkflowRuns()
    let releaseGate = null
    const gate = new Promise(resolve => { releaseGate = resolve })
    const steps = []
    const BACKGROUND_RETURN_TIMEOUT_MS = 3000
    let returnedInTime = false
    let started = null
    let returnTimer = null
    try {
      const raced = await Promise.race([
        startWorkflowInBackground({
          script: 'const a = await agent("first", { label: "第一项" }); log("first done"); const b = await agent("second", { label: "第二项" }); return { a, b }',
          meta: { name: 'background-smoke', description: 'background form test' },
          _runAgentForTest: async ({ prompt, label }) => {
            steps.push(`start:${label}`)
            await gate
            steps.push(`end:${label}`)
            return { stopReason: 'completed', structured: undefined, text: `echo:${prompt}`, childId: `sa-${label}` }
          },
        }).then(value => ({ returned: true, value })),
        new Promise(resolve => {
          returnTimer = setTimeout(() => resolve({ returned: false, value: null }), BACKGROUND_RETURN_TIMEOUT_MS)
        }),
      ])
      returnedInTime = raced.returned
      started = raced.value

      assert.equal(returnedInTime, true,
        `后台启动 ${BACKGROUND_RETURN_TIMEOUT_MS}ms 内必须返回（它不能 await 到运行结束）`)
      assert.equal(started.ok, true, `后台启动必须成功: ${started.error}`)
      assert.ok(isWorkflowRunId(started.runId), `返回合法 run id，实际 ${started.runId}`)
      assert.equal(started.status, 'running', '启动那一刻的状态就是 running')
      // 闸门一直没放，脚本最多推进到「第一项已在跑」——**绝不可能**已经跑完。
      // 这条就是「不阻塞本轮」的可证伪形式：真跑完了 steps 里就会有 end:。
      assert.deepEqual(steps.filter(s => s.startsWith('end:')), [],
        `返回时不该有任何一项已经跑完（后台调用没有 await 到结束）：${steps.join(',')}`)

      // 登记表里已经能看到它，且是 running（面板/查询都靠这一条）
      const immediate = JSON.parse(await execWorkflowStatus({ action: 'status', run_id: started.runId }))
      assert.equal(immediate.ok, true)
      assert.equal(immediate.status, 'running')
      assert.equal(immediate.done, false, '还没跑完就不是 done')
      assert.equal(immediate.live, true)
      assert.ok(backgroundWorkflowCount() >= 1, '正在跑的后台运行要计入计数')
    } finally {
      if (returnTimer) clearTimeout(returnTimer)
      releaseGate()
    }

    // 放闸门：后台运行必须**自己**把脚本继续驱动到底（不是靠调用方拉）
    await new Promise(resolve => setTimeout(resolve, 60))
    assert.ok(steps.includes('end:第二项'), `后台运行必须真的继续把脚本驱动到底，实际 ${steps.join(',')}`)

    // 17c. 终态与逐项结果都能查到
    const done = JSON.parse(await execWorkflowStatus({ action: 'status', run_id: started.runId }))
    assert.equal(done.status, 'completed', `后台运行要走到终态: ${JSON.stringify(done)}`)
    assert.equal(done.done, true)
    assert.equal(done.ok_completed, true)
    assert.equal(done.run_id, started.runId)
    assert.equal(done.name, 'background-smoke')
    assert.equal(done.agents_started, 2)
    assert.deepEqual(done.items.map(i => i.label), ['第一项', '第二项'])
    assert.deepEqual(done.items.map(i => i.status), ['completed', 'completed'])
    assert.deepEqual(done.counts, { completed: 2, failed: 0, running: 0, unknown: 0 })
    assert.ok(done.logs.includes('first done'), `log() 要留在可查结果里: ${JSON.stringify(done.logs)}`)
    assert.match(done.scope, /memory only/i, '每次查询都要带上「进程内、重启即失」的声明')
    // 工具层看到的必须跟登记表**同一份**数据（不存在两套口径）
    assert.equal(getWorkflowRun(started.runId).status, 'completed')

    // 列表形态也要能看到它（面板就是这么读的）
    const listed = JSON.parse(await execWorkflowStatus({ action: 'list' }))
    assert.equal(listed.ok, true)
    assert.equal(listed.action, 'list')
    assert.ok(listed.runs.some(r => r.run_id === started.runId), 'list 里必须能看到刚跑完的这一次')
    assert.equal(listed.runs.find(r => r.run_id === started.runId).status, 'completed')
    assert.equal(typeof listed.background_running, 'number')
    assert.match(listed.scope, /memory only/i)

    // 17d. 失败的后台运行：登记成 error，且**不**变成 unhandled rejection
    // 这里直接从事件循环上接住未处理拒绝/异常。一个 unhandled rejection 会打崩进程，
    // 所以这条断言的价值在于：它在实现里少一道 catch 时**真的会失败**。
    const rejections = []
    const exceptions = []
    const onRejection = reason => rejections.push(reason)
    const onException = error => exceptions.push(error)
    process.on('unhandledRejection', onRejection)
    process.on('uncaughtException', onException)
    let badStarted = null
    try {
      badStarted = await startWorkflowInBackground({
        script: 'await agent("")',
        meta: { name: 'background-failure', description: 'background failure test' },
      })
      assert.equal(badStarted.ok, true, '启动本身要成功——失败是运行期的事')
      assert.ok(isWorkflowRunId(badStarted.runId))
      // 等它落到终态，但**带明确上限**：等不到就断言失败，绝不挂住
      // （挂住只会让 sweep 判 TIMEOUT，看不出坏在哪一条）。
      const deadline = Date.now() + 3000
      let row = getWorkflowRun(badStarted.runId)
      while (row && row.status === 'running' && Date.now() < deadline) {
        await new Promise(resolve => setTimeout(resolve, 10))
        row = getWorkflowRun(badStarted.runId)
      }
      assert.notEqual(row?.status, 'running', '后台失败运行必须落到终态，不能一直挂着')
      // 再给微任务/事件循环几拍，把可能的未处理拒绝暴露出来
      await new Promise(resolve => setImmediate(resolve))
      await new Promise(resolve => setTimeout(resolve, 20))
    } finally {
      process.removeListener('unhandledRejection', onRejection)
      process.removeListener('uncaughtException', onException)
    }
    assert.deepEqual(rejections, [], `后台运行的失败绝不能冒泡成 unhandled rejection: ${rejections.map(String).join(' | ')}`)
    assert.deepEqual(exceptions, [], `后台运行的失败绝不能冒泡成 uncaught exception: ${exceptions.map(String).join(' | ')}`)
    const badRow = JSON.parse(await execWorkflowStatus({ action: 'status', run_id: badStarted.runId }))
    assert.equal(badRow.status, 'error', '致命失败必须如实落成 error，不能写成完成')
    assert.equal(badRow.done, true)
    assert.equal(badRow.ok_completed, false)
    assert.equal(badRow.code, 'INVALID_ARGUMENT', `失败原因要留下错误码: ${JSON.stringify(badRow)}`)
    assert.match(badRow.error || '', /non-empty prompt/)

    // 查询形态本身：不存在的 id / 形状不对的 id / 缺 id / 不认识的 action
    // 一律**明确报错**，绝不把「查不到」粉饰成「还在跑」。
    const notFound = JSON.parse(await execWorkflowStatus({ action: 'status', run_id: 'wf-zzzzzzzz-1' }))
    assert.equal(notFound.ok, false)
    assert.equal(notFound.code, 'WORKFLOW_RUN_NOT_FOUND')
    assert.match(notFound.error, /restart/i, '查不到时必须说明「可能重启过」，而不是含糊其辞')
    assert.equal(JSON.parse(await execWorkflowStatus({ action: 'status', run_id: 'not-a-run-id' })).code, 'INVALID_RUN_ID')
    assert.equal(JSON.parse(await execWorkflowStatus({ action: 'status' })).code, 'RUN_ID_REQUIRED')
    assert.equal(JSON.parse(await execWorkflowStatus({ action: 'cancel' })).code, 'INVALID_ACTION')
    assert.equal(JSON.parse(await execWorkflowStatus({})).code, 'RUN_ID_REQUIRED', '默认 action 是 status')

    // 后台运行的并发额度是**进程级**的独立小额度（防止一次对话塞进无数条扇出）。
    // 上限本身只在纯逻辑段里验（那里不碰数据库）。
    assert.equal(MAX_BACKGROUND_WORKFLOWS, 4, '后台运行上限是 4；改了就要重新想一遍「一次能烧多少额度」')
    assert.equal(backgroundWorkflowCount(), 0, '跑完的后台运行要从计数里摘掉')
  }


  // ── 18. 后台形态的纯逻辑收尾：并发上限**就是**引擎那一份，退出收尾不留句柄 ──
  //
  // 这一组刻意不查登记表，所以它约束的是引擎自己的两个不变量：
  //   a) 后台运行没有自己的并发口径——agent 并发仍然由引擎的 acquireSlot/releaseSlot
  //      与 limits.maxConcurrentAgents 决定（后台**不得**绕过它）；
  //   b) 后台运行不能把进程攥住：被永久卡住的后台运行必须允许进程退出（不泄漏句柄）。
  {
    const {
      startWorkflowInBackground, terminateBackgroundWorkflowsForExit, backgroundWorkflowCount,
    } = await import('./runtime/workflow-engine.js')

    // 18a. 并发上限：4 条后台运行**同时**扇出，逐项并发峰值仍然只能是 maxConcurrentAgents。
    // 每条运行都限到 2，并刻意把 4 条全部挂住让它们真的重叠——任何一条多要一个 slot，
    // 峰值就会超过 2，这条断言立刻红。
    let peak = 0
    let live = 0
    for (let i = 0; i < 4; i += 1) {
      const r = await startWorkflowInBackground({
        script: 'return await parallel([1,2,3,4].map(n => () => agent("p" + n)))',
        meta: { name: `bg-concurrency-${i}`, description: 'background concurrency' },
        limits: { maxConcurrentAgents: 2 },
        _runAgentForTest: async ({ prompt }) => {
          live += 1
          peak = Math.max(peak, live)
          await new Promise(resolve => setTimeout(resolve, 10))
          live -= 1
          return { stopReason: 'completed', structured: undefined, text: prompt, childId: null }
        },
      })
      assert.equal(r.ok, true, `第 ${i} 条后台运行要能启动: ${r.error}`)
    }
    const drainDeadline = Date.now() + 5000
    while (backgroundWorkflowCount() > 0 && Date.now() < drainDeadline) {
      await new Promise(resolve => setTimeout(resolve, 10))
    }
    assert.equal(peak, 2,
      `后台运行必须复用引擎的 slot 上限（每条运行 maxConcurrentAgents=2），实际峰值 ${peak}`)
    assert.equal(live, 0, '跑完的项要放掉 slot')
    assert.equal(backgroundWorkflowCount(), 0, '正常跑完的后台运行都要从「还在跑」里摘掉')

    // 18b. 退出收尾：被**永久卡住**的后台运行不能把进程攥住。
    // 判据是活跃 handle 计数——后台运行挂住前后各数一次，只要它多留下一个
    // 「活着且没 unref」的 handle，进程就退不出去（正是 sweep 判 TIMEOUT 的成因）。
    const activeHandles = () => process._getActiveHandles().filter(h => !h?._unref).length
    const baseline = activeHandles()
    const stuck = await startWorkflowInBackground({
      script: 'await agent("never resolves"); return 1',
      meta: { name: 'bg-stuck', description: 'background stuck run' },
      _runAgentForTest: () => new Promise(() => {}),
    })
    assert.equal(stuck.ok, true)
    await new Promise(resolve => setTimeout(resolve, 30))
    const withStuck = activeHandles()
    assert.ok(withStuck <= baseline + 1,
      `被卡住的后台运行不该给进程留下新的活跃 handle（基线 ${baseline}，现在 ${withStuck}）——否则进程退不出去`)

    // 退出钩子必须**同步**、幂等，并把这一轮真的 abort 掉（不 await 任何东西）
    assert.equal(terminateBackgroundWorkflowsForExit('test'), 1, '退出收尾要认出「还在跑」的那一条')
    assert.equal(terminateBackgroundWorkflowsForExit('test again'), 0, '再调一次是空转（幂等），不会重复中止')
    // abort 之后这一轮要自己走完收尾，不会永远挂在那个永不 settle 的 promise 上
    const settleDeadline = Date.now() + 3000
    while (backgroundWorkflowCount() > 0 && Date.now() < settleDeadline) {
      await new Promise(resolve => setTimeout(resolve, 10))
    }
    assert.equal(backgroundWorkflowCount(), 0,
      'abort 之后后台运行必须自己收尾并从「还在跑」里摘掉（不会永久挂住）')
  }

  // ── 19. 执行器入口：坏参数与成功结果的信封 ─────────────────────────────
  const badExec = JSON.parse(await execWorkflow({ script: '  ' }, {}))
  assert.equal(badExec.ok, false)
  assert.equal(badExec.code, 'EMPTY_SCRIPT')
  const badExecMeta = JSON.parse(await execWorkflow({ script: 'return 1', meta: null }, {}))
  assert.equal(badExecMeta.code, 'INVALID_META')

  // ── 20. run_subagent 的 result_schema 同样走强制子集检查 ───────────────
  const badSubSchema = JSON.parse(await execRunSubagent({
    prompt: 'p',
    result_schema: { type: 'object', properties: { a: { type: 'string', minLength: 3 } } },
  }, {}))
  assert.equal(badSubSchema.ok, false)
  assert.equal(badSubSchema.code, 'RESULT_SCHEMA_UNSUPPORTED')
  assert.ok(Array.isArray(badSubSchema.violations) && badSubSchema.violations.length > 0)

  const nonObjectSubSchema = JSON.parse(await execRunSubagent({ prompt: 'p', result_schema: { type: 'string' } }, {}))
  assert.equal(nonObjectSubSchema.code, 'RESULT_SCHEMA_UNSUPPORTED')

  // ── 21. schema 子集校验器本身的边界 ────────────────────────────────────
  assert.deepEqual(checkSchemaSubset({ type: 'object', properties: { a: { type: 'string' } }, required: ['a'], additionalProperties: false }), [])
  assert.ok(checkSchemaSubset({ type: ['string', 'number'] }).length > 0, 'type arrays are rejected')
  assert.ok(checkSchemaSubset({ type: 'object', required: ['ghost'] }).some(v => /ghost/.test(v)), 'required must name declared properties')
  assert.ok(checkSchemaSubset({ type: 'object', additionalProperties: 'yes' }).length > 0, 'additionalProperties must be boolean')
  assert.ok(checkSchemaSubset({ oneOf: [{ type: 'string' }] }).length > 0, 'oneOf needs at least two branches')
  assert.ok(checkSchemaSubset({ type: 'string', properties: {} }).length > 0, 'properties only fits object')
  assert.ok(checkSchemaSubset({ properties: {} }).length > 0, 'keywords need type or oneOf')
  assert.ok(checkSchemaSubset({ type: 'string', enum: [1, 2] }).some(v => /enum/.test(v)), 'enum must match the type')
  assert.ok(checkSchemaSubset({ type: 'string', enum: ['a'], const: 'b' }).some(v => /const/.test(v)), 'const must be in enum')
  assert.throws(() => assertObjectSchema({ type: 'string' }), /object-rooted|must be "object"/)
  assert.doesNotThrow(() => assertObjectSchema({ type: 'object' }))
  // 注解关键字放行，但值必须是可无损 JSON 化的
  assert.deepEqual(checkSchemaSubset({ type: 'string', description: 'd', title: 't' }), [])
  // 注解值这里只要求「能 JSON 化」，函数会被 JSON.stringify 丢掉
  assert.ok(checkSchemaSubset({ type: 'string', default: () => 1 }).length > 0, 'annotation values must be JSON data')

  // oneOf 的 exact-one 语义
  assert.equal(validateJsonSchema(5, { oneOf: [{ type: 'integer' }, { type: 'string' }] }).valid, true)
  assert.equal(validateJsonSchema('x', { oneOf: [{ type: 'string' }, { enum: ['x'] }] }).valid, false,
    'matching two branches must fail under exact-one')

  // ── 22. 限额默认值与子代理上限的联动 ───────────────────────────────────
  assert.equal(WORKFLOW_LIMITS_DEFAULT.maxConcurrentAgents, 8)
  const reported = (await run('return 1', { limits: { maxConcurrentAgents: 99 } })).limits
  assert.ok(reported.maxConcurrentAgents <= config.subagent.maxActive,
    'workflow concurrency must not exceed the subagent liveness cap')

  console.log('test-workflow: all assertions passed')
} catch (error) {
  console.error(error)
  process.exitCode = 1
}
