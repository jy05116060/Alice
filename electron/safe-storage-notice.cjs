'use strict'

const fs = require('node:fs')
const path = require('node:path')

const NOTICE_TITLE = 'Alice 安全存储说明'
const CONSENT_VERSION = 1
const KNOWN_PURPOSES = new Set(['browser-profile', 'saved-secrets'])

function noticeContent(purpose = 'secure-data') {
  if (purpose === 'browser-profile') {
    return {
      message: '是否启用受保护的浏览器登录状态？',
      detail: [
        'Alice 即将使用 macOS 钥匙串读取和保存自带浏览器的 Cookie、会话及网站登录状态。',
        'macOS 随后可能要求输入你的 Mac 登录密码。密码只由 macOS 验证，Alice 无法读取，也不会上传。',
        '如果暂不使用安全存储，仍可继续浏览网页，但将使用本次运行的临时会话，退出后不保留网站登录状态。',
      ].join('\n\n'),
      continueLabel: '继续使用浏览器',
    }
  }

  return {
    message: 'Alice 需要访问受保护的本地密钥',
    detail: [
      '此操作用于加密或读取你已保存的 API 密钥、访问令牌等本地机密信息。',
      'macOS 随后可能要求输入你的 Mac 登录密码。密码只由 macOS 验证，Alice 无法读取，也不会上传。',
      '如果暂不使用安全存储，新密钥会改用权限受限的本地文件加密；已有的钥匙串加密内容暂时无法读取。',
    ].join('\n\n'),
    continueLabel: '继续访问密钥',
  }
}

function createSafeStorageNotice({
  dialog,
  platform = process.platform,
  parentWindow = () => null,
  consentFile = '',
  logger = console,
} = {}) {
  if (!dialog) throw new TypeError('dialog is required')

  const acknowledgedPurposes = new Set()
  const pendingByPurpose = new Map()

  if (consentFile) {
    try {
      const stat = fs.statSync(consentFile)
      if (stat.isFile() && stat.size > 0 && stat.size <= 16 * 1024) {
        const saved = JSON.parse(fs.readFileSync(consentFile, 'utf8'))
        if (saved?.version === CONSENT_VERSION && Array.isArray(saved.acknowledgedPurposes)) {
          for (const purpose of saved.acknowledgedPurposes) {
            if (KNOWN_PURPOSES.has(purpose)) acknowledgedPurposes.add(purpose)
          }
        }
      }
    } catch (error) {
      if (error?.code !== 'ENOENT') {
        logger.warn?.('[safe-storage] unable to read consent preference:', error?.message || error)
      }
    }
  }

  function persistAcknowledgement() {
    if (!consentFile) return
    try {
      fs.mkdirSync(path.dirname(consentFile), { recursive: true })
      const temporary = `${consentFile}.tmp`
      fs.writeFileSync(temporary, JSON.stringify({
        version: CONSENT_VERSION,
        acknowledgedPurposes: [...acknowledgedPurposes].filter(purpose => KNOWN_PURPOSES.has(purpose)),
      }, null, 2), { encoding: 'utf8', mode: 0o600 })
      try { fs.chmodSync(temporary, 0o600) } catch {}
      fs.renameSync(temporary, consentFile)
    } catch (error) {
      logger.warn?.('[safe-storage] unable to persist consent preference:', error?.message || error)
    }
  }

  function options(purpose) {
    const content = noticeContent(purpose)
    return {
      type: 'info',
      title: NOTICE_TITLE,
      message: content.message,
      detail: content.detail,
      buttons: [content.continueLabel, '不使用安全存储'],
      defaultId: 0,
      cancelId: 1,
      noLink: true,
    }
  }

  async function request(purpose) {
    const key = String(purpose || 'secure-data')
    if (platform !== 'darwin' || acknowledgedPurposes.has(key)) return true
    if (pendingByPurpose.has(key)) return pendingByPurpose.get(key)
    const pending = Promise.resolve()
      .then(async () => {
        const owner = parentWindow()
        const result = owner
          ? await dialog.showMessageBox(owner, options(key))
          : await dialog.showMessageBox(options(key))
        if (result?.response !== 0) return false
        acknowledgedPurposes.add(key)
        persistAcknowledgement()
        return true
      })
      .finally(() => { pendingByPurpose.delete(key) })
    pendingByPurpose.set(key, pending)
    return pending
  }

  function requestSync(purpose) {
    const key = String(purpose || 'secure-data')
    if (platform !== 'darwin' || acknowledgedPurposes.has(key)) return true
    const owner = parentWindow()
    const response = owner
      ? dialog.showMessageBoxSync(owner, options(key))
      : dialog.showMessageBoxSync(options(key))
    if (response !== 0) return false
    acknowledgedPurposes.add(key)
    persistAcknowledgement()
    return true
  }

  return {
    request,
    requestSync,
    isAcknowledged: purpose => acknowledgedPurposes.has(String(purpose || 'secure-data')),
  }
}

module.exports = {
  CONSENT_VERSION,
  NOTICE_TITLE,
  createSafeStorageNotice,
  noticeContent,
}
