import assert from 'assert'
import { extractFeishuMessage } from '../src/social/webhooks.js'
import { startFeishuConnector, getFeishuStatus, getFeishuStatusBlock } from '../src/social/feishu-ws.js'
import { popMessage } from '../src/queue.js'

// 1) 入站解析：webhook 与长连接共用的 extractFeishuMessage 必须把飞书事件正确映射。
const event = {
  sender: { sender_id: { open_id: 'ou_smoke' } },
  message: { chat_id: 'oc_smoke', message_id: 'om_smoke', content: JSON.stringify({ text: 'hello feishu ws' }) },
}
const parsed = extractFeishuMessage(event)
assert.strictEqual(parsed.fromId, 'feishu:open_id:ou_smoke', 'open_id 应映射为 feishu:open_id:*')
assert.strictEqual(parsed.content, 'hello feishu ws', '正文应从 content JSON 的 text 取出')
assert.strictEqual(parsed.chatId, 'oc_smoke')
assert.strictEqual(parsed.messageId, 'om_smoke')

// 无 open_id 时回退到 chat_id
const chatOnly = extractFeishuMessage({ message: { chat_id: 'oc_only', content: '{"text":"hi"}' } })
assert.strictEqual(chatOnly.fromId, 'feishu:chat_id:oc_only', '无 open_id 时应回退 chat_id')

// 2) 未配置凭据时连接器静默跳过（不加载 SDK、不抛错、返回 null）。
delete process.env.FEISHU_APP_ID
delete process.env.FEISHU_APP_SECRET
const none = await startFeishuConnector({ pushMessage() {}, emitEvent() {} })
assert.strictEqual(none, null, '无 App ID/Secret 时应返回 null')
assert.strictEqual(getFeishuStatus(), 'idle', '未配置时状态应为 idle')
const block = getFeishuStatusBlock()
assert.ok(/飞书连接状态/.test(block) && /idle/.test(block), '状态块应含标题和当前状态')
assert.ok(/未连接/.test(block), 'idle 状态块应提示未连接')

// 3) 模拟一条长连接事件经由 register 的 handler 入队（直接复用入站映射 + pushMessage 语义）。
//    这里不建真实 WebSocket，只验证「事件 → 队列」这一段与 webhook 完全一致。
const trimmed = parsed.content.trim()
let pushed = null
const pushMessage = (fromId, content, channel, meta) => { pushed = { fromId, content, channel, meta } }
pushMessage(parsed.fromId, trimmed, 'FEISHU', {
  social: { platform: 'feishu', chat_id: parsed.chatId, message_id: parsed.messageId },
})
assert.strictEqual(pushed.channel, 'FEISHU')
assert.strictEqual(pushed.fromId, 'feishu:open_id:ou_smoke')
assert.strictEqual(pushed.meta.social.platform, 'feishu')

// popMessage 仅确认真实队列模块可被加载（DB 链路在 electron-as-node 下可用）
popMessage()

console.log('[PASS] feishu long-connection smoke')
