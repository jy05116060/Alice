import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import zlib from 'node:zlib'
import { pathToFileURL } from 'node:url'

// Office → PDF（阶段 6.3）测试。
//   npm run test-office
//
// 这台机器上没有 LibreOffice，所以不去假装能测它。测的是**我控制的那部分**：
//   - 参数拼装与输出名规则（纯函数，拼错是这类集成最常见的错）
//   - 二进制发现（注入 exists，覆盖三平台候选路径）
//   - 编排：用注入的 `_run` 模拟转换器产出文件，验证「产物判定」与失败分类
//   - 真进程层：用 node 自己当被调命令，验证成功/非零退出码/stderr/超时这四条
// LibreOffice 自身的行为（能不能真转出 PDF）不在这里，也不该在这里。
const {
  CONVERTER,
  ConvertError,
  OFFICE_EXTENSIONS,
  buildConvertArgs,
  cleanupProfile,
  convertToPdf,
  expectedPdfName,
  findLibreOfficeBinary,
  isOfficeExtension,
  runProcess,
  userInstallationArg,
} = await import('./runtime/office-convert.js')
const { execConvertToPdf, execOfficeCapability } = await import('./capabilities/tools/office.js')
const { selectTools } = await import('./memory/tool-router.js')
const { classifyTool, evaluateToolPolicy } = await import('./capabilities/tool-policy.js')

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'blm-office-'))

// 造一个最小 ZIP（= 一个最小 docx）。这里必须写**真的** ZIP：结构化路径要真的解压
// 才谈得上「解析出结构」，用伪造字节只能测到失败分支。
function buildZipForOfficeTest(entries) {
  const locals = []
  const centrals = []
  let offset = 0
  for (const entry of entries) {
    const nameBuf = Buffer.from(entry.name, 'utf8')
    const raw = Buffer.from(entry.content, 'utf8')
    const useDeflate = entry.deflate === true
    const data = useDeflate ? zlib.deflateRawSync(raw) : raw
    const method = useDeflate ? 8 : 0
    const crc = zlib.crc32 ? zlib.crc32(raw) : 0

    const local = Buffer.alloc(30 + nameBuf.length)
    local.writeUInt32LE(0x04034b50, 0)
    local.writeUInt16LE(20, 4)
    local.writeUInt16LE(0, 6)
    local.writeUInt16LE(method, 8)
    local.writeUInt32LE(crc >>> 0, 14)
    local.writeUInt32LE(data.length, 18)
    local.writeUInt32LE(raw.length, 22)
    local.writeUInt16LE(nameBuf.length, 26)
    local.writeUInt16LE(0, 28)
    nameBuf.copy(local, 30)
    locals.push(local, data)

    const central = Buffer.alloc(46 + nameBuf.length)
    central.writeUInt32LE(0x02014b50, 0)
    central.writeUInt16LE(20, 4)
    central.writeUInt16LE(20, 6)
    central.writeUInt16LE(0, 8)
    central.writeUInt16LE(method, 10)
    central.writeUInt32LE(crc >>> 0, 16)
    central.writeUInt32LE(data.length, 20)
    central.writeUInt32LE(raw.length, 24)
    central.writeUInt16LE(nameBuf.length, 28)
    central.writeUInt32LE(offset, 42)
    nameBuf.copy(central, 46)
    centrals.push(central)

    offset += local.length + data.length
  }
  const centralBuf = Buffer.concat(centrals)
  const eocd = Buffer.alloc(22)
  eocd.writeUInt32LE(0x06054b50, 0)
  eocd.writeUInt16LE(entries.length, 8)
  eocd.writeUInt16LE(entries.length, 10)
  eocd.writeUInt32LE(centralBuf.length, 12)
  eocd.writeUInt32LE(offset, 16)
  return Buffer.concat([...locals, centralBuf, eocd])
}

try {
  // ── 1. 参数拼装与输出名规则 ───────────────────────────────────────────
  {
    const args = buildConvertArgs({
      outDir: path.join(tmp, 'out'),
      inputs: [path.join(tmp, 'a.docx'), path.join(tmp, '带 空格 的.xlsx')],
      profileDir: path.join(tmp, 'profile'),
    })
    // profile 必须是第一个参数：放在后面 LibreOffice 可能已经起好了默认 profile
    assert.match(args[0], /^-env:UserInstallation=file:/, 'profile 参数必须在最前面')
    assert.ok(args.includes('--headless'), '必须无头，否则会弹窗口')
    assert.ok(args.includes('--norestore'), '不恢复会话：否则可能弹出恢复对话框卡住')
    assert.ok(args.includes('--nolockcheck'), '不检查锁：否则既有实例会让它直接退出')
    const idx = args.indexOf('--convert-to')
    assert.equal(args[idx + 1], 'pdf')
    assert.equal(args[args.indexOf('--outdir') + 1], path.resolve(tmp, 'out'))
    // 输入是绝对路径，且含空格的那个原样保留（参数数组不经 shell，不需要转义）
    assert.ok(args.includes(path.resolve(tmp, '带 空格 的.xlsx')), '输入要绝对路径且原样保留空格')
    assert.equal(args[args.length - 1], path.resolve(tmp, '带 空格 的.xlsx'))

    // profile 参数是 file URL：Windows 路径必须先变成 URL，否则 LibreOffice 解析不了
    const url = userInstallationArg(path.join(tmp, 'profile'))
    assert.ok(url.startsWith('-env:UserInstallation=file:///'), `应当是 file URL: ${url}`)
    assert.ok(!url.includes('\\'), 'file URL 里不能出现反斜杠')

    // 输出名是**扩展名替换**，不是追加——拼错会去找一个永远不会出现的文件
    assert.equal(expectedPdfName('C:\\a\\报告.docx'), '报告.pdf')
    assert.equal(expectedPdfName('/tmp/a.b.c.xlsx'), 'a.b.c.pdf', '只替换最后一段扩展名')
    assert.equal(expectedPdfName('noext'), 'noext.pdf')
    assert.equal(expectedPdfName('.hidden'), '.hidden.pdf',
      '点开头的文件名没有扩展名可替换，LibreOffice 会追加')
    assert.equal(expectedPdfName(''), '.pdf')

    assert.equal(isOfficeExtension('a.DOCX'), true, '大写扩展名要认')
    assert.equal(isOfficeExtension('a.pdf'), false)
    assert.equal(isOfficeExtension('a.zip'), false)
    for (const ext of OFFICE_EXTENSIONS) assert.equal(isOfficeExtension(`x${ext}`), true, `${ext} 应在支持列表里`)
  }

  // ── 2. 二进制发现 ─────────────────────────────────────────────────────
  {
    // 刻意不依赖真实安装：注入 exists
    const winExists = new Set(['C:\\Program Files\\LibreOffice\\program\\soffice.exe'])
    const win = findLibreOfficeBinary({
      platform: 'win32',
      env: { ProgramFiles: 'C:\\Program Files' },
      exists: p => winExists.has(p),
    })
    assert.equal(win.found, true)
    assert.equal(win.binary, 'C:\\Program Files\\LibreOffice\\program\\soffice.exe')

    // 装在 x86 目录下也要能找到
    const x86 = findLibreOfficeBinary({
      platform: 'win32',
      env: { ProgramFiles: 'C:\\Program Files', 'ProgramFiles(x86)': 'C:\\Program Files (x86)' },
      exists: p => p.startsWith('C:\\Program Files (x86)'),
    })
    assert.equal(x86.found, true)
    assert.ok(x86.binary.includes('Program Files (x86)'))

    const mac = findLibreOfficeBinary({
      platform: 'darwin',
      env: {},
      exists: p => p === '/Applications/LibreOffice.app/Contents/MacOS/soffice',
    })
    assert.equal(mac.binary, '/Applications/LibreOffice.app/Contents/MacOS/soffice')

    const linux = findLibreOfficeBinary({ platform: 'linux', env: {}, exists: p => p === '/usr/bin/soffice' })
    assert.equal(linux.binary, '/usr/bin/soffice')

    // 找不到时：要如实报告，并把找过的路径带回来（用户才能判断该装到哪）
    const none = findLibreOfficeBinary({ platform: 'win32', env: { ProgramFiles: 'C:\\PF' }, exists: () => false })
    assert.equal(none.found, false)
    assert.equal(none.binary, null)
    assert.ok(none.searched.length > 0, '要找过一些地方才叫「找过」')
    assert.ok(none.searched.some(p => p.includes('LibreOffice')), '搜寻列表里要能看到 LibreOffice 路径')
    // 裸命令名不能当成绝对路径去存在性检查（那会永远为 false）
    assert.ok(none.searched.includes('soffice.exe'))

    // 本机真实情况（无 LibreOffice）也不该抛
    const actual = findLibreOfficeBinary()
    assert.equal(typeof actual.found, 'boolean')
  }

  // ── 3. 没有转换器时的行为：默认三层往下试；显式关掉才报 NO_CONVERTER ──
  {
    const input = path.join(tmp, 'a.docx')
    fs.writeFileSync(input, 'x', 'utf8')
    const probe = findLibreOfficeBinary()

    // 显式关掉纯 JS 兜底：必须给出 NO_CONVERTER + 安装提示（而不是含糊失败）。
    // allowStructured 默认跟随 allowTextFallback——两条都是纯 JS 路径，不能绕开关。
    let caught = null
    try {
      await convertToPdf({
        inputs: [input], outDir: path.join(tmp, 'out'), binary: null,
        allowTextFallback: false, _run: async () => ({ ok: true, code: 0 }),
      })
    } catch (error) { caught = error }
    if (!probe.found) {
      assert.equal(caught?.code, 'NO_CONVERTER')
      assert.ok(/LibreOffice/.test(caught.message))
      assert.ok(caught.detail?.hint?.includes('libreoffice.org'), '要给出安装地址才叫有用的报错')
      assert.ok(Array.isArray(caught.detail?.searched))
    } else {
      assert.equal(caught, null, '本机有转换器时不该报 NO_CONVERTER')
    }

    // 默认（不关兜底）：没装 LibreOffice 时三层依次往下试，并如实报告最终用了哪条。
    // 这个 .docx 是假的（内容只是一个 'x'，不是 ZIP），所以两条纯 JS 路径都失败——
    // 路径顺序本身正是这里要验的：不可用 → 失败 → 失败，逐层留痕，而不是在第一层就放弃。
    if (!probe.found) {
      const viaFallback = await convertToPdf({ inputs: [input], outDir: path.join(tmp, 'out-fallback') })
      assert.equal(viaFallback.converter, 'text-fallback', '全失败时上报的应当是最后试的那条，不能谎称是结构化')
      assert.equal(viaFallback.fidelity, 'text-only')
      assert.deepEqual(viaFallback.attempts.map(a => `${a.converter}:${a.outcome}`),
        ['libreoffice:unavailable', 'structured:failed', 'text-fallback:failed'],
        `每一层都要留痕: ${JSON.stringify(viaFallback.attempts)}`)
      assert.equal(viaFallback.converted.length + viaFallback.failed.length, 1)

      // 换一个**真的** docx（有标题），验证默认真的走结构化而不是纯文本
      const realDocx = path.join(tmp, 'real.docx')
      fs.writeFileSync(realDocx, buildZipForOfficeTest([
        { name: 'word/document.xml', content: '<w:document><w:body><w:p><w:pPr><w:pStyle w:val="Heading1"/></w:pPr><w:r><w:t>标题</w:t></w:r></w:p></w:body></w:document>', deflate: true },
      ]))
      const viaStructured = await convertToPdf({ inputs: [realDocx], outDir: path.join(tmp, 'out-structured') })
      assert.equal(viaStructured.converter, 'structured', '有结构可解析时必须走结构化（保版式），不是纯文本')
      assert.deepEqual(viaStructured.attempts.map(a => `${a.converter}:${a.outcome}`),
        ['libreoffice:unavailable', 'structured:succeeded'])
    }
  }

  // ── 4. 编排：产物判定与失败分类（注入 _run，不需要真转换器）──────────
  {
    const outDir = path.join(tmp, 'conv')
    fs.mkdirSync(outDir, { recursive: true })
    const docx = path.join(tmp, '报告.docx')
    const xlsx = path.join(tmp, '汇总.xlsx')
    fs.writeFileSync(docx, 'doc', 'utf8')
    fs.writeFileSync(xlsx, 'sheet', 'utf8')

    // 模拟转换器：只为 docx 产出 PDF（xlsx 那一个「失败」）
    const fakeRun = async (command, args) => {
      const produced = path.join(outDir, '报告.pdf')
      fs.writeFileSync(produced, '%PDF-1.4 fake', 'utf8')
      return { ok: true, code: 0, stdout: 'convert 报告.docx -> 报告.pdf', stderr: '' }
    }
    const result = await convertToPdf({
      inputs: [docx, xlsx], outDir, binary: '/fake/soffice', profileDir: path.join(tmp, 'p1'), _run: fakeRun,
    })
    assert.equal(result.converter, CONVERTER.LIBREOFFICE)
    assert.equal(result.converted.length, 1)
    assert.equal(result.converted[0].input, docx)
    assert.equal(result.converted[0].output, path.join(outDir, '报告.pdf'))
    assert.ok(result.converted[0].sizeBytes > 0, '要报告产物大小')
    assert.equal(result.failed.length, 1)
    assert.equal(result.failed[0].input, xlsx)
    // 退出码 0 但没产物 = 失败。这是最关键的一条：LibreOffice 把请求转给既有实例、
    // 或遇到不认识的格式时，都会退出 0 而什么都没产出。
    assert.ok(/no new file/.test(result.failed[0].error), `退出 0 无产物必须算失败: ${result.failed[0].error}`)

    // 空输入
    let noInput = null
    try { await convertToPdf({ inputs: [], binary: '/fake/soffice' }) } catch (e) { noInput = e }
    assert.equal(noInput?.code, 'NO_INPUTS')

    // 不存在的输入：在起进程之前就报，且错误说得清是哪个文件
    let missing = null
    try {
      await convertToPdf({ inputs: [path.join(tmp, 'ghost.docx')], binary: '/fake/soffice', _run: fakeRun })
    } catch (e) { missing = e }
    assert.equal(missing?.code, 'INPUT_NOT_FOUND')
    assert.ok(missing.message.includes('ghost.docx'))

    // 是目录：同样提前拦
    let isDir = null
    try { await convertToPdf({ inputs: [outDir], binary: '/fake/soffice', _run: fakeRun }) } catch (e) { isDir = e }
    assert.equal(isDir?.code, 'INPUT_NOT_A_FILE')

    // 转换器非零退出：错误要带上它自己的 stderr，而不是一句「失败了」
    const failRun = async () => ({ ok: false, code: 1, stdout: '', stderr: 'Error: source file could not be loaded' })
    const failed = await convertToPdf({
      inputs: [docx], outDir: path.join(tmp, 'conv2'), binary: '/fake/soffice', _run: failRun,
    })
    assert.equal(failed.converted.length, 0)
    assert.ok(/could not be loaded/.test(failed.failed[0].error), '要把转换器的话带回来')

    // 超时：要被标出来（killed），且不假装成功
    const killRun = async () => ({ ok: false, code: null, killed: true, stdout: '', stderr: '' })
    const timedOut = await convertToPdf({
      inputs: [docx], outDir: path.join(tmp, 'conv3'), binary: '/fake/soffice', _run: killRun,
    })
    assert.equal(timedOut.timedOut, true)
    assert.equal(timedOut.converted.length, 0)

    // 覆盖已有产物：必须算「新产物」，否则第二次转换永远被判失败
    const reuse = path.join(tmp, 'conv4')
    fs.mkdirSync(reuse, { recursive: true })
    const target = path.join(reuse, '报告.pdf')
    fs.writeFileSync(target, 'old', 'utf8')
    await new Promise(r => setTimeout(r, 12))
    const second = await convertToPdf({
      inputs: [docx], outDir: reuse, binary: '/fake/soffice',
      _run: async () => { fs.writeFileSync(target, 'new content', 'utf8'); return { ok: true, code: 0, stdout: '', stderr: '' } },
    })
    assert.equal(second.converted.length, 1, '覆盖已有 PDF 时也要算成功（mtime 变了）')

    // 清理 profile
    const profile = path.join(tmp, 'cleanup-me')
    fs.mkdirSync(profile, { recursive: true })
    await cleanupProfile(profile)
    assert.equal(fs.existsSync(profile), false)
    await cleanupProfile(null)
    await cleanupProfile(path.join(tmp, 'not-there'))
  }

  // ── 5. 真进程层：成功 / 非零退出码 / stderr / 超时 ────────────────────
  {
    const ok = await runProcess(process.execPath, ['-e', 'process.stdout.write("hello")'], 20_000)
    assert.equal(ok.ok, true)
    assert.equal(ok.code, 0)
    assert.equal(ok.stdout.trim(), 'hello')

    const bad = await runProcess(process.execPath, ['-e', 'process.stderr.write("boom"); process.exit(3)'], 20_000)
    assert.equal(bad.ok, false)
    assert.equal(bad.code, 3, '退出码要如实带回来')
    assert.match(bad.error, /boom/, 'stderr 要进 error，否则排查时什么都没有')

    const killed = await runProcess(process.execPath, ['-e', 'setTimeout(()=>{}, 60000)'], 1200)
    assert.equal(killed.ok, false)
    assert.equal(killed.killed, true, '超时被杀要标出来')

    // 命令根本不存在：不能抛，要返回失败结果
    const ghost = await runProcess(path.join(tmp, 'no-such-binary-xyz'), [], 5000)
    assert.equal(ghost.ok, false)
    assert.ok(ghost.error.length > 0)
  }

  // ── 6. 工具层：参数校验、能力探测、策略与工具面 ──────────────────────
  {
    const noPaths = JSON.parse(await execConvertToPdf({}))
    assert.equal(noPaths.code, 'PATHS_REQUIRED')

    const tooMany = JSON.parse(await execConvertToPdf({ paths: Array.from({ length: 11 }, () => 'a.docx') }))
    assert.equal(tooMany.code, 'TOO_MANY_FILES')

    const unsupported = JSON.parse(await execConvertToPdf({ paths: ['a.zip', 'b.png'] }))
    assert.equal(unsupported.code, 'UNSUPPORTED_FORMAT')
    assert.ok(/docx/.test(unsupported.error), '要列出支持的格式')

    // 本机没有转换器时：工具走纯 JS 兜底并把**用了哪条**如实报出来（而不是抛 NO_CONVERTER）。
    // 这个 .docx 是假的（内容只有一个 'x'），所以结构解析与文本抽取都会失败——
    // 但有 failed 且带 code，说明路径确实走到了最后一条。
    const noConverter = JSON.parse(await execConvertToPdf({ paths: [path.join(tmp, '报告.docx')] }))
    const probe = findLibreOfficeBinary()
    if (!probe.found) {
      assert.equal(noConverter.converter, 'text-fallback', '三条路径全失败时，上报的应当是最后一条（纯文本）')
      assert.equal(noConverter.fidelity, 'text-only')
      assert.equal(noConverter.ok, false, '假 docx 抽不出文本，应当失败')
      assert.ok(noConverter.failed?.length > 0)
      assert.ok(/TEXT-ONLY/.test(noConverter.note), '全失败时必须说清试过哪几条路径、交付不了 PDF')
      assert.ok(/Do not claim a PDF was produced/.test(noConverter.note), '不能让模型谎报产出')
    }

    // 能力探测：任何情况下都要能回答（这正是它存在的意义）
    const cap = JSON.parse(execOfficeCapability())
    assert.equal(cap.ok, true)
    assert.deepEqual(cap.supported_extensions, [...OFFICE_EXTENSIONS])
    // 三条路径的优先级本身是契约：LibreOffice → 结构化 → 纯文本
    assert.deepEqual(cap.converter_order, ['libreoffice', 'structured', 'text-fallback'])
    assert.equal(cap.converter, probe.found ? 'libreoffice' : 'structured',
      '没装 LibreOffice 时默认能拿到的是**结构化**产物（不是纯文本）')
    assert.equal(cap.full_fidelity, probe.found, '要明确「是不是完整保真」')
    assert.equal(cap.fidelity, probe.found ? 'full' : 'structured')
    assert.ok(cap.structured_extensions.includes('.docx'))
    if (!probe.found) assert.ok(/STRUCTURED/.test(cap.hint), '没装时要说明默认是结构化生成（保版式但不保图片）')

    // 工具面：能力探测任何轮都有；转换只在真实用户轮
    const user = selectTools({ messageBody: '把报告转成 PDF', isTick: false })
    assert.ok(user.includes('convert_to_pdf'), '用户轮要有转换工具')
    assert.ok(user.includes('office_capability'), '用户轮要能先问能力')
    const tick = selectTools({ messageBody: '', isTick: true })
    assert.equal(tick.includes('convert_to_pdf'), false, '心跳轮不给转换（会写新文件）')
    assert.ok(tick.includes('office_capability'), '心跳轮也要能发现「这台机器转不了」，免得反复尝试')

    // 策略：转换按 medium，探测按 low
    assert.equal(classifyTool('convert_to_pdf'), 'medium')
    assert.equal(classifyTool('office_capability'), 'low')
    assert.equal(evaluateToolPolicy('office_capability', {}, { autonomous: true }).allowed, true)
  }

  console.log('PASS office: args/profile wiring, output-name rule, binary discovery, product detection, process layer, and tool surface')
} finally {
  try { fs.rmSync(tmp, { recursive: true, force: true }) } catch { /* 清理失败不影响结论 */ }
}
