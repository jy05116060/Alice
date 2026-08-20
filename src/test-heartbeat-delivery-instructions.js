// Run: node src/test-heartbeat-delivery-instructions.js
// A heartbeat must not inherit the plain-text delivery rule for local user turns.

import assert from 'node:assert/strict'
import { buildLLMMessages } from './runtime/messages.js'

const messages = buildLLMMessages({
  systemPrompt: 'base prompt',
  input: 'TICK 2026-07-11T02:30:00+08:00',
  isTick: true,
})

const system = messages[0]?.content || ''
assert.match(system, /not a user turn/i, 'tick system prompt distinguishes a heartbeat from a user turn')
assert.match(system, /no incoming local-user channel/i, 'tick does not inherit a missing-channel local reply path')
assert.match(system, /Plain assistant text is private working output/i, 'tick prose is explicitly private')
assert.match(system, /call send_message explicitly/i, 'tick communication requires an explicit send_message call')

console.log('PASS heartbeat delivery instructions distinguish TICK from a local user turn')
