// 工作树（隔离区）面板：列出开着的 git worktree，并把「回收」这件事做成有确认的动作。
//
// 为什么要一个面板：worktree 的后端能力（create / checkout / remove + 脏区守卫）早就在
// runtime 里了，但只有模型能碰到。用户看不到自己名下开着几个隔离区、也不知道能不能回收。
//
// 与后端的分工（**这条是硬约束**）：「脏不脏 / 能不能回收 / 回收后会不会切分支」这些判断
// 一律由服务端算好下发（GET /worktrees 的 status_code / status_tone / dirty / removable /
// can_checkout / reason）。面板跑在浏览器里，import 不到 src/runtime/，一旦在这里重写一份
// 规则，两份迟早对不上——而这里对不上的后果是「面板说能回收，实际把用户的东西删了」。
// 面板自己只做两件事：把服务端给的 code 翻成当前语言的文案、把按钮接到接口上。
import { t, formatDateTime } from "./i18n/index.js";

const STATE = {
  loaded: false,
  rows: [],
  error: "",
  busy: false,
};

const el = (id) => document.getElementById(id);

export const createWorktreePanel = () => `
<div class="worktree-panel" id="worktree-panel" aria-live="polite">
  <div class="wt-card">
    <div class="wt-head">
      <div class="wt-title" id="wt-title">${t("worktrees.title")}</div>
      <div class="wt-actions">
        <button class="wt-btn" id="wt-refresh" type="button">${t("worktrees.refresh")}</button>
        <button class="wt-exit-btn" id="wt-exit-btn" type="button" aria-label="${t("worktrees.close")}" title="${t("worktrees.close")}">×</button>
      </div>
    </div>

    <div class="wt-toolbar">
      <label class="wt-mode">
        <span class="wt-mode-label">${t("worktrees.modeLabel")}</span>
        <!-- 每行同一个模式。value 是**接口要的东西**（none / carry_staged / force），
             显示文案走 i18n，所以中文界面是中文、英文界面是英文。 -->
        <select id="wt-mode">
          <option value="none">${t("worktrees.mode.none")}</option>
          <option value="carry_staged">${t("worktrees.mode.carry")}</option>
          <option value="force">${t("worktrees.mode.force")}</option>
        </select>
      </label>
    </div>

    <div class="wt-error" id="wt-error" hidden></div>

    <div class="wt-list" id="wt-list"></div>
  </div>
</div>
`;

/**
 * 状态文案：服务端给的是稳定的 status_code，面板只负责把它翻成当前语言。
 * 万一来了一个还没登记的 code（服务端先加了新状态），退回服务端算好的 status_label——
 * 宁可显示一句中文兜底，也不要显示一个光秃秃的键名。
 */
function statusText(row) {
  const code = String(row.status_code || "");
  const key = `worktrees.status.${code}`;
  const translated = t(key);
  if (translated !== key) return translated;
  return row.status_label || code || "";
}

/**
 * 「会丢什么」的说明。服务端给的是 reason_code + 各项计数（判断在那边），
 * 这里只把它们拼成当前语言的句子——否则英文界面里会冒出一句中文。
 * 认不出的 code（服务端先加了新理由）才退回服务端算好的 reason。
 */
function reasonText(row) {
  const counts = { staged: row.staged || 0, unstaged: row.unstaged || 0, untracked: row.untracked || 0 };
  switch (row.reason_code) {
    case "staged_only":
      return t("worktrees.reason.stagedOnly", { staged: counts.staged });
    case "uncommitted": {
      const parts = [];
      if (counts.staged) parts.push(t("worktrees.part.staged", { n: counts.staged }));
      if (counts.unstaged) parts.push(t("worktrees.part.unstaged", { n: counts.unstaged }));
      if (counts.untracked) parts.push(t("worktrees.part.untracked", { n: counts.untracked }));
      return t("worktrees.reason.uncommitted", { parts: parts.join(t("worktrees.part.sep")) });
    }
    case "missing":
      return t("worktrees.reason.missing");
    case "":
    case undefined:
    case null:
      return "";
    default:
      return row.reason || "";
  }
}

function renderError(message) {
  const box = el("wt-error");
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
  const box = el("wt-list");
  if (!box) return;
  if (STATE.rows.length === 0) {
    box.innerHTML = `
      <div class="wt-empty">
        <div>${t("worktrees.empty")}</div>
        <div class="wt-empty-hint">${t("worktrees.emptyHint")}</div>
      </div>`;
    return;
  }
  box.innerHTML = STATE.rows.map((row, index) => {
    const tone = ["ok", "warn", "danger", "dim"].includes(row.status_tone) ? row.status_tone : "dim";
    const missing = row.missing === true;
    const meta = [];
    if (row.base_branch) meta.push(t("worktrees.base", { branch: row.base_branch }));
    const created = row.created_at ? formatDateTime(row.created_at, { dateStyle: "short", timeStyle: "short" }) : "";
    if (created) meta.push(t("worktrees.createdAt", { at: created }));
    const checkoutNote = missing ? "" : (row.can_checkout ? t("worktrees.canCheckout") : t("worktrees.cannotCheckout"));
    const reason = reasonText(row);
    return `
    <div class="wt-row" data-tone="${tone}">
      <div class="wt-row-main">
        <div class="wt-row-branch">${escapeHtml(row.branch || row.path || "")}</div>
        <div class="wt-row-path">${escapeHtml(row.path || "")}</div>
        <div class="wt-row-status"><span class="wt-status" data-tone="${tone}">${escapeHtml(statusText(row))}</span></div>
        ${reason ? `<div class="wt-row-reason">${escapeHtml(reason)}</div>` : ""}
        ${checkoutNote ? `<div class="wt-row-note">${escapeHtml(checkoutNote)}</div>` : ""}
        ${meta.length ? `<div class="wt-row-meta">${escapeHtml(meta.join(" · "))}</div>` : ""}
      </div>
      <div class="wt-row-actions">
        ${missing
          ? `<button class="wt-btn" data-forget="${index}" type="button">${t("worktrees.forget")}</button>`
          : `<button class="wt-btn ${row.removable ? "primary" : "danger"}" data-reclaim="${index}" type="button">${t("worktrees.reclaim")}</button>`}
      </div>
    </div>`;
  }).join("");
  box.querySelectorAll("[data-reclaim]").forEach((btn) => {
    btn.addEventListener("click", () => reclaim(Number(btn.dataset.reclaim)));
  });
  box.querySelectorAll("[data-forget]").forEach((btn) => {
    btn.addEventListener("click", () => forget(Number(btn.dataset.forget)));
  });
}

async function load() {
  try {
    const res = await fetch("/worktrees", { headers: { Accept: "application/json" } });
    const payload = await res.json();
    if (!res.ok || payload?.ok === false) throw new Error(payload?.error || `HTTP ${res.status}`);
    STATE.rows = Array.isArray(payload.worktrees) ? payload.worktrees : [];
    STATE.error = "";
  } catch (error) {
    STATE.error = `${t("worktrees.loadFailed")}: ${error?.message || error}`;
  }
  STATE.loaded = true;
  renderError(STATE.error);
  renderList();
}

/** 提交一个动作。失败**原样**把服务端说的原因显示出来，绝不换成「看起来成功」。 */
async function postAction(path, body, failLabel) {
  if (STATE.busy) return false;
  STATE.busy = true;
  try {
    const res = await fetch(path, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
    const payload = await res.json().catch(() => null);
    if (!res.ok || !payload || payload.ok === false) {
      if (Array.isArray(payload?.worktrees)) {
        STATE.rows = payload.worktrees;
        renderList();
      }
      renderError(`${failLabel}: ${payload?.error || `HTTP ${res.status}`}`);
      return false;
    }
    if (Array.isArray(payload.worktrees)) STATE.rows = payload.worktrees;
    renderError("");
    renderList();
    return true;
  } catch (error) {
    renderError(`${failLabel}: ${error?.message || error}`);
    return false;
  } finally {
    STATE.busy = false;
  }
}

/**
 * 回收：把成果并回本地仓库、删掉隔离目录。
 * 确认框就是那道「二次确认」——强制回收时它把「未提交改动会被永久删除」写在脸上。
 */
async function reclaim(index) {
  const row = STATE.rows[index];
  if (!row || STATE.busy) return;
  const mode = el("wt-mode")?.value || "none";
  const branch = row.branch || row.path || "";
  const confirmText = mode === "force"
    ? t("worktrees.confirmForce", { branch, path: row.path })
    : mode === "carry_staged"
      ? t("worktrees.confirmCarry", { branch, path: row.path })
      : t("worktrees.confirmReclaim", { branch, path: row.path });
  if (!window.confirm(confirmText)) return;
  await postAction("/worktrees/reclaim", {
    path: row.path,
    ...(mode === "carry_staged" ? { carry_staged: true } : {}),
    ...(mode === "force" ? { force: true } : {}),
  }, t("worktrees.reclaimFailed"));
}

/** 清理登记：只对「目录已经不在了」的死记录开放（服务端还会再核一次）。 */
async function forget(index) {
  const row = STATE.rows[index];
  if (!row || STATE.busy) return;
  if (!window.confirm(t("worktrees.confirmForget", { path: row.path }))) return;
  await postAction("/worktrees/forget", { path: row.path }, t("worktrees.forgetFailed"));
}

function escapeHtml(value) {
  return String(value ?? "").replace(/[&<>"']/g, (ch) => (
    { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[ch]
  ));
}

export function setWorktreesOpen(open) {
  const panel = el("worktree-panel");
  if (!panel) return;
  panel.classList.toggle("open", open === true);
  // 每次打开都重读：别处（模型建的 / 已经回收的）改动不该等到下次刷新页面才看见
  if (open === true) load();
}

export function initWorktreePanel() {
  let panel = el("worktree-panel");
  if (!panel) {
    document.body.insertAdjacentHTML("beforeend", createWorktreePanel());
    panel = el("worktree-panel");
  }
  if (!panel) return;

  // **把面板搬到 document.body**。它在 app-shell 里被注入到 .app-viewport 内，
  // 而祖先只要有一个 transform / filter / will-change，`position: fixed` 就会
  // **不再相对视口**而是相对那个祖先——表现就是「浮层没有铺满屏幕、压在页面某一块上」。
  // 挂到 body 直接绕开这类包含块陷阱（与 schedules-panel.js 同一个坑）。
  if (panel.parentElement !== document.body) document.body.appendChild(panel);

  // 与调度面板同一套约定：别处（内联脚本 / 工作区 iframe）也能打开它。
  window.addEventListener("blm:open-worktrees", () => setWorktreesOpen(true));
  window.addEventListener("blm:close-worktrees", () => setWorktreesOpen(false));

  el("wt-exit-btn")?.addEventListener("click", () => setWorktreesOpen(false));
  el("wt-refresh")?.addEventListener("click", () => load());
}
