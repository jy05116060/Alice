import { jsonResponse } from '../utils.js'
import { compactionStatus, compactNow, assessCompactionPressure } from '../../runtime/compaction-runtime.js'
import {
  listAllCompactions,
  listConversationRowsInRange,
} from '../../runtime/compaction-store.js'
import { buildCompactionTrace } from '../../runtime/compaction-view.js'
import { getContextWindowConfig } from '../../config.js'

// 会话压缩（阶段 3.2）的 REST 面。
//   GET  /compaction          —— 当前边界 + 摘要 + 最近几次压缩记录
//   GET  /compaction/history  —— Turn-Trace 面板的数据源：每次压缩**压掉了什么** + 摘要
//   POST /compaction          —— 手动压一次（可选 body: { rows, current_msg, action_log }）
//
// 为什么另开一个 /compaction/history 而不是把 GET /compaction 撑大：
// 那个端点的响应形状已经有人在读，改形状要冒破坏兼容的风险；而面板真正缺的是**另一件事**
// ——「压掉了多少 token / 省了几成 / 覆盖了哪一段」这些要现查原文才算得出的展示字段。
// 补形状不如补端点（与 routes/worktrees.js 同一做法）。
//
// 为什么是接口而不是 `/compact` 斜杠命令：爱丽丝的对话入口（TUI / 网页 / 社交渠道）
// 都没有斜杠命令层，聊天正文一律交给模型判断。为了一个命令新造一层解析器，就多出
// 一条「哪些前缀算命令、算命令时正文还给不给模型」的规则要长期维护；而 Brain UI 和
// 局域网客户端本来就靠 REST 驱动，接口是这里更自然的形状。

const MANUAL_CONTEXT_HOURS = 24 * 7

// 面板一次最多看多少条压缩记录。压缩本身是低频事件，200 条足够覆盖很长的历史，
// 同时挡住 ?limit=100000 这种把库拖垮的请求。
const HISTORY_LIMIT_DEFAULT = 50
const HISTORY_LIMIT_MAX = 200

// 不传 rows 时服务端自己取窗口：必须和模型看到的是**同一份来源、同一份配置**
// （getRecentConversationTimeline + contextWindow.chatMessageLimit），
// 否则会出现「接口压的段」和「模型看的段」对不上的鬼故事。
async function defaultRows() {
  const { getRecentConversationTimeline } = await import('../../db.js')
  const { chatMessageLimit } = getContextWindowConfig()
  return getRecentConversationTimeline(chatMessageLimit, MANUAL_CONTEXT_HOURS) || []
}

function compactionPayload() {
  const status = compactionStatus()
  return {
    in_flight: status.inFlight,
    active: status.active
      ? {
        compaction_id: status.active.compactionId,
        covers_from_id: status.active.coversFromId,
        covers_through_id: status.active.coversThroughId,
        summary: status.active.summary,
        message_count: status.active.messageCount,
        chars_before: status.active.charsBefore,
        summary_chars: status.active.summaryChars,
        input_tokens: status.active.inputTokens,
        trigger: status.active.trigger,
        created_at: status.active.createdAt,
      }
      : null,
    history: (status.history || []).map(row => ({
      compaction_id: row.compactionId,
      covers_through_id: row.coversThroughId,
      message_count: row.messageCount,
      chars_before: row.charsBefore,
      summary_chars: row.summaryChars,
      trigger: row.trigger,
      created_at: row.createdAt,
    })),
  }
}

/**
 * Turn-Trace 的数据：每次压缩「压掉了什么」+ 摘要。
 *
 * 「压掉了多少 token」这类展示字段只能在这里算：面板跑在浏览器里，import 不到
 * src/runtime/。口径一律复用 runtime 那几份（estimate* / buildCompactionTrace /
 * assessCompactionPressure），面板只把数字摆出来，不重写任何规则。
 */
async function compactionHistoryPayload(searchParams) {
  const requested = Number.parseInt(searchParams?.get?.('limit') ?? '', 10)
  const limit = Number.isFinite(requested) && requested > 0
    ? Math.min(requested, HISTORY_LIMIT_MAX)
    : HISTORY_LIMIT_DEFAULT

  const status = compactionStatus()
  // 展示字段必须按**整条链**算：每次压缩的「本次新增段」是上一次边界之后的那些行，
  // 只取最近 N 条的话最老的那条没有上一条可比，数字就是错的（详见 compaction-view.js）。
  // 因而是「全链算、切片下发」：链本身是一张小表，代价只有一次原文读。
  const all = listAllCompactions()
  const total = all.length

  // 只读「被覆盖过的那一段」原文：没被压过的行不必读，长会话也不会把库拖垮。
  const throughIds = all.map(c => c.coversThroughId).filter(id => Number.isSafeInteger(id))
  const fromIds = all
    .map(c => (Number.isSafeInteger(c.coversFromId) ? c.coversFromId : c.coversThroughId))
    .filter(id => Number.isSafeInteger(id))
  let rows = []
  let rowsError = null
  if (throughIds.length) {
    try {
      rows = listConversationRowsInRange({
        fromId: fromIds.length ? Math.min(...fromIds) : 0,
        throughId: Math.max(...throughIds),
      })
    } catch (error) {
      // 读不到原文不是 500：摘要与边界仍然可以看，只是「压掉多少 token」那一栏要标成未知。
      // 如实带上原因，绝不静默当成「原文就是 0 条」。
      rowsError = error?.message || String(error)
    }
  }

  const trace = buildCompactionTrace({ compactions: all, rows, showLast: limit })

  // 当前压力：分母（上下文窗口）与阈值同样由服务端算，面板不猜。
  let context
  try {
    const pressure = await assessCompactionPressure({})
    context = {
      enabled: pressure.enabled,
      context_window: pressure.contextWindow,
      limit_tokens: pressure.limit,
      last_input_tokens: pressure.inputTokens ?? 0,
      pressure_percent: Number.isFinite(pressure.pressure)
        ? Math.round(pressure.pressure * 1000) / 10
        : 0,
      pressure_reason: pressure.reason,
      signal_source: pressure.source,
    }
  } catch (error) {
    context = { error: error?.message || String(error) }
  }

  return {
    in_flight: status.inFlight,
    active_id: status.active ? status.active.compactionId : null,
    total,
    limit,
    // 磁盘上还有更多条没下发（total > 取回条数）→ 面板要如实说「只显示最近 N 次」
    truncated: total > trace.entries.length,
    entries: trace.entries,
    totals: trace.totals,
    context,
    rows_error: rowsError,
  }
}

export async function handleCompactionRoutes(req, res, url) {
  const path = url.pathname
  if (path !== '/compaction' && path !== '/compaction/history') return false

  if (req.method === 'GET' && path === '/compaction/history') {
    jsonResponse(res, 200, { ok: true, ...(await compactionHistoryPayload(url.searchParams)) })
    return true
  }

  if (req.method === 'GET') {
    jsonResponse(res, 200, { ok: true, ...compactionPayload() })
    return true
  }

  if (req.method === 'POST' && path === '/compaction') {
    const body = await readJsonBody(req)
    let rows = Array.isArray(body?.rows) ? body.rows : null
    if (!rows) {
      try {
        rows = await defaultRows()
      } catch (error) {
        jsonResponse(res, 500, {
          ok: false,
          code: 'WINDOW_UNAVAILABLE',
          error: `could not read the conversation window: ${error?.message || error}`,
        })
        return true
      }
    }
    if (rows.length === 0) {
      jsonResponse(res, 409, { ok: false, skipped: 'no-rows', ...compactionPayload() })
      return true
    }

    const result = await compactNow({
      rows,
      currentMsg: body?.current_msg || null,
      actionLog: Array.isArray(body?.action_log) ? body.action_log : [],
    })
    const ok = result?.ok === true
    // 没压成不是服务器错误：可能只是「没有新东西可压」或「在飞」。用 409 让调用方
    // 能区分「接口坏了」和「这次没什么可压」。
    jsonResponse(res, ok ? 200 : 409, {
      ok,
      skipped: result?.skipped || null,
      error: result?.error || null,
      covered_now: result?.coveredNow ?? null,
      covered_total: result?.coveredTotal ?? null,
      released_chars: result?.releasedChars ?? null,
      released_tokens: result?.releasedTokens ?? null,
      previous_summary_folded: result?.previousSummaryFolded ?? null,
      ...compactionPayload(),
    })
    return true
  }

  return false
}

function readJsonBody(req) {
  return new Promise((resolve) => {
    let raw = ''
    req.on('data', (chunk) => {
      raw += chunk
      if (raw.length > 8 * 1024 * 1024) {
        try { req.destroy() } catch {}
        resolve(null)
      }
    })
    req.on('end', () => {
      if (!raw) return resolve(null)
      try { resolve(JSON.parse(raw)) } catch { resolve(null) }
    })
    req.on('error', () => resolve(null))
  })
}
