// 极简 PDF 生成器（阶段 6.3 的无依赖兜底）。
//
// 为什么需要它：LibreOffice 没装时，`convert_to_pdf` 就完全没用了。计划里写「再考虑
// WASM」，但**纯 JS 比 WASM 更合适**：不用背一个十几 MB 的二进制、没有运行时初始化、
// 在任何平台都一样。代价是排版能力有限——只做「可读的文本 PDF」，不做版式还原。
//
// 真正难的地方是**中文**：PDF 的基础 14 字体（Helvetica 等）里没有汉字，而嵌入一份
// 中文字体动辄十几 MB。这里用的办法是 PDF 标准里的**非嵌入 CJK 字体**：
//   /BaseFont /STSong-Light + /Encoding /UniGB-UCS2-H
// 字形由阅读器提供（Adobe 的中文标准字体）。

export const PAGE = Object.freeze({ width: 595.28, height: 841.89 }) // A4，单位 pt
const MARGIN = 56.7 // 2cm
const LINE_HEIGHT = 16
const FONT_SIZE = 11

export class PdfError extends Error {
  constructor(code, message) {
    super(message)
    this.name = 'PdfError'
    this.code = code
  }
}

/** 判断一个字符是否需要用 CJK 字体（CJK 统一表意 + 全角标点 + 假名）。 */
export function isCjkChar(ch) {
  const code = ch.codePointAt(0)
  return (
    (code >= 0x3000 && code <= 0x303f)
    || (code >= 0x3040 && code <= 0x30ff)
    || (code >= 0x3400 && code <= 0x4dbf)
    || (code >= 0x4e00 && code <= 0x9fff)
    || (code >= 0xf900 && code <= 0xfaff)
    || (code >= 0xff00 && code <= 0xffef)
  )
}

/**
 * 把一个字符编码成 PDF 字符串字面量的一小段。
 * - CJK 走 `<hex>`（UCS-2 十六进制），配 UniGB-UCS2-H 编码
 * - 拉丁走转义后的 `(...)`
 * @returns {{kind: 'hex'|'literal', text: string}}
 */
// WinAnsiEncoding 里 0x80–0x9F 这一段不是控制符，而是最常见的几个标点。
// 排出来源说明里的 `—`、中文文档里的 `…`「」都会落到这里；把它们降级成 '?' 会让
// 我们自己写的那行说明凭空多出几个问号（第一版就是这样）。
const WIN_ANSI_HIGH = Object.freeze({
  0x20ac: 0x80, 0x201a: 0x82, 0x0192: 0x83, 0x201e: 0x84, 0x2026: 0x85, 0x2020: 0x86,
  0x2021: 0x87, 0x02c6: 0x88, 0x2030: 0x89, 0x0160: 0x8a, 0x2039: 0x8b, 0x0152: 0x8c,
  0x017d: 0x8e, 0x2018: 0x91, 0x2019: 0x92, 0x201c: 0x93, 0x201d: 0x94, 0x2022: 0x95,
  0x2013: 0x96, 0x2014: 0x97, 0x2122: 0x99, 0x203a: 0x9b, 0x0153: 0x9c, 0x017e: 0x9e,
  0x0178: 0x9f,
})

// 反向表：把 WinAnsi 字节还原成 Unicode 码点。少了它，`extractPdfText` 会把
// 破折号还原成 U+0097 这个控制码，往返断言就会诡异地「看着有字符却对不上」。
const WIN_ANSI_HIGH_REVERSE = Object.freeze(
  Object.fromEntries(Object.entries(WIN_ANSI_HIGH).map(([unicode, byte]) => [byte, Number(unicode)])),
)

export function encodeChar(ch) {
  if (isCjkChar(ch)) {
    const code = ch.codePointAt(0)
    // 基本平面之外的汉字（极少见）用 0x3F '?' 兜底，而不是产出非法序列
    const ucs2 = code <= 0xffff ? code : 0x3f
    return { kind: 'hex', text: ucs2.toString(16).toUpperCase().padStart(4, '0') }
  }
  const code = ch.codePointAt(0)
  // WinAnsi 覆盖不到的一律降到 '?'，避免写进 PDF 的字节和实际显示不一致
  if (WIN_ANSI_HIGH[code] !== undefined) {
    return { kind: 'literal', text: `\\${WIN_ANSI_HIGH[code].toString(8).padStart(3, '0')}` }
  }
  const safe = code >= 0x20 && code <= 0x7e ? ch : '?'
  const escaped = safe === '(' || safe === ')' || safe === '\\' ? `\\${safe}` : safe
  return { kind: 'literal', text: escaped }
}

/**
 * 把一行文本切成「同编码的连续片段」，每段一个 Tj。
 * 为什么不逐字符一个 Tj：文件会大好几倍，而且没有实际好处。
 */
export function encodeTextRun(text) {
  const runs = []
  let current = { font: null, parts: [] }
  for (const ch of String(text ?? '')) {
    const encoded = encodeChar(ch)
    const font = encoded.kind === 'hex' ? 'cjk' : 'latin'
    if (current.font !== font) {
      if (current.parts.length > 0) runs.push(current)
      current = { font, parts: [] }
    }
    current.parts.push(encoded.text)
  }
  if (current.parts.length > 0) runs.push(current)
  return runs.map((run) => ({
    font: run.font,
    value: run.font === 'cjk' ? `<${run.parts.join('')}>` : `(${run.parts.join('')})`,
  }))
}

/** 一个字符在版面里大致占多宽（用于换行）。CJK 全角，其余半角。 */
export function charWidth(ch) {
  return isCjkChar(ch) ? 1 : 0.5
}

/**
 * 按可用宽度折行。刻意不做断词算法：
 * 中文按字断，西文尽量在空格处断——再复杂的排版不值得这个兜底路径去做。
 */
export function wrapLine(text, maxUnits) {
  const source = String(text ?? '')
  if (source.length === 0) return ['']
  const lines = []
  let current = ''
  let used = 0
  let lastSpace = -1

  for (const ch of source) {
    const w = charWidth(ch)
    if (used + w > maxUnits && current.length > 0) {
      // 西文回退到最近的空格，中文直接断
      if (lastSpace > 0 && !isCjkChar(ch)) {
        lines.push(current.slice(0, lastSpace))
        current = current.slice(lastSpace + 1)
        used = [...current].reduce((sum, c) => sum + charWidth(c), 0)
      } else {
        lines.push(current)
        current = ''
        used = 0
      }
      lastSpace = -1
    }
    if (ch === ' ') lastSpace = current.length
    current += ch
    used += w
  }
  if (current.length > 0) lines.push(current)
  return lines
}

function escapeLiteral(value) {
  return String(value).replace(/([\\()])/g, '\\$1')
}

/**
 * 生成一份文本 PDF。
 * @param {object} o
 * @param {string} o.title       —— 元数据标题
 * @param {Array<string>} o.lines —— 文本行（会按页宽折行并自动分页）
 * @param {string} [o.sourceLabel] —— 首页顶部说明来源（比如原文件名）
 * @returns {Buffer}
 */
export function buildTextPdf({ title = '', lines = [], sourceLabel = '', page = PAGE } = {}) {
  const contentWidth = page.width - MARGIN * 2
  const maxUnits = contentWidth / (FONT_SIZE * 0.5)
  const maxLinesPerPage = Math.floor((page.height - MARGIN * 2) / LINE_HEIGHT)

  const allLines = []
  if (sourceLabel) allLines.push(sourceLabel, '')
  for (const line of lines) {
    for (const wrapped of wrapLine(line, maxUnits)) allLines.push(wrapped)
  }
  if (allLines.length === 0) allLines.push('(no extractable text)')

  const pages = []
  for (let i = 0; i < allLines.length; i += maxLinesPerPage) {
    pages.push(allLines.slice(i, i + maxLinesPerPage))
  }

  // ── 对象装配 ────────────────────────────────────────────────────────
  const objects = []
  const push = (body) => {
    objects.push(body)
    return objects.length // 1-based 对象号
  }

  const fontLatin = push('<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica /Encoding /WinAnsiEncoding >>')
  const fontCjk = push([
    '<< /Type /Font /Subtype /Type0 /BaseFont /STSong-Light',
    '/Encoding /UniGB-UCS2-H',
    '/DescendantFonts [<< /Type /Font /Subtype /CIDFontType0 /BaseFont /STSong-Light',
    '/CIDSystemInfo << /Registry (Adobe) /Ordering (GB1) /Supplement 2 >> >>] >>',
  ].join(' '))

  const pagesObjectNumber = objects.length + 1 + pages.length // 预留：内容流 + 页面对象之后是 Pages
  const contentNumbers = []
  const pageNumbers = []

  for (const pageLines of pages) {
    const ops = ['BT']
    let y = page.height - MARGIN
    let currentFont = null
    for (const line of pageLines) {
      const runs = encodeTextRun(line)
      if (runs.length === 0) { y -= LINE_HEIGHT; continue }
      // 每行都要先定位；字体变化时才切字体（少写指令，文件更小）
      for (let i = 0; i < runs.length; i++) {
        const run = runs[i]
        const fontRef = run.font === 'cjk' ? fontCjk : fontLatin
        if (currentFont !== fontRef) {
          ops.push(`/${fontRef === fontCjk ? 'F2' : 'F1'} ${FONT_SIZE} Tf`)
          currentFont = fontRef
        }
        // 同一行内后续片段按累计宽度右移；精确字宽要字体度量，这里用估算
        const x = MARGIN + (i === 0 ? 0 : estimateOffset(runs, i))
        ops.push(`1 0 0 1 ${x.toFixed(2)} ${y.toFixed(2)} Tm`)
        ops.push(`${run.value} Tj`)
      }
      y -= LINE_HEIGHT
    }
    ops.push('ET')
    const stream = ops.join('\n')
    const contentNumber = push(`<< /Length ${Buffer.byteLength(stream, 'latin1')} >>\nstream\n${stream}\nendstream`)
    contentNumbers.push(contentNumber)
  }

  // 页面对象必须在 Pages 之后才能知道父节点号，所以先占位再回填
  const firstPageNumber = objects.length + 1
  const pagesNumber = firstPageNumber + pages.length
  for (let i = 0; i < pages.length; i++) {
    push([
      '<< /Type /Page',
      `/Parent ${pagesNumber} 0 R`,
      `/MediaBox [0 0 ${page.width} ${page.height}]`,
      `/Resources << /Font << /F1 ${fontLatin} 0 R /F2 ${fontCjk} 0 R >> >>`,
      `/Contents ${contentNumbers[i]} 0 R >>`,
    ].join(' '))
    pageNumbers.push(firstPageNumber + i)
  }

  push(`<< /Type /Pages /Count ${pages.length} /Kids [${pageNumbers.map(n => `${n} 0 R`).join(' ')}] >>`)
  const catalogNumber = push(`<< /Type /Catalog /Pages ${pagesNumber} 0 R >>`)
  const infoNumber = push(`<< /Title (${escapeLiteral(title)}) /Producer (Alice text-to-PDF fallback) >>`)

  // ── 序列化 + xref ───────────────────────────────────────────────────
  const chunks = []
  let offset = 0
  const write = (text) => {
    const buf = Buffer.from(text, 'latin1')
    chunks.push(buf)
    offset += buf.length
  }

  write('%PDF-1.4\n')
  // 二进制标记行：告诉工具这是二进制文件（否则某些工具会按文本处理坏掉字节）
  write('%\xE2\xE3\xCF\xD3\n')

  const xref = []
  for (let i = 0; i < objects.length; i++) {
    xref.push(offset)
    write(`${i + 1} 0 obj\n${objects[i]}\nendobj\n`)
  }

  const xrefOffset = offset
  const xrefLines = [`xref`, `0 ${objects.length + 1}`, '0000000000 65535 f ']
  for (const off of xref) xrefLines.push(`${String(off).padStart(10, '0')} 00000 n `)
  write(`${xrefLines.join('\n')}\n`)
  write(`trailer\n<< /Size ${objects.length + 1} /Root ${catalogNumber} 0 R /Info ${infoNumber} 0 R >>\n`)
  write(`startxref\n${xrefOffset}\n%%EOF\n`)

  return Buffer.concat(chunks)
}

// ── 结构化排版（阶段 6.3 第三条路径）────────────────────────────────────
// 上面的 buildTextPdf 只做「一行一行排下去」。表格要有表格线、标题要有层级，
// 就必须有真正的版面模型：块（标题/段落/列表项/表格）→ 行/网格 → 页面内容流。
//
// 几条刻意的取舍：
//   - 表格线画成**矩形描边**（`re S`）而不是四条线（`m l`）：线宽 0 就是「最细可见线」，
//     不同的 PDF 阅读器渲染 `re` 与 `m/l` 没有差别，但 `re` 少一半指令。
//   - 列宽按**内容宽度**分配并用 wrapLine 的实际折行结果度量，而不是把字符数除以列数。
//     否则中文表格每列都会挤成一列字。
//   - 字号层级是真实字号（HEADING_SIZE），标题加粗（换 Helvetica-Bold），
//     正文与列表项之间有行距差——这些是「有版式」与「只有文字」的分界线。
export const HEADING_SIZE = Object.freeze([18, 15, 13, 12, 11.5, 11])
export const BODY_SIZE = 10.5
const HEADING_LEADING = 1.35
const BODY_LEADING = 1.5
const SPACE_BEFORE_HEADING = 10
const SPACE_BEFORE_TABLE = 6
const SPACE_AFTER_TABLE = 10
const TABLE_FONT_SIZE = 9.5
const TABLE_LEADING = 1.3
const TABLE_CELL_PADDING = 4
const TABLE_MIN_COLUMN_WIDTH = 24
const RULE_WIDTH = 0.6

function wrapWithBreaks(text, maxUnits) {
  const out = []
  for (const physical of String(text ?? '').split('\n')) {
    const single = wrapLine(physical, maxUnits)
    for (const line of single) out.push(line)
  }
  return out.length > 0 ? out : ['']
}

/** 文本在给定字号下的宽度估计（与 wrapLine 的量纲一致）。 */
function measureUnits(text) {
  let units = 0
  for (const ch of String(text ?? '')) units += charWidth(ch)
  return units
}

function unitsToPoints(units, fontSize) {
  return units * fontSize * 0.5
}

/** 表头/正文都用同一套折行，区别只在字号。 */
function layoutCellText(text, columnWidth, fontSize, { bold = false } = {}) {
  const padding = TABLE_CELL_PADDING * 2
  const maxUnits = Math.max(1, (columnWidth - padding) / (fontSize * 0.5))
  return wrapWithBreaks(text, maxUnits)
}

/** 分配列宽：先按最长单元格的内容宽度给权重，再按页宽等比缩放。 */
function computeColumnWidths(rows, availableWidth, fontSize) {
  const columnCount = rows.reduce((max, row) => Math.max(max, row.length), 0)
  if (columnCount === 0) return []
  const weights = new Array(columnCount).fill(0)
  for (const row of rows) {
    for (let i = 0; i < columnCount; i++) {
      const text = row[i]?.text ?? ''
      // 表格里过长的单元格不该独占整页：按 40 个单位（≈20 个汉字）封顶
      const widest = Math.max(...wrapWithBreaks(text, 1e9).map(line => measureUnits(line)), 0)
      weights[i] = Math.max(weights[i], Math.min(widest, 40), 2)
    }
  }
  const total = weights.reduce((sum, w) => sum + w, 0) || 1
  const widths = weights.map(w => Math.max(TABLE_MIN_COLUMN_WIDTH, (w / total) * availableWidth))
  // 最小值可能把总宽撑过页宽，再等比收一次（宁可挤，也不要越界）
  const sum = widths.reduce((s, w) => s + w, 0)
  if (sum > availableWidth) {
    const factor = availableWidth / sum
    for (let i = 0; i < widths.length; i++) widths[i] *= factor
  }
  return widths
}

/**
 * 把块序列排成页面。纯函数（不碰 IO），因此可以被测试直接断言版面数字。
 * @returns {{pages: Array<Array<object>>, pageCount: number, stats: object}}
 */
export function layoutStructured({ blocks = [], page = PAGE, sourceLabel = '' } = {}) {
  const contentWidth = page.width - MARGIN * 2
  const bottom = MARGIN
  // 顶部先给来源说明留位置（它算一页内容的一部分，否则第一页会贴到标题上）
  const top = page.height - MARGIN
  let y = top
  let current = []
  const pages = []

  const newPage = () => {
    if (current.length > 0) pages.push(current)
    current = []
    y = top
  }
  const ensure = (height) => {
    if (y - height < bottom && current.length > 0) newPage()
  }
  const ops = (command) => { current.push(command) }

  if (sourceLabel) {
    const lines = wrapWithBreaks(sourceLabel, contentWidth / (9 * 0.5))
    for (const line of lines) {
      if (y - 9 * BODY_LEADING < bottom && current.length > 0) newPage()
      ops({ kind: 'text', x: MARGIN, y, size: 9, bold: false, text: line, color: 0.4 })
      y -= 9 * BODY_LEADING
    }
    y -= 6
  }

  const stats = { headings: 0, paragraphs: 0, listItems: 0, tables: 0, drawnRows: 0, drawnLines: 0, pageBreaks: 0 }

  const drawParagraphLike = (block) => {
    const isHeading = block.type === 'heading' && Number.isFinite(block.level) && block.level > 0
    const isList = block.type === 'listItem'
    const size = isHeading ? (HEADING_SIZE[Math.min(block.level, HEADING_SIZE.length) - 1] ?? BODY_SIZE) : BODY_SIZE
    const leading = size * (isHeading ? HEADING_LEADING : BODY_LEADING)
    const indent = isList ? 12 + Math.max(0, block.level || 0) * 12 : 0
    const marker = isList ? (block.marker ? `${block.marker} ` : '') : ''
    const available = contentWidth - indent
    const text = marker + String(block.text ?? '')
    const lines = wrapWithBreaks(text, available / (size * 0.5))
    if (isHeading) {
      // 标题与上文之间留白，避免标题骑在上一段最后一行上
      ensure(lines.length * leading + SPACE_BEFORE_HEADING)
      y -= SPACE_BEFORE_HEADING
    } else {
      ensure(lines.length * leading)
    }
    for (let i = 0; i < lines.length; i++) {
      ensure(leading)
      ops({ kind: 'text', x: MARGIN + indent, y, size, bold: isHeading === true, text: lines[i] })
      y -= leading
    }
    if (isHeading) stats.headings++
    else if (isList) stats.listItems++
    else stats.paragraphs++
  }

  const drawTable = (block) => {
    const rows = Array.isArray(block.rows) ? block.rows : []
    if (rows.length === 0) return
    const widths = computeColumnWidths(rows, contentWidth, TABLE_FONT_SIZE)
    if (widths.length === 0) return
    const columnCount = widths.length
    y -= SPACE_BEFORE_TABLE
    const headerRows = block.header === false ? 0 : 1
    stats.tables++

    for (let r = 0; r < rows.length; r++) {
      const row = rows[r]
      const isHeaderRow = r < headerRows || row.some(cell => cell?.header === true)
      const cells = []
      let rowHeight = 0
      for (let c = 0; c < columnCount; c++) {
        const cell = row[c] || { text: '' }
        const lines = layoutCellText(cell.text ?? '', widths[c], TABLE_FONT_SIZE)
        const height = lines.length * TABLE_FONT_SIZE * TABLE_LEADING + TABLE_CELL_PADDING * 2
        rowHeight = Math.max(rowHeight, height)
        cells.push({ lines, height })
      }
      // 跨页要整行搬到下一页（表格断行会把表格线和单元格放到两个页面上）
      if (y - rowHeight < bottom && current.length > 0) {
        newPage()
        // 新页上先补一行表头，让人知道这张表是什么（这是表格与制表符的关键差别之一）
        if (!isHeaderRow && headerRows > 0 && rows.length > 1) {
          const headerCells = []
          let headerHeight = 0
          for (let c = 0; c < columnCount; c++) {
            const cell = rows[0][c] || { text: '' }
            const lines = layoutCellText(cell.text ?? '', widths[c], TABLE_FONT_SIZE)
            const height = lines.length * TABLE_FONT_SIZE * TABLE_LEADING + TABLE_CELL_PADDING * 2
            headerHeight = Math.max(headerHeight, height)
            headerCells.push({ lines, height })
          }
          emitRow(headerCells, widths, headerHeight, stats)
          y -= headerHeight
        }
      }
      emitRow(cells, widths, rowHeight, stats)
      y -= rowHeight
      stats.drawnRows++
    }
    y -= SPACE_AFTER_TABLE
  }

  const emitRow = (cells, widths, rowHeight, statsRef) => {
    const top = y
    const bottomY = y - rowHeight
    // 先填单元格文字，再画线：线压在文字边缘上更像表格（而不是被文字盖住）
    let x = MARGIN
    for (let c = 0; c < cells.length; c++) {
      const cell = cells[c]
      for (let i = 0; i < cell.lines.length; i++) {
        const lineY = top - TABLE_CELL_PADDING - TABLE_FONT_SIZE * TABLE_LEADING * (i + 1) + TABLE_FONT_SIZE * 0.28
        if (cell.lines[i] !== '') {
          ops({
            kind: 'text',
            x: x + TABLE_CELL_PADDING,
            y: lineY,
            size: TABLE_FONT_SIZE,
            bold: false,
            text: cell.lines[i],
          })
        }
      }
      x += widths[c]
    }
    // 表格线：每个单元格一个矩形，相邻格共用边（重复描一遍没有视觉差别）
    x = MARGIN
    let columnLines = 0
    for (let c = 0; c < widths.length; c++) {
      ops({ kind: 'rect', x, y: bottomY, width: widths[c], height: rowHeight })
      columnLines++
      x += widths[c]
    }
    statsRef.drawnLines += columnLines + 1
  }

  const rowHasHeaderSource = (rows, headerRows) => headerRows > 0 && rows.length > 1

  for (const block of blocks) {
    if (!block) continue
    if (block.type === 'pageBreak') {
      newPage()
      stats.pageBreaks++
      continue
    }
    if (block.type === 'table') { drawTable(block); continue }
    if (block.type === 'heading' || block.type === 'paragraph' || block.type === 'listItem') {
      drawParagraphLike(block)
      continue
    }
    if (block.type === 'note') {
      drawParagraphLike({ type: 'paragraph', text: block.text })
    }
  }

  if (current.length > 0 || pages.length === 0) pages.push(current)
  return {
    pages,
    pageCount: pages.length,
    stats: {
      ...stats,
      // 「真的画了表格」的证据：表格线的条数必须是正数
      tableRules: stats.drawnLines,
      pageCount: pages.length,
    },
  }
}

/** 把排版结果序列化成 PDF 内容流（可读、可断言）。 */
export function renderContentStream(pageCommands = []) {
  const ops = ['BT']
  let currentSize = null
  let currentBold = null
  for (const command of pageCommands) {
    if (command.kind === 'text') {
      const size = command.size ?? BODY_SIZE
      const bold = command.bold === true
      if (currentSize !== size || currentBold !== bold) {
        ops.push(`/${bold ? 'F3' : 'F1'} ${size} Tf`)
        currentSize = size
        currentBold = bold
      }
      ops.push(`1 0 0 1 ${command.x.toFixed(2)} ${command.y.toFixed(2)} Tm`)
      for (const run of encodeTextRun(command.text)) ops.push(`${run.value} Tj`)
      continue
    }
    if (command.kind === 'rect') {
      ops.push('ET')
      // 表格线用**矩形描边**而不是四条 `m/l`：线宽是 RULE_WIDTH（明显可见），
      // 颜色写死浅灰（0.6 0.6 0.6）——纯黑线在中文表格里会显得抢戏。
      // 每条命令都自带线宽与颜色，不依赖前一个图形的状态。
      ops.push(`${RULE_WIDTH} w 0.6 0.6 0.6 RG ${command.x.toFixed(2)} ${command.y.toFixed(2)} ${command.width.toFixed(2)} ${command.height.toFixed(2)} re S`)
      ops.push('BT')
      continue
    }
  }
  ops.push('ET')
  return ops.join('\n')
}

/** 结构化 PDF 里用到的字体资源（多一个粗体：标题的层级不只靠字号）。 */
const FONT_OBJECTS = Object.freeze([
  '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica /Encoding /WinAnsiEncoding >>',
  [
    '<< /Type /Font /Subtype /Type0 /BaseFont /STSong-Light',
    '/Encoding /UniGB-UCS2-H',
    '/DescendantFonts [<< /Type /Font /Subtype /CIDFontType0 /BaseFont /STSong-Light',
    '/CIDSystemInfo << /Registry (Adobe) /Ordering (GB1) /Supplement 2 >> >>] >>',
  ].join(' '),
  '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica-Bold /Encoding /WinAnsiEncoding >>',
])

/**
 * 生成**结构化** PDF：标题有字号层级、表格有线框、中文走同一套非嵌入 CJK 字体。
 * @param {object} o
 * @param {string} o.title
 * @param {Array} o.blocks     —— office-structure.js 的块序列
 * @param {string} [o.sourceLabel]
 * @returns {Buffer}
 */
export function buildStructuredPdf({ title = '', blocks = [], sourceLabel = '', page = PAGE } = {}) {
  const laidOut = layoutStructured({ blocks, page, sourceLabel })
  const objects = []
  const push = (body) => {
    objects.push(body)
    return objects.length
  }

  const fontLatin = push(FONT_OBJECTS[0])
  const fontCjk = push(FONT_OBJECTS[1])
  const fontBold = push(FONT_OBJECTS[2])

  const contentNumbers = []
  for (const pageCommands of laidOut.pages) {
    const stream = renderContentStream(pageCommands)
    contentNumbers.push(push(`<< /Length ${Buffer.byteLength(stream, 'latin1')} >>\nstream\n${stream}\nendstream`))
  }

  const firstPageNumber = objects.length + 1
  const pagesNumber = firstPageNumber + laidOut.pages.length
  const pageNumbers = []
  for (let i = 0; i < laidOut.pages.length; i++) {
    push([
      '<< /Type /Page',
      `/Parent ${pagesNumber} 0 R`,
      `/MediaBox [0 0 ${page.width} ${page.height}]`,
      `/Resources << /Font << /F1 ${fontLatin} 0 R /F2 ${fontCjk} 0 R /F3 ${fontBold} 0 R >> >>`,
      `/Contents ${contentNumbers[i]} 0 R >>`,
    ].join(' '))
    pageNumbers.push(firstPageNumber + i)
  }

  push(`<< /Type /Pages /Count ${laidOut.pages.length} /Kids [${pageNumbers.map(n => `${n} 0 R`).join(' ')}] >>`)
  const catalogNumber = push(`<< /Type /Catalog /Pages ${pagesNumber} 0 R >>`)
  const infoNumber = push(`<< /Title (${escapeLiteral(title)}) /Producer (Alice structured PDF writer) >>`)

  const chunks = []
  let offset = 0
  const write = (text) => {
    const buf = Buffer.from(text, 'latin1')
    chunks.push(buf)
    offset += buf.length
  }
  write('%PDF-1.4\n')
  write('%\xE2\xE3\xCF\xD3\n')
  const xref = []
  for (let i = 0; i < objects.length; i++) {
    xref.push(offset)
    write(`${i + 1} 0 obj\n${objects[i]}\nendobj\n`)
  }
  const xrefOffset = offset
  const xrefLines = ['xref', `0 ${objects.length + 1}`, '0000000000 65535 f ']
  for (const off of xref) xrefLines.push(`${String(off).padStart(10, '0')} 00000 n `)
  write(`${xrefLines.join('\n')}\n`)
  write(`trailer\n<< /Size ${objects.length + 1} /Root ${catalogNumber} 0 R /Info ${infoNumber} 0 R >>\n`)
  write(`startxref\n${xrefOffset}\n%%EOF\n`)
  return Buffer.concat(chunks)
}

/**
 * 从生成的 PDF 里还原出可见文本（CJK 十六进制段 + 拉丁字面量段）。
 * 这不是通用 PDF 解析器，只认我们自己写出来的那两种 Tj —— 但它让「中文真的进去了」
 * 这件事可以被直接断言，而不是靠肉眼看字节。
 */
export function extractPdfText(buffer) {
  const text = Buffer.isBuffer(buffer) ? buffer.toString('latin1') : String(buffer)
  let restored = ''
  for (const m of text.matchAll(/<([0-9A-Fa-f]+)>|\(((?:[^()\\]|\\.)*)\)/g)) {
    if (m[1]) {
      const hex = m[1]
      for (let i = 0; i + 4 <= hex.length; i += 4) restored += String.fromCharCode(parseInt(hex.slice(i, i + 4), 16))
    } else if (m[2] !== undefined) {
      // 字面量里的转义：`\\ooo`（八进制，WinAnsi 高位标点走这条）与 `\\(` `\\)` `\\\\`
      restored += m[2].replace(/\\([0-7]{1,3})|\\([\\()])/g, (_, octal, simple) => {
        if (simple !== undefined) return simple
        const byte = parseInt(octal, 8)
        // 0x80–0x9F 这一段是标点的 WinAnsi 编码，不是控制码，要映射回 Unicode
        return String.fromCharCode(WIN_ANSI_HIGH_REVERSE[byte] ?? byte)
      })
    }
  }
  return restored
}

function estimateOffset(runs, index) {
  let units = 0
  for (let i = 0; i < index; i++) units += runUnits(runs[i])
  return units * FONT_SIZE * 0.5
}

function runUnits(run) {
  // 十六进制串：4 个十六进制字符 = 1 个字符
  if (run.font === 'cjk') return Math.max(0, (run.value.length - 2) / 4)
  // 字面量：去掉首尾括号后，一个转义序列（`\\x` 或 `\\ooo` 八进制）算一个字符。
  // 不能用「replace 成等长字符再数长度」——八进制转义有 4 个字节却只代表 1 个字。
  const body = run.value.slice(1, -1)
  let count = 0
  for (let i = 0; i < body.length; i++) {
    if (body[i] === '\\') {
      const octal = body.slice(i + 1).match(/^[0-7]{1,3}/)
      i += octal ? octal[0].length : 1
    }
    count++
  }
  return count
}

/**
 * 只解析 PDF 的骨架（对象数、xref 偏移、trailer、EOF），用于自检。
 * 不引第三方解析器：这里要验证的是「我们自己生成的字节是否结构合法」。
 */
export function inspectPdf(buffer) {
  const text = Buffer.isBuffer(buffer) ? buffer.toString('latin1') : String(buffer)
  const offsets = [...text.matchAll(/^(\d+) 0 obj$/gm)].map(m => Number(m[1]))
  const startxrefMatch = text.match(/startxref\s+(\d+)/)
  const startxref = startxrefMatch ? Number(startxrefMatch[1]) : null
  const xrefBlock = startxref !== null ? text.slice(startxref) : ''
  const xrefEntries = [...xrefBlock.matchAll(/^(\d{10}) (\d{5}) ([nf]) $/gm)]
    .map(m => ({ offset: Number(m[1]), type: m[3] }))
  return {
    headerOk: text.startsWith('%PDF-1.'),
    endsWithEof: text.trimEnd().endsWith('%%EOF'),
    objectCount: offsets.length,
    startxref,
    xrefEntryCount: xrefEntries.length,
    xrefEntries,
    trailerOk: /trailer\s*<</.test(text),
    hasRoot: /\/Root \d+ 0 R/.test(text),
    pageCount: (text.match(/\/Type \/Page[^s]/g) || []).length,
    byteLength: Buffer.isBuffer(buffer) ? buffer.length : Buffer.byteLength(text, 'latin1'),
  }
}
