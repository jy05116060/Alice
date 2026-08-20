// 桌宠会话增量 SSE 路由（只有一条）。
//
// 为什么只有一条：桌宠是**独立窗口**，它只关心「现在该显示什么」。所有折叠
// （状态优先级、工具分类、任务截断、去重、节流）都在 pet-stream.js 里做完了，
// 这里只负责把它编码成线上帧。
//
// 与 /events 的区别（刻意不合并）：/events 是给 brain-ui 的全局流，带 sticky 补发、
// 事件回放、brain_ui_events 落库；桌宠只要「最新一帧」。混在一起会让桌宠继承
// 一整套它不需要的语义，也会让「没人看就不干活」的收工条件变得难以成立。

import {
  SSE_KEEPALIVE_MS,
  createSseWriter,
  startPetStream,
  startKeepalive,
} from '../../runtime/pet-stream.js'

export const PET_SESSION_STREAM_PATH = '/api/desktop/dsh-tauri-pet/session/stream'

/** 桌宠窗口/Electron 侧作为同机消费端，只允许回环访问。 */
function isLoopback(req) {
  const address = String(req.socket?.remoteAddress || '')
  return address === '127.0.0.1'
    || address === '::1'
    || address === '::ffff:127.0.0.1'
}

export async function handlePetRoutes(req, res, url) {
  if (url.pathname !== PET_SESSION_STREAM_PATH) return false

  if (req.method !== 'GET') {
    res.writeHead(405, { Allow: 'GET' })
    res.end()
    return true
  }

  // 桌宠流只在同机有意义：跨机连上来等于把 agent 的推理过程广播出去。
  if (!isLoopback(req)) {
    res.writeHead(403, { 'Content-Type': 'application/json; charset=utf-8' })
    res.end(JSON.stringify({ ok: false, error: 'forbidden' }))
    return true
  }

  res.writeHead(200, {
    'Content-Type': 'text/event-stream; charset=utf-8',
    'Cache-Control': 'no-cache, no-transform',
    Connection: 'keep-alive',
    // 反向代理（若有）不得缓冲，否则桌宠会「卡住不动」。
    'X-Accel-Buffering': 'no',
  })
  // 首帧前先发一条心跳注释：客户端立刻知道连接是活的，不必等第一帧数据。
  res.write(`: ${'keepalive'}\n\n`)

  const writeFrame = createSseWriter(res)
  let closed = false

  const stopKeepalive = startKeepalive(res)
  const detach = startPetStream({
    push(frame) {
      try {
        writeFrameTo(writeFrame, frame)
      } catch {
        finish()
      }
    },
    close() {
      finish()
      try { res.end() } catch { /* 已断开 */ }
    },
  })

  function finish() {
    if (closed) return
    closed = true
    stopKeepalive()
    detach()
  }

  req.on('close', finish)
  res.on('close', finish)
  return true
}

/**
 * sink 给的是已经序列化好的帧串，这里拆回 `{action, payload}` 再按线上格式写出。
 * 这样 `retry: 1000` 的首帧标记由 writer 统一管理，不会因为复用帧串而漏发或重发。
 */
function writeFrameTo(writeFrame, frame) {
  let parsed
  try {
    parsed = JSON.parse(frame)
  } catch {
    return
  }
  writeFrame(parsed.action, parsed.payload)
}

export { SSE_KEEPALIVE_MS }
