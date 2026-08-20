import assert from 'assert'
import { execAskUserQuestion } from './capabilities/tools/interaction.js'
import {
  addSSEClient,
  removeSSEClient,
  getSSEClientCount,
} from './events.js'
import {
  listPendingInteractions,
  getPendingInteraction,
} from './interaction/pending.js'

// ask_user_question（A8，对齐 DSH dsh-tool-ask-user）的纯 Node 测试：
//   1. 空问题 / 无效参数 → EMPTY_QUESTIONS
//   2. 规范化：重复 id、缺字段、空选项标签剔除；multi_select 映射
//   3. 没有 UI 连着 → NO_UI，不挂起
//   4. 正常链路：挂起 → 模拟用户作答 → ok + answers 回传
//   5. 中断链路：外部 abort → INTERACTION_CANCELLED

function parse(result) {
  return JSON.parse(result)
}

// 一个不会因 write 抛错而被 SSE 客户端表清掉的假客户端
function fakeClient() {
  return { write: () => true }
}

// ── 1. EMPTY_QUESTIONS ─────────────────────────────────────────────────────
assert.equal(parse(await execAskUserQuestion()).code, 'EMPTY_QUESTIONS',
  'no args should yield EMPTY_QUESTIONS')

assert.equal(parse(await execAskUserQuestion({ questions: [] })).code, 'EMPTY_QUESTIONS',
  'empty questions should yield EMPTY_QUESTIONS')

assert.equal(
  parse(await execAskUserQuestion({
    questions: [
      { question: '没有 id' },
      { id: 'q1' },
      { id: '', question: '空 id' },
    ],
  })).code,
  'EMPTY_QUESTIONS',
  'questions without id or question text should be dropped and yield EMPTY_QUESTIONS',
)

// ── 2. 规范化（重复 id / 空选项 / multi_select）────────────────────────────
assert.equal(getSSEClientCount(), 0, 'test must start with no SSE clients')
const client = fakeClient()
addSSEClient(client)

const normalizePromise = execAskUserQuestion({
  questions: [
    {
      id: 'mode',
      question: '走哪条路？',
      header: '选择模式',
      multi_select: true,
      options: [
        { label: '  方案A  ', description: '  更快 ' },
        { label: '', description: '空标签应被剔除' },
        { label: '方案B' },
      ],
    },
    {
      id: 'mode', // 重复 id，只保留第一条
      question: '重复的问题',
    },
  ],
})

let pendingViews = listPendingInteractions()
assert.equal(pendingViews.length, 1, 'exactly one question interaction should be pending')
const view = pendingViews[0]
assert.equal(view.kind, 'question', 'interaction kind should be question')
assert.equal(view.toolName, 'ask_user_question')

const q = view.questions[0]
assert.equal(q.id, 'mode')
assert.equal(q.question, '走哪条路？')
assert.equal(q.header, '选择模式')
assert.equal(q.multiSelect, true, 'snake_case multi_select should normalize to camelCase')
assert.equal(view.questions.length, 1, 'duplicate question id should be dropped')
assert.equal(q.options.length, 2, 'blank option labels should be dropped')
assert.equal(q.options[0].label, '方案A', 'option label should be trimmed')
assert.equal(q.options[0].description, '更快', 'option description should be trimmed')

// 收尾：取消这个挂起，不留下等待中的 Promise
getPendingInteraction(view.id).cancel('测试结束')
assert.equal(parse(await normalizePromise).code, 'INTERACTION_CANCELLED')

// ── 3. NO_UI：撤掉所有客户端后，不能挂起 ──────────────────────────────────
removeSSEClient(client)
assert.equal(getSSEClientCount(), 0)
const noUi = parse(await execAskUserQuestion({
  questions: [{ id: 'q', question: '有人在吗？' }],
}))
assert.equal(noUi.code, 'NO_UI', 'no connected UI should yield NO_UI instead of suspending')
assert.equal(noUi.ok, false)

// ── 4. 正常链路：模拟用户作答 ─────────────────────────────────────────────
addSSEClient(client)
const askPromise = execAskUserQuestion({
  questions: [
    {
      id: 'choice',
      question: '用哪个方案？',
      options: [
        { label: '方案A (Recommended)' },
        { label: '方案B' },
      ],
    },
  ],
})

const askView = listPendingInteractions()[0]
assert.ok(askView, 'a question interaction should be pending while awaiting an answer')
// 用户点选「方案A (Recommended)」→ 答案通过 pending 记录回到执行体
const answered = getPendingInteraction(askView.id).answer({
  answers: [{ id: 'choice', selected: ['方案A (Recommended)'] }],
})
assert.equal(answered, true, 'answer should settle the pending interaction')

const happy = parse(await askPromise)
assert.equal(happy.ok, true)
assert.deepEqual(happy.answers, [
  { id: 'choice', selected: ['方案A (Recommended)'] },
])
assert.equal(listPendingInteractions().length, 0, 'settled interaction should be removed')

// ── 5. 中断链路：abort signal ──────────────────────────────────────────────
const controller = new AbortController()
const abortPromise = execAskUserQuestion(
  { questions: [{ id: 'late', question: '还来得及吗？' }] },
  { signal: controller.signal },
)
assert.equal(listPendingInteractions().length, 1, 'question should be pending before abort')
controller.abort()
const aborted = parse(await abortPromise)
assert.equal(aborted.ok, false)
assert.equal(aborted.code, 'INTERACTION_CANCELLED', 'abort should cancel the pending question')
assert.equal(listPendingInteractions().length, 0, 'cancelled interaction should be removed')

removeSSEClient(client)

console.log('test-ask-user-question: all assertions passed')
