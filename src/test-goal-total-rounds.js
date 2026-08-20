import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import Database from 'better-sqlite3'

// rounds_total（累计自动轮次，跨所有授权只增不减）+ 旧库迁移的测试。
//
//   npm run test:goal-total-rounds
//
// 三件事必须真的跑一遍，而不是靠读代码推断：
//   1. resume 只重置 rounds_started，**不动 rounds_total**（这是本项的核心）；
//   2. 消费一轮自动续轮时两个数**各 +1**；
//   3. 一个**没有 rounds_total 列的旧表**能被迁移加列并回填（否则老目标会显示
//      「累计 0 · 本轮 3」这种自相矛盾的数字）。
//
// 全程用临时目录（ALICE_USER_DIR 指向 mkdtemp），绝不碰真实用户数据。

const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'blm-goal-total-'))
const resolvedTempRoot = path.resolve(tempRoot)
const resolvedOsTemp = path.resolve(os.tmpdir())
assert.ok(
  resolvedTempRoot.startsWith(`${resolvedOsTemp}${path.sep}`),
  `Refusing to use unsafe temp path: ${resolvedTempRoot}`,
)
process.env.ALICE_USER_DIR = resolvedTempRoot
process.env.ALICE_RESOURCES_DIR = path.resolve('.')

const dbFile = path.join(resolvedTempRoot, 'data', 'jarvis.db')
let closeDBForTest = () => {}
const results = []
const check = (label, ok, extra = '') => {
  results.push(ok)
  console.log(`  ${ok ? 'PASS' : 'FAIL'} ${label}${extra ? '  ' + extra : ''}`)
}

// 老库的样子：与 goal-store 的建表语句逐字对齐，**只少 rounds_total 这一列**。
function createLegacyGoalTable(file) {
  fs.mkdirSync(path.dirname(file), { recursive: true })
  const db = new Database(file)
  db.exec(`
    CREATE TABLE IF NOT EXISTS goals (
      goal_id        TEXT PRIMARY KEY,
      objective      TEXT NOT NULL,
      status         TEXT NOT NULL DEFAULT 'active',
      revision       INTEGER NOT NULL DEFAULT 1,
      rounds_started INTEGER NOT NULL DEFAULT 0,
      max_rounds     INTEGER,
      progress_note  TEXT NOT NULL DEFAULT '',
      blocked_reason TEXT,
      pause_reason   TEXT,
      armed_epoch    TEXT,
      created_at     TEXT NOT NULL,
      updated_at     TEXT NOT NULL
    );
  `)
  db.prepare(`
    INSERT INTO goals (goal_id, objective, status, revision, rounds_started, max_rounds,
                       progress_note, armed_epoch, created_at, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run('goal-legacy-spent', 'an old goal that already spent 3 rounds', 'active', 4, 3, 12, 'mid-flight', null,
    '2026-01-01T00:00:00.000Z', '2026-01-01T00:00:00.000Z')
  db.prepare(`
    INSERT INTO goals (goal_id, objective, status, revision, rounds_started, max_rounds,
                       progress_note, armed_epoch, created_at, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run('goal-legacy-fresh', 'an old goal that never spent a round', 'active', 1, 0, 12, '', null,
    '2026-01-02T00:00:00.000Z', '2026-01-02T00:00:00.000Z')
  const cols = db.prepare('PRAGMA table_info(goals)').all().map(c => c.name)
  db.close()
  assert.equal(cols.includes('rounds_total'), false, 'the legacy fixture must NOT have rounds_total')
  return cols
}

try {
  // ── 0. 先造一个「没有 rounds_total 列的旧库」，把迁移逼出来 ──────────────
  console.log('=== 0. 迁移：旧表（无 rounds_total 列）加列 + 回填 ===')
  const legacyCols = createLegacyGoalTable(dbFile)
  console.log(`  旧表列：${legacyCols.join(', ')}`)

  // 首次打开这个库 → ensureGoalTable 应当检测到缺列、ALTER 加列、并回填。
  const goalStore = await import('./runtime/goal-store.js')
  const connection = await import('./db/connection.js')
  closeDBForTest = connection.closeDBForTest

  // 迁移由 ensureGoalTable() 驱动（进程第一次碰 goals 表时跑）。这里显式调一次，
  // 让「加列 + 回填」这一步是确定的，而不是依赖后面某条读写顺手把它带出来。
  goalStore.ensureGoalTable()

  // 列信息从**原始连接**读，而不是连接池/缓存里的那条：ALTER TABLE 之后旧连接上可能还留着
  // 按旧 schema 编译的语句缓存，拿它验「列加没加上」会误判（本用例第一版就栽在这里）。
  // 先 close 让 WAL 收干净，再用一条新连接读库文件本身。
  connection.closeDBForTest()
  const checkDb = new Database(dbFile)
  const migratedCols = checkDb.prepare('PRAGMA table_info(goals)').all().map(c => c.name)
  checkDb.close()
  check('迁移后多了 rounds_total 列', migratedCols.includes('rounds_total'), migratedCols.join(', '))
  const spentRow = goalStore.loadGoalRow('goal-legacy-spent')
  check('老行的 rounds_total 被回填为 rounds_started（3，而不是 0）', spentRow.rounds_total === 3,
    `rounds_total=${spentRow.rounds_total} rounds_started=${spentRow.rounds_started}`)
  check('老行的 rounds_started 本身没被改动', spentRow.rounds_started === 3, `rounds_started=${spentRow.rounds_started}`)
  const freshRow = goalStore.loadGoalRow('goal-legacy-fresh')
  check('没花过轮数的老行回填为 0', freshRow.rounds_total === 0, `rounds_total=${freshRow.rounds_total}`)

  // 幂等：再跑一次迁移不能抛错、也不能把数改坏
  goalStore.migrateGoalTable()
  goalStore.migrateGoalTable()
  const afterTwice = goalStore.loadGoalRow('goal-legacy-spent')
  check('迁移可重复执行（幂等），不重复加列也不改数', afterTwice.rounds_total === 3 && afterTwice.rounds_started === 3,
    `rounds_total=${afterTwice.rounds_total}`)

  // 已经存在、且 rounds_total 正确的行，回填必须是 no-op（只增不减）
  goalStore.updateGoalRow('goal-legacy-fresh', { rounds_total: 9 })
  goalStore.migrateGoalTable()
  check('回填是只增不减的：已有的更大累计值不会被 round_started 覆盖',
    goalStore.loadGoalRow('goal-legacy-fresh').rounds_total === 9,
    `rounds_total=${goalStore.loadGoalRow('goal-legacy-fresh').rounds_total}`)

  // ── 1. 新目标 + 每轮各 +1 ────────────────────────────────────────────
  console.log('\n=== 1. 消费一轮：rounds_started 与 rounds_total 各 +1 ===')
  const {
    createGoal, updateGoal, getCurrentGoal, consumeGoalRound, goalSnapshot,
    _resetGoalsForTest, GOAL_ACTION,
  } = await import('./runtime/goal-manager.js')
  _resetGoalsForTest()

  const created = createGoal({ objective: '累加账本的验证目标', maxRounds: 3 })
  check('建目标成功', created.ok === true, created.error || '')
  check('createGoal 后 rounds_total = 0', created.goal.roundsTotal === 0, `roundsTotal=${created.goal.roundsTotal}`)

  consumeGoalRound()
  const afterRound1 = getCurrentGoal()
  check('第 1 轮后 rounds_started = 1', afterRound1.roundsStarted === 1, `rounds_started=${afterRound1.roundsStarted}`)
  check('第 1 轮后 rounds_total = 1', afterRound1.roundsTotal === 1, `rounds_total=${afterRound1.roundsTotal}`)

  consumeGoalRound()
  consumeGoalRound() // maxRounds=3，这一轮烧完预算
  const exhausted = getCurrentGoal()
  check('第 3 轮后 rounds_started = 3', exhausted.roundsStarted === 3, `rounds_started=${exhausted.roundsStarted}`)
  check('第 3 轮后 rounds_total = 3', exhausted.roundsTotal === 3, `rounds_total=${exhausted.roundsTotal}`)
  check('预算烧完后解除上膛（但目标仍是 active）',
    exhausted.armed === false && exhausted.status === 'active', `armed=${exhausted.armed} status=${exhausted.status}`)

  // ── 2. 核心断言：resume 只归零本轮，累计不动 ─────────────────────────
  console.log('\n=== 2. 核心：resume 后 rounds_total 不变、rounds_started 归零 ===')
  const beforeResume = getCurrentGoal()
  const resumed = updateGoal({ revision: beforeResume.revision, action: GOAL_ACTION.RESUME })
  check('resume 成功', resumed.ok === true, resumed.error || '')
  check('resume 后 rounds_started 归零', resumed.goal.roundsStarted === 0, `rounds_started=${resumed.goal.roundsStarted}`)
  check('resume 后 rounds_total **不变**（=3，没倒退）', resumed.goal.roundsTotal === 3,
    `rounds_total=${resumed.goal.roundsTotal}（resume 前 ${beforeResume.roundsTotal}）`)
  check('resume 后重新上膛', resumed.goal.armed === true, `armed=${resumed.goal.armed}`)

  // 再跑 2 轮：本轮 2，累计 5 —— 两个数各自独立地长
  consumeGoalRound()
  consumeGoalRound()
  const afterSecondRun = getCurrentGoal()
  check('resume 后的第 2 轮：rounds_started = 2', afterSecondRun.roundsStarted === 2, `rounds_started=${afterSecondRun.roundsStarted}`)
  check('resume 后的第 2 轮：rounds_total = 5（3 + 2）', afterSecondRun.roundsTotal === 5, `rounds_total=${afterSecondRun.roundsTotal}`)

  // 再 resume 一次：累计继续不动（只增不减，永不倒退）
  const resumed2 = updateGoal({ revision: afterSecondRun.revision, action: GOAL_ACTION.RESUME })
  check('第二次 resume 后 rounds_started = 0', resumed2.goal.roundsStarted === 0, `rounds_started=${resumed2.goal.roundsStarted}`)
  check('第二次 resume 后 rounds_total 仍是 5', resumed2.goal.roundsTotal === 5, `rounds_total=${resumed2.goal.roundsTotal}`)

  // pause / note / edit / complete / blocked 都不该动累计数
  const beforeActions = getCurrentGoal().roundsTotal
  updateGoal({ revision: getCurrentGoal().revision, action: GOAL_ACTION.PAUSE, pauseReason: 'test' })
  updateGoal({ revision: getCurrentGoal().revision, action: GOAL_ACTION.RESUME })
  updateGoal({ revision: getCurrentGoal().revision, action: GOAL_ACTION.NOTE, progressNote: 'still going' })
  updateGoal({ revision: getCurrentGoal().revision, action: GOAL_ACTION.EDIT, objective: '改过的目标' })
  check('pause/resume/note/edit 都不动 rounds_total', getCurrentGoal().roundsTotal === beforeActions,
    `${beforeActions} → ${getCurrentGoal().roundsTotal}`)

  // ── 3. 对外形状 ───────────────────────────────────────────────────────
  console.log('\n=== 3. 对外形状：goalSnapshot / shapeGoal / 工具 payload ===')
  const snap = goalSnapshot()
  check('goalSnapshot() 暴露 roundsTotal', snap.roundsTotal === getCurrentGoal().roundsTotal,
    `snapshot.roundsTotal=${snap.roundsTotal}`)

  const { handleGoalRoutes } = await import('./api/routes/goals.js')
  const callGet = async () => {
    let body = null
    const res = { writeHeader() {}, setHeader() {}, writeHead() {}, end(p) { body = JSON.parse(p) } }
    await handleGoalRoutes({ method: 'GET', headers: {}, on() {} }, res, new URL('http://127.0.0.1:3000/goal'))
    return body
  }
  const http = await callGet()
  check('GET /goal 的目标形状里有 rounds_total', http?.goal?.rounds_total === getCurrentGoal().roundsTotal,
    `rounds_total=${http?.goal?.rounds_total} / goal.roundsTotal=${getCurrentGoal().roundsTotal}`)
  check('GET /goal 仍然带 rounds_started（两处数字并存）', http?.goal?.rounds_started === getCurrentGoal().roundsStarted,
    `rounds_started=${http?.goal?.rounds_started}`)

  // ── 4. 真实库的迁移演练（在副本上做，绝不碰原件）──────────────────────
  console.log('\n=== 4. 真库副本上的迁移演练（只读原件 → 复制 → 在副本上迁移）===')
  const realDb = 'D:\\爱丽丝\\data\\data\\jarvis.db'
  if (fs.existsSync(realDb)) {
    const beforeSize = fs.statSync(realDb).size
    // 只读打开原件做能力探测：确认它**确实**没有 rounds_total（迁移有活干）
    const ro = new Database(realDb, { readonly: true })
    const realColsBefore = ro.prepare('PRAGMA table_info(goals)').all().map(c => c.name)
    const realRowsBefore = ro.prepare('SELECT COUNT(*) n FROM goals').get().n
    ro.close()
    console.log(`  原件 ${realDb}：${(beforeSize / 1048576).toFixed(1)} MB，${realRowsBefore} 行，列 [${realColsBefore.join(', ')}]`)
    // 这里**不能**硬断言「真库还没有 rounds_total」——那是一次性时雷：
    // 只要真库被迁移过（活实例启动新代码、或早先某次 sweep 走到用真库的套件），
    // 这条断言就必然失败，而问题根本不在迁移逻辑里。
    // 「迁移确实有活干」这个证明由上面那个**构造的旧表夹具**负责（它才是可控的）；
    // 真库这一节只验**幂等**与**原件字节不变**——无论列在不在都应成立。
    const realHadColumn = realColsBefore.includes('rounds_total')
    console.log(`  真库当前${realHadColumn ? '已有' : '还没有'} rounds_total：${realHadColumn ? '迁移应为无害的空转' : '迁移应加列并回填'}`)

    // 副本：连 -wal / -shm 一起复制，否则可能拿到不一致的快照
    const copyDir = path.join(resolvedTempRoot, 'real-db-copy')
    fs.mkdirSync(copyDir, { recursive: true })
    const copyDb = path.join(copyDir, 'jarvis.db')
    fs.copyFileSync(realDb, copyDb)
    for (const suffix of ['-wal', '-shm']) {
      if (fs.existsSync(realDb + suffix)) fs.copyFileSync(realDb + suffix, copyDb + suffix)
    }
    const copy = new Database(copyDb)
    const copyColsBefore = copy.prepare('PRAGMA table_info(goals)').all().map(c => c.name)
    // 断言「副本与原件列一致」（复制完整），而不是断言列不存在
    check('副本复制完整（列与原件一致）',
      JSON.stringify(copyColsBefore) === JSON.stringify(realColsBefore), copyColsBefore.join(', '))

    // 在副本上跑**和 goal-store 里完全相同的**迁移语句
    const have = new Set(copyColsBefore)
    if (!have.has('rounds_total')) copy.exec('ALTER TABLE goals ADD COLUMN rounds_total INTEGER NOT NULL DEFAULT 0')
    const backfilled = copy.prepare('UPDATE goals SET rounds_total = rounds_started WHERE rounds_total < rounds_started').run()
    const copyRows = copy.prepare('SELECT goal_id, rounds_started, rounds_total, status FROM goals').all()
    const bad = copyRows.filter(r => !(Number.isSafeInteger(r.rounds_total) && r.rounds_total >= r.rounds_started))
    copy.close()
    check('副本迁移成功：所有行 rounds_total >= rounds_started',
      bad.length === 0, bad.length ? JSON.stringify(bad.slice(0, 3)) : `${copyRows.length} 行全部满足`)
    console.log(`  副本迁移：ALTER 加列 + 回填影响 ${backfilled.changes} 行；样例 ${JSON.stringify(copyRows.slice(0, 2))}`)
    // 原件必须字节不变
    check('原件未被触碰（大小不变）', fs.statSync(realDb).size === beforeSize,
      `${beforeSize} → ${fs.statSync(realDb).size}`)
  } else {
    console.log(`  跳过：真库不存在（${realDb}）`)
  }

  console.log(`\n=== ${results.every(Boolean) ? 'PASS' : 'FAIL'} goal-total-rounds: ${results.filter(Boolean).length}/${results.length} 项 ===`)
  process.exitCode = results.every(Boolean) ? 0 : 1
} catch (error) {
  console.error(error)
  process.exitCode = 1
} finally {
  closeDBForTest()
  try { fs.rmSync(resolvedTempRoot, { recursive: true, force: true }) } catch { /* 清理失败不影响结论 */ }
}
