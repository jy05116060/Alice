// wake-probe-preload.cjs —— "耳朵"窗口的桥
// 只暴露一个把 16kHz Float32 PCM 送往主进程的通道,以及上报状态。
const { contextBridge, ipcRenderer } = require('electron')

contextBridge.exposeInMainWorld('wakeProbe', {
  // ArrayBuffer(Float32 底层 buffer)→ 主进程
  sendPcm: (buffer) => ipcRenderer.send('wake:pcm', buffer),
  // 上报耳朵状态(running / mic-denied / error),便于主进程日志排查
  reportStatus: (status, detail) => ipcRenderer.send('wake:status', { status, detail }),
})
