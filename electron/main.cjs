const PLATFORM = process.platform
const IS_WIN = PLATFORM === 'win32'
const IS_MAC = PLATFORM === 'darwin'
const IS_LINUX = PLATFORM === 'linux'

// Windows: 把控制台代码页切到 UTF-8，避免中文 stdout 显示为乱码。
// 用 stdio:'ignore'+windowsHide：绝不能用 stdio:'inherit' —— 在 Electron 主进程启动最早期
// 让 chcp 子进程继承 stdout 句柄，会搅乱本进程的 stdout，导致后续 console.log 写到一定量后
// 阻塞、整个后端 bootstrap 卡死（实测）。控制台中文显示的可靠修复在 npm 的 start/dev/
// start:backend 脚本里（启动前 `chcp 65001 >nul`，在真正显示输出的那个控制台里设码页）；
// 这里只作无副作用的兜底。
if (IS_WIN) {
  try {
    require('child_process').execSync('chcp 65001', { stdio: 'ignore', windowsHide: true })
  } catch (_) {}
}

const { app, BaseWindow, BrowserWindow, WebContentsView, View, webContents, session, shell, dialog, Menu, ipcMain, Tray, nativeImage, clipboard, systemPreferences } = require('electron')
const path = require('path')
const fs = require('fs')
const net = require('net')
const http = require('http')
const https = require('https')
const { EventEmitter } = require('events')
const { pathToFileURL } = require('url')
const { autoUpdater } = require('electron-updater')
const wakeWord = require('./wake-word.cjs')
const devLight = require('./dev-board-light.cjs')
const { BROWSER_EMBED_PARTITION, createBrowserEmbedHost } = require('./browser-embed-host.cjs')
const { createBrowserDataStore } = require('./browser-data.cjs')
const { createSafeStorageNotice } = require('./safe-storage-notice.cjs')
const { createAliceChromeManager } = require('./alice-chrome.cjs')
const { bundledBrowserRoot, configureBundledNodeRuntime } = require('./playwright-runtime.cjs')
const { createTrustedWindowSenderGuard } = require('./trusted-window-senders.cjs')
const { createPetController } = require('./pet-window.cjs')
const { hasPackagedUpdaterConfig } = require('./updater-config.cjs')

// The ESM backend is imported into this Electron main process. Expose the
// main-process-only permission API without requiring ESM modules to import the
// special Electron built-in module themselves.
globalThis.aliceSystemPreferences = systemPreferences

const IS_DEV = !app.isPackaged
const WINDOWS_APP_USER_MODEL_ID = 'com.xiaoyuanda.alice'
const WINDOWS_TITLE_BAR_HEIGHT = 38
const WINDOWS_TITLE_BAR_THEMES = Object.freeze({
  startup: { color: '#0b0d10', symbolColor: '#e7edf3' },
  midnight: { color: '#111821', symbolColor: '#f3f5fb' },
  phosphor: { color: '#050806', symbolColor: '#c8f0c8' },
  violet: { color: '#0d0a1a', symbolColor: '#e4deff' },
  rose: { color: '#1a0f16', symbolColor: '#f4e0e4' },
  arctic: { color: '#f5f7f9', symbolColor: '#1a2330' },
  sand: { color: '#f2ede3', symbolColor: '#2a231a' },
})

function windowsTitleBarOverlay(theme = 'startup') {
  const colors = WINDOWS_TITLE_BAR_THEMES[theme] || WINDOWS_TITLE_BAR_THEMES.midnight
  return { ...colors, height: WINDOWS_TITLE_BAR_HEIGHT }
}

function resolvePortableRoot() {
  if (IS_DEV) return null
  const requestedRoot = process.env.ALICE_PORTABLE_DIR?.trim()
  if (requestedRoot) return path.resolve(requestedRoot)
  const exeDir = path.dirname(process.execPath)
  return fs.existsSync(path.join(exeDir, 'portable.flag')) ? exeDir : null
}

const PORTABLE_ROOT = resolvePortableRoot()
const PORTABLE_USER_DIR = PORTABLE_ROOT ? path.join(PORTABLE_ROOT, 'data') : null
const IS_PORTABLE = Boolean(PORTABLE_USER_DIR)
if (PORTABLE_USER_DIR) {
  try { fs.mkdirSync(PORTABLE_USER_DIR, { recursive: true }) } catch {}
  app.setPath('userData', PORTABLE_USER_DIR)
  process.env.ALICE_USER_DIR ||= PORTABLE_USER_DIR
}

const USER_DIR = app.getPath('userData')
const UI_LANGUAGE_FILE = path.join(USER_DIR, 'ui-language.json')

function normalizeUiLanguage(value) {
  const locale = String(value || '').trim().replaceAll('_', '-').toLowerCase()
  if (locale === 'en' || locale.startsWith('en-')) return 'en-US'
  if (locale === 'zh' || locale === 'zh-cn' || locale === 'zh-hans' || locale.startsWith('zh-hans-')) return 'zh-CN'
  return null
}

function readSavedUiLanguage() {
  try {
    const parsed = JSON.parse(fs.readFileSync(UI_LANGUAGE_FILE, 'utf8'))
    return normalizeUiLanguage(parsed?.locale)
  } catch {
    return null
  }
}

let nativeUiLanguage = readSavedUiLanguage()

function getNativeUiLanguage() {
  if (nativeUiLanguage) return nativeUiLanguage
  try { nativeUiLanguage = normalizeUiLanguage(app.getLocale()) } catch {}
  return nativeUiLanguage || 'zh-CN'
}

const NATIVE_UI_MESSAGES = Object.freeze({
  'zh-CN': { showMain: '显示主界面', restart: '重启', quit: '退出' },
  'en-US': { showMain: 'Show Main Window', restart: 'Restart', quit: 'Quit' },
})

function nativeUiText(key) {
  return NATIVE_UI_MESSAGES[getNativeUiLanguage()]?.[key] || NATIVE_UI_MESSAGES['zh-CN'][key] || key
}

function setNativeUiLanguage(locale) {
  const normalized = normalizeUiLanguage(locale)
  if (!normalized) throw new Error(`Unsupported UI locale: ${locale}`)
  const changed = nativeUiLanguage !== normalized
  nativeUiLanguage = normalized
  if (changed || !fs.existsSync(UI_LANGUAGE_FILE)) {
    try {
      const tmp = `${UI_LANGUAGE_FILE}.tmp`
      fs.writeFileSync(tmp, JSON.stringify({ locale: normalized }, null, 2), 'utf8')
      fs.renameSync(tmp, UI_LANGUAGE_FILE)
    } catch (error) {
      console.warn('[ui-language] failed to persist locale:', error?.message || error)
    }
  }
  refreshTrayContextMenu()
  return normalized
}

app.commandLine.appendSwitch('remote-debugging-address', '127.0.0.1')
app.commandLine.appendSwitch('remote-debugging-port', '0')
const CODE_ROOT = app.getAppPath()
const RESOURCE_ROOT = CODE_ROOT
const BACKEND_ENTRY = path.join(CODE_ROOT, 'src', 'index.js')
const STARTUP_PAGE = path.join(__dirname, 'startup.html')
const BUNDLED_NODE_EXECUTABLE = configureBundledNodeRuntime({
  isPackaged: app.isPackaged,
  resourcesPath: process.resourcesPath,
  projectRoot: CODE_ROOT,
})

function isTlsBackend() {
  return Boolean(
    process.env.ALICE_TLS_PFX
    || (process.env.ALICE_TLS_CERT && process.env.ALICE_TLS_KEY)
  )
}

function backendUrl(port, pathname = '/') {
  return `${isTlsBackend() ? 'https' : 'http'}://127.0.0.1:${port}${pathname}`
}

app.on('certificate-error', (event, _webContents, url, _error, _certificate, callback) => {
  try {
    const parsed = new URL(url)
    if (isTlsBackend() && ['127.0.0.1', 'localhost', '::1'].includes(parsed.hostname)) {
      event.preventDefault()
      callback(true)
      return
    }
  } catch {}
  callback(false)
})

const STARTUP_STEPS = [
  { id: 'port', label: '准备本地端口', detail: '锁定 3721 或备用端口' },
  { id: 'core', label: '启动本地核心', detail: '加载 Alice runtime' },
  { id: 'resources', label: '准备工作区', detail: '复制沙箱与音乐资源' },
  { id: 'tools', label: '加载工具槽', detail: '恢复已安装能力' },
  { id: 'api', label: '启动本地 API', detail: 'HTTP / SSE / WebSocket' },
]

const startupProgressState = {
  startedAt: Date.now(),
  updatedAt: Date.now(),
  completed: false,
  failed: false,
  percent: 0,
  activeStepId: null,
  message: '正在打开 Alice',
  steps: STARTUP_STEPS.map(step => ({ ...step, status: 'pending', startedAt: null, endedAt: null })),
}

function cloneStartupProgressState() {
  return {
    ...startupProgressState,
    steps: startupProgressState.steps.map(step => ({ ...step })),
  }
}

function recalcStartupPercent() {
  if (startupProgressState.completed) return 100
  const done = startupProgressState.steps.filter(step => step.status === 'done').length
  const hasRunning = startupProgressState.steps.some(step => step.status === 'running')
  return Math.min(99, Math.round(((done + (hasRunning ? 0.45 : 0)) / startupProgressState.steps.length) * 100))
}

function sendStartupProgress() {
  if (!mainWindow || mainWindow.isDestroyed()) return
  mainWindow.webContents.send('startup:progress', cloneStartupProgressState())
}

function emitStartupProgress(update = {}) {
  const now = Date.now()
  let visibleUpdate = false
  if (update.id) {
    let step = startupProgressState.steps.find(item => item.id === update.id)
    if (!step) {
      if (!update.completed && !update.error && update.status !== 'error') return cloneStartupProgressState()
    } else {
      visibleUpdate = true
      if (update.label) step.label = update.label
      if (update.detail) step.detail = update.detail
      if (update.status) {
        step.status = update.status
        if (update.status === 'running' && !step.startedAt) step.startedAt = now
        if (update.status === 'done' || update.status === 'error') step.endedAt = now
        if (update.status === 'running') startupProgressState.activeStepId = step.id
      }
    }
  }
  if (update.message && (visibleUpdate || update.completed || update.error || update.status === 'error')) startupProgressState.message = update.message
  if (update.status === 'error' || update.error) {
    startupProgressState.failed = true
    startupProgressState.message = update.message || '启动失败'
  }
  if (update.completed) {
    startupProgressState.completed = true
    startupProgressState.percent = 100
    startupProgressState.message = update.message || '启动完成'
  } else {
    startupProgressState.percent = recalcStartupPercent()
  }
  startupProgressState.updatedAt = now
  sendStartupProgress()
  return cloneStartupProgressState()
}

global.aliceStartupProgress = emitStartupProgress

function getAppIconPath({ trayIcon = false } = {}) {
  if (IS_WIN) return path.join(RESOURCE_ROOT, 'build', 'icon.ico')
  if (IS_MAC) return path.join(RESOURCE_ROOT, 'build', 'icon.png')
  if (IS_LINUX) return path.join(RESOURCE_ROOT, 'build', 'icon.png')
  return path.join(RESOURCE_ROOT, 'build', trayIcon ? 'icon.png' : 'icon.png')
}

function createTrayImage() {
  const trayImage = nativeImage.createFromPath(getAppIconPath({ trayIcon: true }))
  if (!IS_MAC) return trayImage

  // macOS does not scale an oversized status item for us. Passing the 512px app
  // icon directly makes the tray item (and its menu) hundreds of pixels wide.
  // Keep the full-colour icon instead of treating its opaque background as a
  // template mask, and constrain only the macOS tray copy to the menu-bar size.
  return trayImage.resize({ width: 16, height: 16, quality: 'best' })
}

const SCREENSHOT_IMAGE_EXTS = new Set(['.png', '.jpg', '.jpeg', '.webp', '.bmp', '.gif'])

function imageMimeForPath(filePath = '') {
  switch (path.extname(filePath).toLowerCase()) {
    case '.jpg':
    case '.jpeg':
      return 'image/jpeg'
    case '.webp':
      return 'image/webp'
    case '.bmp':
      return 'image/bmp'
    case '.gif':
      return 'image/gif'
    default:
      return 'image/png'
  }
}

function addExistingDir(out, dir) {
  if (!dir) return
  try {
    const resolved = path.resolve(dir)
    if (fs.existsSync(resolved) && fs.statSync(resolved).isDirectory()) out.add(resolved)
  } catch {}
}

function collectSystemScreenshotDirs() {
  const dirs = new Set()
  try { addExistingDir(dirs, path.join(app.getPath('pictures'), 'Screenshots')) } catch {}

  const home = process.env.USERPROFILE || process.env.HOME || ''
  addExistingDir(dirs, path.join(home, 'Pictures', 'Screenshots'))

  const localAppData = process.env.LOCALAPPDATA || (home ? path.join(home, 'AppData', 'Local') : '')
  const packagesDir = localAppData ? path.join(localAppData, 'Packages') : ''
  addExistingDir(dirs, path.join(packagesDir, 'MicrosoftWindows.Client.CBS_cw5n1h2txyewy', 'TempState', 'ScreenClip'))
  addExistingDir(dirs, path.join(packagesDir, 'Microsoft.ScreenSketch_8wekyb3d8bbwe', 'TempState'))
  addExistingDir(dirs, path.join(packagesDir, 'Microsoft.ScreenSketch_8wekyb3d8bbwe', 'TempState', 'ScreenClip'))
  addExistingDir(dirs, path.join(packagesDir, 'Microsoft.Windows.SnippingTool_8wekyb3d8bbwe', 'TempState'))
  addExistingDir(dirs, path.join(packagesDir, 'Microsoft.Windows.SnippingTool_8wekyb3d8bbwe', 'TempState', 'ScreenClip'))

  try {
    for (const entry of fs.readdirSync(packagesDir, { withFileTypes: true })) {
      if (!entry.isDirectory()) continue
      if (!/(ScreenSketch|SnippingTool|Client\.CBS)/i.test(entry.name)) continue
      const base = path.join(packagesDir, entry.name, 'TempState')
      addExistingDir(dirs, base)
      addExistingDir(dirs, path.join(base, 'ScreenClip'))
    }
  } catch {}

  return [...dirs]
}

function collectImageFiles(dir, { depth = 0 } = {}) {
  const files = []
  let entries = []
  try { entries = fs.readdirSync(dir, { withFileTypes: true }) } catch { return files }
  for (const entry of entries) {
    const full = path.join(dir, entry.name)
    if (entry.isDirectory()) {
      if (depth > 0) files.push(...collectImageFiles(full, { depth: depth - 1 }))
      continue
    }
    if (!entry.isFile()) continue
    if (!SCREENSHOT_IMAGE_EXTS.has(path.extname(entry.name).toLowerCase())) continue
    try {
      const stat = fs.statSync(full)
      files.push({ path: full, mtimeMs: stat.mtimeMs, size: stat.size })
    } catch {}
  }
  return files
}

function findLatestSystemScreenshotFile({ maxAgeMs = 15 * 60 * 1000 } = {}) {
  const cutoff = Date.now() - Math.max(0, Number(maxAgeMs) || 0)
  const candidates = []
  for (const dir of collectSystemScreenshotDirs()) {
    const depth = /TempState|ScreenClip/i.test(dir) ? 2 : 0
    for (const file of collectImageFiles(dir, { depth })) {
      if (maxAgeMs && file.mtimeMs < cutoff) continue
      candidates.push(file)
    }
  }
  candidates.sort((a, b) => b.mtimeMs - a.mtimeMs)
  return candidates[0] || null
}

function fileImageToDataUrl(filePath) {
  const bytes = fs.readFileSync(filePath)
  return `data:${imageMimeForPath(filePath)};base64,${bytes.toString('base64')}`
}

// 持久化日志：把 console.* 镜像到 USER_DIR/logs/alice.log，
// 安装版没有 stdout 的情况下，卡死/崩溃后还能 tail 这个文件复盘。
// 简易 rotate：> 5MB 时把当前文件改名 .old（覆盖上一份 .old），下次写入重开。
const LOG_DIR = path.join(USER_DIR, 'logs')
const LOG_FILE = path.join(LOG_DIR, 'alice.log')
const LOG_FILE_OLD = path.join(LOG_DIR, 'alice.old.log')
const LOG_MAX_BYTES = 5 * 1024 * 1024
try { fs.mkdirSync(LOG_DIR, { recursive: true }) } catch {}
function rotateLogIfNeeded() {
  try {
    const stat = fs.statSync(LOG_FILE)
    if (stat.size > LOG_MAX_BYTES) {
      try { fs.rmSync(LOG_FILE_OLD, { force: true }) } catch {}
      try { fs.renameSync(LOG_FILE, LOG_FILE_OLD) } catch {}
    }
  } catch {}
}
function writeLog(level, args) {
  let line
  try {
    line = args.map(a => {
      if (typeof a === 'string') return a
      if (a instanceof Error) return a.stack || a.message
      try { return JSON.stringify(a) } catch { return String(a) }
    }).join(' ')
  } catch { line = '[log-serialize-failed]' }
  const ts = new Date().toISOString()
  const out = `${ts} [${level}] ${line}\n`
  try { fs.appendFileSync(LOG_FILE, out) } catch {}
}
// Hijack 一次就够；后端 import 在同一进程，console.* 引用的是同一个 console 对象。
// 把原始方法存起来，appendFile 失败时仍能输出到 stdout/stderr（开发模式可见）。
;(function installLogHijack() {
  const levels = ['log', 'info', 'warn', 'error', 'debug']
  for (const level of levels) {
    const original = console[level]?.bind(console) || (() => {})
    console[level] = (...args) => {
      try { original(...args) } catch {}
      try {
        rotateLogIfNeeded()
        writeLog(level, args)
      } catch {}
    }
  }
})()
process.on('unhandledRejection', (reason) => {
  console.error('[unhandledRejection]', reason instanceof Error ? (reason.stack || reason.message) : String(reason))
})
process.on('uncaughtException', (err) => {
  console.error('[uncaughtException]', err?.stack || err?.message || String(err))
})
console.log(`[main] Alice ${app.getVersion()} starting, logs → ${LOG_FILE}`)

// ── GPU 适配器偏好（Windows 多显卡：核显 + 独显笔记本） ──
// Windows 的逐应用显卡偏好存在 HKCU\...\DirectX\UserGpuPreferences
// （与系统设置→屏幕→显示卡的逐应用选项同源），这里按 config 替自己的 exe 维护一条：
//   'discrete'=2 高性能（独显） 'integrated'=1 省电（核显） 'system'=删除条目跟随系统（默认）
// config.json 顶级字段 gpuPreference 可改。
//
// 默认跟随系统（= Optimus 上落核显）是实测出来的：v2.1.399 试过默认独显优先，
// MX450 上 3D 只占 9% 却另付 10% 的 copy 引擎过路费——屏幕物理接在核显上，
// 独显画完每帧都要拷回核显显示；且只要有持续动画独显就永远无法断电休眠，
// 薄本上常驻 77°C。点阵球节流/抽稀之后渲染负载核显随手就能扛，独显得不偿失。
// 'discrete' 留作大屏/高分辨率重负载场景的手动开关。
// 该键在 GPU 进程创建 D3D 设备时读取——这里在启动最早期同步写入，
// 但首次变更仍可能晚于 GPU 进程拉起，此时要到下次启动才真正切换适配器。
function applyGpuPreference() {
  if (!IS_WIN) return
  let pref = 'system'
  try {
    const cfg = JSON.parse(fs.readFileSync(path.join(USER_DIR, 'config.json'), 'utf-8'))
    if (['discrete', 'integrated', 'system'].includes(cfg?.gpuPreference)) pref = cfg.gpuPreference
  } catch {}
  const KEY = 'HKCU\\Software\\Microsoft\\DirectX\\UserGpuPreferences'
  const { execFileSync } = require('child_process')
  try {
    if (pref === 'system') {
      // 交还系统默认。条目本不存在时 reg 会报错——吞掉即可（结果一样）
      try { execFileSync('reg.exe', ['delete', KEY, '/v', process.execPath, '/f'], { stdio: 'ignore', windowsHide: true }) } catch {}
    } else {
      const value = pref === 'integrated' ? 'GpuPreference=1;' : 'GpuPreference=2;'
      execFileSync('reg.exe', ['add', KEY, '/v', process.execPath, '/t', 'REG_SZ', '/d', value, '/f'], { stdio: 'ignore', windowsHide: true })
    }
    console.log(`[main] GPU 偏好已应用: ${pref}`)
  } catch (e) {
    console.warn('[main] 写入 GPU 偏好失败（不影响启动）:', e.message)
  }
}
applyGpuPreference()

let mainWindow = null
const browserEmbedSenderGuard = createTrustedWindowSenderGuard({
  getMainWindow: () => mainWindow,
})
const safeStorageNotice = createSafeStorageNotice({
  dialog,
  platform: PLATFORM,
  consentFile: path.join(USER_DIR, 'safe-storage-consent.json'),
  parentWindow: () => (
    mainWindow && !mainWindow.isDestroyed() ? mainWindow : null
  ),
})
globalThis.aliceRequestSafeStorageAccessSync = purpose => (
  safeStorageNotice.requestSync(purpose)
)
// The dedicated profile is deliberately under Alice application data and
// never reads, imports, or attaches to the user's daily Chrome profile.
const aliceChrome = createAliceChromeManager({
  userDataDir: USER_DIR,
  bundledBrowserRoot: bundledBrowserRoot({
    isPackaged: app.isPackaged,
    resourcesPath: process.resourcesPath,
    projectRoot: CODE_ROOT,
  }),
})
const embeddedBrowserSession = () => session.fromPartition(BROWSER_EMBED_PARTITION)
const browserDataStore = createBrowserDataStore({
  historyFile: path.join(USER_DIR, 'browser', 'history.json'),
  getSession: embeddedBrowserSession,
})

async function assertEmbeddedBrowserNavigationAllowed(url) {
  const [{ assertWebUrlAllowed }, { config: runtimeConfig }] = await Promise.all([
    import(pathToFileURL(path.join(CODE_ROOT, 'src', 'capabilities', 'tools', 'web', 'url-policy.js')).href),
    import(pathToFileURL(path.join(CODE_ROOT, 'src', 'config.js')).href),
  ])
  return assertWebUrlAllowed(url, {
    allowPrivateNetwork: () => runtimeConfig.security?.browserPrivateNetwork === true,
  })
}

const browserEmbedHost = createBrowserEmbedHost({
  WebContentsView,
  View,
  BrowserWindow,
  BaseWindow,
  isAppQuitting: () => app.isQuiting === true,
  onNavigation: entry => browserDataStore.recordVisit(entry),
  assertNavigationAllowed: assertEmbeddedBrowserNavigationAllowed,
  nativeRequestGuard: true,
})

function readDevToolsActivePort() {
  try {
    const [line] = fs.readFileSync(path.join(USER_DIR, 'DevToolsActivePort'), 'utf8').split(/\r?\n/)
    const port = Number(line)
    return Number.isInteger(port) && port > 0 && port <= 65535 ? port : null
  } catch {
    return null
  }
}

function readLocalJson(port, pathname) {
  return new Promise((resolve, reject) => {
    const request = http.get({ hostname: '127.0.0.1', port, path: pathname, timeout: 2_000 }, response => {
      const chunks = []
      response.on('data', chunk => chunks.push(chunk))
      response.on('end', () => {
        try { resolve(JSON.parse(Buffer.concat(chunks).toString('utf8'))) }
        catch (error) { reject(error) }
      })
    })
    request.on('timeout', () => request.destroy(new Error('CDP target lookup timed out')))
    request.on('error', reject)
  })
}

async function resolveBrowserEmbedCdpTarget() {
  const target = browserEmbedHost.getTarget()
  if (!target) return null
  const port = readDevToolsActivePort()
  if (!port) return { ...target, cdpEndpoint: null, targetId: null }
  const cdpEndpoint = `http://127.0.0.1:${port}`
  try {
    const targets = await readLocalJson(port, '/json/list')
    const match = Array.isArray(targets)
      ? targets.find(candidate => {
          if (!candidate?.id) return false
          try { return webContents.fromDevToolsTargetId(candidate.id)?.id === target.webContentsId }
          catch { return false }
        })
      : null
    return { ...target, cdpEndpoint, targetId: match?.id || null }
  } catch (error) {
    console.warn('[browser-embed] unable to resolve CDP target:', error?.message || error)
    return { ...target, cdpEndpoint, targetId: null }
  }
}
let backendPort = 0
let tray = null
let focusBannerWindow = null
let terminalStreamWindow = null
let terminalStreamWindowStreamId = null
let wakeProbeWindow = null
let voiceOrbWindow = null

// 后端通过 global.focusBannerBridge 控制横幅窗口
const focusBannerBridge = new EventEmitter()
global.focusBannerBridge = focusBannerBridge
const terminalStreamBridge = new EventEmitter()
global.terminalStreamBridge = terminalStreamBridge
global.getAliceWindowLayoutSnapshot = getAliceWindowLayoutSnapshot
globalThis.aliceChromeBridge = Object.freeze({
  ensureEndpoint: async () => {
    if (!browserEmbedHost.getTarget() && mainWindow && !mainWindow.isDestroyed()) {
      await browserEmbedHost.prime(mainWindow)
    }
    const target = await resolveBrowserEmbedCdpTarget()
    if (!target?.cdpEndpoint || !target?.targetId) {
      throw new Error('Alice live browser DevTools target is unavailable')
    }
    return target.cdpEndpoint
  },
  getTarget: async () => resolveBrowserEmbedCdpTarget(),
  closePage: () => browserEmbedHost.closePage(),
  recoverPage: async () => {
    browserEmbedHost.closePage()
    if (!mainWindow || mainWindow.isDestroyed()) {
      throw new Error('Alice main window is unavailable for browser recovery')
    }
    await browserEmbedHost.prime(mainWindow)
    return resolveBrowserEmbedCdpTarget()
  },
  clearData: options => browserDataStore.clearData(options),
  getState: () => browserEmbedHost.getState(mainWindow),
})
global.aliceAppControl = {
  restart() {
    console.log('[main] restart requested')
    app.isQuiting = true
    app.relaunch()
    app.quit()
  },
}

if (IS_WIN) {
  app.setAppUserModelId(WINDOWS_APP_USER_MODEL_ID)
}

function sendUpdaterStatus(payload = {}) {
  if (!mainWindow || mainWindow.isDestroyed()) return
  mainWindow.webContents.send('updater:status', {
    currentVersion: app.getVersion(),
    ...payload,
  })
}

const EXPECTED_BETTER_SQLITE3_VERSION = require('../package.json').dependencies?.['better-sqlite3']

function validatePackagedNativeModules() {
  if (IS_DEV) return
  const appPath = app.getAppPath()
  if (!appPath || !appPath.endsWith('.asar')) return

  const unpackedRoot = `${appPath}.unpacked`
  const moduleRoot = path.join(unpackedRoot, 'node_modules', 'better-sqlite3')
  const virtualModuleRoot = path.join(appPath, 'node_modules', 'better-sqlite3')
  const nativePath = path.join(moduleRoot, 'build', 'Release', 'better_sqlite3.node')
  const issues = []

  if (!/^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/.test(EXPECTED_BETTER_SQLITE3_VERSION || '')) {
    issues.push(`better-sqlite3 must use an exact package version; found ${EXPECTED_BETTER_SQLITE3_VERSION || 'missing'}`)
  }

  try {
    const nativeStat = fs.statSync(nativePath)
    if (!nativeStat.isFile() || nativeStat.size < 1024) {
      issues.push(`Invalid native binding: ${nativePath}`)
    }
  } catch {
    issues.push(`Missing native binding: ${nativePath}`)
  }

  const packagePath = path.join(virtualModuleRoot, 'package.json')
  try {
    const pkg = JSON.parse(fs.readFileSync(packagePath, 'utf-8'))
    if (pkg?.version !== EXPECTED_BETTER_SQLITE3_VERSION) {
      issues.push(`Unexpected better-sqlite3 version ${pkg?.version || 'unknown'}; expected ${EXPECTED_BETTER_SQLITE3_VERSION}`)
    }
  } catch (err) {
    issues.push(`Unreadable better-sqlite3 package.json: ${err.message}`)
  }

  for (const rel of ['lib/index.js', 'lib/database.js', 'lib/sqlite-error.js']) {
    const filePath = path.join(virtualModuleRoot, rel)
    if (!fs.existsSync(filePath)) issues.push(`Incomplete better-sqlite3 package, missing: ${filePath}`)
  }

  const obsoleteNativePath = path.join(virtualModuleRoot, 'lib', 'better_sqlite3.node')
  if (fs.existsSync(obsoleteNativePath)) {
    issues.push(`Conflicting obsolete native binding layout found: ${obsoleteNativePath}`)
  }

  if (issues.length) {
    throw new Error(`Packaged native module integrity check failed:\n${issues.join('\n')}\nPlease close Alice and reinstall it with the official installer.`)
  }
}

async function bootstrapBackend(port) {
  process.env.ALICE_USER_DIR ||= USER_DIR
  process.env.ALICE_RESOURCES_DIR ||= RESOURCE_ROOT
  process.env.ALICE_PORT = String(port)
  validatePackagedNativeModules()
  await import(pathToFileURL(BACKEND_ENTRY).href)
}

const gotLock = app.requestSingleInstanceLock()
if (!gotLock) {
  app.quit()
  process.exit(0)
}

function isLanAccessConfigured() {
  if (/^(1|true|yes|on)$/i.test(String(process.env.ALICE_ALLOW_LAN || '').trim())) return true
  const userDir = process.env.ALICE_USER_DIR?.trim() || USER_DIR
  try {
    const stored = JSON.parse(fs.readFileSync(path.join(userDir, 'config.json'), 'utf8'))
    return stored?.network?.allowLanAccess === true
  } catch {
    return false
  }
}

async function findFreePort(preferred = 3721, host = '127.0.0.1') {
  for (const port of [preferred, 0]) {
    try {
      const actual = await new Promise((resolve, reject) => {
        const server = net.createServer()
        server.once('error', reject)
        server.listen(port, host, () => {
          const address = server.address()
          server.close(() => resolve(address.port))
        })
      })
      return actual
    } catch {}
  }
  throw new Error('Unable to find a free local port')
}

function waitForBackend(port, timeoutMs = 30000) {
  const startedAt = Date.now()
  const url = backendUrl(port, '/activation-status')
  let lastProbe = 'no probe completed'

  return new Promise((resolve, reject) => {
    const tick = () => {
      if (Date.now() - startedAt > timeoutMs) {
        reject(new Error(`Backend startup timed out on port ${port}. Last probe: ${lastProbe}`))
        return
      }

      const client = isTlsBackend() ? https : http
      const options = isTlsBackend() ? { rejectUnauthorized: false } : undefined
      const req = client.get(url, options, res => {
        res.resume()
        lastProbe = `HTTP ${res.statusCode || 'unknown'} from ${url}`
        resolve()
      })
      req.on('error', err => {
        lastProbe = err?.message || String(err)
        setTimeout(tick, 300)
      })
      req.setTimeout(1500, () => {
        lastProbe = `timeout waiting for ${url}`
        req.destroy()
        setTimeout(tick, 300)
      })
    }

    tick()
  })
}

async function loadStartupPage(targetWindow = mainWindow) {
  if (!targetWindow || targetWindow.isDestroyed()) return
  emitStartupProgress({ id: 'window', status: 'running', message: '正在打开桌面窗口' })
  await targetWindow.loadFile(STARTUP_PAGE, { query: { lang: getNativeUiLanguage() } })
  emitStartupProgress({ id: 'window', status: 'done', message: '桌面窗口已打开' })
}

async function loadMainApp(targetWindow = mainWindow) {
  if (!targetWindow || targetWindow.isDestroyed()) return
  if (!backendPort) throw new Error('Backend port is not ready')
  emitStartupProgress({ id: 'interface', status: 'running', message: '正在进入界面' })
  await targetWindow.loadURL(backendUrl(backendPort, '/'))
  emitStartupProgress({ id: 'interface', status: 'done', completed: true, message: '启动完成' })
}

async function createWindow({
  loadStartup = true,
  show = true,
  assignAsMain = true,
  bounds = null,
  beforeLoad = null,
} = {}) {
  const window = new BrowserWindow({
    ...(bounds || { width: 1280, height: 840 }),
    minWidth: 320,
    minHeight: 480,
    show,
    backgroundColor: '#0b0b0e',
    title: 'Alice',
    icon: getAppIconPath(),
    ...(IS_WIN ? {
      titleBarStyle: 'hidden',
      titleBarOverlay: windowsTitleBarOverlay(),
    } : {}),
    webPreferences: {
      contextIsolation: true,
      nodeIntegration: false,
      preload: path.join(__dirname, 'preload.cjs'),
      // 后台唤醒会话：主窗口隐藏到托盘时仍在跑实时 ASR + 唤醒计时器(10s 监听/自动发送/看门狗)。
      // 默认隐藏窗口的 timer/rAF 会被节流到 ~1Hz，会拖垮这些计时器 —— 关掉节流保证后台照常工作。
      backgroundThrottling: false,
      // 唤醒由后台命中触发(无用户手势),开麦的 AudioContext 默认会因自动播放策略停在 suspended、
      // 采不到音频。放开手势要求,保证后台唤醒能直接开麦(与 wake-probe 耳朵窗同理);
      // 顺带让语音助手的 TTS 也能无手势自动播放。
      autoplayPolicy: 'no-user-gesture-required',
    },
  })

  // 授予麦克风权限（语音输入需要）
  if (assignAsMain) mainWindow = window
  if (typeof beforeLoad === 'function') beforeLoad(window)

  window.webContents.session.setPermissionRequestHandler((webContents, permission, callback) => {
    if (permission === 'media') return callback(true)
    callback(false)
  })
  window.webContents.session.setPermissionCheckHandler((webContents, permission) => {
    if (permission === 'media') return true
    return false
  })

  // 窗口级快捷键（不用 globalShortcut，避免劫持其他应用的 F11/Ctrl+R 等）
  //   F12      → 切换主界面 DevTools
  //   F11      → 切换全屏
  //   Ctrl+R   → reload（仅 dev）
  window.webContents.on('before-input-event', (event, input) => {
    if (input.type !== 'keyDown') return
    if (input.key === 'F12') {
      window.webContents.toggleDevTools()
      event.preventDefault()
      return
    }
    if (input.key === 'F11') {
      window.setFullScreen(!window.isFullScreen())
      event.preventDefault()
      return
    }
    if (IS_DEV && (input.control || input.meta) && input.key.toLowerCase() === 'r') {
      window.webContents.reload()
      event.preventDefault()
      return
    }
  })

  const sendFullScreenState = (fullscreen) => {
    if (window.isDestroyed() || window.webContents.isDestroyed()) return
    window.webContents.send('window:fullscreen-changed', Boolean(fullscreen))
  }
  window.on('enter-full-screen', () => sendFullScreenState(true))
  window.on('leave-full-screen', () => sendFullScreenState(false))

  /* ⚠️ 这里是**第四个** shell.openExternal 出口，而且是最危险的一个（2026-10-01 修正）。
     它原先用 `/^https?:\/\//i` 前缀正则判断 —— 与我在 main.cjs 别处、
     desktop-open.js、chat.js 删掉的是同一条弱正则。

     为什么这个最危险：**它没有任何下游校验**。
     另外三个出口（IPC openDesktopUrl、globalThis.aliceDesktopOpen.openExternal、
     HTTP 路由 desktop-open 的 safeWebUrl）后面都跟着 safeExternalUrl / new URL()，
     弱正则只是"第一道"。而这里判断通过就**直接 `shell.openExternal(url)`**，
     原始 URL 一行不停送到操作系统。

     实测这条判据比 safeExternalUrl 弱，有 6 个输入被它放行、被严格判据拒绝：
       `https://a b`、`https://exa mple.com`、`http://`、`https://`、`http://[]`、
       `https://\u0000x`  → 全部会被交给 shell.openExternal。
     （含空格的 URL 交给系统 shell 是经典的风险面：不同平台的 URL 处理差异很大。）

     修法：**走同一个 safeExternalUrl**，与另外三个出口逐字同源 ——
     `safeExternalUrl` 是函数声明（有提升），此处可直接调用。
     两件事顺带修正：
       · 校验不过时不再 `{action:'allow'}` —— 那会让 Electron **在应用内新开窗口**
         加载这个畸形 URL。既然判定它是可疑目标，就不该给它任何一条加载路径。
       · `openExternal` 返回 Promise，必须 catch，否则未捕获拒绝会冒到主进程。 */
  window.webContents.setWindowOpenHandler(({ url }) => {
    const target = safeExternalUrl(url)
    if (target !== null) {
      Promise.resolve(shell.openExternal(target)).catch((error) => {
        console.warn('[window-open] openExternal failed:', error?.message || error)
      })
    }
    return { action: 'deny' }
  })

  try {
    if (loadStartup) {
      await loadStartupPage(window)
    } else if (backendPort) {
      await loadMainApp(window)
    }
  } catch (err) {
    if (window === mainWindow) mainWindow = null
    if (!window.isDestroyed()) window.destroy()
    throw err
  }
  // Windows/Linux 关闭主窗口时最小化到托盘；macOS 允许销毁窗口，Dock/托盘可重建。
  window.on('close', (e) => {
    if (window === mainWindow && !app.isQuiting && !IS_MAC) {
      e.preventDefault()
      window.hide()
    }
  })

  window.on('closed', () => {
    if (window === mainWindow) {
      browserEmbedHost.releaseWindow(window)
      mainWindow = null
    }
  })

  return window
}

async function replaceStartupWithMainApp() {
  const startupWindow = mainWindow
  const hasStartupWindow = startupWindow && !startupWindow.isDestroyed()
  const bounds = hasStartupWindow ? startupWindow.getBounds() : null
  const wasMaximized = Boolean(hasStartupWindow && startupWindow.isMaximized())
  const wasFullScreen = Boolean(hasStartupWindow && startupWindow.isFullScreen())
  let readyWindow = null

  try {
    // Keep the startup renderer visible while the main renderer navigates and
    // paints off-screen. This prevents Chromium from exposing a partial white
    // surface during the file:// -> http:// renderer swap on Windows.
    // Register only this exact renderer as the pending successor before its
    // main-app page loads. The page initializes browser-embed state during
    // did-finish-load, while the visible startup window remains mainWindow.
    // Unrelated windows remain rejected by the sender guard.
    readyWindow = await createWindow({
      loadStartup: false,
      show: false,
      assignAsMain: false,
      bounds,
      beforeLoad: window => {
        browserEmbedSenderGuard.trustReplacement(window)
        window.once('closed', () => browserEmbedSenderGuard.revokeReplacement(window))
      },
    })
    await readyWindow.webContents.executeJavaScript(
      'new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)))',
      true,
    )

    const shouldShow = !hasStartupWindow || startupWindow.isVisible()
    if (hasStartupWindow) browserEmbedHost.transferMainWindow(startupWindow, readyWindow)
    mainWindow = readyWindow
    browserEmbedSenderGuard.revokeReplacement(readyWindow)
    if (wasFullScreen) readyWindow.setFullScreen(true)
    else if (wasMaximized) readyWindow.maximize()
    if (shouldShow) {
      readyWindow.show()
      readyWindow.focus()
    }

    if (hasStartupWindow && !startupWindow.isDestroyed()) startupWindow.destroy()
  } catch (err) {
    if (readyWindow) browserEmbedSenderGuard.revokeReplacement(readyWindow)
    if (readyWindow && !readyWindow.isDestroyed()) readyWindow.destroy()
    throw err
  }
}

async function showMainWindow() {
  if (!mainWindow || mainWindow.isDestroyed()) {
    await createWindow({ loadStartup: !backendPort })
  }
  if (mainWindow.isMinimized()) mainWindow.restore()
  if (!mainWindow.isVisible()) mainWindow.show()
  mainWindow.focus()
}

function setupTray() {
  const trayImage = createTrayImage()
  tray = new Tray(trayImage)
  tray.setToolTip('Alice')

  refreshTrayContextMenu()
  tray.on('double-click', () => { showMainWindow().catch(() => {}) })
  if (IS_MAC) tray.on('click', () => { showMainWindow().catch(() => {}) })
}

function refreshTrayContextMenu() {
  if (!tray || tray.isDestroyed()) return
  const contextMenu = Menu.buildFromTemplate([
    {
      label: nativeUiText('showMain'),
      click: () => { showMainWindow().catch(() => {}) },
    },
    { type: 'separator' },
    {
      label: nativeUiText('restart'),
      click: () => {
        console.log('[tray] restart requested')
        app.isQuiting = true
        app.relaunch()
        app.quit()
      },
    },
    {
      label: nativeUiText('quit'),
      click: () => {
        app.isQuiting = true
        app.quit()
      },
    },
  ])

  tray.setContextMenu(contextMenu)
}

function createFocusBannerWindow({ task = '', current_step = '', tasks = [] } = {}) {
  if (focusBannerWindow && !focusBannerWindow.isDestroyed()) {
    focusBannerWindow.webContents.send('focus-banner:update', { task, current_step, tasks })
    return
  }

  const { width: screenW } = require('electron').screen.getPrimaryDisplay().workAreaSize

  focusBannerWindow = new BrowserWindow({
    width: 280,
    height: 60,
    x: Math.round(screenW / 2 - 140),
    y: 48,
    frame: false,
    transparent: true,
    alwaysOnTop: true,
    skipTaskbar: true,
    resizable: false,
    movable: true,
    minimizable: false,
    maximizable: false,
    focusable: true,
    webPreferences: {
      contextIsolation: true,
      nodeIntegration: false,
      preload: path.join(__dirname, 'focus-banner-preload.cjs'),
    },
  })

  // 给 banner 窗口的 session 也授权麦克风
  focusBannerWindow.webContents.session.setPermissionRequestHandler((wc, permission, callback) => {
    if (permission === 'media') return callback(true)
    callback(false)
  })
  focusBannerWindow.webContents.session.setPermissionCheckHandler((wc, permission) => {
    if (permission === 'media') return true
    return false
  })

  focusBannerWindow.loadFile(path.join(RESOURCE_ROOT, 'focus-banner.html'), {
    query: { lang: getNativeUiLanguage() },
  })

  focusBannerWindow.webContents.once('did-finish-load', () => {
    if (!focusBannerWindow || focusBannerWindow.isDestroyed()) return
    // 先发端口配置，让语音识别结果能发回后端
    focusBannerWindow.webContents.send('focus-banner:config', { port: backendPort, secure: isTlsBackend() })
    focusBannerWindow.webContents.send('focus-banner:update', { task, current_step, tasks })
    autoResizeBannerWindow()
  })

  focusBannerWindow.on('closed', () => {
    focusBannerWindow = null
  })
}

function autoResizeBannerWindow() {
  if (!focusBannerWindow || focusBannerWindow.isDestroyed()) return
  focusBannerWindow.webContents.executeJavaScript(`
    (() => {
      const b = document.getElementById('banner')
      return b ? { w: b.offsetWidth, h: b.offsetHeight } : null
    })()
  `).then(size => {
    if (!size || !focusBannerWindow || focusBannerWindow.isDestroyed()) return
    const padW = 0
    const padH = 0
    focusBannerWindow.setSize(Math.max(160, size.w + padW), Math.max(40, size.h + padH))
  }).catch(() => {})
}

// Focus Banner IPC handlers
ipcMain.on('focus-banner:close', () => {
  if (focusBannerWindow && !focusBannerWindow.isDestroyed()) {
    focusBannerWindow.close()
    focusBannerWindow = null
  }
})

ipcMain.on('focus-banner:set-expanded', (_e, { expanded }) => {
  if (!focusBannerWindow || focusBannerWindow.isDestroyed()) return
  setTimeout(() => autoResizeBannerWindow(), 50)
})

ipcMain.on('focus-banner:request-resize', () => {
  setTimeout(() => autoResizeBannerWindow(), 30)
})

ipcMain.on('focus-banner:toggle-task', (_e, { idx, done }) => {
  // 任务勾选状态更改，横幅已在前端自行更新，无需额外操作
})

// 后端 bridge 事件监听
focusBannerBridge.on('command', ({ action, task, current_step, tasks }) => {
  if (action === 'show' || action === 'update') {
    createFocusBannerWindow({ task, current_step, tasks })
  }
})

focusBannerBridge.on('hide', () => {
  if (focusBannerWindow && !focusBannerWindow.isDestroyed()) {
    focusBannerWindow.close()
    focusBannerWindow = null
  }
})

// ─── 语音唤醒:隐藏"耳朵"窗口 + 主进程 KWS ───
// 隐藏窗口常开麦克风 → AudioWorklet 出 16kHz Float32 → IPC → 主进程 KeywordSpotter。
// 第一步只检测+写日志(USER_DIR/logs/wake-word.log),命中"爱丽丝"不做其他动作。
const TERMINAL_STREAM_DEFAULT_WIDTH = 560
const TERMINAL_STREAM_DEFAULT_HEIGHT = 830
const TERMINAL_STREAM_MIN_WIDTH = 420
const TERMINAL_STREAM_MIN_HEIGHT = 420
const TERMINAL_STREAM_GAP = 16
const TERMINAL_STREAM_MARGIN = 12
const MAIN_WINDOW_SIDECAR_MIN_WIDTH = 900
const MAIN_WINDOW_SIDECAR_MIN_HEIGHT = 600

function clampNumber(value, min, max) {
  if (max < min) return min
  return Math.max(min, Math.min(max, value))
}

function rectRight(rect) {
  return rect.x + rect.width
}

function rectBottom(rect) {
  return rect.y + rect.height
}

function rectOverlapArea(a, b) {
  if (!a || !b) return 0
  const x1 = Math.max(a.x, b.x)
  const y1 = Math.max(a.y, b.y)
  const x2 = Math.min(rectRight(a), rectRight(b))
  const y2 = Math.min(rectBottom(a), rectBottom(b))
  return Math.max(0, x2 - x1) * Math.max(0, y2 - y1)
}

function roundBounds(bounds) {
  return {
    x: Math.round(bounds.x),
    y: Math.round(bounds.y),
    width: Math.round(bounds.width),
    height: Math.round(bounds.height),
  }
}

function fitBoundsToWorkArea(bounds, workArea) {
  const width = clampNumber(
    Math.round(bounds.width || TERMINAL_STREAM_DEFAULT_WIDTH),
    Math.min(TERMINAL_STREAM_MIN_WIDTH, workArea.width),
    workArea.width
  )
  const height = clampNumber(
    Math.round(bounds.height || TERMINAL_STREAM_DEFAULT_HEIGHT),
    Math.min(TERMINAL_STREAM_MIN_HEIGHT, workArea.height),
    workArea.height
  )
  const x = clampNumber(
    Math.round(bounds.x ?? (workArea.x + workArea.width - width - TERMINAL_STREAM_MARGIN)),
    workArea.x,
    workArea.x + workArea.width - width
  )
  const y = clampNumber(
    Math.round(bounds.y ?? (workArea.y + TERMINAL_STREAM_MARGIN)),
    workArea.y,
    workArea.y + workArea.height - height
  )
  return { x, y, width, height }
}

function parseTerminalRequestedBounds(payload = {}) {
  const raw = payload && typeof payload.bounds === 'object' && payload.bounds
    ? payload.bounds
    : payload
  const out = {}
  for (const key of ['x', 'y', 'width', 'height']) {
    const value = Number(raw?.[key])
    if (Number.isFinite(value)) out[key] = value
  }
  return Object.keys(out).length > 0 ? out : null
}

function getDisplayForTerminalWindow(payload = {}) {
  const { screen } = require('electron')
  const requested = parseTerminalRequestedBounds(payload)
  if (Number.isFinite(requested?.x) && Number.isFinite(requested?.y)) {
    return screen.getDisplayNearestPoint({ x: Math.round(requested.x), y: Math.round(requested.y) })
  }
  if (mainWindow && !mainWindow.isDestroyed() && mainWindow.isVisible() && !mainWindow.isMinimized()) {
    return screen.getDisplayMatching(mainWindow.getBounds())
  }
  return screen.getPrimaryDisplay()
}

function windowSnapshot(win) {
  if (!win || win.isDestroyed()) return null
  let bounds = null
  try { bounds = win.getBounds() } catch {}
  if (!bounds) return null
  const isTerminalStream = win === terminalStreamWindow
  const isMain = win === mainWindow
  return {
    id: win.id,
    kind: isTerminalStream ? 'terminal_stream' : (isMain ? 'main' : 'window'),
    terminal_stream_id: isTerminalStream ? terminalStreamWindowStreamId : undefined,
    title: win.getTitle(),
    visible: win.isVisible(),
    focused: win.isFocused(),
    minimized: win.isMinimized(),
    maximized: win.isMaximized(),
    fullscreen: win.isFullScreen(),
    bounds,
  }
}

function getAliceWindowLayoutSnapshot() {
  const { screen } = require('electron')
  const displays = screen.getAllDisplays().map(display => ({
    id: display.id,
    scaleFactor: display.scaleFactor,
    bounds: display.bounds,
    workArea: display.workArea,
  }))
  const windows = BrowserWindow.getAllWindows()
    .map(windowSnapshot)
    .filter(Boolean)
  const terminalStream = windows.find(win => win.kind === 'terminal_stream') || null
  return { displays, windows, terminal_stream_window: terminalStream }
}

function visibleWindowBlockers(display, excludeWindow = null) {
  const { screen } = require('electron')
  return BrowserWindow.getAllWindows()
    .filter(win => win && win !== excludeWindow && !win.isDestroyed() && win.isVisible() && !win.isMinimized())
    .map(win => {
      const bounds = win.getBounds()
      return screen.getDisplayMatching(bounds).id === display.id ? bounds : null
    })
    .filter(Boolean)
}

function candidateFromRegion(region, desired, anchor = {}) {
  if (!region || region.width < TERMINAL_STREAM_MIN_WIDTH || region.height < TERMINAL_STREAM_MIN_HEIGHT) return null
  const width = Math.min(desired.width, region.width)
  const height = Math.min(desired.height, region.height)
  return fitBoundsToWorkArea({
    x: anchor.x ?? region.x,
    y: anchor.y ?? region.y,
    width,
    height,
  }, region)
}

function candidateForPlacement(placement, workArea, desired) {
  const width = Math.min(desired.width, workArea.width)
  const height = Math.min(desired.height, workArea.height)
  const cx = workArea.x + Math.round((workArea.width - width) / 2)
  const cy = workArea.y + Math.round((workArea.height - height) / 2)
  const right = workArea.x + workArea.width - width - TERMINAL_STREAM_MARGIN
  const bottom = workArea.y + workArea.height - height - TERMINAL_STREAM_MARGIN
  const left = workArea.x + TERMINAL_STREAM_MARGIN
  const top = workArea.y + TERMINAL_STREAM_MARGIN
  const key = String(placement || '').toLowerCase()

  if (key === 'right') return fitBoundsToWorkArea({ x: right, y: cy, width, height }, workArea)
  if (key === 'left') return fitBoundsToWorkArea({ x: left, y: cy, width, height }, workArea)
  if (key === 'bottom') return fitBoundsToWorkArea({ x: cx, y: bottom, width, height }, workArea)
  if (key === 'top') return fitBoundsToWorkArea({ x: cx, y: top, width, height }, workArea)
  if (key === 'top-left') return fitBoundsToWorkArea({ x: left, y: top, width, height }, workArea)
  if (key === 'top-right') return fitBoundsToWorkArea({ x: right, y: top, width, height }, workArea)
  if (key === 'bottom-left') return fitBoundsToWorkArea({ x: left, y: bottom, width, height }, workArea)
  if (key === 'bottom-right') return fitBoundsToWorkArea({ x: right, y: bottom, width, height }, workArea)
  if (key === 'center') return fitBoundsToWorkArea({ x: cx, y: cy, width, height }, workArea)
  return null
}

function scoreTerminalCandidate(bounds, blockers, mainBounds) {
  const totalOverlap = blockers.reduce((sum, blocker) => sum + rectOverlapArea(bounds, blocker), 0)
  const mainOverlap = rectOverlapArea(bounds, mainBounds)
  const area = Math.max(1, bounds.width * bounds.height)
  return (mainOverlap * 20) + (totalOverlap * 4) - (area / 1000)
}

function terminalFreeRegionCandidates(workArea, desired, mainBounds) {
  if (!mainBounds) return []
  const gap = TERMINAL_STREAM_GAP
  const regions = [
    {
      region: {
        x: rectRight(mainBounds) + gap,
        y: workArea.y,
        width: rectRight(workArea) - rectRight(mainBounds) - gap,
        height: workArea.height,
      },
      anchor: { x: rectRight(mainBounds) + gap, y: mainBounds.y },
    },
    {
      region: {
        x: workArea.x,
        y: workArea.y,
        width: mainBounds.x - workArea.x - gap,
        height: workArea.height,
      },
      anchor: { x: mainBounds.x - gap - desired.width, y: mainBounds.y },
    },
    {
      region: {
        x: workArea.x,
        y: rectBottom(mainBounds) + gap,
        width: workArea.width,
        height: rectBottom(workArea) - rectBottom(mainBounds) - gap,
      },
      anchor: { x: mainBounds.x, y: rectBottom(mainBounds) + gap },
    },
    {
      region: {
        x: workArea.x,
        y: workArea.y,
        width: workArea.width,
        height: mainBounds.y - workArea.y - gap,
      },
      anchor: { x: mainBounds.x, y: mainBounds.y - gap - desired.height },
    },
  ]

  return regions
    .map(item => candidateFromRegion(item.region, desired, item.anchor))
    .filter(Boolean)
}

function maybeArrangeMainAndTerminalSidecar(workArea, desired) {
  if (!mainWindow || mainWindow.isDestroyed() || !mainWindow.isVisible() || mainWindow.isMinimized()) return null
  if (mainWindow.isFullScreen() || mainWindow.isMaximized()) return null
  const availableWidth = workArea.width - (TERMINAL_STREAM_MARGIN * 2) - TERMINAL_STREAM_GAP
  if (availableWidth < MAIN_WINDOW_SIDECAR_MIN_WIDTH + TERMINAL_STREAM_MIN_WIDTH) return null

  const currentMain = mainWindow.getBounds()
  let mainWidth = Math.min(currentMain.width, availableWidth - TERMINAL_STREAM_MIN_WIDTH)
  mainWidth = Math.max(MAIN_WINDOW_SIDECAR_MIN_WIDTH, mainWidth)
  let terminalWidth = Math.min(desired.width, availableWidth - mainWidth)
  if (terminalWidth < TERMINAL_STREAM_MIN_WIDTH) {
    terminalWidth = TERMINAL_STREAM_MIN_WIDTH
    mainWidth = availableWidth - terminalWidth
  }
  if (mainWidth < MAIN_WINDOW_SIDECAR_MIN_WIDTH) return null

  const maxHeight = workArea.height - (TERMINAL_STREAM_MARGIN * 2)
  const mainHeight = clampNumber(currentMain.height, Math.min(MAIN_WINDOW_SIDECAR_MIN_HEIGHT, maxHeight), maxHeight)
  const terminalHeight = clampNumber(desired.height, Math.min(TERMINAL_STREAM_MIN_HEIGHT, maxHeight), maxHeight)
  const mainX = workArea.x + TERMINAL_STREAM_MARGIN
  const mainY = clampNumber(currentMain.y, workArea.y + TERMINAL_STREAM_MARGIN, workArea.y + workArea.height - TERMINAL_STREAM_MARGIN - mainHeight)
  const terminalX = mainX + mainWidth + TERMINAL_STREAM_GAP
  const terminalY = clampNumber(mainY, workArea.y + TERMINAL_STREAM_MARGIN, workArea.y + workArea.height - TERMINAL_STREAM_MARGIN - terminalHeight)
  const nextMain = roundBounds({ x: mainX, y: mainY, width: mainWidth, height: mainHeight })
  const terminalBounds = roundBounds({ x: terminalX, y: terminalY, width: terminalWidth, height: terminalHeight })

  const changed = ['x', 'y', 'width', 'height'].some(key => Math.abs(nextMain[key] - currentMain[key]) > 2)
  if (changed) {
    try { mainWindow.setBounds(nextMain, false) } catch {}
  }
  return terminalBounds
}

function chooseTerminalStreamBounds(payload = {}, excludeWindow = null) {
  const display = getDisplayForTerminalWindow(payload)
  const workArea = display.workArea
  const requested = parseTerminalRequestedBounds(payload)
  const desired = {
    width: clampNumber(
      Math.round(requested?.width || TERMINAL_STREAM_DEFAULT_WIDTH),
      Math.min(TERMINAL_STREAM_MIN_WIDTH, workArea.width),
      workArea.width
    ),
    height: clampNumber(
      Math.round(requested?.height || TERMINAL_STREAM_DEFAULT_HEIGHT),
      Math.min(TERMINAL_STREAM_MIN_HEIGHT, workArea.height),
      workArea.height
    ),
  }

  if (Number.isFinite(requested?.x) || Number.isFinite(requested?.y)) {
    return fitBoundsToWorkArea({
      x: requested.x,
      y: requested.y,
      width: desired.width,
      height: desired.height,
    }, workArea)
  }

  const placement = String(payload.placement || 'auto').toLowerCase()
  const placed = placement !== 'auto'
    ? candidateForPlacement(placement, workArea, desired)
    : null
  if (placed) return placed

  const { screen } = require('electron')
  const mainBounds = mainWindow && !mainWindow.isDestroyed() && mainWindow.isVisible() && !mainWindow.isMinimized()
    && screen.getDisplayMatching(mainWindow.getBounds()).id === display.id
    ? mainWindow.getBounds()
    : null
  const blockers = visibleWindowBlockers(display, excludeWindow)

  const freeCandidates = terminalFreeRegionCandidates(workArea, desired, mainBounds)
  const zeroOverlap = freeCandidates
    .filter(bounds => blockers.every(blocker => rectOverlapArea(bounds, blocker) === 0))
    .sort((a, b) => scoreTerminalCandidate(a, blockers, mainBounds) - scoreTerminalCandidate(b, blockers, mainBounds))
  if (zeroOverlap[0]) return zeroOverlap[0]

  const sidecar = maybeArrangeMainAndTerminalSidecar(workArea, desired)
  if (sidecar) return sidecar

  const fallbackCandidates = [
    ...freeCandidates,
    candidateForPlacement('top-right', workArea, desired),
    candidateForPlacement('bottom-right', workArea, desired),
    candidateForPlacement('bottom-left', workArea, desired),
    candidateForPlacement('top-left', workArea, desired),
    candidateForPlacement('right', workArea, desired),
    candidateForPlacement('center', workArea, desired),
  ].filter(Boolean)

  fallbackCandidates.sort((a, b) => scoreTerminalCandidate(a, blockers, mainBounds) - scoreTerminalCandidate(b, blockers, mainBounds))
  return fallbackCandidates[0] || fitBoundsToWorkArea({ width: desired.width, height: desired.height }, workArea)
}

function showTerminalStreamWindow(win, focusWindow = true) {
  if (!win || win.isDestroyed()) return
  if (focusWindow === false && typeof win.showInactive === 'function') {
    win.showInactive()
    return
  }
  if (win.isMinimized()) win.restore()
  win.show()
  win.focus()
}

function normalizeTerminalStreamId(value = 'default') {
  return String(value || 'default').replace(/[^a-zA-Z0-9_.:-]+/g, '_').slice(0, 80) || 'default'
}

function createTerminalStreamWindow(payload = {}) {
  const { title = 'Alice Terminal Stream', stream_id = 'default' } = payload
  const cleanTitle = String(title || 'Alice Terminal Stream').slice(0, 120)
  const streamId = normalizeTerminalStreamId(stream_id)
  const url = backendUrl(backendPort, `/terminal-stream?stream_id=${encodeURIComponent(streamId)}`)
  const focusWindow = payload.focus !== false

  if (terminalStreamWindow && !terminalStreamWindow.isDestroyed()) {
    const streamChanged = terminalStreamWindowStreamId !== streamId
    terminalStreamWindow.setTitle(cleanTitle)
    if (streamChanged || payload.relayout === true) {
      terminalStreamWindow.setBounds(chooseTerminalStreamBounds(payload, terminalStreamWindow), false)
    }
    if (streamChanged) {
      terminalStreamWindowStreamId = streamId
      terminalStreamWindow.loadURL(url)
    }
    showTerminalStreamWindow(terminalStreamWindow, focusWindow)
    return
  }

  const initialBounds = chooseTerminalStreamBounds(payload, null)
  terminalStreamWindow = new BrowserWindow({
    ...initialBounds,
    minWidth: TERMINAL_STREAM_MIN_WIDTH,
    minHeight: TERMINAL_STREAM_MIN_HEIGHT,
    show: false,
    backgroundColor: '#050505',
    title: cleanTitle,
    icon: getAppIconPath(),
    webPreferences: {
      contextIsolation: true,
      nodeIntegration: false,
      backgroundThrottling: false,
    },
  })

  terminalStreamWindowStreamId = streamId
  terminalStreamWindow.loadURL(url)
  showTerminalStreamWindow(terminalStreamWindow, focusWindow)
  terminalStreamWindow.on('closed', () => {
    terminalStreamWindow = null
    terminalStreamWindowStreamId = null
  })
}

terminalStreamBridge.on('open', (payload = {}) => {
  createTerminalStreamWindow(payload)
})

terminalStreamBridge.on('close', (payload = {}) => {
  if (terminalStreamWindow && !terminalStreamWindow.isDestroyed()) {
    const streamId = payload?.stream_id ? normalizeTerminalStreamId(payload.stream_id) : null
    if (streamId && terminalStreamWindowStreamId && streamId !== terminalStreamWindowStreamId) return
    terminalStreamWindow.close()
    terminalStreamWindow = null
    terminalStreamWindowStreamId = null
  }
})

function createWakeProbeWindow() {
  if (wakeProbeWindow && !wakeProbeWindow.isDestroyed()) return
  wakeProbeWindow = new BrowserWindow({
    width: 220,
    height: 120,
    show: false,           // 始终隐藏:它只是"耳朵"
    skipTaskbar: true,
    webPreferences: {
      contextIsolation: true,
      nodeIntegration: false,
      preload: path.join(__dirname, 'wake-probe-preload.cjs'),
      autoplayPolicy: 'no-user-gesture-required', // 隐藏窗口无用户手势也能启动 AudioContext
      backgroundThrottling: false,                // 后台不降频,保证常开采集不被节流
    },
  })

  wakeProbeWindow.webContents.session.setPermissionRequestHandler((wc, permission, callback) => {
    callback(permission === 'media')
  })
  wakeProbeWindow.webContents.session.setPermissionCheckHandler((wc, permission) => permission === 'media')

  wakeProbeWindow.loadFile(path.join(__dirname, 'wake-probe.html'))
  wakeProbeWindow.on('closed', () => { wakeProbeWindow = null })
}

ipcMain.on('wake:pcm', (_e, buffer) => {
  if (!buffer) return
  wakeWord.feedPcm(buffer) // 原样转发 ArrayBuffer 给 KWS 子进程
})

ipcMain.on('wake:status', (_e, info) => {
  console.log('[wake-probe] 耳朵状态:', info?.status, info?.detail || '')
})

// ─── 语音唤醒第二步:独立置顶悬浮球窗口 ───
// 命中「小白龙」→ 主窗口渲染层(voice-wake.js)开会话 + 经下列 IPC 驱动这个纯视觉球窗:
// 入场动画 → 镜像球状态 → 10s 无话退场。球窗没有麦克风,真正的开麦/识别/对话仍在主窗口跑。
// 透明/无边框/置顶/不抢焦点;首次唤醒时懒建,之后 hide 不销毁(下次唤醒即时入场)。
// backgroundThrottling:false 让隐藏时也能立刻起动画(与主窗口同理)。
function createVoiceOrbWindow() {
  if (voiceOrbWindow && !voiceOrbWindow.isDestroyed()) return
  const { workArea } = require('electron').screen.getPrimaryDisplay()
  const W = 640, H = 380, topMargin = 8 // 球 264px(较初版翻倍) + 球下两行识别文字
  voiceOrbWindow = new BrowserWindow({
    width: W,
    height: H,
    x: workArea.x + Math.round((workArea.width - W) / 2), // 屏幕正上方居中
    y: workArea.y + topMargin,
    show: false,
    frame: false,
    transparent: true,
    alwaysOnTop: true,
    skipTaskbar: true,
    resizable: false,
    movable: false,
    minimizable: false,
    maximizable: false,
    focusable: false, // 纯视觉,绝不抢占前台应用的焦点
    webPreferences: {
      contextIsolation: true,
      nodeIntegration: false,
      preload: path.join(__dirname, 'voice-orb-preload.cjs'),
      backgroundThrottling: false,
    },
  })
  // 复用 brain-ui 的静态路由(/src/ui/brain-ui/*),voice-orb.html 的 import './voice-core.js' 才能解析
  voiceOrbWindow.loadURL(backendUrl(backendPort, '/src/ui/brain-ui/voice-orb.html'))
  voiceOrbWindow.on('closed', () => { voiceOrbWindow = null })
}

function sendToOrb(channel, payload) {
  if (!voiceOrbWindow || voiceOrbWindow.isDestroyed()) return
  voiceOrbWindow.webContents.send(channel, payload)
}

// 主窗口渲染层 → 主进程:入场(显示球窗,不抢焦点)/ 状态镜像 / 退场
ipcMain.on('wake:orb-enter', () => {
  createVoiceOrbWindow()
  const show = () => {
    if (!voiceOrbWindow || voiceOrbWindow.isDestroyed()) return
    voiceOrbWindow.showInactive() // 显示但不获焦,不打扰用户当前应用
    sendToOrb('orb:enter')
  }
  // 首次创建需等页面加载完再下发命令;已加载则立即
  if (voiceOrbWindow.webContents.isLoading()) {
    voiceOrbWindow.webContents.once('did-finish-load', show)
  } else {
    show()
  }
})

ipcMain.on('wake:orb-frame', (_e, payload) => { sendToOrb('orb:frame', payload) })

ipcMain.on('wake:orb-text', (_e, payload) => { sendToOrb('orb:text', payload) })

ipcMain.on('wake:orb-exit', () => { sendToOrb('orb:exit') })

// 球窗:退场动画播完 → 真正隐藏(保活,下次唤醒复用)
ipcMain.on('wake:orb-exit-done', () => {
  if (voiceOrbWindow && !voiceOrbWindow.isDestroyed()) voiceOrbWindow.hide()
})

function setupAutoUpdater() {
  if (IS_PORTABLE) {
    console.log(`[updater] skipped in portable mode, data dir: ${USER_DIR}`)
    sendUpdaterStatus({ stage: 'portable', portable: true })
    return
  }
  if (!IS_DEV && !hasPackagedUpdaterConfig()) {
    console.log('[updater] skipped: packaged update configuration is unavailable')
    sendUpdaterStatus({ stage: 'unavailable', reason: 'missing-config' })
    return
  }

  autoUpdater.autoDownload = false
  // Marks updater traffic so the update gateway can issue short-lived OSS URLs.
  // This is an application marker, not a user credential.
  autoUpdater.requestHeaders = {
    'X-Alice-Updater': 'AliceUpdater/2',
  }
  // Avoid applying an already downloaded update while Windows is shutting down.
  // The renderer still installs explicitly through updater:quit-and-install.
  autoUpdater.autoInstallOnAppQuit = false

  autoUpdater.on('checking-for-update', () => {
    sendUpdaterStatus({ stage: 'checking' })
  })

  autoUpdater.on('update-available', info => {
    console.log('[updater] update available', info?.version)
    sendUpdaterStatus({ stage: 'available', version: info?.version })
  })

  autoUpdater.on('download-progress', progress => {
    sendUpdaterStatus({
      stage: 'downloading',
      percent: Number(progress?.percent || 0),
      transferred: progress?.transferred || 0,
      total: progress?.total || 0,
    })
  })

  autoUpdater.on('update-downloaded', info => {
    console.log('[updater] update downloaded', info?.version)
    sendUpdaterStatus({ stage: 'downloaded', version: info?.version })
  })

  autoUpdater.on('update-not-available', info => {
    sendUpdaterStatus({
      stage: 'up-to-date',
      version: info?.version || app.getVersion(),
    })
  })

  autoUpdater.on('error', err => {
    const message = err?.message || String(err || 'Update failed')
    console.warn('[updater] update failed', message)
    sendUpdaterStatus({ stage: 'error', message })
  })

  if (!IS_DEV) {
    autoUpdater.checkForUpdates().catch(err => {
      // 不要静默吞掉更新检查失败。GitHub 在国内经常超时/不可达，若整段吞掉，
      // 用户会卡在「永远没有更新」且无任何痕迹。这里至少落到日志，便于排查。
      console.warn('[updater] initial check failed', err?.message || err)
    })
  }
}

ipcMain.handle('app:get-version', () => app.getVersion())
// 输入框右键菜单的复制/粘贴统一走主进程系统剪贴板：
// 渲染层 document.execCommand('paste') 在 Chromium 里已不执行，navigator.clipboard
// 又受权限与焦点限制，所以由主进程读写、经 preload 暴露给界面。
ipcMain.handle('clipboard:read-text', () => clipboard.readText())
ipcMain.handle('clipboard:write-text', (_event, text) => {
  clipboard.writeText(String(text == null ? '' : text))
  return true
})
ipcMain.handle('ui:set-language', (_event, locale) => ({ locale: setNativeUiLanguage(locale) }))
ipcMain.handle('startup:get-progress', () => cloneStartupProgressState())
ipcMain.handle('window:is-full-screen', (event) => {
  const targetWindow = BrowserWindow.fromWebContents(event.sender)
  return Boolean(targetWindow && !targetWindow.isDestroyed() && targetWindow.isFullScreen())
})
ipcMain.handle('window:set-title-bar-theme', (event, theme) => {
  if (!IS_WIN) return false
  const targetWindow = BrowserWindow.fromWebContents(event.sender)
  if (!targetWindow || targetWindow.isDestroyed()) return false
  const normalizedTheme = typeof theme === 'string' ? theme.trim().toLowerCase() : 'midnight'
  targetWindow.setTitleBarOverlay(windowsTitleBarOverlay(normalizedTheme))
  return true
})

function requireMainWindowSender(event) {
  return browserEmbedSenderGuard.requireTrustedSender(event)
}

// ── 打开外链 / 打开目录（移植 dsh-tauri-rightclick 的宿主能力）────────────────
// 两道出口，同一套失败判据：
//   1) IPC（下面 ipcMain.handle）：渲染层经 preload 的 alice.desktopOpen.* 直接调；
//   2) globalThis.aliceDesktopOpen：后端 ESM（src/api/routes/desktop-open.js）跑在本主进程
//      里却 import 不到 electron 内建模块，所以像 aliceSystemPreferences 一样挂到 globalThis。
// 两条出口都必须先过 requireMainWindowSender：这是「只有主窗口能指挥操作系统打开东西」的边界。
//
// ⚠️ URL 校验**必须用 URL 解析，不能用前缀正则**。
// 这里原本是 `/^https?:\/\//i`，看起来"只放行 http/https"，实际放行了一批畸形输入：
// `https://a b`、`https://exa mple.com`（含空格）、`http://`（空主机）、
// `https://\u0000x`（含 NUL）、`http://[]`（非法主机）—— 全部通过前缀判断，
// 然后被原样交给 shell.openExternal。
// 而 HTTP 那条出口（src/api/routes/desktop-open.js 的 safeWebUrl）用 `new URL()` +
// 严格比对 protocol，这些一律拒绝。**同一件事两份实现、校验强度不同** ——
// 与 not-a-directory 那个 bug 同型：逻辑复制之后各自漂移。
// 现在两份实现对齐到同一个判据（safeWebUrl 的语义），畸形输入在前缀判断这里就拦掉。
function safeExternalUrl(value) {
  if (typeof value !== 'string') return null
  const trimmed = value.trim()
  if (trimmed === '') return null
  try {
    const parsed = new URL(trimmed)
    return parsed.protocol === 'http:' || parsed.protocol === 'https:' ? parsed.href : null
  } catch {
    return null
  }
}

async function openDesktopUrl(event, url) {
  requireMainWindowSender(event)
  const target = safeExternalUrl(url)
  if (target === null) return { ok: false, error: 'invalid-url' }
  try {
    await shell.openExternal(target)
    return { ok: true }
  } catch (error) {
    console.warn('[desktop-open] openExternal failed:', error?.message || error)
    return { ok: false, error: 'open-url-failed' }
  }
}

async function openDesktopPath(event, target) {
  requireMainWindowSender(event)
  const dir = typeof target === 'string' ? target.trim() : ''
  if (!dir) return { ok: false, error: 'invalid-path' }
  if (/^[a-z][a-z\d+.-]*:\/\//i.test(dir)) return { ok: false, error: 'invalid-path' }
  // shell.openPath 对不存在的路径**返回错误字符串**（resolve，不 reject）。
  // 只 try/catch 会把「打不开」当成功，UI 于是报成功而什么都没发生。
  const failure = await shell.openPath(path.normalize(dir))
  if (typeof failure === 'string' && failure.length > 0) {
    console.warn('[desktop-open] openPath failed:', failure)
    // 原因不止「不是目录」：可能是路径不存在，也可能是没有关联程序。
    // 别替 Electron 下结论 —— 用中性的 open-path-failed，并把原始原因带回给调用方。
    // （与 api/routes/desktop-open.js 的 performOpenPath 保持同一套错误码。）
    return { ok: false, error: 'open-path-failed', reason: failure }
  }
  return { ok: true }
}

ipcMain.handle('desktop:open-url', (event, url) => openDesktopUrl(event, url))
ipcMain.handle('desktop:open-path', (event, target) => openDesktopPath(event, target))

globalThis.aliceDesktopOpen = Object.freeze({
  // 这里也走 safeExternalUrl（不是前缀正则）。
  // 调用方 src/api/routes/desktop-open.js 已经用 safeWebUrl 校验过一遍，这里是**第二道**；
  // 但第二道不该比第一道更弱 —— 之前它恰恰更弱（前缀正则放行 `https://a b` 这类畸形输入）。
  // 纵深防御的意义在于两道都严，而不是"反正前面拦过了"。
  openExternal: async (url) => {
    const target = safeExternalUrl(url)
    if (target === null) throw new Error('invalid-url')
    await shell.openExternal(target)
  },
  // 故意返回 shell.openPath 的**原始返回值**（空字符串=成功，非空=错误文本）：
  // 后端路由按 Electron 的真实契约判失败，而不是被这里包装过一层。
  openPath: (target) => shell.openPath(path.normalize(String(target || ''))),
})

// ── 桌宠悬浮窗口（移植 dsh-tauri-pet 的窗口与命令层）────────────────────────
// DSH 的桌宠是 Tauri 里的独立 webview，靠 9 个 invoke 命令受控；Electron 的等价物
// 是另一个 BrowserWindow，与上面 createVoiceOrbWindow()（悬浮语音球）同一套模式。
// 窗口控制器在 electron/pet-window.cjs，状态存取的纯逻辑在 electron/pet-state.cjs。
//
// 关键设计：**推理流不经过主进程**。桌宠窗口自己连后端的 SSE
// （/api/desktop/dsh-tauri-pet/session/stream），所以窗口一关 → SSE 断开 →
// 宿主侧最后一个 sink 归零 → 自动注销订阅。主进程只负责窗口生命周期与状态存取，
// 不需要维护任何引用计数。
const petController = createPetController({
  getUserDir: () => USER_DIR,
  loadPage: (win, pagePath) => win.loadURL(backendUrl(backendPort, pagePath)),
})

// 9 个 Tauri 命令 → IPC。Wayland 的两个（get/set_force_xwayland）在 Windows 下不适用，未提供。
for (const [channel, handler] of Object.entries(petController.commands)) {
  ipcMain.handle(channel, (_event, payload) => handler(payload))
}

// 启动时按持久化的偏好恢复桌宠（enabled=true 才显示）。
// 后端端口这时可能还没起来，所以延后到 did-finish-load 由 loadPage 自行兜住。
app.whenReady().then(() => {
  try {
    const state = petController.getStatus()
    if (state.enabled) petController.setEnabled(true)
  } catch (error) {
    console.warn('[pet] restore failed:', error?.message || error)
  }
})

ipcMain.handle('browser-embed:update', (event, options) => (
  browserEmbedHost.update(requireMainWindowSender(event), options)
))
ipcMain.handle('browser-embed:hide', event => (
  browserEmbedHost.hide(requireMainWindowSender(event))
))
ipcMain.handle('browser-embed:get-state', event => (
  browserEmbedHost.getState(requireMainWindowSender(event))
))

ipcMain.handle('system-screenshot:get-latest', async (_event, options = {}) => {
  const maxAgeMs = Number(options?.maxAgeMs || 15 * 60 * 1000)
  const preferClipboard = options?.preferClipboard !== false

  if (preferClipboard) {
    try {
      const image = clipboard.readImage()
      if (image && !image.isEmpty()) {
        const png = image.toPNG()
        if (png?.length) {
          return {
            ok: true,
            source: 'clipboard',
            filename: `system-screenshot-${Date.now()}.png`,
            mime: 'image/png',
            byteLength: png.length,
            dataUrl: `data:image/png;base64,${png.toString('base64')}`,
          }
        }
      }
    } catch (err) {
      console.warn('[system-screenshot] clipboard read failed:', err?.message || err)
    }
  }

  try {
    const latest = findLatestSystemScreenshotFile({ maxAgeMs })
    if (latest?.path) {
      return {
        ok: true,
        source: 'system-cache',
        path: latest.path,
        filename: path.basename(latest.path),
        mime: imageMimeForPath(latest.path),
        byteLength: latest.size,
        mtimeMs: latest.mtimeMs,
        dataUrl: fileImageToDataUrl(latest.path),
      }
    }
  } catch (err) {
    console.warn('[system-screenshot] cache scan failed:', err?.message || err)
  }

  return { ok: false, error: 'no_recent_system_screenshot' }
})

ipcMain.handle('updater:check-for-updates', async () => {
  if (IS_PORTABLE) {
    sendUpdaterStatus({ stage: 'portable', portable: true })
    return { ok: false, skipped: true, reason: 'portable' }
  }
  if (IS_DEV) {
    sendUpdaterStatus({ stage: 'dev' })
    return { ok: false, skipped: true, reason: 'dev' }
  }
  if (!hasPackagedUpdaterConfig()) {
    sendUpdaterStatus({ stage: 'unavailable', reason: 'missing-config' })
    return { ok: false, skipped: true, reason: 'missing-config' }
  }
  try {
    sendUpdaterStatus({ stage: 'checking' })
    const result = await autoUpdater.checkForUpdates()
    return { ok: true, updateInfo: result?.updateInfo || null }
  } catch (error) {
    const message = error?.message || String(error || 'Update check failed')
    sendUpdaterStatus({ stage: 'error', message })
    return { ok: false, message }
  }
})

ipcMain.handle('updater:start-download', async () => {
  if (IS_PORTABLE) {
    sendUpdaterStatus({ stage: 'portable', portable: true })
    return { ok: false, skipped: true, reason: 'portable' }
  }
  try {
    await autoUpdater.downloadUpdate()
    return { ok: true }
  } catch (error) {
    const message = error?.message || String(error || 'Download failed')
    sendUpdaterStatus({ stage: 'error', message })
    return { ok: false, message }
  }
})

ipcMain.handle('updater:quit-and-install', () => {
  if (IS_PORTABLE) {
    sendUpdaterStatus({ stage: 'portable', portable: true })
    return { ok: false, skipped: true, reason: 'portable' }
  }
  autoUpdater.quitAndInstall()
  return { ok: true }
})

app.on('second-instance', () => {
  showMainWindow().catch(() => {})
})

app.on('activate', () => {
  if (IS_MAC) showMainWindow().catch(() => {})
})

app.on('window-all-closed', () => {
  // 主窗口关闭后保持后台运行（Focus Banner 等桌面功能继续工作）
  // 只有托盘菜单「退出」才真正退出
})

let browserShutdownBeforeQuit = null
let browserShutdownComplete = false
app.on('before-quit', (event) => {
  app.isQuiting = true
  if (browserShutdownComplete) {
    browserEmbedHost.destroyAll()
    return
  }
  const shutdowns = [
    globalThis.shutdownAliceMcpClients,
    () => aliceChrome.stopOwnedChrome(),
  ].filter(shutdown => typeof shutdown === 'function')
  if (shutdowns.length === 0) {
    browserShutdownComplete = true
    browserEmbedHost.destroyAll()
    return
  }
  event.preventDefault()
  if (browserShutdownBeforeQuit) return
  // The backend runs in this process. Wait for MCP/Chrome cleanup, with a hard
  // upper bound so a broken browser connection cannot trap the quit loop.
  let browserShutdownTimer
  browserShutdownBeforeQuit = Promise.race([
    Promise.allSettled(shutdowns.map(shutdown => Promise.resolve().then(() => shutdown()))),
    new Promise(resolve => { browserShutdownTimer = setTimeout(resolve, 5_000) }),
  ]).finally(() => {
    clearTimeout(browserShutdownTimer)
    browserShutdownComplete = true
    app.quit() // second before-quit observes browserShutdownComplete and proceeds
  })
})

app.whenReady().then(async () => {
  Menu.setApplicationMenu(null)
  await createWindow({ loadStartup: true })

  try {
    emitStartupProgress({ id: 'port', status: 'running', message: '正在准备本地端口' })
    backendPort = await findFreePort(
      3721,
      isLanAccessConfigured() ? '0.0.0.0' : '127.0.0.1',
    )
    emitStartupProgress({ id: 'port', status: 'done', detail: `本地端口 ${backendPort} 已准备` })

    emitStartupProgress({ id: 'core', status: 'running', message: '正在启动本地核心' })
    await bootstrapBackend(backendPort)
    emitStartupProgress({ id: 'core', status: 'done', message: '本地核心已启动' })

    emitStartupProgress({ id: 'api', status: 'running', detail: '等待 activation-status', message: '正在确认本地 API 就绪' })
    await waitForBackend(backendPort)
    emitStartupProgress({ id: 'api', status: 'done', detail: `本地 API 已监听 ${backendPort}`, message: '本地 API 已启动' })
  } catch (err) {
    console.error(`[main] Backend startup failed on port ${backendPort || 'unknown'}`, err?.stack || err?.message || err)
    emitStartupProgress({ id: 'core', status: 'error', error: true, message: `启动失败: ${err.message}` })
    dialog.showErrorBox('Startup failed', `Unable to start the Alice backend:\n${err.message}`)
    app.quit()
    return
  }

  try {
    await replaceStartupWithMainApp()
  } catch (err) {
    console.error('[main] Failed to load Alice UI', err?.stack || err?.message || err)
    emitStartupProgress({ id: 'interface', status: 'error', error: true, message: `进入界面失败: ${err.message}` })
    dialog.showErrorBox('Startup failed', `Unable to load the Alice interface:\n${err.message}`)
    app.quit()
    return
  }
  setupTray()
  setupAutoUpdater()

  // 语音唤醒:初始化主进程 KWS 引擎,成功则开启隐藏"耳朵"窗口常驻监听。
  // 失败(如缺模型/原生模块)不影响 app 其余功能 —— initWakeWord 内部已吞错。
  try {
    const wakeReady = wakeWord.initWakeWord({ codeRoot: CODE_ROOT, logDir: LOG_DIR })
    if (wakeReady) {
      // 命中"小白龙"→ ① 开发板灯 0.6s 内闪三次后灭(灯离线则静默忽略);
      //              ② 通知主窗口渲染层启动唤醒会话(开麦+悬浮球入场+10s 监听,见 voice-wake.js)。
      wakeWord.setOnHit(() => {
        devLight.blink()
        if (mainWindow && !mainWindow.isDestroyed()) mainWindow.webContents.send('wake:hit')
      })
      createWakeProbeWindow()
      createVoiceOrbWindow() // 预建悬浮球窗(隐藏),首次唤醒即时入场
      console.log('[main] 语音唤醒已启用,隐藏耳朵窗口已开启')
    } else {
      console.warn('[main] 语音唤醒未启用(引擎初始化失败,见 wake-word.log)')
    }
  } catch (err) {
    console.error('[main] 语音唤醒启动异常(忽略):', err?.message || err)
  }
  // 不再注册任何系统级 globalShortcut；F11 / F12 / Ctrl+R 已由 mainWindow
  // 的 before-input-event 处理（见 createWindow），只在窗口获焦时生效，
  // 不会劫持浏览器/IDE 等其他应用的同键操作。
})
