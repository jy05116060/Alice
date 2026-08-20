'use strict'

const fs = require('node:fs')
const path = require('node:path')

function resolveUpdaterConfigPath({ resourcesPath = process.resourcesPath } = {}) {
  return path.join(String(resourcesPath || ''), 'app-update.yml')
}

function hasPackagedUpdaterConfig(options = {}) {
  const existsSync = options.existsSync || fs.existsSync
  return existsSync(resolveUpdaterConfigPath(options))
}

module.exports = { hasPackagedUpdaterConfig, resolveUpdaterConfigPath }
