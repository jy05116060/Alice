// 通用「插件」面板：把插件**在清单里声明的**面板页用 iframe 显示出来，并把声明的命令
// 交给斜杠菜单。
//
// 为什么是**一个**通用面板，而不是每个插件一个 `*-panel.js`：插件是用户自己放进数据目录的
// 东西，界面不可能提前知道会有什么。brain-ui 的 `*-panel.js` 约定（自挂 document.body、
// `position: fixed; inset: 0`、z-index 900、主题令牌）在这里照用，只是内容由插件自己提供。
//
// 扩展点为什么是**声明式**的，不是运行时注册函数
// ---------------------------------------------------------------------------
// 插件的代码跑在**主进程**（`import()` 进宿主的 Node 进程），界面跑在**渲染进程**——
// 一个 JS 函数跨不过这道边界。宿主能交给界面的只有清单里那段**可序列化的数据**：
// cmd / label / description / prompt 模板 / 一个 HTML 文件路径。所以这里拿到的永远只是
// 数据，界面上不存在「执行插件给的函数」这条路径——那既做不到，也不是我们想要的东西。
//
// ⚠️ 诚实边界一：这不是沙箱，只是**结构隔离**
// ---------------------------------------------------------------------------
// 面板 HTML 由 `GET /plugins/ui/<pluginId>/<panelId>` 下发，被下面的 iframe 在
// **应用同源**下加载。同源 iframe 能做的一切它都能做：读宿主的 DOM、带用户身份发请求
// （连 `fetch` 都被 api-client.js 打过补丁，会自动带上 API token）。这里**没有** sandbox
// 属性——加不加都不改变「插件本身是完全受信的进程内代码」这个事实，假装隔离比不隔离更危险。
// 真正的边界见 `src/runtime/plugin-host.js` 文件头：**不要把别人的插件放进插件目录。**
//
// ⚠️ 诚实边界二：插件声明的文案不参与 i18n
// ---------------------------------------------------------------------------
// 命令的 label/description 与面板的 title 直接来自插件清单，按原样显示（中文界面里的
// 英文命令就是英文，英文界面里的中文就是中文）。插件声明不是界面文案表的一部分——
// 界面无法为「用户明天写的一个插件」准备译文。
//
// 与后端的分工（**硬约束**，与 worktree-panel.js / workflow-panel.js 同一条）：
// 「哪些命令/面板是合法的、面板文件在不在、路径有没有越界」全部由主进程判定并下发；
// 界面只负责显示、以及把点击接到已有的机制上（预填输入框 / iframe 加载）。
import { t } from "./i18n/index.js";
import { apiUrl } from "./api-client.js";

const STATE = {
  loaded: false,
  panels: [],
  commands: [],
  errors: [],
  activeKey: "",
  error: "",
};

const el = (id) => document.getElementById(id);

/** 斜杠菜单的接入口。chat.js 就绪得比本模块晚（它在 app.js 靠后的一段里才 init），
 *  所以这里存一个「接收器」，谁先到都不会把命令丢掉。 */
let commandSink = null;
let lastCommands = [];

export const createPluginPanel = () => `
<div class="plugin-panel" id="plugin-panel" aria-live="polite">
  <div class="pp-card">
    <div class="pp-head">
      <div class="pp-title" id="pp-title">${t("plugins.title")}</div>
      <div class="pp-actions">
        <button class="pp-btn" id="pp-refresh" type="button">${t("plugins.refresh")}</button>
        <button class="pp-exit-btn" id="pp-exit-btn" type="button" aria-label="${t("plugins.close")}" title="${t("plugins.close")}">×</button>
      </div>
    </div>

    <!-- 常驻诚实声明：面板不是被隔离的东西。它不藏在空态里——用户恰恰是在**有**面板时
         才会误以为「插件跑在沙箱里」。 -->
    <div class="pp-notice" id="pp-notice">${t("plugins.isolationNotice")}</div>

    <div class="pp-error" id="pp-error" hidden></div>

    <div class="pp-body">
      <div class="pp-side">
        <div class="pp-section-label">${t("plugins.panelsLabel")}</div>
        <div class="pp-list" id="pp-list"></div>
        <div class="pp-section-label">${t("plugins.commandsLabel")}</div>
        <div class="pp-commands" id="pp-commands"></div>
        <div class="pp-section-label">${t("plugins.errorsLabel")}</div>
        <div class="pp-errors" id="pp-errors"></div>
      </div>
      <div class="pp-stage">
        <div class="pp-empty" id="pp-empty">${t("plugins.empty")}</div>
        <!-- 不写 sandbox：面板是**同源**加载的（见文件头「诚实边界一」）。 -->
        <iframe class="pp-frame" id="pp-frame" title="${t("plugins.frameTitle")}" hidden></iframe>
      </div>
    </div>
  </div>
</div>
`;

function escapeHtml(value) {
  return String(value ?? "").replace(/[&<>"']/g, (ch) => (
    { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[ch]
  ));
}

function panelKey(panel) {
  return `${panel?.plugin_id || ""}/${panel?.id || ""}`;
}

function renderError(message) {
  const box = el("pp-error");
  if (!box) return;
  if (!message) {
    box.hidden = true;
    box.textContent = "";
    return;
  }
  box.hidden = false;
  box.textContent = message;
}

function renderPanels() {
  const box = el("pp-list");
  if (!box) return;
  if (STATE.panels.length === 0) {
    box.innerHTML = `<div class="pp-hint">${t("plugins.noPanels")}</div>`;
    return;
  }
  box.innerHTML = STATE.panels.map((panel) => {
    const active = panelKey(panel) === STATE.activeKey;
    return `
      <button class="pp-item${active ? " active" : ""}" data-panel="${escapeHtml(panelKey(panel))}" type="button">
        <span class="pp-item-title">${escapeHtml(panel.title || panel.id)}</span>
        <span class="pp-item-meta">${escapeHtml(panel.plugin_id)}/${escapeHtml(panel.id)}</span>
      </button>`;
  }).join("");
  box.querySelectorAll("[data-panel]").forEach((btn) => {
    btn.addEventListener("click", () => {
      const key = btn.dataset.panel;
      const panel = STATE.panels.find(item => panelKey(item) === key);
      if (panel) openPanel(panel);
    });
  });
}

function renderCommands() {
  const box = el("pp-commands");
  if (!box) return;
  if (STATE.commands.length === 0) {
    box.innerHTML = `<div class="pp-hint">${t("plugins.noCommands")}</div>`;
    return;
  }
  // 只**说明**这些命令是什么；真正的菜单项在斜杠菜单里（点它是预填，不是自动发送）。
  box.innerHTML = STATE.commands.map(command => `
    <div class="pp-command">
      <span class="pp-command-cmd">${escapeHtml(command.cmd)}</span>
      <span class="pp-command-label">${escapeHtml(command.label || "")}</span>
      <span class="pp-command-meta">${escapeHtml(command.plugin_id || "")}</span>
    </div>`).join("");
}

const PLUGIN_ERROR_KEYS = Object.freeze({
  BAD_MANIFEST: "plugins.error.manifest",
  BAD_UI_SECTION: "plugins.error.manifest",
  BAD_UI_COMMAND: "plugins.error.command",
  BAD_UI_PANEL: "plugins.error.panel",
  ENTRY_NOT_FOUND: "plugins.error.entry",
  PLUGIN_PANEL_ENTRY_NOT_FOUND: "plugins.error.entry",
  PLUGIN_PANEL_ESCAPES_DIR: "plugins.error.path",
  PLUGIN_UI_DUPLICATE_COMMAND: "plugins.error.duplicate",
  PLUGIN_UI_DUPLICATE_PANEL: "plugins.error.duplicate",
});

export function pluginErrorLabel(code) {
  return t(PLUGIN_ERROR_KEYS[code] || "plugins.error.unavailable");
}

function renderErrors() {
  const box = el("pp-errors");
  if (!box) return;
  if (STATE.errors.length === 0) {
    box.innerHTML = `<div class="pp-hint">${t("plugins.noErrors")}</div>`;
    return;
  }
  // 先显示本地化说明，原始错误码和消息留在详情中，便于精确排查。
  box.innerHTML = STATE.errors.map(item => `
    <div class="pp-error-row">
      <span class="pp-error-plugin">${escapeHtml(item.plugin_id || "")}</span>
      <span class="pp-error-message">${escapeHtml(pluginErrorLabel(item.code))}</span>
      <details><summary>${escapeHtml(t("plugins.error.details"))}</summary>
        <code>${escapeHtml(item.code || "")}</code>
        <p>${escapeHtml(item.message || "")}</p>
      </details>
    </div>`).join("");
}

function openPanel(panel) {
  const frame = el("pp-frame");
  const empty = el("pp-empty");
  if (!frame) return;
  STATE.activeKey = panelKey(panel);
  frame.src = apiUrl(`/plugins/ui/${encodeURIComponent(panel.plugin_id)}/${encodeURIComponent(panel.id)}`);
  frame.hidden = false;
  if (empty) empty.hidden = true;
  renderPanels();
}

async function load() {
  try {
    const res = await fetch("/plugins/ui", { headers: { Accept: "application/json" } });
    const payload = await res.json();
    if (!res.ok || payload?.ok === false) throw new Error(payload?.error || `HTTP ${res.status}`);
    STATE.panels = Array.isArray(payload.panels) ? payload.panels : [];
    STATE.commands = Array.isArray(payload.commands) ? payload.commands : [];
    STATE.errors = Array.isArray(payload.errors) ? payload.errors : [];
    STATE.error = "";
    lastCommands = STATE.commands;
    // 每次重读都**重新喂一遍**：插件刚才被 reload / 启用，菜单项不该等到下次刷新页面才出现。
    commandSink?.(lastCommands.slice());
  } catch (error) {
    // 失败如实说出来，并把列表清空——留着上一次的结果会让用户以为插件还在。
    STATE.panels = [];
    STATE.commands = [];
    STATE.errors = [];
    STATE.error = `${t("plugins.loadFailed")}: ${error?.message || error}`;
  }
  STATE.loaded = true;
  renderError(STATE.error);
  renderPanels();
  renderCommands();
  renderErrors();
}

/**
 * 登记「把插件命令交给斜杠菜单」的接收器（app.js 在 chat 就绪后接上）。
 * 接收器晚到也不会丢命令：登记时把已经拉到手的声明立刻补喂一次。
 */
export function registerPluginCommandSink(sink) {
  commandSink = typeof sink === "function" ? sink : null;
  if (commandSink && lastCommands.length) commandSink(lastCommands.slice());
  return commandSink !== null;
}

export function setPluginsOpen(open) {
  const panel = el("plugin-panel");
  if (!panel) return;
  panel.classList.toggle("open", open === true);
  // 每次打开都重读：插件可能刚被启用/重载/改过清单。
  if (open === true) void load();
}

export function initPluginPanel() {
  let panel = el("plugin-panel");
  if (!panel) {
    document.body.insertAdjacentHTML("beforeend", createPluginPanel());
    panel = el("plugin-panel");
  }
  if (!panel) return;

  // **把面板搬到 document.body**。它在 app-shell 里被注入到 .app-viewport 内，而祖先只要
  // 有一个 transform / filter / will-change，`position: fixed` 就不再相对视口而是相对那个
  // 祖先——表现是「浮层没铺满屏幕」。挂到 body 直接绕开这类包含块陷阱（与 schedules-panel.js
  // / worktree-panel.js 同一个坑）。
  if (panel.parentElement !== document.body) document.body.appendChild(panel);

  // 与别的面板同一套约定：别处（内联脚本 / 工作区 iframe）也能打开它。
  window.addEventListener("blm:open-plugins", () => setPluginsOpen(true));
  window.addEventListener("blm:close-plugins", () => setPluginsOpen(false));

  el("pp-exit-btn")?.addEventListener("click", () => setPluginsOpen(false));
  el("pp-refresh")?.addEventListener("click", () => void load());

  void load();
}
