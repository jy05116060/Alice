// SSH 远程机器托管 —— 持久化与 TOFU 主机密钥存储。
//
// 两个文件，都在 `<USER_DIR>/ssh/` 下：
//   machines.json      机器清单 + enabled 总开关
//   known-hosts.json   TOFU 主机密钥（首次信任）
//
// 设计要点（都是行为契约，不是风格）：
//  - **读绝不抛**：SSH 托管默认关闭，一个损坏的 JSON 不能让整个 API 起不来。
//    读失败一律回落 `{enabled:false, machines:{}}`。
//  - **写是原子的**：同目录临时文件 + rename。直接覆写会在断电/崩溃时留下
//    半截文件，而下次读又会把它当成「没有机器」——用户的机器清单就这么没了。
//  - **权限收紧**：known-hosts 目录 0o700、文件 0o600。里面有主机公钥指纹与
//    机器凭据（machines.json 存密码），同机其他用户不该读得到。
//    Windows 上 mode 基本无效，但写下去无害，且在 Linux/macOS 上是真生效的。

import fs from 'fs'
import fsp from 'fs/promises'
import path from 'path'
import crypto from 'crypto'
import { paths } from '../paths.js'
import { parseStateFile, machinesOf, fingerprintHostKey } from './ssh-core.js'

/** SSH 数据目录。惰性求值：paths 在 import 时已 resolve，但测试会改 env。 */
function sshDir() {
  return path.join(paths.userDir, 'ssh')
}

export function machinesFile() {
  return path.join(sshDir(), 'machines.json')
}

export function knownHostsFile() {
  return path.join(sshDir(), 'known-hosts.json')
}

/** 同目录临时文件 + rename 的原子写。目录 0o700、文件 0o600。 */
async function writeFileAtomic(filename, content) {
  await fsp.mkdir(path.dirname(filename), { recursive: true, mode: 0o700 })
  const temp = `${filename}.${crypto.randomBytes(6).toString('hex')}.tmp`
  try {
    await fsp.writeFile(temp, content, { mode: 0o600, flag: 'wx' })
    await fsp.rename(temp, filename)
  } catch (error) {
    await fsp.rm(temp, { force: true }).catch(() => undefined)
    throw error
  }
}

// ── 机器清单 ────────────────────────────────────────────────────────────────

/**
 * 读机器清单。**任何失败都回落「关闭 + 空清单」**，不抛。
 * @returns {{enabled:boolean, machines:object}}
 */
export function readStateSync() {
  try {
    return parseStateFile(fs.readFileSync(machinesFile(), 'utf8'))
  } catch {
    return { enabled: false, machines: {} }
  }
}

export async function readState() {
  try {
    return parseStateFile(await fsp.readFile(machinesFile(), 'utf8'))
  } catch {
    return { enabled: false, machines: {} }
  }
}

export async function writeState(state) {
  const payload = {
    enabled: state?.enabled === true,
    machines: (state && typeof state.machines === 'object' && state.machines !== null) ? state.machines : {},
  }
  await writeFileAtomic(machinesFile(), `${JSON.stringify(payload, null, 2)}\n`)
  return payload
}

/** 投影成 id → 档案。写回时用（会剔除键不符的行）。 */
export function machinesFromState(state) {
  return machinesOf(state?.machines)
}

// ── TOFU 主机密钥 ────────────────────────────────────────────────────────────

/**
 * 已知主机存储。**三种裁决**：
 *  - `accepted`  —— 指纹与已存一致，直接放行
 *  - `unknown`   —— 没见过：持久化后放行（这就是 TOFU 的「首次信任」）
 *  - `mismatch`  —— 指纹与已存不符：**中止握手**（可能是中间人，也可能是重装过机器）
 *
 * mismatch 绝不自动覆盖：自动覆盖等于把 TOFU 退化成「永远信任」，
 * 中间人只要等用户重连一次就能永久接管。必须先由用户明确删除该条目。
 */
export class KnownHosts {
  constructor(filename = knownHostsFile()) {
    this.filename = filename
    this.entries = null
  }

  load() {
    if (this.entries !== null) return this.entries
    try {
      const parsed = JSON.parse(fs.readFileSync(this.filename, 'utf8'))
      this.entries = (typeof parsed === 'object' && parsed !== null && !Array.isArray(parsed)) ? parsed : {}
    } catch {
      this.entries = {}
    }
    return this.entries
  }

  async save() {
    await writeFileAtomic(this.filename, `${JSON.stringify(this.load(), null, 2)}\n`)
  }

  /** 已存指纹（`host:port` 为键），没有则 undefined。 */
  fingerprintFor(key) {
    const value = this.load()[key]
    return typeof value === 'string' && value !== '' ? value : undefined
  }

  async remember(key, fingerprint) {
    this.load()[key] = fingerprint
    await this.save()
  }

  async forget(key) {
    const entries = this.load()
    if (!(key in entries)) return false
    delete entries[key]
    await this.save()
    return true
  }

  /**
   * 校验一个主机密钥，返回 `{verdict, fingerprint}`。
   * **只做判定与持久化，不做任何连接动作**——调用方拿到 verdict 后
   * 决定是继续握手还是中止。
   */
  async verify(key, hostKey, { host, port }) {
    const verdict = this.verdictSync(key, hostKey, { host, port, persist: false })
    if (verdict.verdict === 'unknown') await this.save()
    return verdict
  }

  /**
   * **同步**裁决。ssh2 的 `hostVerifier` 回调是同步的（返回 boolean），
   * 所以真实握手路径只能走这个版本：判定与内存写入是同步的，
   * 落盘由 `save()` 异步补上。丢一次落盘最坏是下次再问一遍 TOFU，
   * 而不同步判定会让整条握手路径没法用。
   *
   * ⚠️ **落盘失败不只是"再问一遍"**（2026-10-01 修正）。
   * 原先这里是 `this.save().catch(() => undefined)` —— 彻底静默。
   * 头注释只说"最坏是下次再问一遍 TOFU"，**没提这会让 mismatch 检测失效**：
   * 指纹读不出来 → 每次连接都走 `unknown` 分支 → TOFU 退化成"永远信任"。
   *
   * 实测（落盘正常 / 落盘持续失败两场景）：
   * ```
   *   落盘正常：  unknown → accepted → mismatch   ✅ 能识别换过密钥的主机
   *   落盘失败：  unknown → unknown              ❌ mismatch 分支不可达
   * ```
   * 也就是说：**磁盘一有问题，中间人防护就静默消失，而连接照常成功。**
   *
   * 这里**不改变裁决结果**（`unknown` 仍是 `unknown` —— 首次连接本就该放行，
   * 判定逻辑不能因为落盘失败而变严，那会让 SSH 完全不可用）。
   * 只做两件事：**把失败记下来**（`persistError`，供上层查询）、**打一条 warn**。
   * 目标是让"TOFU 正在降级"这件事**可被观察到**，而不是无声无息。
   */
  verdictSync(key, hostKey, { host, port, persist = true } = {}) {
    const fingerprint = fingerprintHostKey(hostKey)
    const entries = this.load()
    const existing = this.fingerprintFor(key)
    if (existing === undefined) {
      entries[key] = fingerprint
      if (persist) {
        this.save().catch((error) => {
          /* 记在实例上：调用方可以据此判断"当前 TOFU 是否处于降级状态"。 */
          this.persistError = String(error?.message || error)
          console.warn(
            '[ssh-known-hosts] 主机密钥落盘失败 —— TOFU 检测已降级：' +
            '重启后无法识别换过密钥的主机。原因:', this.persistError
          )
        })
      }
      return { verdict: 'unknown', fingerprint, host, port }
    }
    if (existing === fingerprint) return { verdict: 'accepted', fingerprint, host, port }
    return { verdict: 'mismatch', fingerprint, expected: existing, host, port }
  }

  /**
   * 当前是否处于"TOFU 降级"状态：曾经落盘失败过。
   * `mismatch` 检测依赖已存指纹，读不出来就意味着这道防线名存实亡 ——
   * 所以这个状态必须**可被查询**，而不是只躺在日志里。
   */
  degraded() {
    return this.persistError !== undefined
  }
}

/** 主机密钥存储键：`host:port`。同一主机不同端口是**不同**的信任锚。 */
export function knownHostKey(host, port) {
  return `${host}:${port}`
}
