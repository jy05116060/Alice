// 从 Office 文件里解析**结构**（阶段 6.3 的第三条路径，为 PDF 版式还原服务）。
//
// 与 office-text.js 的分工是刻意的：
//   office-text.js       —— 抽文本。段落边界是它唯一的「结构」，表格退化成制表符。
//   office-structure.js  —— 抽结构。段落带 heading 层级、表格带行列、列表带序号。
// 两者共用 ZIP+XML 的读取（listZipEntries / readZipEntry），不重复实现一遍解压。
//
// 为什么值得单开一份而不是改造 office-text：抽文本那条路径已经上线并被测试锁住了
// （测试里断言了制表符拼接），把它改成结构化会同时改掉「兜底」和「主路径」两件事。
// 第三条路径要能独立开关、独立失败、独立回落到文本兜底。
//
// 输出形状刻意保持「扁平的块序列」：
//   { type: 'heading'|'paragraph'|'listItem'|'table'|'pageBreak'|'note', ... }
// 因为它下游只有一个消费者——把块摆到 PDF 页面上。树形结构在这里没有收益，
// 反而让分页逻辑要处理嵌套。
import path from 'node:path'
import { listZipEntries, readZipEntry } from './office-text.js'

export class OfficeStructureError extends Error {
  constructor(code, message) {
    super(message)
    this.name = 'OfficeStructureError'
    this.code = code
  }
}

// ── 小工具 ────────────────────────────────────────────────────────────────
const XML_ENTITY = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'" }

export function decodeXmlEntities(text) {
  return String(text).replace(/&(#x?[0-9a-f]+|amp|lt|gt|quot|apos);/gi, (match, entity) => {
    const key = entity.toLowerCase()
    if (key.startsWith('#x')) return String.fromCodePoint(Number.parseInt(entity.slice(2), 16))
    if (key.startsWith('#')) return String.fromCodePoint(Number.parseInt(entity.slice(1), 10))
    return XML_ENTITY[key] ?? match
  })
}

/**
 * 把 XML 里某个标签下的**全部嵌套内容**取出来。
 * 用栈匹配同名标签：`<w:tbl>` 里嵌 `<w:tbl>`（嵌套表格真的存在）时，
 * 用惰性正则会在第一个 `</w:tbl>` 就收尾，于是外层表格后半截丢掉。
 */
export function sliceNested(xml, tag) {
  const openRe = new RegExp(`<${tag}(?=[\\s/>])`, 'g')
  const closeRe = new RegExp(`</${tag}>`, 'g')
  const out = []
  const source = String(xml)
  let m
  while ((m = openRe.exec(source)) !== null) {
    let depth = 1
    let cursor = openRe.lastIndex
    let end = -1
    while (depth > 0) {
      closeRe.lastIndex = cursor
      const next = closeRe.exec(source)
      if (!next) break
      openRe.lastIndex = cursor
      const inner = openRe.exec(source)
      openRe.lastIndex = next.index // 让外层循环能从闭标签之后继续
      if (openRe.lastIndex <= m.index) openRe.lastIndex = m.index + 1
      if (inner && inner.index < next.index) {
        depth++
        cursor = inner.index + inner[0].length
      } else {
        depth--
        cursor = next.index + next[0].length
        if (depth === 0) end = next.index
      }
    }
    if (end < 0) continue
    out.push(source.slice(m.index + m[0].length, end))
    openRe.lastIndex = end
  }
  return out
}

/** 取某个标签本身的属性串（不含标签名）。 */
export function tagAttrs(xml, index, tagLength) {
  const rest = String(xml).slice(index + tagLength)
  const close = rest.indexOf('>')
  return close < 0 ? '' : rest.slice(0, close)
}

/** 从属性串里取一个属性值（兼容单/双引号）。 */
export function attrValue(attrs, name) {
  const re = new RegExp(`\\b${name}\\s*=\\s*"([^"]*)"|\\b${name}\\s*=\\s*'([^']*)'`)
  const m = String(attrs).match(re)
  if (!m) return null
  return decodeXmlEntities(m[1] ?? m[2] ?? '')
}

/**
 * 把一个 `<w:p>` / `<text:p>` 里的行内内容拼成一行文本。
 * 与 office-text.js 的差别：这里额外把 `<w:br/>` 变成真正的换行、`<w:tab/>` 变成制表符
 * —— 在 PDF 里这两个都是有意义的版面信号，而纯文本抽取把它们丢掉了。
 */
export function paragraphText(xml, { textTags = [], breakTags = [], tabTags = [] } = {}) {
  let source = String(xml)
  for (const tag of breakTags) source = source.replace(new RegExp(`<${tag}\\s*/?>`, 'g'), '\n')
  for (const tag of tabTags) source = source.replace(new RegExp(`<${tag}\\s*/?>`, 'g'), '\t')
  const wanted = new Set(textTags.map(t => t.toLowerCase()))
  const parts = []
  const openRe = /<([a-zA-Z0-9:_-]+)(?:\s[^>]*?)?(\/?)>/g
  let match
  while ((match = openRe.exec(source)) !== null) {
    if (!wanted.has(match[1].toLowerCase())) continue
    if (match[2] === '/') continue
    const end = source.indexOf(`</${match[1]}>`, openRe.lastIndex)
    if (end < 0) continue
    parts.push(decodeXmlEntities(source.slice(openRe.lastIndex, end).replace(/<[^>]*>/g, '')))
  }
  return parts.join('').replace(/\u0000/g, '')
}

/** 段落样式 → 标题层级。返回 null 表示正文。 */
export function headingLevelFromStyle(styleId) {
  const style = String(styleId || '').toLowerCase()
  if (!style) return null
  // `Heading1` / `heading 2` / `标题 3` / `berschrift1` 都能落到同一条规则上
  const numbered = style.match(/(?:heading|标题|berschrift|titre|titulo|título)\s*([1-6])/)
  if (numbered) return Number(numbered[1])
  if (/^(?:title|标题正文|documenttitle)$/.test(style)) return 1
  if (/^subtitle$/.test(style)) return 2
  return null
}

const NUMBERING_FORMAT = Object.freeze({
  decimal: (n) => `${n}.`,
  'decimalZero': (n) => String(n).padStart(2, '0'),
  lowerLetter: (n) => `${String.fromCharCode(96 + Math.min(n, 26))}.`,
  upperLetter: (n) => `${String.fromCharCode(64 + Math.min(n, 26))}.`,
  lowerRoman: (n) => `${toRoman(n).toLowerCase()}.`,
  upperRoman: (n) => `${toRoman(n)}.`,
  bullet: () => '\u2022',
  none: () => '',
})

function toRoman(n) {
  const table = [[1000, 'M'], [900, 'CM'], [500, 'D'], [400, 'CD'], [100, 'C'], [90, 'XC'], [50, 'L'], [40, 'XL'], [10, 'X'], [9, 'IX'], [5, 'V'], [4, 'IV'], [1, 'I']]
  let rest = Math.max(1, Math.floor(n))
  let out = ''
  for (const [value, glyph] of table) {
    while (rest >= value) { out += glyph; rest -= value }
  }
  return out
}

/** 解析 `word/numbering.xml`：numId → 各级别的标记格式。 */
export function parseNumberingXml(xml) {
  const source = String(xml || '')
  const abstractFormats = new Map()
  for (const abstractXml of sliceNested(source, 'w:abstractNum')) {
    const idMatch = abstractXml.match(/\bw:abstractNumId="([^"]*)"/)
    if (!idMatch) continue
    const levels = []
    for (const levelXml of sliceNested(abstractXml, 'w:lvl')) {
      const lvlMatch = levelXml.match(/\bw:ilvl="([^"]*)"/)
      const ilvl = lvlMatch ? Number(lvlMatch[1]) : levels.length
      const fmtMatch = levelXml.match(/<w:numFmt\s+w:val="([^"]*)"/)
      levels[ilvl] = fmtMatch ? fmtMatch[1] : 'decimal'
    }
    abstractFormats.set(idMatch[1], levels)
  }
  const numbering = new Map()
  for (const numXml of sliceNested(source, 'w:num')) {
    // `<w:num w:numId="3"><w:abstractNumId w:val="1"/></w:num>`
    const idMatch = numXml.match(/\bw:numId="([^"]*)"/)
    const abstractMatch = numXml.match(/<w:abstractNumId\s+w:val="([^"]*)"/)
    if (!idMatch || !abstractMatch) continue
    numbering.set(idMatch[1], abstractFormats.get(abstractMatch[1]) || [])
  }
  return numbering
}

/** 把一个列表项渲染成「标记 + 文字」。标记本身是版面信息，不能只留文字。 */
export function formatListMarker(levels, ilvl, counters) {
  const format = (levels && levels[ilvl]) || 'bullet'
  const make = NUMBERING_FORMAT[format] || NUMBERING_FORMAT.bullet
  return make(counters[ilvl] || 1)
}

// ── docx ──────────────────────────────────────────────────────────────────
const HEADING_SIZE_ORDERED = [1, 2, 3, 4, 5, 6]

/**
 * 解析 `word/document.xml`。
 * 表格用递归：单元格里可以有段落、也可以是嵌套表格。
 */
export function parseDocxXml(xml, { numbering = new Map() } = {}) {
  const blocks = []
  const bodyMatch = String(xml).match(/<w:body(?=[\s>])/)
  const body = bodyMatch ? sliceNested(String(xml).replace(/^[\s\S]*?<w:body(?=[\s>])/, '<w:body'), 'w:body')[0] ?? '' : String(xml)

  const counters = new Map() // numId → [每级计数]

  const parseParagraph = (pXml) => {
    const text = paragraphText(pXml, { textTags: ['w:t'], breakTags: ['w:br', 'w:cr'], tabTags: ['w:tab'] })
    const pPrMatch = pXml.match(/<w:pPr(?=[\s>])/)
    const pPr = pPrMatch ? (sliceNested(pXml, 'w:pPr')[0] ?? '') : ''
    const styleId = (pPr.match(/<w:pStyle\s+w:val="([^"]*)"/) || [])[1] || ''
    const numId = (pPr.match(/<w:numId\s+w:val="([^"]*)"/) || [])[1] || null
    const ilvl = Number((pPr.match(/<w:ilvl\s+w:val="([^"]*)"/) || [])[1] || 0)
    const level = headingLevelFromStyle(styleId)
    // 标题里的换行不还原（标题是一行的东西），正文保留
    const flat = level !== null ? text.replace(/\s*\n\s*/g, ' ') : text

    if (numId && numId !== '0') {
      const levels = numbering.get(numId) || []
      const own = counters.get(numId) || [0, 0, 0, 0, 0, 0, 0, 0, 0]
      own[ilvl] = (own[ilvl] || 0) + 1
      for (let i = ilvl + 1; i < own.length; i++) own[i] = 0
      counters.set(numId, own)
      const marker = formatListMarker(levels, ilvl, own)
      return { type: 'listItem', level: ilvl, marker, text: flat }
    }
    if (level !== null && flat.trim()) return { type: 'heading', level, text: flat.trim() }
    return { type: 'paragraph', text: flat }
  }

  const parseTable = (tblXml) => {
    const rows = []
    for (const rowXml of sliceNested(tblXml, 'w:tr')) {
      const cells = []
      for (const cellXml of sliceNested(rowXml, 'w:tc')) {
        const tcPr = sliceNested(cellXml, 'w:tcPr')[0] ?? ''
        const spanMatch = tcPr.match(/<w:gridSpan\s+w:val="([^"]*)"/)
        const vMergeMatch = tcPr.match(/<w:vMerge(?:\s+w:val="([^"]*)")?\s*\/?>/)
        const nested = []
        for (const pXml of sliceNested(cellXml, 'w:p')) {
          const paragraph = parseParagraph(pXml)
          if (paragraph.type === 'paragraph' && paragraph.text.trim() === '') continue
          if (paragraph.type === 'paragraph') nested.push(paragraph.text)
          else if (paragraph.type === 'heading') nested.push(paragraph.text)
          else if (paragraph.text.trim()) nested.push(paragraph.marker ? `${paragraph.marker} ${paragraph.text}` : paragraph.text)
        }
        cells.push({
          text: nested.join('\n'),
          colSpan: spanMatch ? Math.max(1, Number(spanMatch[1]) || 1) : 1,
          // `vMerge` 无 val 或 val="continue" 都是「被上面那格吃掉」
          merged: Boolean(vMergeMatch) && (vMergeMatch[1] === undefined || vMergeMatch[1] === 'continue'),
          header: /<w:tblHeader\b/.test(rowXml),
        })
      }
      if (cells.length > 0) rows.push(cells)
    }
    return rows
  }

  // 顶层按出现顺序扫段落与表格（`<w:tbl>` 里也有 `<w:p>`，所以必须跳过去）
  const source = String(body)
  const topRe = /<w:(p|tbl)(?=[\s>])/g
  let match
  const skipUntil = { p: -1, tbl: -1 }
  while ((match = topRe.exec(source)) !== null) {
    const tag = match[1]
    if (match.index < skipUntil[tag]) continue
    if (tag === 'p') {
      const pXml = sliceNested(source.slice(match.index), 'w:p')[0]
      if (pXml === undefined) break
      const block = parseParagraph(pXml)
      // 空段落是版面间距，保留（正文里连着几个空段落 = 段落间距）
      if (block.type !== 'paragraph' || block.text.trim() !== '' || blocks.length > 0) blocks.push(block)
      topRe.lastIndex = match.index + match[0].length + pXml.length
    } else {
      const tblXml = sliceNested(source.slice(match.index), 'w:tbl')[0]
      if (tblXml === undefined) break
      const rows = parseTable(tblXml)
      if (rows.length > 0) blocks.push({ type: 'table', rows })
      topRe.lastIndex = match.index + match[0].length + tblXml.length
    }
  }

  // 收尾：去掉尾部空段落（文档结构常带一个）
  while (blocks.length > 0 && blocks[blocks.length - 1].type === 'paragraph' && blocks[blocks.length - 1].text.trim() === '') blocks.pop()
  return blocks
}

// ── xlsx ──────────────────────────────────────────────────────────────────
function columnIndex(ref) {
  const letters = String(ref || '').match(/^([A-Z]+)/i)
  if (!letters) return -1
  let n = 0
  for (const ch of letters[1].toUpperCase()) n = n * 26 + (ch.charCodeAt(0) - 64)
  return n - 1
}

/** 把 `<v>` 里的原始值按单元格类型渲染成显示文本（数字格式不做完整实现，够用为止）。 */
export function renderCellValue(raw, type, style) {
  const value = decodeXmlEntities(String(raw ?? ''))
  if (value === '') return ''
  const numericStyle = Number(style)
  if ((type === 'n' || type === undefined || type === '') && /^-?\d+(\.\d+)?$/.test(value)) {
    // 百分比/两位小数这类格式只做最常见的两种，其它按原样——猜错格式比不猜更糟
    if (numericStyle === 10 || numericStyle === 9) return `${(Number(value) * 100).toFixed(0)}%`
    if (numericStyle === 2 || numericStyle === 4) return value.includes('.') ? value : `${value}.00`
    return value
  }
  if (type === 'b') return value === '1' ? 'TRUE' : 'FALSE'
  if (type === 'e') return value
  return value
}

/** 解析一张工作表：共享字符串 + 单元格引用 → 补齐空列的二维数组。 */
export function parseSheetXml(xml, { sharedStrings = [] } = {}) {
  const rows = []
  let maxColumns = 0
  const rowRe = /<row(?=[\s>])([^>]*)>([\s\S]*?)<\/row>/g
  let match
  while ((match = rowRe.exec(String(xml))) !== null) {
    const cells = []
    const cellRe = /<c(?=[\s>])([^>]*?)(?:\/>|>([\s\S]*?)<\/c>)/g
    let cellMatch
    while ((cellMatch = cellRe.exec(match[2])) !== null) {
      const attrs = cellMatch[1] || ''
      const inner = cellMatch[2] || ''
      const ref = attrValue(attrs, 'r') || ''
      const type = attrValue(attrs, 't')
      const style = attrValue(attrs, 's')
      let text = ''
      if (type === 's') {
        const vMatch = inner.match(/<v>([\s\S]*?)<\/v>/)
        text = vMatch ? (sharedStrings[Number(decodeXmlEntities(vMatch[1]))] ?? '') : ''
      } else if (type === 'inlineStr') {
        text = paragraphText(inner, { textTags: ['t'] })
      } else {
        const vMatch = inner.match(/<v>([\s\S]*?)<\/v>/)
        text = vMatch ? renderCellValue(vMatch[1], type, style) : paragraphText(inner, { textTags: ['t'] })
      }
      const index = columnIndex(ref)
      if (index >= 0) {
        while (cells.length < index) cells.push('')
        cells[index] = text
      } else {
        cells.push(text)
      }
    }
    for (let i = 0; i < cells.length; i++) if (cells[i] === undefined) cells[i] = ''
    maxColumns = Math.max(maxColumns, cells.length)
    rows.push({ cells, rowIndex: Number(attrValue(match[1] || '', 'r')) || rows.length + 1 })
  }
  // 列对齐：短行补空串，否则表格线会长短不齐
  for (const row of rows) while (row.cells.length < maxColumns) row.cells.push('')
  return { rows, columnCount: maxColumns }
}

// ── pptx ──────────────────────────────────────────────────────────────────
export function parseSlideXml(xml, { title = '' } = {}) {
  const blocks = []
  if (title) blocks.push({ type: 'heading', level: 1, text: title })
  const source = String(xml)
  const openRe = /<p:sp(?=[\s>])/g
  let match
  const seen = new Set()
  while ((match = openRe.exec(source)) !== null) {
    if (seen.has(match.index)) continue
    const spXml = sliceNested(source.slice(match.index), 'p:sp')[0]
    if (spXml === undefined) continue
    seen.add(match.index)
    const isTitle = /<p:ph\s+type="(?:title|ctrTitle)"/.test(spXml)
    const isSubtitle = /<p:ph\s+type="subTitle"/.test(spXml)
    const paragraphs = []
    for (const pXml of sliceNested(spXml, 'a:p')) {
      const text = paragraphText(pXml, { textTags: ['a:t'], breakTags: ['a:br'] })
      if (text.trim()) paragraphs.push(text)
    }
    if (paragraphs.length === 0) continue
    for (let i = 0; i < paragraphs.length; i++) {
      if (i === 0 && isTitle && !title) blocks.push({ type: 'heading', level: 1, text: paragraphs[i] })
      else if (isSubtitle) blocks.push({ type: 'heading', level: 2, text: paragraphs[i] })
      else blocks.push({ type: 'listItem', level: isTitle ? 0 : 0, marker: '', text: paragraphs[i] })
    }
    openRe.lastIndex = match.index + match[0].length + spXml.length
  }
  return blocks
}

// ── 入口 ──────────────────────────────────────────────────────────────────
/** 结构化解析能处理的格式。老的二进制格式明确不在其中（猜着解析只会产出乱码）。 */
export const STRUCTURED_EXTENSIONS = Object.freeze(['.docx', '.xlsx', '.pptx', '.odt', '.ods', '.odp'])

export function canParseStructure(filePath) {
  return STRUCTURED_EXTENSIONS.includes(path.extname(String(filePath || '')).toLowerCase())
}

/** 读 ZIP 里的一个条目；缺失时返回 null 而不是抛（可选部件很多）。 */
function readOptional(buffer, entries, name) {
  const entry = entries.find(e => e.name === name)
  if (!entry) return null
  try {
    return readZipEntry(buffer, entry).toString('utf8')
  } catch {
    return null
  }
}

function parseDocx(buffer) {
  const entries = listZipEntries(buffer)
  const main = entries.find(e => e.name === 'word/document.xml')
  if (!main) throw new OfficeStructureError('MISSING_DOCUMENT', 'docx has no word/document.xml')
  const xml = readZipEntry(buffer, main).toString('utf8')
  const numberingXml = readOptional(buffer, entries, 'word/numbering.xml')
  const numbering = numberingXml ? parseNumberingXml(numberingXml) : new Map()
  const blocks = parseDocxXml(xml, { numbering })
  return { blocks, format: 'docx', pageSize: 'a4', orientation: 'portrait' }
}

function parseXlsx(buffer) {
  const entries = listZipEntries(buffer)
  const sharedXml = readOptional(buffer, entries, 'xl/sharedStrings.xml')
  const sharedStrings = sharedXml ? [...sharedXml.matchAll(/<si(?=[\s>])[\s\S]*?<\/si>/g)].map(m => paragraphText(m[0], { textTags: ['t'] })) : []
  const sheets = entries
    .filter(e => /^xl\/worksheets\/sheet\d+\.xml$/.test(e.name))
    .sort((a, b) => a.name.localeCompare(b.name))
  if (sheets.length === 0) throw new OfficeStructureError('MISSING_DOCUMENT', 'xlsx has no worksheets')

  // 工作表名（可选：没有 workbook.xml 就用文件名）
  const workbookXml = readOptional(buffer, entries, 'xl/workbook.xml')
  const names = workbookXml
    ? [...workbookXml.matchAll(/<sheet(?=[\s>])[^>]*\/?>/g)].map(m => attrValue(m[0], 'name') || '')
    : []

  const blocks = []
  for (let i = 0; i < sheets.length; i++) {
    const { rows, columnCount } = parseSheetXml(readZipEntry(buffer, sheets[i]).toString('utf8'), { sharedStrings })
    if (i > 0) blocks.push({ type: 'pageBreak' })
    blocks.push({ type: 'heading', level: 1, text: names[i] || path.basename(sheets[i].name, '.xml') })
    if (rows.length === 0 || columnCount === 0) {
      blocks.push({ type: 'paragraph', text: '(empty sheet)' })
      continue
    }
    blocks.push({
      type: 'table',
      header: true,
      rows: rows.map(row => row.cells.map(text => ({ text: String(text), header: row.rowIndex === rows[0].rowIndex }))),
    })
  }
  return { blocks, format: 'xlsx', pageSize: 'a4', orientation: 'landscape' }
}

function parsePptx(buffer) {
  const entries = listZipEntries(buffer)
  const slides = entries
    .filter(e => /^ppt\/slides\/slide\d+\.xml$/.test(e.name))
    .sort((a, b) => Number((a.name.match(/slide(\d+)/) || [])[1] || 0) - Number((b.name.match(/slide(\d+)/) || [])[1] || 0))
  if (slides.length === 0) throw new OfficeStructureError('MISSING_DOCUMENT', 'pptx has no slides')
  const blocks = []
  for (let i = 0; i < slides.length; i++) {
    const index = (slides[i].name.match(/slide(\d+)/) || [])[1] || String(i + 1)
    if (i > 0) blocks.push({ type: 'pageBreak' })
    blocks.push({ type: 'heading', level: 2, text: `slide ${index}` })
    blocks.push(...parseSlideXml(readZipEntry(buffer, slides[i]).toString('utf8')))
  }
  return { blocks, format: 'pptx', pageSize: 'a4', orientation: 'landscape' }
}

function parseOdfDocument(buffer, mainName, format) {
  const entries = listZipEntries(buffer)
  const main = entries.find(e => e.name === mainName)
  if (!main) throw new OfficeStructureError('MISSING_DOCUMENT', `${format} has no ${mainName}`)
  const xml = readZipEntry(buffer, main).toString('utf8')
  const blocks = []
  const topRe = /<(text:h|text:p|table:table)(?=[\s>])/g
  let match
  const source = xml
  while ((match = topRe.exec(source)) !== null) {
    const tag = match[1]
    const inner = sliceNested(source.slice(match.index), tag)[0]
    if (inner === undefined) break
    if (tag === 'table:table') {
      const rows = []
      for (const rowXml of sliceNested(inner, 'table:table-row')) {
        const cells = []
        for (const cellXml of sliceNested(rowXml, 'table:table-cell')) {
          const repeats = Number(attrValue(sliceNested(cellXml, 'table:table-cell')[0] ?? '', 'table:number-columns-repeated') || 0)
          const texts = []
          for (const pXml of sliceNested(cellXml, 'text:p')) {
            const text = paragraphText(pXml, { textTags: ['text:p', 'text:span'], breakTags: ['text:line-break'], tabTags: ['text:tab'] })
            if (text.trim()) texts.push(text)
          }
          const count = Math.max(1, Math.min(repeats || 1, 100))
          for (let i = 0; i < count; i++) cells.push({ text: texts.join('\n') })
        }
        if (cells.length > 0) rows.push(cells)
      }
      if (rows.length > 0) blocks.push({ type: 'table', rows })
      topRe.lastIndex = match.index + match[0].length + inner.length
      continue
    }
    const attrs = source.slice(match.index, source.indexOf('>', match.index) + 1)
    const text = paragraphText(inner, { textTags: ['text:p', 'text:h', 'text:span'], breakTags: ['text:line-break'], tabTags: ['text:tab'] })
    if (tag === 'text:h') {
      const outline = Number(attrValue(attrs, 'text:outline-level') || 1)
      if (text.trim()) blocks.push({ type: 'heading', level: Math.min(6, Math.max(1, outline)), text: text.trim() })
    } else {
      blocks.push({ type: 'paragraph', text })
    }
    topRe.lastIndex = match.index + match[0].length + inner.length
  }
  while (blocks.length > 0 && blocks[blocks.length - 1].type === 'paragraph' && blocks[blocks.length - 1].text.trim() === '') blocks.pop()
  return { blocks, format, pageSize: 'a4', orientation: 'portrait' }
}

/**
 * 解析一个 Office 文件的结构。
 * @returns {Promise<{blocks: Array, format: string, pageSize: string, orientation: string, stats: object}>}
 */
export async function parseOfficeStructure(filePath) {
  const fs = await import('node:fs/promises')
  const abs = path.resolve(String(filePath || ''))
  const ext = path.extname(abs).toLowerCase()
  if (!canParseStructure(abs)) {
    throw new OfficeStructureError('UNSUPPORTED_FORMAT', `no structural parser for ${ext || 'a file with no extension'}`)
  }
  let buffer
  try {
    buffer = await fs.readFile(abs)
  } catch (error) {
    throw new OfficeStructureError('READ_FAILED', `could not read ${abs}: ${error.message}`)
  }

  let result
  if (ext === '.docx') result = parseDocx(buffer)
  else if (ext === '.xlsx') result = parseXlsx(buffer)
  else if (ext === '.pptx') result = parsePptx(buffer)
  else if (ext === '.odt') result = parseOdfDocument(buffer, 'content.xml', 'odt')
  else if (ext === '.ods' || ext === '.odp') result = parseOdfDocument(buffer, 'content.xml', ext.slice(1))

  if (!result.blocks || result.blocks.length === 0) {
    throw new OfficeStructureError('NO_BLOCKS', `${path.basename(abs)} yielded no structural content (no paragraphs, headings or tables)`)
  }
  return { ...result, stats: structureStats(result.blocks) }
}

/** 结构化产出的「有多少东西」摘要——调用方与测试都靠它判断这条路真的生效了。 */
export function structureStats(blocks = []) {
  let headings = 0
  let paragraphs = 0
  let listItems = 0
  let tables = 0
  let tableRows = 0
  let tableCells = 0
  const headingLevels = []
  for (const block of blocks) {
    if (!block) continue
    if (block.type === 'heading') { headings++; if (!headingLevels.includes(block.level)) headingLevels.push(block.level) }
    else if (block.type === 'paragraph') paragraphs++
    else if (block.type === 'listItem') listItems++
    else if (block.type === 'table') {
      tables++
      tableRows += block.rows.length
      for (const row of block.rows) tableCells += row.length
    }
  }
  return { blocks: blocks.length, headings, headingLevels, paragraphs, listItems, tables, tableRows, tableCells }
}
