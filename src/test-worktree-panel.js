import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

// 工作树面板的数据接口测试：GET /worktrees 的**服务端展示字段**（面板全靠这几个字段
// 决定颜色、能不能回收、有没有危险），以及回收/清理登记的失败路径。
//
// 为什么这些字段值得单独测：面板跑在浏览器里，import 不到 src/runtime/，所以「脏不脏、
// 能不能回收」只能是服务端算的。算错的方向只有一种——**说能回收而实际会把用户的东西删掉**。
// 所以这里用真仓库，把「有未提交改动时必须 removable:false、必须拒绝回收」钉死。
//
// 用临时库，不碰真实数据：
//   npm run test:worktree-panel
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'blm-worktree-panel-'))
process.env.ALICE_USER_DIR = tmp
process.env.ALICE_RESOURCES_DIR = process.cwd()

const repoRootTmp = fs.mkdtempSync(path.join(os.tmpdir(), 'blm-worktree-panel-repos-'))

let closeDBForTest = null

// 全程不经过 shell，参数数组直传——含空格的路径正是这样才安全。
function git(args, cwd) {
  return execFileSync('git', args, { cwd, encoding: 'utf8', windowsHide: true }).trim()
}

function makeRepo(name) {
  const dir = path.join(repoRootTmp, name)
  fs.mkdirSync(dir, { recursive: true })
  git(['init', '-q', '-b', 'main'], dir)
  git(['config', 'user.email', 'test@example.com'], dir)
  git(['config', 'user.name', 'Test'], dir)
  git(['config', 'commit.gpgsign', 'false'], dir)
  fs.writeFileSync(path.join(dir, 'README.md'), '# demo\n', 'utf8')
  git(['add', 'README.md'], dir)
  git(['commit', '-q', '-m', 'init'], dir)
  return dir
}

try {
  const dbModule = await import('./db.js')
  closeDBForTest = dbModule.closeDBForTest
  const { handleWorktreeRoutes } = await import('./api/routes/worktrees.js')
  const { createWorktree } = await import('./runtime/worktree.js')
  const { recordWorktree, listOpenWorktrees } = await import('./runtime/worktree-store.js')

  const call = async (method, pathname, body) => {
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
      on(event, handler) {
        if (event === 'data' && body !== undefined) handler(Buffer.from(JSON.stringify(body), 'utf8'))
        if (event === 'end') handler()
      },
    }
    const handled = await handleWorktreeRoutes(req, res, url)
    return { handled, status, payload }
  }

  const rowFor = (board, target) => board.payload.worktrees.find(r => r.path === target)

  // ── 1. 空目录：结构完整，而不是 404 或 null ──────────────────────────
  {
    const empty = await call('GET', '/worktrees')
    assert.equal(empty.handled, true, '这条路径由本路由认领')
    assert.equal(empty.status, 200)
    assert.equal(empty.payload.ok, true)
    assert.deepEqual(empty.payload.worktrees, [])
    assert.equal(empty.payload.count, 0)
    // 不认领的路径/方法要留给后面的路由
    assert.equal((await call('GET', '/worktree')).handled, false)
    assert.equal((await call('PUT', '/worktrees')).handled, false)
  }

  // ── 2. 干净的工作树：字段齐全且判断正确 ──────────────────────────────
  const repo = makeRepo('clean-repo')
  const cleanWt = await createWorktree({ repo, branchName: 'panel-clean' })
  recordWorktree({
    repoRoot: cleanWt.repoRoot,
    path: cleanWt.path,
    branch: cleanWt.branch,
    baseBranch: cleanWt.baseBranch,
    baseCommit: cleanWt.baseCommit,
  })
  {
    const board = await call('GET', '/worktrees')
    assert.equal(board.payload.count, 1)
    const row = rowFor(board, cleanWt.path)
    assert.ok(row, '登记过的工作树要出现在目录里')
    assert.equal(row.branch, 'blm/panel-clean')
    assert.equal(row.repo_root, cleanWt.repoRoot)
    assert.equal(row.base_branch, 'main')
    assert.equal(row.status_code, 'clean')
    assert.equal(row.status_tone, 'ok')
    assert.equal(row.dirty, false)
    assert.equal(row.removable, true, '全干净时不用 force 就能回收')
    assert.equal(row.can_checkout, true, '主仓库干净 → 回收后会切到成果分支')
    assert.deepEqual([row.staged, row.unstaged, row.untracked], [0, 0, 0])
    assert.equal(row.missing, undefined, '目录在的时候不该带 missing')
    assert.equal(row.reason, '', '没风险就没必要吓人')
    assert.equal(row.reason_code, '', '干净时没有理由码')
    assert.equal(typeof row.status_label, 'string')
  }

  // ── 3. 未跟踪文件：dirty / 不可回收（**这会丢东西，必须是 false**）────
  fs.writeFileSync(path.join(cleanWt.path, 'precious.txt'), 'about to be lost\n', 'utf8')
  {
    const row = rowFor(await call('GET', '/worktrees'), cleanWt.path)
    assert.equal(row.status_code, 'dirty')
    assert.equal(row.status_tone, 'danger')
    assert.equal(row.dirty, true)
    assert.equal(row.removable, false, '有未提交改动时说「可回收」就等于让用户以为自己安全')
    assert.equal(row.untracked, 1)
    assert.equal(row.reason_code, 'uncommitted')
    assert.ok(/未提交/.test(row.reason), `要如实说明会丢什么: ${row.reason}`)
  }

  // ── 4. 只有已暂存的改动：单独一档（这正是 carry_staged 能带走的那种）──
  git(['add', 'precious.txt'], cleanWt.path)
  {
    const row = rowFor(await call('GET', '/worktrees'), cleanWt.path)
    assert.equal(row.status_code, 'staged')
    assert.equal(row.status_tone, 'warn')
    assert.deepEqual([row.staged, row.unstaged, row.untracked], [1, 0, 0])
    assert.equal(row.removable, false, '直接回收仍会连暂存内容一起删掉')
    assert.equal(row.reason_code, 'staged_only')
    assert.ok(/暂存/.test(row.reason), `要指出带走暂存的那条路: ${row.reason}`)
  }

  // ── 5. 回收：脏的时候必须**拒绝**，而且如实报告（不能假装成功）───────
  {
    const refused = await call('POST', '/worktrees/reclaim', { path: cleanWt.path })
    assert.equal(refused.status, 409, '用户要先决定是否毁掉那点改动 → 冲突，不是服务器故障')
    assert.equal(refused.payload.ok, false)
    assert.equal(refused.payload.code, 'WORKTREE_DIRTY')
    assert.ok(/uncommitted/.test(refused.payload.error), `拒绝要说清原因: ${refused.payload.error}`)
    assert.equal(fs.existsSync(cleanWt.path), true, '被拒时工作树当然还在')
    assert.ok(Array.isArray(refused.payload.worktrees), '失败也要把刷新后的列表带回来')
    assert.equal(refused.payload.worktrees.find(r => r.path === cleanWt.path).removable, false)
  }

  // ── 6. 强制回收：成功时成果真的落到了本地分支 ────────────────────────
  {
    const forced = await call('POST', '/worktrees/reclaim', { path: cleanWt.path, force: true })
    assert.equal(forced.status, 200, JSON.stringify(forced.payload))
    assert.equal(forced.payload.ok, true)
    assert.equal(forced.payload.result.removed.removed, true)
    assert.equal(forced.payload.result.switched, true, '主仓库干净，回收后应当切到成果分支')
    assert.equal(fs.existsSync(cleanWt.path), false, '目录真的被删了')
    assert.notEqual(git(['branch', '--list', 'blm/panel-clean'], repo), '', '成果分支还在')
    assert.equal(forced.payload.worktrees.some(r => r.path === cleanWt.path), false, '回收后从列表里消失')
    assert.equal(listOpenWorktrees().some(e => e.path === cleanWt.path), false, '登记也关掉了')
  }

  // ── 7. can_checkout 是**另一个**条件：主仓库脏时不切分支 ──────────────
  const repo2 = makeRepo('dirty-main-repo')
  const liveWt = await createWorktree({ repo: repo2, branchName: 'panel-live' })
  recordWorktree({
    repoRoot: liveWt.repoRoot,
    path: liveWt.path,
    branch: liveWt.branch,
    baseBranch: liveWt.baseBranch,
    baseCommit: liveWt.baseCommit,
  })
  fs.writeFileSync(path.join(repo2, 'wip.txt'), 'local wip\n', 'utf8')
  {
    const row = rowFor(await call('GET', '/worktrees'), liveWt.path)
    assert.equal(row.removable, true, '工作树自己是干净的 → 能回收')
    assert.equal(row.can_checkout, false, '但主仓库脏 → 回收后不会切分支（成果仍在本地分支上）')
    assert.equal(row.status_code, 'clean')

    // 目录还在时不许「清理登记」——那会让 git 那边的活工作树在面板里凭空消失
    const stillThere = await call('POST', '/worktrees/forget', { path: liveWt.path })
    assert.equal(stillThere.status, 409)
    assert.equal(stillThere.payload.code, 'WORKTREE_STILL_PRESENT')
    assert.equal(stillThere.payload.ok, false)
  }

  // ── 8. 死记录：目录没了 → 标 missing，可以清理登记 ───────────────────
  {
    fs.rmSync(liveWt.path, { recursive: true, force: true })
    const row = rowFor(await call('GET', '/worktrees'), liveWt.path)
    assert.equal(row.missing, true)
    assert.equal(row.status_code, 'missing')
    assert.equal(row.status_tone, 'dim')
    assert.equal(row.removable, false, '没法并回，所以不是「回收」，走清理登记')
    assert.equal(row.can_checkout, false)
    assert.equal(row.reason_code, 'missing')

    const forgotten = await call('POST', '/worktrees/forget', { path: liveWt.path })
    assert.equal(forgotten.status, 200, JSON.stringify(forgotten.payload))
    assert.equal(forgotten.payload.forgotten, liveWt.path)
    assert.equal(forgotten.payload.worktrees.some(r => r.path === liveWt.path), false)
    assert.equal(listOpenWorktrees().some(e => e.path === liveWt.path), false)
  }

  // ── 9. 坏输入：要给出原因，不能吞成「成功」 ──────────────────────────
  {
    assert.equal((await call('POST', '/worktrees/reclaim', {})).status, 400)
    assert.equal((await call('POST', '/worktrees/forget', {})).status, 400)
    assert.equal((await call('POST', '/worktrees/reclaim', { path: '  ' })).payload.code, 'WORKTREE_REQUIRED')

    const unknown = await call('POST', '/worktrees/reclaim', { path: path.join(repoRootTmp, 'never-registered') })
    assert.equal(unknown.status, 404)
    assert.equal(unknown.payload.code, 'WORKTREE_NOT_REGISTERED')
    assert.equal(unknown.payload.ok, false)

    const unknownForget = await call('POST', '/worktrees/forget', { path: path.join(repoRootTmp, 'never-registered') })
    assert.equal(unknownForget.status, 404)
    assert.equal(unknownForget.payload.ok, false)

    // 非 JSON 体：要如实报「体坏了」，而不是当成空体继续跑
    const url = new URL('http://127.0.0.1:3000/worktrees/reclaim')
    let status = null
    let payload = null
    const res = { writeHead(code) { status = code }, setHeader() {}, end(chunk) { payload = JSON.parse(chunk) } }
    const req = {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      on(event, handler) {
        if (event === 'data') handler(Buffer.from('{not json', 'utf8'))
        if (event === 'end') handler()
      },
    }
    assert.equal(await handleWorktreeRoutes(req, res, url), true)
    assert.equal(status, 400)
    assert.equal(payload.code, 'BAD_BODY')
    assert.ok(/invalid JSON/.test(payload.error), `要带上真正的原因: ${payload.error}`)
  }

  console.log('PASS worktree-panel: server-computed display fields (dirty/removable/can_checkout/tone) and honest reclaim/forget failures')
} finally {
  closeDBForTest?.()
  try { fs.rmSync(tmp, { recursive: true, force: true }) } catch { /* 清理失败不影响结论 */ }
  try { fs.rmSync(repoRootTmp, { recursive: true, force: true }) } catch { /* 同上 */ }
}
