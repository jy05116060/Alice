import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

// POST /goal 的写接口测试。
//
// **这个文件的存在本身就是一次教训**：当初补 POST /goal 时我只用 curl 打了 GET 做对照，
// 于是漏掉了「读体契约不一致」这个必然崩溃的 bug（框架的 readJsonBody 直接返回对象、
// 非法时抛异常，而我按返回 {body,error} 的局部函数去解构 → body 恒为 undefined →
// 下一行读 body.action 抛 TypeError → 穿出处理器被框架兜底成 500）。
// 所以写接口必须真的打一次写请求。
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'blm-goal-http-'))
process.env.ALICE_USER_DIR = tmp
process.env.ALICE_RESOURCES_DIR = process.cwd()

let closeDB = null
const results = []
const check = (label, ok, extra = '') => {
  results.push(ok)
  console.log(`  ${ok ? 'PASS' : 'FAIL'} ${label}${extra ? '  ' + extra : ''}`)
}

try {
  const { handleGoalRoutes } = await import('./api/routes/goals.js')
  const { execCreateGoal } = await import('./capabilities/tools/goals.js')
  const db = await import('./db.js')
  closeDB = db.closeDBForTest

  const raw = (bodyText) => {
    let status = null, payload = null
    const res = { writeHead(c) { status = c }, setHeader() {}, end(chunk) { payload = chunk ? JSON.parse(chunk) : null } }
    const req = {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      on(event, handler) {
        if (event === 'data' && bodyText !== undefined) handler(Buffer.from(bodyText, 'utf8'))
        if (event === 'end') handler()
      },
    }
    return handleGoalRoutes(req, res, new URL('http://127.0.0.1:3000/goal')).then(() => ({ status, payload }))
  }
  const post = (obj) => raw(JSON.stringify(obj))

  console.log('=== 1. 读体契约：坏 body 必须 400，而不是抛异常穿出去（原 bug）===')
  const bad = await post({ revision: 1, action: '' })
  check('缺 action → 400 + MISSING_ACTION', bad.status === 400 && bad.payload?.code === 'MISSING_ACTION', JSON.stringify(bad.payload))

  const broken = await raw('{ this is not json')
  check('非法 JSON → 400 + BAD_BODY（且带出原因）', broken.status === 400 && broken.payload?.code === 'BAD_BODY',
    JSON.stringify(broken.payload))

  const empty = await raw('')
  // 空 body 时框架的 readJsonBody 返回 {}（不是抛异常），所以走到「缺 action」这一支。
  // MISSING_ACTION 比 BAD_BODY 更准确：body 本身没坏，是缺字段。
  check('空 body → 400 + MISSING_ACTION', empty.status === 400 && empty.payload?.code === 'MISSING_ACTION',
    JSON.stringify(empty.payload))

  console.log('\n=== 2. 没有目标时：明确的错误码，不是崩溃 ===')
  const noGoal = await post({ revision: 1, action: 'resume' })
  check('无目标 → 非 2xx 且带业务码', [400, 404, 409].includes(noGoal.status) && !!noGoal.payload?.code,
    `${noGoal.status} ${JSON.stringify(noGoal.payload)}`)

  console.log('\n=== 3. 端到端：建目标 → resume → 真的重新上膛 ===')
  const created = await execCreateGoal({ objective: '测试目标：验证 POST /goal 能真的写进去', max_rounds: 3 }, {})
  const parsedCreate = JSON.parse(created)
  check('建目标成功', parsedCreate.ok === true, parsedCreate.error || '')
  const goalId = parsedCreate.goal?.goal_id

  // revision 冲突必须 409（乐观锁）
  const conflict = await post({ revision: 999, action: 'resume' })
  check('过期 revision → 409 + REVISION_CONFLICT',
    conflict.status === 409 && conflict.payload?.code === 'REVISION_CONFLICT', `${conflict.status} ${JSON.stringify(conflict.payload)}`)

  // 先读当前 revision，再 resume
  let status = null, snapshot = null
  const res2 = { writeHead(c) { status = c }, setHeader() {}, end(chunk) { snapshot = chunk ? JSON.parse(chunk) : null } }
  await handleGoalRoutes({ method: 'GET', headers: {}, on() {} }, res2, new URL('http://127.0.0.1:3000/goal'))
  check('GET 能读到刚建的目标', snapshot?.goal?.goal_id === goalId, JSON.stringify(snapshot?.goal?.goal_id))
  // 新建的目标**本来就是已上膛**的：人建目标就是为了让它开始干活。
  // （EP001 显示 armed:false 是**重启**造成的——armed_epoch 让「已上膛」只对创建它的
  //   那个进程有效，重启自动解除，必须先由人开口 resume。两者不矛盾。）
  check('新建目标即为已上膛（人就该立刻开始干活）', snapshot?.armed === true)

  const resumed = await post({ revision: snapshot.goal.revision, action: 'resume' })
  check('resume → 200', resumed.status === 200, `${resumed.status} ${JSON.stringify(resumed.payload)}`)
  check('resume 后 armed 为 true（真的重新上膛）', resumed.payload?.armed === true, JSON.stringify({ armed: resumed.payload?.armed }))
  check('resume 后轮数预算重置', resumed.payload?.goal?.rounds_started === 0,
    `rounds_started=${resumed.payload?.goal?.rounds_started}`)
  check('返回的目标形状与 GET 一致（同一 shapeGoal）',
    resumed.payload?.goal && JSON.stringify(Object.keys(resumed.payload.goal).sort()) === JSON.stringify(Object.keys(snapshot.goal).sort()),
    JSON.stringify(Object.keys(resumed.payload?.goal || {})))

  console.log(`\n${results.every(Boolean) ? 'PASS' : 'FAIL'} goal-http-write: ${results.filter(Boolean).length}/${results.length} 项`)
  process.exitCode = results.every(Boolean) ? 0 : 1
} finally {
  closeDB?.()
  try { fs.rmSync(tmp, { recursive: true, force: true }) } catch { /* 清理失败不影响结论 */ }
}
