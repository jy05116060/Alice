const DISPLAY_MODES = new Set(['card', 'window'])

export function normalizeBrowserDisplayMode(value) {
  const mode = String(value || '').trim().toLowerCase()
  return DISPLAY_MODES.has(mode) ? mode : ''
}
export function execBrowserSetDisplayMode({ mode, reason = '' } = {}, context = {}) {
  const normalizedMode = normalizeBrowserDisplayMode(mode)
  if (!normalizedMode) {
    return JSON.stringify({
      ok: false,
      tool: 'browser_set_display_mode',
      error: 'mode must be "card" or "window"',
    })
  }

  const state = context.browserDisplayState
  if (state && typeof state === 'object') state.mode = normalizedMode
  context.browserDisplayMode = normalizedMode
  context.browserSurface = 'alice_chrome'

  return JSON.stringify({
    ok: true,
    tool: 'browser_set_display_mode',
    browser_display_mode: normalizedMode,
    reason: String(reason || '').trim().slice(0, 160),
    browser_preview: {
      mode: normalizedMode,
      state: 'ready',
      action: 'browser_set_display_mode',
      renderer: 'webcontentsview',
      surface: 'alice_live_browser',
      native_view: true,
      visible_window: normalizedMode === 'window',
      transition: true,
    },
  })
}
