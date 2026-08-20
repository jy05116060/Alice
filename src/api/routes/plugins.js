import fs from 'node:fs'
import { jsonResponse, readRawBody, decodeRequestBody } from '../utils.js'
import {
  getPluginHost,
  startPluginHost,
  PluginHostError,
  PLUGIN_HOST_ERROR,
  PLUGIN_STATUS,
  PLUGIN_UI_ERROR,
} from '../../runtime/plugin-host.js'

// 插件宿主的数据接口（阶段 6.7）。
//   GET  /plugins         —— 列表 + 每个插件的状态/错误/版本/最近日志 + 宿主自身的监视状态
//   POST /plugins/reload  —— 手动重载一个插件 { id }
//   POST /plugins/toggle  —— 启用/停用 { id, enabled }
//   GET  /plugins/ui                     —— 各插件声明的 UI（命令 + 面板）汇总 + 逐条错误
//   GET  /plugins/ui/:pluginId/:panelId  —— 一个面板的 HTML 文件本体
//
// 三条刻意的规矩：
//
// 1. **不给「看起来成功」的响应**。重载/启停的契约是「这次调用返回 ok 之后，这个插件
//    应该是 loaded」。如果宿主尽力了但插件仍落在 error，接口回 **500 + 插件自己的错误码**
//    （`ACTIVATE_FAILED` / `BAD_MANIFEST` / `ENTRY_NOT_FOUND` / `LOAD_FAILED` /
//    `INVALID_EXPORT`）。用 code 区分「宿主坏了」和「插件代码坏了」——混成一句
//    「重载成功」会让排查方向完全错。
// 2. **接口不接受路径**。`dir` 只能来自宿主的配置（`<ALICE_USER_DIR>/plugins` 或
//    ALICE_PLUGINS_DIR），请求体里给什么路径都不认。一旦接受路径，这个接口就成了
//    「让宿主 import 机器上任意 JS 文件」的原语，那比插件本身危险得多。
//    **面板端点同样遵守这一条**：URL 里只有 pluginId / panelId 两个**标识**，
//    磁盘路径一律由宿主从自己的记录里取；拿到之后再走越界判定（见 findPanelFile）。
// 3. **绝不碰插件之外的东西**：reload/toggle 只接受宿主已经发现的 id。
//
// ⚠️ 关于面板 HTML（不要把它当成安全的东西）
// ---------------------------------------------------------------------------
// `GET /plugins/ui/:pluginId/:panelId` 把**插件目录里的一个 HTML 文件**以
// `text/html; charset=utf-8` 交给浏览器，界面用 iframe 在**应用同源**下加载它。
// 那个 iframe 因此能做同源 iframe 能做的一切（读同源 DOM、带用户身份发请求）——
// 这**不是沙箱，只是结构隔离**。真正的边界与插件本身是同一条（见 plugin-host.js 文件头）：
// 插件是完全受信的进程内代码，不要把别人的插件放进插件目录。
export async function handlePluginRoutes(req, res, url) {
  const pathname = url.pathname
  const panelMatch = PLUGIN_PANEL_PATH.exec(pathname)
  const knownPath = pathname === '/plugins'
    || pathname === '/plugins/reload'
    || pathname === '/plugins/toggle'
    || pathname === '/plugins/ui'
    || panelMatch !== null
  if (!knownPath) return false

  if (req.method === 'GET' && pathname === '/plugins') {
    const host = await ensureHost(res)
    if (!host) return true
    try {
      jsonResponse(res, 200, { ok: true, ...host.snapshot() })
    } catch (error) {
      jsonResponse(res, 500, {
        ok: false,
        code: 'PLUGIN_LIST_FAILED',
        error: error?.message || String(error),
      })
    }
    return true
  }

  // 各插件声明的 UI 汇总。**校验失败/文件缺失如实进 errors**（带 plugin_id），
  // 让界面能告诉用户「某个插件的面板入口不存在」——静默丢掉就是让用户自己猜。
  if (req.method === 'GET' && pathname === '/plugins/ui') {
    const host = await ensureHost(res)
    if (!host) return true
    try {
      const { commands, panels, errors } = host.collectUi()
      jsonResponse(res, 200, { ok: true, commands, panels, errors })
    } catch (error) {
      jsonResponse(res, 500, {
        ok: false,
        code: 'PLUGIN_UI_LIST_FAILED',
        error: error?.message || String(error),
      })
    }
    return true
  }

  // 一个面板的 HTML 本体。越界 / 不存在一律**如实拒绝**，绝不回半截内容。
  if (req.method === 'GET' && panelMatch) {
    const pluginId = decodeSegment(panelMatch[1])
    const panelId = decodeSegment(panelMatch[2])
    if (!PLUGIN_UI_ID_PATTERN.test(pluginId) || !PLUGIN_UI_ID_PATTERN.test(panelId)) {
      jsonResponse(res, 400, {
        ok: false,
        code: PLUGIN_UI_ERROR.PANEL_ID_INVALID,
        error: 'pluginId and panelId may only contain letters, digits, dot, underscore and dash',
      })
      return true
    }
    const host = await ensureHost(res)
    if (!host) return true
    const found = host.findPanelFile(pluginId, panelId)
    if (!found.ok) {
      jsonResponse(res, found.status, { ok: false, code: found.code, error: found.error })
      return true
    }
    let html
    try {
      html = fs.readFileSync(found.path)
    } catch (error) {
      jsonResponse(res, 404, {
        ok: false,
        code: PLUGIN_UI_ERROR.PANEL_ENTRY_NOT_FOUND,
        error: `panel file could not be read: ${error?.message || error}`,
      })
      return true
    }
    // 按**字节**回：面板 HTML 里可能有中文/emoji，再经一次字符串编解码只会多一次出错的机会。
    res.writeHead(200, {
      'Content-Type': 'text/html; charset=utf-8',
      'Content-Length': html.length,
      'Cache-Control': 'no-cache',
    })
    res.end(html)
    return true
  }

  if (req.method === 'POST' && pathname === '/plugins/reload') {
    const { body, error } = await readJsonBody(req)
    if (error) {
      jsonResponse(res, 400, { ok: false, code: 'BAD_BODY', error })
      return true
    }
    const id = typeof body.id === 'string' ? body.id.trim() : ''
    if (!id) {
      jsonResponse(res, 400, { ok: false, code: 'PLUGIN_ID_REQUIRED', error: 'id is required' })
      return true
    }
    const host = await ensureHost(res)
    if (!host) return true
    await respondAfterOperation(res, host, () => host.reload(id), 'PLUGIN_RELOAD_FAILED')
    return true
  }

  if (req.method === 'POST' && pathname === '/plugins/toggle') {
    const { body, error } = await readJsonBody(req)
    if (error) {
      jsonResponse(res, 400, { ok: false, code: 'BAD_BODY', error })
      return true
    }
    const id = typeof body.id === 'string' ? body.id.trim() : ''
    if (!id) {
      jsonResponse(res, 400, { ok: false, code: 'PLUGIN_ID_REQUIRED', error: 'id is required' })
      return true
    }
    if (typeof body.enabled !== 'boolean') {
      jsonResponse(res, 400, { ok: false, code: 'PLUGIN_ENABLED_REQUIRED', error: 'enabled must be a boolean' })
      return true
    }
    const host = await ensureHost(res)
    if (!host) return true
    await respondAfterOperation(res, host, () => host.setEnabled(id, body.enabled), 'PLUGIN_TOGGLE_FAILED')
    return true
  }

  // 路径认识、方法不对：明确说出来，别落进框架的 404 让人以为端点不存在
  jsonResponse(res, 405, {
    ok: false,
    code: 'METHOD_NOT_ALLOWED',
    error: `${req.method} is not supported on ${pathname}`,
  })
  return true
}

/** 面板端点：`/plugins/ui/<pluginId>/<panelId>`。两个段都是**标识符**，不是路径。 */
const PLUGIN_PANEL_PATH = /^\/plugins\/ui\/([^/]+)\/([^/]+)$/
/** 标识符字符集与插件 id 一致：不含 `/`、`\`、`..`，也不含空白。 */
const PLUGIN_UI_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]*$/

/**
 * 解一个 URL 段。解不开（畸形百分号编码）就当空串——空串过不了 id 的字符集检查，
 * 于是走 400，而不是让 decodeURIComponent 抛出去变成 500。
 */
function decodeSegment(segment) {
  try {
    return decodeURIComponent(segment)
  } catch {
    return ''
  }
}

/** 取宿主；没起来就先起（幂等）。起不来也是**如实说**，不是假装没有插件。 */
async function ensureHost(res) {
  const existing = getPluginHost()
  if (existing) return existing
  try {
    return await startPluginHost()
  } catch (error) {
    jsonResponse(res, 503, {
      ok: false,
      code: PLUGIN_HOST_ERROR.PLUGIN_HOST_NOT_STARTED,
      error: `plugin host could not be started: ${error?.message || String(error)}`,
    })
    return null
  }
}

/**
 * 跑一次插件操作并把结果如实转成 HTTP。
 * host 抛出的 PluginHostError 带 code（404/409），其余异常是宿主故障（500）。
 * 操作本身没抛错但插件落在 error 状态 → 500 + 插件错误码：这次调用**没有**达成
 * 「插件现在是 loaded」这个契约，用 2xx 就是在说谎。
 */
async function respondAfterOperation(res, host, action, fallbackCode) {
  let plugin
  try {
    plugin = await action()
  } catch (error) {
    const code = error instanceof PluginHostError ? error.code : fallbackCode
    const status = code === PLUGIN_HOST_ERROR.PLUGIN_NOT_FOUND
      ? 404
      : code === PLUGIN_HOST_ERROR.PLUGIN_DISABLED ? 409 : 500
    jsonResponse(res, status, { ok: false, code, error: error?.message || String(error), plugins: host.list() })
    return
  }

  const snapshot = host.snapshot()
  if (plugin.status === PLUGIN_STATUS.ERROR) {
    jsonResponse(res, 500, {
      ok: false,
      code: plugin.error?.code || fallbackCode,
      error: plugin.error?.message || `plugin ${plugin.id} is in error state`,
      plugin,
      ...snapshot,
    })
    return
  }

  jsonResponse(res, 200, { ok: true, warnings: plugin.warnings, plugin, ...snapshot })
}

/**
 * 读一个 JSON 对象体。
 * @returns {{body?: object, error?: string}} —— 失败时**必须**给出原因（与 worktrees.js 同一份写法）。
 */
async function readJsonBody(req) {
  let raw
  try {
    raw = await readRawBody(req, { maxBytes: 64 * 1024 })
  } catch (error) {
    return { error: `could not read the request body: ${error?.message || error}` }
  }
  if (!raw || raw.length === 0) return { body: {} }
  let text
  try {
    text = decodeRequestBody(raw, req.headers?.['content-type'])
  } catch {
    text = raw.toString('utf8')
  }
  let parsed
  try {
    parsed = JSON.parse(text)
  } catch (error) {
    return { error: `invalid JSON body: ${error.message}${text.length < 200 ? ` (received: ${text})` : ''}` }
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    return { error: 'request body must be a JSON object' }
  }
  return { body: parsed }
}
