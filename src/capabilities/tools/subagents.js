// 子代理工具的推理期执行体（阶段 1）。
// 结果以普通工具结果回到父 Agent 手里——与 DSH 的 dsh-tool-subagent 一致。
import {
  runSubagentTask,
  spawnContinuableSubagent,
  deliverSubagentMessage,
  interruptSubagent,
  listSubagents,
  forgetSubagent,
  SUBAGENT_DEFAULT_TOOLS,
  getSubagentLimits,
} from '../../runtime/subagent-manager.js'
import { assertObjectSchema, JsonSchemaSubsetError } from '../../runtime/json-schema-lite.js'

// 回给父 Agent 的正文上限：子代理可能产出很长内容，但父对话的上下文是稀缺资源。
const MAX_RESULT_CHARS = 8000

function clip(text) {
  const value = String(text ?? '')
  if (value.length <= MAX_RESULT_CHARS) return value
  return `${value.slice(0, MAX_RESULT_CHARS)}\n…[truncated ${value.length - MAX_RESULT_CHARS} chars]`
}

function payload(extra) {
  return JSON.stringify(extra)
}

function normalizeTools(raw) {
  if (!Array.isArray(raw)) return null
  const names = raw.map(item => String(item || '').trim()).filter(Boolean)
  return names.length ? names : null
}

export async function execRunSubagent(args = {}, context = {}) {
  const prompt = String(args.prompt ?? '').trim()
  if (!prompt) {
    return payload({ ok: false, code: 'EMPTY_PROMPT', error: 'run_subagent requires a non-empty prompt' })
  }
  // schema 必须落在受支持的强制子集内：看不懂的关键字要当场拒绝，
  // 而不是「不认识的约束就当没写」——那样模型会以为约束生效了。
  if (args.result_schema !== undefined && args.result_schema !== null) {
    try {
      assertObjectSchema(args.result_schema)
    } catch (error) {
      if (!(error instanceof JsonSchemaSubsetError)) throw error
      return payload({
        ok: false,
        code: 'RESULT_SCHEMA_UNSUPPORTED',
        error: error.message,
        violations: error.violations,
        hint: `Supported keywords: type/properties/required/additionalProperties/items/enum/const/oneOf (+ description/title/default/examples). The root must be type "object".`,
      })
    }
  }
  const result = await runSubagentTask({
    prompt,
    description: String(args.description ?? '').trim(),
    model: typeof args.model === 'string' && args.model.trim() ? args.model.trim() : null,
    resultSchema: args.result_schema && typeof args.result_schema === 'object' ? args.result_schema : null,
    tools: normalizeTools(args.tools),
    inheritContext: args.inherit_context === true,
    parentContext: context,
    parentMessages: context.loopMessages || null,
  })

  if (!result.ok) {
    return payload({
      ok: false,
      code: result.schemaError ? 'RESULT_SCHEMA_INVALID' : 'SUBAGENT_FAILED',
      stop_reason: result.stopReason,
      ...(result.schemaError ? { schema_error: result.schemaError } : {}),
      ...(result.error ? { error: result.error } : {}),
      hint: result.schemaError
        ? 'The sub-agent answered, but not in the requested shape. Either retry with a clearer prompt, or drop result_schema and use prose.'
        : 'The sub-agent did not finish. Consider simplifying the task or splitting it.',
    })
  }

  return payload({
    ok: true,
    child_id: result.childId,
    steps: result.steps,
    tool_calls: result.toolCalls,
    duration_ms: result.durationMs,
    ...(result.structured !== null ? { result: result.structured } : { answer: clip(result.content) }),
  })
}

export async function execSpawnSubagent(args = {}, context = {}) {
  const prompt = String(args.prompt ?? '').trim()
  if (!prompt) {
    return payload({ ok: false, code: 'EMPTY_PROMPT', error: 'spawn_subagent requires a non-empty prompt' })
  }
  const result = await spawnContinuableSubagent({
    prompt,
    description: String(args.description ?? '').trim(),
    model: typeof args.model === 'string' && args.model.trim() ? args.model.trim() : null,
    tools: normalizeTools(args.tools),
    inheritContext: args.inherit_context === true,
    parentContext: context,
    parentMessages: context.loopMessages || null,
  })

  if (!result.ok) {
    return payload({
      ok: false,
      code: 'SUBAGENT_FAILED',
      child_id: result.childId,
      stop_reason: result.stopReason,
      ...(result.error ? { error: result.error } : {}),
      hint: 'The sub-agent is still registered; you may retry with subagent_message or stop it with subagent_interrupt.',
    })
  }

  return payload({
    ok: true,
    child_id: result.childId,
    status: result.status,
    steps: result.steps,
    tool_calls: result.toolCalls,
    duration_ms: result.durationMs,
    answer: clip(result.content),
    hint: 'Send follow-up work with subagent_message(child_id=...).',
  })
}

export async function execSubagentMessage(args = {}, context = {}) {
  const childId = String(args.child_id ?? '').trim()
  const message = String(args.message ?? '').trim()
  if (!childId || !message) {
    return payload({ ok: false, code: 'BAD_ARGS', error: 'subagent_message requires both child_id and message' })
  }
  const result = await deliverSubagentMessage({ childId, message, parentContext: context })
  if (!result.ok) return payload(result)
  if (result.queued) {
    return payload({
      ok: true,
      child_id: childId,
      queued: true,
      queued_count: result.queuedCount,
      hint: 'The sub-agent is still working; the message will run right after its current turn.',
    })
  }
  return payload({
    ok: result.ok,
    child_id: childId,
    status: result.status,
    stop_reason: result.stopReason,
    steps: result.steps,
    tool_calls: result.toolCalls,
    ...(result.structured !== null ? { result: result.structured } : { answer: clip(result.content) }),
  })
}

export async function execSubagentInterrupt(args = {}) {
  const childId = String(args.child_id ?? '').trim()
  if (!childId) {
    return payload({ ok: false, code: 'BAD_CHILD_ID', error: 'child_id is required' })
  }
  if (String(args.action || 'interrupt').trim().toLowerCase() === 'forget') {
    return payload(forgetSubagent({ childId }))
  }
  return payload(interruptSubagent({ childId }))
}

export async function execSubagentList(args = {}) {
  const subagents = listSubagents({ includeDone: args.include_done === true })
  return payload({
    ok: true,
    limits: getSubagentLimits(),
    default_tools: SUBAGENT_DEFAULT_TOOLS,
    count: subagents.length,
    subagents,
  })
}
