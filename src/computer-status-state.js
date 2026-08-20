/**
 * computer-status-state.js
 * ─────────────────────────────────────────────────────────────────────────────
 * 「电脑动态」面板（本机实时状态面板）的开关状态。
 *
 * 与 typhoon.js / worldcup.js 的 panel-state 同一套路：后端持有唯一真相，
 * Agent 工具（computer_status_mode）改这里并 emit 事件，前端 brain-ui 收事件后
 * 真正把面板显示出来；用户在界面里按键开/关时，前端再 POST 回来对齐状态。
 *
 * 注意：面板本身的数据（CPU/内存/磁盘/温度/网速）不在这里，见 system-status.js。
 */

const PANEL_CONTEXT_TTL_MS = 30 * 60 * 1000

let panelState = {
  active: false,
  updatedAtMs: 0,
  openedAtMs: 0,
  openEventPending: false,
  source: 'unknown',
}

let panelActiveUntilMs = 0

export function setComputerStatusPanelState({ active, source = 'unknown' } = {}) {
  if (typeof active !== 'boolean') return getComputerStatusPanelState()
  const now = Date.now()
  const justOpened = active && !panelState.active
  panelState = {
    active,
    updatedAtMs: now,
    openedAtMs: justOpened ? now : (active ? panelState.openedAtMs : 0),
    openEventPending: justOpened ? true : (active ? panelState.openEventPending : false),
    source,
  }
  panelActiveUntilMs = active ? now + PANEL_CONTEXT_TTL_MS : 0
  return getComputerStatusPanelState()
}

export function getComputerStatusPanelState() {
  const now = Date.now()
  const remaining = Math.max(0, panelActiveUntilMs - now)
  const justOpened = panelState.active && panelState.openEventPending
  return {
    ...panelState,
    updatedAt: panelState.updatedAtMs ? new Date(panelState.updatedAtMs).toISOString() : null,
    openedAt: panelState.openedAtMs ? new Date(panelState.openedAtMs).toISOString() : null,
    justOpened,
    contextActive: panelState.active,
    contextTtlSeconds: panelState.active ? Math.round(remaining / 1000) : 0,
  }
}
