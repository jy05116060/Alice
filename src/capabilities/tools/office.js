// convert_to_pdf 工具（阶段 6.3）：把办公文件转成 PDF，通常接着用 present 交给用户。
import path from 'node:path'
import {
  CONVERTER,
  CONVERTER_FIDELITY,
  CONVERTER_ORDER,
  ConvertError,
  OFFICE_EXTENSIONS,
  STRUCTURED_EXTENSIONS,
  TEXT_EXTRACTABLE_EXTENSIONS,
  cleanupProfile,
  convertToPdf,
  findLibreOfficeBinary,
  isOfficeExtension,
} from '../../runtime/office-convert.js'
import { emitEvent } from '../../events.js'

const MAX_FILES = 10

export async function execConvertToPdf(args = {}) {
  const raw = Array.isArray(args.paths) ? args.paths : (args.path ? [args.path] : [])
  const inputs = raw.map(p => String(p ?? '').trim()).filter(Boolean)
  if (inputs.length === 0) {
    return JSON.stringify({
      ok: false,
      code: 'PATHS_REQUIRED',
      error: 'convert_to_pdf needs at least one file: pass { paths: [...] }',
    })
  }
  if (inputs.length > MAX_FILES) {
    return JSON.stringify({
      ok: false,
      code: 'TOO_MANY_FILES',
      error: `convert_to_pdf accepts at most ${MAX_FILES} files per call (got ${inputs.length}); call it again for the rest`,
    })
  }

  // 提前拦一下明显不是办公格式的输入，给出比 LibreOffice 更有用的提示
  const suspicious = inputs.filter(p => !isOfficeExtension(p))
  if (suspicious.length === inputs.length) {
    return JSON.stringify({
      ok: false,
      code: 'UNSUPPORTED_FORMAT',
      error: `none of these look like office documents: ${suspicious.join(', ')}. Supported: ${OFFICE_EXTENSIONS.join(' ')}`,
    })
  }

  const outDir = args.out_dir ? path.resolve(String(args.out_dir)) : null
  let result
  try {
    result = await convertToPdf({ inputs, outDir })
  } catch (error) {
    const payload = {
      ok: false,
      code: error?.code || 'CONVERT_FAILED',
      error: error?.message || String(error),
      ...(error?.detail ? { detail: error.detail } : {}),
    }
    emitEvent('pdf_convert_failed', { code: payload.code, files: inputs.length })
    return JSON.stringify(payload)
  } finally {
    // profile 只是这次转换的脚手架，不留
    if (result?.profileDir) await cleanupProfile(result.profileDir)
  }

  const ok = result.converted.length > 0
  emitEvent('pdf_converted', {
    converter: result.converter,
    converted: result.converted.map(c => ({ input: c.input, output: c.output, size_bytes: c.sizeBytes })),
    failed: result.failed.map(f => ({ input: f.input, error: f.error })),
  })

  const usedStructured = result.converter === 'structured'
  const usedTextFallback = result.converter === 'text-fallback'
  return JSON.stringify({
    ok,
    converter: result.converter,
    ...(result.fidelity ? { fidelity: result.fidelity } : {}),
    converted: result.converted.map(c => ({
      input: c.input,
      output: c.output,
      size_bytes: c.sizeBytes,
      ...(c.structure ? { structure: c.structure } : {}),
    })),
    ...(result.failed.length > 0 ? { failed: result.failed } : {}),
    ...(result.timedOut ? { timed_out: true, timeout_ms: result.timeoutMs } : {}),
    note: ok
      ? [
        usedStructured
          // 结构化比纯文本强，但仍然不是原版式：标题层级与表格在，图片与页眉页脚不在
          ? 'IMPORTANT: LibreOffice is not installed, so these PDFs came from the built-in STRUCTURED writer: headings keep their size levels and tables are drawn as real tables with rules, but images, headers/footers, exact pagination and the original fonts are NOT preserved. Say that when you hand them over, or install LibreOffice for a real conversion.'
          : usedTextFallback
            // 纯文本兜底必须说清楚：把文本导出说成「转换完成」会让用户以为版式都在
            ? 'IMPORTANT: LibreOffice is not installed and the document could not be parsed structurally, so these PDFs are a TEXT-ONLY fallback: the words are there, but layout, styles, tables, images and headers are NOT. Say so when you hand them over, or install LibreOffice for a real conversion.'
            : 'PDF(s) written next to the source file (or into out_dir).',
        result.failed.length > 0 ? 'Some files failed — see failed.' : '',
        'If the user is meant to take the PDF away, hand it over with present.',
      ].filter(Boolean).join(' ')
      : [
        'Nothing was converted.',
        // 全失败时更要说清「本来会给你什么」以及「为什么没给成」：
        // 只回一句 failed 会让模型把「内置转换器试过了三条路径」说成「机器不能转」。
        usedTextFallback
          ? 'Every built-in path was tried (LibreOffice → structured → TEXT-ONLY) and none produced a PDF — see failed for each reason. Do not claim a PDF was produced.'
          : 'Every built-in path was tried and none produced a PDF — see failed for each reason.',
        'Tell the user what failed and suggest installing LibreOffice (https://www.libreoffice.org/download/) or re-saving the file in a modern format (docx/xlsx).',
      ].join(' '),
  })
}

/** 能力探测：让人和模型都能先问一句「这台机器能不能转」，而不是事后猜。 */
export function execOfficeCapability() {
  const probe = findLibreOfficeBinary()
  return JSON.stringify({
    ok: true,
    // 三条路径都要报：没装 LibreOffice 不等于「不能转」，只是保真度往下走
    converter: probe.found ? CONVERTER.LIBREOFFICE : CONVERTER.STRUCTURED,
    converter_order: CONVERTER_ORDER,
    fidelity: probe.found ? CONVERTER_FIDELITY[CONVERTER.LIBREOFFICE] : CONVERTER_FIDELITY[CONVERTER.STRUCTURED],
    full_fidelity: probe.found,
    binary: probe.binary,
    structured_extensions: STRUCTURED_EXTENSIONS,
    text_fallback_extensions: TEXT_EXTRACTABLE_EXTENSIONS,
    supported_extensions: OFFICE_EXTENSIONS,
    ...(probe.found
      ? {}
      : {
        hint: 'LibreOffice was not found. convert_to_pdf still works: it first tries the built-in STRUCTURED writer (docx/xlsx/pptx/odt/ods/odp): headings keep their size levels and tables are drawn as real tables with rules, but images, headers/footers and the original fonts are not preserved. If the structure cannot be parsed it falls back to a TEXT-ONLY export (words only). Tell the user which one they got, or suggest installing LibreOffice for a real conversion.',
      }),
  })
}
