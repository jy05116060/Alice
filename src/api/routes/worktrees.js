import { jsonResponse, readRawBody, decodeRequestBody } from '../utils.js'
import { buildWorktreeBoard, execCheckoutWorktree } from '../../capabilities/tools/worktree.js'
import { closeWorktreeRecord, getOpenWorktreeByPath } from '../../runtime/worktree-store.js'
import { pathExists } from '../../runtime/worktree.js'

// 工作树（隔离区）面板的数据接口（阶段 5 有后端能力，这一步补界面）。
//   GET  /worktrees          —— 目录：开着的隔离区 + **服务端算好的**展示字段
//   POST /worktrees/reclaim  —— 回收：把成果并回本地仓库并删除隔离目录
//   POST /worktrees/forget   —— 清理登记：目录已经不在了的死记录
//
// 为什么展示字段在服务端算：面板跑在浏览器里，**import 不到 src/runtime/**
// （那是主进程代码）。「脏不脏 / 能不能回收 / 回收后会不会切分支」只能由这里算好下发。
// 而这份口径**只有一份**——`buildWorktreeBoard()`（工具层），它内部用的又是
// runtime 的 `classifyWorktreeStatus`。面板不重写规则：两份规则迟早对不上，
// 而「这条回收会不会毁掉用户的东西」是最不能对不上的东西。
//
// 动作端点复用工具层的 `execCheckoutWorktree`（就像 schedules.js 复用 execManageReminder）：
// 校验顺序（先查脏再动手）、分支创建、暂存区搬运、拒绝回收的守卫全都在那一条路径上。
// 路由只负责 HTTP 形状与错误码，**不重写业务逻辑**。
export async function handleWorktreeRoutes(req, res, url) {
  if (req.method === 'GET' && url.pathname === '/worktrees') {
    const board = await buildWorktreeBoard()
    jsonResponse(res, 200, { ok: true, count: board.open.length, worktrees: board.open })
    return true
  }

  if (req.method === 'POST' && url.pathname === '/worktrees/reclaim') {
    const { body, error } = await readJsonBody(req)
    if (error) {
      jsonResponse(res, 400, { ok: false, code: 'BAD_BODY', error })
      return true
    }
    const target = typeof body.path === 'string' ? body.path.trim() : ''
    if (!target) {
      jsonResponse(res, 400, { ok: false, code: 'WORKTREE_REQUIRED', error: 'path is required' })
      return true
    }
    const entry = getOpenWorktreeByPath(target)
    if (!entry) {
      jsonResponse(res, 404, {
        ok: false,
        code: 'WORKTREE_NOT_REGISTERED',
        error: `${target} is not a registered open worktree of this app`,
      })
      return true
    }

    let payload
    try {
      // 工具层对坏输入是**返回** ok:false 的 JSON（不是 throw）；解析失败才是真故障。
      payload = JSON.parse(await execCheckoutWorktree({
        repo: entry.repoRoot,
        worktree_path: target,
        branch_name: typeof body.branch_name === 'string' ? body.branch_name : undefined,
        carry_staged: body.carry_staged === true,
        force: body.force === true,
      }, { cwd: entry.repoRoot }))
    } catch (failure) {
      jsonResponse(res, 500, {
        ok: false,
        code: failure?.code || 'RECLAIM_FAILED',
        error: failure?.message || String(failure),
      })
      return true
    }

    const board = await buildWorktreeBoard()
    if (payload.ok === false) {
      // 如实报告，绝不回一个「看起来成功」的响应。
      // WORKTREE_DIRTY = 用户要先决定是否毁掉那点改动 → 409（冲突，不是服务器故障）；
      // 其余（工作树已不在、仓库不是仓库等）是这份请求本身不成立 → 400/404。
      const status = payload.code === 'WORKTREE_DIRTY'
        ? 409
        : payload.code === 'WORKTREE_NOT_FOUND' ? 404 : 400
      jsonResponse(res, status, { ...payload, ok: false, worktrees: board.open })
      return true
    }
    jsonResponse(res, 200, { ok: true, result: payload, worktrees: board.open })
    return true
  }

  if (req.method === 'POST' && url.pathname === '/worktrees/forget') {
    const { body, error } = await readJsonBody(req)
    if (error) {
      jsonResponse(res, 400, { ok: false, code: 'BAD_BODY', error })
      return true
    }
    const target = typeof body.path === 'string' ? body.path.trim() : ''
    if (!target) {
      jsonResponse(res, 400, { ok: false, code: 'WORKTREE_REQUIRED', error: 'path is required' })
      return true
    }
    const entry = getOpenWorktreeByPath(target)
    if (!entry) {
      jsonResponse(res, 404, {
        ok: false,
        code: 'WORKTREE_NOT_REGISTERED',
        error: `${target} is not a registered open worktree of this app`,
      })
      return true
    }
    // 只在目录**真的不在了**时才允许清理登记。否则这条记录一清，git 那边还留着一个
    // 活的工作树，用户在面板里就再也看不到它了——那是把「看不到」伪装成「不存在」。
    if (await pathExists(target)) {
      jsonResponse(res, 409, {
        ok: false,
        code: 'WORKTREE_STILL_PRESENT',
        error: `${target} still exists on disk; reclaim it instead of forgetting it`,
      })
      return true
    }
    closeWorktreeRecord(target)
    const board = await buildWorktreeBoard()
    jsonResponse(res, 200, { ok: true, forgotten: target, worktrees: board.open })
    return true
  }

  return false
}

/**
 * 读一个 JSON 对象体。
 * @returns {{body?: object, error?: string}} —— 失败时**必须**给出原因（与 schedules.js 同一份写法）。
 */
async function readJsonBody(req) {
  let raw
  try {
    raw = await readRawBody(req, { maxBytes: 256 * 1024 })
  } catch (error) {
    return { error: `could not read the request body: ${error?.message || error}` }
  }
  if (!raw || raw.length === 0) return { body: {} }
  let text
  try {
    text = decodeRequestBody(raw, req.headers?.['content-type'])
  } catch {
    text = raw.toString('utf8')
  }
  let parsed
  try {
    parsed = JSON.parse(text)
  } catch (error) {
    return { error: `invalid JSON body: ${error.message}${text.length < 200 ? ` (received: ${text})` : ''}` }
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    return { error: 'request body must be a JSON object' }
  }
  return { body: parsed }
}
