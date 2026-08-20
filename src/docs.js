// 文档面板管理模块
// 类似 hotspots.js 的面板状态 + TTL 上下文注入机制
import { DOC_TOPICS as VOICE_TOPICS, detectDocTopic as detectVoiceTopic } from './docs/voice-config-faq.js'
import { CONFIG_TOPICS } from './docs/config-faq.js'
import { SELF_KNOWLEDGE_TOPICS, detectSelfKnowledgeTopic } from './docs/self-knowledge.js'

// 合并所有文档主题
const DOC_TOPICS = { ...VOICE_TOPICS, ...CONFIG_TOPICS, ...SELF_KNOWLEDGE_TOPICS }

function formatDocAsContext(topicId) {
  const doc = DOC_TOPICS[topicId]
  if (!doc) return ''
  const lines = [`## Reference Document: ${doc.title}`, doc.summary, '']
  for (const section of doc.sections) {
    lines.push(`### ${section.title}`)
    lines.push(section.content)
    lines.push('')
  }
  if (doc.providers?.length > 0) {
    lines.push('### Providers')
    for (const p of doc.providers) {
      lines.push(`- **${p.name}**${p.free ? ' (free quota available)' : ''}: ${p.note} - ${p.url}`)
    }
  }
  return lines.join('\n')
}

// 根据用户消息检测应打开的文档主题（意图识别，无需穷举关键词）
function detectDocTopic(text) {
  if (!text) return null
  const selfTopic = detectSelfKnowledgeTopic(text)
  if (selfTopic) return selfTopic

  const voiceTopic = detectVoiceTopic(text)
  if (voiceTopic) return voiceTopic

  const t = text.toLowerCase()

  // 模型 / LLM 配置
  if (/(模型|model|llm|provider|api.?key|密钥|激活|切换模型|配置.*(deepseek|minimax|qwen|openai|moonshot|zhipu|claude|gemini|mimo|小米)|deepseek|minimax.*配置|qwen.*配置|mimo.*配置|小米.*配置|自定义.*端点|base.?url)/.test(t)) {
    return 'model_config'
  }

  // 微信 / 社交平台配置
  if (/(微信|wechat|公众号|企业微信|wecom|clawbot|飞书|feishu|discord|社交|配置.*机器人|机器人.*配置|接入.*平台|平台.*接入)/.test(t)) {
    return 'wechat_config'
  }

  return null
}

const DOC_CONTEXT_TTL_MINUTES = 30

let panelState = {
  active: false,
  topicId: null,    // 当前显示的文档主题 ID
  updatedAtMs: 0,
  source: 'startup',
}
let contextActiveUntilMs = 0

export function noteDocPanelViewed(topicId) {
  contextActiveUntilMs = Date.now() + DOC_CONTEXT_TTL_MINUTES * 60 * 1000
  setDocPanelState({ active: true, topicId, source: 'viewed' })
}

export function setDocPanelState({ active, topicId = null, source = 'unknown' } = {}) {
  if (typeof active !== 'boolean') return getDocPanelState()
  panelState = {
    active,
    topicId: active ? (topicId || panelState.topicId) : panelState.topicId,
    updatedAtMs: Date.now(),
    source,
  }
  if (active) contextActiveUntilMs = Date.now() + DOC_CONTEXT_TTL_MINUTES * 60 * 1000
  return getDocPanelState()
}

export function getDocPanelState() {
  const now = Date.now()
  return {
    ...panelState,
    updatedAt: panelState.updatedAtMs ? new Date(panelState.updatedAtMs).toISOString() : null,
    contextActive: now < contextActiveUntilMs,
    contextTtlSeconds: Math.max(0, Math.round((contextActiveUntilMs - now) / 1000)),
  }
}

// 构建面板状态提示（始终注入，告知 Agent 工具可用）
// detectedTopic: 本轮消息中关键词检测到的主题（null 表示未检测到）
export function buildDocPanelStateContext(detectedTopic = null) {
  const state = getDocPanelState()
  const ttl = state.contextActive
    ? `Document context TTL has about ${Math.ceil(state.contextTtlSeconds / 60)} minutes remaining`
    : 'No active document context'

  const topicLabel = state.topicId && DOC_TOPICS[state.topicId]
    ? ` (current topic: ${DOC_TOPICS[state.topicId].title})`
    : ''

  const lines = [
    `## Document Panel State`,
    `Current document panel: ${state.active ? 'open' : 'closed'}${topicLabel}. ${ttl}.`,
    ``,
    `open_doc_panel tool rules. Follow strictly:`,
    `- Do not proactively ask the user for API keys. If the user provides a key, help configure it directly and mention that they can test it.`,
    `- Highest priority: when the user explicitly asks to open or view docs, immediately call open_doc_panel(action: "open", topic: "${state.topicId || 'voice_config'}"). No extra condition is required and you must not refuse.`,
    `- When the user needs voice, model, WeChat, or social-platform configuration help, choose the matching topic and open the panel: voice_asr, voice_tts, voice_config, model_config, or wechat_config. When the user asks about how Alice works, its code architecture, or its internal mechanisms, open self_architecture. When the user asks about Alice's interface, panels, or Scene/visual design, open ui_design.`,
    `- If the document panel is open but the current turn is unrelated to any configuration topic, immediately call open_doc_panel(topic: "${state.topicId || 'voice_config'}", action: "close") to close it.`,
  ]

  // 关键词命中时明确要求 Agent 在本轮回复前先调用工具打开面板
  if (detectedTopic && !state.active) {
    const topicName = DOC_TOPICS[detectedTopic]?.title || detectedTopic
    lines.push(`- Important: the user's current message involves "${topicName}". Before any text reply, you must first call open_doc_panel(action: "open", topic: "${detectedTopic}") to open the document panel, then answer in text. The only exception is when context clearly shows the word appeared incidentally in an unrelated topic and is not a configuration question.`)
  }

  if (detectedTopic && state.active && detectedTopic !== state.topicId) {
    const topicName = DOC_TOPICS[detectedTopic]?.title || detectedTopic
    lines.push(`- The user topic has switched to "${topicName}". Call open_doc_panel(action: "open", topic: "${detectedTopic}") to switch the panel topic.`)
  }

  return lines.join('\n')
}

// 当文档面板活跃时，将文档内容注入上下文
export function buildDocRuntimeContext(userMessage) {
  const state = getDocPanelState()
  const now = Date.now()
  if (now >= contextActiveUntilMs) return ''
  if (!state.topicId) return ''

  // 如果用户消息中有新的文档触发词，自动切换主题
  const detectedTopic = detectDocTopic(userMessage)
  const topicId = detectedTopic || state.topicId

  return formatDocAsContext(topicId)
}

// 根据用户消息自动检测是否应推送文档面板
// 返回 topicId 或 null
export { detectDocTopic }

// 导出文档主题列表（供 API 使用）
export { DOC_TOPICS }
