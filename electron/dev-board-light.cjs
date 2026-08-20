// dev-board-light.cjs —— 控制 ESP32-S3 WiFi 灯板(局域网 HTTP)
//
// 唤醒命中"小白龙"时:在 ~0.6 秒内闪三次,结束灭掉。
// 控制契约见安装版沙箱 esp32_light_control.md:
//   POST http://<板>:8765/api/color  {"color":"#RRGGBB"}
// 实际设备走 WiFi(不是 localhost 串口桥),IP 同用户现有脚本 flash-blue.ps1。
// 灯离线/超时一律静默忽略,绝不拖累唤醒。
const http = require('http')

const HOST = '192.168.1.12' // 与 led-control.html / flash-blue.ps1 一致;换设备改这里
const PORT = 8765
const FLASH_COLOR = '#ffffff'
const OFF_COLOR = '#000000'
const BLINKS = 3
const ON_MS = 100   // 单次亮持续
const OFF_MS = 100  // 两次之间灭的间隔(最后一次后不再等待,直接停在灭)

function setColor(hex) {
  return new Promise((resolve) => {
    const data = JSON.stringify({ color: hex })
    const r = http.request({
      host: HOST, port: PORT, path: '/api/color', method: 'POST', timeout: 1500,
      headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(data) },
    }, (res) => { res.resume(); res.on('end', resolve) })
    r.on('error', () => resolve())
    r.on('timeout', () => { try { r.destroy() } catch {}; resolve() })
    r.write(data)
    r.end()
  })
}

const sleep = (ms) => new Promise(r => setTimeout(r, ms))

let busy = false
// 0.6s 内闪三次,结束灭掉。重入保护:一次闪烁未完不叠加下一次。
async function blink() {
  if (busy) return
  busy = true
  try {
    for (let i = 0; i < BLINKS; i++) {
      await setColor(FLASH_COLOR)
      await sleep(ON_MS)
      await setColor(OFF_COLOR)
      if (i < BLINKS - 1) await sleep(OFF_MS)
    }
  } catch {} finally { busy = false }
}

module.exports = { blink }
