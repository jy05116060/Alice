const { contextBridge, ipcRenderer, webFrame } = require('electron')

contextBridge.exposeInMainWorld('alice', {
  platform: process.platform,
  isElectron: true,
  getVersion: () => ipcRenderer.invoke('app:get-version'),
  readClipboardText: () => ipcRenderer.invoke('clipboard:read-text'),
  writeClipboardText: (text) => ipcRenderer.invoke('clipboard:write-text', text),
  setUiLanguage: (locale) => ipcRenderer.invoke('ui:set-language', locale),
  checkForUpdates: () => ipcRenderer.invoke('updater:check-for-updates'),
  startDownload: () => ipcRenderer.invoke('updater:start-download'),
  quitAndInstall: () => ipcRenderer.invoke('updater:quit-and-install'),
  getLatestSystemScreenshot: (options) => ipcRenderer.invoke('system-screenshot:get-latest', options || {}),
  getStartupProgress: () => ipcRenderer.invoke('startup:get-progress'),
  onStartupProgress: (handler) => {
    if (typeof handler !== 'function') return () => {}
    const listener = (_event, payload) => handler(payload)
    ipcRenderer.on('startup:progress', listener)
    return () => ipcRenderer.removeListener('startup:progress', listener)
  },
  getZoomFactor: () => webFrame.getZoomFactor(),
  setZoomFactor: (factor) => webFrame.setZoomFactor(factor),
  isFullScreen: () => ipcRenderer.invoke('window:is-full-screen'),
  onFullScreenChange: (handler) => {
    if (typeof handler !== 'function') return () => {}
    const listener = (_event, fullscreen) => handler(Boolean(fullscreen))
    ipcRenderer.on('window:fullscreen-changed', listener)
    return () => ipcRenderer.removeListener('window:fullscreen-changed', listener)
  },
  setTitleBarTheme: (theme) => ipcRenderer.invoke('window:set-title-bar-theme', theme),
  browserEmbed: {
    update: (options) => ipcRenderer.invoke('browser-embed:update', options),
    hide: () => ipcRenderer.invoke('browser-embed:hide'),
    getState: () => ipcRenderer.invoke('browser-embed:get-state'),
  },
  // 右键菜单的「在浏览器打开 / 在文件管理器打开」：主进程侧只认可信窗口
  // （见 electron/trusted-window-senders.cjs），非主窗口调用会直接 reject。
  // 返回值与 HTTP 端点同形：{ok:true} 或 {ok:false, error:'invalid-url'|'invalid-path'|
  // 'open-url-failed'|'open-path-failed'|'desktop-open-unavailable'}。
  desktopOpen: {
    openUrl: (url) => ipcRenderer.invoke('desktop:open-url', url),
    openPath: (targetPath) => ipcRenderer.invoke('desktop:open-path', targetPath),
  },
  onUpdaterStatus: (handler) => {
    if (typeof handler !== 'function') return () => {}
    const listener = (_event, payload) => handler(payload)
    ipcRenderer.on('updater:status', listener)
    return () => ipcRenderer.removeListener('updater:status', listener)
  },
  // 语音唤醒:命中「小白龙」由主进程经 wake:hit 通知本渲染层(唤醒会话编排见 voice-wake.js);
  // 悬浮球窗口由本渲染层经下列命令驱动(主进程转发给球窗)。
  wake: {
    onHit: (handler) => {
      if (typeof handler !== 'function') return () => {}
      const listener = () => handler()
      ipcRenderer.on('wake:hit', listener)
      return () => ipcRenderer.removeListener('wake:hit', listener)
    },
    orbEnter: () => ipcRenderer.send('wake:orb-enter'),
    orbFrame: (payload) => ipcRenderer.send('wake:orb-frame', payload),
    orbText: (payload) => ipcRenderer.send('wake:orb-text', payload),
    orbExit: () => ipcRenderer.send('wake:orb-exit'),
  },
  // 桌宠（推理流可视化）：DSH 的 9 个 Tauri invoke 命令在这里的等价物。
  // 注意桌宠**窗口自己连 SSE** 读推理流，不经过这里；本组 API 只管窗口/宠物管理。
  // Wayland 的两个命令（get/set_force_xwayland）在 Windows 下不适用，未提供。
  pet: {
    getStatus: () => ipcRenderer.invoke('pet:get-status'),
    isOverlaySupported: () => ipcRenderer.invoke('pet:get-overlay-supported'),
    setEnabled: (enabled) => ipcRenderer.invoke('pet:set-enabled', { enabled: enabled === true }),
    setActivePet: (id) => ipcRenderer.invoke('pet:set-active-pet', { id }),
    setSize: (size) => ipcRenderer.invoke('pet:set-size', { size }),
    listPets: (source) => ipcRenderer.invoke('pet:list-pets', { source }),
    listPresetPets: () => ipcRenderer.invoke('pet:list-preset-pets'),
    importPet: (name, data) => ipcRenderer.invoke('pet:import-pet', { name, data }),
  },
})
