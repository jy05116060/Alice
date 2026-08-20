// 输入框正上方的两张卡：越权申请卡 + 提问卡。
//
// 机制与布局复刻 DeepSeek Harness Desktop：
//   · dsh-client-ui-approval      → 申请卡（.mna1RW_*）
//   · dsh-client-ui-user-questions → 提问卡（.Mbwy4a_*）
// 两张卡都占用 composer 正上方的插槽（DSH 的 conversation.composer 接管），
// 不挤进输入框内部。
//
// 后端契约（本机同源）：
//   GET  /interaction/pending          → { pending: [view] }   刷新页面后恢复
//   POST /interaction/:id/answer       → 申请卡 { outcome }；提问卡 { answers }
//   POST /interaction/:id/cancel       → 放弃整组
// SSE：interaction_request 新增一张卡；interaction_settled 撤掉一张卡。

const SLOT_ID = 'interaction-slot'

const cards = new Map() // id → { el, view }

function slot() {
  let el = document.getElementById(SLOT_ID)
  if (el) return el
  const row = document.getElementById('input-row')
  if (!row || !row.parentNode) return null
  el = document.createElement('div')
  el.id = SLOT_ID
  el.className = 'interaction-slot'
  row.parentNode.insertBefore(el, row)
  return el
}

function el(tag, className, text) {
  const node = document.createElement(tag)
  if (className) node.className = className
  if (text != null) node.textContent = text
  return node
}

async function post(path, body) {
  const res = await fetch(path, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body || {}),
  })
  let payload = null
  try { payload = await res.json() } catch { payload = null }
  if (!res.ok) {
    throw new Error(payload?.error || `HTTP ${res.status}`)
  }
  return payload
}

function removeCard(id) {
  const entry = cards.get(id)
  if (!entry) return
  entry.el.remove()
  cards.delete(id)
}

// ── 申请卡（对齐 dsh-client-ui-approval 的 ApprovalPanel）────────────────────
// 结构：root > card > [ strip(圆点 + 等待审批), body(headline + command + suggestion), actionRow(拒绝 / 允许一次) ]
// 正文按 DSH 的四问顺序排：申请什么权限 → 为什么要 → 放行后做什么 → 放行意味着什么。
function renderApproval(view) {
  const root = el('div', 'ia-root')
  root.dataset.interactionId = view.id

  const card = el('div', 'ia-card')

  const strip = el('div', 'ia-strip')
  strip.append(el('span', 'ia-dot'), el('span', null, '等待审批'))
  card.appendChild(strip)

  const body = el('div', 'ia-body')
  body.setAttribute('role', 'group')
  body.setAttribute('aria-label', '审批详情')
  const toolZh = view.toolLabel || view.toolName || '未知工具'
  const permZh = view.permissionLabel || (toolZh + '权限')

  // ① 申请的是什么权限
  body.appendChild(el('div', 'ia-perm', '申请权限：' + permZh))
  // ② 为什么申请
  body.appendChild(el('div', 'ia-headline',
    view.reason || ('Agent 请求执行「' + toolZh + '」')))
  // ③ 放行后要做什么（真实命令 / 参数）—— 附复制按钮，用户要拿去核对
  if (view.detail) {
    body.appendChild(el('div', 'ia-command-label', '放行后将执行'))
    const cmdRow = el('div', 'ia-command-row')
    cmdRow.appendChild(el('div', 'ia-command', view.detail))
    const copyBtn = el('button', 'ia-copy-btn', '复制')
    copyBtn.type = 'button'
    copyBtn.title = '复制这段内容'
    copyBtn.addEventListener('click', async () => {
      try {
        await navigator.clipboard.writeText(view.detail)
      } catch { /* 剪贴板不可用时只给视觉反馈 */ }
      copyBtn.textContent = '已复制'
      setTimeout(() => { if (copyBtn.isConnected) copyBtn.textContent = '复制' }, 1200)
    })
    cmdRow.appendChild(copyBtn)
    body.appendChild(cmdRow)
  }
  // ④ 放行意味着什么
  if (view.suggestion) body.appendChild(el('div', 'ia-suggestion', view.suggestion))
  card.appendChild(body)

  const actions = el('div', 'ia-action-row')
  const optionList = Array.isArray(view.options) && view.options.length
    ? view.options
    : [
      { value: 'rejected', label: '拒绝', recommended: false },
      { value: 'allowed-once', label: '允许一次', recommended: false },
    ]
  const buttons = []
  for (const opt of optionList) {
    const isAllow = opt.value === 'allowed-once'
    const btn = el('button',
      'ia-btn ' + (isAllow ? 'ia-btn-primary' : 'ia-btn-outline') + (isAllow ? '' : ' ia-reject'),
      opt.label || (isAllow ? '允许一次' : '拒绝'))
    btn.type = 'button'
    if (opt.recommended) {
      btn.classList.add('ia-btn-recommended')
      btn.appendChild(el('span', 'ia-btn-badge', '建议'))
    }
    btn.addEventListener('click', () => settle(opt.value, btn))
    buttons.push(btn)
    actions.appendChild(btn)
  }
  card.appendChild(actions)

  root.appendChild(card)

  async function settle(outcome, btn) {
    for (const b of buttons) b.disabled = true
    const original = btn.textContent
    btn.textContent = '提交中…'
    try {
      await post(`/interaction/${encodeURIComponent(view.id)}/answer`, { outcome })
      removeCard(view.id)
    } catch (err) {
      for (const b of buttons) b.disabled = false
      btn.textContent = original
      root.dataset.error = err?.message || '提交失败'
    }
  }

  return root
}

// ── 提问卡（对齐 dsh-client-ui-user-questions）──────────────────────────────
// 结构：frame > card > [ header(eyebrow + title + 收起/放弃), body(options), footer(上一题/下一题/提交) ]
function renderQuestion(view) {
  const questions = Array.isArray(view.questions) ? view.questions : []
  const frame = el('div', 'ia-root ia-q-root')
  frame.dataset.interactionId = view.id

  const card = el('div', 'ia-q-card')
  const header = el('div', 'ia-q-header')
  const headBlock = el('div', 'ia-q-heading-block')

  const headerActions = el('div', 'ia-q-header-actions')
  const minimize = el('button', 'ia-q-icon-btn', '⌄')
  minimize.type = 'button'
  minimize.title = '收起问题卡片'
  const cancelBtn = el('button', 'ia-q-icon-btn', '✕')
  cancelBtn.type = 'button'
  cancelBtn.title = '放弃整组问题'
  headerActions.append(minimize, cancelBtn)

  header.append(headBlock, headerActions)
  card.appendChild(header)

  const body = el('div', 'ia-q-body')
  card.appendChild(body)

  const footer = el('div', 'ia-q-footer')
  const pager = el('div', 'ia-q-pager')
  const prevBtn = el('button', 'ia-q-icon-btn', '‹')
  prevBtn.type = 'button'
  prevBtn.title = '上一题'
  const progress = el('span', 'ia-q-progress', '')
  const nextBtn = el('button', 'ia-q-icon-btn', '›')
  nextBtn.type = 'button'
  nextBtn.title = '下一题'
  pager.append(prevBtn, progress, nextBtn)

  const footerActions = el('div', 'ia-q-footer-actions')
  const skipBtn = el('button', 'ia-btn ia-btn-outline', '跳过本题')
  skipBtn.type = 'button'
  const submitBtn = el('button', 'ia-btn ia-btn-primary', '提交')
  submitBtn.type = 'button'
  footerActions.append(skipBtn, submitBtn)

  footer.append(pager, footerActions)
  card.appendChild(footer)
  frame.appendChild(card)

  // 每题一份作答草稿
  const draft = questions.map(q => ({ id: q.id, selected: [], custom: '' }))
  let index = 0

  // 选项容器与自定义输入框只建一次、常驻 body：
  // 重绘只换选项行，输入框不重建也不挪位，所以点选项不会丢掉输入焦点和光标。
  const list = el('div', 'ia-q-options')
  const customRow = el('div', 'ia-q-custom')
  const customInput = document.createElement('input')
  customInput.type = 'text'
  customInput.className = 'ia-q-custom-input'
  customInput.placeholder = '输入你的答案'
  customInput.addEventListener('input', () => {
    draft[index].custom = customInput.value
    clearError()
  })
  customInput.addEventListener('keydown', ev => {
    if (ev.key === 'Enter' && !ev.shiftKey) {
      ev.preventDefault()
      if (index < questions.length - 1) { index += 1; paint() } else submit()
    }
  })
  customRow.appendChild(customInput)
  body.append(list, customRow)

  const isAnswered = (d) => d.selected.length > 0 || Boolean(d.custom && d.custom.trim())
  const clearError = () => { if (frame.dataset.error) delete frame.dataset.error }

  const paint = () => {
    const q = questions[index]
    if (!q) return
    // 后端 tools/interaction.js 规范化后给的是 camelCase multiSelect；
    // 模型原始 schema 是 snake_case multi_select。两个都认，否则多选永远退化成单选。
    const multi = q.multiSelect === true || q.multi_select === true

    headBlock.replaceChildren(
      el('div', 'ia-q-eyebrow', q.header || '需要你确认'),
      el('h3', 'ia-q-title', q.question || ''),
    )

    const options = Array.isArray(q.options) ? q.options : []
    const entry = draft[index]

    list.replaceChildren()
    options.forEach((opt, i) => {
      const label = String(opt?.label ?? '')
      const selected = entry.selected.includes(label)
      const row = el('button', 'ia-q-option' + (selected ? ' ia-q-option-selected' : ''))
      row.type = 'button'
      row.append(
        el('span', multi ? 'ia-q-checkbox' : 'ia-q-number', multi ? '' : String(i + 1)),
      )
      const textWrap = el('span', 'ia-q-option-text')
      const labelEl = el('span', 'ia-q-option-label', label)
      if (/(\(Recommended\)|（推荐）)$/.test(label)) {
        labelEl.appendChild(el('span', 'ia-q-badge', '推荐'))
      }
      textWrap.appendChild(labelEl)
      if (opt?.description) textWrap.appendChild(el('span', 'ia-q-option-desc', String(opt.description)))
      row.appendChild(textWrap)
      row.addEventListener('click', () => {
        if (multi) {
          entry.selected = selected
            ? entry.selected.filter(v => v !== label)
            : [...entry.selected, label]
        } else {
          entry.selected = [label]
        }
        clearError()
        paint()
      })
      list.appendChild(row)
    })

    // 复用同一个输入框：只在值真的变了时写回，避免把光标顶到末尾
    const want = entry.custom || ''
    if (customInput.value !== want) customInput.value = want
    customInput.placeholder = options.length ? '也可以自己填写答案' : '输入你的答案'

    // 进度带上「本题是否已答」，翻页时一眼看出哪题还空着
    progress.textContent = `${isAnswered(entry) ? '✓ ' : ''}${index + 1}/${questions.length}`
    prevBtn.disabled = index === 0
    nextBtn.disabled = index >= questions.length - 1
    skipBtn.hidden = questions.length <= 1
    submitBtn.textContent = index >= questions.length - 1 ? '提交' : '下一题'
  }

  const submit = async () => {
    const answers = draft
      .map((d, i) => ({
        id: d.id,
        selected: d.selected,
        ...(d.custom && d.custom.trim() ? { custom: d.custom.trim() } : {}),
      }))
      .filter(a => a.selected.length > 0 || a.custom)
    if (answers.length === 0) {
      frame.dataset.error = '请选择一个选项或填写自定义答案'
      return
    }
    submitBtn.disabled = true
    try {
      await post(`/interaction/${encodeURIComponent(view.id)}/answer`, { answers })
      removeCard(view.id)
    } catch (err) {
      submitBtn.disabled = false
      frame.dataset.error = err?.message || '提交失败'
    }
  }

  const goTo = (next) => { clearError(); index = next; paint() }
  prevBtn.addEventListener('click', () => { if (index > 0) goTo(index - 1) })
  nextBtn.addEventListener('click', () => { if (index < questions.length - 1) goTo(index + 1) })
  submitBtn.addEventListener('click', () => {
    if (index < questions.length - 1) goTo(index + 1)
    else submit()
  })
  skipBtn.addEventListener('click', () => {
    if (index < questions.length - 1) { goTo(index + 1); return }
    // 最后一题：只有已经答过至少一题才允许收尾。否则 submit() 会因为
    // answers 为空被后端 400 拒掉，按钮看起来像「点了没反应」的死键。
    if (draft.some(isAnswered)) submit()
    else frame.dataset.error = '至少要回答一题才能提交；想整组跳过请点右上角 ✕'
  })
  cancelBtn.addEventListener('click', async () => {
    try { await post(`/interaction/${encodeURIComponent(view.id)}/cancel`, {}) } catch { /* 已结束 */ }
    removeCard(view.id)
  })
  minimize.addEventListener('click', () => {
    const collapsed = card.classList.toggle('ia-q-card-minimized')
    minimize.textContent = collapsed ? '⌃' : '⌄'
    minimize.title = collapsed ? '展开问题卡片' : '收起问题卡片'
  })

  paint()
  return frame
}

function addCard(view, attempt = 0) {
  if (!view?.id || cards.has(view.id)) return
  const host = slot()
  if (!host) {
    // app-shell 生成 #input-row 的时机可能晚于本模块 boot，此时不能把卡丢掉
    if (attempt < 25) setTimeout(() => addCard(view, attempt + 1), 120)
    return
  }
  const node = view.kind === 'approval' ? renderApproval(view) : renderQuestion(view)
  host.appendChild(node)
  cards.set(view.id, { el: node, view })
}

async function restore() {
  try {
    const res = await fetch('/interaction/pending')
    if (!res.ok) return
    const payload = await res.json()
    for (const view of payload?.pending || []) addCard(view)
  } catch { /* 后端未就绪 */ }
}

function boot() {
  window.addEventListener('blm:sse', event => {
    const { type, data } = event.detail || {}
    if (type === 'interaction_request') addCard(data)
    else if (type === 'interaction_settled') removeCard(data?.id)
  })
  restore()
}

if (document.readyState === 'complete' || document.readyState === 'interactive') boot()
else window.addEventListener('DOMContentLoaded', boot, { once: true })
