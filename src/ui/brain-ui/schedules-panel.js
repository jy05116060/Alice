// 调度面板（阶段 4/6 补做）：提醒目录 + 创建表单（cron / 时区 / 预览）+ 投递历史。
//
// 为什么自成一个面板文件：brain-ui 的约定是一个功能一个 `*-panel.js`（doc/knowledge/
// person-card/hotspot/worldcup/computer-status/typhoon/voice 都是这样），由 app.js 里
// initXxxPanel() 挂载。塞进 workspace-panel（那是「工作区」浮动面板，管 skills/MCP）
// 会让两件事的开关与生命周期纠缠在一起。
//
// 与后端的分工：**触发时刻一律由服务端算**（POST /schedules/validate）。前端不自己
// 推 cron——那会出现「表单预览说 9:00、实际 10:00 触发」这种最难查的偏差。
import { t } from "./i18n/index.js";

const STATE = {
  loaded: false,
  reminders: [],
  history: [],
  fields: null,
  preview: null,
  error: "",
  form: { kind: "daily", time: "09:00", timezone: "", weekday: "1", day_of_month: "1", cron: "0 9 * * *", seconds: "60", task: "" },
};

const el = (id) => document.getElementById(id);

export const createSchedulesPanel = () => `
<div class="schedules-panel" id="schedules-panel" aria-live="polite">
  <div class="sch-card">
    <div class="sch-head">
      <div class="sch-title" id="sch-title">${t("schedules.title")}</div>
      <div class="sch-actions">
        <button class="sch-btn" id="sch-refresh" type="button">${t("schedules.refresh")}</button>
        <button class="sch-exit-btn" id="sch-exit-btn" type="button" aria-label="${t("schedules.close")}" title="${t("schedules.close")}">×</button>
      </div>
    </div>

    <div class="sch-tabs">
      <button class="sch-tab active" id="sch-tab-list" type="button">${t("schedules.tabList")}</button>
      <button class="sch-tab" id="sch-tab-new" type="button">${t("schedules.tabNew")}</button>
      <button class="sch-tab" id="sch-tab-history" type="button">${t("schedules.tabHistory")}</button>
    </div>

    <div class="sch-error" id="sch-error" hidden></div>

    <div class="sch-pane" id="sch-pane-list">
      <div class="sch-list" id="sch-list"></div>
    </div>

    <div class="sch-pane" id="sch-pane-new" hidden>
      <div class="sch-form">
        <label class="sch-field">
          <span>${t("schedules.fieldTask")}</span>
          <input id="sch-task" type="text" placeholder="${t("schedules.placeholderTask")}" />
        </label>
        <label class="sch-field">
          <span>${t("schedules.fieldKind")}</span>
          <select id="sch-kind">
            <option value="daily">${t("schedules.kind.daily")}</option>
            <option value="weekly">${t("schedules.kind.weekly")}</option>
            <option value="monthly">${t("schedules.kind.monthly")}</option>
            <option value="cron">${t("schedules.kind.cron")}</option>
            <option value="interval">${t("schedules.kind.interval")}</option>
            <option value="once">${t("schedules.kind.once")}</option>
          </select>
        </label>
        <label class="sch-field" data-when="daily weekly monthly">
          <span>${t("schedules.fieldTime")}</span>
          <input id="sch-time" type="time" step="60" />
        </label>
        <label class="sch-field" data-when="weekly">
          <span>${t("schedules.fieldWeekday")}</span>
          <select id="sch-weekday">
            <option value="0">${t("schedules.weekday.0")}</option><option value="1">${t("schedules.weekday.1")}</option>
            <option value="2">${t("schedules.weekday.2")}</option><option value="3">${t("schedules.weekday.3")}</option>
            <option value="4">${t("schedules.weekday.4")}</option><option value="5">${t("schedules.weekday.5")}</option>
            <option value="6">${t("schedules.weekday.6")}</option>
          </select>
        </label>
        <label class="sch-field" data-when="monthly">
          <span>${t("schedules.fieldDayOfMonth")}</span>
          <input id="sch-dom" type="number" min="1" max="31" />
        </label>
        <label class="sch-field" data-when="cron">
          <span>${t("schedules.fieldCron")}</span>
          <input id="sch-cron" type="text" placeholder="*/15 9-17 * * 1-5" />
        </label>
        <label class="sch-field" data-when="interval">
          <span>${t("schedules.fieldSeconds")}</span>
          <input id="sch-seconds" type="number" min="1" />
        </label>
        <label class="sch-field" data-when="once">
          <span>${t("schedules.fieldDueAt")}</span>
          <input id="sch-due" type="datetime-local" />
        </label>
        <label class="sch-field">
          <span>${t("schedules.fieldTimezone")}</span>
          <input id="sch-timezone" type="text" placeholder="Asia/Shanghai" list="sch-tz-list" />
          <!-- value 必须是 IANA 名（接口就认这个），label 给人的眼睛看。
               Chromium 显示 label、插入 value；只显示 value 的浏览器也仍然可用。 -->
          <datalist id="sch-tz-list">
            <option value="Asia/Shanghai" label="${t("schedules.tz.shanghai")}"></option>
            <option value="UTC" label="${t("schedules.tz.utc")}"></option>
            <option value="Asia/Tokyo" label="${t("schedules.tz.tokyo")}"></option>
            <option value="Europe/London" label="${t("schedules.tz.london")}"></option>
            <option value="America/New_York" label="${t("schedules.tz.newYork")}"></option>
            <option value="America/Los_Angeles" label="${t("schedules.tz.losAngeles")}"></option>
          </datalist>
          <small class="sch-hint">${t("schedules.hintTimezone")}</small>
        </label>
      </div>
      <div class="sch-preview" id="sch-preview"></div>
      <div class="sch-form-actions">
        <button class="sch-btn primary" id="sch-submit" type="button">${t("schedules.create")}</button>
        <button class="sch-btn" id="sch-check" type="button">${t("schedules.previewBtn")}</button>
      </div>
    </div>

    <div class="sch-pane" id="sch-pane-history" hidden>
      <div class="sch-history" id="sch-history"></div>
    </div>
  </div>
</div>
`;

function collectSpec() {
  const form = STATE.form;
  const spec = { kind: form.kind };
  if (form.timezone.trim()) spec.timezone = form.timezone.trim();
  if (form.kind === "daily" || form.kind === "weekly" || form.kind === "monthly") spec.time = form.time
  if (form.kind === "weekly") spec.weekday = Number(form.weekday)
  if (form.kind === "monthly") spec.day_of_month = Number(form.day_of_month)
  if (form.kind === "cron") spec.cron = form.cron
  if (form.kind === "interval") spec.seconds = Number(form.seconds)
  if (form.kind === "once" && form.due_at) spec.due_at = form.due_at
  return spec
}

function syncForm() {
  STATE.form = {
    kind: el("sch-kind")?.value || "daily",
    task: el("sch-task")?.value || "",
    time: el("sch-time")?.value || "09:00",
    timezone: el("sch-timezone")?.value || "",
    weekday: el("sch-weekday")?.value || "1",
    day_of_month: el("sch-dom")?.value || "1",
    cron: el("sch-cron")?.value || "0 9 * * *",
    seconds: el("sch-seconds")?.value || "60",
    due_at: el("sch-due")?.value ? new Date(el("sch-due").value).toISOString() : "",
  };
}

/** 显示/隐藏与当前 kind 相关的字段——让表单只呈现需要填的东西。 */
function applyKindVisibility() {
  const kind = el("sch-kind")?.value || "daily";
  document.querySelectorAll("#schedules-panel [data-when]").forEach((node) => {
    const kinds = String(node.dataset.when).split(/\s+/);
    node.hidden = !kinds.includes(kind);
  });
}

function renderError(message) {
  const box = el("sch-error");
  if (!box) return;
  if (!message) {
    box.hidden = true;
    box.textContent = "";
    return;
  }
  box.hidden = false;
  box.textContent = message;
}

function renderList() {
  const box = el("sch-list");
  if (!box) return;
  if (STATE.reminders.length === 0) {
    box.innerHTML = `<div class="sch-empty">${t("schedules.empty")}</div>`;
    return;
  }
  box.innerHTML = STATE.reminders.map(row => `
    <div class="sch-row" data-id="${row.id}">
      <div class="sch-row-main">
        <div class="sch-row-task">${escapeHtml(row.task)}</div>
        <div class="sch-row-meta">${escapeHtml(row.description || "once")} · ${escapeHtml(row.due_at || "")}${row.timezone ? ` · ${escapeHtml(row.timezone)}` : ""}</div>
      </div>
      <button class="sch-btn danger" data-cancel="${row.id}" type="button">${t("schedules.cancel")}</button>
    </div>
  `).join("");
  box.querySelectorAll("[data-cancel]").forEach((btn) => {
    btn.addEventListener("click", () => cancelReminder(Number(btn.dataset.cancel)));
  });
}

function renderHistory() {
  const box = el("sch-history");
  if (!box) return;
  if (STATE.history.length === 0) {
    box.innerHTML = `<div class="sch-empty">${t("schedules.emptyHistory")}</div>`;
    return;
  }
  box.innerHTML = STATE.history.map(row => `
    <div class="sch-history-row ${row.verified ? "ok" : (row.delivered ? "warn" : "bad")}">
      <div class="sch-row-task">${escapeHtml(row.channel || "")} · ${row.verified ? t("schedules.verified") : (row.delivered ? t("schedules.delivered") : t("schedules.notDelivered"))}</div>
      <div class="sch-row-meta">${escapeHtml(row.created_at || "")}${row.error ? ` · ${escapeHtml(row.error)}` : ""}</div>
    </div>
  `).join("");
}

function renderPreview(result) {
  const box = el("sch-preview");
  if (!box) return;
  if (!result) { box.innerHTML = ""; return; }
  if (!result.ok) {
    box.innerHTML = `<div class="sch-preview-errors">${(result.errors || []).map(e =>
      `<div class="sch-preview-error">${escapeHtml(e.field || "")}: ${escapeHtml(e.message || "")}</div>`).join("")}</div>`;
    return;
  }
  box.innerHTML = `
    <div class="sch-preview-desc">${escapeHtml(result.description || "")}${result.timezone ? ` · ${escapeHtml(result.timezone)}` : ""}</div>
    <ul class="sch-preview-list">
      ${(result.occurrences || []).map(o => `<li>${escapeHtml(o.local)} <span class="sch-preview-abs">${escapeHtml(o.at)}</span></li>`).join("")}
    </ul>
  `;
}

async function load() {
  try {
    const res = await fetch("/schedules", { headers: { Accept: "application/json" } });
    const body = await res.json();
    STATE.reminders = body.reminders || [];
    STATE.history = body.delivery_history || [];
    STATE.fields = body.fields || null;
    STATE.error = "";
  } catch (error) {
    STATE.error = `${t("schedules.loadFailed")}: ${error?.message || error}`;
  }
  STATE.loaded = true;
  renderError(STATE.error);
  renderList();
  renderHistory();
}

async function checkSpec({ preview = false } = {}) {
  syncForm();
  const spec = collectSpec();
  const path = preview ? "/schedules/validate" : "/schedules/check";
  try {
    const res = await fetch(path, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ ...spec, preview_count: 5 }),
    });
    const body = await res.json();
    STATE.preview = body;
    renderPreview(preview ? body : null);
    renderError(body.ok ? "" : (body.errors || []).map(e => `${e.field}: ${e.message}`).join("；"));
    return body.ok;
  } catch (error) {
    renderError(`${t("schedules.checkFailed")}: ${error?.message || error}`);
    return false;
  }
}

async function submit() {
  if (!(await checkSpec({ preview: false }))) return;
  syncForm();
  try {
    const res = await fetch("/schedules", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ ...collectSpec(), task: STATE.form.task, target_id: "ID:000001" }),
    });
    const body = await res.json();
    if (!res.ok || body.ok === false) {
      renderError(body.error || t("schedules.createFailed"));
      return;
    }
    renderError("");
    STATE.preview = null;
    renderPreview(null);
    await load();
    // 建完就告诉 iframe 里的「定时任务」列表：否则它一直显示创建前的旧内容
    notifySchedulesChanged();
    switchTab("list");
  } catch (error) {
    renderError(`${t("schedules.createFailed")}: ${error?.message || error}`);
  }
}

async function cancelReminder(id) {
  try {
    const res = await fetch(`/schedules/${id}`, { method: "DELETE" });
    const body = await res.json();
    if (!res.ok || body.ok === false) {
      renderError(body.error || t("schedules.cancelFailed"));
      return;
    }
    await load();
    notifySchedulesChanged();
  } catch (error) {
    renderError(`${t("schedules.cancelFailed")}: ${error?.message || error}`);
  }
}

/**
 * 通知所有工作区 iframe：提醒数据变了，请重读。
 *
 * 为什么必需：「定时任务」列表在**另一个 iframe** 里（workspace-embed.html），
 * 它只在加载时读一次。面板这边建完/删完不吭声，那个列表就会一直显示旧内容
 * ——用户看到的就是「创建了任务，但定时任务面板里没有」。
 * 广播到所有 iframe（都是本应用的），不去猜哪个是哪个。
 */
function notifySchedulesChanged() {
  for (const frame of document.querySelectorAll("iframe")) {
    try { frame.contentWindow?.postMessage({ type: "bl-schedules-changed" }, "*"); } catch { /* 跨源或未就绪，忽略 */ }
  }
}

function switchTab(which) {  const panes = { list: el("sch-pane-list"), new: el("sch-pane-new"), history: el("sch-pane-history") };
  const tabs = { list: el("sch-tab-list"), new: el("sch-tab-new"), history: el("sch-tab-history") };
  for (const key of Object.keys(panes)) {
    if (panes[key]) panes[key].hidden = key !== which;
    if (tabs[key]) tabs[key].classList.toggle("active", key === which);
  }
}

function escapeHtml(value) {
  return String(value ?? "").replace(/[&<>"']/g, (ch) => (
    { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[ch]
  ));
}

export function setSchedulesOpen(open) {
  const panel = el("schedules-panel");
  if (!panel) return;
  panel.classList.toggle("open", open === true);
  // 每次打开都重读：别处的改动（工具、自动触发）不该等到下次刷新页面才看见
  if (open === true) load();
}

export function initSchedulesPanel() {
  let panel = el("schedules-panel");
  if (!panel) return;

  // **把面板搬到 document.body**。它在 app-shell 里被注入到 .app-viewport 内，
  // 而祖先只要有一个 transform / filter / will-change，`position: fixed` 就会
  // **不再相对视口**而是相对那个祖先——表现就是「浮层没有铺满屏幕、压在页面某一块上」。
  // 挂到 body 直接绕开这类包含块陷阱，不依赖去排查是哪一层带的 transform。
  if (panel.parentElement !== document.body) document.body.appendChild(panel);

  // 工作区面板（workspace-embed.html 的内联脚本）要能打开它。那边是普通内联脚本，
  // 拿不到本模块的导出，所以走自定义事件——比挂一个全局函数干净，也不会和
  // 那边的命名空间打架。
  window.addEventListener("blm:open-schedules", () => setSchedulesOpen(true));
  window.addEventListener("blm:close-schedules", () => setSchedulesOpen(false));

  el("sch-exit-btn")?.addEventListener("click", () => setSchedulesOpen(false));
  el("sch-refresh")?.addEventListener("click", () => load());
  el("sch-tab-list")?.addEventListener("click", () => switchTab("list"));
  el("sch-tab-new")?.addEventListener("click", () => switchTab("new"));
  el("sch-tab-history")?.addEventListener("click", () => switchTab("history"));
  el("sch-kind")?.addEventListener("change", () => { applyKindVisibility(); STATE.preview = null; renderPreview(null); });
  el("sch-check")?.addEventListener("click", () => checkSpec({ preview: true }));
  el("sch-submit")?.addEventListener("click", () => submit());

  // 表单里任何一处改动都清掉上一次的预览结果：留着过期预览比不显示更容易误导
  panel.querySelectorAll("input, select").forEach((node) => {
    node.addEventListener("input", () => {
      if (STATE.preview) { STATE.preview = null; renderPreview(null); }
    });
  });

  applyKindVisibility();
  if (el("sch-time") && !el("sch-time").value) el("sch-time").value = "09:00";
  if (el("sch-dom") && !el("sch-dom").value) el("sch-dom").value = "1";
  if (el("sch-seconds") && !el("sch-seconds").value) el("sch-seconds").value = "60";
  if (el("sch-cron") && !el("sch-cron").value) el("sch-cron").value = "0 9 * * *";
}
