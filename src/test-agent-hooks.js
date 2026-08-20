import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

// Agent hooks 桥接（阶段 6.5）测试。纯逻辑 + 真进程（用 node / shell 当 hook 命令），
// 不需要装任何东西：
//   npm run test-agent-hooks
const {
  DEFAULT_TIMEOUT_MS,
  HOOK_EVENTS,
  READ_ONLY_EVENTS,
  WIRED_EVENTS,
  _clearHookConfigCache,
  buildHookPayload,
  hookConfigPaths,
  hookStatus,
  interpretHookOutput,
  loadHookConfig,
  loadHookConfigCached,
  matcherMatches,
  normalizeHookConfig,
  normalizeMatcherEntry,
  runHooks,
  selectHooks,
} = await import('./runtime/agent-hooks.js')
const {
  appendHookContext,
  hooksEnabled,
  runPostToolUseHooks,
  runPreToolUseHooks,
} = await import('./runtime/hook-bridge.js')
const { config } = await import('./config.js')

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'blm-hooks-'))
const cwd = path.join(tmp, 'project')
const homeDir = path.join(tmp, 'home')
fs.mkdirSync(path.join(cwd, '.claude'), { recursive: true })
fs.mkdirSync(path.join(homeDir, '.claude'), { recursive: true })

const writeSettings = (target, obj) => fs.writeFileSync(target, JSON.stringify(obj, null, 2), 'utf8')

try {
  // ── 1. 配置规范化 ─────────────────────────────────────────────────────
  {
    // 标准形状
    const entry = normalizeMatcherEntry({
      matcher: 'Bash',
      hooks: [{ type: 'command', command: 'echo hi', timeout: 5 }],
    })
    assert.equal(entry.matcher, 'Bash')
    assert.equal(entry.hooks.length, 1)
    assert.equal(entry.hooks[0].command, 'echo hi')
    assert.equal(entry.hooks[0].timeoutMs, 5000, 'Claude Code 的 timeout 单位是秒')

    // 没写 matcher → 全部匹配
    assert.equal(normalizeMatcherEntry({ hooks: [{ command: 'x' }] }).matcher, '*')
    // 守卫：没有可执行命令的项要被丢掉（否则会 spawn 一个空命令）
    assert.equal(normalizeMatcherEntry({ matcher: 'Bash', hooks: [] }), null)
    assert.equal(normalizeMatcherEntry({ matcher: 'Bash', hooks: [{ command: '   ' }] }), null)
    assert.equal(normalizeMatcherEntry(null), null)
    assert.equal(normalizeMatcherEntry('nonsense'), null)
    // 非 command 类型暂时跳过（我们只支持能解释清楚的命令类）
    assert.equal(normalizeMatcherEntry({ hooks: [{ type: 'prompt', command: 'x' }] }), null)
    // 简写：直接给字符串命令
    assert.equal(normalizeMatcherEntry({ matcher: 'Bash', hooks: ['echo s'] }).hooks[0].command, 'echo s')
    // timeout 非法时退回默认
    assert.equal(normalizeMatcherEntry({ hooks: [{ command: 'x', timeout: -1 }] }).hooks[0].timeoutMs, DEFAULT_TIMEOUT_MS)
    assert.equal(normalizeMatcherEntry({ hooks: [{ command: 'x', timeout: 999 }] }).hooks[0].timeoutMs, 120_000,
      '超大 timeout 要被夹住，避免一个 hook 把整条流水线挂死')

    // 整份配置
    const normalized = normalizeHookConfig({
      hooks: {
        PreToolUse: [
          { matcher: 'Bash', hooks: [{ command: 'a' }] },
          { matcher: 'Edit', hooks: [{ command: 'b' }] },
          { matcher: 'Broken', hooks: [] },
        ],
        PostToolUse: [{ hooks: [{ command: 'c' }] }],
        NotAnArray: 'oops',
      },
    })
    assert.equal(normalized.PreToolUse.length, 2, '空 hooks 的项要被丢掉')
    assert.equal(normalized.PostToolUse.length, 1)
    assert.equal(normalized.NotAnArray, undefined)
    // 没有 hooks 段 / 形状不对：不抛，返回空
    assert.deepEqual(normalizeHookConfig({}), {})
    assert.deepEqual(normalizeHookConfig(null), {})
    assert.deepEqual(normalizeHookConfig({ hooks: 'nope' }), {})
  }

  // ── 2. 配置文件读取与合并 ─────────────────────────────────────────────
  {
    const projectSettings = path.join(cwd, '.claude', 'settings.json')
    const userSettings = path.join(homeDir, '.claude', 'settings.json')
    writeSettings(userSettings, {
      hooks: {
        PreToolUse: [{ matcher: 'read_file', hooks: [{ command: 'user-read' }] }],
        UserPromptSubmit: [{ hooks: [{ command: 'on-prompt' }] }],
      },
    })
    writeSettings(projectSettings, {
      hooks: {
        PreToolUse: [{ matcher: 'read_file', hooks: [{ command: 'project-read' }] }],
        PostToolUse: [{ matcher: 'write_file', hooks: [{ command: 'project-post' }] }],
      },
    })

    const loaded = loadHookConfig({ cwd, homeDir })
    assert.equal(loaded.sources.length, 2, '两份配置都要被读到')
    assert.equal(loaded.errors.length, 0)
    assert.equal(loaded.hooks.PostToolUse.length, 1)
    assert.equal(loaded.hooks.UserPromptSubmit.length, 1, '不接入的事件也要解析出来（诊断时才看得见）')
    // 同 matcher 冲突：项目级覆盖用户级
    assert.equal(loaded.hooks.PreToolUse.length, 1)
    assert.equal(loaded.hooks.PreToolUse[0].hooks[0].command, 'project-read')

    // 坏 JSON 要被记为 error 而不是抛，也不能静默当成「没配置」
    const broken = path.join(cwd, '.claude', 'settings.local.json')
    fs.writeFileSync(broken, '{ this is not json', 'utf8')
    const withBroken = loadHookConfig({ cwd, homeDir })
    assert.equal(withBroken.errors.length, 1, '坏配置要如实报告')
    assert.ok(withBroken.errors[0].includes('settings.local.json'))
    assert.equal(withBroken.hooks.PostToolUse.length, 1, '一份坏掉不影响其它份')
    fs.rmSync(broken)

    // 路径顺序：用户级在前、项目级在后（后读的覆盖先读的）
    const paths = hookConfigPaths({ cwd, homeDir })
    assert.equal(paths.length, 4)
    assert.ok(paths[0].includes(homeDir))
    assert.ok(paths[2].includes(cwd))

    // 缓存：TTL 内不重复读盘
    _clearHookConfigCache()
    let reads = 0
    const counting = { cwd, homeDir, _read: (f) => { reads++; return JSON.parse(fs.readFileSync(f, 'utf8')) } }
    const first = loadHookConfigCached(counting)
    const readsAfterFirst = reads
    const second = loadHookConfigCached(counting)
    assert.equal(reads, readsAfterFirst, 'TTL 内不该再读盘')
    assert.equal(second, first, '缓存要返回同一个对象')
    // TTL 过期后重读
    loadHookConfigCached({ ...counting, now: Date.now() + 60_000 })
    assert.ok(reads > readsAfterFirst, 'TTL 过后要重读')

    // hookStatus 是给人看的诊断
    _clearHookConfigCache()
    const status = hookStatus({ cwd, homeDir })
    assert.equal(status.sources.length, 2)
    assert.equal(status.events.PreToolUse, 1)
    assert.deepEqual(status.wired, [...WIRED_EVENTS])
    assert.ok(status.readOnly.includes('UserPromptSubmit'))
  }

  // ── 3. matcher 匹配 ───────────────────────────────────────────────────
  {
    assert.equal(matcherMatches('*', 'anything').match, true)
    assert.equal(matcherMatches('', 'x').match, true, '空 matcher 视为全部')
    assert.equal(matcherMatches('read_file', 'read_file').match, true)
    assert.equal(matcherMatches('read_file', 'write_file').match, false)
    // 正则写法（Claude Code 的 matcher 就是正则）
    assert.equal(matcherMatches('read_.*', 'read_file').match, true)
    assert.equal(matcherMatches('read_.*', 'write_file').match, false)
    assert.equal(matcherMatches('write_file|edit_file', 'edit_file').match, true)
    // 写坏的正则：当作不匹配并报错，而不是让所有调用都抛
    const broken = matcherMatches('([', 'read_file')
    assert.equal(broken.match, false)
    assert.ok(broken.error && /invalid matcher/.test(broken.error))

    const hookConfig = {
      PreToolUse: [
        { matcher: '*', hooks: [{ command: 'all', timeoutMs: 1000 }] },
        { matcher: 'read_.*', hooks: [{ command: 'reads', timeoutMs: 1000 }] },
        { matcher: 'write_file', hooks: [{ command: 'writes', timeoutMs: 1000 }] },
      ],
    }
    const forRead = selectHooks(hookConfig, 'PreToolUse', 'read_file')
    assert.deepEqual(forRead.hooks.map(h => h.command), ['all', 'reads'])
    const forWrite = selectHooks(hookConfig, 'PreToolUse', 'write_file')
    assert.deepEqual(forWrite.hooks.map(h => h.command), ['all', 'writes'])
    assert.deepEqual(selectHooks(hookConfig, 'PostToolUse', 'x').hooks, [])
    assert.deepEqual(selectHooks(null, 'PreToolUse', 'x').hooks, [])
  }

  // ── 4. 输出解释 ───────────────────────────────────────────────────────
  {
    // 退出码 2 = 阻塞，stderr 是理由（Claude Code 的约定）
    const blocked = interpretHookOutput({ exitCode: 2, stdout: '', stderr: '不要改 .env' })
    assert.equal(blocked.blocked, true)
    assert.equal(blocked.reason, '不要改 .env')
    // 退出码 2 但 stderr 为空：也要给一个可读的理由，不能是空串
    assert.equal(interpretHookOutput({ exitCode: 2, stdout: '', stderr: '' }).reason,
      'a hook blocked this tool call')

    // JSON decision: block
    const jsonBlock = interpretHookOutput({
      exitCode: 0, stdout: JSON.stringify({ decision: 'block', reason: 'policy says no' }), stderr: '',
    })
    assert.equal(jsonBlock.blocked, true)
    assert.equal(jsonBlock.reason, 'policy says no')
    assert.equal(interpretHookOutput({ exitCode: 0, stdout: JSON.stringify({ decision: 'deny' }) }).blocked, true)

    // additionalContext（两种位置都认）
    const ctx1 = interpretHookOutput({
      exitCode: 0, stdout: JSON.stringify({ hookSpecificOutput: { additionalContext: '记得跑 lint' } }), stderr: '',
    })
    assert.equal(ctx1.blocked, false)
    assert.equal(ctx1.additionalContext, '记得跑 lint')
    const ctx2 = interpretHookOutput({ exitCode: 0, stdout: JSON.stringify({ additionalContext: '短写法' }) })
    assert.equal(ctx2.additionalContext, '短写法')

    // 纯文本 stdout 当附加上下文（有些脚本就这么写）
    assert.equal(interpretHookOutput({ exitCode: 0, stdout: 'plain note' }).additionalContext, 'plain note')
    // 但 JSON 输出里没有 context 字段时不能把整段 JSON 当上下文塞回去
    assert.equal(interpretHookOutput({ exitCode: 0, stdout: JSON.stringify({ something: 1 }) }).additionalContext, '')

    // 其它非零退出码：非阻塞错误。不该因为别人的脚本坏了就拦住工具。
    const nonBlocking = interpretHookOutput({ exitCode: 1, stdout: '', stderr: 'script bug' })
    assert.equal(nonBlocking.blocked, false)
    assert.equal(nonBlocking.error, 'script bug')

    // 超时：非阻塞，且要标出来
    const timedOut = interpretHookOutput({ exitCode: 1, stdout: '', stderr: '', timedOut: true })
    assert.equal(timedOut.blocked, false)
    assert.match(timedOut.error, /timed out/)

    // 输出很长要被截断（不能拿别人的脚本把上下文撑爆）
    const long = interpretHookOutput({ exitCode: 0, stdout: 'x'.repeat(50_000) })
    assert.ok(long.additionalContext.length <= 8000)
  }

  // ── 5. 跑 hook（注入 _run：语义与顺序）────────────────────────────────
  {
    const hookConfig = {
      PreToolUse: [
        { matcher: '*', hooks: [{ command: 'first', timeoutMs: 1000 }, { command: 'second', timeoutMs: 1000 }] },
      ],
    }
    const calls = []
    const okRun = async (command, stdin, timeout) => {
      calls.push({ command, stdin, timeout })
      return { exitCode: 0, stdout: `ctx from ${command}`, stderr: '' }
    }
    const outcome = await runHooks({
      event: 'PreToolUse', toolName: 'read_file', payload: { tool_name: 'read_file' }, hookConfig, _run: okRun,
    })
    assert.equal(outcome.ran, 2)
    assert.equal(outcome.blocked, false)
    assert.deepEqual(outcome.contexts, ['ctx from first', 'ctx from second'])
    // stdin 是 JSON（脚本要靠它拿工具名与参数）
    assert.equal(JSON.parse(calls[0].stdin).tool_name, 'read_file')
    assert.equal(calls[0].timeout, 1000)

    // 第一个说不就停：后面的没必要再跑
    const stopRun = async (command) => command === 'first'
      ? { exitCode: 2, stdout: '', stderr: 'no' }
      : { exitCode: 0, stdout: 'should not run', stderr: '' }
    const stopped = await runHooks({
      event: 'PreToolUse', toolName: 'read_file', payload: {}, hookConfig, _run: stopRun,
    })
    assert.equal(stopped.blocked, true)
    assert.equal(stopped.ran, 1, '阻塞之后不该继续跑后面的 hook')
    assert.equal(stopped.reason, 'no')
    assert.deepEqual(stopped.contexts, [], '被阻塞时上下文不该被采纳')

    // 没有匹配的 hook：一次都不跑（这条是性能关键——未匹配就不该 spawn 进程）
    let spawned = 0
    await runHooks({
      event: 'PreToolUse', toolName: 'nothing_matches',
      hookConfig: { PreToolUse: [{ matcher: 'only_this', hooks: [{ command: 'x', timeoutMs: 1 }] }] },
      payload: {}, _run: async () => { spawned++; return { exitCode: 0, stdout: '', stderr: '' } },
    })
    assert.equal(spawned, 0)
    // 完全没配 hooks
    const empty = await runHooks({ event: 'PreToolUse', toolName: 'x', hookConfig: {}, payload: {}, _run: async () => { spawned++ } })
    assert.equal(empty.ran, 0)
    assert.equal(spawned, 0)
  }

  // ── 6. 真是进程：命令真的跑起来了 ─────────────────────────────────────
  {
    // 用真实脚本文件而不是内联 `node -e "..."`：真实用户的 hook 就是「一个脚本路径」，
    // 而且内联命令里套三层引号既难读也容易写错（本文件第一版就写错了）。
    const scriptDir = path.join(tmp, 'scripts')
    fs.mkdirSync(scriptDir, { recursive: true })
    const writeScript = (name, body) => {
      const file = path.join(scriptDir, name)
      fs.writeFileSync(file, body, 'utf8')
      return `node "${file}"`
    }

    const contextScript = writeScript('ctx.cjs', [
      'let input = ""',
      'process.stdin.on("data", d => { input += d })',
      'process.stdin.on("end", () => {',
      '  const payload = JSON.parse(input || "{}")',
      '  process.stdout.write(JSON.stringify({ hookSpecificOutput: { additionalContext: `real ctx for ${payload.tool_name}` } }))',
      '})',
    ].join('\n'))

    const hookConfig = { PreToolUse: [{ matcher: '*', hooks: [{ command: contextScript, timeoutMs: 20_000 }] }] }
    const real = await runHooks({
      event: 'PreToolUse', toolName: 'read_file', payload: { tool_name: 'read_file' }, hookConfig,
    })
    assert.equal(real.ran, 1)
    assert.deepEqual(real.contexts, ['real ctx for read_file'],
      `真进程的输出没被读到: ${JSON.stringify(real)}`)

    // 退出码 2 真的会阻塞，理由来自 stderr
    const blockScript = writeScript('block.cjs', 'process.stderr.write("blocked by real hook"); process.exit(2)\n')
    const blocked = await runHooks({
      event: 'PreToolUse', toolName: 'x', payload: {},
      hookConfig: { PreToolUse: [{ matcher: '*', hooks: [{ command: blockScript, timeoutMs: 20_000 }] }] },
    })
    assert.equal(blocked.blocked, true)
    assert.match(blocked.reason, /blocked by real hook/)

    // 命令不存在：非阻塞错误，不能抛
    const ghost = await runHooks({
      event: 'PreToolUse', toolName: 'x', payload: {},
      hookConfig: { PreToolUse: [{ matcher: '*', hooks: [{ command: 'this-command-does-not-exist-xyz', timeoutMs: 5_000 }] }] },
    })
    assert.equal(ghost.blocked, false)
    assert.ok(ghost.errors.length > 0, '命令找不到要记下来')

    // 超时：非阻塞，且不会一直等下去
    const slowScript = writeScript('slow.cjs', 'setTimeout(() => {}, 30000)\n')
    const started = Date.now()
    const slow = await runHooks({
      event: 'PreToolUse', toolName: 'x', payload: {},
      hookConfig: { PreToolUse: [{ matcher: '*', hooks: [{ command: slowScript, timeoutMs: 1 }] }] },
    })
    assert.equal(slow.blocked, false)
    assert.ok(Date.now() - started < 20_000, '超时要真的把它掐掉')
    assert.ok(slow.errors.some(e => /timed out/.test(e)), JSON.stringify(slow.errors))
  }

  // ── 7. 接线层：payload 形状、上下文合并、默认关闭 ─────────────────────
  {
    const pre = buildHookPayload({ event: HOOK_EVENTS.PRE_TOOL_USE, toolName: 'read_file', toolArgs: { path: 'a' }, sessionId: 's1', cwd })
    assert.equal(pre.hook_event_name, 'PreToolUse')
    assert.equal(pre.tool_name, 'read_file')
    assert.deepEqual(pre.tool_input, { path: 'a' })
    assert.equal(pre.session_id, 's1')
    assert.equal(pre.cwd, cwd)
    assert.equal('tool_response' in pre, false, 'PreToolUse 不该带 tool_response')

    const post = buildHookPayload({ event: HOOK_EVENTS.POST_TOOL_USE, toolName: 'read_file', toolResult: 'result text', cwd })
    assert.equal(post.tool_response, 'result text')
    // 超长结果要截断，不能把整个文件内容通过 stdin 送给外部脚本
    const huge = buildHookPayload({ event: HOOK_EVENTS.POST_TOOL_USE, toolName: 'x', toolResult: 'y'.repeat(50_000), cwd })
    assert.ok(huge.tool_response.length <= 8000)
    assert.equal(buildHookPayload({ event: HOOK_EVENTS.POST_TOOL_USE, toolName: 'x', toolResult: null, cwd }).tool_response, null)

    // 上下文合并：JSON 结果塞进 hook_context 字段（模型读起来更清楚）
    const jsonResult = JSON.stringify({ ok: true, path: 'a' })
    const merged = JSON.parse(appendHookContext(jsonResult, ['记得跑 lint']))
    assert.equal(merged.ok, true)
    assert.equal(merged.path, 'a')
    assert.equal(merged.hook_context, '记得跑 lint')
    // 多次合并要叠加
    const twice = JSON.parse(appendHookContext(JSON.stringify(merged), ['再来一条']))
    assert.match(twice.hook_context, /记得跑 lint[\s\S]*再来一条/)
    // 非 JSON 结果退回文本拼接
    const plain = appendHookContext('普通文本结果', ['ctx'])
    assert.match(plain, /普通文本结果/)
    assert.match(plain, /\[agent hook context\]/)
    assert.match(plain, /ctx/)
    // 没有上下文时原样返回（不做无谓改写）
    assert.equal(appendHookContext(jsonResult, []), jsonResult)
    assert.equal(appendHookContext(jsonResult, ['', null, undefined]), jsonResult)

    // **默认关闭**：这一条决定「会不会在用户没同意的情况下执行外部命令」
    assert.equal(hooksEnabled(), config.hooks.enabled === true)
    assert.equal(config.hooks.enabled, false, 'hooks 必须默认关闭')

    // 关闭时 runPreToolUseHooks 仍可被调用（执行层做了判断），但不该有副作用
    const offOutcome = await runPreToolUseHooks('read_file', {}, { cwd })
    assert.equal(typeof offOutcome, 'object')

    assert.equal(WIRED_EVENTS.length, 2)
    assert.ok(READ_ONLY_EVENTS.includes('UserPromptSubmit'), '没接入的事件要明确列出来，而不是假装支持')
  }

  console.log('PASS agent-hooks: config merge, matcher semantics, output interpretation, real-process block/context, bridge framing, and default-off')
} finally {
  _clearHookConfigCache()
  try { fs.rmSync(tmp, { recursive: true, force: true }) } catch { /* 清理失败不影响结论 */ }
}
