'use strict'

const assert = require('assert')
const { EventEmitter } = require('events')
const fs = require('fs')
const os = require('os')
const path = require('path')
const {
  AliceChromeError,
  chromeLaunchArgs,
  createAliceChromeManager,
  isLoopbackDevtoolsUrl,
  resolveDedicatedProfileDir,
  resolveGoogleChromeExecutable,
} = require('./alice-chrome.cjs')
const {
  bundledBrowserRoot,
  bundledBrowserTarget,
  bundledNodeRuntimeTarget,
  resolveBundledChromiumExecutable,
  resolveBundledNodeExecutable,
} = require('./playwright-runtime.cjs')

let failed = 0
function check(condition, label, detail = '') {
  if (condition) return console.log(`PASS: ${label}`)
  failed += 1
  console.error(`FAIL: ${label}${detail ? `\n  ${detail}` : ''}`)
}

function childProcess() {
  const child = new EventEmitter()
  child.kills = 0
  child.kill = () => { child.kills += 1; return true }
  return child
}

async function rejectsCode(promise, code, label) {
  try {
    await promise
    check(false, label, 'expected rejection')
  } catch (error) {
    check(error?.code === code, label, `${error?.code}: ${error?.message}`)
  }
}

async function main() {
  const userDataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'alice-chrome-profile-'))
  try {
    const profileDir = resolveDedicatedProfileDir(userDataDir)
    check(profileDir === path.join(userDataDir, 'browser-profiles', 'alice-chrome'),
      'dedicated profile is always below Alice application data')
    check(!profileDir.includes(path.join('Google', 'Chrome', 'Default')),
      'dedicated profile never resolves to the user default Chrome profile')

    const args = chromeLaunchArgs({ profileDir, port: 9222 })
    check(args.includes(`--user-data-dir=${profileDir}`)
      && args.includes('--remote-debugging-address=127.0.0.1')
      && args.includes('--remote-debugging-port=9222')
      && !args.some(value => /headless|remote-debugging-address=(?!127\.0\.0\.1)/.test(value)),
    'Chrome launch is visible, uses the isolated profile, and binds DevTools only to loopback', args.join(' '))
    check(isLoopbackDevtoolsUrl('http://127.0.0.1:9222')
      && !isLoopbackDevtoolsUrl('http://0.0.0.0:9222')
      && !isLoopbackDevtoolsUrl('http://localhost:9222')
      && !isLoopbackDevtoolsUrl('https://127.0.0.1:9222'),
    'only an explicit http://127.0.0.1 DevTools endpoint is accepted')

    assert.throws(
      () => resolveGoogleChromeExecutable({ platform: 'darwin', env: {}, existsSync: () => false }),
      error => error?.code === 'CHROME_NOT_INSTALLED',
    )
    console.log('PASS: missing Google Chrome has an actionable CHROME_NOT_INSTALLED error')

    const bundledRoot = path.join(userDataDir, 'bundled-browser')
    const bundledExecutable = path.join(
      bundledRoot,
      'chromium-1232',
      'chrome-mac-arm64',
      'Google Chrome for Testing.app',
      'Contents',
      'MacOS',
      'Google Chrome for Testing',
    )
    fs.mkdirSync(path.dirname(bundledExecutable), { recursive: true })
    fs.writeFileSync(bundledExecutable, '')
    check(resolveBundledChromiumExecutable({ root: bundledRoot, platform: 'darwin', arch: 'arm64' }) === bundledExecutable,
      'bundled Chromium executable is resolved from the packaged resource tree')
    check(resolveGoogleChromeExecutable({
      platform: 'darwin',
      arch: 'arm64',
      env: {},
      bundledBrowserRoot: bundledRoot,
    }) === bundledExecutable, 'bundled Chromium is preferred without a system Chrome installation')
    check(bundledBrowserTarget('win32', 'x64') === 'win-x64'
      && bundledBrowserTarget('darwin', 'arm64') === 'mac-arm64',
    'build targets map to the matching bundled browser architecture')
    check(bundledBrowserRoot({
      isPackaged: true,
      resourcesPath: '/app/resources',
      platform: 'darwin',
      arch: 'arm64',
    }) === path.join('/app/resources', 'playwright-browsers'),
    'packaged app resolves its self-contained browser below resources')
    check(bundledNodeRuntimeTarget('darwin', 'arm64') === 'mac-arm64'
      && resolveBundledNodeExecutable({
        isPackaged: true,
        resourcesPath: '/app/resources',
        platform: 'darwin',
        arch: 'arm64',
        existsSync: value => value === path.join('/app/resources', 'node-runtime', 'node'),
      }) === path.join('/app/resources', 'node-runtime', 'node'),
    'packaged app resolves its architecture-matched MCP Node runtime below resources')

    const children = []
    const launches = []
    const manager = createAliceChromeManager({
      userDataDir,
      resolveExecutable: () => '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
      findPort: async () => 9222 + children.length,
      spawn: (executable, launchArgs, options) => {
        launches.push({ executable, launchArgs, options })
        const child = childProcess()
        children.push(child)
        return child
      },
      waitForEndpoint: async () => ({ Browser: 'Chrome/real' }),
      probe: async () => ({ Browser: 'Chrome/real' }),
      logger: { info() {}, warn() {} },
    })
    const started = await manager.start()
    check(started.endpoint === 'http://127.0.0.1:9222' && started.ownedByAlice === true,
      'manager starts exactly one owned dedicated Chrome process')
    check(launches.length === 1 && launches[0].launchArgs.includes(`--user-data-dir=${profileDir}`),
      'launch never imports, copies, or attaches a user Chrome profile')

    children[0].emit('exit', 0, null)
    check(manager.getState().status === 'idle' && manager.getState().ownedByAlice === false,
      'user-closing the dedicated Chrome window clears ownership and connection state')
    const recovered = await manager.ensureEndpoint()
    check(recovered === 'http://127.0.0.1:9223' && children.length === 2,
      'a later browser action can recover by launching a new dedicated Chrome instance')
    const stopped = await manager.stopOwnedChrome()
    check(stopped.closed === true && children[1].kills === 1,
      'application shutdown closes only the Chrome process Alice started')

    const reusedDir = fs.mkdtempSync(path.join(os.tmpdir(), 'alice-chrome-reused-'))
    const reusedProfile = resolveDedicatedProfileDir(reusedDir)
    fs.mkdirSync(reusedProfile, { recursive: true })
    fs.writeFileSync(path.join(reusedProfile, 'DevToolsActivePort'), '9333\n/devtools/browser/test')
    let reusableSpawned = false
    const reusable = createAliceChromeManager({
      userDataDir: reusedDir,
      resolveExecutable: () => '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
      spawn: () => { reusableSpawned = true; return childProcess() },
      probe: async () => ({ Browser: 'Chrome/real' }),
      logger: { info() {}, warn() {} },
    })
    const existing = await reusable.start()
    const untouched = await reusable.stopOwnedChrome()
    check(existing.reused === true && !reusableSpawned && untouched.owned === false,
      'an already-running dedicated profile may be reused but is never killed as Alice-owned')
    fs.rmSync(reusedDir, { recursive: true, force: true })

    const portFailure = createAliceChromeManager({
      userDataDir: fs.mkdtempSync(path.join(os.tmpdir(), 'alice-chrome-port-')),
      resolveExecutable: () => '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
      findPort: async () => { throw new Error('in use') },
      logger: { info() {}, warn() {} },
    })
    await rejectsCode(portFailure.start(), 'DEBUG_PORT_UNAVAILABLE', 'unavailable loopback debug port gives a recoverable error')

    // Set up a ready endpoint using a manager with a probe that changes after start.
    const recoverable = createAliceChromeManager({
      userDataDir: fs.mkdtempSync(path.join(os.tmpdir(), 'alice-chrome-mcp-')),
      resolveExecutable: () => '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
      findPort: async () => 9445,
      spawn: () => childProcess(),
      waitForEndpoint: async () => ({}),
      probe: async () => {
        throw new Error('disconnected')
      },
      logger: { info() {}, warn() {} },
    })
    await recoverable.start()
    await rejectsCode(recoverable.ensureEndpoint(), 'MCP_DISCONNECTED', 'MCP/DevTools disconnect tells the user how to recover')
  } finally {
    fs.rmSync(userDataDir, { recursive: true, force: true })
  }
}

main().catch(error => {
  failed += 1
  console.error(error.stack || error)
  process.exitCode = 1
}).finally(() => {
  if (failed === 0) console.log('All Alice dedicated Chrome lifecycle tests passed.')
  else process.exitCode = 1
})
