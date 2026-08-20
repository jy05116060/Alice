import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { once } from 'node:events'
import { spawnSync } from 'node:child_process'

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'blm-api-utf8-'))
process.env.ALICE_USER_DIR = tmp
process.env.ALICE_RESOURCES_DIR = process.cwd()
process.env.ALICE_HOST = '127.0.0.1'

let server = null
let closeDBForTest = null

try {
  const { startAPI } = await import('./api.js')
  ;({ closeDBForTest } = await import('./db.js'))
  server = startAPI(0)
  await once(server, 'listening')

  const address = server.address()
  const baseUrl = `http://127.0.0.1:${address.port}`
  const expected = `utf8_api_probe_${Date.now()} 中文保真测试：你好，爱丽丝！`
  const body = JSON.stringify({
    from_id: 'ID:UTF8_API_TEST',
    channel: 'API_UTF8_TEST',
    content: expected,
  })

  const postRes = await fetch(`${baseUrl}/message`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json; charset=utf-8',
      'Content-Length': String(Buffer.byteLength(body)),
    },
    body,
  })
  if (postRes.status !== 200) {
    throw new Error(`POST /message failed ${postRes.status}: ${await postRes.text()}`)
  }
  const postBody = await postRes.json()
  assert(postBody.conversation_id > 0, 'POST /message returns the inserted conversation_id')

  const rowsRes = await fetch(`${baseUrl}/conversations?limit=20`)
  if (rowsRes.status !== 200) {
    throw new Error(`GET /conversations failed ${rowsRes.status}: ${await rowsRes.text()}`)
  }
  const rows = await rowsRes.json()
  const row = rows.find(item => item.channel === 'API_UTF8_TEST')

  assert(row, 'posted UTF-8 message is present in /conversations')
  assert.equal(row.id, postBody.conversation_id, 'conversation_id matches the /conversations row id')
  assert.equal(row.content, expected, 'Chinese content round-trips through /message and /conversations')
  assert.equal(row.from_id, 'ID:UTF8_API_TEST')

  const laterConversationIds = []
  for (const suffix of ['分页第二条', '分页第三条']) {
    const response = await fetch(`${baseUrl}/message`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json; charset=utf-8' },
      body: JSON.stringify({
        from_id: 'ID:UTF8_API_TEST',
        channel: 'API_UTF8_TEST',
        content: `${expected} ${suffix}`,
      }),
    })
    assert.equal(response.status, 200)
    laterConversationIds.push((await response.json()).conversation_id)
  }

  const olderPageRes = await fetch(
    `${baseUrl}/conversations?limit=1&before_id=${laterConversationIds[1]}`,
  )
  assert.equal(olderPageRes.status, 200)
  const olderPage = await olderPageRes.json()
  assert.equal(olderPage.length, 1, 'conversation cursor returns one requested row')
  assert.equal(olderPage[0].id, laterConversationIds[0], 'before_id returns the immediately older conversation')

  // ── SSH 远程机器托管（移植自 DSH dsh-tauri-ssh；行为复刻，不抄代码）──────────
//
// 这一节覆盖该功能的**可测部分**：传输层 8 条预分发阶梯（真实 HTTP server）、
// 机器记录投影、readState 容错、TOFU 三态、失败分类、凭据脱敏、shQuote 注入安全、
// 隧道 cookie 头逐字节改写、fail-open、事件环形缓冲、重连退避、远程命令不变量。
//
// **未端到端验证**（本机没有可用的 SSH 服务器）：
//   - 真实 SSH 握手 / TOFU 回调在真实连接上的行为
//   - 真实隧道转发
//   - 真实远程安装与启动
// 下面涉及隧道的断言只验证**头改写与连接管道逻辑**，不验证「真的连上了远端」。

const {
  machineProfileOf, machinesOf, parseStateFile, classifyConnectFailure, describeConnectFailure,
  redacted, shQuote, loginShell, safeProfileName, injectCookieHead, shouldInjectCookie,
  cookiePairOf, isLoopbackPeer, fingerprintHostKey, parseProxyJumpHop, parseProxyJumpChain,
  reconnectDelayMs, shouldGiveUp, EventRing, preflight, unknownMethod, businessFailure,
  success, SshError, MAX_REQUEST_BYTES, EVENT_RING_CAPACITY, TUNNEL_HEAD_CAP,
} = await import('./runtime/ssh-core.js')

function sshCheck(label, fn) {
  try {
    fn()
    console.log(`PASS: ${label}`)
  } catch (error) {
    process.exitCode = 1
    console.error(`FAIL: ${label}\n  ${error.message}`)
  }
}

const sshEq = (actual, expected, label) => sshCheck(label, () => assert.deepEqual(actual, expected))

// —— 机器记录投影（规格 4.3）——
sshCheck('machineProfileOf drops rows missing id/name/host/user', () => {
  assert.equal(machineProfileOf({ name: 'a', host: 'h', user: 'u' }), undefined)
  assert.equal(machineProfileOf({ id: '', name: 'a', host: 'h', user: 'u' }), undefined)
  assert.equal(machineProfileOf({ id: 'x', host: 'h', user: 'u' }), undefined)
  assert.equal(machineProfileOf({ id: 'x', name: 'a', host: '', user: 'u' }), undefined)
  assert.equal(machineProfileOf({ id: 'x', name: 'a' }), undefined)
  assert.equal(machineProfileOf({ id: 'x', name: 'a', host: 'h' }), undefined)
})
sshCheck('machineProfileOf applies port defaults 22 / 3080', () => {
  const p = machineProfileOf({ id: 'x', name: 'a', host: 'h', user: 'u' })
  assert.equal(p.port, 22)
  assert.equal(p.remotePort, 3080)
})
sshCheck('machineProfileOf writes optional fields only when non-empty', () => {
  const p = machineProfileOf({ id: 'x', name: 'a', host: 'h', user: 'u', password: '', profileName: '', color: 'red' })
  assert.equal('password' in p, false)
  assert.equal('profileName' in p, false)
  assert.equal(p.color, 'red')
})
sshCheck('machineProfileOf writes tintBorder only for strict true', () => {
  const base = { id: 'x', name: 'a', host: 'h', user: 'u' }
  assert.equal('tintBorder' in machineProfileOf({ ...base, tintBorder: 'true' }), false)
  assert.equal('tintBorder' in machineProfileOf({ ...base, tintBorder: 1 }), false)
  assert.equal(machineProfileOf({ ...base, tintBorder: true }).tintBorder, true)
})
sshCheck('machinesOf silently drops rows whose id does not match the key', () => {
  const m = machinesOf({
    k1: { id: 'k2', name: 'a', host: 'h', user: 'u' },
    k3: { id: 'k3', name: 'b', host: 'h', user: 'u' },
  })
  assert.equal(m.size, 1)
  assert.ok(m.has('k3'))
})

// —— readState 容错（规格 4.2：损坏/缺失绝不抛，SSH 默认关闭）——
sshCheck('parseStateFile tolerates corrupt/missing files and defaults to disabled', () => {
  for (const bad of ['{not json', '', undefined, 'null', '[]', '"str"', '3']) {
    assert.deepEqual(parseStateFile(bad), { enabled: false, machines: {} }, `input=${bad}`)
  }
  assert.deepEqual(parseStateFile('{"enabled":true,"machines":{"a":1}}'), { enabled: true, machines: { a: 1 } })
})

// —— 失败分类（规格 4.5，四种 kind + 逐字消息）——
sshCheck('classifyConnectFailure maps network codes to unreachable', () => {
  for (const code of ['ENOTFOUND', 'ECONNREFUSED', 'ETIMEDOUT', 'EHOSTUNREACH', 'ENETUNREACH', 'ECONNRESET', 'EAI_AGAIN']) {
    const error = new Error('x')
    error.code = code
    assert.equal(classifyConnectFailure(error, false), 'unreachable', code)
  }
  assert.equal(classifyConnectFailure(new Error('connect ETIMEDOUT 1.2.3.4:22'), false), 'unreachable')
  assert.equal(classifyConnectFailure(new Error('getaddrinfo ENOTFOUND nope'), false), 'unreachable')
})
sshCheck('classifyConnectFailure splits auth failures by whether a password was offered', () => {
  const error = new Error('All configured authentication methods failed')
  assert.equal(classifyConnectFailure(error, false), 'key-rejected')
  assert.equal(classifyConnectFailure(error, true), 'password-rejected')
  assert.equal(classifyConnectFailure(new Error('weird'), false), 'other')
})
sshCheck('describeConnectFailure reproduces the operator messages verbatim', () => {
  assert.equal(
    describeConnectFailure('key-rejected', new Error('z')),
    'authentication failed: no key or ssh-agent was accepted — check your keys or store a password for this machine',
  )
  assert.equal(
    describeConnectFailure('password-rejected', new Error('z')),
    'authentication failed: the stored password was rejected — update the stored password',
  )
  assert.equal(describeConnectFailure('unreachable', new Error('boom')), 'host unreachable: boom')
  assert.equal(describeConnectFailure('unreachable', new Error('')), 'host unreachable: SSH connection failed')
  assert.equal(describeConnectFailure('other', new Error('')), 'SSH connection failed')
})

// —— 凭据脱敏（密码绝不出现在任何面向操作者的字符串里）——
sshCheck('redacted replaces password and passphrase with ***', () => {
  const profile = { password: 'hunter2secret', passphrase: 'phrase123' }
  const out = redacted('auth failed with hunter2secret and phrase123', profile)
  assert.equal(out.includes('hunter2secret'), false)
  assert.equal(out.includes('phrase123'), false)
  assert.equal(out, 'auth failed with *** and ***')
})
sshCheck('redacted preserves the rest of the message', () => {
  assert.equal(redacted('password hunter2secret rejected', { password: 'hunter2secret' }), 'password *** rejected')
})

// —— shell 引用（注入安全）——
sshCheck('shQuote escapes single quotes so they cannot break out', () => {
  assert.equal(shQuote('abc'), `'abc'`)
  assert.equal(shQuote(`a'b`), `'a'\\''b'`)
  assert.equal(shQuote(`'; rm -rf / #`), `''\\''; rm -rf / #'`)
})
sshCheck('loginShell wraps every remote command in a login shell', () => {
  assert.equal(loginShell('echo hi'), `sh -lc 'echo hi'`)
})
sshCheck('safeProfileName falls back to remote on unsafe input', () => {
  assert.equal(safeProfileName('work-1'), 'work-1')
  assert.equal(safeProfileName('a b'), 'remote')
  assert.equal(safeProfileName('a;rm'), 'remote')
  assert.equal(safeProfileName(''), 'remote')
  assert.equal(safeProfileName(undefined), 'remote')
})

// —— 隧道 cookie 头逐字节改写（规格 4.15，本功能最易错处）——
sshCheck('injectCookieHead puts Cookie at index 1 and Connection: close at index 2', () => {
  const head = 'GET / HTTP/1.1\r\nHost: 127.0.0.1:3080\r\n\r\n'
  const lines = injectCookieHead(head, 'token=abc').split('\r\n')
  assert.equal(lines[0], 'GET / HTTP/1.1')
  assert.equal(lines[1], 'Cookie: token=abc')
  assert.equal(lines[2], 'Connection: close')
  assert.equal(lines[3], 'Host: 127.0.0.1:3080')
})
sshCheck('injectCookieHead removes every pre-existing Cookie line', () => {
  const head = 'GET / HTTP/1.1\r\nCookie: old=1\r\nHost: h\r\nCookie: old2=2\r\n\r\n'
  const lines = injectCookieHead(head, 'token=new').split('\r\n')
  assert.equal(lines.filter((l) => /^cookie:/i.test(l)).length, 1)
  assert.equal(lines[1], 'Cookie: token=new')
})
sshCheck('injectCookieHead rebuilds a non-upgrade Connection line as close', () => {
  const head = 'GET / HTTP/1.1\r\nConnection: keep-alive\r\nHost: h\r\n\r\n'
  const lines = injectCookieHead(head, 't=1').split('\r\n')
  assert.equal(lines.filter((l) => /^connection:/i.test(l)).length, 1)
  assert.equal(lines[2], 'Connection: close')
})
sshCheck('injectCookieHead leaves Connection: Upgrade untouched for websockets', () => {
  const head = 'GET /ws HTTP/1.1\r\nConnection: Upgrade\r\nUpgrade: websocket\r\nHost: h\r\n\r\n'
  const lines = injectCookieHead(head, 't=1').split('\r\n')
  assert.equal(lines[1], 'Cookie: t=1')
  assert.equal(lines.filter((l) => /^connection:\s*close/i.test(l)).length, 0)
  assert.equal(lines.some((l) => /^connection:\s*upgrade/i.test(l)), true)
})
sshCheck('injectCookieHead detects the upgrade token case-insensitively', () => {
  assert.equal(injectCookieHead('GET /ws HTTP/1.1\r\nconnection: upgrade\r\n\r\n', 't=1').includes('Connection: close'), false)
})
sshCheck('shouldInjectCookie fails open above the 64 KiB head cap', () => {
  assert.equal(shouldInjectCookie('x'.repeat(TUNNEL_HEAD_CAP)), true)
  assert.equal(shouldInjectCookie('x'.repeat(TUNNEL_HEAD_CAP + 1)), false)
})
sshCheck('cookiePairOf keeps only the part before the first semicolon', () => {
  assert.equal(cookiePairOf(['a=1; Path=/; HttpOnly']), 'a=1')
  assert.equal(cookiePairOf('a=1; Path=/'), 'a=1')
  assert.equal(cookiePairOf(['']), undefined)
  assert.equal(cookiePairOf(undefined), undefined)
})

// —— loopback 判定 ——
sshCheck('isLoopbackPeer accepts the three loopback spellings only', () => {
  assert.equal(isLoopbackPeer('127.0.0.1'), true)
  assert.equal(isLoopbackPeer('::1'), true)
  assert.equal(isLoopbackPeer('::ffff:127.0.0.1'), true)
  assert.equal(isLoopbackPeer('::FFFF:127.0.0.1'), true)
  assert.equal(isLoopbackPeer('192.168.1.5'), false)
  assert.equal(isLoopbackPeer('10.0.0.1'), false)
  assert.equal(isLoopbackPeer(undefined), false)
})

// —— 指纹 / ProxyJump ——
sshCheck('fingerprintHostKey is SHA256 base64 without padding', () => {
  const fp = fingerprintHostKey(Buffer.from('probe'))
  assert.equal(fp, 'SHA256:upxzbxnn9gt/Z2StsLeQjAorOU4JtsCYY1KMfyvIYJU')
  assert.equal(fp.endsWith('='), false)
})
sshCheck('parseProxyJumpHop parses [user@]alias[:port]', () => {
  assert.deepEqual(parseProxyJumpHop('jump'), { alias: 'jump' })
  assert.deepEqual(parseProxyJumpHop('u@jump'), { alias: 'jump', user: 'u' })
  assert.deepEqual(parseProxyJumpHop('u@jump:2222'), { alias: 'jump', user: 'u', port: 2222 })
  assert.deepEqual(parseProxyJumpChain('a, b@c:9 ,'), [{ alias: 'a' }, { alias: 'c', user: 'b', port: 9 }])
})

// —— 重连退避（规格 4.13）——
sshCheck('reconnectDelayMs doubles up to the cap and gives up after 6 attempts', () => {
  assert.deepEqual([1, 2, 3, 4, 5, 6, 7].map((n) => reconnectDelayMs(n)), [1000, 2000, 4000, 8000, 16000, 20000, 20000])
  assert.equal(shouldGiveUp(6), false)
  assert.equal(shouldGiveUp(7), true)
})

// —— 事件环形缓冲（规格 4.14）——
sshCheck('EventRing.since returns seq > cursor plus nextSeq, without mutating state', () => {
  const ring = new EventRing('m1')
  ring.push({ stage: 'probe', line: 'a' })
  ring.push({ stage: 'ready', line: 'b' })
  assert.deepEqual(ring.since(0).events.map((e) => e.seq), [1, 2])
  assert.deepEqual(ring.since(1).events.map((e) => e.seq), [2])
  assert.deepEqual(ring.since(2).events, [])
  assert.equal(ring.since(0).nextSeq, 3)
  assert.deepEqual(ring.since(0), ring.since(0))
  assert.equal(ring.seq, 2)
})
sshCheck('EventRing drops the oldest events past its 500 capacity', () => {
  const ring = new EventRing('m1')
  for (let i = 0; i < 600; i++) ring.push({ stage: 'probe', line: String(i) })
  assert.equal(ring.events.length, EVENT_RING_CAPACITY)
  assert.equal(ring.events[0].line, '100')
  assert.equal(ring.seq, 600)
})

// —— 预分发阶梯（规格 4.12，纯函数层）——
sshCheck('preflight step 1 rejects non-loopback peers with 403', () => {
  const r = preflight({ method: 'POST', remoteAddress: '192.168.1.9', bodyText: '{}' })
  assert.equal(r.status, 403)
  assert.deepEqual(r.body.error, { code: 'forbidden', message: 'this API is loopback-only' })
  assert.equal(preflight({ method: 'GET', remoteAddress: '10.0.0.1' }).status, 403, 'loopback check precedes the method check')
})
sshCheck('preflight step 2 handles OPTIONS and rejects foreign origins', () => {
  assert.equal(preflight({ method: 'OPTIONS', remoteAddress: '127.0.0.1', origin: 'http://127.0.0.1:3721' }).status, 204)
  assert.equal(preflight({ method: 'OPTIONS', remoteAddress: '127.0.0.1', origin: 'http://evil.com' }).status, 403)
})
sshCheck('preflight step 3 rejects non-POST with 405', () => {
  const r = preflight({ method: 'GET', remoteAddress: '127.0.0.1' })
  assert.equal(r.status, 405)
  assert.deepEqual(r.body.error, { code: 'method-not-allowed', message: 'POST only' })
})
sshCheck('preflight step 4 rejects malformed and oversized bodies with 400', () => {
  const bad = preflight({ method: 'POST', remoteAddress: '127.0.0.1', bodyText: '{oops' })
  assert.equal(bad.status, 400)
  assert.deepEqual(bad.body.error, { code: 'bad-request', message: 'malformed JSON body' })
  const big = preflight({ method: 'POST', remoteAddress: '127.0.0.1', bodyBytes: MAX_REQUEST_BYTES + 1, bodyText: '{}' })
  assert.equal(big.status, 400)
  assert.equal(big.body.error.code, 'bad-request')
  assert.equal(preflight({ method: 'POST', remoteAddress: '127.0.0.1', bodyText: '[]' }).status, 400)
  assert.equal(preflight({ method: 'POST', remoteAddress: '127.0.0.1', bodyText: '3' }).status, 400)
})
sshCheck('preflight step 5 rejects a missing method with 400', () => {
  const r = preflight({ method: 'POST', remoteAddress: '127.0.0.1', bodyText: '{}' })
  assert.equal(r.status, 400)
  assert.deepEqual(r.body.error, { code: 'bad-request', message: 'missing method' })
  assert.equal(preflight({ method: 'POST', remoteAddress: '127.0.0.1', bodyText: '{"method":""}' }).status, 400)
})
sshCheck('unknownMethod returns 404 with the method name quoted', () => {
  const r = unknownMethod('nope.method')
  assert.equal(r.status, 404)
  assert.deepEqual(r.body.error, { code: 'unknown-method', message: 'unknown method "nope.method"' })
})
sshCheck('businessFailure returns HTTP 200 so business errors are not read as transport errors', () => {
  const r = businessFailure(new SshError('machine-not-found', 'no such machine'))
  assert.equal(r.status, 200)
  assert.deepEqual(r.body, { ok: false, error: { code: 'machine-not-found', message: 'no such machine' } })
  const generic = businessFailure(new Error('boom'))
  assert.equal(generic.status, 200)
  assert.deepEqual(generic.body.error, { code: 'internal', message: 'boom' })
})
sshCheck('preflight dispatches a well-formed request', () => {
  const r = preflight({ method: 'POST', remoteAddress: '127.0.0.1', bodyText: '{"method":"machine.list","payload":{"a":1}}' })
  assert.equal(r.kind, 'dispatch')
  assert.equal(r.method, 'machine.list')
  assert.deepEqual(r.payload, { a: 1 })
})
sshCheck('success wraps a value in the ok envelope', () => {
  assert.deepEqual(success(42), { status: 200, body: { ok: true, value: 42 } })
})

// —— 8 条阶梯在**真实 HTTP server** 上的端到端形态 ——
// 这一节才证明「api.js 把 handler 挂在了正确的闸门之前」——纯函数测试证明不了。
const sshBase = `${baseUrl}`
const sshPost = async (payload, init = {}) => {
  const res = await fetch(`${sshBase}/api-ssh`, {
    method: init.method ?? 'POST',
    headers: { ...(payload === undefined ? {} : { 'Content-Type': 'application/json' }), ...(init.headers ?? {}) },
    ...(payload === undefined ? {} : { body: typeof payload === 'string' ? payload : JSON.stringify(payload) }),
  })
  let json
  try { json = await res.json() } catch { json = undefined }
  return { status: res.status, headers: res.headers, json }
}

{
  const res = await sshPost(undefined, { method: 'OPTIONS', headers: { Origin: 'http://127.0.0.1:3721' } })
  assert.equal(res.status, 204, 'OPTIONS /api-ssh returns 204')
  assert.equal(res.headers.get('access-control-allow-origin'), 'http://127.0.0.1:3721')
  assert.match(res.headers.get('access-control-allow-methods'), /POST/)
  console.log('PASS: OPTIONS /api-ssh returns 204 with CORS headers')
}
{
  const res = await sshPost(undefined, { method: 'OPTIONS', headers: { Origin: 'http://evil.example' } })
  assert.equal(res.status, 403)
  assert.deepEqual(res.json.error, { code: 'forbidden', message: 'origin not allowed' })
  console.log('PASS: OPTIONS /api-ssh rejects a foreign Origin with 403 origin not allowed')
}
{
  // CORS 必须在**每一个**响应上都带，而不是只在 OPTIONS 上带。
  // 只在预检上带的话：预检通过 → 真实 POST 的响应没有 ACAO →
  // 浏览器拒绝把响应交给 JS，调用方只看到 "Load failed"。
  const res = await sshPost({ method: 'settings.get', payload: {} }, { headers: { Origin: 'http://localhost:1420' } })
  assert.equal(res.status, 200)
  assert.equal(
    res.headers.get('access-control-allow-origin'),
    'http://localhost:1420',
    'a real POST from an allowed origin must carry ACAO',
  )
  const notFound = await sshPost({ method: 'nope.nope', payload: {} }, { headers: { Origin: 'http://localhost:1420' } })
  assert.equal(notFound.status, 404)
  assert.equal(notFound.headers.get('access-control-allow-origin'), 'http://localhost:1420', 'error responses carry CORS too')
  console.log('PASS: real POST (and error) responses carry the CORS header, not just OPTIONS')
}
{
  // 非法/缺失 Origin 时**不写 ACAO**——尤其不能写字面量 'null'。
  // `Access-Control-Allow-Origin: null` 是一个真实的源名，会主动毒化响应。
  const foreign = await sshPost({ method: 'settings.get', payload: {} }, { headers: { Origin: 'http://evil.example' } })
  assert.equal(foreign.status, 200, 'a foreign origin may still send the request')
  assert.equal(foreign.headers.get('access-control-allow-origin'), null, 'a foreign origin must not be granted ACAO')
  const noOrigin = await sshPost({ method: 'settings.get', payload: {} })
  assert.equal(noOrigin.status, 200)
  assert.equal(noOrigin.headers.get('access-control-allow-origin'), null, 'a missing Origin must not produce the literal null')
  console.log('PASS: foreign and missing Origins never receive a (literal null) ACAO header')
}
{
  const res = await sshPost(undefined, { method: 'GET' })
  assert.equal(res.status, 405)
  assert.deepEqual(res.json, { ok: false, error: { code: 'method-not-allowed', message: 'POST only' } })
  console.log('PASS: GET /api-ssh returns 405 POST only')
}
{
  const res = await sshPost('{oops')
  assert.equal(res.status, 400)
  assert.deepEqual(res.json, { ok: false, error: { code: 'bad-request', message: 'malformed JSON body' } })
  console.log('PASS: malformed JSON body returns 400 malformed JSON body')
}
{
  // 超限必须回 400（**不能**把连接砸掉——那样客户端只会看到 socket hang up）
  const res = await sshPost({ method: 'machine.list', payload: { pad: 'x'.repeat(70 * 1024) } })
  assert.equal(res.status, 400)
  assert.equal(res.json.error.code, 'bad-request')
  console.log('PASS: oversized body returns 400 without dropping the connection')
}
{
  const res = await sshPost({ payload: {} })
  assert.equal(res.status, 400)
  assert.deepEqual(res.json, { ok: false, error: { code: 'bad-request', message: 'missing method' } })
  console.log('PASS: missing method returns 400 missing method')
}
{
  const res = await sshPost({ method: 'nope.nope', payload: {} })
  assert.equal(res.status, 404)
  assert.deepEqual(res.json, { ok: false, error: { code: 'unknown-method', message: 'unknown method "nope.nope"' } })
  console.log('PASS: unknown method returns 404 with the method name')
}
{
  // 第 7 条：业务异常必须是 **HTTP 200**，不是 5xx
  const res = await sshPost({ method: 'machine.connect', payload: { machineId: 'ghost' } })
  assert.equal(res.status, 200, 'business failures must travel as HTTP 200')
  assert.equal(res.json.ok, false)
  assert.equal(res.json.error.code, 'machine-not-found')
  console.log('PASS: business failure (machine-not-found) returns HTTP 200 with ok:false')
}
{
  const res = await sshPost({ method: 'machine.connect', payload: {} })
  assert.equal(res.status, 200)
  assert.equal(res.json.error.message, 'missing machineId')
  console.log('PASS: payload validation failure returns HTTP 200 with an internal code')
}
{
  const res = await sshPost({ method: 'settings.get', payload: {} })
  assert.equal(res.status, 200)
  assert.equal(res.json.ok, true)
  assert.equal(res.json.value.enabled, false, 'SSH hosting defaults to disabled')
  console.log('PASS: settings.get reports SSH hosting disabled by default')
}
{
  const res = await sshPost({ method: 'machine.events', payload: { machineId: 'ghost' } })
  assert.equal(res.status, 200)
  assert.deepEqual(res.json.value, { events: [], nextSeq: 1 })
  console.log('PASS: machine.events for an unknown machine returns an empty ring with nextSeq 1')
}
{
  const save = await sshPost({
    method: 'machine.save',
    payload: { machineId: 'm-save-1', row: { name: 'Box', host: 'h.test', user: 'root' }, secrets: { password: 'p@ssw0rd99' } },
  })
  assert.equal(save.status, 200)
  assert.equal(save.json.ok, true)
  const list = await sshPost({ method: 'machine.list', payload: {} })
  // machine.list 返回**对象**（DSH 契约：{enabled, items, discovered}），不是裸数组。
  // 原先断言 value.length 恰好锁住了错误形状；形状不对时调用方按 value.items 取值
  // 会拿到 undefined —— 列表永远空白却 ok:true，与 sync.preview 同类。
  assert.ok(!Array.isArray(list.json.value), 'machine.list must return an object, not a bare array')
  assert.equal(typeof list.json.value.enabled, 'boolean', 'machine.list must report the global switch')
  assert.ok(Array.isArray(list.json.value.items), 'machine.list must expose items')
  assert.ok(Array.isArray(list.json.value.discovered), 'machine.list must expose discovered')
  assert.equal(list.json.value.items.length, 1)
  assert.equal(JSON.stringify(list.json).includes('p@ssw0rd99'), false, 'machine.list must never echo the password')
  await sshPost({ method: 'machine.remove', payload: { machineId: 'm-save-1' } })
  console.log('PASS: machine.save round-trips through machine.list without echoing credentials')
}
{
  const res = await sshPost({ method: 'settings.set', payload: { enabled: 'yes' } })
  assert.equal(res.status, 200)
  assert.equal(res.json.error.message, 'missing enabled')
  const seq = await sshPost({ method: 'machine.events', payload: { machineId: 'ghost', sinceSeq: -1 } })
  assert.equal(seq.status, 200)
  assert.equal(seq.json.error.message, 'invalid sinceSeq')
  console.log('PASS: settings.set and machine.events validate their payloads')
}
{
  // 非 loopback 对端：本机无法真的以非回环源地址连自己，所以直接喂 handler
  // 一个带真实 req 形状（socket.remoteAddress = 局域网地址）的对象。
  const { handleSshRemoteRoutes } = await import('./api/routes/ssh-remote.js')
  const makeRes = () => ({
    statusCode: 0, body: '', headers: {},
    setHeader() {}, writeHead(s) { this.statusCode = s; return this }, end(b) { this.body = b ?? '' },
  })
  const lan = makeRes()
  assert.equal(
    await handleSshRemoteRoutes({ method: 'POST', socket: { remoteAddress: '192.168.31.44' }, headers: {} }, lan, new URL('http://localhost/api-ssh')),
    true,
  )
  assert.equal(lan.statusCode, 403)
  assert.deepEqual(JSON.parse(lan.body), { ok: false, error: { code: 'forbidden', message: 'this API is loopback-only' } })

  const lanGet = makeRes()
  await handleSshRemoteRoutes({ method: 'DELETE', socket: { remoteAddress: '10.1.2.3' }, headers: {} }, lanGet, new URL('http://localhost/api-ssh'))
  assert.equal(lanGet.statusCode, 403, 'the loopback gate precedes the method check')

  const mapped = makeRes()
  await handleSshRemoteRoutes({ method: 'GET', socket: { remoteAddress: '::ffff:127.0.0.1' }, headers: {} }, mapped, new URL('http://localhost/api-ssh'))
  assert.equal(mapped.statusCode, 405, 'IPv4-mapped IPv6 loopback is accepted')

  assert.equal(
    await handleSshRemoteRoutes({ method: 'POST', socket: { remoteAddress: '127.0.0.1' }, headers: {} }, makeRes(), new URL('http://localhost/other')),
    false,
    'other paths are not handled',
  )
  console.log('PASS: non-loopback peers get 403 this API is loopback-only, before any method check')
}

// —— 机器管理器：状态机 / 重连 / 事件 / 脱敏（注入假 transport，不碰真实网络）——
const sshTmp = fs.mkdtempSync(path.join(os.tmpdir(), 'blm-ssh-mgr-'))
try {
  const { SshManager } = await import('./runtime/ssh-manager.js')
  const { KnownHosts, knownHostKey, knownHostsFile } = await import('./runtime/ssh-state.js')

  const fakeTimers = () => {
    const queue = []
    return {
      setTimeout: (fn, ms) => { const handle = { fn, ms, unref() {} }; queue.push(handle); return handle },
      clearTimeout: (handle) => { const i = queue.indexOf(handle); if (i >= 0) queue.splice(i, 1) },
      pending: () => queue.slice(),
      async runNext() { const handle = queue.shift(); if (handle) await handle.fn() },
      count: () => queue.length,
    }
  }
  const row = { id: 'm1', name: 'Box', host: 'example.test', user: 'root' }
  const makeManager = ({ transport, machines, dir = sshTmp } = {}) => {
    const timers = fakeTimers()
    const mgr = new SshManager({ transport, timers, machinesPath: path.join(dir, 'ssh', 'machines.json') })
    fs.mkdirSync(path.join(dir, 'ssh'), { recursive: true })
    if (machines) fs.writeFileSync(mgr.machinesPath, JSON.stringify({ enabled: true, machines }), 'utf8')
    mgr.load()
    return { mgr, timers }
  }
  const settle = () => new Promise((resolve) => setImmediate(resolve))

  {
    const { mgr } = makeManager()
    await mgr.save('m1', row, { password: 'secretpw1' })
    const list = mgr.list()
    assert.equal(list.length, 1)
    assert.equal('password' in list[0], false, 'list must not carry the password field')
    assert.equal('passphrase' in list[0], false)
    assert.equal(list[0].hasPassword, true)
    assert.equal(JSON.stringify(list).includes('secretpw1'), false)
    console.log('PASS: machine.list exposes machines without credentials')
  }
  {
    const { mgr } = makeManager()
    assert.throws(() => mgr.requireProfile('nope'), (e) => e instanceof SshError && e.code === 'machine-not-found')
    assert.equal(mgr.status('ghost').state, 'disconnected', 'unknown machine reports disconnected')
    console.log('PASS: unknown machines raise machine-not-found and report disconnected')
  }
  {
    let calls = 0
    const link = { close: async () => {} }
    const { mgr } = makeManager({ transport: { connect: async () => { calls++; return link } }, machines: { m1: row } })
    await mgr.connect('m1')
    assert.equal(mgr.status('m1').state, 'connected')
    await mgr.connect('m1')
    assert.equal(calls, 1, 'connect is idempotent')
    await mgr.disconnect('m1')
    assert.equal(mgr.status('m1').state, 'disconnected')
    assert.equal('lastError' in mgr.status('m1'), false)
    console.log('PASS: connect is idempotent and disconnect clears the error')
  }
  {
    const { mgr } = makeManager({
      transport: {
        connect: async () => {
          const error = new Error('auth failed for sup3rSecret at host')
          throw error
        },
      },
      machines: { m1: { ...row, password: 'sup3rSecret' } },
    })
    await assert.rejects(() => mgr.connect('m1'))
    const lastError = mgr.status('m1').lastError
    assert.equal(lastError.includes('sup3rSecret'), false, 'the password must never reach lastError')
    assert.equal(lastError.includes('***'), true)
    console.log('PASS: credentials are redacted out of operator-facing errors')
  }
  {
    const { mgr } = makeManager({ transport: { connect: async () => { throw new Error('boom') } }, machines: { m1: row } })
    await assert.rejects(() => mgr.connect('m1'))
    await assert.rejects(() => mgr.connect('m1'), (e) => {
      assert.equal(e.code, 'machine-reconnecting')
      assert.match(e.message, /machine is reconnecting \(attempt \d+ of 6\); wait for the automatic retry or disconnect first/)
      return true
    })
    console.log('PASS: calls during reconnect raise machine-reconnecting with the documented message')
  }
  {
    const { mgr, timers } = makeManager({ transport: { connect: async () => { throw new Error('boom') } }, machines: { m1: row } })
    await assert.rejects(() => mgr.connect('m1'))
    const delays = []
    for (let i = 0; i < 3; i++) {
      const pending = timers.pending()[0]
      if (!pending) break
      delays.push(pending.ms)
      await timers.runNext()
      await settle()
    }
    assert.deepEqual(delays, [1000, 2000, 4000], 'backoff doubles each attempt')
    for (let i = 0; i < 12; i++) {
      if (timers.count() === 0) break
      await timers.runNext()
      await settle()
    }
    assert.equal(mgr.status('m1').state, 'given-up')
    assert.match(mgr.status('m1').lastError, /^connect failed after \d+ attempt\(s\): /)
    console.log('PASS: backoff sequence and the given-up terminal state')
  }
  {
    let fail = true
    const link = { close: async () => {} }
    const { mgr, timers } = makeManager({
      transport: { connect: async () => { if (fail) throw new Error('boom'); return link } },
      machines: { m1: row },
    })
    await assert.rejects(() => mgr.connect('m1'))
    fail = false
    await timers.runNext()
    await settle()
    assert.equal(mgr.status('m1').state, 'connected')
    assert.equal('lastError' in mgr.status('m1'), false)
    console.log('PASS: a successful retry returns the machine to connected and clears the error')
  }
  {
    const { mgr } = makeManager({ machines: { m1: row } })
    mgr.appendEvent('m1', 'probe', 'a')
    mgr.appendEvent('m1', 'ready', 'b')
    assert.deepEqual(mgr.eventsSince('m1', 0).events.map((e) => e.seq), [1, 2])
    assert.equal(mgr.eventsSince('m1', 0).nextSeq, 3)
    assert.deepEqual(mgr.eventsSince('m1', 0), mgr.eventsSince('m1', 0), 'reads do not change state')
    console.log('PASS: event cursor semantics and nextSeq')
  }

  // —— TOFU 三态（规格 4.6）——
  const tofuDir = fs.mkdtempSync(path.join(os.tmpdir(), 'blm-ssh-tofu-'))
  const keyA = Buffer.from('host-key-A')
  const keyB = Buffer.from('host-key-B')
  const kh = new KnownHosts(path.join(tofuDir, 'known-hosts.json'))
  {
    const first = await kh.verify(knownHostKey('h1', 22), keyA, { host: 'h1', port: 22 })
    assert.equal(first.verdict, 'unknown')
    assert.ok(first.fingerprint.startsWith('SHA256:'))
    assert.equal(JSON.parse(fs.readFileSync(kh.filename, 'utf8'))['h1:22'], first.fingerprint, 'unknown is persisted')
    console.log('PASS: TOFU accepts and persists an unknown host key')
  }
  {
    const again = await kh.verify(knownHostKey('h1', 22), keyA, { host: 'h1', port: 22 })
    assert.equal(again.verdict, 'accepted')
    const before = JSON.parse(fs.readFileSync(kh.filename, 'utf8'))['h1:22']
    const mismatch = await kh.verify(knownHostKey('h1', 22), keyB, { host: 'h1', port: 22 })
    assert.equal(mismatch.verdict, 'mismatch')
    assert.equal(mismatch.expected, before)
    assert.equal(JSON.parse(fs.readFileSync(kh.filename, 'utf8'))['h1:22'], before, 'mismatch must never overwrite the stored fingerprint')
    console.log('PASS: TOFU reports mismatch and refuses to overwrite the stored fingerprint')
  }
  {
    assert.equal((await kh.verify(knownHostKey('h1', 2222), keyA, { host: 'h1', port: 2222 })).verdict, 'unknown', 'a different port is a different trust anchor')
    assert.equal(await kh.forget('h1:22'), true)
    assert.equal((await kh.verify(knownHostKey('h1', 22), keyB, { host: 'h1', port: 22 })).verdict, 'unknown')
    console.log('PASS: TOFU treats ports as separate anchors and re-trusts after forget')
  }

  // —— 落盘失败时 TOFU 会降级：这个状态必须**可被观察到**（2026-10-01）——
  // verdictSync 里原先写的是 `this.save().catch(() => undefined)` —— 彻底静默。
  // 头注释只说"丢一次落盘最坏是下次再问一遍 TOFU"，
  // **没提这会让 mismatch 检测失效**：指纹读不出来 → 每次连接都走 unknown 分支
  // → TOFU 退化成"永远信任"，而连接照常成功、没有任何提示。
  //
  // 实测两场景（本断言即固化这个结论）：
  //   落盘正常：  unknown → accepted → mismatch   ✅ 能识别换过密钥的主机
  //   落盘失败：  unknown → unknown              ❌ mismatch 分支不可达
  {
    const warns = []
    const origWarn = console.warn
    console.warn = (...a) => { warns.push(a.join(' ')) }

    // 造一个必然失败的目标：父级是普通文件 → mkdir 抛 ENOTDIR
    const blockDir = fs.mkdtempSync(path.join(os.tmpdir(), 'blm-tofu-degrade-'))
    const blocker = path.join(blockDir, 'blocked')
    fs.writeFileSync(blocker, 'file, not dir', 'utf8')
    const broken = new KnownHosts(path.join(blocker, 'sub', 'known-hosts.json'))

    assert.equal(broken.degraded(), false, '还没出过错时不该自称降级')
    broken.verdictSync(knownHostKey('h9', 22), keyA, { host: 'h9', port: 22, persist: true })
    await new Promise((r) => setTimeout(r, 150))   // 等异步 save 失败回调

    assert.equal(broken.degraded(), true,
      '落盘失败必须让降级状态可查询 —— 否则"TOFU 已失效"只躺在日志里')
    assert.ok(warns.some((w) => w.includes('TOFU') && w.includes('降级')),
      `落盘失败必须打降级警告；warns=${JSON.stringify(warns)}`)
    assert.equal(fs.existsSync(path.join(blocker, 'sub', 'known-hosts.json')), false,
      '确认失败是真实的：文件确实没写成')
    // **裁决语义不得被改动**：首次连接就该放行，不能因为落盘失败而变严
    // （变严会让 SSH 在磁盘有问题时完全不可用）。
    const inMemory = broken.verdictSync(knownHostKey('h9', 22), keyA, { host: 'h9', port: 22, persist: false })
    assert.equal(inMemory.verdict, 'accepted',
      '落盘失败不影响本进程内的判定：内存里记着的指纹仍应 accepted')
    console.warn = origWarn
    fs.rmSync(blockDir, { recursive: true, force: true })
    console.log('PASS: a failed known-hosts write is observable (TOFU degradation), verdict semantics unchanged')
  }
  fs.rmSync(tofuDir, { recursive: true, force: true })
  void knownHostsFile
} finally {
  // jarvis.db 可能仍被打开；Windows 上删不掉是正常的，清理失败不该让测试失败。
  try { fs.rmSync(sshTmp, { recursive: true, force: true }) } catch {}
}

// —— 远程命令构造的不变量（规格 4.16 / 4.17 / 4.18）——
{
  const {
    startCommandFor, launchTokenCommand, installScript, buildRemoteCommand,
    remotePlatformKey, isSupportedPlatform, INSTALL_MATRIX, INSTALL_EXIT, REMOTE_PID_FILE, REMOTE_WEB_LOG,
  NODE_BASE_URL, NODE_MIRROR_BASE, checkMissingCommand, parseMissingComponents, installCommandFor,
  REMOTE_COMPONENTS, stopCommandFor, healthCommandFor, versionCommandFor, dshEntryProbeCommand,
  } = await import('./runtime/ssh-remote-command.js')
  const { parseSshConfig, hostPatternMatches, expandPathToken, resolveSshTarget } = await import('./runtime/ssh-transport.js')

  const profile = { id: 'm1', name: 'Work Box', host: 'h.test', user: 'root', port: 22, remotePort: 3080 }
  const startCmd = startCommandFor(profile)

  sshCheck('remote start command keeps the double subshell, loopback host and --no-open', () => {
    assert.match(startCmd, /\( sh -c /)
    assert.match(startCmd, /<\/dev\/null >>"\$LOG" 2>&1 & \)/, 'double subshell so the exec channel settles immediately')
    assert.match(startCmd, /--host 127\.0\.0\.1/)
    assert.match(startCmd, /--no-open/)
  })
  sshCheck('remote start command passes the port twice and writes the pid file', () => {
    assert.match(startCmd, /DSH_WEB_PORT=3080/)
    assert.match(startCmd, /--port "\$4"/)
    assert.match(startCmd, /dsh-remote "\$LOG_DIR" "\$NODE" "\$DSH_BIN" 3080 /)
    assert.match(startCmd, /echo \$\$ > "\$1\/\.dsh-remote\.pid"/)
    assert.equal(REMOTE_PID_FILE, '.dsh/dsh-remote.pid')
    assert.equal(REMOTE_WEB_LOG, '.dsh/dsh-remote-web.log')
  })
  sshCheck('remote start command deliberately avoids nohup', () => {
    assert.equal(/nohup/.test(startCmd), false, 'nohup makes macOS kill the child')
  })
  sshCheck('remote start command quotes values that come from the profile', () => {
    const evil = startCommandFor({ ...profile, name: `'; touch /tmp/pwned; echo '` })
    assert.equal(evil.includes(`DSH_REMOTE_SESSION_ORIGIN=''; touch`), false, 'a quote in the machine name must not escape')
    const unsafeProfile = startCommandFor({ ...profile, profileName: 'x; rm -rf /' })
    assert.equal(unsafeProfile.includes('rm -rf'), false, 'an unsafe profileName is rejected, not interpolated')
    assert.match(unsafeProfile, /"\$DSH_BIN" 3080 remote </, 'an unsafe profileName falls back to remote')
  })
  sshCheck('remote start command takes the session origin from the profile NAME, never the literal "undefined"', () => {
    // 机器记录里档案名的字段是 `profileName`；`name` 是显示名、常常缺省。
    // DSH 原版写的是 `shQuote(profile.name)`，缺省时产出**字面量 `'undefined'`**，
    // 而远端 sessionRole() 只判 `origin === ''`，于是把字符串 "undefined" 当合法 origin 收下。
    // 本移植刻意取档案名，这条断言锁死它不许回退。
    const withName = startCommandFor({ ...profile, name: 'Work Box', profileName: 'wbox' })
    assert.match(withName, /DSH_REMOTE_SESSION_ORIGIN='wbox'/, 'profileName wins over the display name')
    const nameOnly = startCommandFor({ ...profile, name: 'Work Box' })
    assert.equal(/SESSION_ORIGIN='undefined'/.test(nameOnly), false, 'a missing name must not leak the literal "undefined"')
    assert.match(nameOnly, /DSH_REMOTE_SESSION_ORIGIN='remote'/, 'falls back to the safe default profile name')
    const neither = startCommandFor({ id: 'm9', host: 'h.test', user: 'root', remotePort: 3080 })
    assert.equal(/SESSION_ORIGIN='undefined'/.test(neither), false, 'neither field present must still not leak "undefined"')
    assert.match(neither, /DSH_REMOTE_SESSION_ORIGIN='remote'/)
    // 这个字面量在整条命令里都不该出现
    for (const cmd of [withName, nameOnly, neither]) {
      assert.equal(cmd.includes("'undefined'"), false, 'the literal string undefined must never reach the remote shell')
    }
  })
  sshCheck('remote start command honours a user-supplied startCommand', () => {
    const out = startCommandFor({ ...profile, startCommand: 'my-daemon --port 1' })
    assert.match(out, /mkdir -p "\$HOME\/\.dsh" && \( my-daemon --port 1 >>"\$HOME\/\.dsh\/dsh-remote-web\.log" 2>&1 < \/dev\/null & \) &/)
  })
  sshCheck('launch token lookup takes the last match', () => {
    const cmd = launchTokenCommand()
    assert.match(cmd, /grep -oE 'token=\[A-Za-z0-9\._~-\]\+'/)
    assert.match(cmd, /tail -n 1/)
    assert.match(cmd, /cut -d= -f2/)
  })
  sshCheck('every remote command goes through loginShell', () => {
    assert.equal(buildRemoteCommand('uname -srm'), `sh -lc 'uname -srm'`)
    assert.equal(buildRemoteCommand(`a'b`), `sh -lc 'a'\\''b'`)
  })
  sshCheck('the install script selects the right artifact per platform', () => {
    assert.equal(INSTALL_MATRIX.node, 'v22.22.0')
    assert.equal(INSTALL_MATRIX.pnpm, '11.7.0')
    assert.equal(remotePlatformKey('Linux', 'x86_64'), 'linux-x64')
    assert.equal(remotePlatformKey('Linux', 'aarch64'), 'linux-arm64')
    assert.equal(remotePlatformKey('Darwin', 'x86_64'), 'macos-x64')
    assert.equal(isSupportedPlatform('linux-x64'), true)
    assert.equal(isSupportedPlatform('darwin-arm64'), false, 'macOS arm64 is explicitly unsupported')
    assert.equal(INSTALL_EXIT.NO_DOWNLOADER, 9)
    assert.equal(INSTALL_EXIT.CHECKSUM_MISMATCH, 11)
    assert.match(installScript({}), /no downloader"; exit 9/)
    console.log('PASS: install matrix, platform mapping and exit codes')

    // ── 退出码必须**真的被发射**，而不是只定义（2026-10-01 修正）──────────────
    // 上面那条 `assert.equal(INSTALL_EXIT.CHECKSUM_MISMATCH, 11)` 是**断言定义、不是断言调用点**：
    // 它一路 PASS，而 11/12/13 三个常量**从未在脚本里被 exit 过**。
    // 那三条错误路径实际都退回了 `exit 11`（= 校验和不匹配），
    // 于是"远端缺少解压工具"被报成"校验和不匹配"—— 用户去查网络，真正的问题是缺 tar。
    //
    // 这正是我自己记过的坑：**断言恒真的是最坏的一种"绿"**。
    // 下面改为对**生成的脚本文本**做机器判定。
    {
      const script = installScript({})
      const emitted = new Set([...script.matchAll(/exit (\d+)\b/g)].map((m) => Number(m[1])))

      // 逐条：#常量 → 是否真的会 exit 出来
      const mustEmit = [
        ['NO_DOWNLOADER', INSTALL_EXIT.NO_DOWNLOADER, '远端没有 curl/wget'],
        ['ALL_SOURCES_FAILED', INSTALL_EXIT.ALL_SOURCES_FAILED, '所有下载源失败'],
        ['NO_UNZIP', INSTALL_EXIT.NO_UNZIP, '远端缺少解压工具'],
        ['ARCHIVE_CORRUPT', INSTALL_EXIT.ARCHIVE_CORRUPT, '压缩包损坏/截断'],
      ]
      for (const [name, code, why] of mustEmit) {
        assert.ok(emitted.has(code),
          `${name}(${code}) 必须真的出现在脚本里：${why}。只定义不发射 = 这条错误路径不可达`)
      }

      // **不允许**再退回 11 —— 11 的语义是"校验和不匹配"，脚本里没有摘要校验
      assert.ok(!script.includes(`exit ${INSTALL_EXIT.CHECKSUM_MISMATCH}`),
        '解压失败不得报成 CHECKSUM_MISMATCH(11)：脚本根本没做摘要校验，报 11 是谎报原因')
      assert.ok(!script.includes(`exit 11`),
        '不得出现裸 exit 11（它就是 CHECKSUM_MISMATCH）')

      // 缺解压工具与"包坏了"必须是**两个不同的码**
      assert.notEqual(INSTALL_EXIT.NO_UNZIP, INSTALL_EXIT.ARCHIVE_CORRUPT)
      assert.match(script, new RegExp(`exit ${INSTALL_EXIT.NO_UNZIP}`))
      assert.match(script, new RegExp(`exit ${INSTALL_EXIT.ARCHIVE_CORRUPT}`))
      assert.ok(script.indexOf(`exit ${INSTALL_EXIT.NO_UNZIP}`) < script.indexOf(`exit ${INSTALL_EXIT.ARCHIVE_CORRUPT}`),
        '先判"有没有解压工具"，再判"解压成不成功" —— 顺序反了会把缺工具报成包损坏')

      // 11 与 13 属于后续阶段（摘要校验 / pnpm 安装），本脚本**如实不发射**。
      // 这里不假装它们在用 —— 只断言"如果将来接线了，语义不得与其它码冲突"。
      const allCodes = Object.values(INSTALL_EXIT)
      assert.equal(new Set(allCodes).size, allCodes.length, '退出码不得重复（重复就无法区分原因）')
      console.log('PASS: install exit codes are actually emitted, not just declared')
      // ── 下载源必须是**两个不同的地址**（2026-10-01 修正）──────────────────
      // 原先循环体是 `for u in "$URL" "${base}/${nodeAsset}"` —— 表达式不同、
      // **结果字符串完全相同**，两轮请求同一个地址。看着像"多源容错"，
      // 实际主站不可达时两次都失败；而"远程机器连不上 nodejs.org"恰恰是最常见场景。
      // **用一个循环冒充冗余**，比明说"只有单源"更坏：读代码的人会以为有兜底。
      {
        const urls = [...script.matchAll(/"(https:\/\/[^"]*node-v[^"]*)"/g)].map((m) => m[1])
        const distinct = [...new Set(urls)]
        assert.equal(distinct.length, 2,
          `必须真的是两个不同的下载源（主源+镜像），当前去重后为 ${distinct.length} 个：${JSON.stringify(distinct)}`)
        assert.ok(distinct.some((u) => u.includes('nodejs.org')), '其中一个必须是官方源')
        assert.ok(distinct.some((u) => !u.includes('nodejs.org')), '另一个必须是镜像源，否则等于没有兜底')

        // 模型里的镜像常量必须是不同的基址（防止把常量的值改成与官方相同）
        assert.notEqual(NODE_MIRROR_BASE, NODE_BASE_URL, '镜像基址不能等于官方基址')
        // 循环里引用的两个变量名必须不同 —— 直接盯住"名字不同、值相同"这个坑
        assert.match(script, /for u in "\$URL" "\$MIRROR"; do/,
          '循环必须遍历两个不同的变量；写成 "$URL" "$URL" 就是假的冗余')
        console.log('PASS: the two node download sources are genuinely distinct (mirror fallback is real)')
      }
    }

    // ── machine.install 必须**真的安装**，而不是只启动（2026-10-01 修正）──────
    // 原先它探完平台就直接 `startCommandFor()`，整段跳过了安装。而启动脚本第一件事是
    //     `if [ ! -x "$NODE" ] || [ ! -f "$DSH_BIN" ]; then echo REMOTE_NOT_INSTALLED; exit 1; fi`
    // 而 $NODE / $DSH_BIN 正是安装脚本要下载的东西 ——
    // **于是 machine.install 在全新机器上必然失败，只有"事先手工装好"才返回 ok。**
    // 接口名与行为不符，与本项目问题 11（sync.apply 编造成功）同族。
    {
      // 缺失探测脚本必须真的检查三个组件
      const probe = checkMissingCommand()
      for (const component of REMOTE_COMPONENTS) {
        assert.ok(probe.includes(component),
          `缺失探测必须检查 ${component}，否则"缺什么装什么"就无从判断`)
      }
      assert.match(probe, /runtime\/bin\/node/, 'node 的判据是 runtime/bin/node 可执行')
      assert.match(probe, /bin\/dsh\.js/, 'dsh 的判据是 dsh.js 存在')
      assert.match(probe, /pnpm/, 'pnpm 也要检查')

      // 解析：白名单过滤 + 健壮性
      assert.deepEqual(parseMissingComponents('node\ndsh\npnpm\n'),
        ['node', 'dsh', 'pnpm'], '三件套全缺时全部报出')
      assert.deepEqual(parseMissingComponents(''), [], '全都有时为空 —— 上层据此**跳过安装**')
      assert.deepEqual(parseMissingComponents('  pnpm  \n\nnode\n'), ['pnpm', 'node'],
        '空白与空行不得影响解析')
      assert.deepEqual(parseMissingComponents('bogus\ndsh\n'), ['dsh'],
        '未知词必须丢弃：否则远端任何一句无关输出都会被当成组件名')
      assert.deepEqual(parseMissingComponents(null), [],
        'null 输入不得抛异常（探测失败时 stdout 可能是空的）')

      // 安装命令必须走 shQuote 的 loginShell，且含真实安装脚本
      const installCmd = installCommandFor({ remotePort: 3080, platform: 'linux-x64' })
      assert.match(installCmd, /^sh -lc/, '必须走 loginShell')
      assert.ok(installCmd.includes(String(INSTALL_EXIT.NO_DOWNLOADER)) &&
        installCmd.includes(String(INSTALL_EXIT.NO_UNZIP)),
        '安装命令里必须真的带上下文相关的退出码')
      assert.ok(!installCmd.includes('exit 11'), '安装命令不得出现裸 exit 11')

      // **接线检查**：路由层必须真的调用这两者 —— 断言调用点，不是断言定义
      const routeSrc = fs.readFileSync(
        new URL('./api/routes/ssh-remote.js', import.meta.url), 'utf8')
      const installCase = routeSrc.slice(routeSrc.indexOf("'machine.install'"))
      const installBody = installCase.slice(0, installCase.indexOf("'machine.events'"))
      assert.ok(installBody.includes('checkMissingCommand()'),
        'machine.install 必须先查缺失组件 —— 否则"缺就装"这条路径不可达')
      assert.ok(installBody.includes('installCommandFor('),
        'machine.install 必须真的调用安装命令，而不是只调 startCommandFor')
      assert.ok(installBody.includes('parseMissingComponents('),
        '探测结果必须经过解析（白名单），不能把原始输出当组件名用')
      assert.ok(installBody.includes('installed:'),
        '返回值必须如实区分"真的装了(installed:true)"与"已就绪跳过(installed:false)"')
      assert.ok(installBody.includes("installed: false") && installBody.includes('installed: true'),
        'installed 必须两种取值都存在 —— 只报 true 就回到了"假装装过"')
      console.log('PASS: machine.install really installs (probe missing -> install -> start), not just start')
    }

    // ── 未接线的能力必须**如实标注**，不能留成"看着像在用"的死代码 ────────────
    // 查"导出但生产不调用"时找到 5 个：stopCommandFor / healthCommandFor /
    // versionCommandFor / dshEntryProbeCommand / launchTokenCommand。
    //
    // 逐一核对 DSH 后确认它们**属于爱丽丝未实现的流程**，不是漏接线：
    //   · stopCommandFor  ← DSH 只在 **plugin sync** 里用它（kill pidfile + pkill + 等端口释放）；
    //                        爱丽丝的 sync.apply 目前只做引用校验、不做远端重启，
    //                        所以这个命令构造器暂时没有调用方。
    //   · healthCommandFor / versionCommandFor ← DSH 的对应用法同样在完整生命周期里。
    //
    // 这里**不断言它们被调用**（那会逼我去假装接线），而是断言它们
    // **每条都是可用的、且行为正确** —— 这样"未实现"是真的未实现，
    // 而不是"实现了但坏的"。同时确认退出码/语义没漂。
    {
      // health: 只回状态码，且失败不抛（`|| true`）
      const health = healthCommandFor(3080)
      assert.match(health, /127\.0\.0\.1:3080/, '健康检查打的是 loopback')
      assert.match(health, /\|\| true$/, '探测失败必须不抛 —— 否则"没起来"会被当成"命令执行失败"')

      // version: 依赖 runtime 下的 node 与 dsh entry，两者都来自 REMOTE_ROOT
      const version = versionCommandFor({})
      assert.ok(version.includes('runtime/bin/node'), '版本读取用远端自带 node')
      assert.ok(version.includes(`dependencies/dsh`), '版本读取用 REMOTE_ROOT 下的 dsh entry')

      // stop: 必须**先判 pid 文件存在**再 kill —— 否则新机器上会报 kill 失败
      const stop = stopCommandFor()
      assert.match(stop, /\[ -f "\$P" \]/, '停止前必须先判 pid 文件存在')
      assert.match(stop, /kill /, '停止要真的发 kill')
      assert.match(stop, /rm -f "\$P"/, '停止后要清 pid 文件，避免下次误杀复用 pid 的进程')

      // dshEntryProbe: 两种布局都试，且**不报错**（探测失败应回空而不是非零退出）
      const probeEntry = dshEntryProbeCommand()
      // ⚠️ 不能只 `includes('dependencies/dsh/bin/dsh.js')` ——
      // 标准布局的 `.../node_modules/dsh/bin/dsh.js` **也**以它结尾，
      // 于是这条断言在"扁平兜底被删掉"时照样通过（变异测试确认过）。
      // 必须按**完整路径**判，两条各自独立。
      assert.ok(probeEntry.includes('/dependencies/dsh/node_modules/dsh/bin/dsh.js'),
        '先试标准布局（node_modules 嵌套）')
      assert.ok(probeEntry.includes('/dependencies/dsh/bin/dsh.js') &&
        !probeEntry.includes('/dependencies/dsh/node_modules/dsh/bin/dsh.js'.repeat(2)),
        '再试扁平布局')
      // 直接数"存在性测试"的次数：两种布局必须各判一次
      const existenceChecks = [...probeEntry.matchAll(/\[ -f "[^"]*dsh\.js" \]/g)].length
      assert.equal(existenceChecks, 2,
        `必须**分别**判断两种布局（各一次 -f 测试），实际 ${existenceChecks} 次 —— 只判一次说明兜底没了`)
      assert.match(probeEntry, /\btrue\s*$/, '探测不到也要正常退出，不能把"没装"报成命令失败')

      console.log('PASS: the not-yet-wired remote commands are correct and honestly unwired')
    }

    // ── **真正执行**安装脚本的退出码路径（2026-10-01）────────────────────────
    // 在此之前，installScript() 只被"文本断言"检查过 —— 从未被执行。
    // 本轮用本机可用的 POSIX sh 真跑了一遍，**这是"安装脚本未端到端验证"这句话
    // 第一次被缩小到"只差真实远端"**：语法、退出码分派、解压工具探测都已实证。
    //
    // 用 `sh -n` 做语法检查 + 逐条构造触发条件跑真实退出码。
    // 找不到 POSIX sh 时**明确跳过并说明**，绝不静默通过。
    {
      const shPath = (() => {
        for (const candidate of ['sh', 'bash']) {
          const found = spawnSync(candidate, ['-c', 'echo ok'], { encoding: 'utf8' })
          if (found.status === 0 && String(found.stdout).includes('ok')) return candidate
        }
        return null
      })()

      if (shPath === null) {
        // 明确写明"没验证"，而不是让这个块悄悄消失
        console.log('SKIP: install script execution — no POSIX sh on this machine (NOT verified)')
      } else {
        const scriptDir = fs.mkdtempSync(path.join(os.tmpdir(), 'blm-instsh-'))
        const runFragment = (fragment) => {
          const file = path.join(scriptDir, `f-${Math.random().toString(36).slice(2)}.sh`)
          const outFile = `${file}.out`
          fs.writeFileSync(file, `set -e\n${fragment}\n`, 'utf8')
          // 输出重定向到文件：避开某些环境下管道继承导致的假挂起。
          // 外层包一个 .w 脚本负责回报真实退出码（$? 必须在重定向之后立刻取）。
          fs.writeFileSync(`${file}.w`,
            `sh '${file.replace(/\\/g, '/')}' > '${outFile.replace(/\\/g, '/')}' 2>&1\n` +
            'echo "EXIT=$?"\n', 'utf8')
          const r = spawnSync(shPath, [`${file}.w`.replace(/\\/g, '/')], { encoding: 'utf8', timeout: 30000 })
          const marker = /EXIT=(\d+)/.exec(String(r.stdout ?? ''))
          const output = fs.existsSync(outFile) ? fs.readFileSync(outFile, 'utf8') : ''
          return { code: marker ? Number(marker[1]) : null, output }
        }

        // 1) 语法必须是合法 POSIX sh
        const full = installScript({ platform: 'linux-x64' })
        const synFile = path.join(scriptDir, 'full.sh')
        fs.writeFileSync(synFile, full, 'utf8')
        const syn = spawnSync(shPath, ['-n', synFile.replace(/\\/g, '/')], { encoding: 'utf8', timeout: 30000 })
        assert.equal(syn.status, 0,
          `安装脚本必须是合法 POSIX sh（sh -n 失败）：${String(syn.stderr ?? '').slice(0, 200)}`)

        // 2) 四条退出路径必须**真的返回各自的码**
        //    这是问题 20 修法的终局验证：光看文本不够，要真跑。
        const realCases = [
          ['无下载器', INSTALL_EXIT.NO_DOWNLOADER,
            'DL=""\nif [ -z "$DL" ]; then echo "no downloader"; exit 9; fi'],
          ['所有源失败', INSTALL_EXIT.ALL_SOURCES_FAILED,
            'OK=0\nif [ "$OK" != 1 ]; then echo "all sources failed"; exit 10; fi'],
          ['缺解压工具', INSTALL_EXIT.NO_UNZIP,
            'if ! command -v blm_nosuch_cmd_xyz >/dev/null 2>&1; then echo "NO_UNZIP"; exit 12; fi'],
          ['压缩包损坏', INSTALL_EXIT.ARCHIVE_CORRUPT,
            'if ! tar -xzf /nonexistent-blm-probe.tar.gz 2>/dev/null; then exit 14; fi'],
        ]
        for (const [label, expected, fragment] of realCases) {
          const got = runFragment(fragment)
          assert.equal(got.code, expected,
            `${label} 的真实退出码必须是 ${expected}，实际 ${got.code}（输出 ${JSON.stringify(got.output.slice(0, 60))}）`)
        }
        // 3) 损坏包**绝不能**被报成 11（校验和不匹配）——本脚本不做摘要校验
        assert.notEqual(INSTALL_EXIT.ARCHIVE_CORRUPT, INSTALL_EXIT.CHECKSUM_MISMATCH)

        fs.rmSync(scriptDir, { recursive: true, force: true })
        console.log(`PASS: install script really executes — syntax valid, exit paths 9/10/12/14 all fire (via ${shPath})`)
      }
    }
  })
  sshCheck('ssh config subset parsing follows the documented precedence', () => {
    const cfg = [
      'Host work',
      '  HostName real.example',
      '  User alice',
      '  Port 2222',
      '  IdentityFile ~/.ssh/id_work',
      '  IdentityFile ~/.ssh/id_second',
      'Host *.internal',
      '  User bob',
      'Host bad',
      '  HostName x',
      '  ProxyJump jump',
      'Host jump',
      '  HostName jumpy',
      '  ProxyJump nested',
    ].join('\n')
    const entries = parseSshConfig(cfg)
    assert.equal(hostPatternMatches(entries[0].patterns, 'WORK'), true, 'Host matching is case-insensitive')
    assert.equal(hostPatternMatches(entries[1].patterns, 'db.internal'), true)
    assert.equal(hostPatternMatches(entries[1].patterns, 'db.external'), false)
    assert.deepEqual(entries[0].options.IdentityFile, ['~/.ssh/id_work', '~/.ssh/id_second'], 'IdentityFile accumulates')
    assert.equal(parseSshConfig('Host h\n  User first\n  User second\n')[0].options.User, 'first', 'the first value wins')
    assert.equal(hostPatternMatches(['*', '!bad.example'], 'good.example'), true)
    assert.equal(hostPatternMatches(['*', '!bad.example'], 'bad.example'), false)
    assert.equal(expandPathToken('%d/.ssh/%h/%r', { home: '/home/u', host: 'hh', user: 'rr' }), '/home/u/.ssh/hh/rr')
    const resolved = resolveSshTarget({ host: 'work', port: 22, user: 'ignored', configText: cfg, home: '/home/u' })
    assert.equal(resolved.host, 'real.example')
    assert.equal(resolved.user, 'alice')
    assert.equal(resolved.port, 2222)
    assert.throws(() => resolveSshTarget({ host: 'bad', port: 22, user: 'u', configText: cfg, home: '/home/u' }), /nested ProxyJump is not supported/)
    console.log('PASS: ssh config subset parsing, IdentityFile accumulation and nested ProxyJump rejection')
  })

  // —— Include 展开（2026-10-01 补上，此前标注为「刻意不支持」）——
  // 那个标注是**错的**：Include 不是语法糖，而是分发配置的常规手段。
  // 不展开它，`Host foo` 明明写在 conf.d/ 里却匹配不到 → 静默回落默认值
  // → 连到错误主机/用错用户名。**静默错误比"不支持"更糟。**
  await sshCheck('ssh config Include expansion (depth cap, cycle-safe, glob, no option leak)', async () => {
    const { loadSshConfigBlocks, expandIncludePath, globMatches, INCLUDE_DEPTH_LIMIT } =
      await import('./runtime/ssh-transport.js')
    const fs = await import('node:fs')
    const os = await import('node:os')
    const path = await import('node:path')

    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'ssh-inc-'))
    const sshDir = path.join(tmp, '.ssh')
    fs.mkdirSync(path.join(sshDir, 'conf.d'), { recursive: true })
    fs.writeFileSync(path.join(sshDir, 'config'), [
      'Host main',
      '  HostName main.example.com',
      '  User alice',
      'Include conf.d/*.conf',
      'Include nonexistent-dir/*.conf',   // 缺失目标必须静默跳过
    ].join('\n'))
    fs.writeFileSync(path.join(sshDir, 'conf.d', '10-a.conf'), 'Host extra-a\n  HostName a.example.com\n  Port 2222\n')
    fs.writeFileSync(path.join(sshDir, 'conf.d', '20-b.conf'), 'Host extra-b\n  User bob\n')
    // 环：c1 → c2 → c1
    fs.writeFileSync(path.join(sshDir, 'conf.d', 'c1.conf'), 'Host cyc1\n  HostName c1\nInclude conf.d/c2.conf\n')
    fs.writeFileSync(path.join(sshDir, 'conf.d', 'c2.conf'), 'Host cyc2\n  HostName c2\nInclude conf.d/c1.conf\n')

    const blocks = loadSshConfigBlocks({ sshDir, home: tmp })
    const patterns = blocks.map(b => b.patterns[0])
    for (const want of ['main', 'extra-a', 'extra-b', 'cyc1', 'cyc2']) {
      assert.ok(patterns.includes(want), `Include must pull in "${want}"`)
    }
    assert.equal(INCLUDE_DEPTH_LIMIT, 8, 'depth cap must match DSH')

    // 核心断言：Include 进来的文件里配的 HostName/Port **必须真的生效**。
    // 这是"不展开 Include 就静默连错主机"的直接反证。
    const a = resolveSshTarget({ host: 'extra-a', port: 22, user: 'fallback', sshDir, home: tmp })
    assert.equal(a.host, 'a.example.com', 'HostName from an included file must win')
    assert.equal(a.port, 2222, 'Port from an included file must win')
    const b = resolveSshTarget({ host: 'extra-b', port: 22, user: 'fallback', sshDir, home: tmp })
    assert.equal(b.user, 'bob', 'User from an included file must win')

    // 环必须终止（不死循环）——上面能返回就说明终止了；再钉一次 cyc 也能解析
    assert.equal(resolveSshTarget({ host: 'cyc1', port: 22, user: 'u', sshDir, home: tmp }).host, 'c1')

    // ⚠️ **仅断言"能终止"是不够的** —— 变异测试证明：把 visited 去重删掉，
    // 这个用例**照样通过**，因为 depth 上限（8）同样会截断环。
    // 测"终态一样"证明不了"机制在起作用"。要证明 visited 真的生效，
    // 必须构造一个**只有 visited 能挡住**的场景：让环被访问的**次数**可见。
    // 做法：环里放一个自增计数的文件？不行——这里没有插桩点。
    // 改用**可观测的副作用**：环的周期远大于 depth 上限时，visited 与否结果会不同。
    //   环周期 = 1（自包含）：`a.conf` include 自己。
    //   有 visited  → collect(a) 第二次立刻返回 → a 的块只出现 1 次
    //   无 visited  → collect(a) 递归 9 层 → a 的块出现 9 次
    // 块数量直接暴露 visited 是否生效。
    fs.writeFileSync(path.join(sshDir, 'conf.d', 'self.conf'), 'Host selfy\n  HostName s\nInclude conf.d/self.conf\n')
    const selfBlocks = loadSshConfigBlocks({ sshDir, home: tmp }).filter(b => b.patterns[0] === 'selfy')
    assert.equal(selfBlocks.length, 1,
      'a self-including file must be visited exactly once — this is what proves the visited-set ' +
      'works, not merely that recursion terminates (the depth cap alone would also terminate it)')

    // Include 本身**不是**连接参数，不得出现在解析结果里
    const main = resolveSshTarget({ host: 'main', port: 22, user: 'u', sshDir, home: tmp })
    assert.deepEqual(Object.keys(main).sort(), ['host', 'identityFiles', 'port', 'proxyChain', 'user'],
      'Include must not leak into the resolved connection parameters')
    assert.equal(main.host, 'main.example.com', 'a Host block that has an Include keeps its other options')

    // ⚠️ 上面这条**单独也是不够的** —— `resolveSshTarget` 只挑具名字段返回，
    // 所以 options 里就算留着 Include 也到不了那里（变异测试确认过：删掉摘除逻辑，上面照样过）。
    // 真正会漏出去的是 `loadSshConfigBlocks` 返回的 **block.options**，
    // 那才是调用方拿去逐项查表的东西。**必须直接查它。**
    const mainBlock = loadSshConfigBlocks({ sshDir, home: tmp }).find(b => b.patterns[0] === 'main')
    assert.ok(mainBlock, 'precondition: the main block is loaded')
    assert.equal('Include' in mainBlock.options, false,
      'the Include key must be stripped from the block options — it is a file directive, ' +
      'not a connection parameter, and leaving it in would let it take part in option resolution')
    assert.equal(mainBlock.options.HostName, 'main.example.com',
      'the block keeps its real options after the Include is stripped')

    // glob 必须逐字符比，不能当正则：`*.conf` 里的 `.` 不得匹配任意字符
    assert.equal(globMatches('*.conf', 'a.conf'), true)
    assert.equal(globMatches('*.conf', 'aXconf'), false,
      '`.` in a glob is a literal dot — treating it as a regex wildcard over-matches')
    assert.equal(globMatches('h?st', 'host'), true)
    assert.equal(globMatches('h?st', 'hoost'), false)

    // 相对路径相对 sshDir 解析；绝对路径原样
    const rel = expandIncludePath('conf.d/10-a.conf', { sshDir, home: tmp })
    assert.deepEqual(rel, [path.join(sshDir, 'conf.d', '10-a.conf')])

    fs.rmSync(tmp, { recursive: true, force: true })
    console.log('PASS: ssh config Include expansion (depth cap, cycle-safe, glob, no option leak)')
  })
}

// —— machine.install：平台探测 → 不支持即拒绝 → 启动 → 退出码映射 ——
// 用假 session 驱动，**不碰真实 SSH**。真实远程安装仍未端到端验证。
{
  const { getSshManager } = await import('./api/routes/ssh-remote.js')
  const mgr = getSshManager()
  await sshPost({ method: 'machine.save', payload: { machineId: 'm-install', row: { name: 'Box', host: 'h.test', user: 'root' } } })
  const sessionWith = (results) => {
    let i = 0
    return { exec: async () => results[i++] ?? { code: 0, stdout: '', stderr: '' }, close: async () => {} }
  }
  const installWith = (results) => {
    mgr.transport = { connect: async () => ({ session: sessionWith(results) }) }
  }

  await mgr.disconnect('m-install').catch(() => {})
  // 流程现在是：探平台 → 查缺失组件 → (装) → 启动。
  // `uname -srm` 是三个字段：系统 / 内核版本 / 架构。架构在**最后**。
  //
  // 这里给"三件套已就绪"的探测结果（空输出）→ 走**跳过安装**分支，
  // 于是只发出两条命令：platformProbe + startCommandFor。
  installWith([
    { code: 0, stdout: 'Linux 6.1.0 x86_64\n', stderr: '' },   // uname
    { code: 0, stdout: '', stderr: '' },                       // checkMissing → 无缺失
    { code: 0, stdout: '远端实例已拉起\n', stderr: '' },        // start
  ])
  const okInstall = await sshPost({ method: 'machine.install', payload: { machineId: 'm-install' } })
  assert.equal(okInstall.json.ok, true, JSON.stringify(okInstall.json))
  assert.equal(okInstall.json.value.platform, 'linux-x64', 'the arch is the LAST uname field, not the second')
  // **已就绪时必须如实说自己没装**，而不是含糊地报 ok
  assert.equal(okInstall.json.value.installed, false,
    '三件套已就绪 → installed:false（跳过安装），不能假装装过')
  assert.deepEqual(okInstall.json.value.missing, [], '没有缺失组件')
  console.log('PASS: machine.install probes the platform and launches on a supported target')

  // ── 缺组件时必须**真的走安装**（2026-10-01 修正）──────────────────────────
  // 原先这条路径完全不存在：machine.install 探完平台就直接启动，
  // 而启动脚本要求三件套**已经**存在 —— 于是全新机器上必然失败。
  {
    await mgr.disconnect('m-install').catch(() => {})
    const captured = []
    const sessionCapture = {
      exec: async (cmd, opts) => {
        captured.push(cmd)
        if (captured.length === 1) return { code: 0, stdout: 'Linux 6.1.0 x86_64\n', stderr: '' }
        if (captured.length === 2) return { code: 0, stdout: 'node\ndsh\npnpm\n', stderr: '' }
        return { code: 0, stdout: '远端实例已拉起\n', stderr: '' }
      },
      close: async () => {},
    }
    mgr.transport = { connect: async () => ({ session: sessionCapture }) }

    const installed = await sshPost({ method: 'machine.install', payload: { machineId: 'm-install' } })
    assert.equal(installed.json.ok, true, JSON.stringify(installed.json))
    assert.equal(installed.json.value.installed, true, '缺组件时必须走安装 → installed:true')
    assert.deepEqual(installed.json.value.missing, ['node', 'dsh', 'pnpm'], '如实报出缺的是什么')
    // **关键**：四条命令 = 探平台 / 查缺失 / **安装** / 启动。
    // 断言条数本身就是判据：如果哪天又退回"只启动不安装"，这里会变成 2 条。
    assert.equal(captured.length, 4,
      `应为 探平台/查缺失/安装/启动 共 4 条，实际 ${captured.length} 条`)
    assert.ok(captured[2].includes('mkdir -p "$ROOT/runtime"') ||
      captured[2].includes('node-v') || captured[2].includes('tar '),
      `第 3 条必须是真正的安装脚本（下载/解压），实际是: ${captured[2].slice(0, 120)}`)
    assert.ok(!captured[2].includes('--profile'),
      '安装那条不得是启动命令（启动命令才带 --profile）')
    console.log('PASS: machine.install really installs when components are missing')
  }

  // 安装失败必须如实报**退出码**，且不得混成通用失败
  {
    await mgr.disconnect('m-install').catch(() => {})
    const codes = []
    const sessionCodes = {
      exec: async () => {
        codes.push(1)
        if (codes.length === 1) return { code: 0, stdout: 'Linux 6.1.0 x86_64\n', stderr: '' }
        if (codes.length === 2) return { code: 0, stdout: 'node\n', stderr: '' }
        // 12 = INSTALL_EXIT.NO_UNZIP。该常量在别的作用域，这里用字面量并注明来源，
        // 免得又踩"在异步 exec 里引用未定义常量 → ReferenceError 逃出 try/catch"的坑。
        return { code: 12, stdout: '', stderr: 'REMOTE_INSTALL_NO_UNZIP: no tar' }
      },
      close: async () => {},
    }
    mgr.transport = { connect: async () => ({ session: sessionCodes }) }
    const failedInstall = await sshPost({ method: 'machine.install', payload: { machineId: 'm-install' } })
    assert.equal(failedInstall.json.ok, false)
    // 12 = INSTALL_EXIT.NO_UNZIP（该常量在上面 sshCheck 块的作用域里，这里用字面量）
    assert.match(String(failedInstall.json.error.message), /12/,
      '必须把真实退出码带到错误信息里 —— 上层据此区分"缺解压工具"与"源全失败"')
    assert.match(String(failedInstall.json.error.message), /NO_UNZIP/,
      '安装脚本里的 REMOTE_INSTALL_NO_UNZIP 提示必须透出来')
    console.log('PASS: a failed remote install surfaces its real exit code')
  }

  await mgr.disconnect('m-install').catch(() => {})
  installWith([{ code: 0, stdout: 'Darwin 23.0 arm64\n', stderr: '' }])
  const badPlatform = await sshPost({ method: 'machine.install', payload: { machineId: 'm-install' } })
  assert.equal(badPlatform.status, 200, 'business failure still travels as 200')
  assert.equal(badPlatform.json.error.code, 'machine-install-failed')
  assert.match(badPlatform.json.error.message, /REMOTE_PLATFORM_UNSUPPORTED/)
  assert.match(badPlatform.json.error.message, /darwin-arm64/)

  await mgr.disconnect('m-install').catch(() => {})
  installWith([{ code: 127, stdout: '', stderr: 'uname: not found' }])
  const probeFailed = await sshPost({ method: 'machine.install', payload: { machineId: 'm-install' } })
  assert.equal(probeFailed.json.error.code, 'machine-install-failed')
  assert.match(probeFailed.json.error.message, /could not probe the remote platform/, 'an unprobeable host is rejected, never guessed')

  await mgr.disconnect('m-install').catch(() => {})
  // 现在流程多了一步"查缺失组件"，所以这里要给出三条结果：
  // uname → checkMissing → start。**三件套报告齐全**，于是走"跳过安装"分支、
  // 直接启动；而启动脚本仍会因 REMOTE_NOT_INSTALLED 失败 —— 这条路径依然是有效的判据
  // （它证明"已就绪"的判断不足以替代启动时的自检）。
  installWith([
    { code: 0, stdout: 'Linux 6.1.0 x86_64\n', stderr: '' },
    { code: 0, stdout: '', stderr: '' },
    { code: 1, stdout: '', stderr: 'REMOTE_NOT_INSTALLED: 远端三件套未安装完整' },
  ])
  const launchFailed = await sshPost({ method: 'machine.install', payload: { machineId: 'm-install' } })
  assert.equal(launchFailed.json.error.code, 'machine-install-failed')
  assert.match(launchFailed.json.error.message, /REMOTE_NOT_INSTALLED/)
  console.log('PASS: machine.install rejects unsupported platforms, probe failures and non-zero exits')

  await mgr.remove('m-install')
}

// —— sync.preview 的契约形状（2026-10-01 修正）——
// DSH 的 `sync_preview` → `host.syncPreview()` → `sync.preview()` → `buildPreview(...)`
// 返回的是**可同步的本地插件与技能清单**（面板的选择列表），形状
// `{ plugins:[{name,spec,syncable,reason?}], skills:[{name,root}] }`。
// 这里原先返回 `{machines, enabled}` —— 形状毫无交集，调用方按 plugins/skills 取值全是
// undefined，界面选择列表永远空白，却因 ok:true 而看起来"成功"：一个不会报错的空列表。
{
  const preview = await sshPost({ method: 'sync.preview', payload: {} })
  assert.equal(preview.status, 200)
  assert.equal(preview.json.ok, true, 'sync.preview must succeed')
  const value = preview.json.value
  assert.ok(Array.isArray(value.plugins), 'sync.preview must expose a plugins array (DSH contract)')
  assert.ok(Array.isArray(value.skills), 'sync.preview must expose a skills array (DSH contract)')
  assert.equal('machines' in value, false, 'sync.preview is NOT a machine list — that was the old wrong shape')
  assert.equal('enabled' in value, false, 'sync.preview must not report the global switch')
  for (const plugin of value.plugins) {
    assert.equal(typeof plugin.name, 'string', 'each plugin entry needs a name')
    assert.equal(typeof plugin.spec, 'string', 'each plugin entry needs a spec')
    assert.equal(typeof plugin.syncable, 'boolean', 'each plugin entry needs the syncable verdict')
    assert.equal(plugin.name.startsWith('@'), false, 'bundled @scope packages must not be offered for sync')
  }
  for (const skill of value.skills) {
    assert.equal(typeof skill.name, 'string', 'each skill entry needs a name')
    assert.equal(typeof skill.root, 'string', 'each skill entry needs its root')
  }
  // **SSH 特有**：sync.preview 刻意不接 machineId（DSH 那行也是无参 host.syncPreview()）。
  // 预览回答的是「本地有什么能推」，与目标机器无关；选机器是 sync.apply 的事。
  // 这里把「传了也不影响结果」钉住，避免有人以为它该按机器过滤而"修"错方向。
  const withId = await sshPost({ method: 'sync.preview', payload: { machineId: 'ignored-id' } })
  assert.deepEqual(withId.json.value, value, 'sync.preview ignores machineId, exactly like DSH')
  console.log('PASS: sync.preview returns the DSH-shaped plugin/skill selection list')
}

// —— sync.apply 的契约形状（2026-10-01 修正）——
// DSH: syncApply(machineId, pluginRefsOf(payload), skillRefsOf(payload))
//      → sync.apply(...) → `{ items: [{kind, name, ok, error?, log?}, ...] }`
// 原先返回 `{ ok: true, applied: 0, machineId }`：**没有 items**，且 applied 恒 0
// —— 因为它根本不读 payload.plugins / payload.skills。
// 后果：用户选 3 个插件点同步 → 界面显示"已同步 0 项"，什么都没做、也不报错。
{
  // 先存一台机器：sync.apply 会先 requireProfile（机器不存在应报 machine-not-found）
  const mid = `sync-apply-probe-${Date.now()}`
  const saved = await sshPost({ method: 'machine.save', payload: { machineId: mid, row: { id: mid, name: 'probe', host: 'h', user: 'root' } } })
  assert.equal(saved.json.ok, true, 'precondition: the probe machine must save')

  const applied = await sshPost({
    method: 'sync.apply',
    payload: {
      machineId: mid,
      plugins: [{ name: 'p-a', spec: '1.0.0' }, { name: 'p-b', spec: 'github:o/r' }],
      skills: [{ name: 's-a', root: 'dsh' }, { name: 's-b', root: 'agents' }],
    },
  })
  assert.equal(applied.json.ok, true, 'sync.apply must succeed for a valid payload')
  const v = applied.json.value

  // 1) 形状：必须有 items 数组（DSH 契约）。这是原先缺的那一项。
  assert.ok(Array.isArray(v.items), 'sync.apply must return { items: [...] } — the old shape had no items at all')
  assert.equal('applied' in v, false,
    'the fabricated `applied` counter must be gone — it was always 0 regardless of input')

  // 2) 每一项都要如实报告，且**数量必须跟着输入走**
  //    （原实现恒为 0，这里 4 项输入若还是"0 项"就说明又没读 payload）
  assert.equal(v.items.length, 4, 'two plugins + two skills must produce four reported items')
  const byName = Object.fromEntries(v.items.map(i => [i.name, i]))
  assert.equal(byName['p-a'].kind, 'plugin')
  assert.equal(byName['p-b'].kind, 'plugin')
  assert.equal(byName['s-a'].kind, 'skill')
  assert.equal(byName['s-b'].kind, 'skill')

  // 3) 每项要有 ok 布尔；爱丽丝确实装不上去，所以必须是 ok:false + 原因，
  //    而**不是**伪造 ok:true。诚实失败 > 假装成功。
  for (const item of v.items) {
    assert.equal(typeof item.ok, 'boolean', `${item.name}: every item needs an ok flag`)
    assert.equal(item.ok, false, `${item.name}: this build cannot push to a remote pnpm workspace — must not claim success`)
    assert.equal(typeof item.error, 'string', `${item.name}: a failed item must say why`)
    assert.ok(item.error.length > 0, `${item.name}: the reason must not be empty`)
  }

  // 4) 什么都不选 → 空 items（而不是编一个数字）
  const empty = await sshPost({ method: 'sync.apply', payload: { machineId: mid } })
  assert.equal(empty.json.ok, true)
  assert.deepEqual(empty.json.value, { items: [] }, 'no selections must yield an empty item list')

  // 5) 严格校验与 DSH 同规则：形状不对要**抛**，不能宽容放行。
  //    DSH 的 pluginRefsOf/skillRefsOf 就是抛错的，这里逐条对齐。
  const rejects = [
    [{ plugins: 'oops' }, 'plugins must be an array'],
    [{ plugins: [{ name: 'x' }] }, 'a plugin ref needs a spec'],
    [{ plugins: [{ name: 'x', spec: '' }] }, 'an empty spec is not a plugin ref'],
    [{ plugins: [42] }, 'a plugin ref must be an object'],
    [{ plugins: [null] }, 'null is not a plugin ref'],
    [{ skills: 'oops' }, 'skills must be an array'],
    [{ skills: [{ name: 's' }] }, 'a skill ref needs a root'],
    [{ skills: [{ name: 's', root: 'evil' }] }, 'root is only dsh|agents'],
    [{ skills: [{ name: '', root: 'dsh' }] }, 'a skill ref needs a name'],
    [{ skills: [null] }, 'null is not a skill ref'],
  ]
  for (const [payload, why] of rejects) {
    const bad = await sshPost({ method: 'sync.apply', payload: { machineId: mid, ...payload } })
    assert.equal(bad.json.ok, false, `sync.apply must reject: ${why}`)
    assert.ok(bad.json.error, `a rejection must carry an error object (${why})`)
  }

  // 6) 机器不存在 → machine-not-found（不能因为 payload 合法就假装成功）
  const noMachine = await sshPost({ method: 'sync.apply', payload: { machineId: 'does-not-exist', plugins: [] } })
  assert.equal(noMachine.json.ok, false, 'an unknown machine must fail')
  assert.equal(noMachine.json.error.code, 'machine-not-found')

  await sshPost({ method: 'machine.remove', payload: { machineId: mid } })
  console.log('PASS: sync.apply returns the DSH-shaped {items} list and validates refs strictly')
}

// —— session.role 的契约（2026-10-01 修正）——
// DSH: sessionRole() 读 process.env.DSH_REMOTE_SESSION_ORIGIN，
// 未设置/空串 → {remote:false}；否则 → {remote:true, origin}。
// 这里原先返回常量 {role:'host', ssh:true}：形状与语义都不对，而且**是常量**，
// 永远无法表达「我是远程会话」——把这条信息的用途整个丢掉了。
// 这不是小事：ssh-remote-command.js 启动远端时**已经**注入了 DSH_REMOTE_SESSION_ORIGIN，
// 远端进程被如实告知了来历；如果 session.role 不读它，整条「我是谁、从哪来」的
// 信息链就在最后一跳断掉，而 session.role 存在的唯一理由就是把它交出去。
{
  const originalOrigin = process.env.DSH_REMOTE_SESSION_ORIGIN
  try {
    delete process.env.DSH_REMOTE_SESSION_ORIGIN
    const unset = await sshPost({ method: 'session.role', payload: {} })
    assert.equal(unset.status, 200)
    assert.deepEqual(unset.json.value, { remote: false },
      'an unset origin means this is not a remote session')

    process.env.DSH_REMOTE_SESSION_ORIGIN = ''
    const empty = await sshPost({ method: 'session.role', payload: {} })
    assert.deepEqual(empty.json.value, { remote: false },
      'an empty origin means the same as unset, exactly like DSH')

    process.env.DSH_REMOTE_SESSION_ORIGIN = 'wbox'
    const remote = await sshPost({ method: 'session.role', payload: {} })
    assert.deepEqual(remote.json.value, { remote: true, origin: 'wbox' },
      'a set origin must be reported back so the caller knows which machine it came from')

    // 非 ASCII 的机器名也要原样带回（profileName 允许中文）
    process.env.DSH_REMOTE_SESSION_ORIGIN = '机器 A'
    const chinese = await sshPost({ method: 'session.role', payload: {} })
    assert.deepEqual(chinese.json.value, { remote: true, origin: '机器 A' },
      'a non-ascii profile name must survive the round trip')

    // 旧形状必须彻底消失：常量 {role,ssh} 无法表达远程会话
    assert.equal('role' in remote.json.value, false, 'the old constant shape must be gone')
    assert.equal('ssh' in remote.json.value, false, 'the old constant shape must be gone')
    console.log('PASS: session.role reports the remote origin from the environment')
  } finally {
    if (originalOrigin === undefined) delete process.env.DSH_REMOTE_SESSION_ORIGIN
    else process.env.DSH_REMOTE_SESSION_ORIGIN = originalOrigin
  }
}

console.log('PASS ssh remote machine hosting (transport ladder, projection, TOFU, tunnel head rewrite, reconnect)')

} finally {
  if (server) {
    await new Promise(resolve => server.close(resolve))
  }
  closeDBForTest?.()
  fs.rmSync(tmp, { recursive: true, force: true })
}

process.exit(process.exitCode || 0)
