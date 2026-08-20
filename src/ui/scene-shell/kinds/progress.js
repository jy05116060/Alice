// kind: progress —— 长任务进度。单个 surface 随 value 变化原地 morph:
//   进度条平滑推进(CSS width 过渡)、百分比数字翻动、状态变色。
// 这是"同一元素在动"的最佳展示位(SCENE-PROTOCOL §7)——反复用同一 id ui_set 推进进度。
//
// data: {
//   label: '下载模型',                                  // 任务名
//   value: 42,                                          // 当前量
//   max: 100,                                           // 可选,总量,缺省 100;percent = value/max
//   status: 'active' | 'done' | 'error' | 'paused',     // 可选,缺省 active;满进度推断为 done
//   note: '3 / 10 文件',                                // 可选,副文本(ETA / 计数 / 当前步骤)
//   indeterminate: false                                // 可选,进度未知 → 不定量滑动条(忽略 value)
// }
// 上行 intent:无(纯展示)。

import { el, setText } from './dom.js'

const STATUS = {
  active: 'is-active',
  done:   'is-done',
  error:  'is-error',
  paused: 'is-paused',
}

// 把 value/max 夹到 0..100 的整数百分比。
function percentOf(data = {}) {
  const max = typeof data.max === 'number' && data.max > 0 ? data.max : 100
  const v = typeof data.value === 'number' ? data.value : 0
  return Math.max(0, Math.min(100, Math.round((v / max) * 100)))
}

// 缺省状态推断:显式优先;否则满进度=done,其余=active。
function statusOf(data = {}) {
  if (data.status && STATUS[data.status]) return data.status
  return percentOf(data) >= 100 ? 'done' : 'active'
}

// 是否走不定量滑动条(仅 active 态有意义)。
function isIndeterminate(data = {}, status) {
  return data.indeterminate === true && status === 'active'
}

export const progress = {
  render(data = {}) {
    const pct = percentOf(data)
    const status = statusOf(data)
    const indet = isIndeterminate(data, status)

    const fill = el('div', { class: 'pr-fill' })
    // enter 从 0 填到目标:把目标百分比存到 dataset,初始宽度 0,由 enter() 推上去。
    fill.dataset.pct = String(pct)
    fill.style.width = '0%'

    return el('div', { class: `k-progress ${STATUS[status]}${indet ? ' is-indeterminate' : ''}` }, [
      el('div', { class: 'pr-head' }, [
        el('span', { class: 'pr-label', text: data.label || '' }),
        el('span', { class: 'pr-pct', text: indet ? '' : `${pct}%` }),
      ]),
      el('div', { class: 'pr-track' }, [fill]),
      data.note ? el('div', { class: 'pr-note', text: data.note }) : null,
    ])
  },

  // 入场:进度条从 0 填到目标值,进度是"长出来"的而非凭空出现(不定量态交给 CSS 动画)。
  enter(el_) {
    const fill = el_.querySelector('.pr-fill')
    if (!fill) return
    if (el_.querySelector('.k-progress.is-indeterminate')) return
    const pct = fill.dataset.pct || '0'
    requestAnimationFrame(() => { fill.style.width = `${pct}%` })
  },

  exit() {},

  // morph:value 变 → 进度条 width 平滑过渡(CSS transition)+ 百分比翻动;
  //         status 变 → 重设状态 class 换色;note 增删/原地更新;不定量切换。
  morph(el_, prev = {}, next = {}) {
    const root = el_.querySelector('.k-progress')
    if (!root) return
    const pct = percentOf(next)
    const status = statusOf(next)
    const indet = isIndeterminate(next, status)

    // 状态色:整体重写状态 class(保留 k-progress 基类)。
    root.className = `k-progress ${STATUS[status]}${indet ? ' is-indeterminate' : ''}`

    const fill = root.querySelector('.pr-fill')
    if (fill) {
      fill.dataset.pct = String(pct)
      fill.style.width = indet ? '' : `${pct}%`   // 不定量时清掉内联宽度,由 CSS 动画接管
    }

    const label = root.querySelector('.pr-label')
    if (label) setText(label, next.label || '')

    const pctEl = root.querySelector('.pr-pct')
    if (pctEl) setText(pctEl, indet ? '' : `${pct}%`)

    // note:有→无→有 的增删 + 原地改字。
    const note = root.querySelector('.pr-note')
    if (next.note && !note) {
      root.appendChild(el('div', { class: 'pr-note', text: next.note }))
    } else if (!next.note && note) {
      note.remove()
    } else if (note) {
      setText(note, next.note)
    }
  },
}
