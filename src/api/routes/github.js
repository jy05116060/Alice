import { jsonResponse } from '../utils.js'
import { readRawBody } from '../utils.js'
import { pushMessage } from '../../inbound-message.js'
import { emitEvent } from '../../events.js'
import { config } from '../../config.js'
import {
  DELIVERY_HEADER,
  EVENT_HEADER,
  GithubWebhookError,
  SIGNATURE_HEADER,
  buildGithubWebhookMessage,
  shouldHandleEvent,
  summarizeGithubEvent,
  verifySignature,
} from '../../runtime/github-webhook.js'

// GitHub webhook 入口（阶段 6.4）。
//   POST /webhook/github
//
// 复用现有入站通道（`pushMessage`，与微信/飞书/Discord 同一条路），所以事件会走
// 完整的注入与工具链，不需要另立一套。区别只在于它是一条**系统来源**的后台消息，
// 不是用户说的话——文本里也明确这么写（见 buildGithubWebhookMessage）。
//
// 默认关闭：启用需要一个密钥，而密钥是「只应存在于用户配置里」的东西。
const MAX_BODY_BYTES = 512 * 1024

export async function handleGithubWebhookRoutes(req, res, url) {
  if (url.pathname !== '/webhook/github') return false

  if (req.method !== 'POST') {
    jsonResponse(res, 405, { ok: false, code: 'METHOD_NOT_ALLOWED', error: 'GitHub webhooks are POST-only' })
    return true
  }

  const settings = config.github || {}
  if (settings.enabled !== true) {
    // 未启用时也返回 200/ ok:false，而不是 404：让用户在 GitHub 的 Recent Deliveries 里
    // 看到「投递到了，但服务端说没启用」，比看到一个 404 更容易定位。
    jsonResponse(res, 503, { ok: false, code: 'NOT_ENABLED', error: 'the GitHub webhook endpoint is not enabled in settings' })
    return true
  }
  if (!settings.secret) {
    jsonResponse(res, 503, { ok: false, code: 'NO_SECRET', error: 'no webhook secret is configured; refusing to accept unverifiable deliveries' })
    return true
  }

  // **必须拿原始字节**：签名是对请求体原始字节做的，先 parse 再 stringify 会改变字节
  let raw
  try {
    raw = await readRawBody(req, { maxBytes: MAX_BODY_BYTES })
  } catch (error) {
    jsonResponse(res, error?.statusCode === 413 ? 413 : 400, {
      ok: false,
      code: error?.statusCode === 413 ? 'BODY_TOO_LARGE' : 'BODY_UNREADABLE',
      error: error?.message || 'could not read the request body',
    })
    return true
  }

  const verdict = verifySignature(raw, req.headers?.[SIGNATURE_HEADER], settings.secret)
  if (!verdict.ok) {
    // 不告诉调用方具体是「签名错」还是「密钥没配」的细节差别之外的任何东西——
    // 但要在本地留一条事件，否则用户会以为是配置错了而反复重试。
    emitEvent('github_webhook_rejected', { reason: verdict.reason })
    jsonResponse(res, 401, { ok: false, code: 'BAD_SIGNATURE', error: 'signature verification failed' })
    return true
  }

  let payload = null
  try {
    payload = JSON.parse(raw.toString('utf8'))
  } catch {
    jsonResponse(res, 400, { ok: false, code: 'BAD_JSON', error: 'the verified body is not valid JSON' })
    return true
  }

  const eventType = String(req.headers?.[EVENT_HEADER] || '').trim()
  const deliveryId = String(req.headers?.[DELIVERY_HEADER] || '').trim()
  if (!eventType) {
    jsonResponse(res, 400, { ok: false, code: 'EVENT_HEADER_MISSING', error: `missing ${EVENT_HEADER} header` })
    return true
  }

  if (!shouldHandleEvent(eventType, { events: settings.events })) {
    // 不在订阅里：确认收到但**不唤醒模型**。返回 202 让 GitHub 的投递记录显示成功，
    // 免得它按失败重投。
    emitEvent('github_webhook_ignored', { event: eventType, delivery: deliveryId })
    jsonResponse(res, 202, { ok: true, ignored: true, event: eventType })
    return true
  }

  const summary = summarizeGithubEvent(eventType, payload)
  const content = buildGithubWebhookMessage(summary, { deliveryId })

  try {
    // queue: 'background' —— 它是系统来源的消息，不该插到用户对话前面去。
    pushMessage('SYSTEM', content, 'SYSTEM', {
      queue: 'background',
      githubEvent: {
        event: summary.event,
        repo: summary.repo,
        actor: summary.actor,
        summary: summary.summary,
        delivery: deliveryId,
      },
    })
  } catch (error) {
    emitEvent('github_webhook_failed', { event: eventType, error: error?.message || String(error) })
    jsonResponse(res, 500, { ok: false, code: 'ENQUEUE_FAILED', error: error?.message || 'could not queue the event' })
    return true
  }

  emitEvent('github_webhook_received', {
    event: summary.event,
    repo: summary.repo,
    actor: summary.actor,
    summary: summary.summary,
    delivery: deliveryId,
  })
  jsonResponse(res, 202, { ok: true, event: summary.event, summary: summary.summary })
  return true
}

/** 配置自检（给设置页/诊断用）：告诉调用方现在还差什么才能真正接收事件。 */
export function githubWebhookStatus() {
  const settings = config.github || {}
  const ready = settings.enabled === true && !!settings.secret
  return {
    ok: true,
    enabled: settings.enabled === true,
    has_secret: !!settings.secret,
    ready,
    path: '/webhook/github',
    ...(ready ? {} : {
      missing: [
        settings.enabled === true ? null : 'enabled',
        settings.secret ? null : 'secret',
      ].filter(Boolean),
    }),
  }
}

export { GithubWebhookError }
