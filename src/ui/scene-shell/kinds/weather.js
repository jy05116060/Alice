// kind: weather —— 天气展示。作为「领域专用 kind」的范例。
// data: { city, temp, condition, forecast?: [{ day, low, high, condition }] }
// 上行 intent:无。

import { el, setText } from './dom.js'

// 用 condition 文本粗略映射一个氛围图标 + 色调,纯呈现层决定(core 不下发图标)。
function glyphFor(condition = '') {
  const c = String(condition)
  if (/晴|clear|sun/i.test(c)) return '☀'
  if (/多云|cloud/i.test(c)) return '⛅'
  if (/阴|overcast/i.test(c)) return '☁'
  if (/雨|rain|drizzle/i.test(c)) return '🌧'
  if (/雪|snow/i.test(c)) return '❄'
  if (/雷|storm|thunder/i.test(c)) return '⛈'
  if (/雾|fog|haze|mist/i.test(c)) return '🌫'
  return '◌'
}

function forecastRow(f) {
  return el('div', { class: 'w-fc' }, [
    el('span', { class: 'w-fc-day', text: f.day || '' }),
    el('span', { class: 'w-fc-ico', text: glyphFor(f.condition) }),
    el('span', { class: 'w-fc-temp', text: `${f.low}° / ${f.high}°` }),
  ])
}

export const weather = {
  render(data = {}) {
    const fc = Array.isArray(data.forecast) ? data.forecast : []
    const variant = data.variant === 'week' || fc.length > 3 ? 'week' : 'compact'
    return el('div', { class: `k-weather is-${variant}` }, [
      el('div', { class: 'w-head' }, [
        el('span', { class: 'w-ico', text: glyphFor(data.condition) }),
        el('div', { class: 'w-now' }, [
          el('div', { class: 'w-city', text: data.city || '' }),
          el('div', { class: 'w-cond', text: variant === 'week' ? `${data.condition || ''} · 7天预报` : (data.condition || '') }),
        ]),
        el('div', { class: 'w-temp', text: data.temp == null ? '' : `${data.temp}°` }),
      ]),
      fc.length
        ? el('div', { class: 'w-fclist' }, fc.map(forecastRow))
        : null,
    ])
  },

  enter() {},
  exit() {},

  // morph:温度 / 天气原地翻动;预报列表变化则交叉淡化重建。
  morph(el_, prev = {}, next = {}) {
    const nextFc = Array.isArray(next.forecast) ? next.forecast : []
    const variant = next.variant === 'week' || nextFc.length > 3 ? 'week' : 'compact'
    const body = el_.querySelector('.k-weather')
    if (body) {
      body.classList.toggle('is-week', variant === 'week')
      body.classList.toggle('is-compact', variant !== 'week')
    }

    setText(el_.querySelector('.w-city'), next.city || '')
    setText(el_.querySelector('.w-cond'), variant === 'week' ? `${next.condition || ''} · 7天预报` : (next.condition || ''))
    setText(el_.querySelector('.w-temp'), next.temp == null ? '' : `${next.temp}°`)
    setText(el_.querySelector('.w-ico'), glyphFor(next.condition))

    const prevFc = Array.isArray(prev.forecast) ? prev.forecast : []
    if (JSON.stringify(prevFc) === JSON.stringify(nextFc)) return

    let list = el_.querySelector('.w-fclist')
    if (nextFc.length && !list) {
      list = el('div', { class: 'w-fclist' }, nextFc.map(forecastRow))
      el_.appendChild(list)
    } else if (!nextFc.length && list) {
      list.remove()
    } else if (list) {
      list.classList.add('fade-swap')
      list.style.opacity = '0'
      requestAnimationFrame(() => {
        list.replaceChildren(...nextFc.map(forecastRow))
        requestAnimationFrame(() => { list.style.opacity = '' })
      })
    }
  },
}
