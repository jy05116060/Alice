export const CANONICAL_USER_ID = 'ID:000001'

export function normalizeConversationPartyId(id) {
  if (!id) return id
  const text = String(id).trim()
  if (!text) return text
  if (/^ID:\d+$/i.test(text)) return `ID:${text.replace(/^ID:/i, '')}`
  if (/^\d+$/.test(text)) return `ID:${text}`
  return text
}
