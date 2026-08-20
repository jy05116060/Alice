import assert from 'node:assert/strict'
import crypto from 'node:crypto'

// GitHub webhook 的 HTTP 层端到端测试（阶段 6.4）。需要数据库（config/queue/events）：
//   npm run test:github-webhook-http
// 纯逻辑（签名、摘要、清洗、过滤、投喂文本）在 test-github-webhook.js，那边不需要数据库。
//
// 这里**真走一遍真实的 handleGithubWebhookRoutes**，而不是只测它调用的纯函数：
// 这一层承载的是「未启用就不收」「签名不对就拒」「未订阅不唤醒模型」这三条安全语义，
// 而它们都只体现在状态码与是否入队上——纯函数测试看不到。
const SECRET = 'e2e-secret'

const { handleGithubWebhookRoutes } = await import('./api/routes/github.js')
const { config } = await import('./config.js')
const { addEventListener } = await import('./events.js')
const { getQueueSnapshot, popMessage } = await import('./queue.js')

const original = { enabled: config.github.enabled, secret: config.github.secret, events: [...(config.github.events || [])] }
const events = []
const off = addEventListener((type, data) => events.push({ type, data }))

/** 造一个够用的假 req/res：data/end 用 setImmediate 异步触发，模拟真实流。 */
async function call({ method = 'POST', body = '', headers = {}, pathname = '/webhook/github' } = {}) {
  const buf = Buffer.isBuffer(body) ? body : Buffer.from(body, 'utf8')
  let status = null
  let payload = null
  const res = {
    writeHead(code) { status = code },
    setHeader() {},
    end(chunk) { payload = chunk ? JSON.parse(chunk) : null },
  }
  const handlers = {}
  const req = {
    method,
    headers,
    on(event, handler) {
      handlers[event] = handler
      if (event === 'end') {
        setImmediate(() => {
          if (buf.length && handlers.data) handlers.data(buf)
          handlers.end()
        })
      }
    },
    destroy() {},
  }
  const handled = await handleGithubWebhookRoutes(req, res, new URL(`http://127.0.0.1:3000${pathname}`))
  await new Promise(r => setTimeout(r, 20)) // 等入队
  return { handled, status, payload }
}

try {
  // ① 默认关闭 → 503，且绝不能入队
  config.github.enabled = false
  const disabled = await call({ body: '{}' })
  assert.equal(disabled.status, 503)
  assert.equal(disabled.payload.code, 'NOT_ENABLED')
  assert.equal(getQueueSnapshot().background, 0, '未启用时不能把任何东西塞进队列')

  // ② 启用但没密钥 → 也必须拒（拒绝接受无法验证的投递）
  config.github.enabled = true
  config.github.secret = ''
  const noSecret = await call({ body: '{}', headers: { 'x-github-event': 'push' } })
  assert.equal(noSecret.status, 503)
  assert.equal(noSecret.payload.code, 'NO_SECRET')
  assert.equal(getQueueSnapshot().background, 0)

  // ③ 配上密钥：签名错 → 401，且留下一条可查的拒绝事件
  config.github.secret = SECRET
  const body = JSON.stringify({
    repository: { full_name: 'me/repo' },
    sender: { login: 'alice' },
    ref: 'refs/heads/main',
    commits: [{ id: 'abc123', message: 'fix: 修了一处', author: { name: 'Alice' } }],
  })
  const goodSig = `sha256=${crypto.createHmac('sha256', SECRET).update(Buffer.from(body, 'utf8')).digest('hex')}`

  const badSig = await call({
    body,
    headers: { 'x-github-event': 'push', 'x-hub-signature-256': `sha256=${'0'.repeat(64)}` },
  })
  assert.equal(badSig.status, 401)
  assert.equal(badSig.payload.code, 'BAD_SIGNATURE')
  assert.ok(events.some(e => e.type === 'github_webhook_rejected'), '拒绝要留下可查记录，否则用户只会以为是配置错')

  // ④ 缺 x-github-event → 400（签名是对的，但少了事件类型，没法判断该不该处理）
  const noEventHeader = await call({ body, headers: { 'x-hub-signature-256': goodSig } })
  assert.equal(noEventHeader.status, 400)
  assert.equal(noEventHeader.payload.code, 'EVENT_HEADER_MISSING')

  // ⑤ 未订阅事件（star）→ 202 ignored，但**不唤醒模型**
  const ignored = await call({ body, headers: { 'x-github-event': 'star', 'x-hub-signature-256': goodSig } })
  assert.equal(ignored.status, 202, '要回 202 而不是错误码，否则 GitHub 会按失败重投')
  assert.equal(ignored.payload.ignored, true)
  assert.equal(getQueueSnapshot().background, 0, '未订阅就不要把模型叫起来')

  // ⑥ 订阅事件 + 正确签名 → 202 且入队（完整验证一遍投喂内容）
  const accepted = await call({
    body,
    headers: {
      'x-github-event': 'push',
      'x-hub-signature-256': goodSig,
      'x-github-delivery': 'delivery-abc',
    },
  })
  assert.equal(accepted.status, 202)
  assert.equal(accepted.payload.ok, true)
  assert.ok(accepted.payload.summary.includes('push to main'), accepted.payload.summary)
  assert.ok(getQueueSnapshot().background >= 1, '订阅事件必须入队')

  const queued = popMessage()
  assert.equal(queued?.fromId, 'SYSTEM', '来源是系统，不是某个用户')
  assert.equal(queued?.queueName, 'background', '后台队列——不该插到用户对话前面')
  assert.match(queued.content, /not instructions from the user/i, '必须声明这不是用户的话')
  assert.match(queued.content, /<github-data>/, '外部数据要夹在定界标记里')
  assert.match(queued.content, /<\/github-data>/)
  assert.equal(queued.githubEvent.event, 'push')
  assert.equal(queued.githubEvent.repo, 'me/repo')
  assert.equal(queued.githubEvent.delivery, 'delivery-abc')
  assert.ok(events.some(e => e.type === 'github_webhook_received'))

  // ⑦ 非 POST → 405；其他路径不认领
  assert.equal((await call({ method: 'GET' })).status, 405)
  assert.equal((await call({ pathname: '/other' })).handled, false)

  // ⑧ 事件过滤可配置：把 push 去掉之后同一个请求应变成 ignored
  config.github.events = ['issues']
  const filtered = await call({ body, headers: { 'x-github-event': 'push', 'x-hub-signature-256': goodSig } })
  assert.equal(filtered.payload.ignored, true, '自定义订阅列表要真的生效')

  console.log('PASS github-webhook-http: 19 checks over real routing — disabled/no-secret/bad-signature/ignored/accepted paths and the queued payload shape')
} finally {
  off()
  config.github.enabled = original.enabled
  config.github.secret = original.secret
  config.github.events = original.events
}
