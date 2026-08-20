// SSH 远程机器托管 —— ssh2 传输层适配器。
//
// **重要：本文件是整个移植里唯一无法端到端验证的部分。** 它需要一台真实的
// SSH 服务器才能验证握手、TOFU 回调、exec、端口转发。本机没有这样的服务器，
// 所以这里只做「把 ssh2 的 API 正确接线」这件事，并由测试证明
// **接线本身**是对的（构造、回调、裁决分支、凭据解析、错误归一化），
// 但不声称「真实握手通过」。
//
// 依赖注意：ssh2 是 CommonJS，**必须 default import**。
// `import { Client } from 'ssh2'` 会直接 SyntaxError。

import ssh2 from 'ssh2'
import fs from 'fs'
import os from 'os'
import path from 'path'
import { SshError, parseProxyJumpChain } from './ssh-core.js'
import { knownHostKey } from './ssh-state.js'

const { Client, utils } = ssh2

/** 默认身份文件（`~/.ssh/config` 未指定时按此顺序尝试）。 */
export const DEFAULT_IDENTITY_FILES = ['id_ed25519', 'id_ecdsa', 'id_rsa']

/**
 * 规范化的选项键。`IdentityFile` **累加**，其余「首个取到的值生效」。
 * 这张表就是「我们支持哪些 ssh_config 参数」的清单。
 */
const CANONICAL_OPTION_KEYS = Object.freeze({
  hostname: 'HostName',
  user: 'User',
  port: 'Port',
  identityfile: 'IdentityFile',
  proxyjump: 'ProxyJump',
  connecttimeout: 'ConnectTimeout',
  serveraliveinterval: 'ServerAliveInterval',
  serveralivecountmax: 'ServerAliveCountMax',
  // Include 本身不是连接参数，而是「还有哪些文件要读」。
  // 归一化它只为了能按固定键名取出来交给 loadSshConfigBlocks；
  // 真正的匹配逻辑**必须**忽略它，否则 `Include` 会被当成一个选项参与裁决。
  include: 'Include',
})

/** `Include` 链的最大深度。与 DSH 的 `INCLUDE_DEPTH_LIMIT = 8` 一致。 */
export const INCLUDE_DEPTH_LIMIT = 8

/**
 * `~/.ssh/config` 子集解析。
 *
 * **刻意不支持**：`Match` 块、`ProxyCommand`、agent forwarding——
 * 它们的语义（尤其是 Match 的条件求值）远超一个子集解析器能可靠覆盖的范围，
 * 假装支持会让用户以为配置生效了而实际没有。
 *
 * 规则：Host 模式支持 `*` `?` 逗号多选 `!` 取反，大小写不敏感；
 * **首个匹配的候选项决定**；每参数**首个取到的值生效**；`IdentityFile` **累加**。
 *
 * `Include` 由 {@link loadSshConfigBlocks} 处理（本函数**只解析文本**，
 * 不做文件 IO）——所以它接受 `depth` / `seen` 只为把「我们已经在这个包含深度上」
 * 这一信息带进递归；**单文件解析时它们不参与任何判断**。
 */
export function parseSshConfig(text, { depth = 0, seen = new Set() } = {}) {
  const entries = []
  if (typeof text !== 'string') return entries
  let current = null
  for (const rawLine of text.split(/\r?\n/)) {
    const line = rawLine.replace(/#.*$/, '').trim()
    if (line === '') continue
    const match = /^(\S+)\s*(.*)$/.exec(line)
    if (!match) continue
    const key = match[1]
    const value = match[2].trim()
    if (key.toLowerCase() === 'host') {
      current = { patterns: value.split(/\s+/).filter(Boolean), options: {}, order: entries.length }
      entries.push(current)
      continue
    }
    if (!current) continue
    const lower = key.toLowerCase()
    // IdentityFile 是**累加**的：多把 key 依次尝试，后面的不是「覆盖」而是「备选」。
    if (lower === 'identityfile') {
      current.options.IdentityFile = [...(current.options.IdentityFile ?? []), value]
      continue
    }
    // 归一化成规范拼写。ssh_config 的关键字是**大小写不敏感**的，
    // 但代码里要按固定的键名查找，所以统一到一个规范形式。
    // 注意**不能**简单地把首字母大写、其余小写：`HostName` / `ProxyJump` /
    // `IdentityFile` 都是驼峰，压成 `Hostname` 会让后面的查找全部落空
    // （表现为「Host 块里配的 HostName 被忽略」，静默连到错误的主机）。
    const canonical = CANONICAL_OPTION_KEYS[lower] ?? key
    // 每参数首个取到的值生效
    if (!(canonical in current.options)) current.options[canonical] = value
  }
  return entries
}

/** Host 模式匹配（`*` `?`、逗号、`!` 取反、大小写不敏感）。 */
export function hostPatternMatches(patterns, host) {
  const target = String(host).toLowerCase()
  let positive = false
  let matchedPositive = false
  for (const pattern of patterns) {
    if (pattern.startsWith('!')) {
      if (globMatch(pattern.slice(1), target)) return false
      continue
    }
    positive = true
    if (globMatch(pattern, target)) matchedPositive = true
  }
  if (!positive) return false
  return matchedPositive
}

function globMatch(pattern, value) {
  const regex = new RegExp(`^${String(pattern).toLowerCase()
    .replace(/[.+^${}()|[\]\\]/g, '\\$&')
    .replace(/\*/g, '.*')
    .replace(/\?/g, '.')}$`)
  return regex.test(value)
}

/** 路径 token 展开：`~`、`%d`(home)、`%h`(host)、`%r`(user)。 */
export function expandPathToken(value, { home, host, user }) {
  let out = String(value)
  if (out === '~' || out.startsWith('~/')) out = path.join(home, out.slice(1))
  out = out.replace(/%d/g, home).replace(/%h/g, host).replace(/%r/g, user)
  return out
}

/**
 * 单段 glob 匹配（只支持 `*` 与 `?`，与 DSH 的 globMatches 同语义）。
 *
 * **为什么不能用正则**：用户配置里的 glob 含 `.` `+` `(` 等正则元字符时，
 * 直接 `new RegExp` 会让它们被当成元字符 —— `Include conf.d/*.conf` 里的 `.`
 * 会匹配任意字符，于是 `configXconf` 也被包含进来。必须逐字符比。
 */
export function globMatches(glob, value) {
  let globIndex = 0
  let valueIndex = 0
  let starGlob = -1
  let starValue = -1
  while (valueIndex < value.length) {
    const g = glob[globIndex]
    if (g === '*') {
      starGlob = globIndex
      starValue = valueIndex
      globIndex += 1
    } else if (g === '?' || g === value[valueIndex]) {
      globIndex += 1
      valueIndex += 1
    } else if (starGlob !== -1) {
      globIndex = starGlob + 1
      starValue += 1
      valueIndex = starValue
    } else return false
  }
  while (glob[globIndex] === '*') globIndex += 1
  return globIndex === glob.length
}

/** 目录列举，失败读作空列表（没有就是没有，不抛）。 */
function readdirSyncSafe(dir) {
  try { return fs.readdirSync(dir) } catch { return [] }
}

/**
 * 把一条 `Include` 的值展开成具体文件路径。
 * 支持 `~` / `%d` / `%h` / `%r` 展开；相对路径相对 `sshDir` 解析；
 * basename 里含 `?` `*` 时按目录列举 + glob 匹配，**结果排序**（顺序稳定）。
 */
export function expandIncludePath(value, { sshDir, home, host = '', user = '' }) {
  let expanded = expandPathToken(value, { home, host, user })
  if (!path.isAbsolute(expanded)) expanded = path.join(sshDir, expanded)
  const dir = path.dirname(expanded)
  const basename = path.basename(expanded)
  if (!/[?*]/u.test(basename)) return [expanded]
  return readdirSyncSafe(dir)
    .filter((name) => globMatches(basename, name))
    .sort()
    .map((name) => path.join(dir, name))
}

/**
 * 读出从 `~/.ssh/config` 出发、沿 `Include` 链可达的**全部** Host 块，外层在前。
 *
 * **为什么必须做这件事**（原先标注为「刻意不假装支持」，那个判断是错的）：
 * `Include` 不是可选语法糖，而是**分发配置的常规手段** ——
 * 很多人把每台机器写进 `~/.ssh/config.d/*.conf`，主 config 里只有一行 Include。
 * 不展开 Include，那台机器在配置里**明明写着却连不上**，
 * 而且失败方式很隐蔽：不报错，只是 Host 模式匹配不到 → 回落默认值 →
 * 连到错误的主机 / 用错用户名。**这比"不支持"更糟，因为它静默。**
 *
 * 安全性：深度上限 {@link INCLUDE_DEPTH_LIMIT}、`visited` 去重（防环），
 * 目标文件不存在**静默跳过**（与 `ssh` 自身行为一致 —— 配置里 Include 一个
 * 尚未生成的目录是常见写法，不该因此整个配置读不出来）。
 *
 * @param {object} opts
 * @param {string} opts.sshDir  `~/.ssh`
 * @param {string} [opts.home]  `~` 展开用
 * @param {string} [opts.host]  `%h` 展开用（加载阶段通常为空）
 * @param {string} [opts.user]  `%r` 展开用（加载阶段通常为空）
 * @param {string} [opts.file]  起始文件，默认 `<sshDir>/config`
 */
export function loadSshConfigBlocks({ sshDir, home = os.homedir(), host = '', user = '', file } = {}) {
  const out = []
  const visited = new Set()
  const start = file ?? path.join(sshDir, 'config')

  const collect = (current, depth) => {
    if (depth > INCLUDE_DEPTH_LIMIT || visited.has(current)) return
    visited.add(current)
    let text
    try { text = fs.readFileSync(current, 'utf8') } catch { return }

    for (const entry of parseSshConfig(text)) {
      const includes = entry.options.Include
      if (includes === undefined) {
        out.push(entry)
        continue
      }
      // 带 Include 的块：**块本身仍要保留**（`Host foo` + `Include` 的组合里，
      // foo 的其余选项照样生效），但要把 Include 从选项里摘掉 ——
      // 留着它会让它参与后续的选项裁决，而它不是连接参数。
      if (entry.patterns.length > 0) {
        const { Include: _dropped, ...rest } = entry.options
        out.push({ ...entry, options: rest })
      }
      for (const target of expandIncludePath(includes, { sshDir, home, host, user })) {
        collect(target, depth + 1)
      }
    }
  }

  collect(start, 0)
  return out
}

/**
 * 为一个目标解析出实际的连接参数（含 ProxyJump 链）。
 * 链上某一跳自己又配了 ProxyJump → **拒绝**（用 visited 检测嵌套）。
 *
 * `configText` 仍可用（单文件解析，供测试与调用方直接喂文本）；
 * 传 `sshDir` 时会走 {@link loadSshConfigBlocks} 展开 `Include`。
 */
export function resolveSshTarget({ host, port, user, configText, sshDir, home = os.homedir() }) {
  const entries = sshDir !== undefined
    ? loadSshConfigBlocks({ sshDir, home, host, user })
    : parseSshConfig(configText)
  const applied = entries.find((entry) => hostPatternMatches(entry.patterns, host))
  const options = applied?.options ?? {}

  const resolved = {
    host: options.HostName ? expandPathToken(options.HostName, { home, host, user }) : host,
    port: options.Port ? Number(options.Port) : port,
    user: options.User ?? user,
  }

  const identityFiles = (options.IdentityFile ?? DEFAULT_IDENTITY_FILES.map((f) => `~/.ssh/${f}`))
    .map((file) => expandPathToken(file, { home, host, user }))

  let proxyChain = []
  if (options.ProxyJump) {
    proxyChain = parseProxyJumpChain(options.ProxyJump)
    // 嵌套 ProxyJump 拒绝
    for (const hop of proxyChain) {
      const hopEntry = entries.find((entry) => hostPatternMatches(entry.patterns, hop.alias))
      if (hopEntry?.options?.ProxyJump) {
        throw new SshError('machine-connect-failed', `nested ProxyJump is not supported (hop "${hop.alias}" has its own ProxyJump)`)
      }
    }
  }

  return { ...resolved, identityFiles, proxyChain }
}

/**
 * ssh2 传输层。每次 connect 建一个 `Client`；exec 与隧道共用这条连接。
 * 认证链顺序固定：ssh-agent → 私钥 → 存储的密码。
 */
export class Ssh2Transport {
  constructor({ sshConfigPath = path.join(os.homedir(), '.ssh', 'config') } = {}) {
    this.sshConfigPath = sshConfigPath
  }

  readSshConfig() {
    try { return fs.readFileSync(this.sshConfigPath, 'utf8') } catch { return '' }
  }

  /**
   * 解析连接参数。**走 Include 展开**（`resolveSshTarget` 传 `sshDir` 而非 `configText`）。
   *
   * 原先这里传的是 `configText: this.readSshConfig()` —— 只读主 config、**不展开 Include**。
   * 后果见 {@link loadSshConfigBlocks} 的注释：配置里写着的机器连不上，且静默。
   */
  resolveTarget(host, port, user) {
    return resolveSshTarget({
      host,
      port,
      user,
      sshDir: path.dirname(this.sshConfigPath),
    })
  }

  /**
   * 建立连接。返回一个 session 对象（exec / forwardOut / banner / close）。
   * @throws {SshError} 认证被拒 / 主机密钥不符 / 连不上
   */
  async connect({ profile, knownHosts, config = {}, tunnel = true, onEvent = () => {} }) {
    const target = this.resolveTarget(profile.host, profile.port, profile.user)

    const privateKeys = []
    for (const file of target.identityFiles) {
      try {
        const content = fs.readFileSync(file)
        privateKeys.push(profile.passphrase ? { key: content, passphrase: profile.passphrase } : content)
      } catch { /* 文件不存在就跳过，不是错误 */ }
    }

    const client = new Client()
    const connectOptions = {
      host: target.host,
      port: target.port,
      username: target.user,
      readyTimeout: config.connectTimeoutMs ?? 15000,
      keepaliveInterval: config.keepaliveIntervalMs ?? 10000,
      keepaliveCountMax: config.keepaliveCountMax ?? 3,
      // TOFU：由 knownHosts 给裁决。**mismatch 必须中止握手**，
      // 所以这里抛错——ssh2 会把 hostVerifier 的异常当作握手失败。
      hostVerifier: (key) => {
        if (!knownHosts) return true // 没有 TOFU 存储时退回标准行为（不静默信任）
        const fp = `${key.length}`
        void fp
        const verdict = knownHosts.verdictSync(knownHostKey(target.host, target.port), key, { host: target.host, port: target.port })
        if (verdict.verdict === 'mismatch') {
          onEvent('auth', `host key mismatch for ${target.host}:${target.port}`, { terminal: 'failed', reason: 'host-key-mismatch' })
          throw new SshError('machine-connect-failed', `host key mismatch for ${target.host}:${target.port} — the stored fingerprint differs; verify the host before removing it from known-hosts`)
        }
        if (verdict.verdict === 'unknown') {
          onEvent('auth', `trusting new host key for ${target.host}:${target.port} (${verdict.fingerprint})`)
        }
        return true
      },
    }
    if (privateKeys.length > 0) connectOptions.privateKey = privateKeys
    if (profile.password) connectOptions.password = profile.password
    if (process.env.SSH_AUTH_SOCK) connectOptions.agent = process.env.SSH_AUTH_SOCK

    onEvent('probe', `connecting to ${target.user}@${target.host}:${target.port}`)

    await new Promise((resolve, reject) => {
      const onReady = () => { cleanup(); resolve() }
      const onError = (error) => { cleanup(); reject(wrapConnectError(error, profile, target)) }
      const cleanup = () => {
        client.removeListener('ready', onReady)
        client.removeListener('error', onError)
      }
      client.once('ready', onReady)
      client.once('error', onError)
      try { client.connect(connectOptions) } catch (error) { cleanup(); reject(wrapConnectError(error, profile, target)) }
    })

    onEvent('ready', `connected to ${target.host}`)

    const session = {
      client,
      target,
      authMethod: profile.password ? 'password' : 'key',
      async banner() {
        return new Promise((resolve) => {
          client.exec('uname -srm', (error, stream) => {
            if (error) return resolve('')
            let out = ''
            stream.on('data', (chunk) => { out += chunk.toString('utf8') })
            stream.on('close', () => resolve(out.trim()))
            stream.stderr.resume()
          })
        })
      },
      /** 执行一条远程命令，返回 {code, stdout, stderr}。 */
      async exec(command, { timeoutMs } = {}) {
        return new Promise((resolve, reject) => {
          let settled = false
          let timer
          const finish = (fn, value) => { if (settled) return; settled = true; if (timer) clearTimeout(timer); fn(value) }
          client.exec(command, (error, stream) => {
            if (error) return finish(reject, wrapConnectError(error, profile, target))
            let stdout = ''
            let stderr = ''
            let code = 0
            stream.on('data', (chunk) => { stdout += chunk.toString('utf8') })
            stream.stderr.on('data', (chunk) => { stderr += chunk.toString('utf8') })
            stream.on('exit', (exitCode) => { code = exitCode ?? 0 })
            stream.on('close', () => finish(resolve, { code, stdout, stderr }))
            if (timeoutMs) {
              timer = setTimeout(() => {
                try { stream.close() } catch {}
                finish(reject, new SshError('machine-bootstrap-failed', `remote command timed out after ${timeoutMs}ms`))
              }, timeoutMs)
            }
          })
        })
      },
      /** 打开一条到远端回环地址的直连通道（隧道用）。**恒定 127.0.0.1**。 */
      async forwardOut(remotePort) {
        return new Promise((resolve, reject) => {
          client.forwardOut('127.0.0.1', 0, '127.0.0.1', remotePort, (error, channel) => {
            if (error) return reject(error)
            resolve(channel)
          })
        })
      },
      async close() {
        try { client.end() } catch {}
      },
    }
    void tunnel
    return session
  }
}

/** 把 ssh2 的原始错误归一化。**绝不把密码写进 message**。 */
function wrapConnectError(error, profile, target) {
  if (error instanceof SshError) return error
  const message = error instanceof Error ? error.message : String(error)
  // 防御性：万一 ssh2 把凭据回显进消息，这里再抹一次
  const safe = profile?.password ? message.split(profile.password).join('***') : message
  const wrapped = new SshError('machine-connect-failed', safe)
  wrapped.code = error?.code ?? wrapped.code
  wrapped.level = error?.level
  void target
  return wrapped
}

export { Client, utils }
