import path from 'path'
import { spawn } from 'child_process'
import { paths } from '../../paths.js'
import { loadSkills, refreshSkills } from '../../skills/registry.js'
import { execManageReminder } from '../../capabilities/tools/reminders.js'
import { getDB, listPendingReminders } from '../../db.js'
import { jsonResponse, readJsonBody } from '../utils.js'

function error(res, status, message) {
  jsonResponse(res, status, { ok: false, error: String(message || 'request failed') })
}

// 2026-09-25 动真格：会话改名/删除的持久化表（幂等建表，请求时懒加载）。
// session_key 与前端 loadRealSessions 的会话 id 对齐：'ch-<渠道组>-<YYYY-MM-DD>'（LOCAL=TUI+API 合并组）。
function ensureSessionMetaTable() {
  getDB().exec(`CREATE TABLE IF NOT EXISTS workspace_session_meta (
    session_key TEXT PRIMARY KEY,
    title TEXT NOT NULL DEFAULT '',
    updated_at INTEGER NOT NULL DEFAULT 0
  )`)
}

/**
 * 是否是**真实存在**的日历日（不只是格式对）。
 * 原来只校验 /^\d{4}-\d{2}-\d{2}$/，于是 9999-99-99 这种不存在的日期能通过校验，
 * 然后删 0 行并静默成功——用户打错日期时看到的是一次「正常的删除」。
 * 同时拒绝将来的日期：那不是笔误就是误操作，不该删掉任何东西。
 */
function isRealCalendarDate(value) {
  const text = String(value || '').trim()
  if (!/^\d{4}-\d{2}-\d{2}$/.test(text)) return false
  const parsed = new Date(`${text}T00:00:00Z`)
  if (Number.isNaN(parsed.getTime())) return false
  // round-trip：2026-02-30 会被 Date 归一成 3 月 2 日，回写就不相等了
  if (parsed.toISOString().slice(0, 10) !== text) return false
  // 允许「今天」（提交时可能刚过零点），但不允许明天及以后
  const today = new Date()
  const todayKey = new Date(Date.UTC(today.getFullYear(), today.getMonth(), today.getDate())).toISOString().slice(0, 10)
  return text <= todayKey
}

export async function handleWorkspaceRoutes(req, res, url) {
  if (req.method === 'GET' && url.pathname === '/workspace/skills') {
    const skills = loadSkills().map(({ body, raw, filePath, ...skill }) => skill)
    jsonResponse(res, 200, { ok: true, skills })
    return true
  }

  if (req.method === 'POST' && url.pathname === '/workspace/skills/refresh') {
    const skills = refreshSkills().map(({ body, raw, filePath, ...skill }) => skill)
    jsonResponse(res, 200, { ok: true, skills })
    return true
  }
  if (req.method === 'POST' && url.pathname === '/workspace/skills/open') {
    // 2026-09-25 新增：浮框技能页「打开目录」真实打开技能所在目录（资源管理器）
    try {
      const body = await readJsonBody(req, { maxBytes: 16 * 1024 })
      const roots = {
        bundled: paths.bundledSkillsDir,
        sandbox: paths.sandboxSkillsDir,
        user: paths.skillsDir,
      }
      let dir = ''
      const rootKey = body.root ? String(body.root) : ''
      if (rootKey && Object.prototype.hasOwnProperty.call(roots, rootKey)) {
        dir = path.resolve(roots[rootKey])
      } else {
        const id = String(body.id || '').trim()
        const skill = id ? loadSkills().find(s => s.id === id) : null
        if (!skill) { error(res, 404, 'skill not found: ' + (id || '(missing id)')); return true }
        dir = path.resolve(skill.dir)
      }
      const allowed = Object.values(roots).map(root => path.resolve(root))
      if (!allowed.some(root => dir === root || dir.startsWith(root + path.sep))) {
        error(res, 400, 'directory outside skills roots')
        return true
      }
      spawn('explorer.exe', [dir], { detached: true, stdio: 'ignore' }).unref()
      jsonResponse(res, 200, { ok: true, dir })
    } catch (err) {
      error(res, 400, err.message)
    }
    return true
  }

  if (req.method === 'GET' && url.pathname === '/workspace/conversations') {
    // 2026-09-25 新增：浮框工作区会话列表的真实数据源（本体 conversations 表）。
    // 路径必须带 /workspace 前缀：顶层 /conversations 已被 memory.js 既有路由占用（返回裸数组、先匹配），
    // 若不加前缀本路由永远不会生效（2026-09-25 实测踩坑：curl /conversations 返回的是 memory.js 的形状）。
    // workspace-embed.html 的 loadRealSessions() 按 渠道×自然日 聚合出会话条目。
    const limit = Math.min(Math.max(Number(url.searchParams.get('limit') || 300) || 300, 1), 1000)
    const rows = getDB().prepare(
      `SELECT role, from_id, to_id, content, channel, timestamp, open_question, thread_id
       FROM conversations ORDER BY id DESC LIMIT ?`
    ).all(limit).reverse()
    // 2026-09-25 动真格：附带会话自定义名（workspace_session_meta），前端 loadRealSessions 优先用它做标题
    let sessionMeta = {}
    try {
      ensureSessionMetaTable()
      const metaRows = getDB().prepare('SELECT session_key, title FROM workspace_session_meta').all()
      sessionMeta = Object.fromEntries(metaRows.map(m => [m.session_key, { title: m.title }]))
    } catch { /* meta 表不可用时退回默认标题 */ }
    jsonResponse(res, 200, { ok: true, conversations: rows, sessionMeta })
    return true
  }

  if (req.method === 'POST' && url.pathname === '/workspace/sessions/open') {    // 2026-09-25 新增：打开会话存储目录（jarvis.db 所在 data 目录），与技能页「打开目录」对齐。
    try {
      const dir = path.resolve(paths.dataDir)
      spawn('explorer.exe', [dir], { detached: true, stdio: 'ignore' }).unref()
      jsonResponse(res, 200, { ok: true, dir })
    } catch (err) {
      error(res, 400, err.message)
    }
    return true
  }

  if (req.method === 'POST' && url.pathname === '/workspace/sessions/rename') {
    // 2026-09-25 动真格：会话重命名落库（workspace_session_meta），重启后仍生效。
    try {
      const body = await readJsonBody(req, { maxBytes: 16 * 1024 })
      const id = String(body.id || '').trim()
      const title = String(body.title || '').trim().slice(0, 120)
      if (!id) { error(res, 400, 'missing session id'); return true }
      if (!title) { error(res, 400, 'title cannot be empty'); return true }
      ensureSessionMetaTable()
      getDB().prepare(
        `INSERT OR REPLACE INTO workspace_session_meta (session_key, title, updated_at) VALUES (?, ?, ?)`
      ).run(id, title, Date.now())
      jsonResponse(res, 200, { ok: true, id, title })
    } catch (err) {
      error(res, 400, err.message)
    }
    return true
  }

  if (req.method === 'POST' && url.pathname === '/workspace/sessions/delete') {
    // 2026-09-25 动真格：删除会话 = 直接删 conversations 表中该 渠道×自然日 的消息行。
    // 实测 timestamp 为本地带偏移 ISO（如 2026-09-25T20:07:28+08:00），
    // substr(timestamp,1,10) 即本地自然日，与前端 dayKey 一致；LOCAL 组 = TUI+API 两渠道。
    try {
      const body = await readJsonBody(req, { maxBytes: 16 * 1024 })
      const id = String(body.id || '').trim()
      const channel = String(body.channel || '').trim().toUpperCase()
      const date = String(body.date || '').trim()
      if (!id || !channel || !isRealCalendarDate(date)) {
        error(res, 400, 'missing/invalid session params')
        return true
      }
      const channels = channel === 'LOCAL' ? ['TUI', 'API'] : [channel]
      const placeholders = channels.map(() => '?').join(',')
      const db = getDB()
      const info = db.prepare(
        `DELETE FROM conversations WHERE channel IN (${placeholders}) AND substr(timestamp, 1, 10) = ?`
      ).run(...channels, date)
      // **只在真的删掉了消息行时才动会话元数据。**
      // 原来这里是无条件删：日期打错时（比如 9999-99-99）消息一行没删，
      // 但用户改过的会话标题被静默抹掉——响应还是 {ok:true,deleted:0}，看起来无害，
      // 数据却丢了。没有匹配到会话时不该顺手清掉它的标题。
      let metaCleared = false
      if (info.changes > 0) {
        ensureSessionMetaTable()
        db.prepare(`DELETE FROM workspace_session_meta WHERE session_key = ?`).run(id)
        metaCleared = true
      }
      jsonResponse(res, 200, {
        ok: true,
        id,
        deleted: info.changes,
        // 没匹配到会话时把话说清楚：deleted:0 是「什么都没删」，不是「删干净了」
        ...(info.changes === 0 ? { matched: false, note: 'no conversations matched this channel+date; nothing (including the session title) was removed' } : { matched: true, meta_cleared: metaCleared }),
      })
    } catch (err) {
      error(res, 400, err.message)
    }
    return true
  }

  if (req.method === 'GET' && url.pathname === '/workspace/reminders') {
    jsonResponse(res, 200, { ok: true, reminders: listPendingReminders(100) })
    return true
  }

  if (req.method === 'POST' && url.pathname === '/workspace/reminders') {
    try {
      const body = await readJsonBody(req, { maxBytes: 64 * 1024 })
      const text = await execManageReminder({ ...body, action: 'create' }, {
        visibleTargetIds: [String(body.target_id || 'ID:000001')],
        allowedTargetIds: [String(body.target_id || 'ID:000001')],
      })
      if (String(text).startsWith('错误')) return error(res, 400, text)
      jsonResponse(res, 200, { ok: true, message: text, reminders: listPendingReminders(100) })
    } catch (err) {
      error(res, 400, err.message)
    }
    return true
  }

  if (req.method === 'DELETE' && url.pathname.startsWith('/workspace/reminders/')) {
    const id = Number(url.pathname.slice('/workspace/reminders/'.length))
    if (!Number.isInteger(id) || id <= 0) return error(res, 400, 'invalid reminder id')
    try {
      const text = await execManageReminder({ action: 'cancel', id })
      if (String(text).startsWith('错误')) return error(res, 400, text)
      jsonResponse(res, 200, { ok: true, message: text, reminders: listPendingReminders(100) })
    } catch (err) {
      error(res, 400, err.message)
    }
    return true
  }

  return false
}
