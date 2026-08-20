'use strict'

const OFFICIAL_NAVIGATION_TOOLS = new Set([
  'browser_navigate_forward',
  'browser_reload',
])

function exposeOfficialNavigationTools() {
  const browserTools = require('playwright-core/lib/coreBundle')?.tools?.browserTools || []
  for (const tool of browserTools) {
    if (!OFFICIAL_NAVIGATION_TOOLS.has(String(tool?.schema?.name || ''))) continue
    // @playwright/mcp 0.0.78 ships these native handlers but marks them
    // skillOnly, which excludes them from the MCP catalog. Change only that
    // visibility bit; schema validation, execution, snapshots, and page
    // ownership remain entirely inside Microsoft's official implementation.
    tool.skillOnly = false
  }
}

module.exports = { exposeOfficialNavigationTools }
