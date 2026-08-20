// 桌宠窗口的渲染逻辑：消费 SSE 增量帧，把展示态画到 DOM 上。
//
// **诚实边界（必须照做）**：本文件无法在本环境验证渲染效果——没有浏览器。
// 能验证的只有「标记存在 + 事件绑定存在」；**不能声称宠物能正常显示、动画正确**。
//
// 数据链路：本窗口**自己连** `/api/desktop/dsh-tauri-pet/session/stream`，
// 不经主进程转发。所以窗口关闭 → EventSource 断开 → 宿主侧 sink 归零 →
// 自动注销订阅并清空状态（性能契约在服务端那条链上）。
//
// 精灵图：机制完整，但**没有内置资产**。DSH 的 skills/ 目录在实际安装的
// node_modules 里不存在，拿不到可复制的美术资源。存在 sprite 图时才启用，
// 否则回落到 pet.html 里的纯 CSS 示意球。**绝不伪造图像数据。**

/** SSE 端点（与 src/api/routes/pet.js 的常量逐字一致）。 */
const PET_SESSION_STREAM_PATH = '/api/desktop/dsh-tauri-pet/session/stream'

const root = document.getElementById('pet-root')
const bubble = document.getElementById('pet-bubble')
const taskLine = document.getElementById('pet-task')
const spriteEl = document.getElementById('pet-sprite')

/** 最近一次收到的展示态（重连后用于立即回填，避免闪空）。 */
let lastPayload = null

/** 推理/工具气泡的文案：工具优先于推理（与服务端 liveActivity 二选一逻辑对称）。 */
function bubbleTextOf(payload) {
  const live = payload?.liveActivity
  if (!live) return null
  if (live.kind === 'tool') {
    const name = live.name || '工具'
    const args = typeof live.args === 'string' && live.args ? ` ${live.args}` : ''
    return { kind: 'tool', text: `${name}${args}`, raw: true }
  }
  if (live.kind === 'reasoning') return { kind: 'reasoning', text: live.text || '', raw: true }
  return null
}

/** 把一帧展示态画到 DOM。纯展示，不做任何状态推导（推导全在服务端）。 */
function render(payload) {
  lastPayload = payload

  // 状态：error / waiting / running / undefined（空闲）
  root.dataset.status = payload?.status || ''

  // 气泡
  const bubbleInfo = bubbleTextOf(payload)
  if (bubbleInfo && bubbleInfo.text) {
    bubble.textContent = bubbleInfo.text
    bubble.dataset.kind = bubbleInfo.kind
    bubble.dataset.visible = 'on'
  } else {
    bubble.dataset.visible = 'off'
    bubble.dataset.kind = ''
    bubble.textContent = ''
  }

  // 任务行：服务端已按码点截 40 并加省略号，这里原样展示不再二次截断
  if (payload?.task) {
    taskLine.textContent = payload.task
    taskLine.dataset.visible = 'on'
  } else {
    taskLine.dataset.visible = 'off'
    taskLine.textContent = ''
  }
}

/** 应用精灵图（有资产才启用；没有就保持 CSS 示意球）。 */
function applySprite(spriteUrl) {
  if (!spriteUrl) {
    root.dataset.sprite = 'off'
    return
  }
  spriteEl.style.backgroundImage = `url("${spriteUrl}")`
  root.dataset.sprite = 'on'
}

// ── SSE 消费 ────────────────────────────────────────────────────────────────
// 用 EventSource 而不是 fetch：它自带断线重连，且服务端首帧给的 `retry: 1000`
// 就是给它的重连间隔（与 DSH 的 Rust 消费端同语义）。

let source = null
let retryTimer = null

function connect() {
  try {
    source = new EventSource(PET_SESSION_STREAM_PATH)
  } catch {
    scheduleReconnect()
    return
  }
  root.dataset.connection = 'connecting'

  source.onopen = () => {
    root.dataset.connection = 'open'
    // 重连后立即回填最后一帧，避免气泡闪空
    if (lastPayload) render(lastPayload)
  }

  source.onmessage = (event) => {
    root.dataset.connection = 'open'
    let frame
    try {
      frame = JSON.parse(event.data)
    } catch {
      return // 坏帧忽略，不影响后续
    }
    // 帧形状：{action, payload}；create/update/remove 三种。
    if (frame?.action === 'remove') {
      render(null)
      return
    }
    if (frame?.payload) render(frame.payload)
  }

  source.onerror = () => {
    root.dataset.connection = 'error'
    // EventSource 自带重连；只有它彻底关闭时才手动重建，
    // 避免两套重连叠加导致重复连接。
    if (source && source.readyState === EventSource.CLOSED) {
      source.close()
      source = null
      scheduleReconnect()
    }
  }
}

function scheduleReconnect() {
  if (retryTimer) return
  retryTimer = setTimeout(() => {
    retryTimer = null
    connect()
  }, 1000)
}

// 页面卸载时显式断开：这是「关窗 → 断流 → 宿主收工」链条的**触发点**。
window.addEventListener('beforeunload', () => {
  if (retryTimer) { clearTimeout(retryTimer); retryTimer = null }
  if (source) { source.close(); source = null }
})

// ── 与主进程的窗口/宠物管理（IPC，对应 DSH 的 9 个 invoke 命令）──────────────
// preload 暴露 window.alicePet；本窗口是独立 BrowserWindow，用的是 pet-preload.cjs。
const petApi = window.alicePet

if (petApi) {
  // 主进程改了尺寸/启用状态时刷新
  petApi.onState?.((state) => {
    if (state && typeof state.pet_size === 'number') {
      document.documentElement.dataset.petSize = String(state.pet_size)
    }
  })

  // 精灵图：只有扫描到真实资产才启用（当前仓库没有内置资产，故通常走 CSS 示意球）
  //
  // ⚠️ 两处曾经都是错的，都让"有资产"的宠物显示空白：
  //
  // 1) **文件名**：`hasSprite` 的判据是 `sprite.png || spritesheet.png`
  //    （见 electron/pet-state.cjs 的 listPets），但这里**只拼 sprite.png**。
  //    于是一个只有 `spritesheet.png` 的宠物 `hasSprite=true`，
  //    渲染层却去加载不存在的 `sprite.png` → 404 → 空白。
  //    （精灵图本来就是**图集**，spritesheet.png 才是更常见的形态。）
  //
  // 2) **路径**：这个窗口是 `win.loadURL(backendUrl(...))` 加载的，协议是 **HTTP**；
  //    `/pets/...` 是根相对路径，会被请求到后端。后端原先**没有这条路由** ——
  //    实测返回 404。现已在 src/api/routes/static.js 补上 `/pets/` 静态路由
  //    （根目录 `<userDir>/pets`，走带路径穿越校验的 serveAsset）。
  //
  // 服务端把两个文件名都报出来了，所以就按它报的选，不再猜。
  petApi.listPresetPets?.().then((all) => {
    const pets = all?.preset || []
    const active = pets.find(pet => pet.hasSprite)
    if (!active) { applySprite(null); return }
    const file = active.spriteFile === 'spritesheet.png' ? 'spritesheet.png' : 'sprite.png'
    applySprite(`/pets/${encodeURIComponent(active.source || 'preset')}/${encodeURIComponent(active.name)}/${file}`)
  }).catch(() => { applySprite(null) })
}

// 暴露给测试/诊断的钩子（无副作用：不改变渲染，只报告当前标记）
window.__petRendererProbe = {
  hasRoot: () => Boolean(root),
  currentStatus: () => root.dataset.status,
  currentConnection: () => root.dataset.connection,
  streamPath: PET_SESSION_STREAM_PATH,
}

connect()
