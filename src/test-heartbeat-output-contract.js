// Run: node src/test-heartbeat-output-contract.js
//
// A heartbeat has no implicit recipient-facing reply body. Plain model text is
// retained as private turn output unless the model explicitly calls
// send_message. This test keeps the stream mocked so it never contacts a model
// provider or writes an outbound message.

import assert from 'node:assert/strict'
import { callLLM } from './llm.js'
import { getTraces } from './runtime/turn-trace.js'

const privateText = '这一轮没有新的证据；保持安静。'
let rounds = 0

const result = await callLLM({
  systemPrompt: 'heartbeat test',
  message: 'TICK',
  tools: ['send_message'],
  toolContext: {
    outputContract: 'explicit_send_only',
    currentTargetId: 'ID:000001',
  },
  mustReply: false,
  _streamOnceForTest: async () => {
    rounds += 1
    return { content: privateText, reasoningContent: '', aborted: false, toolCalls: [] }
  },
})

assert.equal(rounds, 1, 'heartbeat plain text ends without a delivery nudge')
assert.equal(result.content, privateText, 'private heartbeat text remains available to turn tracing')
assert.equal(result.delivered, false, 'heartbeat plain text is not converted into an outbound message')
assert.equal(getTraces(1)[0]?.meta?.outputContract, 'explicit_send_only', 'turn trace records the heartbeat output contract')

console.log('PASS: heartbeat output contract keeps plain text private until send_message is explicit')
