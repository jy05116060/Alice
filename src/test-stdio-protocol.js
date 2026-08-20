import assert from 'node:assert/strict'

// stdio 协议层（阶段 6.6 最小子集）测试。纯函数，不需要数据库也不需要真跑模型：
//   npm run test-stdio-protocol
// 端到端（真起进程跑一轮）需要模型凭据，属于冒烟测试，不放在这里。
const {
  ERROR_CODES,
  METHODS,
  PROTOCOL_VERSION,
  buildError,
  buildResult,
  capabilityManifest,
  encodeMessage,
  packageRunResult,
  parseRequestLine,
  validateRunParams,
} = await import('./runtime/stdio-protocol.js')

// ACP 那一层（阶段 6.6 补齐）：纯逻辑，注入一个确定性后端即可离线测。
// 端到端（真起进程、真 stdin/stdout、真模型）不在这个文件里——它需要凭据，
// 属于冒烟测试；这里测的是协议本身会不会说错话。
const {
  ACP_ERRORS,
  ACP_PROTOCOL_VERSION,
  AcpServer,
  SessionStore,
  buildAgentMessageChunk,
  buildAgentThoughtChunk,
  buildErrorResponse,
  buildResponse,
  chunkText,
  composeTurnTask,
  describeAuthLevel,
  extractBearer,
  extractToken,
  parseJsonRpcLine,
  tokenMatches,
  // 注意别名：capabilityManifest 这个短名字已经被上面的旧协议实现占了，
  // 直接重名会把第 5 节的断言悄悄改成在测 ACP——那种「测试还在过但测的不是原来那东西」
  // 是最难发现的一类退化。
  capabilityManifest: acpCapabilityManifest,
} = await import('./runtime/acp-protocol.js')

try {
  // ── 1. 请求解析：正常与各类畸形 ───────────────────────────────────────
  {
    const ok = parseRequestLine('{"id":1,"method":"ping"}')
    assert.equal(ok.ok, true)
    assert.equal(ok.request.id, 1)
    assert.equal(ok.request.method, 'ping')
    assert.deepEqual(ok.request.params, {})

    // id 可以是字符串或数字，原样回传
    assert.equal(parseRequestLine('{"id":"abc","method":"ping"}').request.id, 'abc')
    // 缺 id：接受（回 null），不因为缺 id 就丢弃请求——那会让调用方只看到「没有响应」
    assert.equal(parseRequestLine('{"method":"ping"}').request.id, null)
    assert.equal(parseRequestLine('{"id":null,"method":"ping"}').request.id, null)
    // params 不是对象时退回 {}
    assert.deepEqual(parseRequestLine('{"id":1,"method":"ping","params":"x"}').request.params, {})

    // 空行
    assert.equal(parseRequestLine('').code, ERROR_CODES.INVALID_REQUEST)
    assert.equal(parseRequestLine('   ').code, ERROR_CODES.INVALID_REQUEST)
    // 坏 JSON
    assert.equal(parseRequestLine('{nope').code, ERROR_CODES.PARSE_ERROR)
    // 不是对象
    assert.equal(parseRequestLine('[1,2]').code, ERROR_CODES.INVALID_REQUEST)
    assert.equal(parseRequestLine('"str"').code, ERROR_CODES.INVALID_REQUEST)
    assert.equal(parseRequestLine('42').code, ERROR_CODES.INVALID_REQUEST)
    // 缺 method / 未知 method
    assert.equal(parseRequestLine('{"id":1}').code, ERROR_CODES.INVALID_REQUEST)
    assert.equal(parseRequestLine('{"id":1,"method":""}').code, ERROR_CODES.INVALID_REQUEST)
    const unknown = parseRequestLine('{"id":7,"method":"destroy"}')
    assert.equal(unknown.code, ERROR_CODES.METHOD_NOT_FOUND)
    assert.equal(unknown.id, 7, '未知方法时也要能回传 id，调用方才对得上')
    assert.ok(/supported/.test(unknown.message), '要说清支持哪些方法')

    // 超长行拒绝（避免一个请求把内存吃光）
    const huge = `{"id":1,"method":"ping","params":{"x":"${'y'.repeat(1024 * 1024 + 10)}"}}`
    assert.equal(parseRequestLine(huge).code, ERROR_CODES.INVALID_REQUEST)

    assert.deepEqual(METHODS, ['ping', 'capabilities', 'run'])
  }

  // ── 2. run 参数校验 ───────────────────────────────────────────────────
  {
    const ok = validateRunParams({ task: '  你好  ' })
    assert.equal(ok.ok, true)
    assert.equal(ok.value.task, '你好', '任务要 trim')
    assert.equal(ok.value.freshSession, true, '默认全新会话（不污染用户对话）')
    assert.equal(ok.value.timeoutMs, 300_000)

    // 显式关掉全新会话
    assert.equal(validateRunParams({ task: 'x', fresh_session: false }).value.freshSession, false)
    // 只有明确的 false 才算关；其它值都按默认开
    assert.equal(validateRunParams({ task: 'x', fresh_session: 0 }).value.freshSession, true)

    // 超时：合法值保留，非法值退回默认（不因为参数写错就拒绝整个请求）
    assert.equal(validateRunParams({ task: 'x', timeout_ms: 5000 }).value.timeoutMs, 5000)
    assert.equal(validateRunParams({ task: 'x', timeout_ms: 10 }).value.timeoutMs, 300_000, '低于下限退回默认')
    assert.equal(validateRunParams({ task: 'x', timeout_ms: 'soon' }).value.timeoutMs, 300_000)

    // 任务必填
    for (const params of [{}, { task: '' }, { task: '   ' }, { task: 42 }, { task: null }]) {
      const bad = validateRunParams(params)
      assert.equal(bad.ok, false, `${JSON.stringify(params)} 应被拒`)
      assert.equal(bad.code, ERROR_CODES.INVALID_PARAMS)
    }
    // 超长任务
    assert.equal(validateRunParams({ task: 'x'.repeat(100_001) }).code, ERROR_CODES.INVALID_PARAMS)
  }

  // ── 3. 响应构造 ───────────────────────────────────────────────────────
  {
    assert.deepEqual(buildResult(1, { pong: true }), { id: 1, result: { pong: true } })
    assert.deepEqual(buildResult(null, {}), { id: null, result: {} })
    const err = buildError(2, 'X', 'boom')
    assert.deepEqual(err, { id: 2, error: { code: 'X', message: 'boom' } })
    assert.equal(buildError(2, 'X', 'boom', { a: 1 }).error.detail.a, 1)
    assert.equal(buildError(2, 'X', 'boom').error.detail, undefined, '没有 detail 时不该出现该字段')

    // 一行一条：编码结果里不能有换行（否则协议会错位）
    const line = encodeMessage(buildResult(1, { answer: '多行\n内容' }))
    assert.equal(line.includes('\n'), false, 'JSON 里的换行必须是转义形式')
    assert.equal(JSON.parse(line).result.answer, '多行\n内容')
  }

  // ── 4. 把内部运行结果包成协议响应 ─────────────────────────────────────
  {
    const ok = packageRunResult(3, { ok: true, answer: '答案', duration_ms: 1200, session_dir: '/tmp/s' })
    assert.equal(ok.id, 3)
    assert.equal(ok.result.answer, '答案')
    assert.equal(ok.result.duration_ms, 1200)
    assert.equal(ok.result.session_dir, '/tmp/s')
    assert.equal(ok.error, undefined)

    // 失败：转成 error 而不是 result（调用方靠这个字段分流）
    const failed = packageRunResult(4, { ok: false, error: '模型没回话', session_dir: '/tmp/s' })
    assert.equal(failed.id, 4)
    assert.equal(failed.error.code, ERROR_CODES.RUN_FAILED)
    assert.equal(failed.error.message, '模型没回话')
    assert.equal(failed.error.detail.session_dir, '/tmp/s')
    assert.equal(failed.result, undefined)

    // 没有 error 文本时也要给一句可读的话，不能是空串
    assert.equal(packageRunResult(5, { ok: false }).error.message, 'the run did not produce an answer')
    // 完全没有结果对象（极端情况）也不该崩
    assert.equal(packageRunResult(6, null).error.code, ERROR_CODES.RUN_FAILED)
    assert.equal(packageRunResult(7, undefined).error.code, ERROR_CODES.RUN_FAILED)

    // 答案缺失时给空串而不是 undefined（客户端少一层判空）
    assert.equal(packageRunResult(8, { ok: true }).result.answer, '')
  }

  // ── 5. 能力清单：必须把「一次一进程」这个限制写清楚 ───────────────────
  {
    const manifest = capabilityManifest({ version: '2.2.120' })
    assert.equal(manifest.protocol_version, PROTOCOL_VERSION)
    assert.equal(manifest.app_version, '2.2.120')
    assert.deepEqual(manifest.methods, [...METHODS])
    assert.equal(manifest.session_model, 'one-shot', '限制要写进能力清单，而不是让调用方试出来')
    assert.ok(manifest.notes.some(n => /one run request, then exits/.test(n)))
    assert.ok(manifest.notes.some(n => /single-line JSON/.test(n)))
    assert.ok(manifest.notes.some(n => /need a human/.test(n)), '要说清需要人参与的工具会报不可用而不是挂住')
    // 没有版本号时给 null 而不是 undefined
    assert.equal(capabilityManifest().app_version, null)
  }

  // ── 6. ACP 信封：JSON-RPC 2.0 的形状与标准错误码 ───────────────────────
  {
    const ok = parseJsonRpcLine('{"jsonrpc":"2.0","id":1,"method":"initialize","params":{}}')
    assert.equal(ok.ok, true)
    assert.equal(ok.request.id, 1)
    assert.equal(ok.request.method, 'initialize')
    assert.equal(ok.request.isNotification, false)

    // 没有 id = 通知。这是 session/cancel 唯一的形状，必须被识别出来。
    const note = parseJsonRpcLine('{"jsonrpc":"2.0","method":"session/cancel","params":{"sessionId":"s"}}')
    assert.equal(note.ok, true)
    assert.equal(note.request.isNotification, true)

    // 坏 JSON → -32700（标准码）
    assert.equal(parseJsonRpcLine('{nope').code, ACP_ERRORS.PARSE_ERROR)
    assert.equal(parseJsonRpcLine('{nope').code, -32700)
    // 批量请求明确不支持，而不是半吊子支持
    assert.equal(parseJsonRpcLine('[{"jsonrpc":"2.0","id":1,"method":"ping"}]').code, ACP_ERRORS.INVALID_REQUEST)
    // 非对象
    assert.equal(parseJsonRpcLine('42').code, ACP_ERRORS.INVALID_REQUEST)
    // 缺 method
    assert.equal(parseJsonRpcLine('{"jsonrpc":"2.0","id":1}').code, ACP_ERRORS.INVALID_REQUEST)
    // jsonrpc 版本写错要报出来（否则客户端永远不知道自己发错了什么）
    const badVersion = parseJsonRpcLine('{"jsonrpc":"1.0","id":4,"method":"ping"}')
    assert.equal(badVersion.code, ACP_ERRORS.INVALID_REQUEST)
    assert.ok(/jsonrpc/.test(badVersion.message))

    // 信封构造：必须带 jsonrpc 字段，且错误用 error 对象而不是 result
    assert.equal(buildResponse(1, { a: 1 }).jsonrpc, '2.0')
    assert.equal(buildResponse(null, {}).id, null)
    const err = buildErrorResponse(2, ACP_ERRORS.METHOD_NOT_FOUND, 'nope')
    assert.equal(err.jsonrpc, '2.0')
    assert.equal(err.error.code, -32601)
    assert.equal(err.result, undefined)

    // session/update 的形状：变体名在 params.update.sessionUpdate，内容在 content block
    const chunk = buildAgentMessageChunk('sess_1', '你好')
    assert.equal(chunk.method, 'session/update')
    assert.equal(chunk.id, undefined, '通知不能带 id——带了就成了请求，客户端会等一个永不到来的响应')
    assert.equal(chunk.params.sessionId, 'sess_1')
    assert.equal(chunk.params.update.sessionUpdate, 'agent_message_chunk')
    assert.deepEqual(chunk.params.update.content, { type: 'text', text: '你好' })
    assert.equal(buildAgentThoughtChunk('sess_1', '想').params.update.sessionUpdate, 'agent_thought_chunk')
  }

  // ── 7. 鉴权：级别要诚实，错误码要具体 ─────────────────────────────────
  {
    // 没配置 token = 不启用（见 describeAuthLevel 的级别说明），不算失败
    assert.equal(tokenMatches('', 'anything'), true)
    assert.equal(tokenMatches('secret', 'secret'), true)
    assert.equal(tokenMatches('secret', 'wrong'), false)
    assert.equal(tokenMatches('secret', ''), false)
    // 长度不同也要走到比较，不能靠早退泄露长度
    assert.equal(tokenMatches('secret', 'secret-and-more'), false)

    // 级别说明必须**如实**：不能吹成网络边界
    const level = describeAuthLevel()
    assert.equal(level.mechanism, 'shared-token')
    assert.ok(/not a network boundary/.test(level.level), '级别必须写明不是网络边界')
    assert.ok(level.does_not_protect.some(n => /same user/.test(n)), '要说清挡不住同用户的本机进程')
    assert.ok(level.does_not_protect.some(n => /network/.test(n)))

    // token 提取：params 与 Authorization 头两条路都要认
    assert.equal(extractToken({ token: 'abc' }, {}), 'abc')
    assert.equal(extractToken({ _meta: { token: 'xyz' } }, {}), 'xyz')
    assert.equal(extractToken({}, { ALICE_ACP_TOKEN: 'from-env' }), 'from-env')
    assert.equal(extractBearer({ _meta: { headers: { Authorization: 'Bearer tok123' } } }), 'tok123')
    assert.equal(extractBearer({ _meta: { headers: {} } }), '')
  }

  // ── 8. 多轮上下文延续：这是「多轮」的实质，不是「调两次都成功」 ────────
  {
    const store = new SessionStore()
    const session = store.create({ cwd: '/tmp/x' })

    // 第一轮：历史为空，任务文本**原样**下发（不给单轮调用方塞包装）
    assert.equal(composeTurnTask(session, '第一轮的问题'), '第一轮的问题')

    store.recordTurn(session.sessionId, { user: '我最喜欢的颜色是青色', assistant: '记下了，青色' })

    // 第二轮：必须**真的**带上第一轮的信息
    const second = composeTurnTask(session, '我刚才说的是什么颜色？')
    assert.ok(second.includes('我最喜欢的颜色是青色'), '第二轮必须能看到第一轮的用户输入')
    assert.ok(second.includes('记下了，青色'), '第二轮必须能看到第一轮的回答')
    assert.ok(second.includes('我刚才说的是什么颜色？'), '当前请求必须在')
    // 当前请求放最后：模型对结尾指令服从度最高
    assert.ok(second.lastIndexOf('我刚才说的是什么颜色？') > second.lastIndexOf('我最喜欢的颜色是青色'))

    // 第三轮能看到前两轮（不是只记住最近一轮）
    store.recordTurn(session.sessionId, { user: '第二个问题', assistant: '第二个回答' })
    const third = composeTurnTask(session, '总结一下')
    assert.ok(third.includes('我最喜欢的颜色是青色'))
    assert.ok(third.includes('第二个问题'))

    // 不同会话之间不串台——这是「同一 session 才延续」的反面断言
    const other = store.create({ cwd: '/tmp/y' })
    assert.equal(composeTurnTask(other, '无关的问题'), '无关的问题')
    store.recordTurn(other.sessionId, { user: '别的', assistant: '别的回答' })
    assert.ok(!composeTurnTask(other, 'x').includes('我最喜欢的颜色是青色'), '会话之间不能串台')

    // transcript 上限：超长会话要裁，不能无限长
    const tiny = new SessionStore({ maxTranscriptTurns: 2 })
    const ts = tiny.create({})
    for (let i = 0; i < 5; i++) tiny.recordTurn(ts.sessionId, { user: `u${i}`, assistant: `a${i}` })
    assert.equal(tiny.get(ts.sessionId).transcript.length, 2)
    assert.ok(!composeTurnTask(tiny.get(ts.sessionId), 'x').includes('u0'), '被裁掉的最早轮次不该还在')
    assert.ok(composeTurnTask(tiny.get(ts.sessionId), 'x').includes('u4'))
  }

  // ── 9. 分块 ───────────────────────────────────────────────────────────
  {
    assert.deepEqual(chunkText(''), [])
    assert.deepEqual(chunkText('短'), ['短'])
    const long = 'a'.repeat(300)
    const pieces = chunkText(long, { maxChunkChars: 100 })
    assert.equal(pieces.length, 3, '切块数要跟上限对得上')
    assert.equal(pieces.join(''), long, '拼回去必须等于原文')
    // 非法上限退回默认而不是崩
    assert.ok(chunkText(long, { maxChunkChars: 0 }).length >= 1)
    assert.ok(chunkText(long, { maxChunkChars: NaN }).length >= 1)
  }

  // ── 10. AcpServer：握手 / 多轮 / 流式 / 鉴权 / 未知方法 ───────────────
  // 注入一个确定性的假后端：不联网、不花钱、结果可复现。
  // 它把收到的 task 原样回显，于是「第二轮有没有带上第一轮的信息」可以从回复里读出来。
  {
    const notifications = []
    const echoRunner = async ({ task, onChunk, onThought }) => {
      onThought('（假后端：没有调用模型）')
      for (const piece of [`收到：${task}\n`, '（完毕）\n']) onChunk(piece)
      return { answer: `收到：${task}\n（完毕）` }
    }
    const makeServer = (extra = {}) => new AcpServer({
      turnRunner: echoRunner,
      emit: (m) => notifications.push(m),
      version: '2.2.120',
      log: () => {},
      ...extra,
    })

    // 10a. initialize 握手：必须回协议版本
    {
      const server = makeServer()
      const res = await server.handle(parseJsonRpcLine('{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":1,"clientCapabilities":{}}}').request)
      assert.equal(res.jsonrpc, '2.0')
      assert.equal(res.id, 1)
      assert.equal(res.result.protocolVersion, ACP_PROTOCOL_VERSION)
      assert.equal(res.result.protocolVersion, 1, '协议版本是整数 1，不是字符串')
      assert.equal(res.result.agentInfo.name, 'alice')
      assert.equal(res.result.agentCapabilities.loadSession, true)
      // 没配 token 时不广告鉴权方法（广告了就得能过，否则是骗客户端）
      assert.deepEqual(res.result.authMethods, [])
      // 参数不合法要报 -32602
      const bad = await server.handle(parseJsonRpcLine('{"jsonrpc":"2.0","id":2,"method":"initialize","params":{"protocolVersion":-3}}').request)
      assert.equal(bad.error.code, -32602)
    }

    // 10b. 未知方法 → -32601（不是笼统的失败，是那个具体的码）
    {
      const server = makeServer()
      const res = await server.handle(parseJsonRpcLine('{"jsonrpc":"2.0","id":7,"method":"session/teleport","params":{}}').request)
      assert.equal(res.error.code, ACP_ERRORS.METHOD_NOT_FOUND)
      assert.equal(res.error.code, -32601)
      assert.equal(res.id, 7, '未知方法也要回传 id，否则调用方对不上')
      assert.ok(Array.isArray(res.error.data.supported))
    }

    // 10c. 未鉴权 → -32000（断言具体错误码，不是「失败了」）
    {
      const server = makeServer({ token: 'sekret' })
      const noToken = await server.handle(parseJsonRpcLine('{"jsonrpc":"2.0","id":3,"method":"session/new","params":{}}').request)
      assert.equal(noToken.error.code, ACP_ERRORS.AUTH_REQUIRED)
      assert.equal(noToken.error.code, -32000)
      assert.ok(/token/.test(noToken.error.message))
      // 级别说明要随错误一起回去——调用方有权知道这层是什么级别
      assert.ok(/not a network boundary/.test(noToken.error.data.level))

      const wrongToken = await server.handle(parseJsonRpcLine('{"jsonrpc":"2.0","id":4,"method":"session/new","params":{"token":"wrong"}}').request)
      assert.equal(wrongToken.error.code, -32000)

      // initialize 必须**不**要求 token：否则客户端无法得知需要哪种鉴权
      const init = await server.handle(parseJsonRpcLine('{"jsonrpc":"2.0","id":5,"method":"initialize","params":{}}').request)
      assert.equal(init.error, undefined)
      assert.equal(init.result.authMethods.length, 1)
      assert.equal(init.result.authMethods[0].id, 'shared-token')

      // 正确 token 放行
      const okRes = await server.handle(parseJsonRpcLine('{"jsonrpc":"2.0","id":6,"method":"session/new","params":{"token":"sekret"}}').request)
      assert.equal(okRes.error, undefined)
      assert.ok(okRes.result.sessionId)

      // authenticate：对/错两条路
      const badAuth = await server.handle(parseJsonRpcLine('{"jsonrpc":"2.0","id":8,"method":"authenticate","params":{"methodId":"shared-token","token":"nope"}}').request)
      assert.equal(badAuth.error.code, -32000)
      const goodAuth = await server.handle(parseJsonRpcLine('{"jsonrpc":"2.0","id":9,"method":"authenticate","params":{"methodId":"shared-token","token":"sekret"}}').request)
      assert.equal(goodAuth.result.authenticated, true)
    }

    // 10d. 多轮 + 流式：同一 session 连续两轮，第二轮必须带上第一轮的信息
    {
      notifications.length = 0
      const server = makeServer()
      const newRes = await server.handle(parseJsonRpcLine('{"jsonrpc":"2.0","id":1,"method":"session/new","params":{}}').request)
      const sessionId = newRes.result.sessionId
      assert.ok(sessionId)

      // 第一轮
      const t1 = await server.handle(parseJsonRpcLine(JSON.stringify({
        jsonrpc: '2.0', id: 2, method: 'session/prompt',
        params: { sessionId, prompt: [{ type: 'text', text: '门禁密码是 4471' }] },
      })).request)

      const t1Chunks = notifications.filter(n => n.params.update.sessionUpdate === 'agent_message_chunk')
      // **流式**：必须真的收到 2 块以上，不是最后一次性写完
      assert.ok(t1Chunks.length >= 2, `流式必须真的多块，实际 ${t1Chunks.length} 块`)
      const t1Text = t1Chunks.map(n => n.params.update.content.text).join('')
      // 拼接后必须等于完整回复（假后端的回复是 `收到：<task>\n（完毕）\n`）。
      // 首尾都要断言：只查「含某个词」在「只推了一块就完事」时也会通过。
      assert.ok(t1Text.startsWith('收到：'), '第一块就该是回复的开头')
      assert.ok(t1Text.trimEnd().endsWith('（完毕）'), '最后一块要收尾——拼起来才是完整回复')
      assert.ok(t1Text.includes('门禁密码是 4471'), '第一轮的回复要含第一轮的输入')
      assert.equal(t1.result.stopReason, 'end_turn')
      assert.equal(t1.result._meta.streamed, true)
      assert.equal(t1.result._meta.chunk_source, 'backend', '块必须来自后端流，不是事后切出来的')
      assert.equal(t1.result._meta.chunks, t1Chunks.length, '_meta.chunks 要跟实际推送的块数一致')

      // 第二轮：同一个 session
      notifications.length = 0
      const t2 = await server.handle(parseJsonRpcLine(JSON.stringify({
        jsonrpc: '2.0', id: 3, method: 'session/prompt',
        params: { sessionId, prompt: [{ type: 'text', text: '门禁密码是多少？' }] },
      })).request)

      const t2Chunks = notifications.filter(n => n.params.update.sessionUpdate === 'agent_message_chunk')
      assert.ok(t2Chunks.length >= 2, '第二轮也要真的流式')
      const t2Text = t2Chunks.map(n => n.params.update.content.text).join('')

      // ★ 这就是「多轮」的实质断言：第二轮**真的看到了第一轮的信息**
      assert.ok(t2Text.includes('门禁密码是 4471'),
        `第二轮必须延续第一轮的上下文，实际回复：${JSON.stringify(t2Text.slice(0, 200))}`)
      assert.equal(t2.result._meta.turn, 2, '这必须是该会话的第二轮')
      assert.equal(t1.result._meta.turn, 1)

      // 两轮都成功 ≠ 多轮——上面那条 include 才是。把第一轮抽掉，它必须失败：
      notifications.length = 0
      const fresh = makeServer()
      const freshId = (await fresh.handle(parseJsonRpcLine('{"jsonrpc":"2.0","id":1,"method":"session/new","params":{}}').request)).result.sessionId
      const solo = await fresh.handle(parseJsonRpcLine(JSON.stringify({
        jsonrpc: '2.0', id: 2, method: 'session/prompt',
        params: { sessionId: freshId, prompt: [{ type: 'text', text: '门禁密码是多少？' }] },
      })).request)
      const soloText = notifications.filter(n => n.params.update.sessionUpdate === 'agent_message_chunk').map(n => n.params.update.content.text).join('')
      assert.equal(solo.result.stopReason, 'end_turn')
      assert.ok(!soloText.includes('4471'), '新会话里不该出现上一段会话的信息——证明上面那条断言不是恒真')

      // 不存在的 session → -32001（区别于「参数不对」）
      const missing = await server.handle(parseJsonRpcLine('{"jsonrpc":"2.0","id":4,"method":"session/prompt","params":{"sessionId":"sess_nope","prompt":[{"type":"text","text":"x"}]}}').request)
      assert.equal(missing.error.code, ACP_ERRORS.SESSION_NOT_FOUND)
      assert.equal(missing.error.code, -32001)

      // prompt 为空 / 非 text 块 → -32602，不静默丢弃
      const empty = await server.handle(parseJsonRpcLine(JSON.stringify({
        jsonrpc: '2.0', id: 5, method: 'session/prompt', params: { sessionId, prompt: [] },
      })).request)
      assert.equal(empty.error.code, -32602)
      const image = await server.handle(parseJsonRpcLine(JSON.stringify({
        jsonrpc: '2.0', id: 6, method: 'session/prompt',
        params: { sessionId, prompt: [{ type: 'image', data: 'x' }] },
      })).request)
      assert.equal(image.error.code, -32602)
      assert.ok(/unsupported content block/.test(image.error.message))

      // session/cancel 是通知：永远不回包
      const cancelReply = await server.handle(parseJsonRpcLine(JSON.stringify({
        jsonrpc: '2.0', method: 'session/cancel', params: { sessionId },
      })).request)
      assert.equal(cancelReply, null, '通知不能产生响应')
    }

    // 10e. 流式的另一个方向：后端不流式时必须保底切块，且**如实标注**
    {
      notifications.length = 0
      const lumpRunner = async () => ({ answer: 'x'.repeat(400) })
      const server = new AcpServer({ turnRunner: lumpRunner, emit: (m) => notifications.push(m), log: () => {} })
      const sid = (await server.handle(parseJsonRpcLine('{"jsonrpc":"2.0","id":1,"method":"session/new","params":{}}').request)).result.sessionId
      const res = await server.handle(parseJsonRpcLine(JSON.stringify({
        jsonrpc: '2.0', id: 2, method: 'session/prompt', params: { sessionId: sid, prompt: [{ type: 'text', text: 'hi' }] },
      })).request)
      const chunks = notifications.filter(n => n.params.update.sessionUpdate === 'agent_message_chunk')
      assert.ok(chunks.length >= 2, '一次性回复也要切块推送，否则分块这条路等于没走')
      assert.equal(chunks.map(n => n.params.update.content.text).join(''), 'x'.repeat(400), '拼回去必须等于完整回复')
      assert.equal(res.result._meta.chunk_source, 'synthetic', '切出来的块必须如实标注，不能假装是模型的 token 流')
      assert.equal(res.result._meta.streamed, false, 'synthetic 不是真流式')
    }

    // 10f. cancel 真的打断：断言**轮次结束前**被打断，而不是「返回了 cancelled」
    {
      // 一个只会在 abort 时结束的后端。若取消没生效，这个 await 将永不返回，
      // 于是测试超时——这比「断言返回了 cancelled」强得多：后者在
      // 「取消晚了一步、那一轮本来也快结束了」时同样会通过。
      let aborted = false
      const hangRunner = ({ signal }) => new Promise((resolve) => {
        signal.addEventListener('abort', () => { aborted = true; resolve({ answer: '' }) }, { once: true })
      })
      const server = new AcpServer({ turnRunner: hangRunner, emit: () => {}, log: () => {} })
      const sid = (await server.handle(parseJsonRpcLine('{"jsonrpc":"2.0","id":1,"method":"session/new","params":{}}').request)).result.sessionId

      const started = Date.now()
      const promptPromise = server.handle(parseJsonRpcLine(JSON.stringify({
        jsonrpc: '2.0', id: 2, method: 'session/prompt', params: { sessionId: sid, prompt: [{ type: 'text', text: '跑很久' }] },
      })).request)
      await new Promise(r => setTimeout(r, 30))
      await server.handle(parseJsonRpcLine(JSON.stringify({ jsonrpc: '2.0', method: 'session/cancel', params: { sessionId: sid } })).request)
      const res = await promptPromise
      const elapsed = Date.now() - started

      assert.equal(aborted, true, 'cancel 必须真的把 AbortSignal 打给后端，而不是只记一笔日志')
      assert.equal(res.result.stopReason, 'cancelled')
      assert.equal(res.result._meta.cancelled_before_end, true)
      assert.ok(elapsed < 3000, `被打断的轮次必须尽早返回，实际 ${elapsed}ms`)
    }

    // 10g. session/load：重放历史，且明确标注是重放
    {
      notifications.length = 0
      const server = makeServer({ token: 't' })
      const sid = (await server.handle(parseJsonRpcLine('{"jsonrpc":"2.0","id":1,"method":"session/new","params":{"token":"t"}}').request)).result.sessionId
      await server.handle(parseJsonRpcLine(JSON.stringify({
        jsonrpc: '2.0', id: 2, method: 'session/prompt', params: { token: 't', sessionId: sid, prompt: [{ type: 'text', text: '第一句' }] },
      })).request)
      notifications.length = 0
      const loaded = await server.handle(parseJsonRpcLine(JSON.stringify({
        jsonrpc: '2.0', id: 3, method: 'session/load', params: { token: 't', sessionId: sid },
      })).request)
      assert.equal(loaded.result.sessionId, sid)
      assert.equal(loaded.result.turns, 1)
      const replayed = notifications.filter(n => n.params.update._meta?.replay === true)
      assert.ok(replayed.length >= 2, 'load 要重放用户与助手两侧')
      assert.ok(replayed.some(n => n.params.update.sessionUpdate === 'user_message_chunk'))
      // 重放块必须能被识别出来，否则客户端会把历史当新输出再渲染一遍
      assert.ok(replayed.every(n => n.params.update._meta.replay === true))

      // 缺 sessionId → -32602
      const bad = await server.handle(parseJsonRpcLine('{"jsonrpc":"2.0","id":4,"method":"session/load","params":{"token":"t"}}').request)
      assert.equal(bad.error.code, -32602)
    }

    // 10h. 能力清单要把 ACP 的实情写清楚
    {
      const manifest = acpCapabilityManifest({ version: '2.2.120' })
      assert.equal(manifest.jsonrpc, '2.0')
      assert.equal(manifest.acp_protocol_version, ACP_PROTOCOL_VERSION)
      assert.equal(manifest.session_model, 'multi-turn', 'ACP 这条是真正多轮，别再写 one-shot')
      assert.equal(manifest.streaming.notification, 'session/update')
      assert.ok(manifest.streaming.variants.includes('agent_message_chunk'))
      assert.ok(manifest.methods.includes('session/prompt'))
      assert.ok(manifest.methods.includes('session/cancel') === false, 'cancel 是通知，不该出现在方法表里')
      assert.equal(manifest.auth.level, describeAuthLevel().level)
      assert.ok(/not a network boundary/.test(manifest.auth.level))
    }

    // 10i. **端到端**：走真实进程的 stdio.js，验证通知真的绕过了串行链。
    //
    // 为什么非要有这一条：10f 是在进程内直接调 `AcpServer.handle()`，它只能证明
    // 「AcpServer 内部的取消逻辑是对的」，**证明不了 stdio.js 的行分发会把通知及时
    // 送进来**。变异测试证实过这个缺口——把 stdio.js 里的通知旁路改成
    // `if (false)`（即通知重新排队等 prompt 跑完）时，10f 依然通过。
    // 所以这一条必须真的起子进程、真的通过 stdin/stdout 说话。
    {
      const { spawn } = await import('node:child_process')
      const { fileURLToPath } = await import('node:url')
      // 必须用 fileURLToPath：直接取 `URL.pathname` 会保留百分号编码
      // （本仓库路径含中文，会变成 %E7%99%BD... 这种字面量，spawn 找不到文件而静默退出）。
      const stdioPath = fileURLToPath(new URL('./stdio.js', import.meta.url))

      // 起一个真实 ACP 服务器。echo 后端 + 每块 700ms 延迟，把整轮拉长到秒级，
      // 这样「取消是否真的提前结束」才有可测的差异。
      const startServer = () => {
        const child = spawn(process.execPath, [
          stdioPath, '--acp', '--token', 'e2e-token', '--echo-backend', '--echo-delay-ms', '700',
        ], { stdio: ['pipe', 'pipe', 'pipe'] })
        const messages = []
        let buffer = ''
        let stderr = ''
        child.stdout.setEncoding('utf8')
        child.stderr.setEncoding('utf8')
        child.stdout.on('data', (chunk) => {
          buffer += chunk
          let nl
          while ((nl = buffer.indexOf('\n')) >= 0) {
            const line = buffer.slice(0, nl).trim()
            buffer = buffer.slice(nl + 1)
            if (!line) continue
            try { messages.push(JSON.parse(line)) } catch { /* 非协议行忽略 */ }
          }
        })
        child.stderr.on('data', (chunk) => { stderr += chunk })
        return { child, messages, stderrText: () => stderr }
      }

      const send = (child, obj) => child.stdin.write(`${JSON.stringify(obj)}\n`)
      const sleep = (ms) => new Promise(r => setTimeout(r, ms))
      const waitFor = async (pred, timeoutMs, label) => {
        const deadline = Date.now() + timeoutMs
        while (Date.now() < deadline) {
          const hit = pred()
          if (hit) return hit
          await sleep(25)
        }
        throw new Error(`等待超时：${label}（${timeoutMs}ms 内没等到）`)
      }
      const idOf = (m) => (m.id === undefined ? null : m.id)

      // ── 场景 A：不取消，量出整轮基准时长
      let totalA = 0
      const a = startServer()
      try {
        send(a.child, { jsonrpc: '2.0', id: 1, method: 'initialize', params: {} })
        await waitFor(() => a.messages.find(m => idOf(m) === 1), 10000, 'A: initialize')
        send(a.child, { jsonrpc: '2.0', id: 2, method: 'session/new', params: { token: 'e2e-token' } })
        const newA = await waitFor(() => a.messages.find(m => idOf(m) === 2), 10000, 'A: session/new')
        const sessionA = newA.result.sessionId

        const tA0 = Date.now()
        send(a.child, { jsonrpc: '2.0', id: 3, method: 'session/prompt', params: { token: 'e2e-token', sessionId: sessionA, prompt: [{ type: 'text', text: '第一轮基线' }] } })
        const doneA = await waitFor(() => a.messages.find(m => idOf(m) === 3), 30000, 'A: prompt 完成')
        totalA = Date.now() - tA0
        assert.equal(doneA.result.stopReason, 'end_turn', '不取消时应正常跑完')

        const chunksA = a.messages.filter(m => m.method === 'session/update' && m.params?.update?.sessionUpdate === 'agent_message_chunk')
        assert.ok(chunksA.length >= 2, `端到端也要真的收到 ≥2 个流式分块，实际 ${chunksA.length}`)
      } finally {
        a.child.kill()
      }

      // ── 场景 B：发出取消，断言「(1) 真的返回 cancelled (2) 明显早于基准结束」
      const b = startServer()
      try {
        send(b.child, { jsonrpc: '2.0', id: 1, method: 'initialize', params: {} })
        await waitFor(() => b.messages.find(m => idOf(m) === 1), 10000, 'B: initialize')
        send(b.child, { jsonrpc: '2.0', id: 2, method: 'session/new', params: { token: 'e2e-token' } })
        const newB = await waitFor(() => b.messages.find(m => idOf(m) === 2), 10000, 'B: session/new')
        const sessionB = newB.result.sessionId

        const tB0 = Date.now()
        send(b.child, { jsonrpc: '2.0', id: 3, method: 'session/prompt', params: { token: 'e2e-token', sessionId: sessionB, prompt: [{ type: 'text', text: '这一轮会被取消' }] } })
        // 等到开始出流（说明这一轮确实在跑）再取消
        await waitFor(
          () => b.messages.some(m => m.method === 'session/update'),
          15000,
          'B: 等到第一个流式分块',
        )
        const cancelSentAt = Date.now() - tB0
        send(b.child, { jsonrpc: '2.0', method: 'session/cancel', params: { sessionId: sessionB } })

        const doneB = await waitFor(() => b.messages.find(m => idOf(m) === 3), 30000, 'B: prompt 在取消后返回')
        const totalB = Date.now() - tB0

        assert.equal(
          doneB.result.stopReason,
          'cancelled',
          '端到端取消必须让那一轮以 cancelled 收尾（若通知被排在 prompt 后面，这里会是 end_turn）',
        )
        assert.equal(doneB.result._meta?.cancelled_before_end, true, '必须是轮次结束前被打断')

        // 核心断言：取消要**明显早于**整轮自然结束。
        // 阈值取基准的一半：echo 每条 700ms、至少两条，取消又发生在第一条之后，
        // 所以「提前」是实质性的，不是测量噪声。若取消退化成「跑完才生效」，
        // totalB 会贴近 totalA，这条就会失败——这正是变异 2 逃逸的那个缺口。
        assert.ok(
          totalB < totalA * 0.75,
          `取消必须明显早于整轮结束：取消后 ${totalB}ms vs 基准 ${totalA}ms（阈值 ${Math.round(totalA * 0.75)}ms）`,
        )
      } finally {
        b.child.kill()
      }
    }
  }

  console.log('PASS stdio-protocol: request parsing, param validation, response shaping, run packaging, capability manifest, and the ACP layer (handshake, multi-turn continuity, streaming chunks, auth codes, cancellation)')
} catch (error) {
  console.error(error)
  process.exitCode = 1
}
