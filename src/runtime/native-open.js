// 用系统默认程序打开文件 / 在文件管理器里定位（阶段 6.2）。
//
// 全程 execFile + 参数数组，不经过 shell：路径里的空格、中文、& 、引号都不需要转义，
// 也就没有「拼命令行」那一类注入面。这与 worktree 模块同一个理由。
//
// Windows 的 `start` 是 cmd 内建命令，必须 `cmd /c start "" <path>`：那个空字符串是
// 窗口标题参数。少了它，带引号的路径会被 start 当成标题，于是文件根本不会被打开——
// 这是 `start` 最经典的坑。
import { execFile } from 'node:child_process'
import { stat } from 'node:fs/promises'
import path from 'node:path'

const TIMEOUT_MS = 20_000

function runFile(command, args, timeoutMs = TIMEOUT_MS) {
  return new Promise((resolve) => {
    try {
      execFile(command, args, { timeout: timeoutMs, windowsHide: true }, (error, stdout, stderr) => {
        if (error) {
          resolve({ ok: false, error: String(stderr || error.message || '').trim() || String(error.code || 'failed') })
          return
        }
        resolve({ ok: true, stdout: String(stdout || '').trim(), stderr: String(stderr || '').trim() })
      })
    } catch (error) {
      resolve({ ok: false, error: error?.message || String(error) })
    }
  })
}

async function ensureExists(target) {
  try {
    const info = await stat(target)
    return info.isFile() || info.isDirectory()
  } catch {
    return false
  }
}

/** 系统默认程序打开。返回 { ok, path, error? } —— 失败只说清原因，不抛。 */
export async function openPathNatively(target) {
  const filePath = path.normalize(String(target || ''))
  if (!filePath) return { ok: false, path: filePath, error: 'empty path' }
  if (!(await ensureExists(filePath))) return { ok: false, path: filePath, error: 'file no longer exists' }

  if (process.platform === 'win32') {
    const result = await runFile('cmd', ['/c', 'start', '', filePath])
    return { ok: result.ok, path: filePath, ...(result.ok ? {} : { error: result.error }) }
  }
  if (process.platform === 'darwin') {
    const result = await runFile('open', [filePath])
    return { ok: result.ok, path: filePath, ...(result.ok ? {} : { error: result.error }) }
  }
  const result = await runFile('xdg-open', [filePath])
  return { ok: result.ok, path: filePath, ...(result.ok ? {} : { error: result.error }) }
}

/** 在文件管理器里定位（选中该文件）。Windows 用 explorer /select。 */
export async function revealPathNatively(target) {
  const filePath = path.normalize(String(target || ''))
  if (!filePath) return { ok: false, path: filePath, error: 'empty path' }
  if (!(await ensureExists(filePath))) return { ok: false, path: filePath, error: 'file no longer exists' }

  if (process.platform === 'win32') {
    // explorer 用 /select, 且**返回非 0 是常态**（它经常以 1 退出），所以这里不把
    // 退出码当失败判据——否则每次「在文件夹里显示」都会误报失败。
    await runFile('explorer', [`/select,${filePath}`])
    return { ok: true, path: filePath }
  }
  if (process.platform === 'darwin') {
    const result = await runFile('open', ['-R', filePath])
    return { ok: result.ok, path: filePath, ...(result.ok ? {} : { error: result.error }) }
  }
  const dir = path.dirname(filePath)
  const result = await runFile('xdg-open', [dir])
  return { ok: result.ok, path: filePath, ...(result.ok ? {} : { error: result.error }) }
}
