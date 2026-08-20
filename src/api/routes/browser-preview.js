import fs from 'fs'
import path from 'path'
import {
  browserPreviewDirectory,
  resolveBrowserPreviewFile,
} from '../../mcp/browser-display.js'
import { isPathInside, jsonResponse } from '../utils.js'

export async function handleBrowserPreviewRoutes(req, res, url, { requireLocalOrToken } = {}) {
  if (req.method !== 'GET' || url.pathname !== '/browser-preview') return false
  if (typeof requireLocalOrToken === 'function' && !requireLocalOrToken(req, res, url)) return true

  const candidate = resolveBrowserPreviewFile(url.searchParams.get('file'))
  if (!candidate) {
    jsonResponse(res, 404, { ok: false, error: 'browser preview not found' })
    return true
  }

  try {
    const root = fs.realpathSync(browserPreviewDirectory())
    const resolved = fs.realpathSync(candidate)
    const stat = fs.statSync(resolved)
    if (!isPathInside(root, resolved) || !stat.isFile()) throw new Error('invalid browser preview')
    res.writeHead(200, {
      'Content-Type': 'image/png',
      'Content-Length': stat.size,
      'Cache-Control': 'private, no-store, max-age=0',
      'Content-Disposition': `inline; filename="${path.basename(resolved)}"`,
      'X-Content-Type-Options': 'nosniff',
    })
    fs.createReadStream(resolved).pipe(res)
  } catch {
    jsonResponse(res, 404, { ok: false, error: 'browser preview not found' })
  }
  return true
}
