// 交付物卡片的纯逻辑（阶段 6.2）：文件名/大小/图标/可打开性判定。
//
// 单独成模块是为了能直接测：卡片上显示的每个字段都由这里决定，
// 而 UI 代码本身（DOM）不适合放进测试。零依赖——不碰 db、不碰 fs、不碰事件。
import path from 'node:path'

export const DELIVERABLE_KIND_ICONS = Object.freeze({
  document: '📄',
  spreadsheet: '📊',
  presentation: '📽️',
  pdf: '📕',
  image: '🖼️',
  video: '🎬',
  audio: '🎵',
  archive: '🗜️',
  text: '📝',
  file: '📎',
})

export function iconForKind(kind) {
  return DELIVERABLE_KIND_ICONS[String(kind || 'file')] || DELIVERABLE_KIND_ICONS.file
}

/** 取文件名（兼容两种分隔符——收到的路径可能来自另一套平台习惯）。 */
export function baseName(filePath) {
  const value = String(filePath || '')
  const parts = value.split(/[\\/]/).filter(Boolean)
  return parts.length > 0 ? parts[parts.length - 1] : value
}

/**
 * 人读的大小。
 * 「未知」（null/undefined/''）返回空串，而不是 `0 B`——`0 B` 是在断言「这个文件是空的」，
 * 那是另一回事，而且会让用户以为文件坏了。真正的 0 字节仍然显示 `0 B`。
 */
export function formatSize(bytes) {
  if (bytes === null || bytes === undefined || bytes === '') return ''
  const n = Number(bytes)
  if (!Number.isFinite(n) || n < 0) return ''
  if (n < 1024) return `${n} B`
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`
  if (n < 1024 * 1024 * 1024) return `${(n / (1024 * 1024)).toFixed(1)} MB`
  return `${(n / (1024 * 1024 * 1024)).toFixed(2)} GB`
}

/**
 * 卡片的一行副标题：描述优先，没有描述就退回「大小 · 类型」。
 * 描述为空的常见原因是模型只传了 path——那时至少要告诉用户点开的是什么。
 */
export function describeCard(entry) {
  const e = entry || {}
  const description = String(e.description || '').trim()
  if (description) return description
  const bits = [formatSize(e.size_bytes ?? e.sizeBytes), String(e.kind || '').trim()]
  return bits.filter(Boolean).join(' · ')
}

/**
 * 卡片是否可点开。
 * 只有登记过的交付物能开（服务端也这么判，这里是 UI 侧的提前禁用——
 * 让用户看到一个点了没反应的按钮，比看到一个灰掉的按钮更糟）。
 * 显式挡 null：默认参数 `= {}` 只对 undefined 生效，`canOpen(null)` 会当场崩。
 * 这是从服务端数据渲染的路径，null 真的会漏进来。
 */
export function canOpen(entry) {
  return typeof entry?.path === 'string' && entry.path.length > 0
}

export function compactPath(filePath, maxSegments = 3) {
  const value = String(filePath || '')
  const normalized = value.replace(/[\\/]+/g, '/')
  const parts = normalized.split('/').filter(Boolean)
  if (parts.length <= maxSegments) return normalized
  return `…/${parts.slice(-maxSegments).join('/')}`
}

export function extensionOf(filePath) {
  return path.extname(String(filePath || '')).replace(/^\./, '').toLowerCase()
}
