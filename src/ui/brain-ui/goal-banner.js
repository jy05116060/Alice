// Goal 横幅：把「当前有个长期目标」这件事显示出来，并给出人来拍板的三个动作。
//
// 为什么值得存在：Goal 是**自主**机制——它在后台花轮次替人干活。这种机制最危险的
// 状态不是「没在跑」，而是「人以为它在跑 / 人以为它停了」。横幅就是把这两个状态
// 摆在脸上：目标是什么、跑到第几轮、**是否已上膛**、上次说了什么。
//
// 与后端的契约：GET /goal 读，POST /goal 写（带 revision 乐观锁）。
// 「继续」这个动作在设计上必须由人开口（HUMAN_ONLY_ACTIONS）——而这个按钮**就是**
// 人开口。所以按钮不是绕过规矩，它就是那条规矩指定的入口。
import { t } from "./i18n/index.js";

// 轮询间隔按状态自适应。
//
// 原来固定 30 秒，用户反馈「0/12 不会时时更新」——**已上膛时轮次会不断变化**，
// 30 秒的间隔看着就像卡住了；而没上膛/没目标时它根本不会变，问得勤纯属浪费。
//
// 为什么事件推送之外还留着轮询：两条路各管一件事，缺一不可。
//   · 事件推送（alice:goal → 立刻 load()）是**快路径**。它把「已上膛时轮次在变」
//     这件事做到接近零延迟，用户点「继续」后也能马上看到上膛。
//   · 事件可能**永远不来或来得不及时**，所以轮询是兜底：SSE 断流重连期间、页面在后台
//     被浏览器节流时、以及 app.js 里 EventSource 建立连接（loadBrainUiHistory 之后才
//     connectSSE）之前发生的事件，都只能靠 GET /goal 读回来。
//   · 轮询价格很便宜（没上膛时 30 秒一次只读快照），却是「界面和真实状态不一致」这类
//     问题唯一的自愈手段——事件只是「去重读一次」的提示，真实状态始终以 GET /goal 为准。
const POLL_IDLE_MS = 30_000;  // 没目标 / 未上膛：它不会变，慢慢问
const POLL_ARMED_MS = 3_000;  // 正在自动推进：轮次在变，得跟得上

const STATE = {
  goal: null,
  armed: false,
  loaded: false,
  error: "",
  busy: false,
  timer: 0,
};

const el = (id) => document.getElementById(id);

// 由 initGoalBanner 赋值：横幅展开时把高度写进 CSS 变量，给下面的聊天窗让位。
let syncRoom = () => {};

export const createGoalBanner = () => `
<section class="goal-banner" id="goal-banner" hidden aria-live="polite">
  <span class="gb-dot" id="gb-dot" aria-hidden="true"></span>
  <span class="gb-tag" id="gb-tag"></span>
  <div class="gb-body">
    <div class="gb-line1">
      <span class="gb-title" id="gb-title"></span>
      <span class="gb-meta" id="gb-meta"></span>
    </div>
    <div class="gb-note" id="gb-note"></div>
    <div class="gb-error" id="gb-error" hidden></div>
  </div>
  <div class="gb-actions">
    <button class="gb-btn primary" id="gb-resume" type="button">${t("goal.resume")}</button>
    <button class="gb-btn" id="gb-pause" type="button">${t("goal.pause")}</button>
    <button class="gb-btn" id="gb-complete" type="button">${t("goal.complete")}</button>
    <button class="gb-btn" id="gb-dismiss" type="button" title="${t("goal.dismissHint")}">${t("goal.dismiss")}</button>
  </div>
  <button class="gb-pin" id="gb-pin" type="button" aria-label="钉住" aria-pressed="false" title="钉住">
    <svg viewBox="0 0 24 24" aria-hidden="true"><path d="M12 17v5M5 17h14M6 3h12l-2 7v3l2 2H6l2-2v-3z"></path></svg>
  </button>
</section>
`;

/**
 * 服务端给的是英文枚举（active / complete / paused / blocked）。
 * 界面上直接显示会在中文界面里冒英文——所以这里映射；遇到没登记的取值**原样返回**，
 * 不猜也不吞（宁可露出一个陌生枚举，也不要显示成错误的中文）。
 */
function goalStatusLabel(status) {
  const key = { active: "goal.statusActive", complete: "goal.statusComplete", paused: "goal.statusPaused", blocked: "goal.statusBlocked" }[status];
  if (!key) return String(status || "");
  const label = t(key);
  return label && label !== key ? label : String(status || "");
}

function render() {
  const box = el("goal-banner");
  if (!box) return;
  if (!STATE.goal) {
    box.hidden = true;
    syncRoom();
    return;
  }
  // 已经结束、且用户点过「知道了」的目标：整条不再出现（键含 goal_id + revision，
  // 所以同一个目标再被改动、或换了新目标时会自动重新出现）。
  const dismissedKey = readDismissedGoalKey();
  if (dismissedKey && dismissedKey === goalDismissKey(STATE.goal)) {
    box.hidden = true;
    return;
  }
  box.hidden = false;
  const goal = STATE.goal;

  const dot = el("gb-dot");
  if (dot) {
    // 三种状态用颜色区分：已上膛（会自己跑）/ 停着（等人开口）/ 已结束
    const state = goal.status !== "active" ? "done" : (STATE.armed ? "armed" : "idle");
    dot.dataset.state = state;
  }

  const title = el("gb-title");
  if (title) title.textContent = goal.objective || "";
  title?.setAttribute("title", goal.objective || "");

  const meta = el("gb-meta");
  if (meta) {
    // **这里有两个数，别把它们读成一个。**
    //   rounds_total   —— 累计自动轮次：跨所有授权，只增不减。它是「这个目标一共花了
    //                     多少轮」，resume 不会让它倒退，所以用户不会看到进度回退。
    //   rounds_started —— 本轮自动轮次：**当前这次授权**内的。点「继续」(resume)
    //                     会归零（重新授权 = 换一段新预算，这是刻意的）。
    // 两者都只统计**自动续轮**（需已上膛），正常对话轮不算。
    // 早先只写「2/12 轮」，读起来像"总共 12 轮、做完 2 轮"，是误导。
    const total = Number.isFinite(goal.rounds_total) ? goal.rounds_total : (goal.rounds_started ?? 0);
    const rounds = `${t("goal.roundsTotal")} ${total} ${t("goal.rounds")} · ${t("goal.roundsThisRun")} ${goal.rounds_started}/${goal.max_rounds}`;
    // 「是否上膛」必须显式写出来：这是这个横幅最要紧的一个信息
    const armedText = goal.status !== "active"
      ? (goal.status === "complete" ? t("goal.statusComplete") : t("goal.statusBlocked"))
      : (STATE.armed ? t("goal.armed") : t("goal.disarmed"));
    meta.textContent = `${goalStatusLabel(goal.status)} · ${rounds} · ${armedText}`;
    meta.title = t("goal.roundsHint");
    const tag = el("gb-tag");
    if (tag) tag.textContent = `${rounds} · ${armedText}`;
  }

  const note = el("gb-note");
  if (note) {
    const raw = goal.progress_note || goal.blocked_reason || goal.pause_reason || "";
    note.textContent = raw;
    note.hidden = !raw;
  }

  const err = el("gb-error");
  if (err) {
    err.hidden = !STATE.error;
    err.textContent = STATE.error;
  }

  // 按钮的可达性（这里早先写错过，值得写清楚为什么）：
  //
  // 早先写成「resume 只在 status==='active' 且未上膛时显示」，结果是**点暂停之后
  // 三个按钮全被藏起来**——因为 pause 会把 status 变成 'paused'，于是 `!active`
  // 成立，而 resume 恰好是暂停的唯一出路。**一个动作把通往它自己的门关上了。**
  //
  // 正确规则：按「这个动作现在做得了吗」判断，而不是按 status 是否等于 active。
  //   · resume：只要还没结束就该在（paused / 重启后解除上膛 / blocked 都是要 resume 的情形）
  //   · pause ：只有在「正在自动推进」时才成立（已经是停的就没什么可暂停）
  //   · complete：还没结束就能收尾
  const finished = goal.status === "complete";
  const resume = el("gb-resume");
  const pause = el("gb-pause");
  const complete = el("gb-complete");
  const dismiss = el("gb-dismiss");
  if (resume) resume.hidden = finished || STATE.armed;
  if (pause) pause.hidden = finished || !(goal.status === "active" && STATE.armed);
  if (complete) complete.hidden = finished;
  if (dismiss) dismiss.hidden = !finished;   // 「知道了」只在已结束时才有意义
  for (const b of [resume, pause, complete]) if (b) b.disabled = STATE.busy;
  syncRoom();
}

async function load() {
  try {
    const res = await fetch("/goal", { headers: { Accept: "application/json" } });
    const body = await res.json();
    STATE.goal = body?.goal || null;
    STATE.armed = body?.armed === true;
    STATE.error = "";
  } catch (error) {
    // 读失败时**保留**上一次的目标显示，只报告错误：
    // 一次网络抖动不该让横幅消失，那会让人以为目标没了
    STATE.error = `${t("goal.loadFailed")}: ${error?.message || error}`;
  }
  STATE.loaded = true;
  render();
}

async function act(action, confirmKey = "") {
  if (!STATE.goal || STATE.busy) return;
  if (confirmKey && !window.confirm(t(confirmKey))) return;
  STATE.busy = true;
  STATE.error = "";
  render();
  try {
    const res = await fetch("/goal", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ revision: STATE.goal.revision, action }),
    });
    const body = await res.json();
    if (!res.ok || body.ok === false) {
      // 乐观锁冲突不是错误，是「别处已经改过了」——重读即可，并把最新状态显示出来
      if (body.code === "REVISION_CONFLICT") {
        STATE.error = t("goal.staleRevision");
        await load();
      } else {
        STATE.error = body.error || t("goal.actionFailed");
      }
    } else {
      await load();
    }
  } catch (error) {
    STATE.error = `${t("goal.actionFailed")}: ${error?.message || error}`;
  }
  STATE.busy = false;
  render();
}

// ── 已结束目标的「收起」 ──────────────────────────────────────────────────
// 一个已完成的目标会永远杵在那儿显示几小时前的进度，既不能消失也关不掉——
// 一条永不变的信息等于噪音。这里让用户明确收起它。
const DISMISS_KEY = "blm-goal-banner-dismissed";

/** 收起键：goal_id + revision。rev 变了说明这个目标又被改动过，应当重新出现。 */
function goalDismissKey(goal) {
  if (!goal || !goal.goal_id) return "";
  return `${goal.goal_id}:${goal.revision ?? 0}`;
}

function readDismissedGoalKey() {
  try { return localStorage.getItem(DISMISS_KEY) || ""; } catch { return ""; }
}

function dismissGoal() {
  const key = goalDismissKey(STATE.goal);
  if (!key) return;
  try { localStorage.setItem(DISMISS_KEY, key); } catch { /* 存不了就只在本次会话里收起 */ }
  render();
}

export function initGoalBanner() {
  // 挂到 document.body 并让 CSS 用 position: fixed —— **不挂在 #chat-area 里**。
  //
  // 为什么（这是第一版的实际问题）：原来挂在 #chat-area 内，而工作区换页模式会把
  // 整块 #chat-area 换成「定时任务」等页面，横幅跟着一起消失。可 goal 是**后台**
  // 在跑的东西，它的状态指示器不该因为你在看哪个页面而消失——那正是这个横幅
  // 要解决的问题（人会以为「没显示 = 没在跑」）。所以它必须是全局的。
  let box = el("goal-banner");
  if (!box) {
    if (!document.body || typeof document.body.insertAdjacentHTML !== "function") return;
    document.body.insertAdjacentHTML("beforeend", createGoalBanner());
    box = el("goal-banner");
  }
  if (!box) return;

  // 收起态：只剩一条细条（圆点 + 轮次/上膛），像浮框一样不占版面。

  // 展开时「从上面伸展出来」：每次展开重放一次动画（不强制回流的话只会播第一次）。
  const playDrop = () => {
    box.classList.remove("gb-dropping");
    void box.offsetWidth;
    box.classList.add("gb-dropping");
  };
  // 动画结束就把类摘掉：留着它的 transform 会盖住收起态的定位。
  box.addEventListener("animationend", () => box.classList.remove("gb-dropping"));

  // 给下面的聊天窗让位：把横幅占的高度写成 CSS 变量，聊天窗（#chat-history）
  // 按它少长这么高——它的上沿就整体往下收。
  //
  // 2026-09-29 用户要求：缝只留一条线宽——横幅下沿与聊天窗上沿之间恒定 ROOM_GAP 像素，
  // 展开、收起都一样：不许边挨边，也不许空出一条宽缝。
  // 做法是量「当前状态的实际下沿」，不再固定拿展开态高度：
  //   ① 收起态的下沿比展开态高一截，沿用展开高度就会空出十几像素；
  //   ② 只在落定时量，过渡中间量到的是半截值，让位会跟着跳一下。
  const ROOM_GAP = 1;        // 横幅下沿到聊天窗上沿只留一条线宽（像素）
  let expandedBottom = 0;    // 展开态实测下沿
  let collapsedBottom = 0;   // 收起态实测下沿
  let settling = false;      // 过渡中不量，免得把中间值记成真实下沿

  const measure = () => {
    const r = box.getBoundingClientRect();
    if (r.height <= 0) return;
    const bottom = Math.round(r.bottom);
    if (box.classList.contains("collapsed")) collapsedBottom = bottom; else expandedBottom = bottom;
  };
  const roomPx = () => {
    // The CSS variable is a height budget, not a viewport Y coordinate.
    // Using bottom here reserved the banner's top offset a second time and made a large gap.
    const r = box.getBoundingClientRect();
    return Math.round(r.height) + ROOM_GAP;
  };

  syncRoom = () => {
    const visible = !box.hidden;
    document.body.classList.toggle("goal-banner-open", visible);
    if (!visible) {
      document.documentElement.style.setProperty("--goal-banner-h", "0px");
      return;
    }
    if (!settling) measure();
    document.documentElement.style.setProperty("--goal-banner-h", roomPx() + "px");
  };

  let roomSettle = 0;
  const applyCollapsed = (on, { drop = false } = {}) => {
    box.classList.toggle("collapsed", on);
    if (!on && drop) playDrop();
    settling = true;
    // Keep the chat layout unchanged during the transform; commit the new reservation once.
    clearTimeout(roomSettle);
    roomSettle = setTimeout(() => { settling = false; measure(); syncRoom(); }, 240);
  };

  // 收放跟聊天窗同一套：鼠标移进来就展开，移开一会儿自己收回去；图钉钉住才常驻。
  // 没有 +/- 号——那套手动收放已经拆掉，收放状态也不再存「收起与否」，只存图钉。
  const PIN_KEY = "bl-goal-banner-pinned";
  const AUTO_COLLAPSE_MS = 2600;
  let pinned = false;
  try { pinned = localStorage.getItem(PIN_KEY) === "1"; } catch { pinned = false; }
  let hovering = false;
  let autoTimer = 0;

  const cancelAuto = () => { if (autoTimer) { clearTimeout(autoTimer); autoTimer = 0; } };
  const scheduleCollapse = (delay = AUTO_COLLAPSE_MS) => {
    cancelAuto();
    if (pinned || hovering) return;
    autoTimer = setTimeout(() => {
      autoTimer = 0;
      if (pinned || hovering) return;
      applyCollapsed(true);
    }, delay);
  };
  const expandNow = (drop = true) => {
    cancelAuto();
    if (box.classList.contains("collapsed")) applyCollapsed(false, { drop });
  };
  const syncPin = () => {
    const btn = el("gb-pin");
    if (!btn) return;
    btn.setAttribute("aria-pressed", String(pinned));
    btn.setAttribute("aria-label", pinned ? "取消钉住" : "钉住");
    btn.title = pinned ? "取消钉住" : "钉住（常驻展开）";
  };

  syncPin();
  // 初始：钉住 → 常驻展开；没钉住 → 先收成细条，鼠标移上去自己展开。
  applyCollapsed(!pinned);

  el("gb-pin")?.addEventListener("click", (e) => {
    e.stopPropagation();
    pinned = !pinned;
    syncPin();
    try { localStorage.setItem(PIN_KEY, pinned ? "1" : "0"); } catch { /* 存不了就算了 */ }
    if (pinned) expandNow(false);
    else scheduleCollapse(1200);
  });

  box.addEventListener("mouseenter", () => { hovering = true; expandNow(true); });
  box.addEventListener("mouseleave", () => { hovering = false; scheduleCollapse(); });
  // 收起态下点一下也能展开（触屏、键盘走这条路）
  box.addEventListener("click", () => {
    if (box.classList.contains("collapsed")) expandNow(true);
  });
  window.addEventListener("resize", syncRoom);

  el("gb-resume")?.addEventListener("click", () => act("resume"));
  el("gb-pause")?.addEventListener("click", () => act("pause"));
  el("gb-complete")?.addEventListener("click", () => act("complete", "goal.confirmComplete"));
  el("gb-dismiss")?.addEventListener("click", dismissGoal);

  // 事件推送：服务端发 goal_created / goal_updated / goal_round，app.js 的 SSE 分发
  // （emitGoalBridge）把它们转成 alice:goal 派到 window 上。收到就**立刻** load()，
  // 不用等下一个轮询周期——上膛时的空窗最多 3 秒，没上膛时多达 30 秒。
  //
  // 这里只把事件当作「去重读一次」的信号，**不直接拿 detail 渲染**：detail 的字段
  // 各事件类型并不一致（goal_round 把目标对象嵌在 data.goal 里），而 armed 这类状态
  // 只有 GET /goal 给得全。真相只有一个来源，事件只负责催。
  //
  // 与轮询并存的原因见文件顶部 POLL_IDLE_MS 上方的注释：事件会丢、也会在 SSE 连上
  // 之前发生，那时只有轮询能把它读回来。两者都调 load()，是幂等的只读快照。
  window.addEventListener("alice:goal", () => { void load(); });

  schedulePoll(0);
  // 页面重新可见时立刻刷一次（后台标签页里的轮询不可靠）
  document.addEventListener("visibilitychange", () => { if (!document.hidden) load(); });
}

/**
 * 自调度轮询：每次跑完按**当前**状态决定下一次多久之后问。
 * 用 setTimeout 自调度而不是 setInterval，是因为间隔要随「是否已上膛」变化
 * ——上膛时轮次在变（3 秒），没上膛时它不会变（30 秒）。
 */
function schedulePoll(delay = null) {
  if (STATE.timer) { clearTimeout(STATE.timer); STATE.timer = 0; }
  const wait = delay === null ? (STATE.armed ? POLL_ARMED_MS : POLL_IDLE_MS) : delay;
  STATE.timer = setTimeout(async () => {
    await load();
    schedulePoll();
  }, wait);
}

/** 供别处（比如 Goal 工具执行后）主动刷新。 */
export function refreshGoalBanner() {
  return load();
}
