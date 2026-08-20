import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { once } from 'node:events'

const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'alice-chat-resources-'))
process.env.ALICE_USER_DIR = tempRoot
process.env.ALICE_RESOURCES_DIR = process.cwd()
process.env.ALICE_HOST = '127.0.0.1'

let server = null
let closeDBForTest = null

try {
  const { startAPI } = await import('./api.js')
  const dbModule = await import('./db.js')
  const queueModule = await import('./queue.js')
  const { formatConversationMessage } = await import('./runtime/messages.js')
  const {
    buildPendingResourceInjectorContext,
    mergePendingResourcesIntoConversationWindow,
  } = await import('./chat-resources.js')
  closeDBForTest = dbModule.closeDBForTest
  while (queueModule.popMessage()) {}

  server = startAPI(0)
  await once(server, 'listening')
  const baseUrl = `http://127.0.0.1:${server.address().port}`
  const stageResponse = await fetch(`${baseUrl}/message/resources`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      from_id: 'ID:000001',
      client_id: 'ui-resource-test-client',
      client_message_id: 'resource-test-message-001',
      resources: [
        {
          name: '说明.txt',
          mime: 'text/plain',
          data_url: `data:text/plain;base64,${Buffer.from('hello staged resource', 'utf8').toString('base64')}`,
        },
        {
          name: 'pixel.png',
          mime: 'image/png',
          data_url: 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=',
        },
      ],
    }),
  })
  const staged = await stageResponse.json()
  assert.equal(stageResponse.status, 200, staged.error || 'resource staging failed')
  assert(staged.conversation_id > 0)
  assert.equal(staged.resource_state, 'pending')
  assert.equal(staged.resources.length, 2)
  assert.equal(queueModule.getQueueSnapshot().user, 0, 'dropping resources must not enqueue an Agent turn')

  const db = dbModule.getDB()
  const resourceRow = db.prepare(`
    SELECT * FROM conversations WHERE id = ?
  `).get(staged.conversation_id)
  assert.equal(resourceRow.role, 'user')
  assert.equal(resourceRow.channel, 'RESOURCE')
  assert.equal(resourceRow.resource_state, 'pending')
  const metadata = JSON.parse(resourceRow.resource_metadata)
  assert.equal(metadata.length, 2)
  for (const resource of metadata) {
    assert(resource.path.startsWith('chat-uploads/'))
    assert(fs.existsSync(path.join(tempRoot, 'sandbox', resource.path)))
  }

  const heartbeatTimeline = dbModule.getRecentConversationTimeline(20, 24)
  assert.equal(
    heartbeatTimeline.some(row => row.channel === 'RESOURCE'),
    false,
    'heartbeat history must not see staged resource-only records',
  )

  const downloaded = await fetch(`${baseUrl}${metadata[0].url}`)
  assert.equal(downloaded.status, 200)
  assert.equal(await downloaded.text(), 'hello staged resource')

  const directPrompt = formatConversationMessage(resourceRow, {
    pendingResources: [resourceRow],
  })
  assert.match(directPrompt.content, /current user message is their follow-up instruction/i)
  assert.match(directPrompt.content, /sandbox_path="chat-uploads\//)
  assert.match(buildPendingResourceInjectorContext([resourceRow]), /analyze image content/i)

  const forcedWindow = mergePendingResourcesIntoConversationWindow([
    { id: staged.conversation_id + 1, role: 'user', content: '看看这些内容' },
  ], [resourceRow])
  assert.deepEqual(forcedWindow.map(row => row.id), [staged.conversation_id, staged.conversation_id + 1])

  const instructionResponse = await fetch(`${baseUrl}/message`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      from_id: 'ID:000001',
      channel: 'VOICE',
      client_id: 'ui-resource-test-client',
      client_message_id: 'resource-test-instruction-001',
      content: '看看这些内容并告诉我重点',
    }),
  })
  assert.equal(instructionResponse.status, 200)
  const instruction = await instructionResponse.json()
  assert(instruction.conversation_id > staged.conversation_id)
  assert.equal(queueModule.getQueueSnapshot().user, 1, 'the later voice/text instruction starts the Agent turn')

  const queued = queueModule.popMessage()
  assert.equal(queued.content, '看看这些内容并告诉我重点')
  assert.equal(queued.channel, 'VOICE')
  assert.equal(queued.pendingResources.length, 1)
  assert.equal(queued.pendingResources[0].id, staged.conversation_id)
  assert.equal(dbModule.getPendingConversationResources('ID:000001').length, 0)
  assert.equal(
    db.prepare('SELECT resource_state FROM conversations WHERE id = ?').get(staged.conversation_id).resource_state,
    'consumed',
  )

  const historyResponse = await fetch(`${baseUrl}/conversations?limit=10`)
  const history = await historyResponse.json()
  const historyResource = history.find(row => row.id === staged.conversation_id)
  assert.equal(historyResource.resource_state, 'consumed')
  assert.equal(JSON.parse(historyResource.resource_metadata).length, 2)

  console.log('PASS dropped chat resources persist without processing and join the next text/voice turn')

  // ==========================================================================
  // 打开外链 / 打开目录端点 + 右键菜单覆盖面（移植 dsh-tauri-rightclick，task-5）
  // 并入说明：本段复用上面已经起好的 server 与 baseUrl（**不再起第二个 server**），
  // 复用上面的 tempRoot（不再 mkdtempSync），专属状态一律用 ot* 前缀避免与既有变量撞车
  // （既有已占用：db / staged / resourceRow / metadata / instruction / queued / history /
  //  historyResource 等）。上面第 30-127 行的既有断言一个字未动。
  // ==========================================================================
  const ot = {
    openUrl: '/api/desktop/dsh-tauri-rightclick/open/url',
    openPath: '/api/desktop/dsh-tauri-rightclick/open/path',
    events: [],
    inFlight: 0,
    maxInFlight: 0,
    externalCalls: [],
    pathBehaviour: () => '',
    externalBehaviour: async () => {},
  }
  const otPass = (ms = 25) => new Promise(resolve => setTimeout(resolve, ms))
  const otHost = {
    async openExternal(target) {
      ot.inFlight += 1
      ot.maxInFlight = Math.max(ot.maxInFlight, ot.inFlight)
      ot.events.push(`start:url:${target}`)
      try {
        ot.externalCalls.push(target)
        await ot.externalBehaviour(target)
        await otPass()
        ot.events.push(`end:url:${target}`)
      } finally { ot.inFlight -= 1 }
    },
    async openPath(dir) {
      ot.inFlight += 1
      ot.maxInFlight = Math.max(ot.maxInFlight, ot.inFlight)
      ot.events.push(`start:path:${dir}`)
      try {
        // Electron 的 shell.openPath 契约：resolve 一个字符串，空=成功，非空=错误文本。
        await otPass()
        const result = ot.pathBehaviour(dir)
        ot.events.push(`end:path:${dir}`)
        return result
      } finally { ot.inFlight -= 1 }
    },
  }
  const otPost = (target, { contentType = 'application/json', body = {}, raw = null } = {}) => fetch(target, {
    method: 'POST',
    headers: contentType === null ? {} : { 'Content-Type': contentType },
    body: raw !== null ? raw : JSON.stringify(body),
  })
  const otUrl = `${baseUrl}${ot.openUrl}`
  const otPathUrl = `${baseUrl}${ot.openPath}`
  const { __enqueueDesktopMutationForTest, resetDesktopOpenQueue } = await import('./api/routes/desktop-open.js')

  // ── 队列原语的拒绝容忍（这一节才真正杀掉「失败阻塞后续」的变异）─────────────
  // 端到端那一层证明的是「结果层面」：路由把宿主失败吞成 resolved 的 {ok:false}，
  // 所以 rejection 根本流不到队列。这里直接把 rejection 灌进队列。
  // 每个用例开头都 reset：一个用例留下的拒绝态 tail 会串味到下一个用例，
  // 制造间歇性失败——间歇性失败比失败更糟，会让人不再信任整套测试。
  resetDesktopOpenQueue()
  const otRejectedOnce = __enqueueDesktopMutationForTest(() => Promise.reject(new Error('boom')))
  // 先挂上处理，别让未处理的拒绝炸掉进程。
  await otRejectedOnce.then(() => { throw new Error('the rejected operation must not resolve') }, () => {})
  assert.equal(await __enqueueDesktopMutationForTest(() => 'ok'), 'ok', '一次 reject 之后，队列必须还能继续跑')

  // 连续两次拒绝之后，第三次仍然要能跑
  resetDesktopOpenQueue()
  const otFirstReject = __enqueueDesktopMutationForTest(() => Promise.reject(new Error('boom-1')))
  const otSecondReject = __enqueueDesktopMutationForTest(() => Promise.reject(new Error('boom-2')))
  await otFirstReject.catch(() => {})
  await otSecondReject.catch(() => {})
  assert.equal(await __enqueueDesktopMutationForTest(() => 'still-alive'), 'still-alive',
    '连续两次 reject 之后，队列必须还能继续跑')

  // tail 消毒器：拒绝之后，下一次入队本身**不能**带着前一次的拒绝一起抛
  resetDesktopOpenQueue()
  await __enqueueDesktopMutationForTest(() => Promise.reject(new Error('boom-3'))).catch(() => {})
  assert.equal(await __enqueueDesktopMutationForTest(() => 1), 1, 'tail 必须被消毒成不 reject 的指针')

  // 队列本身仍然是串行的：一个还没落定的操作不能被后面的插队
  resetDesktopOpenQueue()
  const otOrder = []
  const otSlow = __enqueueDesktopMutationForTest(async () => { otOrder.push('slow-start'); await otPass(40); otOrder.push('slow-end'); return 'slow' })
  const otFast = __enqueueDesktopMutationForTest(() => { otOrder.push('fast'); return 'fast' })
  assert.equal(await otFast, 'fast')
  assert.equal(await otSlow, 'slow')
  assert.deepEqual(otOrder, ['slow-start', 'slow-end', 'fast'], '队列必须串行：后一个操作要等前一个落定')
  resetDesktopOpenQueue()

  globalThis.aliceDesktopOpen = otHost

  // ── open/url 成功路径 ────────────────────────────────────────────────────
  let otResponse = await otPost(otUrl, { body: { url: 'https://example.com/a?b=1' } })
  let otPayload = await otResponse.json()
  assert.equal(otResponse.status, 200, `open/url should succeed: ${JSON.stringify(otPayload)}`)
  assert.deepEqual(otPayload, { ok: true })
  assert.deepEqual(ot.externalCalls, ['https://example.com/a?b=1'], 'host must receive the normalized http(s) URL')

  // ── 415：Content-Type 闸（契约第一条）───────────────────────────────────
  ot.externalCalls = []
  otResponse = await otPost(otUrl, { contentType: 'text/plain', raw: JSON.stringify({ url: 'https://example.com/' }) })
  otPayload = await otResponse.json()
  assert.equal(otResponse.status, 415, 'text/plain must be rejected with 415')
  assert.deepEqual(otPayload, { ok: false, error: 'unsupported-media-type' })
  assert.equal(ot.externalCalls.length, 0, 'a rejected Content-Type must never reach the host')

  otResponse = await otPost(otUrl, { contentType: null, raw: JSON.stringify({ url: 'https://example.com/' }) })
  assert.equal(otResponse.status, 415, 'missing Content-Type must be rejected with 415')

  otResponse = await otPost(otUrl, { contentType: 'application/jsonp', raw: '{}' })
  assert.equal(otResponse.status, 415, 'application/jsonp must not pass the Content-Type gate')

  // ── 415 闸不能误伤合法变体 ──────────────────────────────────────────────
  otResponse = await otPost(otPathUrl, { contentType: 'application/json; charset=utf-8', body: { path: tempRoot } })
  assert.equal(otResponse.status, 200, 'application/json; charset=utf-8 must be accepted')
  otResponse = await otPost(otPathUrl, { contentType: 'APPLICATION/JSON', body: { path: tempRoot } })
  assert.equal(otResponse.status, 200, 'Content-Type matching must be case-insensitive')

  // ── open/url 的 safeWebUrl 收敛 ─────────────────────────────────────────
  for (const bad of ['file:///C:/Windows/System32/calc.exe', 'javascript:alert(1)', 'not a url', '', 42, null, undefined]) {
    otResponse = await otPost(otUrl, { body: { url: bad } })
    otPayload = await otResponse.json()
    assert.equal(otResponse.status, 400, `url ${JSON.stringify(bad)} must be 400, got ${otResponse.status}`)
    assert.deepEqual(otPayload, { ok: false, error: 'invalid-url' })
  }
  otResponse = await otPost(otUrl, { raw: '' })
  assert.equal(otResponse.status, 400, 'empty body must be 400 invalid-url')
  otResponse = await otPost(otUrl, { raw: '{not json' })
  assert.equal(otResponse.status, 400, 'malformed JSON must be 400 invalid-url')

  // ── open/url 打开失败 → 500（不是 400）──────────────────────────────────
  ot.externalBehaviour = async () => { throw new Error('no browser configured') }
  otResponse = await otPost(otUrl, { body: { url: 'https://example.com/' } })
  otPayload = await otResponse.json()
  assert.equal(otResponse.status, 500, 'open/url failure must be 500, not 400')
  assert.deepEqual(otPayload, { ok: false, error: 'open-url-failed' })
  ot.externalBehaviour = async () => {}

  // ── open/path 的非法输入 ───────────────────────────────────────────────
  for (const bad of ['', '   ', 'https://example.com/', 'file:///C:/x', 'vscode://open', 42, null]) {
    otResponse = await otPost(otPathUrl, { body: { path: bad } })
    otPayload = await otResponse.json()
    assert.equal(otResponse.status, 400, `path ${JSON.stringify(bad)} must be 400, got ${otResponse.status}`)
    assert.deepEqual(otPayload, { ok: false, error: 'invalid-path' })
  }
  otResponse = await otPost(otPathUrl, { contentType: 'text/plain', raw: '{"path":"C:\\\\x"}' })
  otPayload = await otResponse.json()
  assert.equal(otResponse.status, 415, 'open/path must also enforce the Content-Type gate')
  assert.deepEqual(otPayload, { ok: false, error: 'unsupported-media-type' })

  // ── shell.openPath 返回错误字符串必须判失败（本模块最容易写错的一处）────
  ot.pathBehaviour = () => 'Error: ENOENT: no such file or directory'
  otResponse = await otPost(otPathUrl, { body: { path: path.join(tempRoot, 'does-not-exist') } })
  otPayload = await otResponse.json()
  assert.equal(otResponse.status, 400, 'a non-empty string from shell.openPath means failure => 400')
  // 用中性的 open-path-failed，并把 Electron 的原始原因带回来。
  // 旧代码一律回 not-a-directory，把「路径不存在」「没有关联程序」都谎报成「不是目录」。
  assert.deepEqual(otPayload, { ok: false, error: 'open-path-failed', reason: 'Error: ENOENT: no such file or directory' })

  ot.pathBehaviour = () => ''
  otResponse = await otPost(otPathUrl, { body: { path: tempRoot } })
  otPayload = await otResponse.json()
  assert.equal(otResponse.status, 200, 'an empty string from shell.openPath means success')
  assert.deepEqual(otPayload, { ok: true })

  // ── 串行队列：前一次失败不阻塞后一次 ────────────────────────────────────
  ot.events = []
  ot.inFlight = 0
  ot.maxInFlight = 0
  ot.pathBehaviour = dir => (dir.endsWith('first-fails') ? 'Error: cannot open (simulated)' : '')

  const otFailing = path.join(tempRoot, 'first-fails')
  const otSucceeding = path.join(tempRoot, 'second-succeeds')
  const [otFirstResponse, otSecondResponse] = await Promise.all([
    otPost(otPathUrl, { body: { path: otFailing } }),
    otPost(otPathUrl, { body: { path: otSucceeding } }),
  ])
  const otFirstPayload = await otFirstResponse.json()
  const otSecondPayload = await otSecondResponse.json()

  assert.equal(otFirstResponse.status, 400, 'first open must report the failure')
  assert.deepEqual(otFirstPayload, { ok: false, error: 'open-path-failed', reason: 'Error: cannot open (simulated)' })
  assert.equal(otSecondResponse.status, 200, 'the second open must still succeed after a failed first one')
  assert.deepEqual(otSecondPayload, { ok: true })
  // 顺序证据：第二次的 start 必须晚于第一次的 end —— 既是「串行」，也是「没被卡死」
  assert.deepEqual(ot.events, [
    `start:path:${otFailing}`,
    `end:path:${otFailing}`,
    `start:path:${otSucceeding}`,
    `end:path:${otSucceeding}`,
  ], `mutations must be serialized and the failure must not block the next one; got ${JSON.stringify(ot.events)}`)
  assert.equal(ot.maxInFlight, 1, 'the host must never see two open operations at once')

  // ── 并发压测：队列真的把并发压到 1 ─────────────────────────────────────
  ot.events = []
  ot.inFlight = 0
  ot.maxInFlight = 0
  ot.pathBehaviour = () => ''
  const otBurst = await Promise.all(
    Array.from({ length: 6 }, (_, index) => otPost(otPathUrl, { body: { path: path.join(tempRoot, `burst-${index}`) } })),
  )
  assert.deepEqual(otBurst.map(r => r.status), [200, 200, 200, 200, 200, 200])
  assert.equal(ot.maxInFlight, 1, 'six concurrent requests must still run one at a time')
  assert.equal(ot.events.filter(e => e.startsWith('start:')).length, 6)

  // 开链与开目录共用同一条队列（否则「一次交互拉起多个 OS 打开」照样发生）
  ot.events = []
  ot.inFlight = 0
  ot.maxInFlight = 0
  const otMixed = await Promise.all([
    otPost(otUrl, { body: { url: 'https://example.com/1' } }),
    otPost(otPathUrl, { body: { path: tempRoot } }),
    otPost(otUrl, { body: { url: 'https://example.com/2' } }),
  ])
  assert.deepEqual(otMixed.map(r => r.status), [200, 200, 200])
  assert.equal(ot.maxInFlight, 1, 'open/url and open/path must share the same serial queue')

  // ── 负向：宿主未注入时必须如实失败，不能假装成功 ───────────────────────
  delete globalThis.aliceDesktopOpen
  otResponse = await otPost(otUrl, { body: { url: 'https://example.com/' } })
  otPayload = await otResponse.json()
  assert.equal(otResponse.status, 500, 'without an injected host, open/url must fail — never fake success')
  assert.deepEqual(otPayload, { ok: false, error: 'open-url-failed' })
  otResponse = await otPost(otPathUrl, { body: { path: tempRoot } })
  otPayload = await otResponse.json()
  assert.equal(otResponse.status, 400, 'without an injected host, open/path must fail — never fake success')
  // **「宿主没挂上」和「这个路径不是目录」必须是两个错误码。**
  // 旧代码这里回 not-a-directory：拿一个真实存在的目录去打，会收到「不是目录」，
  // 把人往「路径校验写错了」的方向带 —— 而真相是进程里没有 Electron 宿主。
  // 注意这里传的 tempRoot 是**确实存在的目录**，正是为了让「谎报成 not-a-directory」不可能蒙对。
  assert.deepEqual(otPayload, { ok: false, error: 'desktop-open-unavailable' })
  assert.notDeepEqual(otPayload, { ok: false, error: 'not-a-directory' },
    'a missing host must never be reported as "not a directory"')
  globalThis.aliceDesktopOpen = otHost

  // ── 同一件事的两份实现必须用同一套判据（2026-10-01）───────────────────
  // HTTP 出口用 safeWebUrl（new URL + 严格比对 protocol）；
  // IPC 出口（electron/main.cjs 的 safeExternalUrl）**曾经**用前缀正则 /^https?:\/\//i，
  // 结果放行了一批畸形输入：`https://a b`、`https://exa mple.com`、`http://`（空主机）、
  // `http://[]`（非法主机）—— 全部通过前缀判断后被交给 shell.openExternal。
  // 这与 not-a-directory 是同型问题：逻辑复制之后两份实现各自漂移。
  for (const malformed of ['https://a b', 'https://exa mple.com', 'http://', 'https://', 'http://[]']) {
    otResponse = await otPost(otUrl, { body: { url: malformed } })
    otPayload = await otResponse.json()
    assert.equal(otResponse.status, 400, `malformed url must be rejected: ${JSON.stringify(malformed)}`)
    assert.deepEqual(otPayload, { ok: false, error: 'invalid-url' },
      `malformed url must not reach the OS: ${JSON.stringify(malformed)}`)
  }
  // 反过来，单斜杠的宽容写法 new URL 会归一化成合法地址，允许（与 IPC 侧对齐后行为一致）。
  otResponse = await otPost(otUrl, { body: { url: 'http:/x' } })
  assert.equal(otResponse.status, 200, 'http:/x is normalised by new URL into a valid href')
  // 两个出口的校验必须同时存在 —— 只改一处会留下更弱的孪生实现。
  const otMainSource = fs.readFileSync(path.join(process.cwd(), 'electron/main.cjs'), 'utf8')
  assert.match(otMainSource, /function safeExternalUrl\(value\)/,
    'the IPC exit must validate URLs by parsing, not by a prefix regex')
  assert.doesNotMatch(otMainSource, /DESKTOP_OPEN_URL_SCHEME/,
    'the weak prefix regex must be gone for good — a leftover copy is how this drifts back')

  // ── 第四个 openExternal 出口：setWindowOpenHandler（2026-10-01）──────────
  // 这是**我上一轮漏掉的那一个**。我当时修了 IPC 与 HTTP 两个出口，
  // 却没注意到同一个文件、相隔 800 行的 setWindowOpenHandler 里
  // 还有一条同款弱正则 —— 而且它**没有任何下游校验**：
  // 判断通过就 `shell.openExternal(url)`，原始 URL 一行不停送到操作系统。
  // 另外三个出口后面都跟着 safeExternalUrl / new URL()，弱正则只是"第一道"。
  //
  // **修的边界应该是"它到底有几份"，不是"我搜到哪儿"。**
  {
    const otHandler = /setWindowOpenHandler\(\(\{ url \}\) => \{[\s\S]*?\n  \}\)/.exec(otMainSource)
    assert.ok(otHandler, 'setWindowOpenHandler must be present and extractable')
    const otHandlerCode = otHandler[0]
    assert.match(otHandlerCode, /safeExternalUrl\(url\)/,
      'the window-open exit must go through safeExternalUrl like the other three exits')
    assert.ok(!otHandlerCode.includes('https?:\\/\\/'),
      'the window-open exit must not keep the weak prefix regex (it has NO downstream check)')
    // **不再返回 action:"allow"**：放行会让 Electron 在应用内新开窗口加载这个 URL。
    // 判定它可疑之后，就不该给它任何一条加载路径。
    assert.ok(!/action:\s*'allow'/.test(otHandlerCode) && !/action:\s*"allow"/.test(otHandlerCode),
      'a URL that fails validation must not be given an in-app load path either')
    assert.match(otHandlerCode, /action:\s*'deny'/,
      'every branch must deny in-app navigation')
    // openExternal 返回 Promise —— 不 catch 会变成未捕获拒绝冒到主进程。
    assert.match(otHandlerCode, /\.catch\(/,
      'the openExternal promise must be caught, or it becomes an unhandled rejection')
  }

  // ── 全仓不得再有"弱 URL 前缀正则"落在**安全出口**上 ──────────────────────
  // 允许保留的只有**非边界**用途（显示/选择/补全，或后面紧跟 new URL()）。
  // 这里逐个钉住那些已确认安全的站点，防止其中任何一个被改成真正的出口。
  for (const [file, marker] of [
    ['src/runtime/action-contract.js', 'new URL(/^https?:\\/\\//i.test(raw) ? raw : `https://${raw}`).toString()'],
  ]) {
    const src = fs.readFileSync(path.join(process.cwd(), file), 'utf8')
    assert.ok(src.includes(marker),
      `${file} must keep wrapping the weak test in new URL() — that parse is what makes it safe`)
  }

  // ── 非 POST 不归本路由管 ───────────────────────────────────────────────
  otResponse = await fetch(otUrl, { method: 'GET' })
  assert.equal(otResponse.status, 404, 'GET on an open endpoint must fall through to 404')

  // ── 前端：标记与事件绑定存在（**不证明渲染正确**，无浏览器）────────────
  const otChatSource = fs.readFileSync(path.join(process.cwd(), 'src/ui/brain-ui/chat.js'), 'utf8')
  const otCssSource = fs.readFileSync(path.join(process.cwd(), 'src/ui/brain-ui/styles.css'), 'utf8')

  assert.match(otChatSource, /chatMessages\?\.addEventListener\("contextmenu"/,
    'the conversation transcript must have a contextmenu listener')
  assert.match(otChatSource, /closestChatLink/,
    'links inside the transcript must be routed to the link menu')
  assert.match(otChatSource, /\/api\/desktop\/dsh-tauri-rightclick\/open\/url/,
    'the link menu must open links through the new endpoint')
  assert.match(otChatSource, /function placeContextMenu/, 'positioning must be shared, not re-implemented per menu')
  assert.match(otChatSource, /ensureContextMenu/, 'new menus must reuse the existing .composer-context-menu rendering')
  assert.doesNotMatch(otChatSource, /openFolderNatively/, 'no dangling reference to an unimplemented folder action')

  // ── 客户端 URL 判据必须与服务端**同一套**（2026-10-01 修正）───────────────────
  // 这儿原先用 `/^https?:\/\//i` —— 与我在 main.cjs / desktop-open.js 删掉的是同一条
  // 弱正则（问题 5 的第三次副本）。实测它与服务端 `new URL()` 在 6 个输入上分歧：
  //   https://a b / https://exa mple.com / http:// / https:// / http://[] / https://\u0000x
  // 前端全放行、服务端全拒。
  //
  // ⚠️ 断言必须**先去掉注释**再匹配：我在修正处写了说明性注释，
  //    里面逐字引用了那条旧正则，naive 的 doesNotMatch 会打到自己的注释上（假红）。
  // ⚠️ 去注释这一步本身就是个陷阱，记下踩过的坑：
  //   1) 我在修正处写了说明性注释，里面**逐字引用**了那条旧正则 ——
  //      naive 的 doesNotMatch 会打到自己的注释上（假红）。
  //   2) 第一版行注释规则 `(^|[^:])//[^\n]*` 会把 `https?:\/\//i` 里的 `//` 当注释头
  //      （它前面是 `\` 而不是 `:`），把**真代码**删掉 —— 于是变异 A 存活。
  //      必须同时排除 `://` 与 `\/\/` 两种情形。
  const otChatCode = otChatSource
    .replace(/\/\*[\s\S]*?\*\//g, '')          // 块注释
    .replace(/(^|[^:\\])\/\/[^\n]*/g, '$1')    // 行注释：前面既不是 : 也不是 \ 才算
  // 用**字面串**而不是正则：`/^https?:\/\//i` 在文件里就是 `https?:\/\/`
  //   （每个 / 前一个反斜杠）。写成正则要 `\\\/`，极易多转义一层导致断言恒真。
  assert.ok(!otChatCode.includes('https?:\\/\\/'),
    'the client must not keep the weak prefix regex — it diverges from the server on 6 inputs')
  assert.match(otChatCode, /function isSafeWebUrl/,
    'the client must validate with the same criterion as the server (new URL + protocol)')
  assert.match(otChatCode, /const parsed = new URL\(value\)/,
    'isSafeWebUrl must use new URL(), not a prefix test')
  assert.match(otChatCode, /parsed\.protocol === "http:" \|\| parsed\.protocol === "https:"/,
    'only http/https must pass')

  // **业务拒绝 ≠ 传输失败**：服务端拿到请求但回了 !ok（例如 400 invalid-url）时，
  // 不该再去试 IPC 兜底 —— 那是用一条更弱的路绕开一个明确的裁决。
  // 这与 SSH 的 "businessFailure returns HTTP 200 so business errors are not
  // read as transport errors" 是同一条原则。
  assert.match(otChatCode, /if \(verdict === "rejected"\) return false;/,
    'a server rejection must be final, not treated as an unreachable endpoint')
  assert.match(otChatCode, /verdict = "rejected"/,
    'a response with ok:false must be classified as a rejection')
  assert.match(otChatCode, /catch \{\s*verdict = "unreachable";\s*\}/,
    'only a thrown fetch must be classified as unreachable')

  // isSafeWebUrl 的行为（不只是存在）：直接执行它，与服务端判据逐输入比对。
  // 只做源码匹配的话，"函数在但判据写错"会漏过去。
  {
    const otFnMatch = /function isSafeWebUrl\(rawUrl\) \{[\s\S]*?\n  \}/.exec(otChatCode)
    assert.ok(otFnMatch, 'isSafeWebUrl must be extractable from the source')
    const otIsSafeWebUrl = new Function('return ' + otFnMatch[0])()
    const otCases = [
      'https://example.com', 'http://example.com', 'HTTPS://OK.COM', '  https://ok.com  ',
      'https://a b', 'https://exa mple.com', 'http://', 'https://', 'http://[]',
      'https://\u0000x', 'javascript:alert(1)', 'file:///C:/x', 'data:text/html,x', '',
    ]
    for (const otUrl of otCases) {
      const otMine = otIsSafeWebUrl(otUrl)
      let otServer = false
      try {
        const p = new URL(String(otUrl || '').trim())
        otServer = p.protocol === 'http:' || p.protocol === 'https:'
      } catch { otServer = false }
      assert.strictEqual(otMine, otServer,
        `client/server URL verdict diverged for ${JSON.stringify(otUrl)}: client=${otMine} server=${otServer}`)
    }
  }

  assert.match(otCssSource, /\.composer-context-menu \.context-menu-separator/,
    'the separator used by the new menus must be styled')

  // 菜单文案必须成对存在于两个 locale（t() 写错键会静默返回键名）
  const otZh = (await import('./ui/brain-ui/i18n/locales/zh-CN.js')).default
  const otEn = (await import('./ui/brain-ui/i18n/locales/en-US.js')).default
  const otUsedKeys = [...otChatSource.matchAll(/t\("(ctxMenu\.[A-Za-z0-9_]+)"\)/g)].map(m => m[1])
  assert(otUsedKeys.length >= 4, `expected the new menus to use i18n keys, found ${otUsedKeys.length}`)
  for (const key of new Set(otUsedKeys)) {
    assert.ok(Object.prototype.hasOwnProperty.call(otZh, key), `zh-CN is missing ${key}`)
    assert.ok(Object.prototype.hasOwnProperty.call(otEn, key), `en-US is missing ${key}`)
    assert.notEqual(otEn[key], key, `${key} must be translated in en-US, not fall back to the key name`)
  }
  assert.deepEqual(
    Object.keys(otZh).sort().filter(key => !(key in otEn)),
    [],
    'zh-CN and en-US must stay key-paired',
  )

  // ── 归档接线（2026-10-01）：前端必须调用真实归档端点，且文案不得再声称「后端没有归档概念」
  //    **只断言源码标记与端点契约，不证明渲染正确**（无浏览器）。
  const otWsSource = fs.readFileSync(path.join(process.cwd(), 'src/ui/brain-ui/workspace-embed.html'), 'utf8')
  assert.match(otWsSource, /persist\('\/session\/archive'/,
    'the archive menu action must call the real POST /session/archive endpoint')
  assert.match(otWsSource, /apiFetch\('\/session\/archive'\)/,
    'the session list must load the archive ledger so archived items stay hidden after refresh')
  // 归档现在是后端持久状态：刷新后必须仍隐藏。要隐藏就得在装载时过滤 ledger。
  assert.match(otWsSource, /realSessions\.filter\(function\(s\)\{ return !drop\[s\.id\]; \}\)/,
    'archived sessions must be filtered out of the assembled list')
  // 旧文案的前提（后端无归档概念）已不成立，必须消失
  assert.doesNotMatch(otWsSource, /后端没有「归档」概念/,
    'the stale "backend has no archive concept" note must be gone now that the endpoint exists')
  assert.doesNotMatch(otWsSource, /仅本页隐藏/,
    'the label must no longer claim archive is a page-local hide')
  assert.doesNotMatch(otWsSource, /后端没有归档概念，刷新后原样回来/,
    'the old toast claimed the item returns after refresh, which is now false')

  // 真实端点契约：归档 key 是 (渠道×自然日) 视图键，装载时用它过滤，形状必须对得上
  const otLedger = await fetch(`${baseUrl}/session/archive`, { headers: { Accept: 'application/json' } })
  assert.equal(otLedger.status, 200, 'GET /session/archive must answer 200')
  const otLedgerBody = await otLedger.json()
  assert.ok(Array.isArray(otLedgerBody.archivedSessionIds),
    'the ledger must expose archivedSessionIds as an array for the UI to filter on')
  assert.equal(typeof otLedgerBody.meta, 'object', 'the ledger must expose meta')

  // ── 移植能力入口区（2026-10-01）：浮框里三个入口必须真的接到后端/宿主
  assert.match(otWsSource, /aria-label="移植能力"/,
    'the sidebar must carry a 移植能力 section below 定时任务 / 扩展技能')
  assert.match(otWsSource, /id="fnPortBody"/, 'the section body must be the fnPortBody container')
  assert.match(otWsSource, /fnPortBody\.innerHTML = fnPortHTML\(\)/,
    'the section must be re-rendered together with the other fn sections')
  // 必须是**在 renderFnSections 里被调用**，而不只是「文件里出现过 bindFnPorts 这个名字」——
  // 只匹配名字的话，连函数定义本身都能让断言通过（变异测试抓到过这个假绿）。
  assert.match(otWsSource, /fnPortBody\.innerHTML = fnPortHTML\(\); fnPortBody\.scrollTop = sp; \}\n  fnSchedBody\.scrollTop = st; fnSkillBody\.scrollTop = sk;[\s\S]{0,120}?bindFnPorts\(\);/,
    'its rows must actually be bound inside renderFnSections')
  assert.match(otWsSource, /\.fn-row\[data-fn-port\]\{cursor:pointer\}/,
    'clickable port rows need the same pointer affordance as skill rows')
  // 三个入口各自的效果：SSH 打 /api-ssh、归档打 /session/archive、桌宠走 preload 桥
  assert.match(otWsSource, /sshCall\('machine\.list'\)/, 'the SSH entry must actually list machines')
  // machine.list 的契约形状是 **{enabled, items, discovered}**，不是裸数组。
  // 浮框原先写 `value.machines || value.list || value` 三重猜测 —— 当时"能用"纯属侥幸
  // （后端恰好返回裸数组，最后一个猜测命中）。后端改成契约形状后，猜测链会静默取到空列表，
  // 界面显示"还没有添加任何机器"——**机器明明在，却报没有**。
  // 这里同时钉住两侧：浮框必须按 items 取，且不得再留猜形状的兜底。
  assert.match(otWsSource, /Array\.isArray\(value\.items\)/,
    'the SSH entry must read the contract field `items`, not guess the shape')
  // 注意正则要锚在**可执行代码**上：第一次写的是 /value\.machines \|\| value\.list/，
  // 结果匹配到了我自己那条「原先写的是 value.machines || value.list」的说明注释 ——
  // **假红**。断言必须指向代码本身，不能指向描述代码的文字。
  assert.doesNotMatch(otWsSource, /const\s+list\s*=\s*\(?\s*value\s*&&\s*\(\s*value\.machines/,
    'guessing the response shape must be gone: it hides a wrong shape as an empty list')
  assert.match(otWsSource, /接口返回的形状不认识/,
    'an unrecognised shape must be reported, never silently treated as empty')
  assert.match(otWsSource, /JSON\.stringify\(\{ method: method, payload: payload \|\| \{\} \}\)/,
    'the SSH entry must post the real {method,payload} envelope')
  assert.match(otWsSource, /env\.value !== undefined \? env\.value : env/,
    'the SSH response field is `value` (success() returns {ok:true,value}), not `result`')
  assert.match(otWsSource, /pet\.getStatus\(\)/, 'the pet entry must read real preload state')
  assert.match(otWsSource, /pet\.setEnabled\(/, 'the pet entry must toggle through the real bridge')
  assert.doesNotMatch(otWsSource, /pet\.(getPreferences|setPreferences)\s*\(/,
    'preload exposes getStatus/setEnabled — getPreferences is not a method on the pet bridge')
  // 拿不到能力时必须如实说，不假装成功
  assert.match(otWsSource, /桌宠不可用：当前外壳没有暴露 pet 接口/,
    'a missing pet bridge must be reported honestly')
  assert.match(otWsSource, /远程机器接口不可用：/, 'a failing SSH call must be reported honestly')

  // ── 入口的 desc 是**给用户的承诺**，必须与点击后真的发生的事一致 ──────────────
  // SSH 那行原先 desc 写着「连接 / 隧道 / TOFU」，而点击后**只报台数** ——
  // 文案承诺的三件事一件都没做（后端 13 个方法，本区只调了 1 个）。
  // **一个描述与行为不符的入口，比不列这个入口更糟**：用户以为点了会连接。
  assert.match(otWsSource, /sshCall\('machine\.connect'/,
    'the SSH entry must actually attempt a connection, not just count machines')
  assert.match(otWsSource, /machineId: first\.id/,
    'machine.connect takes a machineId (the key is machineId, not id)')
  assert.match(otWsSource, /连接结果：/,
    'a successful connect must report the real state, not a generic success message')
  assert.match(otWsSource, /连接失败：/,
    'a failed connect must surface the real failure classification')
  assert.doesNotMatch(otWsSource, /desc:'连接 \/ 隧道 \/ TOFU'/,
    'the desc must not promise connect/tunnel/TOFU when the handler only counted machines')

  // 归档入口同理：desc 写着「查看 / 取消归档」，那就必须真的调 restore。
  // 原先后端 5 个 /session/* 端点、前端只用了 1 个（GET /session/archive）——
  // **`POST /session/archive/restore` 从来没被调用过**，desc 的后半句是假的。
  assert.match(otWsSource, /call\('\/session\/archive\/restore'/,
    'the archive entry must actually call restore — its desc promises 取消归档')
  assert.match(otWsSource, /body: JSON\.stringify\(\{ sessionId: latest \}\)/,
    'restore takes { sessionId }, the same key as archive')
  // 恢复的必须是**最新归档的那一条**：列表按 archived_at 升序，所以取末尾。
  // 取 [0] 会去恢复最早的一条 —— 那与"取消我刚归档的那个"的直觉不符，
  // 而且用户看到的是"最近：X"的提示，恢复 Y 会让提示与行为矛盾。
  assert.match(otWsSource, /const latest = archivedIds\[archivedIds\.length - 1\]/,
    'restore must pick the most recently archived entry (the list is ascending by archived_at)')
  assert.match(otWsSource, /已取消归档「/,
    'a successful restore must confirm which entry was restored')
  assert.match(otWsSource, /取消归档「.*」失败：/,
    'a failed restore must say WHICH entry failed, or the user cannot tell if data changed')

  // 每条入口的 desc 都不能是空话：三个 id 与三种行为一一对应
  for (const [id, marker] of [
    ['ssh', "openPortPanel('ssh')"],
    ['archive', "openPortPanel('archive')"],
    ['pet', 'togglePetFromPanel()'],
  ]) {
    assert.match(otWsSource, new RegExp(`if \\(id === '${id}'\\) return ${marker.replace(/[()]/g, '\\$&')}`),
      `the "${id}" entry must dispatch to ${marker}`)
  }

  // 桌宠入口：desc 是「显示 / 隐藏」，走的必须是 getStatus + setEnabled 这对真方法。
  // 另：setEnabled 在**建不出窗口时会抛错**（createWindow 里 require('electron') 拿不到
  // screen），浮框的 .catch 因此会如实报「桌宠操作失败」而不是谎报「已显示」——
  // 这条由行为测试覆盖（见 test-action-contract 的 IPC 段），这里只钉住错误分支存在。
  assert.match(otWsSource, /桌宠操作失败：/, 'a failed pet toggle must be reported, not swallowed')

  // 本段专属：清理注入了的宿主（只能就地删，finally 只有一个且属于上面那段）
  delete globalThis.aliceDesktopOpen

  console.log('PASS open/url + open/path endpoints (415 / 400 / 500 / serial queue / openPath error string)')
} catch (err) {
  /* 断言失败必须**干净地失败**：打印原因、置退出码 1。
     如果让它继续冒泡，异常会穿过 finally，而残留句柄（DB / socket）让事件循环
     不空，末尾的 process.exit() 永远执行不到 —— 测试表现成「卡死」而不是「失败」。
     一个把失败伪装成挂起的测试，比没有这个测试更糟：它会让人以为环境慢。 */
  console.error('FAIL chat-resources: ' + (err && err.message ? err.message : err))
  process.exitCode = 1
} finally {
  /* 收尾必须**有界且不吞异常**。
     两个坑都要防：
      ① `server.close(resolve)` 会等 socket 排空，keep-alive 连接不自己关 →
         await 永不 resolve（已用 closeAllConnections + 超时兜底解决）；
      ② 更隐蔽的：断言失败抛出后，**异常会穿过 finally 继续冒泡**，此时若还有
         未关闭的句柄（DB、socket），Node 的事件循环就不会空，`process.exit()`
         那行再也执行不到 —— 故障表现成「测试卡死」而不是「测试失败」，极难查。
     所以在 finally 里显式设定退出码，并在收尾完成后强制退出。 */
  if (server) {
    try { server.closeAllConnections?.() } catch { /* 老版本没有这个方法 */ }
    await new Promise(resolve => {
      const timer = setTimeout(resolve, 2000)
      server.close(() => { clearTimeout(timer); resolve() })
    })
  }
  try { closeDBForTest?.() } catch { /* 关库失败不该掩盖断言失败 */ }
  try { fs.rmSync(tempRoot, { recursive: true, force: true }) } catch { /* 同上 */ }
}

process.exit(process.exitCode || 0)
