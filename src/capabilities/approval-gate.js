import { createPendingInteraction } from '../interaction/pending.js'
import { getSSEClientCount } from '../events.js'
import { pushMessage } from '../inbound-message.js'

// 越权审批闸门。对齐 DeepSeek Harness Desktop 的 dsh-client-ui-approval：
// 命中 blockedTools 不再直接返回 PERMISSION_DENIED，而是先拦下、弹卡、
// 等用户点「允许一次」才放行。
//
// 一个安全阀：没有 brain-ui 连着的时候不挂起。否则模型会白等几分钟，
// 最后只拿到一个超时错误——那种情况下退回原来的直接拒绝更诚实。

// 90 秒。整个工具调用（进而是整轮对话）都挂在这里等用户点卡，所以不能按
// 「假设用户就坐在屏幕前」定 5 分钟：没看见卡的时候，白等 5 分钟和直接拒绝对
// 用户来说没区别，但前者会把一整轮对话拖死。超时会走下面的留痕，不会静默消失。
const APPROVAL_TIMEOUT_MS = 90 * 1000
const MAX_DETAIL_CHARS = 400

// 卡片文案总纲（2026-09-27 用户要求）：全部用大白话，不许出现专业术语。
// 工具名不甩英文，理由不甩策略原文，参数不甩 JSON。用户看得懂才谈得上判断。

// 工具名 → 中文名。审批卡是给用户看的，不能把英文工具名直接甩上去。
const TOOL_LABELS = {
  run_command: '执行命令',
  exec_command: '执行命令',
  exec_quick_command: '执行快速命令',
  exec_task_command: '执行命令',
  exec_background_command: '后台执行命令',
  write_file: '写入文件',
  edit_file: '修改文件',
  delete_file: '删除文件',
  make_dir: '新建目录',
  download_file: '下载文件',
  install_software: '安装软件',
  install_tool: '安装工具',
  uninstall_tool: '卸载工具',
  manage_tool_factory: '管理自建工具',
  kill_process: '结束进程',
  set_security: '修改权限设置',
  manage_api_capability: '配置接口能力',
  delegate_to_agent: '委派其他 Agent',
  grant_agent_delegation: '授予委派权限',
  analyze_image: '分析图片',
  run_capability: '调用能力',
  run_api_capability: '调用接口能力',
  generate_image: '生成图片',
  generate_music: '生成音乐',
  generate_lyrics: '生成歌词',
  system_browser_open: '打开系统浏览器',
  browser_clear_data: '清除浏览器数据',
  browser_navigate: '浏览器打开网页',
  browser_click: '浏览器点击',
  browser_type: '浏览器输入',
  browser_fill_form: '浏览器填写表单',
  browser_press_key: '浏览器按键',
  browser_drag: '浏览器拖拽',
}

// 后端策略给的是英文原因。审批卡要中文显示，所以这里逐条翻译；
// 没命中的兜底成一句通用中文，绝不把英文原文透出去。
// 翻译出来的句子同时是 SUGGESTION_RULES 的匹配依据，两边改要一起改。
const REASON_ZH = [
  [/已被安全策略禁用/, '这个功能你在设置里关掉了，我不能做'],
  [/references a parent directory|上级目录/, '这条命令要跑到当前文件夹的外面去'],
  [/references an absolute|绝对路径/, '这条命令写死了电脑上的某个具体位置'],
  [/user home directory|用户主目录/, '这条命令要动你电脑里的用户文件夹'],
  [/destructively rewrite the worktree|破坏性地改写工作区/, '这条命令会把项目文件夹里的改动清掉，清完就找不回来了'],
  [/system-level destructive|系统级破坏/, '这条命令会动系统，比如格式化磁盘或者关机，很危险'],
  [/recursive delete|recursive directory delete|递归删除|递归目录删除/, '这条命令会连文件夹带里面的东西一起删掉'],
  [/dynamic code execution|动态代码执行/, '这条命令是把代码临时拼出来跑，不好一眼看懂它要干什么'],
  [/opening the computer default browser|系统默认浏览器/, '你想让我用你电脑上的浏览器打开网页，但这一轮你没提过这件事'],
  [/Music\.app playback|音乐播放/, '你想让我动你正在放的音乐，但这一轮你没提过这件事'],
  [/keep the browser\/page open|保持浏览器/, '你刚说了别关这个网页，所以我不能关'],
  [/limited to browser\/remote-web evidence|浏览器或网页取证/, '这一轮你说的是只看网页，没让我翻本地文件'],
  [/clearing persistent browser data|清除浏览器数据/, '这会把浏览器里的登录状态和记录清掉，得你亲口说清才做'],
  [/MCP tools are disabled|MCP 工具默认关闭/, '我自己定时干活的时候，这类外部工具默认是不开的'],
  [/may inspect rules|只能查看规则|查看规则/, '我自己干活的时候只能看规则，改规则得你在场'],
  [/requires an explicit user-driven context|需要你在场授权/, '我自己干活的时候不能做这件事，得你在场点头'],
  [/installing software on this machine|装软件会改这台机器的环境/, '这会在你电脑上装东西，装完想回到原样很麻烦'],
  [/changes what the Agent can call|改动爱丽丝以后能调用的工具/, '这会改我以后能用哪些功能，不只影响这一次'],
  [/changes the Agent's own permission preset|改爱丽丝自己的权限档位/, '这会改我自己的权限档位，放行后就不是只这一次了'],
  [/stored API capability or credential|接口能力或凭据/, '这会写入或者覆盖一份存好的接口配置，里面有密钥'],
  [/grants another agent authority|把你的权限转授/, '这等于把我的权限交给另一个程序，让它替你做'],
  [/killing a process interrupts|结束进程会中断/, '结束这个进程，正在跑的任务也会跟着停'],
]

function toolLabel(name) {
  return TOOL_LABELS[name] || '这个功能'
}

function chineseReason(raw, name) {
  const text = String(raw || '').trim()
  if (text) {
    for (const pair of REASON_ZH) {
      if (pair[0].test(text)) return pair[1]
    }
    if (/[\u4e00-\u9fa5]/.test(text)) return text
  }
  return '这件事得你点头我才能做'
}

// 参数里挑第一个有用的值，用来拼大白话的说明。
function firstOf(args, keys) {
  for (const k of keys) {
    const v = args?.[k]
    if (typeof v === 'string' && v.trim()) return v.trim()
    if (typeof v === 'number') return String(v)
  }
  return ''
}

// 「放行后到底要做什么」——以前这里直接把参数 JSON 贴给用户看，那是给机器看的。
// 现在按工具翻译成一句人话，把用户真正需要判断的东西（命令原文、文件路径）露出来。
function describeToolCall(name, args) {
  const a = args || {}
  const path = firstOf(a, ['path', 'file_path', 'filepath', 'target', 'output_path', 'dir', 'directory'])
  const cmd = firstOf(a, ['command', 'cmd', 'script'])
  let line = ''

  if (/^(run_command|exec_command|exec_quick_command|exec_task_command|exec_background_command)$/.test(name)) {
    line = cmd ? `要跑的命令：${cmd}` : '要跑一条命令'
  } else if (name === 'write_file') {
    line = `要写进去的文件：${path || '（没说路径）'}`
    const body = typeof a.content === 'string' ? a.content : ''
    if (body) line += `，一共 ${body.length} 个字`
  } else if (name === 'edit_file') {
    line = `要改的文件：${path || '（没说路径）'}`
  } else if (name === 'delete_file') {
    line = `要删掉的文件：${path || '（没说路径）'}`
  } else if (name === 'make_dir') {
    line = `要新建的文件夹：${path || '（没说路径）'}`
  } else if (name === 'download_file') {
    line = `要从网上下载：${firstOf(a, ['url']) || '（没说地址）'}，存到 ${path || '（没说位置）'}`
  } else if (name === 'install_software') {
    line = `要装的软件：${firstOf(a, ['query', 'package_id', 'name']) || '（没说名字）'}`
  } else if (name === 'kill_process') {
    line = `要结束的进程号：${firstOf(a, ['pid']) || '（没说进程号）'}`
  } else if (name === 'set_security') {
    line = '要改我自己的权限档位或者安全设置'
  } else if (name === 'manage_api_capability') {
    line = '要保存一份接口配置'
  } else if (/^browser_/.test(name) || name === 'system_browser_open') {
    const url = firstOf(a, ['url', 'address'])
    line = url ? `要操作的网页：${url}` : '要在网页上操作'
  }

  if (!line) {
    let rendered = ''
    try {
      rendered = JSON.stringify(a)
    } catch {
      rendered = ''
    }
    line = rendered && rendered !== '{}' ? `具体内容：${rendered}` : '没有额外内容'
  }
  if (line.length > MAX_DETAIL_CHARS) line = `${line.slice(0, MAX_DETAIL_CHARS)}…`
  return line
}

// ── 审批卡要回答用户的四个问题（申请逻辑对齐 DSH）────────────────────
//   1. 在申请什么权限   → permissionLabel
//   2. 为什么要申请     → reason（中文大白话）
//   3. 放行后会做什么   → detail（真实命令 / 文件路径）
//   4. 放行意味着什么   → suggestion，并把更稳妥的那个选项标成「建议」
const PERMISSION_LABELS = {
  run_command: '在你电脑上跑一条命令',
  exec_command: '在你电脑上跑一条命令',
  exec_quick_command: '在你电脑上跑一条命令',
  exec_task_command: '在你电脑上跑一条命令',
  exec_background_command: '在你电脑上后台跑一条命令',
  write_file: '往文件里写内容',
  edit_file: '改文件里的内容',
  delete_file: '删掉一个文件',
  make_dir: '新建一个文件夹',
  download_file: '从网上下载一个文件',
  install_software: '在你电脑上装软件',
  install_tool: '给我加一个新功能',
  uninstall_tool: '给我去掉一个功能',
  manage_tool_factory: '改我能用的功能',
  kill_process: '结束一个正在跑的进程',
  set_security: '改我自己的权限档位',
  manage_api_capability: '保存一份接口配置',
  delegate_to_agent: '让别的程序替我干活',
  grant_agent_delegation: '把我的权限交给别的程序',
  analyze_image: '看一张图片',
  generate_image: '生成一张图片',
  generate_music: '生成一段音乐',
  generate_lyrics: '写一段歌词',
  run_capability: '调用一个功能',
  run_api_capability: '用一份接口配置',
  system_browser_open: '用你电脑上的浏览器打开网页',
  system_music: '动你正在放的音乐',
  browser_clear_data: '清掉浏览器里的记录',
  browser_navigate: '在网页上打开一个地址',
  browser_click: '在网页上点一下',
  browser_type: '在网页上打字',
  browser_fill_form: '在网页上填表',
  browser_press_key: '在网页上按一个键',
  browser_drag: '在网页上拖一下',
  speak: '出声说话',
}

export function permissionLabelFor(name) {
  return PERMISSION_LABELS[name] || '这项操作'
}

// 建议：一句「放行意味着什么」的提示 + 推荐哪个选项。
// 破坏性 / 越出工作区的操作推荐先拒绝；本轮明确要求过、只影响一次的操作推荐放行。
const SUGGESTION_RULES = [
  [/外面去|具体位置|用户文件夹/,
    '这条命令会离开当前项目文件夹。确认那个位置确实是你自己的，再点允许。', 'rejected'],
  [/连文件夹带里面的东西一起删掉|清完就找不回来了|格式化磁盘/,
    '这是删掉就回不来的操作。建议先点拒绝，我改成范围小一点再问你一次。', 'rejected'],
  [/临时拼出来跑/,
    '命令里夹着临时拼出来的代码。你看得懂它要做什么再点允许。', 'rejected'],
  [/设置里关掉了/,
    '这个功能是你自己在设置里关掉的。点允许也只放这一次。', 'rejected'],
  [/登录状态和记录清掉/,
    '这会清掉浏览器的登录状态和缓存。只有你这一轮明确说要清才点允许。', 'rejected'],
  [/用你电脑上的浏览器打开网页/,
    '这会在你电脑上弹出浏览器。你这一轮明确要过就点允许。', 'allowed-once'],
  [/正在放的音乐/,
    '这会改你正在播放的音乐。你这一轮明确要过就点允许。', 'allowed-once'],
  [/只看网页/,
    '这一轮你限定了只看网页。想让我翻本地文件，请新开一轮跟我说。', 'rejected'],
  [/外部工具默认是不开的/,
    '我自己定时干活的时候这类工具默认不开。点允许只放这一次。', 'allowed-once'],
  [/得你在场点头|改规则得你在场/,
    '这是我自己干活时默认不碰的事。点允许只放这一次。', 'allowed-once'],
  [/装完想回到原样很麻烦/,
    '这会在你电脑上装软件，装完不是一句「撤销」就能回到原样。确认这个软件和来源你都认可再点允许。', 'rejected'],
  [/改我以后能用哪些功能/,
    '点允许之后，我以后能用哪些功能就变了，不只是这一次。', 'allowed-once'],
  [/改我自己的权限档位/,
    '这是提权：点了允许，我的权限档位就真的改了，不是只这一次。确认是你本人要改再点。', 'rejected'],
  [/存好的接口配置/,
    '这会写入或者覆盖一份接口配置。确认里面的地址和密钥都是你自己的再点允许。', 'allowed-once'],
  [/交给另一个程序/,
    '这会把你的授权交给另一个程序。确认你清楚它拿这份权限要做什么再点允许。', 'rejected'],
  [/正在跑的任务也会跟着停/,
    '点允许只结束这一个进程，但正在跑的任务会一起中断。确认它不是你还等着用的再点。', 'allowed-once'],
]

export function suggestionFor(reason, name) {
  const text = String(reason || '')
  for (const [re, hint, recommend] of SUGGESTION_RULES) {
    if (re.test(text)) return { hint, recommend }
  }
  return {
    hint: `点「允许一次」只让这一次做，我的权限档位不会变。`,
    recommend: 'allowed-once',
  }
}

/**
 * 请求一次越权执行许可。
 * @returns {Promise<'allowed-once'|'rejected'|'no-ui'|'timeout'|'cancelled'>}
 */
export async function requestToolApproval({ name, args, policy, context } = {}) {
  if (getSSEClientCount() === 0) return 'no-ui'

  const reasonZh = chineseReason(policy?.reason, name)
  // 用翻译后的大白话原因去匹配 SUGGESTION_RULES：它的触发词全是中文，喂英文原文会让
  // 每条规则都落空，所有卡都退化成「只对这一次生效」并把「建议」打在放行上。
  const { hint, recommend } = suggestionFor(reasonZh, name)

  const detail = describeToolCall(name, args)
  const pending = createPendingInteraction({
    kind: 'approval',
    toolName: name,
    callId: context?.callId ?? null,
    reason: reasonZh,
    toolLabel: toolLabel(name),
    permissionLabel: permissionLabelFor(name),
    suggestion: hint,
    options: [
      { value: 'allowed-once', label: '允许一次', recommended: recommend === 'allowed-once' },
      { value: 'rejected', label: '拒绝', recommended: recommend === 'rejected' },
    ],
    detail,
    timeoutMs: APPROVAL_TIMEOUT_MS,
  })

  const signal = context?.signal
  const onAbort = () => pending.cancel('工具调用已中断')
  if (signal) {
    if (signal.aborted) pending.cancel('工具调用已中断')
    else signal.addEventListener('abort', onAbort, { once: true })
  }

  try {
    const answer = await pending.result
    return answer?.outcome === 'allowed-once' ? 'allowed-once' : 'rejected'
  } catch (err) {
    if (err?.code === 'INTERACTION_TIMEOUT') {
      // 留痕：卡挂满超时后不能只留一个静默的 PERMISSION_DENIED。用户当时多半不在
      // 电脑前，这张卡会随着页面关掉/刷新一起消失；这条 SYSTEM 信号进对话历史，
      // 之后无论是他自己翻记录还是下一轮上下文，都看得到「有一次高危操作没等到人」。
      // 走 pushMessage 而不是自己写库：系统信号的既有通路（持久化 + 后台队列）就是它。
      try {
        pushMessage(
          'SYSTEM',
          `审批超时：${permissionLabelFor(name)}——${detail}，等了你 ${Math.round(APPROVAL_TIMEOUT_MS / 1000)} 秒没人作答，这次没有放行。要执行就再说一次。`,
          'SYSTEM',
          { queue: 'background' },
        )
      } catch { /* 留痕是 best-effort，绝不能反过来影响工具调用的结果 */ }
      return 'timeout'
    }
    return 'cancelled'
  } finally {
    if (signal) signal.removeEventListener('abort', onAbort)
  }
}
