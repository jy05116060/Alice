// kinds 共享的 DOM 小工具 —— 让各 kind 的 render/morph 写起来干净一致。
//
// 纯展示辅助:建元素、设文本、交叉淡化。没有任何业务逻辑,也不碰协议。

// 极简 createElement:el('div', {class:'x'}, [child, '文本']).
export function el(tag, attrs = {}, children = []) {
  const node = document.createElement(tag)
  for (const [k, v] of Object.entries(attrs)) {
    if (v == null || v === false) continue
    if (k === 'class') node.className = v
    else if (k === 'text') node.textContent = v
    else if (k.startsWith('on') && typeof v === 'function') node.addEventListener(k.slice(2).toLowerCase(), v)
    else node.setAttribute(k, v === true ? '' : String(v))
  }
  for (const c of [].concat(children)) {
    if (c == null) continue
    node.appendChild(typeof c === 'string' ? document.createTextNode(c) : c)
  }
  return node
}

// 设置文本:仅在值真的变了时才改 DOM,并做一次轻交叉淡化,morph 时不闪。
export function setText(node, value) {
  const next = value == null ? '' : String(value)
  if (node.textContent === next) return
  node.classList.add('fade-swap')
  node.style.opacity = '0'
  // 下一帧换字 + 淡回,营造"数字翻动"般的过渡感。
  requestAnimationFrame(() => {
    node.textContent = next
    requestAnimationFrame(() => { node.style.opacity = '' })
  })
}
