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

// 会话压缩（阶段 3.2）测试。落库部分需要 better-sqlite3（Electron ABI）：
//   npm run test:compaction
// 纯逻辑部分完全零依赖，可只跑 node src/test-compaction.js 的前半段。
const {
  COMPACTION_MARKER,
  estimateTokens,
  estimateMessagesTokens,
  evaluateCompactionPressure,
  computeCompactionBoundary,
  formatCompactionSummaryMessage,
  filterCompactedRows,
  buildCompactionInput,
  cleanSummary,


} = await import('./runtime/compaction-view.js')
const {
  runCompaction,
  resolveContextWindow,
  compactionSnapshot,
} = await import('./runtime/compaction.js')
const {
  insertCompaction,
  loadActiveCompaction,
  listCompactions,
  clearCompactions,
  _resetCompactionStateForTest,
} = await import('./runtime/compaction-store.js')
const {
  loadCompactionForView,
  assessCompactionPressure,
  maybeAutoCompact,
  compactNow,
  compactionStatus,
  _resetCompactionRuntimeForTest,
} = await import('./runtime/compaction-runtime.js')
const { buildLLMMessages } = await import('./runtime/messages.js')
const { config } = await import('./config.js')

function fresh() {
  clearCompactions()
  _resetCompactionRuntimeForTest()
}

function rows(n, { prefix = 'm', from = 'ID:000001' } = {}) {
  return Array.from({ length: n }, (_, i) => ({
    id: i + 1,
    role: i % 2 === 0 ? 'user' : 'jarvis',
    from_id: i % 2 === 0 ? from : 'jarvis',
    to_id: i % 2 === 0 ? 'jarvis' : from,
    content: `${prefix}${i + 1}`,
    timestamp: `2026-07-10T12:${String(i).padStart(2, '0')}:00+08:00`,
  }))
}

try {
  // ── 1. token 估算：中文不能按 chars/4 算 ──────────────────────────────
  {
    assert.equal(estimateTokens(''), 0)
    assert.equal(estimateTokens(null), 0)
    // 8 个汉字 ≈ 8 tokens（BPE 对汉字基本一字一 token）
    assert.equal(estimateTokens('爱丽丝在压缩历史'), 8)
    // 8 个拉丁字符 ≈ 2 tokens
    assert.equal(estimateTokens('abcdefgh'), 2)
    // 混排：4 汉字 + 4 拉丁 = 4 + 1
    assert.equal(estimateTokens('压缩历史abcd'), 5)
    // 同一个 100 字的字符串，中文必须显著贵于英文——这就是不能用 chars/4 的理由
    const zh = estimateTokens('压'.repeat(100))
    const en = estimateTokens('a'.repeat(100))
    assert.equal(zh, 100)
    assert.equal(en, 25)
    assert.ok(zh >= en * 3, '中文估算必须比英文贵得多，否则阈值对中文会话形同虚设')
    // 全角标点也算贵
    assert.equal(estimateTokens('，。！？'), 4)
  }

  {
    const msgs = [
      { role: 'system', content: 'a'.repeat(40) },
      { role: 'user', content: '压缩历史' },
      { role: 'assistant', content: '', tool_calls: [{ id: 'x', function: { name: 'read_file' } }] },
    ]
    const total = estimateMessagesTokens(msgs)
    assert.ok(total > 10 + 4 + 4, `每条消息的角色开销也要算进去，got ${total}`)
    assert.equal(estimateMessagesTokens([]), 0)
    assert.equal(estimateMessagesTokens(['abcd']), 1, '裸字符串也能估算')
  }

  // ── 2. 压力判定：真实 usage 优先于估算 ────────────────────────────────
  {
    const base = { contextWindow: 100000, thresholdRatio: 0.7 }
    const under = evaluateCompactionPressure({ ...base, inputTokens: 10000 })
    assert.equal(under.needed, false)
    assert.equal(under.reason, 'under-threshold')
    assert.equal(under.limit, 70000)
    assert.equal(under.source, 'usage')

    const over = evaluateCompactionPressure({ ...base, inputTokens: 70000 })
    assert.equal(over.needed, true, '正好到达阈值就该触发（>= 而不是 >）')
    assert.equal(over.source, 'usage')

    // 没有真实 usage 时用估算
    const est = evaluateCompactionPressure({ ...base, inputTokens: null, estimatedTokens: 80000 })
    assert.equal(est.needed, true)
    assert.equal(est.source, 'estimate')

    // 有真实 usage 时**不理会**估算值（估算只配当兜底）
    const usageWins = evaluateCompactionPressure({ ...base, inputTokens: 1000, estimatedTokens: 999999 })
    assert.equal(usageWins.needed, false, '真实 usage 在就必须以它为准')

    // 两个信号都没有 = 不压（不能凭「大概是满的」去压）
    const noSignal = evaluateCompactionPressure({ ...base })
    assert.equal(noSignal.needed, false)
    assert.equal(noSignal.reason, 'no-signal')

    // 阈值比例真的参与计算
    const tight = evaluateCompactionPressure({ contextWindow: 10000, thresholdRatio: 0.5, inputTokens: 5000 })
    assert.equal(tight.limit, 5000)
    assert.equal(tight.needed, true)
  }

  // ── 3. 边界计算：三条规矩 ─────────────────────────────────────────────
  {
    const window = rows(30)

    // 保护区：最近 keepRecent 条不进摘要 → 边界是 30-10=第 20 条
    const b1 = computeCompactionBoundary({ rows: window, keepRecent: 10, minMessages: 1 })
    assert.equal(b1.boundary, 20)
    assert.equal(b1.covered, 20)

    // 边界只增不减
    const b2 = computeCompactionBoundary({ rows: window, keepRecent: 10, previousBoundary: 20, minMessages: 1 })
    assert.equal(b2.boundary, null, '没有新东西可压时必须返回 null')
    assert.equal(b2.skipped, 'nothing-new')

    // 窗口变长 → 边界前进，且**从不后退**
    const longer = rows(40)
    const b3 = computeCompactionBoundary({ rows: longer, keepRecent: 10, previousBoundary: 20, minMessages: 1 })
    assert.equal(b3.boundary, 30)
    assert.ok(b3.boundary > 20, '边界只能往前走')

    // 窗口变短（窗口被裁小）→ 边界不许后退，只返回 null
    const shorter = rows(12)
    const b4 = computeCompactionBoundary({ rows: shorter, keepRecent: 10, previousBoundary: 20, minMessages: 1 })
    assert.equal(b4.boundary, null, '窗口缩小时边界绝不能后退，否则同一段被反复压')
    assert.equal(b4.skipped, 'nothing-new')

    // 当前消息永不进摘要。边界是单一 id 切点，所以切点必须**压到当前消息之前**
    // ——不能只把它从候选里挑掉（那样它照样落在切点之下被吞掉）。
    // 用窗口中间的一条当「当前消息」，才能真正验证这道闸门（keepRecent=0 绕开保护区）。
    const mid = window[4] // id=5, role=user, from_id=ID:000001, content 'm5'
    const currentMsg = { fromId: 'ID:000001', timestamp: mid.timestamp, content: mid.content }
    const b5 = computeCompactionBoundary({ rows: window, keepRecent: 0, currentMsg, minMessages: 1 })
    assert.equal(b5.boundary, 4, '切点必须停在当前消息（id=5）之前')
    const kept = filterCompactedRows(window, { coversThroughId: b5.boundary })
    assert.ok(kept.some(r => r.id === 5), '当前消息必须在视图里')
    assert.equal(kept.length, 26, 'id 1..4 进摘要，5..30 保持原文')
    assert.equal(kept[0].content, 'm5')

    // 当前消息是**最旧**那条时，前面没有可压的，只能什么都不压（而不是压掉它）
    const oldest = window[0]
    const b5b = computeCompactionBoundary({
      rows: window,
      keepRecent: 0,
      currentMsg: { fromId: 'ID:000001', timestamp: oldest.timestamp, content: oldest.content },
      minMessages: 1,
    })
    assert.equal(b5b.boundary, null, '当前消息在最前时不许压任何东西')
    assert.equal(filterCompactedRows(window, { coversThroughId: 999 }).length, 0, '切点吞掉的语义：这是为什么不能让它越过当前消息')

    // 当前消息不在窗口里（L2 心跳轮）时，正常按保护区切
    const b5c = computeCompactionBoundary({
      rows: window,
      keepRecent: 0,
      currentMsg: { fromId: 'ID:999999', timestamp: 'nope', content: 'nope' },
      minMessages: 1,
    })
    assert.equal(b5c.boundary, 30, '窗口里没有这条消息时就按常规切到尾')

    // 最少条数门槛
    const b6 = computeCompactionBoundary({ rows: rows(5), keepRecent: 0, minMessages: 8 })
    assert.equal(b6.boundary, null)
    assert.equal(b6.skipped, 'below-min-messages')

    // 空窗口 / 没有 id 的行
    assert.equal(computeCompactionBoundary({ rows: [] }).skipped, 'no-rows')
    assert.equal(computeCompactionBoundary({ rows: [{ content: 'no id' }] }).skipped, 'no-rows')
  }

  // ── 4. 视图：标记、位置、绝不吞掉没 id 的行 ───────────────────────────
  {
    const window = rows(10)
    const compaction = { coversThroughId: 6, summary: '早先聊了压缩方案', messageCount: 6 }

    const kept = filterCompactedRows(window, compaction)
    assert.equal(kept.length, 4)
    assert.deepEqual(kept.map(r => r.id), [7, 8, 9, 10])

    // 没有压缩行时原样返回（同一份引用，不做无谓拷贝）
    assert.equal(filterCompactedRows(window, null), window)

    // 合成行（无 id）一律保留：宁可不裁，也不要把可能是本轮输入的行吞掉
    const withSynthetic = [...window, { role: 'user', content: '本轮正文' }]
    assert.equal(filterCompactedRows(withSynthetic, compaction).length, 5)

    const msg = formatCompactionSummaryMessage(compaction)
    assert.equal(msg.role, 'user')
    assert.ok(msg.content.startsWith(COMPACTION_MARKER), '摘要消息必须以稳定标记开头')
    assert.ok(msg.content.includes('早先聊了压缩方案'))
    assert.ok(/first 6 messages/.test(msg.content))
    assert.ok(/not lost/.test(msg.content), '要明确告诉模型原文没丢（否则它会去问用户）')
    assert.ok(/do not re-ask/.test(msg.content))
    assert.equal(formatCompactionSummaryMessage({ summary: '' }), null, '空摘要不产生消息')
    assert.equal(formatCompactionSummaryMessage(null), null)

    // 摘要清洗：模型自带的围栏/标题要去掉，标记由我们自己加
    assert.equal(cleanSummary('```\n摘要内容\n```'), '摘要内容')
    assert.equal(cleanSummary('Summary: 内容'), '内容')
    assert.equal(cleanSummary('摘要：内容'), '内容')
    assert.equal(cleanSummary('  内容  '), '内容')
    assert.equal(cleanSummary(null), '')
  }

  // ── 5. 摘要输入：滚动的上一份摘要必须带进去 ──────────────────────────
  {
    const input = buildCompactionInput({
      rows: rows(3, { prefix: 'x' }),
      previousSummary: '之前压过一次',
      actionLog: [{ tool: 'read_file', ok: true }, { tool: 'run_command', ok: false }],
    })
    assert.ok(input.includes('PREVIOUS SUMMARY'))
    assert.ok(input.includes('之前压过一次'), '滚动摘要必须把上一份带进去，否则结果不能独立成立')
    assert.ok(input.includes('CONVERSATION EXCERPT (oldest first)'))
    assert.ok(input.includes('<ID:000001 -> jarvis> x1'), '要从标签就能看出谁说的')
    assert.ok(input.includes('<assistant -> ID:000001> x2'))
    assert.ok(input.includes('run_command (failed)'), '失败的工具调用要标出来')
    // 超长行要截断，但不能让摘要输入失控
    const long = buildCompactionInput({ rows: [{ id: 1, role: 'user', from_id: 'u', content: 'z'.repeat(5000) }] })
    assert.ok(long.length < 2000, `单行必须截断，got ${long.length}`)
  }

  // ── 6. 上下文窗口解析：配置 > 供应商元数据 > 兜底 ────────────────────
  {
    const cfg = { compaction: { contextWindow: 0, defaultContextWindow: 128000 }, baseURL: 'https://api.deepseek.com', model: 'deepseek-chat' }
    const suppliers = {
      getSupplierList: () => ({
        activeId: 'deepseek',
        suppliers: [{
          id: 'deepseek',
          baseURL: 'https://api.deepseek.com',
          models: [{ id: 'deepseek-chat', contextWindow: 65536 }],
        }],
      }),
    }
    assert.equal(resolveContextWindow({ config: cfg, suppliers }), 65536, '供应商元数据优先于兜底')
    cfg.compaction.contextWindow = 200000
    assert.equal(resolveContextWindow({ config: cfg, suppliers }), 200000, '显式配置优先于一切')
    cfg.compaction.contextWindow = 0
    assert.equal(resolveContextWindow({ config: cfg, suppliers: null }), 128000, '探测不到就走兜底')
    assert.equal(
      resolveContextWindow({ config: { compaction: { defaultContextWindow: 0 } }, suppliers: null }),
      128000,
      '兜底值本身非法时也要有一个安全值',
    )
    // 供应商列表里没有匹配 baseURL 也不该炸
    assert.equal(
      resolveContextWindow({ config: cfg, suppliers: { getSupplierList: () => ({ suppliers: [], activeId: null }) } }),
      128000,
    )
  }

  // ── 7. 落库：边界单调、视图可重放 ────────────────────────────────────
  {
    fresh()
    assert.equal(loadActiveCompaction(), null, '干净状态没有生效的压缩')

    const first = insertCompaction({ coversThroughId: 10, summary: '第一份摘要', messageCount: 10, charsBefore: 1000 })
    assert.equal(first.coversThroughId, 10)
    assert.equal(first.trigger, 'auto')
    assert.equal(first.summaryChars, '第一份摘要'.length)

    // 生效行 = 边界最大的那行，不是写入最晚的那行
    insertCompaction({ coversThroughId: 25, summary: '第二份摘要', messageCount: 25, trigger: 'manual' })
    insertCompaction({ coversThroughId: 18, summary: '乱序写入的旧边界', messageCount: 18 })
    assert.equal(loadActiveCompaction().coversThroughId, 25, '必须按边界取，不能按写入顺序取')
    assert.equal(loadActiveCompaction().summary, '第二份摘要')
    assert.equal(listCompactions().length, 3, '压缩链要保留，历史压缩后的视图才能重建')

    assert.throws(() => insertCompaction({ coversThroughId: null, summary: 'x' }), /integer coversThroughId/)

    fresh()
    assert.equal(loadActiveCompaction(), null)
    assert.equal(loadCompactionForView(), null, '没有压缩时视图注入必须安全返回 null')
  }

  // ── 8. 跑一次压缩（假 LLM）：滚动、累计、可重放 ──────────────────────
  {
    fresh()
    const window = rows(40)
    const seenInputs = []
    const fakeLLM = async ({ message }) => {
      seenInputs.push(message)
      return { content: `摘要-${seenInputs.length}` }
    }

    const cfg = { compaction: { enabled: true, keepRecent: 10, minMessages: 1, maxSummaryTokens: 800, contextWindow: 0, defaultContextWindow: 128000 } }
    const r1 = await runCompaction({ rows: window, _callLLM: fakeLLM, _config: cfg, trigger: 'auto', inputTokens: 90000 })
    assert.equal(r1.ok, true, r1.error)
    assert.equal(r1.compaction.coversThroughId, 30, '40 条、保护 10 条 → 边界 30')
    assert.equal(r1.coveredNow, 30)
    assert.equal(r1.coveredTotal, 30)
    assert.equal(r1.compaction.trigger, 'auto')
    assert.equal(r1.compaction.inputTokens, 90000, '触发时的真实用量要记下来，便于事后解释')
    assert.ok(r1.releasedChars > 0)
    assert.ok(r1.releasedTokens > 0)
    assert.equal(r1.previousSummaryFolded, false)
    assert.equal(seenInputs[0].includes('PREVIOUS SUMMARY'), false, '第一次没有上一份摘要')

    // 边界合法：视图 = 摘要 + id>30 的 10 条
    assert.equal(filterCompactedRows(window, r1.compaction).length, 10)

    // 再跑：窗口长了 → 边界前进；上一份摘要被折进去
    const longer = rows(60)
    const r2 = await runCompaction({ rows: longer, _callLLM: fakeLLM, _config: cfg })
    assert.equal(r2.compaction.coversThroughId, 50)
    assert.equal(r2.coveredNow, 20, '第二次只覆盖新增的那 20 条')
    assert.equal(r2.coveredTotal, 50, '累计覆盖量是整份摘要的范围')
    assert.equal(r2.previousSummaryFolded, true)
    assert.ok(seenInputs[1].includes('摘要-1'), '上一份摘要必须进这一次的输入')

    // 窗口没变 → 没有新东西可压，且**不调用 LLM**
    const callsBefore = seenInputs.length
    const r3 = await runCompaction({ rows: longer, _callLLM: fakeLLM, _config: cfg })
    assert.equal(r3.ok, undefined)
    assert.equal(r3.skipped, 'nothing-new')
    assert.equal(seenInputs.length, callsBefore, '没新东西可压时绝不能白调一次 LLM')

    // 关闭开关 → 直接跳过
    const off = await runCompaction({ rows: rows(80), _callLLM: fakeLLM, _config: { compaction: { enabled: false } } })
    assert.equal(off.skipped, 'disabled')

    // LLM 抛错 / 返回空 → 不写库、不抛
    const before = listCompactions().length
    const boom = await runCompaction({ rows: rows(80), _config: cfg, _callLLM: async () => { throw new Error('boom') } })
    assert.equal(boom.skipped, 'llm-failed')
    assert.ok(boom.error.includes('boom'))
    const empty = await runCompaction({ rows: rows(80), _config: cfg, _callLLM: async () => ({ content: '   ' }) })
    assert.equal(empty.skipped, 'empty-summary')
    assert.equal(listCompactions().length, before, '失败的压缩绝不能写库')

    // 失败之后边界仍然合法可用
    assert.equal(loadActiveCompaction().coversThroughId, 50)
  }

  // ── 9. 视图注入进 buildLLMMessages ───────────────────────────────────
  {
    fresh()
    const window = rows(30)
    const compaction = insertCompaction({ coversThroughId: 20, summary: '早先决定了压缩方案', messageCount: 20 })

    const withCompaction = buildLLMMessages({
      systemPrompt: 'SYS',
      conversationWindow: window,
      input: '这一轮的问题',
      compaction,
    })
    const texts = withCompaction.map(m => m.content)
    assert.ok(texts[0] === 'SYS')
    const summaryIndex = texts.findIndex(c => String(c).startsWith(COMPACTION_MARKER))
    assert.ok(summaryIndex > 0, '摘要消息必须在数组里')
    // 被覆盖的原文一条都不能出现在模型视图里
    for (const row of window.filter(r => r.id <= 20)) {
      assert.equal(texts.some(c => c === row.content), false, `被覆盖的 ${row.content} 不该出现`)
    }
    // 保护区里的原文必须原样在场
    for (const row of window.filter(r => r.id > 20)) {
      assert.ok(texts.some(c => String(c).includes(row.content)), `保护区的 ${row.content} 必须在场`)
    }
    // 摘要位置固定在运行时上下文之后、近期原文之前
    const firstKeptIndex = texts.findIndex(c => String(c).includes('m21'))
    assert.ok(summaryIndex < firstKeptIndex, '摘要必须排在近期原文之前')

    // 没有压缩时视图一字不变：system + [runtime context] + 30 条原文
    // + 一条合成的本轮 user 消息（没传 msg，且窗口里没有「当前消息」那一行）。
    const plain = buildLLMMessages({ systemPrompt: 'SYS', conversationWindow: window, input: '这一轮的问题' })
    assert.equal(plain.some(m => String(m.content).startsWith(COMPACTION_MARKER)), false)
    assert.equal(plain.length, window.length + 3)

    // L3（定时任务）同样受压缩影响，且系统信号行过滤逻辑不受影响
    const l3 = buildLLMMessages({
      systemPrompt: 'SYS', conversationWindow: window, input: 'x', runtimeLane: 'l3', compaction,
    })
    assert.ok(l3.some(m => String(m.content).startsWith(COMPACTION_MARKER)))

    fresh()
  }

  // ── 10. 运行时策略：在飞闸门 ─────────────────────────────────────────
  {
    fresh()
    _resetCompactionRuntimeForTest()
    const status = compactionStatus()
    assert.equal(status.inFlight, false)
    assert.equal(status.active, null)

    const pressure = await assessCompactionPressure({ estimatedTokens: 10 })
    assert.equal(typeof pressure.needed, 'boolean')
    assert.equal(typeof pressure.contextWindow, 'number')
    assert.equal(pressure.enabled, config.compaction.enabled !== false)

    // 在飞闸门：第一次调用**同步**就把 inFlight 占上，所以紧接着的第二次调用
    // 必定当场返回 in-flight——不需要等 LLM，也不需要真的制造慢调用。
    fresh()
    _resetCompactionRuntimeForTest()
    const first = maybeAutoCompact({ rows: rows(40) })
    const second = maybeAutoCompact({ rows: rows(40) })
    assert.equal(second.skipped, 'in-flight', '同一时刻只允许一次压缩')
    const firstResult = await first
    assert.ok(firstResult && typeof firstResult === 'object', '第一次调用要么压成功要么给出 skip 原因')

    // 跑完之后闸门放开
    assert.equal(compactionStatus().inFlight, false, '压缩结束后闸门必须放开，否则以后再也压不了')
    const third = maybeAutoCompact({ rows: rows(40) })
    assert.notEqual(third.skipped, 'in-flight')
    await third

    // 手动压缩给的是结构完整的回答（压没压成都要能解释）
    fresh()
    _resetCompactionRuntimeForTest()
    const manual = await compactNow({ rows: rows(40) })
    assert.ok(typeof manual === 'object' && manual !== null)
    if (!manual.ok) {
      assert.ok(typeof manual.skipped === 'string' && manual.skipped.length > 0, '没压成必须给出原因')
    }
    assert.equal(compactionStatus().inFlight, false)
    fresh()
  }

  // ── 11. 缺配置块时走默认值（老配置文件升级路径） ──────────────────────
  {
    fresh()
    // 老配置文件里没有 compaction 这一块。默认 keepRecent=20，40 条 → 边界 20。
    const r = await runCompaction({
      rows: rows(40),
      _config: {},
      _callLLM: async () => ({ content: '默认值下的摘要' }),
    })
    assert.equal(r.ok, true, `缺配置块时应按默认值正常压缩，got ${JSON.stringify(r.skipped)}`)
    assert.equal(r.compaction.coversThroughId, 20, '默认 keepRecent=20')
    assert.equal(r.compaction.trigger, 'auto')
    fresh()
  }

  fresh()
  console.log('test-compaction: all assertions passed')
} catch (error) {
  console.error(error)
  process.exitCode = 1
}
