// present 交付物工具（阶段 6.2）：把已有文件声明为「这次要做的东西」，让 UI 出卡片。
//
// 与「在回复里写个路径」的区别：卡片是可点的（用系统默认程序打开那个文件），
// 而且有服务端登记兜底——所以点开的一定是模型真的交付给你的文件，不是聊天里
// 随便一个字符串。
//
// 三条约束都是刻意的：
//   1. 最多 4 个。交付物一多就不叫「交付」了，用户不知道该看哪个；
//      宁可让模型自己挑最重要的，也不要甩一张清单。
//   2. **必须是已存在的普通文件**。不存在的路径只会在用户点击时变成一个报错，
//      与其那时才发现，不如这一轮就把话说清楚（返回明确错误让模型改）。
//   3. 相对路径按当前仓库根解析；解析结果（绝对路径）才是登记与展示用的。
import { stat } from 'node:fs/promises'
import path from 'node:path'
import { recordDeliverable } from '../../runtime/deliverables-store.js'
import { emitEvent } from '../../events.js'
import { paths } from '../../paths.js'

export const MAX_DELIVERABLES = 4

export class DeliverableError extends Error {
  constructor(code, message) {
    super(message)
    this.name = 'DeliverableError'
    this.code = code
  }
}

function resolveFilePath(raw) {
  const value = String(raw ?? '').trim()
  if (!value) throw new DeliverableError('PATH_REQUIRED', 'each deliverable needs a path')
  // 相对路径按仓库根解析：模型的 shell/文件工具都以它为锚点，这里保持一致，
  // 否则「我写的 report.md」会在服务端被解析到别处。
  return path.isAbsolute(value) ? path.normalize(value) : path.resolve(paths.resourcesDir, value)
}

/** 文件类型只用于 UI 选图标，不做安全判断。 */
export function describeFileKind(filePath) {
  const ext = path.extname(filePath).toLowerCase()
  if (['.doc', '.docx', '.odt', '.rtf'].includes(ext)) return 'document'
  if (['.xls', '.xlsx', '.csv', '.ods'].includes(ext)) return 'spreadsheet'
  if (['.ppt', '.pptx', '.odp'].includes(ext)) return 'presentation'
  if (ext === '.pdf') return 'pdf'
  if (['.png', '.jpg', '.jpeg', '.gif', '.webp', '.svg', '.bmp'].includes(ext)) return 'image'
  if (['.mp4', '.mov', '.avi', '.mkv', '.webm'].includes(ext)) return 'video'
  if (['.mp3', '.wav', '.flac', '.m4a', '.ogg'].includes(ext)) return 'audio'
  if (['.zip', '.tar', '.gz', '.7z', '.rar'].includes(ext)) return 'archive'
  if (['.md', '.txt', '.log', '.json', '.yaml', '.yml', '.xml', '.html', '.js', '.ts', '.py'].includes(ext)) return 'text'
  return 'file'
}

/**
 * 校验一个交付物声明。
 * @returns {{path: string, description: string, sizeBytes: number, kind: string}}
 */
export async function validateDeliverable(entry = {}) {
  const filePath = resolveFilePath(entry?.path)
  let info
  try {
    info = await stat(filePath)
  } catch {
    throw new DeliverableError('NOT_FOUND', `no such file: ${filePath}`)
  }
  if (info.isDirectory()) {
    throw new DeliverableError(
      'IS_DIRECTORY',
      `${filePath} is a directory; present the file itself (or a single archive), not a folder — a card that opens a folder tells the user nothing`,
    )
  }
  if (!info.isFile()) {
    throw new DeliverableError('NOT_A_FILE', `${filePath} is not a regular file`)
  }
  return {
    path: filePath,
    description: String(entry?.description ?? '').trim().slice(0, 500),
    sizeBytes: info.size,
    kind: describeFileKind(filePath),
  }
}

export async function execPresent(args = {}) {
  const raw = Array.isArray(args.files) ? args.files : []
  if (raw.length === 0) {
    return JSON.stringify({
      ok: false,
      code: 'FILES_REQUIRED',
      error: 'present needs at least one file: pass { files: [{ path, description }] }',
    })
  }
  if (raw.length > MAX_DELIVERABLES) {
    // 不静默截断：截断会让模型以为都交付了，而用户只看到前几个。
    return JSON.stringify({
      ok: false,
      code: 'TOO_MANY_FILES',
      error: `present accepts at most ${MAX_DELIVERABLES} files per call (got ${raw.length}). Pick the ones that matter most — and put the rest in your reply text if they still need mentioning.`,
    })
  }

  const accepted = []
  const rejected = []
  for (const entry of raw) {
    try {
      const valid = await validateDeliverable(entry)
      recordDeliverable(valid)
      accepted.push(valid)
    } catch (error) {
      rejected.push({
        path: String(entry?.path ?? ''),
        code: error?.code || 'INVALID',
        error: error?.message || String(error),
      })
    }
  }

  if (accepted.length > 0) {
    emitEvent('deliverables_presented', {
      files: accepted.map(f => ({
        path: f.path,
        description: f.description,
        size_bytes: f.sizeBytes,
        kind: f.kind,
      })),
    })
  }

  if (accepted.length === 0) {
    return JSON.stringify({
      ok: false,
      code: rejected[0]?.code || 'INVALID',
      error: rejected.map(r => r.error).join('; '),
      rejected,
    })
  }

  return JSON.stringify({
    ok: true,
    presented: accepted.map(f => ({ path: f.path, description: f.description, size_bytes: f.sizeBytes, kind: f.kind })),
    ...(rejected.length > 0 ? { rejected } : {}),
    note: rejected.length > 0
      ? 'Some entries were rejected (see rejected) — fix those and present them again, or drop them.'
      : 'Cards are up in the user interface; the user can open each file with its default app. Do not also paste the whole content into your reply.',
  })
}
