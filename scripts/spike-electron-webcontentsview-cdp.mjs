import assert from 'node:assert/strict'
import fs from 'node:fs'
import http from 'node:http'
import net from 'node:net'
import os from 'node:os'
import path from 'node:path'
import { spawn } from 'node:child_process'
import { fileURLToPath } from 'node:url'

import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js'
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js'
import { createConnection } from '@playwright/mcp'
import { chromium } from 'playwright'
import { connectEmbeddedPlaywright } from '../src/mcp/embedded-playwright-connection.js'
import { createBuiltInEmbeddedPlaywrightConfig } from '../src/mcp/playwright-server.js'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const fixturePath = path.join(root, 'scripts', 'fixtures', 'electron-webcontentsview-cdp-fixture.cjs')
const electronPath = path.join(root, 'node_modules', '.bin', 'electron')
const mcpCliPath = path.join(root, 'node_modules', '@playwright', 'mcp', 'cli.js')
const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'alice-webcontentsview-cdp-'))
const records = []

function record(label, detail = '') {
  records.push({ label, detail })
  console.log(`PASS: ${label}${detail ? `\n  ${detail}` : ''}`)
}

function freePort() {
  return new Promise((resolve, reject) => {
    const server = net.createServer()
    server.unref()
    server.once('error', reject)
    server.listen(0, '127.0.0.1', () => {
      const { port } = server.address()
      server.close(error => error ? reject(error) : resolve(port))
    })
  })
}

async function pollJson(url, { timeoutMs = 15_000 } = {}) {
  const deadline = Date.now() + timeoutMs
  let lastError
  while (Date.now() < deadline) {
    try {
      return await new Promise((resolve, reject) => {
        const request = http.get(url, { timeout: 1_000 }, response => {
          const chunks = []
          response.on('data', chunk => chunks.push(chunk))
          response.on('end', () => {
            try {
              resolve(JSON.parse(Buffer.concat(chunks).toString('utf8')))
            } catch (error) {
              reject(error)
            }
          })
        })
        request.on('timeout', () => request.destroy(new Error('request timeout')))
        request.on('error', reject)
      })
    } catch (error) {
      lastError = error
      await new Promise(resolve => setTimeout(resolve, 100))
    }
  }
  throw lastError || new Error(`Timed out waiting for ${url}`)
}

async function launchFixture(label, userDataDir) {
  const port = await freePort()
  const readyFile = path.join(tempRoot, `${label}-ready.json`)
  const childEnv = {
    ...process.env,
    ALICE_CDP_SPIKE_PORT: String(port),
    ALICE_CDP_SPIKE_READY_FILE: readyFile,
    ALICE_CDP_SPIKE_USER_DATA: userDataDir,
  }
  delete childEnv.ELECTRON_RUN_AS_NODE
  const child = spawn(electronPath, [fixturePath], {
    cwd: root,
    env: childEnv,
    stdio: ['ignore', 'pipe', 'pipe'],
  })
  let output = ''
  child.stdout.on('data', chunk => { output += chunk })
  child.stderr.on('data', chunk => { output += chunk })

  const version = await pollJson(`http://127.0.0.1:${port}/json/version`)
  const deadline = Date.now() + 15_000
  while (!fs.existsSync(readyFile) && Date.now() < deadline) {
    if (child.exitCode !== null) {
      throw new Error(`Electron fixture exited early (${child.exitCode})\n${output}`)
    }
    await new Promise(resolve => setTimeout(resolve, 100))
  }
  if (!fs.existsSync(readyFile)) {
    throw new Error(`Electron fixture did not become ready\n${output}`)
  }
  const ready = JSON.parse(fs.readFileSync(readyFile, 'utf8'))
  return {
    child,
    endpoint: `http://127.0.0.1:${port}`,
    output: () => output,
    ready,
    version,
  }
}

async function stopFixture(fixture) {
  if (!fixture || fixture.child.exitCode !== null) return
  try {
    await pollJson(`${fixture.ready.contentBaseUrl}/quit`, { timeoutMs: 1_000 })
  } catch {}
  const deadline = Date.now() + 3_000
  while (fixture.child.exitCode === null && Date.now() < deadline) {
    await new Promise(resolve => setTimeout(resolve, 50))
  }
  if (fixture.child.exitCode === null) fixture.child.kill('SIGTERM')
}

function resultText(result) {
  return (result?.content || [])
    .filter(item => item.type === 'text')
    .map(item => item.text)
    .join('\n')
}

async function directAndInMemoryTest(userDataDir) {
  const fixture = await launchFixture('in-memory', userDataDir)
  let browser
  let mcpClient
  let embeddedHandle
  let naiveServer
  let naiveClient
  try {
    record(
      'Electron 33.4.11 exposes a loopback CDP endpoint',
      `${fixture.version.Browser}; ${fixture.version['Protocol-Version']}`,
    )

    browser = await chromium.connectOverCDP(fixture.endpoint)
    const contexts = browser.contexts()
    const pages = contexts.flatMap((context, contextIndex) => (
      context.pages().map(page => ({ context, contextIndex, page, url: page.url() }))
    ))
    const brain = pages.find(entry => entry.url.includes('target=brain-ui'))
    const surface = pages.find(entry => entry.url.includes('target=browser-surface'))
    assert.ok(brain, `Brain UI target not found: ${JSON.stringify(pages.map(p => p.url))}`)
    assert.ok(surface, `browser surface target not found: ${JSON.stringify(pages.map(p => p.url))}`)
    assert.equal(
      brain.context,
      surface.context,
      'Electron WebContents unexpectedly mapped to separate Playwright BrowserContexts',
    )
    const surfaceCdpSession = await surface.context.newCDPSession(surface.page)
    const { targetInfo: surfaceTargetInfo } = await surfaceCdpSession.send('Target.getTargetInfo')
    await surfaceCdpSession.detach()
    const targetCatalog = await pollJson(`${fixture.endpoint}/json/list`)
    const catalogSurface = targetCatalog.find(target => target.url.includes('target=browser-surface'))
    assert.equal(surfaceTargetInfo.targetId, catalogSurface?.id)
    record(
      'the WebContentsView Page maps exactly to its Electron DevTools targetId',
      `targetId=${surfaceTargetInfo.targetId}; contexts=${contexts.length}; all partitions merged into context ${surface.contextIndex}`,
    )

    const originalWebContentsId = fixture.ready.browserWebContentsId
    const movedLarge = await pollJson(`${fixture.ready.contentBaseUrl}/move?host=large`)
    const movedSmall = await pollJson(`${fixture.ready.contentBaseUrl}/move?host=small`)
    assert.equal(movedLarge.browserWebContentsId, originalWebContentsId)
    assert.equal(movedSmall.browserWebContentsId, originalWebContentsId)
    assert.equal(surface.page.isClosed(), false)
    record(
      'one WebContentsView can move between small and large hosts without recreating its page',
      `webContents.id=${originalWebContentsId}; Page remained open`,
    )

    // Prove that contextGetter by itself is not sufficient: page enumeration
    // still exposes every Electron WebContents in the merged context.
    {
      const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair()
      naiveServer = await createConnection({
        browser: { browserName: 'chromium' },
        capabilities: ['core'],
        snapshot: { mode: 'none' },
        imageResponses: 'omit',
      }, async () => surface.context)
      naiveClient = new Client({ name: 'alice-naive-context-spike', version: '1.0.0' })
      await Promise.all([
        naiveServer.connect(serverTransport),
        naiveClient.connect(clientTransport),
      ])
      const naiveTabs = resultText(await naiveClient.callTool({
        name: 'browser_tabs',
        arguments: { action: 'list' },
      }))
      assert.match(naiveTabs, /Alice Brain UI spike/)
      assert.match(naiveTabs, /Alice browser surface spike/)
      record(
        'a raw contextGetter is insufficient because it exposes Brain UI as an MCP tab',
        naiveTabs.replaceAll('\n', ' | '),
      )
      await naiveClient.close()
      naiveClient = null
      await naiveServer.close()
      naiveServer = null
    }

    embeddedHandle = await connectEmbeddedPlaywright({
      useSidecar: true,
      target: {
        cdpEndpoint: fixture.endpoint,
        targetId: surfaceTargetInfo.targetId,
        webContentsId: originalWebContentsId,
        url: surface.page.url(),
      },
      mcpConfig: createBuiltInEmbeddedPlaywrightConfig({
        resourcesDir: root,
        sandboxDir: tempRoot,
        allowPrivateNetwork: false,
      }),
    })
    mcpClient = embeddedHandle.client

    const tabsBefore = resultText(await mcpClient.callTool({
      name: 'browser_tabs',
      arguments: { action: 'list' },
    }))
    assert.match(tabsBefore, /Alice browser surface spike/)
    assert.doesNotMatch(tabsBefore, /Alice Brain UI spike/)
    record(
      'the production sidecar exposes only the exact targetId page',
      tabsBefore.replaceAll('\n', ' | '),
    )

    const navigation = resultText(await mcpClient.callTool({
      name: 'browser_navigate',
      arguments: { url: 'https://example.com/?alice-mcp=in-memory' },
    }))
    assert.match(navigation, /Example Domain/)
    const brainState = await pollJson(`${fixture.ready.contentBaseUrl}/state`)
    assert.match(brainState.brainUrl, /target=brain-ui/)
    assert.match(brainState.browserUrl, /alice-mcp=in-memory/)
    record(
      'official Playwright MCP navigates the embedded page without touching Brain UI',
      `browser=${brainState.browserUrl}; brain=${brainState.brainUrl}`,
    )

    const marker = `persist-${Date.now()}`
    await surface.page.evaluate(value => {
      document.cookie = `alice_cdp_spike=${value}; expires=${new Date(Date.now() + 86_400_000).toUTCString()}; path=/; SameSite=Lax`
    }, marker)
    const stateWithCookie = await pollJson(`${fixture.ready.contentBaseUrl}/state`)
    assert.equal(
      stateWithCookie.exampleCookies.find(cookie => cookie.name === 'alice_cdp_spike')?.value,
      marker,
      `surface document cookie did not reach its Electron session: ${JSON.stringify(stateWithCookie)}`,
    )

    await mcpClient.close()
    mcpClient = null
    await new Promise(resolve => setTimeout(resolve, 150))
    const afterMcpClose = await pollJson(`${fixture.ready.contentBaseUrl}/state`)
    assert.match(afterMcpClose.brainUrl, /target=brain-ui/)
    assert.equal(afterMcpClose.browserWebContentsId, originalWebContentsId)
    record(
      'closing the sidecar MCP client does not close the Electron context or view',
      `webContents.id=${afterMcpClose.browserWebContentsId}`,
    )

    return marker
  } finally {
    await naiveClient?.close().catch(() => {})
    await naiveServer?.close().catch(() => {})
    await embeddedHandle?.close().catch(() => {})
    // Do not call browser.close(): for a CDP attachment that asks Chromium to
    // close the actual Electron browser. The fixture owns process lifetime.
    await stopFixture(fixture)
  }
}

async function persistenceTest(userDataDir, marker) {
  const fixture = await launchFixture('persistence', userDataDir)
  let browser
  try {
    browser = await chromium.connectOverCDP(fixture.endpoint)
    const surface = browser.contexts()
      .flatMap(context => context.pages().map(page => ({ context, page })))
      .find(entry => entry.page.url().includes('target=browser-surface'))
    assert.ok(surface)
    const state = await pollJson(`${fixture.ready.contentBaseUrl}/state`)
    assert.equal(
      state.exampleCookies.find(cookie => cookie.name === 'alice_cdp_spike')?.value,
      marker,
    )
    record(
      'the WebContentsView persistent session survives an Electron restart',
      `cookie alice_cdp_spike=${marker}`,
    )
  } finally {
    await stopFixture(fixture)
  }
}

async function cliCdpRiskTest(userDataDir) {
  const fixture = await launchFixture('cli-cdp', userDataDir)
  let client
  try {
    const transport = new StdioClientTransport({
      command: process.execPath,
      args: [
        mcpCliPath,
        '--cdp-endpoint', fixture.endpoint,
        '--codegen', 'none',
        '--image-responses', 'omit',
        '--output-mode', 'stdout',
        '--snapshot-mode', 'none',
      ],
      cwd: root,
      env: {
        PATH: process.env.PATH || '',
      },
      stderr: 'pipe',
    })
    client = new Client({ name: 'alice-cli-cdp-spike', version: '1.0.0' })
    await client.connect(transport)
    const tabs = resultText(await client.callTool({
      name: 'browser_tabs',
      arguments: { action: 'list' },
    }))
    const selectedBrain = tabs.includes('Alice Brain UI spike')
    const selectedSurface = tabs.includes('Alice browser surface spike')
    assert.ok(selectedBrain || selectedSurface, `CLI MCP returned no known Electron target: ${tabs}`)
    record(
      'CLI --cdp-endpoint attaches, but blindly chooses contexts()[0]',
      `visible target=${selectedBrain ? 'Brain UI (unsafe)' : 'browser surface (order-dependent)'}`,
    )

    await client.close()
    client = null
    await new Promise(resolve => setTimeout(resolve, 250))
    let postClose
    try {
      postClose = await pollJson(`${fixture.ready.contentBaseUrl}/state`, { timeoutMs: 1_000 })
    } catch {}
    if (!postClose) {
      record(
        'CLI connection disposal can close an attached Electron BrowserContext',
        'fixture control page became unreachable after MCP client close',
      )
    } else {
      const targetWasClosed = selectedBrain
        ? !postClose.brainUrl
        : !postClose.browserUrl
      record(
        'CLI connection disposal is not an ownership-safe API boundary',
        targetWasClosed
          ? 'the selected attached target was closed'
          : 'the current run survived, but @playwright/mcp disposal still calls BrowserContext.close()',
      )
    }
  } finally {
    await client?.close().catch(() => {})
    await stopFixture(fixture)
  }
}

const persistentUserData = path.join(tempRoot, 'electron-user-data')
try {
  const marker = await directAndInMemoryTest(persistentUserData)
  await persistenceTest(persistentUserData, marker)
  await cliCdpRiskTest(path.join(tempRoot, 'cli-electron-user-data'))
  console.log(`\n${records.length} Electron WebContentsView/CDP checks passed.`)
} finally {
  fs.rmSync(tempRoot, { recursive: true, force: true })
}
