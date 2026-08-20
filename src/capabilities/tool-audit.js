import { insertActionLog } from '../db.js'
import { emitEvent } from '../events.js'
import { classifyTool } from './tool-policy.js'
import { previewValue, safeJsonStringify } from './tool-utils.js'

function getExecutionSource(context = {}) {
  return context.source || context.trigger || (context.autonomous ? 'autonomous' : 'llm')
}
export function summarizeToolExecution(name, args = {}) {
  switch (name) {
    case 'read_file':
      return `read_file(${args.path || args.filename || args.file_path || '?'})`
    case 'list_dir':
      return `list_dir(${args.path || args.dir || args.directory || '.'})`
    case 'write_file':
      return `write_file(${args.path || args.filename || args.file_path || '?'})`
    case 'edit_file':
      return `edit_file(${args.path || args.filename || args.file_path || '?'}, ${args.operation || 'replace'})`
    case 'delete_file':
      return `delete_file(${args.path || args.filename || args.file_path || '?'})`
    case 'make_dir':
      return `make_dir(${args.path || args.dir || args.directory || '?'})`
    case 'run_command':
    case 'exec_command':
      return `${name}(${String(args.command || args.cmd || '?').slice(0, 100)})`
    case 'install_software':
      return `install_software(${String(args.query || args.package_id || args.job_id || '?').slice(0, 100)})`
    case 'web_read':
    case 'fetch_url':
    case 'browser_read':
      return `${name}(${String(args.url || args.link || args.href || '?').slice(0, 120)})`
    case 'web_search':
      return `web_search(${String(args.query || args.q || args.keyword || '?').slice(0, 120)})`
    case 'browser_navigate':
      return `browser_navigate(${String(args.url || '?').slice(0, 120)})`
    case 'browser_navigate_forward':
    case 'browser_reload':
      return `${name}()`
    case 'browser_tabs':
      return `browser_tabs(action=${String(args.action || '?').slice(0, 30)})`
    case 'browser_type':
      return `browser_type(target=${String(args.target || args.element || '?').slice(0, 100)})`
    case 'browser_fill_form':
      return `browser_fill_form(fields=${Array.isArray(args.fields) ? args.fields.length : 0})`
    case 'browser_find':
      return `browser_find(${String(args.text || args.regex || '?').slice(0, 100)})`
    case 'browser_take_screenshot':
      return `browser_take_screenshot(${String(args.filename || '?').slice(0, 120)})`
    case 'browser_set_display_mode':
      return `browser_set_display_mode(${args.mode === 'window' ? 'window' : 'card'})`
    case 'browser_clear_data':
      return `browser_clear_data(${(Array.isArray(args.data_types) ? args.data_types : []).join('+') || '?'}, ${args.time_range || '?'})`
    case 'system_browser_open':
      return `system_browser_open(${String(args.url || '?').slice(0, 120)})`
    case 'system_music':
      return `system_music(${String(args.action || 'status').slice(0, 30)})`
    case 'workflow':
      // 脚本正文绝不进 action_log（可能几千字）：只记这次是不是后台形态 + 工作流名。
      return `workflow(${String(args.meta?.name || '?').slice(0, 60)}${args.run_in_background === true ? ', background' : ''})`
    case 'workflow_status':
      return args.run_id
        ? `workflow_status(${String(args.action || 'status').slice(0, 20)}, ${String(args.run_id).slice(0, 60)})`
        : `workflow_status(${String(args.action || 'list').slice(0, 20)})`
    case 'send_message':
    case 'express':
      return `${name} -> ${args.target_id || '(unknown)'}`
    case 'upsert_memory': {
      const count = Array.isArray(args.memories) ? args.memories.length : 0
      return `upsert_memory(${count})`
    }
    default:
      return name
  }
}

const SENSITIVE_ARG_KEY_RE = /(?:api[_-]?key|apikey|access[_-]?key|secret|token|password|authorization|bearer)/i
const SECRET_VALUE_RE = /\b(?:sk|ak|rk|pk)-[A-Za-z0-9_\-.]{12,180}\b/g

function redactAuditValue(value) {
  if (typeof value === 'string') return value.replace(SECRET_VALUE_RE, '[redacted]')
  if (Array.isArray(value)) return value.map(redactAuditValue)
  if (!value || typeof value !== 'object') return value
  const out = {}
  for (const [key, item] of Object.entries(value)) {
    out[key] = SENSITIVE_ARG_KEY_RE.test(key) ? '[redacted]' : redactAuditValue(item)
  }
  return out
}

function sanitizeBrowserAuditUrl(value) {
  try {
    const parsed = new URL(String(value || ''))
    parsed.username = ''
    parsed.password = ''
    parsed.search = ''
    parsed.hash = ''
    return parsed.href.slice(0, 240)
  } catch {
    return '[redacted-invalid-url]'
  }
}

export function sanitizeToolAuditArgs(name, args = {}) {
  const redacted = redactAuditValue(args)
  if (!redacted || typeof redacted !== 'object') return redacted
  if (
    (name.startsWith('browser_') || name === 'system_browser_open')
    && Object.prototype.hasOwnProperty.call(redacted, 'url')
  ) {
    redacted.url = sanitizeBrowserAuditUrl(redacted.url)
  }
  const safe = { ...redacted }
  // Typed/form text can be a password, token, personal data, or arbitrary
  // prose. It must never reach args_json/detail under generic keys.
  if (name === 'browser_type' && Object.prototype.hasOwnProperty.call(safe, 'text')) {
    safe.text = '[redacted]'
  }
  if (name === 'browser_fill_form' && Array.isArray(safe.fields)) {
    safe.fields = safe.fields.map(field => {
      if (!field || typeof field !== 'object') return field
      return {
        ...field,
        ...(Object.prototype.hasOwnProperty.call(field, 'value') ? { value: '[redacted]' } : {}),
      }
    })
  }
  // 工作流的 script 是整段代码（可能是几千字），args_json 列只留 2000 字符，
  // 完整塞进去既没用又会把真正有信息量的字段挤掉（args / meta）。落库只留一行摘要。
  if (name === 'workflow' && Object.prototype.hasOwnProperty.call(safe, 'script')) {
    safe.script = '[omitted: workflow script]'
  }
  return safe
}

const SENSITIVE_BROWSER_INPUT_TOOLS = new Set(['browser_type', 'browser_fill_form'])

function safeResultPreview(name, result, error) {
  if (!SENSITIVE_BROWSER_INPUT_TOOLS.has(name)) return previewValue(result || error, 220)
  return error ? 'browser input failed' : 'browser input completed'
}

export function inferToolStatus(result) {
  const text = String(result ?? '').trim()
  if (!text) return 'ok'
  try {
    const parsed = JSON.parse(text)
    return parsed?.ok === false ? 'error' : 'ok'
  } catch {}
  return /^(错误|请求失败|执行失败|命令超时|命令执行失败|閿欒|璇锋眰澶辫触|鎵ц澶辫触|鍛戒护瓒呮椂|鍛戒护鎵ц澶辫触)/.test(text) ? 'error' : 'ok'
}

export function writeToolAuditLog({ name, args, context, policy, status, result = '', error = '', startedAt }) {
  const record = buildToolAuditRecord({ name, args, context, policy, status, result, error, startedAt })

  try {
    insertActionLog(record)
  } catch (err) {
    console.warn(`[audit] failed to persist tool audit log: ${err.message}`)
  }

  emitEvent('tool_audit', {
    tool: name,
    status,
    risk: policy?.risk || classifyTool(name),
    summary: record.summary,
    duration_ms: record.durationMs,
    source: record.source,
  })
}

export function buildToolAuditRecord({ name, args, context, policy, status, result = '', error = '', startedAt }) {
  const durationMs = Date.now() - startedAt
  const detailParts = []
  if (policy?.reason) detailParts.push(`policy=${policy.reason}`)
  const auditArgs = sanitizeToolAuditArgs(name, args)
  const argPreview = previewValue(auditArgs, 160)
  if (argPreview && argPreview !== '{}') detailParts.push(`args=${argPreview}`)
  const resultPreview = safeResultPreview(name, result, error)
  if (resultPreview) detailParts.push(`result=${resultPreview}`)

  return {
      timestamp: new Date(startedAt).toISOString(),
      tool: name,
      summary: summarizeToolExecution(name, auditArgs),
      detail: detailParts.join(' | '),
      status,
      risk: policy?.risk || classifyTool(name),
      argsJson: safeJsonStringify(auditArgs),
      resultPreview,
      error: SENSITIVE_BROWSER_INPUT_TOOLS.has(name) && error ? 'browser input failed' : error,
      durationMs,
      source: getExecutionSource(context),
  }
}
