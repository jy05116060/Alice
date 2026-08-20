import { config } from '../../config.js'
import { getLastUsage } from '../../llm.js'
import { jsonResponse } from '../utils.js'

// ── 用量 / 余额路由 ───────────────────────────────────────────────
// 两个都是「拉取式」通道，用来兜住 SSE 可能丢失的场景：
//   GET /usage-last  最近一次 LLM 调用的真实 usage（llm.js 内存里记着）
//   GET /balance     当前 provider 的账户余额
//
// 余额：目前只有 DeepSeek 官方提供 /user/balance 这类接口。
// 其它 provider 没有统一约定，如实返回 unsupported，绝不编造数字。

const BALANCE_TTL_MS = 60 * 1000
let balanceCache = { at: 0, payload: null }

function providerSupportsBalance(provider) {
  return provider === 'deepseek'
}

async function fetchDeepseekBalance() {
  const key = String(config.apiKey || '').trim()
  if (!key || key === 'none') return { ok: false, error: 'LLM 尚未激活' }
  const base = String(config.baseURL || 'https://api.deepseek.com').replace(/\/+$/, '')
  const res = await fetch(`${base}/user/balance`, {
    headers: { Authorization: `Bearer ${key}`, Accept: 'application/json' },
  })
  if (!res.ok) return { ok: false, error: `余额接口返回 ${res.status}` }
  const data = await res.json()
  const info = Array.isArray(data?.balance_infos) ? data.balance_infos[0] : null
  if (!info) return { ok: false, error: '余额接口未返回 balance_infos' }
  return {
    ok: true,
    provider: 'deepseek',
    currency: String(info.currency || 'CNY'),
    total: Number(info.total_balance) || 0,
    granted: Number(info.granted_balance) || 0,
    toppedUp: Number(info.topped_up_balance) || 0,
    available: data?.is_available !== false,
  }
}

export async function handleUsageRoutes(req, res, url) {
  if (req.method === 'GET' && url.pathname === '/usage-last') {
    jsonResponse(res, 200, { ok: true, usage: getLastUsage() })
    return true
  }

  if (req.method === 'GET' && url.pathname === '/balance') {
    const provider = String(config.provider || '')
    if (!providerSupportsBalance(provider)) {
      jsonResponse(res, 200, { ok: false, unsupported: true, provider })
      return true
    }
    const now = Date.now()
    if (balanceCache.payload && now - balanceCache.at < BALANCE_TTL_MS) {
      jsonResponse(res, 200, balanceCache.payload)
      return true
    }
    try {
      const payload = await fetchDeepseekBalance()
      balanceCache = { at: now, payload }
      jsonResponse(res, 200, payload)
    } catch (err) {
      jsonResponse(res, 200, { ok: false, error: String(err?.message || err) })
    }
    return true
  }

  return false
}
