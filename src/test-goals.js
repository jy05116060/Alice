// ── 测试隔离（2026-09-30 补）
// **必须在 import db/paths 之前设置**：paths.js 在 import 时读环境变量。
// 以前这里直接用真实用户目录，于是任何一次全量回归都会在用户的真库上跑迁移
// ——rounds_total 那次就是这样把真库改掉的（40202240 → 40357888 字节）。
// 改成临时目录后，测试不再碰真实数据。
// 放在文件最顶端：静态 import 虽会被提升，但本文件对 db/paths 用的是动态 import，
// 那些发生在模块体里，一定晚于这里的赋值。
import __fs from 'node:fs'
import __os from 'node:os'
import __path from 'node:path'
const __testUserDir = __fs.mkdtempSync(__path.join(__os.tmpdir(), 'blm-suite-'))
process.env.ALICE_USER_DIR = __testUserDir
process.env.ALICE_RESOURCES_DIR = process.cwd()
process.on('exit', () => { try { __fs.rmSync(__testUserDir, { recursive: true, force: true }) } catch { /* 清理失败不影响结论 */ } })
// ─────────────────────────────────────────────────────────────────────────
import assert from 'assert'

// 长期目标 + 自动续轮（阶段 3.1）测试。需要 better-sqlite3（Electron ABI）：
//   npm run test:goals
const {
  createGoal, updateGoal, getCurrentGoal, listGoals, isGoalArmed,
  consumeGoalRound, formatGoalRoundBlock, goalSnapshot, MIN_BLOCKED_ROUNDS, GOAL_ACTION,
  _resetGoalsForTest,


} = await import('./runtime/goal-manager.js')
const { loadGoalRow, updateGoalRow, insertGoal, GOAL_STATUS, clearGoalRows } = await import('./runtime/goal-store.js')
const { TOOL_SCHEMAS } = await import('./capabilities/builtin-tools.js')
const { selectTools } = await import('./memory/tool-router.js')
const { evaluateToolPolicy } = await import('./capabilities/tool-policy.js')
const { createConsciousnessLoop } = await import('./runtime/consciousness-loop.js')
const { execCreateGoal, execUpdateGoal, execGetGoal } = await import('./capabilities/tools/goals.js')
const { config } = await import('./config.js')

const HUMAN = { autonomous: false }
const AUTO = { autonomous: true }

function fresh() {
  _resetGoalsForTest()
}

function newGoal(objective = 'migrate every call site to the new API', opts = {}) {
  const r = createGoal({ objective, ...opts })
  assert.equal(r.ok, true, `createGoal should succeed: ${r.error}`)
  return r.goal
}

try {
  // ── 1. 建目标 ─────────────────────────────────────────────────────────
  fresh()
  assert.equal(getCurrentGoal(), null, 'no goal on a clean slate')
  assert.equal(isGoalArmed(), false)
  assert.equal(formatGoalRoundBlock(), '', 'no round block without an armed goal')

  const badCreate = createGoal({ objective: '   ' })
  assert.equal(badCreate.ok, false)
  assert.equal(badCreate.code, 'INVALID_OBJECTIVE')

  const g1 = newGoal()
  assert.equal(g1.status, GOAL_STATUS.ACTIVE)
  assert.equal(g1.revision, 1)
  assert.equal(g1.roundsStarted, 0)
  assert.equal(g1.roundsTotal, 0, 'a new goal starts with a cumulative count of 0')
  assert.equal(g1.armed, true, 'a goal created in this process starts armed')
  assert.equal(g1.maxRounds, config.goal.maxRounds, 'default budget comes from config')
  assert.equal(isGoalArmed(), true)

  const explicit = createGoal({ objective: 'x', maxRounds: 5 })
  assert.equal(explicit.ok, false)
  assert.equal(explicit.code, 'GOAL_EXISTS', 'only one open goal at a time')
  assert.equal(explicit.goal.goalId, g1.goalId)

  // ── 2. CAS：revision 是硬门 ───────────────────────────────────────────
  const noRev = updateGoal({ action: GOAL_ACTION.NOTE, progressNote: 'x' })
  assert.equal(noRev.code, 'REVISION_REQUIRED')
  const staleRev = updateGoal({ revision: 99, action: GOAL_ACTION.NOTE, progressNote: 'x' })
  assert.equal(staleRev.code, 'REVISION_CONFLICT')
  assert.equal(staleRev.goal.revision, 1, 'a conflict returns the current view so the model can retry')
  const wrongId = updateGoal({ goalId: 'goal-nope', revision: 1, action: GOAL_ACTION.NOTE, progressNote: 'x' })
  assert.equal(wrongId.code, 'GOAL_NOT_FOUND')
  const badAction = updateGoal({ revision: 1, action: 'destroy' })
  assert.equal(badAction.code, 'INVALID_ACTION')

  // ── 3. note：自主轮可写，记的是「下一轮从哪继续」 ──────────────────────
  const noted = updateGoal({ revision: 1, action: GOAL_ACTION.NOTE, progressNote: '12 of 40 files done', ...AUTO })
  assert.equal(noted.ok, true, noted.error)
  assert.equal(noted.goal.progressNote, '12 of 40 files done')
  assert.equal(noted.goal.revision, 2, 'note 是一次真实写入，要动 revision')
  const noNote = updateGoal({ revision: 2, action: GOAL_ACTION.NOTE, ...AUTO })
  assert.equal(noNote.code, 'NOTE_REQUIRED')

  // ── 4. 自主轮不得改方向 / 不得自己续命 ────────────────────────────────
  for (const action of [GOAL_ACTION.EDIT, GOAL_ACTION.PAUSE, GOAL_ACTION.RESUME]) {
    const r = updateGoal({
      revision: 2, action, objective: 'new objective', ...AUTO,
    })
    assert.equal(r.code, 'HUMAN_REQUEST_REQUIRED', `autonomous ${action} must be rejected, got ${r.code}`)
  }
  // 人开口就放行
  const edited = updateGoal({ revision: 2, action: GOAL_ACTION.EDIT, objective: 'ship the migration behind a flag', ...HUMAN })
  assert.equal(edited.ok, true, edited.error)
  assert.equal(edited.goal.objective, 'ship the migration behind a flag')
  assert.equal(edited.goal.revision, 3)
  const noObjective = updateGoal({ revision: 3, action: GOAL_ACTION.EDIT, ...HUMAN })
  assert.equal(noObjective.code, 'INVALID_OBJECTIVE')

  // ── 5. 轮数预算 ───────────────────────────────────────────────────────
  fresh()
  const budgeted = newGoal('keep going until budget runs out', { maxRounds: 3 })
  const round1 = consumeGoalRound()
  assert.equal(round1.consumed, true)
  assert.equal(round1.goal.roundsStarted, 1)
  assert.equal(round1.exhausted, false)
  assert.equal(round1.goal.roundsRemaining, 2)
  consumeGoalRound()
  const round3 = consumeGoalRound()
  assert.equal(round3.exhausted, true, 'the last budgeted round reports exhaustion')
  assert.equal(round3.goal.roundsStarted, 3)
  assert.equal(round3.goal.armed, false, 'budget exhausted → no further automatic rounds')
  assert.match(round3.goal.pauseReason, /budget exhausted/i)
  assert.equal(round3.goal.status, GOAL_STATUS.ACTIVE, 'the goal itself did not fail — only its budget ran out')
  const round4 = consumeGoalRound()
  assert.equal(round4.consumed, false, 'a disarmed goal consumes nothing further')

  // resume 给人一段全新预算，而不是上次烧剩的零头
  const resumed = updateGoal({ revision: round3.goal.revision, action: GOAL_ACTION.RESUME, ...HUMAN })
  assert.equal(resumed.ok, true, resumed.error)
  assert.equal(resumed.goal.armed, true)
  assert.equal(resumed.goal.roundsStarted, 0, 'resume resets the round budget')
  assert.equal(isGoalArmed(), true)

  // ── 6. blocked 的门槛：同一阻塞条件必须已经拖过 3 轮 ──────────────────
  fresh()
  newGoal('something that will genuinely get stuck', { maxRounds: 8 })
  const early = updateGoal({ revision: 1, action: GOAL_ACTION.BLOCKED, blockedReason: 'no credentials', ...AUTO })
  assert.equal(early.code, 'BLOCKED_TOO_EARLY', `blocked must be refused before ${MIN_BLOCKED_ROUNDS} rounds`)
  const noReason = updateGoal({ revision: 1, action: GOAL_ACTION.BLOCKED, ...AUTO })
  assert.equal(noReason.code, 'BLOCKED_REASON_REQUIRED')
  consumeGoalRound(); consumeGoalRound()
  const stillEarly = updateGoal({ revision: 1, action: GOAL_ACTION.BLOCKED, blockedReason: 'no credentials', ...AUTO })
  assert.equal(stillEarly.code, 'BLOCKED_TOO_EARLY')
  consumeGoalRound()
  const blocked = updateGoal({ revision: 1, action: GOAL_ACTION.BLOCKED, blockedReason: 'no credentials', ...AUTO })
  assert.equal(blocked.ok, true, blocked.error)
  assert.equal(blocked.goal.status, GOAL_STATUS.BLOCKED)
  assert.equal(blocked.goal.blockedReason, 'no credentials')
  assert.equal(blocked.goal.armed, false)

  // ── 7. complete 之后可以立新目标 ──────────────────────────────────────
  const completed = updateGoal({ revision: blocked.goal.revision, action: GOAL_ACTION.COMPLETE, ...AUTO })
  assert.equal(completed.ok, true, completed.error)
  assert.equal(completed.goal.status, GOAL_STATUS.COMPLETE)
  assert.equal(isGoalArmed(), false)
  const afterComplete = updateGoal({ revision: completed.goal.revision, action: GOAL_ACTION.NOTE, progressNote: 'x' })
  assert.equal(afterComplete.code, 'GOAL_COMPLETE', 'a finished goal is not writable again')
  const g2 = newGoal('a brand new objective', { maxRounds: 4 })
  assert.equal(g2.revision, 1)
  assert.equal(getCurrentGoal().goalId, g2.goalId)
  assert.equal(listGoals().length, 2, 'finished goals stay in the list')

  // ── 8. 重启解除续行（armed 只在本进程内有效）───────────────────────────
  {
    const snapshot = goalSnapshot()
    // 模拟「上一世」：把 armed_epoch 改成一个不属于本进程的令牌。
    const row = loadGoalRow(g2.goalId)
    updateGoalRow(g2.goalId, { armed_epoch: 'previous-process-epoch' })
    assert.equal(getCurrentGoal().armed, false, 'a goal armed by a previous process must not continue on its own')
    assert.equal(isGoalArmed(), false)
    assert.equal(consumeGoalRound().consumed, false, 'a disarmed goal spends no rounds')
    assert.equal(formatGoalRoundBlock(), '', 'no automatic round is injected while disarmed')
    // 用户说「继续」→ 模型调 resume
    const rearmed = updateGoal({ revision: getCurrentGoal().revision, action: GOAL_ACTION.RESUME, ...HUMAN })
    assert.equal(rearmed.ok, true, rearmed.error)
    assert.equal(rearmed.goal.armed, true)
    assert.equal(rearmed.goal.armedEpoch, snapshot.processEpoch)
    assert.ok(formatGoalRoundBlock().includes('GOAL ROUND'), 'rearmed goal injects a round again')
    // 清掉模拟痕迹，免得影响后面的用例
    updateGoalRow(g2.goalId, { rounds_started: row.rounds_started })
  }

  // ── 9. 续轮提示的内容 ─────────────────────────────────────────────────
  {
    fresh()
    newGoal('audit every module under src/ and report the risky ones', { maxRounds: 6, progressNote: 'read the first 3 files' })
    const block = formatGoalRoundBlock()
    assert.ok(block.includes('GOAL ROUND 1/6'), `budget line missing: ${block.split('\n')[1]}`)
    assert.ok(block.includes('audit every module under src/'))
    assert.ok(block.includes('where you left off: read the first 3 files'))
    assert.ok(/revision: 1/.test(block), 'the round block carries the revision so no extra get_goal is needed')
    assert.ok(block.includes('action=note'), 'the block tells the model how to record progress')
    assert.ok(block.includes('action=complete'))
    assert.ok(block.includes('action=blocked'))
    assert.ok(/needs a direct user request/.test(block), 'the block states the human-only actions')
    assert.ok(/Do not end a round with zero output/.test(block))
  }

  // ── 10. 工具面：create_goal 只在真实用户轮 ────────────────────────────
  {
    const userTurn = selectTools({ messageBody: '帮我把这个项目长期维护下去', isTick: false })
    assert.ok(userTurn.includes('create_goal'), 'create_goal on a user turn')
    assert.ok(userTurn.includes('update_goal'))
    assert.ok(userTurn.includes('get_goal'))
    const tickTurn = selectTools({ messageBody: '', isTick: true })
    assert.equal(tickTurn.includes('create_goal'), false, 'an autonomous turn must not create goals')
    assert.ok(tickTurn.includes('update_goal'), 'an autonomous turn must be able to note/complete/block')
    assert.ok(tickTurn.includes('get_goal'))

    const prevEnabled = config.goal.enabled
    config.goal.enabled = false
    try {
      const off = selectTools({ messageBody: '长期目标', isTick: false })
      assert.equal(off.includes('create_goal'), false)
      assert.equal(off.includes('update_goal'), false)
      assert.equal(off.includes('get_goal'), false)
    } finally {
      config.goal.enabled = prevEnabled
    }

    assert.ok(TOOL_SCHEMAS.create_goal && TOOL_SCHEMAS.update_goal && TOOL_SCHEMAS.get_goal)
    assert.deepEqual(TOOL_SCHEMAS.update_goal.function.parameters.properties.action.enum,
      ['edit', 'note', 'pause', 'resume', 'complete', 'blocked'])
    assert.deepEqual(TOOL_SCHEMAS.update_goal.function.parameters.required, ['revision', 'action'])
  }

  // ── 11. 策略闸门（第二道，不依赖 tool-router）──────────────────────────
  {
    assert.equal(evaluateToolPolicy('create_goal', { objective: 'x' }, AUTO).allowed, false,
      'creating a goal autonomously is refused even if the tool leaks into the list')
    for (const action of ['edit', 'pause', 'resume']) {
      assert.equal(evaluateToolPolicy('update_goal', { revision: 1, action }, AUTO).allowed, false,
        `update_goal action=${action} autonomously must be refused`)
    }
    for (const action of ['note', 'complete', 'blocked']) {
      assert.equal(evaluateToolPolicy('update_goal', { revision: 1, action }, AUTO).allowed, true,
        `update_goal action=${action} must stay available autonomously`)
    }
    assert.equal(evaluateToolPolicy('create_goal', { objective: 'x' }, HUMAN).allowed, true)
    assert.equal(evaluateToolPolicy('update_goal', { revision: 1, action: 'resume' }, HUMAN).allowed, true)
    assert.equal(evaluateToolPolicy('get_goal', {}, AUTO).allowed, true)
  }

  // ── 12. 执行器信封 ────────────────────────────────────────────────────
  {
    fresh()
    const created = JSON.parse(await execCreateGoal({ objective: 'keep the docs honest', max_rounds: 4 }, HUMAN))
    assert.equal(created.ok, true, created.error)
    assert.equal(created.goal.max_rounds, 4)
    assert.equal(created.goal.armed, true)
    assert.ok(/automatic rounds/.test(created.note))

    const autoCreate = JSON.parse(await execCreateGoal({ objective: 'sneaky' }, AUTO))
    assert.equal(autoCreate.code, 'HUMAN_REQUEST_REQUIRED')

    const read = JSON.parse(await execGetGoal({}, AUTO))
    assert.equal(read.ok, true)
    assert.equal(read.goal.goal_id, created.goal.goal_id)
    assert.ok(/armed/.test(read.note))

    const updated = JSON.parse(await execUpdateGoal({
      revision: created.goal.revision, action: 'note', progress_note: 'docs/api.md rewritten',
    }, AUTO))
    assert.equal(updated.ok, true, updated.error)
    assert.equal(updated.goal.progress_note, 'docs/api.md rewritten')
    assert.ok(/next automatic round/.test(updated.note))

    const refused = JSON.parse(await execUpdateGoal({
      revision: updated.goal.revision, action: 'pause',
    }, AUTO))
    assert.equal(refused.code, 'HUMAN_REQUEST_REQUIRED')

    const withHistory = JSON.parse(await execGetGoal({ include_finished: true }, HUMAN))
    assert.ok(Array.isArray(withHistory.recent))

    const empty = JSON.parse(await execGetGoal({}, HUMAN))
    assert.ok(empty.goal, 'the goal is still readable')
  }

  // ── 13. 心跳集成：续轮段进 Tick，跑完才记预算 ─────────────────────────
  {
    function harness({ run = async () => {}, abortFirst = false } = {}) {
      const state = { rounds: 0, blocks: [], tickTexts: [], goalEvents: [] }
      let tickCount = 0
      const loop = createConsciousnessLoop({
        runTurn: async (input) => {
          state.tickTexts.push(input)
          tickCount += 1
          await run({ count: tickCount, loop })
        },
        runTurnWatchdogMs: 5000,
        getCurrentExecution: () => null,
        getCurrentAbortController: () => null,
        clearCurrentExecution: () => {},
        emitEvent: () => {},
        enqueueDueReminders: () => {},
        hasMessages: () => false,
        popMessage: () => null,
        hasUserMessages: () => false,
        getQueueSnapshot: () => ({ user: 0, background: 0 }),
        formatTick: () => 'TICK test',
        consumeTickerTick: () => {},
        decrementAwakeningTick: () => {},
        isStartupSelfCheckActive: () => false,
        isHeartbeatEnabled: () => true,
        isRunning: () => true,
        setScheduler: () => {},
        setInterruptCallback: () => {},
        isRateLimited: () => false,
        getTickInterval: n => n,
        getBaseTickInterval: () => 1000,
        getCustomIntervalMs: () => null,
        getTickerStatus: () => ({ active: false, ttl: 0, revision: 0 }),
        getAwakeningTicks: () => 0,
        isTaskActive: () => isGoalArmed(),
        formatGoalRound: () => { const b = formatGoalRoundBlock(); state.blocks.push(b); return b },
        consumeGoalRound: () => { state.rounds += 1; return consumeGoalRound() },
        emitGoalEvent: (type, payload) => state.goalEvents.push({ type, payload }),
        getNextPendingReminder: () => null,
        getQuotaStatus: () => ({ rpmUsed: 0, tpmUsed: 0, ratio: 0 }),
        startConsolidationLoop: () => {},
        ensureStartupSelfCheckState: () => {},
        setStickyEvent: () => {},
        startupSelfCheckVersion: 'test',
        priorities: { tick: 10, background: 50, user: 100 },
      })
      return { state, loop }
    }

    // 上膛：Tick 带目标段，跑完后记一轮
    fresh()
    newGoal('keep the heartbeat working on the audit', { maxRounds: 5 })
    const armed = harness()
    await armed.loop.onTick()
    assert.equal(armed.state.tickTexts.length, 1)
    assert.ok(armed.state.tickTexts[0].includes('TICK test'), 'the tick text is preserved')
    assert.ok(armed.state.tickTexts[0].includes('GOAL ROUND 1/5'), 'the goal round rides on the tick')
    assert.equal(armed.state.rounds, 1, 'a completed round consumes budget')
    assert.equal(getCurrentGoal().roundsStarted, 1)
    assert.equal(armed.state.goalEvents.length, 1)
    assert.equal(armed.state.goalEvents[0].type, 'goal_round')
    assert.equal(armed.state.goalEvents[0].payload.rounds_started, 1)

    // 未上膛：Tick 不带目标段，也不记预算
    const disarmedGoal = updateGoal({ revision: getCurrentGoal().revision, action: GOAL_ACTION.PAUSE, ...HUMAN })
    assert.equal(disarmedGoal.ok, true, disarmedGoal.error)
    const disarmed = harness()
    await disarmed.loop.onTick()
    assert.equal(disarmed.state.tickTexts[0].includes('GOAL ROUND'), false, 'no goal segment while disarmed')
    assert.equal(disarmed.state.rounds, 0, 'a disarmed goal spends nothing')
    assert.equal(disarmed.state.goalEvents.length, 0)

    // 被中断的那一轮不吃预算（用真实抛错路径，日志临时静音以免刷屏）
    fresh()
    newGoal('aborted rounds must not spend budget', { maxRounds: 5 })
    const aborted = harness({
      run: async ({ loop }) => {
        loop.markLastTickAborted()
        throw new Error('interrupted')
      },
    })
    const originalConsoleError = console.error
    console.error = () => {}
    try {
      await aborted.loop.onTick()
    } finally {
      console.error = originalConsoleError
    }
    assert.equal(aborted.state.blocks.length >= 1, true, 'the round block was offered')
    assert.equal(aborted.state.rounds, 0, 'an aborted round must not consume the goal budget')
    assert.equal(getCurrentGoal().roundsStarted, 0)

    // 用户消息轮不吃目标预算（目标段只在自主轮注入）
    fresh()
    newGoal('user turns do not spend goal rounds', { maxRounds: 5 })
    let userTurnText = null
    const withMessage = createConsciousnessLoop({
      runTurn: async (input) => { userTurnText = input },
      runTurnWatchdogMs: 5000,
      getCurrentExecution: () => null,
      getCurrentAbortController: () => null,
      clearCurrentExecution: () => {},
      emitEvent: () => {},
      enqueueDueReminders: () => {},
      hasMessages: () => true,
      popMessage: () => ({ raw: '顺便看看审计', fromId: 'ID:000001', queueName: 'user' }),
      hasUserMessages: () => true,
      getQueueSnapshot: () => ({ user: 1, background: 0 }),
      formatTick: () => 'TICK test',
      consumeTickerTick: () => {},
      decrementAwakeningTick: () => {},
      isStartupSelfCheckActive: () => false,
      isHeartbeatEnabled: () => true,
      isRunning: () => true,
      setScheduler: () => {},
      setInterruptCallback: () => {},
      isRateLimited: () => false,
      getTickInterval: n => n,
      getBaseTickInterval: () => 1000,
      getCustomIntervalMs: () => null,
      getTickerStatus: () => ({ active: false, ttl: 0, revision: 0 }),
      getAwakeningTicks: () => 0,
      isTaskActive: () => isGoalArmed(),
      formatGoalRound: () => formatGoalRoundBlock(),
      consumeGoalRound: () => { throw new Error('a user message turn must never spend a goal round') },
      emitGoalEvent: () => {},
      getNextPendingReminder: () => null,
      getQuotaStatus: () => ({ rpmUsed: 0, tpmUsed: 0, ratio: 0 }),
      startConsolidationLoop: () => {},
      ensureStartupSelfCheckState: () => {},
      setStickyEvent: () => {},
      startupSelfCheckVersion: 'test',
      priorities: { tick: 10, background: 50, user: 100 },
    })
    await withMessage.onTick()
    assert.equal(userTurnText, '顺便看看审计', 'the queued user message is passed through unchanged')
    assert.equal(getCurrentGoal().roundsStarted, 0, 'a user turn must not consume goal rounds')
  }

  // ── 14. 存储层兜底 ────────────────────────────────────────────────────
  {
    fresh()
    insertGoal({ goalId: 'goal-orphan', objective: 'orphan', armedEpoch: 'x' })
    const row = loadGoalRow('goal-orphan')
    assert.equal(row.status, GOAL_STATUS.ACTIVE)
    assert.equal(row.progress_note, '')
    assert.equal(getCurrentGoal().goalId, 'goal-orphan', 'a goal written directly to the store is still found')
    clearGoalRows()
    assert.equal(getCurrentGoal(), null, 'clearing the table clears the cached id too')
  }

  // ── 15. REST 面：页面刷新后 UI 能重新拿到目标状态 ──────────────────────
  {
    const { handleGoalRoutes } = await import('./api/routes/goals.js')
    const callRoute = async (path, method = 'GET') => {
      const url = new URL(`http://127.0.0.1:3000${path}`)
      let status = null
      let body = null
      const res = {
        writeHead(code) { status = code },
        end(payload) { body = JSON.parse(payload) },
        setHeader() {},
      }
      const handled = await handleGoalRoutes({ method }, res, url)
      return { handled, status, body }
    }
    fresh()
    const none = await callRoute('/goal')
    assert.equal(none.handled, true)
    assert.equal(none.status, 200)
    assert.equal(none.body.goal, null)
    assert.equal(none.body.armed, false)

    const g = newGoal('expose the goal over HTTP', { maxRounds: 7 })
    const one = await callRoute('/goal')
    assert.equal(one.body.goal.goal_id, g.goalId)
    assert.equal(one.body.goal.max_rounds, 7)
    assert.equal(one.body.goal.status, 'active')
    assert.equal(one.body.armed, true)
    assert.equal(one.body.goal.rounds_remaining, 7)

    updateGoal({ revision: g.revision, action: GOAL_ACTION.NOTE, progressNote: 'wrote the route', ...AUTO })
    const done = await callRoute('/goal?include_done=1')
    assert.equal(done.body.goal.progress_note, 'wrote the route')
    assert.ok(Array.isArray(done.body.recent))

    const unrelated = await callRoute('/goals')
    assert.equal(unrelated.handled, false, 'an unrelated path must not be claimed by the goal route')
  }

  // ── 15. 事件通道：目标的变更必须真的推给 UI（否则 Brain UI 只有工具行没有状态）──
  {
    const { getLatestEventId, flushEventsSince } = await import('./events.js')
    const capture = async (fn) => {
      const before = getLatestEventId()
      await fn()
      const seen = []
      const fakeRes = { write(chunk) { seen.push(String(chunk)); return true } }
      flushEventsSince(fakeRes, before)
      return seen.join('')
    }

    fresh()
    const created = await capture(() => execCreateGoal({ objective: 'watch this over the wire' }, HUMAN))
    assert.ok(created.includes('goal_created'), `goal_created must reach the event channel, got: ${created.slice(0, 120)}`)
    assert.ok(created.includes('watch this over the wire'))

    const updated = await capture(() => execUpdateGoal({
      revision: getCurrentGoal().revision, action: GOAL_ACTION.BLOCKED, blocked_reason: 'nope',
    }, AUTO))
    // blocked 太早会被拒——那就先花完 3 轮，再确认事件确实带上了 action
    for (let i = 0; i < 3; i++) consumeGoalRound()
    const blockedEvent = await capture(() => execUpdateGoal({
      revision: getCurrentGoal().revision, action: GOAL_ACTION.BLOCKED, blocked_reason: 'no credentials',
    }, AUTO))
    assert.ok(blockedEvent.includes('goal_updated'), `goal_updated must reach the event channel, got: ${blockedEvent.slice(0, 120)}`)
    assert.ok(blockedEvent.includes('"action":"blocked"'), 'the event carries which action happened')
    assert.ok(blockedEvent.includes('no credentials'), 'the event carries the blocked reason for the UI')
    assert.equal(updated.includes('goal_updated'), false, 'a refused update must not emit an event')
  }

  fresh()
  console.log('test-goals: all assertions passed')
} catch (error) {
  console.error(error)
  process.exitCode = 1
}
