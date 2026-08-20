// Directly executable registered capabilities must arrive in the first model
// round.  Generic capabilities remain discoverable through find_tool.
// Run: node src/test-tool-router.js

import assert from 'node:assert/strict'
import { selectTools } from './memory/tool-router.js'

const CORE = ['send_message', 'recall_memory', 'find_tool', 'ui_set']
const LOCAL_VISUAL = ['person_card_mode', 'knowledge_cortex_mode']
// 每条真实用户轮都在场的「交互型」工具。它们不靠关键词推断：
//   ask_user_question —— 拿不准就问一句的出口（A8）
//   子代理 / workflow  —— 「用户交给我的事」的延伸，够不够格派活由模型判断（阶段 1/2）
//   goal 读写          —— 长期目标要能被立、被记进度、被收尾（阶段 3.1，create 仅用户轮）
//   enter_plan_mode    —— 「先给方案别动手」的入口（阶段 3.3；不在计划模式时才给，
//                         计划模式里换成 exit_plan_mode，见 test-plan-mode.js）
//   present            —— 交付物卡片（阶段 6.2；只在真实用户轮且不在计划模式时给）
//   office_capability  —— 转换器能力探测（阶段 6.3；任何轮都给，心跳轮也要能发现「转不了」）
//   convert_to_pdf     —— Office→PDF（阶段 6.3；只在真实用户轮，它会写新文件）
// 通用能力（读写文件、联网、知识库…）仍然只走 find_tool，不在这一组里。
const ALWAYS_ON_USER_TURN = [
  'ask_user_question',
  'run_subagent', 'spawn_subagent', 'subagent_message', 'subagent_interrupt', 'subagent_list',
  'workflow',
  // workflow_status 是后台运行的查询半：跟着 workflow 一起进出（没有 workflow 就没有
  // run id 可查）。它是只读的，但它**不需要任何意图上下文**——和 workflow 一样属于
  // 「用户交给我的事」的延伸，所以在这一组里，而不是走 find_tool 发现。
  'workflow_status',
  'get_goal', 'update_goal', 'create_goal',
  'enter_plan_mode',
  'present',
  'office_capability', 'convert_to_pdf',
]
const GENERIC_TOOLS = [
  'read_file', 'write_file', 'edit_file', 'delete_file', 'list_dir', 'make_dir',
  'run_command', 'manage_reminder',
  'manage_knowledge_region', 'import_knowledge', 'search_knowledge', 'inspect_knowledge_source',
  'terminal_stream', 'manage_api_capability',
]

const intents = [
  '请创建知识脑区并导入 30 个 Markdown 文档',
  '3000 端口被谁占用？',
  '帮我执行 git status',
  '明天九点提醒我开会',
]

for (const messageBody of intents) {
  const tools = selectTools({ messageBody, isTick: false, senderId: 'ID:000001' })
  assert.deepEqual(
    tools,
    [...CORE, ...ALWAYS_ON_USER_TURN, ...LOCAL_VISUAL],
    `generic tools remain discoverable: ${messageBody}`,
  )
  // 这条断言真正要守的是「通用能力没有被关键词顺带放进来」。
  for (const tool of GENERIC_TOOLS) {
    assert.ok(!tools.includes(tool), `generic tool ${tool} must stay behind find_tool for: ${messageBody}`)
  }
}

const web = selectTools({ messageBody: '搜索今天的新闻并打开网页', isTick: false, senderId: 'ID:000001' })
for (const tool of ['browser_set_display_mode', 'browser_navigate', 'browser_snapshot']) {
  assert.ok(web.includes(tool), `explicit web intent injects ${tool} in the first round`)
}

const systemBrowser = selectTools({ messageBody: '用我电脑上的浏览器打开 https://example.com', isTick: false })
assert.ok(systemBrowser.includes('system_browser_open'), 'explicit system-browser request injects its only valid tool')
assert.ok(!systemBrowser.includes('browser_navigate'), 'system-browser request does not expose the managed-browser substitute')

const install = selectTools({ messageBody: '帮我安装一个软件', isTick: false, senderId: 'ID:000001' })
assert.ok(install.includes('install_software'), 'software installation is available in the first round')

for (const messageBody of [
  '帮我做一个简单的个人主页，保存成网页，我想双击就能打开。',
  '不用发代码，你直接帮我保存成网页就行。',
  '把网页上的名字改成小远，再加一句“喜欢做有意思的小工具”。',
]) {
  const tools = selectTools({ messageBody, isTick: false, senderId: 'ID:000001' })
  for (const tool of ['read_file', 'write_file', 'edit_file']) {
    assert.ok(tools.includes(tool), `natural local-file request injects ${tool}: ${messageBody}`)
  }
}

const fileFollowup = selectTools({
  messageBody: '把按钮改成绿色，其他别动。',
  isTick: false,
  recentActionLog: [{ tool: 'write_file', result_preview: '{"absolute_path":"/tmp/个人主页.html"}' }],
})
for (const tool of ['read_file', 'write_file', 'edit_file']) {
  assert.ok(fileFollowup.includes(tool), `recent file context keeps ${tool} available for a terse edit`)
}
const isolatedEdit = selectTools({ messageBody: '把按钮改成绿色，其他别动。', isTick: false })
assert.ok(!isolatedEdit.includes('edit_file'), 'a terse edit without file context does not inject file tools')

if (process.platform === 'darwin') {
  const pauseMusic = selectTools({ messageBody: '暂停', isTick: false, senderId: 'ID:000001' })
  assert.ok(pauseMusic.includes('system_music'), 'terse pause exposes macOS system music control immediately')
  assert.ok(!pauseMusic.includes('music'), 'macOS never exposes Alice local music library')
  const playVideo = selectTools({ messageBody: '播放这个视频', isTick: false, senderId: 'ID:000001' })
  assert.ok(!playVideo.includes('system_music'), 'video playback does not activate macOS system music control')
}

const activeTask = selectTools({ messageBody: '继续', hasTask: true })
for (const tool of ['set_task', 'complete_task', 'update_task_step', 'review_work']) {
  assert.ok(activeTask.includes(tool), `active task retains runtime control: ${tool}`)
}

const tick = selectTools({ messageBody: '', isTick: true })
for (const tool of ['search_memory', 'probe_memory', 'set_tick_interval']) {
  assert.ok(tick.includes(tool), `tick retains runtime control: ${tool}`)
}
assert.ok(GENERIC_TOOLS.every(tool => !tick.includes(tool)), 'tick does not preselect generic capabilities')

const attachment = selectTools({ messageBody: '![screenshot](data:image/png;base64,AAAA)' })
assert.ok(attachment.includes('analyze_image'), 'an actual attached image remains available to the model')

const external = selectTools({ messageBody: '请打开知识脑区', localVisualTurn: false })
assert.ok(LOCAL_VISUAL.every(tool => !external.includes(tool)), 'external channels cannot expose local-only panels')

const installed = selectTools({ messageBody: 'anything', installedToolNames: ['example_extension'] })
assert.ok(installed.includes('example_extension'), 'installed tools stay model-selectable')
assert.ok(GENERIC_TOOLS.every(tool => !installed.includes(tool)), 'installed tools do not restore generic keyword routing')

console.log('test-tool-router ok')
