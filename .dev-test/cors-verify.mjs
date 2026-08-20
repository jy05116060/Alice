// 验证 Lead 指出的 CORS 缺陷已修：6 条实测（原始输出）。
// 用 fetch（与 Lead 的探针一致）；早先用裸 http.request 的版本会卡住，换掉。
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'blm-cors-'))
process.env.ALICE_USER_DIR = tmp
process.env.ALICE_RESOURCES_DIR = tmp
process.env.ALICE_HOST = '127.0.0.1'

const { startAPI } = await import('file:///D:/白龙马/src/api.js')
const server = startAPI(0)
await new Promise((r) => server.once('listening', r))
const base = `http://127.0.0.1:${server.address().port}`

async function call({ method = 'POST', origin, body, path: p = '/api-ssh' } = {}) {
  const headers = {}
  if (origin !== undefined) headers.Origin = origin
  if (body !== undefined) headers['Content-Type'] = 'application/json'
  const res = await fetch(`${base}${p}`, {
    method,
    headers,
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  })
  return { status: res.status, acao: res.headers.get('access-control-allow-origin'), raw: await res.text() }
}

const show = (label, r) => {
  const acao = r.acao === null || r.acao === undefined ? '(无 ACAO 头)' : `ACAO=${JSON.stringify(r.acao)}`
  console.log(`${label.padEnd(20)} → ${r.status}  ${acao}`)
  console.log(`${' '.repeat(20)}   body=${r.raw.slice(0, 84)}`)
}

console.log('=== CORS 6 条实测（原始输出）===')

const opt = await call({ method: 'OPTIONS', origin: 'http://localhost:1420' })
show('OPTIONS 合法源', opt)

const optBad = await call({ method: 'OPTIONS', origin: 'http://evil.example' })
show('OPTIONS 非法源', optBad)

const post = await call({ body: { method: 'settings.get', payload: {} }, origin: 'http://localhost:1420' })
show('POST 合法源', post)

const postBad = await call({ body: { method: 'settings.get', payload: {} }, origin: 'http://evil.example' })
show('POST 非法源', postBad)

const postNone = await call({ body: { method: 'settings.get', payload: {} } })
show('POST 无 Origin', postNone)

const post404 = await call({ body: { method: 'nope.nope', payload: {} }, origin: 'http://localhost:1420' })
show('POST 合法源 404', post404)

const postBiz = await call({ body: { method: 'machine.connect', payload: { machineId: 'ghost' } }, origin: 'http://localhost:1420' })
show('POST 合法源 业务错', postBiz)

// 非回环：直接喂 handler（本机无法以非回环源地址连自己）
const { handleSshRemoteRoutes } = await import('file:///D:/白龙马/src/api/routes/ssh-remote.js')
const mkRes = () => ({
  statusCode: 0, body: '', headers: {},
  setHeader(k, v) { this.headers[k] = v },
  writeHead(s) { this.statusCode = s; return this },
  end(b) { this.body = b ?? '' },
})
const lan = mkRes()
await handleSshRemoteRoutes(
  { method: 'POST', socket: { remoteAddress: '192.168.1.50' }, headers: { Origin: 'http://localhost:1420' } },
  lan, new URL('http://localhost/api-ssh'),
)
show('非回环', { status: lan.statusCode, acao: lan.headers['Access-Control-Allow-Origin'], raw: lan.body })

console.log('\n=== 断言 ===')
assert.equal(opt.status, 204, 'OPTIONS 合法源 → 204')
assert.equal(opt.acao, 'http://localhost:1420', 'OPTIONS 合法源带 ACAO')
assert.equal(optBad.status, 403, 'OPTIONS 非法源 → 403')
assert.equal(optBad.raw.includes('origin not allowed'), true)
assert.equal(post.status, 200, 'POST 合法源 → 200')
assert.equal(post.acao, 'http://localhost:1420', '★ 合法源的真实 POST 必须带 ACAO（修复前是 null）')
assert.equal(post.raw, '{"ok":true,"value":{"enabled":false}}')
assert.equal(postBad.status, 200, 'POST 非法源 → 200（可以发请求）')
assert.equal(postBad.acao, null, '非法源不带 ACAO（读不到响应）')
assert.notEqual(postBad.acao, 'null', '★ 绝不能写字面量 "null"（会毒化响应）')
assert.equal(postNone.acao, null, '无 Origin 不带 ACAO，也不写 null')
assert.equal(post404.status, 404)
assert.equal(post404.acao, 'http://localhost:1420', '404 也要带 CORS（否则调用方读不到错误）')
assert.equal(postBiz.status, 200)
assert.equal(postBiz.acao, 'http://localhost:1420', '业务错误也要带 CORS')
assert.equal(lan.statusCode, 403, '非回环仍然 403')
assert.equal(JSON.parse(lan.body).error.message, 'this API is loopback-only')
console.log('全部 17 条断言通过 ✓')

server.close()
try { fs.rmSync(tmp, { recursive: true, force: true }) } catch {}
process.exit(0)
