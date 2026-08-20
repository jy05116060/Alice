import { createMarkdownBody } from "./markdown.js";
import { getUiClientId } from "./api-client.js";
import { formatDateTime, t } from "./i18n/index.js";

// 把数据库/事件里的细粒度 channel 名转成 UI 友好的简化标签
export function friendlyChannelLabel(channel) {
  if (!channel) return "";
  const c = String(channel).toUpperCase();
  if (c === "WECHAT_CLAWBOT" || c === "WECHAT_OFFICIAL" || c === "WECHAT") return "WeChat";
  if (c === "WECOM") return "WeCom";
  if (c === "DISCORD") return "Discord";
  if (c === "FEISHU") return "Feishu";
  return "";
}

export function shouldAttachSystemScreenshot() {
  return false;
}

// 中文、日文等输入法确认候选时也会产生 Enter keydown。macOS 上 Chromium
// 通常通过 isComposing 标记它，部分输入法/版本则只暴露 keyCode 229。
export function isImeComposing(event, compositionActive = false) {
  return Boolean(
    compositionActive
    || event?.isComposing
    || event?.keyCode === 229
    || event?.which === 229
  );
}

/**
 * 把一个「原生标记」的统计面板挂到触发芯片上（hover 弹出，位置在芯片正上方居中）。
 * 面板是 app-shell.js / chat.js 里写好的 DOM，这里只做显示与定位：
 *   · 面板会被搬到 document.body 上（等价 DSH stat-dialog 的 createPortal(., document.body)）。
 *     聊天区带 backdrop-filter，position:fixed 落在里面会被当成包含块，坐标会整体错位。
 *   · 定位参数与 DSH useAnchoredPosition 一致：gap 8px、视口边距 12px、side: "top"。
 *   · 移开 160ms 后才收起，留出把鼠标移进面板的余地。
 * @param anchor 触发芯片（button / span）
 * @param panel  `.blm-stat-panel` 面板元素
 */
export function mountStatPanel(anchor, panel) {
  if (!anchor || !panel || panel.dataset.blmPanelMounted === "1") return null;
  panel.dataset.blmPanelMounted = "1";
  let hideTimer = 0;
  const PANEL_GAP = 8;
  const PANEL_MARGIN = 12;
  const place = () => {
    const r = anchor.getBoundingClientRect();
    const w = panel.offsetWidth;
    const h = panel.offsetHeight;
    const left = Math.max(PANEL_MARGIN, Math.min(window.innerWidth - w - PANEL_MARGIN, r.left + r.width / 2 - w / 2));
    const top = Math.max(PANEL_MARGIN, r.top - h - PANEL_GAP);
    panel.style.left = `${Math.round(left)}px`;
    panel.style.top = `${Math.round(top)}px`;
  };
  const cancel = () => { if (hideTimer) { clearTimeout(hideTimer); hideTimer = 0; } };
  const hide = () => {
    cancel();
    panel.hidden = true;
    anchor.setAttribute("aria-expanded", "false");
  };
  const schedule = () => { cancel(); hideTimer = setTimeout(hide, 160); };
  const show = () => {
    cancel();
    if (panel.parentElement !== document.body) document.body.appendChild(panel);
    panel.hidden = false;
    anchor.setAttribute("aria-expanded", "true");
    place();
    requestAnimationFrame(() => { if (!panel.hidden) place(); });
  };
  anchor.addEventListener("mouseenter", show);
  anchor.addEventListener("mouseleave", schedule);
  panel.addEventListener("mouseenter", cancel);
  panel.addEventListener("mouseleave", schedule);
  anchor.addEventListener("click", event => { event.stopPropagation(); show(); });
  document.addEventListener("keydown", event => { if (event.key === "Escape") hide(); });
  // 滚动时位置就过期了（fixed 面板不跟滚动），直接收起
  document.addEventListener("scroll", () => { if (!panel.hidden) hide(); }, true);
  return { show, hide };
}

// DSH 原生图标（IconDatabaseOutline16 / IconClockOutline16，svg 定义照搬自 DSH 前端构建产物）
const ICON_DATABASE_16 = '<svg viewBox="0 0 16 16" fill="none" aria-hidden="true"><ellipse cx="8" cy="3.6" rx="5.75" ry="2.4" stroke="currentColor" stroke-width="1.25"></ellipse><path d="M2.25 3.6V12.3A5.75 2.4 0 0 0 13.75 12.3V3.6" stroke="currentColor" stroke-width="1.25"></path><path d="M2.25 7.95A5.75 2.4 0 0 0 13.75 7.95" stroke="currentColor" stroke-width="1.25"></path></svg>';
const ICON_CLOCK_16 = '<svg viewBox="0 0 16 16" fill="none" aria-hidden="true"><circle cx="8" cy="8" r="6.375" stroke="currentColor" stroke-width="1.25"></circle><path d="M8 4.4V8.3L10.7 9.85" stroke="currentColor" stroke-width="1.25"></path></svg>';

/**
 * 把**插件在清单里声明的**命令转成斜杠菜单项（**纯数据**，不碰 DOM，便于直接测）。
 *
 * 为什么是清单声明而不是运行时注册函数：插件代码跑在**主进程**，界面在**渲染进程**，
 * 一个 JS 函数跨不过这道边界。宿主能序列化出来的只有 cmd / label / description /
 * prompt 模板这些数据——所以这里只接受数据，界面上不存在「执行插件给的函数」这条路径。
 *
 * 规则（每条都对应一个「否则用户会看到一个坏菜单项」的场景）：
 *   · cmd 必须是 `/xxx` 形状，label/description 必须是字符串；
 *   · `prompt` 模板不能为空——点一条没有内容的命令只会让用户以为插件坏了；
 *   · **与已有命令重名的一律丢掉**（内置命令优先）：插件不许覆盖 `/llm` 这类内置行为。
 * 返回 `skipped` 而不是静默丢弃，调用方/测试能看出「为什么这条命令没出现」。
 *
 * @param {Array<object>} commands 来自 GET /plugins/ui 的 commands
 * @param {{existing?: string[]}} [options] 已有的命令（用于查重）
 * @returns {{items: Array<object>, skipped: Array<{cmd: string, reason: string}>}}
 */
export function buildPluginSlashCommands(commands, { existing = [] } = {}) {
  const taken = new Set((Array.isArray(existing) ? existing : []).map(cmd => String(cmd)));
  const items = [];
  const skipped = [];
  for (const command of Array.isArray(commands) ? commands : []) {
    const cmd = typeof command?.cmd === "string" ? command.cmd.trim() : "";
    if (!/^\/[^\s/]+$/.test(cmd)) {
      skipped.push({ cmd: cmd || "(missing)", reason: "invalid-command-name" });
      continue;
    }
    if (taken.has(cmd)) {
      skipped.push({ cmd, reason: "duplicate-command" });
      continue;
    }
    const prompt = typeof command?.prompt === "string" ? command.prompt : "";
    if (!prompt.trim()) {
      skipped.push({ cmd, reason: "empty-prompt" });
      continue;
    }
    const label = typeof command?.label === "string" && command.label.trim() ? command.label.trim() : cmd;
    const description = typeof command?.description === "string" ? command.description.trim() : "";
    taken.add(cmd);
    items.push({
      cmd,
      // 插件 id 也进搜索键：`/` 菜单里能按插件名过滤
      keys: [cmd.slice(1).toLowerCase(), command?.plugin_id ? String(command.plugin_id).toLowerCase() : ""].filter(Boolean),
      label,
      desc: description,
      prompt,
    });
  }
  return { items, skipped };
}

export function initChat({
  apiBase,
  historyPageSize,
  activationWarmupKey,
  getAgentName,
  defaultInputPlaceholder,
  isSpacePttEnabled = () => true,
  onUserMessage = null,
  openSettings = null,
  openSchedules = null,
  openWorktrees = null,
  openCompaction = null,
  openWorkflow = null,
} = {}) {
  const CHAT_PIN_STORAGE_KEY = "alice-chat-pinned";
  const chatHistory = document.getElementById("chat-history");
  const chatMessages = document.getElementById("chat-messages");
  const msgInput = document.getElementById("msg-input");
  const chatArea = document.getElementById("chat-area");
  const chatPinButton = document.getElementById("chat-pin-button");
  const sendBtn = document.getElementById("send-btn");
  const modelSelect = document.getElementById("composer-model");
  const pasteAttachments = document.getElementById("paste-attachments");
  const dropOverlay = document.getElementById("chat-drop-overlay");

  let inputLocked = false;
  // 操作行两块面板的唯一 id 序号（面板会被挂到 body 上，靠 data-panel-id 反查）
  let panelSeq = 0;
  const pendingLocalSends = new Set();
  const queuedSends = [];
let queuedSendSeq = 0;
  let agentRunning = false;
  const pendingPastedImages = [];
  let chatPinned = false;
  let hasPendingJarvisMessage = false;
  let pendingMessageDismissed = false;
  let closeTimer = null;   // 自动收起聊天的定时器（openChat / scheduleClose / closeChat 共用）
  let compositionActive = false;
  let liveEl = null;  // 正在流式输出的 jarvis 气泡（边收 token 边重渲染），message 事件到达后定稿
  let audioCtx = null;
  let audioUnlocked = false;
  let warmupTimer = null;
  let historySyncPromise = null;
  let olderHistoryPromise = null;
  let historyInitialized = false;
  let oldestHistoryId = "";
  let hasOlderHistory = true;
  const renderedMessageIds = new Set();
  const pendingClientMessages = new Map();
  const recentRenderedKeys = new Map();
  const RENDER_DEDUPE_TTL_MS = 2 * 60 * 1000;
  const CHAT_BOTTOM_THRESHOLD_PX = 32;

  const PUSH_TO_TALK_PLACEHOLDER = t("shell.holdSpace");
  const MAX_PASTED_IMAGES = 8;
  const MAX_PASTED_IMAGE_BYTES = 12 * 1024 * 1024;
  const MAX_DROPPED_RESOURCES = 8;
  const MAX_DROPPED_RESOURCE_BYTES = 20 * 1024 * 1024;
  const MAX_DROPPED_RESOURCE_TOTAL_BYTES = 40 * 1024 * 1024;

  function normalizeMessageId(value) {
    if (value === undefined || value === null || value === "") return "";
    return String(value);
  }

  function renderedKey(role, text, label) {
    const cleanText = String(text || "").replace(/\s+/g, " ").trim();
    if (!cleanText) return "";
    return `${role || ""}\n${label || ""}\n${cleanText}`;
  }

  function pruneRenderedKeys(now = Date.now()) {
    for (const [key, ts] of recentRenderedKeys) {
      if (now - ts > RENDER_DEDUPE_TTL_MS) recentRenderedKeys.delete(key);
    }
  }

  function isNearChatBottom() {
    const distance = chatMessages.scrollHeight - chatMessages.clientHeight - chatMessages.scrollTop;
    return distance <= CHAT_BOTTOM_THRESHOLD_PX;
  }

  function scrollChatToBottomIfFollowing(wasNearBottom) {
    if (wasNearBottom) chatMessages.scrollTop = chatMessages.scrollHeight;
  }

  function claimRenderedMessage({ messageId, role, text, label, source = "event", dedupe = true } = {}) {
    const id = normalizeMessageId(messageId);
    const now = Date.now();
    pruneRenderedKeys(now);
    if (id && renderedMessageIds.has(id)) return false;
    const key = renderedKey(role, text, label);
    const allowContentDedupe = source === "history" || !id;
    if (dedupe && allowContentDedupe && key && recentRenderedKeys.has(key)) {
      if (id) renderedMessageIds.add(id);
      return false;
    }
    if (id) renderedMessageIds.add(id);
    if (key && (!id || dedupe === false)) recentRenderedKeys.set(key, now);
    return true;
  }

  // 多行输入：每次内容变化时把高度重置为内容实际高度（上限由 CSS max-height 接管、超出后内部滚动）。
  function autoGrowInput() {
    msgInput.style.height = "auto";
    msgInput.style.height = msgInput.scrollHeight + "px";
  }

  // 聚焦输入框时提示发消息，未聚焦时提示语音输入
  function idlePlaceholder() {
    return document.activeElement === msgInput || !isSpacePttEnabled()
      ? defaultInputPlaceholder()
      : PUSH_TO_TALK_PLACEHOLDER;
  }

  // 复刻 DSH formatMessageClock：同一自然日 → HH:mm；
  // 同一年 → 「M月D日 HH:mm」；跨年 → 「Y年M月D日 HH:mm」。24 小时制、补零。
  function formatMessageTime(timestamp) {
    const date = timestamp ? new Date(timestamp) : new Date();
    if (!Number.isFinite(date.getTime())) return "";
    const clock = formatDateTime(date, { hour: "2-digit", minute: "2-digit", hour12: false });
    const now = new Date();
    const sameDay = date.getFullYear() === now.getFullYear()
      && date.getMonth() === now.getMonth()
      && date.getDate() === now.getDate();
    if (sameDay) return clock;
    if (date.getFullYear() === now.getFullYear()) return `${date.getMonth() + 1}月${date.getDate()}日 ${clock}`;
    return `${date.getFullYear()}年${date.getMonth() + 1}月${date.getDate()}日 ${clock}`;
  }

  function parseResourceMetadata(value) {
    if (Array.isArray(value)) return value.filter(item => item && typeof item === "object");
    try {
      const parsed = JSON.parse(String(value || ""));
      return Array.isArray(parsed) ? parsed.filter(item => item && typeof item === "object") : [];
    } catch {
      return [];
    }
  }

  function formatResourceBytes(value) {
    const bytes = Math.max(0, Number(value) || 0);
    if (bytes < 1024) return `${bytes} B`;
    if (bytes < 1024 * 1024) return `${Math.round(bytes / 1024)} KB`;
    return `${(bytes / (1024 * 1024)).toFixed(bytes < 10 * 1024 * 1024 ? 1 : 0)} MB`;
  }

  function resourceExtension(name = "") {
    const match = String(name || "").match(/\.([a-z0-9]{1,8})$/i);
    return (match?.[1] || "FILE").toUpperCase();
  }

  function resourceStateText(state = "pending", detail = "") {
    if (state === "uploading") return t("shell.resourceUploading");
    if (state === "consumed") return t("shell.resourceConsumed");
    if (state === "failed") return detail || t("shell.resourceFailed");
    return t("shell.resourcePending");
  }

  function createResourceMessageBody(resources = [], state = "pending", detail = "") {
    const body = document.createElement("div");
    body.className = "chat-resource-body";
    const list = document.createElement("div");
    list.className = "chat-resource-list";

    resources.forEach(resource => {
      const href = String(resource.url || resource.preview_url || "");
      const item = document.createElement(href ? "a" : "div");
      item.className = "chat-resource-item";
      if (href && item.tagName === "A") {
        item.href = href;
        item.target = "_blank";
        item.rel = "noopener noreferrer";
      }

      if (resource.kind === "image" || String(resource.mime || "").startsWith("image/")) {
        const image = document.createElement("img");
        image.className = "chat-resource-thumb";
        image.src = String(resource.preview_url || resource.url || "");
        image.alt = String(resource.name || "image");
        image.draggable = false;
        item.appendChild(image);
      } else {
        const icon = document.createElement("span");
        icon.className = "chat-resource-icon";
        icon.textContent = resourceExtension(resource.name);
        item.appendChild(icon);
      }

      const copy = document.createElement("span");
      copy.className = "chat-resource-copy";
      const name = document.createElement("span");
      name.className = "chat-resource-name";
      name.textContent = String(resource.name || "resource");
      name.title = name.textContent;
      const resourceDetail = document.createElement("span");
      resourceDetail.className = "chat-resource-detail";
      resourceDetail.textContent = [
        String(resource.mime || "").replace(/^application\//, ""),
        formatResourceBytes(resource.size),
      ].filter(Boolean).join(" · ");
      copy.append(name, resourceDetail);
      item.appendChild(copy);
      list.appendChild(item);
    });

    const status = document.createElement("div");
    status.className = "chat-resource-state";
    status.textContent = resourceStateText(state, detail);
    body.append(list, status);
    return body;
  }

  function setComposerLocked(locked, reason = "") {
    inputLocked = locked;
    msgInput.disabled = locked;
    sendBtn.disabled = locked;
    msgInput.placeholder = locked ? (reason || t("shell.systemPreparing")) : idlePlaceholder();
  }

  function releaseWarmupLock() {
    if (warmupTimer) {
      clearTimeout(warmupTimer);
      warmupTimer = null;
    }
    try { sessionStorage.removeItem(activationWarmupKey); } catch {}
    setComposerLocked(false);
  }

  function applyActivationWarmupLock() {
    let until = 0;
    try {
      until = Number(sessionStorage.getItem(activationWarmupKey) || 0);
    } catch {}

    const remaining = until - Date.now();
    if (remaining <= 0) {
      releaseWarmupLock();
      return;
    }

    const seconds = Math.max(1, Math.ceil(remaining / 1000));
    setComposerLocked(true, t("format.warmup", { seconds }));
    if (warmupTimer) clearTimeout(warmupTimer);
    warmupTimer = setTimeout(releaseWarmupLock, remaining);
  }

  function isHoveringChat() {
    return chatArea.matches(":hover") || chatHistory.matches(":hover") || chatMessages.matches(":hover");
  }

  function readPinnedPreference() {
    try { return localStorage.getItem(CHAT_PIN_STORAGE_KEY) === "1"; } catch { return false; }
  }

  function setChatPinned(pinned, { persist = true } = {}) {
    chatPinned = Boolean(pinned);
    chatArea.classList.toggle("chat-pinned", chatPinned);
    chatPinButton?.setAttribute("aria-pressed", String(chatPinned));
    chatPinButton?.setAttribute("aria-label", chatPinned ? t("shell.unpinChat") : t("shell.pinChat"));
    if (chatPinButton) chatPinButton.title = chatPinned ? t("shell.unpin") : t("shell.pinChat");
    if (persist) {
      try { localStorage.setItem(CHAT_PIN_STORAGE_KEY, chatPinned ? "1" : "0"); } catch {}
    }
    if (chatPinned) {
      if (closeTimer) { clearTimeout(closeTimer); closeTimer = null; }
      chatHistory.classList.add("open");
      chatArea.classList.remove("wc-collapsed", "ty-collapsed");
    }
    window.dispatchEvent(new CustomEvent("alice:chat-pin", {
      detail: { pinned: chatPinned },
    }));
  }

  function ensureAudioContext() {
    if (!audioCtx) {
      if (!audioUnlocked) return null;  // Don't create before a user gesture — avoids Chrome autoplay warning
      const AudioCtx = window.AudioContext || window.webkitAudioContext;
      if (!AudioCtx) return null;
      try { audioCtx = new AudioCtx(); } catch { return null; }
    }
    return audioCtx;
  }

  function unlockAudioOnFirstGesture() {
    const unlock = () => {
      if (audioUnlocked) return;
      audioUnlocked = true;
      // Create/resume AudioContext only after the first user gesture — avoids Chrome autoplay policy warning
      const ctx = ensureAudioContext();
      if (ctx && ctx.state === "suspended") {
        ctx.resume().catch(() => {});
      }
      window.removeEventListener("pointerdown", unlock, true);
      window.removeEventListener("keydown", unlock, true);
      window.removeEventListener("touchstart", unlock, true);
    };
    window.addEventListener("pointerdown", unlock, true);
    window.addEventListener("keydown", unlock, true);
    window.addEventListener("touchstart", unlock, true);
  }

  async function playJarvisAlert() {
    // 消息提示音已取消：很多用户在深夜处理工作，不希望任何声音打扰（含文本回复与语音识别后的回复）。
    // 这里直接返回，让两个调用点（普通消息 / 流式直播气泡）静默。TTS 朗读不受影响。
    return;
    // eslint-disable-next-line no-unreachable
    const ctx = ensureAudioContext();
    if (!ctx) return;
    try { if (ctx.state === "suspended") await ctx.resume(); } catch { return; }
    if (ctx.state !== "running") return;
    const now = ctx.currentTime;
    const master = ctx.createGain();
    master.gain.setValueAtTime(0.0001, now);
    master.gain.exponentialRampToValueAtTime(0.3, now + 0.02);
    master.gain.exponentialRampToValueAtTime(0.18, now + 0.28);
    master.gain.exponentialRampToValueAtTime(0.0001, now + 0.6);
    master.connect(ctx.destination);

    const oscA = ctx.createOscillator();
    oscA.type = "sine";
    oscA.frequency.setValueAtTime(740, now);
    oscA.frequency.exponentialRampToValueAtTime(880, now + 0.18);
    oscA.connect(master);

    const oscB = ctx.createOscillator();
    oscB.type = "triangle";
    oscB.frequency.setValueAtTime(1110, now + 0.12);
    oscB.frequency.exponentialRampToValueAtTime(1320, now + 0.34);
    oscB.connect(master);

    oscA.start(now); oscA.stop(now + 0.32);
    oscB.start(now + 0.12); oscB.stop(now + 0.5);

    oscA.addEventListener("ended", () => oscA.disconnect(), { once: true });
    oscB.addEventListener("ended", () => oscB.disconnect(), { once: true });
    setTimeout(() => master.disconnect(), 700);
  }

  function isTyping() {
    return document.activeElement === msgInput || msgInput.value.trim().length > 0 || pendingPastedImages.length > 0;
  }

  async function fetchChatHistory({ beforeId = "" } = {}) {
    try {
      const url = new URL("/conversations", `${apiBase}/`);
      url.searchParams.set("limit", String(historyPageSize));
      if (beforeId) url.searchParams.set("before_id", String(beforeId));
      const res = await fetch(url);
      if (!res.ok) return null;
      const rows = await res.json();
      if (!Array.isArray(rows)) return null;
      const messages = rows
        .filter(r => r && (r.role === "user" || r.role === "jarvis") && typeof r.content === "string")
        .map(r => {
          // 外部渠道判定：channel 非空且不是本地（TUI/API），或 from_id 仍带外部前缀（兼容历史数据）
          const channel = (r.channel || "").toUpperCase();
          if (r.role === "user" && channel === "RESOURCE") {
            return {
              role: "user",
              text: r.content,
              label: t("shell.resourceLabel"),
              messageId: r.id,
              timestamp: r.timestamp,
              channel,
              resources: parseResourceMetadata(r.resource_metadata || r.resourceMetadata),
              resourceState: r.resource_state || r.resourceState || "pending",
            };
          }
          const isExternal =
            r.role === "user"
            && ((channel && channel !== "TUI" && channel !== "API" && channel !== "SYSTEM" && channel !== "REMINDER" && channel !== "APP_SIGNAL" && channel !== "VOICE" && channel !== "语音识别")
                || /^(wechat|discord|feishu|wecom):/i.test(r.from_id || ""));
          if (isExternal) {
            const label = friendlyChannelLabel(r.channel) || r.from_id;
            return { role: "external", text: r.content, label, messageId: r.id, timestamp: r.timestamp };
          }
          return { role: r.role, text: r.content, messageId: r.id, timestamp: r.timestamp, channel };
        });
      return { messages, rowCount: rows.length };
    } catch { return null; }
  }

  function openChat(autoClose = false) {
    chatHistory.classList.add("open");
    if (closeTimer) { clearTimeout(closeTimer); closeTimer = null; }
    if (autoClose && (!hasPendingJarvisMessage || pendingMessageDismissed) && !isTyping()) scheduleClose(4500);
  }

  function closeChat() {
    if (chatPinned || (hasPendingJarvisMessage && !pendingMessageDismissed) || isTyping() || isHoveringChat()) return;
    chatHistory.classList.remove("open");
  }

  function scheduleClose(ms = 100) {
    if (chatPinned || (hasPendingJarvisMessage && !pendingMessageDismissed) || isTyping() || isHoveringChat()) return;
    if (closeTimer) clearTimeout(closeTimer);
    closeTimer = setTimeout(closeChat, ms);
  }

  // 复刻 DeepSeek Harness：消息操作行（复制 / 赞 / 踩 / 分支 + 用量）。
  // 真实可用：复制走剪贴板；赞踩走后端 POST /feedback/message 落库（换台机器也还在，不再是 localStorage）。
  // 分支需要会话分叉接口，爱丽丝还没有，故禁用。
  const feedbackCache = new Map();
  function paintFeedback(likeBtn, dislikeBtn, value) {
    likeBtn.classList.toggle("is-on", value === "like");
    dislikeBtn.classList.toggle("is-on", value === "dislike");
  }
  function saveFeedback(messageKey, rating) {
    return fetch("/feedback/message", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ message_key: messageKey, rating }),
    }).then(r => r.json()).catch(() => ({ ok: false }));
  }
  function createMsgActions(text, { messageId = "", timestamp = null } = {}) {
    const bar = document.createElement("div");
    bar.className = "msg-actions";
    const makeBtn = (action, glyph, title) => {
      const b = document.createElement("button");
      b.type = "button";
      b.className = "msg-action";
      b.dataset.action = action;
      b.title = title;
      b.setAttribute("aria-label", title);
      b.textContent = glyph;
      return b;
    };
    const copyBtn = makeBtn("copy", "⧉", "复制");
    const likeBtn = makeBtn("like", "👍", "有帮助");
    const dislikeBtn = makeBtn("dislike", "👎", "没帮助");
    const branchBtn = makeBtn("branch", "⑂", "从这条消息分叉（需要后端接口，暂未实现）");
    branchBtn.disabled = true;
    // 用量 / 用时两枚芯片 + 两块悬停面板：结构照 DSH TurnUsagePanel(3490-3554) 与
    // TurnTimePanel(3560-3608)，芯片样式用 DSH StatsPills 的 pill 类（bOPqQW_pill）。
    // 面板带唯一 id，芯片用 data-panel-id 记住它 —— 面板会被挂到 body 上做定位（DSH 用 createPortal）。
    const usage = document.createElement("button");
    usage.type = "button";
    usage.className = "msg-usage msg-usage-trigger bOPqQW_pill";
    usage.title = "本轮用量";
    usage.setAttribute("aria-haspopup", "dialog");
    usage.setAttribute("aria-expanded", "false");
    usage.setAttribute("aria-label", "本轮用量");
    usage.hidden = true;
    usage.innerHTML = ICON_DATABASE_16 + "<span></span>";
    const usagePanelId = `blm-turn-usage-panel-${(panelSeq += 1)}`;
    const usagePanel = document.createElement("div");
    usagePanel.id = usagePanelId;
    usagePanel.className = "blm-stat-panel bRhRbq_panel";
    usagePanel.dataset.turnUsagePanel = "1";
    usagePanel.setAttribute("role", "dialog");
    usagePanel.setAttribute("aria-label", "本轮用量");
    usagePanel.hidden = true;
    usagePanel.innerHTML = [
      `<div class="bRhRbq_title"><span class="bRhRbq_titleLabel">${ICON_DATABASE_16}本轮用量</span>`,
      `<span class="bRhRbq_titleValue blm-turn-total">—</span></div>`,
      '<div class="bRhRbq_titleRule" aria-hidden="true"></div>',
      '<dl class="bRhRbq_details" data-turn-usage-details>',
      '<dt>提供方 / 模型</dt><dd class="bRhRbq_route blm-turn-model">—</dd>',
      '<dt>缓存命中</dt><dd class="blm-turn-hit">—</dd>',
      '<dt>未缓存输入</dt><dd class="blm-turn-uncached">—</dd>',
      '<dt>缓存读取</dt><dd class="blm-turn-cacheread">—</dd>',
      '<dt>输出</dt><dd class="blm-turn-output">—</dd>',
      '</dl>',
    ].join("");
    usage.dataset.panelId = usagePanelId;

    const elapsed = document.createElement("button");
    elapsed.type = "button";
    elapsed.className = "msg-elapsed bOPqQW_pill";
    elapsed.title = "本轮用时和速度";
    elapsed.setAttribute("aria-haspopup", "dialog");
    elapsed.setAttribute("aria-expanded", "false");
    elapsed.setAttribute("aria-label", "本轮用时和速度");
    elapsed.hidden = true;
    elapsed.innerHTML = ICON_CLOCK_16 + "<span>用时 —</span>";
    const elapsedPanelId = `blm-turn-time-panel-${(panelSeq += 1)}`;
    const elapsedPanel = document.createElement("div");
    elapsedPanel.id = elapsedPanelId;
    elapsedPanel.className = "blm-stat-panel bRhRbq_panel";
    elapsedPanel.dataset.turnTimePanel = "1";
    elapsedPanel.setAttribute("role", "dialog");
    elapsedPanel.setAttribute("aria-label", "本轮用时和速度");
    elapsedPanel.hidden = true;
    elapsedPanel.innerHTML = [
      `<div class="bRhRbq_title"><span class="bRhRbq_titleLabel">${ICON_CLOCK_16}本轮用时和速度</span></div>`,
      '<div class="bRhRbq_titleRule" aria-hidden="true"></div>',
      '<dl class="bRhRbq_details" data-turn-time-details>',
      '<dt>本轮总用时</dt><dd class="blm-turn-duration">—</dd>',
      '<dt>输出速度（TPS）</dt><dd class="blm-turn-tps">—</dd>',
      '<dt>首 token 用时（TTFT）</dt><dd class="blm-turn-ttft">—</dd>',
      '</dl>',
    ].join("");
    elapsed.dataset.panelId = elapsedPanelId;
    const usageAnchor = document.createElement("span");
    usageAnchor.className = "bOPqQW_anchor";
    usageAnchor.append(usage, usagePanel);
    const elapsedAnchor = document.createElement("span");
    elapsedAnchor.className = "bOPqQW_anchor";
    elapsedAnchor.append(elapsed, elapsedPanel);
    mountStatPanel(usage, usagePanel);
    mountStatPanel(elapsed, elapsedPanel);
    const timeEl = document.createElement("time");
    timeEl.className = "msg-time-inline";
    timeEl.dateTime = timestamp || new Date().toISOString();
    timeEl.textContent = formatMessageTime(timestamp);
    const fbKey = messageId ? String(messageId) : "";
    if (fbKey) {
      const cached = feedbackCache.get(fbKey);
      if (cached !== undefined) {
        paintFeedback(likeBtn, dislikeBtn, cached);
      } else {
        fetch(`/feedback/message?key=${encodeURIComponent(fbKey)}`)
          .then(r => r.json())
          .then(data => {
            const value = String(data?.feedback?.rating || "");
            feedbackCache.set(fbKey, value);
            paintFeedback(likeBtn, dislikeBtn, value);
          })
          .catch(() => {});
      }
    }
    const setFb = value => {
      if (!fbKey) return;
      const current = feedbackCache.get(fbKey) ?? "";
      const next = current === value ? "" : value;
      feedbackCache.set(fbKey, next);
      paintFeedback(likeBtn, dislikeBtn, next);
      saveFeedback(fbKey, next).then(data => {
        if (!data || data.ok === false) {
          feedbackCache.set(fbKey, current);
          paintFeedback(likeBtn, dislikeBtn, current);
        }
      });
    };
    copyBtn.addEventListener("click", () => {
      const done = ok => {
        copyBtn.classList.toggle("is-ok", ok);
        copyBtn.textContent = ok ? "✓" : "✕";
        setTimeout(() => { copyBtn.classList.remove("is-ok"); copyBtn.textContent = "⧉"; }, 1100);
      };
      const raw = String(text == null ? "" : text);
      if (navigator.clipboard?.writeText) {
        navigator.clipboard.writeText(raw).then(() => done(true), () => done(false));
      } else {
        try {
          const ta = document.createElement("textarea");
          ta.value = raw;
          ta.style.position = "fixed";
          ta.style.opacity = "0";
          document.body.appendChild(ta);
          ta.select();
          done(document.execCommand("copy"));
          ta.remove();
        } catch { done(false); }
      }
    });
    likeBtn.addEventListener("click", () => setFb("like"));
    dislikeBtn.addEventListener("click", () => setFb("dislike"));
    if (timestamp) bar.dataset.ts = String(timestamp);
    // 顺序对齐参考图 E：复制 / 赞 / 踩 / 分支 → 用量芯片 → 用时芯片 → 时间戳
    bar.append(copyBtn, likeBtn, dislikeBtn, branchBtn, usageAnchor, elapsedAnchor, timeEl);
    return bar;
  }

  function addMsg(role, text, options = {}) {
    const {
      alert = role === "jarvis",
      pending = true,
      label,
      messageId,
      clientMessageId,
      source = "event",
      dedupe = true,
      forceScroll = false,
      prepend = false,
      timestamp = null,
      channel = "",
      resources = [],
      resourceState = "",
      resourceDetail = "",
    } = options;
    const isResourceMessage = String(channel || "").toUpperCase() === "RESOURCE" || resources.length > 0;
    const defaultLabel = isResourceMessage
      ? t("shell.resourceLabel")
      : (role === "user" ? "You" : role === "jarvis" ? getAgentName() : "Peer");
    const labelText = label || defaultLabel;
    if (!claimRenderedMessage({ messageId, role, text, label: labelText, source, dedupe })) return false;
    const shouldScrollToBottom = !prepend && (forceScroll || isNearChatBottom());
    const div = document.createElement("div");
    div.className = `msg msg-${role}`;
    if (isResourceMessage) {
      div.classList.add("msg-resource");
      div.dataset.resourceState = resourceState || "pending";
      div.dataset.resourcePreview = JSON.stringify(resources);
    }
    const normalizedId = normalizeMessageId(messageId);
    if (normalizedId) div.dataset.messageId = normalizedId;
    const normalizedClientMessageId = normalizeMessageId(clientMessageId);
    if (normalizedClientMessageId) {
      div.dataset.clientMessageId = normalizedClientMessageId;
      pendingClientMessages.set(normalizedClientMessageId, div);
    }
    const meta = document.createElement("span");
    meta.className = "msg-meta";
    const labelSpan = document.createElement("span");
    labelSpan.className = "msg-label";
    labelSpan.textContent = labelText;
    meta.appendChild(labelSpan);
    // DSH 里 formatMessageClock 只在消息操作行（MessageIconActions）里用一次，
    // 消息头部不重复挂时间；所以 jarvis 的时间交给操作行，头部只留名字。
    if (role !== "jarvis") {
      const timeSpan = document.createElement("time");
      timeSpan.className = "msg-time";
      timeSpan.dateTime = timestamp || new Date().toISOString();
      timeSpan.textContent = formatMessageTime(timestamp);
      if (timestamp) timeSpan.title = formatDateTime(timestamp, {
        year: "numeric", month: "2-digit", day: "2-digit",
        hour: "2-digit", minute: "2-digit", second: "2-digit", hour12: false,
      });
      meta.appendChild(timeSpan);
    }
    div.appendChild(meta);
    div.appendChild(isResourceMessage
      ? createResourceMessageBody(resources, resourceState || "pending", resourceDetail)
      : createMarkdownBody(text));
    if (role === "jarvis" && !isResourceMessage) {
      div.appendChild(createMsgActions(text, { messageId: normalizedId, timestamp }));
    }
    if (prepend) chatMessages.insertBefore(div, chatMessages.firstChild);
    else chatMessages.appendChild(div);

    // 历史渲染不应改变“有新回复待查看”等实时会话状态。
    if (source !== "history") {
      if (role === "jarvis") {
        hasPendingJarvisMessage = pending;
        pendingMessageDismissed = !pending;
        if (alert) playJarvisAlert();
        if (pending) openChat();
      } else if (role === "user") {
        hasPendingJarvisMessage = false;
        pendingMessageDismissed = false;
      }
    }

    if (!prepend) scrollChatToBottomIfFollowing(shouldScrollToBottom);
    return div;
  }

  function reconcileSentMessage(clientMessageId, conversationId) {
    const clientId = normalizeMessageId(clientMessageId);
    if (!clientId) return false;
    const element = pendingClientMessages.get(clientId)
      || chatMessages.querySelector(`[data-client-message-id="${CSS.escape(clientId)}"]`);
    if (!element) return false;
    const messageId = normalizeMessageId(conversationId);
    if (messageId) {
      element.dataset.messageId = messageId;
      renderedMessageIds.add(messageId);
    }
    pendingClientMessages.delete(clientId);
    return true;
  }

  function updateResourceMessageElement(element, {
    resources = null,
    state = "pending",
    detail = "",
    conversationId = "",
  } = {}) {
    if (!element) return false;
    const previousResources = parseResourceMetadata(element.dataset.resourcePreview || "[]");
    if (resources) {
      for (const resource of previousResources) {
        if (String(resource.preview_url || "").startsWith("blob:")) {
          try { URL.revokeObjectURL(resource.preview_url); } catch {}
        }
      }
    }
    const nextResources = resources || previousResources;
    element.classList.add("msg-resource");
    element.dataset.resourceState = state;
    element.dataset.resourcePreview = JSON.stringify(nextResources);
    if (conversationId) {
      element.dataset.messageId = normalizeMessageId(conversationId);
      renderedMessageIds.add(normalizeMessageId(conversationId));
    }
    element.querySelector(".chat-resource-body")?.replaceWith(
      createResourceMessageBody(nextResources, state, detail),
    );
    return true;
  }

  function reconcileResourceMessage(clientMessageId, conversationId, resources = [], state = "pending") {
    const clientId = normalizeMessageId(clientMessageId);
    const element = pendingClientMessages.get(clientId)
      || (clientId ? chatMessages.querySelector(`[data-client-message-id="${CSS.escape(clientId)}"]`) : null);
    if (!element) return false;
    pendingClientMessages.delete(clientId);
    return updateResourceMessageElement(element, {
      resources,
      state,
      conversationId,
    });
  }

  function markResourceMessagesConsumed(ids = []) {
    for (const id of Array.isArray(ids) ? ids : []) {
      const normalized = normalizeMessageId(id);
      if (!normalized) continue;
      const element = chatMessages.querySelector(`[data-message-id="${CSS.escape(normalized)}"]`);
      if (element?.classList.contains("msg-resource")) {
        updateResourceMessageElement(element, { state: "consumed" });
      }
    }
  }

  function restoreChatHistory() {
    if (historySyncPromise) return historySyncPromise;
    historySyncPromise = fetchChatHistory().then(page => {
      if (!page) return [];
      const { messages, rowCount } = page;
      messages.forEach(i => addMsg(i.role, i.text, {
        persist: false,
        alert: false,
        pending: false,
        label: i.label,
        messageId: i.messageId,
        source: "history",
        timestamp: i.timestamp,
        channel: i.channel,
        resources: i.resources || [],
        resourceState: i.resourceState || "",
      }));
      if (!historyInitialized || !oldestHistoryId) {
        oldestHistoryId = normalizeMessageId(messages[0]?.messageId);
        hasOlderHistory = rowCount >= historyPageSize;
      }
      historyInitialized = true;
      if (messages.length) {
        pendingMessageDismissed = true;
      }
      return messages;
    }).finally(() => {
      historySyncPromise = null;
    });
    return historySyncPromise;
  }

  function loadOlderHistory() {
    if (olderHistoryPromise || !historyInitialized || !hasOlderHistory || !oldestHistoryId) {
      return olderHistoryPromise || Promise.resolve([]);
    }
    const beforeId = oldestHistoryId;
    olderHistoryPromise = fetchChatHistory({ beforeId }).then(page => {
      if (!page) return [];
      const { messages, rowCount } = page;
      if (!messages.length) {
        hasOlderHistory = false;
        return [];
      }

      const previousScrollTop = chatMessages.scrollTop;
      const previousScrollHeight = chatMessages.scrollHeight;
      const anchor = chatMessages.firstElementChild;
      const previousAnchorTop = anchor?.getBoundingClientRect().top ?? 0;
      for (let index = messages.length - 1; index >= 0; index -= 1) {
        const item = messages[index];
        addMsg(item.role, item.text, {
          persist: false,
          alert: false,
          pending: false,
          label: item.label,
          messageId: item.messageId,
          source: "history",
          prepend: true,
          timestamp: item.timestamp,
          channel: item.channel,
          resources: item.resources || [],
          resourceState: item.resourceState || "",
        });
      }
      oldestHistoryId = normalizeMessageId(messages[0]?.messageId) || oldestHistoryId;
      hasOlderHistory = rowCount >= historyPageSize;
      const addedHeight = chatMessages.scrollHeight - previousScrollHeight;
      chatMessages.scrollTop = previousScrollTop + addedHeight;
      if (anchor) {
        const remainingShift = anchor.getBoundingClientRect().top - previousAnchorTop;
        if (remainingShift) chatMessages.scrollTop += remainingShift;
      }
      return messages;
    }).finally(() => {
      olderHistoryPromise = null;
    });
    return olderHistoryPromise;
  }

  chatMessages.addEventListener("scroll", () => {
    if (chatMessages.scrollTop <= 48) loadOlderHistory();
  }, { passive: true });

  // text 显式传入时直接发送、不经过输入框（语音识别用：voice 完全不在 msg-input 留草稿）；
  // 不传 text 则保持原行为，从输入框读取并清空。
  function newClientMessageId() {
    const cryptoObj = globalThis.crypto;
    if (cryptoObj?.randomUUID) return cryptoObj.randomUUID();
    const rand = Math.random().toString(36).slice(2, 10);
    return `local-${Date.now().toString(36)}-${rand}`;
  }

  function localSendKey(channel, text, attachments = []) {
    const mediaKey = attachments
      .map(item => `${item.id || ""}:${item.name || ""}:${String(item.data_url || "").length}`)
      .join("|");
    return `${String(channel || "TUI").toUpperCase()}\n${String(text || "").trim()}\n${mediaKey}`;
  }

  function safeMarkdownAlt(value, fallback = "image") {
    return String(value || fallback).replace(/[\]\r\n]/g, " ").trim() || fallback;
  }

  function markdownImage(dataUrl, alt = "image") {
    return `![${safeMarkdownAlt(alt)}](${dataUrl})`;
  }

  function appendAttachmentMarkdown(content = "", attachments = []) {
    const images = attachments
      .filter(item => item?.data_url)
      .map(item => markdownImage(item.data_url, item.alt || item.name || "image"));
    return [images.join("\n"), String(content || "").trim()].filter(Boolean).join("\n\n");
  }

  function imageExtFromMime(mime = "") {
    const type = String(mime || "").split(";")[0].trim().toLowerCase();
    if (type === "image/jpeg" || type === "image/jpg") return ".jpg";
    if (type === "image/gif") return ".gif";
    if (type === "image/webp") return ".webp";
    if (type === "image/bmp") return ".bmp";
    return ".png";
  }

  function readFileAsDataUrl(file) {
    return new Promise((resolve, reject) => {
      const reader = new FileReader();
      reader.onload = () => resolve(String(reader.result || ""));
      reader.onerror = () => reject(reader.error || new Error("failed to read pasted image"));
      reader.readAsDataURL(file);
    });
  }

  function collectClipboardImageFiles(event) {
    const data = event.clipboardData;
    if (!data) return [];
    const files = [];
    const seen = new Set();
    const pushFile = (file) => {
      if (!file || !String(file.type || "").startsWith("image/")) return;
      const key = `${file.name || ""}:${file.type || ""}:${file.size || 0}:${file.lastModified || 0}`;
      if (seen.has(key)) return;
      seen.add(key);
      files.push(file);
    };

    for (const item of Array.from(data.items || [])) {
      if (item?.kind === "file" && String(item.type || "").startsWith("image/")) {
        pushFile(item.getAsFile());
      }
    }
    for (const file of Array.from(data.files || [])) pushFile(file);
    return files;
  }

  function renderPastedImages() {
    if (!pasteAttachments) return;
    pasteAttachments.replaceChildren();
    pasteAttachments.hidden = pendingPastedImages.length === 0;
    pendingPastedImages.forEach((item, index) => {
      const shell = document.createElement("div");
      shell.className = "paste-attachment";

      const img = document.createElement("img");
      img.src = item.data_url;
      img.alt = item.alt || "pasted image";
      img.draggable = false;
      shell.appendChild(img);

      const remove = document.createElement("button");
      remove.type = "button";
      remove.className = "paste-attachment-remove";
      remove.setAttribute("aria-label", "Remove image");
      remove.title = "Remove image";
      remove.textContent = "\u00d7";
      remove.addEventListener("click", (event) => {
        event.preventDefault();
        pendingPastedImages.splice(index, 1);
        renderPastedImages();
        try { msgInput.focus(); } catch {}
      });
      shell.appendChild(remove);

      pasteAttachments.appendChild(shell);
    });
  }

  function clearPastedImages() {
    pendingPastedImages.length = 0;
    renderPastedImages();
  }

  function snapshotPastedImages() {
    return pendingPastedImages.map(item => ({
      id: item.id,
      data_url: item.data_url,
      alt: item.alt || "pasted image",
      name: item.name || "pasted-image.png",
      source: "paste",
    }));
  }

  async function addPastedImageFiles(files = []) {
    const slots = Math.max(0, MAX_PASTED_IMAGES - pendingPastedImages.length);
    if (slots <= 0) return;
    const accepted = files
      .filter(file => {
        if (!file || file.size > MAX_PASTED_IMAGE_BYTES) {
          console.warn("[paste image] ignored oversized image");
          return false;
        }
        return true;
      })
      .slice(0, slots);
    if (!accepted.length) return;

    const images = await Promise.all(accepted.map(async (file, offset) => {
      try {
        const dataUrl = await readFileAsDataUrl(file);
        if (!/^data:image\//i.test(dataUrl)) return null;
        const ext = imageExtFromMime(file.type);
        return {
          id: newClientMessageId(),
          data_url: dataUrl,
          alt: "pasted image",
          name: file.name || `pasted-image-${pendingPastedImages.length + offset + 1}${ext}`,
        };
      } catch (error) {
        console.warn("[paste image]", error?.message || error);
        return null;
      }
    }));

    // Chromium/Electron may expose one pasted image through both clipboardData.items
    // and clipboardData.files. File metadata can differ, so dedupe after reading bytes.
    const seenDataUrls = new Set();
    for (const image of images) {
      if (!image || seenDataUrls.has(image.data_url)) continue;
      seenDataUrls.add(image.data_url);
      pendingPastedImages.push(image);
    }
    renderPastedImages();
    openChat();
  }

  function droppedFilePreview(file) {
    const mime = String(file?.type || "application/octet-stream");
    const resource = {
      name: String(file?.name || "resource"),
      mime,
      size: Number(file?.size || 0),
      kind: mime.startsWith("image/") ? "image" : "file",
    };
    if (resource.kind === "image") {
      try { resource.preview_url = URL.createObjectURL(file); } catch {}
    }
    return resource;
  }

  function addFailedResourceMessage(resources, detail) {
    const element = addMsg("user", resources.map(item => item.name).join("\n"), {
      label: t("shell.resourceLabel"),
      channel: "RESOURCE",
      resources,
      resourceState: "failed",
      resourceDetail: detail,
      dedupe: false,
      forceScroll: true,
    });
    openChat();
    return element;
  }

  async function stageDroppedResourceFiles(files = []) {
    const selected = Array.from(files || []).filter(file => file instanceof File);
    if (!selected.length) return;
    const previews = selected.slice(0, MAX_DROPPED_RESOURCES).map(droppedFilePreview);
    const totalBytes = selected.reduce((sum, file) => sum + Number(file.size || 0), 0);
    if (
      selected.length > MAX_DROPPED_RESOURCES
      || selected.some(file => Number(file.size || 0) > MAX_DROPPED_RESOURCE_BYTES)
      || totalBytes > MAX_DROPPED_RESOURCE_TOTAL_BYTES
    ) {
      addFailedResourceMessage(previews, t("shell.resourceTooLarge"));
      return;
    }

    const clientMessageId = newClientMessageId();
    const element = addMsg("user", previews.map(item => item.name).join("\n"), {
      label: t("shell.resourceLabel"),
      channel: "RESOURCE",
      resources: previews,
      resourceState: "uploading",
      clientMessageId,
      dedupe: false,
      forceScroll: true,
    });
    openChat();

    try {
      const resources = await Promise.all(selected.map(async file => ({
        name: file.name || "resource",
        mime: file.type || "application/octet-stream",
        size: file.size || 0,
        data_url: await readFileAsDataUrl(file),
      })));
      const response = await fetch(`${apiBase}/message/resources`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          from_id: "ID:000001",
          client_id: getUiClientId(),
          client_message_id: clientMessageId,
          resources,
        }),
      });
      let responseBody = {};
      try { responseBody = await response.json(); } catch {}
      if (!response.ok) throw new Error(responseBody.error || `HTTP ${response.status}`);
      reconcileResourceMessage(
        responseBody.client_message_id || clientMessageId,
        responseBody.conversation_id || responseBody.conversationId,
        responseBody.resources || previews,
        responseBody.resource_state || "pending",
      );
    } catch (error) {
      pendingClientMessages.delete(clientMessageId);
      updateResourceMessageElement(element, {
        state: "failed",
        detail: error?.message || t("shell.resourceFailed"),
      });
      console.warn("[drop resources]", error?.message || error);
    }
  }

  let fileDragDepth = 0;
  function isFileDrag(event) {
    return Array.from(event?.dataTransfer?.types || []).includes("Files");
  }
  function isOwnedDropzone(event) {
    return Boolean(event?.target?.closest?.(".aivideo-dropzone"));
  }
  function hideDropOverlay() {
    fileDragDepth = 0;
    if (dropOverlay) dropOverlay.hidden = true;
  }

  window.addEventListener("dragenter", event => {
    if (!isFileDrag(event) || isOwnedDropzone(event) || event.defaultPrevented) return;
    event.preventDefault();
    fileDragDepth += 1;
    if (dropOverlay) dropOverlay.hidden = false;
  });
  window.addEventListener("dragover", event => {
    if (!isFileDrag(event) || isOwnedDropzone(event) || event.defaultPrevented) return;
    event.preventDefault();
    if (event.dataTransfer) event.dataTransfer.dropEffect = "copy";
    if (dropOverlay) dropOverlay.hidden = false;
  });
  window.addEventListener("dragleave", event => {
    if (!isFileDrag(event) || isOwnedDropzone(event)) return;
    fileDragDepth = Math.max(0, fileDragDepth - 1);
    if (fileDragDepth === 0 && dropOverlay) dropOverlay.hidden = true;
  });
  window.addEventListener("drop", event => {
    if (!isFileDrag(event) || isOwnedDropzone(event) || event.defaultPrevented) return;
    event.preventDefault();
    const files = Array.from(event.dataTransfer?.files || []);
    hideDropOverlay();
    void stageDroppedResourceFiles(files);
  });
  // 「Agent 正在运行」是排队的唯一依据：DSH 里运行中再发消息进队列，
  // 等本轮真正结束（后端 response 事件）再按序发出——而不是等某次 HTTP 请求返回。
  function drainQueue() {
    const next = queuedSends.shift();
    renderQueueDock();
    if (!next) return;
    // send() 在输入被锁时会直接返回；此时把这条放回队首，避免静默丢消息。
    if (inputLocked) {
      queuedSends.unshift(next);
      renderQueueDock();
      return;
    }
    void send(next);
  }

  function setAgentRunning(running) {
    const next = Boolean(running);
    if (agentRunning === next) return;
    agentRunning = next;
    if (!next) drainQueue();
    else renderQueueDock();
  }

  async function send({ channel = null, label = null, text = null, attachments = null } = {}) {
    if (inputLocked) return;
    const fromInput = (text == null);
    const rawContent = (fromInput ? msgInput.value : text).trim();
    const pastedAttachments = fromInput ? snapshotPastedImages() : (attachments || []);
    if (!rawContent && pastedAttachments.length === 0) return;
    if (fromInput && agentRunning) {
      queuedSends.push({ id: `qs${++queuedSendSeq}`, channel, label, text: rawContent, attachments: pastedAttachments, queuedAt: Date.now() });
      msgInput.value = "";
      clearPastedImages();
      autoGrowInput();
      renderQueueDock();
      openChat();
      return;
    }
    const pendingKey = localSendKey(channel, rawContent, pastedAttachments);
    pendingLocalSends.add(pendingKey);
    if (fromInput) {
      msgInput.value = "";
      clearPastedImages();
      autoGrowInput();
    }
    const prepared = { content: rawContent, displayContent: rawContent, attachments: [] };
    prepared.attachments = [...(prepared.attachments || []), ...pastedAttachments];
    prepared.displayContent = appendAttachmentMarkdown(prepared.displayContent || prepared.content, pastedAttachments);
    const content = prepared.content;
    if (!content && !prepared.attachments.length) {
      pendingLocalSends.delete(pendingKey);
      return;
    }
    // If onUserMessage returns a string, use it as the backend payload; if it returns false, skip the backend call
    const override = onUserMessage?.(content);
    const clientMessageId = newClientMessageId();
    addMsg("user", prepared.displayContent || content, {
      label: label || undefined,
      clientMessageId,
      dedupe: false,
      forceScroll: true,
    });
    openChat();
    scheduleClose(1000);
    if (override === false) {
      pendingLocalSends.delete(pendingKey);
      return;
    }
    // 消息已被本机接受，本轮 Agent 开始运行；排队判定以此为准。
    agentRunning = true;
    renderQueueDock();
    try {
      const backendText = (typeof override === "string") ? override : content;
      const payload = {
        content: backendText,
        from_id: "ID:000001",
        client_id: getUiClientId(),
        client_message_id: clientMessageId,
      };
      if (channel) payload.channel = channel;
      const selectedModel = modelSelect?.value || "";
      const split = selectedModel.indexOf("::");
      if (split > 0) {
        payload.provider = selectedModel.slice(0, split);
        payload.model = selectedModel.slice(split + 2);
      }
      if (String(channel || "").toUpperCase() === "VOICE" || channel === "语音识别") {
        window.aliceVoiceDiag?.("voice-message-post", {
          client_id: payload.client_id,
          client_message_id: clientMessageId,
          channel,
          text_length: backendText.length,
        });
      }
      const resp = await fetch(`${apiBase}/message`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload),
      });
      if (!resp.ok) {
        let message = `HTTP ${resp.status}`;
        try {
          const body = await resp.json();
          message = body.error || body.message || message;
        } catch {}
        throw new Error(message);
      }
      const responseBody = await resp.json();
      if (String(channel || "").toUpperCase() === "VOICE" || channel === "语音识别") {
        window.aliceVoiceDiag?.("voice-message-accepted", {
          client_id: responseBody.client_id || payload.client_id,
          client_message_id: responseBody.client_message_id || clientMessageId,
          conversation_id: responseBody.conversation_id || 0,
        });
      }
      reconcileSentMessage(clientMessageId, responseBody.conversation_id || responseBody.conversationId);
    } catch (error) {
      console.warn("[send]", error.message);
      addMsg("jarvis", t("shell.sendFailed"));
      openChat(true);
      setAgentRunning(false);
    } finally {
      pendingLocalSends.delete(pendingKey);
      renderQueueDock();
    }
  }

  const queueDockEl = document.getElementById("queue-dock");
  const queueDockList = document.getElementById("queue-dock-list");
  const queueDockCount = document.getElementById("queue-dock-count");
  const queueDockHeader = document.getElementById("queue-dock-header");
  const queueDockStatus = document.getElementById("queue-dock-status");
  let queueDockCollapsed = true;
  let queueEditId = null;

  function queueItemPreview(item) {
    const text = String((item && item.text) || "").replace(/\s+/g, " ").trim();
    if (!text) return "(附件)";
    return text.length > 60 ? `${text.slice(0, 60)}…` : text;
  }

  function queueDockActionButton(action, text, ariaLabel) {
    const btn = document.createElement("button");
    btn.type = "button";
    btn.className = "queue-dock-action";
    btn.dataset.queueAction = action;
    if (ariaLabel) btn.setAttribute("aria-label", ariaLabel);
    btn.textContent = text;
    return btn;
  }

  function renderQueueDock() {
    if (!queueDockEl || !queueDockList) return;
    const items = queuedSends.slice();
    const rowCount = items.length;
    if (queueDockCount) queueDockCount.textContent = `${rowCount} 条排队中`;
    if (rowCount === 0) {
      queueDockEl.hidden = true;
      queueDockEl.classList.add("collapsed");
      queueDockList.textContent = "";
      queueEditId = null;
      queueDockCollapsed = true;
      if (queueDockHeader) {
        queueDockHeader.hidden = true;
        queueDockHeader.setAttribute("aria-expanded", "false");
      }
      return;
    }
    const listVisible = rowCount === 1 || !queueDockCollapsed;
    queueDockEl.hidden = false;
    queueDockEl.classList.toggle("collapsed", !listVisible);
    if (queueDockHeader) {
      queueDockHeader.hidden = rowCount <= 1;
      queueDockHeader.setAttribute("aria-expanded", listVisible ? "true" : "false");
    }
    if (queueDockStatus) queueDockStatus.hidden = !(pendingLocalSends.size > 0);
    queueDockList.hidden = !listVisible;
    queueDockList.textContent = "";
    items.forEach((item, index) => {
      const row = document.createElement("li");
      row.className = "queue-dock-row";
      row.dataset.queueId = item.id;
      const lead = document.createElement("span");
      lead.className = "queue-dock-row-lead";
      lead.textContent = String(index + 1);
      row.append(lead);
      const actions = document.createElement("span");
      actions.className = "queue-dock-row-actions";
      if (queueEditId === item.id) {
        const editor = document.createElement("input");
        editor.type = "text";
        editor.className = "queue-dock-editor";
        editor.value = item.text || "";
        editor.dataset.queueEditor = item.id;
        actions.append(queueDockActionButton("save", "保存"), queueDockActionButton("cancel", "取消"));
        row.append(editor, actions);
      } else {
        const preview = document.createElement("span");
        preview.className = "queue-dock-row-preview";
        preview.textContent = queueItemPreview(item);
        actions.append(
          queueDockActionButton("edit", "编辑"),
          queueDockActionButton("send-now", "立即发送"),
          queueDockActionButton("remove", "×", "移出排队"),
        );
        row.append(preview, actions);
      }
      queueDockList.append(row);
    });
  }

  queueDockHeader?.addEventListener("click", () => {
    queueDockCollapsed = !queueDockCollapsed;
    renderQueueDock();
  });
  queueDockList?.addEventListener("click", event => {
    const btn = event.target.closest("[data-queue-action]");
    if (!btn) return;
    const row = btn.closest("[data-queue-id]");
    const id = row?.dataset.queueId;
    const index = queuedSends.findIndex(entry => entry.id === id);
    if (index < 0) return;
    const action = btn.dataset.queueAction;
    if (action === "edit") {
      queueEditId = id;
      renderQueueDock();
      queueDockList.querySelector("[data-queue-editor]")?.focus();
      return;
    }
    if (action === "cancel") {
      queueEditId = null;
      renderQueueDock();
      return;
    }
    if (action === "save") {
      const editor = queueDockList.querySelector("[data-queue-editor]");
      const value = (editor?.value || "").trim();
      if (value) queuedSends[index].text = value;
      queueEditId = null;
      renderQueueDock();
      return;
    }
    if (action === "remove") {
      if (queueEditId === id) queueEditId = null;
      queuedSends.splice(index, 1);
      renderQueueDock();
      return;
    }
    if (action === "send-now") {
      const [item] = queuedSends.splice(index, 1);
      if (queueEditId === id) queueEditId = null;
      renderQueueDock();
      void send(item);
    }
  });

  // 输入框右键菜单的复制/粘贴都走 Electron 主进程的系统剪贴板。
  // 旧实现粘贴调 document.execCommand("paste")，Chromium 早已不执行，点了没反应；
  // navigator.clipboard 在本窗口又受权限与焦点限制，所以统一经 window.alice 桥接。
  const writeClipboard = text => {
    const raw = String(text == null ? "" : text);
    if (window.alice?.writeClipboardText) return window.alice.writeClipboardText(raw);
    if (navigator.clipboard?.writeText) return navigator.clipboard.writeText(raw);
    return Promise.reject(new Error("clipboard unavailable"));
  };
  const readClipboard = () => {
    if (window.alice?.readClipboardText) return window.alice.readClipboardText();
    if (navigator.clipboard?.readText) return navigator.clipboard.readText();
    return Promise.resolve("");
  };
  const copyComposerSelection = () => {
    const start = msgInput.selectionStart ?? 0;
    const end = msgInput.selectionEnd ?? 0;
    // 没选中就复制整段输入，避免点了看着像没反应
    const text = end > start ? msgInput.value.slice(start, end) : msgInput.value;
    if (!text) return;
    void writeClipboard(text).catch(() => {});
  };
  const pasteIntoComposer = () => {
    msgInput.focus();
    const start = msgInput.selectionStart ?? msgInput.value.length;
    const end = msgInput.selectionEnd ?? start;
    readClipboard().then(text => {
      const raw = String(text == null ? "" : text);
      if (!raw) return;
      if (typeof msgInput.setRangeText === "function") {
        msgInput.setRangeText(raw, start, end, "end");
      } else {
        msgInput.value = msgInput.value.slice(0, start) + raw + msgInput.value.slice(end);
      }
      autoGrowInput();
      updateSlashMenu();
    }).catch(() => {
      // 读不到剪贴板时退回旧路径，至少不比改动前更差
      try { document.execCommand("paste"); } catch { /* noop */ }
    });
  };

  // ── 右键菜单 ──────────────────────────────────────────────────────────
  // 爱丽丝的右键菜单覆盖面（对照 DSH 的 5 类）：
  //   输入框  —— 本文件下方（app-shell.js 里的静态 #composer-context-menu）
  //   对话文本 / 链接 —— 这里新增（此前整个 brain-ui 只有输入框一类绑了 contextmenu）
  //   会话 / 工作区 —— **不在本文件**：爱丽丝已有，位于 workspace-embed.html（工作区
  //     浮框的内嵌文档）的 906 / 944 / 1030 行。父文档的 contextmenu 监听器收不到
  //     iframe 内部的右键事件，在这里再补一份只会造出两套并存的重复物，故不重复实现。
  //
  // 定位、越界回收、点击外部关闭只有这一份实现，三类菜单共用；渲染也共用同一套
  // class（.composer-context-menu），不另起一套样式。
  const contextMenu = document.getElementById("composer-context-menu");

  /**
   * 把菜单摆到指针处并保证不越出视口。
   * #chat-area carries backdrop-filter, which makes it the containing block for
   * position:fixed descendants. Viewport coordinates (clientX/clientY) were therefore
   * resolved against that panel and the menu landed far outside it. Reparenting to
   * <body> restores fixed == viewport.
   *
   * 缩放有两套机制：Electron 原生 setZoomFactor（innerWidth 已缩小，style.left 与
   * 视口 CSS 像素 1:1）和 CSS documentElement.style.zoom（style.left 会被整体放大）。
   * 不去猜是哪一种——先把菜单摆到 0,0 实测一次渲染尺度，再按实测比例换算，
   * 两种机制（以及叠加）都能得到正确的视口坐标。
   */
  function placeContextMenu(menu, event) {
    if (menu.parentElement !== document.body) document.body.appendChild(menu);
    menu.hidden = false;
    menu.style.left = "0px";
    menu.style.top = "0px";
    const probeRect = menu.getBoundingClientRect();
    const menuWidth = menu.offsetWidth || 190;
    const menuHeight = menu.offsetHeight || 180;
    const scale = menuWidth > 0 ? (probeRect.width / menuWidth) || 1 : 1;
    const visualWidth = menuWidth * scale;
    const visualHeight = menuHeight * scale;
    const left = Math.max(8, Math.min(event.clientX, window.innerWidth - visualWidth - 8));
    const top = Math.max(8, Math.min(event.clientY, window.innerHeight - visualHeight - 8));
    menu.style.left = `${left / scale}px`;
    menu.style.top = `${top / scale}px`;
  }

  // 按需建菜单 DOM：没有右键就没有节点，启动路径不加负担。
  const dynamicContextMenus = new Map();
  function ensureContextMenu(id, labelKey) {
    const existing = document.getElementById(id);
    if (existing) return existing;
    const menu = document.createElement("div");
    menu.className = "composer-context-menu";
    menu.id = id;
    menu.setAttribute("role", "menu");
    menu.setAttribute("aria-label", t(labelKey));
    menu.hidden = true;
    // 动态菜单在创建时就挂上同一个动作分发（handleContextMenuAction 是函数声明，已提升）。
    menu.addEventListener("click", handleContextMenuAction);
    dynamicContextMenus.set(id, menu);
    document.body.appendChild(menu);
    return menu;
  }

  /** items 里传 null 表示一条分隔线。文案一律走 i18n（t()）。 */
  function fillContextMenu(menu, items) {
    menu.textContent = "";
    const close = document.createElement("button");
    close.type = "button";
    close.className = "composer-context-close";
    close.dataset.contextAction = "close";
    close.setAttribute("role", "menuitem");
    close.setAttribute("aria-label", t("ctxMenu.close"));
    close.textContent = "×";
    menu.appendChild(close);
    for (const item of items) {
      if (!item) {
        const separator = document.createElement("div");
        separator.className = "context-menu-separator";
        separator.setAttribute("role", "separator");
        menu.appendChild(separator);
        continue;
      }
      const button = document.createElement("button");
      button.type = "button";
      button.setAttribute("role", "menuitem");
      button.dataset.contextAction = item.action;
      button.textContent = item.label;
      menu.appendChild(button);
    }
  }

  function allContextMenus() {
    return [contextMenu, ...dynamicContextMenus.values()].filter(Boolean);
  }
  const closeContextMenus = () => {
    for (const menu of allContextMenus()) menu.setAttribute("hidden", "");
    hideSlashMenu();
  };

  // 右键那一刻的载荷（选中的文本 / 命中的链接）。放在闭包里而不是 dataset：
  // 正文可能很长，写进属性会在 DOM 里留一份完整副本。
  const contextMenuPayload = { text: "", link: "" };

  const conversationContextMenu = () => ensureContextMenu("conversation-context-menu", "ctxMenu.copy");
  const linkContextMenu = () => ensureContextMenu("link-context-menu", "ctxMenu.copyLink");

  const CHAT_LINK_SELECTOR = "a[href]";
  function closestChatLink(node) {
    const anchor = node?.closest?.(CHAT_LINK_SELECTOR);
    if (!anchor || !chatArea?.contains(anchor)) return null;
    return anchor;
  }

  function selectConversationText() {
    if (!chatMessages || !window.getSelection) return;
    const selection = window.getSelection();
    if (!selection) return;
    const range = document.createRange();
    range.selectNodeContents(chatMessages);
    selection.removeAllRanges();
    selection.addRange(range);
  }

  /**
   * 打开外链。**主路径是新端点** POST /api/desktop/dsh-tauri-rightclick/open/url
   * （协议收敛 + 串行队列都在服务端那一份实现里）；取不到端点时回落到 preload 暴露的
   * IPC（主进程同样只放行 http/https，且要求可信窗口）。两条路都失败才返回 false。
   *
   * ⚠️ **两种失败必须分开**（2026-10-01 修正）：
   *
   * 1) **本地判据曾用前缀正则** `/^https?:\/\//i` —— 与我在主进程/HTTP 那两处
   *    删掉的是同一条弱正则（问题 5 的第三次副本）。实测它与服务端 `new URL()`
   *    在 6 个输入上分歧：`https://a b`、`https://exa mple.com`、`http://`、
   *    `https://`、`http://[]`、`https://\u0000x` —— 前端全放行，服务端全拒。
   *    这里改成与服务端**同一判据**（`new URL()` + 严格比对协议），
   *    让"能不能发出去"在客户端就说清楚。
   *
   * 2) **业务拒绝 ≠ 传输失败**。原先 `if (response.ok && body?.ok) return true;`
   *    之后**无条件**走 IPC 兜底 —— 于是服务端明确回 400 `invalid-url`
   *    也会被当成"端点到不了"，再去试另一条路。
   *    这两件事语义完全不同：
   *      · **端点不可达**（fetch 抛错）→ 该试兜底 ✅
   *      · **服务端说这个 URL 非法**（拿到响应但 ok:false）→ **不该再试**，
   *        直接返回 false，否则等于用一条更弱的路去绕开一个明确的裁决 ❌
   *    这与 SSH 那边 `businessFailure returns HTTP 200 so business errors are not
   *    read as transport errors` 是同一条原则，此处原先违反了它。
   */
  function isSafeWebUrl(rawUrl) {
    const value = String(rawUrl || "").trim();
    if (!value) return false;
    try {
      const parsed = new URL(value);
      return parsed.protocol === "http:" || parsed.protocol === "https:";
    } catch {
      return false;
    }
  }

  async function openLinkExternally(rawUrl) {
    const url = String(rawUrl || "").trim();
    if (!isSafeWebUrl(url)) return false;

    let verdict = "unreachable"; // unreachable | rejected | accepted
    try {
      const response = await fetch("/api/desktop/dsh-tauri-rightclick/open/url", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ url }),
      });
      const body = await response.json().catch(() => null);
      if (response.ok && body?.ok) return true;
      // 拿到了响应但没成功 = 服务端**裁决**了（例如 400 invalid-url）。
      // 这是结论，不是"路不通"。
      verdict = "rejected";
    } catch {
      verdict = "unreachable";
    }
    if (verdict === "rejected") return false;

    // 只有端点真的不可达时才走 IPC 兜底。
    try {
      const viaBridge = await window.alice?.desktopOpen?.openUrl?.(url);
      return Boolean(viaBridge?.ok);
    } catch {
      return false;
    }
  }

  function copyConversationText() {
    const text = contextMenuPayload.text;
    if (!text) return;
    void writeClipboard(text).catch(() => {});
  }

  msgInput.addEventListener("contextmenu", event => {
    event.preventDefault();
    if (!contextMenu) return;
    placeContextMenu(contextMenu, event);
  });

  // 对话文本：整段聊天记录（含消息正文）右键。
  chatMessages?.addEventListener("contextmenu", event => {
    // 命中链接时优先给链接菜单——两件事的可用动作完全不同。
    const anchor = closestChatLink(event.target);
    if (anchor) {
      const href = String(anchor.getAttribute("href") || "").trim();
      if (href) {
        event.preventDefault();
        contextMenuPayload.link = href;
        fillContextMenu(linkContextMenu(), [
          { action: "copy-link", label: t("ctxMenu.copyLink") },
          { action: "open-link", label: t("ctxMenu.openLink") },
        ]);
        placeContextMenu(linkContextMenu(), event);
        return;
      }
    }
    event.preventDefault();
    // 选中了哪一段就复制哪一段；没选中则复制整段对话。
    // 在 contextmenu 时刻取值（而不是点击时刻），因为点击菜单可能已经让选区消失。
    const selected = String(window.getSelection?.()?.toString() || "").trim();
    contextMenuPayload.text = selected || String(chatMessages?.innerText || "").trim();
    fillContextMenu(conversationContextMenu(), [
      { action: "copy-text", label: t("ctxMenu.copy") },
      { action: "select-all-text", label: t("ctxMenu.selectAll") },
    ]);
    placeContextMenu(conversationContextMenu(), event);
  });

  // 三类菜单共用同一个动作分发（含输入框那类，替换掉原先只服务输入框的那份）。
  const CONTEXT_ACTION_HANDLERS = {
    close: () => {},
    "select-all": () => msgInput.select(),
    clear: () => { msgInput.value = ""; clearPastedImages(); autoGrowInput(); },
    copy: () => copyComposerSelection(),
    paste: () => pasteIntoComposer(),
    queue: () => send(),
    "copy-text": () => copyConversationText(),
    "select-all-text": () => selectConversationText(),
    "copy-link": () => { if (contextMenuPayload.link) void writeClipboard(contextMenuPayload.link).catch(() => {}); },
    "open-link": () => {
      const url = contextMenuPayload.link;
      if (url) void openLinkExternally(url).then(ok => { if (!ok) addMsg("jarvis", t("ctxMenu.openFailed")); });
    },
  };

  function handleContextMenuAction(event) {
    const action = event.target.closest("[data-context-action]")?.dataset.contextAction;
    if (!action) return;
    const handler = CONTEXT_ACTION_HANDLERS[action];
    closeContextMenus();
    handler?.();
  }

  contextMenu?.addEventListener("click", handleContextMenuAction);

  document.addEventListener("pointerdown", event => {
    for (const menu of allContextMenus()) {
      if (!menu.hidden && !menu.contains(event.target)) menu.hidden = true;
    }
  });

  chatArea.addEventListener("mouseenter", () => {
    if (closeTimer) { clearTimeout(closeTimer); closeTimer = null; }
    openChat();
  });
  chatArea.addEventListener("mouseleave", () => scheduleClose());
  chatPinButton?.addEventListener("click", () => setChatPinned(!chatPinned));
  msgInput.addEventListener("focus", () => {
    openChat();
    if (!inputLocked) msgInput.placeholder = defaultInputPlaceholder();
  });
  msgInput.addEventListener("blur", () => {
    compositionActive = false;
    if (!inputLocked) msgInput.placeholder = idlePlaceholder();
    if (!isTyping()) scheduleClose();
    // 延迟关闭，让命令项的 mousedown 先触发
    setTimeout(hideSlashMenu, 120);
  });
  msgInput.addEventListener("input", () => {
    autoGrowInput();
    updateSlashMenu();
    if (isTyping()) openChat();
    else if (!hasPendingJarvisMessage || pendingMessageDismissed) scheduleClose();
  });
  msgInput.addEventListener("paste", (event) => {
    const imageFiles = collectClipboardImageFiles(event);
    if (imageFiles.length) {
      addPastedImageFiles(imageFiles);
      openChat();
    }
  });
  msgInput.addEventListener("compositionstart", () => {
    compositionActive = true;
  });
  msgInput.addEventListener("compositionend", () => {
    compositionActive = false;
  });
  msgInput.addEventListener("keydown", event => {
    // 输入法中的 Enter/方向键用于确认或选择候选，不能触发发送或斜杠菜单。
    if (isImeComposing(event, compositionActive)) return;
    if (handleSlashKeydown(event)) return;
    if (event.key === "Enter" && !event.shiftKey) {
      event.preventDefault();
      send();
    }
  });
  sendBtn.addEventListener("click", () => send());
  window.addEventListener("alice:space-ptt-change", () => {
    if (!inputLocked) msgInput.placeholder = idlePlaceholder();
  });

  // 初始未聚焦：显示语音输入提示
  if (!inputLocked) msgInput.placeholder = idlePlaceholder();

  // ── 斜杠命令 ────────────────────────────────────────────────
  // 输入框以 "/" 开头时弹出命令菜单。ASR/TTS/LLM 直接打开对应设置面板；
  // 视频生成无独立面板，预填一句配置请求由 Agent 引导。
  const slashMenu = document.getElementById("slash-menu");
  const SLASH_COMMANDS = [
    {
      cmd: "/llm", keys: ["llm", "模型", "model"],
      label: t("slash.llmLabel"), desc: t("slash.llmDescription"),
      run: () => openSettings?.("llm"),
    },
    {
      cmd: "/voice", keys: ["voice", "asr", "语音对话", "语音识别", "shibie"],
      label: t("slash.voiceLabel"), desc: t("slash.voiceDescription"),
      run: () => openSettings?.("voice"),
    },
    {
      cmd: "/tts", keys: ["tts", "语音合成", "hecheng"],
      label: t("slash.ttsLabel"), desc: t("slash.ttsDescription"),
      run: openVoiceTTS,
    },
    {
      cmd: "/video", keys: ["video", "视频", "视频生成", "seedance", "huoshan"],
      label: t("slash.videoLabel"), desc: t("slash.videoDescription"),
      run: prefillVideoConfig,
    },
    {
      cmd: "/schedules", keys: ["schedules", "提醒", "定时", "调度", "reminder", "tixing"],
      label: t("slash.schedulesLabel"), desc: t("slash.schedulesDescription"),
      run: () => openSchedules?.(),
    },
    {
      cmd: "/worktrees", keys: ["worktrees", "worktree", "工作树", "隔离", "隔离区", "gongzuoshu"],
      label: t("slash.worktreesLabel"), desc: t("slash.worktreesDescription"),
      run: () => openWorktrees?.(),
    },
    {
      cmd: "/compaction", keys: ["compaction", "compact", "压缩", "上下文", "轨迹", "摘要", "yasuo", "shangxiawen"],
      label: t("slash.compactionLabel"), desc: t("slash.compactionDescription"),
      run: () => openCompaction?.(),
    },
    {
      cmd: "/workflow", keys: ["workflow", "工作流", "编排", "运行面板", "gongzuoliu", "bianpai"],
      label: t("slash.workflowLabel"), desc: t("slash.workflowDescription"),
      run: () => openWorkflow?.(),
    },
    // 插件面板的入口。**这一条是内置的静态命令**：插件自己声明的命令由
    // registerPluginCommands() 在启动时追加进来（插件声明的数据来自 GET /plugins/ui）。
    {
      cmd: "/plugins", keys: ["plugins", "plugin", "插件", "扩展", "chajian", "kuozhan"],
      label: t("slash.pluginsLabel"), desc: t("slash.pluginsDescription"),
      run: () => window.dispatchEvent(new CustomEvent("blm:open-plugins")),
    },
    {
      cmd: "/help", keys: ["help", "帮助", "命令"],
      label: t("slash.helpLabel"), desc: t("slash.helpDescription"),
      run: showSlashHelp,
    },
  ];

  let slashItems = [];    // 当前过滤后的命令
  let slashActive = -1;   // 当前高亮索引

  function slashQuery() {
    const v = msgInput.value;
    if (!v.startsWith("/")) return null;
    return v.slice(1).trim().toLowerCase();
  }

  function filterSlash(q) {
    if (!q) return SLASH_COMMANDS.slice();
    return SLASH_COMMANDS.filter(c =>
      c.cmd.slice(1).startsWith(q) ||
      c.keys.some(k => k.toLowerCase().includes(q)) ||
      c.label.includes(q)
    );
  }

  function renderSlashMenu() {
    slashMenu.innerHTML = "";
    if (!slashItems.length) {
      const empty = document.createElement("div");
      empty.className = "slash-empty";
      empty.textContent = t("shell.noMatchingCommand");
      slashMenu.appendChild(empty);
      return;
    }
    slashItems.forEach((c, i) => {
      const item = document.createElement("div");
      item.className = "slash-item" + (i === slashActive ? " active" : "");
      item.setAttribute("role", "option");
      item.innerHTML =
        '<span class="slash-cmd"></span>' +
        '<span class="slash-text"><div class="slash-label"></div><div class="slash-desc"></div></span>';
      item.querySelector(".slash-cmd").textContent = c.cmd;
      item.querySelector(".slash-label").textContent = c.label;
      item.querySelector(".slash-desc").textContent = c.desc;
      // 用 mousedown 而非 click：抢在输入框 blur 之前执行，保留焦点
      item.addEventListener("mousedown", (e) => { e.preventDefault(); runSlash(c); });
      item.addEventListener("mouseenter", () => { slashActive = i; highlightSlash(); });
      slashMenu.appendChild(item);
    });
  }

  function highlightSlash() {
    Array.from(slashMenu.children).forEach((el, i) =>
      el.classList.toggle("active", i === slashActive));
  }

  function updateSlashMenu() {
    const q = slashQuery();
    if (q === null) { hideSlashMenu(); return; }
    slashItems = filterSlash(q);
    slashActive = slashItems.length ? 0 : -1;
    renderSlashMenu();
    slashMenu.hidden = false;
  }

  // 由输入框左下角 ◍ 按钮调用：不输入 "/" 也能直接列出全部命令
  function openSlashMenu() {
    slashItems = SLASH_COMMANDS.slice();
    slashActive = slashItems.length ? 0 : -1;
    renderSlashMenu();
    slashMenu.hidden = false;
  }

  function hideSlashMenu() {
    slashMenu.hidden = true;
    slashItems = [];
    slashActive = -1;
  }

  function handleSlashKeydown(event) {
    if (slashMenu.hidden) return false;
    switch (event.key) {
      case "ArrowDown":
        event.preventDefault();
        if (slashItems.length) { slashActive = (slashActive + 1) % slashItems.length; highlightSlash(); }
        return true;
      case "ArrowUp":
        event.preventDefault();
        if (slashItems.length) { slashActive = (slashActive - 1 + slashItems.length) % slashItems.length; highlightSlash(); }
        return true;
      case "Tab":
      case "Enter":
        if (slashActive >= 0 && slashItems[slashActive]) {
          event.preventDefault();
          runSlash(slashItems[slashActive]);
          return true;
        }
        return false;
      case "Escape":
        event.preventDefault();
        hideSlashMenu();
        return true;
      default:
        return false;
    }
  }

  function runSlash(c) {
    hideSlashMenu();
    msgInput.value = "";   // 清掉已输入的 "/xxx"
    autoGrowInput();
    try { c.run(); } catch (e) { console.warn("[slash]", c.cmd, e); }
  }

  function openVoiceTTS() {
    openSettings?.("voice");
    setTimeout(() => {
      document.getElementById("settings-tts-section")
        ?.scrollIntoView({ behavior: "smooth", block: "start" });
    }, 80);
  }

  function prefillVideoConfig() {
    // 视频生成（火山方舟 Seedance）没有独立设置面板，靠对话引导配置
    msgInput.value = t("slash.videoPrompt");
    openChat();
    autoGrowInput();
    try { msgInput.focus(); } catch {}
  }

  /**
   * 把**插件清单里声明的**命令并进斜杠菜单（唯一一处改动最小的接入点：静态数组 + 追加）。
   * 转换规则与查重全在模块级的 buildPluginSlashCommands() 里（纯函数、可直接测）；
   * 这里只做两件与 DOM 有关的事：给每一项接上 `run`，以及把结果 push 进菜单数组。
   *
   * 点击的效果与 `/video` 一致：把 prompt **预填进输入框**，**不自动发送**。
   * @returns {number} 真正加入菜单的条数
   */
  function registerPluginCommands(commands) {
    const { items } = buildPluginSlashCommands(commands, { existing: SLASH_COMMANDS.map(c => c.cmd) });
    for (const item of items) {
      SLASH_COMMANDS.push({ ...item, run: () => prefillPluginPrompt(item.prompt) });
    }
    return items.length;
  }

  /**
   * 预填插件命令的模板。`{input}` 是「这里要补的输入」的占位符：把它去掉、**光标停在
   * 原来的位置**（而不是留一个字面量 `{input}` 让用户自己删）。没有占位符就整句预填。
   * 同 prefillVideoConfig：只预填，不发送——发送权始终在用户手上。
   */
  function prefillPluginPrompt(template) {
    const token = "{input}";
    const at = template.indexOf(token);
    msgInput.value = at === -1 ? template : `${template.slice(0, at)}${template.slice(at + token.length)}`;
    openChat();
    autoGrowInput();
    try { msgInput.focus(); } catch {}
    if (at !== -1) {
      try { msgInput.setSelectionRange(at, at); } catch {}
    }
  }

  function showSlashHelp() {
    const lines = SLASH_COMMANDS.map(c => `· \`${c.cmd}\` — ${c.label}：${c.desc}`).join("\n");
    addMsg("jarvis", `${t("slash.helpIntro")}\n\n${lines}`, { alert: false, pending: false });
    openChat();
  }

  document.addEventListener("pointerdown", event => {
    if (chatArea.contains(event.target)) return;
    if (chatPinned) return;
    if (hasPendingJarvisMessage && !isTyping()) {
      pendingMessageDismissed = true;
      closeChat();
      return;
    }
    if (!isTyping()) {
      if (closeTimer) {
        clearTimeout(closeTimer);
        closeTimer = null;
      }
      chatHistory.classList.remove("open");
    }
  });

  setChatPinned(readPinnedPreference(), { persist: false });

  function deleteLastUserMsg() {
    const msgs = chatMessages.querySelectorAll('.msg-user')
    if (!msgs.length) return
    const last = msgs[msgs.length - 1]
    last.style.transition = 'opacity 0.3s ease'
    last.style.opacity = '0'
    setTimeout(() => last.remove(), 300)
  }

  // ── 流式回复气泡 ───────────────────────────────────────────────
  // 后端 LLM 边生成边通过 stream_chunk 推 token；这里先建一个空的 jarvis 气泡，
  // 随 token 到达不断重渲染，等权威的 message 事件到达再 finalize 成最终干净全文。
  // 该气泡始终是最后一个 .msg-jarvis，所以打断 ✋（updateLastJarvisMsg）照常作用其上。
  function beginLiveJarvisMsg({ alert = true } = {}) {
    if (liveEl) finalizeLiveJarvisMsg(null);  // 兜底：上一轮孤儿气泡先定稿
    const shouldScrollToBottom = isNearChatBottom();
    const div = document.createElement("div");
    div.className = "msg msg-jarvis msg-live";
    const labelSpan = document.createElement("span");
    labelSpan.className = "msg-label";
    labelSpan.textContent = getAgentName();
    div.appendChild(labelSpan);
    div.appendChild(createMarkdownBody(""));
    chatMessages.appendChild(div);
    liveEl = div;
    hasPendingJarvisMessage = true;
    pendingMessageDismissed = false;
    if (alert) playJarvisAlert();
    openChat();
    scrollChatToBottomIfFollowing(shouldScrollToBottom);
  }

  function updateLiveJarvisMsg(text) {
    if (!liveEl) return;
    const shouldScrollToBottom = isNearChatBottom();
    const children = Array.from(liveEl.children);
    for (let i = 1; i < children.length; i++) children[i].remove();
    liveEl.appendChild(createMarkdownBody(text));
    scrollChatToBottomIfFollowing(shouldScrollToBottom);
  }

  // text 为字符串则替换为权威全文；为 null 仅去掉 live 标记（保留已流出的内容）
  function finalizeLiveJarvisMsg(text, options = {}) {
    if (!liveEl) return false;
    const shouldScrollToBottom = isNearChatBottom();
    if (typeof text === "string") {
      const labelText = getAgentName();
      if (!claimRenderedMessage({ messageId: options.messageId, role: "jarvis", text, label: labelText, source: options.source || "event" })) {
        liveEl.remove();
        liveEl = null;
        return false;
      }
      const normalizedId = normalizeMessageId(options.messageId);
      if (normalizedId) liveEl.dataset.messageId = normalizedId;
      const children = Array.from(liveEl.children);
      for (let i = 1; i < children.length; i++) children[i].remove();
      liveEl.appendChild(createMarkdownBody(text));
      liveEl.appendChild(createMsgActions(text, { messageId: normalizedId }));
    }
    liveEl.classList.remove("msg-live");
    liveEl = null;
    scrollChatToBottomIfFollowing(shouldScrollToBottom);
    return true;
  }

  function hasLiveJarvisMsg() { return !!liveEl; }

  function updateLastJarvisMsg(newText) {
    const msgs = chatMessages.querySelectorAll('.msg-jarvis');
    if (!msgs.length) return;
    const shouldScrollToBottom = isNearChatBottom();
    const last = msgs[msgs.length - 1];
    const children = Array.from(last.children);
    for (let i = 1; i < children.length; i++) children[i].remove();
    last.appendChild(createMarkdownBody(newText));
    last.appendChild(createMsgActions(newText, { messageId: last.dataset.messageId || "" }));
    scrollChatToBottomIfFollowing(shouldScrollToBottom);
  }

  return {
    addMsg,
    deleteLastUserMsg,
    updateLastJarvisMsg,
    beginLiveJarvisMsg,
    updateLiveJarvisMsg,
    finalizeLiveJarvisMsg,
    hasLiveJarvisMsg,
    setAgentRunning,
    isAgentRunning: () => agentRunning,
    applyActivationWarmupLock,
    isComposerLocked: () => inputLocked,
    isTyping,
    openChat,
    restoreChatHistory,
    reconcileSentMessage,
    reconcileResourceMessage,
    markResourceMessagesConsumed,
    send,
    addAttachmentFiles: addPastedImageFiles,
    openCommandMenu: openSlashMenu,
    unlockAudioOnFirstGesture,
    registerPluginCommands,
  };
}
