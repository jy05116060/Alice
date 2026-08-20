// SSH 远程机器托管 —— HTTP 传输层（`POST /api-ssh`）。
//
// 单端点、按 `method` 字段分发。响应信封恒定：
//   `{ok:true, value}` / `{ok:false, error:{code, message}}`
//
// 这一层只做三件事：**判阶梯 → 查方法表 → 包信封**。所有业务逻辑在
// ssh-manager / ssh-state / ssh-core 里，所以这里的每一行都应该是可读的。

import { jsonResponse } from '../utils.js'
import fs from 'node:fs'
import path from 'node:path'
import {
  preflight, unknownMethod, businessFailure, success, SshError,
  isLoopbackPeer, isAllowedTunnelOrigin,
} from '../../runtime/ssh-core.js'
import { SshManager } from '../../runtime/ssh-manager.js'
import { KnownHosts } from '../../runtime/ssh-state.js'
import { Ssh2Transport } from '../../runtime/ssh-transport.js'
import { startCommandFor, platformProbeCommand, buildRemoteCommand, remotePlatformKey, isSupportedPlatform, platformUnsupportedMessage, checkMissingCommand, parseMissingComponents, installCommandFor } from '../../runtime/ssh-remote-command.js'

export const SSH_ROUTE_PATH = '/api-ssh'
const MAX_BODY_BYTES = 64 * 1024

/* ── `sync.preview` 的预览构造（与 DSH `buildPreview` 同形状）──────────────────
   DSH 原版：
     function buildPreview(dependencies, skillRoots) {
       const plugins = Object.entries(dependencies)
         .filter(([name]) => !name.startsWith('@deepseek-ai/') && !BUNDLED_PLUGIN_...)  // 排除内置
         .map(([name, spec]) => { const verdict = classifySpec(spec); return { name, spec, syncable: verdict.syncable, ...(reason ? {reason} : {}) } })
         .sort(byName)
       const skills = []; for (const entry of skillRoots) for (const name of [...entry.names].sort()) skills.push({ name, root: entry.root })
       return { plugins, skills }
     }

   爱丽丝**没有** DSH 那套「远程 pnpm workspace + 插件依赖图」，所以 plugins 扫描的是
   本地插件目录（`<USER_DIR>/plugins`，与插件宿主看到的同一处），
   skills 扫描的是技能目录。这两者就是本产品「能推给远端的东西」的全部。
   形状逐字对齐——调用方按 `plugins[].syncable` / `skills[].root` 取值即可。

   `syncable` 的判据：**只有本地产物能推**。这里所有扫到的都是本地目录里的东西，
   所以恒为 true；保留该字段是为了形状稳定（DSH 里它是 classifySpec 的结论，
   会因为「来自 @deepseek-ai 内置」或「不可解析」而为 false）。 */
function buildSyncPreview(options = {}) {
  const userDir = options.userDir ?? process.env.ALICE_USER_DIR ?? ''
  const pluginsRoot = options.pluginsRoot ?? (userDir ? path.join(userDir, 'plugins') : '')
  const skillsRoot = options.skillsRoot ?? (userDir ? path.join(userDir, 'skills') : '')

  const plugins = []
  if (pluginsRoot && fs.existsSync(pluginsRoot)) {
    for (const entry of fs.readdirSync(pluginsRoot, { withFileTypes: true })) {
      if (!entry.isDirectory()) continue
      // 与 DSH 一致：内置（@deepseek-ai 作用域下的）不参与同步。
      // 注意这里**扫到的是目录**，所以 `@deepseek-ai` 会作为作用域目录本身出现，
      // 要单独把它排掉；同时它下面的子目录也不该被当成独立插件（它们属于同一个作用域）。
      if (entry.name.startsWith('@')) continue
      const spec = path.join(pluginsRoot, entry.name)
      plugins.push({ name: entry.name, spec, syncable: true })
    }
  }
  plugins.sort((left, right) => (left.name < right.name ? -1 : left.name > right.name ? 1 : 0))

  const skills = []
  if (skillsRoot && fs.existsSync(skillsRoot)) {
    for (const entry of fs.readdirSync(skillsRoot, { withFileTypes: true })) {
      if (!entry.isDirectory()) continue
      // 与 DSH 一样按名字排序，root 指回技能根目录
      skills.push({ name: entry.name, root: skillsRoot })
    }
  }
  skills.sort((left, right) => (left.name < right.name ? -1 : left.name > right.name ? 1 : 0))

  return { plugins, skills }
}

export { buildSyncPreview }

/**
 * 读请求体，**超限不砸连接**。
 *
 * 为什么要自己写而不用 `utils.readRawBody`：那个版本在超限时 `req.destroy()`，
 * 于是客户端收到的是 socket hang up，而不是契约要求的
 * `400 {code:"bad-request",message:"malformed JSON body"}`。
 * 我们必须在超限后**停下来但不摧毁 socket**，这样才能把 400 发出去；
 * 同时继续把余下的字节读掉（不读的话对端写不完，一样会卡）。
 */
function readBoundedBody(req, maxBytes) {
  return new Promise((resolve) => {
    const chunks = []
    let size = 0
    let oversize = false
    let done = false
    const finish = () => {
      if (done) return
      done = true
      resolve({ bytes: size, oversize, text: oversize ? '' : Buffer.concat(chunks).toString('utf8') })
    }
    req.on('data', (chunk) => {
      if (done) return
      size += chunk.length
      if (size > maxBytes) {
        // 超限：停止累积（不再吃内存），但让流继续跑到 end，保住 socket。
        oversize = true
        chunks.length = 0
        return
      }
      chunks.push(chunk)
    })
    req.on('end', finish)
    req.on('error', finish)
    // 客户端中途断开：按「读到多少算多少」处理，交给上层判 400。
    req.on('close', finish)
  })
}

// ── 进程内单例 ──────────────────────────────────────────────────────────────
// 一台机器只该有一条 SSH 连接与一个隧道。多次请求共用同一份状态。

let managerInstance = null

export function getSshManager() {
  if (!managerInstance) {
    managerInstance = new SshManager({
      transport: new Ssh2Transport(),
      knownHosts: new KnownHosts(),
    })
    managerInstance.load()
  }
  return managerInstance
}

/** 仅供测试：注入一个自定义 manager（假 transport / 临时路径）。 */
export function setSshManager(manager) {
  managerInstance = manager
  return managerInstance
}

// ── payload 校验（错误消息逐字复刻）────────────────────────────────────────

function machineIdOf(payload) {
  if (!payload || typeof payload.machineId !== 'string' || payload.machineId === '') {
    throw new Error('missing machineId')
  }
  return payload.machineId
}

function enabledOf(payload) {
  if (!payload || typeof payload.enabled !== 'boolean') throw new Error('missing enabled')
  return payload.enabled
}

function sinceSeqOf(payload) {
  const value = payload?.sinceSeq
  if (value === undefined) return undefined
  if (typeof value !== 'number' || !Number.isInteger(value) || value < 0) throw new Error('invalid sinceSeq')
  return value
}

function saveRowOf(payload) {
  const row = payload?.row
  if (typeof row !== 'object' || row === null) throw new Error('missing row')
  if (typeof row.name !== 'string' || row.name === '') throw new Error('invalid row: name')
  if (typeof row.host !== 'string' || row.host === '') throw new Error('invalid row: host')
  if (typeof row.user !== 'string') throw new Error('invalid row: user')
  const rawProfileName = typeof row.profileName === 'string' ? row.profileName.trim() : ''
  return {
    name: row.name,
    host: row.host,
    port: typeof row.port === 'number' ? row.port : 22,
    user: row.user,
    remotePort: typeof row.remotePort === 'number' ? row.remotePort : 3080,
    ...(/^[\w-]+$/.test(rawProfileName) ? { profileName: rawProfileName } : {}),
    ...(typeof row.startCommand === 'string' && row.startCommand !== '' ? { startCommand: row.startCommand } : {}),
    ...(typeof row.color === 'string' && row.color !== '' ? { color: row.color } : {}),
    ...(row.tintBorder === true ? { tintBorder: true } : {}),
  }
}

function secretsOf(payload) {
  const secrets = payload?.secrets
  if (secrets === undefined) return undefined
  if (typeof secrets !== 'object' || secrets === null) throw new Error('invalid secrets')
  const out = {}
  if (typeof secrets.password === 'string' && secrets.password !== '') out.password = secrets.password
  if (typeof secrets.passphrase === 'string' && secrets.passphrase !== '') out.passphrase = secrets.passphrase
  return out
}

// ── 方法表（13 个）─────────────────────────────────────────────────────────
// 每个 handler 收到 (payload, ctx)，返回 value。抛错 → 第 7 条阶梯（HTTP 200）。

function buildMethods(manager) {
  return {
    /* `session.role` 回答的是**「当前这个进程是不是远端会话、来自哪台机器」**，
       不是「本机是不是 host」。DSH 原版：
         sessionRole() {
           const origin = process.env.DSH_REMOTE_SESSION_ORIGIN
           return origin === void 0 || origin === '' ? { remote: false } : { remote: true, origin }
         }
       这里原先返回常量 `{role:'host', ssh:true}` —— 形状与语义都不对，而且**是常量**，
       永远无法表达「我是远程会话」，把这条信息的用途整个丢掉了。
       
       为什么这不是小事：`ssh-remote-command.js` 启动远端时**已经**正确注入了
       `DSH_REMOTE_SESSION_ORIGIN=<profileName>`（见该文件 buildRemoteCommand），
       也就是说远端进程确实被如实告知了来历；如果这里不读它，
       **整条「我是谁、从哪来」的信息链就在最后一跳断掉**——
       而 session.role 存在的唯一理由就是把这个信息交出去。
       已按 DSH 契约改正：形状逐字对齐，origin 是 profileName。 */
    'session.role': () => {
      const origin = process.env.DSH_REMOTE_SESSION_ORIGIN
      return origin === undefined || origin === '' ? { remote: false } : { remote: true, origin }
    },

    'settings.get': () => ({ enabled: manager.enabled }),

    'settings.set': async (payload) => {
      manager.enabled = enabledOf(payload)
      await manager.persist()
      return { enabled: manager.enabled }
    },

    /* `machine.list` 返回**对象**，不是裸数组。DSH 契约：
         { enabled: bool, items: [...], discovered: [...] }
       `items` 是已配置的机器，`discovered` 是从 ~/.ssh/config 发现的候选。
       这里原先 `() => manager.list()` 直接返回数组 —— 调用方按契约取 `value.items`
       会拿到 undefined（**列表永远是空的却 ok:true**），与 sync.preview 是同一类错误：
       形状不对，但不报错。

       爱丽丝**没有** ssh config 的自动发现打通（见规格书如实简化项），
       所以 `discovered` 恒为空数组 —— 保留该键是为了形状稳定，不是假装有发现结果。
       `enabled` 走 settings 的全局开关，与 settings.get 同源。 */
    'machine.list': () => ({
      enabled: manager.enabled === true,
      items: manager.list(),
      discovered: [],
    }),

    'machine.test': async (payload) => {
      const machineId = machineIdOf(payload)
      return manager.test(machineId)
    },

    'machine.connect': async (payload) => {
      const machineId = machineIdOf(payload)
      const link = await manager.connect(machineId)
      return {
        tunnelBaseUrl: link?.tunnelBaseUrl ?? null,
        state: manager.status(machineId).state,
      }
    },

    'machine.disconnect': async (payload) => {
      const machineId = machineIdOf(payload)
      // 断开不存在的机器不报错：UI 的「断开」按钮可能重复点。
      if (!manager.profiles.has(machineId)) return {}
      return manager.disconnect(machineId)
    },

    'machine.install': async (payload) => {
      const machineId = machineIdOf(payload)
      const profile = manager.requireProfile(machineId)
      const link = await manager.connect(machineId)
      const session = link?.session
      if (!session?.exec) {
        throw new SshError('machine-install-failed', 'SSH session does not support exec')
      }

      // 先探平台：安装产物是按平台选的，探不到就没法往下走（而不是猜一个）。
      // 这一步也顺带验证 exec 通道真的能用——连不上会有明确错误，
      // 比让后面的启动命令失败得含糊要好。
      const probe = await session.exec(buildRemoteCommand(platformProbeCommand()))
      // `uname -srm` 输出三个字段：`Linux 6.1.0 x86_64`（系统 / 版本 / 架构）。
      // 架构是**最后一个**字段——取第 2 个会把内核版本当成架构，
      // 于是每个平台都判成 unknown，安装永远被拒。
      const fields = String(probe.stdout ?? '').trim().split(/\s+/).filter(Boolean)
      const platform = remotePlatformKey(fields[0], fields[fields.length - 1])
      if (probe.code !== 0) {
        throw new SshError('machine-install-failed', `could not probe the remote platform (exit ${probe.code}): ${probe.stderr?.trim() || 'no output'}`)
      }
      if (!isSupportedPlatform(platform)) {
        throw new SshError('machine-install-failed', platformUnsupportedMessage(platform))
      }

      // ── 查缺失组件，缺就装（2026-10-01 补）──────────────────────────────
      // 原先前这里**直接跳到启动**，整段跳过了"安装"：
      // `startCommandFor` 的第一件事就是
      //     `if [ ! -x "$NODE" ] || [ ! -f "$DSH_BIN" ]; then echo REMOTE_NOT_INSTALLED; exit 1; fi`
      // 而 $NODE / $DSH_BIN 正是安装脚本要下载的东西。
      // 于是所谓 `machine.install` 在**全新机器上必然失败**，
      // 只有在"事先手工装好"的机器上才会返回 ok —— 接口名与行为不符。
      //
      // DSH 的流程是：探平台 → 查缺失 → 缺才装 → 启动。
      // 这里对齐：全都就绪则**跳过安装**（省下几百 MB 重复下载），
      // 有缺失才真的把 installScript 送过去，并带上完整日志与进度。
      const missingProbe = await session.exec(buildRemoteCommand(checkMissingCommand()))
      const missing = parseMissingComponents(missingProbe.stdout)

      if (missing.length === 0) {
        // 三件套已就绪：跳过安装，但**如实告知**跳过了（而不是假装装过）。
        const command = buildRemoteCommand(startCommandFor(profile))
        const started = await session.exec(command, { timeoutMs: manager.config.installTimeoutMs })
        if (started.code !== 0) {
          throw new SshError('machine-install-failed', started.stderr?.trim() || `install exited with code ${started.code}`)
        }
        return {
          ok: true,
          platform,
          installed: false,
          skippedReason: 'remote components already present',
          missing: [],
          stdout: started.stdout?.trim() ?? '',
        }
      }

      // 真的安装了。安装脚本按平台选产物，所以 platform 必须已经解析出来。
      const install = await session.exec(
        installCommandFor({ remotePort: profile.remotePort, platform }),
        { timeoutMs: manager.config.installTimeoutMs }
      )
      if (install.code !== 0) {
        // 如实上报**退出码**：9/10/12/14 分别对应缺下载器/源全失败/缺解压工具/包损坏，
        // 上层据此给具体提示，而不是一律"安装失败"。
        throw new SshError(
          'machine-install-failed',
          `remote install exited with code ${install.code}` +
          `${install.stderr?.trim() ? `: ${install.stderr.trim()}` : ''}`
        )
      }

      // 装完再启动。启动脚本自带 REMOTE_NOT_INSTALLED 自检——
      // 如果安装其实没成功，这一步会立刻失败，而不是留下一个空跑的状态。
      const command = buildRemoteCommand(startCommandFor(profile))
      const result = await session.exec(command, { timeoutMs: manager.config.installTimeoutMs })
      if (result.code !== 0) {
        throw new SshError('machine-install-failed', result.stderr?.trim() || `install exited with code ${result.code}`)
      }
      return {
        ok: true,
        platform,
        installed: true,
        missing,
        stdout: result.stdout?.trim() ?? '',
      }
    },

    'machine.events': (payload) => {
      const machineId = machineIdOf(payload)
      const sinceSeq = sinceSeqOf(payload)
      return manager.eventsSince(machineId, sinceSeq)
    },

    'machine.save': async (payload) => {
      const machineId = machineIdOf(payload)
      await manager.save(machineId, saveRowOf(payload), secretsOf(payload))
      return {}
    },

    'machine.remove': async (payload) => {
      const machineId = machineIdOf(payload)
      await manager.remove(machineId)
      return {}
    },

    /* `sync.preview` 返回**可同步的本地插件与技能清单**（面板的选择列表），不是「机器列表」。
       契约来自 DSH：`sync_preview` → `host.syncPreview()` → `sync.preview()`
       → `buildPreview(profileDependencies(), scanSkills())`，形状为
       `{ plugins: [{name, spec, syncable, reason?}], skills: [{name, root}] }`。
       **它刻意不接 machineId**（DSH 那行同样是 `host.syncPreview()` 无参）——
       预览回答的是「本地有什么能推」，与目标机器无关；选机器是 `sync.apply` 的事。
       这里原先返回 `{machines, enabled}`，与契约形状毫无交集：调用方按
       `plugins` / `skills` 取字段会拿到 undefined，界面上的选择列表永远是空的，
       却因为 `ok:true` 而看起来「成功」——**一个不会报错的空列表**。
       已按契约改正，并且 shape 与 DSH 逐字对齐。 */
    'sync.preview': () => buildSyncPreview(),

    /* `sync.apply` 把选中的插件/技能推到一台机器，**逐个报告结果**。
       DSH 契约：
         syncApply(machineId, pluginRefsOf(payload), skillRefsOf(payload))
         → sync.apply(...) → 返回 `{ items: [{kind, name, ok, error?, log?}, ...] }`
       其中 pluginRefsOf / skillRefsOf 是**严格校验器**，形状不对直接抛
       （`payload.plugins` 非数组 → "invalid plugins"；项缺 name/spec → "invalid plugin ref"；
        skill 的 root 只认 'dsh' | 'agents'）。

       这里原先返回 `{ ok: true, applied: 0, machineId }` —— 两处偏离：
         a) **形状**没有 `items`：调用方按 `result.items` 逐项取结果会拿到 undefined，
            界面无法显示"哪个成功、哪个失败"，只能看到一句笼统的成功。
         b) **`applied: 0` 是假的**：它**根本不读 payload.plugins / payload.skills**，
            无论用户选了几项都回 0。于是"选了 3 个插件点同步"→ 界面显示"已同步 0 项"，
            而**什么都没做、也不报错**。这与我刚修的 sync.preview 是同一个功能的另一半，
            同一类错误：**形状不对 + 数字是编的，但 `ok:true` 让一切看起来正常。**

       爱丽丝确实**没有远端 pnpm 工作区**（非 DSH 插件架构），所以"真的把包装上去"
       做不到。但**不能因此假装成功**。现在的做法：
         · 严格按 DSH 校验 payload（形状不对就抛，与 DSH 一致地拒绝）
         · 返回**形状正确的 `items`**，每项如实标注 ok:false 与原因
         · **不再返回编造的 applied 计数**
       这样调用方拿到的是一份**诚实的结果清单**：形状能用、每条都说明为什么没做成。 */
    'sync.apply': async (payload) => {
      const machineId = machineIdOf(payload)
      // requireProfile 先跑：机器不存在要报 machine-not-found，而不是"同步了 0 项"。
      manager.requireProfile(machineId)
      const plugins = pluginRefsOf(payload)
      const skills = skillRefsOf(payload)
      return { items: syncItemsFor(plugins, skills) }
    },
  }
}

/* ── `sync.apply` 的引用校验与结果清单（与 DSH 的 pluginRefsOf/skillRefsOf 同规则）──────
   校验必须**逐字复刻 DSH 的严格度**：宽容的校验器会把畸形输入放进来，
   然后在更深的地方以一个看不懂的错误炸掉。这里宁可早失败、错误说清楚。 */

function pluginRefsOf(payload) {
  const list = payload?.plugins
  if (list === undefined) return []
  if (!Array.isArray(list)) throw new Error('invalid plugins')
  return list.map((entry) => {
    if (typeof entry !== 'object' || entry === null) throw new Error('invalid plugin ref')
    if (typeof entry.name !== 'string' || typeof entry.spec !== 'string' || entry.spec === '') {
      throw new Error('invalid plugin ref')
    }
    return { name: entry.name, spec: entry.spec }
  })
}

function skillRefsOf(payload) {
  const list = payload?.skills
  if (list === undefined) return []
  if (!Array.isArray(list)) throw new Error('invalid skills')
  return list.map((entry) => {
    if (typeof entry !== 'object' || entry === null) throw new Error('invalid skill ref')
    if (typeof entry.name !== 'string' || entry.name === '') throw new Error('invalid skill ref')
    // root 只认这两个来源，与 DSH 一致
    if (entry.root !== 'dsh' && entry.root !== 'agents') throw new Error('invalid skill ref: root')
    return { name: entry.name, root: entry.root }
  })
}

/**
 * 每个请求项的落地结果。**爱丽丝没有远端 pnpm 工作区**（不是 DSH 的插件架构），
 * 所以这里不会真的把东西装上去 —— 但每一项都**如实说明这一点**，
 * 而不是用 `applied: 0` 糊过去、也不是伪造 `ok: true`。
 *
 * **为什么"诚实失败"优于"假装成功"**：调用方拿到 ok:false + 具体原因，
 * 可以提示用户"这个能力在当前版本不可用"；拿到 `ok:true, applied:0`
 * 只会显示成功，用户以为推上去了，实际远端没有任何变化 —— 出了事无法追溯。
 */
function syncItemsFor(plugins, skills) {
  const reason = 'remote sync is not available in this build: 爱丽丝 has no remote pnpm workspace to install into'
  return [
    ...plugins.map(p => ({ kind: 'plugin', name: p.name, ok: false, error: reason })),
    ...skills.map(s => ({ kind: 'skill', name: s.name, ok: false, error: reason })),
  ]
}

// 暴露给测试的纯校验器（不经过 HTTP）。
export const __validators = { machineIdOf, enabledOf, sinceSeqOf, saveRowOf, secretsOf }

// ── CORS ────────────────────────────────────────────────────────────────────

/**
 * 按 Origin 算出该带的 CORS 头。**返回头对象，不直接写响应**——
 * 这样调用方能在同一个地方决定「写哪些」并在错误分支里复用。
 *
 * 两条关键语义（都是行为契约）：
 *  1. **不在白名单的 Origin 返回空对象 `{}`，绝不写字面量 `'null'`。**
 *     一个 `Access-Control-Allow-Origin: null` 会**主动毒化**响应：它不只是
 *     「没授权」，而是告诉浏览器这个响应属于 `null` 源。比不加头更糟。
 *  2. 合法源要**在每一个响应上都带**（403/400/404/200 全都带），
 *     不能只在 OPTIONS 上带。只在预检上带的话，预检通过、真实请求的响应
 *     却读不到——浏览器会把响应丢掉，调用方只看到 "Load failed"。
 *
 * @returns {Record<string, string>} 空对象或完整的 CORS 头
 */
export function corsHeadersFor(origin) {
  if (!isAllowedTunnelOrigin(origin)) return {}
  // **只有真的带了 Origin 才回 ACAO。** 没有 Origin 时回一个 `null` 值同样是
  // 毒化响应：`Access-Control-Allow-Origin: null` 是一个**字面量源名**，
  // 不是「无」。非浏览器调用方（curl、Node 客户端）本来就不需要这个头，
  // 给了它反而是错的。CORS 是给浏览器看的，浏览器一定有 Origin。
  if (!origin || origin === 'null') return {}
  return {
    'Access-Control-Allow-Origin': origin,
    'Access-Control-Allow-Methods': 'POST, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type',
    'Access-Control-Max-Age': '600',
  }
}

/** 把 CORS 头写进响应。行为：无条件写（空对象时什么都不做）。 */
function applyCors(res, cors) {
  for (const [key, value] of Object.entries(cors)) res.setHeader(key, value)
}

// ── 路由 ────────────────────────────────────────────────────────────────────

/**
 * `POST /api-ssh`。返回 true 表示已处理（与 api.js 的 handler 约定一致）。
 */
export async function handleSshRemoteRoutes(req, res, url) {
  if (!url || url.pathname !== SSH_ROUTE_PATH) return false

  const remoteAddress = req.socket?.remoteAddress
  const method = String(req.method ?? '').toUpperCase()
  const origin = req.headers?.origin

  // CORS 必须在**每个**响应上都带，所以一进 handler 就算好并设上。
  // 放在这里（而不是 OPTIONS 分支里）的理由见 corsHeadersFor 的注释：
  // 只在预检上带的话，合法调用方的真实 POST 读不到响应。
  // 已验证 `res.writeHead()` 会与 `setHeader` 合并而非覆盖，所以
  // 下面所有 `jsonResponse` 都自然带上这些头。
  const cors = corsHeadersFor(origin)
  applyCors(res, cors)

  // 阶梯 1–3 不读体，可以先判。
  if (!isLoopbackPeer(remoteAddress)) {
    jsonResponse(res, 403, { ok: false, error: { code: 'forbidden', message: 'this API is loopback-only' } })
    return true
  }

  if (method === 'OPTIONS') {
    // 合法性判据 = 「cors 对象里有没有 ACAO」，与 DSH 一致。
    if (cors['Access-Control-Allow-Origin'] === undefined) {
      jsonResponse(res, 403, { ok: false, error: { code: 'forbidden', message: 'origin not allowed' } })
      return true
    }
    res.writeHead(204)
    res.end()
    return true
  }

  if (method !== 'POST') {
    jsonResponse(res, 405, { ok: false, error: { code: 'method-not-allowed', message: 'POST only' } })
    return true
  }

  // 阶梯 4：读体。**按实际字节数判上限**，不能只看 Content-Length（可以撒谎）。
  const { bytes: bodyBytes, oversize, text: bodyText } = await readBoundedBody(req, MAX_BODY_BYTES)
  if (oversize) {
    jsonResponse(res, 400, { ok: false, error: { code: 'bad-request', message: 'malformed JSON body' } })
    return true
  }
  const gate = preflight({ method, remoteAddress, origin: req.headers?.origin, bodyText, bodyBytes })
  if (gate.kind === 'reject') { jsonResponse(res, gate.status, gate.body); return true }
  if (gate.kind !== 'dispatch') { jsonResponse(res, 400, { ok: false, error: { code: 'bad-request', message: 'malformed JSON body' } }); return true }

  const manager = getSshManager()
  const methods = buildMethods(manager)

  // 阶梯 6：未知方法 → 404。**注意这在 try 之外**，避免被第 7 条吞成 200。
  if (!Object.prototype.hasOwnProperty.call(methods, gate.method)) {
    const failure = unknownMethod(gate.method)
    jsonResponse(res, failure.status, failure.body)
    return true
  }

  // 阶梯 7：业务异常 → **HTTP 200**。
  try {
    const value = await methods[gate.method](gate.payload, { manager, req })
    const ok = success(value)
    jsonResponse(res, ok.status, ok.body)
  } catch (error) {
    const failure = businessFailure(error)
    jsonResponse(res, failure.status, failure.body)
  }
  return true
}
