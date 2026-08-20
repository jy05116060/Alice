import assert from 'assert'
import fs from 'fs'
import os from 'os'
import path from 'path'
import { config, getSecurity, setSecurity } from './config.js'
import {
  SANDBOX_MODE,
  SANDBOX_MODES,
  SANDBOX_ROOT,
  READONLY_DISABLED_GROUPS,
  getSandboxMode,
  isReadonlyMode,
  isWorkspaceMode,
  isFullAccessMode,
  isToolDisabledInReadonly,
  fileRestrictedToWorkspace,
  shellRestrictedToWorkspace,
  presetSecurityPatch,
  formatSandboxPolicyForPrompt,
} from './capabilities/sandbox-policy.js'
import {
  evaluateToolPolicy,
  isDangerousShellCommand,
} from './capabilities/tool-policy.js'
import { assertInSandbox } from './capabilities/sandbox.js'

// 统一沙箱策略（A9）纯 Node 测试。setSecurity 会落盘 config.json，
// 所以测试开始保存原始状态，结束时【完整恢复】。
const original = {
  explicit: config.security.accessMode,
  security: getSecurity(),
}

function applyMode(mode) {
  const patch = presetSecurityPatch(mode)
  setSecurity({ ...patch, accessMode: mode })
}

try {
  // ── 1. 模式常量与预设组合 ────────────────────────────────────────────────
  assert.deepEqual(SANDBOX_MODES, ['readonly', 'workspace', 'full'])
  assert.deepEqual(presetSecurityPatch('full'),
    { blockedTools: [], fileSandbox: false, execSandbox: false })
  assert.deepEqual(presetSecurityPatch('workspace'),
    { blockedTools: [], fileSandbox: true, execSandbox: true })
  const readonlyPatch = presetSecurityPatch('readonly')
  assert.equal(readonlyPatch.fileSandbox, false)
  assert.equal(readonlyPatch.execSandbox, true)
  assert.ok(readonlyPatch.blockedTools.includes('write_file'))
  assert.ok(readonlyPatch.blockedTools.includes('chrome_devtools_browser'))
  assert.deepEqual([...readonlyPatch.blockedTools], [...READONLY_DISABLED_GROUPS])

  // ── 2. 只读档：变异类硬拒（noApproval 不弹卡），只读类放行 ───────────────
  applyMode(SANDBOX_MODE.READONLY)
  assert.equal(getSandboxMode(), 'readonly')
  assert.equal(isReadonlyMode(), true)
  assert.equal(isWorkspaceMode(), false)
  assert.equal(isFullAccessMode(), false)

  for (const name of [
    'write_file', 'edit_file', 'delete_file', 'make_dir',
    'run_command', 'exec_command', 'exec_quick_command', 'exec_task_command', 'exec_background_command',
    'install_software', 'install_tool', 'uninstall_tool', 'manage_tool_factory',
    'kill_process', 'download_file',
    'grant_agent_delegation', 'delegate_to_agent',
    'manage_api_capability', 'set_security',
    'browser_navigate', 'browser_click', 'browser_type', 'browser_close',
  ]) {
    assert.equal(isToolDisabledInReadonly(name), true, `${name} should be disabled in readonly`)
    const policy = evaluateToolPolicy(name, { command: 'ls', path: 'x' }, {})
    assert.equal(policy.allowed, false, `${name} must be blocked in readonly`)
    assert.equal(policy.noApproval, true, `${name} block must not spawn an approval card`)
  }

  // 只读类 / 非变异类仍然可用
  for (const name of ['read_file', 'list_dir', 'search_memory', 'send_message', 'find_tool', 'media_mode']) {
    assert.equal(isToolDisabledInReadonly(name), false, `${name} should remain available in readonly`)
  }
  assert.equal(evaluateToolPolicy('read_file', { path: '.' }, {}).allowed, true,
    'read_file stays allowed in readonly')
  assert.equal(evaluateToolPolicy('list_dir', { path: '.' }, {}).allowed, true,
    'list_dir stays allowed in readonly')

  // 即使 blockedTools 组合丢失（模拟设置页误覆盖），模式自身仍兜底硬拒
  config.security.blockedTools = []
  assert.equal(evaluateToolPolicy('write_file', { path: 'x', content: 'a' }, {}).allowed, false,
    'readonly must keep blocking writes even when blockedTools was emptied')

  // ── 3. 工作区档：路径与命令限制在 sandbox 内 ─────────────────────────────
  applyMode(SANDBOX_MODE.WORKSPACE)
  assert.equal(getSandboxMode(), 'workspace')
  assert.equal(fileRestrictedToWorkspace(), true)
  assert.equal(shellRestrictedToWorkspace(), true)

  // 工作区内路径放行；工作区外拒绝
  const insideFile = path.join(SANDBOX_ROOT, '__sandbox_policy_probe.tmp')
  fs.writeFileSync(insideFile, 'ok')
  try {
    assert.doesNotThrow(() => assertInSandbox(path.resolve(insideFile)),
      'paths inside workspace should be accepted')
  } finally {
    fs.rmSync(insideFile, { force: true })
  }
  const outsideFile = path.join(os.tmpdir(), '__blm_sandbox_policy_probe.tmp')
  assert.throws(() => assertInSandbox(path.resolve(outsideFile)),
    /sandbox|工作区|拒绝/,
    'paths outside workspace should be rejected')

  // 命令范围：上级目录引用被标记；普通命令不标记
  assert.ok(isDangerousShellCommand('Get-ChildItem ..').length > 0,
    'parent-directory command should be flagged in workspace')
  assert.ok(isDangerousShellCommand('Get-ChildItem C:\\Windows').length > 0,
    'absolute-path command should be flagged in workspace')
  assert.equal(isDangerousShellCommand('Get-ChildItem').length, 0,
    'in-workspace command without path escape should not be flagged')

  // ── 4. 完全权限档：范围不限（显式档位，闸门全放开）───────────────────────
  applyMode(SANDBOX_MODE.FULL)
  assert.equal(getSandboxMode(), 'full')
  assert.equal(isFullAccessMode(), true)
  assert.equal(fileRestrictedToWorkspace(), false)
  assert.equal(shellRestrictedToWorkspace(), false)
  assert.equal(isDangerousShellCommand('Get-ChildItem ..').length, 0,
    'full mode should not apply workspace path gates')
  assert.doesNotThrow(() => assertInSandbox(path.resolve(outsideFile)),
    'full mode should accept paths outside the workspace')
  assert.equal(evaluateToolPolicy('write_file', { path: 'x', content: 'a' }, {}).allowed, true,
    'explicit full mode allows write tools directly')

  // ── 5. 旧闸门反推（显式档位为空的自定义组合）─────────────────────────────
  config.security.accessMode = ''
  // workspace 组合反推
  setSecurity({ blockedTools: [], fileSandbox: true, execSandbox: true })
  assert.equal(getSandboxMode(), 'workspace', 'sandbox gates should infer workspace mode')
  assert.equal(fileRestrictedToWorkspace(), true)
  assert.equal(shellRestrictedToWorkspace(), true)
  // 默认/未知组合反推为 full（=历史默认行为：范围不限）
  setSecurity({ blockedTools: [], fileSandbox: false, execSandbox: false })
  assert.equal(getSandboxMode(), 'full', 'ungated custom state should behave as full for range')
  // 反推出的 full 不等同显式 full：意图守卫仍在（system_browser 仍需明确用户请求）
  assert.equal(
    evaluateToolPolicy('system_browser_open', { url: 'https://x.com' }, { currentUserMessage: '' }).allowed,
    false,
    'inferred-full default state must keep intent guards (explicit full only bypasses)')

  // readonly 组合反推
  setSecurity({ blockedTools: ['write_file'], fileSandbox: false, execSandbox: true })
  assert.equal(getSandboxMode(), 'readonly', 'readonly gates should infer readonly mode')

  // ── 6. 模型可见声明 ──────────────────────────────────────────────────────
  applyMode(SANDBOX_MODE.READONLY)
  const readonlyText = formatSandboxPolicyForPrompt()
  assert.ok(readonlyText.includes('READ_ONLY'))
  assert.ok(readonlyText.includes(SANDBOX_ROOT))
  applyMode(SANDBOX_MODE.WORKSPACE)
  assert.ok(formatSandboxPolicyForPrompt().includes('WORKSPACE_WRITE'))
  applyMode(SANDBOX_MODE.FULL)
  assert.ok(formatSandboxPolicyForPrompt().includes('FULL_ACCESS'))

  console.log('test-sandbox-policy: all assertions passed')
} finally {
  // ── 完整恢复原始安全状态并落盘 ───────────────────────────────────────────
  const { fileSandbox, execSandbox, blockedTools } = original.security
  const explicit = original.explicit
  if (explicit === 'full' || explicit === 'workspace' || explicit === 'readonly') {
    setSecurity({ fileSandbox, execSandbox, blockedTools, accessMode: explicit })
  } else {
    setSecurity({ fileSandbox, execSandbox, blockedTools })
    config.security.accessMode = explicit // 通常为 '' 或 'custom'
    setSecurity({}) // patchConfig 无条件落盘，恢复显式档位字段
  }
  assert.equal(getSandboxMode(),
    explicit === 'full' || explicit === 'workspace' || explicit === 'readonly'
      ? explicit
      : getSandboxMode(),
    'sandbox mode restored after test')
}
