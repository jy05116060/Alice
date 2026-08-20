import { emitEvent, setStickyEvent } from '../../events.js'
import { pushMessage } from '../../inbound-message.js'
import { restartConnector } from '../../social/index.js'
import { replaceProvider } from '../../providers/registry.js'
import { MinimaxProvider } from '../../providers/minimax.js'
import { VankitProvider } from '../../providers/vankit.js'
import {
  config,
  getActivationStatus,
  getEmbeddingConfig,
  getContextWindowConfig,
  getHeartbeatConfig,
  getMinimaxKey,
  getNetworkConfig,
  getProviderSummaries,
  getReasoningEffort,
  getSecurity,
  getSocialConfig,
  getTTSConfig,
  getVankitConfig,
  getVoiceConfig,
  saveLLMSettings,
  setEmbeddingConfig,
  setContextWindowConfig,
  setHeartbeatConfig,
  setMinimaxKey,
  setNetworkConfig,
  setSecurity,
  setSocialConfig,
  setTemperature,
  setReasoningEffort,
  setThinking,
  setTTSConfig,
  setVankitConfig,
  setVoiceConfig,
  switchModel,
} from '../../config.js'
import { refreshScheduler } from '../../control.js'
import { EMBEDDING_PROVIDER_PRESETS } from '../../config.js'
import { TTS_PROVIDERS, TTS_VOICES } from '../../voice/tts-providers.js'
import { getAgentName, validateAgentName } from '../agent.js'
import { jsonResponse, readJsonBody } from '../utils.js'
import { setConfig } from '../../db.js'
import { getMapServiceSettings, setMapServiceSettings } from '../../map-service.js'
import QRCode from 'qrcode'
import { getMcpServersConfig, setMcpServersConfig } from '../../mcp/config.js'
import { getMcpStatus, reconcileMcpClients } from '../../mcp/client-manager.js'
import { SANDBOX_MODES, presetSecurityPatch } from '../../capabilities/sandbox-policy.js'
import {
  getSupplierList,
  getSupplierRecord,
  findSupplierByBaseURL,
  normalizeBaseURL,
  upsertSupplier,
  removeSupplier,
  markActiveSupplier,
  setSupplierLastModel,
  fetchModelCatalog,
} from '../../suppliers.js'

function checkLocalOrToken(req, res, url, requireLocalOrToken) {
  if (typeof requireLocalOrToken === 'function') return requireLocalOrToken(req, res, url)
  jsonResponse(res, 403, { ok: false, error: 'forbidden' })
  return false
}

// ── 渠道模型目录（目前用于 custom 中转站）──────────────────────────────
// 爱丽丝的 providers.custom.models 一直是空数组（静态目录里没有中转站的信息），
// 这里用该渠道已存的 baseURL + key 调 GET {baseURL}/models，把 id 列表补上。
// 只在用户打开模型面板 / 切到该渠道时按需调用，结果 60s 内存缓存 —— 不在 60s 轮询里打上游。
const PROVIDER_MODELS_TTL_MS = 60 * 1000
const providerModelsCache = new Map()

async function fetchProviderModelCatalog(provider, { force = false } = {}) {
  const entry = getProviderSummaries()?.[provider]
  if (!entry) throw new Error(`未知渠道：${provider}`)
  const baseURL = String(entry.baseURL || '').trim().replace(/\/+$/, '')
  if (!baseURL) throw new Error('该渠道没有配置 baseURL')
  const apiKey = String(entry.apiKey || '').trim()

  const cached = providerModelsCache.get(provider)
  if (!force && cached && Date.now() - cached.at < PROVIDER_MODELS_TTL_MS) {
    return { models: cached.models, cached: true }
  }

  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), 8000)
  try {
    const res = await fetch(`${baseURL}/models`, {
      headers: apiKey ? { Authorization: `Bearer ${apiKey}` } : {},
      signal: controller.signal,
    })
    if (!res.ok) throw new Error(`上游返回 HTTP ${res.status}`)
    const payload = await res.json().catch(() => null)
    // OpenAI 风格是 {data:[{id}]}；少数网关直接给 {models:[...]} 或裸数组
    const raw = Array.isArray(payload) ? payload
      : (Array.isArray(payload?.data) ? payload.data
        : (Array.isArray(payload?.models) ? payload.models : null))
    if (!raw) throw new Error('上游返回的模型目录格式不认识（既没有 data[] 也没有 models[]）')
    const list = raw
      .map((m) => (typeof m === 'string' ? m : (m?.id || m?.name)))
      .filter(Boolean)
      .map((id) => ({ id: String(id), label: String(id), deprecated: false }))
    const models = Array.from(new Map(list.map((m) => [m.id, m])).values())
      .sort((a, b) => a.id.localeCompare(b.id))
    providerModelsCache.set(provider, { at: Date.now(), models })
    return { models, cached: false }
  } catch (err) {
    if (err?.name === 'AbortError') throw new Error('连接上游超时（8s）')
    throw err
  } finally {
    clearTimeout(timer)
  }
}

async function getNetworkSettingsForUi() {
  const network = getNetworkConfig()
  const accessEntries = await Promise.all((network.accessEntries || []).map(async entry => ({
    ...entry,
    qrDataUrl: await QRCode.toDataURL(entry.url, {
      errorCorrectionLevel: 'M',
      margin: 1,
      width: 320,
      color: { dark: '#07110d', light: '#ffffff' },
    }),
    certificateQrDataUrl: await QRCode.toDataURL(entry.certificateUrl, {
      errorCorrectionLevel: 'M',
      margin: 1,
      width: 240,
      color: { dark: '#07110d', light: '#ffffff' },
    }),
  })))
  return {
    ...network,
    accessEntries,
    preferredAccessUrl: accessEntries[0]?.url || '',
  }
}

export async function handleSettingsRoutes(req, res, url, { requireLocalOrToken, hasAllowedAccess } = {}) {
  if (req.method === 'GET' && url.pathname === '/settings') {
    const status = getActivationStatus()
    const minimaxKey = getMinimaxKey()
    jsonResponse(res, 200, {
      agent_name: getAgentName(),
      llm: {
        activated: status.activated,
        apiFormat: status.apiFormat,
        provider: status.provider,
        model: status.model,
        baseURL: status.baseURL,
        models: status.models,
        temperature: config.temperature,
        thinking: config.thinking === true,
        reasoningEffort: getReasoningEffort(),
        contextWindow: getContextWindowConfig(),
        apiKey: config.apiKey || '',
      },
      providers: getProviderSummaries(),
      minimax: (() => {
        const key = globalThis.process?.env?.MINIMAX_API_KEY || minimaxKey || ''
        // 「填了 key」不等于「key 能用」。实测过一个真实事故：`minimax_api_key` 字段里
        // 存的是**火山方舟的 key**（`ark-…`），MiniMax 侧直接 `login fail` —— 于是生图
        // 必然失败，但配置页看起来「已配置」，用户完全无从判断。
        // 这里只做**能确定**的判定（前缀明显属于别家），不做网络探测：
        // 设置页不该每次打开都去打一次上游。
        const looksForeign = /^ark-/.test(key) || /^sk-(proj|ant)-/.test(key) || /^sk-or-/.test(key)
        const providerHint = /^ark-/.test(key) ? 'volcano-ark'
          : /^sk-or-/.test(key) ? 'openrouter'
            : null
        return {
          configured: Boolean(key) && !looksForeign,
          hasKey: Boolean(key),
          suspected_mismatch: looksForeign ? { provider: providerHint, reason: '这个密钥看起来不属于 MiniMax（前缀像是别家的），MiniMax 调用会登录失败' } : null,
        }
      })(),
      // 生图备选通道。回给前端的 `apiKey` 用来回填输入框（与 minimax 那块一致：
      // 设置页本来就会拿到 llm.apiKey 明文，这里不新增暴露面）。
      vankit: (() => {
        const v = getVankitConfig()
        const envKey = globalThis.process?.env?.VANKIT_API_KEY
        const configured = Boolean(envKey || v?.apiKey)
        // 如实告诉前端「现在生图**实际**会走谁」。
        // 注意这里不能只看「MiniMax 字段非空」：字段里可能是别家的 key（见上面 minimax 段
        // 的说明），那种情况下 MiniMax 生图必失败，真正能用的其实是 VANKIT。
        const mmKey = globalThis.process?.env?.MINIMAX_API_KEY || minimaxKey || ''
        const mmUsable = Boolean(mmKey) && !/^ark-/.test(mmKey) && !/^sk-or-/.test(mmKey)
        return {
          configured,
          apiKey: envKey || v?.apiKey || '',
          baseURL: v?.baseURL || 'https://sub.vankit.top',
          model: v?.model || 'gpt-image-2.5',
          imageProvider: mmUsable ? 'minimax' : (configured ? 'vankit' : null),
          imageProviderNote: mmUsable
            ? ''
            : (mmKey
              ? 'MiniMax 里存的密钥看起来不是 MiniMax 的，生图会走 VANKIT'
              : 'MiniMax 未配置，生图会走 VANKIT'),
        }
      })(),
      heartbeat: getHeartbeatConfig(),
      network: getNetworkConfig(),
    })
    return true
  }

  if (req.method === 'POST' && url.pathname === '/settings/agent-name') {
    try {
      const { agentName, agent_name } = await readJsonBody(req)
      const trimmedName = validateAgentName(agentName ?? agent_name)
      if (trimmedName) setConfig('agent_name', trimmedName)
      const name = getAgentName()
      setStickyEvent('agent_name_updated', { name })
      emitEvent('agent_name_updated', { name })
      jsonResponse(res, 200, { ok: true, agent_name: name })
    } catch (err) {
      jsonResponse(res, 400, { ok: false, error: err.message })
    }
    return true
  }

  if (req.method === 'POST' && url.pathname === '/settings/model') {
    try {
      const { provider, apiKey, model, baseURL } = await readJsonBody(req)
      // 分支判据是「**要不要重新激活整个渠道**」。这里踩过两次同一个坑，都是因为
      // 拿「字段有没有出现」当信号，而调用方会习惯性带上所有字段：
      //
      //   第一次：`provider || apiKey || baseURL` —— composer 的模型下拉**总是**发
      //   `{provider, model}`，于是「同渠道换模型」也被当成重新激活。
      //   第二次：改成 `apiKey || baseURL` 后，设置弹窗的 custom 分支**总是**发
      //   `{provider, baseURL, model}`（baseURL 即使没改也带上），于是设置里换模型
      //   照样会走 prepareActivation → 真去连上游探测 → 上游拒绝就整个保存失败。
      //   用户看到的都是同一句话：「切换不过来」。
      //
      // 所以判据必须是**值有没有真的变**，不是字段在不在：
      //   · provider 变了            → 激活（换渠道要重新取模型目录/凭证）
      //   · baseURL 变了（真的不同）  → 激活（换了端点）
      //   · apiKey 变了（真的不同）   → 激活（换了凭证）
      //   · 以上都没变，只是 model 变 → switchModel（纯换名，不连网）
      // 这样「上游一时抽风」不会再把一次本该成功的换模型搞失败；
      // 而真的改了凭证/端点时，仍然会走完整激活（该校验的照样校验）。
      const currentProvider = String(config.provider || '').trim().toLowerCase()
      const wantedProvider = String(provider || '').trim().toLowerCase()
      const currentBaseURL = String(config.baseURL || '').trim()
      const wantedBaseURL = String(baseURL || '').trim()
      const currentApiKey = String(config.apiKey || '').trim()
      const wantedApiKey = String(apiKey || '').trim()

      const providerChanged = Boolean(wantedProvider && wantedProvider !== currentProvider)
      const baseURLChanged = Boolean(wantedBaseURL && wantedBaseURL !== currentBaseURL)
      // 调用方用 "none" 表示「这个端点不需要密钥」，与空值同义，不该被当成「换了凭证」。
      const apiKeyChanged = Boolean(wantedApiKey)
        && wantedApiKey !== 'none'
        && wantedApiKey !== currentApiKey

      const needsActivation = providerChanged || baseURLChanged || apiKeyChanged
      const result = needsActivation
        ? await saveLLMSettings({ provider, apiKey, model, baseURL })
        : switchModel(model)
      emitEvent('model_switched', result)
      jsonResponse(res, 200, { ok: true, ...result })
    } catch (err) {
      jsonResponse(res, 400, { ok: false, error: err.message })
    }
    return true
  }

  if (req.method === 'POST' && url.pathname === '/settings/temperature') {
    try {
      const { temperature } = await readJsonBody(req)
      const result = setTemperature(temperature)
      jsonResponse(res, 200, { ok: true, ...result })
    } catch (err) {
      jsonResponse(res, 400, { ok: false, error: err.message })
    }
    return true
  }

  if (req.method === 'POST' && url.pathname === '/settings/thinking') {
    try {
      const { thinking } = await readJsonBody(req)
      const result = setThinking(thinking)
      jsonResponse(res, 200, { ok: true, ...result })
    } catch (err) {
      jsonResponse(res, 400, { ok: false, error: err.message })
    }
    return true
  }

  // 推理等级（reasoning.effort）：爱丽丝四档 → minimal/low/medium/high
  // （取值集合见 OpenAI SDK 的 ReasoningEffort；不传则回退到旧布尔 thinking 的推导）
  if (req.method === 'POST' && url.pathname === '/settings/reasoning-effort') {
    try {
      const { effort, reasoningEffort } = await readJsonBody(req)
      const result = setReasoningEffort(effort ?? reasoningEffort)
      jsonResponse(res, 200, { ok: true, ...result })
    } catch (err) {
      jsonResponse(res, 400, { ok: false, error: err.message })
    }
    return true
  }

  // 按需拉某个渠道的模型目录（目前用于 custom 中转站的 GET {baseURL}/models）。
  // 只在用户打开模型面板 / 切到该渠道时调用，结果做 60s 内存缓存，绝不在轮询里打上游。
  if (req.method === 'GET' && url.pathname === '/settings/provider-models') {
    const provider = String(url.searchParams.get('provider') || '').trim().toLowerCase()
    const force = url.searchParams.get('refresh') === '1'
    if (!provider) {
      jsonResponse(res, 400, { ok: false, error: 'provider is required' })
      return true
    }
    try {
      const result = await fetchProviderModelCatalog(provider, { force })
      jsonResponse(res, 200, { ok: true, provider, ...result })
    } catch (err) {
      // 上游超时 / 401 / 格式不对：如实返回原因，前端只在面板里显示一句可读提示
      jsonResponse(res, 200, { ok: false, provider, error: err?.message || String(err), models: [] })
    }
    return true
  }

  // ── 供应商常驻列表（借鉴天枢 provider-keys.json）──────────────────────
  // GET  /settings/suppliers            列出加过的供应商（带能力模型清单）
  // POST /settings/suppliers            新增/更新一条（同 baseURL 视为同一条）
  // POST /settings/suppliers/remove     删除一条
  // POST /settings/suppliers/activate   切换到某条（复用 custom 渠道激活）
  // GET  /settings/suppliers/models     用给定地址+Key 拉上游模型清单
  if (req.method === 'GET' && url.pathname === '/settings/suppliers') {
    try {
      jsonResponse(res, 200, { ok: true, ...getSupplierList() })
    } catch (err) {
      jsonResponse(res, 400, { ok: false, error: err?.message || String(err) })
    }
    return true
  }

  if (req.method === 'POST' && url.pathname === '/settings/suppliers/models') {
    try {
      const { baseURL, apiKey, refresh, id } = await readJsonBody(req)
      // 密钥回退：调用方可以只给 baseURL（或给 id），由后端用**已保存的那条**密钥去拉。
      //
      // 为什么要这样：供应商列表接口只回 `hasKey`（不回明文 key），而「刷新已保存供应商
      // 的模型清单」这个操作本来就不该要求前端手里有明文密钥。让前端为了刷新而把 key
      // 读出来再传回去，等于凭空多一条暴露路径。
      //
      // 顺序上**先看 VANKIT 专用配置**：同一个地址可能同时存在于两处
      // （`config.json` 的 `vankit` 字段 与 供应商登记表），实测这两处的 key 会不一致，
      // 于是「刷新清单」拉回来的模型和「实际生图」用的账号根本不是同一个。
      // 专用配置才是生图真正会用的那条，以它为准才符合直觉。
      let key = String(apiKey || '').trim()
      let keySource = key ? 'request' : ''
      if (!key) {
        const normalized = normalizeBaseURL(baseURL)
        const vk = getVankitConfig()
        const vkMatches = vk?.apiKey && normalizeBaseURL(vk.baseURL || '') === normalized
        if (vkMatches) {
          key = vk.apiKey
          keySource = 'vankit-config'
        } else {
          const record = id ? getSupplierRecord(id) : findSupplierByBaseURL(baseURL)
          if (record?.apiKey) {
            key = record.apiKey
            keySource = 'supplier-store'
          }
        }
      }
      const result = await fetchModelCatalog({ baseURL, apiKey: key, force: refresh === true || refresh === 1 })
      jsonResponse(res, 200, { ok: true, ...result, used_stored_key: keySource !== '' && keySource !== 'request', key_source: keySource || 'none' })
    } catch (err) {
      // 上游超时 / 401 / 格式不对：如实返回原因，前端只显示一句可读提示
      jsonResponse(res, 200, { ok: false, error: err?.message || String(err), models: [] })
    }
    return true
  }

  if (req.method === 'POST' && url.pathname === '/settings/suppliers') {
    try {
      const { id, label, baseURL, apiKey, models, lastModel, site } = await readJsonBody(req)
      const list = upsertSupplier({ id, label, baseURL, apiKey, models, lastModel, site })
      jsonResponse(res, 200, { ok: true, ...list })
    } catch (err) {
      jsonResponse(res, 400, { ok: false, error: err?.message || String(err) })
    }
    return true
  }

  if (req.method === 'POST' && url.pathname === '/settings/suppliers/remove') {
    try {
      const { id } = await readJsonBody(req)
      const list = removeSupplier(id)
      jsonResponse(res, 200, { ok: true, ...list })
    } catch (err) {
      jsonResponse(res, 400, { ok: false, error: err?.message || String(err) })
    }
    return true
  }

  if (req.method === 'POST' && url.pathname === '/settings/suppliers/activate') {
    try {
      const { id, model } = await readJsonBody(req)
      const record = getSupplierRecord(id)
      if (!record) throw new Error('没有找到这个供应商，请先在列表里添加')
      const nextModel = String(model || record.lastModel || record.models?.[0]?.id || '').trim()
      if (!nextModel) throw new Error('请选择或填写模型名')
      // 激活仍走既有 custom 渠道，LLM 调用链不动
      const result = await saveLLMSettings({
        provider: 'custom',
        apiKey: record.apiKey || 'none',
        model: nextModel,
        baseURL: record.baseURL,
      })
      markActiveSupplier(record.id)
      setSupplierLastModel(record.id, nextModel)
      emitEvent('model_switched', result)
      jsonResponse(res, 200, { ok: true, ...result, supplierId: record.id, suppliers: getSupplierList().suppliers })
    } catch (err) {
      jsonResponse(res, 400, { ok: false, error: err?.message || String(err) })
    }
    return true
  }

  if (req.method === 'POST' && url.pathname === '/settings/context-window') {
    try {
      const updates = await readJsonBody(req)
      const contextWindow = setContextWindowConfig(updates)
      jsonResponse(res, 200, { ok: true, contextWindow })
    } catch (err) {
      jsonResponse(res, 400, { ok: false, error: err.message })
    }
    return true
  }

  if (req.method === 'GET' && url.pathname === '/settings/heartbeat') {
    jsonResponse(res, 200, { ok: true, heartbeat: getHeartbeatConfig() })
    return true
  }

  if (req.method === 'POST' && url.pathname === '/settings/heartbeat') {
    try {
      const body = await readJsonBody(req)
      const heartbeat = setHeartbeatConfig(body)
      refreshScheduler()
      emitEvent('heartbeat_settings_updated', heartbeat)
      jsonResponse(res, 200, { ok: true, heartbeat })
    } catch (err) {
      jsonResponse(res, 400, { ok: false, error: err.message })
    }
    return true
  }

  if (req.method === 'GET' && url.pathname === '/settings/mcp') {
    if (!checkLocalOrToken(req, res, url, requireLocalOrToken)) return true
    jsonResponse(res, 200, {
      ok: true,
      mcp: getMcpServersConfig(),
      status: getMcpStatus(),
    })
    return true
  }

  if (req.method === 'POST' && url.pathname === '/settings/mcp') {
    if (!checkLocalOrToken(req, res, url, requireLocalOrToken)) return true
    try {
      const body = await readJsonBody(req)
      const mcp = setMcpServersConfig(body)
      const status = await reconcileMcpClients()
      emitEvent('mcp_settings_updated', {
        serverCount: mcp.servers.length,
        enabledCount: mcp.servers.filter(server => server.enabled).length,
        toolCount: status.toolCount,
      })
      jsonResponse(res, 200, { ok: true, mcp, status })
    } catch (err) {
      jsonResponse(res, 400, { ok: false, error: err.message })
    }
    return true
  }

  if (req.method === 'GET' && url.pathname === '/settings/security') {
    if (!hasAllowedAccess?.(req, url)) {
      jsonResponse(res, 403, { ok: false, error: 'forbidden' })
      return true
    }
    jsonResponse(res, 200, { ok: true, security: getSecurity(), network: await getNetworkSettingsForUi() })
    return true
  }

  if (req.method === 'GET' && url.pathname === '/settings/map') {
    jsonResponse(res, 200, { ok: true, map: getMapServiceSettings() })
    return true
  }

  if (req.method === 'POST' && url.pathname === '/settings/map') {
    try {
      const body = await readJsonBody(req)
      const map = setMapServiceSettings(body)
      jsonResponse(res, 200, { ok: true, map })
    } catch (err) {
      jsonResponse(res, 400, { ok: false, error: err.message })
    }
    return true
  }

  if (req.method === 'POST' && url.pathname === '/settings/security') {
    if (!checkLocalOrToken(req, res, url, requireLocalOrToken)) return true
    try {
      const rawUpdates = await readJsonBody(req)
      let updates = rawUpdates
      // 只传 accessMode（API/脚本直接切档，未带闸门组合）时联动预设：
      // 选档即写入与前端下拉完全相同的 blockedTools/双闸门组合，回读不漂移。
      if (
        SANDBOX_MODES.includes(rawUpdates?.accessMode)
        && !Object.prototype.hasOwnProperty.call(rawUpdates, 'blockedTools')
        && !Object.prototype.hasOwnProperty.call(rawUpdates, 'fileSandbox')
        && !Object.prototype.hasOwnProperty.call(rawUpdates, 'execSandbox')
      ) {
        updates = { ...rawUpdates, ...presetSecurityPatch(rawUpdates.accessMode) }
      }
      const result = setSecurity(updates)
      const network = Object.prototype.hasOwnProperty.call(updates, 'allowLanAccess')
        ? setNetworkConfig({ allowLanAccess: !!updates.allowLanAccess })
        : getNetworkConfig()
      jsonResponse(res, 200, {
        ok: true,
        security: result,
        network: network.allowLanAccess ? await getNetworkSettingsForUi() : network,
      })
    } catch (err) {
      jsonResponse(res, 400, { ok: false, error: err.message })
    }
    return true
  }

  if (req.method === 'GET' && url.pathname === '/settings/social') {
    jsonResponse(res, 200, { ok: true, social: getSocialConfig() })
    return true
  }

  if (req.method === 'POST' && url.pathname === '/settings/social') {
    try {
      const updates = await readJsonBody(req)
      const feishuTouched = ('FEISHU_APP_ID' in updates) || ('FEISHU_APP_SECRET' in updates)
      const feishuChanged = feishuTouched && (
        (updates.FEISHU_APP_ID || '') !== (process.env.FEISHU_APP_ID || '') ||
        (updates.FEISHU_APP_SECRET || '') !== (process.env.FEISHU_APP_SECRET || '')
      )
      setSocialConfig(updates)
      const PLATFORM_KEYS = {
        discord: ['DISCORD_BOT_TOKEN'],
      }
      for (const [platform, keys] of Object.entries(PLATFORM_KEYS)) {
        if (keys.some(k => updates[k])) {
          restartConnector(platform, { pushMessage, emitEvent }).catch(err =>
            console.warn(`[social] restart ${platform} failed:`, err.message)
          )
        }
      }
      if (feishuChanged && process.env.FEISHU_APP_ID && process.env.FEISHU_APP_SECRET) {
        restartConnector('feishu', { pushMessage, emitEvent }).catch(err =>
          console.warn('[social] restart feishu failed:', err.message)
        )
      }
      if (updates._clawbot_connect) {
        restartConnector('wechat-clawbot', { pushMessage, emitEvent }).catch(err =>
          console.warn('[social] restart wechat-clawbot failed:', err.message)
        )
      }
      if (updates._feishu_disconnect) {
        restartConnector('feishu', { pushMessage, emitEvent }).catch(err =>
          console.warn('[social] restart feishu failed:', err.message)
        )
      }
      jsonResponse(res, 200, { ok: true, social: getSocialConfig() })
    } catch (err) {
      jsonResponse(res, 400, { ok: false, error: err.message })
    }
    return true
  }

  if (req.method === 'POST' && url.pathname === '/settings/minimax') {
    try {
      const { apiKey } = await readJsonBody(req)
      const trimmed = String(apiKey || '').trim()
      if (!trimmed) throw new Error('API key cannot be empty')
      setMinimaxKey(trimmed)
      replaceProvider(new MinimaxProvider({ apiKey: trimmed }))
      jsonResponse(res, 200, { ok: true, configured: true })
    } catch (err) {
      jsonResponse(res, 400, { ok: false, error: err.message })
    }
    return true
  }

  // VANKIT / OpenAI 兼容图像端点（生图备选）
  //
  // 与 MiniMax 那条的差别：这里**先保存再热注册**，并且保存本身不要求 key 非空
  // （清空 = 取消这条备选，是合法操作）。注册时**不清掉 MiniMax**——两条通道并存，
  // 由注册顺序决定优先级（MiniMax 先注册即优先），所以配置 VANKIT 不会让
  // 原本用 MiniMax 生图的用户被换掉。
  if (req.method === 'POST' && url.pathname === '/settings/vankit') {
    try {
      const body = await readJsonBody(req)
      const saved = setVankitConfig({
        apiKey: body?.apiKey,
        baseURL: body?.baseURL,
        model: body?.model,
      })
      if (saved.configured) {
        replaceProvider(new VankitProvider({
          apiKey: saved.apiKey,
          baseURL: saved.baseURL,
          model: saved.model,
        }))
      }
      jsonResponse(res, 200, {
        ok: true,
        configured: saved.configured,
        baseURL: saved.baseURL,
        model: saved.model,
      })
    } catch (err) {
      jsonResponse(res, 400, { ok: false, error: err.message })
    }
    return true
  }

  if (req.method === 'GET' && url.pathname === '/settings/voice') {
    jsonResponse(res, 200, { ok: true, voice: getVoiceConfig() })
    return true
  }

  if (req.method === 'POST' && url.pathname === '/settings/voice') {
    try {
      const body = await readJsonBody(req)
      setVoiceConfig(body)
      jsonResponse(res, 200, { ok: true, voice: getVoiceConfig() })
    } catch (err) {
      jsonResponse(res, 400, { ok: false, error: err.message })
    }
    return true
  }

  if (req.method === 'GET' && url.pathname === '/settings/tts') {
    jsonResponse(res, 200, { ok: true, tts: getTTSConfig(), providers: TTS_PROVIDERS, voices: TTS_VOICES })
    return true
  }

  if (req.method === 'POST' && url.pathname === '/settings/tts') {
    try {
      const body = await readJsonBody(req)
      setTTSConfig(body)
      jsonResponse(res, 200, { ok: true, tts: getTTSConfig() })
    } catch (err) {
      jsonResponse(res, 400, { ok: false, error: err.message })
    }
    return true
  }

  if (req.method === 'GET' && url.pathname === '/settings/embedding') {
    jsonResponse(res, 200, {
      ok: true,
      embedding: getEmbeddingConfig(),
      presets: EMBEDDING_PROVIDER_PRESETS,
    })
    return true
  }

  if (req.method === 'POST' && url.pathname === '/settings/embedding') {
    try {
      const body = await readJsonBody(req)
      setEmbeddingConfig(body)
      try {
        const { clearEmbeddingCache } = await import('../../embedding.js')
        clearEmbeddingCache()
      } catch {}
      try {
        const { getEmbeddingCredentials } = await import('../../config.js')
        const cred = getEmbeddingCredentials()
        if (cred?.provider === 'local' && cred.model) {
          const { warmupLocalEmbedding } = await import('../../embedding-local.js')
          warmupLocalEmbedding(cred.model).catch(() => {})
        }
      } catch {}
      jsonResponse(res, 200, { ok: true, embedding: getEmbeddingConfig() })
    } catch (err) {
      jsonResponse(res, 400, { ok: false, error: err.message })
    }
    return true
  }

  return false
}
