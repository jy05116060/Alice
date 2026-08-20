// 电脑动态面板主逻辑 — 模式切换、真实系统状态轮询、采样流、时钟
// 数据源：后端 GET /system-status（src/api/routes/system-status.js → src/system-status.js）
// 全部为本机真实指标，无 mock、无演示数据。

import { apiUrl } from './api-client.js';
import { setHotspotMode, moveVoicePanelToBody, restoreVoicePanel } from './hotspot.js';

const POLL_MS = 2000;      // 轮询间隔，与后端 1.5s 节流窗口错开
const GAUGE_LEN = 301.6;   // 2πr，r = 48（见 computer-status-panel.js 里的 svg）
const FEED_MAX = 12;       // 采样流最多保留条数
const TICKER_MAX = 10;     // 跑马灯最多保留条数

const $ = (id) => document.getElementById(id);

let active = false;
let pollTimer = null;
let clockTimer = null;
let feedTimer = null;
let inflight = null;
let feedItems = [];
let feedIndex = 0;
let tickerItems = [];

// ── 小工具 ──────────────────────────────────────────────────────────────────

function setText(id, text) {
  const el = $(id);
  if (el) el.textContent = text;
}

function pad2(n) {
  return String(n).padStart(2, '0');
}

function clockLabel() {
  const now = new Date();
  return `${pad2(now.getHours())}:${pad2(now.getMinutes())}`;
}

function escapeHtml(value) {
  return String(value == null ? '' : value)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

function num(value) {
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
}

function fmtPct(value) {
  const n = num(value);
  return n === null ? '—' : `${n.toFixed(1)}%`;
}

function fmtGB(value) {
  const n = num(value);
  return n === null ? '—' : `${n.toFixed(1)}G`;
}

function fmtDuration(sec) {
  const s = Math.max(0, Math.round(num(sec) || 0));
  const d = Math.floor(s / 86400);
  const h = Math.floor((s % 86400) / 3600);
  const m = Math.floor((s % 3600) / 60);
  if (d > 0) return `${d}天 ${h}小时`;
  if (h > 0) return `${h}小时 ${m}分`;
  return `${m}分`;
}

/** 字节/秒 → 人类可读速率（网速用） */
function fmtSpeed(bps) {
  const n = num(bps);
  if (n === null) return '—';
  if (n < 1024) return `${n.toFixed(0)} B/s`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB/s`;
  return `${(n / 1024 / 1024).toFixed(2)} MB/s`;
}

/** 摄氏温度 */
function fmtTemp(celsius) {
  const n = num(celsius);
  return n === null ? '—' : `${n.toFixed(1)}°C`;
}

/** 高占用换成警示色：>=90 红、>=75 黄，其余走默认冷色 */
function barModifier(pct) {
  const n = num(pct);
  if (n === null) return '';
  if (n >= 90) return ' cs-row-fill--danger';
  if (n >= 75) return ' cs-row-fill--warn';
  return '';
}

function rowHtml(label, pct, value) {
  const n = num(pct);
  const width = n === null ? 0 : Math.max(0, Math.min(100, n));
  return `<li class="cs-row">`
    + `<span class="cs-row-label">${escapeHtml(label)}</span>`
    + `<span class="cs-row-bar"><span class="cs-row-fill${barModifier(pct)}" style="width:${width}%"></span></span>`
    + `<span class="cs-row-value">${escapeHtml(value)}</span>`
    + `</li>`;
}

/** 系统盘优先取 C:（Windows）/ 根卷，找不到就退回第一个卷 */
function pickSystemVolume(disks) {
  const list = Array.isArray(disks) ? disks : [];
  if (!list.length) return null;
  return list.find((d) => String(d.mount || '').toUpperCase().startsWith('C:'))
    || list.find((d) => d.mount === '/')
    || list[0];
}

// ── 渲染 ────────────────────────────────────────────────────────────────────

function setGauge(arcId, numId, pct) {
  const arc = $(arcId);
  const n = num(pct);
  const clamped = n === null ? 0 : Math.max(0, Math.min(100, n));
  if (arc) arc.setAttribute('stroke-dashoffset', String(GAUGE_LEN * (1 - clamped / 100)));
  setText(numId, fmtPct(pct));
}

function setGaugeState(state, message) {
  const box = $('cs-gauge-container');
  if (!box) return;
  box.dataset.gaugeState = state;
  box.setAttribute('aria-busy', state === 'loading' ? 'true' : 'false');
  if (state === 'error') {
    setText('cs-gauge-status-message', `读取失败：${message || '未知错误'}`);
  } else if (state === 'ok') {
    setText('cs-gauge-status-message', `已连接 · 最近采样 ${clockLabel()}`);
  }
}

function renderInfo(snap) {
  const host = snap.host || {};
  const cpu = snap.cpu || {};
  const self = snap.self || {};
  const net = snap.network || {};

  setText('cs-info-hostname', host.hostname || '—');
  setText('cs-info-os', host.platform ? `${host.platform} ${host.release || ''}`.trim() : '—');
  setText('cs-info-arch', host.arch || '—');
  setText('cs-info-cpu', cpu.model || '—');
  setText('cs-info-electron', host.electronVersion || '—');
  setText('cs-info-uptime', fmtDuration(snap.uptimeSec));
  setText('cs-info-ip', net.localIp || '—');

  setText('cs-self-pid', self.pid != null ? String(self.pid) : '—');
  setText('cs-self-rss', self.rssMB != null ? `${self.rssMB}M` : '—');
  setText('cs-self-heap', self.heapUsedMB != null ? `${self.heapUsedMB}M` : '—');
  setText('cs-self-uptime', self.uptimeSec != null ? fmtDuration(self.uptimeSec) : '—');
  setText('cs-self-node', host.nodeVersion || '—');
}

function renderSnapshot(snap) {
  if (!snap) return;

  const cpuPct = snap.cpu?.usagePct;
  const memPct = snap.memory?.usedPct;
  const sysVol = pickSystemVolume(snap.disks);
  const bat = snap.battery || {};

  setText('cs-brand-status', '运行中');
  setText('cs-tag-link', '正常');
  setText('cs-tag-rate', `${Math.round(POLL_MS / 1000)} 秒`);

  // 统计条
  setText('cs-stat-cpu', fmtPct(cpuPct));
  setText('cs-stat-cpu-delta', snap.cpu?.sampleWindowMs
    ? `采样窗口 ${snap.cpu.sampleWindowMs}ms · ${snap.cpu.cores || '—'} 核`
    : `${snap.cpu?.cores || '—'} 核`);
  setText('cs-stat-mem', fmtPct(memPct));
  setText('cs-stat-mem-delta', `${fmtGB(snap.memory?.usedGB)} / ${fmtGB(snap.memory?.totalGB)}`);
  setText('cs-stat-disk', sysVol ? fmtPct(sysVol.usedPct) : '—');
  setText('cs-stat-disk-delta', sysVol ? `${sysVol.label} · 剩余 ${fmtGB(sysVol.freeGB)}` : '未检测到磁盘卷');
  setText('cs-stat-battery', bat.available ? `${Math.round(Number(bat.pct))}%` : (bat.pending ? '读取中' : '—'));
  setText('cs-stat-battery-delta', bat.available ? (bat.charging ? '充电中' : '放电中') : '状态未知');

  // 网络速率：差值法算出来，首帧只建立基线，此时如实显示采样中
  const netSpeed = snap.network || {};
  setText('cs-stat-net', netSpeed.speedAvailable ? `↓ ${fmtSpeed(netSpeed.rxBps)}` : (netSpeed.speedPending ? '采样中' : '—'));
  setText('cs-stat-net-delta', netSpeed.speedAvailable
    ? `↑ ${fmtSpeed(netSpeed.txBps)}${netSpeed.activeAdapter ? ` · ${netSpeed.activeAdapter}` : ''}`
    : '首次采样中，约 10 秒出数');

  // 硬件温度：本机只有 ACPI 热区 + NVIDIA GPU 两路真值，取不到就说取不到，不编数
  const thermal = snap.thermal || {};
  const cpuTemp = num(thermal.cpuCelsius);
  const gpuTemp = num(thermal.gpuCelsius);
  const tempMain = cpuTemp !== null ? cpuTemp : gpuTemp;
  setText('cs-stat-temp', tempMain !== null ? fmtTemp(tempMain) : (thermal.pending ? '读取中' : '不可用'));
  setText('cs-stat-temp-delta', gpuTemp !== null
    ? `GPU ${fmtTemp(gpuTemp)}`
    : (cpuTemp !== null ? 'ACPI 热区' : '无温度源'));

  // 硬件温度明细：本机只有 ACPI 热区（CPU/主板共用）+ NVIDIA GPU 两路真值，
  // 硬盘、内存没有温度源，如实标注「不可用」，不编数。
  const tempMissing = thermal.pending ? '读取中' : '不可用';
  setText('cs-temp-cpu', cpuTemp !== null ? fmtTemp(cpuTemp) : tempMissing);
  setText('cs-temp-board', cpuTemp !== null ? fmtTemp(cpuTemp) : tempMissing);
  setText('cs-temp-gpu', gpuTemp !== null ? fmtTemp(gpuTemp) : tempMissing);
  setText('cs-temp-disk', '不可用');
  setText('cs-temp-mem', '不可用');
  setText('cs-temp-update', (cpuTemp !== null || gpuTemp !== null)
    ? clockLabel()
    : (thermal.pending ? '采样中' : '无温度源'));
  const tempNoteEl = $('cs-temp-note');
  if (tempNoteEl) {
    tempNoteEl.textContent = 'ACPI 热区不区分 CPU 与主板；硬盘、内存温度需装监控驱动（如 LibreHardwareMonitor）';
  }

  // 中柱仪表
  setGauge('cs-gauge-cpu-arc', 'cs-gauge-cpu-num', cpuPct);
  setGauge('cs-gauge-mem-arc', 'cs-gauge-mem-num', memPct);
  setText('cs-gauge-hint', `数据每 ${Math.round(POLL_MS / 1000)} 秒自动刷新`);

  // 左柱：每核 / 磁盘卷
  const perCore = Array.isArray(snap.cpu?.perCore) ? snap.cpu.perCore : [];
  const coreList = $('cs-core-list');
  if (coreList) {
    coreList.innerHTML = perCore
      .map((v, i) => rowHtml(`核 ${i + 1}`, v, fmtPct(v)))
      .join('');
  }
  setText('cs-core-update', perCore.length ? `${perCore.length} 核 · ${clockLabel()}` : '等待采样');

  const diskList = $('cs-disk-list');
  if (diskList) {
    diskList.innerHTML = (Array.isArray(snap.disks) ? snap.disks : [])
      .map((d) => rowHtml(d.label || d.mount, d.usedPct, `${fmtPct(d.usedPct)} · 剩 ${fmtGB(d.freeGB)}`))
      .join('');
  }
  setText('cs-disk-update', Array.isArray(snap.disks) && snap.disks.length ? `${snap.disks.length} 个卷` : '等待采样');

  // 右柱：内存明细 / 进程榜
  const memList = $('cs-mem-list');
  if (memList) {
    memList.innerHTML = [
      rowHtml('已用', memPct, `${fmtGB(snap.memory?.usedGB)} / ${fmtGB(snap.memory?.totalGB)}`),
      rowHtml('可用', memPct === null || memPct === undefined ? null : 100 - Number(memPct), fmtGB(snap.memory?.freeGB)),
    ].join('');
  }
  setText('cs-mem-update', clockLabel());

  const procs = Array.isArray(snap.processes?.list) ? snap.processes.list : [];
  const procList = $('cs-proc-list');
  if (procList) {
    const max = Math.max(1, ...procs.map((p) => num(p.memMB) || 0));
    procList.innerHTML = procs
      .map((p) => rowHtml(p.name || `PID ${p.pid}`, ((num(p.memMB) || 0) / max) * 100, `${(num(p.memMB) || 0).toFixed(1)}M`))
      .join('');
  }
  setText('cs-proc-update', snap.processes?.pending ? '读取中' : `Top ${procs.length}`);

  renderInfo(snap);
}

// ── 采样流 / 跑马灯 ─────────────────────────────────────────────────────────

function sampleLine(snap) {
  const parts = [
    `CPU ${fmtPct(snap.cpu?.usagePct)}`,
    `内存 ${fmtPct(snap.memory?.usedPct)}`,
    `系统盘 ${fmtPct(pickSystemVolume(snap.disks)?.usedPct)}`,
  ];
  if (snap.battery?.available) parts.push(`电池 ${Math.round(Number(snap.battery.pct))}%${snap.battery.charging ? ' 充电中' : ''}`);
  const tempC = num(snap.thermal?.cpuCelsius) ?? num(snap.thermal?.gpuCelsius);
  if (tempC !== null) parts.push(`温度 ${fmtTemp(tempC)}`);
  if (snap.network?.speedAvailable) parts.push(`网速 ↓${fmtSpeed(snap.network.rxBps)} ↑${fmtSpeed(snap.network.txBps)}`);
  return parts.join(' · ');
}

function renderFeed() {
  const track = $('cs-feed-track');
  if (!track) return;
  track.innerHTML = feedItems
    .map((i) => `<span class="cs-feed-item"><span class="cs-feed-item-time">${i.time}</span>${escapeHtml(i.text)}</span>`)
    .join('');
}

function renderTicker() {
  const el = $('cs-ticker-inner');
  if (!el) return;
  const html = tickerItems
    .map((i) => `<span class="cs-ticker-item"><span class="cs-ticker-item-time">${i.time}</span>${escapeHtml(i.text)}</span>`)
    .join('');
  // 内容翻倍实现无缝滚动（配合 cs-ticker-scroll 的 translateX(-50%)）
  el.innerHTML = html ? html + html : '';
}

function pushSample(snap) {
  const time = clockLabel();
  const text = sampleLine(snap);
  feedItems.push({ time, text });
  if (feedItems.length > FEED_MAX) feedItems.shift();
  renderFeed();
  tickerItems.push({ time, text });
  if (tickerItems.length > TICKER_MAX) tickerItems.shift();
  renderTicker();
}

function scrollFeedTo(idx) {
  const track = $('cs-feed-track');
  const viewport = $('cs-feed-viewport');
  if (!track || !viewport) return;
  const items = track.querySelectorAll('.cs-feed-item');
  if (!items.length) return;
  feedIndex = ((idx % items.length) + items.length) % items.length;
  const target = items[feedIndex].offsetLeft - track.offsetLeft;
  viewport.scrollTo({ left: Math.max(0, target), behavior: 'smooth' });
}

function startFeedAuto() {
  stopFeedAuto();
  feedTimer = setInterval(() => scrollFeedTo(feedIndex + 1), 3500);
}

function stopFeedAuto() {
  if (feedTimer) clearInterval(feedTimer);
  feedTimer = null;
}

// ── 时钟 ────────────────────────────────────────────────────────────────────

function updateClock() {
  const el = $('cs-clock');
  if (!el) return;
  const now = new Date();
  el.textContent = `${pad2(now.getHours())}:${pad2(now.getMinutes())}:${pad2(now.getSeconds())}`;
}

function startClock() {
  updateClock();
  stopClock();
  clockTimer = setInterval(updateClock, 1000);
}

function stopClock() {
  if (clockTimer) clearInterval(clockTimer);
  clockTimer = null;
}

// ── 数据拉取 ────────────────────────────────────────────────────────────────

async function fetchStatus({ force = false } = {}) {
  if (inflight) return inflight;
  const controller = new AbortController();
  const pending = (async () => {
    try {
      const res = await fetch(apiUrl(`/system-status${force ? '?refresh=1' : ''}`), { signal: controller.signal });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const data = await res.json();
      if (!active) return null;
      if (!data?.ok) throw new Error(data?.error || '接口返回异常');
      setGaugeState('ok');
      renderSnapshot(data);
      pushSample(data);
      return data;
    } catch (err) {
      if (err?.name === 'AbortError') return null;
      setGaugeState('error', err?.message || String(err));
      console.warn('[ComputerStatus] 系统状态刷新失败:', err?.message || err);
      return null;
    } finally {
      if (inflight === pending) inflight = null;
    }
  })();
  inflight = pending;
  return pending;
}

function startPoll() {
  stopPoll();
  pollTimer = setInterval(() => { fetchStatus().catch(() => {}); }, POLL_MS);
}

function stopPoll() {
  if (pollTimer) clearInterval(pollTimer);
  pollTimer = null;
  inflight = null;
}

// ── 模式切换 ────────────────────────────────────────────────────────────────

/** 把面板开关状态回报后端，让 computer_status_mode 的 status 与界面真实一致 */
function reportComputerStatusState(visible, source = 'brain-ui') {
  fetch(apiUrl('/computer-status-state'), {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ active: !!visible, source }),
  }).catch(() => {});
}

export function setComputerStatusMode(visible, { source = 'brain-ui' } = {}) {
  const next = !!visible;
  if (active === next) {
    reportComputerStatusState(next, source);
    return;
  }
  active = next;
  reportComputerStatusState(next, source);
  document.body.classList.toggle('computer-mode', next);

  const btn = document.getElementById('computer-status-btn');
  if (btn) btn.classList.toggle('active', next);

  if (!next) {
    stopPoll();
    stopClock();
    stopFeedAuto();
    restoreVoicePanel();
    return;
  }

  // 与其它全屏模式互斥
  for (const cls of ['video-mode', 'image-mode', 'music-mode']) {
    document.body.classList.remove(cls);
  }
  if (document.body.classList.contains('hotspot-mode')) setHotspotMode(false, { source });

  moveVoicePanelToBody();
  setGaugeState('loading');
  setText('cs-gauge-status-message', '正在读取系统状态…');
  startClock();
  startFeedAuto();
  // 预热一次，让电池与进程榜尽早进后端缓存，避免首屏两格空着
  fetch(apiUrl('/system-status/prime')).catch(() => {});
  fetchStatus({ force: true }).catch(() => {});
  startPoll();
}

export function toggleComputerStatus(source = 'brain-ui') {
  setComputerStatusMode(!active, { source });
}

// ── 初始化 ──────────────────────────────────────────────────────────────────

export function initComputerStatus() {
  const exitBtn = $('cs-exit-btn');
  if (exitBtn) exitBtn.addEventListener('click', () => toggleComputerStatus());

  // 快捷键 C：与 H（热点）同一套习惯，输入框聚焦时不抢键
  window.addEventListener('keydown', (e) => {
    const tag = e.target?.tagName;
    if (tag === 'INPUT' || tag === 'TEXTAREA' || e.target?.isContentEditable) return;
    if (e.ctrlKey || e.metaKey || e.altKey) return;
    if (e.key === 'c' || e.key === 'C') {
      e.preventDefault();
      toggleComputerStatus('hotkey');
    }
  });

  const retryBtn = $('cs-gauge-retry');
  if (retryBtn) {
    retryBtn.addEventListener('click', () => {
      setGaugeState('loading');
      setText('cs-gauge-status-message', '正在重新读取系统状态…');
      fetchStatus({ force: true }).catch(() => {});
    });
  }

  const prevBtn = $('cs-feed-prev');
  const nextBtn = $('cs-feed-next');
  if (prevBtn) prevBtn.addEventListener('click', () => { stopFeedAuto(); scrollFeedTo(feedIndex - 1); });
  if (nextBtn) nextBtn.addEventListener('click', () => { stopFeedAuto(); scrollFeedTo(feedIndex + 1); });

  setText('cs-clock', '--:--:--');
  renderFeed();
  renderTicker();
}