'use strict'

// 桌宠**窗口**的创建与 IPC 命令接线。
//
// 与 `createVoiceOrbWindow()`（悬浮语音球）刻意保持一致的模式：
// - 透明 / 无边框 / 置顶 / skipTaskbar / 不抢焦点；
// - **懒建**（第一次启用桌宠才建窗口），关闭走 hide 而不是 destroy，下次即时恢复；
// - `backgroundThrottling:false`，隐藏时也能立刻响应；
// - 独立的 preload 文件，渲染层只能拿到白名单 API。
//
// 与 voice-orb 的一处关键差异（有意为之）：voice-orb 是**主窗口渲染层驱动**的
// 纯视觉窗口（主进程转发每一帧）；桌宠**自己连后端 SSE**，主进程只负责窗口生命周期
// 与状态存取。这样「最后一个消费者断开 → 宿主停止订阅」的收工条件天然成立，
// 不需要主进程额外做引用计数。

const { BrowserWindow } = require('electron')
const path = require('path')
const {
  PET_BASE_PX,
  listAllPets,
  listPets,
  petWindowPx,
  importPet,
  overlaySupported,
  readPetState,
  writePetState,
} = require('./pet-state.cjs')

/**
 * 建一个桌宠控制器。
 *
 * @param opts.getUserDir - 返回 userData 目录（注入以便测试，不在本文件里 import paths）。
 * @param opts.loadPage - 加载渲染页的函数 `(win, relativePath) => void`；由 main.cjs 注入，
 *                        因为静态路由的拼法（backendUrl/backendPort）属于 main.cjs 的知识。
 * @param opts.page - 渲染页相对路径，默认 '/src/ui/brain-ui/pet.html'。
 */
function createPetController({ getUserDir, loadPage, page = '/src/ui/brain-ui/pet.html' } = {}) {
  /** 当前桌宠窗口；null = 尚未创建或已销毁。 */
  let petWindow = null
  /** 窗口就绪后要补发的状态（首建时页面还没加载完）。 */
  let pendingState = null

  function userDir() {
    return getUserDir()
  }

  function isAlive() {
    return Boolean(petWindow && !petWindow.isDestroyed())
  }

  /** 把状态推给渲染层（窗口不在了就静默丢弃）。 */
  function pushState(state) {
    if (!isAlive()) return
    const wc = petWindow.webContents
    if (wc.isDestroyed()) return
    if (wc.isLoading()) {
      // 页面还没好：记下来，did-finish-load 时补发，避免首帧丢失。
      pendingState = state
      return
    }
    try {
      wc.send('pet:state', state)
    } catch {
      // 发不出去就当没这个窗口；下一次启用会重建。
    }
  }

  /**
   * 创建桌宠窗口（幂等）。
   * 位置：屏幕**右下角**留边距——桌宠蹲在角落不挡内容，与语音球的「正上方居中」互补。
   */
  function createWindow() {
    if (isAlive()) return petWindow
    const { screen } = require('electron')
    const { workArea } = screen.getPrimaryDisplay()
    const state = readPetState(userDir())
    const px = petWindowPx(state.pet_size)
    const margin = 16
    const W = px
    const H = px
    petWindow = new BrowserWindow({
      width: W,
      height: H,
      x: workArea.x + workArea.width - W - margin,
      y: workArea.y + workArea.height - H - margin,
      show: false,
      frame: false,
      transparent: true,
      alwaysOnTop: true,
      skipTaskbar: true,
      resizable: false,
      movable: true, // 桌宠允许拖动（与语音球的纯视觉球不同：用户会想把它挪开）
      minimizable: false,
      maximizable: false,
      // 不抢焦点：桌宠是**旁观者**，绝不能打断用户正在输入的内容。
      focusable: false,
      hasShadow: false,
      webPreferences: {
        contextIsolation: true,
        nodeIntegration: false,
        preload: path.join(__dirname, 'pet-preload.cjs'),
        backgroundThrottling: false,
      },
    })
    // 置顶层级用 screen-saver 之上：普通 floating 会被部分全屏应用盖住。
    try {
      petWindow.setAlwaysOnTop(true, 'screen-saver')
    } catch {
      // 个别平台不支持层级参数，退回普通置顶。
      try { petWindow.setAlwaysOnTop(true) } catch { /* 尽力而为 */ }
    }
    // 置顶窗口默认不接收鼠标事件会让用户没法拖动；这里保持可交互但不抢焦点。
    try {
      petWindow.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true })
    } catch {
      // macOS 之外可能不支持，忽略。
    }

    petWindow.on('closed', () => { petWindow = null })

    petWindow.webContents.once('did-finish-load', () => {
      if (pendingState) {
        const state2 = pendingState
        pendingState = null
        pushState(state2)
      }
    })

    if (typeof loadPage === 'function') loadPage(petWindow, page)
    return petWindow
  }

  /** 显示/隐藏桌宠窗口（不销毁，下次即时恢复）。 */
  function applyEnabled(enabled) {
    if (!enabled) {
      if (isAlive()) petWindow.hide()
      return
    }
    createWindow()
    if (!isAlive()) return
    // showInactive：显示但不获焦，不打扰用户当前应用（与语音球同一手法）。
    try {
      petWindow.showInactive()
    } catch {
      petWindow.show()
    }
    pushState(readPetState(userDir()))
  }

  /** 应用尺寸：夹到 50–200 并按步长取整后设置窗口大小。 */
  function applySize(size) {
    const state = writePetState(userDir(), { ...readPetState(userDir()), pet_size: size })
    if (isAlive()) {
      const px = petWindowPx(state.pet_size)
      try { petWindow.setSize(px, px) } catch { /* 窗口可能刚被销毁 */ }
    }
    return state
  }

  return {
    /** `get_pet_status`：读状态（窗口不在也照常返回，状态是持久的偏好）。 */
    getStatus() {
      return readPetState(userDir())
    },
    /** `get_pet_overlay_supported`：平台能力判断。 */
    isOverlaySupported() {
      return overlaySupported()
    },
    /** `set_pet_enabled`：落盘 + 显示/隐藏窗口。 */
    setEnabled(enabled) {
      const next = writePetState(userDir(), { ...readPetState(userDir()), enabled: enabled === true })
      applyEnabled(next.enabled)
      return next
    },
    /** `set_active_pet`：落盘（渲染层据此切换精灵图）。 */
    setActivePet(id) {
      return writePetState(userDir(), { ...readPetState(userDir()), active_pet: String(id ?? '') })
    },
    /** `set_pet_size`：落盘 + 改窗口尺寸。 */
    setSize(size) {
      return applySize(size)
    },
    /** `list_pets`：列某个来源。 */
    list(source) {
      return listPets(userDir(), source)
    },
    /** `list_preset_pets`：列全部三路来源。 */
    listAll() {
      return listAllPets(userDir())
    },
    /** `import_pet`：落盘导入（zip 原样保存，不解压）。 */
    import(data) {
      return importPet(userDir(), data)
    },
    /** 供 main.cjs 在做窗口布局/退出时复用。 */
    getWindow() {
      return isAlive() ? petWindow : null
    },
    /** 应用退出/重载时清理。 */
    dispose() {
      if (isAlive()) {
        try { petWindow.destroy() } catch { /* 已销毁 */ }
      }
      petWindow = null
      pendingState = null
    },
    /** 内部：暴露给 IPC 的完整命令表，便于 main.cjs 一次性接线。 */
    commands: {
      'pet:get-status': () => readPetState(userDir()),
      'pet:get-overlay-supported': () => overlaySupported(),
      'pet:set-enabled': (payload) => {
        const next = writePetState(userDir(), { ...readPetState(userDir()), enabled: payload?.enabled === true })
        applyEnabled(next.enabled)
        return next
      },
      'pet:set-active-pet': (payload) => writePetState(userDir(), {
        ...readPetState(userDir()),
        active_pet: String(payload?.id ?? ''),
      }),
      'pet:set-size': (payload) => applySize(payload?.size),
      'pet:list-pets': (payload) => listPets(userDir(), payload?.source),
      'pet:list-preset-pets': () => listAllPets(userDir()),
      'pet:import-pet': (payload) => importPet(userDir(), payload || {}),
    },
  }
}

module.exports = { createPetController, PET_BASE_PX }
