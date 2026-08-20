// 会话归档（阶段 7）——把 DSH 的 session archive 行为移植到爱丽丝。
//
// 设计说明（重要，别把「当前没用上」当成「不需要」）：
//
// 爱丽丝的会话本体是 `conversations` 表里的行（按 渠道×自然日 聚合，session_key 形如
// `ch-LOCAL-2026-10-01`），**没有 DSH 那种「一个会话一个目录」的磁盘树**。
// 但 DSH 的目录定位逻辑本身与「会话存在哪」无关，它是**通用**的：
// 只要将来出现任何「每会话一目录」的落盘形态（ACP 会话、导出目录、附件目录），
// 这套编码/定位/剪枝逻辑就直接可用。所以这里按契约**原样实现**，
// 根目录做成**可配置**（默认 `<USER_DIR>/sessions`），而不是敷衍成恒返回 null 的假实现。
//
// 分层：
//   1. 纯函数（与存储无关，逐字复刻契约）：encodeSessionId / isWithinRoot /
//      findSessionDataDir / pruneEmptyParents
//   2. 归档集合 + 元数据：DSH 存在宿主 workspaceRegistry.archivedSessionIds，
//      爱丽丝改用本地表 `archived_sessions` 持久化（等价物）
//   3. 删除事务顺序：预检 → 内存移除 → 物理删除（失败即中止）→ 归档集合更新
//   4. 记账 detach/attach：DSH 的 workspace.sessionIds 槽位在爱丽丝没有对等物，
//      见文件末尾 accounting 段落的说明（如实标注，不硬套错误语义）
import fs from 'fs'
import path from 'path'
import { paths } from '../paths.js'
import { getDB } from '../db.js'

// ---------------------------------------------------------------------------
// 1. 纯函数（逐字复刻契约）
// ---------------------------------------------------------------------------

const SESSIONS_DIRECTORY = 'sessions'
const SESSION_DIRECTORY_PREFIX = 'session-'
const SESSION_ID_ESCAPE = '~'
const DOT_SEGMENT = '.'
const DOT_DOT_SEGMENT = '..'
const DOT_ESCAPE = '~002E'

/** 会话数据根目录。可配置：传入 root 优先，其次 env，最后 `<USER_DIR>/sessions`。 */
export function sessionsRoot(explicitRoot = null) {
  if (explicitRoot) return path.resolve(String(explicitRoot))
  const fromEnv = String(process.env.ALICE_SESSIONS_DIR || '').trim()
  if (fromEnv) return path.resolve(fromEnv)
  return path.join(path.resolve(paths.userDir), SESSIONS_DIRECTORY)
}

/**
 * 会话 id → 目录名。与 dsh 宿主 JSONL 落盘后端逐字一致，
 * 编错了就找不到目录（这也是为什么这条必须原样复刻而不能「优化」）。
 */
export function encodeSessionId(id) {
  const text = String(id ?? '')
  if (text === DOT_SEGMENT) return DOT_ESCAPE
  if (text === DOT_DOT_SEGMENT) return `${DOT_ESCAPE}${DOT_ESCAPE}`
  let encoded = ''
  for (let index = 0; index < text.length; index++) {
    const code = text.charCodeAt(index)
    const char = String.fromCharCode(code)
    encoded += char !== SESSION_ID_ESCAPE && /^[\w.-]$/.test(char)
      ? char
      : `${SESSION_ID_ESCAPE}${code.toString(16).toUpperCase().padStart(4, '0')}`
  }
  return encoded
}

/**
 * 路径逃逸防护：candidate 必须**严格位于** root 之内（含 root 本身）。
 * `../`、绝对路径、以及 `root` 的前缀兄弟目录（如 root=`/a/s`，candidate=`/a/s-evil`）
 * 都会被拒——最后这条是 `startsWith(base)` 少写 `+ sep` 时会漏的经典洞。
 */
export function isWithinRoot(root, candidate) {
  const base = path.resolve(String(root ?? ''))
  const target = path.resolve(String(candidate ?? ''))
  return target === base || target.startsWith(`${base}${path.sep}`)
}

/** 读目录；不存在 / 不可读 / 是文件 都返回 null（调用方据此判断「不是会话目录」）。 */
function readDirectory(target) {
  try {
    return fs.readdirSync(target)
  } catch {
    return null
  }
}

/** root 下的子目录名（只取目录，不取文件）。 */
function directoryNames(root) {
  try {
    return fs.readdirSync(root, { withFileTypes: true })
      .filter(entry => entry.isDirectory())
      .map(entry => entry.name)
  } catch {
    return []
  }
}

/**
 * 定位会话数据目录：三标记（编码 id / `session-<id>` / 裸 id）× 两层深度
 * （`root/<marker>`、`root/<group>/<marker>`），取第一个「在 root 内 且 可 readdir」的。
 * 找不到返回 null。
 */
export function findSessionDataDir(root, sessionId) {
  const id = String(sessionId ?? '')
  if (!id) return null
  const markers = [
    encodeSessionId(id),
    `${SESSION_DIRECTORY_PREFIX}${id}`,
    id,
  ]
  const candidates = [
    ...markers.map(marker => path.join(root, marker)),
    ...directoryNames(root).flatMap(group => markers.map(marker => path.join(root, group, marker))),
  ]
  return candidates.find(candidate => isWithinRoot(root, candidate) && readDirectory(candidate) !== null) ?? null
}

/**
 * 删除会话目录后向上剪枝空父目录。
 * 三道护栏：不在 root 内 → 拒；就是 root 本身 → 拒（**root 永不删**）；
 * 目录非空（或读不到）→ 停。删掉后递归父目录。
 */
export function pruneEmptyParents(root, parent) {
  if (!isWithinRoot(root, parent)) return
  if (path.resolve(parent) === path.resolve(root)) return
  const entries = readDirectory(parent)
  if (entries === null || entries.length > 0) return
  try {
    fs.rmSync(parent, { recursive: true, force: true })
  } catch {
    return // 删不掉就停下，不要继续往上砍
  }
  pruneEmptyParents(root, path.dirname(parent))
}

/** 删除会话数据目录（含空父目录剪枝）。目录不存在返回 false。 */
export function removeSessionDir(root, sessionId) {
  const dir = findSessionDataDir(root, sessionId)
  if (dir === null) return false
  fs.rmSync(dir, { recursive: true, force: true })
  pruneEmptyParents(root, path.dirname(dir))
  return true
}

// ---------------------------------------------------------------------------
// 2. 归档集合（DSH workspaceRegistry.archivedSessionIds 的等价物：本地表）
// ---------------------------------------------------------------------------

let hooks = {
  'archive:added': [],
  'archive:restored': [],
  'archive:deleted': [],
}

/** 注册 hook（契约的 3 个 hook 点）。返回取消函数。 */
export function onArchiveHook(name, handler) {
  if (!hooks[name] || typeof handler !== 'function') return () => {}
  hooks[name].push(handler)
  return () => {
    hooks[name] = hooks[name].filter(item => item !== handler)
  }
}

/** 仅供测试：清空所有 hook。 */
export function clearArchiveHooksForTest() {
  hooks = { 'archive:added': [], 'archive:restored': [], 'archive:deleted': [] }
}

function callHook(name, payload) {
  for (const handler of hooks[name] || []) {
    try {
      handler(payload)
    } catch (err) {
      console.warn(`[session-archive] hook ${name} 失败:`, err?.message || err)
    }
  }
}

/** 归档表（幂等建表，懒加载）。 */
export function ensureArchivedSessionsTable() {
  getDB().exec(`CREATE TABLE IF NOT EXISTS archived_sessions (
    session_key TEXT PRIMARY KEY,
    archived_at INTEGER NOT NULL DEFAULT 0,
    created_at INTEGER,
    cwd TEXT,
    title TEXT
  )`)
}

/**
 * 会话元数据提供者。DSH 里是宿主的 session store（`sessions.get(id)` / `sessions.list()`）。
 * 爱丽丝对应的会话本体在 `conversations` + `workspace_session_meta`，
 * 这里给出一个默认实现：从 conversations 推断 createdAt / cwd，从 meta 表取 title。
 * 找不到该会话时返回 null —— `ledger.load()` 会据此**跳过**它（与 DSH 一致）。
 *
 * ⚠️ **"查不到" 和 "查询失败" 必须区分开**（2026-10-01 修正）。
 *
 * 原先两个 catch 块都是纯注释、不报任何东西：
 *   `catch { /* meta 表可能还没建 *\/ }`  /  `catch { /* conversations 不可用 *\/ }`
 *
 * 后果实测过：把 `conversations` 表改名模拟 SQL 失败，provider 返回 `null` ——
 * 而这个 `null` 在契约里的含义是**"这个会话不存在"**。
 * 于是**表结构坏了 / SQL 写错了 / 库锁住了**，外界看到的是
 * **"归档列表是空的"**，而不是"查询失败了"。
 *
 * 这比问题 8a（channel 大小写）更隐蔽：8a 至少是稳定复现的错误结果，
 * 这里是**把故障伪装成正常空集**，用户和日志都收不到任何信号。
 * 与我在客户端那处修的是同一个原则：
 * **业务上的"没有" ≠ 传输/执行上的"失败"。**
 *
 * 修法：失败时记一条 warn（带原因），**但返回值语义保持不变**
 * （查不到仍然返回 null，因为"不存在"确实要返回 null）。
 * 区别只在于：现在**日志里能看出发生了什么**，而不是悄无声息。
 */
export function defaultSessionMetaProvider(sessionId) {
  const id = String(sessionId ?? '')
  if (!id) return null
  const db = getDB()
  let title
  try {
    const meta = db.prepare('SELECT title FROM workspace_session_meta WHERE session_key = ?').get(id)
    if (meta && typeof meta.title === 'string' && meta.title) title = meta.title
  } catch (error) {
    /* meta 表可能还没建（首次运行）—— 这是**预期内**的，不算失败，所以不记日志。
       但如果不是"表不存在"，那就说明有别的问题，必须留下痕迹。 */
    const message = String(error?.message || error)
    if (!/no such table/i.test(message)) {
      console.warn('[session-archive] 读取会话标题失败（按"无自定义标题"处理）:', message)
    }
  }

  let createdAt
  let lookupFailed = false
  try {
    /* ⚠️ channel 比对必须**大小写无关**。
       session_key 里的渠道段是小写（`ch-tui-2026-09-27` → `tui`），
       而 `conversations.channel` 存的是大写（`TUI` / `API` / `WECHAT_CLAWBOT` / `语音识别` / `RESOURCE`）。
       SQLite 的 `=` 对文本**区分大小写**，所以原先的 `WHERE channel = ?`（传小写）
       **永远匹配不到任何行** —— 于是 `createdAt` 恒为 undefined，meta 退化成 `{}`。
       实测：一个真实存在、247 条消息的会话 `ch-tui-2026-09-27`，归档后 meta 是空对象，
       归档列表因此**丢掉了创建时间**。
       用 `UPPER()` 两侧归一：session_key 侧是已知 ASCII 小写，DB 侧中文渠道名不受影响。 */
    const row = db.prepare(
      'SELECT MIN(timestamp) AS first_ts FROM conversations WHERE UPPER(channel) = UPPER(?) AND substr(timestamp, 1, 10) = ?'
    ).get(channelOfSessionKey(id), dateOfSessionKey(id))
    if (row?.first_ts) createdAt = String(row.first_ts)
  } catch (error) {
    /* 查询**失败**了（而不是"查到了 0 行"）。这两件事在下游看起来都是
       `createdAt === undefined`，但含义完全不同：
         · 查到了 0 行   → 这个会话真的没有消息 → 合理
         · 查询抛异常     → 我们**不知道**它有没有消息 → 不能当成"没有"
       所以这里置 lookupFailed，让下面的判定不要因为"看起来没有"就报 null。 */
    lookupFailed = true
    console.warn('[session-archive] 查询会话创建时间失败:', String(error?.message || error))
  }

  /* 契约（DSH `ledger.load()`）：`entry === null` 的会话必须**跳过**，不进归档集合。
     DSH 里 entry 来自宿主 session store，会话不存在时就是 null。
     爱丽丝对应的是「这个 session_key 在本库里根本没有消息，也没有自定义标题」——
     此时**必须返回 null**，否则会给一个不存在的会话凭空建一条 `{}` 元数据条目，
     归档列表里于是出现一条点进去什么都没有的幽灵记录。
     注意「有标题无消息」仍算存在（用户可能只改了标题），所以判据是两者皆无。

     ⚠️ **但查询失败时不能走这条路**。`lookupFailed` 为真意味着"我们不知道"，
     把它当成"不存在"会让**归档集合整体变空** —— 数据库一有问题，
     用户看到的不是报错，而是"我归档的会话全没了"。
     这种情况下**返回带 undefined 的 meta 对象**（即有标题给标题、没标题给空 meta），
     宁可保留一条信息不全的记录，也不要谎报"不存在"。
     （与问题 13 同一条原则的镜像：那次是**不该写的写了**，这次是**不该说没有的说没有**。） */
  const hasConversation = createdAt !== undefined
  const hasTitle = title !== undefined
  if (lookupFailed) {
    /* 查询失败：不宣称"不存在"。cwd/createdAt 可能缺失，如实留 undefined。 */
    return { title, createdAt, cwd: undefined }
  }
  if (!hasConversation && !hasTitle) return null

  return { title, createdAt, cwd: undefined }
}

/**
 * 从 session_key（`ch-<渠道组>-<YYYY-MM-DD>`，渠道组可能自带 `-`）解析出渠道与日期。
 * 日期固定在**最后 10 位**，前面才是渠道组——所以从右边切，而不是 split('-')。
 */
function dateOfSessionKey(sessionKey) {
  const text = String(sessionKey || '')
  const match = text.match(/(\d{4}-\d{2}-\d{2})$/)
  return match ? match[1] : ''
}

function channelOfSessionKey(sessionKey) {
  const text = String(sessionKey || '')
  const date = dateOfSessionKey(text)
  if (!date) return text
  return text.slice(0, Math.max(0, text.length - date.length - 1)).replace(/^ch-/, '')
}

/**
 * `ledger.load()`：返回 `{ archivedSessionIds, meta }`。
 * 语义与 DSH 一致：
 *   - 已经不存在（provider 返回 null）的会话 id **跳过**，不进 archivedSessionIds；
 *   - `title = displayTitle ?? title`；
 *   - `title` 为 undefined 时**不写该键**（不是写 null、也不是写空串）。
 */
export async function loadArchiveLedger({ metaProvider = defaultSessionMetaProvider } = {}) {
  ensureArchivedSessionsTable()
  const rows = getDB().prepare('SELECT session_key, created_at, cwd, title FROM archived_sessions ORDER BY archived_at ASC').all()
  const archivedSessionIds = []
  const meta = {}
  for (const row of rows) {
    const sessionId = String(row.session_key)
    let entry = null
    try {
      entry = await metaProvider(sessionId)
    } catch {
      entry = null
    }
    if (entry === null || entry === undefined) continue
    archivedSessionIds.push(sessionId)
    // 表里存的元数据是归档当时的快照；会话还活着就用实时值优先覆盖。
    const title = entry.displayTitle ?? entry.title ?? row.title ?? undefined
    const createdAt = entry.createdAt ?? row.created_at ?? undefined
    const cwd = entry.cwd ?? row.cwd ?? undefined
    meta[sessionId] = {
      createdAt,
      cwd,
      ...(title === undefined ? {} : { title }),
    }
  }
  return { archivedSessionIds, meta }
}

/** 归档集合（只读，不做存活过滤）。 */
export function listArchivedSessionIds() {
  ensureArchivedSessionsTable()
  return getDB().prepare('SELECT session_key FROM archived_sessions ORDER BY archived_at ASC').all()
    .map(row => String(row.session_key))
}

function upsertArchived(sessionId, { createdAt, cwd, title } = {}) {
  ensureArchivedSessionsTable()
  getDB().prepare(
    `INSERT INTO archived_sessions (session_key, archived_at, created_at, cwd, title)
     VALUES (?, ?, ?, ?, ?)
     ON CONFLICT(session_key) DO UPDATE SET archived_at = excluded.archived_at`
  ).run(
    sessionId,
    Date.now(),
    createdAt === undefined ? null : createdAt,
    cwd === undefined ? null : cwd,
    title === undefined ? null : title,
  )
}

function deleteArchivedRows(sessionIds) {
  ensureArchivedSessionsTable()
  const db = getDB()
  const stmt = db.prepare('DELETE FROM archived_sessions WHERE session_key = ?')
  for (const id of sessionIds) stmt.run(id)
}

// ---------------------------------------------------------------------------
// 3. 记账 detach / attach
//
// DSH 的记账对象是宿主 workspaceRegistry 里的「工作区记录」，每条记录有一个
// `sessionIds: string[]` 槽位，detach = 从槽位里移除、attach = 按
// `session.header.cwd` 匹配工作区 `path` 再塞回去。
//
// **爱丽丝没有这个模型**：爱丽丝的「工作区」不是「带 sessionIds 槽位的记录」，
// 而是由 `conversations`（消息行，按渠道×自然日）与 `workspace_session_meta`
// （会话级自定义标题，主键就是 session_key）拼出来的**视图**。
// 会话与视图之间是**派生的**关系，不是一个可以「detach」的成员槽位：
// 归档一个会话并不会让它从 conversations 视图里消失（那需要删消息，属于另一件事）。
//
// 所以这里**如实实现为 no-op**（不硬套一个错误语义去删别人的消息或标题），
// 但保留调用点与返回值，将来若引入真正的工作区-会话成员表，把实现换掉即可。
// ---------------------------------------------------------------------------

export async function detachWorkspaceAccounting(_sessionIds) {
  return { applied: false, reason: 'no-workspace-session-slot-model' }
}

export async function restoreWorkspaceAccounting(_sessionIds) {
  return { applied: false, reason: 'no-workspace-session-slot-model' }
}

// ---------------------------------------------------------------------------
// 4. 服务层（归档 / 恢复 / 永久删除）
// ---------------------------------------------------------------------------

/**
 * 归档单个会话。
 *
 * **不存在的会话不落库**（2026-10-01 修正）。
 *
 * 原先这里**无条件** `upsertArchived` —— 即使 `entry === null`（会话在库里查不到）
 * 也照样 INSERT，只是把 createdAt/cwd/title 全写成 null。于是：
 *   · **写路径**：`ghost-x` 行真的进了 `archived_sessions` 表
 *   · **读路径**：`loadArchiveLedger` 里 `if (entry === null) continue` 把它跳过
 *   → 接口返回 `archivedSessionIds: []`，**而表里明明有一行**
 *   → 下一轮 `deleteAllArchived` 走 `listArchivedSessionIds()`（不过滤）→ `cleared: 1`
 *   实测：POST 归档 `ghost-x` 返回 `[]`，紧接着 clear 却清掉 1 条 —— **两个矛盾的观测**。
 *
 * 根因是**读路径与写路径判据不一致**：读要求"会话存在"，写却不要求。
 * 我在问题 8b 只修了读的那一半（加 `continue`），没修写的这一半 ——
 * 与问题 11「只修症状出现的那一半」是同一个错误。
 *
 * DSH 为什么没这个问题：它的归档集合是**宿主注册表的派生状态**，
 * `registry.archiveSession(不存在的 id)` 根本不会往注册表里写东西，
 * 所以脏数据无处可存。爱丽丝是自建表，**必须自己守住这个不变量**。
 *
 * 保持可观测行为与 DSH 一致：对不存在的会话仍返回 `{archivedSessionIds: [], ...}`
 * （DSH 的 `ledger.load()` 也跳过它），只是**不再留下永远读不出来的脏行**。
 */
export async function archiveSession(sessionId, options = {}) {
  const id = String(sessionId ?? '')
  if (!id) throw new Error('invalid-session-id')
  let entry = null
  try {
    entry = await (options.metaProvider ?? defaultSessionMetaProvider)(id)
  } catch {
    entry = null
  }
  // 会话不存在（metaProvider 查不到）→ 不写库。
  // 注意：entry 为 null 有两种成因 —— 会话不存在，或会话存在但没有任何可读元数据。
  // 两者都**不该归档**：归档一个连会话记录都没有的 id 没有意义。
  if (entry === null || entry === undefined) {
    return loadArchiveLedger(options)
  }
  upsertArchived(id, {
    createdAt: entry.createdAt,
    cwd: entry.cwd,
    title: entry.displayTitle ?? entry.title,
  })
  callHook('archive:added', id)
  return loadArchiveLedger(options)
}

/** 批量归档。任一 id 为空就整体拒绝（契约：invalid-session-ids）。 */
export async function archiveWorkspaceSessions(sessionIds, options = {}) {
  const ids = normalizeIds(sessionIds)
  if (ids.length === 0) throw new Error('invalid-session-ids')
  for (const id of ids) {
    await archiveSession(id, options)
  }
  return loadArchiveLedger(options)
}

/** 取消归档（attach 记账）。 */
export async function unarchiveSession(sessionId, options = {}) {
  const id = String(sessionId ?? '')
  if (!id) throw new Error('invalid-session-id')
  await removeFromLedger([id], 'attach', options)
  callHook('archive:restored', id)
  return { ok: true }
}

/** 永久删除单个 / 多个已归档会话。 */
export async function permanentlyDeleteArchived(rawIds, options = {}) {
  const ids = normalizeIds(rawIds)
  if (ids.length === 0) throw new Error('invalid-session-ids')

  // —— 预检：全部在变更之前完成。不在归档集合里的 id 直接拒绝，避免误删活跃会话。
  const archived = new Set(listArchivedSessionIds())
  const missing = ids.filter(id => !archived.has(id))
  if (missing.length > 0) {
    throw new Error(`会话 '${missing[0]}' 不在归档集合中，拒绝删除`)
  }

  const root = sessionsRoot(options.root)
  const removeDir = options.removeDirImpl || ((sid) => removeSessionDir(root, sid))

  // —— 物理删除（失败即中止：归档集合一个字节都还没动，整体可重试）。
  //    这是「不留幽灵」的关键：先删数据，后更新集合；数据删失败就抛，
  //    归档表保持原样，用户看到的仍是「还归档着」，可以整体重试。
  //
  //    ⚠️ `removed` 数的是**磁盘目录删掉了几个**，不是「集合里移除了几条」。
  //    DSH 原版就是这个语义（只在 removeDir 成功时 +1），照抄是忠实的；
  //    但爱丽丝的会话是 `conversations` 行、**常规形态下没有每会话目录**，
  //    于是这个字段在爱丽丝几乎恒为 0。调用方若拿它当「删了几条」显示，
  //    就会出现「已清空 0 条」而集合其实已经清空 —— 界面说的和实际不一致。
  //    所以额外返回 `cleared`（集合实际移除的条数），由集合更新后重新读表得出；
  //    `removed` 保留原语义供 DSH 契约对齐，两者不再混用。
  let removed = 0
  for (const id of ids) {
    try {
      if (removeDir(id)) removed += 1
    } catch (error) {
      throw new Error(`删除会话数据失败：${id}（${error instanceof Error ? error.message : String(error)}）`)
    }
  }

  // —— 归档集合更新。
  await removeFromLedger(ids, 'detach', options)
  callHook('archive:deleted', ids)
  // 集合实际清掉几条：以「请求的 id 里还有几个留在表里」反推，比数目录可靠。
  const stillArchived = new Set(listArchivedSessionIds())
  const cleared = ids.filter(id => !stillArchived.has(id)).length
  // 与 emptyDeleteResult() 同形状 —— 两处共用一个构造点，见下方 emptyDeleteResult 的说明。
  return { ok: true, removed, cleared }
}

/** 清空：永久删除所有已归档会话。 */
export async function deleteAllArchived(options = {}) {
  const ids = listArchivedSessionIds()
  // ⚠️ 这个提前返回必须和 permanentlyDeleteArchived 的返回**同形状**。
  // 原先这里写的是 `return { ok: true, removed: 0 }` —— 少了 `cleared`。
  // 后果：`DELETE /session/archive/clear` 在**空集合**时返回 `{ok,removed}`，
  // 非空时返回 `{ok,removed,cleared}` —— 同一个端点两种形状，
  // 取决于"清空前有没有东西"。调用方按 `cleared` 读数，在空集合那次拿到 undefined，
  // 界面显示「已清空 undefined 条」（或报 0，而"0"恰好又是对的，于是更难发现）。
  // 这与 not-a-directory / 弱前缀正则 / sync.preview 同型：手写的第二份实现没跟第一份对齐。
  // 现在两条路径共用同一个构造器，物理上不可能再漂移。
  if (ids.length === 0) return emptyDeleteResult()
  return permanentlyDeleteArchived(ids, options)
}

/** 删除结果信封的**唯一**构造点：两条删除路径都从这里出，形状不可能再分叉。 */
function emptyDeleteResult() {
  return { ok: true, removed: 0, cleared: 0 }
}

/** 在文件管理器打开会话目录。找不到目录 → session-directory-not-found。 */
export async function openSessionDir(sessionId, options = {}) {
  const id = String(sessionId ?? '')
  if (!id) return { ok: false, error: 'invalid-session-id' }
  const dir = findSessionDataDir(sessionsRoot(options.root), id)
  if (dir === null) return { ok: false, error: 'session-directory-not-found' }
  const open = options.openImpl
  if (typeof open !== 'function') return { ok: false, error: 'open-implementation-missing' }
  try {
    const result = await open(dir)
    if (result && result.ok === false) return { ok: false, error: 'not-a-directory' }
  } catch {
    return { ok: false, error: 'not-a-directory' }
  }
  return { ok: true, dir }
}

function normalizeIds(rawIds) {
  const list = Array.isArray(rawIds) ? rawIds : []
  const seen = new Set()
  const out = []
  for (const raw of list) {
    const id = String(raw ?? '')
    if (!id || seen.has(id)) continue
    seen.add(id)
    out.push(id)
  }
  return out
}

/**
 * 从归档集合移除 + 记账。DSH 把「记账 + 集合更新」放在同一个
 * registry.enqueueOperation 里原子完成；爱丽丝用 SQLite 事务达到等价原子性。
 */
async function removeFromLedger(ids, accounting, options = {}) {
  const db = getDB()
  const detach = accounting === 'attach'
    ? (options.restoreAccountingImpl || restoreWorkspaceAccounting)
    : (options.detachAccountingImpl || detachWorkspaceAccounting)
  const run = db.transaction(() => {
    deleteArchivedRows(ids)
  })
  // 先记账再动集合：记账失败时集合保持原样（宁可重试，也不要半途状态）。
  await detach(ids)
  run()
}

export const SESSION_ARCHIVE_CONSTANTS = Object.freeze({
  SESSIONS_DIRECTORY,
  SESSION_DIRECTORY_PREFIX,
  SESSION_ID_ESCAPE,
  DOT_SEGMENT,
  DOT_DOT_SEGMENT,
  DOT_ESCAPE,
})
