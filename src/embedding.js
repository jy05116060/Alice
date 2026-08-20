// Embedding module — 向量语义召回的"算 embedding"层。
//
// 设计：记忆向量召回只用本地离线模型（provider 恒为 'local'），不依赖任何云端 API。
// 真正的推理在 src/embedding-local.js（transformers.js + onnxruntime-node 跑 ONNX）。本模块只负责：
//   1. 完全 lazy init：模块加载时不做任何 IO / 推理
//   2. 任何错误都吞掉返回 null，让上层的 FTS5 召回继续工作，绝不影响主流程
//   3. 简易 LRU 缓存（Map 删除最旧项）— 不引入新依赖
//   4. 返回 Buffer（包裹 Float32Array 的字节），方便直接写入 SQLite BLOB
//
// 配置：embedding 块在 config.json 的 "embedding" 键下（仅 model / timeoutMs 有意义），
// 由 src/config.js 的 getEmbeddingCredentials 管理；缺省走本地默认模型，开箱即用零配置。

import crypto from 'crypto'
import { getEmbeddingCredentials } from './config.js'

const MAX_CACHE_ENTRIES = 200
const MIN_TEXT_LENGTH = 2

// LRU 缓存：key = sha256(text + '' + model + isQuery 标记)，value = Buffer
// 用 Map 的插入顺序近似 LRU：每次读到命中就 delete + set，让它移到尾部；
// 写入超限时删 Map.keys().next().value （最旧的 key）
const cache = new Map()

function cacheKey(text, model) {
  return crypto
    .createHash('sha256')
    .update(text + '' + (model || ''))
    .digest('hex')
}

function cacheGet(key) {
  if (!cache.has(key)) return null
  const value = cache.get(key)
  // 重新插入，bump 到尾部
  cache.delete(key)
  cache.set(key, value)
  return value
}

function cacheSet(key, value) {
  if (cache.has(key)) cache.delete(key)
  cache.set(key, value)
  while (cache.size > MAX_CACHE_ENTRIES) {
    const oldestKey = cache.keys().next().value
    if (oldestKey === undefined) break
    cache.delete(oldestKey)
  }
}

export function clearEmbeddingCache() {
  cache.clear()
}

// 是否已配置 embedding。本地模型零配置：只要拿得到 model（默认或 config 指定）即视为已配置。
// 模型未下载完成 / 包未装等运行期失败由 computeEmbedding 内部吞错返回 null，上层走 FTS5 兜底。
export function isEmbeddingConfigured() {
  try {
    const cred = getEmbeddingCredentials()
    return !!(cred && cred.model)
  } catch {
    return false
  }
}

// 向量召回的有效超时（ms）。注入器拿它做硬超时预算。
// 本地离线推理无网络方差但 CPU 慢，默认 1500ms；用户可在 config 的 embedding.timeoutMs 覆盖。
export function getEmbeddingTimeoutMs() {
  try {
    const cred = getEmbeddingCredentials()
    if (cred && Number.isFinite(cred.timeoutMs) && cred.timeoutMs > 0) return cred.timeoutMs
  } catch {}
  return 1500
}

// 主接口：本地算 embedding。
// - text 太短 / 为空 → null
// - 模型未就绪 / 推理失败 → null（静默，上层走 FTS5 兜底）
// - 成功 → Buffer (包裹 Float32Array 的字节，长度 = dim * 4)
//
// opts.isQuery：召回 query 传 true（bge 会套检索指令前缀做非对称检索）；入库 passage 传 false（默认）。
//               query/passage 向量不同（前缀不同），cacheKey 带 isQuery 区分，避免互相覆盖。
export async function computeEmbedding(text, { isQuery = false } = {}) {
  const input = typeof text === 'string' ? text : ''
  if (!input || input.length < MIN_TEXT_LENGTH) return null

  let cred
  try {
    cred = getEmbeddingCredentials()
  } catch {
    return null
  }
  if (!cred || !cred.model) return null

  const keyExtra = isQuery ? ':q' : ':p'
  const key = cacheKey(input, cred.model + keyExtra)
  const cached = cacheGet(key)
  if (cached) return cached

  let buf = null
  try {
    const { computeLocalEmbedding } = await import('./embedding-local.js')
    buf = await computeLocalEmbedding(input, { model: cred.model, isQuery })
  } catch {
    return null
  }

  if (buf) cacheSet(key, buf)
  return buf
}
