// 会话归档的 HTTP 端点（阶段 7）。
//
// 路径与错误串逐字对齐 DSH 的 dsh-tauri-archive 路由契约：
//   GET    /session/archive              → { archivedSessionIds, meta }
//   POST   /session/archive              { sessionId }  归档
//   DELETE /session/archive              { sessionId }  永久删除
//   POST   /session/archive/restore      { sessionId }  取消归档
//   POST   /session/archive/clear                       清空
//   DELETE /session/archive/clear                       清空
//   POST   /session/workspace/archive    { sessionIds } 批量归档
//   DELETE /session/workspace/archive    { sessionIds } 批量删除
//   POST   /session/open/path            { sessionId }  在文件管理器打开会话目录
//
// 错误响应（一字不差）：
//   缺 sessionId → 400 { ok:false, error:"invalid-session-id" }
//   缺 sessionIds → 400 { ok:false, error:"invalid-session-ids" }
//   目录不存在   → 400 { ok:false, error:"session-directory-not-found" }
import { jsonResponse, readJsonBody } from '../utils.js'
import { openPathNatively } from '../../runtime/native-open.js'
import {
  archiveSession,
  archiveWorkspaceSessions,
  deleteAllArchived,
  loadArchiveLedger,
  openSessionDir,
  permanentlyDeleteArchived,
  unarchiveSession,
} from '../../runtime/session-archive.js'

const BODY_LIMIT = 256 * 1024

function fail(res, status, error) {
  jsonResponse(res, status, { ok: false, error })
}

/** 契约要求：body.sessionId 必须是字符串且非空，否则 400 invalid-session-id。 */
function readSessionId(body) {
  return typeof body?.sessionId === 'string' ? body.sessionId : ''
}

/** 契约要求：body.sessionIds 必须是数组，逐项 String 且过滤空值；全空则 400 invalid-session-ids。 */
function readSessionIds(body) {
  return Array.isArray(body?.sessionIds) ? body.sessionIds.map(String).filter(Boolean) : []
}

async function readBodySafe(req) {
  try {
    return await readJsonBody(req, { maxBytes: BODY_LIMIT })
  } catch {
    return {}
  }
}

export async function handleSessionArchiveRoutes(req, res, url, context = {}) {
  const { pathname } = url
  if (!pathname.startsWith('/session/')) return false

  const openImpl = context.openSessionDirImpl || ((dir) => openPathNatively(dir))

  if (req.method === 'GET' && pathname === '/session/archive') {
    jsonResponse(res, 200, await loadArchiveLedger())
    return true
  }

  if (req.method === 'POST' && pathname === '/session/archive') {
    const body = await readBodySafe(req)
    const sessionId = readSessionId(body)
    if (sessionId.length === 0) return fail(res, 400, 'invalid-session-id'), true
    try {
      jsonResponse(res, 200, await archiveSession(sessionId))
    } catch (err) {
      fail(res, 400, err?.message || 'archive-failed')
    }
    return true
  }

  if (req.method === 'DELETE' && pathname === '/session/archive') {
    const body = await readBodySafe(req)
    const sessionId = readSessionId(body)
    if (sessionId.length === 0) return fail(res, 400, 'invalid-session-id'), true
    try {
      jsonResponse(res, 200, await permanentlyDeleteArchived([sessionId]))
    } catch (err) {
      fail(res, 400, err?.message || 'delete-failed')
    }
    return true
  }

  if (req.method === 'POST' && pathname === '/session/archive/restore') {
    const body = await readBodySafe(req)
    const sessionId = readSessionId(body)
    if (sessionId.length === 0) return fail(res, 400, 'invalid-session-id'), true
    try {
      jsonResponse(res, 200, await unarchiveSession(sessionId))
    } catch (err) {
      fail(res, 400, err?.message || 'restore-failed')
    }
    return true
  }

  if ((req.method === 'POST' || req.method === 'DELETE') && pathname === '/session/archive/clear') {
    try {
      jsonResponse(res, 200, await deleteAllArchived())
    } catch (err) {
      fail(res, 400, err?.message || 'clear-failed')
    }
    return true
  }

  if (req.method === 'POST' && pathname === '/session/workspace/archive') {
    const body = await readBodySafe(req)
    const sessionIds = readSessionIds(body)
    if (sessionIds.length === 0) return fail(res, 400, 'invalid-session-ids'), true
    try {
      jsonResponse(res, 200, await archiveWorkspaceSessions(sessionIds))
    } catch (err) {
      fail(res, 400, err?.message || 'archive-failed')
    }
    return true
  }

  if (req.method === 'DELETE' && pathname === '/session/workspace/archive') {
    const body = await readBodySafe(req)
    const sessionIds = readSessionIds(body)
    if (sessionIds.length === 0) return fail(res, 400, 'invalid-session-ids'), true
    try {
      jsonResponse(res, 200, await permanentlyDeleteArchived(sessionIds))
    } catch (err) {
      fail(res, 400, err?.message || 'delete-failed')
    }
    return true
  }

  if (req.method === 'POST' && pathname === '/session/open/path') {
    const body = await readBodySafe(req)
    const sessionId = readSessionId(body)
    if (sessionId.length === 0) return fail(res, 400, 'invalid-session-id'), true
    const result = await openSessionDir(sessionId, { openImpl })
    if (!result.ok) {
      jsonResponse(res, 400, { ok: false, error: result.error })
      return true
    }
    jsonResponse(res, 200, { ok: true, dir: result.dir })
    return true
  }

  return false
}
