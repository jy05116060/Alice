// 会话压缩 compaction（阶段 3.2，对齐 DSH 的上下文压缩）——落库与调模型的那一半。
// 纯逻辑（token 估算、压力判定、边界计算、视图构造）在 runtime/compaction-view.js。
//
// 要解决的问题：会话越长，每轮重发的历史越贵，最终撞上模型上下文窗口。
// 爱丽丝原本只有「按条数裁窗口」（config.contextWindow.chatMessageLimit），
// 那治不了「条数不多但每条很长」——几十条长消息照样能撑爆 128k。
//
// 做法（DSH 同款）：
//   1. 用**真实 usage.inputTokens** 判断压力（拿不到就用字符估算兜底）；
//   2. 把窗口里「较早的一段」交给 LLM 压成一条摘要；
//   3. 只改**派生给模型的视图**：摘要 + 最近的原文尾巴，数据库一行不动。
import {
  loadActiveCompaction,
  insertCompaction,
  listCompactions,
} from './compaction-store.js'
import {
  COMPACTION_MARKER,
  COMPACTION_LIMITS,
  cleanSummary,
  computeCompactionBoundary,
  estimateMessagesTokens,
  estimateTokens,
  buildCompactionInput,
} from './compaction-view.js'

export {
  COMPACTION_MARKER,
  COMPACTION_LIMITS,
  estimateTokens,
  estimateMessagesTokens,
  evaluateCompactionPressure,
  computeCompactionBoundary,
  formatCompactionSummaryMessage,
  filterCompactedRows,
  buildCompactionInput,
} from './compaction-view.js'

// ── 上下文窗口解析 ────────────────────────────────────────────────────────
// 优先级：显式配置 > 供应商模型元数据 > 保守兜底。
// 探测不到时用兜底值而不是「不压缩」：宁可早一点压，也别撞窗口。
export function resolveContextWindow({ config, suppliers } = {}) {
  const override = Number(config?.compaction?.contextWindow)
  if (Number.isFinite(override) && override >= 1000) return Math.round(override)

  try {
    const list = suppliers?.getSupplierList?.()
    if (list?.suppliers?.length) {
      const norm = v => String(v || '').replace(/\/+$/, '').toLowerCase()
      const supplier = list.suppliers.find(s => norm(s.baseURL) === norm(config?.baseURL))
        || list.suppliers.find(s => s.id === list.activeId)
      const meta = supplier?.models?.find(m => m.id === String(config?.model || ''))
      if (Number.isFinite(meta?.contextWindow) && meta.contextWindow >= 1000) {
        return Math.round(meta.contextWindow)
      }
    }
  } catch { /* 探测失败就走兜底 */ }

  const fallback = Number(config?.compaction?.defaultContextWindow)
  return Number.isFinite(fallback) && fallback >= 1000 ? Math.round(fallback) : 128000
}

export async function resolveContextWindowAsync(config = null) {
  const cfg = config || (await import('../config.js')).config
  let suppliers = null
  try {
    suppliers = await import('../suppliers.js')
  } catch { /* 拿不到就只靠配置 */ }
  return resolveContextWindow({ config: cfg, suppliers })
}

const SUMMARY_PROMPT = `You are the context compactor for a long-running assistant session. You are given an earlier span of a conversation (oldest first) plus any tool activity, and you produce ONE compact summary that will replace that span in the model's context.

Requirements:
- Write a factual record of the conversation. Never invent events that are not in the excerpt.
- Keep every concrete anchor a later turn might need: file paths, identifiers, commands, error messages, numbers, decisions and WHO made them (the user or you), and what was left unfinished.
- Preserve commitments and open questions close to their original wording where the wording matters. A dropped promise is worse than a long summary.
- Drop: greetings, acknowledgements, restatements, and any back-and-forth that ended with nothing changed.
- Do not continue the conversation, do not answer anything, and do not comment on the act of summarizing.
- Output the summary only — no heading, no prefix, no bullet markers.
- If a PREVIOUS SUMMARY is given, fold it into yours: the result must stand alone as the complete record of everything covered so far.`

/**
 * 跑一次压缩。成功返回新的 compaction 行；不该压/压不动返回 { skipped }。
 * 任何失败都返回 skipped，绝不抛出——压缩是优化，不能把对话搞挂。
 */
export async function runCompaction({
  rows = [],
  currentMsg = null,
  trigger = 'auto',
  inputTokens = null,
  actionLog = [],
  signal = null,
  _callLLM = null,
  _config = null,
} = {}) {
  let config = _config
  if (!config) {
    try {
      ({ config } = await import('../config.js'))
    } catch (error) {
      return { skipped: 'no-config', error: error?.message || String(error) }
    }
  }
  if (config?.compaction?.enabled === false) return { skipped: 'disabled' }

  const active = loadActiveCompaction()
  const { boundary, covered, skipped } = computeCompactionBoundary({
    rows,
    keepRecent: config?.compaction?.keepRecent ?? 20,
    currentMsg,
    previousBoundary: active?.coversThroughId ?? 0,
    minMessages: config?.compaction?.minMessages ?? 8,
  })
  if (boundary === null) return { skipped, active, considered: covered }

  const floor = active?.coversThroughId ?? 0
  const fresh = (Array.isArray(rows) ? rows : []).filter(r => Number.isSafeInteger(r?.id)
    && r.id > floor
    && r.id <= boundary)
  if (fresh.length === 0) return { skipped: 'nothing-new', active }

  let callLLM = _callLLM
  if (!callLLM) {
    try {
      ({ callLLM } = await import('../llm.js'))
    } catch (error) {
      return { skipped: 'no-llm', error: error?.message || String(error) }
    }
  }

  const charsBefore = fresh.reduce((sum, r) => sum + String(r.content ?? '').length, 0)
  let result = null
  try {
    result = await callLLM({
      systemPrompt: SUMMARY_PROMPT,
      message: buildCompactionInput({ rows: fresh, previousSummary: active?.summary || '', actionLog }),
      temperature: 0.2,
      thinking: false,
      tools: [],
      maxTokens: config?.compaction?.maxSummaryTokens ?? 800,
      mustReply: false,
      ...(signal ? { signal } : {}),
    })
  } catch (error) {
    return { skipped: 'llm-failed', error: error?.message || String(error), active }
  }

  const summary = cleanSummary(result?.content)
  if (!summary) return { skipped: 'empty-summary', active }

  const saved = insertCompaction({
    coversFromId: floor > 0 ? floor + 1 : (fresh[0]?.id ?? null),
    coversThroughId: boundary,
    summary,
    // 累计值是**整份摘要**的覆盖量：previousSummary 被折进新摘要里了，
    // 所以计数也要跟着累计，否则 UI 显示的「已压缩 N 条」会漏掉前几轮。
    messageCount: (active?.messageCount ?? 0) + fresh.length,
    charsBefore: (active?.charsBefore ?? 0) + charsBefore,
    inputTokens: Number.isFinite(inputTokens) ? inputTokens : 0,
    trigger,
  })

  return {
    ok: true,
    compaction: saved,
    coveredNow: fresh.length,
    coveredTotal: saved.messageCount,
    charsBefore,
    charsAfter: summary.length,
    releasedChars: Math.max(0, charsBefore - summary.length),
    releasedTokens: Math.max(0, estimateMessagesTokens(fresh) - estimateTokens(summary)),
    previousSummaryFolded: !!active?.summary,
  }
}

export function compactionSnapshot() {
  return {
    active: loadActiveCompaction(),
    history: listCompactions({ limit: 10 }),
  }
}
