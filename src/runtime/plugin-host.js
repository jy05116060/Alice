// 插件宿主 + 热重载（HMR）的**最小内核**（阶段 6，方案里原先建议暂缓的那一项）。
//
// ⚠️ 受信边界（这是本模块最重要的一段，请先读完再动手）
// ---------------------------------------------------------------------------
// **插件是完全受信的代码。** 它们通过 `import()` 在**宿主进程内**执行，拿到的是完整的
// Node 权限：可以读写任意文件、发起任意网络请求、读环境变量与凭据、甚至 `process.exit()`。
// 这里**没有沙箱、没有权限声明、没有签名校验、没有版本兼容检查**。
//
// 这是**刻意的取舍**：爱丽丝是单体、单用户、本地应用，「插件」等于用户自己放进自己数据
// 目录里的一段脚本——它和用户自己写一个 .js 文件让 Node 跑没有本质区别。给它套一层假
// 沙箱只会让人误以为有隔离，反而更危险。**不要把别人的插件放进这个目录。**
//
// 最小内核的边界（明确写出来，避免让人以为这里是个插件生态）
// ---------------------------------------------------------------------------
// 做了：发现目录 → 读清单 → import 入口 → 调 activate → 文件变化自动重载 → 一个插件
//       出错不影响别的插件 → 状态可见 + HTTP 接口 → **清单里声明的 UI 扩展点（命令 + 面板）**。
// 没做：依赖管理（npm 安装）、插件间依赖、版本兼容检查、市场/分发、插件设置界面、
//       按插件粒度的权限控制、启停状态的持久化、工具栏/状态栏插槽、任意 JS 注入。
//       详见方案文档 6.7 节。
//
// 插件目录结构（默认 `<ALICE_USER_DIR>/plugins/<id>/`）
// ---------------------------------------------------------------------------
//   plugins/
//     hello/
//       plugin.json      （可选）清单
//       plugin.js        （默认入口，可用清单 entry 覆盖）
//       ...              （插件自己的其它文件）
//
// plugin.json 字段（全部可选，但写错就是写错，不会被忽略）：
//   { "id": "hello", "version": "1.0.0", "entry": "plugin.mjs", "name": "..." }
//   - id      ：插件 id，须匹配 /^[A-Za-z0-9][A-Za-z0-9._-]*$/；缺省用**目录名**
//   - entry   ：入口文件（相对插件目录，不许是绝对路径、不许含 ..）
//   - version ：版本号，字符串，仅用于展示（**不做任何兼容性检查**）
//   没有 plugin.json 时：id = 目录名，entry = 入口候选之一。
//   清单非法（不是 JSON / 不是对象 / id 或 entry 形状不对）→ 该插件标记为 error，
//   **不会被当成「没有清单」而照常加载**——那样会把配置错误伪装成能跑。
//
// plugin.json 的 ui 段（可选：命令 + 面板）
// ---------------------------------------------------------------------------
//   "ui": {
//     "commands": [ { "cmd": "/weather", "label": "天气", "description": "…",
//                     "prompt": "帮我查一下 {input} 的天气" } ],
//     "panels":   [ { "id": "weather", "title": "天气面板", "entry": "ui/panel.html" } ]
//   }
//
//   **为什么是清单里的声明式数据，而不是插件的 registerCommand(fn) 之类的运行时注册函数？**
//   因为插件的代码跑在**主进程**，界面跑在**渲染进程**——一个 JS 函数跨不过这道边界。
//   插件能交给界面的东西只有「可序列化的数据」，所以扩展点就只能是清单里的声明。
//   界面拿到的因此永远只是 cmd / label / prompt 模板 / 一个 HTML 文件路径，而不是可执行的函数。
//
//   - commands[].prompt 是**模板**：界面把它预填进输入框（**不自动发送**）。
//     `{input}` 是「这里要补的输入」的占位符；没有占位符就整句预填。
//   - panels[].entry 是**相对插件目录**的 HTML 文件路径，且**必须解析在插件目录之内**；
//     越界（`../`、绝对路径）一律拒收，见 resolvePluginPanelPath()。
//
//   ⚠️ 面板 HTML 会被 iframe 在**应用同源**下加载：它能做同源 iframe 能做的一切
//   （读同源 DOM、带用户身份发请求）。这**不是沙箱**，只是**结构隔离**——
//   别把它当安全边界。受信边界与插件本身是同一条：不要放别人的插件进来。
//
//   ui 段写错（不是对象 / 缺 cmd / entry 越界或文件不存在）→ **只把这一条声明**记进
//   `uiErrors` 并上报（GET /plugins/ui 的 errors），插件的 JS 入口照常加载、别的插件照常，
//   绝不因为一条 UI 声明写错就整份列表失效。**也绝不静默丢掉**：界面要能告诉用户
//   「某个插件的面板入口不存在」。
//
// 模块导出形状（两种都认）：
//   export function activate(ctx) { ... }
//   export function deactivate() { ... }
//   export default { activate(ctx) { ... }, deactivate() {...} }
//   activate 必需（不是函数 → INVALID_EXPORT）；deactivate 可选。
//   两种都可以是 async，宿主会 await。
//
// ctx（宿主交给插件的全部东西）：
//   ctx.id        插件 id
//   ctx.dir       插件目录的绝对路径
//   ctx.version   清单里的版本号（没有就是 null）
//   ctx.log       插件日志。**是同一个东西的两种写法，两种都成立**：
//                   ctx.log('出事了')                  —— 当函数调，第二个参数可给级别
//                   ctx.log('出事了', 'warn')          —— 级别 ∈ info|warn|error；
//                                                          不认识的值按 info 处理，**不抛错**
//                   ctx.log.info('…') / .warn / .error —— 当对象调（对象形状仍在）
//                 每条会带上 `[plugin:<id>]` 前缀，并留一份最近 `maxLogLines` 条
//                 （默认 50，见构造器）给 /plugins 接口（排查「插件到底跑没跑起来」用）。
//                 **写日志永不抛错、不可失败**：宿主 logger 抛错、参数不可序列化、
//                 超限截断，都只会被吞掉或按上限裁剪，绝不会反过来把插件自己搞挂。
//   ctx.onDispose(fn) 登记一个清理回调，**由宿主统一管理**：插件被停用/重载/卸载时，
//                 宿主按**登记顺序的逆序**await 每个回调，回调抛错只记警告、不中断流程。
//                 插件不该自己管生命周期清理——这是宿主的职责，否则重载时会漏清理。
//                 （传进来的不是函数 → TypeError。这是 ctx 上唯一会抛的地方。）
//
// 关于 `fs.watch` 的**实测行为与降级**（不假装它一定可靠）
// ---------------------------------------------------------------------------
// 本内核用 `fs.watch`（非递归）监视插件根目录与每个插件目录，并对快照做**去抖**。
// 它有三个已知的现实问题：
//   1. 事件可能重复、可能合并、也可能在个别文件系统/网络盘上完全不报；
//   2. 编辑器「原子保存」（先写临时文件再 rename）在某些平台只报 rename；
//   3. 目录被删掉后，watcher 的回调不会再报，得靠根目录的 rescan 兜底。
// 所以：**自动重载是尽力而为，不是保证**。`GET /plugins` 会如实返回 `watching` 与
// `watchReason`；一旦建不起 watcher（平台不支持 / 权限 / 路径），宿主的降级行为是
// **只支持手动重载**（`POST /plugins/reload`），并把原因写在 `watchReason` 里。
// 手动重载这条路径永远可用，不依赖 fs.watch。
import fs from 'node:fs'
import path from 'node:path'
import { pathToFileURL } from 'node:url'
import { paths } from '../paths.js'

/** 插件状态。只有这四个值，接口与文档都以它为准。 */
export const PLUGIN_STATUS = Object.freeze({
  /** 发现了目录，但还没加载（宿主未 start / 已 stop） */
  DISCOVERED: 'discovered',
  /** 加载并 activate 成功 */
  LOADED: 'loaded',
  /** 加载/激活/清单校验任一环节失败：见 record.error */
  ERROR: 'error',
  /** 用户显式停用；不会自动重载 */
  DISABLED: 'disabled',
})

/** 插件级错误码。HTTP 路由把这里的 code 原样透出去，便于定位是**哪一环**出的问题。 */
export const PLUGIN_ERROR = Object.freeze({
  BAD_MANIFEST: 'BAD_MANIFEST',
  ENTRY_NOT_FOUND: 'ENTRY_NOT_FOUND',
  LOAD_FAILED: 'LOAD_FAILED',
  INVALID_EXPORT: 'INVALID_EXPORT',
  ACTIVATE_FAILED: 'ACTIVATE_FAILED',
  DEACTIVATE_FAILED: 'DEACTIVATE_FAILED',
  DISPOSE_FAILED: 'DISPOSE_FAILED',
})

/** 宿主级错误码（抛 PluginHostError 用）。 */
export const PLUGIN_HOST_ERROR = Object.freeze({
  PLUGIN_NOT_FOUND: 'PLUGIN_NOT_FOUND',
  PLUGIN_DISABLED: 'PLUGIN_DISABLED',
  PLUGIN_NOT_LOADED: 'PLUGIN_NOT_LOADED',
  PLUGIN_HOST_NOT_STARTED: 'PLUGIN_HOST_NOT_STARTED',
})

/** UI 声明的错误码。这些错误**按条隔离**：只影响那一条声明，不会让整个列表失效。 */
export const PLUGIN_UI_ERROR = Object.freeze({
  /** `ui` 不是对象，或 commands/panels 不是数组 */
  BAD_UI_SECTION: 'BAD_UI_SECTION',
  /** 一条命令声明形状不对（缺 cmd / cmd 不是 "/xxx" / 缺 prompt / label 类型错） */
  BAD_UI_COMMAND: 'BAD_UI_COMMAND',
  /** 一个面板声明形状不对（缺 id / id 字符集不合法 / title 类型错 / 缺 entry） */
  BAD_UI_PANEL: 'BAD_UI_PANEL',
  /** 面板 entry 解析后**落在插件目录之外**（`../`、绝对路径、或目录内的链接指到外面） */
  PANEL_ENTRY_ESCAPES_DIR: 'PLUGIN_PANEL_ESCAPES_DIR',
  /** 面板 entry 指的文件不存在（或不是普通文件） */
  PANEL_ENTRY_NOT_FOUND: 'PLUGIN_PANEL_ENTRY_NOT_FOUND',
  /** 请求里的 pluginId / panelId 形状不合法（含 `/`、`\`、`..`、空字节等） */
  PANEL_ID_INVALID: 'PLUGIN_PANEL_ID_INVALID',
  /** 请求的面板没有被该插件声明 */
  PANEL_NOT_DECLARED: 'PLUGIN_PANEL_NOT_DECLARED',
  /** 同一个斜杠命令被两个插件声明（第一个生效，其余上报） */
  DUPLICATE_COMMAND: 'PLUGIN_UI_DUPLICATE_COMMAND',
  /** 同一个插件里同一个面板 id 声明了两次（第一个生效，其余上报） */
  DUPLICATE_PANEL: 'PLUGIN_UI_DUPLICATE_PANEL',
})

/** 默认入口候选。`.mjs` 排在前面是有原因的：插件目录通常在用户数据目录下，
 *  那里没有 package.json，**裸 `.js` 会被 Node 当作 CommonJS**，用 ESM 语法写就会
 *  加载失败。`.mjs` 与作用域无关，永远按 ESM 解析。想用 `.js` 写 ESM，请在插件目录里
 *  放一个 `{"type":"module"}` 的 package.json（测试里就是这么演的）。 */
export const DEFAULT_ENTRY_CANDIDATES = Object.freeze(['plugin.mjs', 'plugin.js'])

/** 插件日志能用的级别。`ctx.log(msg, level)` 的第二个参数只认这三个；
 *  给别的值**不报错**，按 `info` 处理——日志参数写错不该让插件 activate 失败。 */
export const PLUGIN_LOG_LEVELS = Object.freeze(['info', 'warn', 'error'])
/** `ctx.log(msg)` 不带级别时用哪个。 */
export const DEFAULT_PLUGIN_LOG_LEVEL = 'info'

const PLUGIN_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]*$/
/** 斜杠命令的形状：`/` 开头，后面不许有空白或第二个 `/`。 */
const SLASH_COMMAND_PATTERN = /^\/[^\s/]+$/

export class PluginHostError extends Error {
  constructor(code, message) {
    super(message)
    this.name = 'PluginHostError'
    this.code = code
  }
}

/** 默认插件目录：`<ALICE_USER_DIR>/plugins`。
 *  环境变量 ALICE_PLUGINS_DIR 可整体覆盖（测试与多用户目录用）。
 *  **注意这里不 mkdir**：目录不存在就是「没有插件」，不是错误，也不该由宿主凭空造出来。 */
export function resolvePluginsDir() {
  const override = String(process.env.ALICE_PLUGINS_DIR || '').trim()
  if (override) return path.resolve(override)
  return path.join(paths.userDir, 'plugins')
}

function toText(value) {
  if (typeof value === 'string') return value
  if (value instanceof Error) return value.stack || value.message
  try { return JSON.stringify(value) } catch { return String(value) }
}

function errorMessage(error) {
  return error?.message || String(error)
}

function normalizeLogger(logger) {
  const noop = () => {}
  const pick = (name, fallback) => (typeof logger?.[name] === 'function' ? logger[name].bind(logger) : fallback)
  return {
    info: pick('info', noop),
    warn: pick('warn', noop),
    error: pick('error', noop),
  }
}

function statOrNull(target) {
  try { return fs.statSync(target, { throwIfNoEntry: false }) } catch { return null }
}

function isFile(target) {
  return statOrNull(target)?.isFile() === true
}

function isDirectory(target) {
  return statOrNull(target)?.isDirectory() === true
}

function isInside(dir, candidate) {
  const rel = path.relative(path.resolve(dir), path.resolve(candidate))
  return rel === '' || (!!rel && !rel.startsWith('..') && !path.isAbsolute(rel))
}

function manifestError(code, message) {
  return { code, message }
}

/**
 * 把一个面板 entry 解析成绝对路径，并确认它**在插件目录之内**。
 *
 * 这是插件 UI 扩展点上唯一的硬安全要求，也是整条链路上唯一不能出错的一步：面板文件是
 * 由**宿主进程**读出来、以 `text/html` 交给浏览器同源 iframe 的。一旦 entry 能指到插件
 * 目录之外，插件清单就成了「读取机器上任意文件」的原语（`../../../../Users/<用户>/.ssh/id_rsa`
 * 之类），而读取动作还发生在**宿主进程**的权限下。
 *
 * 判据是 `path.resolve` 之后做**路径前缀比较**（`path.relative` 的结果不以 `..` 开头、
 * 也不是绝对路径），而不是「字符串里有没有 `..`」或「字符串有没有以目录名开头」：
 *   · `a/../ui/panel.html` 解析后仍在目录内 → 应当放行（判据要落在**解析结果**上）；
 *   · `../weather-ui-evil/secret.html` 解析后落在**同级目录**，字符串前缀恰好，
 *     但路径前缀比较能看出来它出去了 → 必须拒绝。
 *
 * @param {string} pluginDir 插件目录（绝对路径）
 * @param {string} entry     清单里的相对路径
 * @returns {{ok: true, path: string} | {ok: false, code: string, error: string}}
 */
export function resolvePluginPanelPath(pluginDir, entry) {
  const where = typeof pluginDir === 'string' && pluginDir ? pluginDir : ''
  const raw = typeof entry === 'string' ? entry.trim() : ''
  if (!where) return { ok: false, code: PLUGIN_UI_ERROR.BAD_UI_PANEL, error: 'plugin directory is unknown' }
  if (!raw) return { ok: false, code: PLUGIN_UI_ERROR.BAD_UI_PANEL, error: 'panel "entry" must be a non-empty string' }
  if (path.isAbsolute(raw)) {
    return {
      ok: false,
      code: PLUGIN_UI_ERROR.PANEL_ENTRY_ESCAPES_DIR,
      error: `panel entry "${raw}" must be a relative path inside the plugin directory`,
    }
  }
  const abs = path.resolve(where, raw)
  if (!isInside(where, abs)) {
    return {
      ok: false,
      code: PLUGIN_UI_ERROR.PANEL_ENTRY_ESCAPES_DIR,
      error: `panel entry "${raw}" resolves outside the plugin directory`,
    }
  }
  return { ok: true, path: abs }
}

/**
 * 追加一道**符号链接 / junction** 检查。
 * `path.resolve` 只看字符串，看不见「插件目录里的一个链接指到了目录外」——那是前缀比较
 * 天然管不到的一类越界。文件不存在时 `realpathSync` 会抛，那属于「后面按 404 处理」的
 * 场景，这里不重复判断，返回 null 放行。
 * @returns {string|null} 越界说明，或 null（在目录内 / 判断不了）
 */
function linkedPathEscapesDir(dir, target) {
  try {
    const realDir = fs.realpathSync(dir)
    const realTarget = fs.realpathSync(target)
    if (isInside(realDir, realTarget)) return null
    return `panel file resolves (through a link) outside the plugin directory: ${realTarget}`
  } catch {
    return null
  }
}

function pushUiError(descriptor, code, message) {
  descriptor.uiErrors.push({ code, message })
}

/** 解析并校验 `ui.commands` 的**一条**声明。形状不对就记进 uiErrors、跳过这一条。 */
function parseUiCommand(raw, index, descriptor) {
  const where = `ui.commands[${index}]`
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
    pushUiError(descriptor, PLUGIN_UI_ERROR.BAD_UI_COMMAND, `${where} must be an object`)
    return
  }
  const cmd = typeof raw.cmd === 'string' ? raw.cmd.trim() : ''
  if (!SLASH_COMMAND_PATTERN.test(cmd)) {
    pushUiError(descriptor, PLUGIN_UI_ERROR.BAD_UI_COMMAND, `${where}.cmd must be a string like "/weather" (no spaces, no second slash)`)
    return
  }
  // prompt 是命令的**全部作用**（点它就是把这句预填进输入框）。没有它这条命令点了什么都不会
  // 发生——那比报错更糟，用户只会以为「插件坏了」。所以缺 prompt 当作声明写错。
  const prompt = typeof raw.prompt === 'string' ? raw.prompt : ''
  if (!prompt.trim()) {
    pushUiError(descriptor, PLUGIN_UI_ERROR.BAD_UI_COMMAND, `${where}.prompt must be a non-empty string: it is what gets prefilled into the composer, so a command without it would silently do nothing`)
    return
  }
  for (const field of ['label', 'description']) {
    if (raw[field] !== undefined && typeof raw[field] !== 'string') {
      pushUiError(descriptor, PLUGIN_UI_ERROR.BAD_UI_COMMAND, `${where}.${field} must be a string when present`)
      return
    }
  }
  descriptor.ui.commands.push({
    cmd,
    label: typeof raw.label === 'string' && raw.label.trim() ? raw.label.trim() : cmd,
    description: typeof raw.description === 'string' ? raw.description.trim() : '',
    prompt,
  })
}

/** 解析并校验 `ui.panels` 的**一条**声明。entry 越界或文件不存在都记进 uiErrors、跳过这一条。 */
function parseUiPanel(raw, index, dirPath, descriptor) {
  const where = `ui.panels[${index}]`
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
    pushUiError(descriptor, PLUGIN_UI_ERROR.BAD_UI_PANEL, `${where} must be an object`)
    return
  }
  const id = typeof raw.id === 'string' ? raw.id.trim() : ''
  if (!PLUGIN_ID_PATTERN.test(id)) {
    pushUiError(descriptor, PLUGIN_UI_ERROR.BAD_UI_PANEL, `${where}.id must match ${PLUGIN_ID_PATTERN}`)
    return
  }
  if (raw.title !== undefined && typeof raw.title !== 'string') {
    pushUiError(descriptor, PLUGIN_UI_ERROR.BAD_UI_PANEL, `${where}.title must be a string when present`)
    return
  }
  if (descriptor.ui.panels.some(panel => panel.id === id)) {
    pushUiError(descriptor, PLUGIN_UI_ERROR.DUPLICATE_PANEL, `${where}.id "${id}" is declared more than once in this plugin; only the first is used`)
    return
  }
  const resolved = resolvePluginPanelPath(dirPath, raw.entry)
  if (!resolved.ok) {
    pushUiError(descriptor, resolved.code, `${where}.entry: ${resolved.error}`)
    return
  }
  if (!isFile(resolved.path)) {
    pushUiError(
      descriptor,
      PLUGIN_UI_ERROR.PANEL_ENTRY_NOT_FOUND,
      `${where}.entry "${typeof raw.entry === 'string' ? raw.entry : String(raw.entry)}" is not a file inside the plugin directory`,
    )
    return
  }
  descriptor.ui.panels.push({
    id,
    title: typeof raw.title === 'string' && raw.title.trim() ? raw.title.trim() : id,
    entry: typeof raw.entry === 'string' ? raw.entry.trim() : '',
    path: resolved.path,
  })
}

/**
 * 解析 `plugin.json` 的 `ui` 段（可选）。
 * **任何一条声明写错都不影响别的声明、也不影响插件加载**——错误只落在 `descriptor.uiErrors`。
 */
function readPluginUiSection(rawUi, dirPath, descriptor) {
  if (rawUi === undefined) return
  descriptor.ui.declared = true
  if (!rawUi || typeof rawUi !== 'object' || Array.isArray(rawUi)) {
    pushUiError(descriptor, PLUGIN_UI_ERROR.BAD_UI_SECTION, 'plugin.json "ui" must be an object with optional "commands" and "panels" arrays')
    return
  }
  for (const field of ['commands', 'panels']) {
    if (rawUi[field] === undefined) continue
    if (!Array.isArray(rawUi[field])) {
      pushUiError(descriptor, PLUGIN_UI_ERROR.BAD_UI_SECTION, `plugin.json "ui.${field}" must be an array`)
      continue
    }
    rawUi[field].forEach((item, index) => {
      if (field === 'commands') parseUiCommand(item, index, descriptor)
      else parseUiPanel(item, index, dirPath, descriptor)
    })
  }
}

/**
 * 读一个插件目录的清单与入口。**纯发现，不加载**。
 * 任何形状问题都在这里变成 `manifestError` / `entryError`，而不是抛异常——一个插件的
 * 配置写错不该影响别的插件，也不该让宿主崩。
 * @param {string} dirPath
 * @param {string} dirName
 */
export function readPluginDirectory(dirPath, dirName = path.basename(dirPath)) {
  const descriptor = {
    id: dirName,
    dir: dirPath,
    hasManifest: false,
    manifestPath: null,
    manifestError: null,
    version: null,
    entry: null,
    entryPath: null,
    entryError: null,
    /** 清单里声明的 UI 扩展点（命令 + 面板）。declared=false 表示清单里根本没有 ui 段。 */
    ui: { declared: false, commands: [], panels: [] },
    /** UI 声明的逐条错误，**不影响插件加载**，只如实上报给 GET /plugins/ui 的 errors。 */
    uiErrors: [],
  }

  const manifestPath = path.join(dirPath, 'plugin.json')
  const manifestStat = statOrNull(manifestPath)
  let parsed = null

  if (manifestStat && !manifestStat.isFile()) {
    descriptor.hasManifest = true
    descriptor.manifestPath = manifestPath
    descriptor.manifestError = manifestError(PLUGIN_ERROR.BAD_MANIFEST, `${manifestPath} exists but is not a regular file`)
    return descriptor
  }

  if (manifestStat) {
    descriptor.hasManifest = true
    descriptor.manifestPath = manifestPath
    let text = null
    try {
      text = fs.readFileSync(manifestPath, 'utf8')
    } catch (error) {
      descriptor.manifestError = manifestError(PLUGIN_ERROR.BAD_MANIFEST, `plugin.json could not be read: ${errorMessage(error)}`)
      return descriptor
    }
    try {
      parsed = JSON.parse(text)
    } catch (error) {
      descriptor.manifestError = manifestError(
        PLUGIN_ERROR.BAD_MANIFEST,
        `plugin.json is not valid JSON: ${errorMessage(error)}${text.length < 200 ? ` (received: ${text})` : ''}`,
      )
      return descriptor
    }
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
      descriptor.manifestError = manifestError(PLUGIN_ERROR.BAD_MANIFEST, 'plugin.json must contain a JSON object')
      return descriptor
    }
    if (parsed.id !== undefined) {
      if (typeof parsed.id !== 'string' || !PLUGIN_ID_PATTERN.test(parsed.id)) {
        descriptor.manifestError = manifestError(PLUGIN_ERROR.BAD_MANIFEST, `plugin.json "id" must match ${PLUGIN_ID_PATTERN}`)
        return descriptor
      }
      descriptor.id = parsed.id
    }
    if (parsed.version !== undefined) {
      if (typeof parsed.version !== 'string' || !parsed.version.trim()) {
        descriptor.manifestError = manifestError(PLUGIN_ERROR.BAD_MANIFEST, 'plugin.json "version" must be a non-empty string')
        return descriptor
      }
      descriptor.version = parsed.version.trim()
    }
    if (parsed.entry !== undefined) {
      if (typeof parsed.entry !== 'string' || !parsed.entry.trim()) {
        descriptor.manifestError = manifestError(PLUGIN_ERROR.BAD_MANIFEST, 'plugin.json "entry" must be a non-empty string')
        return descriptor
      }
      const entry = parsed.entry.trim()
      if (path.isAbsolute(entry) || entry.split(/[\\/]/).includes('..')) {
        // 入口逃出插件目录意味着「清单能指定宿主去 import 任意路径」——那是把
        // 「放一个插件」变成「让宿主执行机器上任何文件」，必须当场拒绝。
        descriptor.manifestError = manifestError(PLUGIN_ERROR.BAD_MANIFEST, 'plugin.json "entry" must be a relative path inside the plugin directory')
        return descriptor
      }
      descriptor.entry = entry
    }
    // ui 段在 id / version / entry 之后解析：上面任何一处写错都会提前 return，
    // 此时整份清单都不可信，再去解析它的 ui 段只会得到一堆连带噪音。
    readPluginUiSection(parsed.ui, dirPath, descriptor)
  }

  const candidates = descriptor.entry ? [descriptor.entry] : DEFAULT_ENTRY_CANDIDATES
  for (const rel of candidates) {
    const abs = path.resolve(dirPath, rel)
    if (!isInside(dirPath, abs)) {
      descriptor.entryError = manifestError(PLUGIN_ERROR.BAD_MANIFEST, `entry "${rel}" resolves outside the plugin directory`)
      return descriptor
    }
    if (isFile(abs)) {
      descriptor.entry = rel
      descriptor.entryPath = abs
      break
    }
  }
  if (!descriptor.entryPath) {
    descriptor.entryError = manifestError(
      PLUGIN_ERROR.ENTRY_NOT_FOUND,
      `no plugin entry found in ${dirPath}: expected ${candidates.join(' or ')}`,
    )
  }
  return descriptor
}

/** 从模块命名空间里挑出实现对象。ESM 具名导出与 `export default {}`、以及 CJS 的
 *  `module.exports = {}`（此时它在 `default` 上）都能落到同一个判据上。 */
export function pickPluginImplementation(moduleNamespace) {
  const namespace = moduleNamespace || {}
  const fallback = namespace.default
  if (fallback && typeof fallback === 'object' && typeof fallback.activate === 'function') return fallback
  if (typeof namespace.activate === 'function') return namespace
  return null
}

export class PluginHost {
  /**
   * @param {object} [options]
   * @param {string} [options.dir]              插件根目录，默认 resolvePluginsDir()
   * @param {object} [options.logger]           { info, warn, error }
   * @param {number} [options.reloadDebounceMs] 文件事件去抖窗口，默认 250ms
   * @param {number} [options.maxLogLines]      每个插件保留的最近日志条数
   * @param {Function} [options.watch]          覆盖 fs.watch（测试里用来演「平台不支持」）
   */
  constructor(options = {}) {
    this.dir = options.dir ? path.resolve(options.dir) : resolvePluginsDir()
    this.logger = normalizeLogger(options.logger || console)
    this.reloadDebounceMs = Number.isFinite(options.reloadDebounceMs) ? Math.max(0, options.reloadDebounceMs) : 250
    this.maxLogLines = Number.isFinite(options.maxLogLines) ? Math.max(1, options.maxLogLines) : 50
    this.watchImpl = typeof options.watch === 'function' ? options.watch : fs.watch.bind(fs)

    /** @type {Map<string, object>} id -> 记录（含内部字段，对外只发 _publicRecord） */
    this.records = new Map()
    /** @type {Map<string, {module: object|null, disposers: Function[]}>} */
    this.internals = new Map()
    /** @type {Map<string, fs.FSWatcher>} 按插件 id 索引的 watcher */
    this.watchers = new Map()
    /** @type {fs.FSWatcher|null} 插件根目录的 watcher（单独一个字段，避免和插件 id 撞 key） */
    this.rootWatcher = null
    /** @type {Map<string, NodeJS.Timeout>} 去抖定时器，key 是 'root' 或 `plugin:<id>` */
    this.timers = new Map()

    this.started = false
    this.dirExists = false
    this.dirError = null
    this.watching = false
    this.watchReason = null
    /** 同一个 id 被多个目录声明时，只保留排序最前的那个，其余记在这里——静默丢一个插件
     *  比报个冲突危险得多（用户会以为它加载了）。 */
    this.conflicts = []
    this.importCounter = 0
  }

  // ── 对外只读视图 ────────────────────────────────────────────────────

  /** 给 HTTP / 人看的状态快照。只含可序列化字段，不含模块引用。 */
  snapshot() {
    return {
      dir: this.dir,
      dirExists: this.dirExists,
      watching: this.watching,
      watchReason: this.watchReason,
      dirError: this.dirError,
      conflicts: this.conflicts.map(c => ({ ...c })),
      count: this.records.size,
      plugins: this.list(),
    }
  }

  list() {
    return [...this.records.values()].map(record => this._publicRecord(record))
  }

  get(id) {
    const record = this.records.get(String(id || ''))
    return record ? this._publicRecord(record) : null
  }

  _publicRecord(record) {
    return {
      id: record.id,
      dir: record.dir,
      status: record.status,
      enabled: record.enabled,
      hasManifest: record.hasManifest,
      manifestPath: record.manifestPath,
      version: record.version,
      entry: record.entry,
      entryPath: record.entryPath,
      error: record.error ? { ...record.error } : null,
      warnings: record.warnings.map(w => ({ ...w })),
      loadedAt: record.loadedAt,
      activateCount: record.activateCount,
      watching: this.watchers.has(record.id),
      watchReason: record.watchReason,
      logs: record.logs.map(line => ({ ...line })),
      // UI 声明只给**计数**：完整的声明走 GET /plugins/ui（那是给界面用的汇总视图）。
      // 错误逐条给出来，因为「为什么我的面板没出现」只能在这里查。
      ui: {
        declared: record.ui.declared,
        commands: record.ui.commands.length,
        panels: record.ui.panels.length,
        errors: record.uiErrors.map(e => ({ ...e })),
      },
    }
  }

  // ── UI 扩展点（命令 + 面板） ─────────────────────────────────────────

  /**
   * 汇总所有插件声明的 UI，交给 `GET /plugins/ui`。
   *
   * 三条刻意的规矩：
   * 1. **只有 enabled 且 status=loaded 的插件**才贡献命令与面板。插件没跑起来就不该
   *    出现在斜杠菜单或面板列表里——那会让用户以为它在工作。
   * 2. 清单里的 ui 声明写错 → 进 `errors`（**带 plugin_id**），只影响那一条声明。
   *    **绝不静默丢掉**：界面要能告诉用户「某个插件的面板入口不存在」。
   * 3. 跨插件的同名斜杠命令 → **第一个生效**，其余进 errors。静默覆盖会留下一个
   *    「怎么点都不对」的菜单项。
   *
   * @returns {{commands: object[], panels: object[], errors: object[]}}
   */
  collectUi() {
    const commands = []
    const panels = []
    const errors = []
    const commandOwners = new Map()

    for (const record of this.records.values()) {
      if (!record.enabled) continue

      for (const uiError of record.uiErrors) {
        errors.push({ plugin_id: record.id, ...uiError })
      }
      // 这个插件加载不起来 → 它的 ui 声明无法生效，界面**必须说出来**，
      // 否则用户看到的是「我明明声明了面板，界面上什么都没有」。
      //
      // 注意这里的措辞：能走到 `record.ui.declared === true`，说明清单**是合法的**、
      // ui 段**确实被读到了**，坏的是入口那一层（文件不存在/已消失）。原先写成
      // 「plugin.json is invalid, so its ui section was not read」两半都是错的，
      // 会把用户引去改一份根本没问题的 plugin.json。
      if (record.contractError && record.ui.declared) {
        errors.push({
          plugin_id: record.id,
          code: record.contractError.code,
          message: record.contractError.code === PLUGIN_ERROR.ENTRY_NOT_FOUND
            ? `this plugin's ui declarations cannot take effect because its entry file was not found: ${record.contractError.message}`
            : `this plugin's ui declarations cannot take effect because the plugin could not be loaded: ${record.contractError.message}`,
        })
      }

      if (record.status !== PLUGIN_STATUS.LOADED) continue

      for (const item of record.ui.commands) {
        const owner = commandOwners.get(item.cmd)
        if (owner) {
          errors.push({
            plugin_id: record.id,
            code: PLUGIN_UI_ERROR.DUPLICATE_COMMAND,
            message: `command "${item.cmd}" is already declared by plugin "${owner}"; this declaration is ignored`,
          })
          continue
        }
        commandOwners.set(item.cmd, record.id)
        commands.push({
          plugin_id: record.id,
          cmd: item.cmd,
          label: item.label,
          description: item.description,
          prompt: item.prompt,
        })
      }

      for (const item of record.ui.panels) {
        // 面板 URL 里带 plugin_id，所以跨插件的同名面板 id 不冲突；同一个插件里
        // 重名在 parseUiPanel 那一层就报掉了。
        panels.push({
          plugin_id: record.id,
          id: item.id,
          title: item.title,
          entry: item.entry,
          url: `/plugins/ui/${record.id}/${item.id}`,
        })
      }
    }

    return { commands, panels, errors }
  }

  /**
   * 取一个**已声明**的面板文件（`GET /plugins/ui/:pluginId/:panelId` 用）。
   *
   * 请求里的路径**一个字都不信**：插件目录来自宿主的记录，面板 entry 来自清单校验通过的
   * 声明，最后仍然再走一遍 `resolvePluginPanelPath()` 的越界判定 + 一道符号链接检查——
   * 因为这行代码是「读机器上任意文件」与「读插件自己目录里的文件」之间的唯一那道门。
   * @returns {{ok: true, path: string, panel: object, pluginId: string}|{ok: false, status: number, code: string, error: string}}
   */
  findPanelFile(pluginId, panelId) {
    const id = String(pluginId || '')
    const wanted = String(panelId || '')
    const record = this.records.get(id)
    if (!record) {
      return { ok: false, status: 404, code: PLUGIN_HOST_ERROR.PLUGIN_NOT_FOUND, error: `plugin "${id}" is not in ${this.dir}` }
    }
    if (!record.enabled) {
      return { ok: false, status: 409, code: PLUGIN_HOST_ERROR.PLUGIN_DISABLED, error: `plugin "${id}" is disabled` }
    }
    if (record.status !== PLUGIN_STATUS.LOADED) {
      return { ok: false, status: 409, code: PLUGIN_HOST_ERROR.PLUGIN_NOT_LOADED, error: `plugin "${id}" is not loaded (status=${record.status}); its ui is not offered` }
    }
    const panel = record.ui.panels.find(item => item.id === wanted)
    if (!panel) {
      return { ok: false, status: 404, code: PLUGIN_UI_ERROR.PANEL_NOT_DECLARED, error: `plugin "${id}" does not declare a panel "${wanted}"` }
    }
    const resolved = resolvePluginPanelPath(record.dir, panel.entry)
    if (!resolved.ok) {
      return { ok: false, status: 400, code: resolved.code, error: resolved.error }
    }
    const linkEscape = linkedPathEscapesDir(record.dir, resolved.path)
    if (linkEscape) {
      return { ok: false, status: 400, code: PLUGIN_UI_ERROR.PANEL_ENTRY_ESCAPES_DIR, error: linkEscape }
    }
    if (!isFile(resolved.path)) {
      return { ok: false, status: 404, code: PLUGIN_UI_ERROR.PANEL_ENTRY_NOT_FOUND, error: `panel file is missing: ${panel.entry}` }
    }
    return { ok: true, path: resolved.path, panel: { ...panel }, pluginId: id }
  }

  // ── 发现 ────────────────────────────────────────────────────────────

  /**
   * 扫描插件根目录。**目录不存在 → 空列表，不报错。**
   * @returns {{dir: string, exists: boolean, error: string|null, plugins: object[]}}
   */
  discover() {
    const result = { dir: this.dir, exists: false, error: null, plugins: [] }
    const stats = statOrNull(this.dir)
    if (!stats) return result
    if (!stats.isDirectory()) {
      result.exists = true
      result.error = `${this.dir} exists but is not a directory`
      return result
    }
    result.exists = true

    let entries
    try {
      entries = fs.readdirSync(this.dir, { withFileTypes: true })
    } catch (error) {
      result.error = `could not read ${this.dir}: ${errorMessage(error)}`
      return result
    }

    for (const entry of entries.sort((a, b) => a.name.localeCompare(b.name))) {
      if (!entry.isDirectory()) continue
      if (entry.name.startsWith('.')) continue // .git 之类不是插件
      result.plugins.push(readPluginDirectory(path.join(this.dir, entry.name), entry.name))
    }
    return result
  }

  // ── 生命周期 ────────────────────────────────────────────────────────

  async start() {
    if (this.started) return this.snapshot()
    this.started = true
    this._hostLog('info', `plugin host scanning ${this.dir}`)
    await this._rescan()
    this._startWatching()
    this._hostLog('info', this.watching
      ? `plugin host watching ${this.dir} (auto reload on file change)`
      : `plugin host NOT watching (${this.watchReason}); manual reload only`)
    return this.snapshot()
  }

  /** 停宿主：关掉全部 watcher，按逆序跑清理回调，状态回到 discovered。 */
  async stop() {
    this.started = false
    for (const timer of this.timers.values()) clearTimeout(timer)
    this.timers.clear()
    for (const watcher of this.watchers.values()) {
      try { watcher.close() } catch { /* 关不掉也不该影响停机 */ }
    }
    this.watchers.clear()
    if (this.rootWatcher) {
      try { this.rootWatcher.close() } catch { /* 同上 */ }
      this.rootWatcher = null
    }
    this.watching = false
    this.watchReason = null

    for (const record of this.records.values()) {
      if (this._internalOf(record)?.module) {
        // 走串行链：可能有一个重载正好跑到一半
        const warnings = await this._run(record, () => this._deactivate(record))
        if (warnings.length) record.warnings = warnings
      }
      record.status = PLUGIN_STATUS.DISCOVERED
    }
    this._hostLog('info', 'plugin host stopped')
    return this.snapshot()
  }

  /**
   * 重新扫描：新目录加载、消失的目录卸载、清单/入口元数据刷新。
   *
   * **对账的单位是目录，不是一个 id。** 一个插件目录最多对应一条记录：用户把
   * `plugin.json` 里的 `id` 改掉之后，同一目录上的旧记录必须被替换掉（先跑掉它的
   * dispose），而不是让「旧 id + 新 id」两条记录同时指向这个目录——那样旧的那条
   * 永远等不到自己的目录消失（它并非「目录不在了」），只有重启才会被忘掉。
   */
  async _rescan() {
    const discovery = this.discover()
    this.dirExists = discovery.exists
    this.dirError = discovery.error

    if (!discovery.exists) {
      // 整个插件目录没了：把已加载的插件全部卸掉（不静默留着一堆「loaded」的幽灵记录）
      for (const id of [...this.records.keys()]) await this.unload(id)
      this.conflicts = []
      return this.snapshot()
    }

    if (discovery.error) {
      // 目录**读失败**（不是「不存在」）：这一轮不做任何增删。一次 readdir 失败
      // 不该让所有插件消失——那比「多留一条记录」危险得多。
      this.conflicts = []
      return this.snapshot()
    }

    // 发现结果先按 id 去重（同一个 id 被多个目录声明时只留第一个，其余如实记成冲突），
    // 再按目录建索引。
    const conflicts = []
    const byId = new Map()
    const byDir = new Map()
    for (const descriptor of discovery.plugins) {
      const kept = byId.get(descriptor.id)
      if (kept) {
        conflicts.push({
          id: descriptor.id,
          kept: kept.dir,
          dropped: descriptor.dir,
          message: `plugin id "${descriptor.id}" is declared by more than one directory; only the first is loaded`,
        })
        continue
      }
      byId.set(descriptor.id, descriptor)
      byDir.set(descriptor.dir, descriptor)
    }

    // ① 同一目录只留一条记录：优先留 id 与这次发现结果一致的那条。对不上任何发现结果
    //    的记录（孤儿，比如改过 id 留下的旧记录）与同目录的重复记录都进 stale 待删。
    const byDirRecord = new Map()
    const stale = []
    for (const record of [...this.records.values()]) {
      const descriptor = byDir.get(record.dir)
      const existing = byDirRecord.get(record.dir)
      if (!existing) {
        if (descriptor) byDirRecord.set(record.dir, record)
        else stale.push(record)
        continue
      }
      const wanted = descriptor?.id
      if (wanted && existing.id !== wanted && record.id === wanted) {
        byDirRecord.set(record.dir, record)
        stale.push(existing)
      } else {
        stale.push(record)
      }
    }

    // ② 先卸掉 stale：既清掉孤儿，也把它们占着的 id 腾出来，免得下面换 key 时撞上
    //    一条更旧的记录。unload 会跑 deactivate + dispose，不泄漏。
    for (const record of stale) await this.unload(record.id)

    // ③ 逐目录套用发现结果；同一目录换了 id 的，先清理旧实例再整体换 key。
    for (const descriptor of byDir.values()) {
      let record = byDirRecord.get(descriptor.dir)
      if (!record) {
        // 新目录：新建记录并激活（原行为）。
        record = this._createRecord(descriptor)
        this.records.set(descriptor.id, record)
        await this._run(record, () => this._activate(record))
        continue
      }
      if (record.id !== descriptor.id) {
        // 同一目录换了 id：先把旧 id 下那个实例清理干净（deactivate + 逆序 dispose），
        // 再把记录整体换到新 id 上。只改 record.id 是不够的——records / internals /
        // watchers 都以 id 为键，漏搬一个就留下半截状态。
        const warnings = await this._run(record, async () => {
          const collected = await this._deactivate(record)
          // 被停用的记录改 id 后仍然是被停用，不许因为一次重扫就变回 discovered
          record.status = record.enabled ? PLUGIN_STATUS.DISCOVERED : PLUGIN_STATUS.DISABLED
          return collected
        })
        if (warnings.length) record.warnings = warnings
        this._rekeyRecord(record, descriptor.id)
      }
      this._applyDescriptor(record, descriptor)
      // 已经 loaded 且 id 没变的插件**不重复 activate**（普通 rescan 不该让
      // activateCount 增长）；只有新目录、换过 id、或上一轮加载失败的才需要激活。
      await this._run(record, async () => {
        if (record.enabled && record.status !== PLUGIN_STATUS.LOADED) {
          await this._activate(record)
        }
      })
    }

    this.conflicts = conflicts
    for (const conflict of conflicts) this._hostLog('warn', conflict.message)
    return this.snapshot()
  }

  _createRecord(descriptor) {
    const record = {
      id: descriptor.id,
      dir: descriptor.dir,
      status: PLUGIN_STATUS.DISCOVERED,
      enabled: true,
      hasManifest: false,
      manifestPath: null,
      version: null,
      entry: null,
      entryPath: null,
      /** 清单/入口层的契约错误：每次刷新都可能被改好或改坏 */
      contractError: null,
      error: null,
      warnings: [],
      loadedAt: null,
      activateCount: 0,
      watchReason: null,
      logs: [],
      /** 清单里声明的 UI 扩展点（命令 + 面板）与逐条错误；discover/reload 时刷新 */
      ui: { declared: false, commands: [], panels: [] },
      uiErrors: [],
      /** 每个插件一条操作串行链：文件事件与手动重载**随时可能撞在一起**，
       *  并发跑 deactivate/import/activate 会留下半截状态。所有会改插件状态的操作
       *  都从 _run() 走这条链。 */
      chain: Promise.resolve(),
    }
    this._applyDescriptor(record, descriptor)
    this.internals.set(record.id, { module: null, disposers: [] })
    return record
  }

  _applyDescriptor(record, descriptor) {
    record.dir = descriptor.dir
    record.hasManifest = descriptor.hasManifest
    record.manifestPath = descriptor.manifestPath
    record.version = descriptor.manifestError ? null : descriptor.version
    record.entry = descriptor.entry
    record.entryPath = descriptor.entryPath
    record.contractError = descriptor.manifestError || descriptor.entryError || null
    // 深拷一份：descriptor 是每次 discover 新建的，但 record 会被反复 _applyDescriptor，
    // 共享数组会让「上一轮的声明」在新一轮之后还活着。
    const ui = descriptor.ui || { declared: false, commands: [], panels: [] }
    record.ui = {
      declared: ui.declared === true,
      commands: (ui.commands || []).map(item => ({ ...item })),
      panels: (ui.panels || []).map(item => ({ ...item })),
    }
    record.uiErrors = (descriptor.uiErrors || []).map(item => ({ ...item }))
  }

  /**
   * 把一条记录换到新的 id 上。**所有以 id 为键的表都要一起搬**（records / internals /
   * watchers / 该插件的去抖定时器），否则换 key 只会把状态撕成两半：旧 id 下的
   * module/watcher 变成没人认领的泄漏，新 id 又找不到它们。
   *
   * 目标 id 可能正被**另一条**记录占着（比如两个目录互换 id）：那类记录同样在本次
   * 目录对账里，把它先摘下来暂存、稍后由它自己的那一轮挂到它该去的 id 上，比直接覆盖
   * 安全——覆盖会连同它的 internals/watcher 一起丢掉。
   *
   * 调用方负责先跑掉旧实例的 deactivate + dispose——这个方法只管搬 key。
   * 只能在 `_rescan()` 的目录对账循环里调用：那里保证每条被摘下的记录都会被再挂回去。
   */
  _rekeyRecord(record, newId) {
    if (record.id === newId) return
    const occupant = this.records.get(newId)
    if (occupant && occupant !== record) this._detachRecord(occupant)
    this._detachRecord(record)
    this._attachRecord(record, newId)
  }

  /** 把记录从所有以 id 为键的表里摘下来，连它的 internals / watcher / 去抖定时器
   *  一起暂存在记录上，等 `_attachRecord()` 用新 id 挂回去。 */
  _detachRecord(record) {
    const id = record.id
    if (this.records.get(id) === record) this.records.delete(id)
    if (record._parked) return
    const parked = {
      internal: this.internals.get(id) || null,
      watcher: this.watchers.get(id) || null,
      timer: this.timers.get(`plugin:${id}`) || null,
    }
    if (parked.internal) this.internals.delete(id)
    if (parked.watcher) this.watchers.delete(id)
    if (parked.timer) this.timers.delete(`plugin:${id}`)
    record._parked = parked
  }

  _attachRecord(record, newId) {
    record.id = newId
    this.records.set(newId, record)
    const parked = record._parked || { internal: null, watcher: null, timer: null }
    delete record._parked
    if (parked.internal) this.internals.set(newId, parked.internal)
    if (parked.watcher) this.watchers.set(newId, parked.watcher)
    if (parked.timer) this.timers.set(`plugin:${newId}`, parked.timer)
  }

  /** 取记录当前的 internals。换 key 过程中记录可能被短暂摘下来（`_parked`），
   *  这时它的 internals 暂存在记录上——清理必须照样找得到，否则 deactivate/dispose
   *  会被静默跳过。 */
  _internalOf(record) {
    return this.internals.get(record.id) || record._parked?.internal || null
  }

  /** 重新读一遍清单与入口（用户改好 plugin.json 之后手动 reload 也要生效）。 */
  _refreshMetadata(record) {
    const descriptor = readPluginDirectory(record.dir, path.basename(record.dir))
    this._applyDescriptor(record, descriptor)
    return descriptor
  }

  // ── 加载 / 停用 ─────────────────────────────────────────────────────

  async _activate(record) {
    record.warnings = []

    if (record.contractError) {
      record.status = PLUGIN_STATUS.ERROR
      record.error = { ...record.contractError, at: Date.now() }
      this._pluginLog(record, 'error', record.error.message)
      return record
    }
    if (!record.entryPath || !isFile(record.entryPath)) {
      record.status = PLUGIN_STATUS.ERROR
      record.error = {
        code: PLUGIN_ERROR.ENTRY_NOT_FOUND,
        message: `entry file is missing: ${record.entryPath || record.entry}`,
        at: Date.now(),
      }
      return record
    }

    // 缓存破坏：同一个文件 URL 追加不同的 query，Node 的 ESM loader 会当成不同的模块
    // 重新求值——这是热重载能拿到**新代码**的关键一行。没有它，reload 只是又跑了一遍
    // 老模块，日志看着「重载成功」而代码一个字都没变。
    const moduleUrl = `${pathToFileURL(record.entryPath).href}?blm_reload=${++this.importCounter}`

    let namespace
    try {
      namespace = await import(moduleUrl)
    } catch (error) {
      record.status = PLUGIN_STATUS.ERROR
      record.error = {
        code: PLUGIN_ERROR.LOAD_FAILED,
        message: `could not import ${record.entryPath}: ${errorMessage(error)}`,
        at: Date.now(),
      }
      this._pluginLog(record, 'error', record.error.message)
      return record
    }

    const implementation = pickPluginImplementation(namespace)
    if (!implementation) {
      record.status = PLUGIN_STATUS.ERROR
      record.error = {
        code: PLUGIN_ERROR.INVALID_EXPORT,
        message: `${record.entryPath} must export { activate(ctx), deactivate() } (named or default)`,
        at: Date.now(),
      }
      this._pluginLog(record, 'error', record.error.message)
      return record
    }

    const internal = this._internalOf(record) || { module: null, disposers: [] }
    this.internals.set(record.id, internal)
    internal.module = implementation
    internal.disposers = []

    try {
      await implementation.activate(this._createContext(record))
    } catch (error) {
      // 激活到一半失败：把它这一步注册过的清理回调照样跑一遍，别把半截状态留下
      const warnings = await this._runDisposers(internal)
      internal.module = null
      record.status = PLUGIN_STATUS.ERROR
      record.error = {
        code: PLUGIN_ERROR.ACTIVATE_FAILED,
        message: `activate() threw: ${errorMessage(error)}`,
        at: Date.now(),
      }
      record.warnings = warnings
      this._pluginLog(record, 'error', record.error.message)
      return record
    }

    record.status = PLUGIN_STATUS.LOADED
    record.error = null
    record.loadedAt = Date.now()
    record.activateCount += 1
    this._pluginLog(record, 'info', `activated (${record.entry})`)
    return record
  }

  /**
   * 停用：先调插件自己的 `deactivate()`，再按**逆序**跑宿主代管的 dispose 回调。
   * 任何一步抛错都只记成 warning，绝不让它中断流程——否则「重载」会被一个坏清理函数
   * 卡死在半路，插件再也回不到可用状态。
   */
  async _deactivate(record) {
    const internal = this._internalOf(record)
    if (!internal) return []
    const warnings = []
    const implementation = internal.module

    if (implementation && typeof implementation.deactivate === 'function') {
      try {
        await implementation.deactivate()
      } catch (error) {
        warnings.push({ code: PLUGIN_ERROR.DEACTIVATE_FAILED, message: `deactivate() threw: ${errorMessage(error)}` })
      }
    }
    warnings.push(...await this._runDisposers(internal))
    internal.module = null
    return warnings
  }

  async _runDisposers(internal) {
    const warnings = []
    const callbacks = internal.disposers.splice(0).reverse()
    for (const callback of callbacks) {
      try {
        await callback()
      } catch (error) {
        warnings.push({ code: PLUGIN_ERROR.DISPOSE_FAILED, message: `onDispose callback threw: ${errorMessage(error)}` })
      }
    }
    return warnings
  }

  /** 把一个会改变插件状态的操作排到该插件的串行链上。前一个操作失败也要继续跑下一个
   *  （否则一个坏重载会把这条插件永久卡死）。 */
  _run(record, task) {
    const run = record.chain.then(task, task)
    record.chain = run.then(() => undefined, () => undefined)
    return run
  }

  // ── 对外的加载 / 重载 / 卸载 / 启停 ──────────────────────────────────

  _requireRecord(id) {
    const key = String(id || '').trim()
    if (!key) throw new PluginHostError(PLUGIN_HOST_ERROR.PLUGIN_NOT_FOUND, 'plugin id is required')
    const record = this.records.get(key)
    if (!record) throw new PluginHostError(PLUGIN_HOST_ERROR.PLUGIN_NOT_FOUND, `plugin "${key}" is not in ${this.dir}`)
    return record
  }

  /** 手动重载一个插件：deactivate → 重读清单 → 缓存破坏重新 import → activate。 */
  async reload(id) {
    const record = this._requireRecord(id)
    if (!record.enabled) {
      throw new PluginHostError(PLUGIN_HOST_ERROR.PLUGIN_DISABLED, `plugin "${record.id}" is disabled; enable it before reloading`)
    }
    // 清单里的 id 被改过：这不是「重载同一个插件」，而是同一个**目录**换了 id。
    // 交给 _rescan 的目录对账（它会先跑旧实例的 dispose，再整体换 key），不能在这里
    // 自己改 record.id——目标 id 可能正被另一条记录占着，直接覆盖会把它连
    // internals/watcher 一起丢掉。目录本身已经不在时保持原行为（当作一次失败的加载）。
    const probe = isDirectory(record.dir) ? readPluginDirectory(record.dir, path.basename(record.dir)) : null
    if (probe && probe.id !== record.id) {
      await this._rescan()
      const renamed = this.records.get(probe.id)
      if (!renamed) {
        throw new PluginHostError(PLUGIN_HOST_ERROR.PLUGIN_NOT_FOUND, `plugin "${probe.id}" is not in ${this.dir}`)
      }
      return this._publicRecord(renamed)
    }
    return this._run(record, async () => {
      // 吃掉尚未触发的 watcher 去抖：否则「改文件 + 手动重载」会让插件被激活两次
      // （实测 50% 复现）。手动重载是更明确的意图，它覆盖掉那次自动重载的效果。
      this._cancelPendingFor(record)
      const warnings = await this._deactivate(record)
      this._refreshMetadata(record)
      await this._activate(record)
      // 合并而不是覆盖：_activate 在「激活到一半失败」时也会写 warnings
      record.warnings = [...warnings, ...record.warnings]
      return this._publicRecord(record)
    })
  }

  /** 重新扫描并重载**所有**启用的插件（等价于「全部重载」按钮）。 */
  async reloadAll() {
    await this._rescan()
    for (const record of [...this.records.values()]) {
      if (!record.enabled) continue
      await this.reload(record.id).catch(error => this._hostLog('error', `reload ${record.id} failed: ${errorMessage(error)}`))
    }
    return this.snapshot()
  }

  /** 卸载：停用 + 删记录 + 关它的 watcher。目录还在的话，下次 rescan 会重新发现它。 */
  async unload(id) {
    const record = this.records.get(String(id || ''))
    if (!record) return false
    await this._run(record, async () => {
      const warnings = await this._deactivate(record)
      if (warnings.length) record.warnings = warnings
      const watcher = this.watchers.get(record.id)
      if (watcher) {
        try { watcher.close() } catch { /* 同上 */ }
        this.watchers.delete(record.id)
      }
      const timer = this.timers.get(record.id)
      if (timer) { clearTimeout(timer); this.timers.delete(record.id) }
      this.records.delete(record.id)
      this.internals.delete(record.id)
    })
    return true
  }

  /**
   * 启用/停用。启用会**重新读清单并重新加载**（用户可以改好插件再打开它）；
   * 停用只停不删，状态记成 disabled，`error` 保留下来（「为什么它是坏的」不该因为
   * 被停用一下就消失）。
   */
  async setEnabled(id, enabled) {
    const record = this._requireRecord(id)
    const want = enabled === true
    return this._run(record, async () => {
      if (want) {
        // 先停用再启用：对已经 loaded 的插件再点一次「启用」时，**必须先跑掉旧实例的
        // 清理**，否则旧实例的资源没人回收、activate 还会被叠着跑第二遍。
        const warnings = await this._deactivate(record)
        record.enabled = true
        this._refreshMetadata(record)
        await this._activate(record)
        record.warnings = [...warnings, ...record.warnings]
        return this._publicRecord(record)
      }
      const warnings = await this._deactivate(record)
      record.enabled = false
      record.status = PLUGIN_STATUS.DISABLED
      record.warnings = warnings
      return this._publicRecord(record)
    })
  }

  // ── 文件监视 ────────────────────────────────────────────────────────

  _startWatching() {
    if (!this.started) return
    if (!this.dirExists) {
      this.watching = false
      this.watchReason = 'plugins directory does not exist'
      return
    }
    if (!this.rootWatcher) {
      const watcher = this._watch(this.dir, () => this._schedule('root', () => this._handleRootChange()))
      if (watcher) {
        this.rootWatcher = watcher
        this.watching = true
        this.watchReason = null
      } else {
        this.watching = false
        // 如实记下**为什么**没在自动重载，而不是假装它在工作
        this.watchReason = this._lastWatchError || 'fs.watch is unavailable for this path'
      }
    }
    for (const record of this.records.values()) {
      if (this.watchers.has(record.id)) continue
      if (!isDirectory(record.dir)) continue
      const watcher = this._watch(record.dir, () => this._schedule(`plugin:${record.id}`, () => this._handlePluginChange(record.id)))
      if (watcher) {
        this.watchers.set(record.id, watcher)
        record.watchReason = null
      } else {
        record.watchReason = this._lastWatchError || 'fs.watch is unavailable for this path'
      }
    }
  }

  /** 建一个 watcher。失败返回 null 并把原因留在 `this._lastWatchError` —— 这里**不抛**，
   *  因为「监视不可用」是已知的降级场景，不是宿主故障。 */
  _watch(target, onEvent) {
    this._lastWatchError = null
    try {
      // persistent:false —— 监视不该拖着进程不退出（测试里尤其重要）
      const watcher = this.watchImpl(target, { persistent: false, encoding: 'utf8' }, (eventType, filename) => {
        // 文件事件本身也可能抛（回调在 fs 的上下文里跑），吞掉并记下来，
        // 绝不让它变成未捕获异常把宿主带走。
        try {
          onEvent(eventType, filename)
        } catch (error) {
          this._hostLog('error', `watch callback for ${target} failed: ${errorMessage(error)}`)
        }
      })
      watcher.on('error', (error) => {
        this._lastWatchError = `${errorMessage(error)}`
        this._hostLog('warn', `watcher for ${target} failed: ${errorMessage(error)}; falling back to manual reload`)
      })
      return watcher
    } catch (error) {
      this._lastWatchError = errorMessage(error)
      this._hostLog('warn', `fs.watch unavailable for ${target}: ${errorMessage(error)}; falling back to manual reload`)
      return null
    }
  }

  _schedule(key, action) {
    const previous = this.timers.get(key)
    if (previous) clearTimeout(previous)
    const timer = setTimeout(() => {
      this.timers.delete(key)
      Promise.resolve()
        .then(action)
        .catch(error => this._hostLog('error', `watch handler failed: ${errorMessage(error)}`))
    }, this.reloadDebounceMs)
    // 去抖定时器同样不该拖住进程退出
    if (typeof timer.unref === 'function') timer.unref()
    this.timers.set(key, timer)
  }

  /**
   * 取消某个键上**尚未触发**的去抖动作。返回是否真的取消了一个。
   *
   * 为什么必须有这个：文件监视的去抖窗口（默认 250ms）与手动重载是两条独立的路。
   * 用户改完文件、在去抖窗口内又点了「重载」，两条路都会 `deactivate → activate` ——
   * 插件被**激活两次**，副作用（注册命令、开定时器）跑两遍。实测这条竞态有
   * **50% 的复现率**（`test-plugin-host.js` 那个断言 6 !== 5）。
   *
   * 手动操作是**更明确的意图**：它一旦发生，就该吃掉尚未触发的自动重载，
   * 因为那次自动重载要达成的效果已经被手动这次覆盖了。
   */
  _cancelScheduled(key) {
    const timer = this.timers.get(key)
    if (!timer) return false
    clearTimeout(timer)
    this.timers.delete(key)
    return true
  }

  /** 取消某条插件自身以及根目录上所有待定去抖。手动操作前后调用。 */
  _cancelPendingFor(record) {
    const byId = this._cancelScheduled(`plugin:${record.id}`)
    // 根目录的待定 rescan 也要吃掉：它最终会走到这条记录上，效果同样是重复激活。
    const byRoot = this._cancelScheduled('root')
    return byId || byRoot
  }

  /** 根目录变化：可能有新插件目录 / 目录被删 → 重新扫描（幂等，代价很小）。 */
  async _handleRootChange() {
    if (!this.started) return
    await this._rescan()
    this._startWatching()
  }

  /** 插件目录变化：只重载**这一个**插件。 */
  async _handlePluginChange(id) {
    if (!this.started) return
    const record = this.records.get(id)
    if (!record) return
    if (!record.enabled) return
    if (!isDirectory(record.dir)) return
    try {
      await this.reload(id)
    } catch (error) {
      this._hostLog('error', `auto-reload of ${id} failed: ${errorMessage(error)}`)
    }
  }

  // ── ctx 与日志 ──────────────────────────────────────────────────────

  _createContext(record) {
    const internal = this._internalOf(record)
    return {
      id: record.id,
      dir: record.dir,
      version: record.version,
      log: this._createPluginLog(record),
      // 生命周期清理统一交给宿主：插件只登记，不自己管。
      onDispose: (fn) => {
        if (typeof fn !== 'function') throw new TypeError('ctx.onDispose(fn) requires a function')
        if (!internal) return
        internal.disposers.push(fn)
      },
    }
  }

  /**
   * 造这个插件的 `ctx.log`：**一个可调用的函数，同时挂着 `.info` / `.warn` / `.error`**。
   *
   * 为什么是「两副面孔」而不是二选一：契约的两份**活体样本**各写了一种。
   *   · 文件头与方案文档 6.7 写的是对象形状 `log: { info, warn, error }`，测试用的也是它；
   *   · 数据目录里那份示例插件（`data/plugins/hello/plugin.mjs`）写的是 `ctx.log('…')`。
   * 二选一必然要改掉其中一份，而示例插件是**正在被使用的活体夹具**（不能改），
   * 所以这里给超集：函数可调（默认 info、第二参数可给级别），三个方法照旧。
   * 旧的 `ctx.log.info(...)` 一个字符都不用动，新的 `ctx.log(...)` 也能跑。
   *
   * 语义细节（都是刻意的，为了「日志绝不反过来搞挂插件」）：
   *   · `ctx.log(...)`：**最后一个参数**若是 `info|warn|error` 之一且参数多于一个，它就是级别，
   *     剩下的当消息拼起来；否则整串参数都当消息、级别用默认。给别的级别字符串**不报错**，
   *     会原样并进消息里（当 info 记）——写错级别不该让一次日志变成一次异常。
   *   · 参数经 `toText()`（Error 取 stack、别的 JSON.stringify，失败退化成 String），
   *     所以传对象/Error/循环引用都不会抛。
   */
  _createPluginLog(record) {
    const emit = (level, args) => {
      // 这一层 try 是**最后一道兜底**：_pluginLog 自己已经吞掉了能想到的失败，
      // 但「插件的日志写不进去」永远不该升级成「插件挂了」。
      try {
        this._pluginLog(record, level, ...args)
      } catch { /* 插件日志不可失败：吞掉 */ }
    }

    const callable = (...args) => {
      const level = args.length > 1 ? args[args.length - 1] : undefined
      if (typeof level === 'string' && PLUGIN_LOG_LEVELS.includes(level)) {
        emit(level, args.slice(0, -1))
        return
      }
      emit(DEFAULT_PLUGIN_LOG_LEVEL, args)
    }

    for (const level of PLUGIN_LOG_LEVELS) {
      callable[level] = (...args) => emit(level, args)
    }
    return callable
  }

  _pluginLog(record, level, ...args) {
    // 日志是**尽力而为**的旁路，任何一步失败都只吞掉，绝不往外抛：
    // record.logs 万一不在（未来某条路径没建全）、参数序列化炸掉、宿主 logger 抛错。
    let message
    try {
      message = args.map(toText).join(' ')
    } catch {
      message = ''
    }
    try {
      if (!Array.isArray(record.logs)) record.logs = []
      record.logs.push({ level, message, at: Date.now() })
      if (record.logs.length > this.maxLogLines) record.logs.splice(0, record.logs.length - this.maxLogLines)
    } catch { /* 记不进内存也不影响插件 */ }
    const sink = this.logger?.[level]
    if (typeof sink !== 'function') return
    try {
      sink(`[plugin:${record.id}] ${message}`)
    } catch { /* 宿主/自定义 logger 抛错不许把插件带走 */ }
  }

  _hostLog(level, message) {
    this.logger[level](`[plugin-host] ${message}`)
  }
}

// ── 进程内单例：api.js 用它启动，路由用它取状态 ─────────────────────────

let defaultHost = null
let defaultHostPromise = null

export function getPluginHost() {
  return defaultHost
}

/** 启动单例宿主。重复调用返回同一个实例的启动 Promise（幂等）。 */
export function startPluginHost(options = {}) {
  if (!defaultHostPromise) {
    const host = new PluginHost(options)
    defaultHost = host
    defaultHostPromise = host.start().then(
      () => host,
      (error) => {
        // 宿主自己的 start 不该抛（每个插件都被隔离了），但真抛了也不能静默
        console.error('[plugin-host] start failed:', error)
        return host
      },
    )
  }
  return defaultHostPromise
}

export async function stopPluginHost() {
  const host = defaultHost
  defaultHost = null
  defaultHostPromise = null
  if (!host) return null
  return host.stop()
}
