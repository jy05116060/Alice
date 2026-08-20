'use strict'

const path = require('node:path')
const { exposeOfficialNavigationTools } = require('./playwright-official-navigation.cjs')

exposeOfficialNavigationTools()
const packageJson = require.resolve('@playwright/mcp/package.json')
require(path.join(path.dirname(packageJson), 'cli.js'))
