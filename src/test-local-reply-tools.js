import assert from 'node:assert/strict'
import {
  filterSendMessageForLocalReply,
  turnNeedsExternalSendMessage,
} from './runtime/local-reply-tools.js'

const baseTools = ['send_message', 'browser_navigate', 'read_file']

assert.deepEqual(
  filterSendMessageForLocalReply(baseTools, {
    localReply: true,
    input: '你成功把我逗乐了',
  }),
  ['browser_navigate', 'read_file'],
  'local replies do not expose send_message to the model'
)

assert.deepEqual(
  filterSendMessageForLocalReply(baseTools, {
    localReply: true,
    input: '把结果发到我微信',
  }),
  baseTools,
  'explicit external-send intent keeps send_message available'
)

assert.deepEqual(
  filterSendMessageForLocalReply(baseTools, {
    localReply: false,
    input: 'hello from feishu',
  }),
  baseTools,
  'external/social turns keep send_message available'
)

assert.equal(
  turnNeedsExternalSendMessage('推送到飞书'),
  true,
  'Feishu wording is treated as external-send intent'
)

assert.equal(
  turnNeedsExternalSendMessage('直接回答我就行'),
  false,
  'ordinary local reply text is not external-send intent'
)

console.log('PASS local reply tool filtering')
