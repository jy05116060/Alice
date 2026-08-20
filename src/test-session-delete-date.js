// 会话相关的两套路由/逻辑测试（合并自 test-session-archive.js，保持测试文件总数 147）：
//   A. /workspace/sessions/delete 的日期校验与「无匹配时不动元数据」
//   B. 会话归档（阶段 7）：纯函数 + 归档集合 + 8 个端点 + 删除事务四阶段
// 用临时库 + 假 req/res 直接调路由处理器，不依赖运行中的实例。
//
// 注意：归档部分要建 better-sqlite3 库，必须用 Electron ABI 跑
// （$env:ELECTRON_RUN_AS_NODE='1'; .\node_modules\electron\dist\electron.exe .\src\test-session-delete-date.js），
// plain node 会 ERR_DLOPEN_FAILED。
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'blm-del-date-'))
process.env.ALICE_USER_DIR = tmp
process.env.ALICE_RESOURCES_DIR = process.cwd()

const results = []
const check = (label, ok, extra = '') => {
  results.push({ label, ok })
  console.log(`  ${ok ? 'PASS' : 'FAIL'} ${label}${extra ? '  ' + extra : ''}`)
}

// 归档用（temp user dir 已在 os.tmpdir() 下，符合 paths.js import 时 ensureDir 的约束）
const sessionsRoot = path.join(tmp, 'sessions')
const mkdir = (p) => fs.mkdirSync(p, { recursive: true })
const touch = (dir, file) => { mkdir(dir); fs.writeFileSync(path.join(dir, file), 'x', 'utf8') }
const exists = (p) => fs.existsSync(p)

let closeDB = null
try {
  const { handleWorkspaceRoutes } = await import('./api/routes/workspace.js')
  const db = await import('./db.js')
  closeDB = db.closeDBForTest

  const call = async (body) => {
    let status = null, payload = null
    const res = {
      writeHead(c) { status = c }, setHeader() {}, end(chunk) { payload = chunk ? JSON.parse(chunk) : null },
    }
    const req = {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      on(event, handler) {
        if (event === 'data') handler(Buffer.from(JSON.stringify(body), 'utf8'))
        if (event === 'end') handler()
      },
    }
    await handleWorkspaceRoutes(req, res, new URL('http://127.0.0.1:3000/workspace/sessions/delete'))
    return { status, payload }
  }

  console.log('=== 1. 非法/不存在的日期必须 400（原来会静默 deleted:0）===')
  for (const date of ['9999-99-99', '2026-02-30', '2026-13-01', 'not-a-date', '']) {
    const r = await call({ id: 'ch-LOCAL-2026-09-29', channel: 'LOCAL', date })
    check(`date="${date}" → 400`, r.status === 400, `实际 ${r.status} ${JSON.stringify(r.payload)}`)
  }

  console.log('\n=== 2. 将来的日期必须 400（不是笔误就是误操作）===')
  const future = new Date(Date.now() + 86400_000 * 3) // 3 天后
  const fk = new Date(Date.UTC(future.getFullYear(), future.getMonth(), future.getDate())).toISOString().slice(0, 10)
  const fr = await call({ id: 'ch-LOCAL-x', channel: 'LOCAL', date: fk })
  check(`date="${fk}"（将来）→ 400`, fr.status === 400, `实际 ${fr.status}`)

  console.log('\n=== 3. 有匹配时：消息与元数据一起删 ===')
  // 先跑这步：路由内部会 ensureSessionMetaTable()，顺带把表建出来
  db.getDB().prepare('INSERT INTO conversations (role, from_id, to_id, content, channel, timestamp) VALUES (?,?,?,?,?,?)')
    .run('user', 'u', 'a', '待删消息', 'TUI', '2020-02-02T10:00:00+08:00')
  const del = await call({ id: 'ch-LOCAL-2020-02-02', channel: 'LOCAL', date: '2020-02-02' })
  check('有匹配 → deleted > 0', del.payload?.deleted > 0, JSON.stringify(del.payload))
  check('有匹配 → matched:true 且 meta_cleared:true', del.payload?.matched === true && del.payload?.meta_cleared === true)

  console.log('\n=== 4. 合法日期但无匹配：**不动**会话元数据（本次修的数据丢失 bug）===')
  db.getDB().prepare('INSERT OR REPLACE INTO workspace_session_meta (session_key, title) VALUES (?, ?)')
    .run('ch-LOCAL-2020-01-01', '用户改过的标题')
  const metaBefore = db.getDB().prepare('SELECT COUNT(*) AS n FROM workspace_session_meta').get().n

  const okr = await call({ id: 'ch-LOCAL-2020-01-01', channel: 'LOCAL', date: '2020-01-01' })
  check('合法日期 → 200', okr.status === 200, `实际 ${okr.status}`)
  check('无匹配时如实报 matched:false', okr.payload?.matched === false, JSON.stringify(okr.payload))
  check('无匹配时 deleted 为 0', okr.payload?.deleted === 0)

  const metaAfter = db.getDB().prepare('SELECT COUNT(*) AS n FROM workspace_session_meta').get().n
  const stillThere = db.getDB().prepare('SELECT title FROM workspace_session_meta WHERE session_key = ?').get('ch-LOCAL-2020-01-01')
  check('**无匹配时元数据未被删**', metaAfter === metaBefore && !!stillThere,
    `meta ${metaBefore}→${metaAfter}，标题=${stillThere ? stillThere.title : '(已丢失)'}`)
  check('标题内容完好', stillThere?.title === '用户改过的标题', `实际 ${stillThere?.title}`)

  // =====================================================================
  // B. 会话归档（阶段 7）
  // =====================================================================
  const sa = await import('./runtime/session-archive.js')
  const { handleSessionArchiveRoutes } = await import('./api/routes/session-archive.js')
  const {
    encodeSessionId, isWithinRoot, findSessionDataDir, pruneEmptyParents,
    archiveSession, unarchiveSession, permanentlyDeleteArchived, deleteAllArchived,
    loadArchiveLedger, listArchivedSessionIds, ensureArchivedSessionsTable,
    defaultSessionMetaProvider,
  } = sa
  const { getDB } = db

  // 归档集合默认不认账不存在的会话（load 会跳过），所以这里统一提供一个
  // 「所有 id 都存在」的 provider，单独再去测「不存在就跳过」的那条语义。
  const liveProvider = (id) => ({ createdAt: `2026-10-01T00:00:00+08:00`, cwd: undefined, title: `标题-${id}` })

  console.log('\n=== 5. encodeSessionId：逐字复刻 ===')
  check('"." → "~002E"', encodeSessionId('.') === '~002E', `实际 ${encodeSessionId('.')}`)
  check('".." → "~002E~002E"', encodeSessionId('..') === '~002E~002E', `实际 ${encodeSessionId('..')}`)
  check('普通 id 原样保留', encodeSessionId('abc-123_XY.Z') === 'abc-123_XY.Z', `实际 ${encodeSessionId('abc-123_XY.Z')}`)
  check('"~" 必须被转义（不是保留字符）', encodeSessionId('~') === '~007E', `实际 ${encodeSessionId('~')}`)
  check('中文按 charCode 转 4 位大写十六进制',
    encodeSessionId('中') === '~4E2D', `实际 ${encodeSessionId('中')}`)
  check('中文多字逐字转义', encodeSessionId('会话') === '~4F1A~8BDD', `实际 ${encodeSessionId('会话')}`)
  check('空格转义为 ~0020', encodeSessionId('a b') === 'a~0020b', `实际 ${encodeSessionId('a b')}`)
  check('斜杠被转义（防目录穿越）', encodeSessionId('a/b') === 'a~002Fb', `实际 ${encodeSessionId('a/b')}`)
  check('反斜杠被转义', encodeSessionId('a\\b') === 'a~005Cb', `实际 ${encodeSessionId('a\\b')}`)
  check('".." 与 "." 前面的长度不受影响', encodeSessionId('a..b') === 'a..b', `实际 ${encodeSessionId('a..b')}`)
  check('编码结果不含路径分隔符', !/[\\/]/.test(encodeSessionId('a/b\\c中')))

  console.log('\n=== 6. isWithinRoot：路径逃逸防护 ===')
  const pathRoot = path.resolve('/tmp/root-x')
  check('root 本身 → true', isWithinRoot(pathRoot, pathRoot) === true)
  check('root 内子目录 → true', isWithinRoot(pathRoot, path.join(pathRoot, 'a', 'b')) === true)
  check('"../" 逃逸 → false', isWithinRoot(pathRoot, path.join(pathRoot, '..', 'evil')) === false)
  check('"../../" 逃逸 → false', isWithinRoot(pathRoot, path.join(pathRoot, '..', '..', 'evil')) === false)
  check('绝对路径逃逸 → false', isWithinRoot(pathRoot, path.resolve('/etc/passwd')) === false)
  check('**前缀兄弟目录必须被拒**（root-x-evil 不是 root-x 的子目录）',
    isWithinRoot(pathRoot, `${pathRoot}-evil`) === false, `target=${pathRoot}-evil`)
  check('root 内名字含 ".." 的合法目录 → true',
    isWithinRoot(pathRoot, path.join(pathRoot, 'a..b')) === true)

  console.log('\n=== 7. findSessionDataDir：三标记 × 两层深度 ===')
  const r3 = path.join(tmp, 'r3')
  mkdir(r3)
  mkdir(path.join(r3, encodeSessionId('s1')))
  check('一级：编码 id 目录命中', findSessionDataDir(r3, 's1') === path.join(r3, 's1'))
  mkdir(path.join(r3, 'session-s2'))
  check('一级：session-<id> 命中', findSessionDataDir(r3, 's2') === path.join(r3, 'session-s2'))
  mkdir(path.join(r3, 's3'))
  check('一级：裸 id 命中', findSessionDataDir(r3, 's3') === path.join(r3, 's3'))
  mkdir(path.join(r3, 'groupA', 's4'))
  check('二级：root/<group>/<marker> 命中', findSessionDataDir(r3, 's4') === path.join(r3, 'groupA', 's4'))
  mkdir(path.join(r3, encodeSessionId('s5')))
  mkdir(path.join(r3, 'session-s5'))
  mkdir(path.join(r3, 's5'))
  check('标记优先级：编码名 > session- > 裸 id',
    findSessionDataDir(r3, 's5') === path.join(r3, encodeSessionId('s5')))
  mkdir(path.join(r3, 's6'))
  mkdir(path.join(r3, 'groupB', 's6'))
  check('深度优先级：一级优先于二级', findSessionDataDir(r3, 's6') === path.join(r3, 's6'))
  fs.writeFileSync(path.join(r3, 's7'), 'not a dir', 'utf8')
  check('同名**文件**不算会话目录 → null', findSessionDataDir(r3, 's7') === null)
  check('不存在 → null', findSessionDataDir(r3, 'nope-zzz') === null)
  mkdir(path.join(r3, encodeSessionId('会话甲')))
  check('中文 id 用编码名命中', findSessionDataDir(r3, '会话甲') === path.join(r3, encodeSessionId('会话甲')))
  mkdir(path.join(r3, 'g1', 'g2', 's8'))
  check('深度 3 的目录不被找到（上限 2）', findSessionDataDir(r3, 's8') === null)

  console.log('\n=== 8. pruneEmptyParents：向上剪枝且 root 本身不删 ===')
  const r4 = path.join(tmp, 'r4')
  const deep = path.join(r4, 'g1', 'g2', 'sess')
  touch(deep, 'f.txt')
  fs.rmSync(deep, { recursive: true, force: true })
  pruneEmptyParents(r4, path.dirname(deep))
  check('空父目录被递归剪掉', !exists(path.join(r4, 'g1')))
  check('**root 本身没被删**', exists(r4))
  const keep = path.join(r4, 'g3', 'g4')
  touch(keep, 'a.txt')
  touch(path.join(r4, 'g3'), 'sibling.txt')
  pruneEmptyParents(r4, keep)
  check('非空父目录不被删', exists(path.join(r4, 'g3')))
  pruneEmptyParents(r4, r4)
  check('传 root 本身 → root 仍存在', exists(r4))
  const outside = path.join(tmp, 'outside-empty')
  mkdir(outside)
  pruneEmptyParents(r4, outside)
  check('root 之外的目录不被删', exists(outside))

  console.log('\n=== 9. 归档 / 恢复 / 元数据（ledger.load 语义）===')
  ensureArchivedSessionsTable()
  await archiveSession('ch-LOCAL-2026-10-01', { metaProvider: liveProvider })
  let ledger = await loadArchiveLedger({ metaProvider: liveProvider })
  check('归档后出现在 archivedSessionIds 里', ledger.archivedSessionIds.includes('ch-LOCAL-2026-10-01'))
  check('meta 里有 title', ledger.meta['ch-LOCAL-2026-10-01']?.title === '标题-ch-LOCAL-2026-10-01')
  check('meta 里有 createdAt', ledger.meta['ch-LOCAL-2026-10-01']?.createdAt === '2026-10-01T00:00:00+08:00')

  await archiveSession('no-title', { metaProvider: () => ({ createdAt: undefined, cwd: undefined, title: undefined }) })
  ledger = await loadArchiveLedger({ metaProvider: (id) => (id === 'no-title' ? { title: undefined, createdAt: undefined, cwd: undefined } : liveProvider(id)) })
  const noTitleMeta = ledger.meta['no-title']
  check('title 为 undefined 时不写 title 键', noTitleMeta && !Object.prototype.hasOwnProperty.call(noTitleMeta, 'title'),
    JSON.stringify(noTitleMeta))
  check('title 为 undefined 时 createdAt 键仍然写（值为 undefined）',
    noTitleMeta && Object.prototype.hasOwnProperty.call(noTitleMeta, 'createdAt'))
  check('cwd 为 undefined 时也写该键（与 DSH 形状一致）',
    noTitleMeta && Object.prototype.hasOwnProperty.call(noTitleMeta, 'cwd'))

  await archiveSession('ghost-1', { metaProvider: liveProvider })
  const mixed = await loadArchiveLedger({ metaProvider: (id) => (id === 'ghost-1' ? null : liveProvider(id)) })
  check('**已不存在的会话被跳过**（不进 archivedSessionIds）', !mixed.archivedSessionIds.includes('ghost-1'))
  check('**已不存在的会话也没有 meta 项**', !Object.prototype.hasOwnProperty.call(mixed.meta, 'ghost-1'))

  // ── **"查不到" 与 "查询失败" 必须区分**（2026-10-01 修正）───────────────────
  // provider 的 catch 原先全是纯注释、不报任何东西。实测把 conversations 表改名，
  // provider 返回 null —— 而 null 在契约里意味着"这个会话不存在"。
  // 于是**表结构坏了 / SQL 写错了 / 库锁住**，外界看到的是"归档列表是空的"。
  //
  // 这比问题 8a（channel 大小写）更隐蔽：8a 至少是稳定复现的错误结果，
  // 这里是把故障**伪装成正常空集**，用户和日志都收不到信号。
  // 与客户端那处修的是同一原则：**业务上的"没有" ≠ 执行上的"失败"**。
  {
    const warns = []
    const origWarn = console.warn
    console.warn = (...a) => { warns.push(a.join(' ')) }
    let failedMeta
    let renamed = false
    try {
      db.getDB().prepare('ALTER TABLE conversations RENAME TO conversations_probe_bak').run()
      renamed = true
      failedMeta = defaultSessionMetaProvider('ch-tui-2026-09-27')
    } catch { /* 改不动表就跳过这条 */ }
    if (renamed) {
      db.getDB().prepare('ALTER TABLE conversations_probe_bak RENAME TO conversations').run()
      check('查询失败时**不得**谎报"会话不存在"（null 意味着不存在，故障不是不存在）',
        failedMeta !== null,
        `返回了 null —— 数据库一有问题，用户看到的会是"我归档的会话全没了"而不是报错`)
      check('查询失败必须留下日志痕迹（原先 catch 是空的）',
        warns.some(w => w.includes('session-archive') && w.includes('查询会话创建时间失败')),
        `warns=${JSON.stringify(warns)}`)
    }
    // 反向：**预期的**"表还没建"不该刷日志（首次运行时 meta 表确实不存在）
    warns.length = 0
    const absent = defaultSessionMetaProvider('ch-tui-1999-01-01')
    check('真正不存在的会话仍然必须返回 null（这条契约不能被上面的修法破坏）',
      absent === null, JSON.stringify(absent))
    console.warn = origWarn
  }

  // ── **写路径**也必须守住同一个不变量（2026-10-01 修正）──────────────────────
  // 上面几条只证明了**读**会跳过不存在的会话。但读跳过 ≠ 写不落库 ——
  // 而当时写路径是**无条件 INSERT**：`archiveSession('ghost-x')` 真的往
  // `archived_sessions` 表里插了一行（created_at/cwd/title 全 null）。
  //
  // 两个矛盾的可观测现象由此而来：
  //   POST /session/archive  → {"archivedSessionIds":[]}      ← 读把它跳过
  //   紧接着 clear           → {"cleared":1}                  ← 删的是同一行
  // **接口说"没有"，清空却说"清掉 1 条"。** 表里留下永远读不出来的脏行。
  //
  // 我在问题 8b 只修了读的一半（加 continue），没修写的一半 ——
  // 与「只修症状出现的那一半」是同一个错误。这两条断言钉住写路径。
  {
    await deleteAllArchived()                       // 先清干净，断言才不受残留影响
    const ghostLedger = await archiveSession('ghost-write-probe', { metaProvider: () => null })
    const rowsAfter = listArchivedSessionIds()
    check('归档不存在的会话：**不得写入归档表**（读的判据与写的判据必须一致）',
      !rowsAfter.includes('ghost-write-probe'),
      `表里出现了 ${JSON.stringify(rowsAfter)} —— 写路径没有守住"会话必须存在"这个不变量`)
    check('归档不存在的会话：返回的集合也必须为空（与 DSH 的 ledger.load 一致）',
      ghostLedger.archivedSessionIds.length === 0,
      JSON.stringify(ghostLedger))
    // 这条是"接口说空、clear 说 1"那个矛盾的直接回归测试
    const afterGhostClear = await deleteAllArchived()
    check('归档不存在的会话后，clear 必须报 cleared=0（不得清掉一行读不出来的脏数据）',
      afterGhostClear.cleared === 0,
      `cleared=${afterGhostClear.cleared}；这说明归档时写入了读路径看不见的行`)
  }

  // ── **默认** provider 也必须遵守同一条契约（2026-10-01 修正）────────────────
  // 上面两条用的是**注入的** provider，所以它们证明的是 ledger.load 的跳过逻辑，
  // 证明不了「默认 provider 会不会返回 null」。而默认 provider 恰恰是个真缺陷：
  // 它的注释写着「找不到该会话时返回 null」，代码却无论什么 id 都 `return {...}`，
  // 于是给不存在的会话凭空建了一条 `{}` 元数据 —— 归档列表里出现点进去什么都没有的幽灵记录。
  check('默认 provider：不存在的会话必须返回 null（注释与代码曾经不一致）',
    defaultSessionMetaProvider('ch-tui-1999-01-01') === null,
    `got ${JSON.stringify(defaultSessionMetaProvider('ch-tui-1999-01-01'))}`)
  check('默认 provider：空串返回 null', defaultSessionMetaProvider('') === null)
  check('默认 provider：undefined 返回 null', defaultSessionMetaProvider(undefined) === null)

  // ── 默认 provider 的 channel 比对必须**大小写无关**（2026-10-01 修正）────────
  // session_key 里渠道段是小写（`ch-tui-...` → `tui`），conversations.channel 存大写（`TUI`）。
  // SQLite 的 `=` 区分大小写，所以原先 `WHERE channel = ?`（传小写）永远匹配不到 ——
  // createdAt 恒 undefined，meta 退化成 `{}`，归档列表**丢掉创建时间**。
  // 临时库里没有 conversations 表数据，所以**自己造一条**再验（不能靠库里有现成数据）。
  {
    const db = getDB()
    // from_id / role / content / timestamp 是 NOT NULL，必须一起给。
    db.prepare('INSERT INTO conversations (role, from_id, content, channel, timestamp) VALUES (?, ?, ?, ?, ?)')
      .run('user', 'meta-probe', 'meta-probe', 'TUI', '2026-10-01T07:30:00+08:00')
    // key 用小写渠道段，模拟真实的 `ch-tui-<date>` —— 这正是原先匹配不到的那一类。
    const meta = defaultSessionMetaProvider('ch-tui-2026-10-01')
    check('默认 provider：大小写不同的 channel 也能推出 createdAt（TUI vs tui）',
      meta !== null && typeof meta.createdAt === 'string' && meta.createdAt.startsWith('2026-10-01'),
      `got ${JSON.stringify(meta)}`)
    db.prepare('DELETE FROM conversations WHERE content = ?').run('meta-probe')
  }

  // 删除结果信封：两条删除路径必须**同形状**（2026-10-01 修正）
  // deleteAllArchived 在空集合时有个提前返回，原先写死 `{ok,removed}` —— 少了 cleared，
  // 于是 `DELETE /session/archive/clear` 在空集合/非空集合时返回**两种形状**。
  // 已改成两条路径共用同一个构造点；这里把形状钉住。
  // ⚠️ 必须先**清成空集合**再测提前返回那条路径 —— 第一次写时没清，
  //    清空返回 cleared:3（前面用例残留），断言失败但**代码是对的**：又是我自己的测试没控住状态。
  {
    await deleteAllArchived()                       // 先确保集合为空，才能走到提前返回分支
    check('前置：归档集合已清空', listArchivedSessionIds().length === 0)

    const emptyDelete = await deleteAllArchived()   // ← 这一条才走提前返回
    check('清空空集合也返回 cleared（两条删除路径同形状）',
      Object.prototype.hasOwnProperty.call(emptyDelete, 'cleared') && emptyDelete.cleared === 0,
      JSON.stringify(emptyDelete))

    await archiveSession('shape-a', { metaProvider: liveProvider })
    await archiveSession('shape-b', { metaProvider: liveProvider })
    const fullDelete = await deleteAllArchived()    // ← 这一条走正常路径
    check('清空非空集合返回 cleared = 实际移除条数', fullDelete.cleared === 2, JSON.stringify(fullDelete))
    check('两种情形的键集完全一致',
      JSON.stringify(Object.keys(emptyDelete).sort()) === JSON.stringify(Object.keys(fullDelete).sort()),
      `${JSON.stringify(Object.keys(emptyDelete).sort())} vs ${JSON.stringify(Object.keys(fullDelete).sort())}`)
  }
  check('同一批里存在的会话照常返回', mixed.archivedSessionIds.includes('ch-LOCAL-2026-10-01'))

  await unarchiveSession('ch-LOCAL-2026-10-01', { metaProvider: liveProvider })
  ledger = await loadArchiveLedger({ metaProvider: liveProvider })
  check('取消归档后不在集合里', !ledger.archivedSessionIds.includes('ch-LOCAL-2026-10-01'))

  console.log('\n=== 10. 删除事务顺序：预检 → 物理删除 → 集合更新（不留幽灵）===')
  let rejected = null
  try { await permanentlyDeleteArchived(['never-archived'], { root: sessionsRoot }) } catch (e) { rejected = e.message }
  check('删除未归档 id → 抛错', typeof rejected === 'string' && rejected.includes('不在归档集合中'), String(rejected))

  const dirB = path.join(sessionsRoot, encodeSessionId('del-1'))
  touch(dirB, 'data.json')
  await archiveSession('del-1', { metaProvider: liveProvider })
  await permanentlyDeleteArchived(['del-1'], { root: sessionsRoot })
  check('物理目录已删除', !exists(dirB))
  check('归档集合里也没有它（无幽灵）', !listArchivedSessionIds().includes('del-1'))

  const dirC = path.join(sessionsRoot, encodeSessionId('del-2'))
  touch(dirC, 'data.json')
  await archiveSession('del-2', { metaProvider: liveProvider })
  const beforeC = listArchivedSessionIds().includes('del-2')
  let threw = null
  try {
    await permanentlyDeleteArchived(['del-2'], {
      root: sessionsRoot,
      removeDirImpl: () => { throw new Error('模拟磁盘故障') },
    })
  } catch (e) { threw = e.message }
  check('物理删除失败 → 抛错', typeof threw === 'string' && threw.includes('删除会话数据失败'), String(threw))
  check('物理删除失败 → 错误信息里带上了原因', typeof threw === 'string' && threw.includes('模拟磁盘故障'), String(threw))
  check('**物理删除失败时归档集合未被改动（无幽灵：不会出现"数据还在但已取消归档"）**',
    beforeC && listArchivedSessionIds().includes('del-2'))
  check('物理删除失败时磁盘数据也还在（可整体重试）', exists(dirC))
  check('失败后仍可重试成功', await permanentlyDeleteArchived(['del-2'], { root: sessionsRoot }).then(() => !exists(dirC) && !listArchivedSessionIds().includes('del-2')))

  await archiveSession('del-3', { metaProvider: liveProvider })
  await archiveSession('del-4', { metaProvider: liveProvider })
  await permanentlyDeleteArchived(['del-3', 'del-4'], { root: sessionsRoot })
  check('批量删除生效', !listArchivedSessionIds().includes('del-3') && !listArchivedSessionIds().includes('del-4'))
  await archiveSession('del-5', { metaProvider: liveProvider })
  await deleteAllArchived({ root: sessionsRoot })
  check('clear 后归档集合为空（本批）', !listArchivedSessionIds().includes('del-5'))

  /* 2026-10-01 计数语义：`removed` 数的是**磁盘目录删了几个**（DSH 原语义），
     而爱丽丝常规形态没有每会话目录 → 它恒为 0。
     如果调用方拿它当「删了几条」显示，就会报「已清空 0 条」而集合其实已清空。
     所以另外用 `cleared`（集合实际移除条数）表达这件事，这里锁死两者。 */
  await archiveSession('cnt-1', { metaProvider: liveProvider })
  await archiveSession('cnt-2', { metaProvider: liveProvider })
  await archiveSession('cnt-3', { metaProvider: liveProvider })
  const cntClear = await deleteAllArchived({ root: sessionsRoot })
  check('clear 的 cleared 必须等于集合实际移除条数（不是磁盘目录数）', cntClear.cleared === 3,
    `cleared=${cntClear.cleared} 期望 3；removed=${cntClear.removed}`)
  check('clear 之后集合确实空了', !listArchivedSessionIds().length)
  await archiveSession('cnt-solo', { metaProvider: liveProvider })
  const cntOne = await permanentlyDeleteArchived(['cnt-solo'], { root: sessionsRoot })
  check('单条删除的 cleared 必须为 1', cntOne.cleared === 1, `cleared=${cntOne.cleared} 期望 1`)
  check('removed 保留 DSH 原语义（爱丽丝无会话目录 → 0）', cntOne.removed === 0,
    `removed=${cntOne.removed} 期望 0（这表明两个字段不再混用）`)

  console.log('\n=== 10e. 四个阶段的**每一个**失败点都不能留幽灵 ===')
  // 删除事务四步：① 预检 ② 内存移除 ③ 物理删除 ④ 归档集合更新。
  // 上面只覆盖了 ③ 失败。这里逐阶段验证：
  // 任何一步失败，最终状态都必须是「数据与归档集合一致」——要么都在，要么都不在。

  // 阶段① 预检失败：不在归档集合里 → 拒绝，且**磁盘数据一个字节都不能动**
  const stageA = path.join(sessionsRoot, encodeSessionId('stage-a'))
  touch(stageA, 'data.json')
  let stageAErr = null
  try { await permanentlyDeleteArchived(['stage-a'], { root: sessionsRoot }) } catch (e) { stageAErr = e.message }
  check('阶段① 预检失败 → 抛错', typeof stageAErr === 'string' && stageAErr.includes('不在归档集合中'))
  check('阶段① 预检失败 → 磁盘数据完好未被动过', exists(stageA) && exists(path.join(stageA, 'data.json')))

  // 阶段② 内存移除失败：记账抛错时集合必须保持原样（先记账后动集合）
  await archiveSession('stage-b', { metaProvider: liveProvider })
  const stageBDir = path.join(sessionsRoot, encodeSessionId('stage-b'))
  touch(stageBDir, 'data.json')
  let stageBErr = null
  try {
    await permanentlyDeleteArchived(['stage-b'], {
      root: sessionsRoot,
      detachAccountingImpl: () => { throw new Error('模拟记账失败') },
    })
  } catch (e) { stageBErr = e.message }
  check('阶段② 记账失败 → 抛错（不会被吞成成功）', typeof stageBErr === 'string' && stageBErr.includes('模拟记账失败'), String(stageBErr))
  check('**阶段② 记账失败后归档集合仍保留该会话**（不会出现"数据没了但集合里没有"的反向幽灵）',
    listArchivedSessionIds().includes('stage-b'))

  // 阶段③ 物理删除失败（多 id：第一个成功、第二个失败 → 必须中止且集合完全不动）
  await archiveSession('stage-c1', { metaProvider: liveProvider })
  await archiveSession('stage-c2', { metaProvider: liveProvider })
  const dirC1 = path.join(sessionsRoot, encodeSessionId('stage-c1'))
  const dirC2 = path.join(sessionsRoot, encodeSessionId('stage-c2'))
  touch(dirC1, 'data.json'); touch(dirC2, 'data.json')
  let calls = 0
  let stageCErr = null
  try {
    await permanentlyDeleteArchived(['stage-c1', 'stage-c2'], {
      root: sessionsRoot,
      removeDirImpl: () => {
        calls += 1
        if (calls === 2) throw new Error('模拟第二个删除失败')
        return true
      },
    })
  } catch (e) { stageCErr = e.message }
  check('阶段③ 中途物理失败 → 抛错并中止后续', typeof stageCErr === 'string' && stageCErr.includes('模拟第二个删除失败'), String(stageCErr))
  check('**阶段③ 中途失败 → 归档集合两个 id 都还在**（无幽灵：不会出现"数据已删但归档仍列"）',
    listArchivedSessionIds().includes('stage-c1') && listArchivedSessionIds().includes('stage-c2'),
    `集合=${JSON.stringify(listArchivedSessionIds().filter(i => i.startsWith('stage-')))}`)

  // 阶段④ 集合更新：正常路径下必须真的落库（成功即一致）
  await archiveSession('stage-d', { metaProvider: liveProvider })
  await permanentlyDeleteArchived(['stage-d'], { root: sessionsRoot })
  check('阶段④ 成功 → 集合里确认已移除', !listArchivedSessionIds().includes('stage-d'))

  // 不变量：任何时刻「磁盘上还有目录」的已归档会话，集合里必须仍然列着它。
  await archiveSession('ghost-check', { metaProvider: liveProvider })
  const ghostDir = path.join(sessionsRoot, encodeSessionId('ghost-check'))
  touch(ghostDir, 'data.json')
  try {
    await permanentlyDeleteArchived(['ghost-check'], {
      root: sessionsRoot,
      removeDirImpl: () => { throw new Error('模拟失败') },
    })
  } catch { /* 预期内 */ }
  const ghostStillListed = listArchivedSessionIds().includes('ghost-check')
  const ghostDataStillThere = exists(ghostDir)
  check('**不变量：物理数据还在 ⟺ 归档集合仍列着它**',
    ghostStillListed === ghostDataStillThere && ghostStillListed === true,
    `listed=${ghostStillListed} dataOnDisk=${ghostDataStillThere}`)
  await permanentlyDeleteArchived(['ghost-check'], { root: sessionsRoot })

  console.log('\n=== 11. hook 点 ===')
  const seen = []
  const off1 = sa.onArchiveHook('archive:added', (id) => seen.push(`added:${id}`))
  const off2 = sa.onArchiveHook('archive:restored', (id) => seen.push(`restored:${id}`))
  const off3 = sa.onArchiveHook('archive:deleted', (ids) => seen.push(`deleted:${ids.join(',')}`))
  await archiveSession('hook-1', { metaProvider: liveProvider })
  await unarchiveSession('hook-1', { metaProvider: liveProvider })
  await archiveSession('hook-1', { metaProvider: liveProvider })
  await permanentlyDeleteArchived(['hook-1'], { root: sessionsRoot })
  check('archive:added 被调用', seen.includes('added:hook-1'))
  check('archive:restored 被调用', seen.includes('restored:hook-1'))
  check('archive:deleted 被调用且带 ids 数组', seen.includes('deleted:hook-1'))
  off1(); off2(); off3()
  const countBefore = seen.length
  await archiveSession('hook-2', { metaProvider: liveProvider })
  check('取消注册后 hook 不再触发', seen.length === countBefore)

  console.log('\n=== 12. 8 个端点：正常路径 ===')
  const callArchive = async (method, pathname, body, opts = {}) => {
    let status = null, payload = null
    const res = {
      writeHead(code) { status = code },
      setHeader() {},
      end(chunk) { payload = chunk ? JSON.parse(chunk.toString('utf8')) : null },
    }
    const chunks = body === undefined ? [] : [Buffer.from(JSON.stringify(body), 'utf8')]
    const req = {
      method,
      headers: { 'content-type': 'application/json' },
      on(event, handler) {
        if (event === 'data') for (const c of chunks) handler(c)
        if (event === 'end') handler()
      },
    }
    const handled = await handleSessionArchiveRoutes(req, res, new URL(`http://127.0.0.1:3000${pathname}`), opts)
    return { handled, status, payload }
  }
  /* seed 一条**真实可被 defaultSessionMetaProvider 认出来**的会话。
     ⚠️ 这里原先写死了 `channel='TUI'`，于是只有 `ch-TUI-*` 的 key 能被认出来 ——
     `ch-LOCAL-2026-01-01` / `ch-API-2026-01-02` 的渠道段与 'TUI' 不符，
     `UPPER(channel)=UPPER('local')` 匹配不到任何行 → provider 返回 null → 归档变成 no-op。
     而测试却断言"进了归档集合"，所以它们**一直在依赖写路径不检查会话存在那个 bug**。
     （这不是我改坏的：那 4 条断言原本就是靠 bug 通过的。）
     现在按 key 解析出真实渠道再插入，测的才是"归档一个真实会话"。
     注意 timestamp 必须能被 `substr(timestamp,1,10)` 取到 key 里的日期。 */
  const channelOfKey = (key) => {
    const m = /^ch-(.+)-(\d{4}-\d{2}-\d{2})$/.exec(key)
    if (!m) throw new Error(`unparseable session key in test seed: ${key}`)
    return { channel: m[1], date: m[2] }
  }
  const seedSession = (key) => {
    const { channel, date } = channelOfKey(key)
    db.getDB().prepare('INSERT INTO conversations (role, from_id, to_id, content, channel, timestamp) VALUES (?,?,?,?,?,?)')
      .run('user', 'u', 'a', 'hi', channel.toUpperCase(), `${date}T10:00:00+08:00`)
  }

  const g0 = await callArchive('GET', '/session/archive')
  check('GET /session/archive → 200', g0.status === 200 && g0.handled === true)
  check('GET 返回形状 { archivedSessionIds, meta }',
    Array.isArray(g0.payload?.archivedSessionIds) && typeof g0.payload?.meta === 'object')

  // ⚠️ 这些用例原先归档的 id **从来没有 seed 到 conversations 表**里
  // （`ch-LOCAL-2026-01-01` / `ch-LOCAL-2026-01-02`）—— 它们依赖"写路径不检查会话是否存在"。
  // 那正是被修掉的 bug（问题 13）：写路径无条件 INSERT，读路径又跳过不存在的会话，
  // 于是接口说 `[]`、clear 却清掉 1 条。
  //
  // **修法不是放宽断言，是把断言改成它本来该测的东西**：归档一个**真实存在**的会话。
  // 依据：爱丽丝自己的读路径有 `if (entry === null) continue`，
  // DSH 的 `ledger.load()` 也有同一道 `if (entry === null) continue` —— 两边都要求会话存在。
  // 「不存在的会话不落库」另由上面的 ghost-write-probe 用例专门钉住。
  seedSession('ch-LOCAL-2026-01-01')
  const p1 = await callArchive('POST', '/session/archive', { sessionId: 'ch-LOCAL-2026-01-01' })
  check('POST /session/archive → 200', p1.status === 200, JSON.stringify(p1.payload)?.slice(0, 120))
  check('POST 后进入归档集合', listArchivedSessionIds().includes('ch-LOCAL-2026-01-01'))

  const p2 = await callArchive('POST', '/session/archive/restore', { sessionId: 'ch-LOCAL-2026-01-01' })
  check('POST /session/archive/restore → 200 { ok:true }', p2.status === 200 && p2.payload?.ok === true)
  check('restore 后离开归档集合', !listArchivedSessionIds().includes('ch-LOCAL-2026-01-01'))

  seedSession('ch-API-2026-01-02')
  seedSession('ch-LOCAL-2026-01-02')
  const p3 = await callArchive('POST', '/session/workspace/archive', { sessionIds: ['ch-LOCAL-2026-01-02', 'ch-API-2026-01-02'] })
  check('POST /session/workspace/archive → 200', p3.status === 200)
  check('批量归档两个 id 都进集合',
    listArchivedSessionIds().includes('ch-LOCAL-2026-01-02') && listArchivedSessionIds().includes('ch-API-2026-01-02'))

  const p4 = await callArchive('DELETE', '/session/workspace/archive', { sessionIds: ['ch-LOCAL-2026-01-02', 'ch-API-2026-01-02'] })
  check('DELETE /session/workspace/archive → 200 { ok:true }', p4.status === 200 && p4.payload?.ok === true)
  check('批量删除后集合里没有了',
    !listArchivedSessionIds().includes('ch-LOCAL-2026-01-02') && !listArchivedSessionIds().includes('ch-API-2026-01-02'))

  seedSession('ch-LOCAL-2026-01-03')
  await callArchive('POST', '/session/archive', { sessionId: 'ch-LOCAL-2026-01-03' })
  const p5 = await callArchive('DELETE', '/session/archive', { sessionId: 'ch-LOCAL-2026-01-03' })
  check('DELETE /session/archive → 200 { ok:true }', p5.status === 200 && p5.payload?.ok === true)
  check('单个永久删除后集合里没有了', !listArchivedSessionIds().includes('ch-LOCAL-2026-01-03'))

  seedSession('ch-LOCAL-2026-01-04')
  await callArchive('POST', '/session/archive', { sessionId: 'ch-LOCAL-2026-01-04' })
  const p6 = await callArchive('POST', '/session/archive/clear')
  check('POST /session/archive/clear → 200 { ok:true }', p6.status === 200 && p6.payload?.ok === true)
  check('clear 后归档集合清空', listArchivedSessionIds().length === 0)

  await callArchive('POST', '/session/archive', { sessionId: 'ch-LOCAL-2026-01-05' })
  const p7 = await callArchive('DELETE', '/session/archive/clear')
  check('DELETE /session/archive/clear → 200 { ok:true }', p7.status === 200 && p7.payload?.ok === true)
  check('DELETE clear 后归档集合清空', listArchivedSessionIds().length === 0)

  const openCalls = []
  const openDirId = 'ch-LOCAL-2026-01-06'
  mkdir(path.join(sessionsRoot, encodeSessionId(openDirId)))
  const p8 = await callArchive('POST', '/session/open/path', { sessionId: openDirId }, {
    openSessionDirImpl: async (dir) => { openCalls.push(dir); return { ok: true } },
  })
  check('POST /session/open/path → 200 { ok:true }', p8.status === 200 && p8.payload?.ok === true, JSON.stringify(p8.payload))
  check('open/path 传的是**定位到的会话目录**', openCalls[0] === path.join(sessionsRoot, encodeSessionId(openDirId)), String(openCalls[0]))

  console.log('\n=== 13. 8 个端点：错误路径（错误串逐字）===')
  const bad1 = await callArchive('POST', '/session/archive', {})
  check('POST /session/archive 缺 id → 400 invalid-session-id',
    bad1.status === 400 && bad1.payload?.error === 'invalid-session-id', `实际 ${bad1.status} ${JSON.stringify(bad1.payload)}`)
  const bad2 = await callArchive('POST', '/session/archive', { sessionId: 123 })
  check('sessionId 非字符串 → 400 invalid-session-id',
    bad2.status === 400 && bad2.payload?.error === 'invalid-session-id', `实际 ${bad2.status} ${JSON.stringify(bad2.payload)}`)
  const bad3 = await callArchive('DELETE', '/session/archive', {})
  check('DELETE /session/archive 缺 id → 400 invalid-session-id',
    bad3.status === 400 && bad3.payload?.error === 'invalid-session-id')
  const bad4 = await callArchive('POST', '/session/archive/restore', {})
  check('POST restore 缺 id → 400 invalid-session-id',
    bad4.status === 400 && bad4.payload?.error === 'invalid-session-id')
  const bad5 = await callArchive('POST', '/session/workspace/archive', {})
  check('POST workspace/archive 缺 ids → 400 invalid-session-ids',
    bad5.status === 400 && bad5.payload?.error === 'invalid-session-ids', `实际 ${JSON.stringify(bad5.payload)}`)
  const bad6 = await callArchive('POST', '/session/workspace/archive', { sessionIds: [] })
  check('空数组 → 400 invalid-session-ids',
    bad6.status === 400 && bad6.payload?.error === 'invalid-session-ids')
  const bad7 = await callArchive('DELETE', '/session/workspace/archive', { sessionIds: 'not-array' })
  check('sessionIds 非数组 → 400 invalid-session-ids',
    bad7.status === 400 && bad7.payload?.error === 'invalid-session-ids')
  const bad8 = await callArchive('POST', '/session/open/path', {})
  check('POST open/path 缺 id → 400 invalid-session-id',
    bad8.status === 400 && bad8.payload?.error === 'invalid-session-id')
  const bad9 = await callArchive('POST', '/session/open/path', { sessionId: 'no-such-session-zz' })
  check('**目录不存在 → 400 session-directory-not-found**',
    bad9.status === 400 && bad9.payload?.error === 'session-directory-not-found', `实际 ${JSON.stringify(bad9.payload)}`)
  check('错误响应形状统一为 { ok:false, error }',
    bad1.payload?.ok === false && bad5.payload?.ok === false && bad9.payload?.ok === false)
  const notMine = await callArchive('GET', '/session/unknown-thing')
  check('未注册的 /session/* 路径不被本路由吞掉', notMine.handled === false)
  const otherRoute = await callArchive('GET', '/workspace/skills')
  check('非 /session/ 路径直接放行', otherRoute.handled === false)

  console.log('\n=== 14. 编码自查 ===')
  for (const rel of ['./runtime/session-archive.js', './api/routes/session-archive.js']) {
    const buf = fs.readFileSync(new URL(rel, import.meta.url))
    const text = buf.toString('utf8')
    check(`${rel} 无 U+FFFD 替换字符`, !text.includes('\uFFFD'))
    check(`${rel} 往返编码一致`, Buffer.from(text, 'utf8').equals(buf))
  }

  console.log(`\n${results.every(r => r.ok) ? 'PASS' : 'FAIL'} delete-date + session-archive: ${results.filter(r => r.ok).length}/${results.length} 项`)
  process.exitCode = results.every(r => r.ok) ? 0 : 1
} catch (err) {
  console.error('测试自身异常:', err)
  process.exitCode = 1
} finally {
  closeDB?.()
  try { fs.rmSync(tmp, { recursive: true, force: true }) } catch { /* 清理失败不影响结论 */ }
}
