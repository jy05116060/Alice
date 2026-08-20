const IS_WIN = process.platform === 'win32'

export const COMMAND_PROFILES = Object.freeze({
  quick: {
    mode: 'quick',
    defaultTimeoutSec: 10,
    maxTimeoutSec: 30,
    useFastLane: true,
    promoteToBackground: false,
  },
  task: {
    mode: 'task',
    defaultTimeoutSec: 60,
    maxTimeoutSec: 120,
    useFastLane: false,
    promoteToBackground: false,
  },
  background: {
    mode: 'background',
    defaultTimeoutSec: 10,
    maxTimeoutSec: 30,
    useFastLane: false,
    promoteToBackground: true,
  },
  download: {
    mode: 'download',
    defaultTimeoutSec: 120,
    maxTimeoutSec: 120,
    useFastLane: false,
    promoteToBackground: false,
  },
  strict: {
    mode: 'strict',
    defaultTimeoutSec: 30,
    maxTimeoutSec: 120,
    useFastLane: false,
    promoteToBackground: false,
  },
})

const LONG_RUNNING_PATTERNS = [
  /\b(watch|tail\s+-f|tail\s+--follow|journalctl\b[^\n]*\s-f|Get-Content\b[^\n]*\s-Wait)\b/i,
  /\b(top|htop|btop)\b/i,
  /\bping\b[^\n]*\s-t\b/i,
  /\b(npm|pnpm|yarn|bun)\s+(run\s+)?(dev|start|serve|watch)\b/i,
  /\b(vite|nodemon|next\s+dev|ng\s+serve|nuxt\s+dev|remix\s+dev|astro\s+dev|expo\s+start|http-server|live-server|webpack-dev-server)\b/i,
  /\b(tsc|webpack|rollup|esbuild)\b[^\n]*(\s-w\b|--watch)/i,
  /\bnode\s+[^\n]*\bserver\b/i,
  /\b(uvicorn|gunicorn|hypercorn|daphne|flask\s+run|streamlit\s+run)\b/i,
  /\bpython3?\s+[^\n]*\b(runserver|server)\b/i,
  /\b(dotnet\s+(run|watch)|cargo\s+(run|watch)|php\s+artisan\s+serve|rails\s+(s|server)|jekyll\s+serve|hugo\s+server)\b/i,
  /\b(mvn\b[^\n]*spring-boot:run|gradle\b[^\n]*bootRun|go\s+run\b[^\n]*\bserver)/i,
  /\bdocker(\s+compose)?\s+up\b(?!\s+-d)/i,
  /\b(docker(\s+compose)?\s+logs|kubectl\s+logs)\b[^\n]*\s-f\b/i,
  /\bssh\b[\s\S]*\b(watch|tail\s+-f|tail\s+--follow|journalctl\b[^\n]*\s-f|top|htop)\b/i,
]

const FAST_LANE_SAFE_HEADS = new Set([
  'ls', 'dir', 'gci', 'get-childitem', 'pwd', 'get-location', 'gl', 'tree',
  'cat', 'type', 'gc', 'get-content',
  'findstr', 'select-string', 'sls', 'grep', 'rg', 'ag',
  'test-path', 'get-item', 'gi', 'get-itemproperty', 'resolve-path',
  'split-path', 'join-path', 'convert-path',
  'measure-object', 'get-command', 'gcm', 'get-module', 'get-variable',
  'echo', 'write-output',
  'hostname', 'whoami', 'get-date',
  'head', 'tail', 'wc', 'nl', 'basename', 'dirname', 'stat',
])

const FAST_LANE_BLOCK_RE = /(-Wait|--follow|\s-f\b|\bmore\b|\bless\b|Read-Host|Get-Credential|Out-GridView|Wait-Event|Wait-Process|Start-Sleep|\bpause\b|-Confirm\b)/i
const DOWNLOAD_RE = /\b(curl|wget|Invoke-WebRequest|iwr|Start-BitsTransfer|aria2c)\b/i
const TASK_RE = /\b(npm|pnpm|yarn|bun|node|python3?|pip|uv|cargo|go|dotnet|mvn|gradle|git|winget|choco|scoop|msiexec)\b|(?:^|[\s"'`])[^"'`\s]+\.(?:exe|msi)\b/i
const STRICT_RE = /\b(git\s+(reset|clean|checkout|push|rebase|merge)|npm\s+publish|pnpm\s+publish|yarn\s+publish|powershell|pwsh)\b/i

export function isLikelyLongRunningCommand(command = '') {
  const text = String(command || '').trim()
  if (!text) return false
  return LONG_RUNNING_PATTERNS.some((re) => re.test(text))
}

export function isFastLaneEligible(command = '') {
  if (!IS_WIN) return false
  const text = String(command || '').trim()
  if (!text || text.length > 2000) return false
  if (/;/.test(text)) return false
  if (isLikelyLongRunningCommand(text)) return false
  if (FAST_LANE_BLOCK_RE.test(text)) return false
  const head = text.split(/[\s;|&(]/)[0].replace(/^['"]/, '').replace(/\.exe$/i, '').toLowerCase()
  return FAST_LANE_SAFE_HEADS.has(head)
}

export function normalizeCommandProfile(value) {
  const mode = String(value || '').trim().toLowerCase()
  return COMMAND_PROFILES[mode] ? mode : ''
}

export function classifyCommandProfile(command = '', forcedProfile = '') {
  const forced = normalizeCommandProfile(forcedProfile)
  if (forced) return { ...COMMAND_PROFILES[forced], detected: forced, forced: true }

  const text = String(command || '').trim()
  if (!text) return { ...COMMAND_PROFILES.task, detected: 'task', forced: false }
  if (isLikelyLongRunningCommand(text)) return { ...COMMAND_PROFILES.background, detected: 'background', forced: false }
  if (DOWNLOAD_RE.test(text)) return { ...COMMAND_PROFILES.download, detected: 'download', forced: false }
  if (STRICT_RE.test(text)) return { ...COMMAND_PROFILES.strict, detected: 'strict', forced: false }
  if (isFastLaneEligible(text)) return { ...COMMAND_PROFILES.quick, detected: 'quick', forced: false }
  if (TASK_RE.test(text)) return { ...COMMAND_PROFILES.task, detected: 'task', forced: false }
  return { ...COMMAND_PROFILES.task, detected: 'task', forced: false }
}

export function resolveProfileTimeout(args = {}, profile = COMMAND_PROFILES.task) {
  const rawTimeout = Number(args.timeout) || profile.defaultTimeoutSec || 30
  const maxTimeoutSec = profile.maxTimeoutSec || 120
  const timeoutSec = Math.max(1, Math.min(rawTimeout < 1000 ? rawTimeout : rawTimeout / 1000, maxTimeoutSec))
  return Math.round(timeoutSec * 1000)
}
