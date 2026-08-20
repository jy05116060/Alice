const { contextBridge, ipcRenderer } = require('electron')

// 悬浮语音球窗口的桥:主进程下发 enter/state/exit 命令,窗口回报退场动画播完。
contextBridge.exposeInMainWorld('voiceOrb', {
  onCommand: (handler) => {
    if (typeof handler !== 'function') return
    ipcRenderer.on('orb:enter', () => handler('enter'))
    // 每帧:状态 + 真实音量(驱动球体跳动)
    ipcRenderer.on('orb:frame', (_e, payload) => handler('frame', payload))
    // 识别文字 / "思考中"
    ipcRenderer.on('orb:text', (_e, payload) => handler('text', payload))
    ipcRenderer.on('orb:exit', () => handler('exit'))
  },
  // 退场过渡结束 → 通知主进程真正隐藏窗口(动画播完才隐藏,见决策 C)
  exitDone: () => ipcRenderer.send('wake:orb-exit-done'),
})
