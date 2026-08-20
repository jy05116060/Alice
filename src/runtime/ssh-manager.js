// SSH 远程机器托管 —— 会话管理器（状态机 / 重连 / 机器 CRUD / RPC 方法表）。
//
// 这一层是**与 ssh2 解耦**的：真正的握手、exec、隧道通过注入的 `transport` 完成。
// 这样做的理由很实际——本机没有可用的 SSH 服务器，真实握手无法端到端验证；
// 但状态机、重连退避、事件缓冲、RPC 校验这些**与网络无关**的部分，
// 必须能被完整测到。把 transport 做成可注入的，测试就能用假 transport
// 走完全部状态流转，而不用假装"测过了 SSH"。

import fs from 'fs'
import path from 'path'
import { paths } from '../paths.js'
import {
  SshError, redacted, machineProfileOf, machinesOf, classifyConnectFailure,
  describeConnectFailure, EventRing, reconnectDelayMs, shouldGiveUp, RECONNECT_DEFAULTS,
  fingerprintHostKey,
} from './ssh-core.js'
import { readState, writeState } from './ssh-state.js'

/** 连接阶段的 phase 枚举。未知 id 报 `disconnected`。 */
export const PHASES = Object.freeze([
  'disconnected', 'testing', 'connecting', 'connected', 'reconnecting', 'given-up',
])

/** 会话默认参数（与 DSH ConfigSchema 默认值对齐）。 */
export const SESSION_DEFAULTS = Object.freeze({
  connectTimeoutMs: 15000,
  healthCheckTimeoutMs: 3000,
  healthPollIntervalMs: 1000,
  healthPollAttempts: 30,
  keepaliveIntervalMs: 10000,
  keepaliveCountMax: 3,
  reconnectInitialDelayMs: 1000,
  reconnectMaxDelayMs: 20000,
  reconnectMaxAttempts: 6,
  installTimeoutMs: 1800000,
})

/** 只读的机器视图：**永不含 password/passphrase**。 */
export function redactProfile(profile) {
  if (!profile) return undefined
  const { password, passphrase, ...rest } = profile
  return {
    ...rest,
    hasPassword: typeof password === 'string' && password !== '',
    hasPassphrase: typeof passphrase === 'string' && passphrase !== '',
  }
}

export class SshManager {
  /**
   * @param {object} options
   * @param {object} options.transport 真正的 SSH 实现（可注入假实现）
   * @param {object} [options.knownHosts] TOFU 存储
   * @param {string} [options.machinesPath] 覆盖 machines.json 路径（测试用）
   * @param {object} [options.timers] 定时器注入（测试里可同步推进）
   */
  constructor({ transport, knownHosts, machinesPath, timers, config = {} } = {}) {
    this.transport = transport
    this.knownHosts = knownHosts
    this.machinesPath = machinesPath ?? path.join(paths.userDir, 'ssh', 'machines.json')
    this.timers = timers ?? { setTimeout, clearTimeout }
    this.config = { ...SESSION_DEFAULTS, ...config }

    this.enabled = false
    this.profiles = new Map()
    this.rings = new Map()
    /** @type {Map<string, object>} 每机器运行时状态 */
    this.states = new Map()
    this.listeners = new Set()
  }

  // ── 事件分发 ──────────────────────────────────────────────────────────────

  /** 订阅状态变化（供 SSE / 轮询用）。返回退订函数。 */
  subscribe(listener) {
    this.listeners.add(listener)
    return () => this.listeners.delete(listener)
  }

  notify(machineId) {
    const view = this.status(machineId)
    for (const listener of this.listeners) {
      try { listener(machineId, view) } catch { /* 订阅者自己的异常不该影响状态机 */ }
    }
  }

  /** 追加一条事件到该机器的环形缓冲。**不持久化**。 */
  appendEvent(machineId, stage, line, extra = {}) {
    return this.ring(machineId).push({ stage, line, ...extra })
  }

  ring(machineId) {
    let ring = this.rings.get(machineId)
    if (!ring) { ring = new EventRing(machineId); this.rings.set(machineId, ring) }
    return ring
  }

  /** `since()` 语义。未知机器 → `{events:[], nextSeq:1}`。读取不改变状态。 */
  eventsSince(machineId, sinceSeq) {
    if (!this.profiles.has(machineId) && !this.rings.has(machineId)) {
      return { events: [], nextSeq: 1 }
    }
    return this.ring(machineId).since(sinceSeq)
  }

  // ── 清单加载 / 保存 ────────────────────────────────────────────────────────

  load() {
    let text
    try { text = fs.readFileSync(this.machinesPath, 'utf8') } catch { text = undefined }
    // 复用同一套容错：损坏/缺失 → 关闭 + 空清单，绝不抛。
    const state = (() => {
      if (typeof text !== 'string' || text === '') return { enabled: false, machines: {} }
      try {
        const parsed = JSON.parse(text)
        if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) return { enabled: false, machines: {} }
        return {
          enabled: parsed.enabled === true,
          machines: (typeof parsed.machines === 'object' && parsed.machines !== null && !Array.isArray(parsed.machines)) ? parsed.machines : {},
        }
      } catch { return { enabled: false, machines: {} } }
    })()

    this.enabled = state.enabled
    this.profiles = machinesOf(state.machines)
    return this
  }

  /** 返回写入磁盘的**原始**字典（含凭据，因为要能重连）。 */
  rawRows() {
    const rows = {}
    for (const [id, profile] of this.profiles) rows[id] = { ...profile }
    return rows
  }

  async persist() {
    const payload = { enabled: this.enabled, machines: this.rawRows() }
    await writeState(payload)
    return payload
  }

  // ── 机器 CRUD ─────────────────────────────────────────────────────────────

  requireProfile(machineId) {
    const profile = this.profiles.get(machineId)
    if (!profile) throw new SshError('machine-not-found', `no such machine: ${machineId}`)
    return profile
  }

  /** 保存一台机器。secrets 是**只写**的：空值表示「不改动已存凭据」。 */
  async save(machineId, row, secrets) {
    const existing = this.profiles.get(machineId)
    const merged = {
      ...(existing ?? {}),
      id: machineId,
      ...row,
      ...(secrets && typeof secrets.password === 'string' && secrets.password !== '' ? { password: secrets.password } : {}),
      ...(secrets && typeof secrets.passphrase === 'string' && secrets.passphrase !== '' ? { passphrase: secrets.passphrase } : {}),
    }
    const profile = machineProfileOf(merged)
    if (!profile) throw new Error('invalid row')
    if (profile.id !== machineId) throw new Error('invalid row: id')
    this.profiles.set(machineId, profile)
    await this.persist()
    this.notify(machineId)
    return {}
  }

  async remove(machineId) {
    await this.disconnect(machineId).catch(() => undefined)
    this.profiles.delete(machineId)
    this.rings.delete(machineId)
    this.states.delete(machineId)
    await this.persist()
    this.notify(machineId)
    return {}
  }

  list() {
    return [...this.profiles.values()].map((profile) => {
      const view = redactProfile(profile)
      const status = this.status(profile.id)
      return {
        ...view,
        state: status.state,
        ...(status.tunnelBaseUrl === undefined ? {} : { tunnelBaseUrl: status.tunnelBaseUrl }),
        ...(status.lastError === undefined ? {} : { lastError: status.lastError }),
        ...(status.dshMissing === true ? { dshMissing: true } : {}),
        ...(status.progress === undefined ? {} : { progress: status.progress }),
        ...(status.nextRetryAt === undefined ? {} : { nextRetryAt: status.nextRetryAt }),
        ...(status.authMethod === undefined ? {} : { authMethod: status.authMethod }),
      }
    })
  }

  // ── 状态机 ────────────────────────────────────────────────────────────────

  stateOf(machineId) {
    let state = this.states.get(machineId)
    if (!state) {
      state = { phase: 'disconnected', generation: 0 }
      this.states.set(machineId, state)
    }
    return state
  }

  /** 对外状态视图。未知 id → `disconnected`（不抛）。 */
  status(machineId) {
    const state = this.states.get(machineId)
    if (!state) return { state: 'disconnected' }
    return {
      state: state.phase,
      ...(state.link?.tunnelBaseUrl === undefined ? {} : { tunnelBaseUrl: state.link.tunnelBaseUrl }),
      ...(state.lastError === undefined ? {} : { lastError: state.lastError }),
      ...(state.dshMissing === true ? { dshMissing: true } : {}),
      ...(state.progress === undefined ? {} : { progress: state.progress }),
      ...(state.nextRetryAt === undefined ? {} : { nextRetryAt: state.nextRetryAt }),
      ...(state.authMethod === undefined ? {} : { authMethod: state.authMethod }),
    }
  }

  /** 重连循环期间，相关调用一律拒绝。 */
  refuseWhileReconnecting(machineId, state) {
    const rec = state.reconnect
    if (rec === undefined) return
    throw new SshError(
      'machine-reconnecting',
      `machine is reconnecting (attempt ${rec.attempt} of ${this.config.reconnectMaxAttempts}); wait for the automatic retry or disconnect first`,
    )
  }

  stopReconnect(state) {
    if (state.reconnect?.timer !== undefined) this.timers.clearTimeout(state.reconnect.timer)
    delete state.reconnect
    delete state.nextRetryAt
  }

  /** 进入 given-up 终态，lastError 汇总尝试次数与最后一次失败。 */
  giveUp(machineId, state) {
    const rec = state.reconnect
    this.stopReconnect(state)
    delete state.progress
    state.phase = 'given-up'
    const last = rec?.reasons[rec.reasons.length - 1] ?? state.lastError ?? 'connection failed'
    const raw = rec === undefined
      ? last
      : `connect failed after ${rec.reasons.length} attempt(s): ${last}`
    state.lastError = redacted(raw, this.profiles.get(machineId))
    this.notify(machineId)
    this.appendEvent(machineId, 'reconnect', state.lastError, { terminal: 'failed', reason: state.lastError })
  }

  /**
   * 安排下一次重连。退避 `min(initial * 2^(attempt-1), max)`；
   * `attempt > maxAttempts` 即放弃。
   */
  scheduleReconnect(machineId) {
    const state = this.stateOf(machineId)
    const rec = state.reconnect
    if (rec === undefined) return
    if (shouldGiveUp(rec.attempt, this.config)) {
      this.giveUp(machineId, state)
      return
    }
    const delay = reconnectDelayMs(rec.attempt, this.config)
    state.phase = 'reconnecting'
    state.nextRetryAt = Date.now() + delay
    this.notify(machineId)
    rec.timer = this.timers.setTimeout(() => {
      rec.timer = undefined
      rec.attempt += 1
      state.phase = 'connecting'
      this.attemptConnect(machineId).then(
        (link) => this.onReconnectSuccess(machineId, link),
        (error) => this.onReconnectFailure(machineId, error),
      )
    }, delay)
    // 定时器不该把进程钉住不退出。
    rec.timer?.unref?.()
  }

  onReconnectSuccess(machineId, link) {
    const state = this.states.get(machineId)
    if (!state?.reconnect) return
    this.stopReconnect(state)
    state.phase = 'connected'
    state.link = link
    delete state.lastError
    this.notify(machineId)
    this.appendEvent(machineId, 'reconnect', 'reconnected', { terminal: 'success' })
  }

  onReconnectFailure(machineId, error) {
    const state = this.states.get(machineId)
    const rec = state?.reconnect
    if (!state || !rec) return
    if ((error instanceof SshError && error.code === 'machine-dsh-missing') || state.dshMissing === true) {
      this.giveUp(machineId, state)
      return
    }
    rec.reasons.push(state.lastError ?? describeConnectFailure(classifyConnectFailure(error, false), error))
    this.scheduleReconnect(machineId)
  }

  /** 失败后把机器交给后台重连循环（调用方仍看到这次失败）。 */
  handToReconnect(machineId, error) {
    const state = this.stateOf(machineId)
    state.phase = 'reconnecting'
    state.lastError = redacted(describeConnectFailure(classifyConnectFailure(error, state.passwordOffered === true), error), this.profiles.get(machineId))
    state.generation += 1
    state.reconnect = { generation: state.generation, attempt: 1, reasons: [state.lastError], timer: undefined }
    this.appendEvent(machineId, 'reconnect', state.lastError, { terminal: 'failed', reason: state.lastError })
    this.scheduleReconnect(machineId)
  }

  // ── 连接 ──────────────────────────────────────────────────────────────────

  /** 真正走一次连接（交给 transport）。子类/测试可覆盖。 */
  async attemptConnect(machineId) {
    const profile = this.requireProfile(machineId)
    if (!this.transport) throw new SshError('machine-connect-failed', 'SSH transport is not available in this build')
    return this.transport.connect({
      profile,
      knownHosts: this.knownHosts,
      config: this.config,
      onEvent: (stage, line, extra) => this.appendEvent(machineId, stage, line, extra),
    })
  }

  /**
   * 建立（或复用）链路。幂等。失败时把机器交给后台重连循环，
   * 但**调用方这一次仍看到失败**——不能让 UI 以为连上了。
   */
  async connect(machineId) {
    const state = this.stateOf(machineId)
    this.requireProfile(machineId)
    if (state.link !== undefined) return state.link
    this.refuseWhileReconnecting(machineId, state)

    state.phase = 'connecting'
    delete state.lastError
    delete state.dshMissing
    state.progress = { phase: 'handshake' }
    this.notify(machineId)

    try {
      const link = await this.attemptConnect(machineId)
      state.link = link
      state.phase = 'connected'
      delete state.progress
      if (link?.authMethod !== undefined) state.authMethod = link.authMethod
      this.notify(machineId)
      return link
    } catch (error) {
      delete state.progress
      state.phase = 'disconnected'
      state.lastError = redacted(
        describeConnectFailure(classifyConnectFailure(error, state.passwordOffered === true), error),
        this.profiles.get(machineId),
      )
      this.notify(machineId)
      this.handToReconnect(machineId, error)
      throw error instanceof SshError
        ? new SshError(error.code, redacted(error.message, this.profiles.get(machineId)))
        : new SshError('machine-connect-failed', state.lastError)
    }
  }

  /** 连通性测试：**不建隧道**。 */
  async test(machineId) {
    const state = this.stateOf(machineId)
    const profile = this.requireProfile(machineId)
    this.refuseWhileReconnecting(machineId, state)
    state.phase = 'testing'
    this.notify(machineId)
    try {
      if (!this.transport) throw new SshError('machine-connect-failed', 'SSH transport is not available in this build')
      const session = await this.transport.connect({ profile, knownHosts: this.knownHosts, config: this.config, tunnel: false })
      try {
        const banner = await session.banner?.()
        return { ok: true, banner: typeof banner === 'string' ? banner.trim() : '' }
      } finally {
        await session.close?.().catch?.(() => undefined)
      }
    } catch (error) {
      return {
        ok: false,
        message: redacted(
          error instanceof SshError ? error.message : describeConnectFailure(classifyConnectFailure(error, false), error),
          profile,
        ),
      }
    } finally {
      if (state.phase === 'testing') state.phase = state.link ? 'connected' : 'disconnected'
      this.notify(machineId)
    }
  }

  async disconnect(machineId) {
    const state = this.states.get(machineId)
    if (!state) return {}
    this.stopReconnect(state)
    const link = state.link
    state.link = undefined
    state.phase = 'disconnected'
    delete state.lastError
    delete state.progress
    await link?.close?.().catch?.(() => undefined)
    this.notify(machineId)
    return {}
  }

  /** 关闭全部机器（进程退出时调用）。不阻塞退出。 */
  async closeAll() {
    await Promise.all([...this.states.keys()].map((id) => this.disconnect(id).catch(() => undefined)))
  }
}
