import fs from 'fs'
import { paths } from '../paths.js'
import { deleteSecret, getSecret, hasSecret, setSecret } from './secret-store.js'

export const KIMI_VISION_SLOT_ID = 'vision.kimi'

const SLOT_FILE_VERSION = 2
const DEFAULT_PROVIDER = 'custom'
const DEFAULT_KIMI_VISION_MODEL = 'kimi-k3'
const DEFAULT_KIMI_BASE_URL = 'https://api.moonshot.cn/v1'
const DEFAULT_CHAT_COMPLETIONS_ENDPOINT = '/chat/completions'
const GENERIC_API_CAPABILITY_TOOLS = ['run_capability']
const LEGACY_TOOL_BY_KIND = {
  vision: ['analyze_image'],
}
const VISION_KIND_ALIASES = new Set(['vision', 'image_vision', 'image-vision', 'image', 'visual', 'ocr'])

const DEFAULT_VISION_TRIGGERS = [
  '识图', '看图', '读图', '图片识别', '图像识别', '图片理解', '图里', '图上',
  '这张图', '这幅图', '这张照片', '照片里', '截图里', 'ocr', '视觉',
  'vision', 'image recognition', 'analyze image', 'describe image', 'read image',
]
const VISION_ATTACHMENT_RE = /!\[[^\]]*]\(|\/media\/chat\/|data:image\/|https?:\/\/\S+\.(?:png|jpe?g|webp|gif)|\.(?:png|jpe?g|webp|gif)\b/i
const VISION_INTENT_RE = /识图|看图|读图|图片识别|图像识别|图片理解|图里|图上|这张图|这幅图|这张照片|照片里|截图里|截图中|截图上|截图内容|ocr|vision|image recognition|analyze image|describe image|read image/i

const SECRET_TOKEN_RE = /\b(?:sk|ak|rk|pk|ark)-[A-Za-z0-9_\-.]{12,180}\b/g
const AUTH_TYPES = new Set(['api_key', 'none'])

function nowIso() {
  return new Date().toISOString()
}

function readSlotFile() {
  try {
    const parsed = JSON.parse(fs.readFileSync(paths.apiCapabilitySlotsFile, 'utf-8'))
    const file = Array.isArray(parsed)
      ? { version: 1, slots: parsed }
      : (parsed && typeof parsed === 'object' && Array.isArray(parsed.slots) ? parsed : null)
    if (file) return migrateSlotFileSecrets(file)
  } catch {}
  return { version: SLOT_FILE_VERSION, slots: [] }
}

function writeSlotFile(slots) {
  const tmp = `${paths.apiCapabilitySlotsFile}.tmp`
  fs.writeFileSync(tmp, JSON.stringify({ version: SLOT_FILE_VERSION, slots }, null, 2), 'utf-8')
  fs.renameSync(tmp, paths.apiCapabilitySlotsFile)
}

function normalizeId(value = '') {
  return String(value || '').trim().toLowerCase().replace(/[^a-z0-9_.-]+/g, '-').replace(/^-+|-+$/g, '')
}

function normalizeKind(value = 'vision') {
  const kind = String(value || 'vision').trim().toLowerCase().replace(/[^a-z0-9_-]+/g, '_')
  return VISION_KIND_ALIASES.has(kind) ? 'vision' : kind
}

export function normalizeApiCapabilityKind(value = 'vision') {
  return normalizeKind(value)
}

function normalizeProvider(value = DEFAULT_PROVIDER) {
  return String(value || DEFAULT_PROVIDER).trim().toLowerCase()
}

function defaultSlotId(kind = 'vision', provider = DEFAULT_PROVIDER) {
  return normalizeId(`${normalizeKind(kind)}.${normalizeProvider(provider)}`)
}

function canonicalSlotId({ id = '', kind = 'vision', provider = DEFAULT_PROVIDER } = {}) {
  const explicit = normalizeId(id)
  if (!explicit) return defaultSlotId(kind, provider)

  const parts = explicit.split('.').filter(Boolean)
  if (parts.length === 2) {
    const [first, second] = parts
    if (normalizeKind(first) === 'vision') return defaultSlotId('vision', second)
    if (normalizeKind(second) === 'vision') return defaultSlotId('vision', first)
  }

  return explicit
}

function providerFromSlotId(id = '', kind = 'vision') {
  const explicit = normalizeId(id)
  const parts = explicit.split('.').filter(Boolean)
  if (parts.length !== 2) return ''
  const [first, second] = parts
  const normalizedKind = normalizeKind(kind)
  if (normalizeKind(first) === 'vision') return second
  if (normalizeKind(second) === 'vision') return first
  if (normalizeId(normalizedKind) === first) return second
  return ''
}

function apiCredentialRef(slotId = '') {
  return `api-capability:${normalizeId(slotId)}:apiKey`
}

function rawSlotId(slot = {}) {
  const kind = normalizeKind(slot.kind || 'vision')
  const provider = normalizeProvider(slot.provider || providerFromSlotId(slot.id, kind) || DEFAULT_PROVIDER)
  return canonicalSlotId({ id: slot.id, kind, provider })
}

function isApiKeyPlaceholder(value = '') {
  return String(value || '').trim() === '[configured]'
}

function cleanInlineApiKey(value = '') {
  const text = String(value || '').trim()
  return isApiKeyPlaceholder(text) ? '' : text
}

function normalizeAuthType(value = '', credentialRequired = undefined) {
  const text = String(value || '').trim().toLowerCase().replace(/-/g, '_')
  if (AUTH_TYPES.has(text)) return text
  if (credentialRequired === false) return 'none'
  return 'api_key'
}

function isCredentialRequired(api = {}, slot = {}) {
  const authType = normalizeAuthType(api.authType || api.auth_type || slot.authType || slot.auth_type, api.credentialRequired ?? api.credential_required)
  return authType !== 'none'
}

function migrateSlotFileSecrets(file = {}) {
  const slots = Array.isArray(file.slots) ? file.slots : []
  let changed = Number(file.version || 1) !== SLOT_FILE_VERSION
  const nextSlots = slots.map(slot => {
    if (!slot || typeof slot !== 'object' || Array.isArray(slot)) return slot
    const id = rawSlotId(slot)
    const api = slot.api && typeof slot.api === 'object' && !Array.isArray(slot.api)
      ? { ...slot.api }
      : {}
    const inlineKey = cleanInlineApiKey(api.apiKey)
    const credentialRef = String(api.credentialRef || api.credential_ref || apiCredentialRef(id)).trim()
    const credentialRequired = isCredentialRequired(api, slot)
    const authType = credentialRequired ? 'api_key' : 'none'
    if (inlineKey) {
      try {
        setSecret(credentialRef, inlineKey)
        delete api.apiKey
        changed = true
      } catch (err) {
        console.warn(`[api-slots] failed to migrate API key for ${id}: ${err.message}`)
      }
    } else if (Object.prototype.hasOwnProperty.call(api, 'apiKey')) {
      delete api.apiKey
      changed = true
    }
    if (Object.prototype.hasOwnProperty.call(api, 'credential_ref')) {
      delete api.credential_ref
      changed = true
    }
    if (api.credentialRef !== credentialRef) {
      api.credentialRef = credentialRef
      changed = true
    }
    if (api.authType !== authType) {
      api.authType = authType
      changed = true
    }
    if (Object.prototype.hasOwnProperty.call(api, 'auth_type')) {
      delete api.auth_type
      changed = true
    }
    if (api.credentialRequired !== credentialRequired) {
      api.credentialRequired = credentialRequired
      changed = true
    }
    if (Object.prototype.hasOwnProperty.call(api, 'credential_required')) {
      delete api.credential_required
      changed = true
    }
    const configured = credentialRequired
      ? (api.configured === true || Boolean(inlineKey) || hasSecret(credentialRef))
      : true
    if (api.configured !== configured) {
      api.configured = configured
      changed = true
    }
    return { ...slot, api }
  })
  if (changed) writeSlotFile(nextSlots)
  return { version: SLOT_FILE_VERSION, slots: nextSlots }
}

function uniqueStrings(values = []) {
  const out = []
  const seen = new Set()
  for (const value of values) {
    const text = String(value || '').trim()
    const key = text.toLowerCase()
    if (!text || seen.has(key)) continue
    seen.add(key)
    out.push(text)
  }
  return out
}

function redactSecrets(text = '') {
  return String(text || '').replace(SECRET_TOKEN_RE, '[redacted-api-key]')
}

function normalizeSlot(slot = {}, { preserveInlineApiKey = false } = {}) {
  const kind = normalizeKind(slot.kind || 'vision')
  const provider = normalizeProvider(slot.provider || providerFromSlotId(slot.id, kind) || DEFAULT_PROVIDER)
  const id = canonicalSlotId({ id: slot.id, kind, provider })
  const api = slot.api && typeof slot.api === 'object' ? slot.api : {}
  const docs = slot.docs && typeof slot.docs === 'object' ? slot.docs : {}
  const credentialRef = String(api.credentialRef || api.credential_ref || apiCredentialRef(id)).trim()
  const inlineKey = cleanInlineApiKey(api.apiKey)
  const credentialRequired = isCredentialRequired(api, slot)
  const authType = credentialRequired ? 'api_key' : 'none'
  const configured = credentialRequired ? (Boolean(inlineKey) || hasSecret(credentialRef)) : true
  return {
    id,
    kind,
    provider,
    label: String(slot.label || id).trim(),
    summary: String(slot.summary || '通过已配置的外部 API 服务执行能力槽。').trim(),
    enabled: slot.enabled !== false,
    triggers: uniqueStrings([...(slot.triggers || []), ...(kind === 'vision' ? DEFAULT_VISION_TRIGGERS : [])]),
    api: {
      protocol: String(api.protocol || 'openai-chat-completions').trim(),
      baseURL: String(api.baseURL || api.baseUrl || '').trim(),
      endpoint: String(api.endpoint || DEFAULT_CHAT_COMPLETIONS_ENDPOINT).trim(),
      model: String(api.model || '').trim(),
      authType,
      credentialRequired,
      credentialRef,
      configured,
      apiKey: preserveInlineApiKey ? inlineKey : '',
    },
    docs: {
      text: redactSecrets(docs.text || slot.docsText || ''),
      url: String(docs.url || slot.docsUrl || '').trim(),
      summary: String(docs.summary || slot.docsSummary || '').trim(),
      source: String(docs.source || slot.docsSource || 'user').trim(),
      updatedAt: docs.updatedAt || slot.docsUpdatedAt || null,
    },
    executionInstructions: String(slot.executionInstructions || '').trim(),
    program: normalizeProgram(slot.program || {}),
    inputSchema: normalizeJsonSchema(slot.inputSchema || slot.input_schema),
    outputSchema: normalizeJsonSchema(slot.outputSchema || slot.output_schema),
    permissions: normalizePermissions(slot.permissions || {}),
    testResults: normalizeTestResults(slot.testResults || slot.test_results),
    createdAt: slot.createdAt || nowIso(),
    updatedAt: slot.updatedAt || nowIso(),
  }
}

function normalizeProgram(program = {}) {
  return {
    path: String(program.path || program.programPath || '').trim(),
    runtime: String(program.runtime || '').trim() || inferProgramRuntime(program.path || program.programPath || ''),
    timeoutMs: Math.min(Math.max(Number(program.timeoutMs || program.timeout_ms || 60_000) || 60_000, 1_000), 10 * 60_000),
    contract: String(program.contract || 'stdin-json/stdout-json').trim(),
  }
}

function inferProgramRuntime(programPath = '') {
  const text = String(programPath || '').trim().toLowerCase()
  if (text.endsWith('.py')) return 'python'
  return 'node'
}

function normalizeJsonSchema(schema) {
  if (!schema || typeof schema !== 'object' || Array.isArray(schema)) {
    return { type: 'object', properties: {}, required: [] }
  }
  return schema
}

function normalizePermissions(permissions = {}) {
  return {
    network: permissions.network !== false,
    filesystem: permissions.filesystem === true,
    exec: false,
  }
}

function normalizeTestResults(results = []) {
  if (!Array.isArray(results)) return []
  return results.slice(0, 20).map((item, index) => ({
    name: String(item?.name || `test_${index + 1}`).slice(0, 80),
    ok: item?.ok === true,
    detail: String(item?.detail || item?.message || '').slice(0, 1000),
    testedAt: item?.testedAt || item?.tested_at || nowIso(),
  }))
}

function publicSlot(slot) {
  const normalized = normalizeSlot(slot)
  const configured = normalized.api.configured
  return {
    ...normalized,
    configured,
    api: {
      ...normalized.api,
      configured,
      apiKey: normalized.api.credentialRequired && configured ? '[configured]' : '',
    },
  }
}

function storageSlot(slot) {
  const normalized = normalizeSlot(slot, { preserveInlineApiKey: true })
  const credentialRef = normalized.api.credentialRef || apiCredentialRef(normalized.id)
  const apiKey = String(normalized.api.apiKey || '').trim()
  if (!normalized.api.credentialRequired) deleteSecret(credentialRef)
  else if (apiKey) setSecret(credentialRef, apiKey)
  const configured = normalized.api.credentialRequired
    ? (Boolean(apiKey) || normalized.api.configured || hasSecret(credentialRef))
    : true
  const { apiKey: _apiKey, ...api } = normalized.api
  return {
    ...normalized,
    configured,
    api: {
      ...api,
      credentialRef,
      configured,
    },
  }
}

function upsertSlot(slot) {
  const normalized = normalizeSlot(slot, { preserveInlineApiKey: true })
  const file = readSlotFile()
  const existing = file.slots.find(s => canonicalSlotId(s) === normalized.id)
  const next = storageSlot({
    ...(existing || {}),
    ...normalized,
    api: { ...(existing?.api || {}), ...normalized.api },
    docs: { ...(existing?.docs || {}), ...normalized.docs },
    triggers: uniqueStrings([...(existing?.triggers || []), ...normalized.triggers]),
    createdAt: existing?.createdAt || normalized.createdAt,
    updatedAt: nowIso(),
  })
  const slots = file.slots.filter(s => {
    const id = canonicalSlotId(s)
    if (id === normalized.id) return false
    return true
  })
  slots.push(next)
  writeSlotFile(slots)
  return next
}

export function listApiCapabilitySlots({ includeSecrets = false } = {}) {
  // Compatibility only: slot reads never return credential plaintext.
  const slots = readSlotFile().slots.map(slot => normalizeSlot(slot))
  return includeSecrets ? slots : slots.map(publicSlot)
}

export function getApiCapabilitySlot(id = '', { includeSecrets = false } = {}) {
  const normalizedId = normalizeId(id)
  if (!normalizedId) return null
  const canonicalId = canonicalSlotId({ id: normalizedId })
  const slots = readSlotFile().slots.map(s => normalizeSlot(s))
  const slot = slots.find(s => s.id === normalizedId || canonicalSlotId(s) === canonicalId)
  if (!slot) return null
  return includeSecrets ? slot : publicSlot(slot)
}

export function getApiCapabilityCredential(slotOrId = '') {
  const slot = typeof slotOrId === 'string'
    ? getApiCapabilitySlot(slotOrId)
    : normalizeSlot(slotOrId)
  if (!slot) return ''
  if (!slot.api?.credentialRequired) return ''
  return getSecret(slot.api?.credentialRef || apiCredentialRef(slot.id))
}

export function apiCapabilityNeedsCredential(slotOrId = '') {
  const slot = typeof slotOrId === 'string'
    ? getApiCapabilitySlot(slotOrId)
    : normalizeSlot(slotOrId)
  return !!slot?.api?.credentialRequired
}

export function deleteApiCapabilitySlot(id) {
  const normalizedId = normalizeId(id)
  if (!normalizedId) return false
  const canonicalId = canonicalSlotId({ id: normalizedId })
  const file = readSlotFile()
  const existing = file.slots.find(s => normalizeId(s?.id) === normalizedId || canonicalSlotId(s) === canonicalId)
  const next = file.slots.filter(s => normalizeId(s?.id) !== normalizedId && canonicalSlotId(s) !== canonicalId)
  if (next.length === file.slots.length) return false
  const ref = existing ? normalizeSlot(existing).api.credentialRef : apiCredentialRef(normalizedId)
  deleteSecret(ref)
  writeSlotFile(next)
  return true
}

export function setApiCapabilitySlotEnabled(id, enabled) {
  const slot = getApiCapabilitySlot(id)
  if (!slot) throw new Error(`API capability slot not found: ${id}`)
  return publicSlot(upsertSlot({ ...slot, enabled: !!enabled }))
}

export function configureApiCapabilitySlot({
  slotId = '',
  provider = '',
  kind = 'vision',
  label = '',
  summary = '',
  apiKey = '',
  authType = '',
  credentialRequired = undefined,
  model = '',
  baseURL = '',
  endpoint = '',
  protocol = 'openai-chat-completions',
  docsText = '',
  docsUrl = '',
  docsSummary = '',
  docsSource = 'user',
  executionInstructions = '',
  programPath = '',
  programRuntime = '',
  programTimeoutMs = undefined,
  inputSchema = null,
  outputSchema = null,
  permissions = {},
  testResults = [],
  triggers = [],
  enabled = true,
} = {}) {
  const normalizedKind = normalizeKind(kind)
  const requestedId = normalizeId(slotId)
  const normalizedProvider = normalizeProvider(provider || providerFromSlotId(requestedId, normalizedKind) || DEFAULT_PROVIDER)
  const id = canonicalSlotId({ id: requestedId, kind: normalizedKind, provider: normalizedProvider })
  const existing = getApiCapabilitySlot(id) || {}
  const existingApi = existing.api || {}
  const existingDocs = existing.docs || {}
  const nextDocs = {
    ...existingDocs,
    ...(docsText ? { text: redactSecrets(docsText).slice(0, 20_000) } : {}),
    ...(docsUrl ? { url: String(docsUrl).trim() } : {}),
    ...(docsSummary ? { summary: String(docsSummary).trim().slice(0, 2000) } : {}),
    source: docsSource || existingDocs.source || 'user',
    updatedAt: (docsText || docsUrl || docsSummary) ? nowIso() : existingDocs.updatedAt,
  }
  const existingProgram = existing.program || {}
  const nextProgram = normalizeProgram({
    ...existingProgram,
    ...(programPath ? { path: programPath } : {}),
    ...(programRuntime ? { runtime: programRuntime } : {}),
    ...(programTimeoutMs !== undefined ? { timeoutMs: programTimeoutMs } : {}),
  })
  return publicSlot(upsertSlot({
    ...existing,
    id,
    kind: normalizedKind,
    provider: normalizedProvider,
    label: label || existing.label || `${normalizedProvider} ${normalizedKind}`,
    summary: summary || existing.summary || '通过已配置的外部 API 服务执行能力槽。',
    enabled,
    triggers,
    api: {
      ...existingApi,
      protocol: protocol || existingApi.protocol || 'openai-chat-completions',
      baseURL: baseURL || existingApi.baseURL || '',
      endpoint: endpoint || existingApi.endpoint || DEFAULT_CHAT_COMPLETIONS_ENDPOINT,
      model: model || existingApi.model || '',
      authType: authType || existingApi.authType || existingApi.auth_type || 'api_key',
      credentialRequired: credentialRequired !== undefined ? !!credentialRequired : existingApi.credentialRequired,
      apiKey,
    },
    docs: nextDocs,
    executionInstructions: executionInstructions || existing.executionInstructions || defaultExecutionInstructions(normalizedKind),
    program: nextProgram,
    inputSchema: inputSchema || existing.inputSchema,
    outputSchema: outputSchema || existing.outputSchema,
    permissions: { ...(existing.permissions || {}), ...(permissions || {}) },
    testResults: Array.isArray(testResults) && testResults.length ? testResults : existing.testResults,
  }))
}

export function saveKimiVisionDocs({
  docsText = '',
  docsUrl = '',
  docsSummary = '',
  executionInstructions = '',
  model = '',
  baseURL = '',
  triggers = [],
} = {}) {
  return configureApiCapabilitySlot({
    slotId: KIMI_VISION_SLOT_ID,
    kind: 'vision',
    provider: 'kimi',
    label: 'Kimi 视觉识图',
    summary: '调用 Moonshot/Kimi 的视觉模型识别、描述、OCR 或分析用户提供的图片。',
    docsText,
    docsUrl,
    docsSummary,
    executionInstructions,
    triggers,
    baseURL: baseURL || DEFAULT_KIMI_BASE_URL,
    model: model || DEFAULT_KIMI_VISION_MODEL,
  })
}

export function configureKimiVisionSlot({
  apiKey,
  docsText = '',
  executionInstructions = '',
  model = '',
  baseURL = '',
  triggers = [],
} = {}) {
  const key = String(apiKey || '').trim()
  if (!key) throw new Error('apiKey required')
  return configureApiCapabilitySlot({
    slotId: KIMI_VISION_SLOT_ID,
    provider: 'kimi',
    kind: 'vision',
    label: 'Kimi 视觉识图',
    summary: '调用 Moonshot/Kimi 的视觉模型识别、描述、OCR 或分析用户提供的图片。',
    apiKey: key,
    docsText,
    executionInstructions,
    model: model || DEFAULT_KIMI_VISION_MODEL,
    baseURL: baseURL || DEFAULT_KIMI_BASE_URL,
    triggers,
  })
}

export function listApiSlotCapabilities() {
  return listApiCapabilitySlots()
    .filter(slot => slot.enabled && slot.program?.path)
    .map(slot => ({
      id: `api-slot:${slot.id}`,
      label: slot.label,
      summary: slot.summary,
      triggers: slot.triggers,
      tools: toolsForSlot(slot),
      detect: ctx => matchesApiSlotIntent(slot, ctx),
      toolWhen: ctx => matchesApiSlotIntent(slot, ctx),
      context: buildApiSlotContext(slot),
    }))
    .filter(cap => cap.tools.length > 0)
}

function toolsForSlot(slot = {}) {
  if (slot.program?.path) return [...GENERIC_API_CAPABILITY_TOOLS]
  return [...(LEGACY_TOOL_BY_KIND[slot.kind] || [])]
}

export function findConfiguredApiSlotByKind(kind = 'vision', preferredId = '') {
  const normalizedKind = normalizeKind(kind)
  const slots = listApiCapabilitySlots()
    .filter(slot => slot.enabled && slot.api?.configured && slot.kind === normalizedKind)
  if (!slots.length) return null
  const id = normalizeId(preferredId)
  if (id) {
    const canonicalId = canonicalSlotId({ id })
    return slots.find(slot => slot.id === id || canonicalSlotId(slot) === canonicalId) || null
  }
  return slots[0]
}

export function hasApiCapabilityKind(kind = 'vision') {
  return !!findConfiguredApiSlotByKind(kind)
}

export function buildApiSlotContext(slot = {}) {
  const s = normalizeSlot(slot)
  const toolNames = toolsForSlot(s)
  const docsSummary = s.docs?.summary ? `\n- Docs summary: ${s.docs.summary}` : ''
  const docsUrl = s.docs?.url ? `\n- Config docs URL: ${s.docs.url}` : ''
  const instructions = s.executionInstructions || defaultExecutionInstructions(s.kind)
  const inputSchema = JSON.stringify(s.inputSchema || { type: 'object', properties: {}, required: [] })
  const outputSchema = JSON.stringify(s.outputSchema || { type: 'object' })
  const credentialLine = s.api.credentialRequired
    ? 'Credential: API key is configured internally; do not ask for it or expose it.'
    : 'Credential: none required; run the local program directly.'
  const secretGuidance = s.api.credentialRequired
    ? '- Do not expose or repeat API keys. If the call fails, use the docs URL to debug before changing code.'
    : '- If the call fails, use the registered runner path and docs summary to debug before changing code.'
  return `### Capability Slot: ${s.label}
- Slot id: ${s.id}
- Provider: ${s.provider}; kind: ${s.kind}; model: ${s.api.model}
- Use tool(s): ${toolNames.join(', ')}
- Program path: ${s.program.path || '(not configured)'} (${s.program.runtime || 'node'}, ${s.program.contract})
- Auth type: ${s.api.authType}
- ${credentialLine}
- Input schema: ${inputSchema}
- Output schema: ${outputSchema}
- Call run_capability with slot_id="${s.id}" and args matching the input schema. Do not re-read the full docs unless the call fails or the user asks to change the capability.
${secretGuidance}
- Execution instructions: ${instructions}${docsUrl}${docsSummary}`
}

function defaultExecutionInstructions(kind = 'vision') {
  if (kind !== 'vision') return 'Call the configured capability runner according to the saved execution instructions.'
  return 'Use an OpenAI-compatible chat completions request with a user content array containing text plus image_url. Return choices[0].message.content as the image analysis result.'
}

function matchesApiSlotIntent(slot, ctx = {}) {
  const raw = `${ctx.rawText || ''}\n${ctx.text || ''}`.toLowerCase()
  if (!raw.trim()) return false
  if ((slot.triggers || []).some(t => raw.includes(String(t).toLowerCase()))) return true
  if (slot.kind === 'vision') {
    return VISION_ATTACHMENT_RE.test(raw) || VISION_INTENT_RE.test(raw)
  }
  return false
}

export const __internal = {
  apiCredentialRef,
  redactSecrets,
  normalizeSlot,
  defaultSlotId,
}
