// 统一沙箱策略（A9，对齐 DSH dsh-sandbox-policy）。
//
// 这是 fs / shell 等所有受限能力消费的【唯一策略归属】：
//   readonly  —— 只读：写入 / 命令执行 / 安装 / 授权变异类一律硬拒（不弹卡）
//   workspace —— 工作区：文件读写与命令都限制在 sandbox/ 工作区内
//   full      —— 完全权限：不限制文件范围（不可逆命令、授权变异闸门照旧）
//
// 与旧开关的关系：fileSandbox / execSandbox / blockedTools 仍保留，用于
// 「自定义」组合；三档预设的强制力不再只靠它们的组合，模式自身即可兜底——
// 即使配置升级或设置页保存时漏掉了 blockedTools，readonly 的硬限制也不会丢。

import { config, getAccessMode } from '../config.js'
import { SANDBOX_ROOT } from './sandbox.js'

export const SANDBOX_MODE = Object.freeze({
  READONLY: 'readonly',
  WORKSPACE: 'workspace',
  FULL: 'full',
})
export const SANDBOX_MODES = Object.freeze(['readonly', 'workspace', 'full'])

// 爱丽丝 Chrome 浏览器变异家族（与 config.js / app.js 同一份清单）。
const CHROME_BROWSER_FAMILY = Object.freeze([
  'browser_navigate',
  'browser_navigate_back',
  'browser_navigate_forward',
  'browser_reload',
  'browser_snapshot',
  'browser_find',
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
  'browser_take_screenshot',
  'browser_console_messages',
  'browser_resize',
  'browser_close',
])

// 只读档硬禁的工具【组名】（与 composer 下拉的 READONLY_BLOCKED 完全一致）。
// 前后端选档时都写这一份，保证 UI 与实际闸门始终同一事实。
export const READONLY_DISABLED_GROUPS = Object.freeze([
  'run_command',
  'write_file',
  'edit_file',
  'delete_file',
  'make_dir',
  'install_software',
  'install_tool',
  'uninstall_tool',
  'manage_tool_factory',
  'kill_process',
  'download_file',
  'grant_agent_delegation',
  'delegate_to_agent',
  'manage_api_capability',
  'set_security',
  'chrome_devtools_browser',
])

// 组名 → 实际工具名（含 shell 别名与浏览器家族），用于模式自身的硬拒判定。
const READONLY_DISABLED_TOOLS = new Set([
  'exec_command',
  'exec_quick_command',
  'exec_task_command',
  'exec_background_command',
  ...READONLY_DISABLED_GROUPS.filter(name => name !== 'chrome_devtools_browser'),
  ...CHROME_BROWSER_FAMILY,
])

/**
 * 当前生效的沙箱模式。
 * 显式档位优先；未显式选择时按旧闸门反推；反推不出（custom）→ 'full'，
 * 与爱丽丝「默认不限制范围」的历史行为保持一致，避免升级后误伤现有用法。
 * @returns {'readonly'|'workspace'|'full'}
 */
export function getSandboxMode() {
  const explicit = config.security?.accessMode
  if (explicit === 'readonly' || explicit === 'workspace' || explicit === 'full') {
    return explicit
  }
  const inferred = getAccessMode() // 'readonly' | 'workspace' | 'custom'
  return inferred === 'custom' ? SANDBOX_MODE.FULL : inferred
}

export function isReadonlyMode() {
  return getSandboxMode() === SANDBOX_MODE.READONLY
}

export function isWorkspaceMode() {
  return getSandboxMode() === SANDBOX_MODE.WORKSPACE
}

export function isFullAccessMode() {
  return getSandboxMode() === SANDBOX_MODE.FULL
}

// 文件操作是否被限制在工作区内（workspace 档或旧 fileSandbox 开关）。
export function fileRestrictedToWorkspace() {
  return config.security?.fileSandbox === true || isWorkspaceMode()
}

// 命令执行是否被限制在工作区内（workspace 档或旧 execSandbox 开关）。
export function shellRestrictedToWorkspace() {
  return config.security?.execSandbox === true || isWorkspaceMode()
}

export function isToolDisabledInReadonly(name) {
  return READONLY_DISABLED_TOOLS.has(String(name || ''))
}

/**
 * 预设档位 → 闸门组合。setSecurity 与前端下拉共用，保证选档即联动。
 * @returns {{blockedTools: string[], fileSandbox: boolean, execSandbox: boolean}}
 */
export function presetSecurityPatch(mode) {
  if (mode === SANDBOX_MODE.READONLY) {
    return {
      blockedTools: [...READONLY_DISABLED_GROUPS],
      fileSandbox: false,
      execSandbox: true,
    }
  }
  if (mode === SANDBOX_MODE.WORKSPACE) {
    return { blockedTools: [], fileSandbox: true, execSandbox: true }
  }
  return { blockedTools: [], fileSandbox: false, execSandbox: false }
}

const MODE_POLICY_TEXT = Object.freeze({
  readonly: [
    'mode: READ_ONLY',
    '- Write/edit/delete/mkdir, command execution, software installation, downloads, and authority-granting tools are HARD DISABLED.',
    '- Reading and listing files, memory, search, and UI display tools remain available.',
    '- If the user asks for a blocked operation, do not retry it; explain read-only mode and offer to switch in Settings.',
  ].join('\n'),
  workspace: [
    'mode: WORKSPACE_WRITE',
    '- File tools and commands are confined to the workspace root below.',
    '- Reads/writes outside it, absolute paths, parent traversal, and home-directory references are blocked.',
    '- If a request needs outside access, explain the boundary instead of probing repeatedly; the mode can be changed in Settings.',
  ].join('\n'),
  full: [
    'mode: FULL_ACCESS',
    '- No workspace path boundary: file tools and commands may target the whole filesystem when the request calls for it.',
    '- Irreversible commands (recursive delete, format/shutdown, rewriting git worktree history, dynamic code) and authority-changing tools still require confirmation.',
  ].join('\n'),
})

/**
 * 从任意一份 security 快照推出档位（与 config.getAccessMode 同一套反推规则）。
 * 供「调用方传了自己那份 security」的场景使用——不能去读全局 config，
 * 否则渲染出来的状态和实际传入的设置会不一致。
 */
export function resolveSandboxModeFor(security) {
  const explicit = security?.accessMode
  if (SANDBOX_MODES.includes(explicit)) return explicit
  const blocked = Array.isArray(security?.blockedTools) ? security.blockedTools : []
  const fileSandbox = security?.fileSandbox === true
  const execSandbox = security?.execSandbox === true
  if (blocked.length === 0 && fileSandbox && execSandbox) return SANDBOX_MODE.WORKSPACE
  if (blocked.length > 0 && execSandbox && !fileSandbox) return SANDBOX_MODE.READONLY
  return SANDBOX_MODE.FULL
}

/**
 * 渲染给模型的沙箱策略声明（每轮系统提示中注入）。
 * 对齐 DSH：模型在开口前就知道当前模式与边界，不会反复尝试被禁操作。
 *
 * @param {object|null} security 调用方的 security 快照；不给则读全局 config。
 * @param {string|null} now 兼容旧签名的占位参数（历史调用会多传一个时间）。
 */
export function formatSandboxPolicyForPrompt(security = null, now = null) {
  const effective = security && typeof security === 'object' ? security : (config.security || {})
  const mode = security && typeof security === 'object'
    ? resolveSandboxModeFor(effective)
    : getSandboxMode()

  const lines = [
    'Sandbox Status:',
    MODE_POLICY_TEXT[mode],
    `- workspace_root: ${SANDBOX_ROOT}`,
    // 保留逐闸门的字面状态：设置页、测试与既有提示词契约都依赖这两行。
    `- file_sandbox: ${effective.fileSandbox === true ? 'ENABLED' : 'DISABLED'}`,
    `- exec_sandbox: ${effective.execSandbox === true ? 'ENABLED' : 'DISABLED'}`,
  ]

  // 自定义组合：显式档位为空但旧闸门被手动改过，把工具屏蔽量补充清楚。
  if (!SANDBOX_MODES.includes(effective.accessMode)) {
    const blocked = Array.isArray(effective.blockedTools) ? effective.blockedTools : []
    lines.push(`- custom gates: blocked_tools=${blocked.length}`)
  }

  const changedAt = effective.updatedAt
  lines.push(changedAt
    ? `- changed_at: ${changedAt}`
    : '- changed_at: legacy setting; exact change time was not recorded')
  return lines.join('\n')
}

// 供工具/测试引用，避免重复维护。
export { SANDBOX_ROOT, CHROME_BROWSER_FAMILY }
