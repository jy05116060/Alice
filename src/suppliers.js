// 模型供应商（常驻列表）——借鉴天枢 provider-keys.json 的结构：
//   每个供应商以 baseURL 为键，下面挂一份「带能力的模型清单」
//   （id / contextWindow / maxTokens / supportsVision）。
//
// 与 config.js 里的 data/llm/<provider>.json 的关系：
//   - 内建渠道（deepseek/minimax/...）仍走 <provider>.json，单文件单渠道；
//   - 自定义中转站走这里：data/llm/suppliers.json 是一个多条目列表，
//     加过的供应商常驻在里面，切换时不用再重填地址和 Key。
//   - 「当前生效的自定义供应商」记在 suppliers.json 的 activeId，
//     实际激活仍复用 config.js 的 saveLLMSettings({ provider: 'custom', ... })，
//     所以 LLM 调用链不需要改动。

import fs from 'fs'
import path from 'path'
import { paths } from './paths.js'

const SUPPLIERS_FILE = path.join(paths.llmConfigDir, 'suppliers.json')
const SUPPLIERS_SCHEMA_VERSION = 1

// 天枢那份带能力的模型目录：只读参考源，存在就用它给模型补上下文窗口/视觉能力。
const TIANSHU_PROVIDER_KEYS = 'D:\\天枢\\Tianshu\\TianshuData\\.rivet\\provider-keys.json'

function readJsonSafe(file) {
  try {
    if (!fs.existsSync(file)) return null
    const parsed = JSON.parse(fs.readFileSync(file, 'utf-8'))
    return parsed && typeof parsed === 'object' ? parsed : null
  } catch {
    return null
  }
}

function writeJsonAtomic(file, obj) {
  fs.mkdirSync(path.dirname(file), { recursive: true })
  const tmp = `${file}.tmp`
  fs.writeFileSync(tmp, JSON.stringify(obj, null, 2), 'utf-8')
  fs.renameSync(tmp, file)
}

// 地址归一化：去掉尾部斜杠、统一小写主机名，用它当供应商 id（同址即同一条）。
export function normalizeBaseURL(baseURL) {
  const raw = String(baseURL || '').trim()
  if (!raw) return ''
  return raw.replace(/\/+$/, '')
}

// 网站栏：供应商的官网/控制台地址。没写协议就补 https://，非 http(s) 一律当没填。
export function normalizeSite(site) {
  const raw = String(site || '').trim()
  if (!raw) return ''
  const withScheme = /^[a-z][a-z0-9+.-]*:\/\//i.test(raw) ? raw : `https://${raw}`
  try {
    const url = new URL(withScheme)
    if (url.protocol !== 'http:' && url.protocol !== 'https:') return ''
    return url.toString().replace(/\/+$/, '')
  } catch {
    return ''
  }
}

function supplierIdFor(baseURL) {
  return normalizeBaseURL(baseURL).toLowerCase()
}

function defaultLabelFor(baseURL) {
  const normalized = normalizeBaseURL(baseURL)
  if (!normalized) return '未命名供应商'
  try {
    return new URL(normalized).host || normalized
  } catch {
    return normalized
  }
}

// ── 天枢模型能力目录 ────────────────────────────────────────────────
let tianshuCatalogCache = null

function loadTianshuCatalog() {
  if (tianshuCatalogCache !== null) return tianshuCatalogCache
  const parsed = readJsonSafe(TIANSHU_PROVIDER_KEYS)
  const providers = parsed?.providers
  if (!providers || typeof providers !== 'object') {
    tianshuCatalogCache = {}
    return tianshuCatalogCache
  }
  // 摊平成 baseURL(小写) → { 模型id → { contextWindow, maxTokens, supportsVision } }
  const flat = {}
  for (const [key, entries] of Object.entries(providers)) {
    const keyNorm = normalizeBaseURL(key).toLowerCase()
    const models = {}
    const list = Array.isArray(entries) ? entries : []
    for (const entry of list) {
      for (const m of (Array.isArray(entry?.models) ? entry.models : [])) {
        if (!m?.id) continue
        models[String(m.id)] = {
          contextWindow: Number.isFinite(m.contextWindow) ? m.contextWindow : undefined,
          maxTokens: Number.isFinite(m.maxTokens) ? m.maxTokens : undefined,
          supportsVision: m.supportsVision === true,
        }
      }
    }
    if (Object.keys(models).length) flat[keyNorm] = models
  }
  tianshuCatalogCache = flat
  return flat
}

// 给一个供应商的模型清单补能力字段：先按 baseURL 精确匹配天枢目录，
// 匹配不上（比如中转站地址与天枢记录不同）就整份目录里按模型 id 兜底查一次。
export function enrichModelsWithCapabilities(baseURL, models) {
  const catalog = loadTianshuCatalog()
  const byURL = catalog[supplierIdFor(baseURL)] || null
  const fallback = byURL ? null : Object.values(catalog).reduce((acc, group) => {
    for (const [id, meta] of Object.entries(group)) if (!acc[id]) acc[id] = meta
    return acc
  }, {})

  return (Array.isArray(models) ? models : [])
    .filter(m => m?.id)
    .map((m) => {
      const id = String(m.id)
      const meta = byURL?.[id] || fallback?.[id] || null
      const enriched = { id, label: m.label || id, deprecated: false }
      if (meta?.contextWindow) enriched.contextWindow = meta.contextWindow
      if (meta?.maxTokens) enriched.maxTokens = meta.maxTokens
      if (meta?.supportsVision) enriched.supportsVision = true
      return enriched
    })
}

// ── 供应商列表读写 ──────────────────────────────────────────────────

function readStore() {
  const parsed = readJsonSafe(SUPPLIERS_FILE)
  const list = Array.isArray(parsed?.suppliers) ? parsed.suppliers : []
  const suppliers = list
    .filter(s => s && typeof s === 'object' && normalizeBaseURL(s.baseURL))
    .map(s => ({
      id: String(s.id || supplierIdFor(s.baseURL)),
      label: String(s.label || defaultLabelFor(s.baseURL)),
      baseURL: normalizeBaseURL(s.baseURL),
      apiKey: typeof s.apiKey === 'string' ? s.apiKey : '',
      site: normalizeSite(s.site),
      models: Array.isArray(s.models) ? s.models : [],
      lastModel: String(s.lastModel || ''),
      addedAt: s.addedAt || null,
      updatedAt: s.updatedAt || null,
    }))
  return {
    version: SUPPLIERS_SCHEMA_VERSION,
    activeId: parsed?.activeId ? String(parsed.activeId) : null,
    suppliers,
  }
}

function writeStore(store) {
  writeJsonAtomic(SUPPLIERS_FILE, {
    version: SUPPLIERS_SCHEMA_VERSION,
    activeId: store.activeId || null,
    suppliers: store.suppliers,
  })
}

// 供前端渲染的列表（apiKey 只回传是否已配置，不回传明文）
export function getSupplierList() {
  const store = readStore()
  return {
    activeId: store.activeId,
    suppliers: store.suppliers.map(s => ({
      id: s.id,
      label: s.label,
      baseURL: s.baseURL,
      site: s.site || '',
      hasKey: !!s.apiKey,
      models: enrichModelsWithCapabilities(s.baseURL, s.models),
      lastModel: s.lastModel,
      addedAt: s.addedAt,
      updatedAt: s.updatedAt,
    })),
  }
}

export function getSupplierRecord(id) {
  const store = readStore()
  const target = String(id || '').toLowerCase()
  return store.suppliers.find(s => s.id.toLowerCase() === target) || null
}

// 按地址找已保存的那条。用于「只给了 baseURL，就用它已存的密钥」这类回退场景
// （例如刷新已保存供应商的模型清单时，前端不必持有明文密钥）。
// 比较用规范化后的地址，避免 https://x.com/ 与 https://x.com 被当成两条。
export function findSupplierByBaseURL(baseURL) {
  const normalized = normalizeBaseURL(baseURL)
  if (!normalized) return null
  const target = supplierIdFor(normalized)
  const store = readStore()
  return store.suppliers.find(s => supplierIdFor(s.baseURL) === target) || null
}

// 新增或更新一条供应商；同 baseURL 视为同一条（更新而不是追加）。
export function upsertSupplier({ id, label, baseURL, apiKey, models, lastModel, site } = {}) {
  const normalized = normalizeBaseURL(baseURL)
  if (!normalized) throw new Error('请填写 Base URL')
  const store = readStore()
  const key = id ? String(id).toLowerCase() : supplierIdFor(normalized)
  const now = new Date().toISOString()
  const existing = store.suppliers.find(s => s.id.toLowerCase() === key)
    || store.suppliers.find(s => supplierIdFor(s.baseURL) === supplierIdFor(normalized))

  const nextModels = enrichModelsWithCapabilities(normalized, models?.length ? models : existing?.models)

  if (existing) {
    existing.label = String(label || existing.label || defaultLabelFor(normalized))
    existing.baseURL = normalized
    if (typeof apiKey === 'string' && apiKey.trim()) existing.apiKey = apiKey.trim()
    // 网站栏：填了才覆盖；留空表示不动原来那条
    if (typeof site === 'string' && site.trim()) existing.site = normalizeSite(site)
    if (nextModels.length) existing.models = nextModels
    if (lastModel) existing.lastModel = String(lastModel)
    existing.updatedAt = now
  } else {
    store.suppliers.push({
      id: key,
      label: String(label || defaultLabelFor(normalized)),
      baseURL: normalized,
      site: normalizeSite(site),
      apiKey: typeof apiKey === 'string' ? apiKey.trim() : '',
      models: nextModels,
      lastModel: String(lastModel || ''),
      addedAt: now,
      updatedAt: now,
    })
  }
  writeStore(store)
  return getSupplierList()
}

export function removeSupplier(id) {
  const target = String(id || '').toLowerCase()
  const store = readStore()
  const before = store.suppliers.length
  store.suppliers = store.suppliers.filter(s => s.id.toLowerCase() !== target)
  if (store.activeId && store.activeId.toLowerCase() === target) store.activeId = null
  if (store.suppliers.length === before) throw new Error('没有找到这个供应商')
  writeStore(store)
  return getSupplierList()
}

export function markActiveSupplier(id) {
  const store = readStore()
  store.activeId = id ? String(id) : null
  writeStore(store)
}

export function setSupplierLastModel(id, model) {
  const store = readStore()
  const target = String(id || '').toLowerCase()
  const hit = store.suppliers.find(s => s.id.toLowerCase() === target)
  if (!hit) return
  hit.lastModel = String(model || '')
  hit.updatedAt = new Date().toISOString()
  writeStore(store)
}

// ── 拉上游模型清单 ──────────────────────────────────────────────────
// 用给定 baseURL + key 调 GET {baseURL}/models，再把天枢的能力字段补上。
const MODELS_TTL_MS = 60 * 1000
const modelsCache = new Map()

export async function fetchModelCatalog({ baseURL, apiKey, force = false } = {}) {
  const normalized = normalizeBaseURL(baseURL)
  if (!normalized) throw new Error('请填写 Base URL')

  const cacheKey = `${normalized}|${apiKey ? 'k' : '-'}`
  const cached = modelsCache.get(cacheKey)
  if (!force && cached && Date.now() - cached.at < MODELS_TTL_MS) {
    return { models: cached.models, cached: true }
  }

  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), 8000)
  try {
    const res = await fetch(`${normalized}/models`, {
      headers: apiKey ? { Authorization: `Bearer ${apiKey}` } : {},
      signal: controller.signal,
    })
    if (!res.ok) throw new Error(`上游返回 HTTP ${res.status}`)
    const payload = await res.json().catch(() => null)
    const raw = Array.isArray(payload) ? payload
      : (Array.isArray(payload?.data) ? payload.data
        : (Array.isArray(payload?.models) ? payload.models : null))
    if (!raw) throw new Error('上游返回的模型目录格式不认识（既没有 data[] 也没有 models[]）')
    const list = raw
      .map(m => (typeof m === 'string' ? m : (m?.id || m?.name)))
      .filter(Boolean)
      .map(id => ({ id: String(id), label: String(id) }))
    const unique = Array.from(new Map(list.map(m => [m.id, m])).values())
      .sort((a, b) => a.id.localeCompare(b.id))
    const models = enrichModelsWithCapabilities(normalized, unique)
    modelsCache.set(cacheKey, { at: Date.now(), models })
    return { models, cached: false }
  } catch (err) {
    if (err?.name === 'AbortError') throw new Error('连接上游超时（8s）')
    throw err
  } finally {
    clearTimeout(timer)
  }
}