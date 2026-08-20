/* 工作区浮框：内容层直接内嵌 workspace-embed.html（演示页的逐字副本），保证与演示页完全一致。
   浮框自身只负责：屏幕最左边缘悬停唤出、标题栏拖动、关闭按钮。 */
const EMBED_SRC = '/src/ui/brain-ui/workspace-embed.html'

export function createWorkspacePanel() {
  return '<section class="workspace-float" id="workspace-float" aria-label="工作区">'
    + '<header class="workspace-float-titlebar" id="workspace-float-drag">'
    + '<span class="workspace-window-grip" aria-hidden="true">⠿</span>'

    + '<button type="button" id="workspace-float-hide" title="关闭" aria-label="关闭">×</button>'
    + '</header>'
    + '<iframe class="workspace-frame" id="workspace-frame" src="' + EMBED_SRC + '#navonly=1" title="工作区"></iframe>'
    + '</section>'
}

export function initWorkspacePanel() {
  let panel = document.getElementById('workspace-float')
  if (!panel) {
    document.body.insertAdjacentHTML('beforeend', createWorkspacePanel())
    panel = document.getElementById('workspace-float')
  }
  if (!panel) return
  const setOpen = open => {
    panel.classList.toggle('is-hidden', !open)
    document.body.classList.toggle('workspace-float-open', open)
  }
  panel.querySelector('#workspace-float-hide')?.addEventListener('click', () => setOpen(false))
  setOpen(false)

  let closeTimer = 0
  const cancelClose = () => { if (closeTimer) { clearTimeout(closeTimer); closeTimer = 0 } }
  const scheduleClose = () => { cancelClose(); closeTimer = setTimeout(() => { closeTimer = 0; setOpen(false) }, 260) }

  let hoverZone = document.getElementById('workspace-hover-zone')
  if (!hoverZone) {
    document.body.insertAdjacentHTML('beforeend', '<div class="workspace-hover-zone" id="workspace-hover-zone" aria-hidden="true"></div>')
    hoverZone = document.getElementById('workspace-hover-zone')
  }
  if (hoverZone && !hoverZone.dataset.workspaceBound) {
    hoverZone.dataset.workspaceBound = '1'
    hoverZone.addEventListener('mouseenter', () => { cancelClose(); setOpen(true) })
    hoverZone.addEventListener('mouseleave', scheduleClose)
    panel.addEventListener('mouseenter', cancelClose)
    panel.addEventListener('mouseleave', scheduleClose)
  }

  // 主题桥：浮框内容层是独立内嵌文档，主框的主题变量传不进去，
  // 把当前外观主题色主动推给它，浮框里外才是同一个颜色。
  const THEME_VARS = ['--bg0', '--bg1', '--bg-deep', '--ink', '--ink2', '--dim',
    '--line', '--line-strong', '--panel', '--panel-raised',
    '--cool', '--warm', '--ok', '--warn', '--danger']
  const themeSnapshot = () => {
    const computed = getComputedStyle(document.documentElement)
    const vars = {}
    THEME_VARS.forEach(name => {
      const value = computed.getPropertyValue(name).trim()
      if (value) vars[name] = value
    })
    return vars
  }
  const themeFrames = () => [panel.querySelector('#workspace-frame'), document.getElementById('workspace-right-swap-frame')].filter(Boolean)
  const pushTheme = () => {
    const vars = themeSnapshot()
    themeFrames().forEach(fr => {
      try { fr.contentWindow.postMessage({ type: 'bl-theme', vars }, '*') } catch (error) { void error }
    })
  }
  themeFrames().forEach(fr => {
    if (fr.dataset.themeBound) return
    fr.dataset.themeBound = '1'
    fr.addEventListener('load', pushTheme)
  })
  pushTheme()
  if (!panel.dataset.themeWatch) {
    panel.dataset.themeWatch = '1'
    window.addEventListener('message', event => {
      if (event && event.data && event.data.type === 'bl-theme-request') pushTheme()
    })
    new MutationObserver(pushTheme).observe(document.documentElement, {
      attributes: true,
      attributeFilter: ['data-theme', 'class', 'style']
    })
  }

  // 点浮框里的「定时任务 / 扩展技能」→ 主界面右边那块大框（#chat-area，带输入框的整块）
  // 整体换成对应页；左边窄框照旧占住认知界面那一格。框右上角叉号返回会话。
  const SWAP_HOST_SELECTOR = '#chat-area'
  const clearSwappedPage = () => {
    const host = document.querySelector(SWAP_HOST_SELECTOR)
    if (host) host.classList.remove('is-workspace-swapped')
    const box = document.getElementById('workspace-right-swap')
    if (box) box.remove()
  }
  const ensureSwapBox = () => {
    let box = document.getElementById('workspace-right-swap')
    if (box) return box
    box = document.createElement('section')
    box.id = 'workspace-right-swap'
    box.className = 'workspace-right-swap'
    box.setAttribute('aria-label', '工作区页面')
    box.innerHTML = '<header class="workspace-right-swap-bar">'
      + '<span class="workspace-right-swap-title" id="workspace-right-swap-title">工作区</span>'
      + '<button type="button" class="workspace-right-swap-close" id="workspace-right-swap-close" title="返回会话" aria-label="返回会话">×</button>'
      + '</header>'
      + '<iframe class="workspace-right-swap-frame" id="workspace-right-swap-frame" title="工作区页面"></iframe>'
    box.querySelector('#workspace-right-swap-close')?.addEventListener('click', clearSwappedPage)
    const swapFrame = box.querySelector('#workspace-right-swap-frame')
    if (swapFrame) swapFrame.addEventListener('load', pushTheme)
    return box
  }
  const showSwappedPage = page => {
    if (page !== 'schedule' && page !== 'skills' && page !== 'mcp' && page !== 'workspace') return
    const host = document.querySelector(SWAP_HOST_SELECTOR)
    if (!host) return
    const box = ensureSwapBox()
    const title = box.querySelector('#workspace-right-swap-title')
    if (title) title.textContent = page === 'schedule' ? '定时任务' : page === 'skills' ? '扩展技能' : page === 'mcp' ? 'MCP' : '工作区'
    if (title && page === 'workspace') title.textContent = '\u5de5\u4f5c\u533a'
    const frame = box.querySelector('#workspace-right-swap-frame')
    const src = EMBED_SRC + '#page=' + page + '&bare=1'
    if (frame && frame.getAttribute('src') !== src) frame.setAttribute('src', src)
    host.appendChild(box)
    host.classList.add('is-workspace-swapped')
  }
  if (!panel.dataset.swapWatch) {
    panel.dataset.swapWatch = '1'
    window.addEventListener('message', event => {
      const data = event && event.data
      if (!data) return
      // 内嵌页请求打开提醒面板（「提醒调度」导航项 / 定时任务页的「手动创建」）。
      // 那边是 iframe，只能靠 postMessage 过来——在自己 window 上 dispatch 父窗口听不到。
      if (data.type === 'bl-open-schedules') {
        const inner0 = panel.querySelector('#workspace-frame')
        if (inner0 && event.source && event.source !== inner0.contentWindow
          && event.source !== document.getElementById('workspace-right-swap-frame')?.contentWindow) return
        window.dispatchEvent(new CustomEvent('blm:open-schedules'))
        return
      }
      if (data.type !== 'bl-page') return
      const inner = panel.querySelector('#workspace-frame')
      // 只认浮框内嵌页发来的消息，避免页面里别的东西误触发
      if (inner && event.source && event.source !== inner.contentWindow) return
      showSwappedPage(data.page)
    })
  }

  const bar = panel.querySelector('#workspace-float-drag')
  if (!bar) return
  let dragging = false, dx = 0, dy = 0
  bar.addEventListener('pointerdown', event => {
    dragging = true
    const rect = panel.getBoundingClientRect()
    dx = event.clientX - rect.left
    dy = event.clientY - rect.top
    bar.setPointerCapture(event.pointerId)
  })
  bar.addEventListener('pointermove', event => {
    if (!dragging) return
    panel.style.left = Math.max(8, event.clientX - dx) + 'px'
    panel.style.top = Math.max(42, event.clientY - dy) + 'px'
    panel.style.right = 'auto'
  })
  bar.addEventListener('pointerup', () => { dragging = false })
  bar.addEventListener('pointercancel', () => { dragging = false })
}
