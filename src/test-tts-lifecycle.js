import assert from 'node:assert/strict'
import {
  createPlaybackProgressWatchdog,
  isCurrentStreamingTtsSession,
  nextStreamingTtsSession,
} from './ui/brain-ui/tts-lifecycle.js'

{
  const first = nextStreamingTtsSession(0, false)
  const replacement = nextStreamingTtsSession(first.epoch, true)
  assert.equal(replacement.micSuspended, true, 'replacement must inherit microphone suspension ownership')
  assert.equal(isCurrentStreamingTtsSession(first.epoch, replacement.epoch), false)
  assert.equal(isCurrentStreamingTtsSession(replacement.epoch, replacement.epoch), true)
}

{
  let clock = 0
  let terminal = null
  const audio = { currentTime: 0, ended: false }
  const watchdog = createPlaybackProgressWatchdog({
    audioEl: audio,
    onTerminal: result => { terminal = result },
    stallMs: 1000,
    now: () => clock,
    schedule: () => 1,
    cancel: () => {},
  })

  watchdog.start()
  clock = 500
  audio.currentTime = 0.5
  watchdog.check()
  clock = 1400
  watchdog.check()
  assert.equal(terminal, null, 'recent media progress should keep playback alive')
  clock = 1600
  watchdog.check()
  assert.equal(terminal?.kind, 'playback-stalled')
  assert.equal(terminal?.ok, false)
}

{
  let terminal = null
  const audio = { currentTime: 1, ended: false }
  const watchdog = createPlaybackProgressWatchdog({
    audioEl: audio,
    onTerminal: result => { terminal = result },
    schedule: () => 1,
    cancel: () => {},
  })
  watchdog.start()
  audio.ended = true
  watchdog.check()
  assert.equal(terminal?.kind, 'ended-without-event')
  assert.equal(terminal?.ok, true)
}

console.log('TTS lifecycle tests passed')
