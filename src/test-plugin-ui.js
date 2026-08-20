import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

// 插件 UI 扩展点（阶段 6.7 的第一项未做项）的测试：清单里的 `ui` 声明 → 汇总接口 →
// 面板文件服务（**含路径越界防护**）→ 界面侧的命令转换 / 面板骨架。
//
// 这里造的是**真的插件目录**（真的 plugin.json、真的 HTML 文件、真的 junction），
// 全程在临时目录里，绝不碰真实用户数据：
//   npm run test:plugin-ui
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'blm-plugin-ui-'))
process.env.ALICE_USER_DIR = tmp
process.env.ALICE_RESOURCES_DIR = process.cwd()
delete process.env.ALICE_PLUGINS_DIR

const pluginsRoot = path.join(tmp, 'plugins')
// 插件目录**之外**的一份文件：越界面板的靶子。它的内容一旦出现在响应体里就是漏了。
const outsideDir = path.join(tmp, 'outside')
fs.mkdirSync(outsideDir, { recursive: true })
const SECRET_MARKER = 'SECRET-OUTSIDE-CONTENT'
fs.writeFileSync(path.join(outsideDir, 'secret.html'), `<!doctype html><html><body>${SECRET_MARKER}</body></html>`, 'utf8')

const PLUGIN_SOURCE = `export function activate(ctx) { ctx.log.info('ui plugin up') }\n`

function writePlugin(root, dirName, files, { mkdirOnly = false } = {}) {
  const dir = path.join(root, dirName)
  fs.mkdirSync(dir, { recursive: true })
  if (mkdirOnly) return dir
  for (const [name, content] of Object.entries(files)) {
    const target = path.join(dir, name)
    fs.mkdirSync(path.dirname(target), { recursive: true })
    fs.writeFileSync(target, content, 'utf8')
  }
  return dir
}

const manifest = (id, ui, extra = {}) => JSON.stringify({ id, version: '1.0.0', entry: 'plugin.mjs', ...extra, ...(ui === undefined ? {} : { ui }) }, null, 2)

// ── 1. 正常的插件：一条命令 + 一个存在的面板 + 一个不存在的面板 ──────────
writePlugin(pluginsRoot, 'weather-ui', {
  'plugin.json': manifest('weather-ui', {
    commands: [{
      cmd: '/weather',
      label: '天气',
      description: '查一个城市的天气',
      prompt: '帮我查一下 {input} 的天气',
    }],
    panels: [
      { id: 'weather', title: '天气面板', entry: 'ui/panel.html' },
      { id: 'ghost', title: '缺失面板', entry: 'ui/nope.html' },
    ],
  }),
  'plugin.mjs': PLUGIN_SOURCE,
  'ui/panel.html': '<!doctype html><html><body>WEATHER-PANEL-MARKER 天气面板</body></html>',
})

// ── 2. 面板 entry 指到插件目录**之外**：必须被拒，且它的命令仍然可用 ──────
writePlugin(pluginsRoot, 'escape-panel', {
  'plugin.json': manifest('escape-panel', {
    commands: [{ cmd: '/escape-ok', label: '仍要能用', prompt: '这条命令是好的' }],
    panels: [{ id: 'escape', title: '越界面板', entry: '../../outside/secret.html' }],
  }),
  'plugin.mjs': PLUGIN_SOURCE,
})

// ── 3. ui 段整个写错（不是对象）──────────────────────────────────────────
writePlugin(pluginsRoot, 'bad-ui', {
  'plugin.json': manifest('bad-ui', 'not-an-object'),
  'plugin.mjs': PLUGIN_SOURCE,
})

// ── 4. 命令声明逐条写错：只有一条是合法的 ────────────────────────────────
writePlugin(pluginsRoot, 'bad-command', {
  'plugin.json': manifest('bad-command', {
    commands: [
      { cmd: 'weather', prompt: '少了斜杠' },          // 名字不合法
      { cmd: '/noprompt' },                            // 没有 prompt：点了什么都不会发生
      { cmd: '/badlabel', label: 5, prompt: '标签类型错' },
      { cmd: '/ok-cmd', label: '好命令', prompt: '好命令的内容' },
    ],
  }),
  'plugin.mjs': PLUGIN_SOURCE,
})

// ── 5. 两个插件声明同一个命令：第一个生效，第二个如实上报 ────────────────
for (const id of ['twin-a', 'twin-b']) {
  writePlugin(pluginsRoot, id, {
    'plugin.json': manifest(id, { commands: [{ cmd: '/twins', label: id, prompt: `来自 ${id}` }] }),
    'plugin.mjs': PLUGIN_SOURCE,
  })
}

// ── 6. 目录内的一个 junction 指到插件目录之外 ────────────────────────────
// 清单校验只看字符串解析结果（`ui/secret.html` 确实在目录里），唯有 realpath 那道
// 检查能看出这是个链接。所以这一条**必须**在服务面板那条路径上被测到。
const jailDir = writePlugin(pluginsRoot, 'jail-panel', {
  'plugin.json': manifest('jail-panel', {
    panels: [{ id: 'secret', title: '链接面板', entry: 'ui/secret.html' }],
  }),
  'plugin.mjs': PLUGIN_SOURCE,
})
let junctionCreated = false
let junctionReason = ''
try {
  fs.symlinkSync(outsideDir, path.join(jailDir, 'ui'), 'junction')
  junctionCreated = fs.existsSync(path.join(jailDir, 'ui', 'secret.html'))
  if (!junctionCreated) junctionReason = 'junction created but the target file is not reachable'
} catch (error) {
  junctionReason = error?.message || String(error)
}

// ── 7. 没有 ui 段的插件：什么都不声明，也不该出现在 errors 里 ────────────
writePlugin(pluginsRoot, 'no-ui', {
  'plugin.json': manifest('no-ui', undefined),
  'plugin.mjs': PLUGIN_SOURCE,
  'ui/panel.html': '<!doctype html><html><body>这个文件没有被声明，不该被服务</body></html>',
})

const silentLogger = { info() {}, warn() {}, error() {} }
let host = null
let noEntryHost = null

try {
  const { startPluginHost, stopPluginHost, PLUGIN_UI_ERROR, resolvePluginPanelPath, PluginHost } = await import('./runtime/plugin-host.js')
  const { handlePluginRoutes } = await import('./api/routes/plugins.js')

  // HTTP 调用垫片：与 test-plugin-host.js 同一份写法，多记下响应头（面板要断言 Content-Type）。
  const call = async (method, pathname, body) => {
    const url = new URL(`http://127.0.0.1:3000${pathname}`)
    let status = null
    let headers = null
    let text = ''
    const res = {
      writeHead(code, extra) { status = code; headers = extra || {} },
      setHeader() {},
      end(chunk) { text = chunk === undefined || chunk === null ? '' : String(chunk) },
    }
    const req = {
      method,
      headers: { 'content-type': 'application/json' },
      on(event, handler) {
        if (event === 'data' && body !== undefined) handler(Buffer.from(JSON.stringify(body), 'utf8'))
        if (event === 'end') handler()
      },
    }
    const handled = await handlePluginRoutes(req, res, url)
    let payload = null
    if (status !== null && /application\/json/.test(headers?.['Content-Type'] || '')) {
      payload = text ? JSON.parse(text) : null
    }
    return { handled, status, headers, text, payload }
  }

  // ── A. 纯函数：越界判定的判据落在**解析结果**上，不是字符串上 ─────────
  {
    const dir = path.join(pluginsRoot, 'weather-ui')
    const ok = resolvePluginPanelPath(dir, 'ui/panel.html')
    assert.equal(ok.ok, true)
    assert.equal(ok.path, path.resolve(dir, 'ui/panel.html'))

    // 解析后仍在目录内 → 放行（判据不能退化成「字符串里有 ..」）
    const normalized = resolvePluginPanelPath(dir, 'ui/../ui/panel.html')
    assert.equal(normalized.ok, true, 'a/../b 解析后仍在目录内就该放行')
    assert.equal(normalized.path, path.resolve(dir, 'ui/panel.html'))

    for (const entry of ['../outside/secret.html', '../../outside/secret.html', 'ui/../../outside/secret.html']) {
      const escaped = resolvePluginPanelPath(dir, entry)
      assert.equal(escaped.ok, false, `${entry} 必须被拒绝`)
      assert.equal(escaped.code, 'PLUGIN_PANEL_ESCAPES_DIR')
    }

    // 关键一条：**同级目录**。用「字符串以插件目录开头」做判据的实现会在这里放行
    // （`<root>/plugins/weather-ui-evil/...` 确实以 `<root>/plugins/weather-ui` 开头）。
    const sibling = resolvePluginPanelPath(dir, '../weather-ui-evil/secret.html')
    assert.equal(sibling.ok, false, '前缀比较必须是路径前缀，不是字符串前缀')
    assert.equal(sibling.code, 'PLUGIN_PANEL_ESCAPES_DIR')

    const absolute = resolvePluginPanelPath(dir, path.join(outsideDir, 'secret.html'))
    assert.equal(absolute.ok, false, '绝对路径一律拒绝')
    assert.equal(absolute.code, 'PLUGIN_PANEL_ESCAPES_DIR')

    const empty = resolvePluginPanelPath(dir, '   ')
    assert.equal(empty.ok, false)
    assert.equal(empty.code, PLUGIN_UI_ERROR.BAD_UI_PANEL)

    if (path.sep === '\\') {
      const backslash = resolvePluginPanelPath(dir, '..\\outside\\secret.html')
      assert.equal(backslash.ok, false, 'Windows 反斜杠的越界同样要拒')
      assert.equal(backslash.code, 'PLUGIN_PANEL_ESCAPES_DIR')
    }
  }

  // ── B. 汇总接口 GET /plugins/ui ────────────────────────────────────────
  host = await startPluginHost({ logger: silentLogger, reloadDebounceMs: 10 })
  {
    const snapshot = host.snapshot()
    assert.equal(snapshot.count, 8, `应发现 8 个插件目录，实际 ${snapshot.count}`)
    for (const plugin of snapshot.plugins) {
      assert.equal(plugin.status, 'loaded', `${plugin.id} 应该照常加载：${plugin.error?.message || ''}`)
    }
    // 一条 UI 声明写错**不许**影响插件本身
    assert.equal(snapshot.plugins.find(p => p.id === 'escape-panel').error, null)
    assert.equal(snapshot.plugins.find(p => p.id === 'bad-ui').error, null)
    // GET /plugins 里能看到声明计数与逐条错误
    const escapeRecord = snapshot.plugins.find(p => p.id === 'escape-panel')
    assert.equal(escapeRecord.ui.declared, true)
    assert.equal(escapeRecord.ui.commands, 1)
    assert.equal(escapeRecord.ui.panels, 0)
    assert.equal(escapeRecord.ui.errors[0].code, PLUGIN_UI_ERROR.PANEL_ENTRY_ESCAPES_DIR)
    assert.equal(snapshot.plugins.find(p => p.id === 'no-ui').ui.declared, false)

    const ui = await call('GET', '/plugins/ui')
    assert.equal(ui.handled, true)
    assert.equal(ui.status, 200)
    assert.equal(ui.payload.ok, true)
    const { commands, panels, errors } = ui.payload

    // 命令：正常的进来，写错的/重复的都不进来
    const weatherCommand = commands.find(c => c.cmd === '/weather')
    assert.ok(weatherCommand, '/weather 应该在命令列表里')
    assert.equal(weatherCommand.plugin_id, 'weather-ui', '命令要带 plugin_id 以便追溯来源')
    assert.equal(weatherCommand.label, '天气')
    assert.equal(weatherCommand.prompt, '帮我查一下 {input} 的天气', 'prompt 是模板，原样下发')
    assert.ok(commands.some(c => c.cmd === '/escape-ok'), '面板坏掉的插件，它的**命令**仍然应该可用（逐条隔离）')
    assert.ok(commands.some(c => c.cmd === '/ok-cmd'))
    assert.equal(commands.some(c => c.cmd === '/noprompt'), false, '没有 prompt 的命令点了什么都不会发生 → 不收')
    assert.equal(commands.some(c => c.cmd === '/badlabel'), false, 'label 类型错 → 不收')
    assert.equal(commands.some(c => c.cmd === 'weather'), false, 'cmd 形状错 → 不收')
    const twins = commands.filter(c => c.cmd === '/twins')
    assert.equal(twins.length, 1, '同一个命令只生效一次')
    assert.equal(twins[0].plugin_id, 'twin-a', '第一个声明生效')

    // 面板：只有 entry 真的存在、且没越界的才下发
    const weatherPanel = panels.find(p => p.plugin_id === 'weather-ui' && p.id === 'weather')
    assert.ok(weatherPanel)
    assert.equal(weatherPanel.title, '天气面板')
    assert.equal(weatherPanel.entry, 'ui/panel.html')
    assert.equal(weatherPanel.url, '/plugins/ui/weather-ui/weather')
    assert.equal(panels.some(p => p.id === 'ghost'), false, 'entry 指的文件不存在 → 不下发')
    assert.equal(panels.some(p => p.id === 'escape'), false, 'entry 越界 → 不下发')
    assert.ok(panels.some(p => p.plugin_id === 'jail-panel' && p.id === 'secret'), 'junction 只有到服务那一刻才看得出来，声明阶段先如实下发')

    // 错误：每一条都要带 plugin_id，且**不能**把整个列表搞失效
    assert.ok(errors.length > 0)
    for (const error of errors) {
      assert.ok(error.plugin_id, `错误必须带 plugin_id 以便追溯到插件：${JSON.stringify(error)}`)
      assert.ok(error.code && error.message)
    }
    const codesOf = (id) => errors.filter(e => e.plugin_id === id).map(e => e.code)
    assert.deepEqual(codesOf('weather-ui'), [PLUGIN_UI_ERROR.PANEL_ENTRY_NOT_FOUND])
    assert.deepEqual(codesOf('escape-panel'), [PLUGIN_UI_ERROR.PANEL_ENTRY_ESCAPES_DIR])
    assert.deepEqual(codesOf('bad-ui'), [PLUGIN_UI_ERROR.BAD_UI_SECTION])
    assert.deepEqual(codesOf('bad-command'), [
      PLUGIN_UI_ERROR.BAD_UI_COMMAND,
      PLUGIN_UI_ERROR.BAD_UI_COMMAND,
      PLUGIN_UI_ERROR.BAD_UI_COMMAND,
    ])
    assert.deepEqual(codesOf('twin-b'), [PLUGIN_UI_ERROR.DUPLICATE_COMMAND])
    assert.deepEqual(codesOf('no-ui'), [], '没声明 ui 的插件不该出现在 errors 里')
  }

  // ── C. 面板端点：正常取到 / 越界与不存在都被如实拒绝 ────────────────────
  {
    const served = await call('GET', '/plugins/ui/weather-ui/weather')
    assert.equal(served.handled, true)
    assert.equal(served.status, 200)
    assert.equal(served.headers['Content-Type'], 'text/html; charset=utf-8')
    assert.ok(served.text.includes('WEATHER-PANEL-MARKER'), '要真的把面板文件内容回出来')
    assert.ok(served.text.includes('天气面板'), '按字节回，中文不能坏')

    // entry 指的文件不存在的那条声明在**声明阶段**就被拒了（并进了 errors），
    // 所以它不是一个「已声明的面板」→ 请求它得到的是「没有这个面板」。
    const missingFile = await call('GET', '/plugins/ui/weather-ui/ghost')
    assert.equal(missingFile.status, 404)
    assert.equal(missingFile.payload.code, PLUGIN_UI_ERROR.PANEL_NOT_DECLARED)

    const notDeclared = await call('GET', '/plugins/ui/weather-ui/nope')
    assert.equal(notDeclared.status, 404)
    assert.equal(notDeclared.payload.code, PLUGIN_UI_ERROR.PANEL_NOT_DECLARED)

    const unknownPlugin = await call('GET', '/plugins/ui/never-existed/weather')
    assert.equal(unknownPlugin.status, 404)
    assert.equal(unknownPlugin.payload.code, 'PLUGIN_NOT_FOUND')

    // entry 越界的插件：面板根本没被声明 → 404，而且**绝不**回插件目录之外的内容
    const escaped = await call('GET', '/plugins/ui/escape-panel/escape')
    assert.equal(escaped.status, 404)
    assert.equal(escaped.payload.code, PLUGIN_UI_ERROR.PANEL_NOT_DECLARED)
    assert.equal(escaped.text.includes(SECRET_MARKER), false, '越界面板的内容一个字都不许出去')

    // URL 层面的穿越（%2F 编码的斜杠，绕不过 URL 归一化，会真的打到本路由）：
    // 解码后过不了 id 字符集 → 400，而且路径永远不被当路径用。
    for (const target of [
      '/plugins/ui/..%2F..%2Foutside/secret',
      '/plugins/ui/weather-ui/..%2Fplugin.json',
      '/plugins/ui/%00/weather',
    ]) {
      const attack = await call('GET', target)
      assert.equal(attack.status, 400, `${target} 必须被拒绝，实际 ${attack.status}`)
      assert.equal(attack.payload.ok, false)
      assert.equal(attack.text.includes(SECRET_MARKER), false)
    }

    // **裸**的 `../` 根本到不了这里：WHATWG URL 在解析阶段就把路径归一化了
    // （`/plugins/ui/../weather-ui/weather` → `/plugins/weather-ui/weather`），
    // 于是这个请求连本路由都不匹配。这不是漏洞，而是「哪种穿越能打进来」的前提——
    // 所以防护必须落在**解码后的段**上，而不是「整个 URL 里有没有 ..」。
    const normalizedByParser = await call('GET', '/plugins/ui/../weather-ui/weather')
    assert.equal(normalizedByParser.handled, false, '裸 ../ 被 URL 解析器归一化，已经不是面板路由了')
    assert.equal(normalizedByParser.text.includes(SECRET_MARKER), false)

    // 一个**路径**（不是标识符）当插件 id：直接 400，而不是去盘上找
    const asPath = await call('GET', `/plugins/ui/${encodeURIComponent(outsideDir)}/secret`)
    assert.equal(asPath.status, 400)
    assert.equal(asPath.payload.code, PLUGIN_UI_ERROR.PANEL_ID_INVALID)
    assert.equal(asPath.text.includes(SECRET_MARKER), false)

    // 目录里的 junction 指到插件目录之外：声明阶段看不出来，服务这一刻必须拦住
    if (junctionCreated) {
      const throughLink = await call('GET', '/plugins/ui/jail-panel/secret')
      assert.equal(throughLink.status, 400, `junction 越界必须被拒，实际 ${throughLink.status}`)
      assert.equal(throughLink.payload.code, PLUGIN_UI_ERROR.PANEL_ENTRY_ESCAPES_DIR)
      assert.equal(throughLink.text.includes(SECRET_MARKER), false, '顺着链接读到的内容一个字都不许出去')
    } else {
      console.log(`[test] 本机建不起 junction（${junctionReason}）→ 跳过「目录内链接越界」这一条（如实跳过，不假装通过）`)
    }

    // 方法/路径不匹配：405 或者干脆不认领，别落进框架的 404 让人以为端点不存在
    const wrongMethod = await call('POST', '/plugins/ui')
    assert.equal(wrongMethod.status, 405)
    assert.equal(wrongMethod.payload.code, 'METHOD_NOT_ALLOWED')

    // 不认领别的路径（既有的三条端点行为不许被这次改动动到）
    assert.equal((await call('GET', '/plugin')).handled, false)
    assert.equal((await call('GET', '/plugins/unknown')).handled, false)
    assert.equal((await call('GET', '/plugins/ui/weather-ui')).handled, false, '面板端点只认两段式路径')
    assert.equal((await call('GET', '/plugins/ui/weather-ui/weather/extra')).handled, false)
    assert.equal((await call('GET', '/worktrees')).handled, false)
    assert.equal((await call('GET', '/plugins')).status, 200, '既有列表端点照常')

    // 只服务**声明过**的面板：插件目录里存在但没声明的文件取不到
    const undeclared = await call('GET', '/plugins/ui/no-ui/panel')
    assert.equal(undeclared.status, 404)
    assert.equal(undeclared.payload.code, PLUGIN_UI_ERROR.PANEL_NOT_DECLARED)
    assert.equal(undeclared.text.includes('没有被声明'), false)

    // 声明之后文件才被删掉（发现 → 请求之间的真实竞态）：这时走的是**服务那一刻**的检查。
    // 同步删 + 同步查，不给 fs.watch 的去抖重载（10ms）插进来的机会；
    // 路由那一步只是把这同一个结论转成 HTTP 形状。
    fs.rmSync(path.join(pluginsRoot, 'weather-ui', 'ui', 'panel.html'))
    const raced = host.findPanelFile('weather-ui', 'weather')
    assert.equal(raced.ok, false)
    assert.equal(raced.status, 404)
    assert.equal(raced.code, PLUGIN_UI_ERROR.PANEL_ENTRY_NOT_FOUND)
  }

  // ── D. 界面侧：命令转换规则（纯函数，可直接测）──────────────────────────
  {
    const { buildPluginSlashCommands } = await import('./ui/brain-ui/chat.js')
    const built = buildPluginSlashCommands([
      { cmd: '/weather', label: '天气', description: '查天气', prompt: '查 {input} 的天气', plugin_id: 'weather-ui' },
      { cmd: '/llm', label: '覆盖内置', prompt: '不许覆盖' },
      { cmd: '/noprompt', prompt: '   ' },
      { cmd: 'weather', prompt: 'x' },
    ], { existing: ['/llm'] })
    assert.equal(built.items.length, 1, '只有合法且不重名的命令能进菜单')
    assert.deepEqual(built.items[0], {
      cmd: '/weather',
      keys: ['weather', 'weather-ui'],
      label: '天气',
      desc: '查天气',
      prompt: '查 {input} 的天气',
    })
    assert.deepEqual(built.skipped.map(s => s.reason), ['duplicate-command', 'empty-prompt', 'invalid-command-name'])
    // 没有 label 时退回 cmd（宁可显示命令本身，也不要显示空白菜单项）
    const fallbackLabel = buildPluginSlashCommands([{ cmd: '/x', prompt: 'p' }])
    assert.equal(fallbackLabel.items[0].label, '/x')
  }

  // ── E. 界面侧：面板骨架与浮层样式（查的是 DOM 字符串与 CSS 文本，不是渲染结果）──
  {
    const { createPluginPanel } = await import('./ui/brain-ui/plugin-panel.js')
    const { t } = await import('./ui/brain-ui/i18n/index.js')
    const html = createPluginPanel()
    for (const id of ['plugin-panel', 'pp-list', 'pp-commands', 'pp-errors', 'pp-error', 'pp-refresh', 'pp-exit-btn', 'pp-frame', 'pp-notice']) {
      assert.ok(html.includes(`id="${id}"`), `面板缺元素 ${id}`)
    }
    assert.ok(html.includes('class="pp-card"'), '面板缺卡片容器')
    // 常驻诚实声明：用户恰恰是在**有**面板时才会误以为它跑在沙箱里
    assert.ok(html.includes(t('plugins.isolationNotice')), '「不是沙箱」的声明必须画进 DOM')
    assert.ok(/同源|same origin/.test(html), '要明说同源加载')
    // 面板 HTML 由插件提供，界面**不许**给它加 sandbox 假装隔离（也还没做别的注入）
    assert.equal(/<iframe[^>]*\bsandbox\b/.test(html), false, '这里不做沙箱，也不许假装是沙箱')

    const css = fs.readFileSync(path.join(process.cwd(), 'src/ui/brain-ui/styles.css'), 'utf8')
    const start = css.indexOf('.plugin-panel {')
    assert.ok(start > 0, 'styles.css 里要有 .plugin-panel 规则')
    const block = css.slice(start)
    assert.ok(/position:\s*fixed/.test(block), '浮层要 fixed')
    assert.ok(/inset:\s*0/.test(block), '浮层要铺满视口')
    assert.ok(/z-index:\s*900/.test(block), '浮层要压在设置类弹层之上')
  }

  // ── F. 入口缺失时，ui 错误文案不许把用户引去改 plugin.json ───────────────
  //      能走到「有 ui 声明」这一步，说明清单是**合法**的、ui 段**确实被读了**；
  //      真实原因是入口文件不存在，插件加载不起来，所以 UI 声明无法生效。
  {
    const noEntryRoot = path.join(tmp, 'plugins-no-entry')
    writePlugin(noEntryRoot, 'ui-no-entry', {
      'plugin.json': manifest('ui-no-entry', {
        commands: [{ cmd: '/ghost', label: '幽灵命令', prompt: '入口没了，这条命令不该生效' }],
        panels: [{ id: 'ghost', title: '幽灵面板', entry: 'ui/panel.html' }],
      }),
      // 故意不写 plugin.mjs：清单声明了 entry，但文件不存在
    })
    noEntryHost = new PluginHost({ dir: noEntryRoot, logger: silentLogger, reloadDebounceMs: 10 })
    await noEntryHost.start()

    const record = noEntryHost.get('ui-no-entry')
    assert.ok(record, 'ui-no-entry 应该被发现')
    assert.equal(record.status, 'error')
    assert.equal(record.error.code, 'ENTRY_NOT_FOUND')
    assert.equal(record.ui.declared, true, '这份清单是合法的，ui 段确实被读到了')

    const collected = noEntryHost.collectUi()
    assert.equal(collected.commands.length, 0, '插件没 loaded → 它的命令不该下发')
    assert.equal(collected.panels.length, 0, '插件没 loaded → 它的面板不该下发')
    const contractError = collected.errors.find(e => e.plugin_id === 'ui-no-entry' && e.code === 'ENTRY_NOT_FOUND')
    assert.ok(contractError, `必须上报入口缺失这条错误，实际 ${JSON.stringify(collected.errors)}`)
    assert.equal(/plugin\.json is invalid/i.test(contractError.message), false, '不许再说 plugin.json 非法')
    assert.equal(/was not read/i.test(contractError.message), false, '不许再说 ui 段没被读')
    assert.equal(/not found/i.test(contractError.message), true, '要如实说入口文件找不到')
    assert.match(contractError.message, /ui declaration/i)
    console.log(`[test] 入口缺失文案：${contractError.message}`)
  }

  console.log('PASS plugin-ui: manifest ui section (commands/panels), per-item error isolation, GET /plugins/ui, panel file serving with path-escape guard (resolve-prefix + junction), composer-prefill command conversion, generic panel shell')
} finally {
  try { await (await import('./runtime/plugin-host.js')).stopPluginHost() } catch { /* 停机失败不影响结论 */ }
  try { await noEntryHost?.stop() } catch { /* 同上 */ }
  try { fs.rmSync(tmp, { recursive: true, force: true }) } catch { /* 清理失败不影响结论 */ }
}
