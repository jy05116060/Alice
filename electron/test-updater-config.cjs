'use strict'

const assert = require('node:assert/strict')
const {
  hasPackagedUpdaterConfig,
  resolveUpdaterConfigPath,
} = require('./updater-config.cjs')

assert.equal(
  resolveUpdaterConfigPath({ resourcesPath: '/Applications/Alice.app/Contents/Resources' }),
  '/Applications/Alice.app/Contents/Resources/app-update.yml',
)
assert.equal(hasPackagedUpdaterConfig({ resourcesPath: '/missing', existsSync: () => false }), false)
assert.equal(hasPackagedUpdaterConfig({ resourcesPath: '/present', existsSync: () => true }), true)
console.log('Updater configuration tests passed.')
