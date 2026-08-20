import { markdownImage, persistChatMediaDataUrl } from '../chat-media.js'

const MAX_INBOUND_CHAT_MEDIA = 8

function collectInboundChatMedia(body = {}) {
  const out = []
  const push = (item, fallbackAlt = 'image') => {
    if (!item) return
    if (typeof item === 'string') {
      out.push({ dataUrl: item, alt: fallbackAlt })
      return
    }
    if (typeof item !== 'object') return
    const dataUrl = item.dataUrl || item.data_url || item.url || item.src || item.image || ''
    if (!dataUrl) return
    out.push({
      dataUrl: String(dataUrl),
      alt: item.alt || item.name || item.filename || fallbackAlt,
    })
  }

  if (Array.isArray(body.attachments)) {
    for (const item of body.attachments) push(item, 'attachment')
  }
  if (Array.isArray(body.images)) {
    for (const item of body.images) push(item, 'image')
  }
  push(body.image_data_url || body.imageDataUrl || body.image, 'image')
  push(body.screenshot_data_url || body.screenshotDataUrl || body.screenshot, 'system screenshot')

  return out
    .filter(item => /^data:image\//i.test(String(item.dataUrl || '').trim()))
    .slice(0, MAX_INBOUND_CHAT_MEDIA)
}

export function appendInboundChatMediaMarkdown(content = '', body = {}) {
  const media = []
  for (const item of collectInboundChatMedia(body)) {
    try {
      const stored = persistChatMediaDataUrl(item.dataUrl)
      media.push({
        ...stored,
        alt: item.alt || 'image',
        markdown: markdownImage(stored.url, item.alt || 'image'),
      })
    } catch (err) {
      console.warn('[message] inbound chat media ignored:', err?.message || err)
    }
  }
  if (media.length === 0) return { content, media }
  return {
    content: `${media.map(item => item.markdown).join('\n')}\n\n${content.trim()}`.trim(),
    media,
  }
}
