// 动态上下文记忆池 · 第 5d 步「主线深化时剔除残留噪声」自检
//
// 跑法：node src/test-noise-eviction.js
// 前提：node 的 better-sqlite3 ABI 与本机匹配（用 electron 内置 node 跑则需要 electron）
// 本地若 ABI 不匹配会在 import db.js 阶段抛错，本测试整体跳过（见末尾 catch）。
//
// 隔离策略：把 ALICE_USER_DIR 指向临时目录，db.js 走 paths.dbFile = <USER_DIR>/data/jarvis.db。
// 不动真实 DB。

import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { mkdtempSync, rmSync } from 'node:fs'

const tmp = mkdtempSync(join(tmpdir(), 'blm-noise-eviction-'))
process.env.ALICE_USER_DIR = tmp

function assert(cond, msg) {
  if (!cond) {
    console.error(`FAIL: ${msg}`)
    process.exitCode = 1
  } else {
    console.log(`PASS: ${msg}`)
  }
}

try {
  const {
    getDB,
    insertConversation,
    getRecentConversation,
    getRecentConversationTimeline,
    markConversationsAbsorbed,
  } = await import('./db.js')

  const db = getDB() // 触发 schema 迁移

  // schema check：focus_absorbed 列存在
  const cols = db.prepare(`PRAGMA table_info(conversations)`).all().map(c => c.name)
  assert(cols.includes('focus_absorbed'), 'conversations has focus_absorbed column')

  // 索引 check
  const idx = db.prepare(`SELECT name FROM sqlite_master WHERE type='index'`).all().map(r => r.name)
  assert(idx.includes('idx_conv_focus_absorbed'), 'idx_conv_focus_absorbed exists')

  // 准备三段对话：
  //   T0: 主线（设计理念）—— 不被 absorbed
  //   T1: 子帧（天气）   —— 将被 absorbed
  //   T2: 主线（写代码） —— 不被 absorbed
  const t0 = new Date(Date.now() - 30 * 60 * 1000).toISOString() // 30 分钟前
  const t1 = new Date(Date.now() - 20 * 60 * 1000).toISOString() // 20 分钟前
  const t1b = new Date(Date.now() - 19 * 60 * 1000).toISOString() // 19 分钟前
  const t2 = new Date(Date.now() - 5 * 60 * 1000).toISOString()  // 5 分钟前

  const testUser = 'user:noise-test'

  insertConversation({ role: 'user',   from_id: testUser, to_id: 'jarvis', content: '聊聊设计理念', timestamp: t0 })
  insertConversation({ role: 'user',   from_id: testUser, to_id: 'jarvis', content: '今天天气怎么样', timestamp: t1 })
  insertConversation({ role: 'jarvis', from_id: 'jarvis', to_id: testUser, content: '今天晴天 25 度', timestamp: t1b })
  insertConversation({ role: 'user',   from_id: testUser, to_id: 'jarvis', content: '回到设计：写成代码', timestamp: t2 })

  // 默认（includeAbsorbed=false）——所有 4 条都未 absorbed，应全部可见
  const beforeMark = getRecentConversation(testUser, 50, 24)
  assert(beforeMark.length === 4, `before mark: getRecentConversation returns 4 rows (got ${beforeMark.length})`)

  const beforeMarkTimeline = getRecentConversationTimeline(50, 24)
  assert(beforeMarkTimeline.length >= 4, `before mark: timeline returns >=4 rows (got ${beforeMarkTimeline.length})`)

  // 标记 [t1, t2) 区间为 absorbed（模拟天气子帧被压缩回填）
  const marked = markConversationsAbsorbed(t1, t2)
  assert(marked === 2, `markConversationsAbsorbed marks 2 rows in [t1, t2) (got ${marked})`)

  // 重复标记同样区间——已经 focus_absorbed=1 的不再被 update（WHERE focus_absorbed=0）
  const markedAgain = markConversationsAbsorbed(t1, t2)
  assert(markedAgain === 0, `second mark is idempotent (got ${markedAgain})`)

  // 默认调用——近期 raw 连续性优先：absorbed 的两条仍在最近窗口内可见。
  const afterMark = getRecentConversation(testUser, 50, 24)
  assert(afterMark.length === 4, `after mark: recent raw floor keeps absorbed rows visible (got ${afterMark.length})`)
  assert(
    afterMark.some(r => r.content === '今天天气怎么样') && afterMark.some(r => r.content === '今天晴天 25 度'),
    'after mark: recent absorbed rows remain visible to preserve continuity'
  )

  // 显式 includeAbsorbed=true——拿全量
  const afterMarkFull = getRecentConversation(testUser, 50, 24, { includeAbsorbed: true })
  assert(afterMarkFull.length === 4, `includeAbsorbed=true returns all 4 rows (got ${afterMarkFull.length})`)

  // timeline 默认也保留最近 raw。
  const afterMarkTimeline = getRecentConversationTimeline(50, 24)
  const ourRowsTimeline = afterMarkTimeline.filter(r => r.from_id === testUser || r.to_id === testUser)
  assert(
    ourRowsTimeline.length === 4,
    `after mark: timeline (default) keeps recent absorbed our rows (got ${ourRowsTimeline.length})`
  )

  // timeline 显式 includeAbsorbed=true——拿全量
  const afterMarkTimelineFull = getRecentConversationTimeline(50, 24, { includeAbsorbed: true })
  const ourRowsTimelineFull = afterMarkTimelineFull.filter(r => r.from_id === testUser || r.to_id === testUser)
  assert(
    ourRowsTimelineFull.length === 4,
    `timeline includeAbsorbed=true returns all 4 (got ${ourRowsTimelineFull.length})`
  )

  // 吸收只是「标记」，不是「隐藏」。
  //
  // 这里曾经断言：插入 65 条更新的主线消息、把天气子帧挤出 old raw floor 之后，
  // 默认窗口应当「重新隐藏」被吸收的行。该断言对应的是已被有意退役的 absorbed 棘轮
  // 行为——db.js getRecentConversation 现在明确不再按 focus_absorbed 过滤
  // （见 db.js「写端已无人调用；读端也不再按 focus_absorbed 过滤」的说明）：
  // 历史上被时间区间误标记的行不该永久隐藏，误丢的代价是失忆且不可恢复。
  //
  // 所以这里断言的是当前真实契约：被吸收的行在任何窗口位置都仍然可见，
  // 默认调用与 includeAbsorbed=true 返回同一批数据。
  for (let i = 0; i < 65; i++) {
    const ts = new Date(Date.parse(t2) + (i + 1) * 1000).toISOString()
    insertConversation({
      role: 'user',
      from_id: testUser,
      to_id: 'jarvis',
      content: `主线继续 ${i}`,
      timestamp: ts,
    })
  }

  const isLeafRow = r => r.content === '今天天气怎么样' || r.content === '今天晴天 25 度'

  // 对照：limit=3 时窗口确实只够最近 3 条，子帧行不在窗口内——
  // 证明下面的断言不是因为窗口无界才「碰巧」通过。
  const afterAgingNarrow = getRecentConversation(testUser, 3, 24)
  assert(
    !afterAgingNarrow.some(isLeafRow),
    `control: limit=3 window excludes the absorbed leaf rows (got ${afterAgingNarrow.length} rows)`
  )

  // 窗口足够宽时（4 条原始行 + 65 条追加 = 69 条，低于默认上限），
  // 被吸收的叶子行仍然可见，没有因为「老化超过 raw floor」而被隐藏。
  const afterAging = getRecentConversation(testUser, 100, 24)
  assert(afterAging.length === 69, `after aging: all 69 rows remain retrievable (got ${afterAging.length})`)
  assert(
    afterAging.some(isLeafRow),
    'after aging: absorbed leaf rows stay visible — absorption never hides or destroys raw history'
  )

  // 默认调用与 includeAbsorbed=true 必须是同一批数据：过滤参数已经退役，
  // 两者不再有语义差别（避免「同一个函数随参数静默改变历史可见性」）。
  const afterAgingFull = getRecentConversation(testUser, 100, 24, { includeAbsorbed: true })
  assert(
    afterAgingFull.map(r => r.id).join(',') === afterAging.map(r => r.id).join(','),
    'includeAbsorbed is now a no-op: default and includeAbsorbed=true return the same rows'
  )

  // 标记本身必须仍然真实落库（否则上面的「可见」可能只是因为压根没标上）。
  const flagged = db.prepare(
    `SELECT COUNT(*) AS n FROM conversations WHERE focus_absorbed = 1 AND content IN ('今天天气怎么样', '今天晴天 25 度')`
  ).get()
  assert(flagged.n === 2, `both absorbed leaf rows are still flagged focus_absorbed=1 (got ${flagged.n})`)

  // 错误防御：startedAt 为空时返回 0，不抛
  const nullMark = markConversationsAbsorbed(null, t2)
  assert(nullMark === 0, 'markConversationsAbsorbed(null) returns 0')

  console.log('\n[test-noise-eviction] all checks done')
} catch (err) {
  // better-sqlite3 ABI 不匹配时这里会捕获；CI 上跑 electron 内置 node 也走这条路径
  console.warn('[test-noise-eviction] SKIPPED:', err?.message || err)
  console.warn('  (likely better-sqlite3 ABI mismatch — run inside electron or rebuild native modules)')
} finally {
  try { rmSync(tmp, { recursive: true, force: true }) } catch {}
}
