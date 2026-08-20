// Run: node src/test-failed-outbound-dedupe.js

import assert from 'node:assert/strict'
import {
  FAILED_OUTBOUND_RETRY_COOLDOWN_MS,
  createOutboundAttemptKey,
  getRecentOutboundFailure,
  recordOutboundFailure,
} from './runtime/delivery.js'

const outbound = {
  toId: 'ID:000001',
  channel: 'WECHAT_CLAWBOT',
  externalTargetId: 'wechat:clawbot:recipient',
  content: `failed outbound probe ${Date.now()}`,
}
const failedAt = 1_000_000

assert.equal(
  createOutboundAttemptKey(outbound),
  createOutboundAttemptKey({ ...outbound, content: `  ${outbound.content}  ` }),
  'outbound keys normalize incidental surrounding whitespace',
)

recordOutboundFailure({ ...outbound, reason: 'no context_token', now: failedAt })
const blocked = getRecentOutboundFailure({ ...outbound, now: failedAt + 1 })
assert.equal(blocked?.reason, 'no context_token', 'the concrete external failure stays available for diagnosis')
assert(blocked?.retryAfterMs > 0, 'an identical failed message is held during the retry cooldown')

assert.equal(
  getRecentOutboundFailure({ ...outbound, content: `${outbound.content} changed`, now: failedAt + 1 }),
  null,
  'changed content is not treated as a duplicate failure',
)
assert.equal(
  getRecentOutboundFailure({ ...outbound, now: failedAt + FAILED_OUTBOUND_RETRY_COOLDOWN_MS + 1 }),
  null,
  'the failed-message guard expires so a deliberate later retry remains possible',
)

console.log('PASS failed outbound messages preserve their reason and suppress only identical retries')
