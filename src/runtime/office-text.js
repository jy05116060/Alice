// 从 Office 文件里抽纯文本（阶段 6.3 的无依赖兜底）。
//
// docx / xlsx / pptx / odt 本质都是 ZIP + XML，所以「抽文本」不需要完整的格式实现：
//   1. 解析 ZIP 中央目录，取出需要的条目（Node 自带 zlib，不用第三方库）
//   2. 从 XML 里取文本节点
// 这当然不是版式还原——它只交付**可读的文本**。对「没有 LibreOffice 的机器上，
// 至少能拿到一份能看的 PDF」这个目标来说，这是正确的一步。
//
// 刻意不做的事：解析样式、表格布局、图片、页眉页脚。做不好不如不做，
// 而我们输出的是一份「文本导出」，用户看一眼就知道它是什么。
import zlib from 'node:zlib'
import fs from 'node:fs/promises'
import path from 'node:path'

export class OfficeTextError extends Error {
  constructor(code, message) {
    super(message)
    this.name = 'OfficeTextError'
    this.code = code
  }
}

const MAX_ENTRY_BYTES = 32 * 1024 * 1024
const XML_ENTITY = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'" }

function decodeXmlEntities(text) {
  return String(text).replace(/&(#x?[0-9a-f]+|amp|lt|gt|quot|apos);/gi, (match, entity) => {
    const key = entity.toLowerCase()
    if (key.startsWith('#x')) return String.fromCodePoint(Number.parseInt(entity.slice(2), 16))
    if (key.startsWith('#')) return String.fromCodePoint(Number.parseInt(entity.slice(1), 10))
    return XML_ENTITY[key] ?? match
  })
}

// ── ZIP ───────────────────────────────────────────────────────────────────
/**
 * 列出 ZIP 里的条目（只读中央目录，不解压）。返回 [{ name, method, compressedSize, size, localHeaderOffset }]
 * 从中央目录读而不是扫本地头：本地头的长度字段在流式写入时可能为 0，中央目录才可靠。
 */
export function listZipEntries(buffer) {
  if (!Buffer.isBuffer(buffer) || buffer.length < 22) {
    throw new OfficeTextError('NOT_A_ZIP', 'file is too small to be a zip archive')
  }
  // 从尾部往前找 EOCD 签名（可能带注释，所以不能只看最后 22 字节）
  let eocd = -1
  const scanFrom = Math.max(0, buffer.length - 66_000)
  for (let i = buffer.length - 22; i >= scanFrom; i--) {
    if (buffer.readUInt32LE(i) === 0x06054b50) { eocd = i; break }
  }
  if (eocd < 0) throw new OfficeTextError('NOT_A_ZIP', 'no zip end-of-central-directory record found')

  const entryCount = buffer.readUInt16LE(eocd + 10)
  let offset = buffer.readUInt32LE(eocd + 16)
  const entries = []
  for (let i = 0; i < entryCount; i++) {
    if (offset + 46 > buffer.length) break
    if (buffer.readUInt32LE(offset) !== 0x02014b50) break
    const method = buffer.readUInt16LE(offset + 10)
    const compressedSize = buffer.readUInt32LE(offset + 20)
    const size = buffer.readUInt32LE(offset + 24)
    const nameLength = buffer.readUInt16LE(offset + 28)
    const extraLength = buffer.readUInt16LE(offset + 30)
    const commentLength = buffer.readUInt16LE(offset + 32)
    const localHeaderOffset = buffer.readUInt32LE(offset + 42)
    const name = buffer.slice(offset + 46, offset + 46 + nameLength).toString('utf8')
    entries.push({ name, method, compressedSize, size, localHeaderOffset })
    offset += 46 + nameLength + extraLength + commentLength
  }
  return entries
}

/** 解出某个条目的内容（支持 stored 与 deflate；其它压缩方式明确报错）。 */
export function readZipEntry(buffer, entry) {
  if (!entry) throw new OfficeTextError('ENTRY_NOT_FOUND', 'zip entry not found')
  if (entry.size > MAX_ENTRY_BYTES) {
    throw new OfficeTextError('ENTRY_TOO_LARGE', `zip entry ${entry.name} is too large to read (${entry.size} bytes)`)
  }
  const base = entry.localHeaderOffset
  if (buffer.readUInt32LE(base) !== 0x04034b50) {
    throw new OfficeTextError('BAD_LOCAL_HEADER', `invalid local file header for ${entry.name}`)
  }
  const nameLength = buffer.readUInt16LE(base + 26)
  const extraLength = buffer.readUInt16LE(base + 28)
  const dataStart = base + 30 + nameLength + extraLength
  const data = buffer.slice(dataStart, dataStart + entry.compressedSize)
  if (entry.method === 0) return data
  if (entry.method === 8) {
    try {
      return zlib.inflateRawSync(data)
    } catch (error) {
      throw new OfficeTextError('INFLATE_FAILED', `could not decompress ${entry.name}: ${error.message}`)
    }
  }
  throw new OfficeTextError('UNSUPPORTED_COMPRESSION', `${entry.name} uses unsupported compression method ${entry.method}`)
}

// ── XML 文本提取 ──────────────────────────────────────────────────────────
/**
 * 取出指定标签的文本内容。
 *
 * 实现要点（第一版在这里犯过错，值得写下来）：**绝不能**用「匹配 `<tag>...</tag>`
 * 再判断标签名」的写法。那样外层标签（比如 `<w:document>`）会用惰性匹配把**里面
 * 全部内容**吞掉，于是内层的 `<w:t>` 根本扫不到，结果是「抽出来是空的」。
 * 正确做法是只扫**开标签**，命中想要的标签后再去后面找对应的闭标签。
 */
export function extractTagText(xml, tags) {
  const wanted = new Set(tags.map(t => t.toLowerCase()))
  const source = String(xml)
  const parts = []
  const openRe = /<([a-zA-Z0-9:_-]+)(?:\s[^>]*?)?(\/?)>/g
  let match
  while ((match = openRe.exec(source)) !== null) {
    const name = match[1]
    if (!wanted.has(name.toLowerCase())) continue
    if (match[2] === '/') continue // 自闭合，没有内容
    const end = source.indexOf(`</${name}>`, openRe.lastIndex)
    if (end < 0) continue
    const inner = source.slice(openRe.lastIndex, end)
    const text = decodeXmlEntities(inner.replace(/<[^>]*>/g, ''))
    if (text) parts.push(text)
    // 刻意不把 lastIndex 推到闭标签之后：里面可能还有别的文本标签
  }
  return parts
}

/**
 * 按段落切分再抽文本——这才是 Office 文档的正确读法。
 * 段落边界是**结构信息**（决定 PDF 里的换行），不能靠「插一个换行符到标签外面」
 * 再指望它被文本标签捕获到（第一版就是这么错的：换行被插在 `<w:p>` 之前，
 * 而捕获范围从 `<w:t>` 之后开始，于是段落全挤成一行）。
 * @param {string} xml
 * @param {{paragraphTags: string[], textTags: string[]}} spec
 * @returns {string[]} 每个段落一行
 */
export function extractParagraphLines(xml, { paragraphTags = [], textTags = [] } = {}) {
  const source = String(xml)
  if (paragraphTags.length === 0) return extractTagText(source, textTags)

  // 在段落开标签前插一个不会出现在 XML 里的分隔符，然后按它切
  const SEP = '\u0000'
  let marked = source
  for (const tag of paragraphTags) {
    marked = marked.split(`<${tag}`).join(`${SEP}<${tag}`)
  }
  const lines = []
  for (const chunk of marked.split(SEP)) {
    if (!chunk.trim()) continue
    const parts = extractTagText(chunk, textTags)
    // 段落里可能夹着 w:br / w:tab
    const text = parts.join('').replace(/\u0000/g, '')
    if (text.trim() || lines.length > 0) lines.push(text)
  }
  // 收尾：去掉尾部空行（文档结构常带一个空段落）
  while (lines.length > 0 && lines[lines.length - 1].trim() === '') lines.pop()
  return lines
}

// ── 各格式 ────────────────────────────────────────────────────────────────
async function extractDocx(buffer) {
  const entries = listZipEntries(buffer)
  const main = entries.find(e => e.name === 'word/document.xml')
  if (!main) throw new OfficeTextError('MISSING_DOCUMENT', 'docx has no word/document.xml')
  const xml = readZipEntry(buffer, main).toString('utf8')
  return extractParagraphLines(xml, { paragraphTags: ['w:p'], textTags: ['w:t'] })
}

async function extractOdt(buffer) {
  const entries = listZipEntries(buffer)
  const main = entries.find(e => e.name === 'content.xml')
  if (!main) throw new OfficeTextError('MISSING_DOCUMENT', 'odt has no content.xml')
  const xml = readZipEntry(buffer, main).toString('utf8')
  return extractParagraphLines(xml, { paragraphTags: ['text:p', 'text:h'], textTags: ['text:p', 'text:h', 'text:span'] })
}

async function extractXlsx(buffer) {
  const entries = listZipEntries(buffer)
  const shared = entries.find(e => e.name === 'xl/sharedStrings.xml')
  const sharedStrings = shared
    ? extractTagText(readZipEntry(buffer, shared).toString('utf8'), ['t'])
    : []
  const sheets = entries
    .filter(e => /^xl\/worksheets\/sheet\d+\.xml$/.test(e.name))
    .sort((a, b) => a.name.localeCompare(b.name))
  if (sheets.length === 0) throw new OfficeTextError('MISSING_DOCUMENT', 'xlsx has no worksheets')

  const lines = []
  for (const sheet of sheets) {
    lines.push(`# ${path.basename(sheet.name)}`)
    const xml = readZipEntry(buffer, sheet).toString('utf8')
    for (const rowXml of xml.split(/<row[\s>]/).slice(1)) {
      const cells = []
      for (const cellXml of rowXml.split(/<c[\s>]/).slice(1)) {
        const isShared = /t="s"/.test(cellXml.slice(0, cellXml.indexOf('>') + 1))
        const valueMatch = cellXml.match(/<v>([\s\S]*?)<\/v>/)
        const inlineMatch = cellXml.match(/<is>[\s\S]*?<t[^>]*>([\s\S]*?)<\/t>/)
        if (inlineMatch) {
          cells.push(decodeXmlEntities(inlineMatch[1]))
        } else if (valueMatch) {
          const raw = decodeXmlEntities(valueMatch[1])
          cells.push(isShared ? (sharedStrings[Number(raw)] ?? raw) : raw)
        }
      }
      if (cells.length > 0) lines.push(cells.join('\t'))
    }
    lines.push('')
  }
  return lines
}

async function extractPptx(buffer) {
  const entries = listZipEntries(buffer)
  const slides = entries
    .filter(e => /^ppt\/slides\/slide\d+\.xml$/.test(e.name))
    .sort((a, b) => {
      const n = s => Number((s.name.match(/slide(\d+)\.xml$/) || [])[1] || 0)
      return n(a) - n(b)
    })
  if (slides.length === 0) throw new OfficeTextError('MISSING_DOCUMENT', 'pptx has no slides')
  const lines = []
  for (const slide of slides) {
    const index = (slide.name.match(/slide(\d+)\.xml$/) || [])[1] || '?'
    lines.push(`# slide ${index}`)
    const xml = readZipEntry(buffer, slide).toString('utf8')
    for (const line of extractParagraphLines(xml, { paragraphTags: ['a:p'], textTags: ['a:t'] })) {
      if (line.trim()) lines.push(line)
    }
    lines.push('')
  }
  return lines
}

export const PLAIN_TEXT_EXTENSIONS = Object.freeze(['.txt', '.md', '.markdown', '.csv', '.tsv', '.log', '.json', '.yaml', '.yml'])

/** 能纯文本抽取的格式（= 无依赖兜底能处理的集合）。 */
export const TEXT_EXTRACTABLE_EXTENSIONS = Object.freeze([
  '.docx', '.odt', '.xlsx', '.ods', '.pptx', '.odp',
  ...PLAIN_TEXT_EXTENSIONS,
])

export function canExtractText(filePath) {
  return TEXT_EXTRACTABLE_EXTENSIONS.includes(path.extname(String(filePath || '')).toLowerCase())
}

/**
 * 抽文本。老的二进制格式（.doc/.xls/.ppt）明确报错——它们不是 ZIP，猜着解析
 * 只会产出乱码，那比老实说「不支持」更糟。
 * @returns {Promise<{lines: string[], format: string}>}
 */
export async function extractOfficeText(filePath) {
  const abs = path.resolve(String(filePath || ''))
  const ext = path.extname(abs).toLowerCase()
  const buffer = await fs.readFile(abs)

  if (PLAIN_TEXT_EXTENSIONS.includes(ext)) {
    // 文本文件直接按 UTF-8 读；BOM 要去掉，否则第一行会多一个不可见字符
    const text = buffer.toString('utf8').replace(/^\uFEFF/, '')
    return { lines: text.split(/\r?\n/), format: 'text' }
  }
  if (['.doc', '.xls', '.ppt'].includes(ext)) {
    throw new OfficeTextError(
      'LEGACY_BINARY_FORMAT',
      `${ext} is the old binary format, which cannot be read without a real converter; save it as the modern format (${ext}x) or install LibreOffice`,
    )
  }
  if (ext === '.docx') return { lines: await extractDocx(buffer), format: 'docx' }
  if (ext === '.odt') return { lines: await extractOdt(buffer), format: 'odt' }
  if (['.xlsx', '.ods'].includes(ext)) return { lines: await extractXlsx(buffer), format: ext.slice(1) }
  if (['.pptx', '.odp'].includes(ext)) return { lines: await extractPptx(buffer), format: ext.slice(1) }
  throw new OfficeTextError('UNSUPPORTED_FORMAT', `cannot extract text from ${ext || 'a file with no extension'}`)
}
