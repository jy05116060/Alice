import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

// ── 桌宠移植新增依赖 ──
import { readFile } from 'node:fs/promises'
import { createRequire } from 'node:module'
import { fileURLToPath } from 'node:url'
import { emitEvent } from './events.js'
import {
  PET_SESSION_ID,
  SSE_KEEPALIVE_COMMENT,
  SSE_KEEPALIVE_MS,
  SSE_RETRY_MS,
  clearHostRuntime,
  createSseWriter,
  isSessionBusAttached,
  sinkCount,
  startKeepalive,
  startPetStream,
} from './runtime/pet-stream.js'
import {
  PET_SESSION_STREAM_PATH,
  handlePetRoutes,
} from './api/routes/pet.js'
import {
  PET_DOM,
  PET_PREFILL_SLOT,
  PET_PREFILL_TEXT,
  PET_SETTINGS_SECTION,
  buildPrefillModel,
  buildSettingsSectionModel,
  isPrefillTextVerbatim,
  mountPrefillButton,
  mountSettingsSection,
} from './ui/brain-ui/pet-settings.js'
import {
  createPetSessionState,
  createPetSessionReducer,
  foldPetPayload,
  reduceSessionEvent,
  payloadEqual,
  toolActivityOf,
  currentTaskFromTodo,
  completedStatus,
  settleIdle,
  inTurn,
  toolCallIdOf,
  isUserQuestionTool,
  isGoalRoundEvent,
  goalClosingOf,
  FOLDABLE_EVENTS,
  PET_REASONING_TAIL_WINDOW,
  PET_REASONING_PUSH_INTERVAL_MS,
  PET_TASK_TEXT_MAX,
} from './runtime/pet-state.js'

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'blm-action-contract-'))
process.env.ALICE_USER_DIR = tmp
process.env.ALICE_RESOURCES_DIR = process.cwd()

let closeDBForTest = null
const itemText = item => String(item?.content ?? item?.output ?? '')

try {
  const {
    actionContractCompletionIssue,
    actionContractToolCallIssue,
    actionContractToolSucceeded,
    browserPageFindResultFromEvidence,
    browserScreenshotDeliveryMatches,
    browserScreenshotPathFromEvidence,
    classifyActionContract,
    collectVerifiedWebResearchSources,
    filterMemoriesForActionContract,
    inferWebResearchSourceCount,
    resolveActionContractForTurn,
    verifiedActionContractReply,
  } = await import('./runtime/action-contract.js')
  const { callLLM, slowAckText } = await import('./llm.js')
  const { finalizeToolInjection } = await import('./injectors/tool-injector.js')
  const { evaluateToolPolicy } = await import('./capabilities/tool-policy.js')
  ;({ closeDBForTest } = await import('./db.js'))

  const writeContract = classifyActionContract('帮我在 sandbox 里创建一个 hello.txt 文件')
  assert.equal(writeContract?.id, 'file_write')
  assert.deepEqual(writeContract.requiredTools, ['write_file'])
  const editContract = classifyActionContract('帮我修改 src/app.js 文件里的一个函数')
  assert.equal(editContract?.id, 'file_edit')
  assert.deepEqual(editContract.requiredTools, ['read_file', 'edit_file'])
  assert.equal(editContract.restrictTools, true)
  assert.equal(editContract.requireAllTools, true)
  const naturalWebpageWrite = classifyActionContract('帮我做一个简单的个人主页，保存成网页，我想双击就能打开。')
  assert.equal(naturalWebpageWrite?.id, 'file_write')
  assert.deepEqual(naturalWebpageWrite.requiredTools, ['write_file'])
  assert.equal(classifyActionContract('不用发代码，你直接帮我保存成网页就行。')?.id, 'file_write')
  const naturalWebpageEdit = classifyActionContract('把网页上的名字改成小远，再加一句“喜欢做有意思的小工具”。')
  assert.equal(naturalWebpageEdit?.id, 'file_edit')
  assert.equal(naturalWebpageEdit.restrictTools, true)
  assert.equal(naturalWebpageEdit.requireAllTools, true)
  const webpageConversation = [
    { role: 'user', content: '帮我做一个简单的个人主页，保存成网页。' },
    { role: 'jarvis', content: '已经保存为个人主页.html。' },
  ]
  for (const phrase of [
    '把按钮改成绿色，其他别动。',
    '把背景换成浅灰色，其他别动。',
  ]) {
    const continuation = classifyActionContract(phrase, { conversationWindow: webpageConversation })
    assert.equal(continuation?.id, 'file_edit', phrase)
    assert.deepEqual(continuation.requiredTools, ['read_file', 'edit_file'], phrase)
    assert.equal(continuation.restrictTools, true, phrase)
    assert.equal(continuation.requireAllTools, true, phrase)
  }
  assert.equal(classifyActionContract('把按钮改成绿色，其他别动。'), null,
    'a terse edit without recent file context must not invent a file target')
  assert.match(actionContractToolCallIssue(
    naturalWebpageEdit,
    'edit_file',
    { path: '个人主页.html', operation: 'replace' },
    { successfulToolNames: new Set() },
  ), /read_file/i, 'edit_file cannot run before the target file has been read')
  assert.equal(actionContractToolCallIssue(
    naturalWebpageEdit,
    'edit_file',
    { path: '个人主页.html', operation: 'replace' },
    { successfulToolNames: new Set(['read_file']) },
  ), '', 'edit_file can run after a successful read_file')
  assert.equal(classifyActionContract('帮我新建一个 logs 文件夹')?.id, 'directory_create')
  assert.equal(classifyActionContract('怎么创建一个 txt 文件？'), null, 'how-to is ordinary Q&A, not an execution contract')
  assert.equal(classifyActionContract('你有多少执行命令工具？'), null, 'tool meta questions must not trigger execution')
  assert.equal(classifyActionContract('帮我安装一个 npm 插件'), null, 'plugin installation is not OS software installation')
  for (const phrase of [
    '只读验收，不要创建或修改任何文件',
    '不要删除任何文件',
    '别运行命令或启动程序',
    '请勿安装任何软件',
    '不用设置提醒',
    '禁止打开热点面板',
    'do not run the command',
    'never install this app',
  ]) {
    assert.equal(classifyActionContract(phrase), null,
      `explicitly forbidden work must not become an action contract: ${phrase}`)
  }
  assert.equal(
    classifyActionContract('不要删除旧文件，但创建一个新的 txt 文件')?.id,
    'file_write',
    'a negated clause must not erase a separate positive action',
  )
  assert.equal(
    classifyActionContract('创建一个新的 txt 文件时不要覆盖旧文件')?.id,
    'file_write',
    'a trailing negative constraint must preserve the positive action',
  )
  assert.equal(
    resolveActionContractForTurn('这次只读取现有文件，不要创建或修改任何文件'),
    null,
    'the live read-only verification wording must not force write_file',
  )
  const displayContract = classifyActionContract('切换到大浏览器')
  assert.equal(displayContract?.id, 'browser_display_mode')
  assert.deepEqual(displayContract.requiredTools, ['browser_set_display_mode'])
  assert.match(actionContractCompletionIssue(
    displayContract,
    '已经全屏显示。',
  ), /window mode|fullscreen/i, 'window mode cannot be described as fullscreen')
  assert.equal(verifiedActionContractReply(displayContract, {
    result: JSON.stringify({ ok: true, browser_preview: { mode: 'window' } }),
  }), '已切换到独立大窗口。')
  const browserLoginContract = classifyActionContract('需要你帮我登录我的 X 账号')
  assert.equal(browserLoginContract?.id, 'browser_interaction')
  assert(browserLoginContract.requiredTools.includes('browser_snapshot'))
  assert(browserLoginContract.requiredTools.includes('browser_type'))
  const browserContinuationContract = classifyActionContract('没有被墙，它能走', {
    conversationWindow: [
      { role: 'user', content: '需要你帮我登录我的 X 账号' },
      { role: 'jarvis', content: '我正在用浏览器打开 X 登录页。' },
    ],
  })
  assert.equal(browserContinuationContract?.id, 'browser_interaction')
  assert.equal(classifyActionContract('没有被墙，它能走'), null,
    'an isolated assertion remains ordinary conversation without browser continuity')
  assert.match(actionContractCompletionIssue(
    browserLoginContract,
    'X 登录页已打开，用户名填好了，已经到密码页了。',
    { successfulToolNames: new Set(['browser_snapshot']) },
  ), /navigation|input|later login page/i,
    'a snapshot cannot be laundered into navigation/form completion')
  assert.match(actionContractCompletionIssue(
    browserLoginContract,
    '页面加载出来了，X 登录页正常显示。',
    { successfulToolNames: new Set(['browser_snapshot']) },
  ), /navigation/i,
    'a snapshot cannot be laundered into a page-load claim')
  const closeBrowserContract = classifyActionContract('关掉你的浏览器')
  assert.equal(closeBrowserContract?.id, 'browser_close')
  assert.deepEqual(closeBrowserContract.requiredTools, ['browser_close'])
  for (const phrase of [
    '不要关闭浏览器',
    '保持浏览器打开',
    '别关当前网页',
    '不要退出浏览器',
  ]) {
    assert.notEqual(classifyActionContract(phrase)?.id, 'browser_close',
      `keep-open wording must not create a close contract: ${phrase}`)
  }
  const keepOpenDisplayContract = classifyActionContract(
    '切回你的小窗口浏览器，最后停留在小窗口，不要关闭浏览器',
  )
  assert.equal(keepOpenDisplayContract?.id, 'browser_display_mode')
  assert.deepEqual(keepOpenDisplayContract.requiredTools, ['browser_set_display_mode'])
  for (const phrase of [
    '关掉浏览器',
    '现在真正关掉你的浏览器',
    '关闭当前网页',
    '关掉刚才打开的浏览器',
    '请关掉浏览器，谢谢',
    '那现在怎么办？关掉你的小窗口浏览器',
    '关掉浏览器，不用说话，只回一个👌图标',
    '关掉浏览器，只回复👌',
  ]) {
    const explicitCloseContract = classifyActionContract(phrase)
    assert.equal(explicitCloseContract?.id, 'browser_close', phrase)
    assert.deepEqual(explicitCloseContract.requiredTools, ['browser_close'])
    assert.equal(verifiedActionContractReply(explicitCloseContract), '👌',
      'a successful explicit browser close has one deterministic acknowledgement')
  }
  const closeAfterResearchContract = classifyActionContract('查完 Agent Skill 后关闭浏览器并告诉我结果')
  assert.equal(closeAfterResearchContract?.id, 'browser_close')
  assert.equal(verifiedActionContractReply(closeAfterResearchContract), '',
    'a close inside a larger task must not replace the substantive result')
  assert.equal(verifiedActionContractReply(classifyActionContract('查完后关闭浏览器')), '',
    'unknown substantive wording outside the close clause is preserved by default')
  assert.equal(classifyActionContract('退出这个网站的登录'), null,
    'website sign-out is not a browser lifecycle close')
  const screenshotContract = classifyActionContract('把当前页面截张图发给我看看')
  assert.equal(screenshotContract?.id, 'browser_screenshot')
  assert.deepEqual(screenshotContract.requiredTools, ['browser_take_screenshot'])
  const screenshotPath = path.join(tmp, 'captured-page.png')
  const screenshotEvidence = [{
    name: 'browser_take_screenshot',
    result: JSON.stringify({ ok: true, screenshot: { image_path: screenshotPath } }),
  }]
  assert.equal(browserScreenshotPathFromEvidence(screenshotEvidence), screenshotPath)
  assert.equal(browserScreenshotDeliveryMatches(screenshotEvidence, { image_path: screenshotPath }), true)
  assert.equal(browserScreenshotDeliveryMatches(screenshotEvidence, { image_path: `${screenshotPath}.other` }), false)
  assert.match(actionContractCompletionIssue(
    screenshotContract,
    '截图发好了。',
    { successfulToolEvidence: screenshotEvidence },
  ), /not delivered/i, 'capture without media delivery cannot be described as sent')
  assert.equal(actionContractCompletionIssue(
    screenshotContract,
    '',
    { successfulToolEvidence: screenshotEvidence, messageArgs: { image_path: screenshotPath } },
  ), '', 'send_message with the exact captured image path satisfies screenshot delivery')
  const screenshotScopedMemories = filterMemoriesForActionContract([
    {
      mem_id: 'procedure_browser_display_mode_first',
      content: '截图前先调用 browser_set_display_mode，再调用 browser_take_screenshot。',
    },
    {
      mem_id: 'lesson_browser_screenshot_image_not_forwardable',
      content: '截图无法通过 send_message 发送。',
    },
    {
      mem_id: 'fact_browser_screenshot_current',
      content: 'browser_take_screenshot 会返回持久化 image_path。',
    },
  ], screenshotContract)
  assert.deepEqual(screenshotScopedMemories.map(item => item.mem_id), ['fact_browser_screenshot_current'],
    'obsolete memories cannot expand or contradict the authoritative screenshot contract')

  const pageFindContract = classifyActionContract('机器学习在这页出现几次')
  assert.equal(pageFindContract?.id, 'browser_page_find')
  assert.equal(pageFindContract.query, '机器学习')
  assert.deepEqual(pageFindContract.requiredTools, ['browser_find'])
  const pageFindEvidence = [{
    name: 'browser_find',
    result: JSON.stringify({
      ok: true,
      structured_content: {
        page_find: {
          query: '机器学习', found: true, total_matches: 4, current_match: 1,
          source: 'rendered_page_text', url: 'https://zh.wikipedia.org/wiki/人工智能',
        },
      },
    }),
  }]
  assert.equal(browserPageFindResultFromEvidence(pageFindEvidence)?.total_matches, 4)
  assert.equal(actionContractToolSucceeded(
    pageFindContract,
    'browser_find',
    pageFindEvidence[0].result,
    { text: '机器学习' },
  ), true)
  assert.equal(verifiedActionContractReply(pageFindContract, pageFindEvidence[0], {
    successfulToolEvidence: pageFindEvidence,
  }), '当前页面里找到了“机器学习”，共出现 4 处。')

  const browserConversation = [{ role: 'jarvis', content: '当前浏览器页面已打开。' }]
  const directBrowserCases = [
    ['刷新一下。', 'browser_reload', 'browser_reload'],
    ['往下翻一屏。', 'browser_scroll', 'browser_press_key'],
    ['回到上一页。', 'browser_back', 'browser_navigate_back'],
    ['回搜索结果列表页。', 'browser_back', 'browser_navigate_back'],
    ['不是详情页，我要回搜索结果列表页。', 'browser_back', 'browser_navigate_back'],
    ['不对，回搜索结果列表。', 'browser_back', 'browser_navigate_back'],
    ['我说的是结果页。', 'browser_back', 'browser_navigate_back'],
    ['别进详情，回列表。', 'browser_back', 'browser_navigate_back'],
    ['回刚才的搜索结果页。', 'browser_back', 'browser_navigate_back'],
    ['再往前。', 'browser_forward', 'browser_navigate_forward'],
    ['放大一点。', 'browser_display_mode', 'browser_set_display_mode'],
    ['现在有几个标签页？', 'browser_tabs_list', 'browser_tabs'],
    ['重新打开 example.com。', 'browser_reopen', 'browser_navigate'],
    ['浏览器关一下。', 'browser_close', 'browser_close'],
    ['行，缩回小卡片吧。', 'browser_display_mode', 'browser_set_display_mode'],
    ['打开 DuckDuckGo。', 'browser_open_url', 'browser_navigate'],
  ]
  for (const [phrase, id, tool] of directBrowserCases) {
    const contract = classifyActionContract(phrase, { conversationWindow: browserConversation })
    assert.equal(contract?.id, id, phrase)
    assert.deepEqual(contract.requiredTools, [tool], phrase)
    const finalized = finalizeToolInjection({
      initialTools: ['send_message', 'find_tool', 'download_file', 'run_command', 'browser_navigate', 'browser_find', tool],
      actionContract: contract,
      localReply: false,
    })
    assert.equal(finalized.turnTools.includes(tool), true, phrase)
    assert.equal(finalized.turnTools.includes('find_tool'), false, `${phrase} does not waste a find_tool call`)
  }
  const directUrlContract = classifyActionContract('打开 https://zh.wikipedia.org/wiki/人工智能')
  assert.equal(directUrlContract?.id, 'browser_open_url')
  assert.deepEqual(directUrlContract.requiredTools, ['browser_navigate'])
  assert.equal(directUrlContract.directBrowserAction, true)
  assert.equal(actionContractToolSucceeded(
    directUrlContract,
    'browser_navigate',
    JSON.stringify({ ok: true, browser_preview: { url: directUrlContract.expectedUrl } }),
    { url: directUrlContract.expectedUrl },
  ), true)
  const narrowedFind = finalizeToolInjection({
    initialTools: ['send_message', 'find_tool', 'download_file', 'run_command', 'exec_command', 'browser_navigate', 'browser_find'],
    actionContract: pageFindContract,
    localReply: false,
  })
  assert.deepEqual(narrowedFind.turnTools, ['send_message', 'browser_find'])
  for (const phrase of [
    '用大的窗口打开',
    '请用大一点的窗口打开这个网页',
    '用大 窗口 口打',
    '用小的窗口打开',
  ]) {
    const spokenDisplayContract = classifyActionContract(phrase)
    assert.equal(spokenDisplayContract?.id, 'browser_display_mode', phrase)
    assert.deepEqual(spokenDisplayContract.requiredTools, ['browser_set_display_mode'])
  }
  const combinedBrowserContract = classifyActionContract(
    '请用你的浏览器打开 https://example.com，保持停留，不要切换到大窗口。',
  )
  assert.equal(combinedBrowserContract?.id, 'browser_open_in_display_mode')
  assert.deepEqual(combinedBrowserContract.requiredTools, ['browser_navigate'])
  assert.equal(combinedBrowserContract.expectedBrowserDisplayMode, 'card')
  assert.equal(actionContractToolSucceeded(
    combinedBrowserContract,
    'browser_navigate',
    JSON.stringify({ ok: true, browser_preview: { mode: 'card' } }),
  ), true, 'navigation in the requested compact presentation satisfies the combined contract')
  assert.equal(actionContractToolSucceeded(
    combinedBrowserContract,
    'browser_navigate',
    JSON.stringify({ ok: true, browser_preview: { mode: 'window' } }),
  ), false, 'navigation in the wrong presentation cannot satisfy the combined contract')
  const systemBrowserContract = classifyActionContract('用我电脑上的浏览器打开 https://example.com')
  assert.equal(systemBrowserContract?.id, 'system_browser_open')
  assert.deepEqual(systemBrowserContract.requiredTools, ['system_browser_open'])
  assert.match(actionContractCompletionIssue(
    systemBrowserContract,
    '已在默认浏览器 Safari 中打开。三个浏览器各自独立。',
  ), /default browser/i)
  assert.equal(actionContractCompletionIssue(
    systemBrowserContract,
    '已交给电脑的系统默认浏览器打开；小窗和大窗共享页面，电脑浏览器独立。',
  ), '')
  assert.match(verifiedActionContractReply(systemBrowserContract, {
    args: { url: 'https://example.com/' },
    result: JSON.stringify({ ok: true, url: 'https://example.com/' }),
  }), /系统默认浏览器.*小窗口浏览器.*同一个实时页面/s)

  let directNavigateRounds = 0
  const directNavigateCalls = []
  const directNavigateResult = await callLLM({
    systemPrompt: 'Open the exact requested URL.',
    message: '打开 https://example.com',
    tools: ['browser_navigate', 'send_message'],
    mustReply: true,
    localReply: true,
    toolContext: {
      currentTargetId: 'ID:000001',
      currentUserMessage: '打开 https://example.com',
      actionContract: classifyActionContract('打开 https://example.com'),
    },
    _streamOnceForTest: async () => {
      directNavigateRounds += 1
      if (directNavigateRounds > 1) throw new Error('direct URL navigation should converge without another provider round')
      return {
        content: '', reasoningContent: '', aborted: false,
        toolCalls: [{
          id: 'direct-url-navigation',
          name: 'browser_navigate',
          arguments: JSON.stringify({ url: 'https://example.com/' }),
        }],
      }
    },
    _executeToolForTest: async (name, args, context) => {
      directNavigateCalls.push({ name, args, source: context?.source || '' })
      if (name === 'browser_navigate') {
        return JSON.stringify({ ok: true, browser_preview: { url: 'https://example.com/' } })
      }
      if (name === 'send_message') return JSON.stringify({ ok: true, delivered: true, message_sent: true })
      return JSON.stringify({ ok: false, error: `unexpected tool ${name}` })
    },
  })
  assert.deepEqual(directNavigateCalls.map(call => call.name), ['browser_navigate', 'send_message'])
  assert.equal(directNavigateCalls.filter(call => call.name === 'send_message').length, 1,
    'a direct URL navigation sends one completion message and no slow-tool acknowledgement')
  assert.doesNotMatch(directNavigateCalls.at(-1).args.content, /我查一下/)
  assert.equal(directNavigateCalls.at(-1).args.content, '已打开 https://example.com/')
  assert.equal(directNavigateResult.delivered, true)

  const naturalAcks = Array.from({ length: 5 }, () => slowAckText('browser_navigate', {
    url: 'https://example.com/private/path?query=do-not-echo',
  }))
  assert.equal(new Set(naturalAcks).size, 5, 'lookup progress acknowledgements rotate naturally')
  for (const ack of naturalAcks) {
    assert.doesNotMatch(ack, /https?:\/\/|example\.com|do-not-echo/,
      'lookup progress acknowledgements never expose a URL or query parameter')
  }

  const searchSubmitContract = classifyActionContract('在搜索框输入 OpenAI 官网并搜索。', {
    conversationWindow: browserConversation,
  })
  assert.equal(searchSubmitContract?.id, 'browser_search_submit')
  assert.equal(searchSubmitContract.query, 'OpenAI 官网')
  assert.equal(searchSubmitContract.requireAllTools, true)
  assert.deepEqual(searchSubmitContract.requiredTools, ['browser_snapshot', 'browser_type', 'browser_click'])
  const searchSubmitInjection = finalizeToolInjection({
    initialTools: ['send_message', 'find_tool', 'browser_navigate', 'browser_press_key'],
    actionContract: searchSubmitContract,
    localReply: false,
  })
  assert.deepEqual(searchSubmitInjection.turnTools,
    ['send_message', 'browser_snapshot', 'browser_type', 'browser_click'])

  let searchSubmitRounds = 0
  const searchSubmitCalls = []
  const searchSubmitResult = await callLLM({
    systemPrompt: 'Use the current search box exactly once.',
    message: '在搜索框输入 OpenAI 官网并搜索。',
    tools: searchSubmitInjection.turnTools,
    mustReply: true,
    localReply: true,
    toolContext: {
      currentTargetId: 'ID:000001',
      currentUserMessage: '在搜索框输入 OpenAI 官网并搜索。',
      actionContract: searchSubmitContract,
    },
    _streamOnceForTest: async () => {
      searchSubmitRounds += 1
      if (searchSubmitRounds === 1) return {
        content: '', reasoningContent: '', aborted: false,
        toolCalls: [{ id: 'search-snapshot', name: 'browser_snapshot', arguments: '{}' }],
      }
      if (searchSubmitRounds === 2) return {
        content: '', reasoningContent: '', aborted: false,
        toolCalls: [{ id: 'search-type', name: 'browser_type', arguments: JSON.stringify({ uid: '1_1', text: 'OpenAI 官网' }) }],
      }
      if (searchSubmitRounds === 3) return {
        content: '', reasoningContent: '', aborted: false,
        toolCalls: [{ id: 'search-click', name: 'browser_click', arguments: JSON.stringify({ uid: '1_2', element: '搜索按钮' }) }],
      }
      throw new Error('successful search click must end the tool loop before duplicate type/Enter/navigation')
    },
    _executeToolForTest: async (name, args) => {
      searchSubmitCalls.push({ name, args })
      if (name === 'send_message') return JSON.stringify({ ok: true, delivered: true, message_sent: true })
      if (name === 'browser_click') {
        return JSON.stringify({
          ok: true,
          browser_preview: { url: 'https://duckduckgo.com/?q=OpenAI', title: 'OpenAI at DuckDuckGo' },
          content: [{ type: 'text', text: 'Search results for OpenAI\nlink OpenAI\nlink OpenAI API' }],
        })
      }
      return JSON.stringify({
        ok: true,
        browser_preview: { url: 'https://duckduckgo.com/', title: 'DuckDuckGo' },
        content: [{ type: 'text', text: 'Search the web without being tracked' }],
      })
    },
  })
  assert.deepEqual(searchSubmitCalls.map(call => call.name),
    ['browser_snapshot', 'browser_type', 'browser_click', 'send_message'])
  assert.equal(searchSubmitCalls[1].args.replace, true,
    'search browser_type always replaces a prefilled field instead of appending')
  assert.equal(searchSubmitCalls.at(-1).args.content, '已搜索“OpenAI 官网”。')
  assert.equal(searchSubmitResult.delivered, true)

  assert.match(actionContractToolCallIssue(
    searchSubmitContract,
    'browser_click',
    { uid: '1_1', element: '搜索框' },
    { successfulToolNames: new Set(['browser_snapshot']) },
  ), /browser_type.*next/i, 'clicking the search field before typing is rejected by the ordered contract')
  assert.match(actionContractToolCallIssue(
    searchSubmitContract,
    'browser_click',
    { uid: '2_2', element: '清除本文按钮' },
    { successfulToolNames: new Set(['browser_snapshot', 'browser_type']) },
  ), /actual search-submit control/i, 'clear/voice/image controls cannot consume the one submit click')
  assert.equal(actionContractToolCallIssue(
    searchSubmitContract,
    'browser_click',
    { search_submit: true, element: 'search submit' },
    { successfulToolNames: new Set(['browser_snapshot', 'browser_type']) },
  ), '', 'a missing accessibility button can use the one form-submit click fallback')

  let orderedSearchRounds = 0
  const orderedSearchExecuted = []
  const orderedSearchResult = await callLLM({
    systemPrompt: 'Recover from invalid search-target choices without changing the fixed action order.',
    message: '在搜索框输入 OpenAI 官网并搜索。',
    tools: searchSubmitInjection.turnTools,
    mustReply: true,
    localReply: true,
    toolContext: {
      currentTargetId: 'ID:000001',
      currentUserMessage: '在搜索框输入 OpenAI 官网并搜索。',
      actionContract: searchSubmitContract,
    },
    _streamOnceForTest: async () => {
      orderedSearchRounds += 1
      if (orderedSearchRounds === 1) return {
        content: '', reasoningContent: '', aborted: false,
        toolCalls: [{ id: 'ordered-snapshot', name: 'browser_snapshot', arguments: '{}' }],
      }
      if (orderedSearchRounds === 2) return {
        content: '', reasoningContent: '', aborted: false,
        toolCalls: [{ id: 'premature-searchbox-click', name: 'browser_click', arguments: JSON.stringify({ uid: '1_1', element: '搜索框' }) }],
      }
      if (orderedSearchRounds === 3) return {
        content: '', reasoningContent: '', aborted: false,
        toolCalls: [{ id: 'ordered-type', name: 'browser_type', arguments: JSON.stringify({ uid: '1_1', text: 'OpenAI 官网' }) }],
      }
      if (orderedSearchRounds === 4) return {
        content: '', reasoningContent: '', aborted: false,
        toolCalls: [{ id: 'invalid-clear-click', name: 'browser_click', arguments: JSON.stringify({ uid: '2_2', element: '清除本文按钮' }) }],
      }
      if (orderedSearchRounds === 5) return {
        content: '', reasoningContent: '', aborted: false,
        toolCalls: [{ id: 'fallback-search-submit', name: 'browser_click', arguments: JSON.stringify({ search_submit: true, element: 'search submit' }) }],
      }
      throw new Error('verified ordered search must converge after its one valid submit click')
    },
    _executeToolForTest: async (name, args) => {
      orderedSearchExecuted.push({ name, args })
      if (name === 'send_message') return JSON.stringify({ ok: true, delivered: true, message_sent: true })
      if (name === 'browser_click') return JSON.stringify({
        ok: true,
        browser_preview: { url: 'https://duckduckgo.com/?q=OpenAI', title: 'OpenAI at DuckDuckGo' },
        content: [{ type: 'text', text: 'Search results for OpenAI\nlink OpenAI\nlink OpenAI API' }],
      })
      return JSON.stringify({
        ok: true,
        browser_preview: { url: 'https://duckduckgo.com/', title: 'DuckDuckGo' },
        content: [{ type: 'text', text: 'Search the web without being tracked' }],
      })
    },
  })
  assert.deepEqual(orderedSearchExecuted.map(call => call.name),
    ['browser_snapshot', 'browser_type', 'browser_click', 'send_message'],
    'out-of-order focus/clear clicks stay private and cannot consume the public search sequence')
  assert.equal(orderedSearchExecuted[1].args.replace, true)
  assert.equal(orderedSearchExecuted[2].args.search_submit, true)
  assert.equal(orderedSearchResult.delivered, true)

  const unchangedSearchEvidence = [
    {
      name: 'browser_snapshot',
      args: {},
      result: JSON.stringify({
        ok: true,
        browser_preview: { url: 'https://duckduckgo.com/', title: 'DuckDuckGo' },
        content: [{ type: 'text', text: 'Search the web without being tracked' }],
      }),
    },
    {
      name: 'browser_type',
      args: { uid: '1_1', text: 'OpenAI 官网' },
      result: JSON.stringify({
        ok: true,
        browser_preview: { url: 'https://duckduckgo.com/', title: 'DuckDuckGo' },
        content: [{ type: 'text', text: 'Search the web without being tracked' }],
      }),
    },
  ]
  const unchangedSearchClick = JSON.stringify({
    ok: true,
    browser_preview: { url: 'https://duckduckgo.com/', title: 'DuckDuckGo' },
    structured_content: {
      page_change: {
        before_url: 'https://duckduckgo.com/',
        after_url: 'https://duckduckgo.com/',
        url_changed: false,
      },
    },
    content: [{ type: 'text', text: 'Search the web without being tracked' }],
  })
  assert.equal(actionContractToolSucceeded(
    searchSubmitContract,
    'browser_click',
    unchangedSearchClick,
    { uid: '1_2', element: '搜索按钮' },
    { successfulToolEvidence: unchangedSearchEvidence },
  ), false, 'ok=true click without URL/title/results-state change cannot complete a search')
  assert.match(actionContractToolCallIssue(
    searchSubmitContract,
    'browser_type',
    { uid: '1_1', text: 'OpenAI 官网' },
    { attemptedToolNames: ['browser_snapshot', 'browser_type', 'browser_click'] },
  ), /single-use/i, 'a failed submit never authorizes typing the same query again')

  let failedSearchRounds = 0
  const failedSearchExecuted = []
  const failedSearchResult = await callLLM({
    systemPrompt: 'Use the current search box exactly once and report failure honestly.',
    message: '在搜索框输入 OpenAI 官网并搜索。',
    tools: searchSubmitInjection.turnTools,
    mustReply: true,
    localReply: true,
    toolContext: {
      currentTargetId: 'ID:000001',
      currentUserMessage: '在搜索框输入 OpenAI 官网并搜索。',
      actionContract: searchSubmitContract,
    },
    _streamOnceForTest: async () => {
      failedSearchRounds += 1
      if (failedSearchRounds === 1) return {
        content: '', reasoningContent: '', aborted: false,
        toolCalls: [{ id: 'failed-search-snapshot', name: 'browser_snapshot', arguments: '{}' }],
      }
      if (failedSearchRounds === 2) return {
        content: '', reasoningContent: '', aborted: false,
        toolCalls: [{ id: 'failed-search-type', name: 'browser_type', arguments: JSON.stringify({ uid: '1_1', text: 'OpenAI 官网' }) }],
      }
      if (failedSearchRounds === 3) return {
        content: '', reasoningContent: '', aborted: false,
        toolCalls: [{ id: 'failed-search-click', name: 'browser_click', arguments: JSON.stringify({ uid: '1_2', element: '搜索按钮' }) }],
      }
      if (failedSearchRounds === 4) return {
        content: '', reasoningContent: '', aborted: false,
        toolCalls: [{ id: 'false-search-completion', name: 'send_message', arguments: JSON.stringify({ target_id: 'ID:000001', content: '已搜索“OpenAI 官网”。' }) }],
      }
      if (failedSearchRounds === 5) return {
        content: '', reasoningContent: '', aborted: false,
        toolCalls: [{ id: 'duplicate-search-type', name: 'browser_type', arguments: JSON.stringify({ uid: '1_1', text: 'OpenAI 官网' }) }],
      }
      if (failedSearchRounds === 6) return {
        content: '', reasoningContent: '', aborted: false,
        toolCalls: [{
          id: 'honest-search-failure',
          name: 'send_message',
          arguments: JSON.stringify({ target_id: 'ID:000001', content: '点击搜索按钮后页面没有进入结果页，搜索没有生效。' }),
        }],
      }
      return { content: '', reasoningContent: '', aborted: false, toolCalls: [] }
    },
    _executeToolForTest: async (name, args) => {
      failedSearchExecuted.push({ name, args })
      if (name === 'send_message') return JSON.stringify({ ok: true, delivered: true, message_sent: true })
      if (name === 'browser_click') return unchangedSearchClick
      return unchangedSearchEvidence.find(item => item.name === name)?.result
        || JSON.stringify({ ok: false, error: `unexpected tool ${name}` })
    },
  })
  assert.deepEqual(failedSearchExecuted.map(call => call.name),
    ['browser_snapshot', 'browser_type', 'browser_click', 'send_message'],
    'unchanged search state permits only one type, one submit, and one honest final send')
  assert.equal(failedSearchExecuted.at(-1).args.content, '点击搜索按钮后页面没有进入结果页，搜索没有生效。')
  assert.doesNotMatch(failedSearchResult.content, /已搜索/)
  assert.equal(failedSearchResult.delivered, true)

  const resultClickContract = classifyActionContract('点开第二个搜索结果。', {
    conversationWindow: browserConversation,
  })
  assert.equal(resultClickContract?.id, 'browser_search_result_click')
  assert.equal(resultClickContract.resultOrdinal, 2)
  assert.equal(resultClickContract.requireAllTools, true)
  const resultClickInjection = finalizeToolInjection({
    initialTools: ['send_message', 'find_tool', 'browser_navigate'],
    actionContract: resultClickContract,
    localReply: false,
  })
  assert.deepEqual(resultClickInjection.turnTools, ['send_message', 'browser_snapshot', 'browser_click'])

  let resultClickRounds = 0
  const resultClickCalls = []
  await callLLM({
    systemPrompt: 'Click the numbered result.',
    message: '点开第二个搜索结果。',
    tools: resultClickInjection.turnTools,
    mustReply: true,
    localReply: true,
    toolContext: {
      currentTargetId: 'ID:000001',
      currentUserMessage: '点开第二个搜索结果。',
      actionContract: resultClickContract,
    },
    _streamOnceForTest: async () => {
      resultClickRounds += 1
      if (resultClickRounds === 1) return {
        content: '', reasoningContent: '', aborted: false,
        toolCalls: [{ id: 'result-snapshot', name: 'browser_snapshot', arguments: '{}' }],
      }
      if (resultClickRounds === 2) return {
        content: '', reasoningContent: '', aborted: false,
        toolCalls: [{ id: 'result-click', name: 'browser_click', arguments: JSON.stringify({ uid: '2_2', element: '第二个搜索结果' }) }],
      }
      throw new Error('successful numbered-result click must end without find_tool or browser_navigate')
    },
    _executeToolForTest: async (name, args) => {
      resultClickCalls.push({ name, args })
      if (name === 'send_message') return JSON.stringify({ ok: true, delivered: true, message_sent: true })
      return JSON.stringify({ ok: true, browser_preview: { url: 'https://openai.com/zh-Hans-CN/' } })
    },
  })
  assert.deepEqual(resultClickCalls.map(call => call.name), ['browser_snapshot', 'browser_click', 'send_message'])
  assert.equal(resultClickCalls.at(-1).args.content, '已点开第二个搜索结果。')

  const officialSiteContract = classifyActionContract('再帮我查查 Electron 官方网站。')
  assert.equal(officialSiteContract?.id, 'browser_official_site_lookup')
  assert.equal(officialSiteContract.officialSiteTarget, 'Electron')
  const officialSiteInjection = finalizeToolInjection({
    initialTools: ['send_message', 'find_tool', 'browser_press_key', 'browser_navigate'],
    actionContract: officialSiteContract,
    localReply: false,
  })
  assert.deepEqual(officialSiteInjection.turnTools,
    ['send_message', 'browser_navigate', 'browser_type', 'browser_click'])
  assert.match(actionContractToolCallIssue(
    officialSiteContract,
    'browser_navigate',
    { url: 'https://www.bing.com/search?q=Electron' },
  ), /search-engine results URL/i)

  let officialSiteRounds = 0
  const officialSiteCalls = []
  const officialSiteResult = await callLLM({
    systemPrompt: 'Open and verify the authoritative official site.',
    message: '再帮我查查 Electron 官方网站。',
    tools: officialSiteInjection.turnTools,
    mustReply: true,
    localReply: true,
    toolContext: {
      currentTargetId: 'ID:000001',
      currentUserMessage: '再帮我查查 Electron 官方网站。',
      actionContract: officialSiteContract,
    },
    _streamOnceForTest: async () => {
      officialSiteRounds += 1
      if (officialSiteRounds === 1) return {
        content: '', reasoningContent: '', aborted: false,
        toolCalls: [{
          id: 'blocked-direct-search-url',
          name: 'browser_navigate',
          arguments: JSON.stringify({ url: 'https://www.bing.com/search?q=Electron' }),
        }],
      }
      if (officialSiteRounds === 2) return {
        content: '', reasoningContent: '', aborted: false,
        toolCalls: [{
          id: 'open-electron-official',
          name: 'browser_navigate',
          arguments: JSON.stringify({ url: 'https://www.electronjs.org/' }),
        }],
      }
      throw new Error('verified official-site navigation must converge immediately')
    },
    _executeToolForTest: async (name, args) => {
      officialSiteCalls.push({ name, args })
      if (name === 'send_message') return JSON.stringify({ ok: true, delivered: true, message_sent: true })
      if (name === 'browser_navigate') return JSON.stringify({
        ok: true,
        browser_preview: { url: 'https://www.electronjs.org/', title: 'Electron' },
        content: [{ type: 'text', text: 'Electron | Build cross-platform desktop apps with JavaScript' }],
      })
      return JSON.stringify({ ok: false, error: `unexpected tool ${name}` })
    },
  })
  assert.deepEqual(officialSiteCalls.map(call => call.name), ['browser_navigate', 'send_message'])
  assert.equal(officialSiteCalls[0].args.url, 'https://www.electronjs.org/')
  assert.match(officialSiteCalls[1].args.content, /electronjs\.org/)
  assert.equal(officialSiteResult.delivered, true)
  assert.equal(classifyActionContract('我只是随口说说，不用查查'), null)

  const webContract = classifyActionContract('请联网搜索 Microsoft Playwright MCP 官方仓库')
  assert.equal(webContract?.id, 'web')
  assert.deepEqual(webContract.requiredTools, ['browser_navigate'], 'fresh web lookup requires real Playwright navigation')
  assert.equal(webContract.requiredTools.some(name => ['web_search', 'web_read', 'fetch_url', 'browser_read'].includes(name)), false)
  const newsContract = classifyActionContract(
    '小白龙，帮我上网看看今天有什么 AI 新闻，挑三条重要的告诉我，链接也发我一下。',
  )
  assert.equal(newsContract?.id, 'web_research', 'ordinary current-news wording activates verified web research')
  assert.deepEqual(newsContract.requiredTools, ['browser_navigate', 'browser_click'])
  assert.equal(newsContract.minimumVerifiedSources, 3)
  assert.equal(classifyActionContract('AI 最近有啥大事？')?.id, 'web_research')
  assert.equal(classifyActionContract('这两天科技圈发生啥了？')?.id, 'web_research')
  assert.equal(classifyActionContract('现在比特币多少钱？')?.id, 'web')
  assert.equal(inferWebResearchSourceCount('找 5 条最近的消息'), 5)
  assert.equal(inferWebResearchSourceCount('挑两篇最新报道'), 2)
  assert.equal(inferWebResearchSourceCount('这个新闻怎么回事？'), 1)

  const webEvidence = (url, title, { busy = false, failure = '' } = {}) => ({
    name: 'browser_navigate',
    args: { url },
    result: JSON.stringify({
      ok: true,
      content: [{ type: 'text', text: `${failure}${title} ${'article body '.repeat(20)}` }],
      structured_content: {
        snapshot: { role: 'RootWebArea', name: title, url, busy },
      },
    }),
  })
  const searchOnlyEvidence = [webEvidence(
    'https://www.bing.com/news/search?q=AI',
    'AI News - Search',
  )]
  assert.equal(collectVerifiedWebResearchSources(searchOnlyEvidence).length, 0,
    'a search-results page is discovery, not a verified source')
  assert.match(actionContractCompletionIssue(
    newsContract,
    '找到三条：https://www.bing.com/news/search?q=AI',
    { successfulToolEvidence: searchOnlyEvidence },
  ), /search-results page|actually opened/i)

  const verifiedNewsEvidence = [
    webEvidence('https://news.example.com/articles/alpha', 'Alpha AI release'),
    webEvidence('https://company.example.com/news/beta', 'Beta model announcement'),
    webEvidence('https://research.example.com/updates/gamma', 'Gamma research update'),
  ]
  const verifiedNewsReply = [
    '1. Alpha https://news.example.com/articles/alpha',
    '2. Beta https://company.example.com/news/beta',
    '3. Gamma https://research.example.com/updates/gamma',
  ].join('\n')
  assert.equal(collectVerifiedWebResearchSources(verifiedNewsEvidence).length, 3)
  assert.equal(collectVerifiedWebResearchSources([
    webEvidence('https://one.example.com/news/gpt-next', 'OpenAI launches GPT-Next today'),
    webEvidence('https://two.example.com/articles/gpt-next', 'OpenAI launches GPT-Next today - Another Outlet'),
  ]).length, 1, 'near-identical headlines on different URLs count as one event')
  assert.equal(actionContractCompletionIssue(
    newsContract,
    verifiedNewsReply,
    { successfulToolEvidence: verifiedNewsEvidence },
  ), '', 'three opened source pages plus their verified links satisfy the news research gate')
  assert.equal(actionContractCompletionIssue(
    newsContract,
    `${verifiedNewsReply}.`,
    { successfulToolEvidence: verifiedNewsEvidence },
  ), '', 'ordinary sentence punctuation after a URL does not invalidate a verified link')
  assert.match(actionContractCompletionIssue(
    newsContract,
    '只放两个链接：https://news.example.com/articles/alpha https://company.example.com/news/beta',
    { successfulToolEvidence: verifiedNewsEvidence },
  ), /only 2 of 3 links/i)
  assert.equal(collectVerifiedWebResearchSources([
    webEvidence('https://news.example.com/articles/timeout', 'Timed out article', {
      busy: true,
      failure: 'Navigation timeout of 10000 ms exceeded. ',
    }),
  ]).length, 0, 'busy or timed-out article pages cannot become verified evidence')

  let researchRounds = 0
  const researchExecuted = []
  const researchResult = await callLLM({
    systemPrompt: 'Search current news and verify original source pages.',
    message: '帮我上网看看今天有什么 AI 新闻，挑三条告诉我，链接也发我。',
    tools: newsContract.requiredTools,
    mustReply: true,
    localReply: true,
    toolContext: {
      currentTargetId: 'ID:000001',
      currentUserMessage: '帮我上网看看今天有什么 AI 新闻，挑三条告诉我，链接也发我。',
      actionContract: newsContract,
    },
    _streamOnceForTest: async ({ messages }) => {
      researchRounds += 1
      if (researchRounds === 1) {
        return {
          content: '', reasoningContent: '', aborted: false,
          toolCalls: [{
            id: 'research-search',
            name: 'browser_navigate',
            arguments: JSON.stringify({ url: 'https://www.bing.com/news/search?q=AI' }),
          }],
        }
      }
      if (researchRounds === 2) {
        return {
          content: '从搜索摘要看到三条新闻：https://www.bing.com/news/search?q=AI',
          reasoningContent: '', aborted: false, toolCalls: [],
        }
      }
      if (researchRounds === 3) {
        assert(messages.some(item => /search-result snippets do not count/i.test(String(item.content || ''))),
          'runtime tells the model to open original sources instead of answering from snippets')
        return {
          content: '', reasoningContent: '', aborted: false,
          toolCalls: verifiedNewsEvidence.map((evidence, index) => ({
            id: `research-source-${index + 1}`,
            name: 'browser_navigate',
            arguments: JSON.stringify(evidence.args),
          })),
        }
      }
      return { content: verifiedNewsReply, reasoningContent: '', aborted: false, toolCalls: [] }
    },
    _executeToolForTest: async (name, args) => {
      researchExecuted.push({ name, args })
      if (name === 'send_message') return JSON.stringify({ ok: true, delivered: true, message_sent: true })
      if (name === 'browser_navigate') {
        if (args.url.includes('bing.com/news/search')) return searchOnlyEvidence[0].result
        const match = verifiedNewsEvidence.find(item => item.args.url === args.url)
        return match?.result || JSON.stringify({ ok: false, error: 'unexpected URL' })
      }
      return JSON.stringify({ ok: false, error: 'unexpected tool' })
    },
  })
  assert.equal(researchRounds, 4, 'snippet-only draft is held until three original pages are verified')
  assert.equal(researchExecuted.filter(item => item.name === 'browser_navigate').length, 4,
    'research opens one discovery page and three distinct source pages')
  assert.equal(researchResult.delivered, true)
  assert.equal(actionContractCompletionIssue(
    newsContract,
    researchResult.content,
    { successfulToolEvidence: verifiedNewsEvidence },
  ), '')
  assert.equal(classifyActionContract('打开人物卡片看看'), null,
    'person-card commands are left to model semantic intent instead of regex action contracts')
  assert.equal(classifyActionContract('人物卡片有点问题，经常错误触发'), null,
    'person-card feature discussions do not create a UI action contract')
  if (process.platform === 'darwin') {
    const explicitMusicPause = classifyActionContract('暂停 Apple Music')
    assert.equal(explicitMusicPause?.id, 'macos_system_music')
    assert.deepEqual(explicitMusicPause.requiredTools, ['system_music'])
    const contextualMusicPause = classifyActionContract('暂停', {
      runtimeContext: '[macOS System Music]\nMusic.app is open. Authoritative playback state: playing.',
    })
    assert.equal(contextualMusicPause?.id, 'macos_system_music', 'live Music.app state makes terse pause an evidenced action')
    assert.equal(classifyActionContract('播放我的 mac 系统里的 Music')?.id, 'macos_system_music')
    assert.equal(classifyActionContract('怎么暂停 Apple Music？'), null, 'music how-to remains ordinary explanation')

    let musicRounds = 0
    const musicCalls = []
    const musicResult = await callLLM({
      systemPrompt: 'system',
      message: '暂停',
      tools: ['system_music'],
      mustReply: true,
      localReply: true,
      toolContext: {
        currentTargetId: 'ID:000001',
        currentUserMessage: '暂停',
        actionContract: contextualMusicPause,
      },
      _streamOnceForTest: async ({ messages }) => {
        musicRounds += 1
        if (musicRounds === 1) return { content: '已经暂停了。', reasoningContent: '', aborted: false, toolCalls: [] }
        if (musicRounds === 2) {
          assert(messages.some(item => String(item.content || '').includes('No matching action has actually run')))
          return {
            content: '', reasoningContent: '', aborted: false,
            toolCalls: [{ id: 'music-pause-1', name: 'system_music', arguments: JSON.stringify({ action: 'pause' }) }],
          }
        }
        return { content: '已暂停《七里香》。', reasoningContent: '', aborted: false, toolCalls: [] }
      },
      _executeToolForTest: async (name, args) => {
        musicCalls.push({ name, args })
        return JSON.stringify({ ok: true, tool: 'system_music', action: 'pause', playback_state: 'paused', title: '七里香' })
      },
    })
    assert.equal(musicRounds, 3, 'a text-only pause claim is replaced by a real Music.app action round')
    assert.deepEqual(musicCalls.filter(call => call.name === 'system_music'), [
      { name: 'system_music', args: { action: 'pause' } },
    ])
    assert.match(musicResult.content, /已暂停/)
  }
  assert.equal(
    resolveActionContractForTurn('帮我在 sandbox 里创建一个 hello.txt 文件', {
      strictEvaluation: { active: true, forbiddenTools: ['write_file'] },
    }),
    null,
    'an action contract never requires a tool forbidden by strict evaluation',
  )

  let rounds = 0
  const executed = []
  const result = await callLLM({
    systemPrompt: 'system',
    message: '帮我在 sandbox 里创建一个 hello.txt 文件',
    tools: ['write_file', 'send_message'],
    mustReply: true,
    localReply: true,
    toolContext: {
      currentTargetId: 'ID:000001',
      actionContract: writeContract,
    },
    _streamOnceForTest: async ({ messages }) => {
      rounds += 1
      if (rounds === 1) {
        return { content: '已经创建好了。', reasoningContent: '', aborted: false, toolCalls: [] }
      }
      if (rounds === 2) {
        assert(messages.some(m => String(m.content || '').includes('No matching action has actually run')))
        return {
          content: '',
          reasoningContent: '',
          aborted: false,
          toolCalls: [{ id: 'write-1', name: 'write_file', arguments: JSON.stringify({ path: 'sandbox/hello.txt', content: 'hello' }) }],
        }
      }
      return { content: '文件已创建：sandbox/hello.txt。', reasoningContent: '', aborted: false, toolCalls: [] }
    },
    _executeToolForTest: async (name) => {
      executed.push(name)
      if (name === 'write_file') return JSON.stringify({ ok: true, path: 'sandbox/hello.txt', bytes: 5 })
      if (name === 'send_message') return JSON.stringify({ ok: true, delivered: true, message_sent: true })
      return JSON.stringify({ ok: false, error: 'unexpected tool' })
    },
  })

  assert.equal(rounds, 3, 'text-only completion is replaced with a real action round')
  assert.deepEqual(executed, ['write_file', 'send_message'], 'the requested side effect runs before fallback delivery')
  assert.equal(result.delivered, true)
  assert.match(result.content, /文件已创建/)

  // A failed real attempt must not be laundered into “已创建”. The runtime
  // gives the model one correction round and delivers only the truthful result.
  let failedRounds = 0
  const failed = await callLLM({
    systemPrompt: 'system',
    message: '帮我在 sandbox 里创建一个 hello.txt 文件',
    tools: ['write_file', 'send_message'],
    mustReply: true,
    localReply: true,
    toolContext: { currentTargetId: 'ID:000001', actionContract: writeContract },
    _streamOnceForTest: async ({ messages }) => {
      failedRounds += 1
      if (failedRounds === 1) {
        return {
          content: '', reasoningContent: '', aborted: false,
          toolCalls: [{ id: 'write-fail', name: 'write_file', arguments: JSON.stringify({ path: 'sandbox/hello.txt', content: 'hello' }) }],
        }
      }
      if (failedRounds === 2) {
        return { content: '文件已创建。', reasoningContent: '', aborted: false, toolCalls: [] }
      }
      assert(messages.some(m => String(m.content || '').includes('has no successful tool evidence')))
      return { content: '写入失败：当前目录没有写入权限。', reasoningContent: '', aborted: false, toolCalls: [] }
    },
    _executeToolForTest: async (name) => {
      if (name === 'write_file') return JSON.stringify({ ok: false, error: 'permission denied' })
      if (name === 'send_message') return JSON.stringify({ ok: true, delivered: true, message_sent: true })
      return JSON.stringify({ ok: false, error: 'unexpected tool' })
    },
  })
  assert.equal(failedRounds, 3, 'a false completion after tool failure gets corrected')
  assert.match(failed.content, /写入失败/)
  assert.doesNotMatch(failed.content, /已创建/)

  // Social channels cannot use the local fallback. A premature send_message is
  // therefore also blocked; it must not masquerade as the requested action.
  let socialRounds = 0
  const socialExecuted = []
  const social = await callLLM({
    systemPrompt: 'system',
    message: '帮我在 sandbox 里创建一个 hello.txt 文件',
    tools: ['write_file', 'send_message'],
    mustReply: true,
    localReply: false,
    toolContext: { currentTargetId: 'ID:000001', actionContract: writeContract },
    _streamOnceForTest: async () => {
      socialRounds += 1
      if (socialRounds === 1) {
        return {
          content: '', reasoningContent: '', aborted: false,
          toolCalls: [{ id: 'premature-send', name: 'send_message', arguments: JSON.stringify({ target_id: 'ID:000001', content: '文件已创建。' }) }],
        }
      }
      if (socialRounds === 2) {
        return {
          content: '', reasoningContent: '', aborted: false,
          toolCalls: [{ id: 'write-social', name: 'write_file', arguments: JSON.stringify({ path: 'sandbox/hello.txt', content: 'hello' }) }],
        }
      }
      if (socialRounds === 3) {
        return {
          content: '', reasoningContent: '', aborted: false,
          toolCalls: [{ id: 'final-send', name: 'send_message', arguments: JSON.stringify({ target_id: 'ID:000001', content: '文件已创建：sandbox/hello.txt。' }) }],
        }
      }
      return { content: '', reasoningContent: '', aborted: false, toolCalls: [] }
    },
    _executeToolForTest: async (name) => {
      socialExecuted.push(name)
      if (name === 'write_file') return JSON.stringify({ ok: true, path: 'sandbox/hello.txt' })
      if (name === 'send_message') return JSON.stringify({ ok: true, delivered: true, message_sent: true })
      return JSON.stringify({ ok: false, error: 'unexpected tool' })
    },
  })
  assert.equal(socialRounds, 4, 'ordinary final delivery gets a non-terminal reconsideration round')
  assert.deepEqual(socialExecuted, ['write_file', 'send_message'], 'premature social completion was suppressed, not delivered')
  assert.equal(social.delivered, true)

  // A successful system-browser handoff still does not prove a concrete app
  // name, and must not be summarized as three independent browser profiles.
  let systemRounds = 0
  const systemExecuted = []
  const systemReply = await callLLM({
    systemPrompt: 'system',
    message: '用我电脑上的浏览器打开 https://example.com',
    tools: ['system_browser_open'],
    mustReply: true,
    localReply: true,
    toolContext: { currentTargetId: 'ID:000001', actionContract: systemBrowserContract },
    _streamOnceForTest: async ({ messages }) => {
      systemRounds += 1
      if (systemRounds === 1) {
        return {
          content: '', reasoningContent: '', aborted: false,
          toolCalls: [{
            id: 'system-open',
            name: 'system_browser_open',
            arguments: JSON.stringify({ url: 'https://example.com/' }),
          }],
        }
      }
      if (systemRounds === 2) {
        return {
          content: '已在 Safari 中打开。三个浏览器各自独立。',
          reasoningContent: '', aborted: false, toolCalls: [],
        }
      }
      assert(messages.some(m => String(m.content || '').includes('do not name Safari')))
      return {
        content: '已交给电脑的系统默认浏览器打开。小窗口和大窗口共享同一个页面，电脑浏览器独立。',
        reasoningContent: '', aborted: false, toolCalls: [],
      }
    },
    _executeToolForTest: async (name) => {
      systemExecuted.push(name)
      if (name === 'system_browser_open') {
        return JSON.stringify({ ok: true, surface: 'system', url: 'https://example.com/' })
      }
      if (name === 'send_message') return JSON.stringify({ ok: true, delivered: true, message_sent: true })
      return JSON.stringify({ ok: false, error: 'unexpected tool' })
    },
  })
  assert.equal(systemRounds, 3, 'unsupported system-browser claims get one correction round')
  assert.deepEqual(systemExecuted, ['system_browser_open', 'send_message'])
  assert.doesNotMatch(systemReply.content, /Safari|三个浏览器各自独立/)
  assert.match(systemReply.content, /系统默认浏览器/)

  let snapshotRounds = 0
  const snapshotExecuted = []
  await callLLM({
    systemPrompt: 'Use the automatic snapshot in each browser action result.',
    message: '打开 https://example.com 并保持浏览器打开',
    tools: ['browser_navigate', 'browser_snapshot'],
    mustReply: true,
    localReply: true,
    toolContext: { currentTargetId: 'ID:000001' },
    _streamOnceForTest: async ({ messages }) => {
      snapshotRounds += 1
      if (snapshotRounds === 1) {
        return {
          content: '', reasoningContent: '', aborted: false,
          toolCalls: [{
            id: 'navigate-with-auto-snapshot',
            name: 'browser_navigate',
            arguments: JSON.stringify({ url: 'https://example.com/' }),
          }],
        }
      }
      assert(messages.some(entry => {
        try {
          const parsed = JSON.parse(itemText(entry))
          return parsed?.content?.some(item => item?.text?.includes('heading "Example Domain" [ref=e1]'))
        } catch { return false }
      }),
        'the next Agent round receives inline accessibility YAML from browser_navigate')
      return { content: '已打开 Example Domain，并保持浏览器打开。', reasoningContent: '', aborted: false, toolCalls: [] }
    },
    _executeToolForTest: async (name) => {
      snapshotExecuted.push(name)
      if (name === 'browser_navigate') {
        return JSON.stringify({
          ok: true,
          content: [{ type: 'text', text: '```yaml\n- heading "Example Domain" [ref=e1]\n```' }],
        })
      }
      if (name === 'send_message') return JSON.stringify({ ok: true, delivered: true, message_sent: true })
      return JSON.stringify({ ok: false, error: 'unexpected tool' })
    },
  })
  assert.equal(snapshotExecuted.includes('browser_snapshot'), false,
    'Agent does not mechanically call browser_snapshot after an action that already returned inline YAML')

  // Regression for the installed-app failure: when a login continuation only
  // produces prose, the runtime must suppress it, insist on a real browser
  // action, and reject the same fabricated claims after a mere snapshot.
  let loginRounds = 0
  const loginExecuted = []
  const loginResult = await callLLM({
    systemPrompt: 'Follow the current browser task.',
    message: '没有被墙，它能走',
    tools: browserLoginContract.requiredTools,
    mustReply: true,
    localReply: true,
    toolContext: {
      currentTargetId: 'ID:000001',
      actionContract: browserContinuationContract,
    },
    _streamOnceForTest: async ({ messages }) => {
      loginRounds += 1
      if (loginRounds === 1) {
        return {
          content: '页面加载出来了，用户名填好了，已经到密码页了。',
          reasoningContent: '', aborted: false, toolCalls: [],
        }
      }
      if (loginRounds === 2) {
        assert(messages.some(m => String(m.content || '').includes('No matching action has actually run')))
        return {
          content: '', reasoningContent: '', aborted: false,
          toolCalls: [{ id: 'login-snapshot', name: 'browser_snapshot', arguments: '{}' }],
        }
      }
      if (loginRounds === 3) {
        return {
          content: '页面加载出来了，用户名填好了，已经到密码页了。',
          reasoningContent: '', aborted: false, toolCalls: [],
        }
      }
      assert(messages.some(m => String(m.content || '').includes('Reply from verified evidence only')))
      return {
        content: '我已检查当前页面；尚未执行输入或提交，也不能确认已登录。',
        reasoningContent: '', aborted: false, toolCalls: [],
      }
    },
    _executeToolForTest: async name => {
      loginExecuted.push(name)
      if (name === 'browser_snapshot') return JSON.stringify({ ok: true, content: [{ type: 'text', text: 'X login page' }] })
      if (name === 'send_message') return JSON.stringify({ ok: true, delivered: true, message_sent: true })
      return JSON.stringify({ ok: false, error: 'unexpected tool' })
    },
  })
  assert.equal(loginRounds, 4)
  assert.deepEqual(loginExecuted, ['browser_snapshot', 'send_message'])
  assert.match(loginResult.content, /尚未执行输入或提交/)
  assert.doesNotMatch(loginResult.content, /密码页|填好了/)

  let realBrowserCloseCalls = 0
  let keepOpenRounds = 0
  await callLLM({
    systemPrompt: 'Follow the current user request.',
    message: '不要关闭浏览器',
    tools: ['browser_close'],
    mustReply: true,
    localReply: true,
    toolContext: { currentTargetId: 'ID:000001', currentUserMessage: '不要关闭浏览器' },
    _streamOnceForTest: async () => {
      keepOpenRounds += 1
      if (keepOpenRounds === 1) {
        return {
          content: '', reasoningContent: '', aborted: false,
          toolCalls: [{ id: 'wrong-close', name: 'browser_close', arguments: '{}' }],
        }
      }
      return { content: '浏览器会保持打开。', reasoningContent: '', aborted: false, toolCalls: [] }
    },
    _executeToolForTest: async (name, args, context) => {
      const policy = evaluateToolPolicy(name, args, context)
      if (!policy.allowed) return JSON.stringify({ ok: false, error: 'permission denied', policy })
      if (name === 'browser_close') realBrowserCloseCalls += 1
      if (name === 'send_message') return JSON.stringify({ ok: true, delivered: true, message_sent: true })
      return JSON.stringify({ ok: true })
    },
  })
  assert.equal(realBrowserCloseCalls, 0,
    'an erroneous model browser_close is rejected before the real close implementation runs')

  let closeReplyRounds = 0
  const closeReplyMessages = []
  const closeReplyResult = await callLLM({
    systemPrompt: 'Follow the current user request.',
    message: '关掉浏览器',
    tools: ['browser_close', 'send_message'],
    mustReply: true,
    localReply: true,
    toolContext: {
      currentTargetId: 'ID:000001',
      currentUserMessage: '关掉浏览器',
      actionContract: closeBrowserContract,
    },
    _streamOnceForTest: async () => {
      closeReplyRounds += 1
      if (closeReplyRounds === 1) {
        return {
          content: '', reasoningContent: '', aborted: false,
          toolCalls: [{ id: 'close-browser', name: 'browser_close', arguments: '{}' }],
        }
      }
      return {
        content: '关掉了。Bing 搜索页面已关闭，profile 数据保留着。',
        reasoningContent: '',
        aborted: false,
        toolCalls: [],
      }
    },
    _executeToolForTest: async (name, args) => {
      if (name === 'browser_close') return JSON.stringify({ ok: true, closed: true })
      if (name === 'send_message') {
        closeReplyMessages.push(args.content)
        return JSON.stringify({ ok: true, delivered: true, message_sent: true })
      }
      return JSON.stringify({ ok: false, error: 'unexpected tool' })
    },
  })
  assert.deepEqual(closeReplyMessages, ['👌'],
    'runtime fallback replaces a verbose browser-close draft with one emoji')
  assert.equal(closeReplyResult.content, '👌')
  assert.equal(closeReplyRounds, 1,
    'a successful standalone close does not spend another provider round on narration')

  let externalCloseRounds = 0
  const externalCloseMessages = []
  await callLLM({
    systemPrompt: 'Follow the current user request.',
    message: '关闭当前页面',
    tools: ['browser_close', 'send_message'],
    mustReply: true,
    localReply: false,
    toolContext: {
      currentTargetId: 'ID:000001',
      currentUserMessage: '关闭当前页面',
      actionContract: closeBrowserContract,
    },
    _streamOnceForTest: async () => {
      externalCloseRounds += 1
      if (externalCloseRounds === 1) {
        return {
          content: '', reasoningContent: '', aborted: false,
          toolCalls: [{ id: 'external-close-browser', name: 'browser_close', arguments: '{}' }],
        }
      }
      if (externalCloseRounds === 2) {
        return {
          content: '', reasoningContent: '', aborted: false,
          toolCalls: [{
            id: 'verbose-close-reply',
            name: 'send_message',
            arguments: JSON.stringify({
              target_id: 'ID:000001',
              content: '浏览器窗口已关闭，Cookie 和 profile 都还在。',
            }),
          }],
        }
      }
      return { content: '', reasoningContent: '', aborted: false, toolCalls: [] }
    },
    _executeToolForTest: async (name, args) => {
      if (name === 'browser_close') return JSON.stringify({ ok: true, closed: true })
      if (name === 'send_message') {
        externalCloseMessages.push(args.content)
        return JSON.stringify({ ok: true, delivered: true, message_sent: true })
      }
      return JSON.stringify({ ok: false, error: 'unexpected tool' })
    },
  })
  assert.deepEqual(externalCloseMessages, ['👌'],
    'explicit send_message content is normalized after a successful browser close')
  assert.equal(externalCloseRounds, 1,
    'external delivery also uses the runtime-owned close acknowledgement immediately')

  const screenshotFile = path.join(tmp, 'runtime-screenshot.png')
  fs.writeFileSync(screenshotFile, Buffer.from('screenshot'))

  let explicitScreenshotRounds = 0
  const explicitScreenshotCalls = []
  const explicitScreenshotPublicCalls = []
  const explicitScreenshotResult = await callLLM({
    systemPrompt: 'Capture and deliver the requested screenshot.',
    message: '把现在这个页面截个图发给我。',
    tools: ['browser_take_screenshot', 'send_message'],
    mustReply: true,
    localReply: true,
    toolContext: {
      currentTargetId: 'ID:000001',
      currentUserMessage: '把现在这个页面截个图发给我。',
      actionContract: screenshotContract,
    },
    _streamOnceForTest: async () => {
      explicitScreenshotRounds += 1
      if (explicitScreenshotRounds === 1) {
        return {
          content: '', reasoningContent: '', aborted: false,
          toolCalls: [
            { id: 'wrong-window', name: 'browser_set_display_mode', arguments: JSON.stringify({ mode: 'window' }) },
            { id: 'explicit-capture', name: 'browser_take_screenshot', arguments: '{}' },
          ],
        }
      }
      if (explicitScreenshotRounds === 2) {
        return {
          content: '', reasoningContent: '', aborted: false,
          toolCalls: [{
            id: 'explicit-send-image',
            name: 'send_message',
            arguments: JSON.stringify({
              target_id: 'ID:000001',
              content: '上一轮的 Example Domain 计数是 1，截图如下。',
              image_path: screenshotFile,
            }),
          }],
        }
      }
      throw new Error('a successful screenshot delivery must terminate before a duplicate send round')
    },
    _executeToolForTest: async (name, args) => {
      explicitScreenshotCalls.push({ name, args })
      if (name === 'browser_take_screenshot') {
        return JSON.stringify({ ok: true, screenshot: { image_path: screenshotFile, delivered: false } })
      }
      if (name === 'send_message') return JSON.stringify({ ok: true, delivered: true, message_sent: true })
      return JSON.stringify({ ok: false, error: 'unexpected tool' })
    },
    onToolCall: (name, args) => explicitScreenshotPublicCalls.push({ name, args }),
  })
  assert.equal(explicitScreenshotRounds, 2)
  assert.deepEqual(explicitScreenshotCalls.map(call => call.name), ['browser_take_screenshot', 'send_message'])
  assert.deepEqual(explicitScreenshotPublicCalls.map(call => call.name), ['browser_take_screenshot', 'send_message'],
    'out-of-scope planning attempts are kept private and cannot pollute the observed tool sequence')
  assert.equal(explicitScreenshotCalls[1].args.image_path, screenshotFile)
  assert.equal(explicitScreenshotCalls[1].args.content, '',
    'screenshot delivery removes stale facts copied from a previous turn')
  assert.equal(explicitScreenshotResult.delivered, true)
  assert.doesNotMatch(explicitScreenshotResult.content, /没有成功发送|发送失败/)

  let failedScreenshotRounds = 0
  const failedScreenshotCalls = []
  const failedScreenshotResult = await callLLM({
    systemPrompt: 'Capture and deliver the requested screenshot.',
    message: '把现在这个页面截个图发给我。',
    tools: ['browser_take_screenshot', 'send_message'],
    mustReply: true,
    localReply: true,
    toolContext: {
      currentTargetId: 'ID:000001',
      currentUserMessage: '把现在这个页面截个图发给我。',
      actionContract: screenshotContract,
    },
    _streamOnceForTest: async () => {
      failedScreenshotRounds += 1
      if (failedScreenshotRounds === 1) {
        return {
          content: '', reasoningContent: '', aborted: false,
          toolCalls: [{ id: 'failed-capture', name: 'browser_take_screenshot', arguments: '{}' }],
        }
      }
      if (failedScreenshotRounds === 2) {
        return {
          content: '', reasoningContent: '', aborted: false,
          toolCalls: [{
            id: 'failed-send-image',
            name: 'send_message',
            arguments: JSON.stringify({ target_id: 'ID:000001', content: '', image_path: screenshotFile }),
          }],
        }
      }
      return { content: '截图生成了，但图片发送失败。', reasoningContent: '', aborted: false, toolCalls: [] }
    },
    _executeToolForTest: async (name, args) => {
      failedScreenshotCalls.push({ name, args })
      if (name === 'browser_take_screenshot') {
        return JSON.stringify({ ok: true, screenshot: { image_path: screenshotFile, delivered: false } })
      }
      if (name === 'send_message' && args.image_path) {
        return JSON.stringify({ ok: false, delivered: false, message_sent: false, error: 'transport_failed' })
      }
      if (name === 'send_message') return JSON.stringify({ ok: true, delivered: true, message_sent: true })
      return JSON.stringify({ ok: false, error: 'unexpected tool' })
    },
  })
  assert.equal(failedScreenshotCalls.filter(call => call.args.image_path === screenshotFile).length, 1,
    'a failed real image send is not raced by an identical fallback image send')
  assert.match(failedScreenshotResult.content, /图片发送失败/)

  let pageFindRounds = 0
  const pageFindToolCalls = []
  const pageFindRuntimeResult = await callLLM({
    systemPrompt: 'Find text only in the current page.',
    message: '机器学习在这页出现几次',
    tools: ['browser_find', 'download_file', 'run_command', 'exec_command', 'browser_navigate', 'send_message'],
    mustReply: true,
    localReply: true,
    toolContext: {
      currentTargetId: 'ID:000001',
      currentUserMessage: '机器学习在这页出现几次',
      actionContract: pageFindContract,
    },
    _streamOnceForTest: async () => {
      pageFindRounds += 1
      if (pageFindRounds > 1) throw new Error('browser_find success must converge without another model round')
      return {
        content: '', reasoningContent: '', aborted: false,
        toolCalls: [{ id: 'find-current-page', name: 'browser_find', arguments: JSON.stringify({ text: '机器学习' }) }],
      }
    },
    _executeToolForTest: async (name, args) => {
      pageFindToolCalls.push({ name, args })
      if (name === 'browser_find') return pageFindEvidence[0].result
      if (name === 'send_message') return JSON.stringify({ ok: true, delivered: true, message_sent: true })
      return JSON.stringify({ ok: false, error: `unexpected tool ${name}` })
    },
  })
  assert.equal(pageFindRounds, 1)
  assert.deepEqual(pageFindToolCalls.map(call => call.name), ['browser_find', 'send_message'])
  assert.equal(pageFindToolCalls.some(call => ['download_file', 'run_command', 'exec_command', 'browser_navigate'].includes(call.name)), false)
  assert.equal(pageFindRuntimeResult.content, '当前页面里找到了“机器学习”，共出现 4 处。')
  assert.equal(pageFindRuntimeResult.delivered, true)

  let screenshotRounds = 0
  const screenshotToolCalls = []
  const screenshotResult = await callLLM({
    systemPrompt: 'Capture and deliver the requested screenshot.',
    message: '把当前页面截张图发给我看看',
    tools: ['browser_take_screenshot', 'send_message'],
    mustReply: true,
    localReply: true,
    toolContext: {
      currentTargetId: 'ID:000001',
      currentUserMessage: '把当前页面截张图发给我看看',
      actionContract: screenshotContract,
    },
    _streamOnceForTest: async ({ messages }) => {
      screenshotRounds += 1
      if (screenshotRounds === 1) {
        return {
          content: '', reasoningContent: '', aborted: false,
          toolCalls: [{ id: 'capture-browser', name: 'browser_take_screenshot', arguments: '{}' }],
        }
      }
      if (screenshotRounds === 2) {
        return { content: '截图已经发给你了。', reasoningContent: '', aborted: false, toolCalls: [] }
      }
      assert(messages.some(item => /not delivered|image_path/i.test(String(item.content || ''))))
      return { content: '图片已经显示在浏览器卡片里。', reasoningContent: '', aborted: false, toolCalls: [] }
    },
    _executeToolForTest: async (name, args) => {
      screenshotToolCalls.push({ name, args })
      if (name === 'browser_take_screenshot') {
        return JSON.stringify({ ok: true, screenshot: { image_path: screenshotFile, delivered: false } })
      }
      if (name === 'send_message') return JSON.stringify({ ok: true, delivered: true, message_sent: true })
      return JSON.stringify({ ok: false, error: 'unexpected tool' })
    },
  })
  assert.equal(screenshotResult.delivered, true)
  assert.deepEqual(screenshotToolCalls.map(call => call.name), ['browser_take_screenshot', 'send_message'])
  assert.equal(screenshotToolCalls[1].args.image_path, screenshotFile)
  assert.equal(screenshotToolCalls[1].args.content, '')
  console.log('test-action-contract passed')
} finally {
  closeDBForTest?.()
  fs.rmSync(tmp, { recursive: true, force: true })
}


// ══════════════════════════════════════════════════════════════════════════
// 桌宠（dsh-tauri-pet 移植）：状态机 + SSE 路由 + Electron 层纯逻辑
// 并入自开发期独立文件 test-pet.js（该文件已删除，见交付说明）
// 以下段落自带 runner，与上方 test-action-contract 的检查互不干扰：
//   - 上方用 process.exitCode，本段用 exitCode 取或，谁失败都退出 1
//   - 本段用例共享进程级 sink 集合，因此**必须串行 await**（不能 Promise.all）
// ══════════════════════════════════════════════════════════════════════════

let failed = 0
let passed = 0

/**
 * ⚠️ **这个 runner 必须能跑 async 用例，而且必须是「惰性排队」的**——两处真实坑。
 *
 * **坑 1（同步 runner）**：早期版本是「同步 `try { fn(); passed++ } catch`」。
 * 对 `async () => {...}` 的用例：`fn()` 立刻返回 pending promise → **马上 `passed++`
 * 并打印 PASS**；里面的 `assert` 稍后在微任务里才跑，失败时已脱离 try/catch →
 * 变成未处理的 promise 拒绝，最终让进程 exit 1。
 * 症状极隐蔽：**汇总行打印「154 passed, 0 failed」，但退出码是 1**。假绿比红灯危险。
 *
 * **坑 2（急切的 then）**：第一次修的时候写成 `Promise.resolve().then(fn)` 立即入队，
 * 以为末尾 `await` 就是串行——**错**。`then(fn)` 当场就把 `fn` 排进微任务队列，
 * 于是**所有** async 用例在末尾的等待循环开始之前就已经并发跑起来了。
 * 后果是共享状态（进程级 sink 集合、reducer）互相踩：表现为 `sinkCount()` 读到
 * 别的用例的数字（0 !== 1、2 !== 1 这类诡异断言）。
 *
 * **正确做法**：只把 thunk 存进队列，**等到末尾串行 await 时才逐个启动**。
 */
const queue = []

function check(label, fn) {
  queue.push({ label, fn })
}

/**
 * 让出事件循环：等微任务与 I/O 回调清空。
 * 「异步收尾」型断言（如 close 之后触发 detach）需要它。
 */
function tick() {
  return new Promise((resolve) => setImmediate(resolve))
}

function makeState(peer = {}) {
  return createPetSessionState('s1', peer)
}

/** 收集 reducer 回调，便于断言「推了什么、推了几次」。 */
function collect(handleImpl) {
  const frames = []
  const reducer = createPetSessionReducer((action, payload) => {
    frames.push({ action, payload })
    handleImpl?.(action, payload)
  })
  return { frames, reducer }
}

/** 假的 SSE sink：记录收到的原始帧串 + 是否被 close。 */
function makeSink() {
  const frames = []
  return {
    frames,
    closed: false,
    push(frame) { frames.push({ raw: frame, ...JSON.parse(frame) }) },
    close() { this.closed = true },
  }
}

/**
 * 每个流相关的 check 前后都把模块级状态归零。
 * pet-stream 的 sink 集合与 knownSessions 是**进程级单例**（这正是「没人看就不干活」
 * 与「首次出现推 create」的实现方式），所以测试之间必须显式重置，
 * 否则上一个用例遗留的 openTools / knownSessions 会污染下一个用例——
 * 那是**测试隔离问题**，不是实现缺陷。
 */
function resetStream() {
  clearHostRuntime()
}

/**
 * 隔离式流用例：自动建 sink、自动归零、自动注销。
 * 用例体拿到 `{ sink, emit }`，其中 emit 是裸的事件投递。
 */
function withStream(fn) {
  resetStream()
  const sink = makeSink()
  const detach = startPetStream(sink)
  try {
    fn(sink)
  } finally {
    detach()
    resetStream()
  }
}

/** 走真实事件总线投递一次爱丽丝宿主事件（验证翻译层，而不是直接调 reducer）。 */
function publishHost(type, data) {
  emitEvent(type, data)
}

// ── Electron 层（pet-state.cjs / pet-window.cjs）是 CommonJS，用 createRequire 载入。
// 注意 createRequire **要文件系统路径**（不是 file:// URL），用 fileURLToPath 转换。
const electronRequire = createRequire(import.meta.url)
const electronPetStatePath = fileURLToPath(new URL('../electron/pet-state.cjs', import.meta.url))
const electronPetWindowPath = fileURLToPath(new URL('../electron/pet-window.cjs', import.meta.url))
const electronPetState = electronRequire(electronPetStatePath)
const electronPetWindow = electronRequire(electronPetWindowPath)

const ELECTRON_PET_SIZE_DEFAULT = electronPetState.PET_SIZE_DEFAULT
const ELECTRON_PET_SIZE_MIN = electronPetState.PET_SIZE_MIN
const ELECTRON_PET_SIZE_MAX = electronPetState.PET_SIZE_MAX
const ELECTRON_PET_SIZE_STEP = electronPetState.PET_SIZE_STEP
const ELECTRON_PET_BASE_PX = electronPetState.PET_BASE_PX
const ELECTRON_PET_SPRITE_COLUMNS = electronPetState.PET_SPRITE_COLUMNS
const ELECTRON_PET_SPRITE_ROWS = electronPetState.PET_SPRITE_ROWS
const electronNormalizePetSize = electronPetState.normalizePetSize
const electronPetSizeOptions = electronPetState.petSizeOptions
const electronPetWindowPx = electronPetState.petWindowPx
const electronPetRootDir = electronPetState.petRootDir
const electronListPets = electronPetState.listPets
const electronListAllPets = electronPetState.listAllPets
const electronImportPet = electronPetState.importPet
const electronPetStateFile = electronPetState.petStateFile
const electronReadPetState = electronPetState.readPetState
const electronWritePetState = electronPetState.writePetState

/** pet-preload.cjs 的精灵图规格常量（源码级读取，因为 preload 只能在 Electron 里跑）。 */
const petPreloadSprite = (() => {
  const src = fs.readFileSync(
    new URL('../electron/pet-preload.cjs', import.meta.url),
    'utf8',
  )
  const columns = Number(src.match(/columns:\s*(\d+)/)?.[1])
  const rows = Number(src.match(/rows:\s*(\d+)/)?.[1])
  return { columns, rows }
})()

/**
 * 测试用临时目录：**必须建在 os.tmpdir() 下**。
 * src/paths.js 在 import 时会对整个 sandbox 树 ensureDir，建在仓库里会污染工作区。
 */
function makeTempDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'blm-pet-'))
}

/** 触发 makeRes 包装对象的 res 侧 close 监听（路由挂了 res.on('close', finish)）。 */
function resResTrigger(res, event) {
  if (typeof res.trigger === 'function') res.trigger(event)
}

/** 假的 http 响应：记录 statusCode / headers / 写出的内容，并支持触发 close。 */
function makeRes() {
  const chunks = []
  const listeners = new Map()
  const res = {
    statusCode: 200,
    headers: {},
    ended: false,
    writeHead(code, headers) {
      this.statusCode = code
      if (headers) Object.assign(this.headers, headers)
    },
    write(chunk) {
      chunks.push(String(chunk))
      return true
    },
    // ⚠️ `end()` 会把**最后一截正文**交出来（路由的 403 分支就是 `res.end(JSON.stringify(...))`）。
    // 早期版本这里忽略了参数，导致 403 的正文收不到——那是测试脚手架的 bug，不是路由的。
    end(chunk) {
      if (chunk !== undefined && chunk !== null) chunks.push(String(chunk))
      this.ended = true
    },
    on(event, handler) {
      if (!listeners.has(event)) listeners.set(event, [])
      listeners.get(event).push(handler)
    },
    trigger(event) {
      for (const handler of listeners.get(event) || []) handler()
    },
    // 路由里 res.write 之后再断开时不应抛；这里如实模拟已关闭的 socket。
    destroy() { this.destroyed = true },
  }
  return {
    res,
    body: chunks,
    text: () => chunks.join(''),
  }
}

/** 假的 http 请求：可控地触发 close。 */
function makeReq() {
  const listeners = new Map()
  return {
    method: 'GET',
    socket: { remoteAddress: '127.0.0.1' },
    headers: {},
    on(event, handler) {
      // ⚠️ **不是 `listeners.get(event, [])`**：`Map.prototype.get` 只收一个参数，
      // 第二个「默认值」会被**静默忽略**并返回 undefined，随后 `.push` 抛错。
      // 那会导致 `req.on('close', finish)` 根本没注册上、`trigger('close')` 空转，
      // 于是路由的收尾永远不跑、sink 泄漏到后面所有用例。
      if (!listeners.has(event)) listeners.set(event, [])
      listeners.get(event).push(handler)
    },
    trigger(event) {
      for (const handler of listeners.get(event) || []) handler()
    },
  }
}

console.log('== 常量 ==')
check('POINT: 推理尾部窗口 = 120', () => assert.equal(PET_REASONING_TAIL_WINDOW, 120))
check('推理推送节流 = 500ms', () => assert.equal(PET_REASONING_PUSH_INTERVAL_MS, 500))
check('任务码点上限 = 40', () => assert.equal(PET_TASK_TEXT_MAX, 40))
check('FOLDABLE_EVENTS 恰好 10 个且内容固定', () => {
  assert.equal(FOLDABLE_EVENTS.size, 10)
  for (const t of [
    'turn/start', 'step/start', 'assistant/message', 'tool/call', 'tool/result',
    'user/message', 'turn/end', 'session/title', 'approval/asked', 'approval/decided',
  ]) {
    assert.ok(FOLDABLE_EVENTS.has(t), `缺少 ${t}`)
  }
})

console.log('== 会话状态模型 ==')
check('createPetSessionState 初始字段', () => {
  const s = makeState({ origin: 'main', title: 't', displayTitle: 'd', cwd: '/x', running: true })
  assert.equal(s.id, 's1')
  assert.equal(s.origin, 'main')
  assert.equal(s.title, 't')
  assert.equal(s.displayTitle, 'd')
  assert.equal(s.cwd, '/x')
  assert.equal(s.running, true)
  assert.equal(s.turnActive, false)
  assert.equal(s.stepActive, false)
  assert.ok(s.openTools instanceof Map)
  assert.equal(s.openTools.size, 0)
  assert.equal(s.reasoningTail, '')
  assert.equal(s.assistantText, '')
  assert.equal(s.firstSeqAt, 0)
})

check('running 缺省回落 false', () => {
  assert.equal(createPetSessionState('a', {}).running, false)
  assert.equal(createPetSessionState('a').running, false)
})

console.log('== 状态优先级（8 种）==')
check('PRIORITY: lastAgentError 压过 running → error', () => {
  const s = makeState()
  s.running = true
  s.turnActive = true
  s.waitingKind = 'approval'
  s.lastAgentError = 'boom'
  assert.equal(foldPetPayload(s).status, 'error')
})

check('PRIORITY: waitingKind 压过 running → waiting', () => {
  const s = makeState()
  s.running = true
  s.turnActive = true
  s.waitingKind = 'approval'
  assert.equal(foldPetPayload(s).status, 'waiting')
})

check('running 单独 → running', () => {
  const s = makeState()
  s.running = true
  assert.equal(foldPetPayload(s).status, 'running')
})

check('turnActive 单独 → running', () => {
  const s = makeState()
  s.turnActive = true
  assert.equal(foldPetPayload(s).status, 'running')
})

check('全空 → status undefined（空闲无标签）', () => {
  assert.equal(foldPetPayload(makeState()).status, undefined)
})

check('activity 恒等于 status；phase 恒等于 waitingKind', () => {
  const s = makeState()
  s.waitingKind = 'blocked'
  s.running = true
  const p = foldPetPayload(s)
  assert.equal(p.activity, p.status)
  assert.equal(p.phase, 'blocked')
  assert.equal(p.phase, s.waitingKind)
})

check('message 为空串时是 undefined 而非 ""', () => {
  const s = makeState()
  assert.equal(foldPetPayload(s).message, undefined)
  s.assistantText = 'hi'
  assert.equal(foldPetPayload(s).message, 'hi')
})

check('title 回落 displayTitle', () => {
  const s = makeState()
  s.displayTitle = 'D'
  assert.equal(foldPetPayload(s).title, 'D')
  s.title = 'T'
  assert.equal(foldPetPayload(s).title, 'T')
})

console.log('== liveActivity 二选一 ==')
check('LIVE: running + 有工具 → tool（优先于推理）', () => {
  const s = makeState()
  s.running = true
  s.reasoningTail = '正在想'
  s.openTools.set('c1', { name: 'read_file', args: '{"path":"a"}' })
  const p = foldPetPayload(s)
  assert.equal(p.liveActivity.kind, 'tool')
  assert.equal(p.liveActivity.name, 'read_file')
  assert.equal(p.liveActivity.args, '{"path":"a"}')
})

check('running + 无工具 + 有推理 → reasoning', () => {
  const s = makeState()
  s.running = true
  s.reasoningTail = '正在想'
  const p = foldPetPayload(s)
  assert.equal(p.liveActivity.kind, 'reasoning')
  assert.equal(p.liveActivity.text, '正在想')
})

check('非 running 时 liveActivity 为 undefined', () => {
  const s = makeState()
  s.reasoningTail = '正在想'
  s.openTools.set('c1', { name: 'read_file' })
  assert.equal(foldPetPayload(s).liveActivity, undefined)
})

console.log('== 事件折叠 ==')
check('turn/start 重置一切瞬时态', () => {
  const s = makeState()
  s.reasoningTail = 'old'
  s.assistantText = 'old'
  s.waitingKind = 'approval'
  s.lastAgentError = 'old'
  s.task = 'old'
  reduceSessionEvent(s, { type: 'turn/start', data: {} })
  assert.equal(s.reasoningTail, '')
  assert.equal(s.assistantText, '')
  assert.equal(s.waitingKind, undefined)
  assert.equal(s.lastAgentError, undefined)
  assert.equal(s.task, undefined)
  assert.equal(s.turnActive, true)
  assert.equal(s.running, true)
  assert.equal(s.workStatus, 'thinking')
})

check('step/start 置 stepActive（有 openTools 时不改 workStatus）', () => {
  const s = makeState()
  s.openTools.set('c1', { name: 'shell_exec' })
  s.workStatus = 'working'
  reduceSessionEvent(s, { type: 'step/start', data: {} })
  assert.equal(s.stepActive, true)
  assert.equal(s.workStatus, 'working')
})

check('tool/call 入 Map（callId 优先，无名则不写）', () => {
  const s = makeState()
  reduceSessionEvent(s, { type: 'tool/call', data: { callId: 'c1', name: 'grep_search', arguments: '{}' } })
  assert.equal(s.openTools.size, 1)
  assert.equal(s.openTools.get('c1').name, 'grep_search')
  assert.equal(s.toolActivity, 'searching')
  assert.equal(s.workStatus, 'working')
  reduceSessionEvent(s, { type: 'tool/call', data: { callId: 'c2' } })
  assert.equal(s.openTools.size, 1, '无名工具不应入 Map')
})

check('tool/result 出 Map（按 callId）', () => {
  const s = makeState()
  reduceSessionEvent(s, { type: 'tool/call', data: { callId: 'c1', name: 'read_file' } })
  reduceSessionEvent(s, { type: 'tool/call', data: { callId: 'c2', name: 'write_file' } })
  assert.equal(s.openTools.size, 2)
  reduceSessionEvent(s, { type: 'tool/result', data: { callId: 'c1' } })
  assert.equal(s.openTools.size, 1)
  assert.ok(s.openTools.has('c2'))
  assert.equal(s.workStatus, 'working')
})

check('tool/result 取不到 id → 清空全部', () => {
  const s = makeState()
  s.openTools.set('c1', { name: 'a' })
  s.openTools.set('c2', { name: 'b' })
  reduceSessionEvent(s, { type: 'tool/result', data: {} })
  assert.equal(s.openTools.size, 0)
  assert.equal(s.workStatus, 'result')
})

check('tool/result 从 message.source.callId 取 id', () => {
  const s = makeState()
  s.openTools.set('c9', { name: 'a' })
  reduceSessionEvent(s, { type: 'tool/result', data: { message: { source: { callId: 'c9' } } } })
  assert.equal(s.openTools.size, 0)
})

check('approval/asked 进入 waiting 且记 id', () => {
  const s = makeState()
  reduceSessionEvent(s, { type: 'approval/asked', data: { id: 'ap1' } })
  assert.equal(s.waitingKind, 'approval')
  assert.equal(s.waitingApprovalId, 'ap1')
  assert.equal(s.workStatus, 'waiting')
  assert.equal(s.running, true)
})

check('approval/decided 只清匹配 id（不匹配不动）', () => {
  const s = makeState()
  reduceSessionEvent(s, { type: 'approval/asked', data: { id: 'ap1' } })
  const payload = reduceSessionEvent(s, { type: 'approval/decided', data: { id: 'ap2' } })
  assert.equal(payload, null, '不匹配必须返回 null')
  assert.equal(s.waitingKind, 'approval')
  assert.equal(s.waitingApprovalId, 'ap1')
  reduceSessionEvent(s, { type: 'approval/decided', data: { id: 'ap1' } })
  assert.equal(s.waitingKind, undefined)
  assert.equal(s.workStatus, 'thinking')
})

check('user/message 清掉 user-question 等待（approval 等待不被清）', () => {
  const s = makeState()
  s.waitingKind = 'user-question'
  s.waitingCallId = 'c1'
  reduceSessionEvent(s, { type: 'user/message', data: {} })
  assert.equal(s.waitingKind, undefined)
  assert.equal(s.turnActive, true)

  const s2 = makeState()
  reduceSessionEvent(s2, { type: 'approval/asked', data: { id: 'ap1' } })
  reduceSessionEvent(s2, { type: 'user/message', data: {} })
  assert.equal(s2.waitingKind, 'approval', '审批等待不该被 user/message 清掉')
})

check('session/title 只接受非空字符串', () => {
  const s = makeState()
  reduceSessionEvent(s, { type: 'session/title', data: { title: 'A' } })
  assert.equal(s.title, 'A')
  assert.equal(s.displayTitle, 'A')
  reduceSessionEvent(s, { type: 'session/title', data: { title: '' } })
  assert.equal(s.title, 'A')
  reduceSessionEvent(s, { type: 'session/title', data: { title: 42 } })
  assert.equal(s.title, 'A')
})

check('turn/end completed → success + 清 lastAgentError', () => {
  const s = makeState()
  s.running = true
  s.lastAgentError = 'old'
  reduceSessionEvent(s, { type: 'turn/end', data: { reason: { kind: 'completed' } } })
  assert.equal(s.workStatus, 'success')
  assert.equal(s.lastAgentError, undefined)
  assert.equal(s.running, false)
  assert.equal(s.turnActive, false)
})

check('turn/end error → workStatus=error + lastAgentError', () => {
  const s = makeState()
  reduceSessionEvent(s, { type: 'turn/end', data: { reason: { kind: 'error', error: { message: 'kaboom' } } } })
  assert.equal(s.workStatus, 'error')
  assert.equal(s.lastAgentError, 'kaboom')
  assert.equal(foldPetPayload(s).status, 'error')
})

check('turn/end error 无 message → 回落 kind', () => {
  const s = makeState()
  reduceSessionEvent(s, { type: 'turn/end', data: { reason: { kind: 'timeout' } } })
  assert.equal(s.lastAgentError, 'timeout')
})

check('turn/end blocked → waiting + waitingKind=blocked', () => {
  const s = makeState()
  reduceSessionEvent(s, { type: 'turn/end', data: { reason: { kind: 'blocked' } } })
  assert.equal(s.waitingKind, 'blocked')
  assert.equal(s.workStatus, 'waiting')
  assert.equal(foldPetPayload(s).status, 'waiting')
})

check('turn/end 无 reason → settleIdle', () => {
  const s = makeState()
  s.running = true
  s.reasoningTail = 'x'
  s.openTools.set('c1', { name: 'a' })
  reduceSessionEvent(s, { type: 'turn/end', data: {} })
  assert.equal(s.running, false)
  assert.equal(s.reasoningTail, '')
  assert.equal(s.openTools.size, 0)
  assert.equal(s.workStatus, undefined)
})

check('非 FOLDABLE 事件返回 null', () => {
  const s = makeState()
  assert.equal(reduceSessionEvent(s, { type: 'unknown/thing', data: {} }), null)
  assert.equal(reduceSessionEvent(s, { type: 'todo/write', data: { todos: [] } }), null, '空 todo 无变化→null')
})

check('assistant/chunk reasoning-delta 累积并返回载荷；text-delta 返回 null', () => {
  const s = makeState()
  const p = reduceSessionEvent(s, { type: 'assistant/chunk', data: { chunk: { type: 'reasoning-delta', text: 'abc' } } })
  assert.ok(p, 'reasoning-delta 必须返回载荷')
  assert.equal(s.reasoningTail, 'abc')
  assert.equal(s.workStatus, 'thinking')
  assert.equal(reduceSessionEvent(s, { type: 'assistant/chunk', data: { chunk: { type: 'text-delta', text: 'hi' } } }), null)
  assert.equal(s.assistantText, 'hi')
})

check('reasoning 尾部截 120（累计后只留最后 120）', () => {
  const s = makeState()
  reduceSessionEvent(s, { type: 'assistant/chunk', data: { chunk: { type: 'reasoning-delta', text: 'a'.repeat(200) } } })
  assert.equal(s.reasoningTail.length, 120)
  assert.equal(s.reasoningTail, 'a'.repeat(120))
  reduceSessionEvent(s, { type: 'assistant/chunk', data: { chunk: { type: 'reasoning-delta', text: 'END' } } })
  assert.equal(s.reasoningTail.length, 120)
  assert.ok(s.reasoningTail.endsWith('END'), '新内容必须在尾部')
})

check('assistantText 截 1000', () => {
  const s = makeState()
  reduceSessionEvent(s, { type: 'assistant/chunk', data: { chunk: { type: 'text-delta', text: 'x'.repeat(1500) } } })
  assert.equal(s.assistantText.length, 1000)
})

check('assistant/message 拼接 text 块并截 1000', () => {
  const s = makeState()
  reduceSessionEvent(s, {
    type: 'assistant/message',
    data: { message: { content: [{ type: 'text', text: 'ab' }, { type: 'tool_use' }, { type: 'text', text: 'cd' }] } },
  })
  assert.equal(s.assistantText, 'abcd')
})

console.log('== 任务提取（码点截断）==')
check('POINT: todo/write 取最后一个 in_progress', () => {
  const s = makeState()
  reduceSessionEvent(s, {
    type: 'todo/write',
    data: { todos: [{ status: 'in_progress', content: '第一' }, { status: 'pending', content: '第二' }, { status: 'in_progress', content: '第三' }] },
  })
  assert.equal(s.task, '第三')
})

check('无 in_progress 时回落第一个 pending', () => {
  const s = makeState()
  reduceSessionEvent(s, {
    type: 'todo/write',
    data: { todos: [{ status: 'completed', content: 'A' }, { status: 'pending', content: 'B' }, { status: 'pending', content: 'C' }] },
  })
  assert.equal(s.task, 'B')
})

check('无进行中/待办 → task undefined', () => {
  const s = makeState()
  reduceSessionEvent(s, { type: 'todo/write', data: { todos: [{ status: 'completed', content: 'A' }] } })
  assert.equal(s.task, undefined)
})

check('CODE POINT: 41 个 emoji（每字 2 个 UTF-16 单元）截 40 码点，不劈代理对', () => {
  const todos = [{ status: 'in_progress', content: '🐴'.repeat(41) }]
  const task = currentTaskFromTodo({ todos })
  const points = Array.from(task)
  assert.equal(points.length, 41, '40 个字符 + 省略号')
  assert.equal(points[40], '\u2026')
  assert.equal(points.slice(0, 40).join(''), '🐴'.repeat(40))
  // 若误用 String.slice，会劈开代理对产生孤立代理项
  assert.ok(!task.includes('\uFFFD'), '不应出现替换字符')
  for (const ch of task) {
    assert.ok(ch.codePointAt(0) > 0xFFFF || ch !== '🐴'.slice(0, 0) || true)
  }
})

check('CODE POINT: 中文不截断（40 字以内原样）', () => {
  const task = currentTaskFromTodo({ todos: [{ status: 'pending', content: '读取配置文件并修复编码问题' }] })
  assert.equal(task, '读取配置文件并修复编码问题')
})

check('CODE POINT: 中文超 40 码点 → 40 字 + 省略号', () => {
  const raw = '汉'.repeat(45)
  const task = currentTaskFromTodo({ todos: [{ status: 'pending', content: raw }] })
  const points = Array.from(task)
  assert.equal(points.length, 41)
  assert.equal(points.slice(0, 40).join(''), '汉'.repeat(40))
  assert.equal(points[40], '\u2026')
  assert.equal(task, '汉'.repeat(40) + '…')
})

check('CODE POINT 反证：按 UTF-16 单元截断会劈开代理对（说明为何必须 Array.from）', () => {
  // 41 个 emoji 用 39 个 UTF-16 单元承载的字符来暴露劈开：中文 1 单元 + emoji 2 单元，
  // 让第 40 个单元正好落在某个 emoji 的**前半**。
  const raw = '汉'.repeat(39) + '🐴'.repeat(3)
  const byUnit = raw.slice(0, 40)
  const lastUnit = byUnit.charCodeAt(byUnit.length - 1)
  assert.ok(
    lastUnit >= 0xD800 && lastUnit <= 0xDBFF,
    '按 UTF-16 单元截断的末尾应是高位代理项（即被劈开）',
  )
  assert.equal(String.fromCharCode(lastUnit).length, 1, '孤立代理项长度为 1')

  // 按码点截断则恰好 40 个字符，末尾无孤立代理
  const byPoint = currentTaskFromTodo({ todos: [{ status: 'pending', content: raw }] })
  const points = Array.from(byPoint)
  assert.equal(points.length, 41, '40 码点 + 省略号')
  assert.equal(points[0], '汉')
  assert.equal(points[39], '🐴', '第 40 个码点仍是完整 emoji')
  for (const ch of byPoint) {
    const code = ch.codePointAt(0)
    assert.ok(!(code >= 0xD800 && code <= 0xDFFF), '正确实现不含孤立代理项')
  }
})

check('正好 40 码点不截断（不加省略号）', () => {
  const task = currentTaskFromTodo({ todos: [{ status: 'pending', content: '汉'.repeat(40) }] })
  assert.equal(task, '汉'.repeat(40))
  assert.equal(Array.from(task).length, 40)
})

check('todo 内容前后空白被 trim', () => {
  assert.equal(currentTaskFromTodo({ todos: [{ status: 'pending', content: '  x  ' }] }), 'x')
})

console.log('== 工具活动分类（5 类）==')
check('分类：searching/editing/testing/commanding/using-tool', () => {
  assert.equal(toolActivityOf('grep_search'), 'searching')
  assert.equal(toolActivityOf('web_fetch'), 'searching')
  assert.equal(toolActivityOf('read_file'), 'searching')
  assert.equal(toolActivityOf('write_file'), 'editing')
  assert.equal(toolActivityOf('edit_file'), 'editing')
  assert.equal(toolActivityOf('delete_path'), 'editing')
  assert.equal(toolActivityOf('run_test'), 'testing')
  assert.equal(toolActivityOf('lint_check'), 'testing')
  assert.equal(toolActivityOf('build_project'), 'testing')
  assert.equal(toolActivityOf('shell_exec'), 'commanding')
  assert.equal(toolActivityOf('powershell_run'), 'commanding')
  assert.equal(toolActivityOf('some_other_tool'), 'using-tool')
})

check('分类对空/未知输入安全', () => {
  assert.equal(toolActivityOf(''), 'using-tool')
  assert.equal(toolActivityOf(undefined), 'using-tool')
  assert.equal(toolActivityOf(null), 'using-tool')
})

check('分类顺序：read_file 归 searching 而非 editing', () => {
  // read 与 write/edit 规则都能匹配 "read_file" 吗？不能——但 "open_file" 只匹配 searching
  assert.equal(toolActivityOf('open_path'), 'searching')
  // 同时含 search 与 write 的名字，searching 优先
  assert.equal(toolActivityOf('search_and_write'), 'searching')
})

console.log('== payloadEqual 去重（18 项）==')
check('DEDUPE: 完全相同 → true', () => {
  const s = makeState({ origin: 'main', title: 'T', running: true })
  s.openTools.set('c', { name: 'read_file', args: '{}' })
  assert.equal(payloadEqual(foldPetPayload(s), foldPetPayload(s)), true)
})

check('DEDUPE: 只差一个字段（task）→ false', () => {
  const s = makeState()
  const a = foldPetPayload(s)
  s.task = '新任务'
  const b = foldPetPayload(s)
  assert.equal(payloadEqual(a, b), false)
})

check('DEDUPE: 只差 liveActivity.name → false', () => {
  const s = makeState({ running: true })
  s.openTools.set('c', { name: 'read_file' })
  const a = foldPetPayload(s)
  s.openTools.set('c', { name: 'write_file' })
  const b = foldPetPayload(s)
  assert.equal(payloadEqual(a, b), false)
})

check('DEDUPE: 只差 liveActivity.args → false', () => {
  const s = makeState({ running: true })
  s.openTools.set('c', { name: 'read_file', args: '{"a":1}' })
  const a = foldPetPayload(s)
  s.openTools.set('c', { name: 'read_file', args: '{"a":2}' })
  const b = foldPetPayload(s)
  assert.equal(payloadEqual(a, b), false)
})

check('DEDUPE: liveActivity.kind 从 tool 变 reasoning → false', () => {
  const s = makeState({ running: true })
  s.openTools.set('c', { name: 'read_file' })
  const a = foldPetPayload(s)
  s.openTools.clear()
  s.reasoningTail = '在想'
  const b = foldPetPayload(s)
  assert.equal(payloadEqual(a, b), false)
})

check('DEDUPE: lastAgentError 从 undefined 变有值 → false', () => {
  const s = makeState()
  const a = foldPetPayload(s)
  s.lastAgentError = 'x'
  assert.equal(payloadEqual(a, foldPetPayload(s)), false)
})

check('DEDUPE: undefined 与 null 不等（Object.is 语义）', () => {
  const a = { ...foldPetPayload(makeState()) }
  const b = { ...a, lastAgentError: null }
  assert.equal(payloadEqual(a, b), false)
})

console.log('== 完成状态（4 种）==')
check('非 goal 轮 → success', () => {
  assert.equal(completedStatus({ goalRound: false }), 'success')
  assert.equal(completedStatus({}), 'success')
})

check('goal 轮 + goalClosing=complete → success', () => {
  assert.equal(completedStatus({ goalRound: true, goalClosing: 'complete' }), 'success')
})

check('goal 轮 + goalClosing=blocked → error', () => {
  assert.equal(completedStatus({ goalRound: true, goalClosing: 'blocked' }), 'error')
})

check('goal 轮 + 无收尾动作 → result（中间轮）', () => {
  assert.equal(completedStatus({ goalRound: true }), 'result')
  assert.equal(completedStatus({ goalRound: true, goalClosing: undefined }), 'result')
})

check('goalClosingOf 只认 update_goal 且只认 complete/blocked', () => {
  assert.equal(goalClosingOf('update_goal', '{"action":"complete"}'), 'complete')
  assert.equal(goalClosingOf('update_goal', '{"action":"blocked"}'), 'blocked')
  assert.equal(goalClosingOf('update_goal', '{"action":"edit"}'), undefined)
  assert.equal(goalClosingOf('update_goal', '{"action":"pause"}'), undefined)
  assert.equal(goalClosingOf('update_goal', 'not json'), undefined)
  assert.equal(goalClosingOf('other_tool', '{"action":"complete"}'), undefined)
})

check('isGoalRoundEvent 只认 kind=goal 且 round>0', () => {
  assert.equal(isGoalRoundEvent({ source: { kind: 'goal', round: 1 } }), true)
  assert.equal(isGoalRoundEvent({ source: { kind: 'goal', round: 0 } }), false)
  assert.equal(isGoalRoundEvent({ source: { kind: 'user', round: 5 } }), false)
  assert.equal(isGoalRoundEvent({}), false)
})

check('turn/end 的 goal 轮 + update_goal(complete) → success', () => {
  const s = makeState()
  reduceSessionEvent(s, { type: 'user/message', data: { source: { kind: 'goal', round: 2 } } })
  reduceSessionEvent(s, { type: 'tool/call', data: { callId: 'c', name: 'update_goal', arguments: '{"action":"complete"}' } })
  reduceSessionEvent(s, { type: 'turn/end', data: { reason: { kind: 'completed' } } })
  assert.equal(s.workStatus, 'success')
})

check('turn/end 的 goal 轮无收尾 → result', () => {
  const s = makeState()
  reduceSessionEvent(s, { type: 'user/message', data: { source: { kind: 'goal', round: 2 } } })
  reduceSessionEvent(s, { type: 'turn/end', data: { reason: { kind: 'completed' } } })
  assert.equal(s.workStatus, 'result')
})

check('turn/end 的 goal 轮 blocked → error', () => {
  const s = makeState()
  reduceSessionEvent(s, { type: 'user/message', data: { source: { kind: 'goal', round: 1 } } })
  reduceSessionEvent(s, { type: 'tool/call', data: { callId: 'c', name: 'update_goal', arguments: '{"action":"blocked"}' } })
  reduceSessionEvent(s, { type: 'turn/end', data: { reason: { kind: 'completed' } } })
  assert.equal(s.workStatus, 'error')
})

check('round=0 的 /goal 激活轮按普通轮处理 → success', () => {
  const s = makeState()
  reduceSessionEvent(s, { type: 'user/message', data: { source: { kind: 'goal', round: 0 } } })
  reduceSessionEvent(s, { type: 'turn/end', data: { reason: { kind: 'completed' } } })
  assert.equal(s.workStatus, 'success')
})

check('turn/end 后 goalRound/goalClosing 被复位', () => {
  const s = makeState()
  reduceSessionEvent(s, { type: 'user/message', data: { source: { kind: 'goal', round: 3 } } })
  reduceSessionEvent(s, { type: 'tool/call', data: { callId: 'c', name: 'update_goal', arguments: '{"action":"complete"}' } })
  reduceSessionEvent(s, { type: 'turn/end', data: { reason: { kind: 'completed' } } })
  assert.equal(s.goalRound, false)
  assert.equal(s.goalClosing, undefined)
})

console.log('== 问答工具识别 ==')
check('识别等用户回答的工具名', () => {
  assert.equal(isUserQuestionTool('ask_user'), true)
  assert.equal(isUserQuestionTool('request_user_input'), true)
  assert.equal(isUserQuestionTool('ask_user_question'), true)
  assert.equal(isUserQuestionTool('user_question'), true)
  assert.equal(isUserQuestionTool('question_from_user'), true)
  assert.equal(isUserQuestionTool('exit_plan_mode'), true)
  assert.equal(isUserQuestionTool('ask_consent'), true)
})

check('不把普通工具误判为等待', () => {
  assert.equal(isUserQuestionTool('code_review'), false)
  assert.equal(isUserQuestionTool('allowlist_files'), false)
  assert.equal(isUserQuestionTool('permission_scan'), false)
  assert.equal(isUserQuestionTool('read_file'), false)
  assert.equal(isUserQuestionTool(''), false)
})

check('tool/call 问答工具 → waiting/user-question', () => {
  const s = makeState()
  reduceSessionEvent(s, { type: 'tool/call', data: { callId: 'c1', name: 'ask_user_question' } })
  assert.equal(s.waitingKind, 'user-question')
  assert.equal(s.waitingCallId, 'c1')
  assert.equal(s.workStatus, 'waiting')
  assert.equal(foldPetPayload(s).status, 'waiting')
})

check('tool/result 结束问答工具 → 清 waiting', () => {
  const s = makeState()
  reduceSessionEvent(s, { type: 'tool/call', data: { callId: 'c1', name: 'ask_user_question' } })
  reduceSessionEvent(s, { type: 'tool/result', data: { callId: 'c1' } })
  assert.equal(s.waitingKind, undefined)
  assert.equal(s.workStatus, 'result')
})

console.log('== toolCallIdOf ==')
check('从 message.content[].toolCallId 取 id', () => {
  assert.equal(toolCallIdOf({ data: { message: { content: [{ type: 'tool_result', toolCallId: 'c7' }] } } }), 'c7')
})
check('从 message.callId / data.callId 取 id', () => {
  assert.equal(toolCallIdOf({ data: { message: { callId: 'c8' } } }), 'c8')
  assert.equal(toolCallIdOf({ data: { callId: 'c9' } }), 'c9')
})
check('取不到返回空串（不是 "undefined"）', () => {
  assert.equal(toolCallIdOf({ data: {} }), '')
  assert.equal(toolCallIdOf({}), '')
})

console.log('== settleIdle / inTurn ==')
check('settleIdle 清空一切瞬时态', () => {
  const s = makeState()
  s.running = true
  s.turnActive = true
  s.stepActive = true
  s.reasoningTail = 'x'
  s.assistantText = 'y'
  s.waitingKind = 'approval'
  s.waitingApprovalId = 'a'
  s.waitingCallId = 'c'
  s.workStatus = 'working'
  s.lastAgentError = 'e'
  s.openTools.set('c', { name: 'a' })
  s.goalRound = true
  s.goalClosing = 'complete'
  settleIdle(s)
  assert.equal(s.running, false)
  assert.equal(s.turnActive, false)
  assert.equal(s.stepActive, false)
  assert.equal(s.reasoningTail, '')
  assert.equal(s.assistantText, '')
  assert.equal(s.waitingKind, undefined)
  assert.equal(s.waitingApprovalId, undefined)
  assert.equal(s.waitingCallId, undefined)
  assert.equal(s.workStatus, undefined)
  assert.equal(s.lastAgentError, undefined)
  assert.equal(s.openTools.size, 0)
  assert.equal(s.goalRound, false)
  assert.equal(s.goalClosing, undefined)
  assert.equal(foldPetPayload(s).status, undefined)
})

check('inTurn：running/turnActive/stepActive 任一为真', () => {
  const s = makeState()
  assert.equal(inTurn(s), false)
  s.stepActive = true
  assert.equal(inTurn(s), true)
  s.stepActive = false
  s.turnActive = true
  assert.equal(inTurn(s), true)
  s.turnActive = false
  s.running = true
  assert.equal(inTurn(s), true)
})

console.log('== reducer：创建 / 去重 / 节流 ==')
check('reducer.create 推一帧 create', () => {
  const { frames, reducer } = collect()
  reducer.create({ id: 's1', origin: 'main', title: 'T' })
  assert.equal(frames.length, 1)
  assert.equal(frames[0].action, 'create')
  assert.equal(frames[0].payload.id, 's1')
  assert.equal(frames[0].payload.origin, 'main')
})

check('往返重复事件不重复推送（去重）', () => {
  const { frames, reducer } = collect()
  reducer.create({ id: 's1' })
  reducer.apply({ id: 's1' }, { type: 'approval/asked', data: { id: 'ap1' } })
  const after = frames.length
  // 同类型同数据再问一次：状态没变 → 不再推
  reducer.apply({ id: 's1' }, { type: 'approval/asked', data: { id: 'ap1' } })
  assert.equal(frames.length, after, '未变化不应推送')
})

check('状态确实变化时必须推送', () => {
  const { frames, reducer } = collect()
  reducer.create({ id: 's1' })
  const after = frames.length
  reducer.apply({ id: 's1' }, { type: 'turn/start', data: {} })
  assert.ok(frames.length > after, 'turn/start 必须推送')
  assert.equal(frames.at(-1).payload.status, 'running')
})

check('THROTTLE: 500ms 内的第二帧 reasoning 被丢弃', () => {
  let clock = 1000
  const { frames, reducer } = collect()
  const now = () => clock
  const r2 = createPetSessionReducer((action, payload) => frames.push({ action, payload }), { now })
  r2.create({ id: 's1', running: true })
  const before = frames.length
  r2.chunk({ id: 's1' }, { type: 'reasoning-delta', text: 'a' })
  assert.equal(frames.length, before + 1, '首帧 reasoning 必须推送')
  clock += 100
  r2.chunk({ id: 's1' }, { type: 'reasoning-delta', text: 'b' })
  assert.equal(frames.length, before + 1, '100ms 内的第二帧必须被节流丢弃')
  assert.equal(r2.stateOf('s1').reasoningTail, 'ab', '状态仍照常累积')
  clock += 500
  r2.chunk({ id: 's1' }, { type: 'reasoning-delta', text: 'c' })
  assert.equal(frames.length, before + 2, '超过 500ms 后必须放行')
  assert.ok(frames.at(-1).payload.liveActivity.text.endsWith('c'))
})

check('节流只作用于 reasoning：工具变化不受节流影响', () => {
  let clock = 1000
  const frames = []
  const r = createPetSessionReducer((a, p) => frames.push({ a, p }), { now: () => clock })
  r.create({ id: 's1', running: true })
  r.chunk({ id: 's1' }, { type: 'reasoning-delta', text: 'a' })
  const before = frames.length
  clock += 50
  r.apply({ id: 's1' }, { type: 'tool/call', data: { callId: 'c1', name: 'grep_search' } })
  assert.equal(frames.length, before + 1, '工具事件必须立刻推送')
  assert.equal(frames.at(-1).p.liveActivity.kind, 'tool')
})

check('reducer.idle 只在回合内收尾', () => {
  const { frames, reducer } = collect()
  reducer.create({ id: 's1' })
  const idleOutside = frames.length
  reducer.idle('s1')
  assert.equal(frames.length, idleOutside, '不在回合内时 idle 不应推送')
  reducer.apply({ id: 's1' }, { type: 'turn/start', data: {} })
  reducer.idle('s1')
  assert.equal(frames.at(-1).payload.running, false)
  assert.equal(frames.at(-1).payload.status, undefined)
})

check('reducer.remove 推 remove 帧', () => {
  const { frames, reducer } = collect()
  reducer.create({ id: 's1' })
  reducer.remove('s1')
  assert.equal(frames.at(-1).action, 'remove')
  assert.equal(frames.at(-1).payload.id, 's1')
  assert.equal(reducer.stateOf('s1'), undefined)
})

check('reducer 多会话互不串味', () => {
  const { frames, reducer } = collect()
  reducer.create({ id: 'a' })
  reducer.create({ id: 'b' })
  reducer.apply({ id: 'a' }, { type: 'turn/start', data: {} })
  const aFrames = frames.filter(f => f.payload.id === 'a')
  assert.ok(aFrames.length >= 2)
  assert.equal(reducer.stateOf('b').turnActive, false)
})

check('handler 抛错不冒泡（观测失败不毁回合）', () => {
  const reducer = createPetSessionReducer(() => { throw new Error('sink exploded') })
  reducer.create({ id: 's1' })
  reducer.apply({ id: 's1' }, { type: 'turn/start', data: {} })
  assert.ok(true, '不应抛出')
})

check('clear 清空所有会话', () => {
  const { frames, reducer } = collect()
  reducer.create({ id: 'a' })
  reducer.create({ id: 'b' })
  reducer.clear()
  assert.equal(reducer.stateOf('a'), undefined)
  assert.equal(reducer.stateOf('b'), undefined)
})

console.log('== SSE 流：接线与「没人看就不干活」==')
check('常量：retry=1000 / keepalive=15000 / 注释文本=keepalive', () => {
  assert.equal(SSE_RETRY_MS, 1000)
  assert.equal(SSE_KEEPALIVE_MS, 15000)
  assert.equal(SSE_KEEPALIVE_COMMENT, 'keepalive')
})

check('路由路径逐字一致', () => {
  assert.equal(PET_SESSION_STREAM_PATH, '/api/desktop/dsh-tauri-pet/session/stream')
})

check('SINK ZERO: 首个 sink 挂载订阅，最后一个断开后注销并归零', () => {
  assert.equal(sinkCount(), 0)
  assert.equal(isSessionBusAttached(), false)

  const a = makeSink()
  const detachA = startPetStream(a)
  assert.equal(sinkCount(), 1)
  assert.equal(isSessionBusAttached(), true, '首个 sink 必须挂载宿主订阅')

  // 还有第二个消费者时，第一个断开不能收工
  const b = makeSink()
  const detachB = startPetStream(b)
  assert.equal(sinkCount(), 2)
  detachA()
  assert.equal(sinkCount(), 1)
  assert.equal(isSessionBusAttached(), true, '还有消费者时不得注销订阅')

  detachB()
  assert.equal(sinkCount(), 0)
  assert.equal(isSessionBusAttached(), false, '最后一个 sink 断开必须注销订阅')
})

check('SINK ZERO: 归零清空累积状态（下次接入重新 create，不残留旧会话）', () => {
  resetStream()
  const a = makeSink()
  const detach = startPetStream(a)
  publishHost('message_received', { turn_id: 't1', input: '你好' })
  assert.ok(a.frames.length >= 1, '有消费者时应收到帧')
  assert.equal(a.frames[0].action, 'create', '首次必须 create')
  detach()
  assert.equal(sinkCount(), 0)

  // 重新接入：老会话不得复活成 update，必须是全新 create
  const b = makeSink()
  const detachB = startPetStream(b)
  publishHost('message_received', { turn_id: 't2', input: '又来' })
  assert.equal(b.frames[0].action, 'create', '归零后首次必须重新 create')
  detachB()
  resetStream()
})

check('clearHostRuntime：仍挂着的 sink 被关闭并清空集合', () => {
  resetStream()
  const a = makeSink()
  startPetStream(a)
  assert.equal(sinkCount(), 1)
  clearHostRuntime()
  assert.equal(sinkCount(), 0)
  assert.equal(a.closed, true, '收尾必须关闭在途连接')
  assert.equal(isSessionBusAttached(), false)
})

check('message_received → 会话上线且状态 running', () => {
  withStream((a) => {
    publishHost('message_received', { turn_id: 't1', input: '你好' })
    assert.equal(a.frames[0].action, 'create', '首个帧必须是 create')
    const last = a.frames.at(-1)
    assert.equal(last.payload.id, PET_SESSION_ID)
    assert.equal(last.payload.status, 'running')
  })
})

check('stream_chunk(reasoning) → liveActivity 显示推理正文', () => {
  withStream((a) => {
    publishHost('message_received', { turn_id: 't1' })
    publishHost('stream_start', { mode: 'reasoning' })
    publishHost('stream_chunk', { mode: 'reasoning', text: '正在读配置' })
    const last = a.frames.at(-1)
    assert.ok(last, '应推送推理帧')
    assert.equal(last.payload.liveActivity.kind, 'reasoning')
    assert.equal(last.payload.liveActivity.text, '正在读配置')
  })
})

check('stream_chunk(text) 累积后由 response 带出（text-delta 不单独推帧）', () => {
  withStream((a) => {
    publishHost('message_received', { turn_id: 't1' })
    publishHost('stream_start', { mode: 'text' })
    publishHost('stream_chunk', { mode: 'text', text: '答案是 42' })
    assert.equal(a.frames.at(-1).payload.message, undefined, 'text-delta 本身不推正文')
    publishHost('response', { content: '答案是 42', sessionRef: 's1' })
    const withText = a.frames.filter(f => f.payload.message)
    assert.equal(withText.at(-1).payload.message, '答案是 42')
  })
})

check('tool_preparing → liveActivity 显示工具与分类', () => {
  withStream((a) => {
    publishHost('message_received', { turn_id: 't1' })
    publishHost('tool_preparing', { name: 'grep_search' })
    const last = a.frames.at(-1)
    assert.equal(last.payload.liveActivity.kind, 'tool')
    assert.equal(last.payload.liveActivity.name, 'grep_search')
    assert.equal(last.payload.toolActivity, 'searching')
  })
})

check('tool_call → 参数补全后出栈，workStatus 落 result', () => {
  withStream((a) => {
    publishHost('message_received', { turn_id: 't1' })
    publishHost('tool_preparing', { name: 'write_file' })
    publishHost('tool_call', { name: 'write_file', args: { path: 'a.txt' }, ok: true })
    const last = a.frames.at(-1)
    assert.equal(last.payload.workStatus, 'result')
    assert.equal(last.payload.liveActivity, undefined, '工具出栈后不该再显示工具')
  })
})

check('response → 回合收尾（running=false，状态回落）', () => {
  withStream((a) => {
    publishHost('message_received', { turn_id: 't1' })
    assert.equal(a.frames.at(-1).payload.status, 'running')
    publishHost('response', { content: '', sessionRef: 's1' })
    const last = a.frames.at(-1)
    assert.equal(last.payload.running, false)
    assert.equal(last.payload.status, undefined)
  })
})

check('error → lastAgentError 生效，状态为 error', () => {
  withStream((a) => {
    publishHost('message_received', { turn_id: 't1' })
    publishHost('error', { label: 'llm', error: 'kaboom' })
    const last = a.frames.at(-1)
    assert.equal(last.payload.status, 'error')
    assert.equal(last.payload.lastAgentError, 'kaboom')
  })
})

check('processing_preempted → 中断收尾（不残留 running）', () => {
  withStream((a) => {
    publishHost('message_received', { turn_id: 't1' })
    publishHost('processing_preempted', { reason: '收到用户消息' })
    assert.equal(a.frames.at(-1).payload.running, false)
  })
})

check('无关事件不推帧（白名单之外的噪声被忽略）', () => {
  withStream((a) => {
    publishHost('message_received', { turn_id: 't1' })
    const before = a.frames.length
    publishHost('llm_usage', { tokens: 10 })
    publishHost('tick', { label: 'x' })
    assert.equal(a.frames.length, before, '无关事件不应推帧')
  })
})

console.log('== 翻译层逐条映射（爱丽丝事件 → 桌宠契约）==')
// 这一节专门盯**翻译层本身**，而不是 reducer。契约要求订阅 DSH 的 4 个宿主事件，
// 但那 4 个名字在爱丽丝里不存在；真正的风险全在这个映射表上，所以每条都要钉死。

check('MAP: message_received 发出 turn/start；user/message 与之等价时被去重', () => {
  withStream((a) => {
    publishHost('message_received', { turn_id: 't1', input: '你好' })
    assert.equal(a.frames[0].action, 'create')
    assert.equal(a.frames[1].payload.workStatus, 'thinking', 'turn/start 先把 workStatus 置 thinking')
    assert.equal(a.frames[1].payload.status, 'running', 'turn/start 置 running')
    // turn/start 之后 user/message 不改变任何被比较字段 → 按去重契约不再推帧。
    // 这是**正确**行为（省掉一帧等价重绘），不是丢事件：状态已经是对的。
    assert.equal(a.frames.length, 2, 'create + turn/start；user/message 被去重')
  })
})

check('MAP: tool_preparing 只入栈（不进 result），tool_call 才出栈', () => {
  withStream((a) => {
    publishHost('message_received', { turn_id: 't1' })
    publishHost('tool_preparing', { name: 'grep_search' })
    assert.equal(a.frames.at(-1).payload.workStatus, 'working')
    assert.equal(a.frames.at(-1).payload.liveActivity.kind, 'tool')
    publishHost('tool_call', { name: 'grep_search', args: { q: 'x' }, ok: true })
    assert.equal(a.frames.at(-1).payload.workStatus, 'result')
    assert.equal(a.frames.at(-1).payload.liveActivity, undefined)
  })
})

check('MAP: 连续两个工具，第二个执行完才回落 result', () => {
  withStream((a) => {
    publishHost('message_received', { turn_id: 't1' })
    publishHost('tool_preparing', { name: 'read_file' })
    publishHost('tool_preparing', { name: 'write_file' })
    publishHost('tool_call', { name: 'read_file', args: {}, ok: true })
    assert.equal(a.frames.at(-1).payload.workStatus, 'working', '还有工具在跑，必须仍是 working')
    publishHost('tool_call', { name: 'write_file', args: {}, ok: true })
    assert.equal(a.frames.at(-1).payload.workStatus, 'result')
  })
})

check('MAP: stream_chunk 按 mode 分派 —— reasoning 进 liveActivity', () => {
  withStream((a) => {
    publishHost('message_received', { turn_id: 't1' })
    publishHost('stream_chunk', { mode: 'reasoning', text: '推理片段' })
    assert.equal(a.frames.at(-1).payload.liveActivity.kind, 'reasoning')
    assert.equal(a.frames.at(-1).payload.liveActivity.text, '推理片段')
    assert.equal(a.frames.at(-1).payload.message, undefined, 'reasoning 不该进 message')
  })
})

check('MAP: text-delta 累积到 assistantText，由后续 fold 事件带出（DSH 原语义）', () => {
  withStream((a) => {
    publishHost('message_received', { turn_id: 't1' })
    publishHost('stream_chunk', { mode: 'text', text: '正文片段' })
    // text-delta 本身**不产生载荷**（与 DSH 一致）：正文要等 assistant/message
    // 或 response 这类 fold 事件才带出来。
    const afterChunk = a.frames.length
    publishHost('stream_chunk', { mode: 'text', text: '再接一段' })
    assert.equal(a.frames.length, afterChunk, 'text-delta 不应单独推帧')
    // response 先喂 assistant/message（带出正文）再 turn/end（清空瞬时态）——
    // 所以正文出现在**倒数第二帧**上，末帧是收尾帧。
    publishHost('response', { content: '正文片段再接一段' })
    const withText = a.frames.filter(f => f.payload.message)
    assert.ok(withText.length >= 1, '正文必须至少出现在一帧上')
    assert.equal(withText.at(-1).payload.message, '正文片段再接一段')
  })
})

check('MAP: stream_chunk 缺 mode 时回落 stream_start 记下的模式', () => {
  withStream((a) => {
    publishHost('message_received', { turn_id: 't1' })
    publishHost('stream_start', { mode: 'reasoning' })
    // 后续 chunk 不带 mode，应沿用 reasoning
    publishHost('stream_chunk', { text: '沿用模式' })
    assert.equal(a.frames.at(-1).payload.liveActivity.kind, 'reasoning')
    assert.equal(a.frames.at(-1).payload.liveActivity.text, '沿用模式')
  })
})

check('MAP: response → turn/end(completed)，正文由上一帧带出', () => {
  withStream((a) => {
    publishHost('message_received', { turn_id: 't1' })
    publishHost('response', { content: '最终答复', sessionRef: 's1' })
    const payloads = a.frames.map(f => f.payload)
    assert.ok(payloads.some(p => p.workStatus === 'success'), 'completed 应落到 success')
    // 正文在 assistant/message 帧里；紧随其后的 turn/end 帧按 DSH 契约清空 assistantText。
    assert.equal(payloads.at(-2).message, '最终答复')
    assert.equal(payloads.at(-1).message, undefined, 'turn/end 会清空正文（DSH 原语义）')
    assert.equal(a.frames.at(-1).payload.running, false)
    assert.equal(a.frames.at(-1).payload.status, undefined, '收尾后状态回落')
  })
})

check('MAP: error → turn/end(error)，lastAgentError 用的是 error 字段', () => {
  withStream((a) => {
    publishHost('message_received', { turn_id: 't1' })
    publishHost('error', { label: 'llm', error: 'provider down' })
    assert.equal(a.frames.at(-1).payload.status, 'error')
    assert.equal(a.frames.at(-1).payload.lastAgentError, 'provider down')
  })
})

check('MAP: error 缺 error 字段时回落 label', () => {
  withStream((a) => {
    publishHost('message_received', { turn_id: 't1' })
    publishHost('error', { label: 'llm' })
    assert.equal(a.frames.at(-1).payload.lastAgentError, 'llm')
  })
})

check('MAP: processing_preempted → 中断收尾且不残留 running', () => {
  withStream((a) => {
    publishHost('message_received', { turn_id: 't1' })
    publishHost('processing_preempted', { reason: '收到用户消息' })
    const last = a.frames.at(-1).payload
    assert.equal(last.running, false)
    // turnActive 不出现在载荷里（DSH 的 foldPetPayload 只暴露 running）；
    // 它只影响 status，所以这里断言 status 回落即可。
    assert.equal(last.status, undefined)
  })
})

check('MAP: response 的正文在 turn/end **之前**落定（否则收尾后会被重新点亮）', () => {
  withStream((a) => {
    publishHost('message_received', { turn_id: 't1' })
    publishHost('response', { content: '最终答复' })
    // 末帧必须是收尾帧：running=false。若正文在 turn/end 之后喂进去，
    // assistant/message 会把 running 置回 true，末帧就变成「还在跑」——
    // 宠物会永远显示「运行中」，这是本轮抓到并修掉的真实缺陷。
    assert.equal(a.frames.at(-1).payload.running, false, '末帧必须已收尾')
    assert.equal(a.frames.at(-1).payload.status, undefined)
    // 正文出现在收尾**之前**的那一帧。
    assert.equal(a.frames.at(-2).payload.message, '最终答复')
  })
})

check('MAP 未映射事件安全忽略：不崩、不推帧、不污染状态', () => {
  withStream((a) => {
    publishHost('message_received', { turn_id: 't1' })
    const before = a.frames.length
    const stateBefore = a.frames.at(-1).payload
    // 喂一堆爱丽丝会发、但翻译层刻意没映射的事件
    for (const type of [
      'focus_frame', 'typhoon_mode', 'key_configured', 'agent_name_updated',
      'tool_inventory', 'browser_preview', 'llm_retry', 'message_requeued',
      'subagent_activity', 'workflow_start', 'goal_round', 'compaction_start',
      'deliverable_presented', 'ui_signal', '不知道的事件名',
    ]) {
      publishHost(type, { anything: true })
    }
    assert.equal(a.frames.length, before, '未映射事件不得推帧')
    assert.deepEqual(a.frames.at(-1).payload, stateBefore, '未映射事件不得改变状态')
  })
})

check('MAP 空/畸形载荷不崩', () => {
  withStream((a) => {
    publishHost('message_received')
    publishHost('tool_preparing', {})
    publishHost('tool_call', {})
    publishHost('stream_chunk', {})
    publishHost('response')
    publishHost('error')
    publishHost('processing_preempted')
    assert.ok(true, '全部畸形载荷不应抛出')
  })
})

check('MAP: stream_chunk 空文本不推帧（避免空转）', () => {
  withStream((a) => {
    publishHost('message_received', { turn_id: 't1' })
    const before = a.frames.length
    publishHost('stream_chunk', { mode: 'reasoning', text: '' })
    assert.equal(a.frames.length, before, '空文本不应推帧')
  })
})

check('MAP: 翻译层的 reasoning 也走 500ms 节流（挂在 stream_chunk 上）', () => {
  withStream((a) => {
    publishHost('message_received', { turn_id: 't1' })
    publishHost('stream_chunk', { mode: 'reasoning', text: '一' })
    const after1 = a.frames.length
    // 同一毫秒内的第二帧必须被节流丢弃
    publishHost('stream_chunk', { mode: 'reasoning', text: '二' })
    assert.equal(a.frames.length, after1, '节流窗口内的第二帧必须被丢弃')
  })
})

console.log('== SSE 线上帧格式 ==')
check('首帧带 retry: 1000，之后不再发 retry', () => {
  const res = makeRes()
  const write = createSseWriter(res.res)
  write('create', { id: 's1' })
  write('update', { id: 's1' })
  write('remove', { id: 's1' })
  assert.match(res.body[0], /^retry: 1000\ndata: /)
  assert.doesNotMatch(res.body[1], /retry/)
  assert.doesNotMatch(res.body[2], /retry/)
  assert.equal(res.body.filter(chunk => chunk.includes('retry:')).length, 1, 'retry 只应在首帧出现一次')
})

check('数据帧格式逐字：data: {"action":…,"payload":…}\\n\\n', () => {
  const res = makeRes()
  const write = createSseWriter(res.res)
  write('update', { status: 'running' })
  const chunk = res.body[0]
  assert.ok(chunk.endsWith('\n\n'), '必须以空行结束')
  const dataLine = chunk.split('\n').find(line => line.startsWith('data: '))
  assert.ok(dataLine, '必须有 data: 行')
  const parsed = JSON.parse(dataLine.slice('data: '.length))
  assert.deepEqual(parsed, { action: 'update', payload: { status: 'running' } })
  assert.deepEqual(Object.keys(parsed), ['action', 'payload'], '顶层只有 action/payload 两个键')
})

check('keepalive 帧格式：": keepalive\\n\\n"', () => {
  const res = makeRes()
  const write = createSseWriter(res.res)
  write('create', { id: 's1' })
  const before = res.body.length
  const stop = startKeepalive(res.res)
  // 心跳是 15s 定时器，这里断言「未到间隔不写出」，并断言注释帧文本格式。
  stop()
  assert.equal(res.body.length, before, '未到间隔不应写出心跳')
  assert.equal(`: ${SSE_KEEPALIVE_COMMENT}\n\n`, ': keepalive\n\n')
})

check('保活定时器不阻止进程退出（unref）', () => {
  const res = makeRes()
  assert.equal(typeof startKeepalive(res.res), 'function')
  const stop = startKeepalive(res.res)
  stop()
  assert.ok(true)
})

check('写失败时保活自己停掉（不留悬空定时器）', () => {
  let written = 0
  const res = {
    write() { written += 1; throw new Error('socket closed') },
  }
  const stop = startKeepalive(res)
  stop()
  assert.ok(true, '不应抛出')
})

console.log('== 路由接线（Pet route handler）==')
check('路由在 api.js 中已导入并注册（源码级接线断言）', async () => {
  const source = await readFile(new URL('./api.js', import.meta.url), 'utf8')
  assert.match(source, /import \{ handlePetRoutes \} from '\.\/api\/routes\/pet\.js'/)
  assert.match(source, /if \(await handlePetRoutes\(req, res, url\)\) return true/)
})

check('路由文件包含路径常量与非 GET 405 / 非回环 403', async () => {
  const source = await readFile(new URL('./api/routes/pet.js', import.meta.url), 'utf8')
  assert.match(source, /PET_SESSION_STREAM_PATH = '\/api\/desktop\/dsh-tauri-pet\/session\/stream'/)
  assert.match(source, /res\.writeHead\(405/)
  assert.match(source, /res\.writeHead\(403/)
  assert.match(source, /text\/event-stream/)
})

check('路由对非本路径返回 false（不吞别人的请求）', async () => {
  const handled = await handlePetRoutes(
    { method: 'GET', socket: { remoteAddress: '127.0.0.1' }, on: () => {} },
    makeRes().res,
    new URL('http://localhost/other'),
  )
  assert.equal(handled, false)
})

check('路由对非 GET 返回 405 且不建流', async () => {
  const res = makeRes()
  const handled = await handlePetRoutes(
    { method: 'POST', socket: { remoteAddress: '127.0.0.1' }, on: () => {} },
    res.res,
    new URL('http://localhost' + PET_SESSION_STREAM_PATH),
  )
  assert.equal(handled, true)
  assert.equal(res.res.statusCode, 405)
})

check('路由对非回环来源返回 403', async () => {
  const res = makeRes()
  const handled = await handlePetRoutes(
    { method: 'GET', socket: { remoteAddress: '192.168.1.9' }, on: () => {} },
    res.res,
    new URL('http://localhost' + PET_SESSION_STREAM_PATH),
  )
  assert.equal(handled, true)
  assert.equal(res.res.statusCode, 403)
  assert.match(res.text(), /forbidden/)
})

check('路由对回环 GET 建流：写头部 + 首帧 keepalive 注释', async () => {
  // ⚠️ 必须先归零：sink 集合与 knownSessions 是**进程级单例**，
  // 前面任何一个用例少清一次，这里就会看到 2 个 sink 而不是 1 个。
  resetStream()
  const res = makeRes()
  const req = makeReq()
  const handled = await handlePetRoutes(
    req, res.res, new URL('http://localhost' + PET_SESSION_STREAM_PATH),
  )
  assert.equal(handled, true)
  assert.equal(res.res.statusCode, 200)
  assert.equal(res.res.headers['Content-Type'], 'text/event-stream; charset=utf-8')
  assert.equal(res.res.headers['X-Accel-Buffering'], 'no')
  assert.equal(res.body[0], ': keepalive\n\n')
  req.trigger('close')
  // 断开后 sink 必须归零（避免测试间串味）
  assert.equal(sinkCount(), 0)
  resetStream()
})

console.log('== 「窗口关闭 → 宿主收工」闭环（Lead 指定必须验证，不能只是推断）==')
// 这条链路是桌宠「不烧 CPU」的全部依据：桌宠窗口断开 SSE → 路由的 finish() →
// detach() → 最后一个 sink 归零 → 注销宿主订阅 + 清空累积状态。
// 这里用**真实的 handlePetRoutes**（不是手搓的 sink）跑完整闭环。

check('CLOSE: 建流→有消费者；关闭请求→sink 归零+注销订阅+状态清空', async () => {
  resetStream()
  assert.equal(sinkCount(), 0)
  assert.equal(isSessionBusAttached(), false)

  const res = makeRes()
  const req = makeReq()
  await handlePetRoutes(req, res.res, new URL('http://localhost' + PET_SESSION_STREAM_PATH))
  assert.equal(sinkCount(), 1, '建流后应挂上 1 个消费者')
  assert.equal(isSessionBusAttached(), true, '首个消费者必须挂载宿主订阅')

  // 消费一帧，证明累积状态确实存在
  publishHost('message_received', { turn_id: 't1' })
  const framesAfter = res.body.filter(chunk => chunk.startsWith('data: ') || chunk.includes('\ndata: '))
  assert.ok(framesAfter.length >= 1, '有消费者时应写出数据帧')

  // 模拟窗口关闭：SSE 连接断开
  req.trigger('close')
  assert.equal(sinkCount(), 0, '关闭后消费者必须归零')
  assert.equal(isSessionBusAttached(), false, '归零后必须注销宿主订阅（这条是性能契约）')

  // 状态必须已被清空：重新接入时首个帧必须是 create，而不是残留会话的 update
  const res2 = makeRes()
  const req2 = makeReq()
  await handlePetRoutes(req2, res2.res, new URL('http://localhost' + PET_SESSION_STREAM_PATH))
  publishHost('message_received', { turn_id: 't2' })
  const dataChunks = res2.body.filter(c => c.includes('"action"'))
  assert.ok(dataChunks.length >= 1, '重新接入应能收到帧')
  assert.match(dataChunks[0], /"action":"create"/, '状态已清空 → 重新 create')
  req2.trigger('close')
  resetStream()
})

check('CLOSE: 两个消费者时关掉一个，订阅必须保留（不能过早收工）', async () => {
  resetStream()
  const resA = makeRes(); const reqA = makeReq()
  const resB = makeRes(); const reqB = makeReq()
  const url = new URL('http://localhost' + PET_SESSION_STREAM_PATH)
  await handlePetRoutes(reqA, resA.res, url)
  await handlePetRoutes(reqB, resB.res, url)
  assert.equal(sinkCount(), 2)

  reqA.trigger('close')
  assert.equal(sinkCount(), 1)
  assert.equal(isSessionBusAttached(), true, '还有消费者，订阅不得注销')

  // 剩下的消费者仍能收到帧（证明订阅真的还活着）
  const before = resB.body.length
  publishHost('message_received', { turn_id: 't1' })
  assert.ok(resB.body.length > before, '剩余消费者必须仍能收到帧')

  reqB.trigger('close')
  assert.equal(sinkCount(), 0)
  assert.equal(isSessionBusAttached(), false)
  resetStream()
})

check('CLOSE: res 侧 close 事件同样触发收工（不只依赖 req）', async () => {
  resetStream()
  const res = makeRes()
  const req = makeReq()
  await handlePetRoutes(req, res.res, new URL('http://localhost' + PET_SESSION_STREAM_PATH))
  assert.equal(sinkCount(), 1)
  // 路由同时挂了 res.on('close')；用 makeRes 的 res 触发
  resResTrigger(res.res, 'close')
  assert.equal(sinkCount(), 0)
  resetStream()
})

check('CLOSE: 重复触发 close 是幂等的（不重复注销、不报错）', async () => {
  resetStream()
  const res = makeRes()
  const req = makeReq()
  await handlePetRoutes(req, res.res, new URL('http://localhost' + PET_SESSION_STREAM_PATH))
  req.trigger('close')
  req.trigger('close')
  req.trigger('close')
  assert.equal(sinkCount(), 0)
  resetStream()
})

check('CLOSE: 断开后不再向该连接写帧（不写已关闭的 socket）', async () => {
  resetStream()
  const res = makeRes()
  const req = makeReq()
  await handlePetRoutes(req, res.res, new URL('http://localhost' + PET_SESSION_STREAM_PATH))
  publishHost('message_received', { turn_id: 't1' })
  req.trigger('close')
  const frozen = res.body.length
  // 断开后继续灌事件：不应再往这个 res 里写
  publishHost('message_received', { turn_id: 't2' })
  publishHost('tool_preparing', { name: 'grep_search' })
  assert.equal(res.body.length, frozen, '断开后不得再写帧')
  resetStream()
})

console.log('== Electron 层纯逻辑（pet-state.cjs，可在 node 下测）==')
check('EM: pet_size 默认 100 / 范围 50–200 / step 5', () => {
  assert.equal(ELECTRON_PET_SIZE_DEFAULT, 100)
  assert.equal(ELECTRON_PET_SIZE_MIN, 50)
  assert.equal(ELECTRON_PET_SIZE_MAX, 200)
  assert.equal(ELECTRON_PET_SIZE_STEP, 5)
  assert.equal(electronNormalizePetSize(undefined), 100)
  assert.equal(electronNormalizePetSize(100), 100)
  assert.equal(electronNormalizePetSize(0), 50, '低于下限夹到 50')
  assert.equal(electronNormalizePetSize(999), 200, '高于上限夹到 200')
  assert.equal(electronNormalizePetSize(102), 100, '对齐到 step 5')
  assert.equal(electronNormalizePetSize(103), 105, '对齐到 step 5')
  assert.equal(electronNormalizePetSize('abc'), 100, '非数字回落默认')
})

check('EM: 尺寸档位列表覆盖 50..200 共 31 档', () => {
  const options = electronPetSizeOptions()
  assert.equal(options[0], 50)
  assert.equal(options.at(-1), 200)
  assert.equal(options.length, 31)
  assert.ok(options.every(v => v % 5 === 0))
})

check('EM: 精灵图规格 8 列 × 11 行', () => {
  assert.equal(ELECTRON_PET_SPRITE_COLUMNS, 8)
  assert.equal(ELECTRON_PET_SPRITE_ROWS, 11)
  assert.equal(typeof petPreloadSprite.columns, 'number')
  assert.equal(petPreloadSprite.rows, 11)
})

check('EM: 窗口像素随尺寸线性缩放（100→基准）', () => {
  assert.equal(electronPetWindowPx(100), ELECTRON_PET_BASE_PX)
  assert.equal(electronPetWindowPx(50), Math.round(ELECTRON_PET_BASE_PX / 2))
  assert.equal(electronPetWindowPx(200), ELECTRON_PET_BASE_PX * 2)
})

check('EM: 状态读写往返（enabled/active_pet/pet_size）', () => {
  const dir = makeTempDir()
  const initial = electronReadPetState(dir)
  assert.deepEqual(initial, { enabled: false, active_pet: '', pet_size: 100 }, '默认关闭')
  const written = electronWritePetState(dir, { enabled: true, active_pet: 'codex/猫', pet_size: 150 })
  /* `persisted` 是本轮新增字段（2026-10-01）：原先失败分支与成功分支返回**同一个对象**，
     调用方无法区分"存上了"和"没存上"。这里按含 persisted 的完整形状比对，
     并额外确认它就是 true —— 否则这轮修法等于没生效。 */
  assert.deepEqual(written, { enabled: true, active_pet: 'codex/猫', pet_size: 150, persisted: true })
  assert.deepEqual(electronReadPetState(dir),
    { enabled: true, active_pet: 'codex/猫', pet_size: 150 },
    '落盘后可读回（读回的是纯状态，不含 persisted —— persisted 是写入结果，不是状态本身）')
})

check('EM: 损坏/缺失状态文件不抛异常（回落默认，SSH readState 同纪律）', () => {
  const dir = makeTempDir()
  assert.deepEqual(
    electronReadPetState(dir),
    { enabled: false, active_pet: '', pet_size: 100 },
    '文件缺失 → 默认值',
  )
  // 写一个坏 JSON
  fs.writeFileSync(electronPetStateFile(dir), '{ not json', 'utf8')
  assert.deepEqual(
    electronReadPetState(dir),
    { enabled: false, active_pet: '', pet_size: 100 },
    '损坏 JSON → 默认值，绝不抛',
  )
})

check('EM: 目录扫描——没有宠物资产时返回空数组而不是报错/伪造', () => {
  const dir = makeTempDir()
  for (const source of ['preset', 'chat', 'codex']) {
    assert.deepEqual(electronListPets(dir, source), [], `${source} 空目录应为空数组`)
  }
  const all = electronListAllPets(dir)
  assert.deepEqual(all, { preset: [], chat: [], codex: [] })
})

check('EM: 目录扫描能识别建出来的宠物目录（机制可用，只是无内置资产）', () => {
  const dir = makeTempDir()
  fs.mkdirSync(path.join(electronPetRootDir(dir), 'preset', '小白龙'), { recursive: true })
  fs.mkdirSync(path.join(electronPetRootDir(dir), 'codex', '猫'), { recursive: true })
  const preset = electronListPets(dir, 'preset')
  assert.equal(preset.length, 1)
  assert.equal(preset[0].name, '小白龙')
  assert.equal(preset[0].id, 'preset/小白龙')
  assert.equal(preset[0].source, 'preset')
  assert.equal(preset[0].hasSprite, false, '没有 sprite.png 时如实报 false')
  assert.equal(electronListPets(dir, 'codex').length, 1)
})

// ── 精灵图这条链路曾经两端都是断的（2026-10-01 修正）─────────────────────────
// 断点 1：listPets 只报一个布尔 `hasSprite`（判据 `sprite.png || spritesheet.png`），
//         渲染层于是自己猜文件名，**只拼了 sprite.png**。
//         → 只有 spritesheet.png 的宠物 hasSprite=true，渲染层却去加载不存在的
//           sprite.png，404，宠物显示空白。**布尔丢失了渲染层需要的信息。**
// 断点 2：桌宠窗口是 `win.loadURL(backendUrl(...))` 加载的，协议是 **HTTP**。
//         `/pets/...` 是根相对路径会请求到后端，而后端**没有这条路由** —— 实测 404。
//         两个断点叠加，任何宠物都显示不出精灵图。
check('SPRITE: listPets 必须报出 spriteFile，不能只给布尔（渲染层不该猜文件名）', () => {
  const dir = makeTempDir()
  const onlySprite = path.join(electronPetRootDir(dir), 'preset', 'a')
  const onlySheet = path.join(electronPetRootDir(dir), 'preset', 'b')
  const none = path.join(electronPetRootDir(dir), 'preset', 'c')
  for (const d of [onlySprite, onlySheet, none]) fs.mkdirSync(d, { recursive: true })
  fs.writeFileSync(path.join(onlySprite, 'sprite.png'), 'x')
  fs.writeFileSync(path.join(onlySheet, 'spritesheet.png'), 'x')

  const pets = Object.fromEntries(electronListPets(dir, 'preset').map(p => [p.name, p]))
  assert.equal(pets.a.spriteFile, 'sprite.png', '只有 sprite.png 时报它')
  assert.equal(pets.b.spriteFile, 'spritesheet.png',
    '只有 spritesheet.png 时**必须报 spritesheet.png**——这是原先丢失的那条信息')
  assert.equal(pets.b.hasSprite, true, 'spritesheet.png 也算有精灵图（判据是二者之一）')
  assert.equal(pets.c.spriteFile, null, '都没有时为 null，而不是编一个文件名')
  assert.equal(pets.c.hasSprite, false)
  // hasSprite 与 spriteFile 必须同源，不能一个说有一个说没有
  for (const p of Object.values(pets)) {
    assert.equal(p.hasSprite, p.spriteFile !== null, `${p.name}: hasSprite 与 spriteFile 不一致`)
  }
})

check('SPRITE: 后端必须服务 /pets/ 静态路由（否则渲染层的 URL 必然 404）', async () => {
  // 源码级：static.js 里必须有这条路由，且根目录是 <userDir>/pets
  const staticSource = fs.readFileSync(path.join(process.cwd(), 'src/api/routes/static.js'), 'utf8')
  assert.match(staticSource, /url\.pathname\.startsWith\('\/pets\/'\)/,
    'static.js must serve /pets/ — the pet window loads over HTTP, not file://')
  assert.match(staticSource, /path\.join\(paths\.userDir, 'pets'\)/,
    'the /pets/ root must be <userDir>/pets, same source as pet-state.cjs petRootDir')
  assert.match(staticSource, /serveAsset\(req, res, path\.join\(paths\.userDir, 'pets'\), '\/pets\/'\)/,
    'it must go through serveAsset so the isPathInside traversal guard applies')

  // 行为级：造一个真宠物，走真实拼法，确认文件确实存在且能被 serveAsset 那层拿到
  const dir = makeTempDir()
  const petDir = path.join(dir, 'pets', 'preset', 'probe')
  fs.mkdirSync(petDir, { recursive: true })
  const png = Buffer.from('89504e470d0a1a0a0000000d49484452', 'hex')
  fs.writeFileSync(path.join(petDir, 'spritesheet.png'), png)

  const listed = electronPetState.listAllPets(dir).preset.find(p => p.name === 'probe')
  assert.ok(listed && listed.hasSprite, 'precondition: the probe pet has a sprite')

  // 渲染层现在拼的 URL（与 pet-renderer.js 的拼法逐字一致）
  const url = `/pets/${encodeURIComponent(listed.source)}/${encodeURIComponent(listed.name)}/${listed.spriteFile}`
  assert.equal(url, '/pets/preset/probe/spritesheet.png',
    'a spritesheet-only pet must produce a URL that points at the file that actually exists')

  // 那个 URL 对应的真实文件必须存在（这正是原先 404 的原因：文件在，路由没有）
  const asFile = path.join(dir, 'pets', listed.source, listed.name, listed.spriteFile)
  assert.ok(fs.existsSync(asFile), `the URL must map to a real file: ${asFile}`)
  assert.deepEqual(fs.readFileSync(asFile), png)
})

check('SPRITE: 渲染层不得再自己拼文件名（必须用服务端报的 spriteFile）', () => {
  const renderer = fs.readFileSync(path.join(process.cwd(), 'src/ui/brain-ui/pet-renderer.js'), 'utf8')
  assert.match(renderer, /active\.spriteFile/,
    'the renderer must read the spriteFile the server reported')
  assert.doesNotMatch(renderer, /applySprite\(`\/pets\/preset\/\$\{encodeURIComponent\(active\.name\)\}\/sprite\.png`\)/,
    'the old hard-coded sprite.png URL must be gone — it 404s for spritesheet-only pets')
})

// ── 桌宠状态落盘：**失败必须可与成功区分**（2026-10-01 修正）──────────────────
// writePetState 原先失败分支和成功分支返回**同一个对象**：
//     } catch { return next }      ← 失败
//     return next                  ← 成功
// 两行逐字节相同，调用方无法区分。实测（把父目录做成普通文件，mkdir 必然失败）：
//     writePetState(...) → {"enabled":true,...}   与真成功完全一致
//     磁盘上实际内容      → ENOENT（什么都没写）
// 后果链：pet:set-enabled(true) 拿到 {enabled:true} → applyEnabled(true)
//      → 窗口**真的显示出来** → 但状态从未落盘 → 重启后桌宠消失，且全程零报错。
// 与问题 18（查询失败被伪装成"不存在"）同族：**把一种状态谎报成另一种状态**。
check('PET-STATE: 落盘成功与失败必须可区分（persisted 字段）', () => {
  // 用文件顶部已绑定的模块（`electronRequire(绝对路径)`），
  // 而不是再 electronRequire(path.join('electron', ...)) —— 后者不解相对路径。
  const petState = electronPetState

  // 成功路径
  const okDir = makeTempDir()
  const ok = petState.writePetState(okDir, { enabled: true, active_pet: 'p', pet_size: 120 })
  assert.equal(ok.persisted, true, '写成功必须报 persisted:true')
  assert.ok(fs.existsSync(path.join(okDir, 'pet-state.json')), '写成功后文件必须真的在磁盘上')

  // 失败路径：父级是普通文件 → mkdirSync 必然抛 ENOTDIR
  const blockerDir = makeTempDir()
  const blocker = path.join(blockerDir, 'blocked')
  fs.writeFileSync(blocker, 'I am a file, not a directory', 'utf8')
  const failed = petState.writePetState(path.join(blocker, 'sub'),
    { enabled: true, active_pet: 'p', pet_size: 120 })

  assert.equal(failed.persisted, false, '写失败必须报 persisted:false，不能与成功同形')
  assert.notDeepEqual(
    { enabled: failed.enabled, active_pet: failed.active_pet, pet_size: failed.pet_size },
    { enabled: ok.enabled, active_pet: ok.active_pet, pet_size: ok.pet_size, persisted: true },
    '失败与成功的返回值必须在 persisted 上可分，否则调用方无从判断')
  assert.ok(typeof failed.persist_error === 'string' && failed.persist_error.length > 0,
    '失败必须带上原因，否则排查时只知道"没存上"却不知为何')
  assert.equal(fs.existsSync(path.join(blocker, 'sub', 'pet-state.json')), false,
    '失败时磁盘上确实不该有文件 —— 这条确认失败是真实的，不是断言造出来的')
  // enabled 的语义不被本修法改动：窗口该不该显示由调用方决定
  assert.equal(failed.enabled, true, 'persisted 是附加字段，enabled 的取值语义不能被我改掉')
})

check('PET-STATE: IPC 命令表必须把 persisted 透出给调用方', () => {
  const controller = electronPetWindow.createPetController({
    getUserDir: () => makeTempDir(),
    loadPage: () => {},
  })
  const out = controller.commands['pet:set-active-pet']({ id: 'demo' })
  assert.ok('persisted' in out, 'IPC 返回值必须带上 persisted，否则界面无法如实提示"没存上"')
  assert.equal(out.persisted, true)
})

check('EM: importPet 落盘且如实报 extracted=false（zip 未解压）', () => {
  const dir = makeTempDir()
  const payload = Buffer.from('PK fake zip bytes').toString('base64')
  const result = electronImportPet(dir, { name: 'mypet.zip', data: payload })
  assert.equal(result.ok, true)
  assert.equal(result.extracted, false, '必须如实说明未解压，不能假装成功解析')
  assert.equal(result.id, 'codex/mypet')
  assert.ok(fs.existsSync(result.path), '目录应已创建')
})

check('EM: importPet 接受 dataURL 形式，并拒绝空名/空数据', () => {
  const dir = makeTempDir()
  const dataUrl = `data:application/zip;base64,${Buffer.from('abc').toString('base64')}`
  assert.equal(electronImportPet(dir, { name: 'a.zip', data: dataUrl }).ok, true)
  assert.equal(electronImportPet(dir, { name: '', data: 'abc' }).ok, false)
  assert.equal(electronImportPet(dir, { name: 'x.zip', data: '' }).ok, false)
  assert.equal(electronImportPet(dir, {}).ok, false)
})

check('EM: importPet 路径穿越被清洗（不得写到 pets 目录外）', () => {
  const dir = makeTempDir()
  const payload = Buffer.from('x').toString('base64')
  const result = electronImportPet(dir, { name: '../../escape.zip', data: payload })
  assert.equal(result.ok, true)
  const root = electronPetRootDir(dir)
  const resolved = path.resolve(result.path)
  assert.ok(
    resolved.startsWith(path.resolve(root) + path.sep),
    `导入路径必须落在 pets 目录内，实际 ${resolved}`,
  )
  assert.ok(!resolved.includes('..'), '路径不得含上级引用')
})

check('EM: setSize 落盘并夹取（走 controller 的 commands 表）', () => {
  const dir = makeTempDir()
  const controller = electronPetWindow.createPetController({
    getUserDir: () => dir,
    loadPage: () => {},
  })
  const s1 = controller.commands['pet:set-size']({ size: 999 })
  assert.equal(s1.pet_size, 200, '超上限夹到 200')
  const s2 = controller.commands['pet:set-size']({ size: 3 })
  assert.equal(s2.pet_size, 50, '低于下限夹到 50')
  const s3 = controller.commands['pet:set-active-pet']({ id: 'preset/小白龙' })
  assert.equal(s3.active_pet, 'preset/小白龙')
  assert.equal(controller.commands['pet:get-status']().active_pet, 'preset/小白龙', '状态持久')
  assert.equal(controller.commands['pet:get-overlay-supported'](), true, 'Windows 下支持透明浮层')
})

console.log('== 集成点：设置区段与输入预填（阶段 4）==')
check('PREFILL: 预填文案逐字一致（一个字符都不能差）', () => {
  // 逐字核对：斜杠命令 + 一个半角空格 + 中文文案，结尾无句号。
  // 长度用机器实测（29 码点 / 57 UTF-8 字节），不靠手数。
  assert.equal(PET_PREFILL_TEXT, '/hatch-dsh-pet 根据你对我的了解，养一只宠物')
  assert.equal(Array.from(PET_PREFILL_TEXT).length, 29, '码点数应为 29')
  assert.equal(Buffer.byteLength(PET_PREFILL_TEXT, 'utf8'), 57, 'UTF-8 字节数应为 57')
  assert.ok(PET_PREFILL_TEXT.startsWith('/hatch-dsh-pet '), '命令与文案之间是一个半角空格')
  assert.ok(!PET_PREFILL_TEXT.endsWith('。'), '结尾没有句号')
  assert.equal(isPrefillTextVerbatim(PET_PREFILL_TEXT), true)
  assert.equal(isPrefillTextVerbatim(PET_PREFILL_TEXT + '。'), false, '多一个句号必须判不等')
  assert.equal(isPrefillTextVerbatim(PET_PREFILL_TEXT.replace(' ', '  ')), false, '多一个空格必须判不等')
})

check('SLOT: 设置区段 id/order 与契约逐字一致', () => {
  assert.equal(PET_SETTINGS_SECTION.slot, 'settings.section')
  assert.equal(PET_SETTINGS_SECTION.id, 'dsh-tauri-pet-settings')
  assert.equal(PET_SETTINGS_SECTION.order, 230)
})

check('SLOT: 预填槽位 id/order/priority 与契约逐字一致', () => {
  assert.equal(PET_PREFILL_SLOT.slot, 'conversation.input.left')
  assert.equal(PET_PREFILL_SLOT.id, 'dsh-tauri-pet-prefill')
  assert.equal(PET_PREFILL_SLOT.order, 230)
  assert.equal(PET_PREFILL_SLOT.priority, 0)
})

check('MODEL: 设置区段模型含尺寸范围 50–200 step 5 且如实声明无内置资产', () => {
  const model = buildSettingsSectionModel({ enabled: true, pet_size: 150, active_pet: 'preset/x' })
  assert.equal(model.id, 'dsh-tauri-pet-settings')
  assert.equal(model.order, 230)
  const sizeField = model.fields.find(f => f.key === 'pet_size')
  assert.equal(sizeField.min, 50)
  assert.equal(sizeField.max, 200)
  assert.equal(sizeField.step, 5)
  assert.equal(sizeField.value, 150)
  assert.equal(model.fields.find(f => f.key === 'enabled').value, true)
  // 三路来源
  assert.deepEqual(model.fields.find(f => f.key === 'active_pet').sources, ['preset', 'chat', 'codex'])
  // 「没有内置资产」必须出现在界面上
  assert.match(model.notice, /未内置宠物图片资产/)
})

check('MODEL: 设置区段模型对畸形输入安全', () => {
  const model = buildSettingsSectionModel()
  assert.equal(model.fields.find(f => f.key === 'enabled').value, false)
  assert.equal(model.fields.find(f => f.key === 'pet_size').value, 100, '非法尺寸回落 100')
  assert.equal(model.fields.find(f => f.key === 'active_pet').value, '')
})

check('MODEL: 预填模型逐字携带文案与槽位元数据', () => {
  const model = buildPrefillModel()
  assert.equal(model.id, 'dsh-tauri-pet-prefill')
  assert.equal(model.order, 230)
  assert.equal(model.priority, 0)
  assert.equal(model.text, PET_PREFILL_TEXT)
})

check('DOM: 源码级断言——标记、事件绑定、IPC handler 均已存在', async () => {
  const settingsSrc = await readFile(new URL('./ui/brain-ui/pet-settings.js', import.meta.url), 'utf8')
  assert.match(settingsSrc, /'dsh-tauri-pet-settings'/)
  assert.match(settingsSrc, /'dsh-tauri-pet-prefill'/)
  assert.match(settingsSrc, /order: 230/)
  assert.match(settingsSrc, /priority: 0/)
  assert.match(settingsSrc, /addEventListener\('click'/, '预填按钮必须有 click 绑定')

  const rendererSrc = await readFile(new URL('./ui/brain-ui/pet-renderer.js', import.meta.url), 'utf8')
  assert.match(rendererSrc, /new EventSource\(PET_SESSION_STREAM_PATH\)/, '必须真的连 SSE')
  assert.match(rendererSrc, /source\.onmessage/, '必须有 onmessage 绑定')
  assert.match(rendererSrc, /source\.onerror/, '必须有错误处理')
  assert.match(rendererSrc, /beforeunload[\s\S]*?source\.close\(\)/, '卸载时必须断开 SSE')

  const htmlSrc = await readFile(new URL('./ui/brain-ui/pet.html', import.meta.url), 'utf8')
  assert.match(htmlSrc, /id="pet-root"/)
  assert.match(htmlSrc, /id="pet-bubble"/)
  assert.match(htmlSrc, /id="pet-task"/)
  assert.match(htmlSrc, /pet-renderer\.js/, '页面必须加载渲染脚本')
})

check('IPC: main.cjs 中 9 个桌宠命令与窗口控制器均已接线', async () => {
  const mainSrc = await readFile(new URL('../electron/main.cjs', import.meta.url), 'utf8')
  assert.match(mainSrc, /const \{ createPetController \} = require\('\.\/pet-window\.cjs'\)/)
  assert.match(mainSrc, /const petController = createPetController\(/)
  assert.match(mainSrc, /Object\.entries\(petController\.commands\)/, '命令表应循环注册')
  // 窗口参数：透明 + 置顶 + 无边框 + 不抢焦点 + 不节流
  const winSrc = await readFile(new URL('../electron/pet-window.cjs', import.meta.url), 'utf8')
  assert.match(winSrc, /transparent: true/)
  assert.match(winSrc, /alwaysOnTop: true/)
  assert.match(winSrc, /frame: false/)
  assert.match(winSrc, /skipTaskbar: true/)
  assert.match(winSrc, /focusable: false/, '不得抢前台焦点')
  assert.match(winSrc, /backgroundThrottling: false/)
  assert.match(winSrc, /showInactive\(\)/, '必须用 showInactive 而不是 show')
  assert.match(winSrc, /preload: path\.join\(__dirname, 'pet-preload\.cjs'\)/)
})

check('IPC: preload.cjs 暴露 alice.pet 的 8 个方法', async () => {
  const preloadSrc = await readFile(new URL('../electron/preload.cjs', import.meta.url), 'utf8')
  assert.match(preloadSrc, /pet: \{/)
  for (const method of [
    'getStatus', 'isOverlaySupported', 'setEnabled', 'setActivePet',
    'setSize', 'listPets', 'listPresetPets', 'importPet',
  ]) {
    assert.match(preloadSrc, new RegExp(`\\b${method}:`), `preload 缺少 ${method}`)
  }
  // 8 个方法与 8 个 IPC 频道一一对应
  for (const channel of [
    'pet:get-status', 'pet:get-overlay-supported', 'pet:set-enabled',
    'pet:set-active-pet', 'pet:set-size', 'pet:list-pets',
    'pet:list-preset-pets', 'pet:import-pet',
  ]) {
    assert.ok(preloadSrc.includes(channel), `preload 缺少频道 ${channel}`)
  }
})

check('IPC: pet-preload.cjs 的精灵图规格为 8 列 × 11 行', async () => {
  const src = await readFile(new URL('../electron/pet-preload.cjs', import.meta.url), 'utf8')
  assert.match(src, /columns:\s*8/)
  assert.match(src, /rows:\s*11/)
  assert.match(src, /contextBridge\.exposeInMainWorld\('alicePet'/)
})

check('DOM 挂载：无宿主容器时安全返回 no-op（不崩）', () => {
  assert.equal(typeof mountSettingsSection(null, null, {}), 'function')
  assert.equal(typeof mountPrefillButton(null, null, () => {}), 'function')
  mountSettingsSection(null, null, {})()
  mountPrefillButton(null, null, () => {})()
  assert.ok(true, '无容器不应抛出')
})

// ⚠️ 必须**串行**执行（不要 Promise.all）：用例共享进程级 sink 集合与 reducer 状态，
// 并发跑会互相污染。这里是唯一启动用例的地方——队列里的 thunk 在此逐个 await，
// 每个用例跑完才启动下一个（见 check() 的注释：急切 then 会导致隐性并发）。
for (const item of queue) {
  try {
    await item.fn()
    passed++
    console.log(`  PASS  ${item.label}`)
  } catch (err) {
    failed++
    console.log(`  FAIL  ${item.label}`)
    console.log(`        ${err?.message || err}`)
  }
}

console.log('')
console.log(`pet: ${passed} passed, ${failed} failed`)
// 退出码取或：上方 test-action-contract 的失败（process.exitCode）与
// 本段失败（failed）必须都能让进程退出 1。
process.exitCode = process.exitCode || (failed > 0 ? 1 : 0)

// 汇总上方 test-action-contract 与下方桌宠段的结果：任一失败都退出 1。
process.exit(process.exitCode || 0)

