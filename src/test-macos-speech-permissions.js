import assert from 'node:assert/strict'
import { requestMacMicrophoneAccess } from './voice/macos-speech.js'

async function checkAccess(systemPreferences) {
  const errors = []
  const granted = await requestMacMicrophoneAccess((message) => errors.push(message), systemPreferences)
  return { granted, errors }
}

{
  const result = await checkAccess(undefined)
  assert.equal(result.granted, true)
  assert.deepEqual(result.errors, [])
}

{
  let asked = false
  const result = await checkAccess({
    getMediaAccessStatus: () => 'granted',
    askForMediaAccess: async () => {
      asked = true
      return true
    },
  })
  assert.equal(result.granted, true)
  assert.equal(asked, false)
  assert.deepEqual(result.errors, [])
}

{
  const requestedTypes = []
  const result = await checkAccess({
    getMediaAccessStatus: () => 'not-determined',
    askForMediaAccess: async (mediaType) => {
      requestedTypes.push(mediaType)
      return true
    },
  })
  assert.equal(result.granted, true)
  assert.deepEqual(requestedTypes, ['microphone'])
  assert.deepEqual(result.errors, [])
}

for (const status of ['denied', 'restricted']) {
  let asked = false
  const result = await checkAccess({
    getMediaAccessStatus: () => status,
    askForMediaAccess: async () => {
      asked = true
      return true
    },
  })
  assert.equal(result.granted, false)
  assert.equal(asked, false)
  assert.match(result.errors[0], /系统设置.*麦克风/)
}

{
  const result = await checkAccess({
    getMediaAccessStatus: () => 'not-determined',
    askForMediaAccess: async () => false,
  })
  assert.equal(result.granted, false)
  assert.match(result.errors[0], /麦克风权限未授予/)
}

{
  const result = await checkAccess({
    getMediaAccessStatus: () => 'not-determined',
    askForMediaAccess: async () => {
      throw new Error('native request failed')
    },
  })
  assert.equal(result.granted, false)
  assert.match(result.errors[0], /native request failed/)
}

{
  const result = await checkAccess({
    getMediaAccessStatus: () => {
      throw new Error('status unavailable')
    },
    askForMediaAccess: async () => true,
  })
  assert.equal(result.granted, false)
  assert.match(result.errors[0], /status unavailable/)
}

console.log('macOS speech permission tests passed')
