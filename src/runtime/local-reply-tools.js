// Local replies are delivered by the runtime text path. Keep send_message only
// when the turn clearly asks for external or social-channel delivery.
const EXTERNAL_SEND_HINTS = [
  '微信', 'wechat', 'discord', '飞书', 'feishu', '企微', 'wecom',
  '发到', '推送到', '发给我', '转给', '发条微信', '发个微信', '发我微信',
]

export function turnNeedsExternalSendMessage(text = '') {
  const body = String(text || '').toLowerCase()
  return EXTERNAL_SEND_HINTS.some(hint => body.includes(hint.toLowerCase()))
}

export function filterSendMessageForLocalReply(tools = [], { localReply = false, silentSignal = false, input = '' } = {}) {
  const list = Array.isArray(tools) ? tools : []
  if (!localReply || silentSignal || turnNeedsExternalSendMessage(input)) return list
  return list.filter(tool => tool !== 'send_message')
}
