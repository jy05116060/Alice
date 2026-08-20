import { jsonResponse, readRawBody, decodeRequestBody } from '../utils.js'

// 「打开外链 / 打开目录」宿主端点（移植 DSH dsh-tauri-rightclick 的服务端两件事；行为复刻，不抄代码）。
//
//   POST /api/desktop/dsh-tauri-rightclick/open/url   —— 默认浏览器打开 http/https 外链
//   POST /api/desktop/dsh-tauri-rightclick/open/path  —— 文件管理器打开本地目录
//
// 为什么这两件事值得单独开端点、还要一道 Content-Type 闸：
// 它们是**把用户/外部输入交给操作系统去执行**的原语。URL 少了协议收敛，
// `file:` / `javascript:` / 自定义 scheme 就能越过浏览器打开别的程序；路径少了
// scheme 判据，`https://...` 会被当成相对目录名塞给文件管理器。所以两道校验都在这里，
// 不散到各个调用方。
//
// 打开动作走**串行队列**：开链与开目录都会拉起系统进程，一次交互里并发拉起多个
// OS 打开操作既无意义又容易触发文件管理器的竞态，故统一排队。
//
// 与 DSH 的差异（Electron 不是 Tauri，本次实现如实标注）：
//   - DSH 的 `openUrl` 直接 spawn `rundll32.exe url.dll,FileProtocolHandler` /
//     `open` / `xdg-open`；这里用 Electron `shell.openExternal`，由 Electron 处理
//     协议注册与失败上报。
//   - DSH 的 `openDirectory` 先 `statSync` 判目录再 spawn explorer/open/xdg-open，
//     失败即抛错；Electron `shell.openPath` **对不存在的路径返回错误字符串而不是抛异常**，
//     所以这里判的是返回值非空（见 performOpenPath）。

const ROUTE_PREFIX = '/api/desktop/dsh-tauri-rightclick'

// 只接受 JSON 的 POST。读体函数本身**不看 Content-Type**，缺了这道闸 text/plain 也能进来。
const JSON_CONTENT_TYPE = /^application\/json(?:\s*;|$)/i

// 带 URL scheme 的值不是本地路径：外链走 open/url，别在这里当作目录名打开。
const URL_SCHEME_PATTERN = /^[a-z][a-z\d+.-]*:\/\//i

const MAX_BODY_BYTES = 64 * 1024

/**
 * 只放行 http/https。file: / javascript: / 自定义 scheme 一律拒绝。
 * 校验失败返回 null（不抛错），调用方据此回 400——绝不静默放行。
 * @returns {string|null} 归一化后的 href
 */
export function safeWebUrl(value) {
  if (typeof value !== 'string') return null
  try {
    const url = new URL(value)
    return url.protocol === 'http:' || url.protocol === 'https:' ? url.href : null
  } catch {
    return null
  }
}

// ── 串行队列 ────────────────────────────────────────────────────────────────
// 尾指针接在上一次**落定**之后（成功失败都继续）。关键语义：
// **前一次失败不阻塞后一次**——`tail.then(op, op)` 在成功与失败两条路径上都会执行 op，
// 且 tail 永远被替换成不 reject 的指针。少了这层，一次打开失败会把队列永久卡死。
let tail = Promise.resolve()

function enqueueDesktopMutation(operation) {
  const result = tail.then(operation, operation)
  tail = result.then(() => undefined, () => undefined)
  return result
}

// 队列原语导出给测试用。**为什么必须导出**：路由把宿主的失败全部吞成 resolved 的
// `{ok:false}`（见 performOpenPath/performOpenUrl），所以走 HTTP 那一层永远产生不了
// rejection —— 端到端测试只能证明「结果层面前一次失败不阻塞后一次」，证明不了上面
// `tail.then(op, op)` 的失败分支与 tail 消毒器。把「一次拒绝之后队列仍能继续」直接
// 断在队列这一层，那条断言才是可证伪的（改成 `tail.then(op)` + `tail = result` 会立刻变红）。
export { enqueueDesktopMutation as __enqueueDesktopMutationForTest }

/** 仅在测试里用：把队列尾指针复位，避免用例之间互相拖住。 */
export function resetDesktopOpenQueue() {
  tail = Promise.resolve()
}

// ── 宿主能力（Electron 主进程注入）──────────────────────────────────────────
// 后端 ESM 跑在 Electron 主进程里，但 import 不到 electron 内建模块，
// 所以由 main.cjs 把 shell 的两个方法挂到 globalThis（与 aliceSystemPreferences 同一套路）。
// 挂不上（纯 node 环境 / 主进程没启动到位）时**如实报失败**，绝不假装打开成功。
function resolveDesktopOpenHost() {
  const host = globalThis.aliceDesktopOpen
  if (!host) return null
  if (typeof host.openExternal !== 'function' || typeof host.openPath !== 'function') return null
  return host
}

async function performOpenUrl(url) {
  const host = resolveDesktopOpenHost()
  if (!host) return { ok: false, error: 'open-url-failed' }
  try {
    await host.openExternal(url)
    return { ok: true }
  } catch (error) {
    console.warn(`[desktop-open] failed to open URL ${url}:`, error?.message || error)
    return { ok: false, error: 'open-url-failed' }
  }
}

async function performOpenPath(target) {
  const host = resolveDesktopOpenHost()
  // 「宿主没挂上」和「这个路径不是目录」是**两回事**，不能回同一个错误码。
  // 之前这里返回 `not-a-directory`，后果是我自己验证时就踩了：拿 `D:\白龙马`
  // 这个**真实存在的目录**去打，收到 not-a-directory，第一反应是「路径校验写错了」——
  // 实际是当时进程里没有 Electron 宿主。错误码把「环境没能力」谎报成「你的路径不对」，
  // 排查方向被带偏。这与上面 performOpenUrl 返回 open-url-failed 也不一致。
  if (!host) return { ok: false, error: 'desktop-open-unavailable' }
  try {
    const failure = await host.openPath(target)
    // 这一行是整个模块最容易写错的地方：Electron 的 shell.openPath 对不存在的路径
    // **返回一段错误字符串**（resolve，不 reject）。只写 try/catch 会把「打不开」
    // 当成「打开了」，于是 UI 报成功而什么都没发生。
    if (typeof failure === 'string' && failure.length > 0) {
      console.warn(`[desktop-open] failed to open directory ${target}: ${failure}`)
      // Electron 给的是人话（如 "Path does not exist" / "No application is associated…"），
      // 原因不止「不是目录」一种，所以用中性的 open-path-failed，别替它下结论。
      // 原始原因随 body 一起回给调用方，便于如实显示。
      return { ok: false, error: 'open-path-failed', reason: failure }
    }
    return { ok: true }
  } catch (error) {
    console.warn(`[desktop-open] failed to open directory ${target}:`, error?.message || error)
    return { ok: false, error: 'open-path-failed', reason: error?.message || String(error) }
  }
}

/** @returns {{ok: true, body: object}|{ok: false}} —— 读不到合法 JSON 对象时 ok:false */
async function readJsonObjectBody(req) {
  let raw
  try {
    raw = await readRawBody(req, { maxBytes: MAX_BODY_BYTES })
  } catch {
    return { ok: false }
  }
  if (!raw || raw.length === 0) return { ok: true, body: {} }
  let text
  try {
    text = decodeRequestBody(raw, req.headers?.['content-type'])
  } catch {
    text = raw.toString('utf8')
  }
  let parsed
  try {
    parsed = JSON.parse(text)
  } catch {
    return { ok: false }
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return { ok: false }
  return { ok: true, body: parsed }
}

export async function handleDesktopOpenRoutes(req, res, url) {
  if (req.method !== 'POST') return false
  const isOpenUrl = url.pathname === `${ROUTE_PREFIX}/open/url`
  const isOpenPath = url.pathname === `${ROUTE_PREFIX}/open/path`
  if (!isOpenUrl && !isOpenPath) return false

  const invalidError = isOpenUrl ? 'invalid-url' : 'invalid-path'

  const contentType = String(req.headers?.['content-type'] ?? '')
  if (!JSON_CONTENT_TYPE.test(contentType)) {
    jsonResponse(res, 415, { ok: false, error: 'unsupported-media-type' })
    return true
  }

  const parsed = await readJsonObjectBody(req)
  if (!parsed.ok) {
    // 体不是合法 JSON 对象：与「字段不合法」同归 400。DSH 那边由 h3 的 readBody 抛 400，
    // 错误信封形状不同（h3 的 statusCode/statusMessage），错误码这一层是一致的。
    jsonResponse(res, 400, { ok: false, error: invalidError })
    return true
  }

  if (isOpenUrl) {
    const target = safeWebUrl(parsed.body.url)
    if (!target) {
      jsonResponse(res, 400, { ok: false, error: 'invalid-url' })
      return true
    }
    const result = await enqueueDesktopMutation(() => performOpenUrl(target))
    jsonResponse(res, result.ok ? 200 : 500, result)
    return true
  }

  const rawPath = parsed.body.path
  const target = typeof rawPath === 'string' ? rawPath.trim() : ''
  if (target.length === 0 || URL_SCHEME_PATTERN.test(target)) {
    jsonResponse(res, 400, { ok: false, error: 'invalid-path' })
    return true
  }
  const result = await enqueueDesktopMutation(() => performOpenPath(target))
  jsonResponse(res, result.ok ? 200 : 400, result)
  return true
}
