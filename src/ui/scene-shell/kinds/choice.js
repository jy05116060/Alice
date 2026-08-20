// kind: choice —— 请用户做一次选择 / 确认。唯一的交互型 kind。
// data: { prompt, options: [{ value, label, tone? }] }  tone ∈ default|primary|danger
// 上行 intent:select,载荷 { value }。
//
// 红线:shell 只负责显示与上报,绝不在组件内承担业务决策(SCENE-PROTOCOL §3.4 / §7)。

import { el, setText } from './dom.js'

function optionButton(opt, ctx) {
  return el('button', {
    class: `c-opt tone-${opt.tone || 'default'}`,
    'data-value': opt.value,
    text: opt.label,
    onclick: (e) => {
      // 点选 → 标记选中态(纯呈现),并把 select 意图上行。决策权永远在 Agent。
      const root = e.target.closest('.k-choice')
      if (root) root.querySelectorAll('.c-opt').forEach(b => b.classList.remove('chosen'))
      e.target.classList.add('chosen')
      ctx.emit && ctx.emit('select', { value: opt.value })
    },
  })
}

export const choice = {
  render(data = {}, ctx = {}) {
    const opts = Array.isArray(data.options) ? data.options : []
    return el('div', { class: 'k-choice' }, [
      el('p', { class: 'c-prompt s-body', text: data.prompt || '' }),
      el('div', { class: 'c-opts' }, opts.map((o, i) => {
        const b = optionButton(o, ctx)
        // 选项错峰浮现,增强"被请求决策"的仪式感。
        b.style.setProperty('--opt-delay', `${i * 70}ms`)
        return b
      })),
    ])
  },

  enter() {},
  exit() {},

  // morph:prompt 原地更新;选项集变化时整体重建选项行(选项是离散集合,无法逐项插值)。
  morph(el_, prev = {}, next = {}, ctx = {}) {
    const prompt = el_.querySelector('.c-prompt')
    if (prompt) setText(prompt, next.prompt || '')

    const prevOpts = Array.isArray(prev.options) ? prev.options : []
    const nextOpts = Array.isArray(next.options) ? next.options : []
    const same = JSON.stringify(prevOpts) === JSON.stringify(nextOpts)
    if (same) return

    const box = el_.querySelector('.c-opts')
    if (!box) return
    box.classList.add('fade-swap')
    box.style.opacity = '0'
    requestAnimationFrame(() => {
      box.replaceChildren(...nextOpts.map((o, i) => {
        const b = optionButton(o, ctx)
        b.style.setProperty('--opt-delay', `${i * 70}ms`)
        return b
      }))
      requestAnimationFrame(() => { box.style.opacity = '' })
    })
  },
}
