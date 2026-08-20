// 会话压缩（阶段 3.2）的**纯逻辑**部分：token 估算、压力判定、边界计算、视图构造。
//
// 这里零依赖——不碰 db、不碰 llm、不碰 config 单例。理由和 focus-compress.js 一样：
// 压缩的正确性主要落在这几个算式上，把它们和「真的去调一次 LLM」分开，
// 才能在不连数据库的环境里直接测边界、测幂等、测标记。
// 需要落库与调模型的部分在 runtime/compaction.js。
//
// 三条不能破的规矩（在 computeCompactionBoundary 里强制）：
//   - 边界只增不减：covers_through_id 永不后退，否则同一段历史被反复压，越压越糊。
//   - 当前这条消息永不进摘要：它是这一轮要回答的东西。
//   - 最近 N 条原文永不进摘要：摘要替代不了刚刚说过的原话（引用、指代全靠它）。

// 稳定标记：摘要消息以此开头。它是**契约**而不是文案——人工核对、UI 识别、
// 以及模型区分「这是我被压缩过的记忆」还是「用户真的说过这句话」都靠它。
export const COMPACTION_MARKER = '[context compacted]'

export const COMPACTION_LIMITS = Object.freeze({
  minCoveredMessages: 2,
})

// ── token 估算 ────────────────────────────────────────────────────────────
// 只在拿不到真实 usage 时兜底。中日韩字符按 ~1 token/字，其余按 ~4 字符/token：
// 这个差异是真实的（BPE 对汉字基本一字一 token），统一用 chars/4 估算中文会话
// 会低估 3-4 倍，阈值就形同虚设。
export function estimateTokens(text) {
  const s = String(text ?? '')
  if (!s) return 0
  let cjk = 0
  for (const ch of s) {
    const code = ch.codePointAt(0)
    if (
      (code >= 0x3000 && code <= 0x303f)   // CJK 标点
      || (code >= 0x3040 && code <= 0x30ff) // 假名
      || (code >= 0x3400 && code <= 0x4dbf) // 扩展 A
      || (code >= 0x4e00 && code <= 0x9fff) // 基本汉字
      || (code >= 0xf900 && code <= 0xfaff) // 兼容汉字
      || (code >= 0xff00 && code <= 0xffef) // 全角
    ) cjk++
  }
  const rest = s.length - cjk
  return Math.ceil(cjk + rest / 4)
}

export function estimateMessagesTokens(messages = []) {
  let total = 0
  for (const m of messages) {
    if (typeof m === 'string') { total += estimateTokens(m); continue }
    if (!m) continue
    total += estimateTokens(m.content)
    // 工具调用/结果同样是实打实的 token
    if (m.tool_calls) total += estimateTokens(JSON.stringify(m.tool_calls))
    total += 4 // 每条消息的角色与分隔符开销
  }
  return total
}

// ── 压力判定 ──────────────────────────────────────────────────────────────
/**
 * 判断这一轮要不要压缩。纯函数。
 * @param {object} o
 * @param {number|null} o.inputTokens  —— 上一轮真实 usage.inputTokens（首选信号）
 * @param {number} [o.estimatedTokens] —— 估算值（没有真实 usage 时兜底）
 * @param {number} o.contextWindow
 * @param {number} o.thresholdRatio
 * @returns {{needed: boolean, reason: string, pressure: number, limit: number, source: string}}
 */
export function evaluateCompactionPressure({
  inputTokens = null,
  estimatedTokens = 0,
  contextWindow = 0,
  thresholdRatio = 0.7,
} = {}) {
  const limit = Math.max(1, Math.round(Number(contextWindow) * Number(thresholdRatio)))
  const hasUsage = Number.isFinite(inputTokens) && inputTokens > 0
  const used = hasUsage ? inputTokens : Math.max(0, Number(estimatedTokens) || 0)
  const source = hasUsage ? 'usage' : 'estimate'
  const pressure = used / limit
  if (used <= 0) return { needed: false, reason: 'no-signal', pressure: 0, limit, source }
  if (used >= limit) return { needed: true, reason: 'over-threshold', pressure, limit, source }
  return { needed: false, reason: 'under-threshold', pressure, limit, source }
}

// ── 边界计算 ──────────────────────────────────────────────────────────────
/**
 * 算出这次压缩可以覆盖到哪一条（返回该行的 id）；不该压时返回 boundary: null。
 *
 * @param {object} o
 * @param {Array}  o.rows             —— 窗口里的对话行（时间正序，带 id）
 * @param {number} o.keepRecent       —— 保护的尾巴条数
 * @param {object|null} o.currentMsg  —— 本轮正在回答的消息（永不覆盖）
 * @param {number} o.previousBoundary —— 上次压缩的边界（只增不减）
 * @param {number} o.minMessages      —— 至少要能覆盖这么多条才值得压
 * @returns {{boundary: number|null, covered: number, skipped: string|null}}
 */
export function computeCompactionBoundary({
  rows = [],
  keepRecent = 20,
  currentMsg = null,
  previousBoundary = 0,
  minMessages = COMPACTION_LIMITS.minCoveredMessages,
} = {}) {
  const usable = (Array.isArray(rows) ? rows : []).filter(r => Number.isSafeInteger(r?.id))
  if (usable.length === 0) return { boundary: null, covered: 0, skipped: 'no-rows' }

  // 1. 从尾部往回数 keepRecent 条，这些是保护区。
  const tailStart = Math.max(0, usable.length - Math.max(0, keepRecent))
  let candidates = usable.slice(0, tailStart)

  // 2. 当前消息永不进摘要。
  //
  // 边界是**单一 id 切点**（视图 = id > boundary 的行），所以「挖掉中间某一条」
  // 是表达不出来的：只要当前消息在切点之下，它就会连带被吞。因此这里不是「把它
  // 从候选里挑出去」，而是**把切点压到它前面**——只覆盖严格早于当前消息的那些行，
  // 它之后的行一律保持原文。正确性优先于覆盖面。
  //
  // 平时当前消息就在窗口最末尾（它正是这一轮要回答的那条），第 1 步的保护区已经
  // 盖住它；这道闸门真正起作用的是两种边角：keepRecent=0，以及本轮资源被
  // mergePendingResourcesIntoConversationWindow 追加在当前消息之后。
  if (currentMsg) {
    const here = usable.findIndex(r => isCurrentRow(r, currentMsg))
    if (here >= 0) {
      const currentId = usable[here].id
      candidates = candidates.filter(r => r.id < currentId)
    } else {
      // 当前消息不在窗口里（例如 L2 心跳轮）：没有可吞的对象，但仍要防住
      // 窗口裁切留下的重复行——按内容去重比按位置猜更稳。
      candidates = candidates.filter(r => !isCurrentRow(r, currentMsg))
    }
  }

  // 3. 边界只增不减：已经进过摘要的行不再重复覆盖。
  const fresh = candidates.filter(r => r.id > (Number.isSafeInteger(previousBoundary) ? previousBoundary : 0))
  const min = Math.max(COMPACTION_LIMITS.minCoveredMessages, Number(minMessages) || 0)
  if (fresh.length < min) {
    return {
      boundary: null,
      covered: fresh.length,
      skipped: fresh.length === 0 ? 'nothing-new' : 'below-min-messages',
    }
  }

  // 4. 取最新的那条可覆盖行作为新边界——覆盖范围连续，不在历史里留空洞。
  const boundary = fresh[fresh.length - 1].id
  const covered = fresh.filter(r => r.id <= boundary).length
  return { boundary, covered, skipped: null }
}

function isCurrentRow(row, currentMsg) {
  return !!currentMsg
    && row?.role === 'user'
    && row.from_id === currentMsg.fromId
    && row.timestamp === currentMsg.timestamp
    && row.content === currentMsg.content
}

// ── 视图构造 ──────────────────────────────────────────────────────────────
export function formatCompactionSummaryMessage(compaction) {
  if (!compaction?.summary) return null
  const covered = compaction.messageCount > 0
    ? `first ${compaction.messageCount} messages of this conversation`
    : 'earlier messages of this conversation'
  return {
    role: 'user',
    content: [
      `${COMPACTION_MARKER} The ${covered} were compacted into the summary below.`,
      'The raw history is not lost — it is still stored and readable; you are simply seeing it summarized.',
      'Treat it as things you already know happened; do not re-ask the user about anything it covers.',
      '',
      compaction.summary,
    ].join('\n'),
  }
}

/**
 * 把窗口行按生效的压缩边界裁成模型该看到的样子。
 * 摘要消息本身不在这里返回——它由 buildLLMMessages 插在运行时上下文之后，
 * 位置固定，不受行顺序影响。
 * 没有 id 的行（合成行）一律保留：宁可不裁，也不要把可能是本轮输入的行吞掉。
 */
export function filterCompactedRows(rows = [], compaction = null) {
  const list = Array.isArray(rows) ? rows : []
  if (!compaction || !Number.isSafeInteger(compaction.coversThroughId)) return list
  return list.filter(r => !Number.isSafeInteger(r?.id) || r.id > compaction.coversThroughId)
}

// ── 摘要输入构造 ──────────────────────────────────────────────────────────
export function formatRowForSummary(row) {
  const who = row.role === 'user' ? (row.from_id || 'user') : 'assistant'
  const to = row.to_id || (row.role === 'user' ? 'assistant' : (row.from_id || 'user'))
  const text = String(row.content ?? '').replace(/\s*\n\s*/g, ' ').trim()
  const clipped = text.length > 1200 ? `${text.slice(0, 1200)}…` : text
  return `<${who} -> ${to}> ${clipped}`
}

export function buildCompactionInput({ rows = [], previousSummary = '', actionLog = [] } = {}) {
  const parts = []
  if (previousSummary) {
    parts.push(`PREVIOUS SUMMARY (already covers everything before this excerpt):\n${previousSummary}`)
  }
  parts.push(`CONVERSATION EXCERPT (oldest first):\n${rows.map(formatRowForSummary).join('\n')}`)
  if (actionLog.length > 0) {
    const lines = actionLog.map(entry => `- ${entry?.tool || 'tool'}${entry?.ok === false ? ' (failed)' : ''}`)
    parts.push(`TOOL ACTIVITY:\n${lines.join('\n')}`)
  }
  return parts.join('\n\n')
}

export function cleanSummary(raw) {
  let s = String(raw || '').trim()
  // 有的模型会自带标题或围栏，去掉——标记由我们自己加，不能让模型改动契约。
  s = s.replace(/^```[a-z]*\s*/i, '').replace(/\s*```$/, '').trim()
  s = s.replace(/^(?:summary|摘要)\s*[:：]\s*/i, '').trim()
  return s
}

// ── 展示视图构造（Turn-Trace 面板用）──────────────────────────────────────
// 面板跑在浏览器里，import 不到 src/runtime/，所以「压掉了多少 token、省了几成、
// 覆盖了哪一段」必须由这里算好随接口下发。放在本文件而不是路由里，是因为它同样是
// **纯算式**：喂进压缩行与原文行，吐出展示行；不碰 db、不碰 llm、不碰 config。
//
// 一条硬规矩：**对不上就说对不上**。落库的 messageCount 是累计值，原文行是现查的，
// 两者对不上（历史被清理、库被换过、覆盖段落在窗口裁切之外）时必须给
// source_complete:false，而不是把「少算了」粉饰成「本来就这么多」。
export function buildCompactionTrace({ compactions = [], rows = [], showLast = null } = {}) {
  const list = (Array.isArray(compactions) ? compactions : [])
    .filter(c => Number.isSafeInteger(c?.coversThroughId))
    .slice()
    .sort((a, b) => (a.coversThroughId - b.coversThroughId)
      || ((a.compactionId ?? 0) - (b.compactionId ?? 0)))
  const source = (Array.isArray(rows) ? rows : [])
    .filter(r => Number.isSafeInteger(r?.id))
    .slice()
    .sort((a, b) => a.id - b.id)

  const entries = []
  let prevThrough = 0        // 上一次的边界：本次新增段从这里之后开始
  let prevMessages = 0       // 上一次的累计条数：用来核对本次新增条数
  let totalReleasedChars = 0
  let totalReleasedTokens = 0

  for (const c of list) {
    const through = c.coversThroughId
    // 本次“新吞进去”的原文 = 边界在上一次之后、这一次之内的那些行。
    // 用累计值做差而不是直接取 covers_through_id 之前的全部行，是因为面板要回答的是
    // 「这一次压掉了什么」——整条链的累计量另外给（message_count / chars_before）。
    const fresh = source.filter(r => r.id > prevThrough && r.id <= through)
    const summary = String(c.summary ?? '')
    const summaryTokens = estimateTokens(summary)
    const freshChars = fresh.reduce((sum, r) => sum + String(r.content ?? '').length, 0)
    const freshTokens = estimateMessagesTokens(fresh)
    const releasedChars = Math.max(0, freshChars - summary.length)
    const releasedTokens = Math.max(0, freshTokens - summaryTokens)
    const expectedFresh = Math.max(0, (Number(c.messageCount) || 0) - prevMessages)
    const contextBefore = Number.isFinite(c.inputTokens) && c.inputTokens > 0 ? c.inputTokens : 0

    entries.push({
      compaction_id: Number.isSafeInteger(c.compactionId) ? c.compactionId : null,
      trigger: c.trigger || 'auto',
      created_at: c.createdAt || '',
      // 覆盖范围：本次新增段（可解释「压掉了哪一段」）+ 累计边界（可解释视图从哪切）
      new_from_id: fresh.length ? fresh[0].id : prevThrough + 1,
      new_through_id: through,
      covers_from_id: Number.isSafeInteger(c.coversFromId) ? c.coversFromId : null,
      covers_through_id: through,
      message_count: Number(c.messageCount) || 0,
      new_message_count: expectedFresh,
      source_rows_found: fresh.length,
      // null = 无从核对（登记里没有条数），true/false = 核对过
      source_complete: expectedFresh > 0 ? fresh.length >= expectedFresh : null,
      span_first_at: fresh.length ? (fresh[0].timestamp || '') : '',
      span_last_at: fresh.length ? (fresh[fresh.length - 1].timestamp || '') : '',
      chars_before: Number(c.charsBefore) || 0,
      new_chars: freshChars,
      summary,
      summary_chars: summary.length,
      summary_tokens: summaryTokens,
      new_tokens: freshTokens,
      released_chars: releasedChars,
      released_tokens: releasedTokens,
      // 百分比由服务端算：面板不该自己除，两份口径迟早对不上
      released_percent: freshTokens > 0 ? Math.round((releasedTokens / freshTokens) * 1000) / 10 : 0,
      // 触发时的**真实 usage**（整份上下文，不只是覆盖段）。0 = 当时拿不到真实读数。
      context_tokens_before: contextBefore,
      context_tokens_after: contextBefore > 0 ? Math.max(0, contextBefore - releasedTokens) : 0,
    })

    prevThrough = Math.max(prevThrough, through)
    prevMessages = Math.max(prevMessages, Number(c.messageCount) || 0)
    totalReleasedChars += releasedChars
    totalReleasedTokens += releasedTokens
  }

  const latest = entries[entries.length - 1] || null
  // 「本次新增段」必须按**整条链**算（上一条的边界是累加出来的），但面板一次只看最近 N 条。
  // 所以这里先全链算完再切片：切完再算的话，最老的那条会把「整段历史」当成自己这一次
  // 压掉的，或者因为累计条数对不上而误报「原文对不上」——两种都是数字撒谎。
  const shown = Number.isSafeInteger(showLast) && showLast > 0 ? entries.slice(-showLast) : entries
  return {
    entries: shown,
    totals: {
      runs: entries.length,
      released_chars: totalReleasedChars,
      released_tokens: totalReleasedTokens,
      // 最新一次之后的边界与会话视图起点：面板顶部那一行「现在生效的是哪一次」
      covered_messages: latest ? latest.message_count : 0,
      covers_through_id: latest ? latest.covers_through_id : 0,
      context_tokens_before: latest ? latest.context_tokens_before : 0,
      context_tokens_after: latest ? latest.context_tokens_after : 0,
      last_at: latest ? latest.created_at : '',
    },
  }
}
