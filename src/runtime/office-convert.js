// Office → PDF 转换（阶段 6.3）。
//
// 策略：优先用本机已装的 LibreOffice（`soffice`）做无头转换。它在三大平台上同一套命令行，
// 且不像 MS Office 那样需要 COM/AppleScript 与授权；没装就明确告诉调用方「没有可用的
// 转换器」并给出安装提示，而不是含糊地失败。
//
// 两个真实的坑，都不是「拼个命令行」能带过的：
//   1. **用户配置目录必须隔离**。LibreOffice 的 `--convert-to` 在「已经有一个实例在跑」时
//      会把请求转给那个实例然后**立刻返回**（退出码 0！），而转换根本没做。托盘里躺着
//      一个 LibreOffice 时就会这样。用 `-env:UserInstallation=file://<临时目录>` 开一个
//      独立 profile 才能保证真的转换，顺带也不会污染用户自己的 LibreOffice 配置。
//   2. **输出文件名由 LibreOffice 决定**（`<输入 basename>.pdf`，扩展名替换而非追加）。
//      所以不能自己拼输出路径去断言成功，必须转换后**去 outdir 里找产物**并核对 mtime。
//
// 全程 execFile + 参数数组，不经过 shell：路径里的空格、中文、& 都不需要转义。
import { execFile } from 'node:child_process'
import fs from 'node:fs'
import fsp from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { pathToFileURL } from 'node:url'

export const CONVERTER = Object.freeze({
  LIBREOFFICE: 'libreoffice',
  // 纯 JS 但没有版式还原：只抽文本，表格会变成制表符。
  TEXT_FALLBACK: 'text-fallback',
  // 纯 JS 且**还原结构**：解析 docx/xlsx 的 XML 后用 pdf-writer 排版（标题层级、表格线框）。
  // 它仍然不是 LibreOffice：图片、字体、页眉页脚、精确分页都没有。
  STRUCTURED: 'structured',
})

/** 路径优先级：LibreOffice → 结构化 → 纯文本。顺序本身就是契约（见 convertToPdf）。 */
export const CONVERTER_ORDER = Object.freeze([CONVERTER.LIBREOFFICE, CONVERTER.STRUCTURED, CONVERTER.TEXT_FALLBACK])

/** 每条路径「保真到什么程度」——调用方要如实转述给用户，不能一律说「转换完成」。 */
export const CONVERTER_FIDELITY = Object.freeze({
  [CONVERTER.LIBREOFFICE]: 'full',
  [CONVERTER.STRUCTURED]: 'structured',
  [CONVERTER.TEXT_FALLBACK]: 'text-only',
})

export class StructuredFallbackError extends Error {
  constructor(code, message) {
    super(message)
    this.name = 'StructuredFallbackError'
    this.code = code
  }
}

/** 兜底能处理的格式（= 纯文本抽取支持的集合）。 */
export { TEXT_EXTRACTABLE_EXTENSIONS, canExtractText } from './office-text.js'

/** 结构化路径能处理的格式（docx/xlsx/pptx/odt/ods/odp——老的二进制格式不在其中）。 */
export { STRUCTURED_EXTENSIONS, canParseStructure } from './office-structure.js'

export class TextFallbackUnavailable extends Error {
  constructor(message) {
    super(message)
    this.name = 'TextFallbackUnavailable'
    this.code = 'TEXT_FALLBACK_UNAVAILABLE'
  }
}

/**
 * 无依赖兜底：抽文本 → 生成文本 PDF。
 * 与 LibreOffice 路径的关键差别是**它不还原版式**（表格会变成制表符分隔、没有样式、
 * 没有图片）。所以调用方必须把用的是哪条路径告诉用户——把兜底产物说成「转换完成」
 * 会让用户以为版式都在。
 */
export async function convertViaTextFallback({ inputs = [], outDir = null, targetFormat = 'pdf' } = {}) {
  if (targetFormat !== 'pdf') {
    throw new TextFallbackUnavailable('the dependency-free fallback can only produce PDF')
  }
  const { buildTextPdf } = await import('./pdf-writer.js')
  const { extractOfficeText } = await import('./office-text.js')

  const list = (Array.isArray(inputs) ? inputs : [inputs]).map(p => String(p || '').trim()).filter(Boolean)
  if (list.length === 0) throw new ConvertError('NO_INPUTS', 'no input files given')

  const targetDir = path.resolve(outDir || path.dirname(path.resolve(list[0])))
  await fsp.mkdir(targetDir, { recursive: true })

  const converted = []
  const failed = []
  for (const input of list) {
    const abs = path.resolve(input)
    try {
      const { lines, format } = await extractOfficeText(abs)
      const output = path.join(targetDir, expectedPdfName(abs))
      const pdf = buildTextPdf({
        title: path.basename(abs),
        lines,
        // 首页顶部标明来源与「这是文本导出」，用户一眼能看出它不是原版式
        sourceLabel: `${path.basename(abs)} — text-only export (${format}); layout, images and styles are not preserved`,
      })
      await fsp.writeFile(output, pdf)
      converted.push({ input: abs, output, sizeBytes: pdf.length })
    } catch (error) {
      failed.push({ input: abs, error: error?.message || String(error), code: error?.code || 'TEXT_FALLBACK_FAILED' })
    }
  }
  return {
    converter: CONVERTER.TEXT_FALLBACK,
    fidelity: CONVERTER_FIDELITY[CONVERTER.TEXT_FALLBACK],
    outDir: targetDir,
    converted,
    failed,
  }
}

/**
 * 第三条路径：**结构化**纯 JS 生成 PDF。
 *
 * 与文本兜底的区别就是这一条的全部意义：文本兜底把表格拍成制表符、把所有字号拉平；
 * 这条路解析 XML 里的真实结构（标题层级、表格行列、列表），再由 pdf-writer 排版成
 * 有字号层级、有表格线框的 PDF。
 *
 * 它不是 LibreOffice 的替代品：图片、页眉页脚、精确分页、字体都还原不了。
 * 所以 `fidelity: 'structured'` 必须跟着返回值一起交出去。
 */
export async function convertViaStructure({ inputs = [], outDir = null, targetFormat = 'pdf' } = {}) {
  if (targetFormat !== 'pdf') {
    throw new StructuredFallbackError('STRUCTURED_UNAVAILABLE', 'the structured writer can only produce PDF')
  }
  const { parseOfficeStructure } = await import('./office-structure.js')
  const { buildStructuredPdf } = await import('./pdf-writer.js')

  const list = (Array.isArray(inputs) ? inputs : [inputs]).map(p => String(p || '').trim()).filter(Boolean)
  if (list.length === 0) throw new ConvertError('NO_INPUTS', 'no input files given')

  const targetDir = path.resolve(outDir || path.dirname(path.resolve(list[0])))
  await fsp.mkdir(targetDir, { recursive: true })

  const converted = []
  const failed = []
  for (const input of list) {
    const abs = path.resolve(input)
    try {
      const parsed = await parseOfficeStructure(abs)
      const output = path.join(targetDir, expectedPdfName(abs))
      const pdf = buildStructuredPdf({
        title: path.basename(abs),
        blocks: parsed.blocks,
        // 首页顶部标明来源与「这是结构化导出」：它比纯文本强，但仍然不是原版式
        sourceLabel: `${path.basename(abs)} — structured export (${parsed.format}); images, headers/footers and exact pagination are not preserved`,
      })
      await fsp.writeFile(output, pdf)
      converted.push({
        input: abs,
        output,
        sizeBytes: pdf.length,
        structure: parsed.stats,
      })
    } catch (error) {
      failed.push({ input: abs, error: error?.message || String(error), code: error?.code || 'STRUCTURED_FAILED' })
    }
  }
  return {
    converter: CONVERTER.STRUCTURED,
    fidelity: CONVERTER_FIDELITY[CONVERTER.STRUCTURED],
    outDir: targetDir,
    converted,
    failed,
  }
}

// LibreOffice 能直接吃的常见办公格式（不是白名单式限制，只是用来提前给出更有用的报错）
export const OFFICE_EXTENSIONS = Object.freeze([
  '.doc', '.docx', '.odt', '.rtf', '.txt',
  '.xls', '.xlsx', '.ods', '.csv',
  '.ppt', '.pptx', '.odp',
])

const DEFAULT_TIMEOUT_MS = 120_000

export class ConvertError extends Error {
  constructor(code, message, detail = null) {
    super(message)
    this.name = 'ConvertError'
    this.code = code
    this.detail = detail
  }
}

/**
 * 找 LibreOffice 的可执行文件。
 * @param {object} [o]
 * @param {NodeJS.ProcessEnv} [o.env]  —— 便于测试注入
 * @param {string[]} [o.extraCandidates]
 * @param {(p: string) => boolean} [o.exists]
 * @returns {{found: boolean, binary: string|null, searched: string[]}}
 */
export function findLibreOfficeBinary({
  env = process.env,
  platform = process.platform,
  extraCandidates = [],
  exists = (p) => { try { return fs.existsSync(p) } catch { return false } },
} = {}) {
  const searched = []
  const candidates = []

  if (platform === 'win32') {
    const roots = [
      env.ProgramFiles,
      env['ProgramFiles(x86)'],
      env.LOCALAPPDATA ? path.join(env.LOCALAPPDATA, 'Programs') : null,
      env.ProgramW6432,
    ].filter(Boolean)
    for (const root of roots) {
      candidates.push(path.join(root, 'LibreOffice', 'program', 'soffice.exe'))
      candidates.push(path.join(root, 'OpenOffice 4', 'program', 'soffice.exe'))
    }
  } else if (platform === 'darwin') {
    candidates.push('/Applications/LibreOffice.app/Contents/MacOS/soffice')
    candidates.push('/opt/homebrew/bin/soffice')
    candidates.push('/usr/local/bin/soffice')
  } else {
    candidates.push('/usr/bin/soffice', '/usr/bin/libreoffice', '/usr/local/bin/soffice', '/snap/bin/libreoffice')
  }

  // PATH 上的裸命令名放在最后：Windows 上 soffice.exe 通常不在 PATH，
  // 而 Linux 上往往只在 PATH。先查具体路径能给出更确定的结论。
  candidates.push('soffice.exe', 'soffice', 'libreoffice')
  candidates.push(...extraCandidates)

  for (const candidate of candidates) {
    searched.push(candidate)
    // 裸命令名没有目录分隔符：交给调用方用 `where`/`which` 的语义处理（这里只认绝对路径存在）
    if (!candidate.includes('/') && !candidate.includes('\\')) continue
    if (exists(candidate)) return { found: true, binary: candidate, searched }
  }
  return { found: false, binary: null, searched }
}

/** `-env:UserInstallation=` 要的是一个 file URL，而 Windows 路径必须先变成 URL。 */
export function userInstallationArg(profileDir) {
  return `-env:UserInstallation=${pathToFileURL(path.resolve(profileDir)).href}`
}

/**
 * 组装 LibreOffice 参数（纯函数，便于直接断言——参数拼错是这类集成最常见的错）。
 * @param {string} outDir
 * @param {string[]} inputs
 * @param {string} profileDir
 */
export function buildConvertArgs({ outDir, inputs, profileDir, targetFormat = 'pdf' }) {
  return [
    userInstallationArg(profileDir),
    '--headless',
    '--norestore',
    '--nolockcheck',
    '--nodefault',
    '--nologo',
    '--convert-to', targetFormat,
    '--outdir', path.resolve(outDir),
    ...inputs.map(p => path.resolve(p)),
  ]
}

/**
 * LibreOffice 的输出名规则：**扩展名替换**（`报告.docx` → `报告.pdf`），不是追加。
 * 自己拼 `<input>.pdf` 会得到 `报告.docx.pdf`，然后去断言一个根本不会出现的文件。
 */
export function expectedPdfName(inputPath) {
  const base = path.basename(String(inputPath || ''))
  const dot = base.lastIndexOf('.')
  return `${dot > 0 ? base.slice(0, dot) : base}.pdf`
}

/**
 * 跑一条外部命令，把「成功/退出码/超时/stderr」整理成统一形状。
 * 导出是为了能测：用 node 自己当被调命令，就能真实验证成功判定、非零退出码、
 * stderr 捕获与超时杀掉这四条——不需要装任何转换器。
 */
export function runProcess(command, args, timeoutMs) {
  return new Promise((resolve) => {
    try {
      execFile(command, args, { timeout: timeoutMs, windowsHide: true, maxBuffer: 8 * 1024 * 1024 }, (error, stdout, stderr) => {
        resolve({
          ok: !error,
          code: error?.code ?? 0,
          killed: error?.killed === true,
          stdout: String(stdout || ''),
          stderr: String(stderr || ''),
          error: error ? String(stderr || error.message || '').trim() : '',
        })
      })
    } catch (error) {
      resolve({ ok: false, code: -1, killed: false, stdout: '', stderr: '', error: error?.message || String(error) })
    }
  })
}

/**
 * 把一个或多个办公文件转成 PDF。
 *
 * 一次调用转多个：LibreOffice 的启动开销（冷启动常 2–5 秒）远大于转换本身，
 * 逐个调用会让「转 5 个文件」变成半分钟。
 *
 * **三层路径，按保真度递减**：LibreOffice → 结构化 → 纯文本兜底。
 * 每一层失败都继续往下试，但**每一次返回都如实上报 `converter`**：
 * 把兜底产物说成主路径的转换是最坏的一种失败。
 *
 * `allowStructured` 默认跟随 `allowTextFallback`：调用方说「不要纯 JS 兜底」时，
 * 结构化也是纯 JS 兜底，不能绕过这个开关偷偷用上。
 *
 * @returns {Promise<{converter, fidelity, converted: Array, failed: Array, attempts: Array, raw?: object}>}
 */
export async function convertToPdf({
  inputs = [],
  outDir = null,
  binary = null,
  profileDir = null,
  timeoutMs = DEFAULT_TIMEOUT_MS,
  targetFormat = 'pdf',
  allowTextFallback = true,
  allowStructured = allowTextFallback,
  _run = runProcess,
} = {}) {
  const list = (Array.isArray(inputs) ? inputs : [inputs]).map(p => String(p || '').trim()).filter(Boolean)
  if (list.length === 0) throw new ConvertError('NO_INPUTS', 'no input files given')

  // 每一层试过之后都记一笔（用没用、为什么没用），全失败时这些就是错误消息的主体
  const attempts = []
  const note = (converter, outcome, detail) => attempts.push({ converter, outcome, ...(detail ? { detail } : {}) })

  const tryStructured = async (why) => {
    if (!allowStructured) {
      note(CONVERTER.STRUCTURED, 'skipped', 'structured path disabled by the caller (allowStructured=false)')
      return null
    }
    const result = await convertViaStructure({ inputs: list, outDir, targetFormat })
    if (result.converted.length > 0) {
      note(CONVERTER.STRUCTURED, 'succeeded', why)
      return result
    }
    // 结构解析失败（老格式、损坏的 zip、没有结构内容）不是致命错：还有纯文本一层
    note(CONVERTER.STRUCTURED, 'failed', result.failed.map(f => `${path.basename(f.input)}: ${f.code}`).join('; '))
    return { ...result, attemptedOnly: true }
  }

  const tryText = async (why) => {
    if (!allowTextFallback) {
      note(CONVERTER.TEXT_FALLBACK, 'skipped', 'text fallback disabled by the caller (allowTextFallback=false)')
      return null
    }
    const result = await convertViaTextFallback({ inputs: list, outDir, targetFormat })
    if (result.converted.length > 0) {
      note(CONVERTER.TEXT_FALLBACK, 'succeeded', why)
      return result
    }
    note(CONVERTER.TEXT_FALLBACK, 'failed', result.failed.map(f => `${path.basename(f.input)}: ${f.code}`).join('; '))
    return { ...result, attemptedOnly: true }
  }

  const probe = binary ? { found: true, binary } : findLibreOfficeBinary()
  if (!probe.found) {
    // 没装 LibreOffice：先试结构化（有版式），再退纯文本（只有字）。
    // 这条顺序是契约：用户拿到的东西保真度只能往下走，不能反过来。
    note(CONVERTER.LIBREOFFICE, 'unavailable', 'soffice was not found on this machine')

    // 两条纯 JS 路径都被关掉 = 调用方明确要「没有转换器就报错」，不是「尽力而为」。
    // 这条分支必须在真的去试之前：关掉的路径不该被跑一遍（会白写文件）。
    if (!allowStructured && !allowTextFallback) {
      throw new ConvertError(
        'NO_CONVERTER',
        'no office converter is installed on this machine (LibreOffice was not found)',
        {
          searched: probe.searched,
          attempts,
          hint: 'install LibreOffice (https://www.libreoffice.org/download/) and retry; on Windows the default install path is C:\\Program Files\\LibreOffice\\program\\soffice.exe',
        },
      )
    }

    const structured = await tryStructured('LibreOffice is not installed')
    if (structured && !structured.attemptedOnly) return withAttempts(structured, attempts)
    const text = await tryText('structured export also failed')
    if (text && !text.attemptedOnly) return withAttempts(text, attempts)

    // 三条路径都试过且都产不出东西。**这里刻意不抛**：路径确实跑到了底，
    // 「每个文件为什么失败」是正常结果而不是异常（调用方与工具层都靠 failed 逐条上报）。
    // 只有当调用方把两条纯 JS 路径都关掉、等于「这台机器没有转换器」时才抛 NO_CONVERTER。
    const last = text || structured || null
    return {
      converter: last?.converter || CONVERTER.TEXT_FALLBACK,
      fidelity: CONVERTER_FIDELITY[last?.converter || CONVERTER.TEXT_FALLBACK],
      outDir: path.resolve(outDir || path.dirname(path.resolve(list[0]))),
      converted: [],
      failed: last?.failed || [],
      attempts,
    }
  }

  // 输入先校验：不存在/是目录就当场说清，不要留给 LibreOffice 去报一句难懂的话
  const prepared = []
  for (const input of list) {
    const abs = path.resolve(input)
    let info
    try {
      info = await fsp.stat(abs)
    } catch {
      throw new ConvertError('INPUT_NOT_FOUND', `no such file: ${abs}`)
    }
    if (!info.isFile()) throw new ConvertError('INPUT_NOT_A_FILE', `not a regular file: ${abs}`)
    prepared.push(abs)
  }

  const targetDir = path.resolve(outDir || path.dirname(prepared[0]))
  await fsp.mkdir(targetDir, { recursive: true })

  // 独立 profile：避免「已有一个 LibreOffice 实例」时静默直返（见文件头第 1 条）
  const profile = profileDir || (await fsp.mkdtemp(path.join(os.tmpdir(), 'blm-lo-profile-')))
  const before = new Map()
  for (const input of prepared) {
    const candidate = path.join(targetDir, expectedPdfName(input))
    before.set(input, await mtimeOf(candidate))
  }

  const args = buildConvertArgs({ outDir: targetDir, inputs: prepared, profileDir: profile, targetFormat })
  const raw = await _run(probe.binary, args, timeoutMs)

  const converted = []
  const failed = []
  for (const input of prepared) {
    const candidate = path.join(targetDir, expectedPdfName(input))
    const after = await mtimeOf(candidate)
    // 「有产物且是新的」才算成功。只看退出码是不够的：LibreOffice 在把请求转给既有实例、
    // 或遇到它不认识的格式时，都可能退出 0 而什么都没产出。
    if (after !== null && after !== before.get(input)) {
      converted.push({ input, output: candidate, sizeBytes: await sizeOf(candidate) })
    } else {
      // 失败原因优先用转换器自己的话（stderr），其次才是我们的猜测。
      // 这里刻意两种字段都认（error / stderr）：注入 _run 的调用方未必知道
      // runProcess 的内部形状，只给 stderr 是很自然的事——只读 error 会退化成
      // 一句没有信息量的「exited with code 1」。
      const detail = raw.error || String(raw.stderr || '').trim()
      failed.push({
        input,
        expected: candidate,
        error: raw.ok
          ? 'the converter exited successfully but produced no new file (unsupported format, or another LibreOffice instance swallowed the request)'
          : (detail || `converter exited with code ${raw.code}`),
      })
    }
  }

  return {
    converter: CONVERTER.LIBREOFFICE,
    fidelity: CONVERTER_FIDELITY[CONVERTER.LIBREOFFICE],
    binary: probe.binary,
    outDir: targetDir,
    profileDir: profile,
    converted,
    failed,
    attempts,
    ...(raw.killed ? { timedOut: true, timeoutMs } : {}),
  }
}

/** 把「试过哪几条路径」附在返回结果上——调用方与用户都靠它判断产物是什么级别。 */
function withAttempts(result, attempts) {
  return {
    ...result,
    fidelity: result.fidelity || CONVERTER_FIDELITY[result.converter],
    attempts,
  }
}

async function mtimeOf(file) {
  try {
    const info = await fsp.stat(file)
    return info.mtimeMs
  } catch {
    return null
  }
}

async function sizeOf(file) {
  try {
    return (await fsp.stat(file)).size
  } catch {
    return null
  }
}

/** 清理临时 profile（转换完就没用了，留着只会攒垃圾）。 */
export async function cleanupProfile(profileDir) {
  if (!profileDir) return
  try {
    await fsp.rm(profileDir, { recursive: true, force: true })
  } catch { /* 清不掉不影响结果 */ }
}

export function isOfficeExtension(filePath) {
  return OFFICE_EXTENSIONS.includes(path.extname(String(filePath || '')).toLowerCase())
}
