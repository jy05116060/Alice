import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

// Worktree 隔离开发流（阶段 5）测试。**必须用真仓库**——worktree 的行为
// （分支指向、暂存区搬运、脏工作区拒绝回收）没有一个是能靠 mock 验出来的：
//   npm run test-worktree
const {
  createWorktree,
  checkoutWorktree,
  removeWorktree,
  listWorktrees,
  resolveRepoRoot,
  currentBranch,
  headCommit,
  worktreeStatus,
  branchExists,
  normalizeBranchName,
  safeBranchSegment,
  deriveWorktreePath,
  samePath,
  carryStagedChanges,
  WorktreeError,
} = await import('./runtime/worktree.js')

const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'blm-worktree-'))

// 全程不经过 shell，参数数组直传——含空格与中文的路径正是这样才安全。
function git(args, cwd) {
  return execFileSync('git', args, { cwd, encoding: 'utf8', windowsHide: true }).trim()
}

function makeRepo(name) {
  const dir = path.join(tmpRoot, name)
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

let cleaned = false
function cleanup() {
  if (cleaned) return
  cleaned = true
  // 先让 git 忘掉工作树登记，再删目录——否则下次在同一个父目录里建仓库会被登记记录干扰
  try { fs.rmSync(tmpRoot, { recursive: true, force: true }) } catch {}
}

try {
  // ── 1. 名称与路径规范化（纯函数）────────────────────────────────────
  {
    assert.equal(normalizeBranchName('feature-x'), 'blm/feature-x', '没有斜杠时加项目前缀，与 DSH 加 dsh/ 同理')
    assert.equal(normalizeBranchName('blm/feature-x'), 'blm/feature-x', '已有斜杠就不再加前缀')
    assert.equal(normalizeBranchName('user/fix-thing'), 'user/fix-thing', '用户自己分的层级要保留')
    for (const bad of ['', '  ', 'a b', 'a..b', 'a~b', '/lead', 'trail/', 'a:b']) {
      let caught = null
      try { normalizeBranchName(bad) } catch (error) { caught = error }
      assert.ok(caught, `分支名 "${bad}" 应被拒`)
      assert.ok(['BRANCH_REQUIRED', 'INVALID_BRANCH'].includes(caught.code), `错误码应为 BRANCH_REQUIRED/INVALID_BRANCH，got ${caught.code}`)
    }

    // 目录片段：斜杠与 Windows 非法字符都要换掉，且不能空
    assert.equal(safeBranchSegment('blm/feature-x'), 'blm-feature-x')
    assert.equal(safeBranchSegment('a b c'), 'a-b-c')
    assert.equal(safeBranchSegment('a:b*c?d"e<f>g|h'), 'a-b-c-d-e-f-g-h')
    assert.equal(safeBranchSegment('trailing...'), 'trailing')
    assert.equal(safeBranchSegment('///'), 'worktree', '全非法时要有兜底名，不能是空目录名')
    assert.equal(safeBranchSegment(''), 'worktree')

    // 工作树放在仓库旁边，不放里面
    const derived = deriveWorktreePath('D:\\repo', 'blm/x')
    assert.ok(derived.includes('repo.worktrees'), '默认路径在 <repo>.worktrees 下')
    assert.ok(!/^D:\\repo[\\/]/.test(derived), '不能放在仓库内部——否则主仓库自己就能扫到隔离区')

    assert.equal(samePath('D:\\A\\b', 'd:/a/b/'), true, '跨平台路径比较：大小写与分隔符都不参与')
    assert.equal(samePath('D:\\A\\b', 'D:\\A\\c'), false)
  }

  // ── 2. 建工作树：主工作区不动，隔离区独立 ───────────────────────────
  {
    const repo = makeRepo('basic')
    const repoRoot = await resolveRepoRoot(repo)
    assert.equal(samePath(repoRoot, repo), true, '仓库根解析')
    assert.equal(await currentBranch(repo), 'main')
    const baseCommit = await headCommit(repo)

    const created = await createWorktree({ repo, branchName: 'feature-one' })
    assert.equal(created.branch, 'blm/feature-one')
    assert.equal(created.baseBranch, 'main')
    assert.equal(created.baseCommit, baseCommit)
    assert.equal(fs.existsSync(created.path), true, '工作树目录真的建出来了')
    assert.equal(await currentBranch(created.path), 'blm/feature-one', '新工作树在新分支上')

    // 主仓库分支没被切走
    assert.equal(await currentBranch(repo), 'main', '建工作树不该改变主仓库所在分支')

    // 隔离是真的：在工作树里提交，主仓库看不到
    fs.writeFileSync(path.join(created.path, 'work.txt'), 'in worktree\n', 'utf8')
    git(['add', 'work.txt'], created.path)
    git(['commit', '-q', '-m', 'worktree commit'], created.path)
    assert.equal(fs.existsSync(path.join(repo, 'work.txt')), false, '工作树里的提交不会出现在主仓库工作区')
    assert.equal(await headCommit(repo), baseCommit, '主仓库 HEAD 没动')

    // 登记列表能同时看到主工作区与隔离区
    const list = await listWorktrees(repo)
    assert.equal(list.length, 2)
    assert.ok(list.some(w => samePath(w.path, repo) && w.branch === 'main'))
    assert.ok(list.some(w => samePath(w.path, created.path) && w.branch === 'blm/feature-one'))

    // 重名分支要被拒
    let dup = null
    try { await createWorktree({ repo, branchName: 'feature-one' }) } catch (error) { dup = error }
    assert.equal(dup?.code, 'BRANCH_EXISTS')

    // 路径被占也要被拒（用同一个分支名但显式给已存在的路径）
    let occupied = null
    try {
      await createWorktree({ repo, branchName: 'feature-two', path: repo })
    } catch (error) { occupied = error }
    assert.equal(occupied?.code, 'PATH_EXISTS')
  }

  // ── 3. carryStaged：只带暂存区，未暂存/未跟踪留在原地 ────────────────
  {
    const repo = makeRepo('carry')
    // 已跟踪文件改成暂存 + 再改一次（未暂存部分）
    fs.writeFileSync(path.join(repo, 'README.md'), '# demo\nstaged line\n', 'utf8')
    git(['add', 'README.md'], repo)
    fs.writeFileSync(path.join(repo, 'README.md'), '# demo\nstaged line\nunstaged line\n', 'utf8')
    // 新文件进暂存区
    fs.writeFileSync(path.join(repo, 'staged-new.txt'), 'new\n', 'utf8')
    git(['add', 'staged-new.txt'], repo)
    // 未跟踪文件
    fs.writeFileSync(path.join(repo, 'untracked.txt'), 'untracked\n', 'utf8')

    const created = await createWorktree({ repo, branchName: 'carry-staged', carryStaged: true })
    const inWt = fs.readFileSync(path.join(created.path, 'README.md'), 'utf8')
    assert.match(inWt, /staged line/, '暂存区里的改动要带过来')
    assert.doesNotMatch(inWt, /unstaged line/, '未暂存的改动不能带过来')
    assert.equal(fs.existsSync(path.join(created.path, 'staged-new.txt')), true, '暂存的新文件要带过来')
    assert.equal(fs.existsSync(path.join(created.path, 'untracked.txt')), false, '未跟踪文件不带过来')
    assert.equal(created.carriedStaged, 2, '报告的搬运文件数与实际一致')

    // 带过来的改动在新工作树里仍是**暂存**状态（这样「继续改再提交」的语义是连贯的）
    const wtStatus = git(['status', '--porcelain'], created.path)
    assert.match(wtStatus, /^M {2}README\.md$/m, 'README 在新工作树里是已暂存的修改')
    assert.match(wtStatus, /^A {2}staged-new\.txt$/m, '新文件在新工作树里是已暂存的新增')

    // 不带 carryStaged 时是干净的
    const clean = await createWorktree({ repo, branchName: 'no-carry' })
    assert.deepEqual((await worktreeStatus(clean.path)).entries, [], '不带暂存区时新工作树干净')

    // 源仓库自己的状态不受影响：未暂存的改动还在，而且现在是「既暂存又未暂存」（MM）——
    // 因为源文件先被暂存过一版，之后又被改了一次。这正好证明我们只搬了暂存那一版。
    const srcStatus = git(['status', '--porcelain'], repo)
    assert.match(srcStatus, /untracked\.txt/, '源仓库的未跟踪文件仍在原地')
    assert.match(srcStatus, /^MM README\.md$/m, '源仓库同时保有暂存版与未暂存版，两者都没被动过')
  }

  // ── 4. 空暂存区时搬运是 no-op ────────────────────────────────────────
  {
    const repo = makeRepo('empty-carry')
    const result = await carryStagedChanges({ fromRepo: repo, toRepo: repo })
    assert.equal(result.applied, false, '没有暂存内容时不该尝试 apply，也不该报错')
    assert.equal(result.files, 0)
  }

  // ── 5. 回收：提交落到本地分支，工作树被删，主分支不变 ────────────────
  {
    const repo = makeRepo('checkout')
    const created = await createWorktree({ repo, branchName: 'to-checkout' })
    fs.writeFileSync(path.join(created.path, 'feature.txt'), 'done\n', 'utf8')
    git(['add', 'feature.txt'], created.path)
    git(['commit', '-q', '-m', 'feature work'], created.path)
    const featCommit = await headCommit(created.path)

    const result = await checkoutWorktree({
      repo,
      worktreePath: created.path,
      branchName: 'blm/to-checkout',
    })
    assert.equal(result.commit, featCommit)
    assert.equal(result.switched, true, '主仓库干净时应当切到目标分支')
    assert.equal(result.removed.removed, true, '工作树被回收')
    assert.equal(fs.existsSync(created.path), false, '工作树目录已删除')
    assert.equal(await branchExists(repo, 'blm/to-checkout'), true, '本地分支被创建')
    assert.equal(await currentBranch(repo), 'blm/to-checkout', '主仓库切到了带成果的分支')
    assert.equal(await headCommit(repo), featCommit, '成果（提交）确实并回来了')
    assert.equal(fs.existsSync(path.join(repo, 'feature.txt')), true, '文件在工作区里可见了')

    // 工作树登记已清掉
    const list = await listWorktrees(repo)
    assert.equal(list.length, 1, '只剩主工作区')
    assert.equal(list[0].branch, 'blm/to-checkout', '主工作区现在在成果分支上')
  }

  // ── 6. 回收时 carryStaged：工作树里未提交但已暂存的改动要保住 ────────
  {
    const repo = makeRepo('checkout-carry')
    const created = await createWorktree({ repo, branchName: 'carry-back' })
    // 一次提交
    fs.writeFileSync(path.join(created.path, 'committed.txt'), 'a\n', 'utf8')
    git(['add', 'committed.txt'], created.path)
    git(['commit', '-q', '-m', 'committed work'], created.path)
    // 外加一处只暂存、没提交的改动
    fs.writeFileSync(path.join(created.path, 'pending.txt'), 'not yet committed\n', 'utf8')
    git(['add', 'pending.txt'], created.path)

    const result = await checkoutWorktree({
      repo, worktreePath: created.path, branchName: 'blm/carry-back', carryStaged: true,
    })
    assert.equal(result.carriedStaged, 1)
    assert.equal(result.removed.removed, true)
    // 提交与暂存区都保住了
    assert.equal(fs.existsSync(path.join(repo, 'committed.txt')), true, '提交带回来了')
    assert.equal(fs.existsSync(path.join(repo, 'pending.txt')), true, '暂存改动没随着工作树一起消失')
    assert.match(git(['status', '--porcelain'], repo), /^A {2}pending\.txt$/m, '带回来的暂存改动在主仓库里仍是暂存状态')
  }

  // ── 7. 有未提交改动的工作树拒绝回收（默认），force 才毁 ──────────────
  {
    const repo = makeRepo('dirty')
    const created = await createWorktree({ repo, branchName: 'dirty-wt' })
    fs.writeFileSync(path.join(created.path, 'precious.txt'), 'about to be lost\n', 'utf8')

    let refused = null
    try { await removeWorktree({ repo, worktreePath: created.path }) } catch (error) { refused = error }
    assert.equal(refused?.code, 'WORKTREE_DIRTY', '有未提交改动时必须拒绝，而不是静默毁掉')
    assert.match(refused.message, /uncommitted/)
    assert.ok(refused.detail?.entries?.length > 0, '拒绝时要列出会丢什么')
    assert.equal(fs.existsSync(path.join(created.path, 'precious.txt')), true, '被拒时文件当然还在')

    // 整个 checkout 路径也必须被这层挡住，不能绕过
    let viaCheckout = null
    try { await checkoutWorktree({ repo, worktreePath: created.path }) } catch (error) { viaCheckout = error }
    assert.equal(viaCheckout?.code, 'WORKTREE_DIRTY', 'checkout 也不能绕过这道保险')

    // force 明确要求才毁
    const forced = await removeWorktree({ repo, worktreePath: created.path, force: true })
    assert.equal(forced.removed, true)
    assert.equal(fs.existsSync(created.path), false)
  }

  // ── 8. 主仓库不干净时不切分支（但成果仍然落地）──────────────────────
  {
    const repo = makeRepo('dirty-main')
    const created = await createWorktree({ repo, branchName: 'from-dirty-main' })
    fs.writeFileSync(path.join(created.path, 'x.txt'), 'x\n', 'utf8')
    git(['add', 'x.txt'], created.path)
    git(['commit', '-q', '-m', 'x'], created.path)
    const featCommit = await headCommit(created.path)

    // 主仓库有一处未提交改动
    fs.writeFileSync(path.join(repo, 'README.md'), '# demo\nlocal wip\n', 'utf8')

    const result = await checkoutWorktree({ repo, worktreePath: created.path, branchName: 'blm/from-dirty-main' })
    assert.equal(result.switched, false, '主仓库脏的时候不切分支——切可能覆盖用户的在途改动')
    assert.ok(result.notes.some(n => /uncommitted change/.test(n)), '要如实说明为什么没切')
    assert.equal(await branchExists(repo, 'blm/from-dirty-main'), true, '但分支仍然被建出来了')
    assert.equal(await currentBranch(repo), 'main', '主仓库还在原分支上')
    assert.equal(git(['show', 'blm/from-dirty-main:x.txt'], repo), 'x', '成果在分支上，随时可以切过去')
    // 用户的在途改动完好
    assert.match(fs.readFileSync(path.join(repo, 'README.md'), 'utf8'), /local wip/, '用户的未提交改动不能被碰掉')
  }

  // ── 9. 路径含空格与中文 ─────────────────────────────────────────────
  {
    const repo = makeRepo('带 空格 的 仓库 dir')
    const created = await createWorktree({ repo, branchName: '空格测试' })
    assert.ok(created.path.includes('带 空格 的 仓库 dir.worktrees'), '含空格/中文的仓库也要能正确推导路径')
    assert.equal(fs.existsSync(created.path), true)

    fs.writeFileSync(path.join(created.path, '中文 文件.txt'), '内容\n', 'utf8')
    git(['add', '中文 文件.txt'], created.path)
    git(['commit', '-q', '-m', '中文提交'], created.path)

    const result = await checkoutWorktree({
      repo, worktreePath: created.path, branchName: 'blm/spaces-cn',
    })
    assert.equal(result.switched, true)
    assert.equal(fs.existsSync(path.join(repo, '中文 文件.txt')), true, '含空格与中文的路径下成果照样并回来')
    assert.equal(result.removed.removed, true)
  }

  // ── 10. 错误路径：不是仓库 / 工作树不存在 ───────────────────────────
  {
    const notRepo = path.join(tmpRoot, 'not-a-repo')
    fs.mkdirSync(notRepo, { recursive: true })
    let notRepoError = null
    try { await resolveRepoRoot(notRepo) } catch (error) { notRepoError = error }
    assert.equal(notRepoError?.code, 'NOT_A_REPO', '给出「不是 git 仓库」而不是一句 git stderr')

    const repo = makeRepo('errors')
    let missing = null
    try {
      await checkoutWorktree({ repo, worktreePath: path.join(tmpRoot, 'nope') })
    } catch (error) { missing = error }
    assert.equal(missing?.code, 'WORKTREE_NOT_FOUND')

    let noPath = null
    try { await checkoutWorktree({ repo, worktreePath: '' }) } catch (error) { noPath = error }
    assert.equal(noPath?.code, 'WORKTREE_REQUIRED')

    // 已经没了的工作树：remove 应当是幂等的「已经不在」，而不是报错
    const created = await createWorktree({ repo, branchName: 'ghost' })
    git(['worktree', 'remove', created.path], repo)
    const gone = await removeWorktree({ repo, worktreePath: created.path })
    assert.equal(gone.removed, false)
    assert.equal(gone.reason, 'already-gone')
  }

  cleanup()
  console.log('PASS worktree: isolation, staged-only carry, safe checkout, dirty-worktree refusal, and space/Chinese paths')
} catch (error) {
  cleanup()
  console.error(error)
  process.exitCode = 1
}
