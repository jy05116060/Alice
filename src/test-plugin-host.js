import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

// 插件宿主 + 热重载最小内核的测试（阶段 6.7）。
//
// 这里造的是**真的插件目录**：真的清单文件、真的 ESM 模块、真的 fs.watch。
// 插件模块跑在同一个进程里，所以它们把生命周期事件写进 `globalThis.__pluginTrace`,
// 测试直接读那个数组——「deactivate 到底有没有被调用」只有从插件自己那边看才算数。
//
// 全程在临时目录里，**绝不碰真实用户数据**：
//   npm run test:plugin-host
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'blm-plugin-host-'))
process.env.ALICE_USER_DIR = tmp
process.env.ALICE_RESOURCES_DIR = process.cwd()
delete process.env.ALICE_PLUGINS_DIR

const pluginsRoot = path.join(tmp, 'plugins')
const pluginsRootB = path.join(tmp, 'plugins-b')

/** 插件自己写的「我跑了」记录。同一个进程、同一个 globalThis，所以宿主进程读得到。 */
const trace = []
globalThis.__pluginTrace = trace

function writePlugin(root, dirName, files) {
  const dir = path.join(root, dirName)
  fs.mkdirSync(dir, { recursive: true })
  for (const [name, content] of Object.entries(files)) {
    fs.writeFileSync(path.join(dir, name), content, 'utf8')
  }
  return dir
}

const goodSource = (token) => `// 好插件：正常 activate，登记 dispose，导出 deactivate
globalThis.__pluginTrace.push('good:activate:' + ${JSON.stringify(token)})
export async function activate(ctx) {
  ctx.log.info('token=' + ${JSON.stringify(token)})
  ctx.onDispose(() => { globalThis.__pluginTrace.push('good:dispose') })
}
export async function deactivate() {
  globalThis.__pluginTrace.push('good:deactivate')
}
`

const degradedSource = (token) => `export function activate(ctx) {
  ctx.log.info('degraded token=' + ${JSON.stringify(token)})
  globalThis.__pluginTrace.push('degraded:activate:' + ${JSON.stringify(token)})
}
export function deactivate() {
  globalThis.__pluginTrace.push('degraded:deactivate')
}
`

// 「改 plugin.json 的 id」这条缺陷现场用的夹具：activate 时把**当时的 ctx.id** 写进
// dispose 回调里，这样测试能证明「旧 id 那条记录的清理真的跑过」，而不是只从表里被删掉。
const renamerSource = (token) => `export async function activate(ctx) {
  globalThis.__pluginTrace.push('renamer:activate:' + ctx.id + ':' + ${JSON.stringify(token)})
  ctx.onDispose(() => { globalThis.__pluginTrace.push('renamer:dispose:' + ctx.id) })
}
export async function deactivate() {
  globalThis.__pluginTrace.push('renamer:deactivate')
}
`

// ── 造插件 ────────────────────────────────────────────────────────────
const goodDir = writePlugin(pluginsRoot, 'good', {
  'plugin.json': JSON.stringify({ id: 'good', version: '1.2.3', entry: 'plugin.mjs' }, null, 2),
  'plugin.mjs': goodSource('A'),
})

writePlugin(pluginsRoot, 'no-manifest', {
  // 裸 .js 在「没有 package.json 的作用域」里会被 Node 当 CommonJS 解析，
  // 所以这个插件在自己的目录里声明 type=module —— 这也是给用户看的写法示范。
  'package.json': JSON.stringify({ type: 'module' }, null, 2),
  'plugin.js': `export function activate(ctx) {
  ctx.log.info('no-manifest activated')
  globalThis.__pluginTrace.push('no-manifest:activate')
}
`,
})

writePlugin(pluginsRoot, 'bad-activate', {
  'plugin.json': JSON.stringify({ id: 'bad-activate' }, null, 2),
  'plugin.mjs': `export function activate() { throw new Error('boom-activate') }
export function deactivate() { globalThis.__pluginTrace.push('bad-activate:deactivate') }
`,
})

writePlugin(pluginsRoot, 'bad-deactivate', {
  'plugin.json': JSON.stringify({ id: 'bad-deactivate' }, null, 2),
  'plugin.mjs': `export function activate(ctx) {
  ctx.log.info('bad-deactivate activated')
  globalThis.__pluginTrace.push('bad-deactivate:activate')
}
export async function deactivate() { throw new Error('boom-deactivate') }
`,
})

writePlugin(pluginsRoot, 'bad-manifest', {
  'plugin.json': '{ "id": "bad-manifest", ', // 故意写坏的 JSON
  'plugin.mjs': `export function activate() { globalThis.__pluginTrace.push('bad-manifest:activate') }
`,
})

writePlugin(pluginsRoot, 'escape-entry', {
  'plugin.json': JSON.stringify({ id: 'escape-entry', entry: '../../evil.mjs' }, null, 2),
  'plugin.mjs': `export function activate() { globalThis.__pluginTrace.push('escape-entry:activate') }
`,
})

writePlugin(pluginsRoot, 'no-entry', {
  'README.md': '# 这个插件目录里没有入口文件\n',
})

writePlugin(pluginsRoot, 'bad-export', {
  'plugin.json': JSON.stringify({ id: 'bad-export' }, null, 2),
  'plugin.mjs': `export const nope = 1\n`,
})

writePlugin(pluginsRootB, 'degraded', {
  'plugin.json': JSON.stringify({ id: 'degraded', entry: 'plugin.mjs' }, null, 2),
  'plugin.mjs': degradedSource('D1'),
})

// ── ctx.log 契约的夹具（独立目录，免得动上面「8 个插件」的计数） ────────
// 活的缺陷现场：示例插件 `data/plugins/hello/plugin.mjs` 写的是 `ctx.log('…')`（函数式），
// 而实现只给了 `{ info, warn, error }`（对象式）→ activate 里 `ctx.log is not a function`。
// 这份夹具把**两种写法都演一遍**，钉死「两种都必须成立」。
const pluginsRootC = path.join(tmp, 'plugins-log')

writePlugin(pluginsRootC, 'log-shape', {
  'plugin.json': JSON.stringify({ id: 'log-shape', version: '1.0.0', entry: 'plugin.mjs' }, null, 2),
  'plugin.mjs': `export function activate(ctx) {
  globalThis.__pluginTrace.push('log-shape:typeof=' + typeof ctx.log + '/' + typeof ctx.log.info)
  ctx.log('plain message')
  ctx.log('warn message', 'warn')
  ctx.log.error('error via method')
  ctx.log({ nested: { a: 1 } })
  ctx.log(new Error('boom-in-log'))
  const cyclic = {}; cyclic.self = cyclic
  ctx.log(cyclic)
  ctx.log('level typo', 'bogus')
  ctx.log.info('info via method', 'second part')
  globalThis.__pluginTrace.push('log-shape:activate-done')
}
`,
})

writePlugin(pluginsRootC, 'log-flood', {
  'plugin.json': JSON.stringify({ id: 'log-flood', entry: 'plugin.mjs' }, null, 2),
  'plugin.mjs': `export function activate(ctx) {
  for (let i = 1; i <= 120; i += 1) ctx.log('flood ' + i)
  globalThis.__pluginTrace.push('log-flood:activate-done')
}
`,
})

const missingRoot = path.join(tmp, 'definitely-not-here')

async function waitFor(predicate, timeoutMs) {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    if (predicate()) return true
    await new Promise(resolve => setTimeout(resolve, 50))
  }
  return predicate() === true
}

const silentLogger = { info() {}, warn() {}, error() {} }
let mainHost = null
let degradedHost = null
let logHost = null
let renameHost = null
let swapHost = null

try {
  const {
    PluginHost,
    PLUGIN_STATUS,
    PLUGIN_ERROR,
    PLUGIN_LOG_LEVELS,
    startPluginHost,
    stopPluginHost,
    getPluginHost,
  } = await import('./runtime/plugin-host.js')
  const { handlePluginRoutes } = await import('./api/routes/plugins.js')

  // ── 1. 插件目录不存在：空列表、不报错、不建目录 ─────────────────────
  {
    const host = new PluginHost({ dir: missingRoot, logger: silentLogger, reloadDebounceMs: 10 })
    const snapshot = await host.start()
    assert.equal(snapshot.dirExists, false)
    assert.equal(snapshot.count, 0)
    assert.deepEqual(snapshot.plugins, [])
    assert.equal(snapshot.dirError, null, '目录不存在不是错误')
    assert.equal(snapshot.watching, false)
    assert.ok(snapshot.watchReason, '要说清为什么没在监视')
    assert.equal(fs.existsSync(missingRoot), false, '宿主不许凭空建出插件目录')
    await host.stop()
  }

  // ── 2. 发现 + 加载：四种状态与五类契约错误 ─────────────────────────
  mainHost = await startPluginHost({ logger: silentLogger, reloadDebounceMs: 120 })
  assert.equal(getPluginHost(), mainHost, '路由看到的必须是同一个宿主实例')
  {
    const snapshot = mainHost.snapshot()
    assert.equal(snapshot.dir, pluginsRoot)
    assert.equal(snapshot.dirExists, true)
    assert.equal(snapshot.count, 8, `应发现 8 个插件目录，实际 ${snapshot.count}`)

    const byId = new Map(snapshot.plugins.map(p => [p.id, p]))
    const expectStatus = (id, status) => {
      const record = byId.get(id)
      assert.ok(record, `插件 ${id} 应该被发现了`)
      assert.equal(record.status, status, `${id} 状态应为 ${status}，实际 ${record.status} / ${record.error?.message}`)
      return record
    }

    const good = expectStatus('good', PLUGIN_STATUS.LOADED)
    assert.equal(good.version, '1.2.3', '版本来自清单')
    assert.equal(good.entry, 'plugin.mjs')
    assert.equal(good.error, null)
    assert.ok(good.loadedAt > 0)
    assert.equal(good.activateCount, 1)

    // 没有清单 → id 用目录名，entry 用默认 plugin.js
    const noManifest = expectStatus('no-manifest', PLUGIN_STATUS.LOADED)
    assert.equal(noManifest.hasManifest, false)
    assert.equal(noManifest.manifestPath, null)
    assert.equal(noManifest.version, null)
    assert.equal(noManifest.entry, 'plugin.js')

    const badActivate = expectStatus('bad-activate', PLUGIN_STATUS.ERROR)
    assert.equal(badActivate.error.code, PLUGIN_ERROR.ACTIVATE_FAILED)
    assert.ok(/boom-activate/.test(badActivate.error.message), '要带出插件自己的异常信息')

    const badManifest = expectStatus('bad-manifest', PLUGIN_STATUS.ERROR)
    assert.equal(badManifest.error.code, PLUGIN_ERROR.BAD_MANIFEST)
    assert.ok(/not valid JSON/.test(badManifest.error.message))

    const escapeEntry = expectStatus('escape-entry', PLUGIN_STATUS.ERROR)
    assert.equal(escapeEntry.error.code, PLUGIN_ERROR.BAD_MANIFEST)
    assert.ok(/relative path/.test(escapeEntry.error.message), '入口不许逃出插件目录')

    const noEntry = expectStatus('no-entry', PLUGIN_STATUS.ERROR)
    assert.equal(noEntry.error.code, PLUGIN_ERROR.ENTRY_NOT_FOUND)

    const badExport = expectStatus('bad-export', PLUGIN_STATUS.ERROR)
    assert.equal(badExport.error.code, PLUGIN_ERROR.INVALID_EXPORT)

    // deactivate 抛错不影响「加载成功」这个事实
    const badDeactivate = expectStatus('bad-deactivate', PLUGIN_STATUS.LOADED)
    assert.equal(badDeactivate.error, null)

    // 错误隔离：坏插件不许影响好插件——它们该跑的 activate 都跑了
    assert.ok(trace.includes('good:activate:A'))
    assert.ok(trace.includes('no-manifest:activate'))
    assert.ok(trace.includes('bad-deactivate:activate'))
    assert.equal(trace.includes('bad-manifest:activate'), false, '清单非法就不该 import 它的入口')
    assert.equal(trace.includes('escape-entry:activate'), false, '入口越界就不该 import')
  }

  // ── 3. 坏插件重载后仍然是坏插件，但宿主不崩、好插件照常 ────────────
  {
    const reloaded = await mainHost.reload('bad-activate')
    assert.equal(reloaded.status, PLUGIN_STATUS.ERROR)
    assert.equal(reloaded.error.code, PLUGIN_ERROR.ACTIVATE_FAILED)
    assert.equal(mainHost.get('good').status, PLUGIN_STATUS.LOADED, '坏插件重载不许拖垮好插件')

    // 清单非法 → 修好它 → 重载即可加载（重载会重读清单）
    fs.writeFileSync(
      path.join(pluginsRoot, 'bad-manifest', 'plugin.json'),
      JSON.stringify({ id: 'bad-manifest' }, null, 2),
      'utf8',
    )
    const fixed = await mainHost.reload('bad-manifest')
    assert.equal(fixed.status, PLUGIN_STATUS.LOADED, JSON.stringify(fixed.error))
    assert.ok(trace.includes('bad-manifest:activate'))
  }

  // ── 4. 手动重载：先 deactivate、再缓存破坏重新 import ───────────────
  {
    fs.writeFileSync(path.join(goodDir, 'plugin.mjs'), goodSource('B'), 'utf8')
    const plugin = await mainHost.reload('good')
    assert.equal(plugin.status, PLUGIN_STATUS.LOADED)
    assert.equal(plugin.activateCount, 2)

    const deactivateAt = trace.indexOf('good:deactivate')
    const disposeAt = trace.indexOf('good:dispose')
    const lastB = trace.lastIndexOf('good:activate:B')
    assert.ok(deactivateAt !== -1, '重载必须先调插件的 deactivate()')
    assert.ok(disposeAt !== -1, 'onDispose 登记的回调必须由宿主跑掉')
    assert.ok(lastB > deactivateAt, '顺序必须是 deactivate → activate')
    assert.ok(lastB > disposeAt, 'dispose 必须在重新 activate 之前跑完')

    // 缓存破坏的**实质**断言：新代码真的被求值了（拿到的是 B 而不是又跑一遍 A）
    assert.ok(trace.includes('good:activate:A'))
    assert.ok(trace.includes('good:activate:B'), '重载后必须执行新代码（query 缓存破坏生效）')
    assert.ok(plugin.logs.some(line => line.message.includes('token=B')), 'ctx.log 要能证明跑的是新代码')
  }

  // ── 5. fs.watch 真的事件 → 自动重载（实测，不假装） ─────────────────
  {
    const snapshot = mainHost.snapshot()
    const startedAt = Date.now()
    fs.writeFileSync(path.join(goodDir, 'plugin.mjs'), goodSource('C'), 'utf8')
    let observed = await waitFor(() => trace.includes('good:activate:C'), 4000)
    if (!observed) {
      // 再改一次：某些平台/编辑器会吞掉第一次事件，给它第二次机会。仍然没反应才判失败。
      fs.writeFileSync(path.join(goodDir, 'plugin.mjs'), goodSource('C'), 'utf8')
      observed = await waitFor(() => trace.includes('good:activate:C'), 4000)
    }
    const elapsed = Date.now() - startedAt
    console.log(`[test] fs.watch：watching=${snapshot.watching}，文件改动后自动重载=${observed}（${elapsed}ms）`)
    if (snapshot.watching) {
      assert.equal(observed, true, '宿主声称在监视，就必须真的因文件改动而重载')
    } else {
      console.log(`[test] 本机 fs.watch 不可用（${snapshot.watchReason}）→ 按设计降级为只支持手动重载`)
    }
  }

  // ── 6. 手动重载永远可用（不依赖 fs.watch） ──────────────────────────
  {
    fs.writeFileSync(path.join(goodDir, 'plugin.mjs'), goodSource('E'), 'utf8')
    const plugin = await mainHost.reload('good')
    assert.equal(plugin.status, PLUGIN_STATUS.LOADED)
    assert.ok(trace.includes('good:activate:E'), '手动 reload 必须拿到最新代码')
  }

  // ── 7. deactivate 抛错：重载照样成功，但如实给出 warning ─────────────
  {
    const plugin = await mainHost.reload('bad-deactivate')
    assert.equal(plugin.status, PLUGIN_STATUS.LOADED, '一个坏清理函数不该让插件再也回不来')
    assert.equal(plugin.warnings.length, 1)
    assert.equal(plugin.warnings[0].code, PLUGIN_ERROR.DEACTIVATE_FAILED)
    assert.ok(/boom-deactivate/.test(plugin.warnings[0].message))
  }

  // ── 8. 启停 ────────────────────────────────────────────────────────
  {
    const before = trace.length
    const disabled = await mainHost.setEnabled('good', false)
    assert.equal(disabled.status, PLUGIN_STATUS.DISABLED)
    assert.equal(disabled.enabled, false)
    assert.ok(trace.slice(before).includes('good:deactivate'), '停用必须调 deactivate')

    await assert.rejects(
      () => mainHost.reload('good'),
      (error) => error.code === 'PLUGIN_DISABLED',
      '停用的插件不许被重载（那是「看起来成功」）',
    )

    const enabled = await mainHost.setEnabled('good', true)
    assert.equal(enabled.status, PLUGIN_STATUS.LOADED)
    assert.equal(enabled.error, null)

    // 对**已经 loaded** 的插件再点一次「启用」：必须先跑掉旧实例的清理，
    // 不能叠着 activate 两遍（旧实例的资源会没人回收）。
    const beforeRepeat = trace.length
    const enabledAgain = await mainHost.setEnabled('good', true)
    assert.equal(enabledAgain.activateCount, enabled.activateCount + 1)
    assert.equal(enabledAgain.status, PLUGIN_STATUS.LOADED)
    assert.ok(trace.slice(beforeRepeat).includes('good:deactivate'), '重复启用必须先停用旧实例')

    // 坏插件被停用后，error 信息要保留下来（解释「为什么它是坏的」）
    const offline = await mainHost.setEnabled('bad-activate', false)
    assert.equal(offline.status, PLUGIN_STATUS.DISABLED)
    assert.equal(offline.error.code, PLUGIN_ERROR.ACTIVATE_FAILED)
    const back = await mainHost.setEnabled('bad-activate', true)
    assert.equal(back.status, PLUGIN_STATUS.ERROR, '代码没改，启用后还是坏')
  }

  // ── 9. HTTP 路由 ───────────────────────────────────────────────────
  {
    const call = async (method, pathname, body, rawBody) => {
      const url = new URL(`http://127.0.0.1:3000${pathname}`)
      let status = null
      let payload = null
      const res = {
        writeHead(code) { status = code },
        setHeader() {},
        end(chunk) { payload = chunk ? JSON.parse(chunk) : null },
      }
      const req = {
        method,
        headers: { 'content-type': 'application/json' },
        on(event, handler) {
          if (event === 'data') {
            if (rawBody !== undefined) handler(Buffer.from(rawBody, 'utf8'))
            else if (body !== undefined) handler(Buffer.from(JSON.stringify(body), 'utf8'))
          }
          if (event === 'end') handler()
        },
      }
      const handled = await handlePluginRoutes(req, res, url)
      return { handled, status, payload }
    }

    const list = await call('GET', '/plugins')
    assert.equal(list.handled, true)
    assert.equal(list.status, 200)
    assert.equal(list.payload.ok, true)
    assert.equal(list.payload.dir, pluginsRoot)
    assert.equal(list.payload.plugins.length, 8)
    assert.equal(typeof list.payload.watching, 'boolean')
    // 接口**不接受路径**：请求里没有也别想有 dir 覆盖
    assert.equal(list.payload.dir, mainHost.dir)

    const reloaded = await call('POST', '/plugins/reload', { id: 'good' })
    assert.equal(reloaded.status, 200, JSON.stringify(reloaded.payload))
    assert.equal(reloaded.payload.ok, true)
    assert.equal(reloaded.payload.plugin.status, PLUGIN_STATUS.LOADED)

    // 重载一个仍然坏的插件：**不能**回 2xx
    const broken = await call('POST', '/plugins/reload', { id: 'bad-activate' })
    assert.equal(broken.status, 500)
    assert.equal(broken.payload.ok, false)
    assert.equal(broken.payload.code, PLUGIN_ERROR.ACTIVATE_FAILED)
    assert.ok(/boom-activate/.test(broken.payload.error))

    const toggled = await call('POST', '/plugins/toggle', { id: 'good', enabled: false })
    assert.equal(toggled.status, 200)
    assert.equal(toggled.payload.plugin.status, PLUGIN_STATUS.DISABLED)
    assert.equal((await call('GET', '/plugins')).payload.plugins.find(p => p.id === 'good').status, PLUGIN_STATUS.DISABLED)

    const disabledReload = await call('POST', '/plugins/reload', { id: 'good' })
    assert.equal(disabledReload.status, 409)
    assert.equal(disabledReload.payload.code, 'PLUGIN_DISABLED')

    const enabledBad = await call('POST', '/plugins/toggle', { id: 'bad-activate', enabled: true })
    assert.equal(enabledBad.status, 500)
    assert.equal(enabledBad.payload.code, PLUGIN_ERROR.ACTIVATE_FAILED)

    await call('POST', '/plugins/toggle', { id: 'good', enabled: true })

    // 坏输入：每一种都要给出原因
    const noId = await call('POST', '/plugins/reload', {})
    assert.equal(noId.status, 400)
    assert.equal(noId.payload.code, 'PLUGIN_ID_REQUIRED')

    const unknown = await call('POST', '/plugins/reload', { id: 'never-existed' })
    assert.equal(unknown.status, 404)
    assert.equal(unknown.payload.code, 'PLUGIN_NOT_FOUND')
    assert.equal(unknown.payload.ok, false)

    const badToggle = await call('POST', '/plugins/toggle', { id: 'good', enabled: 'yes' })
    assert.equal(badToggle.status, 400)
    assert.equal(badToggle.payload.code, 'PLUGIN_ENABLED_REQUIRED')

    const badBody = await call('POST', '/plugins/reload', undefined, '{not json')
    assert.equal(badBody.status, 400)
    assert.equal(badBody.payload.code, 'BAD_BODY')
    assert.ok(/invalid JSON/.test(badBody.payload.error), '要带上真正的原因')

    const wrongMethod = await call('GET', '/plugins/reload')
    assert.equal(wrongMethod.status, 405)
    assert.equal(wrongMethod.payload.code, 'METHOD_NOT_ALLOWED')

    // 不认领别的路径，留给后面的路由
    assert.equal((await call('GET', '/plugin')).handled, false)
    assert.equal((await call('GET', '/plugins/unknown')).handled, false)
    assert.equal((await call('GET', '/worktrees')).handled, false)
  }

  // ── 10. fs.watch 不可用时的降级：只支持手动重载，并如实说明 ─────────
  {
    degradedHost = new PluginHost({
      dir: pluginsRootB,
      logger: silentLogger,
      reloadDebounceMs: 10,
      watch: () => { throw new Error('ENOSYS: fs.watch not supported here') },
    })
    const snapshot = await degradedHost.start()
    assert.equal(snapshot.watching, false, '建不起 watcher 就不能声称在监视')
    assert.ok(/ENOSYS/.test(snapshot.watchReason), `要说清原因，实际：${snapshot.watchReason}`)
    assert.equal(snapshot.plugins[0].status, PLUGIN_STATUS.LOADED, '没有监视也要能加载')
    assert.equal(snapshot.plugins[0].watching, false)

    // 降级之后手动重载依然可用，缓存破坏依然生效，且不需要任何文件事件
    fs.writeFileSync(path.join(pluginsRootB, 'degraded', 'plugin.mjs'), degradedSource('D2'), 'utf8')
    const plugin = await degradedHost.reload('degraded')
    assert.equal(plugin.status, PLUGIN_STATUS.LOADED)
    assert.ok(trace.includes('degraded:activate:D2'))
    assert.ok(trace.includes('degraded:deactivate'))
  }

  // ── 11. ctx.log 契约：两种写法都成立、进 logs[]、超限截断、永不抛错 ──
  {
    // 宿主 logger **真的抛**（只在插件那一路抛），用来验证「写日志失败不会把插件搞挂」。
    const hostLogLines = []
    let pluginLogCalls = 0
    const throwingLogger = {
      info(message) {
        hostLogLines.push(String(message))
        if (String(message).includes('[plugin:')) { pluginLogCalls += 1; throw new Error('host logger boom') }
      },
      warn(message) {
        hostLogLines.push(String(message))
        if (String(message).includes('[plugin:')) { pluginLogCalls += 1; throw new Error('host logger boom') }
      },
      error(message) {
        hostLogLines.push(String(message))
        if (String(message).includes('[plugin:')) { pluginLogCalls += 1; throw new Error('host logger boom') }
      },
    }

    logHost = new PluginHost({
      dir: pluginsRootC,
      logger: throwingLogger,
      reloadDebounceMs: 10,
      maxLogLines: 20, // 显式给一个小上限：截断策略要按**这个数字**验
    })
    const snapshot = await logHost.start()

    // ① 不抛：activate 里用了 ctx.log 的两种写法，插件仍然是 loaded 而不是 ACTIVATE_FAILED
    const shape = snapshot.plugins.find(p => p.id === 'log-shape')
    assert.ok(shape, 'log-shape 应该被发现')
    assert.equal(shape.status, PLUGIN_STATUS.LOADED, `ctx.log 不许让 activate 失败：${shape.error?.message}`)
    assert.equal(shape.error, null)
    assert.ok(trace.includes('log-shape:activate-done'), 'activate 必须跑到最后一行')
    assert.ok(
      trace.includes('log-shape:typeof=function/function'),
      'ctx.log 必须既能当函数调、又带 .info 方法（两种契约写法都成立）',
    )
    assert.ok(trace.includes('log-flood:activate-done'), '120 条日志也不许把 activate 打断')

    // ② 消息进了该插件的 logs[]，结构与既有形状一致（{ level, message, at }）
    //    末尾那条 `activated (…)` 是宿主自己在 activate 成功后记的，也走同一个 logs[]。
    assert.deepEqual(
      shape.logs.slice(0, 8).map(line => [line.level, line.message]),
      [
        ['info', 'plain message'],            // ctx.log(msg) → 默认 info
        ['warn', 'warn message'],             // ctx.log(msg, level)
        ['error', 'error via method'],        // ctx.log.error(msg) 仍然可用
        ['info', '{"nested":{"a":1}}'],       // 对象参数被序列化，不抛
        ['info', shape.logs[4].message],      // Error → stack，下面单独断言
        ['info', '[object Object]'],          // 循环引用 → 退化成 String()，不抛
        ['info', 'level typo bogus'],         // 不认识的级别 → 并进消息、按 info 记，不抛
        ['info', 'info via method second part'],
      ],
      `ctx.log 的记录形状/内容不对：${JSON.stringify(shape.logs)}`,
    )
    assert.equal(shape.logs.length, 9, '8 条插件日志 + 1 条宿主自己的 activated')
    assert.equal(shape.logs[8].message, 'activated (plugin.mjs)', '宿主自己的日志与插件日志同一个数组')
    assert.ok(/^Error: boom-in-log/.test(shape.logs[4].message), 'Error 参数要留下 message/stack')
    for (const line of shape.logs) {
      assert.equal(typeof line.at, 'number', '每条日志都要有 at 时间戳')
      assert.ok(PLUGIN_LOG_LEVELS.includes(line.level), `级别只能是 info/warn/error，实际 ${line.level}`)
    }

    // 宿主 logger 拿到的仍然带 `[plugin:<id>]` 前缀（文件头承诺的那一条）
    assert.ok(hostLogLines.includes('[plugin:log-shape] plain message'), '宿主侧要带 [plugin:<id>] 前缀')
    // 而且这个 logger **确实抛过**——插件却照样 loaded、日志照样留在 logs[] 里
    assert.ok(pluginLogCalls > 0, '这个夹具的宿主 logger 必须真的抛过，否则验不到「不可失败」')

    // ③ 超过上限按既有策略截断：留**最近的** maxLogLines 条
    const flood = snapshot.plugins.find(p => p.id === 'log-flood')
    assert.equal(flood.status, PLUGIN_STATUS.LOADED, JSON.stringify(flood.error))
    assert.equal(flood.logs.length, 20, 'logs[] 必须遵守 maxLogLines 上限')
    const floodMessages = flood.logs.map(line => line.message)
    assert.equal(floodMessages[0], 'flood 102', '截断要丢最旧的、留最近的')
    assert.equal(floodMessages[18], 'flood 120')
    assert.equal(floodMessages[19], 'activated (plugin.mjs)', '宿主自己那条也吃同一个上限')
    assert.ok(flood.logs.every(line => line.level === 'info'), 'flood 全是 info')

    console.log(`[test] ctx.log：两种写法都成立；上限 ${flood.logs.length} 条生效；宿主 logger 抛 ${pluginLogCalls} 次也没把插件搞挂`)
  }

  // ── 12. 停机：清理回调跑掉，状态回 discovered ───────────────────────
  {
    const snapshot = await mainHost.stop()
    assert.equal(snapshot.watching, false)
    for (const plugin of snapshot.plugins) {
      assert.equal(plugin.status, PLUGIN_STATUS.DISCOVERED, `${plugin.id} 停机后不该还写着 loaded`)
    }
    assert.ok(trace.includes('good:dispose'), '停机同样要走宿主代管的清理')
  }

  // ── 13. 改清单 id：按**目录**归一，旧记录被替换（跑 dispose）而不是留成孤儿 ──
  //      缺陷现场：改 id 之后旧记录指向的目录还在，老代码的清理循环「目录在就跳过」，
  //      于是出现两条指向同一目录的记录，旧那条永远不消失、只有重启才干净。
  {
    const renameRoot = path.join(tmp, 'plugins-rename')
    const renameDir = writePlugin(renameRoot, 'renamer', {
      'plugin.json': JSON.stringify({ id: 'renamer', entry: 'plugin.mjs' }, null, 2),
      'plugin.mjs': renamerSource('R1'),
    })
    renameHost = new PluginHost({ dir: renameRoot, logger: silentLogger, reloadDebounceMs: 10 })
    await renameHost.start()
    assert.equal(renameHost.snapshot().count, 1)
    assert.equal(renameHost.get('renamer').status, PLUGIN_STATUS.LOADED)

    // ① 同一个目录把 id 改成 renamer-v2，触发重扫 + 全量重载
    const changeMark = trace.length
    fs.writeFileSync(
      path.join(renameDir, 'plugin.json'),
      JSON.stringify({ id: 'renamer-v2', entry: 'plugin.mjs' }, null, 2),
      'utf8',
    )
    await renameHost.reloadAll()

    let snapshot = renameHost.snapshot()
    assert.equal(snapshot.count, 1, `改 id 后该目录必须只有一条记录，实际 ${JSON.stringify(snapshot.plugins.map(p => p.id))}`)
    assert.deepEqual(snapshot.plugins.map(p => p.id), ['renamer-v2'], '旧 id 的记录必须被替换掉')
    assert.equal(renameHost.get('renamer'), null, '旧 id 不该还能查到')
    const renamed = renameHost.get('renamer-v2')
    assert.ok(renamed, '新 id 必须出现')
    assert.equal(renamed.status, PLUGIN_STATUS.LOADED, JSON.stringify(renamed.error))
    assert.equal(renamed.dir, renameDir, '新记录仍指向同一个目录')
    assert.equal(renamed.entryPath, path.join(renameDir, 'plugin.mjs'))
    // ② 旧记录的 dispose 真的被调用过（不是只从 records 里删掉）
    assert.ok(
      trace.slice(changeMark).includes('renamer:dispose:renamer'),
      `旧记录的 dispose 必须被跑掉，实际新增 trace=${JSON.stringify(trace.slice(changeMark))}`,
    )
    // ③ 记录集合与 discover() 一一对应
    assert.deepEqual(
      snapshot.plugins.map(p => p.id).sort(),
      renameHost.discover().plugins.map(p => p.id).sort(),
      'reloadAll() 之后记录集合必须与 discover() 一一对应',
    )

    // 再改一次 id，这次走**单插件 reload** 这条路（_refreshMetadata → _applyDescriptor 换 key）
    fs.writeFileSync(
      path.join(renameDir, 'plugin.json'),
      JSON.stringify({ id: 'renamer-v3', entry: 'plugin.mjs' }, null, 2),
      'utf8',
    )
    const reloaded = await renameHost.reload('renamer-v2')
    assert.equal(reloaded.id, 'renamer-v3', '单插件 reload 也必须把记录换到新 id 上')
    assert.equal(reloaded.status, PLUGIN_STATUS.LOADED, JSON.stringify(reloaded.error))
    assert.equal(renameHost.snapshot().count, 1, '单插件 reload 不许留下旧 id 的幽灵记录')
    assert.ok(trace.includes('renamer:dispose:renamer-v2'), '旧 id（renamer-v2）的 dispose 必须跑过')
    assert.deepEqual(
      renameHost.snapshot().plugins.map(p => p.id).sort(),
      renameHost.discover().plugins.map(p => p.id).sort(),
    )

    // ④ 普通 HMR 重载：连改几次入口文件，记录数不变、activateCount 每次只涨 1
    const before = renameHost.get('renamer-v3').activateCount
    const tokens = ['R2', 'R3', 'R4']
    for (const [index, token] of tokens.entries()) {
      fs.writeFileSync(path.join(renameDir, 'plugin.mjs'), renamerSource(token), 'utf8')
      const plugin = await renameHost.reload('renamer-v3')
      assert.equal(plugin.status, PLUGIN_STATUS.LOADED)
      assert.ok(trace.includes(`renamer:activate:renamer-v3:${token}`), '重载必须拿到新代码')
      assert.equal(renameHost.snapshot().count, 1, '普通 HMR 重载不许产生重复记录')
      assert.equal(
        renameHost.get('renamer-v3').activateCount,
        before + index + 1,
        '每次重载 activateCount 只许涨 1（不许重复 activate）',
      )
    }
    console.log(`[test] 改清单 id：目录归一后 1 条记录；旧 id dispose 跑过；HMR ${tokens.length} 次重载记录数稳定为 1`)

    // ⑤ 两个目录**互换 id**：换 key 时目标 id 正被另一条记录占着。不许互相覆盖
    //    （覆盖会连对方的 internals/watcher 一起丢掉），也不许漏掉任何一条的 dispose。
    const swapRoot = path.join(tmp, 'plugins-swap')
    const alphaDir = writePlugin(swapRoot, 'alpha', {
      'plugin.json': JSON.stringify({ id: 'alpha', entry: 'plugin.mjs' }, null, 2),
      'plugin.mjs': renamerSource('S0'),
    })
    const betaDir = writePlugin(swapRoot, 'beta', {
      'plugin.json': JSON.stringify({ id: 'beta', entry: 'plugin.mjs' }, null, 2),
      'plugin.mjs': renamerSource('S0'),
    })
    swapHost = new PluginHost({ dir: swapRoot, logger: silentLogger, reloadDebounceMs: 10 })
    await swapHost.start()
    assert.deepEqual(swapHost.snapshot().plugins.map(p => p.id).sort(), ['alpha', 'beta'])

    const swapMark = trace.length
    fs.writeFileSync(path.join(alphaDir, 'plugin.json'), JSON.stringify({ id: 'beta', entry: 'plugin.mjs' }, null, 2), 'utf8')
    fs.writeFileSync(path.join(betaDir, 'plugin.json'), JSON.stringify({ id: 'alpha', entry: 'plugin.mjs' }, null, 2), 'utf8')
    await swapHost.reloadAll()

    assert.equal(swapHost.snapshot().count, 2, '互换 id 后仍是两条记录，不许互相覆盖丢掉一条')
    assert.deepEqual(swapHost.snapshot().plugins.map(p => p.id).sort(), ['alpha', 'beta'])
    assert.equal(swapHost.get('beta').dir, alphaDir, 'id=beta 现在对应 alpha 目录')
    assert.equal(swapHost.get('alpha').dir, betaDir, 'id=alpha 现在对应 beta 目录')
    assert.equal(swapHost.get('beta').status, PLUGIN_STATUS.LOADED, JSON.stringify(swapHost.get('beta').error))
    assert.equal(swapHost.get('alpha').status, PLUGIN_STATUS.LOADED, JSON.stringify(swapHost.get('alpha').error))
    assert.ok(trace.slice(swapMark).includes('renamer:dispose:alpha'), 'alpha 旧 id 的记录必须跑 dispose')
    assert.ok(trace.slice(swapMark).includes('renamer:dispose:beta'), 'beta 旧 id 的记录必须跑 dispose')
    console.log('[test] 两目录互换 id：仍是 2 条记录，两条旧记录都跑了 dispose，两条新 id 都 loaded')
  }

  console.log('PASS plugin-host: discovery/manifest validation/isolation/HMR cache-bust/routes/toggle/degradation/ctx-log')
} finally {
  try { await stopPluginHost() } catch { /* 停机失败不影响结论 */ }
  try { await degradedHost?.stop() } catch { /* 同上 */ }
  try { await logHost?.stop() } catch { /* 同上 */ }
  try { await renameHost?.stop() } catch { /* 同上 */ }
  try { await swapHost?.stop() } catch { /* 同上 */ }
  try { fs.rmSync(tmp, { recursive: true, force: true }) } catch { /* 清理失败不影响结论 */ }
}
