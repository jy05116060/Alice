import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

// 交付物卡片（阶段 6.2）测试。用临时库，不碰真实数据：
//   npm run test-present
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'blm-present-'))
process.env.ALICE_USER_DIR = tmp
process.env.ALICE_RESOURCES_DIR = tmp

let closeDBForTest = null

try {
  const dbModule = await import('./db.js')
  closeDBForTest = dbModule.closeDBForTest
  const {
    MAX_DELIVERABLES,
    describeFileKind,
    execPresent,
    validateDeliverable,
  } = await import('./capabilities/tools/present.js')
  const {
    clearDeliverables,
    deliverableView,
    isRegisteredDeliverable,
    listDeliverableViews,
    recordDeliverable,
  } = await import('./runtime/deliverables-store.js')
  const {
    baseName,
    canOpen,
    compactPath,
    describeCard,
    extensionOf,
    formatSize,
    iconForKind,
  } = await import('./runtime/deliverable-card.js')
  const { handleDeliverableRoutes } = await import('./api/routes/deliverables.js')
  const { selectTools } = await import('./memory/tool-router.js')
  const { evaluateToolPolicy, classifyTool } = await import('./capabilities/tool-policy.js')
  const { addEventListener, emitEvent } = await import('./events.js')

  // 造几个真实文件
  const docsDir = path.join(tmp, 'out')
  fs.mkdirSync(docsDir, { recursive: true })
  const reportPath = path.join(docsDir, 'report.md')
  fs.writeFileSync(reportPath, '# report\n内容\n', 'utf8')
  const sheetPath = path.join(docsDir, '数据 汇总.xlsx')
  fs.writeFileSync(sheetPath, 'x'.repeat(2048), 'utf8')
  const bigPath = path.join(docsDir, 'big.bin')
  fs.writeFileSync(bigPath, Buffer.alloc(3 * 1024 * 1024))

  const row = (p) => ({ path: p, description: '' })

  // ── 1. 纯展示逻辑 ─────────────────────────────────────────────────────
  {
    assert.equal(baseName('D:\\a\\b\\c.md'), 'c.md')
    assert.equal(baseName('/usr/local/x/y.pdf'), 'y.pdf')
    assert.equal(baseName('plain.txt'), 'plain.txt')
    assert.equal(baseName(''), '')
    assert.equal(baseName('D:\\a\\b\\'), 'b', '尾部分隔符不该产生空名字')

    assert.equal(formatSize(0), '0 B', '0 字节要显示出来，空白会让人以为加载失败')
    assert.equal(formatSize(512), '512 B')
    assert.equal(formatSize(1024), '1.0 KB')
    assert.equal(formatSize(1536), '1.5 KB')
    assert.equal(formatSize(1024 * 1024), '1.0 MB')
    assert.equal(formatSize(3 * 1024 * 1024 * 1024), '3.00 GB')
    assert.equal(formatSize(-1), '', '负数不显示成怪东西')
    assert.equal(formatSize(null), '')

    assert.equal(iconForKind('spreadsheet'), '📊')
    assert.equal(iconForKind('pdf'), '📕')
    assert.equal(iconForKind('nonsense'), '📎', '未知类型要有兜底图标')
    assert.equal(iconForKind(undefined), '📎')

    assert.equal(describeCard({ description: '季度汇总' }), '季度汇总')
    assert.equal(describeCard({ size_bytes: 2048, kind: 'spreadsheet' }), '2.0 KB · spreadsheet',
      '没有描述时要退回「大小 · 类型」，不能让副标题空着')
    assert.equal(describeCard({ description: '', size_bytes: 0 }), '0 B',
      '两部分都是空/零时不该留下悬空的 " · "')
    assert.equal(describeCard({ description: '   ' }), '', '纯空白描述不算描述')

    assert.equal(canOpen({ path: 'x' }), true)
    assert.equal(canOpen({ path: '' }), false)
    assert.equal(canOpen({}), false)
    assert.equal(canOpen(null), false)

    assert.equal(compactPath('a/b/c/d/e.md', 2), '…/d/e.md')
    assert.equal(compactPath('a/b.md', 2), 'a/b.md')
    assert.equal(extensionOf('x.Y.PDF'), 'pdf')
    assert.equal(extensionOf('noext'), '')
  }

  // ── 2. 类型识别 ───────────────────────────────────────────────────────
  {
    assert.equal(describeFileKind('a.docx'), 'document')
    assert.equal(describeFileKind('a.xlsx'), 'spreadsheet')
    assert.equal(describeFileKind('a.pptx'), 'presentation')
    assert.equal(describeFileKind('a.pdf'), 'pdf')
    assert.equal(describeFileKind('a.PNG'), 'image', '大写扩展名要认')
    assert.equal(describeFileKind('a.mp4'), 'video')
    assert.equal(describeFileKind('a.mp3'), 'audio')
    assert.equal(describeFileKind('a.zip'), 'archive')
    assert.equal(describeFileKind('a.md'), 'text')
    assert.equal(describeFileKind('a.weird'), 'file')
    assert.equal(describeFileKind('noext'), 'file')
  }

  // ── 3. 校验：必须存在、必须是普通文件 ────────────────────────────────
  {
    const ok = await validateDeliverable({ path: reportPath, description: '  周报  ' })
    assert.equal(ok.path, reportPath)
    assert.equal(ok.description, '周报', '描述要去掉两侧空白')
    assert.ok(ok.sizeBytes > 0)
    assert.equal(ok.kind, 'text')

    let missing = null
    try { await validateDeliverable({ path: path.join(tmp, 'nope.txt') }) } catch (e) { missing = e }
    assert.equal(missing?.code, 'NOT_FOUND')

    let isDir = null
    try { await validateDeliverable({ path: docsDir }) } catch (e) { isDir = e }
    assert.equal(isDir?.code, 'IS_DIRECTORY')
    assert.ok(/directory/.test(isDir.message), '要告诉模型为什么不能用目录')

    let noPath = null
    try { await validateDeliverable({}) } catch (e) { noPath = e }
    assert.equal(noPath?.code, 'PATH_REQUIRED')

    // 相对路径按仓库根解析（与文件/命令工具同一个锚点）
    const rel = await validateDeliverable({ path: 'out/report.md' })
    assert.equal(rel.path, path.resolve(tmp, 'out/report.md'), '相对路径要解析成绝对路径再登记')
  }

  // ── 4. present 工具：上限、部分失败、事件 ─────────────────────────────
  {
    clearDeliverables()
    const events = []
    const off = addEventListener((type, data) => events.push({ type, data }))

    const one = JSON.parse(await execPresent({ files: [{ path: reportPath, description: '周报' }] }))
    assert.equal(one.ok, true)
    assert.equal(one.presented.length, 1)
    assert.equal(one.presented[0].path, reportPath)
    assert.equal(events.filter(e => e.type === 'deliverables_presented').length, 1)
    assert.equal(events[0].data.files[0].description, '周报')

    // 超过上限：明确拒绝，**不静默截断**（截断会让模型以为都交付了）
    const tooMany = JSON.parse(await execPresent({
      files: Array.from({ length: MAX_DELIVERABLES + 1 }, () => row(reportPath)),
    }))
    assert.equal(tooMany.ok, false)
    assert.equal(tooMany.code, 'TOO_MANY_FILES')
    assert.ok(/at most 4/.test(tooMany.error))

    // 空列表
    assert.equal(JSON.parse(await execPresent({ files: [] })).code, 'FILES_REQUIRED')
    assert.equal(JSON.parse(await execPresent({})).code, 'FILES_REQUIRED')

    // 部分失败：好的照常登记，坏的逐条报回来（而不是整体失败）
    const mixed = JSON.parse(await execPresent({
      files: [
        { path: sheetPath, description: '数据汇总' },
        { path: path.join(tmp, 'ghost.txt') },
      ],
    }))
    assert.equal(mixed.ok, true, '有一个成功就应当算成功')
    assert.equal(mixed.presented.length, 1)
    assert.equal(mixed.rejected.length, 1)
    assert.equal(mixed.rejected[0].code, 'NOT_FOUND')
    assert.ok(/fix those/.test(mixed.note), '部分失败要提示模型去修，而不是当没事')

    // 全部失败
    const allBad = JSON.parse(await execPresent({ files: [{ path: path.join(tmp, 'a.txt') }] }))
    assert.equal(allBad.ok, false)
    assert.equal(allBad.code, 'NOT_FOUND')

    off()
  }

  // ── 5. 登记表与视图 ───────────────────────────────────────────────────
  {
    clearDeliverables()
    assert.deepEqual(listDeliverableViews(), [])

    recordDeliverable({ path: sheetPath, description: '数据汇总', sizeBytes: 2048, kind: 'spreadsheet' })
    recordDeliverable({ path: reportPath, description: '', sizeBytes: 12, kind: 'text' })
    const views = listDeliverableViews()
    assert.equal(views.length, 2)

    const sheet = views.find(v => v.path === sheetPath)
    assert.equal(sheet.name, '数据 汇总.xlsx', '含空格的文件名要原样保留')
    assert.equal(sheet.size_text, '2.0 KB')
    assert.equal(sheet.icon, '📊')
    assert.equal(sheet.can_open, true, '服务端算好的可打开标记，前端直接用')
    assert.equal(sheet.description, '数据汇总')

    // 同一路径重复登记是更新而不是插两行
    recordDeliverable({ path: sheetPath, description: '改过的描述', sizeBytes: 4096, kind: 'spreadsheet' })
    assert.equal(listDeliverableViews().length, 2, '同路径重复登记不该变两行')
    assert.equal(listDeliverableViews().find(v => v.path === sheetPath).description, '改过的描述')

    // limit 被夹住
    assert.equal(listDeliverableViews({ limit: 9999 }).length, 2)
    assert.equal(listDeliverableViews({ limit: 1 }).length, 1)

    // deliverableView(null) 要安全
    assert.equal(deliverableView(null), null)
  }

  // ── 6. 打开接口的安全边界：只认登记过的路径 ──────────────────────────
  {
    clearDeliverables()
    const call = async (method, pathname, body) => {
      const url = new URL(`http://127.0.0.1:3000${pathname}`)
      let status = null
      let payload = null
      const res = {
        writeHead(code) { status = code },
        setHeader() {},
        end(chunk) { payload = chunk ? JSON.parse(chunk) : null },
      }
      const fakeReq = {
        method,
        on(event, handler) {
          if (event === 'data' && body !== undefined) handler(JSON.stringify(body))
          if (event === 'end') handler()
        },
      }
      const handled = await handleDeliverableRoutes(fakeReq, res, url)
      return { handled, status, payload }
    }

    // 空列表
    const empty = await call('GET', '/deliverables')
    assert.equal(empty.handled, true)
    assert.equal(empty.status, 200)
    assert.deepEqual(empty.payload.deliverables, [])

    // 未登记的路径：必须 403，且错误码区分得开
    const forbidden = await call('POST', '/deliverables/open', { path: reportPath })
    assert.equal(forbidden.status, 403, '没登记过的路径绝不能打开——那会变成「打开任意文件」的原语')
    assert.equal(forbidden.payload.code, 'NOT_A_DELIVERABLE')
    assert.equal(await isRegisteredDeliverable(reportPath), false)

    // 缺 path：400
    const noPath = await call('POST', '/deliverables/open', {})
    assert.equal(noPath.status, 400)
    assert.equal(noPath.payload.code, 'PATH_REQUIRED')

    // 登记之后：GET 能列出来（含服务端算好的展示字段）
    recordDeliverable({ path: reportPath, description: '周报', sizeBytes: 12, kind: 'text' })
    const listed = await call('GET', '/deliverables')
    assert.equal(listed.payload.deliverables.length, 1)
    assert.equal(listed.payload.deliverables[0].icon, '📝')
    assert.equal(listed.payload.deliverables[0].name, 'report.md')
    assert.equal(await isRegisteredDeliverable(reportPath), true)

    // 不属于本路由的路径不该被认领
    const unrelated = await call('GET', '/deliverable')
    assert.equal(unrelated.handled, false)
    const wrongMethod = await call('DELETE', '/deliverables')
    assert.equal(wrongMethod.handled, false)
  }

  // ── 7. 工具面与策略 ───────────────────────────────────────────────────
  {
    const userTurn = selectTools({ messageBody: '把报告整理好发给我', isTick: false })
    assert.ok(userTurn.includes('present'), '真实用户轮要有 present')
    const tick = selectTools({ messageBody: '', isTick: true })
    assert.equal(tick.includes('present'), false, '心跳轮不给——那一轮没人等着拿文件')

    const { enterPlanMode, exitPlanMode } = await import('./runtime/plan-mode.js')
    enterPlanMode({ source: 'test' })
    try {
      const planning = selectTools({ messageBody: '先给我方案', isTick: false })
      assert.equal(planning.includes('present'), false, '计划模式还没动手，没有成果可交付')
    } finally {
      exitPlanMode()
    }

    assert.equal(classifyTool('present'), 'low', 'present 不改任何东西')
    assert.equal(evaluateToolPolicy('present', { files: [] }, {}).allowed, true)
    assert.equal(evaluateToolPolicy('present', { files: [] }, { autonomous: true }).allowed, true,
      '它没有副作用，自主轮也不需要额外闸门')
  }

  clearDeliverables()
  console.log('PASS present: validation, card fields, registry, open-endpoint guard, and tool surface')
} finally {
  closeDBForTest?.()
  fs.rmSync(tmp, { recursive: true, force: true })
}
