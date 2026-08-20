import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

// 会话压缩轨迹（Turn-Trace）面板的数据接口测试：GET /compaction/history 的
// **服务端展示字段** —— 「压掉了多少 token / 省了几成 / 覆盖了哪一段 / 原文条数对不对得上」。
//
// 为什么这些字段值得单独测：面板跑在浏览器里，import 不到 src/runtime/，所以这些数字
// 只能是服务端算的，面板只负责摆出来。算错的方向有两种，这里都要钉死：
//   1. 把「省了多少」算大 —— 面板会告诉用户「已经压掉了 8 万 token」，而模型其实还在原样重发；
//   2. 原文对不上时（历史被清理 / 换了库）假装数字完整 —— 那是把「看不到」伪装成「不存在」。
// 所以除了数值本身，这里还要验 source_complete 会如实变成 false / null。
//
// 用临时库，不碰真实数据：
//   npm run test:compaction-panel
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'blm-compaction-panel-'))
process.env.ALICE_USER_DIR = tmp
process.env.ALICE_RESOURCES_DIR = process.cwd()

let closeDBForTest = null

try {
  const dbModule = await import('./db.js')
  closeDBForTest = dbModule.closeDBForTest
  const { insertConversation } = dbModule
  const { handleCompactionRoutes } = await import('./api/routes/compaction.js')
  const { insertCompaction, clearCompactions } = await import('./runtime/compaction-store.js')
  const { buildCompactionTrace, estimateMessagesTokens, estimateTokens } = await import('./runtime/compaction-view.js')

  const call = async (method, pathname) => {
    const url = new URL(`http://127.0.0.1:3000${pathname}`)
    let status = null
    let payload = null
    const res = {
      writeHead(code) { status = code },
      setHeader() {},
      end(chunk) { payload = chunk ? JSON.parse(chunk) : null },
    }
    const req = {
      method,
      headers: { 'content-type': 'application/json' },
      on() {},
    }
    const handled = await handleCompactionRoutes(req, res, url)
    return { handled, status, payload }
  }

  const addRow = (content, at) => insertConversation({
    role: 'user', from_id: 'ID:000001', to_id: 'jarvis', content, timestamp: at,
  })

  // ── 1. 纯算式：本次新吞入的原文 → 摘要，省了多少 ─────────────────────
  {
    const rows = [
      { id: 1, role: 'user', from_id: 'ID:000001', content: 'a'.repeat(400), timestamp: '2026-07-01T10:00:00+08:00' },
      { id: 2, role: 'jarvis', from_id: 'jarvis', content: 'b'.repeat(400), timestamp: '2026-07-01T10:01:00+08:00' },
      { id: 3, role: 'user', from_id: 'ID:000001', content: 'c'.repeat(400), timestamp: '2026-07-01T10:02:00+08:00' },
      { id: 4, role: 'jarvis', from_id: 'jarvis', content: 'd'.repeat(400), timestamp: '2026-07-01T10:03:00+08:00' },
    ]
    const summary = '摘要'.repeat(20) // 40 字符
    const trace = buildCompactionTrace({
      compactions: [{ compactionId: 7, coversFromId: 1, coversThroughId: 2, summary, messageCount: 2, charsBefore: 800, inputTokens: 90000, trigger: 'manual', createdAt: '2026-07-01T10:05:00+08:00' }],
      rows,
    })
    assert.equal(trace.entries.length, 1)
    const e = trace.entries[0]
    assert.equal(e.compaction_id, 7)
    assert.equal(e.trigger, 'manual')
    assert.equal(e.new_from_id, 1)
    assert.equal(e.new_through_id, 2, '本次新增段只到这一次的边界')
    assert.equal(e.new_message_count, 2)
    assert.equal(e.source_rows_found, 2)
    assert.equal(e.source_complete, true, '原文条数对得上就该说对得上')
    // 数值必须与 runtime 用的是同一份估算（口径只有一份）
    assert.equal(e.new_tokens, estimateMessagesTokens(rows.slice(0, 2)))
    assert.equal(e.summary_tokens, estimateTokens(summary))
    assert.equal(e.released_tokens, Math.max(0, e.new_tokens - e.summary_tokens))
    assert.equal(e.released_percent, Math.round((e.released_tokens / e.new_tokens) * 1000) / 10)
    assert.ok(e.released_tokens > 0, '压掉 800 字符换 40 字符，必然有节省')
    assert.equal(e.context_tokens_before, 90000, '触发时的真实 usage 要带出来')
    assert.equal(e.context_tokens_after, 90000 - e.released_tokens)
    assert.equal(e.span_first_at, rows[0].timestamp)
    assert.equal(e.span_last_at, rows[1].timestamp)
    assert.equal(trace.totals.runs, 1)
    assert.equal(trace.totals.released_tokens, e.released_tokens)
    assert.equal(trace.totals.last_at, '2026-07-01T10:05:00+08:00')

    // 链接续：第二次只算「新增的那一段」，累计量另给。
    const chained = buildCompactionTrace({
      compactions: [
        { compactionId: 8, coversThroughId: 4, summary: '二', messageCount: 4, charsBefore: 1600, trigger: 'auto' },
        { compactionId: 7, coversFromId: 1, coversThroughId: 2, summary: '一', messageCount: 2, charsBefore: 800 },
      ],
      rows,
    })
    assert.deepEqual(chained.entries.map(e => e.compaction_id), [7, 8], '乱序传入也要按边界升序')
    assert.equal(chained.entries[1].new_from_id, 3, '第二次从上次边界之后开始')
    assert.equal(chained.entries[1].new_message_count, 2)
    assert.equal(chained.entries[1].covers_from_id, null)
    assert.equal(chained.totals.runs, 2)
    assert.equal(chained.totals.covered_messages, 4)
    assert.equal(chained.totals.covers_through_id, 4)

    // 只下发最近 1 条时，「本次新增段」仍然要按整条链算——切完再算的话，
    // 最老的那条会把整段历史当成自己压掉的，或者因为累计条数对不上而误报原文缺失。
    const sliced = buildCompactionTrace({
      compactions: [
        { compactionId: 7, coversFromId: 1, coversThroughId: 2, summary: '一', messageCount: 2, charsBefore: 800 },
        { compactionId: 8, coversThroughId: 4, summary: '二', messageCount: 4, charsBefore: 1600, trigger: 'auto' },
      ],
      rows,
      showLast: 1,
    })
    assert.equal(sliced.entries.length, 1)
    assert.equal(sliced.entries[0].compaction_id, 8)
    assert.equal(sliced.entries[0].new_from_id, 3, '切片后仍要用上一条边界当起点')
    assert.equal(sliced.entries[0].new_message_count, 2)
    assert.equal(sliced.entries[0].source_complete, true, '不能因为切片而误报原文对不上')
    assert.equal(sliced.totals.runs, 2, '总数是整条链的，不是切出来的条数')

    // 原文对不上：登记压掉了 10 条，库里只找得到 4 条 → 必须如实说。
    const missing = buildCompactionTrace({
      compactions: [{ compactionId: 9, coversThroughId: 4, summary: 'x', messageCount: 10, inputTokens: 0 }],
      rows,
    })
    assert.equal(missing.entries[0].new_message_count, 10)
    assert.equal(missing.entries[0].source_rows_found, 4)
    assert.equal(missing.entries[0].source_complete, false, '少算了就说少算了，不能粉饰成「本来就这么多」')

    // 登记条数为 0 → 无从核对，给 null 而不是 false（不冤枉也不放过）
    const unchecked = buildCompactionTrace({
      compactions: [{ compactionId: 10, coversThroughId: 4, summary: 'x', messageCount: 0 }],
      rows,
    })
    assert.equal(unchecked.entries[0].source_complete, null)
    assert.equal(unchecked.entries[0].context_tokens_before, 0, '拿不到真实读数就是 0（未知），不能编')

    // 空输入不炸
    assert.deepEqual(buildCompactionTrace({}).entries, [])
    assert.deepEqual(buildCompactionTrace({ compactions: [{}] }).entries, [], '没有整数边界的行直接跳过')
  }

  // ── 2. 接口：空库是「结构完整」而不是 404 / null ──────────────────────
  {
    clearCompactions()
    const empty = await call('GET', '/compaction/history')
    assert.equal(empty.handled, true, '这条路径由本路由认领')
    assert.equal(empty.status, 200)
    assert.equal(empty.payload.ok, true)
    assert.deepEqual(empty.payload.entries, [])
    assert.equal(empty.payload.totals.runs, 0)
    assert.equal(empty.payload.total, 0)
    assert.equal(empty.payload.truncated, false)
    assert.equal(empty.payload.active_id, null)
    assert.equal(empty.payload.in_flight, false)
    assert.ok(empty.payload.context && typeof empty.payload.context === 'object', '压力块要么给数字要么给原因')
    if (empty.payload.context.error === undefined) {
      assert.ok(Number.isFinite(empty.payload.context.context_window))
      assert.ok(Number.isFinite(empty.payload.context.limit_tokens))
    }

    // 不认领的路径/方法要留给后面的路由
    assert.equal((await call('GET', '/compaction/history/extra')).handled, false)
    assert.equal((await call('DELETE', '/compaction/history')).handled, false)
    assert.equal((await call('GET', '/compaction')).handled, true, '老端点原样可用')
    const legacy = await call('GET', '/compaction')
    assert.equal(legacy.payload.ok, true)
    assert.equal(legacy.payload.active, null)
    assert.deepEqual(legacy.payload.history, [])
  }

  // ── 3. 端到端：真原文 + 真压缩行 → 面板要的那几栏 ────────────────────
  {
    clearCompactions()
    const ids = []
    ids.push(addRow('第一句：把压缩轨迹面板做出来', '2026-07-01T10:00:00+08:00'))
    ids.push(insertConversation({ role: 'jarvis', from_id: 'jarvis', to_id: 'ID:000001', content: '好，我先读现有的压缩实现', timestamp: '2026-07-01T10:01:00+08:00' }))
    ids.push(addRow('第二句：注意别碰真实库', '2026-07-01T10:02:00+08:00'))
    ids.push(insertConversation({ role: 'jarvis', from_id: 'jarvis', to_id: 'ID:000001', content: 'b'.repeat(300), timestamp: '2026-07-01T10:03:00+08:00' }))
    ids.push(addRow('第三句：面板要能看摘要', '2026-07-01T10:04:00+08:00'))
    ids.push(insertConversation({ role: 'jarvis', from_id: 'jarvis', to_id: 'ID:000001', content: 'c'.repeat(300), timestamp: '2026-07-01T10:05:00+08:00' }))

    const first = insertCompaction({
      coversFromId: ids[0], coversThroughId: ids[3],
      summary: '第一次摘要：读实现、定范围',
      messageCount: 4, charsBefore: 800, inputTokens: 90000, trigger: 'manual',
      createdAt: '2026-07-01T10:06:00+08:00',
    })
    const second = insertCompaction({
      coversFromId: ids[4], coversThroughId: ids[5],
      summary: '第二次摘要：面板字段与诚实报告',
      messageCount: 6, charsBefore: 1200, inputTokens: 7000, trigger: 'auto',
      createdAt: '2026-07-01T10:07:00+08:00',
    })

    const history = await call('GET', '/compaction/history?limit=50')
    assert.equal(history.status, 200)
    assert.equal(history.payload.ok, true)
    assert.equal(history.payload.entries.length, 2)
    assert.equal(history.payload.total, 2)
    assert.equal(history.payload.truncated, false)
    assert.equal(history.payload.active_id, second.compactionId, '生效的是边界最大的那一次')
    assert.equal(history.payload.rows_error, null, '原文读得到就不该报读不到')

    const [one, two] = history.payload.entries
    assert.equal(one.compaction_id, first.compactionId)
    assert.equal(one.summary, '第一次摘要：读实现、定范围', '摘要正文必须下发（面板要给人看）')
    assert.equal(one.covers_through_id, ids[3])
    assert.equal(one.new_from_id, ids[0])
    assert.equal(one.new_through_id, ids[3])
    assert.equal(one.new_message_count, 4)
    assert.equal(one.source_rows_found, 4)
    assert.equal(one.source_complete, true)
    assert.equal(one.context_tokens_before, 90000)
    assert.equal(one.context_tokens_after, 90000 - one.released_tokens)
    assert.ok(one.released_tokens > 0)
    assert.ok(one.released_percent > 0 && one.released_percent <= 100)
    assert.equal(one.span_first_at, '2026-07-01T10:00:00+08:00')
    assert.equal(one.span_last_at, '2026-07-01T10:03:00+08:00')

    assert.equal(two.new_from_id, ids[4], '第二次只覆盖新增段')
    assert.equal(two.new_message_count, 2)
    assert.equal(two.message_count, 6, '累计条数照实给')
    assert.equal(two.context_tokens_before, 7000)

    assert.equal(history.payload.totals.runs, 2)
    assert.equal(history.payload.totals.released_tokens, one.released_tokens + two.released_tokens)
    assert.equal(history.payload.totals.covered_messages, 6)
    assert.equal(history.payload.totals.covers_through_id, ids[5])
    assert.equal(history.payload.totals.context_tokens_before, 7000)

    // limit 要夹住：小值照做，超上限夹到 200，坏值走默认
    assert.equal((await call('GET', '/compaction/history?limit=1')).payload.entries.length, 1)
    assert.equal((await call('GET', '/compaction/history?limit=1')).payload.limit, 1)
    assert.equal((await call('GET', '/compaction/history?limit=99999')).payload.limit, 200)
    assert.equal((await call('GET', '/compaction/history?limit=abc')).payload.limit, 50)
    const clipped = await call('GET', '/compaction/history?limit=1')
    assert.equal(clipped.payload.total, 2, 'total 是库里的真实条数，不是取回的条数')
    assert.equal(clipped.payload.truncated, true, '还有没下发的就必须说「只显示最近 N 次」')
    assert.equal(clipped.payload.entries.length, 1)
    assert.equal(clipped.payload.entries[0].compaction_id, second.compactionId, '切出来的是最新那条')
    assert.equal(clipped.payload.entries[0].new_from_id, ids[4], '切片后新增段的起点仍然要对')
    assert.equal(clipped.payload.entries[0].new_message_count, 2)
    assert.equal(clipped.payload.entries[0].source_complete, true)
    assert.equal(clipped.payload.totals.runs, 2, '合计仍是整条链的')

    // 老端点不受影响：形状没变，摘要正文仍然按需取
    const legacy = await call('GET', '/compaction')
    assert.equal(legacy.payload.active.compaction_id, second.compactionId)
    assert.equal(legacy.payload.active.summary, '第二次摘要：面板字段与诚实报告')
    assert.equal(legacy.payload.history.length, 2)
  }

  // ── 4. 原文对不上：接口层也要把 source_complete 降下来 ────────────────
  {
    clearCompactions()
    const id = addRow('只有这一条是真的', '2026-07-02T09:00:00+08:00')
    insertCompaction({
      coversFromId: id, coversThroughId: id + 50,
      summary: '压了 51 条（其中 50 条库里已经没了）',
      messageCount: 51, inputTokens: 12345, trigger: 'auto',
    })
    const history = await call('GET', '/compaction/history')
    const [entry] = history.payload.entries
    assert.equal(entry.new_message_count, 51)
    assert.equal(entry.source_rows_found, 1)
    assert.equal(entry.source_complete, false, '原文对不上必须如实标出来，面板据此显示危险色')
    // 少算了就是少算了：渲染用的 tokens 只按找到的那条算，不能凭空补齐
    assert.equal(entry.new_tokens, estimateMessagesTokens([{ role: 'user', content: '只有这一条是真的' }]))
  }

  clearCompactions()
  console.log('PASS compaction-panel: server-computed trace fields (released tokens/percent, covered span, honest source_complete)')
} finally {
  closeDBForTest?.()
  try { fs.rmSync(tmp, { recursive: true, force: true }) } catch { /* 清理失败不影响结论 */ }
}
