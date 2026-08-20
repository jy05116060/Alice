import { spawn } from 'node:child_process'
import { EventEmitter } from 'node:events'
import fs from 'node:fs'
import http from 'node:http'
import net from 'node:net'
import os from 'node:os'
import path from 'node:path'
import { createRequire } from 'node:module'
import WebSocket from 'ws'

const require = createRequire(import.meta.url)
const { CdpNetworkRecorder } = require('../electron/network-diagnostics.cjs')

function parseArgs(argv) {
  const options = {}
  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index]
    if (!token.startsWith('--')) throw new Error(`unexpected argument: ${token}`)
    const value = argv[index + 1]
    if (!value || value.startsWith('--')) throw new Error(`missing value for ${token}`)
    options[token.slice(2)] = value
    index += 1
  }
  return options
}

function defaultChromePath() {
  const candidates = process.arch === 'arm64'
    ? [
        '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
        'build/playwright-browsers/mac-arm64/chromium-1232/chrome-mac-arm64/Google Chrome for Testing.app/Contents/MacOS/Google Chrome for Testing',
      ]
    : [
        '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
        'build/playwright-browsers/mac-x64/chromium-1217/chrome-mac-x64/Google Chrome for Testing.app/Contents/MacOS/Google Chrome for Testing',
      ]
  return candidates.map(candidate => path.resolve(candidate)).find(candidate => fs.existsSync(candidate)) || null
}

function reserveLoopbackPort() {
  return new Promise((resolve, reject) => {
    const server = net.createServer()
    server.unref()
    server.once('error', reject)
    server.listen(0, '127.0.0.1', () => {
      const address = server.address()
      server.close(error => {
        if (error) reject(error)
        else resolve(address.port)
      })
    })
  })
}

function readJson(port, pathname) {
  return new Promise((resolve, reject) => {
    const request = http.get({ hostname: '127.0.0.1', port, path: pathname, timeout: 2_000 }, response => {
      const chunks = []
      response.on('data', chunk => chunks.push(chunk))
      response.on('end', () => {
        try { resolve(JSON.parse(Buffer.concat(chunks).toString('utf8'))) }
        catch (error) { reject(error) }
      })
    })
    request.on('timeout', () => request.destroy(new Error('CDP target lookup timed out')))
    request.on('error', reject)
  })
}

class RawCdpDebugger extends EventEmitter {
  constructor(socket) {
    super()
    this.socket = socket
    this.attached = false
    this.sequence = 0
    this.pending = new Map()
    socket.on('message', bytes => {
      let message
      try { message = JSON.parse(String(bytes)) } catch { return }
      if (message.id) {
        const pending = this.pending.get(message.id)
        if (!pending) return
        this.pending.delete(message.id)
        if (message.error) pending.reject(new Error(message.error.message || 'CDP command failed'))
        else pending.resolve(message.result || {})
        return
      }
      if (message.method) this.emit('message', {}, message.method, message.params || {})
    })
    socket.on('close', () => {
      const wasAttached = this.attached
      this.attached = false
      for (const pending of this.pending.values()) pending.reject(new Error('CDP socket closed'))
      this.pending.clear()
      if (wasAttached) this.emit('detach', {}, 'connection closed')
    })
  }

  attach() { this.attached = true }
  isAttached() { return this.attached && this.socket.readyState === WebSocket.OPEN }
  sendCommand(method, params = {}) {
    if (!this.isAttached()) return Promise.reject(new Error('CDP socket is not attached'))
    const id = ++this.sequence
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject })
      this.socket.send(JSON.stringify({ id, method, params }), error => {
        if (!error) return
        this.pending.delete(id)
        reject(error)
      })
    })
  }
  detach() {
    if (!this.attached) return
    this.attached = false
    this.socket.close()
  }
}

function connectSocket(url) {
  return new Promise((resolve, reject) => {
    const socket = new WebSocket(url)
    socket.once('open', () => resolve(socket))
    socket.once('error', reject)
  })
}

async function waitForPageTarget(port, timeoutMs = 10_000) {
  const startedAt = Date.now()
  while (Date.now() - startedAt < timeoutMs) {
    try {
      const targets = await readJson(port, '/json/list')
      const page = targets.find(target => target.type === 'page' && target.webSocketDebuggerUrl)
      if (page) return page
    } catch {}
    await new Promise(resolve => setTimeout(resolve, 100))
  }
  throw new Error('Chrome page target did not become available')
}

async function stopChild(child) {
  if (!child || child.exitCode !== null) return
  child.kill('SIGTERM')
  await Promise.race([
    new Promise(resolve => child.once('exit', resolve)),
    new Promise(resolve => setTimeout(resolve, 2_000)),
  ])
  if (child.exitCode === null) child.kill('SIGKILL')
}

async function main() {
  const options = parseArgs(process.argv.slice(2))
  const chromePath = path.resolve(options.chrome || defaultChromePath() || '')
  if (!chromePath || !fs.existsSync(chromePath)) throw new Error('Chrome executable was not found')
  const outputDir = path.resolve(options['output-dir'] || 'data/network-audits')
  const profileDir = fs.mkdtempSync(path.join(os.tmpdir(), 'alice-chrome-baseline-'))
  // Chrome explicitly treats --remote-debugging-port=0 as an automation
  // signal. A fixed ephemeral loopback port keeps the observer read-only
  // without unnecessarily changing navigator.webdriver in the baseline.
  const port = await reserveLoopbackPort()
  const child = spawn(chromePath, [
    '--remote-debugging-address=127.0.0.1',
    `--remote-debugging-port=${port}`,
    `--user-data-dir=${profileDir}`,
    '--no-first-run',
    '--no-default-browser-check',
    '--window-size=1280,840',
    'about:blank',
  ], { stdio: 'ignore' })

  let recorder
  let finished = false
  const finish = async reason => {
    if (finished) return
    finished = true
    try {
      const result = await recorder?.stop({ reason })
      if (result?.path) process.stdout.write(`SAVED ${result.path}\n`)
    } finally {
      await stopChild(child)
      if (path.basename(profileDir).startsWith('alice-chrome-baseline-')) {
        try { fs.rmSync(profileDir, { recursive: true, force: true }) } catch {}
      }
    }
  }

  try {
    const target = await waitForPageTarget(port)
    const socket = await connectSocket(target.webSocketDebuggerUrl)
    const debuggerApi = new RawCdpDebugger(socket)
    recorder = new CdpNetworkRecorder({
      webContents: {
        id: 'chrome-baseline',
        debugger: debuggerApi,
        isDestroyed: () => child.exitCode !== null,
      },
      outputDir,
      source: 'chrome-cdp-observer',
    })
    await recorder.start()
    process.stdout.write(`READY Chrome network recording started; type STOP and press Enter when the manual visit is complete.\n`)
    process.stdin.setEncoding('utf8')
    process.stdin.on('data', chunk => {
      if (/\bSTOP\b/i.test(chunk)) finish('manual-stop').then(() => process.exit(0))
    })
    process.on('SIGINT', () => finish('sigint').then(() => process.exit(0)))
    process.on('SIGTERM', () => finish('sigterm').then(() => process.exit(0)))
    child.once('exit', () => finish('chrome-exit').then(() => process.exit(0)))
    process.stdin.resume()
  } catch (error) {
    await finish('startup-error')
    throw error
  }
}

main().catch(error => {
  console.error(error.message)
  process.exitCode = 1
})
