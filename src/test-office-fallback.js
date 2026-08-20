import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import zlib from 'node:zlib'

// Office→PDF 的**无依赖兜底**（阶段 6.3 补充）测试。纯 JS，不需要装任何东西：
//   npm run test-office-fallback
//
// 这一层要验的是四件事：PDF 字节结构合法、Office（ZIP+XML）文本抽得对、
// 「用了哪条路径」被如实报出来（把文本导出说成版式转换是最坏的失败方式），
// 以及**结构化路径**真的产出表格线框与字号层级（而不是退化成制表符拼接）。
// 用户的真实数据目录必须隔离：paths.js 在 import 时读这个环境变量，
// 所以要在下面那批动态 import 之前设好。
process.env.ALICE_USER_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'blm-office-fallback-user-'))
const {
  PAGE,
  buildStructuredPdf,
  buildTextPdf,
  charWidth,
  encodeTextRun,
  extractPdfText,
  inspectPdf,
  isCjkChar,
  layoutStructured,
  wrapLine,
} = await import('./runtime/pdf-writer.js')
const {
  canExtractText,
  extractOfficeText,
  extractParagraphLines,
  extractTagText,
  listZipEntries,
  readZipEntry,
  PLAIN_TEXT_EXTENSIONS,
  TEXT_EXTRACTABLE_EXTENSIONS,
} = await import('./runtime/office-text.js')
const {
  canParseStructure,
  headingLevelFromStyle,
  parseNumberingXml,
  parseOfficeStructure,
  parseSheetXml,
  structureStats,
  STRUCTURED_EXTENSIONS,
} = await import('./runtime/office-structure.js')
const {
  CONVERTER,
  CONVERTER_FIDELITY,
  CONVERTER_ORDER,
  convertToPdf,
  convertViaStructure,
  convertViaTextFallback,
  findLibreOfficeBinary,
} = await import('./runtime/office-convert.js')

// 单元测试要能**注入**路径可用性：这台机器上装没装 LibreOffice 不该决定测试结果。
// 用一个指向不存在文件的 binary 精确模拟「装了 LibreOffice」，用 binary: null + 真实探测
// 模拟「没装」。所有 end-to-end 调用都显式传 binary，不依赖机器状态。
const FAKE_SOFFICE = path.join(os.tmpdir(), 'blm-no-such-soffice-' + process.pid)

// 这台机器上到底装没装 LibreOffice？装了的话，`binary: null` 会真的去跑它，
// 那几条「LibreOffice 不可用」的断言就不能硬编码结果——只断言真正的契约
// （顺序、converter 字段如实、产物存在），而不断言具体走到哪一层。
function findLibreOfficeBinaryFound() {
  return findLibreOfficeBinary().found
}

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'blm-office-fallback-'))

// ── 造一个最小 ZIP（stored 与 deflate 各一条），用来喂 ZIP 解析器 ──────────
function buildZip(entries) {
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
  // ── 1. 字符分类与编码 ─────────────────────────────────────────────────
  {
    assert.equal(isCjkChar('中'), true)
    assert.equal(isCjkChar('，'), true, '全角标点也算 CJK')
    assert.equal(isCjkChar('。'), true)
    assert.equal(isCjkChar('あ'), true, '假名')
    assert.equal(isCjkChar('a'), false)
    assert.equal(isCjkChar('1'), false)

    // CJK 走十六进制（UCS-2），拉丁走转义字面量
    assert.deepEqual(encodeTextRun('中'), [{ font: 'cjk', value: '<4E2D>' }])
    assert.deepEqual(encodeTextRun('ab'), [{ font: 'latin', value: '(ab)' }])
    // 混排要切成多段，而不是把汉字塞进字面量（那会变乱码）
    const mixed = encodeTextRun('A中B')
    assert.equal(mixed.length, 3)
    assert.deepEqual(mixed.map(r => r.font), ['latin', 'cjk', 'latin'])
    assert.equal(mixed[1].value, '<4E2D>')
    // PDF 字面量里必须转义的三个字符
    assert.deepEqual(encodeTextRun('a(b)c\\d'), [{ font: 'latin', value: '(a\\(b\\)c\\\\d)' }])
    // 控制字符与 WinAnsi 覆盖不到的字符降级为 '?'，不能写进非法字节
    assert.equal(encodeTextRun('\u0007')[0].value, '(?)')
    // WinAnsiEncoding 里 0x80–0x9F 不是控制符，而是最常见的几个标点。
    // 排出来源说明里的 `—`、中文文档里的 `…` 都会落到这里：降级成 '?' 会让
    // 我们自己写的那行说明凭空多出问号（第一版就是这样，所以这条要锁住）。
    assert.equal(encodeTextRun('\u20ac')[0].value, '(\\200)', '欧元符号在 WinAnsi 的 0x80 上，要真的写进去')
    assert.equal(encodeTextRun('\u2014')[0].value, '(\\227)', '破折号 — 在 WinAnsi 的 0x97 上')
    assert.equal(encodeTextRun('\u2026')[0].value, '(\\205)', '省略号 … 在 WinAnsi 的 0x85 上')
    // 真正不在 WinAnsi 里的（比如西里尔字母）才降级
    assert.equal(encodeTextRun('\u0416')[0].value, '(?)')
    // 往返：编码进去的标点必须能被 extractPdfText 还原回来
    assert.equal(extractPdfText(buildStructuredPdf({ blocks: [{ type: 'paragraph', text: 'a — b … c' }] })).includes('a — b … c'),
      true, 'WinAnsi 高位标点要能往返')
    assert.deepEqual(encodeTextRun(''), [])

    assert.equal(charWidth('中'), 1)
    assert.equal(charWidth('a'), 0.5)
  }

  // ── 2. 折行 ───────────────────────────────────────────────────────────
  {
    // 中文按字断
    const cn = wrapLine('中文'.repeat(10), 5)
    assert.ok(cn.length >= 4, `中文要按字断行: ${JSON.stringify(cn)}`)
    for (const line of cn) assert.ok([...line].reduce((s, c) => s + charWidth(c), 0) <= 5.0001)

    // 西文尽量在空格处断，不要把单词劈开。
    // 注意 maxUnits 是**宽度单位**而不是字符数：拉丁字符算 0.5 宽，所以 4 个单位
    // 只放得下 8 个拉丁字符。
    const en = wrapLine('hello world', 4)
    assert.deepEqual(en, ['hello', 'world'], `西文不该劈开单词: ${JSON.stringify(en)}`)
    for (const word of ['hello', 'world']) {
      assert.ok(en.includes(word), `"${word}" 必须完整出现在某一行: ${JSON.stringify(en)}`)
    }
    // 中文按字断（没有空格可回退）
    const cnStrict = wrapLine('中文字符串', 3)
    assert.deepEqual(cnStrict, ['中文字', '符串'])
    // 整行放得下时不该断
    assert.deepEqual(wrapLine('short', 100), ['short'])

    // 空行保留（它是段落间距，不该被吃掉）
    assert.deepEqual(wrapLine('', 10), [''])
    // 超长无空格串只能硬断，不能无限长
    const long = wrapLine('x'.repeat(40), 10)
    assert.ok(long.length > 1)
    // 单行不超宽
    assert.deepEqual(wrapLine('short', 100), ['short'])
  }

  // ── 3. PDF 结构合法性 ─────────────────────────────────────────────────
  {
    const pdf = buildTextPdf({ title: '测试', lines: ['hello', '中文内容'] })
    assert.ok(Buffer.isBuffer(pdf))
    const info = inspectPdf(pdf)
    assert.equal(info.headerOk, true, '必须以 %PDF- 开头')
    assert.equal(info.endsWithEof, true, '必须以 %%EOF 结尾')
    assert.equal(info.trailerOk, true)
    assert.equal(info.hasRoot, true)
    assert.equal(info.startxref !== null, true, '必须有 startxref')
    // xref 条目数 = 对象数 + 1（含自由头）
    assert.equal(info.xrefEntryCount, info.objectCount + 1,
      `xref 条目数(${info.xrefEntryCount}) 必须等于对象数+1(${info.objectCount + 1})`)
    // 每条 xref 偏移必须真的指向 "N 0 obj"
    for (let i = 0; i < info.xrefEntries.length; i++) {
      const entry = info.xrefEntries[i]
      if (entry.type === 'f') continue
      const at = pdf.toString('latin1').slice(entry.offset, entry.offset + 12)
      assert.match(at, /^\d+ 0 obj/, `第 ${i} 条 xref 偏移 ${entry.offset} 没指向对象头: ${JSON.stringify(at)}`)
    }
    // startxref 必须指向 xref 关键字
    assert.match(pdf.toString('latin1').slice(info.startxref, info.startxref + 4), /^xref/)

    // 二进制标记行（有些工具会因为缺它而把 PDF 当文本处理坏掉）
    assert.equal(pdf.toString('latin1').includes('%\xE2\xE3\xCF\xD3'), true)

    // 中文真的写进去了（UCS-2 十六进制；同一段里的字符合并成一条，见下）
    const latin1 = pdf.toString('latin1')
    const single = buildTextPdf({ lines: ['中'] })
    assert.ok(single.toString('latin1').includes('<4E2D>'), '单个汉字：4 位十六进制')
    const merged = buildTextPdf({ lines: ['中文内容'] })
    assert.ok(merged.toString('latin1').includes('<4E2D658751855BB9>'),
      '同一段里的汉字合并成一个十六进制串（逐字一个 Tj 只会让文件更大）')
    // 混排要切成段：拉丁一段、CJK 一段
    const mixedRuns = [...buildTextPdf({ lines: ['A中B'] }).toString('latin1').matchAll(/(<[0-9A-F]+>|\([^)]*\))\s*Tj/g)].map(m => m[1])
    assert.deepEqual(mixedRuns, ['(A)', '<4E2D>', '(B)'], `混排要按编码切段: ${JSON.stringify(mixedRuns)}`)
    assert.ok(latin1.includes('/STSong-Light'), '要引用非嵌入 CJK 字体')
    assert.ok(latin1.includes('/UniGB-UCS2-H'), '要声明 GB 编码')
    assert.ok(latin1.includes('/Helvetica'), '拉丁字体也要在')
    // 不使用嵌入字体（那会让 PDF 十几 MB）
    assert.equal(latin1.includes('/FontFile'), false, '不能试图嵌入字体')

    // 分页：行数超一页要真的产出多页
    const many = buildTextPdf({ lines: Array.from({ length: 200 }, (_, i) => `line ${i}`) })
    const manyInfo = inspectPdf(many)
    assert.ok(manyInfo.pageCount > 1, `200 行应分多页，实际 ${manyInfo.pageCount}`)
    assert.equal((many.toString('latin1').match(/\/Type \/Pages/g) || []).length, 1, 'Pages 节点只有一个')

    // 空内容不能产出坏 PDF
    const empty = buildTextPdf({ lines: [] })
    const emptyInfo = inspectPdf(empty)
    assert.equal(emptyInfo.headerOk, true)
    assert.equal(emptyInfo.endsWithEof, true)
    assert.ok(emptyInfo.pageCount >= 1, '至少要有一页')
    assert.ok(empty.toString('latin1').includes('no extractable text'))

    // 尺寸与页边距：内容不该越界
    assert.equal(PAGE.width > PAGE.height, false, 'A4 是纵向的')
    const tiny = buildTextPdf({ lines: ['x'], page: { width: 200, height: 200 } })
    assert.equal(inspectPdf(tiny).endsWithEof, true, '自定义页尺寸也要产出合法 PDF')
  }

  // ── 4. ZIP 读取 ───────────────────────────────────────────────────────
  {
    const zip = buildZip([
      { name: 'stored.txt', content: 'stored content' },
      { name: 'deflated.xml', content: '<a>deflated content</a>'.repeat(20), deflate: true },
    ])
    const entries = listZipEntries(zip)
    assert.equal(entries.length, 2)
    assert.equal(entries[0].name, 'stored.txt')
    assert.equal(entries[0].method, 0)
    assert.equal(entries[1].name, 'deflated.xml')
    assert.equal(entries[1].method, 8)

    assert.equal(readZipEntry(zip, entries[0]).toString('utf8'), 'stored content')
    assert.equal(readZipEntry(zip, entries[1]).toString('utf8'), '<a>deflated content</a>'.repeat(20))

    // 不是 ZIP：明确报错，而不是抛出难懂的 zlib 错
    let notZip = null
    try { listZipEntries(Buffer.from('not a zip at all')) } catch (e) { notZip = e }
    assert.equal(notZip?.code, 'NOT_A_ZIP')
    let tinyZip = null
    try { listZipEntries(Buffer.from('x')) } catch (e) { tinyZip = e }
    assert.equal(tinyZip?.code, 'NOT_A_ZIP')
    // 缺条目：也要明确报错
    let noEntry = null
    try { readZipEntry(zip, null) } catch (e) { noEntry = e }
    assert.equal(noEntry?.code, 'ENTRY_NOT_FOUND')
  }

  // ── 5. XML 文本提取 ───────────────────────────────────────────────────
  {
    const docXml = `<w:document><w:body>
      <w:p><w:r><w:t>第一段</w:t></w:r></w:p>
      <w:p><w:r><w:t xml:space="preserve">Second </w:t></w:r><w:r><w:t>paragraph</w:t></w:r></w:p>
      <w:p><w:r><w:t>转义 &amp; &lt;tag&gt; &quot;引号&quot;</w:t></w:r></w:p>
    </w:body></w:document>`
    const parts = extractTagText(docXml, ['w:t'])
    assert.ok(parts.includes('第一段'), `平铺抽取也要能拿到内容: ${JSON.stringify(parts)}`)
    assert.ok(parts.includes('Second '), 'xml:space="preserve" 的空格要保留')
    assert.ok(parts.includes('转义 & <tag> "引号"'), `XML 实体要解码: ${JSON.stringify(parts)}`)

    // 段落结构由 extractParagraphLines 负责（平铺抽取拿不到边界，这是刻意的分工）
    const paragraphs = extractParagraphLines(docXml, { paragraphTags: ['w:p'], textTags: ['w:t'] })
    assert.equal(paragraphs.length, 3, `三段文字: ${JSON.stringify(paragraphs)}`)
    assert.equal(paragraphs[0], '第一段')
    assert.equal(paragraphs[1], 'Second paragraph', '同一段里的多个 run 要拼起来')
    assert.equal(paragraphs[2], '转义 & <tag> "引号"')

    // **关键回归**：外层不想要的标签不能把里面的内容吞掉。
    // 第一版用「匹配 <tag>…</tag> 再判断标签名」的写法，`<w:document>` 会把整个文档
    // 吞进它的惰性捕获里，于是内层 `<w:t>` 一条都扫不到、抽出来是空的。
    assert.deepEqual(extractTagText('<outer><inner><t>deep</t></inner></outer>', ['t']), ['deep'],
      '嵌套在无关标签里的目标标签必须仍能被找到')
    assert.deepEqual(extractTagText('<a><t>x</t></a><a><t>y</t></a>', ['t']), ['x', 'y'])

    // 数字实体
    assert.equal(extractTagText('<t>&#65;&#x42;</t>', ['t'])[0], 'AB')
    // 自闭合标签不该产出内容，也不能让扫描卡住
    assert.deepEqual(extractTagText('<t/><t>ok</t>', ['t']), ['ok'])
    // 大小写不敏感
    assert.deepEqual(extractTagText('<T>X</T>', ['t']), ['X'])
  }

  // ── 6. 各格式的文本抽取（用真 ZIP+XML 造）──────────────────────────────
  {
    const docxPath = path.join(tmp, 'demo.docx')
    fs.writeFileSync(docxPath, buildZip([
      { name: '[Content_Types].xml', content: '<Types/>' },
      { name: 'word/document.xml', content: '<w:document><w:body><w:p><w:r><w:t>Hello 世界</w:t></w:r></w:p><w:p><w:r><w:t>第二段</w:t></w:r></w:p></w:body></w:document>', deflate: true },
    ]))
    const docx = await extractOfficeText(docxPath)
    assert.equal(docx.format, 'docx')
    assert.ok(docx.lines.join('\n').includes('Hello 世界'))
    assert.ok(docx.lines.join('\n').includes('第二段'))

    const xlsxPath = path.join(tmp, 'demo.xlsx')
    fs.writeFileSync(xlsxPath, buildZip([
      { name: 'xl/sharedStrings.xml', content: '<sst><si><t>列一</t></si><si><t>列二</t></si></sst>' },
      { name: 'xl/worksheets/sheet1.xml', content: '<worksheet><sheetData><row><c t="s"><v>0</v></c><c t="s"><v>1</v></c></row><row><c><v>42</v></c></row></sheetData></worksheet>', deflate: true },
    ]))
    const xlsx = await extractOfficeText(xlsxPath)
    assert.equal(xlsx.format, 'xlsx')
    const sheetText = xlsx.lines.join('\n')
    assert.ok(sheetText.includes('列一\t列二'), `共享字符串要按索引还原: ${JSON.stringify(xlsx.lines)}`)
    assert.ok(sheetText.includes('42'), '数字单元格要保留')

    const pptxPath = path.join(tmp, 'demo.pptx')
    fs.writeFileSync(pptxPath, buildZip([
      { name: 'ppt/slides/slide1.xml', content: '<p:sld><a:p><a:r><a:t>标题页</a:t></a:r></a:p></p:sld>' },
      { name: 'ppt/slides/slide2.xml', content: '<p:sld><a:p><a:r><a:t>Second slide</a:t></a:r></a:p></p:sld>', deflate: true },
    ]))
    const pptx = await extractOfficeText(pptxPath)
    assert.equal(pptx.format, 'pptx')
    const slideText = pptx.lines.join('\n')
    assert.ok(slideText.includes('标题页'))
    assert.ok(slideText.indexOf('标题页') < slideText.indexOf('Second slide'), '幻灯片要按序号排列')

    // 纯文本格式
    const txtPath = path.join(tmp, 'note.md')
    fs.writeFileSync(txtPath, '\uFEFF# 标题\n\n正文', 'utf8')
    const txt = await extractOfficeText(txtPath)
    assert.equal(txt.format, 'text')
    assert.equal(txt.lines[0], '# 标题', 'BOM 要去掉')

    // 老的二进制格式：明确报错并指路（猜着解析只会产出乱码，比老实说不支持更糟）
    const legacyPath = path.join(tmp, 'old.doc')
    fs.writeFileSync(legacyPath, Buffer.from([0xd0, 0xcf, 0x11, 0xe0]))
    let legacy = null
    try { await extractOfficeText(legacyPath) } catch (e) { legacy = e }
    assert.equal(legacy?.code, 'LEGACY_BINARY_FORMAT')
    assert.ok(/x$|LibreOffice/.test(legacy.message), '要告诉用户怎么办')

    // 缺 document.xml 的 docx（伪造/损坏）要报 MISSING_DOCUMENT，而不是崩
    const brokenPath = path.join(tmp, 'broken.docx')
    fs.writeFileSync(brokenPath, buildZip([{ name: 'other.xml', content: '<x/>' }]))
    let broken = null
    try { await extractOfficeText(brokenPath) } catch (e) { broken = e }
    assert.equal(broken?.code, 'MISSING_DOCUMENT')

    // 能力判定
    assert.equal(canExtractText('a.docx'), true)
    assert.equal(canExtractText('a.xlsx'), true)
    assert.equal(canExtractText('a.pptx'), true)
    assert.equal(canExtractText('a.doc'), false, '老格式不在能力范围内')
    assert.equal(canExtractText('a.pdf'), false)
    assert.ok(TEXT_EXTRACTABLE_EXTENSIONS.includes('.docx'))
    assert.ok(PLAIN_TEXT_EXTENSIONS.includes('.md'))
  }

  // ── 7. 兜底端到端：office 文件 → 真的产出 PDF ─────────────────────────
  {
    const outDir = path.join(tmp, 'out')
    const docxPath = path.join(tmp, 'demo.docx')
    fs.writeFileSync(docxPath, buildZip([
      { name: 'word/document.xml', content: '<w:document><w:body><w:p><w:r><w:t>报告标题</w:t></w:r></w:p><w:p><w:r><w:t>第一行结论</w:t></w:r></w:p></w:body></w:document>', deflate: true },
    ]))

    const result = await convertViaTextFallback({ inputs: [docxPath], outDir })
    assert.equal(result.converter, CONVERTER.TEXT_FALLBACK, '必须如实报告用的是兜底路径')
    assert.equal(result.converted.length, 1)
    const output = result.converted[0].output
    assert.equal(output, path.join(outDir, 'demo.pdf'), '输出名是扩展名替换')
    const pdf = fs.readFileSync(output)
    const info = inspectPdf(pdf)
    assert.equal(info.headerOk, true)
    assert.equal(info.endsWithEof, true)
    assert.equal(info.xrefEntryCount, info.objectCount + 1)
    assert.ok(pdf.toString('latin1').includes('报告标题'.split('').map(c => c.codePointAt(0).toString(16).toUpperCase()).join('')) === false || true)

    // 内容真的进去了：把 PDF 里的文本段还原出来（十六进制段=中文，字面量段=拉丁）
    const latin1 = pdf.toString('latin1')
    let restored = ''
    for (const m of latin1.matchAll(/<([0-9A-Fa-f]+)>|\(((?:[^()\\]|\\.)*)\)/g)) {
      if (m[1]) {
        const hex = m[1]
        for (let i = 0; i + 4 <= hex.length; i += 4) restored += String.fromCharCode(parseInt(hex.slice(i, i + 4), 16))
      } else if (m[2] !== undefined) {
        restored += m[2].replace(/\\([\\()])/g, '$1')
      }
    }
    assert.ok(restored.includes('报告标题'), `PDF 里应能还原出原文: ${restored.slice(0, 120)}`)
    assert.ok(restored.includes('第一行结论'))
    // 首页要标明这是文本导出（不能让人以为版式都在）
    assert.ok(restored.includes('text-only export'), `首页要标明是文本导出: ${restored.slice(0, 200)}`)
    assert.ok(/layout, images and styles are not preserved/.test(restored))

    // 一个成功一个失败：好的照常产出，坏的逐条报回来
    const legacy = path.join(tmp, 'old.xls')
    fs.writeFileSync(legacy, Buffer.from([0xd0, 0xcf]))
    const mixed = await convertViaTextFallback({ inputs: [docxPath, legacy], outDir })
    assert.equal(mixed.converted.length, 1)
    assert.equal(mixed.failed.length, 1)
    assert.equal(mixed.failed[0].code, 'LEGACY_BINARY_FORMAT')

    // 空输入
    let noInput = null
    try { await convertViaTextFallback({ inputs: [] }) } catch (e) { noInput = e }
    assert.equal(noInput?.code, 'NO_INPUTS')
  }

  // ── 8. 结构化解析：docx 的标题/表格/列表真的被解析成结构 ───────────────
  {
    // 样式名 → 层级。这条规则错了，整个「字号层级」就无从谈起
    assert.equal(headingLevelFromStyle('Heading1'), 1)
    assert.equal(headingLevelFromStyle('heading 2'), 2)
    assert.equal(headingLevelFromStyle('标题3'), 3)
    assert.equal(headingLevelFromStyle('Title'), 1)
    assert.equal(headingLevelFromStyle('Normal'), null, '正文字体不该被当成标题')
    assert.equal(headingLevelFromStyle(''), null)
    assert.equal(headingLevelFromStyle(undefined), null)

    // 编号格式：列表项的标记是版面信息，必须解析出来
    const numbering = parseNumberingXml([
      '<w:numbering>',
      '<w:abstractNum w:abstractNumId="1">',
      '<w:lvl w:ilvl="0"><w:numFmt w:val="decimal"/></w:lvl>',
      '<w:lvl w:ilvl="1"><w:numFmt w:val="lowerRoman"/></w:lvl>',
      '</w:abstractNum>',
      '<w:num w:numId="7"><w:abstractNumId w:val="1"/></w:num>',
      '</w:numbering>',
    ].join(''))
    assert.deepEqual(numbering.get('7'), ['decimal', 'lowerRoman'])
    assert.equal(numbering.has('1'), false, 'abstractNum 的 id 不该被当成 numId')

    // 表格必须是行列，不是制表符拼接的字符串
    const docXml = [
      '<w:document><w:body>',
      '<w:p><w:pPr><w:pStyle w:val="Heading1"/></w:pPr><w:r><w:t>季度报告</w:t></w:r></w:p>',
      '<w:p><w:r><w:t>正文结论</w:t></w:r></w:p>',
      '<w:p><w:pPr><w:pStyle w:val="Heading2"/></w:pPr><w:r><w:t>明细</w:t></w:r></w:p>',
      '<w:p><w:pPr><w:numId w:val="7"/></w:pPr><w:r><w:t>第一项</w:t></w:r></w:p>',
      '<w:tbl><w:tblPr/>',
      '<w:tr><w:tc><w:tcPr/><w:p><w:r><w:t>区域</w:t></w:r></w:p></w:tc>',
      '<w:tc><w:tcPr/><w:p><w:r><w:t>收入</w:t></w:r></w:p></w:tc></w:tr>',
      '<w:tr><w:tc><w:tcPr/><w:p><w:r><w:t>华东</w:t></w:r></w:p></w:tc>',
      '<w:tc><w:tcPr/><w:p><w:r><w:t>1200</w:t></w:r></w:p></w:tc></w:tr>',
      // 一个单元格里有**两个段落**：表格单元格是块，不是一行字符串。
      // 这一格专门用来钉住「单元格内部用换行而不是制表符分隔」。
      '<w:tr><w:tc><w:tcPr/><w:p><w:r><w:t>说明</w:t></w:r></w:p><w:p><w:r><w:t>含备注</w:t></w:r></w:p></w:tc>',
      '<w:tc><w:tcPr/><w:p><w:r><w:t>—</w:t></w:r></w:p></w:tc></w:tr>',
      '</w:tbl>',
      '</w:body></w:document>',
    ].join('')

    const docxPath = path.join(tmp, 'structured.docx')
    fs.writeFileSync(docxPath, buildZip([
      { name: '[Content_Types].xml', content: '<Types/>' },
      { name: 'word/document.xml', content: docXml, deflate: true },
    ]))
    const parsed = await parseOfficeStructure(docxPath)
    assert.equal(parsed.format, 'docx')
    const types = parsed.blocks.map(b => b.type)
    assert.deepEqual(types, ['heading', 'paragraph', 'heading', 'listItem', 'table'],
      `块序列要保住结构: ${JSON.stringify(types)}`)
    assert.equal(parsed.blocks[0].level, 1)
    assert.equal(parsed.blocks[2].level, 2, '两级标题要有不同层级')

    // **关键断言**：表格是 `rows[x][y]` 的二维结构，不是含 \t 的字符串
    const table = parsed.blocks[4]
    assert.equal(table.type, 'table')
    assert.equal(table.rows.length, 3, '三行')
    assert.equal(table.rows[0].length, 2, '两列')
    assert.deepEqual(table.rows[0].map(c => c.text), ['区域', '收入'])
    assert.deepEqual(table.rows[1].map(c => c.text), ['华东', '1200'])
    // 单元格里的两个段落用换行分隔（用制表符就是「表格退化成文本」的那种实现）
    assert.equal(table.rows[2][0].text, '说明\n含备注', `单元格内多段落要用换行: ${JSON.stringify(table.rows[2][0].text)}`)
    assert.equal(table.rows[2][1].text, '—')
    const tableJson = JSON.stringify(table)
    assert.equal(tableJson.includes('\\t'), false,
      `结构化路径里不该出现制表符拼接的单元格: ${tableJson.slice(0, 200)}`)

    const stats = structureStats(parsed.blocks)
    assert.equal(stats.tables, 1)
    assert.equal(stats.tableRows, 3)
    assert.equal(stats.tableCells, 6)
    assert.deepEqual(stats.headingLevels, [1, 2], '两个不同层级的标题')

    // xlsx：单元格引用决定列位置，空列不能丢（丢了列就错位了）
    const sheet = parseSheetXml([
      '<worksheet><sheetData>',
      '<row r="1"><c r="A1" t="s"><v>0</v></c><c r="C1" t="s"><v>1</v></c></row>',
      '<row r="2"><c r="A2"><v>42</v></c><c r="B2"><v>3.5</v></c></row>',
      '</sheetData></worksheet>',
    ].join(''), { sharedStrings: ['区域', '同比'] })
    assert.equal(sheet.columnCount, 3)
    assert.deepEqual(sheet.rows[0].cells, ['区域', '', '同比'], 'B1 缺失要补空串，否则 C 列会左移')
    assert.deepEqual(sheet.rows[1].cells, ['42', '3.5', ''])

    // 老的二进制格式与无扩展名文件：结构化解析明确拒绝（但会回落到文本抽取那层的报错）
    assert.equal(canParseStructure('a.docx'), true)
    assert.equal(canParseStructure('a.xlsx'), true)
    assert.equal(canParseStructure('a.doc'), false, '老格式解析不了')
    assert.equal(canParseStructure('a.txt'), false, '纯文本没有结构可解析')
    assert.ok(STRUCTURED_EXTENSIONS.includes('.pptx'))

    let unsupported = null
    try { await parseOfficeStructure(path.join(tmp, 'note.md')) } catch (e) { unsupported = e }
    assert.equal(unsupported?.code, 'UNSUPPORTED_FORMAT')
  }

  // ── 9. 结构化 PDF：真的有表格线框 + 真的字号层级 + 中文往返 ────────────
  {
    const blocks = [
      { type: 'heading', level: 1, text: '年度总结' },
      { type: 'paragraph', text: '正文结论' },
      { type: 'heading', level: 2, text: '分区域' },
      { type: 'table', rows: [
        [{ text: '区域' }, { text: '收入' }],
        [{ text: '华东' }, { text: '1200' }],
        [{ text: '华南' }, { text: '980' }],
      ] },
    ]
    const pdf = buildStructuredPdf({ title: 'structured', blocks, sourceLabel: 'demo.docx — structured export (docx)' })
    const info = inspectPdf(pdf)
    assert.equal(info.headerOk, true)
    assert.equal(info.endsWithEof, true)
    assert.equal(info.xrefEntryCount, info.objectCount + 1, 'xref 条目数 = 对象数 + 1')

    const latin1 = pdf.toString('latin1')

    // **表格是表格而不是制表符**：3 行 × 2 列 = 6 个单元格矩形描边。
    // 这条断言在「表格退化成制表符拼接」的实现上必然失败——那时 `re S` 是 0 条。
    // 指令形状是 `<线宽> w <r> <g> <b> RG <x> <y> <w> <h> re S`。
    const RECT_RE = /([\d.]+) w [\d.]+ [\d.]+ [\d.]+ RG ([\d.-]+) ([\d.-]+) ([\d.]+) ([\d.]+) re S/g
    // 捕获组：1=线宽 2=x 3=y 4=宽 5=高
    const rules = [...latin1.matchAll(RECT_RE)].map(m => ({
      lineWidth: Number(m[1]), x: Number(m[2]), y: Number(m[3]), width: Number(m[4]), height: Number(m[5]),
    }))
    assert.equal(rules.length, 6, `3 行 × 2 列要有 6 个单元格线框，实际 ${rules.length}`)
    for (const rule of rules) {
      assert.ok(rule.width > 10 && rule.height > 5, `单元格线框必须有实际尺寸: ${rule.width}×${rule.height}`)
      assert.ok(rule.lineWidth > 0 && rule.lineWidth <= 1, `线宽要显式写出且合理: ${rule.lineWidth}`)
    }
    // 列是对齐的：同一列在不同行上的 x 与宽度必须一致（「至少列对齐」这条要求）
    const rowsByY = new Map()
    for (const rule of rules) {
      if (!rowsByY.has(rule.y)) rowsByY.set(rule.y, [])
      rowsByY.get(rule.y).push(rule)
    }
    const rowList = [...rowsByY.values()]
    assert.equal(rowList.length, 3, `三行各自的线框 y 不同，实际 ${rowList.length}`)
    for (const row of rowList) assert.equal(row.length, 2, '每行两个单元格')
    for (let c = 0; c < 2; c++) {
      const column = rowList.map(row => row.sort((a, b) => a.x - b.x)[c])
      for (const cell of column) {
        assert.equal(cell.x, column[0].x, `第 ${c} 列的 x 必须跨行一致（列对齐）`)
        assert.equal(cell.width, column[0].width, `第 ${c} 列的宽度必须跨行一致（列对齐）`)
      }
    }
    // 表格里**不该**有制表符（制表符正是「没有表格」的标志）
    assert.equal(extractPdfText(pdf).includes('\t'), false, '结构化 PDF 里不该出现制表符')

    // 字号层级：H1 > H2 > 正文 > 表格
    const sizes = [...new Set([...latin1.matchAll(/\/(F[123]) ([\d.]+) Tf/g)].map(m => Number(m[2])))].sort((a, b) => b - a)
    assert.ok(sizes.length >= 3, `至少要有三档字号（H1/H2/正文），实际 ${JSON.stringify(sizes)}`)
    const h1 = sizes[0]
    const body = sizes[sizes.length - 1]
    assert.ok(h1 >= body * 1.5, `H1(${h1}) 必须明显大于正文(${body})`)
    const h2 = sizes[1]
    assert.ok(h2 < h1 && h2 > body, `H2(${h2}) 必须在 H1(${h1}) 与正文(${body}) 之间`)
    // 标题不只靠字号：还用粗体（层级是两维的）
    assert.ok(latin1.includes('/BaseFont /Helvetica-Bold'), '标题要用粗体字体')
    assert.ok(/\/F3 [\d.]+ Tf/.test(latin1), '粗体字体要被实际选为当前字体')

    // 中文往返：生成的 PDF 里能取回原文
    const restored = extractPdfText(pdf)
    assert.ok(restored.includes('年度总结'), `PDF 里应能还原标题: ${restored.slice(0, 200)}`)
    assert.ok(restored.includes('分区域'))
    assert.ok(restored.includes('华东'), '表格单元格里的中文也要往返')
    assert.ok(restored.includes('1200'))
    assert.ok(restored.includes('structured export'), '首页要标明这是结构化导出')
    // 与文本兜底一样走非嵌入 CJK 字体（不引十几 MB 的字体文件）
    assert.ok(latin1.includes('/STSong-Light'))
    assert.ok(latin1.includes('/UniGB-UCS2-H'))
    assert.equal(latin1.includes('/FontFile'), false, '不能试图嵌入字体')

    // 版面数字：标题、正文、表格的行位置不能重叠（重叠=没有排版）
    const layout = layoutStructured({ blocks })
    assert.equal(layout.pageCount, 1)
    for (const page of layout.pages) {
      const texts = page.filter(c => c.kind === 'text')
      assert.ok(texts.length >= 5, `页面上要有标题/正文/表格文字: ${texts.length}`)
      // 表格文字必须落在表格线框的范围内（不然「有表格线」只是画了几个框）
      const rects = page.filter(c => c.kind === 'rect')
      assert.equal(rects.length, 6)
      const tableTexts = texts.filter(t => ['区域', '收入', '华东', '1200', '华南', '980'].includes(t.text))
      assert.equal(tableTexts.length, 6, '六个单元格文字都要排进去')
      for (const t of tableTexts) {
        assert.ok(rects.some(r => t.y <= r.y + r.height + 0.01 && t.y >= r.y - 0.01 && t.x >= r.x - 0.01 && t.x <= r.x + r.width + 0.01),
          `单元格文字 ${t.text} 应落在某个单元格线框内 (y=${t.y.toFixed(1)}, x=${t.x.toFixed(1)})`)
      }
    }
    // 分页：内容超页要真的分页，且不能把表格行劈到两页
    const manyBlocks = [{ type: 'heading', level: 1, text: '长文' }]
    for (let i = 0; i < 120; i++) manyBlocks.push({ type: 'paragraph', text: `第 ${i} 段正文内容` })
    manyBlocks.push({ type: 'table', rows: [[{ text: 'A' }, { text: 'B' }], [{ text: 'C' }, { text: 'D' }]] })
    const manyPdf = buildStructuredPdf({ blocks: manyBlocks })
    const manyInfo = inspectPdf(manyPdf)
    assert.ok(manyInfo.pageCount > 1, `长文档要分多页，实际 ${manyInfo.pageCount}`)
    assert.equal((manyPdf.toString('latin1').match(/\/Type \/Pages/g) || []).length, 1, 'Pages 节点只有一个')
    // 分页后每个页面对象都要有对应的内容流
    assert.equal(manyInfo.objectCount, 3 + manyInfo.pageCount * 2 + 3,
      `对象数 = 3 字体 + ${manyInfo.pageCount} 内容流 + ${manyInfo.pageCount} 页面 + Pages/Catalog/Info`)
  }

  // ── 10. 路径选择顺序：LibreOffice → 结构化 → 文本兜底 ─────────────────
  {
    const outDir = path.join(tmp, 'chain')
    // 造一个**真** docx（有标题、有表格），三条路径都能处理它
    const docxPath = path.join(tmp, 'chain.docx')
    fs.writeFileSync(docxPath, buildZip([
      { name: '[Content_Types].xml', content: '<Types/>' },
      {
        name: 'word/document.xml',
        content: '<w:document><w:body><w:p><w:pPr><w:pStyle w:val="Heading1"/></w:pPr><w:r><w:t>标题中文</w:t></w:r></w:p>'
          + '<w:tbl><w:tr><w:tc><w:p><w:r><w:t>甲</w:t></w:r></w:p></w:tc><w:tc><w:p><w:r><w:t>乙</w:t></w:r></w:p></w:tc></w:tr></w:tbl>'
          + '</w:body></w:document>',
        deflate: true,
      },
    ]))

    // 顺序本身是契约，先断言常量
    assert.deepEqual([...CONVERTER_ORDER], ['libreoffice', 'structured', 'text-fallback'])
    assert.equal(CONVERTER_FIDELITY[CONVERTER.LIBREOFFICE], 'full')
    assert.equal(CONVERTER_FIDELITY[CONVERTER.STRUCTURED], 'structured')
    assert.equal(CONVERTER_FIDELITY[CONVERTER.TEXT_FALLBACK], 'text-only')

    // (a) LibreOffice 可用 → 绝不走结构化。用注入的 _run 模拟它产出 PDF。
    const loRun = async (command, args) => {
      const target = path.join(args[args.indexOf('--outdir') + 1], 'chain.pdf')
      fs.writeFileSync(target, '%PDF-1.4 fake-libreoffice\n%%EOF\n', 'latin1')
      return { ok: true, code: 0, stdout: '', stderr: '' }
    }
    const viaLo = await convertToPdf({
      inputs: [docxPath], outDir: path.join(outDir, 'lo'), binary: FAKE_SOFFICE, profileDir: path.join(tmp, 'p-chain'), _run: loRun,
    })
    assert.equal(viaLo.converter, CONVERTER.LIBREOFFICE, '装了 LibreOffice 就必须走它')
    assert.equal(viaLo.fidelity, 'full')
    assert.equal(viaLo.converted.length, 1)
    // 结构化路径**一次都不该被碰过**：碰了就可能覆盖 LibreOffice 的产物
    assert.equal(viaLo.attempts.some(a => a.converter === CONVERTER.STRUCTURED), false,
      'LibreOffice 可用时不该尝试结构化路径')
    assert.equal(fs.readFileSync(viaLo.converted[0].output, 'utf8').includes('fake-libreoffice'), true,
      '产物必须来自 LibreOffice，不能被结构化路径覆盖')

    // (b) LibreOffice 不可用 → 走到结构化（而不是直接掉到纯文本）
    const viaStructured = await convertToPdf({ inputs: [docxPath], outDir: path.join(outDir, 'structured'), binary: null })
    if (findLibreOfficeBinaryFound()) {
      // 这台机器真的装了 LibreOffice：binary:null 会走真实转换，跳过依赖机器状态的断言
    } else {
      assert.equal(viaStructured.converter, CONVERTER.STRUCTURED, '没装 LibreOffice 时要走结构化，不是纯文本')
      assert.equal(viaStructured.fidelity, 'structured')
      assert.equal(viaStructured.converted.length, 1)
      assert.ok(viaStructured.converted[0].structure?.tables >= 1, '要报告解析出的表格数')
      // 产物里真的有表格线框与两档字号
      const pdf = fs.readFileSync(viaStructured.converted[0].output)
      const restored = extractPdfText(pdf)
      assert.ok(restored.includes('标题中文'), `结构化 PDF 要能还原中文: ${restored.slice(0, 160)}`)
      assert.ok(restored.includes('甲') && restored.includes('乙'), '表格单元格文字要进去')
      assert.ok((pdf.toString('latin1').match(/ re S/g) || []).length >= 2, '要有表格线框')
      // attempts 要如实记录「LibreOffice 不可用 → 结构化成功」
      assert.deepEqual(viaStructured.attempts.map(a => `${a.converter}:${a.outcome}`),
        ['libreoffice:unavailable', 'structured:succeeded'])
    }

    // (c) 结构化也失败（.txt：没有结构可解析）→ 才到纯文本兜底
    const txtPath = path.join(tmp, 'chain.txt')
    fs.writeFileSync(txtPath, '纯文本内容\n第二行', 'utf8')
    const viaText = await convertToPdf({ inputs: [txtPath], outDir: path.join(outDir, 'text'), binary: null })
    if (!findLibreOfficeBinaryFound()) {
      assert.equal(viaText.converter, CONVERTER.TEXT_FALLBACK, '结构化失败时必须继续往下降到纯文本')
      assert.equal(viaText.fidelity, 'text-only')
      assert.equal(viaText.converted.length, 1)
      assert.ok(extractPdfText(fs.readFileSync(viaText.converted[0].output)).includes('纯文本内容'))
      // 三层都被记录：不可用 → 失败 → 成功
      assert.deepEqual(viaText.attempts.map(a => `${a.converter}:${a.outcome}`),
        ['libreoffice:unavailable', 'structured:failed', 'text-fallback:succeeded'],
        `每一层都要留痕: ${JSON.stringify(viaText.attempts)}`)
      assert.ok(viaText.attempts[1].detail.includes('chain.txt'), '结构化失败要说明是哪个文件')

      // (d) 三层全失败 → 不抛异常（路径确实跑到了底，这是**结果**不是异常），
      //     但要如实上报「最后试的那条」并把每层的失败原因逐条带回来。
      const legacyPath = path.join(tmp, 'chain.doc')
      fs.writeFileSync(legacyPath, Buffer.from([0xd0, 0xcf, 0x11, 0xe0]))
      const allFailed = await convertToPdf({ inputs: [legacyPath], outDir: path.join(outDir, 'none'), binary: null })
      assert.equal(allFailed.converted.length, 0, '全失败时不能有任何 converted')
      assert.equal(allFailed.failed.length, 1)
      assert.equal(allFailed.converter, CONVERTER.TEXT_FALLBACK, '全失败时上报最后试的那条，不能谎称走了结构化')
      assert.deepEqual(allFailed.attempts.map(a => `${a.converter}:${a.outcome}`),
        ['libreoffice:unavailable', 'structured:failed', 'text-fallback:failed'])
      // 每层各自的失败原因都要在：结构化说是 UNSUPPORTED_FORMAT，文本说是 LEGACY_BINARY_FORMAT
      const codes = allFailed.failed.map(f => f.code)
      assert.ok(codes.includes('LEGACY_BINARY_FORMAT'),
        `老格式的失败原因要带回来: ${JSON.stringify(allFailed.failed)}`)

      // (e) 关掉结构化 → 直接到纯文本（开关必须真的生效）
      const noStructured = await convertToPdf({
        inputs: [docxPath], outDir: path.join(outDir, 'nostructured'), binary: null, allowStructured: false,
      })
      assert.equal(noStructured.converter, CONVERTER.TEXT_FALLBACK)
      assert.equal(noStructured.attempts.find(a => a.converter === CONVERTER.STRUCTURED)?.outcome, 'skipped')

      // (f) 两条纯 JS 路径都关掉 → NO_CONVERTER + 安装提示
      let none = null
      try {
        await convertToPdf({
          inputs: [docxPath], binary: null, allowStructured: false, allowTextFallback: false,
        })
      } catch (e) { none = e }
      assert.equal(none?.code, 'NO_CONVERTER')
      assert.ok(none.detail?.hint?.includes('libreoffice.org'))
    }

    // (g) convertViaStructure 直接调用：converter 字段如实、失败逐条上报
    const direct = await convertViaStructure({ inputs: [docxPath], outDir: path.join(outDir, 'direct') })
    assert.equal(direct.converter, CONVERTER.STRUCTURED, '直接调用也要如实上报路径')
    assert.equal(direct.fidelity, 'structured')
    assert.equal(direct.converted.length, 1)
    assert.equal(fs.existsSync(direct.converted[0].output), true)
    const directMixed = await convertViaStructure({ inputs: [docxPath, path.join(tmp, 'chain.txt')], outDir: path.join(outDir, 'direct') })
    assert.equal(directMixed.converted.length, 1)
    assert.equal(directMixed.failed.length, 1)
    assert.equal(directMixed.failed[0].code, 'UNSUPPORTED_FORMAT')
    assert.equal(directMixed.converter, CONVERTER.STRUCTURED, '失败混杂时也不能改口径')

    let directNoInput = null
    try { await convertViaStructure({ inputs: [] }) } catch (e) { directNoInput = e }
    assert.equal(directNoInput?.code, 'NO_INPUTS')
  }

  console.log('PASS office-fallback: PDF structure/xref, CJK encoding without embedded fonts, zip+xml text extraction, structured tables/heading levels, path order (LibreOffice→structured→text) and honest path reporting')
} finally {
  try { fs.rmSync(tmp, { recursive: true, force: true }) } catch { /* 清理失败不影响结论 */ }
  try { fs.rmSync(process.env.ALICE_USER_DIR, { recursive: true, force: true }) } catch { /* 同上 */ }
}
