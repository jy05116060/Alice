// Run: node src/test-channel.js

import { PUBLIC_CHANNELS, normalizeChannel, isVoiceChannel } from './runtime/channel.js'

let failed = 0
function assertEqual(actual, expected, label) {
  if (actual !== expected) {
    failed++
    process.exitCode = 1
    console.error(`FAIL: ${label}`)
    console.error(`  expected: ${JSON.stringify(expected)}`)
    console.error(`  actual:   ${JSON.stringify(actual)}`)
  } else {
    console.log(`PASS: ${label}`)
  }
}

function assert(cond, label) {
  if (!cond) {
    failed++
    process.exitCode = 1
    console.error(`FAIL: ${label}`)
  } else {
    console.log(`PASS: ${label}`)
  }
}

assertEqual(normalizeChannel(''), 'TUI', 'empty channel defaults to TUI')
assertEqual(normalizeChannel(null), 'TUI', 'null channel defaults to TUI')
assertEqual(normalizeChannel('API'), 'TUI', 'API normalizes to TUI')
assertEqual(normalizeChannel('voice'), 'TUI', 'voice normalizes to TUI')
assertEqual(normalizeChannel('VOICE'), 'TUI', 'uppercase VOICE normalizes to TUI')
assertEqual(normalizeChannel('语音识别'), 'TUI', 'Chinese voice channel normalizes to TUI')
assertEqual(normalizeChannel('FocusBanner'), 'TUI', 'FocusBanner normalizes to TUI')
assertEqual(normalizeChannel('WECHAT_CLAWBOT'), 'WECHAT', 'wechat clawbot normalizes to WECHAT')
assertEqual(normalizeChannel('WECHAT_OFFICIAL'), 'WECHAT', 'wechat official normalizes to WECHAT')
assertEqual(normalizeChannel('REMINDER'), 'SYSTEM', 'REMINDER normalizes to SYSTEM')
assertEqual(normalizeChannel('APP_SIGNAL'), 'SYSTEM', 'APP_SIGNAL normalizes to SYSTEM')
assertEqual(normalizeChannel('custom_channel'), 'CUSTOM_CHANNEL', 'unknown channels uppercase')
assert(PUBLIC_CHANNELS.includes('AUTO'), 'PUBLIC_CHANNELS includes AUTO')
assert(isVoiceChannel('voice'), 'voice channel is recognized as voice')
assert(isVoiceChannel('VOICE'), 'uppercase VOICE channel is recognized as voice')
assert(isVoiceChannel('语音识别'), 'Chinese voice channel is recognized as voice')
assert(isVoiceChannel('FocusBanner'), 'FocusBanner channel is recognized as voice')
// 2026-09-22 的产品决定：手机网页端（TUI / API / RESOURCE）与微信端（WECHAT*）
// 也纳入语音播报白名单，让这些渠道的回复同样出声。详见 runtime/channel.js 里
// VOICE_CHANNELS 上的注释——这条断言必须跟着那个决定走，不能反过来把它锁死。
for (const channel of ['TUI', 'API', 'RESOURCE', 'WECHAT', 'WECHAT_CLAWBOT', 'WECHAT_OFFICIAL']) {
  assert(isVoiceChannel(channel), `${channel} speaks because the 2026-09-22 broadcast whitelist includes it`)
}
// 白名单是精确匹配，不是「非 TUI 即语音」：没列进来的渠道仍然不出声。
for (const channel of ['DISCORD', 'FEISHU', 'WECOM', 'AUTO', 'custom_channel', '']) {
  assert(!isVoiceChannel(channel), `${channel || '(empty)'} is not on the broadcast whitelist`)
}

if (failed === 0) {
  console.log('\nAll channel checks complete.')
} else {
  console.log(`\n${failed} channel check(s) failed.`)
}
