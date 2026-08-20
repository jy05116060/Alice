import { execFile } from 'node:child_process'

function normalizeSystemBrowserUrl(value) {
  let parsed
  try {
    parsed = new URL(String(value || '').trim())
  } catch {
    return ''
  }
  if (!['http:', 'https:'].includes(parsed.protocol)) return ''
  if (parsed.username || parsed.password) return ''
  return parsed.href
}

function systemBrowserCommand(url, platform = process.platform) {
  if (platform === 'darwin') return { command: 'open', args: [url] }
  if (platform === 'win32') {
    return {
      command: 'rundll32.exe',
      args: ['url.dll,FileProtocolHandler', url],
    }
  }
  return { command: 'xdg-open', args: [url] }
}

function execFileAsync(command, args, options) {
  return new Promise((resolve, reject) => {
    execFile(command, args, options, (error, stdout, stderr) => {
      if (error) {
        error.stdout = stdout
        error.stderr = stderr
        reject(error)
        return
      }
      resolve({ stdout, stderr })
    })
  })
}

export async function execSystemBrowserOpen({ url } = {}, context = {}) {
  const normalizedUrl = normalizeSystemBrowserUrl(url)
  if (!normalizedUrl) {
    return JSON.stringify({
      ok: false,
      tool: 'system_browser_open',
      error: 'url must be a complete http:// or https:// URL without embedded credentials',
    })
  }

  const platform = String(context.platform || process.platform)
  const launch = systemBrowserCommand(normalizedUrl, platform)
  const runner = typeof context.openSystemBrowser === 'function'
    ? context.openSystemBrowser
    : execFileAsync

  try {
    await runner(launch.command, launch.args, {
      timeout: 10_000,
      windowsHide: true,
      maxBuffer: 64 * 1024,
    })
    return JSON.stringify({
      ok: true,
      tool: 'system_browser_open',
      surface: 'system',
      url: normalizedUrl,
      controllable: false,
      shared_with_alice_browser: false,
    })
  } catch (error) {
    return JSON.stringify({
      ok: false,
      tool: 'system_browser_open',
      surface: 'system',
      url: normalizedUrl,
      error: String(error?.message || error || 'failed to open the system browser').slice(0, 300),
    })
  }
}

export const __internal = {
  normalizeSystemBrowserUrl,
  systemBrowserCommand,
}
