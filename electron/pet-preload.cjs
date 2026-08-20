'use strict'

// 桌宠窗口的桥（对照 `voice-orb-preload.cjs` 的写法：contextBridge + 白名单）。
//
// 桌宠窗口需要两类能力：
// 1. **读推理流** —— 但它**不走 IPC**，自己直连后端 SSE
//    （`/api/desktop/dsh-tauri-pet/session/stream`）。这样「窗口一关 → SSE 断开 →
//    宿主停止订阅」的收工条件天然成立，主进程不必代转每一帧。
// 2. **窗口/宠物管理** —— 走 IPC（对应 DSH 的 9 个 invoke 命令）。
//
// 因此这里只暴露管理类 API，不暴露任何事件转发通道。

const { contextBridge, ipcRenderer } = require('electron')

/** DSH 的 9 个 Tauri 命令 → 本 preload 的 8 个方法（Wayland 两个在 Windows 下不适用）。 */
contextBridge.exposeInMainWorld('alicePet', {
  /** `get_pet_status` → `{enabled, active_pet, pet_size}` */
  getStatus: () => ipcRenderer.invoke('pet:get-status'),
  /** `get_pet_overlay_supported` → boolean */
  isOverlaySupported: () => ipcRenderer.invoke('pet:get-overlay-supported'),
  /** `set_pet_enabled` → 新状态 */
  setEnabled: (enabled) => ipcRenderer.invoke('pet:set-enabled', { enabled: enabled === true }),
  /** `set_active_pet` → 新状态 */
  setActivePet: (id) => ipcRenderer.invoke('pet:set-active-pet', { id }),
  /** `set_pet_size`（50–200，step 5）→ 新状态 */
  setSize: (size) => ipcRenderer.invoke('pet:set-size', { size }),
  /** `list_pets`（单来源）→ 数组 */
  listPets: (source) => ipcRenderer.invoke('pet:list-pets', { source }),
  /** `list_preset_pets` → 三路来源 */
  listPresetPets: () => ipcRenderer.invoke('pet:list-preset-pets'),
  /** `import_pet`：base64 dataURL → 落盘（zip 原样保存，不解压） */
  importPet: (name, data) => ipcRenderer.invoke('pet:import-pet', { name, data }),
  /** 状态变化广播（主进程 setEnabled/setSize 后推给本窗口）。 */
  onState: (handler) => {
    if (typeof handler !== 'function') return () => {}
    const listener = (_event, payload) => handler(payload)
    ipcRenderer.on('pet:state', listener)
    return () => ipcRenderer.removeListener('pet:state', listener)
  },
  /** 渲染层需要知道的规格常量（精灵图 8 列 × 11 行等）。 */
  sprite: Object.freeze({ columns: 8, rows: 11 }),
})
