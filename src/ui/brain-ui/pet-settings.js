// 桌宠的**集成点**：设置区段 + 对话输入预填。
//
// 两个挂载点（契约 3.10）：
//   - `settings.section`        id `dsh-tauri-pet-settings`  order 230
//   - `conversation.input.left` id `dsh-tauri-pet-prefill`   order 230  priority 0
//
// **预填文案逐字**：`/hatch-dsh-pet 根据你对我的了解，养一只宠物`
// （不许改标点、不许改空格——它是一条要被用户直接采用的命令）
//
// 诚实边界：本文件**不与某个具体插件系统耦合**。DSH 的 slot 注册走的是它的
// cordis 插件运行时；爱丽丝没有同名运行时，所以这里提供的是**与 DSH 同形的
// 描述符 + 幂等的 DOM 挂载函数**：描述符（id / order / priority）逐字保持，
// 挂载行为按爱丽丝现有的 DOM 约定实现。**未接入爱丽丝设置页宿主**——见报告。

/** 预填文案：**逐字**，一个字符都不能差（含那个空格）。 */
export const PET_PREFILL_TEXT = '/hatch-dsh-pet 根据你对我的了解，养一只宠物'

/** 设置区段描述符（与 DSH 契约逐字同形）。 */
export const PET_SETTINGS_SECTION = Object.freeze({
  slot: 'settings.section',
  id: 'dsh-tauri-pet-settings',
  order: 230,
})

/** 输入预填描述符（与 DSH 契约逐字同形）。 */
export const PET_PREFILL_SLOT = Object.freeze({
  slot: 'conversation.input.left',
  id: 'dsh-tauri-pet-prefill',
  order: 230,
  priority: 0,
})

/** DOM 标记（与 DSH 的 data-* 命名同风格，便于外部脚本识别，也便于测试断言存在性）。 */
export const PET_DOM = Object.freeze({
  settings: 'data-dsh-tauri-pet-settings',
  prefill: 'data-dsh-tauri-pet-prefill',
})

/**
 * 生成设置区段的 DOM 结构描述。
 * 纯数据，不碰 DOM——这样它可以被单测（本环境没有浏览器，DOM 渲染无法验证）。
 */
export function buildSettingsSectionModel(state = {}) {
  const enabled = state.enabled === true
  const size = Number.isFinite(Number(state.pet_size)) ? Number(state.pet_size) : 100
  const activePet = typeof state.active_pet === 'string' ? state.active_pet : ''
  return {
    id: PET_SETTINGS_SECTION.id,
    order: PET_SETTINGS_SECTION.order,
    title: '桌宠',
    // 如实描述它是什么——不是装饰，是推理流的可视化
    description: '把 agent 的推理流显示成一只宠物：在搜索 / 编辑 / 测试 / 执行命令，正在想什么，做到哪了。',
    fields: [
      { key: 'enabled', type: 'boolean', label: '启用桌宠', value: enabled },
      {
        key: 'pet_size',
        type: 'range',
        label: '尺寸',
        value: size,
        min: 50,
        max: 200,
        step: 5,
      },
      {
        key: 'active_pet',
        type: 'select',
        label: '当前宠物',
        value: activePet,
        // 三路来源：presetPets / chatPets / codexPets
        sources: ['preset', 'chat', 'codex'],
        options: [],
      },
    ],
    // 没有内置资产这件事必须出现在界面上，不能让用户以为是坏了
    notice: '未内置宠物图片资产；可在 pets/{preset,chat,codex}/<名称>/ 放入 sprite.png 后从列表选择。',
  }
}

/**
 * 生成输入预填模型（纯数据）。
 * `text` 逐字为契约要求的那句命令。
 */
export function buildPrefillModel() {
  return {
    id: PET_PREFILL_SLOT.id,
    order: PET_PREFILL_SLOT.order,
    priority: PET_PREFILL_SLOT.priority,
    text: PET_PREFILL_TEXT,
  }
}

/** 判断预填文案是否与契约逐字一致（供健康检查/测试用）。 */
export function isPrefillTextVerbatim(value) {
  return value === PET_PREFILL_TEXT
}

/**
 * 幂等挂载设置区段。**未接入爱丽丝设置页宿主**：
 * 调用方需要显式传入宿主容器；本函数只负责建节点与打标记，不做路由/生命周期管理。
 *
 * @returns 卸载函数；宿主容器为 null 时返回 no-op。
 */
export function mountSettingsSection(doc, container, state) {
  if (!doc || !container) return () => {}
  const existing = doc.querySelector(`[${PET_DOM.settings}]`)
  if (existing) existing.remove()

  const section = doc.createElement('section')
  section.setAttribute(PET_DOM.settings, PET_SETTINGS_SECTION.id)
  section.dataset.order = String(PET_SETTINGS_SECTION.order)

  const model = buildSettingsSectionModel(state)
  const heading = doc.createElement('h3')
  heading.textContent = model.title
  section.appendChild(heading)

  const desc = doc.createElement('p')
  desc.className = 'dsh-tauri-pet-description'
  desc.textContent = model.description
  section.appendChild(desc)

  const notice = doc.createElement('p')
  notice.className = 'dsh-tauri-pet-notice'
  notice.textContent = model.notice
  section.appendChild(notice)

  for (const field of model.fields) {
    const row = doc.createElement('div')
    row.className = 'dsh-tauri-pet-field'
    row.setAttribute('data-field', field.key)
    row.textContent = `${field.label}`
    section.appendChild(row)
  }

  container.appendChild(section)
  return () => {
    if (section.parentNode) section.parentNode.removeChild(section)
  }
}

/**
 * 幂等挂载输入预填按钮。点击后把**逐字**文案交给宿主提供的 `onPick`。
 */
export function mountPrefillButton(doc, container, onPick) {
  if (!doc || !container) return () => {}
  const existing = doc.querySelector(`[${PET_DOM.prefill}]`)
  if (existing) existing.remove()

  const model = buildPrefillModel()
  const button = doc.createElement('button')
  button.type = 'button'
  button.setAttribute(PET_DOM.prefill, model.id)
  button.dataset.order = String(model.order)
  button.dataset.priority = String(model.priority)
  button.title = model.text
  button.textContent = '🐴'
  button.addEventListener('click', () => {
    if (typeof onPick === 'function') onPick(model.text)
  })

  container.appendChild(button)
  return () => {
    if (button.parentNode) button.parentNode.removeChild(button)
  }
}
