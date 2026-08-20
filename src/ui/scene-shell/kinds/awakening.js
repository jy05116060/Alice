// kind: awakening —— 觉醒期探索反馈。单个 surface 逐条 morph 过每次发现(index 1→2→…),
// 觉醒结束时 ui_set(remove) 收起。建议 intent=ambient(角落低调,不抢焦点)。
//
// data: { index, total, title, finding, emoji? }
// 上行 intent:无(纯展示;生命周期由 Agent 在觉醒末尾移除)。

import { el, setText } from './dom.js'

const MAX_DOTS = 15

function dotsFor(index = 1, total = 2) {
  const idx = Math.max(1, Math.min(Number(index) || 1, total))
  const n = Math.min(total, MAX_DOTS)
  return Array.from({ length: n }, (_, i) => {
    const k = i + 1
    const cls = k < idx ? 'aw-dot done' : k === idx ? 'aw-dot active' : 'aw-dot'
    return el('span', { class: cls })
  })
}

export const awakening = {
  render(data = {}) {
    const { index = 1, total = 2, title = '探索中', finding = '', emoji = '🔍' } = data
    return el('div', { class: 'k-awakening' }, [
      el('div', { class: 'aw-head' }, [
        el('span', { class: 'aw-emoji', text: emoji }),
        el('span', { class: 'aw-title', text: title }),
        el('span', { class: 'aw-badge', text: `${Math.min(index, total)} / ${total}` }),
      ]),
      el('div', { class: 'aw-finding', text: finding || '…' }),
      el('div', { class: 'aw-dots' }, dotsFor(index, total)),
    ])
  },

  enter() {},
  exit() {},

  // morph:标题/发现/计数原地更新,进度点重算(发现是离散更替,逐项重建)。
  morph(el_, prev = {}, next = {}) {
    const { index = 1, total = 2, title = '探索中', finding = '', emoji = '🔍' } = next
    const emojiEl = el_.querySelector('.aw-emoji')
    const titleEl = el_.querySelector('.aw-title')
    const badgeEl = el_.querySelector('.aw-badge')
    const findEl = el_.querySelector('.aw-finding')
    const dotsEl = el_.querySelector('.aw-dots')
    if (emojiEl) setText(emojiEl, emoji)
    if (titleEl) setText(titleEl, title)
    if (badgeEl) setText(badgeEl, `${Math.min(index, total)} / ${total}`)
    if (findEl) setText(findEl, finding || '…')
    if (dotsEl) dotsEl.replaceChildren(...dotsFor(index, total))
  },
}
