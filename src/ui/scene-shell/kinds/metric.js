// kind: metric —— 单个关键数值 + 标签 + 可选趋势。
// data: { label, value, unit?, trend? }  trend ∈ up|down|flat  ·  上行 intent:无。

import { el, setText } from './dom.js'

const TREND = {
  up:   { glyph: '▲', cls: 'up' },
  down: { glyph: '▼', cls: 'down' },
  flat: { glyph: '—', cls: 'flat' },
}

export const metric = {
  render(data = {}) {
    const t = TREND[data.trend]
    return el('div', { class: 'k-metric' }, [
      el('div', { class: 's-title', text: data.label || '' }),
      el('div', { class: 'm-row' }, [
        el('span', { class: 'm-value', text: data.value == null ? '' : String(data.value) }),
        data.unit ? el('span', { class: 'm-unit', text: data.unit }) : null,
        t ? el('span', { class: `m-trend ${t.cls}`, text: t.glyph }) : null,
      ]),
    ])
  },

  enter() {},
  exit() {},

  // morph:数值原地翻动 + 趋势重算。数值变化是 metric 最常见的更新,做得最讲究。
  morph(el_, prev = {}, next = {}) {
    const label = el_.querySelector('.s-title')
    const value = el_.querySelector('.m-value')
    const row = el_.querySelector('.m-row')
    let unit = el_.querySelector('.m-unit')
    let trend = el_.querySelector('.m-trend')

    if (label) setText(label, next.label || '')
    if (value) setText(value, next.value == null ? '' : String(next.value))

    if (next.unit && !unit) {
      unit = el('span', { class: 'm-unit', text: next.unit })
      if (trend) row.insertBefore(unit, trend); else row.appendChild(unit)
    } else if (!next.unit && unit) {
      unit.remove()
    } else if (unit) {
      setText(unit, next.unit)
    }

    const t = TREND[next.trend]
    if (t && !trend) {
      trend = el('span', { class: `m-trend ${t.cls}`, text: t.glyph })
      row.appendChild(trend)
    } else if (!t && trend) {
      trend.remove()
    } else if (t && trend) {
      trend.className = `m-trend ${t.cls}`
      setText(trend, t.glyph)
    }
  },
}
