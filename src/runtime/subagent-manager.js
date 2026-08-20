// 进程内子代理管理器（阶段 1，对齐 DSH subagent）。
//
// 与既有 delegate_to_agent 的区别：那是**冷启动外部进程**（Claude Code / Codex），
// 一次性、无共享上下文、无法追问。这里是**同进程内的子智能体**：
//   · 拥有独立对话历史与独立工具集，与主对话互不污染；
//   · 可一次性（one-shot）拿一个结果，也可续期（continuable）反复追问；
//   · 可 fork 继承父会话已完成的轮次；
//   · 启动时**快照权限作用域**，不可在内部提权（子代理永不弹审批卡）。
//
// 限制：maxDepth（默认 1，即只有主 Agent 能派活）、maxActive（默认 8，
// 存活的续期子代理数）。子代理崩溃或跑飞都不会影响父会话。

import { config } from '../config.js'
import { emitEvent } from '../events.js'
import { runAgentLoop } from '../llm.js'
import { validateJsonSchema, describeSchemaErrors } from './json-schema-lite.js'
import {
  SUBAGENT_MODE,
  SUBAGENT_STATUS,
  saveSubagentSession,
  loadSubagentSession,
  listSubagentRows,
  deleteSubagentSession,
} from './subagent-store.js'

export const MAX_SUBAGENT_DEPTH_DEFAULT = 1
export const MAX_ACTIVE_SUBAGENTS_DEFAULT = 8
export const MAX_SUBAGENT_STEPS_DEFAULT = 24

// 子代理默认工具集：够用（读写/命令/检索/记忆）但刻意**不含**通信工具
// （对用户发消息是父 Agent 的职责）、不含委派工具（杜绝递归提权）、
// 不含安装/授权/浏览器接管类高风险能力。
export const SUBAGENT_DEFAULT_TOOLS = Object.freeze([
  'read_file',
  'list_dir',
  'write_file',
  'edit_file',
  'make_dir',
  'delete_file',
  'run_command',
  'web_search',
  'web_read',
  'search_memory',
  'probe_memory',
])

const active = new Map() // childId → { controller, status, meta, pending: [] }
let sequence = 0

function nextChildId() {
  sequence += 1
  return `sa-${Date.now().toString(36)}-${sequence}`
}

function maxDepth() {
  const value = Number(config.subagent?.maxDepth)
  return Number.isSafeInteger(value) && value >= 0 ? value : MAX_SUBAGENT_DEPTH_DEFAULT
}

function maxActive() {
  const value = Number(config.subagent?.maxActive)
  return Number.isSafeInteger(value) && value > 0 ? value : MAX_ACTIVE_SUBAGENTS_DEFAULT
}

function runningCount() {
  let count = 0
  for (const entry of active.values()) if (entry.status === SUBAGENT_STATUS.RUNNING) count += 1
  return count
}

export function getSubagentLimits() {
  return { maxDepth: maxDepth(), maxActive: maxActive(), running: runningCount(), resident: active.size }
}

function systemPromptFor({ description, resultSchema }) {
  const lines = [
    'You are a focused sub-agent working inside Alice on a single delegated task.',
    'You have your own conversation and a small tool set; you cannot message the user directly —',
    'your final answer is returned to the parent agent as the tool result.',
    'Work autonomously: use the tools you have, verify real results, then answer.',
    'Keep the final answer concise and factual; state only what you actually verified.',
  ]
  if (description) lines.push(`Your assignment: ${description}`)
  if (resultSchema) {
    lines.push(
      'Finish with a single JSON value that satisfies the requested schema, and nothing else.',
      `Requested schema: ${JSON.stringify(resultSchema)}`,
    )
  }
  return lines.join('\n')
}

function emit(type, payload) {
  try { emitEvent(type, payload) } catch { /* 观测失败绝不影响任务本身 */ }
}

function toolContextFor({ childId, depth, signal, signalParent }) {
  return {
    // 子代理身份与深度：用于递归拦截与审计
    subagent: true,
    subagentId: childId,
    subagentDepth: depth,
    // 关键：子代理永不弹审批卡，也不继承父级的自主/授权标志
    signal,
    signalParent,
    autonomous: false,
    allowHighRiskAutonomy: false,
    currentChannel: 'SUBAGENT',
    currentUserMessage: '',
  }
}

async function runTurn({ childId, depth, mode, description, messages, prompt, tools, model, temperature, resultSchema, signal, _streamOnceForTest = null }) {
  const entry = active.get(childId)
  const controller = new AbortController()
  const onOuterAbort = () => controller.abort('parent aborted')
  if (signal) {
    if (signal.aborted) controller.abort('parent aborted')
    else signal.addEventListener('abort', onOuterAbort, { once: true })
  }
  if (entry) entry.controller = controller
  if (entry) entry.status = SUBAGENT_STATUS.RUNNING

  emit('subagent_start', {
    child_id: childId, depth, mode,
    description: description || '',
    model: model || config.model,
  })
  saveSubagentSession({
    childId, mode, status: SUBAGENT_STATUS.RUNNING,
    provider: config.provider, model: model || config.model,
    description: description || '', messages, parentSession: null, depth,
    toolCalls: entry?.meta?.toolCalls || 0,
  })

  const startedAt = Date.now()
  // 种子历史 + 本轮新消息（续期时 messages 是上一轮的完整对话，prompt 是新的追问）。
  const seed = Array.isArray(messages) && messages.length
    ? messages.map(item => ({ ...item }))
    : []
  if (String(prompt || '').trim()) seed.push({ role: 'user', content: String(prompt) })

  let loopResult
  try {
    loopResult = await runAgentLoop({
      systemPrompt: systemPromptFor({ description, resultSchema }),
      messages: seed.length ? seed : null,
      tools,
      model: model || config.model,
      temperature: typeof temperature === 'number' ? temperature : 0.4,
      signal: controller.signal,
      toolContext: toolContextFor({ childId, depth, signal: controller.signal, signalParent: signal }),
      maxSteps: MAX_SUBAGENT_STEPS_DEFAULT,
      _streamOnceForTest,
      onActivity: (activity) => {
        emit('subagent_activity', { child_id: childId, depth, ...activity })
      },
    })
  } finally {
    if (signal) signal.removeEventListener('abort', onOuterAbort)
  }

  const durationMs = Math.max(0, Date.now() - startedAt)
  const summary = String(loopResult.content || '').slice(0, 300)

  // 结构化结果：schema 校验失败不当作任务成功，把违规清单原样回给父 Agent。
  let structured = null
  let schemaError = null
  if (resultSchema && loopResult.ok && loopResult.stopReason === 'finished') {
    let parsed = null
    try {
      const text = String(loopResult.content || '').trim()
      const fenced = text.match(/```(?:json)?\s*([\s\S]*?)```/)
      parsed = JSON.parse(fenced ? fenced[1].trim() : text)
    } catch {
      schemaError = 'the final answer was not parseable JSON'
    }
    if (!schemaError) {
      const check = validateJsonSchema(parsed, resultSchema)
      if (check.valid) structured = parsed
      else schemaError = describeSchemaErrors(check.errors)
    }
  }

  // 状态语义：
  //   一次性子代理   → 成功即 DONE（从默认名册消失，历史仍在库里）
  //   可续期子代理   → 成功即 IDLE（等下一次 subagent_message；schema 不合规也算
  //                    这一轮结束，父级可以发一条纠正消息，所以仍是 IDLE）
  // 真正的执行失败/被中断两边都是 ERROR，留在名册里可见。
  let status
  if (!loopResult.ok || loopResult.stopReason === 'aborted') {
    status = SUBAGENT_STATUS.ERROR
  } else if (mode === SUBAGENT_MODE.CONTINUABLE) {
    status = SUBAGENT_STATUS.IDLE
  } else {
    status = SUBAGENT_STATUS.DONE
  }

  if (entry) {
    entry.status = status
    entry.controller = null
    entry.meta.toolCalls = (entry.meta.toolCalls || 0) + loopResult.toolCalls
  }
  saveSubagentSession({
    childId, mode, status,
    provider: config.provider, model: model || config.model,
    description: description || '', messages: loopResult.messages, parentSession: null, depth,
    toolCalls: entry?.meta?.toolCalls || 0,
  })

  emit('subagent_end', {
    child_id: childId, depth, status,
    stop_reason: loopResult.stopReason,
    duration_ms: durationMs,
    tool_calls: loopResult.toolCalls,
    summary,
    ...(schemaError ? { schema_error: schemaError } : {}),
  })

  return {
    childId, status, ok: loopResult.ok && !schemaError,
    stopReason: loopResult.stopReason,
    content: loopResult.content,
    structured,
    schemaError,
    error: loopResult.error || null,
    steps: loopResult.steps,
    toolCalls: loopResult.toolCalls,
    durationMs,
    messages: loopResult.messages,
  }
}

function ensureCanSpawn(depth) {
  if (depth >= maxDepth()) {
    return `subagent depth limit reached (maxDepth=${maxDepth()}); a sub-agent at depth ${depth} cannot create another`
  }
  if (runningCount() >= maxActive()) {
    return `too many sub-agents running (maxActive=${maxActive()}); wait for one to finish`
  }
  return null
}

/**
 * 一次性子代理：跑完一个任务并把最终答案交回父 Agent。
 * @param {object} params
 * @param {string} params.prompt 交给子代理的任务
 * @param {object} [params.parentContext] 父级工具上下文（取深度、signal）
 * @param {string[]} [params.tools] 覆盖默认工具集
 */
export async function runSubagentTask({
  prompt,
  description = '',
  model = null,
  temperature = null,
  resultSchema = null,
  tools = null,
  inheritContext = false,
  parentContext = {},
  parentMessages = null,
  // signal 通常随 parentContext 传递（工具上下文的老约定）。显式参数是给
  // 非工具调用方（如工作流引擎）用的：它们没有工具上下文，却有自己的取消源。
  signal = null,
  _streamOnceForTest = null,
} = {}) {
  const depth = (Number(parentContext.subagentDepth) || 0) + 1
  const gate = ensureCanSpawn(depth - 1)
  if (gate) return { ok: false, code: 'SUBAGENT_LIMIT', error: gate }

  const childId = nextChildId()
  const allowedTools = Array.isArray(tools) && tools.length ? tools : SUBAGENT_DEFAULT_TOOLS

  // 默认全新上下文（对齐 DSH：子代理不共享父对话）。只有显式 inherit_context
  // 才把父级已完成轮次作为种子，形成 fork。
  const seed = selectSeedMessages(inheritContext ? parentMessages : null)

  active.set(childId, {
    controller: null,
    status: SUBAGENT_STATUS.RUNNING,
    meta: { depth, mode: SUBAGENT_MODE.ONESHOT, description, toolCalls: 0 },
    pending: [],
  })
  try {
    return await runTurn({
      childId, depth, mode: SUBAGENT_MODE.ONESHOT,
      description: description || String(prompt || '').slice(0, 120),
      messages: seed, prompt, tools: allowedTools,
      model, temperature, resultSchema,
      signal: signal || parentContext.signal,
      _streamOnceForTest,
    })
  } finally {
    active.delete(childId)
  }
}

// 只挑出能安全作为种子的纯文本轮次（跳过 tool 协议条目与函数调用 Item）。
function selectSeedMessages(parentMessages) {
  if (!Array.isArray(parentMessages) || parentMessages.length === 0) return []
  return parentMessages
    .filter(item => (item.role === 'system' || item.role === 'user' || item.role === 'assistant')
      && typeof item.content === 'string' && item.content.trim())
    .slice(-20)
    .map(item => ({ role: item.role, content: item.content }))
}

/**
 * 可续期子代理：返回稳定 child id，之后可以用 deliverSubagentMessage 反复追问。
 */
export async function spawnContinuableSubagent({
  prompt,
  description = '',
  model = null,
  temperature = null,
  tools = null,
  inheritContext = false,
  parentContext = {},
  parentMessages = null,
  signal = null,
  _streamOnceForTest = null,
} = {}) {
  const depth = (Number(parentContext.subagentDepth) || 0) + 1
  const gate = ensureCanSpawn(depth - 1)
  if (gate) return { ok: false, code: 'SUBAGENT_LIMIT', error: gate }

  const childId = nextChildId()
  const allowedTools = Array.isArray(tools) && tools.length ? tools : SUBAGENT_DEFAULT_TOOLS
  const seed = selectSeedMessages(inheritContext ? parentMessages : null)

  active.set(childId, {
    controller: null,
    status: SUBAGENT_STATUS.RUNNING,
    meta: { depth, mode: SUBAGENT_MODE.CONTINUABLE, description, toolCalls: 0, model, temperature, tools: allowedTools, _streamOnceForTest },
    pending: [],
  })

  const turn = await runTurn({
    childId, depth, mode: SUBAGENT_MODE.CONTINUABLE,
    description: description || String(prompt || '').slice(0, 120),
    messages: seed, prompt, tools: allowedTools,
    model, temperature, signal: signal || parentContext.signal,
    _streamOnceForTest,
  })

  drainPending(childId)
  return { ...turn, childId }
}

// 续期子代理空闲时，立刻消费排队的消息（消息不丢、也不并发跑同一子代理）。
function drainPending(childId) {
  const entry = active.get(childId)
  if (!entry || entry.status === SUBAGENT_STATUS.RUNNING) return
  const next = entry.pending.shift()
  if (!next) return
  void continueTurn(childId, next)
}

async function continueTurn(childId, message) {
  const entry = active.get(childId)
  if (!entry) return { ok: false, code: 'NO_SUCH_SUBAGENT', error: `no live sub-agent ${childId}` }
  const stored = loadSubagentSession(childId)
  const messages = stored?.messages || []
  const turn = await runTurn({
    childId,
    depth: entry.meta.depth,
    mode: SUBAGENT_MODE.CONTINUABLE,
    description: entry.meta.description,
    messages, prompt: message,
    tools: entry.meta.tools,
    model: entry.meta.model,
    temperature: entry.meta.temperature,
    signal: entry.signal,
    _streamOnceForTest: entry.meta._streamOnceForTest || null,
  })
  drainPending(childId)
  return turn
}

/**
 * 给续期子代理发消息。空闲时立即开跑；正在跑时排队（不丢消息）。
 */
export async function deliverSubagentMessage({ childId, message, parentContext = {}, _streamOnceForTest = null } = {}) {
  const id = String(childId || '').trim()
  if (!id) return { ok: false, code: 'BAD_CHILD_ID', error: 'child_id is required' }
  const entry = active.get(id)
  if (!entry) {
    const stored = loadSubagentSession(id)
    if (!stored) return { ok: false, code: 'NO_SUCH_SUBAGENT', error: `unknown sub-agent ${id}` }
    if (stored.mode !== SUBAGENT_MODE.CONTINUABLE) {
      return { ok: false, code: 'NOT_CONTINUABLE', error: `sub-agent ${id} was one-shot and cannot be continued` }
    }
    // 冷恢复：进程重启后重建一个活的续期子代理，从落盘历史继续
    active.set(id, {
      controller: null,
      status: SUBAGENT_STATUS.IDLE,
      meta: { depth: stored.depth, mode: SUBAGENT_MODE.CONTINUABLE, description: stored.description, toolCalls: stored.toolCalls, model: null, temperature: null, tools: SUBAGENT_DEFAULT_TOOLS, _streamOnceForTest },
      pending: [],
      signal: parentContext.signal,
    })
    emit('subagent_start', { child_id: id, depth: stored.depth, mode: SUBAGENT_MODE.CONTINUABLE, description: stored.description, resumed: true })
  }
  const live = active.get(id)

  if (live.status === SUBAGENT_STATUS.RUNNING) {
    if (live.pending.length >= 8) {
      return { ok: false, code: 'SUBAGENT_QUEUE_FULL', error: `sub-agent ${id} already has 8 queued messages` }
    }
    live.pending.push(String(message || ''))
    return { ok: true, childId: id, queued: true, queuedCount: live.pending.length }
  }

  live.signal = parentContext.signal
  return continueTurn(id, String(message || ''))
}

export function interruptSubagent({ childId } = {}) {
  const id = String(childId || '').trim()
  const entry = active.get(id)
  if (!entry) return { ok: false, code: 'NO_SUCH_SUBAGENT', error: `no live sub-agent ${id}` }
  const wasRunning = entry.status === SUBAGENT_STATUS.RUNNING
  try { entry.controller?.abort('interrupted by parent') } catch { /* 已结束 */ }
  entry.pending.length = 0
  entry.status = SUBAGENT_STATUS.IDLE
  emit('subagent_end', { child_id: id, status: 'interrupted', interrupted: true })
  return { ok: true, childId: id, interrupted: wasRunning }
}

/**
 * 子代理名册：合并「活的进程内实例」与「落盘历史」，不加载/不唤醒它们。
 */
export function listSubagents({ includeDone = false } = {}) {
  const persisted = listSubagentRows({ includeDone })
  const seen = new Set()
  const out = persisted.map((row) => {
    seen.add(row.childId)
    const live = active.get(row.childId)
    return {
      ...row,
      live: Boolean(live),
      status: live ? live.status : row.status,
      queued: live ? live.pending.length : 0,
    }
  })
  for (const [childId, entry] of active) {
    if (seen.has(childId)) continue
    out.push({
      childId, mode: entry.meta.mode, status: entry.status,
      provider: config.provider, model: entry.meta.model || config.model,
      description: entry.meta.description, parentSession: null,
      depth: entry.meta.depth, toolCalls: entry.meta.toolCalls || 0,
      createdAt: null, updatedAt: null, live: true, queued: entry.pending.length,
    })
  }
  return out
}

export function forgetSubagent({ childId } = {}) {
  const id = String(childId || '').trim()
  if (!id) return { ok: false, code: 'BAD_CHILD_ID', error: 'child_id is required' }
  active.delete(id)
  deleteSubagentSession(id)
  return { ok: true, childId: id }
}
