// Run: node src/test-tick-policy.js

import { buildAutonomousTickDirections } from './runtime/tick-policy.js'
import { evaluateToolPolicy } from './capabilities/tool-policy.js'

let failed = 0
function assert(condition, label) {
  if (condition) {
    console.log(`PASS: ${label}`)
    return
  }
  failed++
  process.exitCode = 1
  console.error(`FAIL: ${label}`)
}

const normal = buildAutonomousTickDirections()
assert(normal.includes('no obligation to act, speak, or remain passive'), 'ordinary Tick has no forced behavioral default')
assert(normal.includes('make your own situational judgment'), 'ordinary Tick delegates semantic judgment to the model')
assert(normal.includes('use find_tool'), 'ordinary Tick preserves on-demand capability discovery')
assert(normal.includes('private working text'), 'ordinary Tick distinguishes private text from external communication')
assert(normal.includes('calling send_message'), 'ordinary Tick lets the model explicitly choose external communication')
assert(normal.includes('do not narrate or justify silence'), 'ordinary Tick defines silent completion without semantic runtime filtering')
assert(normal.includes('Treat unanswered conversation like a person would'), 'ordinary Tick treats unanswered messages as a reason to pause')
assert(normal.includes('several messages in a row'), 'ordinary Tick specifically discourages repeated unanswered pings')
assert(!normal.includes('23:00') && !normal.includes('Things you can proactively do'), 'ordinary Tick has no fixed time rule or action menu')
assert(!normal.includes('HARD RULE') && !normal.includes('forbidden'), 'ordinary Tick contains no behavioral hard-rule wording')

const startup = buildAutonomousTickDirections({ startupSelfCheckActive: true, awakeningTicks: 8 })
assert(!startup.includes('diagnostic goal, not a mandatory checklist'), 'generic tick policy does not own the fixed startup self-check')
assert(startup.includes('early awakening period'), 'fixed self-check is injected separately from generic tick policy')

const awakening = buildAutonomousTickDirections({ awakeningTicks: 3 })
assert(awakening.includes('not a prescribed exploration sequence'), 'awakening no longer forces sequential exploration')
assert(awakening.includes('exploration, reflection, task work, communication, or silence'), 'awakening leaves the outcome to model judgment')

const customCadence = buildAutonomousTickDirections({
  tickerStatus: { active: true, seconds: 10, ttl: 7, reason: 'user asked for fast feelings', revision: 3 },
})
assert(customCadence.includes('10s interval, 7 heartbeat(s) remaining'), 'custom ticker status is visible to Tick context')
assert(customCadence.includes('not an instruction to speak'), 'custom ticker status stays scheduling context')
assert(customCadence.includes('not an instruction to speak or to confirm the setting'), 'custom ticker status does not ask the model to repeat a no-op change')

const discovery = buildAutonomousTickDirections({ delegationDiscovery: '[available collaborators: Codex]' })
assert(discovery.endsWith('[available collaborators: Codex]'), 'neutral discovery context can be appended without changing policy')

const autonomousHighRisk = evaluateToolPolicy('delete_file', { path: 'x' }, { autonomous: true })
assert(autonomousHighRisk.allowed === false, 'autonomous Tick still blocks high-risk execution without user authority')
const autonomousSecurityChange = evaluateToolPolicy('set_security', {}, { autonomous: true })
assert(autonomousSecurityChange.allowed === false, 'autonomous Tick cannot expand or change its own authority')
const autonomousBrowserNavigation = evaluateToolPolicy('browser_navigate', { url: 'https://example.com' }, { autonomous: true })
assert(autonomousBrowserNavigation.allowed === false, 'autonomous Tick cannot navigate the interactive Playwright browser without user authority')
const autonomousSandboxCommand = evaluateToolPolicy('exec_command', { command: 'Get-ChildItem' }, { autonomous: true })
assert(autonomousSandboxCommand.allowed === false, 'autonomous Tick cannot launch a general shell without user authority')
const autonomousBackgroundCommand = evaluateToolPolicy('exec_background_command', { command: 'node worker.js' }, { autonomous: true })
assert(autonomousBackgroundCommand.allowed === false, 'autonomous Tick cannot bypass shell authority through a background command')
const autonomousCommunication = evaluateToolPolicy('send_message', {}, { autonomous: true })
assert(autonomousCommunication.allowed === true, 'model may still judge medium-risk communication during Tick')
const autonomousRuleList = evaluateToolPolicy('manage_rule', { action: 'list' }, { autonomous: true })
assert(autonomousRuleList.allowed === true, 'autonomous Tick may inspect persistent rules')
const autonomousRuleMutation = evaluateToolPolicy('manage_rule', { action: 'upsert' }, { autonomous: true })
assert(autonomousRuleMutation.allowed === false, 'autonomous Tick cannot silently rewrite persistent rules')
const explicitlyAuthorized = evaluateToolPolicy('delete_file', { path: 'x' }, { autonomous: true, allowHighRiskAutonomy: true })
assert(explicitlyAuthorized.allowed === true, 'runtime can represent an explicit high-risk autonomy grant')

if (failed === 0) console.log('\nAll autonomous Tick policy checks passed.')
