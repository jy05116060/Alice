import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

// Goal 横幅的**静态**契约检查。
//
//   npm run test:goal-banner-wiring
//
// 为什么值得存在：横幅是个渲染在浏览器里的模块，本仓库的测试跑在 Node/Electron 里，
// **没有 DOM**，所以「界面是不是真的显示了累计轮次」这件事没法在这里断言。能断言的是
// 「接线有没有断」：
//   • 横幅读的是 rounds_total（而不是只读 rounds_started）；
//   • 它用的两个 i18n 键在 zh-CN / en-US 里都存在（键写错了 t() 会**静默返回键名**，
//     界面上就出现 goal.roundsTotal 这种字面量——查起来很烦，所以在这里拦一道）。
//
// 注意：这里只做静态检查，**不代表界面渲染正常**——那需要浏览器。

const here = path.dirname(fileURLToPath(import.meta.url))
const bannerPath = path.join(here, 'ui', 'brain-ui', 'goal-banner.js')
const source = fs.readFileSync(bannerPath, 'utf8')

// ── 1. 横幅确实把两个数都读了出来 ─────────────────────────────────────
assert.match(source, /goal\.rounds_total/, 'banner must read goal.rounds_total')
assert.match(source, /goal\.rounds_started/, 'banner must keep reading goal.rounds_started (this run)')
assert.match(source, /t\(["']goal\.roundsTotal["']\)/, 'banner must use the goal.roundsTotal i18n key')
assert.match(source, /t\(["']goal\.roundsThisRun["']\)/, 'banner must use the goal.roundsThisRun i18n key')
assert.match(source, /t\(["']goal\.roundsHint["']\)/, 'banner must use the goal.roundsHint i18n key')
// 累计与本轮要出现在**同一行**文案里（用户要求「累计 X 轮 · 本轮 Y/Z」一起看）
const roundsLine = source.split('\n').find(line => line.includes('goal.roundsTotal') && line.includes('goal.roundsThisRun'))
assert.ok(roundsLine, 'total and this-run must be composed into one banner line')
assert.match(roundsLine, /累计|total/i, `unexpected banner line: ${roundsLine}`)

// ── 2. 别人加的 gb-tag 元素不能被覆盖掉 ───────────────────────────────
assert.match(source, /class="gb-tag"/, 'the gb-tag element added by someone else must survive')
assert.match(source, /el\("gb-tag"\)/, 'gb-tag must still be wired up')

// ── 3. i18n 键在**两个** locale 里都存在，且不是空串 ───────────────────
const zh = (await import('./ui/brain-ui/i18n/locales/zh-CN.js')).default
const en = (await import('./ui/brain-ui/i18n/locales/en-US.js')).default
for (const key of ['goal.roundsTotal', 'goal.roundsThisRun', 'goal.rounds', 'goal.roundsHint']) {
  assert.ok(Object.prototype.hasOwnProperty.call(zh, key), `zh-CN is missing ${key}`)
  assert.ok(Object.prototype.hasOwnProperty.call(en, key), `en-US is missing ${key}`)
  assert.equal(typeof zh[key], 'string')
  assert.equal(typeof en[key], 'string')
  assert.ok(zh[key].length > 0, `zh-CN ${key} is empty`)
  assert.ok(en[key].length > 0, `en-US ${key} is empty`)
}

// ── 4. 悬停说明必须同时解释两个数字 ───────────────────────────────────
assert.match(zh['goal.roundsHint'], /累计/, 'zh hint must explain the cumulative number')
assert.match(zh['goal.roundsHint'], /本轮/, 'zh hint must explain this-run number')
assert.match(en['goal.roundsHint'], /total/, 'en hint must explain the cumulative number')
assert.match(en['goal.roundsHint'], /this run/, 'en hint must explain this-run number')
// 老文案说「点继续会重置为 0」而不区分是哪个数——那正是用户困惑的来源，必须已经改掉
assert.ok(!/^这个计数只统计自动续轮，且在你点/.test(zh['goal.roundsHint']), 'zh hint must no longer claim "the count" resets')

// ── 5. 用 t() 真渲染一遍，确认拼出来的就是「累计 X 轮 · 本轮 Y/Z」 ─────
const { setLocale, t } = await import('./ui/brain-ui/i18n/index.js')
setLocale('zh-CN')
const line = `${t('goal.roundsTotal')} 7 ${t('goal.rounds')} · ${t('goal.roundsThisRun')} 2/12`
assert.equal(line, '累计 7 轮 · 本轮自动轮次 2/12', `unexpected rendered line: ${line}`)

// ── 6. Goal 推送桥：服务端事件 → app.js 派发 → 横幅监听（静态核对）────────
// 这一段拦的是「线断在中间」。服务端一直都在发 goal_created / goal_updated / goal_round
// （events.js 的白名单 + tools/goals.js 的 announce + consciousness-loop 的 emitGoalEvent），
// 但 app.js 的 SSE 分发只把它们喂给了思考流/顶部状态条，**没有**转成 window 事件——
// 于是 goal-banner 这个独立模块收不到，只能靠轮询（未上膛 30s / 已上膛 3s）。
// 线路是：emitEvent → GET /events(SSE) → app.js handle() → emitGoalBridge → alice:goal → 横幅 load()。
// 这里钉住「分发」和「监听」两端；中间那段（真 SSE + 真 DOM）Node 里验不了，见报告。
const appSource = fs.readFileSync(path.join(here, 'ui', 'brain-ui', 'app.js'), 'utf8')
for (const type of ['goal_created', 'goal_updated', 'goal_round']) {
  const after = appSource.split(`case "${type}": {`)[1]
  assert.ok(after, `app.js must still handle ${type}`)
  const body = after.slice(0, after.indexOf('break;'))
  assert.ok(
    body.includes(`emitGoalBridge("${type}", data)`),
    `${type} must be re-dispatched onto the window bridge (the banner lives in another module)`,
  )
}
assert.match(
  appSource,
  /new CustomEvent\("alice:goal",/,
  'the bridge must dispatch alice:goal (one event per module, like alice:media / alice:aivideo)',
)
assert.match(
  source,
  /window\.addEventListener\("alice:goal", \(\) => \{ void load\(\); \}\)/,
  'the banner must reload immediately when alice:goal arrives',
)
// 轮询必须保留作兜底（事件会丢、也会在 SSE 连上之前发生），且文件要写清两套并存的理由
assert.match(source, /schedulePoll\(0\)/, 'the polling fallback must stay wired up')
assert.match(source, /事件推送[\s\S]{0,600}轮询/, 'the banner must explain why event push and polling coexist')

console.log('goal-banner wiring tests passed (static only — no browser rendering was verified)')
