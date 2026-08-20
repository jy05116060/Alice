import fs from 'fs'
import path from 'path'
import { config } from '../../config.js'
import { paths } from '../../paths.js'
import { contentTypeFor, isPathInside } from '../utils.js'

const INDEX_PATH = paths.indexHtml
const DASHBOARD_PATH = paths.dashboardHtml
const BRAIN_PATH = paths.brainHtml
const BRAIN_UI_PATH = paths.brainUiHtml
const WEBSITE_PATH = paths.websiteHtml
const SYSTEM_PROMPT_PATH = paths.systemPromptHtml
const ACTIVATION_PATH = paths.activationHtml
const TURN_TRACE_PATH = paths.turnTraceHtml
const BRAIN_UI_ASSET_ROOT = paths.brainUiAssetRoot
const SITE_ICON_PATH = path.join(paths.resourcesDir, 'build', 'icon.png')
const SCENE_SHELL_ASSET_ROOT = path.join(paths.resourcesDir, 'src', 'ui', 'scene-shell')
const TERMINAL_STREAM_PATH = path.join(paths.resourcesDir, 'src', 'ui', 'terminal-stream', 'index.html')
const D3_VENDOR_PATH = path.join(paths.resourcesDir, 'node_modules', 'd3', 'dist', 'd3.min.js')

function serveHtml(res, filePath, notFoundText) {
  try {
    const html = fs.readFileSync(filePath, 'utf-8')
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' })
    res.end(html)
  } catch {
    res.writeHead(404)
    res.end(notFoundText)
  }
}

function serveFile(res, filePath, notFoundText, cacheControl = 'no-cache') {
  try {
    const stat = fs.statSync(filePath)
    if (!stat.isFile()) {
      res.writeHead(404)
      res.end(notFoundText)
      return
    }
    res.writeHead(200, {
      'Content-Type': contentTypeFor(filePath),
      'Content-Length': stat.size,
      'Cache-Control': cacheControl,
    })
    fs.createReadStream(filePath).pipe(res)
  } catch {
    res.writeHead(404)
    res.end(notFoundText)
  }
}

function serveAsset(req, res, assetRoot, relativePrefix) {
  const relativePath = decodeURIComponent(req.url.split('?')[0].slice(relativePrefix.length))
  const root = path.resolve(assetRoot)
  const assetPath = path.resolve(assetRoot, relativePath)

  if (!isPathInside(root, assetPath)) {
    res.writeHead(403)
    res.end('forbidden')
    return
  }

  try {
    const stat = fs.statSync(assetPath)
    if (!stat.isFile()) {
      res.writeHead(404)
      res.end('asset not found')
      return
    }
    const rangeMatch = /^bytes=(\d*)-(\d*)$/.exec(String(req.headers.range || '').trim())
    if (rangeMatch) {
      const requestedStart = rangeMatch[1] === '' ? null : Number(rangeMatch[1])
      const requestedEnd = rangeMatch[2] === '' ? null : Number(rangeMatch[2])
      let start = requestedStart
      let end = requestedEnd

      if (start === null && end !== null) {
        start = Math.max(0, stat.size - end)
        end = stat.size - 1
      } else {
        start ??= 0
        end = Math.min(end ?? stat.size - 1, stat.size - 1)
      }

      if (!Number.isSafeInteger(start) || !Number.isSafeInteger(end)
        || start < 0 || end < start || start >= stat.size) {
        res.writeHead(416, {
          'Content-Range': `bytes */${stat.size}`,
          'Accept-Ranges': 'bytes',
        })
        res.end()
        return
      }

      res.writeHead(206, {
        'Content-Type': contentTypeFor(assetPath),
        'Content-Length': end - start + 1,
        'Content-Range': `bytes ${start}-${end}/${stat.size}`,
        'Accept-Ranges': 'bytes',
        'Cache-Control': 'no-cache',
      })
      fs.createReadStream(assetPath, { start, end }).pipe(res)
      return
    }

    res.writeHead(200, {
      'Content-Type': contentTypeFor(assetPath),
      'Content-Length': stat.size,
      'Accept-Ranges': 'bytes',
      'Cache-Control': 'no-cache',
    })
    fs.createReadStream(assetPath).pipe(res)
  } catch {
    res.writeHead(404)
    res.end('asset not found')
  }
}

export async function handleStaticRoutes(req, res, url) {
  if (req.method === 'GET' && url.pathname === '/alice-lan-root-ca.cer') {
    const caPath = String(globalThis.process?.env?.ALICE_LAN_CA_CERT || '').trim()
    if (!caPath) {
      res.writeHead(404)
      res.end('LAN root certificate is not configured')
      return true
    }
    serveFile(res, caPath, 'LAN root certificate not found', 'no-store')
    return true
  }

  if (req.method === 'GET' && (url.pathname === '/turn-trace' || url.pathname === '/turn-trace.html')) {
    serveHtml(res, TURN_TRACE_PATH, 'turn-trace.html not found')
    return true
  }

  if (req.method === 'GET' && url.pathname === '/favicon.ico') {
    res.writeHead(204)
    res.end()
    return true
  }

  if (req.method === 'GET' && (url.pathname === '/activation' || url.pathname === '/activation.html')) {
    serveHtml(res, ACTIVATION_PATH, 'activation.html not found')
    return true
  }

  if (req.method === 'GET' && (url.pathname === '/' || url.pathname === '/index.html')) {
    if (config.needsActivation) {
      res.writeHead(302, { Location: '/activation' })
      res.end()
      return true
    }
    try {
      const html = fs.readFileSync(INDEX_PATH, 'utf-8')
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' })
      res.end(html)
    } catch {
      res.writeHead(302, { Location: '/brain-ui' })
      res.end()
    }
    return true
  }

  if (req.method === 'GET' && url.pathname === '/dashboard.html') {
    serveHtml(res, DASHBOARD_PATH, 'dashboard.html not found')
    return true
  }

  if (req.method === 'GET' && url.pathname === '/brain.html') {
    serveHtml(res, BRAIN_PATH, 'brain.html not found')
    return true
  }

  if (req.method === 'GET' && (url.pathname === '/site' || url.pathname === '/site.html')) {
    serveHtml(res, WEBSITE_PATH, 'website.html not found')
    return true
  }

  if (req.method === 'GET' && url.pathname === '/site-assets/icon.png') {
    serveFile(res, SITE_ICON_PATH, 'site icon not found', 'public, max-age=31536000, immutable')
    return true
  }

  if (req.method === 'GET' && (url.pathname === '/brain-ui' || url.pathname === '/brain-ui.html')) {
    if (config.needsActivation && !url.searchParams.has('intro-preview')) {
      res.writeHead(302, { Location: '/activation' })
      res.end()
      return true
    }
    serveHtml(res, BRAIN_UI_PATH, 'brain-ui.html not found')
    return true
  }

  if (req.method === 'GET' && (url.pathname === '/terminal-stream' || url.pathname === '/terminal-stream.html')) {
    serveHtml(res, TERMINAL_STREAM_PATH, 'terminal-stream.html not found')
    return true
  }

  if (req.method === 'GET' && url.pathname === '/systemPrompt.html') {
    serveHtml(res, SYSTEM_PROMPT_PATH, 'systemPrompt.html not found')
    return true
  }

  if (req.method === 'GET' && url.pathname === '/vendor/d3/d3.min.js') {
    try {
      const stat = fs.statSync(D3_VENDOR_PATH)
      res.writeHead(200, {
        'Content-Type': contentTypeFor(D3_VENDOR_PATH),
        'Content-Length': stat.size,
        'Cache-Control': 'public, max-age=31536000, immutable',
      })
      fs.createReadStream(D3_VENDOR_PATH).pipe(res)
    } catch {
      res.writeHead(404)
      res.end('d3.min.js not found')
    }
    return true
  }

  if (req.method === 'GET' && url.pathname.startsWith('/src/ui/scene-shell/')) {
    serveAsset(req, res, SCENE_SHELL_ASSET_ROOT, '/src/ui/scene-shell/')
    return true
  }

  if (req.method === 'GET' && url.pathname.startsWith('/src/ui/brain-ui/')) {
    serveAsset(req, res, BRAIN_UI_ASSET_ROOT, '/src/ui/brain-ui/')
    return true
  }

  /* 桌宠精灵图（`/pets/<source>/<名称>/<文件>`）。
     为什么需要这条路由：桌宠窗口是 `BrowserWindow.loadURL(backendUrl(...))` 加载的
     ——**协议是 HTTP，不是 file://**。渲染层拿到的宠物条目里只有名字，
     要显示精灵图必须向同一个源请求图片，而 `/pets/...` 原先**没有任何路由服务它**：
     实测一个 hasSprite=true 的宠物，渲染层拼出的 `/pets/preset/x/sprite.png` 返回 **404**，
     于是 `background-image` 指向一个不存在的地址，宠物**显示空白**。
     根目录是 `<userDir>/pets`（与 electron/pet-state.cjs 的 petRootDir 同源）。
     serveAsset 自带 `isPathInside` 校验，`../` 穿越在下面这层就被挡住。 */
  if (req.method === 'GET' && url.pathname.startsWith('/pets/')) {
    serveAsset(req, res, path.join(paths.userDir, 'pets'), '/pets/')
    return true
  }

  return false
}
