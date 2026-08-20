// 工作流编排引擎（阶段 2，对齐 DSH `dsh-workflow-ptc`）。
//
// 模型写一段纯 JS 脚本，脚本里只能调五个钩子（外加 args 全局），真正的活由
// 阶段 1 的子代理去干：
//   agent(prompt, opts?)        跑一个子代理；带 schema 返回校验过的对象，失败返回 null
//   pipeline(items, ...stages)  每个 item 独立走完整条 stage 链（stage 之间**没有**栅栏）
//   parallel(thunks)            并发跑一批零参函数，全部等到（栅栏）
//   phase(title)                设定后续 agent() 的进度分组
//   log(message)                进度播报
//
// **致命 vs null 的纪律**（这是整套设计的关键）：
//   · 传错参数、未知选项、超限、schema 不合规 → 致命错误，整个脚本失败，
//     组合器会把它重新抛出（打错一个选项名必须响亮地死）。
//   · 子代理自己跑失败、stage 内部普通报错 → 只有那一个 item 变 null。
//
// 隔离：脚本跑在 node:vm 的空白上下文里（没有 require / process / console /
// setTimeout），钩子函数去掉原型链并冻结，参数与返回值一律走 JSON 往返，
// 保证脚本手里只有本 realm 的原生对象。
//
// 诚实声明：这是**约定与误伤防护**，不是对抗恶意代码的安全边界。脚本作者就是
// 模型自己，它本来就能通过普通工具读写文件、执行命令，权限不比逃逸后更小。

import vm from 'node:vm'
import { config } from '../config.js'
import { emitEvent } from '../events.js'
import { runSubagentTask } from './subagent-manager.js'
import { assertObjectSchema, JsonSchemaSubsetError } from './json-schema-lite.js'
import {
  beginWorkflowRun,
  endWorkflowRun,
  noteWorkflowPhase,
  noteWorkflowLog,
  noteWorkflowAgentStart,
  noteWorkflowAgentEnd,
} from './workflow-runs.js'

/** 工作流失败。所有 code 默认致命；fatal 字段让「组合器要不要重抛」显式化。 */
export class WorkflowError extends Error {
  constructor(message, code, { fatal = true } = {}) {
    super(message)
    this.name = 'WorkflowError'
    this.code = code
    this.fatal = fatal
  }
}

/** 进程内同时**后台**跑的工作流上限（run_in_background:true）。前台运行不吃这份额度。 */
export const MAX_BACKGROUND_WORKFLOWS = 4

export const WORKFLOW_LIMITS_DEFAULT = Object.freeze({
  /** 并发 agent() 上限。 */
  maxConcurrentAgents: 8,
  /** 单次运行的 agent() 总数上限（跑飞兜底）。 */
  maxTotalAgents: 64,
  /** 单次 parallel()/pipeline() 接受的 item 数上限。 */
  maxItemsPerCall: 4096,
  /** 脚本初始同步片段的 VM 超时（DSH 同语义：只管同步段）。 */
  syncTimeoutMs: 5000,
  /** 整轮墙钟上限。DSH 由宿主负责取消，爱丽丝在turn 内跑，所以必须自己兜。 */
  deadlineMs: 15 * 60 * 1000,
  /** 脚本长度上限。 */
  maxScriptChars: 200000,
})

const SUPPORTED_AGENT_OPTIONS = new Set(['label', 'phase', 'schema', 'provider', 'model'])
// DSH 明确点名的「暂不支持」选项，报错信息里要单独说清楚。
const DEFERRED_AGENT_OPTIONS = new Set(['effort', 'isolation', 'agentType'])

let runSequence = 0

// ── 严格物化：把 realm 值拷成宿主侧的纯 JSON 数据 ────────────────────────────

class MaterializeError extends Error {
  constructor(path, reason) {
    super(`${path}: ${reason}`)
    this.name = 'MaterializeError'
  }
}

// realm 无关的「普通对象」判定：原型为 null，或原型的原型为 null（各 realm 的
// Object.prototype）。Date / Map / class 实例的原型链更长，一律拒绝。
function hasPlainPrototype(value) {
  const proto = Object.getPrototypeOf(value)
  if (proto === null) return true
  return Object.getPrototypeOf(proto) === null
}

function materializeFromRealm(value, root = 'value') {
  if (value === undefined) return undefined
  return materialize(value, root, new Set())
}

function materialize(value, path, seen) {
  switch (typeof value) {
    case 'boolean':
    case 'string':
      return value
    case 'number':
      if (!Number.isFinite(value) || Object.is(value, -0)) {
        throw new MaterializeError(path, 'non-finite numbers are not JSON data')
      }
      return value
    case 'bigint': throw new MaterializeError(path, 'bigints are not JSON data')
    case 'function': throw new MaterializeError(path, 'functions are not plain JSON data')
    case 'symbol': throw new MaterializeError(path, 'symbols are not plain JSON data')
    case 'undefined': throw new MaterializeError(path, 'undefined is not JSON data')
    case 'object': break
    default: throw new MaterializeError(path, `unsupported value type ${typeof value}`)
  }
  if (value === null) return null
  if (seen.has(value)) throw new MaterializeError(path, 'circular references are not JSON data')
  seen.add(value)
  try {
    if (Array.isArray(value)) {
      const out = []
      for (let index = 0; index < value.length; index++) {
        if (!(index in value)) throw new MaterializeError(`${path}[${index}]`, 'sparse arrays are not JSON data')
        out.push(materialize(value[index], `${path}[${index}]`, seen))
      }
      if (Object.getOwnPropertySymbols(value).length > 0) {
        throw new MaterializeError(path, 'symbol-keyed properties are not plain JSON data')
      }
      return out
    }
    if (!hasPlainPrototype(value)) {
      throw new MaterializeError(path, 'only plain objects and arrays are JSON data (exotic prototype)')
    }
    if (Object.getOwnPropertySymbols(value).length > 0) {
      throw new MaterializeError(path, 'symbol-keyed properties are not plain JSON data')
    }
    const out = {}
    for (const key of Object.keys(value)) {
      out[key] = materialize(value[key], `${path}.${key}`, seen)
    }
    return out
  } finally {
    seen.delete(value)
  }
}

function renderThrown(error) {
  try {
    const stack = error?.stack
    if (typeof stack === 'string' && stack.length > 0) return stack
    const message = error?.message
    if (typeof message === 'string' && message.length > 0) return message
    return String(error)
  } catch {
    return '[unrenderable thrown value]'
  }
}

// 只取第一行消息：回给模型的是可读的一句话，不是整段 stack。
function cleanMessage(error) {
  try {
    const message = error?.message
    if (typeof message === 'string' && message.length > 0) return message
    return String(error)
  } catch {
    return '[unrenderable thrown value]'
  }
}

// 脚本 realm 里抛出的错误靠这个标记区分「致命」——宿主侧 instanceof 跨 realm 不成立。
function isFatalFromRealm(error) {
  try {
    return error?.fatal === true && typeof error?.code === 'string'
  } catch {
    return false
  }
}

function defaultLabel(prompt) {
  const newline = String(prompt).indexOf('\n')
  const line = newline === -1 ? String(prompt) : String(prompt).slice(0, newline)
  return line.length <= 48 ? line : `${line.slice(0, 47)}…`
}

// 钩子函数去掉原型链并冻结：脚本拿不到 host Function，构造器逃逸这条路被堵住。
function harden(fn) {
  Object.setPrototypeOf(fn, null)
  return Object.freeze(fn)
}

// ── 一次运行的执行体 ───────────────────────────────────────────────────────

class WorkflowRun {
  constructor({ runId, meta, limits, observer, parentContext, signal, runAgent, streamOnceForTest, slotPool = null }) {
    this.runId = runId
    this.meta = meta
    this.limits = limits
    this.observer = observer
    this.parentContext = parentContext
    this.runAgent = runAgent
    this.streamOnceForTest = streamOnceForTest
    // 进程级的并发名额池（**只有后台运行传**，见 backgroundSlotPool）。
    // null = 用运行自己的 activeSlots 记账（前台的原有语义，一个字节不改）。
    this.slotPool = slotPool
    this.started = 0
    this.activeSlots = 0
    this.slotWaiters = []
    this.currentPhase = undefined
    this.aborted = null
    this.controller = new AbortController()
    if (signal) {
      if (signal.aborted) this.controller.abort('parent aborted')
      else signal.addEventListener('abort', () => this.controller.abort('parent aborted'), { once: true })
    }

    this.compiled = null
    this.context = null
  }

  compile(prefixLines, body) {
    const source = `${prefixLines.join('\n')}\n${body}\n})()`
    try {
      this.compiled = new vm.Script(source, {
        filename: `workflow:${this.meta.name}`,
        // 让报错行号指回脚本自己的第 1 行，而不是我们拼进去的前缀。
        lineOffset: -prefixLines.length,
      })
    } catch (error) {
      throw new WorkflowError(`workflow script does not parse: ${renderThrown(error)}`, 'SCRIPT_PARSE')
    }
  }

  buildContext(prefixLines, args, body) {
    // 空白上下文：脚本只有本 realm 的原生对象 + 我们放进去的桥。
    // 关掉动态代码生成，堵住 realm 侧 eval / new Function 这条路。
    this.context = vm.createContext({}, {
      name: `workflow:${this.meta.name}`,
      codeGeneration: { strings: false, wasm: false },
    })
    this.context.__BLM_ARGS__ = JSON.stringify(args === undefined ? null : args)
    this.context.__BLM_BRIDGE__ = this.buildBridge()
    // node:vm 会给上下文自动塞一个 console，它的输出会直接落到爱丽丝主进程的日志里。
    // 脚本要播报进度就用 log()（会进思考流），所以这里把 console 遮掉，避免日志被刷。
    // 注意：console 不是 sandbox 的自有属性（delete 无效），只能赋值覆盖。
    this.context.console = undefined
    this.compile(prefixLines, body)
  }

  buildBridge() {
    const bridge = Object.create(null)
    bridge.agent = harden((prompt, opts) => this.envelope(() => this.realmAgent(prompt, opts)))
    bridge.parallel = harden(thunks => this.envelope(() => this.realmParallel(thunks)))
    bridge.pipeline = harden((items, stages) => this.envelope(() => this.realmPipeline(items, stages)))
    // phase/log 在契约里是**同步**钩子（脚本不 await 它们），所以走同步信封：
    // 参数写错必须当场抛出，能被脚本的 try/catch 抓到，而不是变成 unhandled rejection。
    bridge.phase = harden(title => this.envelopeSync(() => this.realmPhase(title)))
    bridge.log = harden(message => this.envelopeSync(() => this.realmLog(message)))
    return Object.freeze(bridge)
  }

  errorEnvelope(error) {
    const isWorkflowError = error instanceof WorkflowError
    // 能走到信封这一层的都是钩子层面的失败：宿主侧意外错误一律致命，
    // 只有 realm 里显式标了 fatal:false 的才算普通错误。
    const fatal = isWorkflowError ? error.fatal : error?.fatal !== false
    const code = isWorkflowError
      ? error.code
      : (typeof error?.code === 'string' && error.code ? error.code : 'SCRIPT_ERROR')
    return {
      ok: false,
      code: String(code),
      fatal: fatal === true,
      message: isWorkflowError ? error.message : cleanMessage(error),
    }
  }

  // 钩子一律返回 JSON 信封，让 realm 侧包装器自己解析/抛错——这样脚本手里的
  // 值、异常全是本 realm 的原生对象，跨 realm 的 instanceof 陷阱也就不存在了。
  async envelope(fn) {
    try {
      const value = await fn()
      return JSON.stringify({ ok: true, value: value === undefined ? null : value })
    } catch (error) {
      return JSON.stringify(this.errorEnvelope(error))
    }
  }

  envelopeSync(fn) {
    try {
      const value = fn()
      return JSON.stringify({ ok: true, value: value === undefined ? null : value })
    } catch (error) {
      return JSON.stringify(this.errorEnvelope(error))
    }
  }

  async drive() {
    try {
      const scriptPromise = this.compiled.runInContext(this.context, { timeout: this.limits.syncTimeoutMs })
      const raw = await contain(Promise.resolve(scriptPromise))
      if (raw === undefined) {
        return { value: null, stopReason: 'completed', agentsStarted: this.started, error: null, errorCode: null }
      }
      return {
        value: this.materializeResult(raw),
        stopReason: 'completed',
        agentsStarted: this.started,
        error: null,
        errorCode: null,
      }
    } catch (error) {
      return {
        value: null,
        stopReason: 'error',
        // 单行消息回给模型；完整 stack 留在 detail 里便于排查。
        error: cleanMessage(error),
        detail: renderThrown(error),
        // 致命钩子错误（参数写错 / 超限 / schema 越界）穿过脚本时保留它自己的错误码。
        errorCode: typeof error?.code === 'string' ? error.code : null,
        agentsStarted: this.started,
      }
    }
  }

  materializeResult(raw) {
    try {
      return materializeFromRealm(raw, 'workflow result')
    } catch (error) {
      if (!(error instanceof MaterializeError)) throw error
      throw new WorkflowError(
        `the workflow's return value is not plain JSON data — ${error.message}. Return only JSON-serializable objects/arrays/scalars.`,
        'RESULT_UNSERIALIZABLE',
      )
    }
  }

  acquireSlot() {
    // 后台运行：名额从**进程级**池子里领。每个运行各记各的账会让 N 条后台运行
    // 各自都能同时跑满 maxConcurrentAgents（4×8=32 个子代理），那是对上限的绕过。
    if (this.slotPool) return this.slotPool.acquire()
    if (this.activeSlots < this.limits.maxConcurrentAgents) {
      this.activeSlots += 1
      return Promise.resolve()
    }
    return new Promise((resolve) => {
      this.slotWaiters.push(() => {
        this.activeSlots += 1
        resolve()
      })
    })
  }

  releaseSlot() {
    // 与 acquireSlot 对称：领池子的必须还池子，否则名额只出不进，引擎会自己饿死。
    if (this.slotPool) {
      this.slotPool.release()
      return
    }
    this.activeSlots -= 1
    const next = this.slotWaiters.shift()
    if (next) next()
  }

  // ── agent(prompt, opts) ─────────────────────────────────────────────────
  async realmAgent(rawPrompt, rawOpts) {
    if (typeof rawPrompt !== 'string' || rawPrompt.length === 0) {
      throw new WorkflowError('agent() requires a non-empty prompt string', 'INVALID_ARGUMENT')
    }
    const opts = this.readAgentOptions(rawOpts)
    if (this.started >= this.limits.maxTotalAgents) {
      throw new WorkflowError(
        `this run reached its total agent cap (${this.limits.maxTotalAgents}) — a runaway-loop backstop; raise workflow.maxTotalAgents if the scale is intentional`,
        'AGENT_CAP',
      )
    }
    this.started += 1
    const seq = this.started
    const label = opts.label ?? defaultLabel(rawPrompt)
    const phase = opts.phase ?? this.currentPhase

    // 面板登记：**发起时**就记一条，这样一次长扇出在运行途中也能看到「哪几项在跑」。
    // 纯观测（失败不影响运行），而且只写进程内登记表——SSE 事件与执行语义保持不变。
    // 子代理返回后 observer.agentStart 会带 childId 再报一次，登记表按 seq 去重。
    try {
      noteWorkflowAgentStart(this.runId, { seq, label, ...(phase !== undefined ? { phase } : {}) })
    } catch { /* 观测失败不影响运行 */ }

    await this.acquireSlot()
    try {
      let result
      try {
        result = await this.runAgent({
          prompt: rawPrompt,
          schema: opts.schema,
          model: opts.model,
          label,
          parentContext: this.parentContext,
          signal: this.controller.signal,
          streamOnceForTest: this.streamOnceForTest,
        })
      } catch (error) {
        if (error instanceof WorkflowError) throw error
        throw new WorkflowError(`agent() could not start a child: ${renderThrown(error)}`, 'AGENT_START')
      }

      const info = { seq, label, ...(phase !== undefined ? { phase } : {}), childId: result?.childId || null }
      this.observer.agentStart(info)
      const finish = outcome => this.observer.agentEnd({ ...info, outcome })

      if (!result || result.stopReason !== 'completed') {
        finish('failed')
        return null
      }
      if (opts.schema !== undefined) {
        // 带 schema 却没拿到合规结构化结果 → 这个子代理算失败（DSH 同语义）。
        if (result.structured === undefined) {
          finish('failed')
          return null
        }
        finish('completed')
        return result.structured
      }
      finish('completed')
      return result.text
    } finally {
      this.releaseSlot()
    }
  }

  readAgentOptions(rawOpts) {
    if (rawOpts === undefined || rawOpts === null) return {}
    let opts
    try {
      opts = materializeFromRealm(rawOpts, 'agent() options')
    } catch (error) {
      if (!(error instanceof MaterializeError)) throw error
      throw new WorkflowError(`agent() options must be plain JSON data — ${error.message}`, 'INVALID_ARGUMENT')
    }
    if (typeof opts !== 'object' || opts === null || Array.isArray(opts)) {
      throw new WorkflowError('agent() options must be an object', 'INVALID_ARGUMENT')
    }
    for (const key of Object.keys(opts)) {
      if (SUPPORTED_AGENT_OPTIONS.has(key)) continue
      if (DEFERRED_AGENT_OPTIONS.has(key)) {
        throw new WorkflowError(
          `agent() option "${key}" is deferred and not supported by this engine (supported: ${[...SUPPORTED_AGENT_OPTIONS].join(', ')})`,
          'UNSUPPORTED_OPTION',
        )
      }
      throw new WorkflowError(
        `agent() option "${key}" is not recognized (supported: ${[...SUPPORTED_AGENT_OPTIONS].join(', ')})`,
        'UNSUPPORTED_OPTION',
      )
    }
    for (const key of ['label', 'phase', 'provider', 'model']) {
      if (opts[key] !== undefined && typeof opts[key] !== 'string') {
        throw new WorkflowError(`agent() option "${key}" must be a string`, 'INVALID_ARGUMENT')
      }
    }
    // 爱丽丝的对话循环绑定当前 provider；跨 provider 覆盖不在这里悄悄降级，
    // 而是明确报错，免得脚本以为换了模型其实没换。
    if (opts.provider !== undefined && opts.provider !== config.provider) {
      throw new WorkflowError(
        `agent() provider override is not supported (configured provider is "${config.provider}"); pass model only`,
        'UNSUPPORTED_OPTION',
      )
    }
    let schema
    if (opts.schema !== undefined) {
      try {
        assertObjectSchema(opts.schema)
        schema = opts.schema
      } catch (error) {
        if (!(error instanceof JsonSchemaSubsetError)) throw error
        throw new WorkflowError(`agent() schema is outside the supported subset — ${error.message}`, 'UNSUPPORTED_SCHEMA')
      }
    }
    return {
      ...opts.label !== undefined ? { label: opts.label } : {},
      ...opts.phase !== undefined ? { phase: opts.phase } : {},
      ...opts.model !== undefined ? { model: opts.model } : {},
      ...schema !== undefined ? { schema } : {},
    }
  }

  // ── parallel(thunks) ───────────────────────────────────────────────────
  async realmParallel(rawThunks) {
    if (!Array.isArray(rawThunks)) {
      throw new WorkflowError('parallel() requires an array of zero-argument functions', 'INVALID_ARGUMENT')
    }
    this.assertItemCap(rawThunks.length, 'parallel()')
    rawThunks.forEach((thunk, index) => {
      if (typeof thunk !== 'function') {
        throw new WorkflowError(`parallel() item ${index} is not a function`, 'INVALID_ARGUMENT')
      }
    })
    const settled = await Promise.all(rawThunks.map(async (thunk) => {
      try {
        return { ok: true, value: await thunk() }
      } catch (error) {
        // 致命错误重新抛出，让整个 Promise.all 失败（脚本响亮地死）；
        // 普通错误只有这一项变 null。
        if (error instanceof WorkflowError || isFatalFromRealm(error)) throw error
        return { ok: false, value: null }
      }
    }))
    return settled.map(entry => entry.value)
  }

  // ── pipeline(items, ...stages) ─────────────────────────────────────────
  async realmPipeline(rawItems, rawStages) {
    if (!Array.isArray(rawItems)) {
      throw new WorkflowError('pipeline() requires an items array', 'INVALID_ARGUMENT')
    }
    this.assertItemCap(rawItems.length, 'pipeline()')
    if (!Array.isArray(rawStages) || rawStages.length === 0) {
      throw new WorkflowError('pipeline() requires at least one stage function', 'INVALID_ARGUMENT')
    }
    rawStages.forEach((stage, index) => {
      if (typeof stage !== 'function') {
        throw new WorkflowError(`pipeline() stage ${index} is not a function`, 'INVALID_ARGUMENT')
      }
    })
    // 每个 item 独立走完整条链，stage 之间没有栅栏：慢 item 不阻塞别人。
    const settled = await Promise.all(rawItems.map(async (item, index) => {
      try {
        let value = item
        for (const stage of rawStages) value = await stage(value, item, index)
        return { ok: true, value }
      } catch (error) {
        if (error instanceof WorkflowError || isFatalFromRealm(error)) throw error
        return { ok: false, value: null }
      }
    }))
    return settled.map(entry => entry.value)
  }

  assertItemCap(length, hook) {
    if (length > this.limits.maxItemsPerCall) {
      throw new WorkflowError(
        `${hook} received ${length} items — over the per-call cap (${this.limits.maxItemsPerCall}); split the work or raise workflow.maxItemsPerCall`,
        'ITEM_CAP',
      )
    }
  }

  realmPhase(title) {
    if (typeof title !== 'string' || title.length === 0) {
      throw new WorkflowError('phase() requires a non-empty title string', 'INVALID_ARGUMENT')
    }
    this.currentPhase = title
    this.observer.phase(title)
  }

  realmLog(message) {
    if (typeof message !== 'string') {
      throw new WorkflowError('log() requires a message string', 'INVALID_ARGUMENT')
    }
    this.observer.log(message)
  }
}

// 挂一个空的 rejection 消费者：脚本把 promise 丢掉时，宿主的 rejection 不能
// 变成 unhandled rejection 把进程带走；脚本自己 await 时照样能看到 rejection。
function contain(promise) {
  promise.catch(() => {})
  return promise
}

// 脚本前缀：把桥包成 realm 原生 API，并把 args 物化到本 realm。
const PROLOGUE_LINES = [
  '(async () => {',
  'const __bridge = __BLM_BRIDGE__;',
  'const __unwrap = (raw) => {',
  '  const env = JSON.parse(raw);',
  '  if (env.ok) return env.value;',
  '  const err = new Error(env.message);',
  '  err.code = env.code;',
  '  err.fatal = env.fatal === true;',
  '  throw err;',
  '};',
  'globalThis.args = JSON.parse(__BLM_ARGS__);',
  'globalThis.agent = async (prompt, opts) => __unwrap(await __bridge.agent(prompt, opts));',
  'globalThis.parallel = async (thunks) => __unwrap(await __bridge.parallel(thunks));',
  'globalThis.pipeline = async (items, ...stages) => __unwrap(await __bridge.pipeline(items, stages));',
  'globalThis.phase = (title) => { __unwrap(__bridge.phase(title)); };',
  'globalThis.log = (message) => { __unwrap(__bridge.log(message)); };',
]

/** 校验 meta（DSH：缺字段/类型错一律是致命错误）。 */
export function validateWorkflowMeta(meta) {
  if (!meta || typeof meta !== 'object' || Array.isArray(meta)) {
    throw new WorkflowError('workflow meta must be an object', 'INVALID_META')
  }
  const name = typeof meta.name === 'string' ? meta.name.trim() : ''
  if (!name) throw new WorkflowError('workflow meta.name is required', 'INVALID_META')
  if (!/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(name)) {
    throw new WorkflowError('workflow meta.name must be kebab-case (e.g. "audit-repos")', 'INVALID_META')
  }
  const description = typeof meta.description === 'string' ? meta.description.trim() : ''
  if (!description) throw new WorkflowError('workflow meta.description is required', 'INVALID_META')
  const phases = meta.phases === undefined ? undefined : meta.phases
  if (phases !== undefined) {
    if (!Array.isArray(phases)) throw new WorkflowError('workflow meta.phases must be an array', 'INVALID_META')
    phases.forEach((phase, index) => {
      if (!phase || typeof phase !== 'object' || typeof phase.title !== 'string' || !phase.title.trim()) {
        throw new WorkflowError(`workflow meta.phases[${index}].title is required`, 'INVALID_META')
      }
    })
  }
  return {
    name,
    description,
    ...(typeof meta.whenToUse === 'string' && meta.whenToUse.trim() ? { whenToUse: meta.whenToUse.trim() } : {}),
    ...(phases ? { phases: phases.map(p => ({ title: String(p.title), ...(typeof p.detail === 'string' ? { detail: p.detail } : {}) })) } : {}),
  }
}

function resolveLimits(overrides = null) {
  const configured = config.workflow && typeof config.workflow === 'object' ? config.workflow : {}
  const pick = (key, fallback, { min = 1 } = {}) => {
    const raw = overrides?.[key] ?? configured[key]
    const value = Number(raw)
    return Number.isSafeInteger(value) && value >= min ? value : fallback
  }
  return {
    maxConcurrentAgents: Math.min(
      pick('maxConcurrentAgents', WORKFLOW_LIMITS_DEFAULT.maxConcurrentAgents),
      // 不能超过子代理自身的存活上限，否则并发到一半就撞 SUBAGENT_LIMIT。
      Math.max(1, Number(config.subagent?.maxActive) || 8),
    ),
    maxTotalAgents: pick('maxTotalAgents', WORKFLOW_LIMITS_DEFAULT.maxTotalAgents),
    maxItemsPerCall: pick('maxItemsPerCall', WORKFLOW_LIMITS_DEFAULT.maxItemsPerCall),
    syncTimeoutMs: pick('syncTimeoutMs', WORKFLOW_LIMITS_DEFAULT.syncTimeoutMs),
    deadlineMs: pick('deadlineMs', WORKFLOW_LIMITS_DEFAULT.deadlineMs),
    maxScriptChars: pick('maxScriptChars', WORKFLOW_LIMITS_DEFAULT.maxScriptChars),
  }
}

/**
 * 跑一段工作流脚本。
 * @param {object} [options]
 * @param {(info: {runId: string, abort: (reason?: string) => void}) => void} [options.onStarted]
 *   运行对象一建好就同步回调一次（此时尚未开始执行）。后台形态用它拿到
 *   「怎么中止这一轮」，以便进程退出时能安全收尾。前台调用不需要传。
 * @param {boolean} [options.unrefDeadline]
 *   让墙钟兜底计时器不要撑住事件循环（**只有后台形态该传 true**）。语义见下面
 *   deadline 的注释：没人 await 的那一轮，不能把进程的退出权攥在手里。
 * @param {object} [options.slotPool]
 *   进程级并发名额池（**只有后台形态该传**，见 backgroundSlotPool）。传了就由池子
 *   统一分配 agent 并发名额；不传就用本运行自己的账本（前台的原有语义）。
 * @returns {Promise<{ok:boolean, code?:string, error?:string, value?:unknown, agentsStarted?:number,
 *   stopReason?:string, durationMs?:number, phases?:string[], runId?:string}>}
 */
export async function runWorkflow({
  script,
  meta,
  args = null,
  parentContext = {},
  signal = null,
  limits: limitOverrides = null,
  onEvent = null,
  onStarted = null,
  unrefDeadline = false,
  slotPool = null,
  _streamOnceForTest = null,
  _runAgentForTest = null,
} = {}) {
  const emit = (type, payload) => {
    try {
      emitEvent(type, payload)
    } catch { /* 观测失败绝不影响运行本身 */ }
    try {
      onEvent?.({ type, ...payload })
    } catch { /* 同上 */ }
  }

  let validatedMeta
  try {
    validatedMeta = validateWorkflowMeta(meta)
  } catch (error) {
    return { ok: false, code: error.code || 'INVALID_META', error: error.message }
  }

  const body = typeof script === 'string' ? script : ''
  if (!body.trim()) return { ok: false, code: 'EMPTY_SCRIPT', error: 'workflow script must be a non-empty string' }

  const limits = resolveLimits(limitOverrides)
  if (body.length > limits.maxScriptChars) {
    return {
      ok: false,
      code: 'SCRIPT_TOO_LARGE',
      error: `workflow script is ${body.length} chars — over the cap (${limits.maxScriptChars})`,
    }
  }

  runSequence += 1
  const runId = `wf-${Date.now().toString(36)}-${runSequence}`
  const startedAt = Date.now()
  const phasesSeen = []
  const logs = []

  // 进程内的运行登记（阶段 3.4，工作流面板的数据源）。纯观测：只读记录，
  // 不改任何执行语义，失败也绝不影响运行本身（与 emit 同一纪律）。
  // 这个登记是**内存态**、重启即清空——面板会如实写明这一点。
  beginWorkflowRun({
    runId,
    name: validatedMeta.name,
    description: validatedMeta.description,
    phases: validatedMeta.phases || [],
    limits,
  })

  const observer = {
    phase: (title) => {
      if (!phasesSeen.includes(title)) phasesSeen.push(title)
      try { noteWorkflowPhase(runId, title) } catch { /* 观测失败不影响运行 */ }
      emit('workflow_phase', { run_id: runId, name: validatedMeta.name, title })
    },
    log: (message) => {
      logs.push(message)
      try { noteWorkflowLog(runId, message) } catch { /* 同上 */ }
      emit('workflow_log', { run_id: runId, name: validatedMeta.name, message })
    },
    agentStart: (info) => {
      try { noteWorkflowAgentStart(runId, info) } catch { /* 同上 */ }
      emit('workflow_agent_start', { run_id: runId, name: validatedMeta.name, ...info })
    },
    agentEnd: (info) => {
      try { noteWorkflowAgentEnd(runId, info) } catch { /* 同上 */ }
      emit('workflow_agent_end', { run_id: runId, name: validatedMeta.name, ...info })
    },
  }

  const runAgent = _runAgentForTest || (async ({ prompt, schema, model, label, parentContext: ctx, signal: sig, streamOnceForTest }) => {
    const result = await runSubagentTask({
      prompt,
      description: label || '',
      model: model || null,
      resultSchema: schema || null,
      // 子代理管理器的约定是 signal 走 parentContext，而这里必须换成**工作流自己的**
      // controller.signal：否则父级中断只会停掉工作流外壳，内部子代理照样跑到底。
      parentContext: { ...ctx, signal: sig },
      _streamOnceForTest: streamOnceForTest,
    })
    // 子代理容量撞上限属于「引擎资源不够」，是致命问题，不能悄悄变成 null。
    if (!result.ok && result.code === 'SUBAGENT_LIMIT') {
      throw new WorkflowError(result.error || 'subagent capacity exhausted', 'AGENT_CAP')
    }
    if (!result.ok) {
      return { stopReason: result.stopReason || 'error', structured: undefined, text: '', childId: result.childId || null }
    }
    return {
      stopReason: 'completed',
      structured: result.structured === null ? undefined : result.structured,
      text: result.content || '',
      childId: result.childId || null,
    }
  })

  const run = new WorkflowRun({
    runId, meta: validatedMeta, limits, observer, parentContext, signal,
    runAgent, streamOnceForTest: _streamOnceForTest, slotPool,
  })

  // 后台启动器要能在退出时**同步**中止这一轮（前台调用方不需要，所以是可选钩子）。
  if (typeof onStarted === 'function') {
    try {
      onStarted({ runId, abort: (reason = 'background workflow aborted') => { run.controller.abort(reason) } })
    } catch { /* 启动钩子失败不影响这轮运行本身 */ }
  }

  emit('workflow_start', {
    run_id: runId,
    name: validatedMeta.name,
    description: validatedMeta.description,
    phases: validatedMeta.phases || [],
    limits,
  })

  let result
  try {
    run.buildContext(PROLOGUE_LINES, args, body)
  } catch (error) {
    const code = error instanceof WorkflowError ? error.code : 'SCRIPT_PARSE'
    emit('workflow_end', { run_id: runId, name: validatedMeta.name, status: 'error', code })
    // 脚本没编译起来也是**一次失败的运行**：面板要能看到它，而不是只看到「跑过的」。
    try {
      endWorkflowRun(runId, { ok: false, code, error: error.message })
    } catch { /* 观测失败不影响运行 */ }
    return { ok: false, code, error: error.message, runId }
  }

  let deadlineHit = false
  let timer = null
  const deadline = new Promise((resolve) => {
    // 刻意不 unref()：墙钟兜底计时器必须能撑住事件循环。脚本如果卡在一个
    // 永不 settle 的 promise 上，事件循环里就没有别的 handle 了，unref 掉会让
    // 进程直接判定「顶层 await 未完成」而退出，兜底也就永远不会触发。
    // 正常结束时会在 finally 里 clearTimeout，不会留下悬挂 handle。
    //
    // **后台形态是唯一的例外**（unrefDeadline）：那时「有没有人在等这一轮」的答案
    // 是「没有」。一个被永久卡住的后台运行如果还攥着这只 15 分钟的计时器，进程就
    // 退不出去——退出收尾钩子（process 'exit'）根本没机会跑，用户看到的是「关不掉」。
    // unref 之后：进程没有别的事要干就正常退出，退出时由 process 'exit' 钩子同步
    // abort 掉这一轮；只要后台运行还在做真事（子代理的网络/IO handle 还在），
    // 事件循环就活着，它照样跑到底。前台运行一个字节都不改。
    timer = setTimeout(() => {
      deadlineHit = true
      try { run.controller.abort('workflow deadline exceeded') } catch { /* 已结束 */ }
      resolve(null)
    }, limits.deadlineMs)
    if (unrefDeadline && typeof timer.unref === 'function') timer.unref()
  })

  try {
    const drivePromise = run.drive()
    const outcome = await Promise.race([drivePromise, deadline])
    if (deadlineHit || outcome === null) {
      result = {
        ok: false,
        code: 'WORKFLOW_TIMEOUT',
        error: `workflow exceeded its wall-clock deadline (${limits.deadlineMs} ms); children were aborted`,
      }
    } else if (outcome.stopReason !== 'completed') {
      result = {
        ok: false,
        code: outcome.errorCode || 'WORKFLOW_SCRIPT_ERROR',
        error: outcome.error,
        ...(outcome.detail ? { detail: outcome.detail } : {}),
      }
    } else {
      result = { ok: true, value: outcome.value, stopReason: 'completed', agentsStarted: outcome.agentsStarted }
    }
  } catch (error) {
    // 致命钩子错误（参数写错、超限、schema 不合规）会一路抛到这里。
    const code = error instanceof WorkflowError ? error.code : 'WORKFLOW_SCRIPT_ERROR'
    result = { ok: false, code, error: error instanceof WorkflowError ? error.message : renderThrown(error) }
  } finally {
    if (timer) clearTimeout(timer)
  }

  const durationMs = Math.max(0, Date.now() - startedAt)
  const final = {
    ...result,
    runId,
    name: validatedMeta.name,
    agentsStarted: result.agentsStarted ?? run.started,
    durationMs,
    phases: phasesSeen,
    logs,
    limits,
  }
  emit('workflow_end', {
    run_id: runId,
    name: validatedMeta.name,
    status: final.ok ? 'completed' : 'error',
    code: final.code || null,
    agents_started: final.agentsStarted,
    duration_ms: durationMs,
    phases: phasesSeen,
  })
  // 结算登记：失败/超时/被上限截断都如实记下来（面板不能只显示「完成」）。
  try {
    endWorkflowRun(runId, {
      ok: final.ok === true,
      code: final.code || null,
      error: final.error || null,
      agentsStarted: final.agentsStarted,
      durationMs,
    })
  } catch { /* 观测失败不影响运行 */ }
  return final
}

// ── 后台运行（run_in_background）─────────────────────────────────────────────
//
// 这一层只做「不阻塞本轮」：引擎怎么跑、限额怎么算，一个字都不改——后台运行走的
// 就是同一个 runWorkflow()，也就自动继承了同一套 slot 机制（acquireSlot/releaseSlot）
// 与同一份 concurrency 上限。绕开引擎另起一套「后台执行」等于把上限变装饰。
//
// 三条纪律：
//   1) 立刻返回：登记发生在 runWorkflow() 内部、第一个 await 之前，所以这里同步就能
//      拿到 runId 与 status='running'，不必等它跑完。
//   2) 异常绝不冒泡：runWorkflow 自己是全兜住的（脚本错误走返回值），但**观测层**
//      仍可能抛（写登记表失败、emitEvent 失败）。这里再加一道 catch，并且连 catch
//      处理器本身也包起来——一个未捕获的 rejection 会直接带走进程（Node 默认
//      --unhandled-rejections=throw）。
//   3) 退出要安全：不注册任何监听器、不留定时器；后台运行的收尾逻辑（clearTimeout）
//      本来就在 runWorkflow 的 finally 里（**故意不 unref** 的那个墙钟兜底也在那儿被清掉）。
//      进程要退出时，调用方同步调 terminateBackgroundWorkflowsForExit() 中止扇出，
//      退出路径上没有任何 await、没有悬挂的 handle。
//
// **诚实声明**：运行状态与结果只留在**本进程内**的登记表里（workflow-runs.js）。
// 进程一重启就查不到了——这不是持久队列，没有断点续跑，也没有跨重启的 run id。

/** runId → 后台运行启动器。只保留「还在跑」的；terminate 与正常结束都会删掉。 */
const backgroundRuns = new Map()

/**
 * **进程级**并发名额池，后台运行专用。
 *
 * 为什么必须有它：引擎原本的排班（activeSlots / slotWaiters）是**每个运行各记各的账**。
 * 一次前台运行独占整个对话轮，所以「每运行一份」就等于「进程一份」。后台形态打破了这个
 * 前提——4 条后台运行同时扇出时，各自的账本互不相干，进程里就会同时有 4×8 = 32 个子代理
 * 在跑。子代理管理器自己的 maxActive 能兜住最坏情况（第 11 个会抛 SUBAGENT_LIMIT，
 * 那是致命错误，会把整轮运行打断），但工作流层声明的「并发上限」就形同虚设了。
 *
 * 所以后台运行统统从这个池子里领名额：池子大小 = 引擎解析出来的 maxConcurrentAgents
 * （和前台同一个口径：config.workflow.maxConcurrentAgents 与 config.subagent.maxActive
 * 取小）。前台运行不受影响——它仍然是自己的账本，一个字节没改。
 */
const backgroundSlotPool = (() => {
  let capacity = 0
  let active = 0
  const waiters = []
  return {
    /**
     * 校准池子容量。每次后台启动都会调一次（配置可能热更新，测试也会临时改 limits）。
     *
     * 只调容量，**不动已经发出去的名额**：正在跑的那几项是上一次按当时上限批的，
     * 中途把它们踢回去只会让运行停在一个莫名其妙的中间态。容量变大时，等在队列里
     * 的人按 FIFO 立刻拿到新放出来的票；容量变小时，已经在跑的就让它跑完，
     * 后续 acquire 按新上限排队。额度只少不多，绝不会短暂超编。
     */
    setCapacity(next) {
      capacity = Number.isSafeInteger(next) && next > 0 ? next : 1
      while (waiters.length && active < capacity) {
        active += 1
        waiters.shift()()
      }
    },
    acquire() {
      if (active < capacity) {
        active += 1
        return Promise.resolve()
      }
      return new Promise((resolve) => { waiters.push(resolve) })
    },
    release() {
      const next = waiters.shift()
      if (next) {
        // 名额直接转手，不经过 active：减一再加一，池子里的额度不会漏。
        next()
        return
      }
      if (active > 0) active -= 1
    },
    /** 仅测试用：把池子清空（跑完的运行必须先放掉自己的票）。 */
    reset() {
      capacity = 0
      active = 0
      waiters.length = 0
    },
    stats() {
      return { capacity, active, waiting: waiters.length }
    },
  }
})()

/** 后台运行当前占用的并发名额（诊断用）。 */
export function backgroundSlotStats() {
  return backgroundSlotPool.stats()
}

/** 后台运行的 run id。校验形状，免得别的东西被当成 run id 去查登记表。 */
export function isWorkflowRunId(value) {
  return /^wf-[a-z0-9]+-\d+$/.test(String(value ?? ''))
}

/**
 * 后台启动一次工作流：立刻返回 run id 与已登记状态，引擎在后台继续驱动。
 *
 * @returns {{ok:boolean, runId?:string, status?:string, name?:string, code?:string, error?:string,
 *   concurrency?:number, background_running?:number, background_limit?:number}}
 */
export function startWorkflowInBackground({
  script,
  meta,
  args = null,
  parentContext = {},
  signal = null,
  limits: limitOverrides = null,
  onEvent = null,
  // 测试注入口与前台 runWorkflow 保持同名同义（否则「后台形态」就成了唯一测不到的那条路径）。
  _streamOnceForTest = null,
  _runAgentForTest = null,
} = {}) {
  const active = activeBackgroundCount()
  if (active >= MAX_BACKGROUND_WORKFLOWS) {
    return {
      ok: false,
      code: 'WORKFLOW_BACKGROUND_LIMIT',
      error: `this process already has ${active} background workflows running (limit ${MAX_BACKGROUND_WORKFLOWS}); wait for one to finish (workflow_status) or run this one in the foreground`,
      background_running: active,
      background_limit: MAX_BACKGROUND_WORKFLOWS,
    }
  }

  // entry 先建出来：onStarted 是**同步**回调（runWorkflow 里建的，早于它自己的第一个 await），
  // 所以这个回调一定在下面的 return 之前跑完，entry.terminate 也就一定已经挂好了。
  const entry = { runId: null, terminate: null, aborted: false }

  // 名额池的容量按**这次**解析出来的并发上限校准（配置可能热更新，测试也会临时改）。
  backgroundSlotPool.setCapacity(resolveLimits(limitOverrides).maxConcurrentAgents)

  // **刻意不 await**：这就是后台的全部含义。promise 一定被下面的 then/catch 消费掉。
  const promise = runWorkflow({
    script, meta, args, parentContext, signal, limits: limitOverrides, onEvent,
    // 后台运行不能阻止进程退出：见 runWorkflow 里 unrefDeadline 的注释。
    unrefDeadline: true,
    // 并发名额从**进程级**池子里领，而不是各运行一份账本（见 backgroundSlotPool）。
    slotPool: backgroundSlotPool,
    _streamOnceForTest,
    _runAgentForTest,
    onStarted: ({ runId, abort }) => {
      entry.runId = runId
      entry.terminate = abort
    },
  })

  const runId = entry.runId
  if (!isWorkflowRunId(runId)) {
    // 校验在登记之前就失败了（缺 meta / 空脚本 / 超长脚本）：那不是后台运行，
    // 是一次**立刻就知道失败**的调用。把结论原样交回给调用方，别假装有个 run id。
    return promise.then(result => ({
      ok: false,
      code: result?.code || 'WORKFLOW_START_FAILED',
      error: result?.error || 'the workflow was rejected before it could start',
      runId: null,
      background_running: activeBackgroundCount(),
      background_limit: MAX_BACKGROUND_WORKFLOWS,
    }), () => ({
      ok: false,
      code: 'WORKFLOW_START_FAILED',
      error: 'the workflow was rejected before it could start',
      runId: null,
      background_running: activeBackgroundCount(),
      background_limit: MAX_BACKGROUND_WORKFLOWS,
    }))
  }

  entry.runId = runId
  backgroundRuns.set(runId, entry)
  // 安全收尾：结算这个 entry 自己的记录。**只有 entry 还在 Map 里（仍等于自己）时才删**——
  // 否则一次已经逃逸的旧运行结束时，会把同 id 的新 entry 误删（run id 里带时间戳+序号，
  // 现实中撞不上，但这条守卫让「删错东西」在结构上不可能）。
  const settle = () => {
    if (backgroundRuns.get(runId) === entry) backgroundRuns.delete(runId)
  }
  promise.then(settle, settle)
  // 异常已经在上面的 then/catch 里被消费掉了；这里只做「顺手记一笔」。
  promise.catch(() => {})

  return Promise.resolve({
    ok: true,
    runId,
    status: 'running',
    name: typeof meta?.name === 'string' ? meta.name : null,
    concurrency: resolveLimits(limitOverrides).maxConcurrentAgents,
    background_running: activeBackgroundCount(),
    background_limit: MAX_BACKGROUND_WORKFLOWS,
  })
}

function activeBackgroundCount() {
  let count = 0
  for (const entry of backgroundRuns.values()) if (!entry.aborted) count += 1
  return count
}

/** 还有几次后台运行在跑（给状态查询用；不会暴露脚本内容）。 */
export function backgroundWorkflowCount() {
  return activeBackgroundCount()
}

/**
 * 退出时的安全收尾：把后台运行的子代理中止掉，避免一次正在跑的扇出把退出拖住。
 *
 * 签名与 subagent-manager 的 terminateSubagentsForExit 同形（**同步**）：调用方在
 * 「要退出了」的时刻同步调用，这里只做同步的 abort，真正的清理交给进程退出。
 * 刻意**不**清空 Map：清空之后 workflow_status 会把「刚被中止的这一次」报成
 * 「没这个 run」（not found），那是在撒谎——它明明还在登记表里。
 * 中止之后运行会自己走完收尾，登记表随之落到 error。
 */
export function terminateBackgroundWorkflowsForExit(reason = 'process exiting') {
  let aborted = 0
  for (const entry of backgroundRuns.values()) {
    if (entry.aborted) continue
    entry.aborted = true
    aborted += 1
    try {
      entry.terminate?.(reason)
    } catch { /* 收尾失败绝不能变成新的异常 */ }
  }
  return aborted
}

// 挂上退出收尾（与 capabilities/tools/shell.js 的 process.once('exit', ...) 同一条纪律：
// 模块被 import 就自动生效，不需要 index.js 记得来调）。**惰性**：只中止「退出那一刻
// 还在跑」的后台运行；正常结束的运行早就从 Map 里摘掉了，所以绝大多数退出这里是空转。
// 只做同步 abort，不在退出路径上 await 任何东西——退出不能被一次扇出拖住。
process.once('exit', () => { try { terminateBackgroundWorkflowsForExit('process exit') } catch { /* 见上 */ } })
