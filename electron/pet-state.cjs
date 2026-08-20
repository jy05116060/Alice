'use strict'

// 桌宠悬浮窗口的主进程侧实现（Tauri → Electron 的映射层）。
//
// 与 DSH 的关系：DSH 的桌宠是 Tauri 里的**独立 webview**，通过 9 个 invoke 命令
// （get_pet_status / set_pet_enabled / set_active_pet / set_pet_size / list_pets /
// import_pet / list_preset_pets / get_pet_overlay_supported / get_force_xwayland）
// 受控。Electron 没有 Tauri 的 webview 概念，等价物是**另一个 BrowserWindow**
// ——与仓库既有的 `createVoiceOrbWindow()`（悬浮语音球）走同一套模式：
// 透明、无边框、置顶、不抢焦点、懒建、hide 不销毁。
//
// **窗口是独立的，但数据源是同一条 SSE**：窗口里加载的 pet.html 自己连
// `/api/desktop/dsh-tauri-pet/session/stream`，主进程不转发推理帧——
// 这样「没人看就不干活」的收工条件天然成立（窗口一关，SSE 断开，宿主收工）。
//
// 诚实边界：本文件**不包含任何宠物图片资产**。DSH 的 `skills/` 目录在实际安装的
// node_modules 里不存在，所以没有可复制的内置精灵图；这里只实现**机制与目录扫描**。
// 扫描不到就是空列表，绝不返回伪造的图像数据。

const fs = require('fs')
const path = require('path')

/** 桌宠尺寸范围与步长（DSH 契约：默认 100，范围 50–200，step 5）。 */
const PET_SIZE_DEFAULT = 100
const PET_SIZE_MIN = 50
const PET_SIZE_MAX = 200
const PET_SIZE_STEP = 5

/**
 * 精灵图规格（DSH 契约 8 列 × 11 行）。
 * 这里只导出规格常量供渲染层排帧，**不生成也不伪造图像**。
 */
const PET_SPRITE_COLUMNS = 8
const PET_SPRITE_ROWS = 11

/** 桌宠窗口基准像素：size=100 时窗口边长。 */
const PET_BASE_PX = 160

/**
 * 把任意输入夹到契约范围内并对齐步长。
 * 非数字/越界一律回落到默认值——桌宠尺寸是**展示偏好**，不值得为此报错。
 */
function normalizePetSize(value) {
  const n = Number(value)
  if (!Number.isFinite(n)) return PET_SIZE_DEFAULT
  const stepped = Math.round(n / PET_SIZE_STEP) * PET_SIZE_STEP
  if (stepped < PET_SIZE_MIN) return PET_SIZE_MIN
  if (stepped > PET_SIZE_MAX) return PET_SIZE_MAX
  return stepped
}

/** 人类可读的尺寸档位列表（设置页滑块用）。 */
function petSizeOptions() {
  const out = []
  for (let size = PET_SIZE_MIN; size <= PET_SIZE_MAX; size += PET_SIZE_STEP) out.push(size)
  return out
}

/**
 * 把 pet_size 换算成窗口边长（像素）。
 * size=100 → PET_BASE_PX，线性缩放；仍按步长取整避免亚像素抖动。
 */
function petWindowPx(size) {
  const normalized = normalizePetSize(size)
  return Math.round((PET_BASE_PX * normalized) / PET_SIZE_DEFAULT)
}

/**
 * 宠物目录根。刻意放在 userData 下（与 voice-orb 的静态资源分离）：
 * 用户导入的宠物属于**用户数据**，升级覆盖安装不能清掉。
 */
function petRootDir(userDir) {
  return path.join(userDir, 'pets')
}

/** 三路来源各自对应的子目录（DSH 契约：presetPets / chatPets / codexPets）。 */
const PET_SOURCES = Object.freeze({
  preset: 'preset',
  chat: 'chat',
  codex: 'codex',
})

function isPetSource(value) {
  return Object.prototype.hasOwnProperty.call(PET_SOURCES, String(value || ''))
}

/**
 * 列出某个来源下的宠物。
 *
 * **扫描机制已实现，但没有内置资产**：目录不存在 / 为空都返回空数组，
 * 不报错（与 paths.js「没有就是没有」的纪律一致）。
 * 目录名即宠物 id 与显示名。
 */
function listPets(userDir, source) {
  const key = isPetSource(source) ? String(source) : PET_SOURCES.preset
  const dir = path.join(petRootDir(userDir), key)
  let entries
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true })
  } catch {
    return []
  }
  const pets = []
  for (const entry of entries) {
    if (!entry.isDirectory()) continue
    if (entry.name.startsWith('.')) continue
    const petDir = path.join(dir, entry.name)
    /* 把**具体是哪个文件**报给渲染层，别只报一个布尔。
       原先只有 `hasSprite`，渲染层于是自己猜文件名（只拼了 sprite.png）——
       而 hasSprite 的判据是 `sprite.png || spritesheet.png`。
       结果：只有 spritesheet.png 的宠物 hasSprite=true，渲染层却去加载不存在的
       sprite.png → 404 → 宠物显示空白。**布尔丢失了渲染层需要的那个信息。**
       现在报 spriteFile（有就报实际存在的那个），渲染层照着取即可，不用猜。
       hasSprite 保留（既有调用方与测试依赖它），两者由同一处真相推导，不会不一致。 */
    const hasSpritePng = fs.existsSync(path.join(petDir, 'sprite.png'))
    const hasSpritesheetPng = fs.existsSync(path.join(petDir, 'spritesheet.png'))
    pets.push({
      id: `${key}/${entry.name}`,
      name: entry.name,
      source: key,
      hasSprite: hasSpritePng || hasSpritesheetPng,
      // sprite.png 优先（单图更省流），否则 spritesheet.png；都没有则为 null。
      spriteFile: hasSpritePng ? 'sprite.png' : hasSpritesheetPng ? 'spritesheet.png' : null,
    })
  }
  pets.sort((a, b) => a.name.localeCompare(b.name))
  return pets
}

/** 列出三路来源的全部宠物。 */
function listAllPets(userDir) {
  return {
    preset: listPets(userDir, PET_SOURCES.preset),
    chat: listPets(userDir, PET_SOURCES.chat),
    codex: listPets(userDir, PET_SOURCES.codex),
  }
}

/**
 * 导入一只宠物（Codex 导入路径）。
 *
 * DSH 侧是 `<input type="file" accept=".zip">` → `FileReader.readAsDataURL` → base64，
 * 主进程收到 base64 后落盘。这里**如实处理**：
 * - 收 base64 或原始字节；文件名做安全清洗（防目录穿越）；
 * - **不解压 zip**（没有可用的解压实现，且 DSH 的 zip 内部结构未公开），
 *   原样保存为 `.zip` 并与用户说明「已保存但未解析」——绝不假装解析成功。
 *
 * @returns {{ok:true,id:string,path:string,extracted:false}|{ok:false,error:string}}
 */
function importPet(userDir, { name, data } = {}) {
  const rawName = String(name ?? '').trim()
  if (!rawName) return { ok: false, error: 'invalid-name' }
  // 安全清洗：只保留基名，去掉路径分隔符与上级引用，防止写到 pets 目录之外。
  const base = path.basename(rawName).replace(/[\\/:*?"<>|]/g, '_').replace(/^\.+/, '')
  if (!base) return { ok: false, error: 'invalid-name' }
  if (typeof data !== 'string' || !data) return { ok: false, error: 'invalid-data' }

  // 接受 dataURL 或裸 base64。
  const commaAt = data.indexOf(',')
  const base64 = /^data:[^,]*;base64,/i.test(data) ? data.slice(commaAt + 1) : data
  let buffer
  try {
    buffer = Buffer.from(base64, 'base64')
  } catch {
    return { ok: false, error: 'invalid-data' }
  }
  if (!buffer.length) return { ok: false, error: 'invalid-data' }

  const petName = base.replace(/\.zip$/i, '') || 'imported'
  const dir = path.join(petRootDir(userDir), PET_SOURCES.codex, petName)
  try {
    fs.mkdirSync(dir, { recursive: true })
    fs.writeFileSync(path.join(dir, base.endsWith('.zip') ? base : `${base}.zip`), buffer)
  } catch (err) {
    return { ok: false, error: `write-failed: ${err?.message || err}` }
  }
  // extracted 恒为 false：zip 未解压，渲染层据此显示「已保存，待解析」而不是假装可用。
  return { ok: true, id: `${PET_SOURCES.codex}/${petName}`, path: dir, extracted: false }
}

/**
 * 桌宠状态存取（DSH 的 `{enabled, active_pet, pet_size}` 形状，逐字保持）。
 * 存在 userData 下的小 JSON 里：它是**用户偏好**，重启要保留（与机器记录同理）。
 */
function petStateFile(userDir) {
  return path.join(userDir, 'pet-state.json')
}

function readPetState(userDir) {
  const fallback = { enabled: false, active_pet: '', pet_size: PET_SIZE_DEFAULT }
  let text
  try {
    text = fs.readFileSync(petStateFile(userDir), 'utf8')
  } catch {
    return fallback
  }
  let parsed
  try {
    parsed = JSON.parse(text)
  } catch {
    // 损坏文件按默认值处理，绝不抛异常——与 ssh 的 readState 同一纪律。
    return fallback
  }
  return {
    enabled: parsed?.enabled === true,
    active_pet: typeof parsed?.active_pet === 'string' ? parsed.active_pet : '',
    pet_size: normalizePetSize(parsed?.pet_size),
  }
}

/**
 * 落盘桌宠状态。
 *
 * ⚠️ **返回值的 `persisted` 字段是必须的**（2026-10-01 修正）。
 *
 * 原先失败分支和成功分支**返回同一个对象**：
 * ```js
 *   } catch {
 *     return next        // ← 失败
 *   }
 *   return next          // ← 成功
 * ```
 * 两行完全一样，调用方**无法区分**。实测（把父目录做成普通文件，mkdir 必然失败）：
 * ```
 *   writePetState(...) → {"enabled":true,...}    ← 与真成功逐字节相同
 *   磁盘上实际内容      → ENOENT（什么都没写）
 * ```
 *
 * 后果链：`pet:set-enabled(true)` 拿到 `{enabled:true}` → `applyEnabled(true)`
 * → `createWindow()` + `showInactive()` → **窗口真的出现在屏幕上** →
 * 而状态从未落盘 → **重启应用后桌宠不见了**，且全程零报错。
 *
 * 这与问题 18 同族（查询失败被伪装成"不存在"）：
 * **都是把一种状态谎报成另一种状态。** 本轮这类已累计 4 处
 * （11 编造成功 / 13 不该写却写 / 16 业务拒绝当传输失败 / 18 故障伪装成空集）。
 *
 * 修法：`persisted` 如实反映"到底写进磁盘没有"，失败时记 warn。
 * **不改 `enabled` 等字段的值** —— 窗口该不该显示由调用方决定，
 * 这里只负责诚实报告"这个状态是否已经持久化"。
 */
function writePetState(userDir, state) {
  const next = {
    enabled: state?.enabled === true,
    active_pet: typeof state?.active_pet === 'string' ? state.active_pet : '',
    pet_size: normalizePetSize(state?.pet_size),
  }
  const file = petStateFile(userDir)
  const tmp = `${file}.tmp`
  try {
    fs.mkdirSync(path.dirname(file), { recursive: true })
    // 原子写：先写临时文件再 rename，避免半个 JSON 留在盘上。
    fs.writeFileSync(tmp, JSON.stringify(next, null, 2), 'utf8')
    fs.renameSync(tmp, file)
  } catch (error) {
    const message = String(error?.message || error)
    console.warn('[pet-state] 状态落盘失败（本次设置重启后会丢失）:', message)
    return { ...next, persisted: false, persist_error: message }
  }
  return { ...next, persisted: true }
}

/**
 * 透明置顶浮层的支持情况（DSH 的 `get_pet_overlay_supported`）。
 *
 * **诚实标注**：Windows 下 Electron 的透明窗口自 Windows 7 起可用，返回 true；
 * Linux 上 X11 可用，Wayland 下 Electron 的透明/定位支持受限（对应 DSH 的
 * XWayland 开关，本实现**不提供该开关**，只如实报告支持与否）。
 */
function overlaySupported(platform = process.platform, env = process.env) {
  if (platform === 'win32' || platform === 'darwin') return true
  if (platform === 'linux') {
    const wayland = String(env.XDG_SESSION_TYPE || '').toLowerCase() === 'wayland'
    // Wayland 下透明置顶不可靠：如实返回 false，让前端回落到「不显示浮层」。
    return !wayland
  }
  return false
}

module.exports = {
  PET_SIZE_DEFAULT,
  PET_SIZE_MIN,
  PET_SIZE_MAX,
  PET_SIZE_STEP,
  PET_SPRITE_COLUMNS,
  PET_SPRITE_ROWS,
  PET_BASE_PX,
  PET_SOURCES,
  normalizePetSize,
  petSizeOptions,
  petWindowPx,
  petRootDir,
  listPets,
  listAllPets,
  importPet,
  petStateFile,
  readPetState,
  writePetState,
  overlaySupported,
}
