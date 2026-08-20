import http from 'http'
import crypto from 'crypto'
import { startAPI } from '../src/api.js'
import { popMessage } from '../src/queue.js'
import { dispatchSocialMessage } from '../src/social/dispatch.js'
import { executeTool } from '../src/capabilities/executor.js'

const port = 39000 + Math.floor(Math.random() * 1000)
process.env.FEISHU_VERIFICATION_TOKEN = 'smoke-feishu-token'
process.env.WECHAT_OFFICIAL_TOKEN = 'smoke-token'
process.env.WECOM_INCOMING_TOKEN = 'smoke-wecom-token'

const server = startAPI(port)
const base = `http://127.0.0.1:${port}`

function postJson(path, body) {
  return fetch(`${base}${path}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  })
}

function wechatSignature(timestamp, nonce) {
  return crypto.createHash('sha1').update(['smoke-token', timestamp, nonce].sort().join('')).digest('hex')
}

try {
  const challenge = await postJson('/social/feishu/webhook', {
    challenge: 'ok-challenge',
    token: 'smoke-feishu-token',
  }).then(r => r.json())
  if (challenge.challenge !== 'ok-challenge') throw new Error('Feishu challenge failed')

  const feishuEvent = await postJson('/social/feishu/webhook', {
    schema: '2.0',
    header: {
      event_id: 'ev_smoke',
      event_type: 'im.message.receive_v1',
      token: 'smoke-feishu-token',
      create_time: String(Date.now()),
      tenant_key: 'tenant_smoke',
      app_id: 'cli_smoke',
    },
    event: {
      sender: { sender_id: { open_id: 'ou_smoke' } },
      message: { chat_id: 'oc_smoke', message_id: 'om_smoke', content: JSON.stringify({ text: 'hello feishu' }) },
    },
  })
  if (!feishuEvent.ok) throw new Error(`Feishu event failed: ${feishuEvent.status}`)
  const feishuMsg = popMessage()
  if (
    feishuMsg?.externalPartyId !== 'feishu:open_id:ou_smoke'
    || feishuMsg?.channel !== 'FEISHU'
    || feishuMsg?.content !== 'hello feishu'
  ) throw new Error('Feishu message enqueue failed')

  const ts = String(Math.floor(Date.now() / 1000))
  const nonce = 'abc'
  const sig = wechatSignature(ts, nonce)
  const echo = await fetch(`${base}/social/wechat/official?signature=${sig}&timestamp=${ts}&nonce=${nonce}&echostr=echo-ok`).then(r => r.text())
  if (echo !== 'echo-ok') throw new Error('WeChat verification failed')

  await fetch(`${base}/social/wechat/official?signature=${sig}&timestamp=${ts}&nonce=${nonce}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/xml' },
    body: '<xml><ToUserName><![CDATA[to]]></ToUserName><FromUserName><![CDATA[from_openid]]></FromUserName><MsgType><![CDATA[text]]></MsgType><Content><![CDATA[hello wechat]]></Content></xml>',
  })
  const wechatMsg = popMessage()
  if (
    wechatMsg?.externalPartyId !== 'wechat:official:from_openid'
    || wechatMsg?.channel !== 'WECHAT_OFFICIAL'
    || wechatMsg?.content !== 'hello wechat'
  ) throw new Error('WeChat message enqueue failed')

  await fetch(`${base}/social/wecom/webhook`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: 'Bearer smoke-wecom-token' },
    body: JSON.stringify({ from_id: 'wecom:webhook:default', content: 'hello wecom' }),
  })
  const wecomMsg = popMessage()
  if (
    wecomMsg?.externalPartyId !== 'wecom:webhook:default'
    || wecomMsg?.channel !== 'WECOM'
    || wecomMsg?.content !== 'hello wecom'
  ) throw new Error('WeCom message enqueue failed')

  const unsupportedOfficialMedia = await dispatchSocialMessage('wechat:official:from_openid', {
    text: 'caption',
    mediaPath: 'package.json',
    mediaKind: 'file',
  })
  if (unsupportedOfficialMedia?.ok !== false || !/media send is not supported/.test(unsupportedOfficialMedia.error || '')) {
    throw new Error('Unsupported media dispatch should be rejected for WeChat official')
  }

  const notConnectedClawbotMedia = await dispatchSocialMessage('wechat:clawbot:smoke_user', {
    text: 'caption',
    mediaPath: 'package.json',
    mediaKind: 'file',
  })
  if (notConnectedClawbotMedia?.ok !== false || notConnectedClawbotMedia?.reason !== 'wechat-clawbot not connected') {
    throw new Error('ClawBot media dispatch did not reach ClawBot connector')
  }

  const unsupportedToolMedia = await executeTool('send_message', {
    target_id: 'wechat:official:from_openid',
    media_path: 'package.json',
  }, { source: 'smoke-test' })
  if (!unsupportedToolMedia.includes('媒体消息当前仅支持微信 ClawBot')) {
    throw new Error('send_message should reject media for non-ClawBot targets')
  }

  console.log('[PASS] social smoke')
} finally {
  await new Promise(resolve => server.close(resolve))
}
