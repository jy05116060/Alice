// 仅用于本地离线预览 scene-shell(demo.html / index.html)的极简静态服务器。
// 与产品运行无关:demo.html 用 ES module 需经 HTTP 伺服(file:// 会被 CORS 挡)。
// 启动:node dev-server.cjs  → http://127.0.0.1:8765/demo.html
const http = require('http')
const fs = require('fs')
const path = require('path')

const ROOT = __dirname
const PORT = process.env.PORT || 8765
const MIME = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.json': 'application/json; charset=utf-8' }

http.createServer((req, res) => {
  let rel = decodeURIComponent(req.url.split('?')[0])
  if (rel === '/' || rel === '') rel = '/demo.html'
  const file = path.join(ROOT, path.normalize(rel))
  if (!file.startsWith(ROOT)) { res.writeHead(403); res.end('forbidden'); return }
  fs.readFile(file, (err, buf) => {
    if (err) { res.writeHead(404); res.end('not found'); return }
    res.writeHead(200, { 'Content-Type': MIME[path.extname(file)] || 'application/octet-stream' })
    res.end(buf)
  })
}).listen(PORT, '127.0.0.1', () => console.log(`[scene-shell dev] http://127.0.0.1:${PORT}/demo.html`))
