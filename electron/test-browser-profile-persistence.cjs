'use strict'

const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const { spawnSync } = require('node:child_process')

const stage = process.env.ALICE_PROFILE_TEST_STAGE
if (!stage) {
  const electronPath = require('electron')
  const userData = fs.mkdtempSync(path.join(os.tmpdir(), 'alice-browser-profile-'))
  const run = nextStage => spawnSync(electronPath, [__filename], {
    env: {
      ...process.env,
      ALICE_PROFILE_TEST_STAGE: nextStage,
      ALICE_PROFILE_TEST_USER_DATA: userData,
    },
    encoding: 'utf8',
  })
  const write = run('write')
  if (write.status !== 0) throw new Error(write.stderr || write.stdout || 'profile write stage failed')
  const read = run('read')
  if (read.status !== 0) throw new Error(read.stderr || read.stdout || 'profile read stage failed')
  const parseResult = output => {
    const resultLine = String(output || '').trim().split(/\r?\n/).find(line => line.startsWith('PROFILE_RESULT='))
    return JSON.parse(String(resultLine || '').slice('PROFILE_RESULT='.length))
  }
  const result = parseResult(read.stdout)
  if (!result.persistentCookie) throw new Error('persistent cookie did not survive an Electron restart')
  if (!result.sessionCookie) throw new Error('session cookie did not survive an Electron restart')
  const clear = run('clear')
  if (clear.status !== 0) throw new Error(clear.stderr || clear.stdout || 'profile clear stage failed')
  const readAfterClear = run('read')
  if (readAfterClear.status !== 0) throw new Error(readAfterClear.stderr || readAfterClear.stdout || 'post-clear read stage failed')
  const clearedResult = parseResult(readAfterClear.stdout)
  if (clearedResult.persistentCookie || clearedResult.sessionCookie) {
    throw new Error('explicit cookie deletion was incorrectly restored from the encrypted session backup')
  }
  fs.rmSync(userData, { recursive: true, force: true })
  console.log('browser profile persistence test passed')
} else {
  const { app, session, safeStorage } = require('electron')
  const { BROWSER_EMBED_PARTITION } = require('./browser-embed-host.cjs')
  const { createBrowserSessionCookieStore } = require('./browser-session-cookies.cjs')
  app.setPath('userData', process.env.ALICE_PROFILE_TEST_USER_DATA)
  app.whenReady().then(async () => {
    const targetSession = session.fromPartition(BROWSER_EMBED_PARTITION)
    const cookieStore = createBrowserSessionCookieStore({
      backupFile: path.join(app.getPath('userData'), 'browser', 'session-cookies.safe'),
      getSession: () => targetSession,
      safeStorage,
      saveDelayMs: 0,
    })
    await cookieStore.restore()
    cookieStore.start()
    if (stage === 'write') {
      await targetSession.cookies.set({
        url: 'https://persist.example/',
        name: 'persistent-cookie',
        value: 'kept',
        expirationDate: Math.floor(Date.now() / 1000) + 86_400,
      })
      await targetSession.cookies.set({
        url: 'https://persist.example/',
        name: 'session-cookie',
        value: 'kept',
      })
      await targetSession.cookies.flushStore()
      await cookieStore.flush()
    } else if (stage === 'clear') {
      await targetSession.clearData({ dataTypes: ['cookies'] })
      await cookieStore.flush()
    } else {
      const cookies = await targetSession.cookies.get({ url: 'https://persist.example/' })
      console.log(`PROFILE_RESULT=${JSON.stringify({
        persistentCookie: cookies.some(cookie => cookie.name === 'persistent-cookie' && cookie.value === 'kept'),
        sessionCookie: cookies.some(cookie => cookie.name === 'session-cookie' && cookie.value === 'kept'),
      })}`)
    }
    app.quit()
  }).catch(error => {
    console.error(error)
    app.exit(1)
  })
}
