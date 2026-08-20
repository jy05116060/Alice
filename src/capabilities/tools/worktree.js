// Worktree 工具执行体（阶段 5）。
import {
  checkoutWorktree,
  createWorktree,
  listWorktrees,
  samePath,
  worktreeErrorPayload,
  worktreeStatus,
  classifyWorktreeStatus,
} from '../../runtime/worktree.js'
import {
  closeWorktreeRecord,
  listOpenWorktrees,
  recordWorktree,
  soleOpenWorktree,
} from '../../runtime/worktree-store.js'
import { emitEvent } from '../../events.js'

function resolveRepoArg(args, context) {
  const fromArgs = typeof args?.repo === 'string' ? args.repo.trim() : ''
  if (fromArgs) return fromArgs
  return context?.cwd || context?.workspaceRoot || process.cwd()
}

/**
 * 「这个工作树现在算什么状态」的**唯一**一份展示口径。
 *
 * 判断全部来自 `classifyWorktreeStatus`（runtime），这里只把它的三个计数翻译成
 * 「能不能回收 / 回收会不会丢东西 / 回收后会不会切分支」。面板不重算这些——
 * 浏览器里拿不到 runtime，第二份规则迟早和这一份对不上。
 *
 * 返回的 status_code 是稳定的机器键（面板据此选 i18n 文案与颜色），
 * status_label / reason 是人看的兜底文案。
 */
function statusDisplay(classified, { missing = false } = {}) {
  if (missing) {
    return {
      status_code: 'missing',
      status_tone: 'dim',
      status_label: '目录已不存在',
      reason_code: 'missing',
      reason: '工作树目录已经不在了：成果无法再并回，只能清掉这条登记记录。',
    }
  }
  const staged = classified.staged.length
  const unstaged = classified.unstaged.length
  const untracked = classified.untracked.length
  if (classified.atRiskWithoutCarry === 0) {
    return {
      status_code: 'clean', status_tone: 'ok', status_label: '干净，无未提交改动', reason_code: '', reason: '',
    }
  }
  // 只有已暂存的改动：这正是 carry_staged 能整批带走的那一种，所以单独给一档，
  // 而不是和「真会丢」的未暂存/未跟踪混在一起报。
  if (unstaged === 0 && untracked === 0) {
    return {
      status_code: 'staged',
      status_tone: 'warn',
      status_label: '只有已暂存的改动',
      reason_code: 'staged_only',
      reason: `有 ${staged} 处已暂存的改动：直接回收会随目录一起消失，选「带上暂存改动回收」可以带回主仓库。`,
    }
  }
  const parts = []
  if (staged) parts.push(`${staged} 处已暂存`)
  if (unstaged) parts.push(`${unstaged} 处未暂存`)
  if (untracked) parts.push(`${untracked} 个未跟踪文件`)
  return {
    status_code: 'dirty',
    status_tone: 'danger',
    status_label: '有未提交改动',
    reason_code: 'uncommitted',
    reason: `有未提交改动（${parts.join('、')}）：回收会永久删除未暂存与未跟踪的部分。`,
  }
}

/** 主仓库干净吗？同一个仓库在一次构建里只查一次（面板可能同时开着好几个工作树）。 */
async function repoIsClean(repoRoot, cache) {
  if (!repoRoot) return null
  if (cache?.has(repoRoot)) return cache.get(repoRoot)
  let clean = null
  try { clean = (await worktreeStatus(repoRoot)).clean } catch { clean = null }
  cache?.set(repoRoot, clean)
  return clean
}

async function describeOpen(entry, repoCleanCache = null) {
  const base = {
    path: entry.path,
    branch: entry.branch,
    base_branch: entry.baseBranch,
    repo_root: entry.repoRoot,
    created_at: entry.createdAt,
  }
  let status = null
  try {
    status = classifyWorktreeStatus((await worktreeStatus(entry.path)).entries)
  } catch { /* 目录可能已经被手动删了 */ }

  const missing = !status
  const classified = status || { staged: [], unstaged: [], untracked: [], atRiskWithoutCarry: 0, atRiskWithCarry: 0 }
  const display = statusDisplay(classified, { missing })
  const repoClean = missing ? null : await repoIsClean(entry.repoRoot, repoCleanCache)

  return {
    ...base,
    staged: classified.staged.length,
    unstaged: classified.unstaged.length,
    untracked: classified.untracked.length,
    clean: !missing && classified.atRiskWithoutCarry === 0 && classified.staged.length === 0,
    ...(missing ? { missing: true } : {}),
    // 未提交改动会在回收时消失（不含「已暂存且选择带走」的那种）
    dirty: !missing && classified.atRiskWithoutCarry > 0,
    // 不用 force 就能安全回收：只有全干净时成立。缺目录的那条走「清理登记」而不是回收。
    removable: !missing && classified.atRiskWithoutCarry === 0,
    // 回收后主仓库能不能切到成果分支（checkoutWorktree 只在主仓库干净时才切）
    can_checkout: !missing && repoClean === true,
    ...display,
  }
}

export async function execCreateWorktree(args = {}, context = {}) {
  const repo = resolveRepoArg(args, context)
  try {
    const created = await createWorktree({
      repo,
      branchName: args.branch_name,
      path: args.path || null,
      carryStaged: args.carry_staged === true,
    })
    recordWorktree({
      repoRoot: created.repoRoot,
      path: created.path,
      branch: created.branch,
      baseBranch: created.baseBranch,
      baseCommit: created.baseCommit,
    })
    emitEvent('worktree_created', {
      path: created.path,
      branch: created.branch,
      base_branch: created.baseBranch,
      carried_staged: created.carriedStaged,
    })
    return JSON.stringify({
      ok: true,
      path: created.path,
      branch: created.branch,
      base_branch: created.baseBranch,
      base_commit: created.baseCommit,
      carried_staged: created.carriedStaged,
      note: [
        `Isolated worktree ready at ${created.path} on branch ${created.branch}.`,
        'Use that path as the working directory for the shell and file calls that belong to this work.',
        'The main working tree was not touched. When the work is committed, call checkout_worktree to bring it back and reclaim the directory.',
        created.carriedStaged > 0
          ? `Carried ${created.carriedStaged} staged change(s) in; unstaged and untracked files stayed in the original repository.`
          : '',
      ].filter(Boolean).join(' '),
    })
  } catch (error) {
    emitEvent('worktree_failed', { action: 'create', code: error?.code || null, error: error?.message || String(error) })
    return JSON.stringify(worktreeErrorPayload(error, { repo }))
  }
}

export async function execCheckoutWorktree(args = {}, context = {}) {
  const repo = resolveRepoArg(args, context)
  try {
    let target = typeof args.worktree_path === 'string' ? args.worktree_path.trim() : ''
    if (!target) {
      // 只在自己登记过、且**唯一**时才自动选。多个还替模型猜，猜错就回收错隔离区。
      const sole = soleOpenWorktree()
      if (!sole) {
        const open = listOpenWorktrees()
        if (open.length === 0) {
          // 登记记录可能被清过（换机、手动删库），退一步问 git 自己
          const live = (await listWorktrees(repo)).filter(w => !samePath(w.path, repo))
          if (live.length === 1) target = live[0].path
          else {
            return JSON.stringify({
              ok: false,
              code: 'WORKTREE_REQUIRED',
              error: live.length === 0
                ? 'there is no open worktree to bring back'
                : `there are ${live.length} worktrees and no record of which one is yours; pass worktree_path explicitly`,
              worktrees: live.map(w => ({ path: w.path, branch: w.branch })),
            })
          }
        } else {
          return JSON.stringify({
            ok: false,
            code: 'WORKTREE_AMBIGUOUS',
            error: `there are ${open.length} open worktrees; pass worktree_path to choose one`,
            worktrees: open.map(entry => ({ path: entry.path, branch: entry.branch })),
          })
        }
      } else {
        target = sole.path
      }
    }

    const result = await checkoutWorktree({
      repo,
      worktreePath: target,
      branchName: args.branch_name || null,
      carryStaged: args.carry_staged === true,
      force: args.force === true,
    })
    closeWorktreeRecord(result.worktreePath)
    emitEvent('worktree_closed', {
      path: result.worktreePath,
      branch: result.targetBranch,
      commit: result.commit,
      carried_staged: result.carriedStaged,
      switched: result.switched,
    })
    return JSON.stringify({
      ok: true,
      path: result.worktreePath,
      branch: result.targetBranch,
      commit: result.commit,
      carried_staged: result.carriedStaged,
      switched: result.switched,
      removed: result.removed,
      notes: result.notes,
      ...(result.stagedPatchUnapplied
        ? { staged_patch_unapplied: result.stagedPatchUnapplied }
        : {}),
      summary: [
        `Local branch ${result.targetBranch} now points at the worktree's commits.`,
        result.switched
          ? 'The repository was switched to it.'
          : 'The repository was NOT switched to it (see notes).',
        result.carriedStaged > 0 ? `Carried ${result.carriedStaged} staged change(s) back.` : '',
        result.removed?.removed ? 'The isolated worktree was removed.' : '',
        ...(result.notes || []),
      ].filter(Boolean).join(' '),
    })
  } catch (error) {
    emitEvent('worktree_failed', { action: 'checkout', code: error?.code || null, error: error?.message || String(error) })
    return JSON.stringify(worktreeErrorPayload(error, { repo }))
  }
}

/** 给面板/诊断用：登记 + 实际状态（两边不一致时以实际状态为准并标出来）。 */
export async function execListWorktrees(args = {}, context = {}) {
  const repo = resolveRepoArg(args, context)
  const open = listOpenWorktrees()
  const described = await Promise.all(open.map(entry => describeOpen(entry, new Map())))
  let live = []
  try {
    live = (await listWorktrees(repo)).filter(w => !samePath(w.path, repo))
  } catch { /* 不是仓库也不该让这个查询失败 */ }
  return JSON.stringify({
    ok: true,
    open: described,
    live: live.map(w => ({ path: w.path, branch: w.branch })),
  })
}

/** 面板用的汇总（也供 REST 复用，避免两处各写一份口径）。 */
export async function buildWorktreeBoard({ repo = null } = {}) {
  const open = repo ? listOpenWorktrees({ repoRoot: repo }) : listOpenWorktrees()
  // 同一仓库只查一次主工作区状态：面板一次要画好几行，逐行各查一遍是白费
  const repoCleanCache = new Map()
  const rows = []
  for (const entry of open) rows.push(await describeOpen(entry, repoCleanCache))
  return { open: rows }
}
