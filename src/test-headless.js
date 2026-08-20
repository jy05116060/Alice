import assert from 'assert'
import fs from 'fs'
import os from 'os'
import path from 'path'

// Headless 一次性模式（阶段 6）测试。
// 这里测的是**能在不拉起整个应用的前提下测的部分**：参数解析、会话目录准备、
// 退出码约定、事件观察者。真正跑一轮要连模型（网络 + 额度），不在测试里做——
// 那属于冒烟测试，不是回归测试。
//   npm run test-headless
const {
  EXIT,
  HEADLESS_ENV,
  HELP_TEXT,
  HeadlessArgError,
  defaultSessionDir,
  parseHeadlessArgs,
  parseTimeout,
  prepareHeadlessSession,
} = await import('./runtime/headless-session.js')
const { addEventListener, emitEvent, getLatestEventId } = await import('./events.js')

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'blm-headless-test-'))

try {
  // ── 1. 参数解析 ───────────────────────────────────────────────────────
  {
    const a = parseHeadlessArgs(['把 README 翻成英文'])
    assert.equal(a.task, '把 README 翻成英文')
    assert.equal(a.keepSession, false)
    assert.equal(a.json, false)
    assert.equal(a.timeoutMs, 5 * 60 * 1000, '默认超时 5 分钟')

    // 位置参数可以拆成多个词，拼回一句话
    assert.equal(parseHeadlessArgs(['check', 'the', 'build']).task, 'check the build')
    assert.equal(parseHeadlessArgs(['--task', 'a b c']).task, 'a b c')
    // 位置 + --task 混用：按出现顺序拼接（不静默丢掉一半）
    assert.equal(parseHeadlessArgs(['first', '--task', 'second']).task, 'first second')

    assert.equal(parseHeadlessArgs(['x', '--json']).json, true)
    assert.equal(parseHeadlessArgs(['x', '--keep-session']).keepSession, true)
    assert.equal(parseHeadlessArgs(['x', '--session-dir', '/tmp/abc']).sessionDir, '/tmp/abc')
    assert.equal(parseHeadlessArgs(['--help']).help, true)
    assert.equal(parseHeadlessArgs(['-h']).help, true)
    // 任务为空 = 调用方要自己判断（解析层不抛）
    assert.equal(parseHeadlessArgs([]).task, '')
    assert.equal(parseHeadlessArgs(['   ']).task, '')

    // 未知选项必须报错，而不是被当成任务文本——
    // 否则 `--jsoon` 拼错就变成「让模型处理 --jsoon」这种莫名结果
    for (const bad of [['x', '--jsoon'], ['--nope'], ['--task']]) {
      let caught = null
      try { parseHeadlessArgs(bad) } catch (e) { caught = e }
      assert.ok(caught, `${JSON.stringify(bad)} 应当报错`)
      assert.equal(caught.code, 'BAD_ARGS')
      assert.ok(caught instanceof HeadlessArgError)
    }
    // `--task` 缺值也要报错（而不是把后面的 undefined 当任务）
    assert.ok(/needs a value/.test((() => { try { parseHeadlessArgs(['--timeout']) } catch (e) { return e.message } return '' })()))
  }

  // ── 2. 超时解析 ───────────────────────────────────────────────────────
  {
    assert.equal(parseTimeout('30'), 30_000, '裸数字小于 1000 按秒读')
    assert.equal(parseTimeout('180'), 180_000, '180 = 180 秒（人写这个不会是想说 180 毫秒）')
    assert.equal(parseTimeout('30000'), 30_000, '裸数字 ≥ 1000 按毫秒读')
    assert.equal(parseTimeout('30s'), 30_000)
    assert.equal(parseTimeout('90s'), 90_000)
    assert.equal(parseTimeout('2m'), 120_000)
    assert.equal(parseTimeout('1500ms'), 1500)
    assert.equal(parseTimeout(' 5m '), 300_000, '两侧空白要容忍')
    assert.equal(parseTimeout('1.5s'), 1500, '小数秒可以')
    assert.equal(parseTimeout('500'), 500_000, '阈值改成 1000 之后，500 就是 500 秒')
    assert.equal(parseTimeout('1000'), 1000, '1000 起按毫秒读')
    // 下限之外才是错误：显式 ms 小于 1000、或 0 / 负数 / 非数字。
    // （裸数字不可能触发下限了：小于 1000 的一律按秒读，1 秒起就是合法的。）
    for (const bad of ['abc', '', 's', '-5', '0', '0ms', '999ms', '0.5s']) {
      let caught = null
      try { parseTimeout(bad) } catch (e) { caught = e }
      assert.ok(caught, `--timeout "${bad}" 应被拒`)
      assert.equal(caught.code, 'BAD_ARGS')
    }
  }

  // ── 3. 会话目录准备：只搬白名单，不搬历史 ────────────────────────────
  {
    // 造一个「真实 user dir」：有 config/llm，也有历史 DB 与媒体（不该被搬走）
    const source = path.join(tmp, 'real-user-dir')
    fs.mkdirSync(path.join(source, 'data', 'media'), { recursive: true })
    fs.mkdirSync(path.join(source, 'llm'), { recursive: true })
    fs.writeFileSync(path.join(source, 'config.json'), JSON.stringify({ model: 'x', apiKey: 'secret' }), 'utf8')
    fs.writeFileSync(path.join(source, 'llm', 'providers.json'), '{"a":1}', 'utf8')
    fs.writeFileSync(path.join(source, 'mcp-servers.json'), '[]', 'utf8')
    fs.writeFileSync(path.join(source, 'data', 'jarvis.db'), 'FAKE-HISTORY', 'utf8')
    fs.writeFileSync(path.join(source, 'data', 'media', 'pic.png'), 'BYTES', 'utf8')
    fs.writeFileSync(path.join(source, 'seedance.json'), '{}', 'utf8')

    const target = path.join(tmp, 'session-a')
    const result = prepareHeadlessSession({ sourceUserDir: source, sessionDir: target })
    assert.equal(result.created, true)
    assert.equal(result.sessionDir, path.resolve(target))
    assert.ok(result.carried.includes('config.json'), '凭据必须带过去——否则新会话里没有 key')
    assert.ok(result.carried.includes('llm'))
    assert.ok(result.carried.includes('mcp-servers.json'))
    assert.ok(result.missing.includes('voice'), '源里没有的要如实报告 missing')
    assert.equal(result.missing.includes('config.json'), false)

    // 凭据到位
    assert.equal(JSON.parse(fs.readFileSync(path.join(target, 'config.json'), 'utf8')).apiKey, 'secret')
    assert.equal(fs.readFileSync(path.join(target, 'llm', 'providers.json'), 'utf8'), '{"a":1}')
    // **历史与媒体绝不能被搬**——那才是「全新会话」
    assert.equal(fs.existsSync(path.join(target, 'data', 'jarvis.db')), false, '历史 DB 不该进新会话')
    assert.equal(fs.existsSync(path.join(target, 'data', 'media')), false, '媒体不该进新会话')
    assert.equal(fs.existsSync(path.join(target, 'seedance.json')), false, '白名单外的东西一律不搬')
    // data 目录本身要建好（DB 会落在里面）
    assert.equal(fs.existsSync(path.join(target, 'data')), true)

    // 第二次调用同一目录：不覆盖已在里面的东西，也不重复报 carried
    fs.writeFileSync(path.join(target, 'config.json'), '{"model":"edited"}', 'utf8')
    const again = prepareHeadlessSession({ sourceUserDir: source, sessionDir: target })
    assert.equal(again.created, false, '目录已存在时 created=false')
    assert.equal(fs.readFileSync(path.join(target, 'config.json'), 'utf8'), '{"model":"edited"}',
      '已存在的配置不能被源覆盖——用户可能在里面改过')

    // 源目录不存在时：不抛，但把 missing 说全（调用方据此判断没有凭据）
    const empty = prepareHeadlessSession({ sourceUserDir: path.join(tmp, 'nope'), sessionDir: path.join(tmp, 'session-b') })
    assert.equal(empty.carried.length, 0)
    assert.ok(empty.missing.includes('config.json'))

    // 缺 sessionDir 时报错而不是写到奇怪的地方
    let noDir = null
    try { prepareHeadlessSession({ sourceUserDir: source }) } catch (e) { noDir = e }
    assert.equal(noDir?.code, 'BAD_ARGS')
  }

  // ── 4. 默认会话目录与退出码约定 ──────────────────────────────────────
  {
    const d1 = defaultSessionDir()
    const d2 = defaultSessionDir()
    assert.ok(d1.includes('alice-headless'), '默认目录名要能认出来')
    assert.notEqual(d1, d2, '两次调用不该撞同一个目录名')
    assert.equal(path.isAbsolute(d1), true)

    assert.equal(EXIT.ANSWERED, 0)
    assert.equal(EXIT.RUN_FAILED, 1)
    assert.equal(EXIT.BAD_ARGS, 2)
    assert.equal(EXIT.TIMED_OUT, 3)
    // 退出码必须两两不同，否则脚本没法区分
    assert.equal(new Set(Object.values(EXIT)).size, Object.keys(EXIT).length)
  }

  // ── 5. 帮助文本要点 ──────────────────────────────────────────────────
  {
    assert.ok(/node src\/headless\.js/.test(HELP_TEXT), '要给出可复制的用法')
    assert.ok(/--json/.test(HELP_TEXT) && /--timeout/.test(HELP_TEXT) && /--keep-session/.test(HELP_TEXT))
    assert.ok(/fresh session/.test(HELP_TEXT), '要说清默认是全新会话（否则用户以为在跑真实对话）')
    assert.ok(/Exit codes/.test(HELP_TEXT), '退出码约定要写在帮助里，脚本作者才知道怎么判')
    assert.ok(/no UI attached/.test(HELP_TEXT), '要说清没有 UI —— 需要人参与的工具会报不可用')
  }

  // ── 6. 事件观察者（headless 拿回答靠它）──────────────────────────────
  {
    const seen = []
    const off = addEventListener((type, data) => seen.push([type, data]))
    emitEvent('headless_test_event', { hello: 'world' })
    assert.equal(seen.length, 1)
    assert.equal(seen[0][0], 'headless_test_event')
    assert.equal(seen[0][1].hello, 'world')

    // 退订后不再收到
    off()
    emitEvent('headless_test_event', { hello: 'again' })
    assert.equal(seen.length, 1, '退订之后不该再收到事件')

    // 观察者抛错不能影响主流程——观测失败绝不能毁掉被观测的那一轮
    const before = getLatestEventId()
    const offBoom = addEventListener(() => { throw new Error('observer exploded') })
    let threw = false
    try { emitEvent('headless_test_event', { x: 1 }) } catch { threw = true }
    assert.equal(threw, false, '观察者抛错必须被吞掉')
    assert.ok(getLatestEventId() > before, '事件仍然要正常入列')
    offBoom()

    // 多个观察者互不影响；传非函数要有安全的返回值
    const hits = []
    const off1 = addEventListener(() => hits.push('a'))
    const off2 = addEventListener(() => hits.push('b'))
    emitEvent('headless_test_event', {})
    assert.deepEqual(hits.sort(), ['a', 'b'])
    off1(); off2()
    const noop = addEventListener(null)
    assert.equal(typeof noop, 'function', '传非函数也要能安全调用退订')

    // 关键：**没有 SSE 客户端时观察者照样收得到**（headless 就是这种情况）
    const { getSSEClientCount } = await import('./events.js')
    assert.equal(getSSEClientCount(), 0, '这个测试进程本来就没有 UI 客户端')
    const lonely = []
    const offLonely = addEventListener((type) => lonely.push(type))
    emitEvent('headless_test_event', {})
    assert.deepEqual(lonely, ['headless_test_event'], '没有 UI 客户端时更要能拿到事件')
    offLonely()
  }

  // ── 7. 环境变量键名与 headless.js 的约定一致 ─────────────────────────
  {
    assert.equal(HEADLESS_ENV.MODE, 'ALICE_HEADLESS')
    assert.equal(HEADLESS_ENV.TASK, 'ALICE_HEADLESS_TASK')
    assert.equal(HEADLESS_ENV.TIMEOUT, 'ALICE_HEADLESS_TIMEOUT_MS')
    assert.equal(HEADLESS_ENV.JSON, 'ALICE_HEADLESS_JSON')
    assert.equal(HEADLESS_ENV.SESSION_DIR, 'ALICE_HEADLESS_SESSION_DIR')
    // index.js 的分支读的就是这个键；写成两处不一致会导致 headless 静默变成常驻
    const indexSource = fs.readFileSync(new URL('./index.js', import.meta.url), 'utf8')
    assert.ok(indexSource.includes(`process.env.${HEADLESS_ENV.MODE} === '1'`),
      'index.js 必须用同一组键名判断 headless 模式')
    assert.ok(indexSource.includes('runHeadlessOnce'), 'index.js 里要有 headless 执行体')
  }

  console.log('test-headless: all assertions passed')
} catch (error) {
  console.error(error)
  process.exitCode = 1
} finally {
  try { fs.rmSync(tmp, { recursive: true, force: true }) } catch { /* 清理失败不影响结论 */ }
}
