const { contextBridge, ipcRenderer } = require('electron')

contextBridge.exposeInMainWorld('focusBanner', {
  close:         () => ipcRenderer.send('focus-banner:close'),
  toggleTask:    (idx, done) => ipcRenderer.send('focus-banner:toggle-task', { idx, done }),
  setExpanded:   (expanded) => ipcRenderer.send('focus-banner:set-expanded', { expanded }),
  requestResize: () => ipcRenderer.send('focus-banner:request-resize'),
  onUpdate: (handler) => {
    ipcRenderer.on('focus-banner:update', (_e, data) => handler(data))
  },
  onConfig: (handler) => {
    ipcRenderer.on('focus-banner:config', (_e, cfg) => handler(cfg))
  },
})
