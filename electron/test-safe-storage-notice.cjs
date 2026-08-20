'use strict'

const assert = require('node:assert/strict')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const {
  createSafeStorageNotice,
  noticeContent,
} = require('./safe-storage-notice.cjs')

async function main() {
  const preferenceDir = fs.mkdtempSync(path.join(os.tmpdir(), 'alice-safe-storage-notice-'))
  const consentFile = path.join(preferenceDir, 'safe-storage-consent.json')
  const mainSource = fs.readFileSync(path.join(__dirname, 'main.cjs'), 'utf8')
  assert.doesNotMatch(
    mainSource,
    /if \(assignAsMain\) await browserEmbedHost\.prime\(window\)/,
    'creating the app window must not eagerly create the browser WebContents',
  )
  const readyBlock = mainSource.slice(mainSource.indexOf('app.whenReady().then(async () => {'))
  assert.doesNotMatch(
    readyBlock.slice(0, readyBlock.indexOf('await createWindow({ loadStartup: true })')),
    /browserSessionCookieStore\.(restore|start)/,
    'startup must not read encrypted browser session data',
  )
  assert.match(
    mainSource,
    /await ensureBrowserSecureStorageReady\(\)\s+await browserEmbedHost\.prime\(mainWindow\)/,
    'the purpose notice must run immediately before lazy browser creation',
  )

  const calls = []
  const dialog = {
    async showMessageBox(...args) {
      calls.push({ mode: 'async', options: args.at(-1) })
      return { response: 0 }
    },
    showMessageBoxSync(...args) {
      calls.push({ mode: 'sync', options: args.at(-1) })
      return 0
    },
  }
  const notice = createSafeStorageNotice({ dialog, platform: 'darwin', consentFile })
  assert.equal(calls.length, 0, 'constructing the notice must not prompt at startup')
  assert.equal(await notice.request('browser-profile'), true)
  assert.equal(calls.length, 1)
  assert.match(calls[0].options.detail, /Cookie、会话及网站登录状态/)
  assert.match(calls[0].options.detail, /Mac 登录密码/)
  assert.match(calls[0].options.detail, /Alice 无法读取，也不会上传/)
  assert.match(calls[0].options.detail, /仍可继续浏览网页/)
  assert.equal(calls[0].options.buttons[1], '不使用安全存储')
  assert.equal(await notice.request('browser-profile'), true)
  assert.equal(calls.length, 1, 'acknowledged notice should not repeat in one process')
  assert.equal(notice.requestSync('saved-secrets'), true)
  assert.equal(calls.length, 2, 'different protected purposes require their own explanation')
  assert.match(calls[1].options.detail, /API 密钥、访问令牌/)
  assert.equal(notice.isAcknowledged('browser-profile'), true)
  assert.equal(notice.isAcknowledged('saved-secrets'), true)
  assert.equal(fs.statSync(consentFile).mode & 0o777, 0o600)

  let reloadedCalls = 0
  const reloaded = createSafeStorageNotice({
    platform: 'darwin',
    consentFile,
    dialog: {
      async showMessageBox() { reloadedCalls += 1; return { response: 0 } },
      showMessageBoxSync() { reloadedCalls += 1; return 0 },
    },
  })
  assert.equal(await reloaded.request('browser-profile'), true)
  assert.equal(reloaded.requestSync('saved-secrets'), true)
  assert.equal(reloadedCalls, 0, 'persisted approvals must not prompt again after restart')

  let cancelCalls = 0
  const cancelled = createSafeStorageNotice({
    platform: 'darwin',
    dialog: {
      async showMessageBox() {
        cancelCalls += 1
        return { response: 1 }
      },
      showMessageBoxSync() {
        cancelCalls += 1
        return 1
      },
    },
  })
  assert.equal(await cancelled.request('browser-profile'), false)
  assert.equal(await cancelled.request('browser-profile'), false)
  assert.equal(cancelCalls, 2, 'declining must leave a future explicit browser attempt available')

  const secretCopy = noticeContent('saved-secrets')
  assert.match(secretCopy.detail, /API 密钥、访问令牌/)
  assert.match(secretCopy.detail, /Mac 登录密码/)
  assert.match(secretCopy.detail, /本地文件加密/)

  let nonMacCalls = 0
  const nonMac = createSafeStorageNotice({
    platform: 'linux',
    dialog: {
      async showMessageBox() { nonMacCalls += 1; return { response: 0 } },
      showMessageBoxSync() { nonMacCalls += 1; return 0 },
    },
  })
  assert.equal(nonMac.requestSync('saved-secrets'), true)
  assert.equal(nonMacCalls, 0)

  fs.rmSync(preferenceDir, { recursive: true, force: true })

  console.log('safe storage notice tests passed')
}

main().catch(error => {
  console.error(error)
  process.exitCode = 1
})
