'use strict'

// Lifecycle for the one Chrome instance that Alice is allowed to control.
//
// This intentionally does not use Electron's WebContents or the user's normal
// browser profile. A visible Chromium runtime bundled with Alice is the
// primary browser; a locally installed stable Chrome is only a development
// fallback. Both use the same isolated Alice profile and loopback CDP.

const childProcess = require('child_process')
const fs = require('fs')
const http = require('http')
const net = require('net')
const path = require('path')
const { resolveBundledChromiumExecutable } = require('./playwright-runtime.cjs')

const LOOPBACK_HOST = '127.0.0.1'
const DEVTOOLS_ACTIVE_PORT_FILE = 'DevToolsActivePort'
const PROFILE_DIRECTORY_NAME = 'alice-chrome'
const STARTUP_TIMEOUT_MS = 20_000

class AliceChromeError extends Error {
  constructor(code, message, cause) {
    super(message)
    this.name = 'AliceChromeError'
    this.code = code
    if (cause) this.cause = cause
  }
}

function isGoogleChromeExecutable(candidate) {
  const normalized = String(candidate || '').trim()
  if (!normalized) return false
  const folded = normalized.toLowerCase()
  return !folded.includes('chrome for testing') && !folded.includes('chromium')
}

function pathExists(candidate, existsSync = fs.existsSync) {
  try { return Boolean(candidate && existsSync(candidate)) } catch { return false }
}

function chromeCandidates(platform = process.platform, env = process.env) {
  const configured = String(env.ALICE_GOOGLE_CHROME_PATH || '').trim()
  const candidates = configured ? [configured] : []
  if (platform === 'darwin') {
    candidates.push('/Applications/Google Chrome.app/Contents/MacOS/Google Chrome')
  } else if (platform === 'win32') {
    const roots = [env.PROGRAMFILES, env['PROGRAMFILES(X86)'], env.LOCALAPPDATA]
      .filter(Boolean)
    for (const root of roots) {
      candidates.push(path.join(root, 'Google', 'Chrome', 'Application', 'chrome.exe'))
    }
  } else {
    candidates.push('/usr/bin/google-chrome', '/usr/bin/google-chrome-stable', '/opt/google/chrome/google-chrome')
  }
  return [...new Set(candidates.map(value => path.resolve(value)))]
}

function resolveGoogleChromeExecutable({
  platform = process.platform,
  arch = process.arch,
  env = process.env,
  bundledBrowserRoot,
  existsSync = fs.existsSync,
} = {}) {
  const configured = String(env.ALICE_BROWSER_PATH || '').trim()
  if (configured && pathExists(configured, existsSync)) return path.resolve(configured)
  const bundled = resolveBundledChromiumExecutable({
    root: bundledBrowserRoot,
    platform,
    arch,
    existsSync,
  })
  if (bundled) return bundled
  for (const candidate of chromeCandidates(platform, env)) {
    if (isGoogleChromeExecutable(candidate) && pathExists(candidate, existsSync)) return candidate
  }
  throw new AliceChromeError(
    'CHROME_NOT_INSTALLED',
    'Alice built-in browser is missing or damaged. Reinstall Alice, then try the browser again.',
  )
}

function resolveDedicatedProfileDir(userDataDir) {
  const raw = String(userDataDir || '').trim()
  if (!raw) throw new AliceChromeError('PROFILE_UNAVAILABLE', 'Alice application data directory is unavailable.')
  const root = path.resolve(raw)
  return path.join(root, 'browser-profiles', PROFILE_DIRECTORY_NAME)
}

function isPathWithin(root, target) {
  const relative = path.relative(path.resolve(root), path.resolve(target))
  return relative === '' || (!relative.startsWith(`..${path.sep}`) && relative !== '..' && !path.isAbsolute(relative))
}

function assertDedicatedProfileDir(profileDir, userDataDir) {
  const expected = resolveDedicatedProfileDir(userDataDir)
  if (path.resolve(profileDir) !== expected || !isPathWithin(path.dirname(expected), profileDir)) {
    throw new AliceChromeError('PROFILE_ISOLATION_FAILED', 'Refusing to use a Chrome profile outside Alice application data.')
  }
  return expected
}

function isLoopbackDevtoolsUrl(value) {
  try {
    const url = new URL(String(value || ''))
    return url.protocol === 'http:' && url.hostname === LOOPBACK_HOST && Number(url.port) > 0
  } catch {
    return false
  }
}

function devtoolsUrl(port) {
  const numeric = Number(port)
  if (!Number.isInteger(numeric) || numeric < 1 || numeric > 65535) {
    throw new AliceChromeError('DEBUG_PORT_INVALID', 'Chrome DevTools port is invalid.')
  }
  return `http://${LOOPBACK_HOST}:${numeric}`
}

function findLoopbackPort({ createServer = net.createServer } = {}) {
  return new Promise((resolve, reject) => {
    const server = createServer()
    server.once('error', reject)
    server.listen(0, LOOPBACK_HOST, () => {
      const address = server.address()
      const port = typeof address === 'object' && address ? address.port : 0
      server.close(error => error ? reject(error) : resolve(port))
    })
  })
}

function readDevToolsActivePort(profileDir, { readFileSync = fs.readFileSync } = {}) {
  try {
    const raw = readFileSync(path.join(profileDir, DEVTOOLS_ACTIVE_PORT_FILE), 'utf8')
    const [portText] = String(raw || '').split(/\r?\n/)
    const port = Number(portText)
    return Number.isInteger(port) && port > 0 && port <= 65535 ? port : null
  } catch {
    return null
  }
}

function requestJson(url, pathname = '/json/version', {
  get = http.get,
  timeoutMs = 2_000,
} = {}) {
  if (!isLoopbackDevtoolsUrl(url)) {
    return Promise.reject(new AliceChromeError('DEBUG_ENDPOINT_UNSAFE', 'Chrome DevTools must use the 127.0.0.1 loopback endpoint.'))
  }
  const endpoint = new URL(url)
  return new Promise((resolve, reject) => {
    const request = get({
      hostname: LOOPBACK_HOST,
      port: Number(endpoint.port),
      path: pathname,
      timeout: timeoutMs,
    }, response => {
      const chunks = []
      response.on('data', chunk => chunks.push(chunk))
      response.on('end', () => {
        if (response.statusCode !== 200) {
          reject(new AliceChromeError('DEBUG_ENDPOINT_UNAVAILABLE', `Chrome DevTools returned HTTP ${response.statusCode}.`))
          return
        }
        try { resolve(JSON.parse(Buffer.concat(chunks).toString('utf8'))) }
        catch (error) { reject(new AliceChromeError('DEBUG_ENDPOINT_INVALID', 'Chrome DevTools returned invalid JSON.', error)) }
      })
    })
    request.on('timeout', () => request.destroy(new Error('Chrome DevTools request timed out')))
    request.on('error', error => reject(error))
  })
}

async function waitForDevtools(url, {
  probe = requestJson,
  timeoutMs = STARTUP_TIMEOUT_MS,
  intervalMs = 150,
  isProcessClosed = () => false,
} = {}) {
  const deadline = Date.now() + timeoutMs
  let lastError = null
  while (Date.now() < deadline) {
    if (isProcessClosed()) {
      throw new AliceChromeError('CHROME_CLOSED', 'Alice Chrome was closed before its DevTools connection became ready.')
    }
    try {
      const details = await probe(url)
      if (details && typeof details === 'object') return details
    } catch (error) {
      lastError = error
    }
    await new Promise(resolve => setTimeout(resolve, intervalMs))
  }
  throw new AliceChromeError(
    'DEBUG_ENDPOINT_UNAVAILABLE',
    'Alice Chrome started but its local DevTools endpoint did not become available. Close the Alice Chrome window and try again.',
    lastError,
  )
}

function chromeLaunchArgs({ profileDir, port }) {
  return [
    `--user-data-dir=${profileDir}`,
    `--remote-debugging-address=${LOOPBACK_HOST}`,
    `--remote-debugging-port=${port}`,
    '--no-first-run',
    '--no-default-browser-check',
    '--disable-background-mode',
  ]
}

function createAliceChromeManager({
  userDataDir,
  platform = process.platform,
  arch = process.arch,
  env = process.env,
  bundledBrowserRoot,
  spawn = childProcess.spawn,
  existsSync = fs.existsSync,
  mkdirSync = fs.mkdirSync,
  rmSync = fs.rmSync,
  findPort = findLoopbackPort,
  probe = requestJson,
  waitForEndpoint = waitForDevtools,
  resolveExecutable = resolveGoogleChromeExecutable,
  logger = console,
} = {}) {
  const profileDir = resolveDedicatedProfileDir(userDataDir)
  let ownedProcess = null
  let ownedProcessClosed = false
  let endpoint = ''
  let starting = null

  function state() {
    return {
      surface: 'alice_chrome',
      profileDir,
      endpoint: endpoint || null,
      loopbackOnly: true,
      visible: true,
      ownedByAlice: Boolean(ownedProcess && !ownedProcessClosed),
      status: endpoint ? (ownedProcessClosed ? 'closed' : 'ready') : 'idle',
    }
  }

  async function existingEndpoint() {
    const port = readDevToolsActivePort(profileDir)
    if (!port) return null
    const url = devtoolsUrl(port)
    try {
      await probe(url)
      return url
    } catch {
      return null
    }
  }

  async function start() {
    assertDedicatedProfileDir(profileDir, userDataDir)
    if (starting) return starting
    starting = Promise.resolve().then(async () => {
      const reusable = await existingEndpoint()
      if (reusable) {
        endpoint = reusable
        return { ...state(), reused: true }
      }
      const executable = resolveExecutable({ platform, arch, env, bundledBrowserRoot, existsSync })
      try { mkdirSync(profileDir, { recursive: true }) } catch (error) {
        throw new AliceChromeError('PROFILE_UNAVAILABLE', 'Unable to create Alice Chrome profile directory.', error)
      }
      let port
      try {
        port = await findPort()
      } catch (error) {
        throw new AliceChromeError(
          'DEBUG_PORT_UNAVAILABLE',
          'Unable to reserve a 127.0.0.1-only Chrome DevTools port. Close the Alice Chrome window or another conflicting local debugger, then retry.',
          error,
        )
      }
      const url = devtoolsUrl(port)
      let child
      try {
        child = spawn(executable, chromeLaunchArgs({ profileDir, port }), {
          detached: false,
          stdio: 'ignore',
          windowsHide: true,
        })
      } catch (error) {
        throw new AliceChromeError('CHROME_START_FAILED', 'Unable to start the installed Google Chrome browser.', error)
      }
      if (!child || typeof child.on !== 'function') {
        throw new AliceChromeError('CHROME_START_FAILED', 'Unable to start the installed Google Chrome browser.')
      }
      ownedProcess = child
      ownedProcessClosed = false
      child.once('exit', (code, signal) => {
        ownedProcessClosed = true
        if (endpoint === url) endpoint = ''
        logger.info?.(`[alice-chrome] Chrome exited (${code ?? 'unknown'}${signal ? `, ${signal}` : ''})`)
      })
      child.once('error', error => {
        ownedProcessClosed = true
        if (endpoint === url) endpoint = ''
        logger.warn?.('[alice-chrome] Chrome process error:', error?.message || error)
      })
      try {
        await waitForEndpoint(url, {
          probe,
          isProcessClosed: () => ownedProcessClosed,
        })
      } catch (error) {
        if (!ownedProcessClosed) {
          try { child.kill() } catch {}
        }
        throw error instanceof AliceChromeError
          ? error
          : new AliceChromeError('DEBUG_ENDPOINT_UNAVAILABLE', 'Unable to connect to Alice Chrome DevTools.', error)
      }
      endpoint = url
      return { ...state(), executable, reused: false }
    }).finally(() => { starting = null })
    return starting
  }

  async function ensureEndpoint() {
    if (endpoint) {
      try {
        await probe(endpoint)
        return endpoint
      } catch {
        endpoint = ''
        if (ownedProcess && !ownedProcessClosed) {
          throw new AliceChromeError('MCP_DISCONNECTED', 'Alice Chrome DevTools disconnected. Close the Alice Chrome window and try again.')
        }
      }
    }
    const launched = await start()
    return launched.endpoint
  }

  async function stopOwnedChrome() {
    const child = ownedProcess
    ownedProcess = null
    endpoint = ''
    if (!child || ownedProcessClosed) return { closed: false, owned: false }
    ownedProcessClosed = true
    try { child.kill() } catch {}
    return { closed: true, owned: true }
  }

  async function clearData({ dataTypes = [] } = {}) {
    const selected = new Set(dataTypes)
    await stopOwnedChrome()
    // Profile removal is intentionally limited to this exact dedicated
    // directory. It can never touch the user's regular Chrome profile.
    if (selected.size > 0) {
      try { rmSync(profileDir, { recursive: true, force: true }) } catch (error) {
        throw new AliceChromeError('CLEAR_FAILED', 'Unable to clear Alice Chrome profile data.', error)
      }
    }
    return {
      cleared_data_types: [...selected],
      profile_dir: profileDir,
      profile_deleted: selected.size > 0,
      scope: 'alice_dedicated_chrome_only',
    }
  }

  return {
    start,
    ensureEndpoint,
    stopOwnedChrome,
    clearData,
    getState: state,
    getProfileDir: () => profileDir,
  }
}

module.exports = {
  AliceChromeError,
  DEVTOOLS_ACTIVE_PORT_FILE,
  LOOPBACK_HOST,
  PROFILE_DIRECTORY_NAME,
  assertDedicatedProfileDir,
  chromeCandidates,
  chromeLaunchArgs,
  createAliceChromeManager,
  devtoolsUrl,
  findLoopbackPort,
  isGoogleChromeExecutable,
  isLoopbackDevtoolsUrl,
  readDevToolsActivePort,
  requestJson,
  resolveDedicatedProfileDir,
  resolveGoogleChromeExecutable,
  waitForDevtools,
}
