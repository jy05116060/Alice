'use strict'

function createTrustedWindowSenderGuard({ getMainWindow }) {
  const replacements = new Set()

  function isUsableWindow(window) {
    return Boolean(
      window
      && !window.isDestroyed()
      && window.webContents
      && !window.webContents.isDestroyed(),
    )
  }

  function trustReplacement(window) {
    if (!isUsableWindow(window)) throw new Error('cannot trust a destroyed replacement window')
    replacements.add(window)
  }

  function revokeReplacement(window) {
    replacements.delete(window)
  }

  function requireTrustedSender(event) {
    const mainWindow = getMainWindow()
    const candidates = [mainWindow, ...replacements]
    const window = candidates.find(candidate => (
      isUsableWindow(candidate) && event?.sender === candidate.webContents
    ))
    if (!window || event.sender.isDestroyed()) {
      throw new Error('browser embed requests are only accepted from the main window')
    }
    return window
  }

  return {
    requireTrustedSender,
    revokeReplacement,
    trustReplacement,
  }
}

module.exports = { createTrustedWindowSenderGuard }
