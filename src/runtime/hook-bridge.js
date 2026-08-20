// hooks ↔ 工具流水线的接线层（阶段 6.5）。
//
// 单独成模块的原因：executor.js 已经是整个仓库最大的文件之一，而这一层需要
// config + hook 引擎 + 结果包装三样东西。抽出来之后 executor 那边只剩「包一层」，
// 也避免了 executor 与 hook 引擎互相 import 的循环。
//
// 与 executor 的分工：executor 决定**什么时候**问，这里决定**怎么问、怎么解释答案**。
import { config } from '../config.js'
import { emitEvent } from '../events.js'
import {
  HOOK_EVENTS,
  buildHookPayload,
  loadHookConfigCached,
  runHooks,
} from './agent-hooks.js'

export function hooksEnabled() {
  return config.hooks?.enabled === true
}

/** 附加了 hook 上下文的结果文本。工具返回的是 JSON 字符串，所以尽量塞进 JSON 里。 */
export function appendHookContext(result, contexts = []) {
  const extra = contexts.filter(Boolean).join('\n\n')
  if (!extra) return result
  const block = `[agent hook context]\n${extra}`
  if (typeof result !== 'string' || !result.trim().startsWith('{')) {
    return `${result}\n\n${block}`
  }
  try {
    const parsed = JSON.parse(result)
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
      const existing = typeof parsed.hook_context === 'string' ? `${parsed.hook_context}\n\n${extra}` : extra
      return JSON.stringify({ ...parsed, hook_context: existing })
    }
  } catch { /* 不是合法 JSON 就退回文本拼接 */ }
  return `${result}\n\n${block}`
}

function reportHookOutcome(event, toolName, outcome) {
  if (!outcome || outcome.ran === 0) return
  // 只在「真的有 hook 跑过」时发事件：否则每次工具调用都会刷一条噪声
  emitEvent('agent_hook_ran', {
    event,
    tool: toolName,
    ran: outcome.ran,
    blocked: outcome.blocked === true,
    ...(outcome.errors?.length ? { errors: outcome.errors.slice(0, 5) } : {}),
  })
}

export async function runPreToolUseHooks(toolName, args, context = {}) {
  const hookConfig = loadHookConfigCached({ cwd: context.cwd || process.cwd() }).hooks
  const outcome = await runHooks({
    event: HOOK_EVENTS.PRE_TOOL_USE,
    toolName,
    hookConfig,
    payload: buildHookPayload({
      event: HOOK_EVENTS.PRE_TOOL_USE,
      toolName,
      toolArgs: args,
      sessionId: context.turnId || '',
      cwd: context.cwd || process.cwd(),
    }),
  })
  reportHookOutcome(HOOK_EVENTS.PRE_TOOL_USE, toolName, outcome)
  for (const error of outcome.errors || []) console.warn(`[hooks] PreToolUse: ${error}`)
  return outcome
}

/** 有没有配 PostToolUse？没配就完全不用付这次检查的成本。 */
export function hooksHavePostToolUse() {
  const { hooks } = loadHookConfigCached()
  return Array.isArray(hooks?.[HOOK_EVENTS.POST_TOOL_USE]) && hooks[HOOK_EVENTS.POST_TOOL_USE].length > 0
}

export async function runPostToolUseHooks(toolName, args, result, context = {}, preVerdict = null) {
  const hookConfig = loadHookConfigCached({ cwd: context.cwd || process.cwd() }).hooks
  const outcome = await runHooks({
    event: HOOK_EVENTS.POST_TOOL_USE,
    toolName,
    hookConfig,
    payload: buildHookPayload({
      event: HOOK_EVENTS.POST_TOOL_USE,
      toolName,
      toolArgs: args,
      toolResult: result,
      sessionId: context.turnId || '',
      cwd: context.cwd || process.cwd(),
    }),
  })
  reportHookOutcome(HOOK_EVENTS.POST_TOOL_USE, toolName, outcome)
  for (const error of outcome.errors || []) console.warn(`[hooks] PostToolUse: ${error}`)
  const contexts = [...(preVerdict?.contexts || []), ...(outcome.contexts || [])]
  return contexts.length > 0 ? appendHookContext(result, contexts) : null
}
