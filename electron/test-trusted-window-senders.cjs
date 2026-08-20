'use strict'

const assert = require('node:assert/strict')
const { createTrustedWindowSenderGuard } = require('./trusted-window-senders.cjs')

function fakeWindow() {
  const webContents = {
    destroyed: false,
    isDestroyed() { return this.destroyed },
  }
  return {
    destroyed: false,
    webContents,
    isDestroyed() { return this.destroyed },
  }
}

const startup = fakeWindow()
const replacement = fakeWindow()
const attacker = fakeWindow()
let mainWindow = startup
const guard = createTrustedWindowSenderGuard({ getMainWindow: () => mainWindow })

assert.equal(guard.requireTrustedSender({ sender: startup.webContents }), startup)
assert.throws(
  () => guard.requireTrustedSender({ sender: replacement.webContents }),
  /only accepted from the main window/,
)

guard.trustReplacement(replacement)
assert.equal(
  guard.requireTrustedSender({ sender: replacement.webContents }),
  replacement,
  'a registered replacement may initialize before the main-window pointer switches',
)
assert.throws(
  () => guard.requireTrustedSender({ sender: attacker.webContents }),
  /only accepted from the main window/,
  'an unrelated renderer must never control the browser embed',
)

mainWindow = replacement
guard.revokeReplacement(replacement)
assert.equal(guard.requireTrustedSender({ sender: replacement.webContents }), replacement)
assert.throws(() => guard.requireTrustedSender({ sender: startup.webContents }))

replacement.webContents.destroyed = true
assert.throws(() => guard.requireTrustedSender({ sender: replacement.webContents }))

console.log('Trusted replacement-window sender tests passed.')
