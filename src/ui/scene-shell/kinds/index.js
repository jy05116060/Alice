// kind 注册表 —— 渲染端词汇表(SCENE-PROTOCOL §6)。
//
// 每个 kind 是一个对象:{ render(data, ctx), enter(el), exit(el), morph(el, prev, next, ctx) }。
// shell 通过本表把 surface.kind 映射到具体组件;不认识的 kind 降级为占位,绝不崩溃(§8)。

import { el } from './dom.js'
import { text } from './text.js'
import { metric } from './metric.js'
import { image } from './image.js'
import { choice } from './choice.js'
import { weather } from './weather.js'
import { progress } from './progress.js'
import { selfcheck } from './selfcheck.js'
import { awakening } from './awakening.js'
import { stack, row, col } from './layout.js'

// 未知 kind 的占位组件:显示 kind 名,保持画面不崩。
const unknown = {
  render(data, ctx) {
    return el('div', { class: 'k-unknown', text: `⚠ 未知 kind: ${ctx && ctx.kind || '?'}` })
  },
  enter() {},
  exit() {},
  morph() {},
}

const REGISTRY = { text, metric, image, choice, weather, progress, selfcheck, awakening, stack, row, col }

// 取某 kind 的组件;不存在则返回占位组件。
export function getKind(kind) {
  return REGISTRY[kind] || unknown
}

// 哪些 kind 是布局原语(其 children 需递归驱动生命周期)。
export function isLayout(kind) {
  return kind === 'stack' || kind === 'row' || kind === 'col'
}
