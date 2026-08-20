import { getConfig } from '../db.js'

const DEFAULT_AGENT_NAME = '小白龙'

export function getAgentName() {
  return (getConfig('agent_name') || '').trim() || DEFAULT_AGENT_NAME
}

export function validateAgentName(agentName) {
  const trimmedName = String(agentName || '').trim()
  if (!trimmedName) return ''
  if (trimmedName.length > 32) {
    throw new Error('AI 名字不能超过 32 个字符')
  }
  if (!/^[一-龥A-Za-z0-9 _-]+$/.test(trimmedName)) {
    throw new Error('AI 名字只允许中文、英文字母、数字、空格、下划线、短横线')
  }
  return trimmedName
}
