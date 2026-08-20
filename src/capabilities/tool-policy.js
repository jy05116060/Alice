import { config, isFullAccessMode } from '../config.js'
import { isPlanMode, isToolBlockedInPlanMode } from '../runtime/plan-mode.js'
import {
  isReadonlyMode,
  isToolDisabledInReadonly,
  shellRestrictedToWorkspace,
} from './sandbox-policy.js'
import { getMcpToolMetadata, isMcpTool } from '../mcp/client-manager.js'
import { isExplicitAgentBrowserDataDeletionRequest } from '../mcp/browser-data-intent.js'
import { isSystemBrowserRequest } from '../mcp/browser-display.js'
import {
  explicitlyKeepsBrowserOpen,
  isLocalFileToolCallBlocked,
} from '../runtime/browser-intent-guards.js'

const TOOL_RISK = {
  read_file: 'low',
  list_dir: 'low',
  search_memory: 'low',
  probe_memory: 'low',
  list_processes: 'low',
  skip_recognition: 'low',
  send_message: 'medium',
  express: 'medium',
  write_file: 'medium',
  edit_file: 'medium',
  make_dir: 'medium',
  upsert_memory: 'medium',
  merge_memories: 'high',
  downgrade_memory: 'low',
  skip_consolidation: 'low',
  manage_reminder: 'medium',
  schedule_reminder: 'medium',
  manage_prefetch_task: 'medium',
  manage_rule: 'medium',
  manage_information_subscription: 'medium',
  ui_set: 'medium',
  capability_demo: 'medium',
  terminal_stream: 'medium',
  set_tick_interval: 'medium',
  media_mode: 'low',
  hotspot_mode: 'low',
  worldcup_mode: 'low',
  open_doc_panel: 'low',
  person_card_mode: 'low',
  computer_status_mode: 'low',
  music: 'low',
  delegate_to_agent: 'high',
  grant_agent_delegation: 'high',
  // 工作流：一次调用可能拉起几十个子代理，闸门在 tool-router（只在真实用户轮
  // 注入）+ 下面的自主轮清单里；这里标 high 是为了审计与审批卡如实描述代价。
  workflow: 'high',
  // Goal（阶段 3.1）：建目标 / 改目标 = 给自己立一个会持续烧轮数的承诺。
  create_goal: 'medium',
  update_goal: 'medium',
  get_goal: 'low',
  // Worktree（阶段 5）：改的是仓库布局（新目录、新分支），失败也可能留下半成品，
  // 所以按 high 走审批；读取当前隔离区是纯查询。
  create_worktree: 'high',
  checkout_worktree: 'high',
  git_worktrees: 'low',
  // 交付物卡片（阶段 6.2）：不改任何东西，只是把已有文件声明给用户看。
  // 唯一的后果是界面多一张卡，所以按 low。
  present: 'low',
  // Office→PDF（阶段 6.3）：起一个本机转换器进程并写一个新 PDF 到磁盘。
  // 它不碰源文件，但确实在文件系统里产出东西、也消耗较多时间，所以按 medium。
  convert_to_pdf: 'medium',
  office_capability: 'low',
  install_tool: 'high',
  uninstall_tool: 'medium',
  list_tools: 'low',
  manage_tool_factory: 'high',
  find_tool: 'low',
  complete_startup_self_check: 'low',
  delete_file: 'high',
  install_software: 'high',
  run_command: 'high',
  exec_command: 'high', // legacy executor alias
  exec_quick_command: 'medium',
  exec_task_command: 'high',
  exec_background_command: 'high',
  download_file: 'high',
  kill_process: 'high',
  web_search: 'high',
  web_read: 'high',
  fetch_url: 'high',
  browser_read: 'high',
  browser_navigate: 'medium',
  browser_navigate_back: 'medium',
  browser_navigate_forward: 'medium',
  browser_reload: 'medium',
  browser_snapshot: 'low',
  browser_find: 'low',
  browser_click: 'high',
  browser_type: 'high',
  browser_fill_form: 'high',
  browser_select_option: 'high',
  browser_press_key: 'high',
  browser_hover: 'medium',
  browser_drag: 'high',
  browser_wait_for: 'medium',
  browser_handle_dialog: 'high',
  browser_tabs: 'medium',
  browser_take_screenshot: 'low',
  browser_console_messages: 'low',
  browser_resize: 'medium',
  browser_close: 'medium',
  browser_clear_data: 'high',
  browser_set_display_mode: 'low',
  system_browser_open: 'medium',
  system_music: 'medium',
  speak: 'high',
  generate_lyrics: 'high',
  generate_music: 'high',
  generate_image: 'high',
  run_capability: 'high',
  run_api_capability: 'high',
  analyze_image: 'high',
  manage_api_capability: 'high',
  set_security: 'high',
}

// Chrome DevTools MCP exposes these actions as browser mutations. Keep an
// explicit local backstop as well, so an autonomous Tick cannot gain mutation
// authority from missing/incorrect remote metadata.
const BROWSER_MUTATING_TOOLS = [
  'browser_navigate',
  'browser_navigate_back',
  'browser_navigate_forward',
  'browser_reload',
  'browser_click',
  'browser_type',
  'browser_fill_form',
  'browser_select_option',
  'browser_press_key',
  'browser_hover',
  'browser_drag',
  'browser_wait_for',
  'browser_handle_dialog',
  'browser_tabs',
  'browser_resize',
  'browser_close',
]
const STARTUP_SELF_CHECK_BROWSER_TOOLS = new Set([
  'browser_navigate',
  'browser_snapshot',
  'browser_close',
])
const SYSTEM_MUSIC_ACTION_INTENT_RE = /(?:apple\s*music|music\.app|系统音乐|音乐播放器|当前歌曲|这首歌|播放|暂停|继续|恢复|停止|上一首|下一首|切歌|换一首|play|pause|resume|stop|next|previous)/i

// Audit risk and autonomous authority are related but not identical. Several
// read-only or reversible capabilities (for example web reads and speech) are
// classified "high" for observability/cost, yet blanket-blocking every high
// label would make autonomous task progress impossible. General shell tools
// stay in the explicit-authorization set because their cwd boundary is not an
// OS sandbox. The rest of this set covers authority changes, installation,
// destructive state changes, process control, and unbudgeted provider work.
const AUTONOMOUS_USER_AUTH_REQUIRED = new Set([
  'delete_file',
  'install_software',
  'install_tool',
  'uninstall_tool',
  'manage_tool_factory',
  'set_security',
  'grant_agent_delegation',
  'manage_api_capability',
  // 工作流也属于「无预算的上游工作量」：一次调用可能拉起几十个子代理。
  // tool-router 已经不在 Tick 轮注入它，这里是第二道独立的闸门——万一将来
  // 出现别的自主轮（冷唤醒/自检）绕过了路由判断，也不会自动烧掉一大笔额度。
  'workflow',
  // 后台形态同样是「无预算的上游工作量」：run_in_background=true 的那一次本轮就返回了，
  // 但子代理照跑。只看 workflow 这个名字会留下一个明显缺口（后台 = 绕过自主轮闸门）。
  'workflow_status',
  'kill_process',
  'run_command',
  'exec_command',
  'exec_quick_command',
  'exec_task_command',
  'exec_background_command',
  'generate_image',
  'generate_music',
  'generate_lyrics',
  'run_capability',
  'run_api_capability',
  'analyze_image',
  'system_browser_open',
  'system_music',
  'browser_clear_data',
  ...BROWSER_MUTATING_TOOLS,
])
export function classifyTool(name) {
  const mcpTool = getMcpToolMetadata(name)
  if (mcpTool?.annotations?.destructiveHint === true) return 'high'
  if (mcpTool?.annotations?.readOnlyHint === true) return 'low'
  return TOOL_RISK[name] || 'medium'
}

// 不可逆 / 破坏性命令：和「路径在不在工作区里」无关，任何权限档位都该先问一次。
// 完全权限档只声明「不限制文件范围」，不代表递归删除、格盘、改写工作区历史、
// 动态执行代码不用过问——细分出来是为了让完全权限档也能单独用这一组。
function irreversibleShellReasons(text) {
  const reasons = []
  if (/\bgit\s+reset\s+--hard\b/i.test(text) || /\bgit\s+clean\b/i.test(text)) reasons.push('command can destructively rewrite the worktree')
  if (/\b(format|diskpart|shutdown)\b/i.test(text)) reasons.push('command is system-level destructive or disruptive')
  if (/Remove-Item\b.*-Recurse|-Recurse\b.*Remove-Item/i.test(text)) reasons.push('recursive delete (Remove-Item -Recurse) detected')
  if (/\brd\s+\/s\b/i.test(text)) reasons.push('recursive directory delete (rd /s) detected')
  if (/\bInvoke-Expression\b|\biex\s/i.test(text)) reasons.push('dynamic code execution via Invoke-Expression detected')
  return reasons
}

export function isIrreversibleShellCommand(command) {
  return irreversibleShellReasons(String(command || '').trim())
}

export function isDangerousShellCommand(command) {
  const text = String(command || '').trim()
  // 路径范围检查：workspace 档（统一策略）或旧 execSandbox 开关启用时才做。
  // full / 默认状态不限制范围。
  if (!shellRestrictedToWorkspace()) return []
  const reasons = []
  if (/(^|[\s"'`])\.\.([\\/]|$)/.test(text)) reasons.push('command references a parent directory')
  if (/(^|[\s"'`])[a-z]:[\\/]/i.test(text) || /(^|[\s"'`])[\\/]{2}[^\\/]/.test(text)) reasons.push('command references an absolute filesystem path')
  if (/(^|[\s"'`])~([\\/]|$)/.test(text) || /\$(home|env:userprofile)\b/i.test(text) || /%userprofile%/i.test(text)) reasons.push('command references the user home directory')
  return [...reasons, ...irreversibleShellReasons(text)]
}

// 「完全权限」不等于「危险操作不用问」——这句话现在只对「只读 / 工作区」档位成立。
// 完全权限档下（2026-09-27 用户要求）除了「设置里被明确禁用的工具」，其余一律直接
// 放行、不弹卡；下面这几类改的不是这一次的结果，而是「爱丽丝以后还能做什么」——
// 装软件、动工具集、改自己的权限档、写接口凭据、把权限转授给别的 Agent、
// 结束别人的进程。在只读 / 工作区档位下它们仍然先弹审批卡。
const ALWAYS_CONFIRM_REASONS = {
  install_software: 'installing software on this machine changes the system outside the conversation',
  install_tool: 'this changes what the Agent can call from now on',
  uninstall_tool: 'this changes what the Agent can call from now on',
  manage_tool_factory: 'this changes what the Agent can call from now on',
  set_security: "this changes the Agent's own permission preset, not just one call",
  create_worktree: 'this creates a new directory and a new branch in the repository',
  checkout_worktree: 'this moves branches in the repository and removes the isolated worktree',
  manage_api_capability: 'this changes a stored API capability or credential',
  grant_agent_delegation: 'this grants another agent authority to act on your behalf',
  kill_process: 'killing a process interrupts work that may still be running',
}
const ALWAYS_CONFIRM_TOOLS = new Set(Object.keys(ALWAYS_CONFIRM_REASONS))

// 子代理自身的管理/委派类工具：子代理一律不得调用（防递归与提权）。
// workflow 也在这里：子代理不该再自己拉一支扇出队伍。
const SUBAGENT_CONTROL_TOOLS = new Set([
  'run_subagent',
  'spawn_subagent',
  'subagent_message',
  'subagent_interrupt',
  'subagent_list',
  'workflow',
  // 状态查询本身不改任何东西，但它读的是**别的**工作流的运行记录。子代理既不
  // 该拉队伍，也不该去翻主 Agent 的运行清单——一并挡在递归闸门里。
  'workflow_status',
  'delegate_to_agent',
  'grant_agent_delegation',
])

// 目标上「必须有人开口」的动作（阶段 3.1）。与 goal-manager 里的
// HUMAN_ONLY_ACTIONS 同义：这里是工具面的一道闸，管理器里还有一道语义检查。
const GOAL_HUMAN_ONLY_ACTIONS = new Set(['edit', 'pause', 'resume'])
// 计划模式自己的两个工具（阶段 3.3）不属于「改变世界」，不进上面的闸门；
// 它们的权限问题在各自执行体里管（进入要用户开口、退出要用户批准）。
const PLAN_MODE_TOOLS = new Set(['enter_plan_mode', 'exit_plan_mode'])

export function evaluateToolPolicy(name, args = {}, context = {}) {
  const risk = classifyTool(name)
  const currentUserMessage = context.currentUserMessage || ''
  const blockedTools = config.security?.blockedTools || []
  const canonicalName = ['fetch_url', 'browser_read'].includes(name)
    ? 'web_read'
    : ['run_command', 'exec_command', 'exec_quick_command', 'exec_task_command', 'exec_background_command'].includes(name)
      ? 'run_command'
      : name
  if (blockedTools.includes(canonicalName)) {
    // 设置里被明确禁用的工具：任何档位都不放行。完全权限档下连卡也不弹
    // （noApproval），直接按拒绝处理——档位的语义就是「不要再问我」。
    // 只读档同样不弹卡：否则一张「允许一次」就能绕过只读，档位等于失效。
    return {
      allowed: false,
      risk,
      noApproval: isFullAccessMode() || isReadonlyMode(),
      reason: `工具 "${name}" 已被安全策略禁用`,
    }
  }
  // 只读档（统一策略，A9）：写入 / 命令执行 / 安装 / 授权变异类一律硬拒。
  // 这是模式自身的强制力，不依赖 blockedTools 组合是否完整——noApproval 不弹卡。
  if (isReadonlyMode() && isToolDisabledInReadonly(name)) {
    return {
      allowed: false,
      risk,
      noApproval: true,
      reason: '当前为只读模式：写入、命令执行、安装、下载、授权类操作已被禁用',
    }
  }
  // 子代理递归闸门（阶段 1）：子代理不得再派子代理，也不得走外部 Agent 委派。
  // 放在完全权限档之前——「不限制范围」不等于「允许无限自我复制」。
  if (context.subagent === true && SUBAGENT_CONTROL_TOOLS.has(name)) {
    return {
      allowed: false,
      risk,
      noApproval: true,
      reason: 'a sub-agent cannot create or drive further sub-agents (recursive delegation is disabled)',
    }
  }
  // 目标自授权闸门（阶段 3.1）：这三件事都是「改方向 / 改要不要继续」，自主轮里
  // 必须由人开口。resume 尤其如此——那是再次授权自动推进，自己给自己续命等于
  // 没有预算上限。complete / blocked / note 不在其列，它们正是自主轮该做的收尾。
  // 同样放在完全权限档之前：档位说的是「文件范围不设限」，不是「可以自己续命」。
  if (
    context.autonomous === true
    && (name === 'create_goal'
      || (name === 'update_goal' && GOAL_HUMAN_ONLY_ACTIONS.has(String(args.action || '').trim().toLowerCase())))
  ) {
    return {
      allowed: false,
      risk,
      reason: name === 'create_goal'
        ? 'creating a goal requires a direct user request; an autonomous turn cannot commit itself to a new long-running objective'
        : `update_goal action=${args.action} changes the objective or whether it continues, so it requires a direct user request`,
    }
  }
  // 计划模式闸门（阶段 3.3）：计划模式的一切价值就在这一条上——「先给方案，别动手」
  // 必须是硬约束，而不是提示里的一句建议。会改变世界的工具在此一律硬拒。
  // 位置很重要：放在完全权限档**之前**。档位说的是「文件范围不设限」，
  // 不是「可以无视用户要求的计划先行」。
  // blocked 的判定复用只读档的硬禁清单 + 计划模式自己的白名单/点名表，
  // 保证「什么算改变世界」只有一份事实（见 runtime/plan-mode.js）。
  if (isPlanMode() && !PLAN_MODE_TOOLS.has(name) && isToolBlockedInPlanMode(name, {
    readonlyBlocked: isToolDisabledInReadonly,
    riskOf: classifyTool,
  })) {
    return {
      allowed: false,
      risk,
      noApproval: true,
      reason: `计划模式已开启：${name} 会改变实际状态，因此本次不可用。先探索、先提问，然后用 exit_plan_mode 提交计划，等用户批准。`,
    }
  }
  // 完全权限档（2026-09-27 用户要求）：用户既然显式选了「完全权限」，除了上面那类
  // 「自己在设置里禁掉的工具」，其余闸门一律直接放行，不再弹审批卡。
  // 其他档位维持原样，照旧弹卡。
  if (isFullAccessMode()) {
    return { allowed: true, risk, reason: '' }
  }
  if (name === 'system_browser_open' && !isSystemBrowserRequest(currentUserMessage)) {
    return {
      allowed: false,
      risk,
      reason: 'opening the computer default browser requires an explicit current user request for the system/default browser',
    }
  }
  if (
    name === 'system_music'
    && String(args.action || 'status').toLowerCase() !== 'status'
    && !SYSTEM_MUSIC_ACTION_INTENT_RE.test(currentUserMessage)
  ) {
    return {
      allowed: false,
      risk,
      reason: 'changing Music.app playback requires an explicit current user music-control request',
    }
  }
  if (name === 'browser_close' && explicitlyKeepsBrowserOpen(currentUserMessage)) {
    return {
      allowed: false,
      risk,
      reason: 'the current user explicitly asked to keep the browser/page open or explicitly rejected closing it',
    }
  }
  if (isLocalFileToolCallBlocked(name, args, currentUserMessage)) {
    return {
      allowed: false,
      risk,
      reason: 'this turn is explicitly limited to browser/remote-web evidence; local filesystem fallback is not authorized',
    }
  }
  if (
    name === 'browser_clear_data'
    && !isExplicitAgentBrowserDataDeletionRequest(currentUserMessage)
  ) {
    return {
      allowed: false,
      risk,
      reason: 'clearing persistent browser data requires an explicit current user request naming Alice/Agent built-in browser data',
    }
  }
  const startupBrowserCheck = context.autonomous
    && context.startupSelfCheck?.active === true
    && STARTUP_SELF_CHECK_BROWSER_TOOLS.has(name)
    && getMcpToolMetadata(name)?.builtIn === true
    && getMcpToolMetadata(name)?.chromeDevtools === true
  if (context.autonomous && isMcpTool(name) && !context.allowHighRiskAutonomy && !isFullAccessMode() && !startupBrowserCheck) {
    const mcpTool = getMcpToolMetadata(name)
    const explicitlyAllowed = mcpTool?.allowAutonomousReadOnly === true
      && mcpTool?.annotations?.readOnlyHint === true
      && mcpTool?.annotations?.destructiveHint !== true
    if (!explicitlyAllowed) {
      return {
        allowed: false,
        risk,
        reason: 'MCP tools are disabled for autonomous Tick/scheduled work unless this server explicitly allows annotated read-only tools',
      }
    }
  }
  if (['run_command', 'exec_command', 'exec_quick_command', 'exec_task_command', 'exec_background_command'].includes(name)) {
    const reasons = isDangerousShellCommand(args.command || args.cmd || '')
    if (reasons.length) return { allowed: false, risk, reason: reasons.join('; ') }
  }
  // 完全权限档下 isDangerousShellCommand 会提前返回空数组，所以这里再单独补一层
  // 「不可逆命令」判定：递归删除 / 格盘或关机 / 改写 git 工作区历史 / 动态执行代码。
  // 这几条不随权限档位豁免——它们不是「范围」问题，是「这次做完就回不来了」。
  // 例外只有显式的 allowHighRiskAutonomy（runtime 对某一轮的明确高危授权）。
  const irreversible = isIrreversibleShellCommand(args.command || args.cmd || '')
  if (irreversible.length && !context.allowHighRiskAutonomy) {
    return { allowed: false, risk, reason: irreversible.join('; ') }
  }
  // 改变「以后还能做什么」的工具：任何档位都先弹审批卡。用户点「允许一次」只放行
  // 这一次调用，权限档位本身不变（set_security 是唯一例外，它的卡会明说这一点）。
  if (ALWAYS_CONFIRM_TOOLS.has(name) && !context.allowHighRiskAutonomy) {
    return { allowed: false, risk, reason: ALWAYS_CONFIRM_REASONS[name] }
  }
  if (
    context.autonomous
    && name === 'manage_rule'
    && String(args.action || 'list').trim().toLowerCase() !== 'list'
    && !context.allowHighRiskAutonomy && !isFullAccessMode()
  ) {
    return { allowed: false, risk, reason: 'autonomous Tick may inspect rules, but changing persistent rules requires an explicit user-driven context' }
  }
  if (context.autonomous && AUTONOMOUS_USER_AUTH_REQUIRED.has(name) && !context.allowHighRiskAutonomy && !isFullAccessMode() && !startupBrowserCheck) {
    return { allowed: false, risk, reason: 'this authority-changing, destructive, or unbudgeted tool requires an explicit user-driven context' }
  }
  return { allowed: true, risk, reason: '' }
}
