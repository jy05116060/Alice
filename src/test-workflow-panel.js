import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

// 工作流运行面板的数据接口测试：GET /workflow/runs 与 /workflow/runs/:id 的
// **服务端展示字段** —— 阶段进度、每项子代理状态、耗时、错误码、截断标记。
//
// 为什么这些字段值得单独测：面板跑在浏览器里，import 不到 src/runtime/，所以这些数字
// 只能是服务端算的，面板只负责摆出来。这里要钉死的是**诚实性**，失败方向有两种：
//   1. 「运行成功」被写成整个运行都成了，而某一项子代理其实返回了 null；
//   2. 失败 / 超时 / 被上限截断被粉饰成「完成」——用户看不到错误码，就无从排查。
// 还有一条同样重要：登记表是**内存态**，重启即清空，所以 process_scoped 必须是 true，
// 面板据此才会在界面上写明「只显示本次进程内的运行」。
//
// 用临时目录，不碰真实数据：
//   npm run test:workflow-panel
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'blm-workflow-panel-'))
process.env.ALICE_USER_DIR = tmp
process.env.ALICE_RESOURCES_DIR = process.cwd()

let closeDBForTest = null

try {
  const dbModule = await import('./db.js')
  closeDBForTest = dbModule.closeDBForTest
  const { runWorkflow } = await import('./runtime/workflow-engine.js')
  const { clearWorkflowRuns, listWorkflowRuns, workflowRunStats } = await import('./runtime/workflow-runs.js')
  const { handleWorkflowRoutes } = await import('./api/routes/workflow.js')

  const call = async (method, pathname) => {
    const url = new URL(`http://127.0.0.1:3000${pathname}`)
    let status = null
    let payload = null
    const res = {
      writeHead(code) { status = code },
      setHeader() {},
      end(chunk) { payload = chunk ? JSON.parse(chunk) : null },
    }
    const req = { method, headers: {}, on() {} }
    const handled = await handleWorkflowRoutes(req, res, url)
    return { handled, status, payload }
  }

  const META = { name: 'panel-test', description: 'workflow run panel test' }
  const okAgent = async ({ prompt, label }) => ({
    stopReason: 'completed', structured: undefined, text: `echo:${prompt}`, childId: `sa-${label || 'x'}`,
  })
  const run = (script, { agent = null, limits = null, meta = META } = {}) => runWorkflow({
    script, meta, limits,
    _runAgentForTest: agent || okAgent,
  })

  // ── 1. 空登记：结构完整，而不是 404 / null；且只认领自己的路径 ──────────
  {
    clearWorkflowRuns()
    const empty = await call('GET', '/workflow/runs')
    assert.equal(empty.handled, true, '这条路径由本路由认领')
    assert.equal(empty.status, 200)
    assert.equal(empty.payload.ok, true)
    assert.deepEqual(empty.payload.runs, [])
    assert.equal(empty.payload.count, 0)
    assert.equal(empty.payload.total, 0)
    assert.equal(empty.payload.running, 0)
    assert.equal(empty.payload.truncated, false)
    assert.ok(empty.payload.capacity > 0, '面板要能说清登记表的容量')
    assert.equal(empty.payload.process_scoped, true, '内存态这件事必须由接口显式说出来')

    // 不认领的路径/方法要留给后面的路由
    assert.equal((await call('GET', '/workflow')).handled, false)
    assert.equal((await call('POST', '/workflow/runs')).handled, false, '只读端点：不接受写入')
    assert.equal((await call('DELETE', '/workflow/runs')).handled, false)
    assert.equal((await call('GET', '/workflow/runs/a/b')).handled, false, '多一段路径不是本路由的形状')
  }

  // ── 2. 成功的一次运行：阶段、每项、计数、耗时都要能对上 ─────────────────
  let okRun = null
  {
    okRun = await run(`
      phase("准备");
      const a = await agent("one", { label: "第一项" });
      phase("执行");
      const items = await pipeline([1, 2], async (item) => agent("item " + item, { label: "p" + item, phase: "执行" }));
      log("全部跑完");
      return { a, items };
    `)
    assert.equal(okRun.ok, true, JSON.stringify(okRun))
    assert.equal(okRun.agentsStarted, 3)

    const list = await call('GET', '/workflow/runs')
    assert.equal(list.payload.count, 1)
    assert.equal(list.payload.total, 1)
    assert.equal(list.payload.running, 0)
    const row = list.payload.runs[0]
    assert.equal(row.run_id, okRun.runId)
    assert.equal(row.name, 'panel-test')
    assert.equal(row.status, 'completed')
    assert.equal(row.ok, true)
    assert.equal(row.code, null)
    assert.equal(row.error, null)
    assert.equal(row.live, false, '跑完了就不该还标「进行中」')
    assert.ok(Number.isFinite(row.duration_ms) && row.duration_ms >= 0)
    assert.ok(row.ended_at >= row.started_at)
    assert.equal(row.agents_started, 3)
    assert.equal(row.agents_omitted, 0)
    assert.deepEqual(row.counts, { completed: 3, failed: 0, running: 0, unknown: 0 })
    assert.equal(row.process_scoped, true)

    assert.deepEqual(row.phases.map(p => p.title), ['准备', '执行'], '阶段按发生顺序')
    for (const phase of row.phases) {
      assert.equal(phase.live, false)
      assert.ok(phase.ended_at !== null, '运行结束了，阶段就该有终点')
      assert.ok(phase.duration_ms >= 0)
      assert.equal(phase.visits, 1)
    }
    assert.deepEqual(
      row.phases.map(p => p.completed),
      [1, 2],
      '阶段计数要按 item 的 phase 归属算',
    )

    assert.equal(row.items.length, 3)
    assert.deepEqual(row.items.map(i => i.status), ['completed', 'completed', 'completed'])
    assert.equal(row.items[0].seq, 1)
    assert.equal(row.items[0].label, '第一项')
    assert.equal(row.items[0].phase, '准备')
    assert.equal(row.items[1].phase, '执行')
    assert.equal(row.items[1].child_id, 'sa-p1')
    assert.deepEqual(row.logs, ['全部跑完'])
    assert.equal(row.logs_omitted, 0)
    assert.ok(row.limits && Number.isFinite(row.limits.maxTotalAgents), '面板要能显示本次用的限额')

    // 详情端点：单次运行同一个形状
    const detail = await call('GET', `/workflow/runs/${okRun.runId}`)
    assert.equal(detail.handled, true)
    assert.equal(detail.status, 200)
    assert.equal(detail.payload.ok, true)
    assert.equal(detail.payload.process_scoped, true)
    assert.deepEqual(detail.payload.run, row, '详情与清单里的同一次运行必须是同一份数据')
  }

  // ── 2b. 登记表自己的账要算对：没回报结果的项不许被算到别人头上 ──────────
  {
    const { beginWorkflowRun, endWorkflowRun, noteWorkflowAgentStart, noteWorkflowAgentEnd } =
      await import('./runtime/workflow-runs.js')
    // 刻意**不清空**登记表：这里只是往后面追加一次合成运行，
    // 前面那次真实运行的记录要留着给后面的排序断言用。
    beginWorkflowRun({ runId: 'wf-synthetic', name: 'synthetic', description: '', phases: [], limits: null })
    noteWorkflowAgentStart('wf-synthetic', { seq: 1, label: '第一项' })
    // agentEnd 没见过对应的 agentStart：只补自己那一条，绝不能把第一项改成失败
    noteWorkflowAgentEnd('wf-synthetic', { seq: 2, label: '孤儿项', outcome: 'completed' })
    endWorkflowRun('wf-synthetic', { ok: true, agentsStarted: 2, durationMs: 5 })

    const row = (await call('GET', '/workflow/runs/wf-synthetic')).payload.run
    assert.deepEqual(row.items.map(i => [i.seq, i.label, i.status]), [
      [1, '第一项', 'unknown'],
      [2, '孤儿项', 'completed'],
    ], '第一项没回报结果 → unknown；孤儿项自己补上，谁也不背谁的锅')
    assert.equal(row.counts.unknown, 1)
    assert.equal(row.counts.completed, 1)
    assert.equal(row.agents_started, 2)
    assert.equal(row.agents_omitted, 0)
  }

  // ── 3. 运行成功，但某一项失败了：**不能**写成整个都成了 ─────────────────
  {
    const partial = await run('const a = await agent("bad", { label: "坏项" }); return { isNull: a === null }', {
      agent: async () => ({ stopReason: 'error', structured: undefined, text: '', childId: 'sa-bad' }),
    })
    assert.equal(partial.ok, true, '子代理自己失败不是致命错误')
    const detail = await call('GET', `/workflow/runs/${partial.runId}`)
    const row = detail.payload.run
    assert.equal(row.status, 'completed')
    assert.equal(row.counts.failed, 1, '运行级成功 ≠ 每一项都成功')
    assert.equal(row.counts.completed, 0)
    assert.equal(row.items[0].status, 'failed')
    assert.equal(row.items[0].label, '坏项')
  }

  // ── 4. 致命失败：错误码与原因都要留在登记里 ────────────────────────────
  {
    const fatal = await run('await agent("")')
    assert.equal(fatal.ok, false)
    assert.equal(fatal.code, 'INVALID_ARGUMENT')
    const row = (await call('GET', `/workflow/runs/${fatal.runId}`)).payload.run
    assert.equal(row.status, 'error')
    assert.equal(row.ok, false)
    assert.equal(row.code, 'INVALID_ARGUMENT')
    assert.ok(/non-empty prompt/.test(row.error || ''), `引擎给的原因要原样留着: ${row.error}`)
    assert.equal(row.ended_at >= row.started_at, true)
  }

  // ── 5. 脚本没编译起来也算一次**失败的运行**（不是「没跑过」）─────────────
  {
    const parseFail = await run('return ((((')
    assert.equal(parseFail.code, 'SCRIPT_PARSE')
    const row = (await call('GET', `/workflow/runs/${parseFail.runId}`)).payload.run
    assert.equal(row.status, 'error')
    assert.equal(row.code, 'SCRIPT_PARSE')
    assert.ok(row.error, '编译失败也要带原因')
  }

  // ── 6. 超时：如实报 WORKFLOW_TIMEOUT，绝不写成「完成」──────────────────
  {
    let release = null
    const gate = new Promise((resolve) => { release = resolve })
    const timed = await runWorkflow({
      script: 'await agent("hang"); return 1',
      meta: META,
      limits: { deadlineMs: 60 },
      _runAgentForTest: () => gate.then(() => ({
        stopReason: 'completed', structured: undefined, text: 'late', childId: null,
      })),
    })
    assert.equal(timed.ok, false)
    assert.equal(timed.code, 'WORKFLOW_TIMEOUT')
    const row = (await call('GET', `/workflow/runs/${timed.runId}`)).payload.run
    assert.equal(row.status, 'error')
    assert.equal(row.code, 'WORKFLOW_TIMEOUT')
    assert.ok(/deadline/.test(row.error || ''), `超时要说明白: ${row.error}`)
    // 卡住的那一项：发起了（发起时登记）、但引擎从没回报结果 → 必须落在「未回报结果」，
    // 不许编成 completed，也不许编成 failed。
    assert.equal(row.agents_started, 1)
    assert.equal(row.items.length, 1)
    assert.equal(row.items[0].status, 'unknown', '超时中止的那一项是「没有结果」，不是「失败」')
    assert.equal(row.counts.completed, 0)
    assert.equal(row.counts.failed, 0)
    assert.equal(row.counts.unknown, 1)
    release() // 放掉挂着的 promise，别留悬空句柄
    await gate
  }

  // ── 7. 日志上限：截断要如实标出来，不能悄悄丢 ───────────────────────────
  {
    const noisy = await run('for (let i = 0; i < 250; i++) log("L" + i); return 1')
    assert.equal(noisy.ok, true)
    const row = (await call('GET', `/workflow/runs/${noisy.runId}`)).payload.run
    assert.equal(row.logs.length, 200, '单次运行的日志上限')
    assert.equal(row.logs_omitted, 50, '丢了多少条必须说出来')
    assert.equal(row.logs[0], 'L0')
    assert.equal(row.logs.at(-1), 'L199')
  }

  // ── 8. 运行中：面板打开就能看到「还在跑」的那一次 ──────────────────────
  {
    let release = null
    const gate = new Promise((resolve) => { release = resolve })
    const pending = runWorkflow({
      script: 'phase("跑着"); await agent("hold"); return 1',
      meta: META,
      _runAgentForTest: () => gate.then(() => ({
        stopReason: 'completed', structured: undefined, text: 'done', childId: null,
      })),
    })
    // runWorkflow 在第一个 await 之前就登记了这次运行，所以这里已经能看到它。
    const mid = await call('GET', '/workflow/runs')
    assert.equal(mid.payload.running, 1)
    const runningRow = mid.payload.runs.find(r => r.run_id !== okRun.runId && r.status === 'running')
    assert.ok(runningRow, '进行中的运行必须在清单里')
    assert.equal(runningRow.live, true)
    assert.equal(runningRow.status, 'running')
    assert.deepEqual(runningRow.phases.map(p => p.title), ['跑着'])
    assert.equal(runningRow.phases[0].live, true, '还没结束的阶段要标成进行中')
    assert.equal(runningRow.phases[0].ended_at, null)
    // 正在跑的那一项也要看得见（发起时就登记，而不是等它返回）
    assert.equal(runningRow.items.length, 1, '挂住的那一项现在就该在清单里')
    assert.equal(runningRow.items[0].status, 'running')
    assert.equal(runningRow.items[0].phase, '跑着')
    assert.equal(runningRow.counts.running, 1)
    assert.equal(runningRow.counts.unknown, 0, '还在跑就不是「没回报结果」')

    release()
    const finished = await pending
    assert.equal(finished.ok, true)
    const after = await call('GET', '/workflow/runs')
    assert.equal(after.payload.running, 0, '跑完就该从「进行中」里消失')
    const row = after.payload.runs.find(r => r.run_id === finished.runId)
    assert.equal(row.status, 'completed')
    assert.equal(row.live, false)
    assert.equal(row.items[0].status, 'completed')
  }

  // ── 9. 顺序、limit 夹取、truncated、404 ────────────────────────────────
  {
    const all = await call('GET', '/workflow/runs')
    const total = all.payload.total
    assert.ok(total >= 6, `这一轮至少登记了 6 次运行，实际 ${total}`)
    const ids = all.payload.runs.map(r => r.run_id)
    assert.equal(ids[ids.length - 1], okRun.runId, '最新的排最前，最老的排最后')
    assert.equal(new Set(ids).size, ids.length, '同一个 run id 不该出现两次')

    const clipped = await call('GET', '/workflow/runs?limit=1')
    assert.equal(clipped.payload.limit, 1)
    assert.equal(clipped.payload.count, 1)
    assert.equal(clipped.payload.total, total, 'total 是登记表里的真实条数，不是取回的条数')
    assert.equal(clipped.payload.truncated, true, '还有没下发的就必须说「只显示最近 N 次」')
    assert.equal(clipped.payload.runs[0].run_id, ids[0])

    assert.equal((await call('GET', '/workflow/runs?limit=abc')).payload.limit, 50, '坏值走默认')
    assert.equal((await call('GET', '/workflow/runs?limit=99999')).payload.limit, 50, '超上限要夹住')
    assert.equal((await call('GET', '/workflow/runs?limit=0')).payload.limit, 50)

    const missing = await call('GET', '/workflow/runs/wf-does-not-exist')
    assert.equal(missing.handled, true)
    assert.equal(missing.status, 404)
    assert.equal(missing.payload.ok, false)
    assert.equal(missing.payload.code, 'WORKFLOW_RUN_NOT_FOUND')
    assert.ok(/current process/.test(missing.payload.error || ''), '要说清「只在本次进程内」')
  }

  // ── 10. 容量：登记表留最近 N 次，老的淘汰（内存态不能无限长）────────────
  {
    clearWorkflowRuns()
    const created = []
    for (let i = 0; i < 55; i += 1) {
      const res = await run('return 1')
      assert.equal(res.ok, true)
      created.push(res.runId)
    }
    const stats = workflowRunStats()
    assert.equal(stats.total, stats.capacity, '超过容量就该淘汰，而不是无限增长')
    assert.equal(listWorkflowRuns().length, stats.capacity)
    assert.equal((await call('GET', `/workflow/runs/${created[0]}`)).status, 404, '最老的被淘汰了')
    assert.equal((await call('GET', `/workflow/runs/${created.at(-1)}`)).status, 200, '最新的还在')
    assert.equal(listWorkflowRuns()[0].run_id, created.at(-1))
  }

  // ── 11. 面板：DOM 字符串与「内存态」声明必须在页面里（不是只写在注释里）──
  {
    const { createWorkflowPanel } = await import('./ui/brain-ui/workflow-panel.js')
    const { t } = await import('./ui/brain-ui/i18n/index.js')
    const html = createWorkflowPanel()
    for (const id of ['workflow-panel', 'wf-list', 'wf-summary', 'wf-error', 'wf-refresh', 'wf-exit-btn', 'wf-filter', 'wf-notice']) {
      assert.ok(html.includes(`id="${id}"`), `面板缺元素 ${id}`)
    }
    assert.ok(html.includes('class="wf-card"'), '面板缺卡片容器')
    for (const value of ['all', 'running', 'completed', 'error']) {
      assert.ok(html.includes(`<option value="${value}">`), `过滤下拉缺选项 ${value}`)
    }
    // 常驻诚实声明：用户恰恰是在有数据时才会误以为这是持久历史。
    assert.ok(html.includes(t('workflows.notice')), '内存态声明必须画进 DOM')
    assert.ok(/重启后清空/.test(html), '中文界面要明说重启后清空')
    // 面板只读：不提供任何会触发/取消运行的按钮
    assert.equal(/<button[^>]*data-(run|cancel|abort)/i.test(html), false)
  }

  // ── 12. 样式：浮层与 <select> 的几条硬规矩（查的是 CSS 文本，不是渲染结果）──
  {
    const cssPath = path.join(process.cwd(), 'src/ui/brain-ui/styles.css')
    const css = fs.readFileSync(cssPath, 'utf8')
    const start = css.indexOf('.workflow-panel {')
    assert.ok(start > 0, 'styles.css 里要有 .workflow-panel 规则')
    // 只截自己这一段：正则一路作用到文件末尾会把别人的规则也算进来（本仓库踩过这个坑）。
    const block = css.slice(start)
    assert.ok(/position:\s*fixed/.test(block), '浮层要 fixed')
    assert.ok(/inset:\s*0/.test(block), '浮层要铺满视口')
    assert.ok(/z-index:\s*900/.test(block), '浮层要压在设置类弹层之上')
    const selectStart = block.indexOf('.wf-filter select {')
    assert.ok(selectStart > 0, '下拉要有自己的规则')
    const selectBlock = block.slice(selectStart, block.indexOf('.wf-filter select option'))
    assert.ok(/appearance:\s*none/.test(selectBlock))
    assert.ok(/-webkit-appearance:\s*none/.test(selectBlock))
    assert.ok(/color-scheme:\s*dark/.test(selectBlock))
    assert.ok(/background-color:\s*var\(/.test(selectBlock), '要用 background-color，不能用简写')
    assert.equal(/[^-\w]background:\s*var/.test(selectBlock), false, 'background 简写会把箭头图重置掉')
    assert.ok(/\.wf-filter select option/.test(block), 'option 要显式配色')
  }

  clearWorkflowRuns()
  console.log('PASS workflow-panel: server-computed run fields (phases/items/duration/error code), honest failure reporting and process-scoped notice')
} finally {
  closeDBForTest?.()
  try { fs.rmSync(tmp, { recursive: true, force: true }) } catch { /* 清理失败不影响结论 */ }
}
