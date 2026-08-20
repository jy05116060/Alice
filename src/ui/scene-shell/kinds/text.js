// kind: text —— 语义文本块(标题 + 正文 + 可选脚注)。也是排版原语之一。
// data: { title?, body, footnote? }  ·  上行 intent:无(纯展示)。

import { el, setText } from './dom.js'

export const text = {
  render(data = {}) {
    const root = el('div', { class: 'k-text' }, [
      data.title ? el('p', { class: 's-title', text: data.title }) : null,
      el('p', { class: 's-body', text: data.body || '' }),
      data.footnote ? el('p', { class: 's-foot', text: data.footnote }) : null,
    ])
    return root
  },

  // enter/exit 主要交给外壳的 .is-entering/.is-exiting;这里留作 kind 级钩子(可叠加细节)。
  enter() {},
  exit() {},

  // morph:同一元素数据变化 —— 逐行原地交叉淡化,而非整块重建,体现"还是这张卡"。
  morph(el_, prev = {}, next = {}) {
    let title = el_.querySelector('.s-title')
    const body = el_.querySelector('.s-body')
    let foot = el_.querySelector('.s-foot')

    // 标题:可能从无到有 / 从有到无,补建或移除。
    if (next.title && !title) {
      title = el('p', { class: 's-title', text: next.title })
      el_.insertBefore(title, el_.firstChild)
    } else if (!next.title && title) {
      title.remove()
    } else if (title) {
      setText(title, next.title)
    }

    if (body) setText(body, next.body || '')

    if (next.footnote && !foot) {
      foot = el('p', { class: 's-foot', text: next.footnote })
      el_.appendChild(foot)
    } else if (!next.footnote && foot) {
      foot.remove()
    } else if (foot) {
      setText(foot, next.footnote)
    }
  },
}
