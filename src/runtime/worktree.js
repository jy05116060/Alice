// Git worktree 隔离开发流（阶段 5，对齐 DSH 的 create_worktree / checkout_worktree）。
//
// 解决的问题：让 Agent 在**另一个目录**里改代码，主工作区完全不动。这样
// 「一边让我改，一边你自己还在这个仓库里干活」不会互相踩；改坏了也只是删掉工作树。
//
// 三条安全规矩（都是「宁可拒绝，不要静默毁掉东西」）：
//   1. **只搬运暂存区**（carryStaged）：未暂存与未跟踪的文件留在原地。这是 DSH 的契约，
//      也是唯一能解释清楚的语义——暂存区是「你明确说这次要带上的东西」。
//   2. **工作树里有未提交改动就拒绝回收**：工作树的提交会随分支带走，但未提交的改动
//      在 `git worktree remove` 时是**真的会没**。所以回收前必须干净，或者调用方明确要求强制。
//   3. **主仓库工作区不干净时不切换分支**：`git checkout` 在有未提交改动时可能失败，
//      更糟的是某些路径会覆盖掉用户的改动。只建分支、不切，然后如实告诉用户。
//
// Windows 路径：全程用 execFile + 参数数组，**不经过 shell**，所以含中文、空格的路径
// 不需要任何转义，也不会被 PowerShell/cmd 的引号规则改造。
import { execFile } from 'node:child_process'
import path from 'node:path'

export class WorktreeError extends Error {
  constructor(code, message, detail = null) {
    super(message)
    this.name = 'WorktreeError'
    this.code = code
    this.detail = detail
  }
}

const DEFAULT_TIMEOUT_MS = 120_000
const MAX_BUFFER = 32 * 1024 * 1024

/** 跑一条 git 命令。永远不经过 shell（参数数组直传），所以路径里的空格/中文是安全的。 */
export function runGit(args, { cwd = null, timeoutMs = DEFAULT_TIMEOUT_MS, input = null } = {}) {
  return new Promise((resolve, reject) => {
    const child = execFile('git', args, {
      cwd: cwd || undefined,
      timeout: timeoutMs,
      maxBuffer: MAX_BUFFER,
      windowsHide: true,
      encoding: 'utf8',
      env: { ...process.env, GIT_TERMINAL_PROMPT: '0' },
    }, (error, stdout, stderr) => {
      if (error) {
        reject(new WorktreeError(
          'GIT_FAILED',
          `git ${args[0]} failed: ${(stderr || error.message || '').trim() || error.code}`,
          { args, cwd, stderr: String(stderr || '').trim(), code: error.code },
        ))
        return
      }
      resolve({ stdout: String(stdout || ''), stderr: String(stderr || '') })
    })
    if (input !== null) {
      child.stdin?.end(input)
    }
  })
}

export async function gitVersion() {
  const { stdout } = await runGit(['--version'])
  return stdout.trim()
}

/** 仓库根目录（吸掉符号链接与盘符大小写差异，后续比较都用它）。 */
export async function resolveRepoRoot(repoPath) {
  const cwd = String(repoPath || '.').trim() || '.'
  let stdout
  try {
    ({ stdout } = await runGit(['rev-parse', '--show-toplevel'], { cwd }))
  } catch (error) {
    if (error instanceof WorktreeError && /not a git repository/i.test(error.message)) {
      throw new WorktreeError('NOT_A_REPO', `${cwd} is not inside a git repository`)
    }
    throw error
  }
  return stdout.trim()
}

export async function currentBranch(repoPath) {
  const { stdout } = await runGit(['rev-parse', '--abbrev-ref', 'HEAD'], { cwd: repoPath })
  const name = stdout.trim()
  return name === 'HEAD' ? null : name // detached HEAD
}

export async function headCommit(repoPath) {
  const { stdout } = await runGit(['rev-parse', 'HEAD'], { cwd: repoPath })
  return stdout.trim()
}

/** 工作区干净吗？返回 `{ clean, entries }`；entries 是 porcelain 的逐行输出。 */
export async function worktreeStatus(repoPath) {
  const { stdout } = await runGit(['status', '--porcelain'], { cwd: repoPath })
  const entries = stdout.split('\n').map(line => line.trimEnd()).filter(Boolean)
  return { clean: entries.length === 0, entries }
}

/**
 * 把 porcelain 的 `XY path` 拆成「暂存 / 未暂存 / 未跟踪」三堆。
 *
 * 为什么非拆不可：`carryStaged` 的全部意义就是**把暂存区带走**，所以对这条路径来说
 * 暂存的改动不是「会丢的东西」，而是「正要搬的东西」。把两者混成一个 clean 判断，
 * 会让 carryStaged 永远被自己的安全阀挡住——那是测试里真实发生过的。
 * 真正会丢的是**未暂存与未跟踪**：它们既不会被带走，也会随工作树一起消失。
 */
export function classifyWorktreeStatus(entries = []) {
  const staged = []
  const unstaged = []
  const untracked = []
  for (const line of entries) {
    if (line.startsWith('??')) { untracked.push(line); continue }
    const x = line[0]
    const y = line[1]
    if (x && x !== ' ' && x !== '?') staged.push(line)
    if (y && y !== ' ') unstaged.push(line)
  }
  return {
    staged,
    unstaged,
    untracked,
    // 回收工作树时真正会无法挽回的东西
    atRiskWithoutCarry: staged.length + unstaged.length + untracked.length,
    atRiskWithCarry: unstaged.length + untracked.length,
    describe() {
      const parts = []
      if (staged.length) parts.push(`${staged.length} staged`)
      if (unstaged.length) parts.push(`${unstaged.length} unstaged`)
      if (untracked.length) parts.push(`${untracked.length} untracked`)
      return parts.join(', ') || 'nothing'
    },
  }
}

export async function branchExists(repoPath, branchName) {
  try {
    await runGit(['rev-parse', '--verify', '--quiet', `refs/heads/${branchName}`], { cwd: repoPath })
    return true
  } catch {
    return false
  }
}

/**
 * 分支名 → 目录名片段。
 * `/` 不能直接当目录名（会和既有目录层级冲突），所以替换成 `-`；
 * Windows 的非法字符也一并替换。返回值保证非空、无非法字符。
 */
export function safeBranchSegment(branchName) {
  const cleaned = String(branchName || '')
    .replace(/[\\/:*?"<>|]/g, '-')   // 路径分隔符 + Windows 非法字符
    .replace(/[\s]+/g, '-')          // 空格
    .replace(/\.+$/, '')             // Windows 不允许目录名以点结尾
    .replace(/^-+|-+$/g, '')
  return cleaned || 'worktree'
}

/**
 * 默认工作树路径：放在仓库**旁边**的 `<repo>.worktrees/<branch>`。
 * 为什么不放仓库内部：放里面会被主仓库的 `git status` / 各种 glob 扫到，
 * 变成「自己看得见自己的隔离区」，隔离的意义就没了。
 */
export function deriveWorktreePath(repoRoot, branchName) {
  return path.join(`${repoRoot}.worktrees`, safeBranchSegment(branchName))
}

/** 当前登记的 worktree 列表（含主工作区，`git worktree list` 的原样解析）。 */
export async function listWorktrees(repoPath) {
  const { stdout } = await runGit(['worktree', 'list', '--porcelain'], { cwd: repoPath })
  const blocks = stdout.split('\n\n').map(b => b.trim()).filter(Boolean)
  return blocks.map((block) => {
    const entry = { path: '', head: '', branch: null, detached: false, bare: false }
    for (const line of block.split('\n')) {
      if (line.startsWith('worktree ')) entry.path = line.slice('worktree '.length)
      else if (line.startsWith('HEAD ')) entry.head = line.slice('HEAD '.length)
      else if (line.startsWith('branch ')) entry.branch = line.slice('branch '.length).replace(/^refs\/heads\//, '')
      else if (line === 'detached') entry.detached = true
      else if (line === 'bare') entry.bare = true
    }
    return entry
  }).filter(entry => entry.path)
}

function isMissingWorktreeError(error) {
  return /is not a working tree|not a working tree/i.test(error?.message || '')
}

/**
 * 建一个隔离工作树。
 * @returns {{path, branch, baseBranch, baseCommit, carriedStaged: number}}
 */
export async function createWorktree({ repo, branchName, path = null, carryStaged = false } = {}) {
  const repoRoot = await resolveRepoRoot(repo)
  const branch = normalizeBranchName(branchName)
  if (await branchExists(repoRoot, branch)) {
    throw new WorktreeError('BRANCH_EXISTS', `branch "${branch}" already exists; pick another name`)
  }
  const target = path ? String(path) : deriveWorktreePath(repoRoot, branch)
  if (await pathExists(target)) {
    throw new WorktreeError('PATH_EXISTS', `worktree path already exists: ${target}`)
  }

  const baseBranch = await currentBranch(repoRoot)
  const baseCommit = await headCommit(repoRoot)

  const args = ['worktree', 'add', '-b', branch]
  if (carryStaged) {
    // 带暂存区进来：先把「源仓库当前 HEAD」作为起点建好，再把暂存区打上去。
    // （直接 worktree add 会从 HEAD 建新分支，暂存区不在里面。）
    args.push(target, baseCommit)
  } else {
    args.push(target)
  }
  await runGit(args, { cwd: repoRoot })

  let carriedStaged = 0
  if (carryStaged) {
    const carried = await carryStagedChanges({ fromRepo: repoRoot, toRepo: target })
    carriedStaged = carried.files
  }

  return { repoRoot, path: target, branch, baseBranch, baseCommit, carriedStaged }
}

/** 分支名规范化：没有 `/` 时加上本项目前缀，与 DSH 给 dsh/ 加前缀同理。 */
export function normalizeBranchName(branchName, prefix = 'blm/') {
  const raw = String(branchName || '').trim()
  if (!raw) throw new WorktreeError('BRANCH_REQUIRED', 'branch_name is required')
  if (/[\s~^:?*\[\\]/.test(raw) || raw.includes('..') || raw.startsWith('/') || raw.endsWith('/')) {
    throw new WorktreeError('INVALID_BRANCH', `"${raw}" is not a valid git branch name`)
  }
  return raw.includes('/') ? raw : `${prefix}${raw}`
}

/**
 * 把源仓库的**暂存区**（只有暂存区）搬到目标仓库，并在目标里也保持「已暂存」状态。
 * 未暂存 / 未跟踪的东西不动——那是源仓库的在途工作，不该被复制走。
 */
export async function carryStagedChanges({ fromRepo, toRepo }) {
  const captured = await captureStagedDiff({ repo: fromRepo })
  if (!captured.diff) return { files: 0, applied: false }
  await applyStagedDiff({ repo: toRepo, diff: captured.diff })
  return { files: captured.files, applied: true }
}

/** 只读取差异、不落任何东西。回收流程要「先取下来再删源」时用这个。 */
export async function captureStagedDiff({ repo }) {
  const { stdout: diff } = await runGit(['diff', '--cached', '--binary'], { cwd: repo })
  if (!diff.trim()) return { diff: '', files: 0 }
  return { diff, files: (diff.match(/^diff --git /gm) || []).length }
}

/** 把差异按「已暂存」落到目标仓库。失败时把补丁附在错误里，调用方还有第二次机会。 */
export async function applyStagedDiff({ repo, diff, files = 0 }) {
  if (!diff) return { applied: false, files: 0 }
  try {
    await runGit(['apply', '--index', '--binary', '-'], { cwd: repo, input: diff })
  } catch (error) {
    throw new WorktreeError(
      'CARRY_STAGED_FAILED',
      `could not apply the staged changes: ${error.detail?.stderr || error.message}`,
      { files, diff },
    )
  }
  return { applied: true, files }
}

/**
 * 把一个隔离工作树并回本地仓库，然后回收它。
 *
 * 步骤顺序是刻意排的，有两处不能颠倒：
 *   1. **先校验再动手**：工作树有未提交改动就整个拒绝（除非 force）。放在最前面，
 *      避免「已经改了别的，最后才发现在这一步失败」的半成品状态。
 *   2. **先删工作树，再切主仓库的分支**：git 不允许检出**已被别的 worktree 占用**的分支
 *      （fatal: '...' is already checked out at ...）。工作树的成果分支通常就是要切的那个，
 *      所以必须等它释放。这一条是测试抓出来的——顺序写反时表现为「主仓库干净却切不过去」。
 *
 * 暂存区搬运放在删之前（要读工作树的 index），建分支放在删之前（建分支指向某个 commit
 * 与工作树的占用无关，失败也无害）。
 */
export async function checkoutWorktree({ repo, worktreePath, branchName = null, carryStaged = false, force = false } = {}) {
  const repoRoot = await resolveRepoRoot(repo)
  const wtPath = String(worktreePath || '').trim()
  if (!wtPath) throw new WorktreeError('WORKTREE_REQUIRED', 'worktree path is required')

  const worktrees = await listWorktrees(repoRoot)
  const entry = worktrees.find(w => samePath(w.path, wtPath))
  if (!entry) {
    throw new WorktreeError('WORKTREE_NOT_FOUND', `${wtPath} is not a registered worktree of ${repoRoot}`)
  }

  // ① 先校验：会丢东西就先停下来，一步都不做。
  //    carryStaged 时暂存改动是「正要搬走的」，不算会丢；未暂存/未跟踪才算。
  const wtStatus = await worktreeStatus(wtPath)
  const wtClassified = classifyWorktreeStatus(wtStatus.entries)
  const atRisk = carryStaged ? wtClassified.atRiskWithCarry : wtClassified.atRiskWithoutCarry
  if (atRisk > 0 && !force) {
    throw new WorktreeError(
      'WORKTREE_DIRTY',
      carryStaged
        ? `${wtPath} has uncommitted work that carryStaged does NOT move (${wtClassified.describe()}); only staged changes can be carried, so commit or discard the rest first, or pass force to destroy it`
        : `${wtPath} has uncommitted work that would be destroyed (${wtClassified.describe()}); commit or discard it first, or pass force to destroy it`,
      { entries: wtStatus.entries.slice(0, 20), staged: wtClassified.staged.length, unstaged: wtClassified.unstaged.length, untracked: wtClassified.untracked.length },
    )
  }

  const wtCommit = await headCommit(wtPath)
  const sourceBranch = entry.branch || null
  const targetBranch = normalizeBranchName(branchName || sourceBranch || '')
  const notes = []

  // ② 先把暂存区的差异**取下来**（只读）。刻意不在这里落盘——落了会把主仓库弄脏，
  //    而下一步的切分支要求主仓库干净。取下来的补丁一直握在手里，即使后面某步失败
  //    也不会丢（churn 报告里会带上补丁文本）。
  let stagedPatch = { diff: '', files: 0 }
  if (carryStaged) {
    stagedPatch = await captureStagedDiff({ repo: wtPath })
  }

  // ③ 建本地分支指向成果（已存在就不动它——强行 reset 会毁掉本地提交）
  const existed = await branchExists(repoRoot, targetBranch)
  if (!existed) {
    await runGit(['branch', targetBranch, wtCommit], { cwd: repoRoot })
    notes.push(`created local branch "${targetBranch}" at ${wtCommit.slice(0, 8)}`)
  } else {
    const { stdout: existingSha } = await runGit(['rev-parse', `refs/heads/${targetBranch}`], { cwd: repoRoot })
    const existing = existingSha.trim()
    if (existing !== wtCommit) {
      notes.push(`local branch "${targetBranch}" already existed at ${existing.slice(0, 8)}; the worktree's commits are on "${sourceBranch}" and were NOT merged into it`)
    } else {
      notes.push(`local branch "${targetBranch}" already points at the worktree's HEAD`)
    }
  }

  // ④ 回收工作树（腾出分支占用；成果已经在分支上，这一步失败也不会丢东西）
  //    ignoreStaged: 暂存内容已经取在手上，所以它不再「会丢」。
  const removed = await removeWorktree({
    repo: repoRoot, worktreePath: wtPath, force, ignoreStaged: carryStaged,
  })

  // ⑤ 现在才能切主仓库的分支（工作树释放了它）。此时主仓库还是干净的——
  //    所以这一步必须先于「落补丁」。
  const status = await worktreeStatus(repoRoot)
  let switched = false
  if (status.clean) {
    const current = await currentBranch(repoRoot)
    if (current === targetBranch) {
      switched = true
    } else {
      try {
        await runGit(['checkout', targetBranch], { cwd: repoRoot })
        switched = true
      } catch (error) {
        notes.push(`could not switch the repository to "${targetBranch}": ${error.message}`)
      }
    }
  } else {
    notes.push(`the repository has ${status.entries.length} uncommitted change(s), so it was NOT switched to "${targetBranch}" — switch manually when you are ready`)
  }

  // ⑥ 最后落补丁。此刻主仓库正好停在补丁的基线（工作树的 HEAD）上，所以能干净应用。
  let carriedStaged = 0
  if (stagedPatch.diff) {
    try {
      await applyStagedDiff({ repo: repoRoot, diff: stagedPatch.diff, files: stagedPatch.files })
      carriedStaged = stagedPatch.files
    } catch (error) {
      // 补丁没落上不是「成果丢了」——提交已经在分支上。如实报告并把补丁带回去。
      notes.push(`the staged changes could NOT be applied: ${error.message}`)
      return {
        repoRoot,
        worktreePath: wtPath,
        sourceBranch,
        targetBranch,
        commit: wtCommit,
        carriedStaged: 0,
        stagedPatchUnapplied: stagedPatch.diff,
        switched,
        removed,
        notes,
      }
    }
  }

  return {
    repoRoot,
    worktreePath: wtPath,
    sourceBranch,
    targetBranch,
    commit: wtCommit,
    carriedStaged,
    switched,
    removed,
    notes,
  }
}

/**
 * 删除一个工作树。
 *
 * `ignoreStaged` 是给 `checkoutWorktree(carryStaged: true)` 用的：那条路径已经把暂存区
 * 搬到主仓库了，所以暂存的改动不再「会丢」。真正会丢的未暂存/未跟踪改动**永远**要拦
 * （除非 force）——那些删掉是真的没了。
 */
export async function removeWorktree({ repo, worktreePath, force = false, ignoreStaged = false } = {}) {
  const repoRoot = await resolveRepoRoot(repo)
  // 目录已经不在（有人手动删了，或上一次已经回收过）：这是幂等的「已经不在」，
  // 不是失败。先判这里，否则下一步的 git status 会以一个 ENOENT 报出来，
  // 让人以为出了别的问题。
  if (!(await pathExists(worktreePath))) {
    try {
      await runGit(['worktree', 'prune'], { cwd: repoRoot })
    } catch { /* prune 失败无所谓，登记记录留着也不影响 */ }
    return { removed: false, reason: 'already-gone' }
  }
  const status = await worktreeStatus(worktreePath)
  const classified = classifyWorktreeStatus(status.entries)
  const atRisk = ignoreStaged ? classified.atRiskWithCarry : classified.atRiskWithoutCarry
  if (atRisk > 0 && !force) {
    throw new WorktreeError(
      'WORKTREE_DIRTY',
      `${worktreePath} has uncommitted work that would be destroyed (${classified.describe()}); commit or discard it first, or pass force to destroy it`,
      { entries: status.entries.slice(0, 20), staged: classified.staged.length, unstaged: classified.unstaged.length, untracked: classified.untracked.length },
    )
  }
  // git 自己也会因为「工作区不干净」拒绝删除。当 ignoreStaged 成立、且我们刚刚核对过
  // **剩下的脏东西只有已搬运的暂存内容**时，用 git 层的 --force 完成删除是安全的：
  // 我们的分类比 git 那刀更细（它不分暂存与否），安全性由上面那一步负责。
  const leftoverIsOnlyCarriedStaged = ignoreStaged
    && classified.atRiskWithCarry === 0
    && classified.staged.length > 0
  const args = ['worktree', 'remove']
  if (force || leftoverIsOnlyCarriedStaged) args.push('--force')
  args.push(worktreePath)
  try {
    await runGit(args, { cwd: repoRoot })
  } catch (error) {
    if (isMissingWorktreeError(error)) return { removed: false, reason: 'already-gone' }
    throw error
  }
  return { removed: true }
}

export async function pathExists(target) {
  const fs = await import('node:fs/promises')
  try {
    await fs.access(target)
    return true
  } catch {
    return false
  }
}

/** 跨平台的路径比较：大小写与分隔符都不参与（Windows 上两者都会变）。 */
export function samePath(a, b) {
  const norm = value => String(value || '')
    .replace(/[\\/]+/g, '/')
    .replace(/\/+$/, '')
    .toLowerCase()
  return norm(a) === norm(b)
}

export function worktreeErrorPayload(error, extra = {}) {
  return {
    ok: false,
    code: error?.code || 'WORKTREE_FAILED',
    error: error?.message || String(error),
    ...(error?.detail ? { detail: error.detail } : {}),
    ...extra,
  }
}
