// 会话压缩轨迹面板（Turn-Trace）：历史上每一次上下文压缩**压掉了什么**、摘要是什么。
//
// 为什么要一个面板：压缩的后端能力（边界、滚动摘要、落库）早就在 runtime 里了，但用户
// 看不到它——上下文怎么被压的、压掉了多少、摘要写了什么，全都只发生在幕后。压缩最坏的
// 失败方式是**悄悄压掉了关键信息**，而用户连去哪儿看都不知道。这个面板就是那个「去哪儿看」。
//
// 与后端的分工（**硬约束**，与 worktree-panel.js 同一条）：「压掉了多少 token、省了几成、
// 覆盖了哪一段、原文条数对不对得上」全部由服务端算好下发（GET /compaction/history 的
// released_tokens / released_percent / source_complete / context_* 等字段）。面板跑在
// 浏览器里，import 不到 src/runtime/，在这里重写一份估算规则就是两份口径迟早对不上——
// 而对不上的后果是「面板说省了 8 万 token，实际模型还在原样重发」。
// 面板自己只做两件事：把服务端给的数字摆出来、把 code 翻成当前语言的文案。
import { t, formatDateTime, getLocale } from "./i18n/index.js";

const HISTORY_LIMIT = 50;

const STATE = {
  loaded: false,
  entries: [],
  totals: null,
  context: null,
  inFlight: false,
  activeId: null,
  total: 0,
  truncated: false,
  rowsError: null,
  error: "",
};

const el = (id) => document.getElementById(id);

export const createCompactionPanel = () => `
<div class="compaction-panel" id="compaction-panel" aria-live="polite">
  <div class="cmp-card">
    <div class="cmp-head">
      <div class="cmp-title" id="cmp-title">${t("compaction.title")}</div>
      <div class="cmp-actions">
        <button class="cmp-btn" id="cmp-refresh" type="button">${t("compaction.refresh")}</button>
        <button class="cmp-exit-btn" id="cmp-exit-btn" type="button" aria-label="${t("compaction.close")}" title="${t("compaction.close")}">×</button>
      </div>
    </div>

    <div class="cmp-summary" id="cmp-summary"></div>
    <div class="cmp-error" id="cmp-error" hidden></div>
    <div class="cmp-list" id="cmp-list"></div>
  </div>
</div>
`;

/** 千分位。数字本身来自服务端，这里只负责好读。 */
function fmt(value) {
  const n = Number(value);
  if (!Number.isFinite(n)) return "0";
  try {
    return new Intl.NumberFormat(getLocale() || undefined).format(n);
  } catch {
    return String(n);
  }
}

function fmtWhen(value) {
  if (!value) return "";
  return formatDateTime(value, { dateStyle: "short", timeStyle: "short" });
}

function fmtPercent(value) {
  const n = Number(value);
  return `${Number.isFinite(n) ? n.toFixed(1) : "0.0"}%`;
}

/**
 * 触发方式文案：服务端给的是稳定的 trigger 值（auto / manual），面板只把它翻成当前语言。
 * 认不出的值（服务端先加了新触发方式）原样显示，绝不编一个词出来。
 */
function triggerText(trigger) {
  const raw = String(trigger || "");
  const key = `compaction.trigger.${raw}`;
  const translated = t(key);
  return translated === key ? raw : translated;
}

/** 覆盖条数的诚实说法：登记值 vs 库里实际找到的原文档数。 */
function sourceNote(entry) {
  if (entry.source_complete === false) {
    return {
      tone: "danger",
      text: t("compaction.sourceIncomplete", {
        stored: fmt(entry.new_message_count),
        found: fmt(entry.source_rows_found),
      }),
    };
  }
  if (entry.source_complete === null) {
    return { tone: "dim", text: t("compaction.sourceUnknown") };
  }
  return null;
}

function renderSummary() {
  const box = el("cmp-summary");
  if (!box) return;
  const totals = STATE.totals;
  const ctx = STATE.context;
  const lines = [];

  if (totals && totals.runs > 0) {
    lines.push(`<div class="cmp-summary-line">${t("compaction.totals", {
      runs: fmt(totals.runs),
      tokens: fmt(totals.released_tokens),
      messages: fmt(totals.covered_messages),
    })}</div>`);
  }
  if (STATE.truncated) {
    lines.push(`<div class="cmp-summary-note">${t("compaction.truncated", {
      total: fmt(STATE.total),
      shown: fmt(STATE.entries.length),
    })}</div>`);
  }
  if (ctx && !ctx.error && Number(ctx.last_input_tokens) > 0) {
    lines.push(`<div class="cmp-summary-line">${t("compaction.pressure", {
      used: fmt(ctx.last_input_tokens),
      limit: fmt(ctx.limit_tokens),
      percent: fmtPercent(ctx.pressure_percent),
      window: fmt(ctx.context_window),
    })}</div>`);
  } else if (ctx && !ctx.error) {
    // 有窗口配置但还没有真实用量：不能写成「用了 0 token」——那是把「不知道」说成「很空」。
    lines.push(`<div class="cmp-summary-note">${t("compaction.pressureNoUsage", {
      limit: fmt(ctx.limit_tokens),
      window: fmt(ctx.context_window),
    })}</div>`);
  } else {
    lines.push(`<div class="cmp-summary-note">${t("compaction.pressureUnknown")}</div>`);
  }
  if (STATE.inFlight) {
    lines.push(`<div class="cmp-summary-note">${t("compaction.inFlight")}</div>`);
  }
  if (STATE.activeId !== null && STATE.activeId !== undefined) {
    lines.push(`<div class="cmp-summary-note">${t("compaction.activeId", { id: fmt(STATE.activeId) })}</div>`);
  }
  box.innerHTML = lines.join("");
}

function renderError(message) {
  const box = el("cmp-error");
  if (!box) return;
  if (!message) {
    box.hidden = true;
    box.textContent = "";
    return;
  }
  box.hidden = false;
  box.textContent = message;
}

function entryHtml(entry, index) {
  const tone = entry.source_complete === false
    ? "danger"
    : (Number(entry.released_tokens) > 0 ? "ok" : "dim");
  const note = sourceNote(entry);

  const metrics = [
    {
      label: t("compaction.metricBefore"),
      value: entry.context_tokens_before > 0 ? `${fmt(entry.context_tokens_before)} tok` : t("compaction.unknown"),
      hint: t("compaction.metricBeforeHint"),
    },
    {
      label: t("compaction.metricAfter"),
      value: entry.context_tokens_after > 0 ? `${fmt(entry.context_tokens_after)} tok` : t("compaction.unknown"),
      hint: t("compaction.metricAfterHint"),
    },
    {
      label: t("compaction.metricSpan"),
      value: `#${fmt(entry.new_from_id)} – #${fmt(entry.new_through_id)}`,
      hint: t("compaction.metricSpanHint", {
        now: fmt(entry.new_message_count),
        total: fmt(entry.message_count),
      }),
    },
    {
      label: t("compaction.metricSaved"),
      value: `${fmt(entry.released_tokens)} tok`,
      hint: t("compaction.metricSavedHint", {
        percent: fmtPercent(entry.released_percent),
        chars: fmt(entry.released_chars),
      }),
    },
    {
      label: t("compaction.metricRaw"),
      value: `${fmt(entry.new_tokens)} tok`,
      hint: t("compaction.metricRawHint", { chars: fmt(entry.new_chars) }),
    },
    {
      label: t("compaction.metricSummary"),
      value: `${fmt(entry.summary_tokens)} tok`,
      hint: t("compaction.metricSummaryHint", { chars: fmt(entry.summary_chars) }),
    },
  ];

  const span = (entry.span_first_at || entry.span_last_at)
    ? `${fmtWhen(entry.span_first_at)} ~ ${fmtWhen(entry.span_last_at)}`
    : "";

  return `
  <details class="cmp-entry" data-tone="${tone}">
    <summary class="cmp-entry-head">
      <span class="cmp-seq">#${escapeHtml(String(entry.compaction_id ?? index + 1))}</span>
      <span class="cmp-badge" data-tone="${tone}">${escapeHtml(triggerText(entry.trigger))}</span>
      <span class="cmp-when">${escapeHtml(fmtWhen(entry.created_at))}</span>
      <span class="cmp-saved">${t("compaction.savedShort", {
        tokens: fmt(entry.released_tokens),
        percent: fmtPercent(entry.released_percent),
      })}</span>
    </summary>
    <div class="cmp-entry-body">
      <div class="cmp-grid">
        ${metrics.map(m => `
          <div class="cmp-metric">
            <div class="cmp-metric-label">${escapeHtml(m.label)}</div>
            <div class="cmp-metric-value">${escapeHtml(m.value)}</div>
            <div class="cmp-metric-hint">${escapeHtml(m.hint)}</div>
          </div>`).join("")}
      </div>
      ${span ? `<div class="cmp-span">${escapeHtml(t("compaction.spanWindow", { span }))}</div>` : ""}
      ${note ? `<div class="cmp-note" data-tone="${note.tone}">${escapeHtml(note.text)}</div>` : ""}
      <div class="cmp-summary-label">${escapeHtml(t("compaction.summaryLabel"))}</div>
      <pre class="cmp-summary-text">${escapeHtml(entry.summary || t("compaction.summaryEmpty"))}</pre>
    </div>
  </details>`;
}

function renderList() {
  const box = el("cmp-list");
  if (!box) return;
  if (STATE.entries.length === 0) {
    box.innerHTML = `
      <div class="cmp-empty">
        <div>${escapeHtml(t("compaction.empty"))}</div>
        <div class="cmp-empty-hint">${escapeHtml(t("compaction.emptyHint"))}</div>
      </div>`;
    return;
  }
  // 最新的排最上面：用户打开面板想看的是「刚刚那次压了什么」。
  const ordered = STATE.entries.slice().reverse();
  box.innerHTML = ordered.map((entry, index) => entryHtml(entry, index)).join("");
}

async function load() {
  try {
    const res = await fetch(`/compaction/history?limit=${HISTORY_LIMIT}`, { headers: { Accept: "application/json" } });
    const payload = await res.json();
    if (!res.ok || payload?.ok === false) throw new Error(payload?.error || `HTTP ${res.status}`);
    STATE.entries = Array.isArray(payload.entries) ? payload.entries : [];
    STATE.totals = payload.totals || null;
    STATE.context = payload.context || null;
    STATE.inFlight = payload.in_flight === true;
    STATE.activeId = payload.active_id ?? null;
    STATE.total = Number(payload.total) || 0;
    STATE.truncated = payload.truncated === true;
    STATE.rowsError = payload.rows_error || null;
    STATE.error = "";
  } catch (error) {
    // 失败要如实报：一次读不到就清空列表并说明原因，绝不把上一次的数据继续摆着当「当前值」。
    STATE.entries = [];
    STATE.totals = null;
    STATE.context = null;
    STATE.rowsError = null;
    STATE.error = `${t("compaction.loadFailed")}: ${error?.message || error}`;
  }
  STATE.loaded = true;
  renderError(STATE.rowsError
    ? `${STATE.error ? `${STATE.error} ` : ""}${t("compaction.rowsError", { error: STATE.rowsError })}`.trim()
    : STATE.error);
  renderSummary();
  renderList();
}

function escapeHtml(value) {
  return String(value ?? "").replace(/[&<>"']/g, (ch) => (
    { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[ch]
  ));
}

export function setCompactionOpen(open) {
  const panel = el("compaction-panel");
  if (!panel) return;
  panel.classList.toggle("open", open === true);
  // 每次打开都重读：压缩是**背后**发生的（自动触发），别处的改动不该等到下次刷新页面才看见。
  if (open === true) load();
}

export function initCompactionPanel() {
  let panel = el("compaction-panel");
  if (!panel) {
    document.body.insertAdjacentHTML("beforeend", createCompactionPanel());
    panel = el("compaction-panel");
  }
  if (!panel) return;

  // **把面板搬到 document.body**。它在 app-shell 里被注入到 .app-viewport 内，
  // 而祖先只要有一个 transform / filter / will-change，`position: fixed` 就会
  // **不再相对视口**而是相对那个祖先——表现就是「浮层没有铺满屏幕、压在页面某一块上」。
  // 挂到 body 直接绕开这类包含块陷阱（与 schedules-panel.js / worktree-panel.js 同一个坑）。
  if (panel.parentElement !== document.body) document.body.appendChild(panel);

  // 与其它面板同一套约定：内联脚本 / 工作区 iframe 也能打开它。
  window.addEventListener("blm:open-compaction", () => setCompactionOpen(true));
  window.addEventListener("blm:close-compaction", () => setCompactionOpen(false));

  el("cmp-exit-btn")?.addEventListener("click", () => setCompactionOpen(false));
  el("cmp-refresh")?.addEventListener("click", () => load());
}
