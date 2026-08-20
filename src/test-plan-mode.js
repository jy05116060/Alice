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

// 计划模式（阶段 3.3）测试。落库部分需要 better-sqlite3（Electron ABI）：
//   npm run test:plan-mode
const {
  PLAN_MODE_BLOCK,
  PLAN_REVIEW_QUESTION_ID,
  buildPlanReviewQuestions,
  enterPlanMode,
  exitPlanMode,
  formatPlanModeBlock,
  getPlanModeState,
  isPlanMode,
  isToolBlockedInPlanMode,
  markPlanSubmitted,
  planModeStateForUI,
  readPlanReviewVerdict,
  resetPlanMode,
  _resetPlanModeForTest,


} = await import('./runtime/plan-mode.js')
const {
  getRuntimeFlag,
  listRuntimeFlags,
  setRuntimeFlag,
  _resetRuntimeFlagsForTest,
} = await import('./runtime/plan-mode-store.js')
const { evaluateToolPolicy, classifyTool } = await import('./capabilities/tool-policy.js')
const { isToolDisabledInReadonly } = await import('./capabilities/sandbox-policy.js')
const { selectTools } = await import('./memory/tool-router.js')
const { execEnterPlanMode, execExitPlanMode } = await import('./capabilities/tools/plan.js')
const { config } = await import('./config.js')
const { TOOL_SCHEMAS } = await import('./capabilities/builtin-tools.js')

const HUMAN = { autonomous: false }
const AUTO = { autonomous: true }

// 计划模式的闸门判定需要只读档清单与风险分级，测试里显式注入（和 tool-policy 里一样）。
const blocked = name => isToolBlockedInPlanMode(name, {
  readonlyBlocked: isToolDisabledInReadonly,
  riskOf: classifyTool,
})

function clearPlan() {
  resetPlanMode()
}

try {
  // ── 1. 状态读写与持久化 ───────────────────────────────────────────────
  {
    clearPlan()
    assert.equal(isPlanMode(), false, '干净状态不在计划模式')
    assert.deepEqual(planModeStateForUI(), { on: false, entered_at: null, source: null, plan_submitted_at: null })

    const on = enterPlanMode({ source: 'model', at: '2026-07-10T12:00:00.000Z' })
    assert.equal(on.on, true)
    assert.equal(on.source, 'model')
    assert.equal(on.enteredAt, '2026-07-10T12:00:00.000Z')
    assert.equal(isPlanMode(), true)
    assert.equal(formatPlanModeBlock(), PLAN_MODE_BLOCK)

    // 重复进入是幂等的：entered_at / source 不被后来的调用覆盖
    const again = enterPlanMode({ source: 'ui', at: '2026-07-10T13:00:00.000Z' })
    assert.equal(again.enteredAt, '2026-07-10T12:00:00.000Z', '重复进入不刷新进去的时间')
    assert.equal(again.source, 'model', '重复进入不改「怎么进来的」')

    // 提交计划只记时间，不改变「还在计划模式」这件事
    const submitted = markPlanSubmitted({ at: '2026-07-10T12:30:00.000Z' })
    assert.equal(submitted.on, true, '提交计划不等于批准，必须还在计划模式')
    assert.equal(submitted.planSubmittedAt, '2026-07-10T12:30:00.000Z')

    // 退出：保留「什么时候进来的」作为事后线索
    const off = exitPlanMode({ at: '2026-07-10T13:00:00.000Z' })
    assert.equal(off.changed, true)
    assert.equal(isPlanMode(), false)
    assert.equal(formatPlanModeBlock(), '', '不在计划模式时不注入提示块')
    const raw = JSON.parse(getRuntimeFlag('plan_mode'))
    assert.equal(raw.on, false)
    assert.equal(raw.entered_at, '2026-07-10T12:00:00.000Z', '退出后仍保留进入时间，便于排查「为什么一直不动手」')

    // 重复退出是 no-op
    assert.equal(exitPlanMode().changed, false)

    // 读不出来时**默认关闭**：数据库坏了不该让爱丽丝彻底不能干活
    setRuntimeFlag('plan_mode', 'not json at all')
    assert.equal(isPlanMode(), false, '状态损坏时必须退回「不在计划模式」，否则彻底不能干活')
    // 但能解析出对象、on 又是真值时，**宁可当开着**：那是限制方向。
    // 反过来的失败模式（误当关闭 → 闸门放开 → 模型改了用户以为不会改的东西）不可撤销。
    assert.equal(isPlanMode(), false)
    setRuntimeFlag('plan_mode', JSON.stringify({ on: 'yes' }))
    assert.equal(isPlanMode(), true, '真值就按开着算——受限方向是安全方向')
    setRuntimeFlag('plan_mode', JSON.stringify({ on: 0 }))
    assert.equal(isPlanMode(), false, '假值按关着算')
    setRuntimeFlag('plan_mode', JSON.stringify({}))
    assert.equal(isPlanMode(), false, '没有 on 字段 = 没开过')
    clearPlan()
  }

  // ── 2. 闸门：什么被禁、什么放行 ───────────────────────────────────────
  {
    // 改变世界的 → 禁
    for (const name of [
      'write_file', 'edit_file', 'delete_file', 'make_dir', 'run_command', 'exec_command',
      'install_software', 'install_tool', 'kill_process', 'download_file', 'manage_tool_factory',
      'set_security', 'grant_agent_delegation', 'delegate_to_agent', 'manage_api_capability',
      'manage_reminder', 'schedule_reminder', 'set_tick_interval', 'system_browser_open',
      'system_music', 'speak', 'generate_image', 'generate_music', 'run_capability',
      'run_api_capability', 'upsert_memory', 'merge_memories', 'browser_click', 'browser_type',
      'browser_fill_form', 'browser_press_key', 'browser_clear_data', 'media_mode',
    ]) {
      assert.equal(blocked(name), true, `${name} 会改变实际状态，计划模式下必须禁`)
    }

    // 说话 / 研究 / 界面 / 自己的账本 → 放行
    for (const name of [
      'send_message', 'express', 'ask_user_question',
      'web_search', 'web_read', 'fetch_url', 'browser_read',
      'browser_navigate', 'browser_snapshot', 'browser_find', 'browser_take_screenshot',
      'search_memory', 'recall_memory', 'find_tool',
      'ui_set', 'open_doc_panel',
      'create_goal', 'update_goal', 'get_goal',
      'run_subagent', 'workflow',
      'enter_plan_mode', 'exit_plan_mode',
    ]) {
      assert.equal(blocked(name), false, `${name} 是计划模式必须能用的（说话/研究/界面/账本），不该被禁`)
    }

    // 风险 low 的自动放行（不需要逐个白名单）
    assert.equal(blocked('read_file'), false)
    assert.equal(blocked('list_dir'), false)
    assert.equal(blocked('list_processes'), false)

    // 未知工具默认按 medium → 禁。这是刻意的方向：漏禁一个变异工具的代价远大于多禁一个只读工具。
    assert.equal(blocked('some_brand_new_tool'), true, '未知工具默认在计划模式下被禁（fail-safe）')
    assert.equal(blocked(''), false, '空名字不是工具，不该当禁用处理')
  }

  // ── 3. tool-policy 里的硬拒（真正的权威闸门）──────────────────────────
  {
    clearPlan()
    // 完全权限档下，本来一切放行；计划模式必须能压过它
    const wasMode = config.security?.accessMode
    config.security = { ...(config.security || {}), accessMode: 'full' }
    try {
      assert.equal(evaluateToolPolicy('write_file', { path: 'x', content: 'a' }, HUMAN).allowed, true,
        '前提检查：完全权限档下 write_file 本来是放行的')
      assert.equal(evaluateToolPolicy('run_command', { command: 'ls' }, HUMAN).allowed, true)

      enterPlanMode({ source: 'test' })
      assert.equal(evaluateToolPolicy('write_file', { path: 'x', content: 'a' }, HUMAN).allowed, false,
        '计划模式必须压过完全权限档：档位说的是文件范围，不是可以无视用户要求的计划先行')
      const verdict = evaluateToolPolicy('run_command', { command: 'ls' }, HUMAN)
      assert.equal(verdict.allowed, false)
      assert.equal(verdict.noApproval, true, '这是硬拒，不是弹一张卡让人绕过')
      assert.ok(/计划模式/.test(verdict.reason), `拒绝理由要说清是计划模式，got: ${verdict.reason}`)

      // 说话/研究/计划工具照旧可用
      assert.equal(evaluateToolPolicy('send_message', {}, HUMAN).allowed, true)
      assert.equal(evaluateToolPolicy('web_search', {}, HUMAN).allowed, true)
      assert.equal(evaluateToolPolicy('read_file', { path: '.' }, HUMAN).allowed, true)
      assert.equal(evaluateToolPolicy('ask_user_question', {}, HUMAN).allowed, true)
      assert.equal(evaluateToolPolicy('enter_plan_mode', {}, HUMAN).allowed, true)
      assert.equal(evaluateToolPolicy('exit_plan_mode', { plan: 'x' }, HUMAN).allowed, true,
        '计划模式自己的出口不能被自己的闸门锁住')

      // 自主轮同样被拦（计划模式下连心跳也不许动手）
      assert.equal(evaluateToolPolicy('write_file', { path: 'x', content: 'a' }, AUTO).allowed, false)

      clearPlan()
      assert.equal(evaluateToolPolicy('write_file', { path: 'x', content: 'a' }, HUMAN).allowed, true,
        '退出计划模式后闸门必须放开')
    } finally {
      if (wasMode === undefined) delete config.security.accessMode
      else config.security.accessMode = wasMode
      clearPlan()
    }
  }

  // ── 4. 工具面：进出计划模式的工具何时可见 ─────────────────────────────
  {
    clearPlan()
    const normal = selectTools({ messageBody: '先给我方案，别动手', isTick: false })
    assert.ok(normal.includes('enter_plan_mode'), '不在计划模式时给进入工具')
    assert.equal(normal.includes('exit_plan_mode'), false, '不在计划模式时不该给提交计划（那是个必然失败的选项）')

    enterPlanMode({ source: 'test' })
    const planning = selectTools({ messageBody: '继续', isTick: false })
    assert.ok(planning.includes('exit_plan_mode'), '计划模式里给提交计划')
    assert.equal(planning.includes('enter_plan_mode'), false, '已经在计划模式里就不用再给进入工具')

    // 自主轮一律不给（进入是对节奏的要求，只能来自用户；提交要用户看，Tick 里没人看）
    const tick = selectTools({ messageBody: '', isTick: true })
    assert.equal(tick.includes('enter_plan_mode'), false, 'Tick 不得进入计划模式')
    assert.equal(tick.includes('exit_plan_mode'), false, 'Tick 不得提交计划')

    clearPlan()
    const prev = config.plan.enabled
    config.plan.enabled = false
    try {
      const offTools = selectTools({ messageBody: '先给我方案', isTick: false })
      assert.equal(offTools.includes('enter_plan_mode'), false, '能力关闭时不注入')
      assert.equal(offTools.includes('exit_plan_mode'), false)
    } finally {
      config.plan.enabled = prev
    }

    assert.ok(TOOL_SCHEMAS.enter_plan_mode && TOOL_SCHEMAS.exit_plan_mode)
    assert.deepEqual(TOOL_SCHEMAS.exit_plan_mode.function.parameters.required, ['plan'])
    clearPlan()
  }

  // ── 5. 进入：必须有人开口 ─────────────────────────────────────────────
  {
    clearPlan()
    const auto = JSON.parse(await execEnterPlanMode({}, AUTO))
    assert.equal(auto.ok, false)
    assert.equal(auto.code, 'HUMAN_REQUEST_REQUIRED')
    assert.equal(isPlanMode(), false, '被拒的进入绝不能留下状态')

    const human = JSON.parse(await execEnterPlanMode({ reason: '用户说先给方案' }, HUMAN))
    assert.equal(human.ok, true, human.error)
    assert.equal(human.plan_mode.on, true)
    assert.ok(/Plan mode is on/.test(human.note))
    assert.equal(human.reason, '用户说先给方案')
    clearPlan()
  }

  // ── 6. 提交计划：批准 / 打回 / 没有 UI ───────────────────────────────
  {
    clearPlan()
    // 不在计划模式时调用 → 明确报错，不静默当成功（那是状态漂移）
    const notPlanning = JSON.parse(await execExitPlanMode({ plan: 'x' }, HUMAN))
    assert.equal(notPlanning.ok, false)
    assert.equal(notPlanning.code, 'NOT_IN_PLAN_MODE')

    enterPlanMode({ source: 'test' })
    const noPlan = JSON.parse(await execExitPlanMode({}, HUMAN))
    assert.equal(noPlan.code, 'PLAN_REQUIRED')
    assert.equal(isPlanMode(), true, '缺计划文本不能顺手退出计划模式')

    // 没有 Brain UI 连接时：ask_user_question 会返回 NO_UI。
    // **绝不能因此自动退出计划模式**——用户没看到计划就放开闸门 = 计划模式失效。
    const noUi = JSON.parse(await execExitPlanMode({ plan: '1. 改 A\n2. 验证 B' }, HUMAN))
    assert.equal(noUi.ok, false)
    assert.equal(noUi.code, 'NO_UI')
    assert.equal(isPlanMode(), true, '评审卡没弹出来时，计划模式必须还在')
    assert.ok(/still active/.test(noUi.error), '要如实告诉模型闸门还锁着，并给出改用正文呈交的路')
    assert.equal(getPlanModeState().planSubmittedAt !== null, true, '提交动作已记录，便于排查')

    clearPlan()
  }

  // ── 7. 评审判定与问题卡 ───────────────────────────────────────────────
  {
    const questions = buildPlanReviewQuestions('  1. 改 A  \n2. 验证 B  ')
    assert.equal(questions.length, 1)
    assert.equal(questions[0].id, PLAN_REVIEW_QUESTION_ID)
    assert.ok(questions[0].question.includes('1. 改 A'), '计划正文要进问题，用户才看得到')
    assert.equal(questions[0].options.length, 2)
    assert.ok(/Recommended/.test(questions[0].options[0].label), '推荐项排第一并带 (Recommended)，与既有提问卡约定一致')
    assert.ok(/批准/.test(questions[0].options[0].label))

    assert.equal(readPlanReviewVerdict({ [PLAN_REVIEW_QUESTION_ID]: '批准，开始执行 (Recommended)' }).verdict, 'approved')
    assert.equal(readPlanReviewVerdict({ [PLAN_REVIEW_QUESTION_ID]: 'approve' }).verdict, 'approved')
    assert.equal(readPlanReviewVerdict({ [PLAN_REVIEW_QUESTION_ID]: '先别动，我有修改意见' }).verdict, 'rejected')
    assert.equal(readPlanReviewVerdict({ [PLAN_REVIEW_QUESTION_ID]: '第 2 步改成先跑测试' }).verdict, 'rejected',
      '自由文本（用户直接打字反馈）算打回，反馈原样回给模型')
    assert.equal(readPlanReviewVerdict({ [PLAN_REVIEW_QUESTION_ID]: '第 2 步改成先跑测试' }).text, '第 2 步改成先跑测试')
    assert.equal(readPlanReviewVerdict({}).verdict, 'unknown')
    assert.equal(readPlanReviewVerdict({ [PLAN_REVIEW_QUESTION_ID]: ['批准，开始执行 (Recommended)'] }).verdict, 'approved',
      '多选答案数组也要能判')
  }

  // ── 8. 提示块内容 ─────────────────────────────────────────────────────
  {
    assert.ok(/Plan Mode Is Active/.test(PLAN_MODE_BLOCK))
    assert.ok(/planning, not executing/.test(PLAN_MODE_BLOCK))
    assert.ok(/not available in this turn/.test(PLAN_MODE_BLOCK), '要说清工具不可用，而不是「请不要用」')
    assert.ok(/exit_plan_mode/.test(PLAN_MODE_BLOCK), '要给出提交计划的出口')
    assert.ok(/ask_user_question/.test(PLAN_MODE_BLOCK), '要指向提问工具而不是让模型瞎猜')
    assert.ok(/Do not describe this mode/.test(PLAN_MODE_BLOCK), '别把模式本身讲给用户听')
  }

  // ── 9. kv 存储层 ──────────────────────────────────────────────────────
  {
    clearPlan()
    setRuntimeFlag('demo_key', 'demo_value')
    assert.equal(getRuntimeFlag('demo_key'), 'demo_value')
    // upsert 语义：重复写是覆盖，不是插入两行
    setRuntimeFlag('demo_key', 'second')
    assert.equal(getRuntimeFlag('demo_key'), 'second')
    assert.equal(listRuntimeFlags().filter(r => r.key === 'demo_key').length, 1)
    // 不存在的键给默认值
    assert.equal(getRuntimeFlag('nope_missing', 'fallback'), 'fallback')
    assert.equal(getRuntimeFlag('nope_missing'), null)
    clearPlan()
  }

  // ── 10. 重启后仍然在计划模式（与 goal 的语义刻意相反）────────────────
  {
    clearPlan()
    enterPlanMode({ source: 'user', at: '2026-07-10T12:00:00.000Z' })
    // 模拟进程重启：只重置模块级连接缓存，不动库里的标志。
    _resetRuntimeFlagsForTest()
    assert.equal(isPlanMode(), true,
      '重启后必须仍然在计划模式：变异的代价高，宁可不许动手，等用户明确说开始做')
    assert.equal(getPlanModeState().enteredAt, '2026-07-10T12:00:00.000Z', '重启不丢「什么时候进来的」')
    // 对照：goal 的重启语义是反的（armed_epoch 让重启后自动解除续行）——
    // 两者都是「让风险大的那一侧在重启后回到安全态」。
    clearPlan()
  }

  clearPlan()
  console.log('test-plan-mode: all assertions passed')
} catch (error) {
  // 断言失败也要把标志清掉：这个测试跑在**真实的库**上，留下一个「计划模式已开启」
  // 会让爱丽丝重启后什么都不肯做，而用户完全不知道是测试干的。
  try { clearPlan() } catch { /* 清不掉也不能盖住原始错误 */ }
  console.error(error)
  process.exitCode = 1
}
