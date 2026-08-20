// 工作流运行面板：本次进程内跑过的工作流 —— 阶段进度、每项子代理成没成、耗时、失败原因。
//
// 为什么要一个面板：工作流引擎（agent / pipeline / parallel / phase / log）早就在跑，
// 进度也确实经 SSE 进了「思考流」。但思考流是**滚动**的：一次扇出 30 个子代理，条目会
// 被后面的话挤走，跑完就再也翻不到「哪一项失败了、卡在哪个阶段」。用户没有任何一个地方
// 能停下来看一份清单。这个面板就是那个地方。
//
// 与后端的分工（**硬约束**，与 worktree-panel.js / compaction-panel.js 同一条）：
// 「阶段耗时、每项状态、计数、日志截断、错误码」全部由服务端算好下发
// （GET /workflow/runs 的 phases / items / counts / duration_ms / code 等字段）。
// 面板跑在浏览器里，import 不到 src/runtime/，在这里重写一份统计就是两份口径迟早对不上——
// 而对不上的后果是「面板说这一项成了，实际它返回了 null」。
// 面板自己只做三件事：把服务端给的数字摆出来、把 code 翻成当前语言的文案、把时间格式化。
//
// **诚实声明（必须显示给用户）**：服务端的运行登记是**内存态**，进程重启即清空。
// 所以面板顶部常驻一句「只显示本次进程内的运行，重启后清空」，绝不把它包装成持久历史。
// 同理：失败、超时、被上限截断的运行都照实显示错误码与原因，不做「看起来完成了」的粉饰。
import { t, formatDateTime } from "./i18n/index.js";

const POLL_MS = 3000;

const STATE = {
  loaded: false,
  runs: [],
  total: 0,
  running: 0,
  capacity: 0,
  truncated: false,
  filter: "all",
  error: "",
};

let pollTimer = null;

const el = (id) => document.getElementById(id);

export const createWorkflowPanel = () => `
<div class="workflow-panel" id="workflow-panel" aria-live="polite">
  <div class="wf-card">
    <div class="wf-head">
      <div class="wf-title" id="wf-title">${t("workflows.title")}</div>
      <div class="wf-actions">
        <button class="wf-btn" id="wf-refresh" type="button">${t("workflows.refresh")}</button>
        <button class="wf-exit-btn" id="wf-exit-btn" type="button" aria-label="${t("workflows.close")}" title="${t("workflows.close")}">×</button>
      </div>
    </div>

    <!-- 常驻的诚实声明：这份清单是进程内的，重启就没了。不放在空态里，
         因为用户恰恰是在有数据时才会误以为它是历史记录。 -->
    <div class="wf-notice" id="wf-notice">${t("workflows.notice")}</div>

    <div class="wf-toolbar">
      <label class="wf-filter">
        <span class="wf-filter-label">${t("workflows.filterLabel")}</span>
        <!-- value 是接口认识的状态值（all / running / completed / error），显示文案走 i18n -->
        <select id="wf-filter">
          <option value="all">${t("workflows.filter.all")}</option>
          <option value="running">${t("workflows.filter.running")}</option>
          <option value="completed">${t("workflows.filter.completed")}</option>
          <option value="error">${t("workflows.filter.error")}</option>
        </select>
      </label>
    </div>

    <div class="wf-summary" id="wf-summary"></div>
    <div class="wf-error" id="wf-error" hidden></div>
    <div class="wf-list" id="wf-list"></div>
  </div>
</div>
`;

function escapeHtml(value) {
  return String(value ?? "").replace(/[&<>"']/g, (ch) => (
    { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[ch]
  ));
}

/** 状态文案：服务端给的是稳定值（running / completed / error），面板只负责翻译。 */
function statusText(run) {
  const raw = String(run.status || "");
  const key = `workflows.status.${raw}`;
  const translated = t(key);
  if (translated !== key) return translated;
  // 认不出的状态：只有服务端明确给了 status_label 才用它；两个都没有就**原样显示空**，
  // 绝不退回「服务端状态值」再当文案渲染——那会在界面上印出一串机器码，
  // 看起来像一条正常记录。这里宁可空着（badge 的 tone 是 dim），也不编一个状态。
  return run.status_label || "";
}

/** 每项子代理的状态。认不出的状态原样显示，绝不编一个「完成」出来。 */
function itemStatusText(status) {
  const raw = String(status || "");
  const key = `workflows.itemStatus.${raw}`;
  const translated = t(key);
  return translated === key ? raw : translated;
}

/**
 * 错误码文案。引擎的错误码是有限集合，能翻就翻；服务端以后加了新码就先显示原码，
 * 绝不吞掉——「哪一类失败」正是这个面板存在的理由。
 */
function codeText(code) {
  const raw = String(code || "");
  if (!raw) return "";
  const key = `workflows.code.${raw}`;
  const translated = t(key);
  return translated === key ? raw : translated;
}

/** 毫秒 → 好读的时长。数字本身来自服务端，这里只负责摆成人能读的样子。 */
function fmtDuration(ms) {
  const n = Number(ms);
  if (!Number.isFinite(n) || n < 0) return "";
  if (n < 1000) return t("workflows.durationMs", { ms: Math.round(n) });
  const totalSec = Math.round(n / 1000);
  if (totalSec < 60) return t("workflows.durationSec", { s: totalSec });
  const min = Math.floor(totalSec / 60);
  const sec = totalSec % 60;
  if (min < 60) return t("workflows.durationMin", { m: min, s: sec });
  return t("workflows.durationLong", { h: Math.floor(min / 60), m: min % 60 });
}

function fmtWhen(value) {
  if (!value) return "";
  try {
    return formatDateTime(value, { dateStyle: "short", timeStyle: "short" });
  } catch {
    return String(value);
  }
}

function fmtNumber(value) {
  const n = Number(value);
  return Number.isFinite(n) ? String(n) : "0";
}

function tone(run) {
  if (run.status === "error") return "danger";
  if (run.status === "running") return "warn";
  if (run.status === "completed") return "ok";
  return "dim";
}

function renderSummary() {
  const box = el("wf-summary");
  if (!box) return;
  const lines = [];
  lines.push(`<div class="wf-summary-line">${escapeHtml(t("workflows.summary", {
    runs: fmtNumber(STATE.total),
    running: fmtNumber(STATE.running),
    capacity: fmtNumber(STATE.capacity),
  }))}</div>`);
  if (STATE.truncated) {
    lines.push(`<div class="wf-summary-note">${escapeHtml(t("workflows.truncated", {
      total: fmtNumber(STATE.total),
      shown: fmtNumber(STATE.runs.length),
    }))}</div>`);
  }
  // 过滤后一条都不剩时要说清「是过滤掉的，不是没有运行」——否则用户会以为记录丢了。
  if (STATE.filter !== "all" && STATE.runs.length === 0 && STATE.total > 0) {
    lines.push(`<div class="wf-summary-note">${escapeHtml(t("workflows.filteredEmpty"))}</div>`);
  }
  box.innerHTML = lines.join("");
}

function renderError(message) {
  const box = el("wf-error");
  if (!box) return;
  if (!message) {
    box.hidden = true;
    box.textContent = "";
    return;
  }
  box.hidden = false;
  box.textContent = message;
}

function phasesHtml(run) {
  const phases = Array.isArray(run.phases) ? run.phases : [];
  if (phases.length === 0) return "";
  const rows = phases.map((phase) => {
    const live = phase.live === true;
    const done = Number(phase.completed) || 0;
    const failed = Number(phase.failed) || 0;
    const running = Number(phase.running) || 0;
    const total = done + failed + running;
    const bits = [t("workflows.agents", { count: fmtNumber(total) })];
    if (done) bits.push(t("workflows.itemStatus.completed"));
    if (failed) bits.push(t("workflows.itemStatus.failed"));
    if (running) bits.push(t("workflows.itemStatus.running"));
    if (Number(phase.visits) > 1) bits.push(t("workflows.phaseVisits", { count: fmtNumber(phase.visits) }));
    const duration = fmtDuration(phase.duration_ms);
    return `
      <div class="wf-phase" data-live="${live ? "true" : "false"}">
        <div class="wf-phase-title">${escapeHtml(phase.title || t("workflows.noPhase"))}</div>
        <div class="wf-phase-meta">${escapeHtml(bits.join(" · "))}</div>
        <div class="wf-phase-dur">${escapeHtml(live ? t("workflows.live") : duration)}</div>
      </div>`;
  }).join("");
  return `
    <div class="wf-section-label">${escapeHtml(t("workflows.phasesLabel"))}</div>
    <div class="wf-phases">${rows}</div>`;
}

function itemsHtml(run) {
  const items = Array.isArray(run.items) ? run.items : [];
  if (items.length === 0 && !(Number(run.agents_omitted) > 0)) return "";
  const rows = items.map((item) => {
    const status = String(item.status || "unknown");
    const label = item.label || `#${item.seq}`;
    const when = item.at ? fmtWhen(item.at) : "";
    return `
      <div class="wf-item" data-tone="${escapeHtml(status)}">
        <span class="wf-item-seq">#${escapeHtml(fmtNumber(item.seq))}</span>
        <span class="wf-item-label">${escapeHtml(label)}</span>
        <span class="wf-item-phase">${escapeHtml(item.phase || t("workflows.noPhase"))}</span>
        <span class="wf-item-status" data-tone="${escapeHtml(status)}">${escapeHtml(itemStatusText(status))}</span>
        <span class="wf-item-when">${escapeHtml(when)}</span>
      </div>`;
  }).join("");
  const omitted = Number(run.agents_omitted) > 0
    ? `<div class="wf-note" data-tone="warn">${escapeHtml(t("workflows.agentsOmitted", { count: fmtNumber(run.agents_omitted) }))}</div>`
    : "";
  return `
    <div class="wf-section-label">${escapeHtml(t("workflows.itemsLabel"))}</div>
    <div class="wf-items">${rows}</div>
    ${omitted}`;
}

function logsHtml(run) {
  const logs = Array.isArray(run.logs) ? run.logs : [];
  if (logs.length === 0 && !(Number(run.logs_omitted) > 0)) return "";
  const omitted = Number(run.logs_omitted) > 0
    ? `<div class="wf-note" data-tone="warn">${escapeHtml(t("workflows.logsOmitted", { count: fmtNumber(run.logs_omitted) }))}</div>`
    : "";
  return `
    <div class="wf-section-label">${escapeHtml(t("workflows.logsLabel"))}</div>
    <pre class="wf-logs">${escapeHtml(logs.join("\n"))}</pre>
    ${omitted}`;
}

function runHtml(run, index) {
  const runTone = tone(run);
  const counts = run.counts || {};
  const metrics = [
    {
      label: t("workflows.metricAgents"),
      value: fmtNumber(run.agents_started),
      hint: t("workflows.metricAgentsHint", {
        completed: fmtNumber(counts.completed),
        failed: fmtNumber(counts.failed),
        running: fmtNumber(counts.running),
      }),
    },
    {
      label: t("workflows.metricDuration"),
      value: fmtDuration(run.duration_ms) || t("workflows.unknown"),
      hint: run.live === true ? t("workflows.live") : "",
    },
    {
      label: t("workflows.metricPhases"),
      value: fmtNumber((run.phases || []).length),
      hint: t("workflows.metricPhasesHint", { declared: fmtNumber((run.declared_phases || []).length) }),
    },
    {
      label: t("workflows.metricLogs"),
      value: fmtNumber((run.logs || []).length),
      hint: "",
    },
  ];

  // 失败必须写全：错误码（翻成母语）+ 引擎给的原文原因。只显示「失败」两个字
  // 等于把排查成本原样丢回给用户。
  const failure = run.status === "error"
    ? `
      <div class="wf-note" data-tone="danger">
        <div class="wf-note-code">${escapeHtml(codeText(run.code) || t("workflows.unknownCode"))}</div>
        ${run.error ? `<div class="wf-note-msg">${escapeHtml(run.error)}</div>` : `<div class="wf-note-msg">${escapeHtml(t("workflows.noErrorDetail"))}</div>`}
      </div>`
    : "";

  const limits = run.limits && typeof run.limits === "object"
    ? `<div class="wf-limits">${escapeHtml(t("workflows.limits", {
      concurrency: fmtNumber(run.limits.maxConcurrentAgents),
      total: fmtNumber(run.limits.maxTotalAgents),
      minutes: fmtNumber(Math.round((Number(run.limits.deadlineMs) || 0) / 60000)),
    }))}</div>`
    : "";

  const startedAt = fmtWhen(run.started_at);
  const endedAt = fmtWhen(run.ended_at);
  const span = endedAt ? `${startedAt} ~ ${endedAt}` : startedAt;

  return `
  <details class="wf-run" data-run-id="${escapeHtml(run.run_id || "")}" data-tone="${runTone}" data-index="${index}">
    <summary class="wf-run-head">
      <span class="wf-run-name">${escapeHtml(run.name || run.run_id || "")}</span>
      <span class="wf-badge" data-tone="${runTone}">${escapeHtml(statusText(run))}</span>
      <span class="wf-when">${escapeHtml(span)}</span>
      <span class="wf-run-dur">${escapeHtml(run.live === true ? t("workflows.live") : fmtDuration(run.duration_ms))}</span>
    </summary>
    <div class="wf-run-body">
      ${run.description ? `<div class="wf-desc">${escapeHtml(run.description)}</div>` : ""}
      <div class="wf-run-id">${escapeHtml(run.run_id || "")}</div>
      <div class="wf-grid">
        ${metrics.map(m => `
          <div class="wf-metric">
            <div class="wf-metric-label">${escapeHtml(m.label)}</div>
            <div class="wf-metric-value">${escapeHtml(m.value)}</div>
            <div class="wf-metric-hint">${escapeHtml(m.hint || "")}</div>
          </div>`).join("")}
      </div>
      ${failure}
      ${phasesHtml(run)}
      ${itemsHtml(run)}
      ${logsHtml(run)}
      ${limits}
    </div>
  </details>`;
}

function renderList() {
  const box = el("wf-list");
  if (!box) return;
  const rows = STATE.runs;
  // 折叠状态要保留：这个面板每 3 秒刷一次，一次重绘就把用户展开的那一条收回去，
  // 等于面板自己没法读。所以按 run_id 记住哪些是展开的。
  const openIds = new Set(
    Array.from(box.querySelectorAll("details.wf-run[open]"))
      .map((node) => node.getAttribute("data-run-id"))
      .filter(Boolean),
  );
  if (rows.length === 0) {
    box.innerHTML = `
      <div class="wf-empty">
        <div>${escapeHtml(t("workflows.empty"))}</div>
        <div class="wf-empty-hint">${escapeHtml(t("workflows.emptyHint"))}</div>
      </div>`;
    return;
  }
  box.innerHTML = rows.map((run, index) => runHtml(run, index)).join("");
  // 恢复展开状态
  if (openIds.size) {
    box.querySelectorAll("details.wf-run").forEach((node) => {
      if (openIds.has(node.getAttribute("data-run-id"))) node.open = true;
    });
  }
}

/** 客户端过滤：只按服务端给的状态筛，不改任何数字。 */
function matchesFilter(run) {
  return STATE.filter === "all" || String(run?.status) === STATE.filter;
}

async function load() {
  try {
    const res = await fetch("/workflow/runs", { headers: { Accept: "application/json" } });
    const payload = await res.json();
    if (!res.ok || payload?.ok === false) throw new Error(payload?.error || `HTTP ${res.status}`);
    STATE.runs = (Array.isArray(payload.runs) ? payload.runs : []).filter(matchesFilter);
    STATE.total = Number(payload.total) || 0;
    STATE.running = Number(payload.running) || 0;
    STATE.capacity = Number(payload.capacity) || 0;
    STATE.truncated = payload.truncated === true;
    STATE.error = "";
  } catch (error) {
    // 读不到就清空并说明原因，绝不把上一次的数据继续摆着当「当前值」。
    STATE.runs = [];
    STATE.total = 0;
    STATE.running = 0;
    STATE.truncated = false;
    STATE.error = `${t("workflows.loadFailed")}: ${error?.message || error}`;
  }
  STATE.loaded = true;
  renderError(STATE.error);
  renderSummary();
  renderList();
}

function stopPolling() {
  if (pollTimer) {
    clearInterval(pollTimer);
    pollTimer = null;
  }
}

function startPolling() {
  stopPolling();
  // 运行中时进度才会变，所以轮询只在面板开着的时候跑，关掉立刻停——
  // 一个没人看的浮层不该每 3 秒打一次接口。
  pollTimer = setInterval(() => { void load(); }, POLL_MS);
}

export function setWorkflowOpen(open) {
  const panel = el("workflow-panel");
  if (!panel) return;
  panel.classList.toggle("open", open === true);
  if (open === true) {
    // 每次打开都重读：运行是**背后**发生的（模型调用工作流工具），
    // 别处的改动不该等到下次刷新页面才看见。
    void load();
    startPolling();
  } else {
    stopPolling();
  }
}

export function initWorkflowPanel() {
  let panel = el("workflow-panel");
  if (!panel) {
    document.body.insertAdjacentHTML("beforeend", createWorkflowPanel());
    panel = el("workflow-panel");
  }
  if (!panel) return;

  // **把面板搬到 document.body**。它在 app-shell 里被注入到 .app-viewport 内，
  // 而祖先只要有一个 transform / filter / will-change，`position: fixed` 就会
  // **不再相对视口**而是相对那个祖先——表现就是「浮层没有铺满屏幕、压在页面某一块上」。
  // 挂到 body 直接绕开这类包含块陷阱（与 schedules-panel.js / worktree-panel.js 同一个坑）。
  if (panel.parentElement !== document.body) document.body.appendChild(panel);

  // 与其它面板同一套约定：内联脚本 / 工作区 iframe 也能打开它。
  window.addEventListener("blm:open-workflow", () => setWorkflowOpen(true));
  window.addEventListener("blm:close-workflow", () => setWorkflowOpen(false));

  el("wf-exit-btn")?.addEventListener("click", () => setWorkflowOpen(false));
  el("wf-refresh")?.addEventListener("click", () => { void load(); });
  el("wf-filter")?.addEventListener("change", (event) => {
    STATE.filter = String(event?.target?.value || "all");
    void load();
  });
}
