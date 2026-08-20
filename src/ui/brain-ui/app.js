import { renderBrainUiApp } from "./app-shell.js";
import { API, getUiClientId, isUiClientTarget } from "./api-client.js";
import { bootstrapScene } from "../scene-shell/bootstrap.js";
import { initChat, friendlyChannelLabel, mountStatPanel } from "./chat.js";
import { initPanelCollapse } from "./panel-collapse.js";
import { ThoughtStream } from "./thought-stream.js";
import { initVoicePanel } from "./voice-panel.js";
import { initHotspot, toggleHotspot, setHotspotMode } from "./hotspot.js";
import { initWorldcup, toggleWorldcup, setWorldcupMode } from "./worldcup.js";
import { initTyphoon, toggleTyphoon, setTyphoonMode } from "./typhoon.js";
import { cancelPersonCardAssistantEnrichment, enrichVisiblePersonCardFromText, initPersonCard, setPersonCardMode } from "./person-card.js";
import { initDocPanel, setDocPanelMode } from "./doc.js";
import { initKnowledgePanel, setKnowledgeCortexMode } from "./knowledge.js";
import { initWorkspacePanel } from "./workspace-panel.js";
import { initSchedulesPanel, setSchedulesOpen } from "./schedules-panel.js";
import { initWorktreePanel, setWorktreesOpen } from "./worktree-panel.js";
import { initCompactionPanel, setCompactionOpen } from "./compaction-panel.js";
import { initWorkflowPanel, setWorkflowOpen } from "./workflow-panel.js";
import { initPluginPanel, registerPluginCommandSink } from "./plugin-panel.js";
import { initGoalBanner } from "./goal-banner.js";
import { initComputerStatus, toggleComputerStatus, setComputerStatusMode } from "./computer-status.js";
import { initWechatPopup, showWechatPopup } from "./wechat-popup.js";
import { initFeishuPopup, showFeishuPopup } from "./feishu-popup.js";
import { attachJarvisAudioGraph, attachJarvisFx, isFxEnabledForVoice, setFxEnabledForVoice, getJarvisFxParams, setJarvisFxParams, resetJarvisFxParams, isFxUnlocked, tryUnlockFx, resumeJarvisAudioContext } from "./tts-fx.js";
import { initAudioOutputRouting, applyOutputSink, listOutputDevices, getOutputPreference, setOutputPreference } from "./audio-output.js";
import { createVoiceReplyCoordinator } from "./voice-reply-coordinator.js";
import { createPlaybackProgressWatchdog, isCurrentStreamingTtsSession, nextStreamingTtsSession } from "./tts-lifecycle.js";
import { initMediaModes } from "./media-modes.js";
import { initAIVideoMode } from "./ai-video-mode.js";
import { initSettings } from "./settings.js";
import {
  buildMemoryGraphLinks,
  deterministicIndex,
  findMemoryGraphAnchor,
  markGraphCore,
  semanticChildTargets as getSemanticChildTargets,
  shuffleGraphItems,
} from "./memory-graph-data.js";
import { playBrainUiIntro } from "./brain-ui-intro.js";
import { formatDateTime, getLocale, localizeDom, observeDomLocalization, t } from "./i18n/index.js";

const BRAIN_UI_ARRIVAL_KEY = "alice_brain_ui_arrival_at";

function consumeBrainUiArrival() {
  try {
    const rawArrival = sessionStorage.getItem(BRAIN_UI_ARRIVAL_KEY);
    sessionStorage.removeItem(BRAIN_UI_ARRIVAL_KEY);
    if (!rawArrival) return { requested: false, releaseSelfCheck: false };
    let arrivalAt = Number(rawArrival);
    let source = "activation";
    try {
      const parsed = JSON.parse(rawArrival);
      arrivalAt = Number(parsed?.at ?? arrivalAt);
      source = String(parsed?.source || source);
    } catch {}
    const requested = Number.isFinite(arrivalAt) && Date.now() - arrivalAt < 30_000;
    return {
      requested,
      releaseSelfCheck: requested && source === "activation",
    };
  } catch {
    return { requested: false, releaseSelfCheck: false };
  }
}

function playBrainUiArrival(enabled) {
  if (!enabled) return Promise.resolve();
  const targets = [
    document.getElementById("panel-l1"),
    ...document.querySelectorAll("#panel-l2 .l2-module"),
    document.getElementById("chat-area"),
  ].filter(Boolean);
  if (!targets.length) return Promise.resolve();

  document.body.classList.add("brain-ui-arrival");
  targets.forEach((element, index) => {
    element.classList.add("brain-ui-arrival-card");
    element.style.setProperty("--brain-ui-arrival-delay", `${index * 135}ms`);
    element.style.setProperty("--brain-ui-arrival-x", index === 0 ? "-18px" : index === targets.length - 1 ? "0px" : "18px");
  });

  return new Promise((resolve) => {
    let cleared = false;
    const lastTarget = targets[targets.length - 1];
    const clearArrival = () => {
      if (cleared) return;
      cleared = true;
      lastTarget.removeEventListener("animationend", handleArrivalEnd);
      document.body.classList.remove("brain-ui-arrival");
      targets.forEach((element) => {
        element.classList.remove("brain-ui-arrival-card");
        element.style.removeProperty("--brain-ui-arrival-delay");
        element.style.removeProperty("--brain-ui-arrival-x");
      });
      resolve();
    };
    const handleArrivalEnd = (event) => {
      if (event.target !== lastTarget || event.animationName !== "brain-ui-card-glitch-in") return;
      clearArrival();
    };
    lastTarget.addEventListener("animationend", handleArrivalEnd);
    window.setTimeout(clearArrival, 2200);
  });
}

const brainUiArrival = consumeBrainUiArrival();
const isBrainUiIntroPreview = new URLSearchParams(window.location.search).has("intro-preview");
const brainUiIntroRequested = brainUiArrival.requested || isBrainUiIntroPreview;
document.documentElement.classList.toggle("brain-ui-intro-pending", brainUiIntroRequested);
const hasWindowsTitleBarOverlay = window.alice?.isElectron && window.alice?.platform === "win32";
document.documentElement.classList.toggle("windows-titlebar-overlay", Boolean(hasWindowsTitleBarOverlay));
if (hasWindowsTitleBarOverlay) {
  const setFullScreenClass = (fullscreen) => {
    document.documentElement.classList.toggle("window-fullscreen", Boolean(fullscreen));
  };
  window.alice.onFullScreenChange?.(setFullScreenClass);
  window.alice.isFullScreen?.().then(setFullScreenClass).catch(() => {});
}
renderBrainUiApp(document.body);
initWorkspacePanel();
initSchedulesPanel();
initWorktreePanel();
initCompactionPanel();
initWorkflowPanel();
initPluginPanel();
initGoalBanner();
localizeDom(document.body);
observeDomLocalization(document.body);
void window.alice?.setUiLanguage?.(getLocale());
if (brainUiIntroRequested) {
  void (async () => {
    try {
      await playBrainUiIntro();
    } finally {
      await playBrainUiArrival(true);
      if (brainUiArrival.releaseSelfCheck && !isBrainUiIntroPreview) {
        fetch("/activation/intro-complete", { method: "POST" })
          .then((response) => {
            if (!response.ok) throw new Error(`HTTP ${response.status}`);
          })
          .catch((error) => {
            console.warn("[brain-ui] could not release startup self-check:", error?.message || error);
          });
      }
    }
  })();
}
const THEME_KEY = "jarvis-brain-ui-theme";
const PHYSICS_STORAGE_KEY = "jarvis-brain-ui-physics";
const ACTIVATION_WARMUP_KEY = "alice_activation_warmup_until";
const UI_ZOOM_STORAGE_KEY = "alice_ui_zoom_factor";
const CHAT_HISTORY_PAGE_SIZE = 60;
const DEFAULT_AGENT_NAME = "小白龙";
const DEFAULT_UI_ZOOM = 1.1;
const MIN_UI_ZOOM = 0.8;
const MAX_UI_ZOOM = 1.8;
const UI_ZOOM_STEP = 0.1;
const UI_ZOOM_WHEEL_STEP = 0.05;
const MEMORY_GRAPH_STORAGE_KEY = "alice-memory-graph-enabled";
const VOICE_SPACE_PTT_KEY = "alice-voice-space-ptt-enabled";
const MEMORY_GRAPH_ENABLED = localStorage.getItem(MEMORY_GRAPH_STORAGE_KEY) !== "false";
const UI_CLIENT_ID = getUiClientId();
const SSE_LAST_EVENT_KEY = "alice-sse-last-event-id";
const voiceReplyCoordinator = createVoiceReplyCoordinator(UI_CLIENT_ID);
const voiceDiagnosticLog = [];
window.aliceVoiceDiagnostics = voiceDiagnosticLog;

function voiceDiag(stage, detail = {}) {
  const record = {
    at: new Date().toISOString(),
    stage,
    client_id: UI_CLIENT_ID,
    visibility: document.visibilityState,
    ...detail,
  };
  voiceDiagnosticLog.push(record);
  if (voiceDiagnosticLog.length > 200) voiceDiagnosticLog.shift();
  console.info("[voice-diag]", record);
  return record;
}
window.aliceVoiceDiag = voiceDiag;

const themeSwitcher = document.getElementById("theme-switcher");
const resetViewBtn = document.getElementById("reset-view-btn");
const physicsControl = document.getElementById("physics-control");
const physicsToggle = document.getElementById("physics-toggle");
const gravitySlider = document.getElementById("gravity-slider");
const repulsionSlider = document.getElementById("repulsion-slider");
const nodeSizeSlider = document.getElementById("node-size-slider");
const gravityValue = document.getElementById("gravity-value");
const repulsionValue = document.getElementById("repulsion-value");
const nodeSizeValue = document.getElementById("node-size-value");
const brandNameEl = document.getElementById("agent-brand-name");
const graphEl = document.getElementById("graph");
const focusBlockEl = document.getElementById("focus-block");
const focusStackEl = document.getElementById("focus-stack");
const focusDepthEl = document.getElementById("focus-depth");

const IGNORED_VERSION_KEY = "alice_ignored_update_version";
const SUPPRESS_UPDATES_KEY = "alice_suppress_update_notifications";

let agentName = DEFAULT_AGENT_NAME;
let currentUiZoom = DEFAULT_UI_ZOOM;
let chat = null;
// 由 initSettings() 内部赋值，供 chat.js 的斜杠命令打开设置面板
let openSettingsRef = null;

function addMsg(...args) { return chat?.addMsg(...args); }
function openChat(...args) { return chat?.openChat(...args); }
function updateLastJarvisMsg(...args) { return chat?.updateLastJarvisMsg(...args); }
function isTyping() { return chat?.isTyping() || false; }

function defaultInputPlaceholder() {
  return t("shell.messageAgent", { name: agentName });
}

function clampZoomFactor(factor) {
  return Math.min(MAX_UI_ZOOM, Math.max(MIN_UI_ZOOM, Number(factor) || DEFAULT_UI_ZOOM));
}

function saveUiZoom(factor) {
  try {
    localStorage.setItem(UI_ZOOM_STORAGE_KEY, String(factor));
  } catch {}
}

function loadSavedUiZoom() {
  try {
    const raw = Number(localStorage.getItem(UI_ZOOM_STORAGE_KEY));
    if (Number.isFinite(raw)) return clampZoomFactor(raw);
  } catch {}
  return DEFAULT_UI_ZOOM;
}

function applyUiZoom(factor, { persist = true } = {}) {
  const nextZoom = clampZoomFactor(factor);
  currentUiZoom = nextZoom;

  const bridge = window.alice;
  if (bridge?.isElectron && typeof bridge.setZoomFactor === "function") {
    bridge.setZoomFactor(nextZoom);
  } else {
    document.documentElement.style.zoom = String(nextZoom);
  }

  if (persist) saveUiZoom(nextZoom);
}

function stepUiZoom(delta) {
  const nextZoom = Math.round((currentUiZoom + delta) * 100) / 100;
  applyUiZoom(nextZoom);
}

function initUiZoom() {
  const bridge = window.alice;
  const initialZoom = loadSavedUiZoom();

  if (!bridge?.isElectron) {
    applyUiZoom(initialZoom, { persist: false });
  } else {
    try {
      const bridgeZoom = bridge.getZoomFactor?.();
      if (typeof bridgeZoom === "number" && Number.isFinite(bridgeZoom)) {
        currentUiZoom = clampZoomFactor(bridgeZoom);
      }
    } catch {}
    applyUiZoom(initialZoom, { persist: false });
  }

  window.addEventListener("wheel", (event) => {
    if (!event.ctrlKey && !event.metaKey) return;
    event.preventDefault();
    stepUiZoom(event.deltaY < 0 ? UI_ZOOM_WHEEL_STEP : -UI_ZOOM_WHEEL_STEP);
  }, { passive: false, capture: true });

  window.addEventListener("keydown", (event) => {
    if (!event.ctrlKey && !event.metaKey) return;

    const key = event.key;
    if (key === "+" || key === "=" || key === "Add") {
      event.preventDefault();
      stepUiZoom(UI_ZOOM_STEP);
      return;
    }

    if (key === "-" || key === "_" || key === "Subtract") {
      event.preventDefault();
      stepUiZoom(-UI_ZOOM_STEP);
      return;
    }

    if (key === "0") {
      event.preventDefault();
      applyUiZoom(DEFAULT_UI_ZOOM);
    }
  });
}

function setAgentName(nextName) {
  const normalized = String(nextName || "").trim() || DEFAULT_AGENT_NAME;
  agentName = normalized;
  document.title = `${normalized} · Cognitive Surface`;
  if (brandNameEl) brandNameEl.textContent = `${normalized} AI Agent`;
  if (graphEl) graphEl.setAttribute("aria-label", `${normalized} memory graph`);
  const input = document.getElementById("msg-input");
  if (input && !chat?.isComposerLocked?.() && document.activeElement === input) input.placeholder = defaultInputPlaceholder();
  document.querySelectorAll(".msg-jarvis .msg-label").forEach((el) => {
    el.textContent = normalized;
  });
}

async function loadAgentProfile() {
  try {
    const res = await fetch(`${API}/agent-profile`);
    if (!res.ok) return;
    const data = await res.json();
    setAgentName(data.name);
  } catch {}
}

const physicsSettings = {
  gravity: 1,
  repulsion: 1.35,
  nodeSize: 1,
};

requestAnimationFrame(() => {
  themeSwitcher.classList.add("visible");
  resetViewBtn.classList.add("visible");
  physicsControl.classList.add("visible");
});

function readCSSVar(name) {
  return getComputedStyle(document.body).getPropertyValue(name).trim();
}

function readPhysicsSettings() {
  try {
    const raw = localStorage.getItem(PHYSICS_STORAGE_KEY);
    if (!raw) return;
    const parsed = JSON.parse(raw);
    if (parsed && typeof parsed === "object") {
      if (typeof parsed.gravity === "number") physicsSettings.gravity = parsed.gravity;
      if (typeof parsed.repulsion === "number") physicsSettings.repulsion = parsed.repulsion;
      if (typeof parsed.nodeSize === "number") physicsSettings.nodeSize = parsed.nodeSize;
    }
  } catch {}
}

function savePhysicsSettings() {
  try {
    localStorage.setItem(PHYSICS_STORAGE_KEY, JSON.stringify(physicsSettings));
  } catch {}
}

function updatePhysicsReadout() {
  gravitySlider.value = String(physicsSettings.gravity);
  repulsionSlider.value = String(physicsSettings.repulsion);
  nodeSizeSlider.value = String(physicsSettings.nodeSize);
  gravityValue.textContent = `${physicsSettings.gravity.toFixed(2)}x`;
  repulsionValue.textContent = `${physicsSettings.repulsion.toFixed(2)}x`;
  nodeSizeValue.textContent = `${physicsSettings.nodeSize.toFixed(2)}x`;
}

let themeColors = {};
function refreshThemeColors() {
  themeColors = {
    cool: readCSSVar("--cool"),
    warm: readCSSVar("--warm"),
    nodeLow: readCSSVar("--node-low"),
    nodeHigh: readCSSVar("--node-high"),
    dim: readCSSVar("--dim"),
    ink2: readCSSVar("--ink2"),
    linkStroke: readCSSVar("--link-stroke"),
    bg0: readCSSVar("--bg0"),
  };
}

function applyTheme(theme) {
  document.body.dataset.theme = theme;
  try { localStorage.setItem(THEME_KEY, theme); } catch {}
  if (hasWindowsTitleBarOverlay) {
    window.alice?.setTitleBarTheme?.(theme).catch(() => {});
  }
  document.querySelectorAll(".theme-dot").forEach(el => {
    el.classList.toggle("active", el.dataset.t === theme);
  });
  setTimeout(() => {
    refreshThemeColors();
    renderLegend();
    if (MEMORY_GRAPH_ENABLED && nodeSel && !nodeSel.empty()) {
      refreshNodeVisuals();
      linkSel.attr("stroke", themeColors.linkStroke);
    }
  }, 20);
}

(function initTheme() {
  let saved = "midnight";
  try { saved = localStorage.getItem(THEME_KEY) || "midnight"; } catch {}
  applyTheme(saved);
})();

themeSwitcher.querySelectorAll(".theme-dot").forEach(el => {
  el.addEventListener("click", () => applyTheme(el.dataset.t));
});

physicsToggle.addEventListener("click", () => {
  const nextOpen = !physicsControl.classList.contains("open");
  physicsControl.classList.toggle("open", nextOpen);
  physicsToggle.setAttribute("aria-expanded", String(nextOpen));
});

gravitySlider.addEventListener("input", () => {
  physicsSettings.gravity = Number(gravitySlider.value);
  applyPhysicsSettings();
});

repulsionSlider.addEventListener("input", () => {
  physicsSettings.repulsion = Number(repulsionSlider.value);
  applyPhysicsSettings();
});

nodeSizeSlider.addEventListener("input", () => {
  physicsSettings.nodeSize = Number(nodeSizeSlider.value);
  applyPhysicsSettings();
});

let W = window.innerWidth;
let H = window.innerHeight;

function elementOccupiesViewport(element) {
  if (!element) return false;
  const style = getComputedStyle(element);
  if (style.display === "none" || style.visibility === "hidden") return false;
  const rect = element.getBoundingClientRect();
  return rect.width > 0
    && rect.height > 0
    && rect.right > 0
    && rect.left < W
    && rect.bottom > 0
    && rect.top < H;
}

function measureGraphLayout() {
  const outerPadding = W <= 900 ? 12 : 18;
  const panelGap = W <= 900 ? 10 : 16;
  let left = outerPadding;
  let right = Math.max(left + 1, W - outerPadding);
  let top = outerPadding;
  let bottom = Math.max(top + 1, H - outerPadding);
  const leftPanel = document.getElementById("panel-l1");
  const rightPanel = document.getElementById("panel-l2");
  const consoleEl = document.querySelector(".console");

  if (elementOccupiesViewport(leftPanel)) {
    left = Math.max(left, leftPanel.getBoundingClientRect().right + panelGap);
  }
  if (elementOccupiesViewport(rightPanel)) {
    right = Math.min(right, rightPanel.getBoundingClientRect().left - panelGap);
  }
  if (elementOccupiesViewport(consoleEl)) {
    const consoleRect = consoleEl.getBoundingClientRect();
    if (consoleRect.top > top + 180) bottom = Math.min(bottom, consoleRect.top - panelGap);
  }

  // 极窄的中间区域仍保留一个有效舞台，避免断点或面板动画期间产生负尺寸。
  if (right - left < 180) {
    const center = W / 2;
    left = Math.max(outerPadding, center - 90);
    right = Math.min(W - outerPadding, center + 90);
  }
  if (bottom - top < 180) {
    top = outerPadding;
    bottom = Math.max(top + 180, H - outerPadding);
  }

  const width = Math.max(1, right - left);
  const height = Math.max(1, bottom - top);
  const scale = Math.max(0.48, Math.min(1, width / 720, height / 680));
  return {
    left,
    right,
    top,
    bottom,
    width,
    height,
    centerX: left + width / 2,
    centerY: top + height / 2,
    scale,
  };
}

let graphLayout = measureGraphLayout();

const svg = d3.select("#graph").attr("width", W).attr("height", H);
const tip = d3.select("#tip");

const defs = svg.append("defs");
defs.html(`
  <filter id="neb-glow" x="-70%" y="-70%" width="240%" height="240%">
    <feGaussianBlur stdDeviation="3.2" result="blur"/>
    <feMerge>
      <feMergeNode in="blur"/>
      <feMergeNode in="SourceGraphic"/>
    </feMerge>
  </filter>
`);

const world = svg.append("g");
const gLink = world.append("g").attr("stroke-linecap", "round");
const gNode = world.append("g");

const zoom = d3.zoom()
  .scaleExtent([0.1, 5])
  .filter(event => event.type === "wheel")
  .on("zoom", event => world.attr("transform", event.transform));

svg.call(zoom);
svg.on("wheel.zoom", null);
svg.on("dblclick.zoom", null);

svg.node().addEventListener("wheel", event => {
  event.preventDefault();
  const current = d3.zoomTransform(svg.node());
  const factor = event.deltaY < 0 ? 1.12 : 1 / 1.12;
  const nextScale = Math.max(0.1, Math.min(5, current.k * factor));
  const k = nextScale / current.k;
  const px = graphLayout.centerX, py = graphLayout.centerY;
  const nextX = px - (px - current.x) * k;
  const nextY = py - (py - current.y) * k;
  svg.call(zoom.transform, d3.zoomIdentity.translate(nextX, nextY).scale(nextScale));
}, { passive: false });

const glowSet = new Map();
const usePulseSet = new Map();
let linkData = [];
let nodeData = [];
let linkSel = gLink.selectAll("line");
let nodeSel = gNode.selectAll("circle");

const nodeCountEl = document.getElementById("node-count");
const linkCountEl = document.getElementById("link-count");
const connStateEl = document.getElementById("conn-state");

function updateStats() {
  nodeCountEl.textContent = String(nodeData.length);
  linkCountEl.textContent = String(linkData.length);
}

function setConnectionState(text, live = true) {
  connStateEl.innerHTML = live
    ? `<span class="live-dot"></span>${text}`
    : text;
  connStateEl.classList.toggle("live", live);
}

function isGlowing(nid) {
  const expiry = glowSet.get(nid);
  if (!expiry) return false;
  if (Date.now() > expiry) { glowSet.delete(nid); return false; }
  return true;
}

function highlightNodes(nids, duration = 2400) {
  if (!MEMORY_GRAPH_ENABLED || !sim) return;
  if (!nids || !nids.length) return;
  const now = Date.now();
  const expiry = now + duration;
  nids.forEach(nid => {
    const key = String(nid);
    glowSet.set(key, expiry);
    usePulseSet.set(key, { start: now, end: expiry });
  });
  refreshNodeVisuals();
  sim.alpha(Math.max(sim.alpha(), 2)).restart();
  setTimeout(() => {
    nids.forEach(nid => {
      const key = String(nid);
      glowSet.delete(key);
      usePulseSet.delete(key);
    });
    refreshNodeVisuals();
  }, duration + 80);
}

function nodeUseProgress(nid) {
  const key = String(nid);
  const pulse = usePulseSet.get(key);
  if (!pulse) return 0;
  const now = Date.now();
  if (now >= pulse.end) {
    usePulseSet.delete(key);
    return 0;
  }
  const total = Math.max(1, pulse.end - pulse.start);
  return 1 - ((now - pulse.start) / total);
}

function nodeStrength(d) {
  if (typeof d._strength !== "number") {
    const deg = Math.min(1, (d._deg || 0) / 12);
    d._strength = 0.35 + deg * 0.55;
  }
  return d._strength;
}

function nodeColor(d) {
  if (d._core) return themeColors.warm || "#d39872";
  const age = (Date.now() - (d._ts || Date.now())) / 18000;
  const fade = Math.max(0.25, 1 - age);
  const t = 0.18 + nodeStrength(d) * 0.5 * fade;
  const interp = d3.interpolateRgb(themeColors.nodeLow || "#3a556e", themeColors.nodeHigh || "#cfe3f5");
  let color = interp(Math.min(1, t));
  const base = d3.color(color);
  if (base) color = base.darker(0.55) + "";
  const useBoost = nodeUseProgress(d._nid);
  if (isGlowing(d._nid) || useBoost > 0) {
    const c = d3.color(color);
    if (c) return c.brighter(2 + useBoost * 2) + "";
  }
  return color;
}

function nodeRadius(d) {
  const base = d._core ? 9 : 3.4 + Math.min((d._deg || 0) * 0.9, 5.4);
  const childScale = 1 + Math.min(1.5, (d._childCount || 0) * 0.18);
  const useBoost = nodeUseProgress(d._nid);
  const glowScale = isGlowing(d._nid) ? 1.08 : 1;
  const pulseScale = 1 + (Math.sin((1 - useBoost) * Math.PI * 3) * 0.04 + useBoost * 0.12);
  const scaledBase = base * physicsSettings.nodeSize;
  return Math.min(scaledBase * 2.5, scaledBase * childScale * glowScale * Math.max(1, pulseScale));
}

const sim = MEMORY_GRAPH_ENABLED
  ? d3.forceSimulation()
    .force("link", d3.forceLink().id(d => d._nid))
    .force("charge", d3.forceManyBody())
    .force("center", d3.forceCenter(graphLayout.centerX, graphLayout.centerY))
    .force("x", d3.forceX(graphLayout.centerX))
    .force("y", d3.forceY(graphLayout.centerY))
    .force("radial", d3.forceRadial(180, graphLayout.centerX, graphLayout.centerY))
    .force("collision", d3.forceCollide())
    .alphaDecay(0.028)
    .alphaMin(0.02) // 肉眼已静止后别再空烧 GPU（默认 0.001 要多跑约 2 秒）
    .velocityDecay(0.3)
    .on("tick", tick)
    .on("end", writeGraphDom)
  : null;

function linkDistance(link) {
  const countFactor = Math.min(34, Math.sqrt(Math.max(1, nodeData.length)) * 4.2);
  let distance;
  if (link._kind === "visual_parent") distance = 82 + countFactor * 0.45;
  else if (link._kind === "visual_random") distance = 108 + countFactor;
  else distance = 76 + countFactor * 0.55;
  return distance * graphLayout.scale;
}

function linkStrength(link) {
  if (link._kind === "visual_parent") return 0.2;
  if (link._kind === "visual_random") return 0.035;
  return 0.16;
}

function chargeStrength(node) {
  const countBoost = Math.min(76, Math.sqrt(Math.max(1, nodeData.length)) * 3.5);
  const baseCharge = -92 - countBoost * 0.4 - (node._deg || 0) * 2.4 - (node._childCount || 0) * 1.2;
  const compactness = Math.max(0.34, graphLayout.scale * graphLayout.scale);
  return baseCharge * physicsSettings.repulsion * compactness;
}

function radialStrength() {
  const baseSpread = nodeData.length > 36 ? 0.1 : 0.1;
  return baseSpread * physicsSettings.gravity;
}

function centerPullStrength() {
  const basePull = nodeData.length > 36 ? 0.04 : 0.055;
  return basePull * physicsSettings.gravity;
}

function collisionRadius(node) {
  const countPadding = nodeData.length > 36 ? 6 : 4;
  return nodeRadius(node) + countPadding;
}

function updateSimulationForces() {
  if (!MEMORY_GRAPH_ENABLED || !sim) return;
  sim.force("link")
    .distance(linkDistance)
    .strength(linkStrength);

  sim.force("charge")
    .strength(chargeStrength);

  sim.force("x")
    .x(graphLayout.centerX)
    .strength(centerPullStrength());

  sim.force("y")
    .y(graphLayout.centerY)
    .strength(centerPullStrength());

  sim.force("radial")
    .radius(Math.max(
      18,
      Math.min(Math.max(24, Math.sqrt(Math.max(1, nodeData.length)) * 6), 64) * graphLayout.scale,
    ))
    .x(graphLayout.centerX)
    .y(graphLayout.centerY)
    .strength(radialStrength());

  sim.force("collision")
    .radius(collisionRadius)
    .strength(0.82)
    .iterations(nodeData.length > 40 ? 2 : 1);
}

function updateGraphViewport() {
  W = window.innerWidth;
  H = window.innerHeight;
  graphLayout = measureGraphLayout();
  svg.attr("width", W).attr("height", H);
}

function reseedGraphNodes() {
  if (!nodeData.length) return;
  const movableNodes = nodeData.filter(node => !node._core);
  const maxRadius = Math.max(
    26,
    Math.min(graphLayout.width, graphLayout.height) * 0.3,
  );
  const goldenAngle = Math.PI * (3 - Math.sqrt(5));
  let movableIndex = 0;

  nodeData.forEach((node, index) => {
    node.fx = null;
    node.fy = null;
    node.vx = 0;
    node.vy = 0;
    if (node._core) {
      node.x = graphLayout.centerX;
      node.y = graphLayout.centerY;
      return;
    }

    const progress = Math.sqrt((movableIndex + 1) / Math.max(1, movableNodes.length));
    const phase = (deterministicIndex(node._nid || index, 360) / 180) * Math.PI;
    const angle = phase + movableIndex * goldenAngle;
    const radius = Math.max(18, maxRadius * progress);
    node.x = graphLayout.centerX + Math.cos(angle) * radius;
    node.y = graphLayout.centerY + Math.sin(angle) * radius;
    movableIndex += 1;
  });
}

function graphLayoutSnapshot() {
  return {
    viewport: { width: W, height: H },
    stage: { ...graphLayout },
    nodeCount: nodeData.length,
  };
}

function resetGraphLayout({ reseed = true, restartAlpha = 1 } = {}) {
  updateGraphViewport();
  svg.call(zoom.transform, d3.zoomIdentity);
  if (!MEMORY_GRAPH_ENABLED || !sim) return;
  sim.force("center", d3.forceCenter(graphLayout.centerX, graphLayout.centerY));
  updateSimulationForces();
  if (reseed) reseedGraphNodes();
  sim.alphaTarget(0).alpha(Math.max(0.35, restartAlpha)).restart();
  writeGraphDom();
}

window.aliceGraphLayout = graphLayoutSnapshot;

function applyPhysicsSettings(restartAlpha = 2) {
  updatePhysicsReadout();
  if (!MEMORY_GRAPH_ENABLED || !sim) {
    savePhysicsSettings();
    return;
  }
  updateSimulationForces();
  refreshNodeVisuals();
  sim.alpha(Math.max(sim.alpha(), restartAlpha)).restart();
  savePhysicsSettings();
}

function refreshNodeVisuals() {
  if (!MEMORY_GRAPH_ENABLED) return;
  if (!nodeSel || nodeSel.empty()) return;
  nodeSel
    .attr("r", nodeRadius)
    .attr("fill", nodeColor)
    .attr("filter", d => (d._core || isGlowing(d._nid) || nodeUseProgress(d._nid) > 0) ? "url(#neb-glow)" : null)
    .style("animation", d => nodeUseProgress(d._nid) > 0 ? "neb-node-use 10s ease-out" : null);
}

function dampTangentialMotion() {
  if (!MEMORY_GRAPH_ENABLED || !sim) return;
  const cx = graphLayout.centerX;
  const cy = graphLayout.centerY;
  const twitching = sim.alpha() > 0.45;

  nodeData.forEach(node => {
    if (!node || node.fx != null || node.fy != null) return;

    const dx = (node.x ?? cx) - cx;
    const dy = (node.y ?? cy) - cy;
    const dist = Math.hypot(dx, dy);
    if (dist < 0.001) return;

    const rx = dx / dist;
    const ry = dy / dist;
    const tx = -ry;
    const ty = rx;
    const vx = node.vx || 0;
    const vy = node.vy || 0;
    const radialVelocity = vx * rx + vy * ry;
    const tangentialVelocity = vx * tx + vy * ty;
    const tangentialDamping = twitching ? 0.14 : 0.24;

    node.vx = radialVelocity * rx + tangentialVelocity * tangentialDamping * tx;
    node.vy = radialVelocity * ry + tangentialVelocity * tangentialDamping * ty;
  });
}

function naturalTwitch(big = Math.random() < 0.3) {
  if (!MEMORY_GRAPH_ENABLED || !sim) return;
  if (nodeData.length < 2) {
    sim.alpha(1).restart();
    return;
  }

  const nodeById = new Map(nodeData.map(node => [String(node._nid), node]));
  const anchorMap = new Map();
  linkData.forEach(link => {
    if (link._kind !== "visual_parent" && link._kind !== "visual_random") return;
    const sourceId = typeof link.source === "object" ? String(link.source._nid) : String(link.source);
    const targetId = typeof link.target === "object" ? String(link.target._nid) : String(link.target);
    if (!anchorMap.has(sourceId) && nodeById.has(targetId)) {
      anchorMap.set(sourceId, nodeById.get(targetId));
    }
  });

  // 小抽动（常态）只动少数节点低热度；大波（偶发）才整片涌动
  const ratio = big ? 0.3 : 0.1;
  const twitchCount = Math.max(big ? 6 : 3, Math.floor(nodeData.length * ratio));
  const candidates = shuffleGraphItems(nodeData.filter(node => !node._core)).slice(0, twitchCount);

  candidates.forEach(node => {
    const anchor = anchorMap.get(String(node._nid)) || nodeData[deterministicIndex(node._nid, nodeData.length)];
    if (!anchor) return;

    const anchorX = anchor.x ?? graphLayout.centerX;
    const anchorY = anchor.y ?? graphLayout.centerY;
    const angle = Math.random() * Math.PI * 2;
    const offset = (36 + Math.random() * 52) * graphLayout.scale;
    const nextX = anchorX + Math.cos(angle) * offset;
    const nextY = anchorY + Math.sin(angle) * offset;
    const currentX = node.x ?? nextX;
    const currentY = node.y ?? nextY;

    node.x = currentX * 0.7 + nextX * 0.3;
    node.y = currentY * 0.7 + nextY * 0.3;
    node.vx = (node.vx || 0) + (nextX - currentX) * 0.14;
    node.vy = (node.vy || 0) + (nextY - currentY) * 0.14;
  });

  sim.alpha(big ? 0.6 : 0.35).restart();
}

let tickParity = 0;
function tick() {
  if (!MEMORY_GRAPH_ENABLED) return;
  dampTangentialMotion();
  // 非拖拽时 DOM 写入降到 30fps：力计算照跑，重绘减半；拖拽（alphaTarget>0）保持满帧
  tickParity ^= 1;
  if (tickParity && sim.alphaTarget() === 0) return;
  writeGraphDom();
}

function writeGraphDom() {
  if (!MEMORY_GRAPH_ENABLED || !linkSel || !nodeSel) return;

  linkSel
    .attr("x1", d => d.source.x)
    .attr("y1", d => d.source.y)
    .attr("x2", d => d.target.x)
    .attr("y2", d => d.target.y);

  nodeSel
    .attr("cx", d => d.x)
    .attr("cy", d => d.y);
}

function computeDegrees() {
  const nodeById = new Map(nodeData.map(n => [n._nid, n]));
  nodeData.forEach(n => {
    n._deg = 0;
    n._childCount = 0;
  });
  linkData.forEach(l => {
    const s = typeof l.source === "object" ? l.source : nodeById.get(String(l.source));
    const t = typeof l.target === "object" ? l.target : nodeById.get(String(l.target));
    if (s) s._deg = (s._deg || 0) + 1;
    if (t) t._deg = (t._deg || 0) + 1;
  });

  nodeData.forEach(node => {
    const childTargets = getSemanticChildTargets(node);
    if (childTargets.size) {
      node._childCount = childTargets.size;
      return;
    }

    const selfId = String(node._nid || "");
    node._childCount = nodeData.reduce((count, candidate) => (
      candidate.parent_id != null && String(candidate.parent_id) === selfId ? count + 1 : count
    ), 0);
  });
}

function showTip(event, d) {
  const label = d.title || (d.content || "").slice(0, 120) || d._nid;
  const type = d._core ? "self" : (d.event_type || "memory");
  tip
    .style("display", "block")
    .style("left", `${event.clientX + 14}px`)
    .style("top", `${event.clientY + 12}px`)
    .html(`<span class="tip-type">${type}</span><div>${label}</div>`);
}

function markCore() {
  markGraphCore(nodeData);
}

function renderLegend() {
  const el = document.getElementById("legend");
  if (!el) return;
  const total = nodeData.length;
  const active = nodeData.filter(n => (Date.now() - (n._ts || 0)) < 15000).length;
  const known = Math.max(0, total - active - 1);
  const decayed = nodeData.filter(n => (Date.now() - (n._ts || 0)) > 60000).length;

  const items = [
    { name: "约束", count: 1, color: themeColors.warm },
    { name: "记忆", count: total, color: themeColors.nodeHigh },
    { name: "知识", count: known, color: themeColors.cool },
    { name: "衰减", count: decayed, color: themeColors.dim },
  ];

  el.innerHTML = items.map(i =>
    `<div class="legend-item">
      <span class="legend-dot" style="background:${i.color}"></span>
      <span class="legend-name">${i.name}</span>
      <span class="legend-count">${i.count}</span>
    </div>`
  ).join("");
}

function renderGraph(restartAlpha = 2) {
  if (!MEMORY_GRAPH_ENABLED || !sim) {
    updateStats();
    renderLegend();
    return;
  }
  computeDegrees();
  markCore();
  updateStats();
  renderLegend();

  linkSel = linkSel.data(linkData, d => d._lid);
  linkSel.exit().remove();
  linkSel = linkSel.enter().append("line")
    .attr("stroke", themeColors.linkStroke || "rgba(143,182,216,0.18)")
    .attr("stroke-width", 0.6)
    .merge(linkSel);

  nodeSel = nodeSel.data(nodeData, d => d._nid);
  nodeSel.exit().transition().duration(280).attr("r", 0).remove();

  const enter = nodeSel.enter().append("circle")
    .attr("r", 0)
    .attr("fill", nodeColor)
    .style("cursor", "pointer")
    .call(d3.drag()
      .on("start", (event, d) => {
        if (!event.active) sim.alphaTarget(2).restart();
        d.fx = d.x; d.fy = d.y;
      })
      .on("drag", (event, d) => {
        d.fx = event.x; d.fy = event.y;
      })
      .on("end", (event, d) => {
        if (!event.active) sim.alphaTarget(0);
        d.fx = null; d.fy = null;
      }))
    .on("mouseover", showTip)
    .on("mousemove", event => {
      tip.style("left", `${event.clientX + 14}px`)
         .style("top", `${event.clientY + 12}px`);
    })
    .on("mouseout", () => tip.style("display", "none"))
    .on("click", (event, d) => {
      d._ts = Date.now();
      d._strength = Math.min(1, (d._strength || 0.5) + 0.25);
      highlightNodes([d._nid], 900);
    });

  enter.transition().duration(360).attr("r", nodeRadius);
  nodeSel = enter.merge(nodeSel);

  sim.nodes(nodeData);
  sim.force("link").links(linkData);
  updateSimulationForces();
  sim.alpha(0.5).restart();
  refreshNodeVisuals();
}

async function loadMemories() {
  if (!MEMORY_GRAPH_ENABLED) return;
  try {
    const rows = await fetch(`${API}/memories?limit=120`).then(r => r.json());
    if (!Array.isArray(rows)) return;
    const isInitialGraphLoad = nodeData.length === 0;

    const prevPositions = new Map(nodeData.map(n => [n._nid, {
      x: n.x, y: n.y, vx: n.vx, vy: n.vy, fx: n.fx, fy: n.fy,
    }]));

    nodeData = rows.map(row => {
      const nid = row.mem_id || String(row.id);
      const prev = prevPositions.get(nid);
      return {
        ...row,
        _nid: nid,
        _ts: prev ? Date.now() : Date.now() - Math.random() * 8000,
        x: prev ? prev.x : graphLayout.centerX + (Math.random() - 0.5) * 180 * graphLayout.scale,
        y: prev ? prev.y : graphLayout.centerY + (Math.random() - 0.5) * 180 * graphLayout.scale,
        vx: prev ? prev.vx : 0,
        vy: prev ? prev.vy : 0,
        fx: prev ? prev.fx : null,
        fy: prev ? prev.fy : null,
      };
    });

    linkData = buildMemoryGraphLinks(nodeData);

    renderGraph(1.1);
    if (isInitialGraphLoad) {
      resetGraphLayout({ reseed: true, restartAlpha: 1 });
    }
  } catch (error) {
    console.warn("[graph] load failed:", error.message);
    setConnectionState(t("runtime.offline"), false);
  }
}

function addNewNodes(memories) {
  if (!MEMORY_GRAPH_ENABLED) return;
  const nodeMap = new Map(nodeData.map(n => [n._nid, n]));
  const newNids = [];
  memories.forEach(memory => {
    const nid = memory.mem_id || memory.id;
    if (!nid || nodeMap.has(String(nid))) return;
    const anchor = findMemoryGraphAnchor(memory, nodeData, linkData);
    const anchorX = anchor?.x ?? graphLayout.centerX;
    const anchorY = anchor?.y ?? graphLayout.centerY;
    const node = {
      ...memory,
      _nid: String(nid),
      mem_id: String(nid),
      event_type: memory.event_type || memory.type || "fact",
      _ts: Date.now(),
      _strength: 0.85,
      x: anchorX + (Math.random() - 0.5) * 72 * graphLayout.scale,
      y: anchorY + (Math.random() - 0.5) * 72 * graphLayout.scale,
      vx: 0, vy: 0,
    };
    nodeData.push(node);
    nodeMap.set(node._nid, node);
    newNids.push(node._nid);
  });
  if (!newNids.length) return;

  linkData = buildMemoryGraphLinks(nodeData);
  renderGraph(2);
  highlightNodes(newNids, 10000);
}

if (MEMORY_GRAPH_ENABLED) {
  // 随机 5–9 秒一次抽动，比固定节拍更像活物；窗口不可见时休眠省 GPU
  const scheduleTwitch = () => {
    setTimeout(() => {
      if (!document.hidden) naturalTwitch();
      scheduleTwitch();
    }, 5000 + Math.random() * 4000);
  };
  scheduleTwitch();
  document.addEventListener("visibilitychange", () => {
    if (!document.hidden) naturalTwitch(true); // 回到前台来一发大波当欢迎
  });
  setInterval(() => { nodeData.forEach(n => { if (n._strength) n._strength *= 0.97; }); }, 2500);
}

function parseUserMessageInput(raw) {
  const text = String(raw || "");
  const match = text.match(/^\[([^\]]+)\]\s+(\S+)\s+\[([^\]]+)\]\s+([\s\S]*)$/);
  if (!match) return { content: text.trim(), time: null };
  return { fromId: match[1], timestamp: match[2], channel: match[3], content: match[4].trim(), time: formatMsgTime(match[2]) };
}

function formatMsgTime(stamp) {
  if (!stamp) return null;
  const m = String(stamp).match(/T(\d{2}):(\d{2}):(\d{2})/);
  if (m) return `${m[1]}:${m[2]}:${m[3]}`;
  const m2 = String(stamp).match(/(\d{2}):(\d{2}):(\d{2})/);
  if (m2) return `${m2[1]}:${m2[2]}:${m2[3]}`;
  return null;
}

const L1 = new ThoughtStream("si-l1", "cool", {
  readCSSVar,
  thinkingLabel: t("thought.thinkingEllipsis"),
  thinkingDoneLabel: t("thought.thinkingDone"),
  toolDetailLength: 140,
});
const L2 = new ThoughtStream("si-l2", "warm", {
  readCSSVar,
  thinkingLabel: t("thought.thinking"),
  thinkingDoneLabel: t("thought.thinkingDone"),
  toolDetailLength: 220,
});

// ── L2 意识观测：心跳图、行动日志、实时认知状态 ────────────────
// 波形表达真实的意识活动：L2 Tick / 用户消息触发大跳，工具调用触发小跳；
// 底部计数仍只统计 L2 Tick，SSE 是否在线则由右上角状态灯单独表达。
// 行动日志只存工具动作的人类可读摘要；完整参数/结果不写入浏览器存储。
const ACTION_LOG_KEY = "alice-action-log-v1";
const HEARTBEAT_COUNT_KEY = "alice-heartbeat-count-v1";
const ACTION_LOG_LIMIT = 58;
const ACTION_LOG_IGNORED_TOOLS = new Set(["send_message", "ui_set"]);
const heartbeatMonitorEl = document.querySelector(".heartbeat-monitor");
const heartbeatWaveEl = document.getElementById("heartbeat-wave");
const heartbeatAreaEl = document.getElementById("heartbeat-area");
const heartbeatStateEl = document.getElementById("heartbeat-state");
const heartbeatStateLabelEl = document.getElementById("heartbeat-state-label");
const heartbeatCountEl = document.getElementById("heartbeat-count");
const heartbeatLastEl = document.getElementById("heartbeat-last");
const actionLogEl = document.getElementById("action-log");
const commandRunsEl = document.getElementById("command-runs");
const actionLogModuleEl = actionLogEl?.closest(".action-log-module");
const actionLogSurfaceEl = document.getElementById("action-log-surface");
const browserPreviewEl = document.getElementById("browser-preview");
const browserPreviewImageEl = document.getElementById("browser-preview-image");
const browserPreviewNativeSlotEl = document.getElementById("browser-preview-native-slot");
const cognitionStateEl = document.getElementById("cognition-state");
const l3StateEl = document.getElementById("l3-state");
const cognitionEmptyEl = document.getElementById("cognition-empty");
const BROWSER_PREVIEW_TRANSITION_MS = 480;
// The native WebContentsView is the actual page controlled by the browser MCP.
// It is layered into this DOM slot by the main process, so compact mode remains
// live and interactive instead of displaying a periodically refreshed image.
const browserEmbedBridge = window.alice?.browserEmbed || null;
let browserPreviewObjectUrl = "";
let browserPreviewLoadToken = 0;
let browserPreviewActive = false;
let browserPreviewPending = false;
let browserPreviewNativeUrl = "";
let browserEmbedFrameRequest = 0;
let browserEmbedAnimationUntil = 0;
let browserPreviewTransitionFrame = 0;
let browserPreviewTransitionTimer = null;
let lastBrowserEmbedGeometry = "";
let browserPreviewDisplayMode = "hidden";
let browserPreviewHostTransitioning = false;
let browserPreviewHostTransitionTarget = "";
let browserPreviewHostTransitionToken = 0;

function readHeartbeatStorage(key, fallback) {
  try {
    const value = JSON.parse(localStorage.getItem(key));
    return value == null ? fallback : value;
  } catch {
    return fallback;
  }
}

let actionLog = readHeartbeatStorage(ACTION_LOG_KEY, []);
if (!Array.isArray(actionLog)) actionLog = [];
actionLog = actionLog
  .filter(entry => (
    entry
    && entry.kind !== "failed"
    && !ACTION_LOG_IGNORED_TOOLS.has(entry.tool)
    && typeof entry.text === "string"
    && Number.isFinite(Number(entry.ts))
  ))
  .slice(-ACTION_LOG_LIMIT);
let heartbeatCount = Math.max(0, Number(readHeartbeatStorage(HEARTBEAT_COUNT_KEY, 0)) || 0);
let lastHeartbeatAt = 0;
let activeHeartbeatRound = false;
let heartbeatConnectionState = "waiting";
let defaultHeartbeatIntervalMinutes = 20;
const COMMAND_RUN_UI_LIMIT = 3;
const COMMAND_RUN_CACHE_LIMIT = 24;
const COMMAND_RUN_OUTPUT_LIMIT = 1800;
const commandRunViews = new Map();
let commandRunRenderFrame = 0;

function heartbeatClock(ts) {
  return formatDateTime(Number(ts) || Date.now(), {
    hour12: false,
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
  });
}

function renderActionLog() {
  if (!actionLogEl) return;
  actionLogEl.replaceChildren();
  const visibleEntries = actionLog.slice();
  if (visibleEntries.length === 0) {
    const empty = document.createElement("div");
    empty.className = "action-log-empty";
    empty.id = "action-log-empty";
    empty.textContent = "Agent 最近执行的文件、命令和工具动作会显示在这里";
    actionLogEl.appendChild(empty);
  } else {
    for (const entry of visibleEntries) {
      const row = document.createElement("div");
      row.className = "action-log-entry";
      row.dataset.kind = entry.kind || "action";
      const dot = document.createElement("span");
      dot.className = "action-log-dot";
      const textEl = document.createElement("span");
      textEl.className = "action-log-text";
      textEl.textContent = entry.text;
      textEl.title = entry.text;
      const timeEl = document.createElement("time");
      timeEl.className = "action-log-time";
      timeEl.dateTime = new Date(entry.ts).toISOString();
      timeEl.textContent = heartbeatClock(entry.ts);
      row.append(dot, textEl, timeEl);
      actionLogEl.appendChild(row);
    }
    actionLogEl.scrollTop = actionLogEl.scrollHeight;
  }
}

function commandRunStateLabel(state) {
  return ({
    starting: t("runtime.commandStarting"),
    running: t("runtime.commandRunning"),
    cancelling: t("runtime.commandCancelling"),
    completed: t("runtime.commandCompleted"),
    failed: t("runtime.commandFailed"),
    cancelled: t("runtime.commandCancelled"),
  })[state] || state || t("runtime.commandWaiting");
}

function renderCommandRuns() {
  commandRunRenderFrame = 0;
  if (!commandRunsEl) return;
  const runs = [...commandRunViews.values()]
    .sort((left, right) => right.updatedAt - left.updatedAt)
    .slice(0, COMMAND_RUN_UI_LIMIT);
  commandRunsEl.replaceChildren();
  commandRunsEl.hidden = runs.length === 0;
  for (const run of runs) {
    const card = document.createElement("article");
    card.className = "command-run";
    card.dataset.state = run.state || "starting";
    card.title = run.command || run.runId;

    const dot = document.createElement("span");
    dot.className = "command-run-dot";
    const command = document.createElement("code");
    command.className = "command-run-command";
    command.textContent = run.command || t("runtime.commandFallback", { id: run.runId.slice(-6) });
    const state = document.createElement("span");
    state.className = "command-run-state";
    state.textContent = commandRunStateLabel(run.state);
    card.append(dot, command, state);

    if (run.output) {
      const output = document.createElement("pre");
      output.className = "command-run-output";
      output.textContent = run.output.replace(/\r/g, "").trimEnd();
      card.appendChild(output);
    }
    commandRunsEl.appendChild(card);
  }
}

function scheduleCommandRunRender() {
  if (commandRunRenderFrame) return;
  commandRunRenderFrame = requestAnimationFrame(renderCommandRuns);
}

function commandRunView(runId) {
  const id = String(runId || "");
  if (!id) return null;
  let run = commandRunViews.get(id);
  if (!run) {
    run = { runId: id, state: "starting", command: "", output: "", lastSequence: 0, updatedAt: Date.now() };
    commandRunViews.set(id, run);
    if (commandRunViews.size > COMMAND_RUN_CACHE_LIMIT) {
      const oldest = [...commandRunViews.values()]
        .filter(item => !["starting", "running", "cancelling"].includes(item.state))
        .sort((left, right) => left.updatedAt - right.updatedAt)[0]
        || [...commandRunViews.values()].sort((left, right) => left.updatedAt - right.updatedAt)[0];
      if (oldest && oldest.runId !== id) commandRunViews.delete(oldest.runId);
    }
  }
  return run;
}

function handleCommandRunEvent(data = {}, ts = null) {
  const run = commandRunView(data.run_id);
  if (!run) return;
  if (data.command != null) run.command = String(data.command);
  if (data.state) run.state = String(data.state);
  if (data.pid != null) run.pid = data.pid;
  if (data.exit_code != null) run.exitCode = data.exit_code;
  run.updatedAt = Date.parse(ts) || Date.now();
  scheduleCommandRunRender();
}

function handleCommandOutputEvent(data = {}, ts = null) {
  const run = commandRunView(data.run_id);
  if (!run) return;
  const sequence = Number(data.sequence) || 0;
  // SSE reconnect replay is allowed; never append the same output record twice.
  if (sequence && sequence <= run.lastSequence) return;
  run.lastSequence = Math.max(run.lastSequence, sequence);
  run.output = `${run.output}${String(data.text || "")}`.slice(-COMMAND_RUN_OUTPUT_LIMIT);
  run.updatedAt = Date.parse(ts) || Date.now();
  scheduleCommandRunRender();
}

function describeAction(name, args = {}, result = "") {
  const parsedResult = L2.parseJsonResult(result);
  const label = L2.toolAction(name || "tool", args);
  const subject = L2.formatToolSubject(name, args, parsedResult);
  return subject ? `${label} · ${subject}` : label;
}

function addActionLogEntry(name, args = {}, result = "", ok = true, ts = Date.now()) {
  if (ok === false || ACTION_LOG_IGNORED_TOOLS.has(name)) return;
  actionLog.push({
    text: describeAction(name, args, result),
    kind: "action",
    tool: String(name || "tool"),
    ts: Number(ts) || Date.now(),
  });
  actionLog = actionLog.slice(-ACTION_LOG_LIMIT);
  try { localStorage.setItem(ACTION_LOG_KEY, JSON.stringify(actionLog)); } catch {}
  renderActionLog();
}

function isCardBrowserAction(data = {}) {
  return String(data.name || "").startsWith("browser_")
    && data.name !== "browser_clear_data"
    && data.browser_display_mode === "card";
}

function browserPreviewTransitionDuration() {
  return window.matchMedia?.("(prefers-reduced-motion: reduce)")?.matches
    ? 1
    : BROWSER_PREVIEW_TRANSITION_MS;
}

function clearBrowserPreviewTransition() {
  if (browserPreviewTransitionFrame) {
    cancelAnimationFrame(browserPreviewTransitionFrame);
    browserPreviewTransitionFrame = 0;
  }
  if (browserPreviewTransitionTimer) {
    clearTimeout(browserPreviewTransitionTimer);
    browserPreviewTransitionTimer = null;
  }
}

function callBrowserEmbed(method, payload) {
  if (!browserEmbedBridge || typeof browserEmbedBridge[method] !== "function") {
    return Promise.resolve(null);
  }
  try {
    return Promise.resolve(browserEmbedBridge[method](payload)).catch(error => {
      console.warn(`[brain-ui] browser embed ${method} failed:`, error?.message || error);
      return null;
    });
  } catch (error) {
    console.warn(`[brain-ui] browser embed ${method} failed:`, error?.message || error);
    return Promise.resolve(null);
  }
}

function hideNativeBrowserEmbed() {
  if (!browserEmbedBridge) return;
  browserEmbedAnimationUntil = 0;
  if (browserEmbedFrameRequest) {
    cancelAnimationFrame(browserEmbedFrameRequest);
    browserEmbedFrameRequest = 0;
  }
  lastBrowserEmbedGeometry = "";
  callBrowserEmbed("hide");
}

function browserEmbedPayload() {
  if (
    !browserEmbedBridge
    || !browserPreviewActive
    || browserPreviewEl?.hidden
    || document.visibilityState === "hidden"
    || !browserPreviewNativeSlotEl
  ) return null;
  const rect = browserPreviewNativeSlotEl.getBoundingClientRect();
  if (rect.width < 1 || rect.height < 1) return null;
  const radius = Math.max(
    0,
    Number.parseFloat(getComputedStyle(browserPreviewNativeSlotEl).borderTopLeftRadius) || 0,
  );
  // getBoundingClientRect() is expressed in renderer CSS pixels, while Electron
  // View bounds use device-independent window pixels. Page zoom changes the
  // relationship between the two, so apply webFrame's zoom factor (but not
  // devicePixelRatio, which would incorrectly double-scale Retina displays).
  const rendererZoom = Math.max(
    0.25,
    Math.min(5, Number(window.alice?.getZoomFactor?.()) || 1),
  );
  return {
    mode: "card",
    visible: true,
    bounds: {
      x: Math.round(rect.left * rendererZoom),
      y: Math.round(rect.top * rendererZoom),
      width: Math.max(1, Math.round(rect.width * rendererZoom)),
      height: Math.max(1, Math.round(rect.height * rendererZoom)),
    },
    radius: Math.round(radius * rendererZoom),
    ...(browserPreviewNativeUrl ? { url: browserPreviewNativeUrl } : {}),
    interactive: true,
  };
}

function syncNativeBrowserEmbed(timestamp = performance.now()) {
  browserEmbedFrameRequest = 0;
  if (browserPreviewHostTransitioning) return;
  const payload = browserEmbedPayload();
  if (!payload) {
    if (browserPreviewActive) hideNativeBrowserEmbed();
    return;
  }
  const geometry = JSON.stringify(payload);
  if (geometry !== lastBrowserEmbedGeometry) {
    lastBrowserEmbedGeometry = geometry;
    callBrowserEmbed("update", payload);
  }
  if (timestamp < browserEmbedAnimationUntil) scheduleNativeBrowserEmbedSync();
}

function scheduleNativeBrowserEmbedSync(animationDuration = 0) {
  const duration = Number.isFinite(animationDuration) ? Math.max(0, animationDuration) : 0;
  if (duration > 0) {
    browserEmbedAnimationUntil = Math.max(
      browserEmbedAnimationUntil,
      performance.now() + duration + 34,
    );
  }
  if (!browserEmbedBridge || browserEmbedFrameRequest) return;
  browserEmbedFrameRequest = requestAnimationFrame(syncNativeBrowserEmbed);
}

function clearBrowserPreviewAsset() {
  if (browserPreviewImageEl) browserPreviewImageEl.removeAttribute("src");
  if (browserPreviewObjectUrl) {
    URL.revokeObjectURL(browserPreviewObjectUrl);
    browserPreviewObjectUrl = "";
  }
}

function finalizeBrowserPreviewHidden({
  hideEmbed = true,
  preservePending = false,
  clearAsset = true,
} = {}) {
  clearBrowserPreviewTransition();
  browserEmbedAnimationUntil = 0;
  browserPreviewActive = false;
  if (hideEmbed) {
    browserPreviewNativeUrl = "";
    browserPreviewDisplayMode = "hidden";
  }
  if (!preservePending) {
    browserPreviewPending = false;
  }
  if (browserPreviewEl) {
    browserPreviewEl.hidden = true;
    browserPreviewEl.dataset.state = "idle";
    delete browserPreviewEl.dataset.renderer;
    browserPreviewEl.setAttribute("aria-hidden", "true");
  }
  if (actionLogEl) actionLogEl.hidden = false;
  actionLogSurfaceEl?.setAttribute("aria-hidden", "false");
  if (actionLogModuleEl) {
    delete actionLogModuleEl.dataset.browserActive;
    delete actionLogModuleEl.dataset.browserPhase;
  }
  if (hideEmbed) hideNativeBrowserEmbed();
  if (clearAsset) clearBrowserPreviewAsset();
}

function revealBrowserPreviewSurface() {
  if (!browserPreviewEl || !actionLogModuleEl) return;
  clearBrowserPreviewTransition();
  const wasRendered = !browserPreviewEl.hidden;
  if (actionLogEl) actionLogEl.hidden = false;
  actionLogSurfaceEl?.setAttribute("aria-hidden", "false");
  browserPreviewEl.hidden = false;
  browserPreviewEl.setAttribute("aria-hidden", "false");
  actionLogModuleEl.dataset.browserActive = "true";
  if (!wasRendered) delete actionLogModuleEl.dataset.browserPhase;

  // Keep the initial, off-screen browser pose for one rendered frame. The
  // next frame flips both layers together, allowing CSS and the native
  // WebContentsView geometry loop to follow the same motion curve.
  void actionLogModuleEl.offsetWidth;
  browserPreviewTransitionFrame = requestAnimationFrame(() => {
    browserPreviewTransitionFrame = 0;
    if (!browserPreviewActive || browserPreviewEl.hidden) return;
    actionLogModuleEl.dataset.browserPhase = "browser";
    const duration = browserPreviewTransitionDuration();
    if (!browserPreviewHostTransitioning) scheduleNativeBrowserEmbedSync(duration);
    browserPreviewTransitionTimer = setTimeout(() => {
      browserPreviewTransitionTimer = null;
      if (!browserPreviewActive || actionLogModuleEl.dataset.browserPhase !== "browser") return;
      if (actionLogEl) actionLogEl.hidden = true;
      actionLogSurfaceEl?.setAttribute("aria-hidden", "true");
      if (!browserPreviewHostTransitioning) scheduleNativeBrowserEmbedSync();
    }, duration + 34);
  });
}

function concealBrowserPreviewSurface({
  hideEmbed = true,
  preservePending = false,
  clearAsset = true,
  immediate = false,
} = {}) {
  if (immediate || !browserPreviewActive || !browserPreviewEl || browserPreviewEl.hidden) {
    finalizeBrowserPreviewHidden({ hideEmbed, preservePending, clearAsset });
    return;
  }
  clearBrowserPreviewTransition();
  if (actionLogEl) actionLogEl.hidden = false;
  actionLogSurfaceEl?.setAttribute("aria-hidden", "false");
  const duration = browserPreviewTransitionDuration();
  browserPreviewTransitionFrame = requestAnimationFrame(() => {
    browserPreviewTransitionFrame = 0;
    if (actionLogModuleEl) delete actionLogModuleEl.dataset.browserPhase;
    if (!browserPreviewHostTransitioning) scheduleNativeBrowserEmbedSync(duration);
    browserPreviewTransitionTimer = setTimeout(() => {
      browserPreviewTransitionTimer = null;
      finalizeBrowserPreviewHidden({ hideEmbed, preservePending, clearAsset });
    }, duration + 34);
  });
}

function concealBrowserPreviewForAction({ hideEmbed = true } = {}) {
  concealBrowserPreviewSurface({
    hideEmbed,
    preservePending: true,
    clearAsset: false,
  });
}

function hideBrowserPreview({ immediate = false } = {}) {
  browserPreviewHostTransitionToken += 1;
  browserPreviewHostTransitioning = false;
  browserPreviewHostTransitionTarget = "";
  browserPreviewDisplayMode = "hidden";
  browserPreviewLoadToken += 1;
  browserPreviewPending = false;
  browserPreviewNativeUrl = "";
  concealBrowserPreviewSurface({ immediate });
}

function prepareBrowserPreview(data = {}) {
  browserPreviewLoadToken += 1;
  browserPreviewPending = true;
  if (browserEmbedBridge && browserPreviewDisplayMode === "window") {
    void showNativeBrowserPreview({ ...data, transition: true });
    return;
  }
  // Once the card preview is visible, keep it on screen while Chrome actions
  // types, scrolls, or navigates. Only the very first load waits off-screen;
  // browser_close owns the later decision to dismiss the surface.
  if (!browserPreviewActive) concealBrowserPreviewForAction();
}

function measureFinalBrowserCardPayload() {
  if (!actionLogModuleEl) return null;
  const previousPhase = actionLogModuleEl.dataset.browserPhase;
  actionLogModuleEl.dataset.browserPhase = "browser";
  void actionLogModuleEl.offsetWidth;
  const payload = browserEmbedPayload();
  if (previousPhase === undefined) delete actionLogModuleEl.dataset.browserPhase;
  else actionLogModuleEl.dataset.browserPhase = previousPhase;
  void actionLogModuleEl.offsetWidth;
  return payload;
}

async function showNativeBrowserPreview(data = {}) {
  if (
    browserPreviewHostTransitioning
    && browserPreviewHostTransitionTarget === "card"
  ) return;
  const switchingFromWindow = browserPreviewDisplayMode === "window";
  const transitionToken = ++browserPreviewHostTransitionToken;
  browserPreviewLoadToken += 1;
  browserPreviewPending = false;
  browserPreviewActive = true;
  browserPreviewDisplayMode = "card";
  if (data.url) browserPreviewNativeUrl = String(data.url);
  if (browserPreviewEl) {
    browserPreviewEl.dataset.renderer = "native";
    browserPreviewEl.dataset.state = "ready";
  }
  browserPreviewHostTransitioning = switchingFromWindow;
  browserPreviewHostTransitionTarget = switchingFromWindow ? "card" : "";
  revealBrowserPreviewSurface();
  if (!switchingFromWindow) return;

  const payload = measureFinalBrowserCardPayload();
  if (!payload) {
    browserPreviewHostTransitioning = false;
    browserPreviewHostTransitionTarget = "";
    scheduleNativeBrowserEmbedSync(browserPreviewTransitionDuration());
    return;
  }
  lastBrowserEmbedGeometry = JSON.stringify(payload);
  await callBrowserEmbed("update", {
    ...payload,
    transition: {
      enabled: data.transition !== false,
      durationMs: browserPreviewTransitionDuration(),
    },
  });
  if (transitionToken !== browserPreviewHostTransitionToken) return;
  browserPreviewHostTransitioning = false;
  browserPreviewHostTransitionTarget = "";
  lastBrowserEmbedGeometry = "";
  scheduleNativeBrowserEmbedSync();
}

async function showNativeBrowserWindow(data = {}) {
  if (!browserEmbedBridge) {
    hideBrowserPreview();
    return;
  }
  if (
    browserPreviewHostTransitioning
    && browserPreviewHostTransitionTarget === "window"
  ) return;
  const switchingFromCard = browserPreviewDisplayMode === "card"
    && browserPreviewActive
    && !browserPreviewEl?.hidden;
  const transitionToken = ++browserPreviewHostTransitionToken;
  browserPreviewDisplayMode = "window";
  browserPreviewHostTransitioning = switchingFromCard;
  browserPreviewHostTransitionTarget = switchingFromCard ? "window" : "";
  browserPreviewLoadToken += 1;
  browserPreviewPending = false;
  if (browserEmbedFrameRequest) {
    cancelAnimationFrame(browserEmbedFrameRequest);
    browserEmbedFrameRequest = 0;
  }
  lastBrowserEmbedGeometry = "";
  const hostUpdate = callBrowserEmbed("update", {
    mode: "window",
    visible: true,
    ...(data.url ? { url: String(data.url) } : {}),
    interactive: true,
    transition: {
      enabled: switchingFromCard && data.transition !== false,
      durationMs: browserPreviewTransitionDuration(),
    },
  });
  if (switchingFromCard) {
    concealBrowserPreviewSurface({ hideEmbed: false, clearAsset: false });
  } else {
    finalizeBrowserPreviewHidden({ hideEmbed: false, clearAsset: false });
  }
  await hostUpdate;
  if (transitionToken !== browserPreviewHostTransitionToken) return;
  browserPreviewHostTransitioning = false;
  browserPreviewHostTransitionTarget = "";
}

async function loadBrowserPreviewImage(data = {}) {
  const imagePath = String(data.image_url || "");
  if (!imagePath || !browserPreviewImageEl) return;
  browserPreviewPending = true;
  const loadToken = ++browserPreviewLoadToken;
  let objectUrl = "";
  let previousObjectUrl = "";
  try {
    const imageUrl = new URL(imagePath, `${API}/`);
    if (data.revision) imageUrl.searchParams.set("revision", String(data.revision));
    const response = await fetch(imageUrl, { cache: "no-store" });
    if (!response.ok) throw new Error(`browser preview HTTP ${response.status}`);
    const blob = await response.blob();
    if (!blob.type.startsWith("image/")) throw new Error("browser preview is not an image");
    objectUrl = URL.createObjectURL(blob);
    const preloadedImage = new Image();
    preloadedImage.src = objectUrl;
    await preloadedImage.decode();
    if (loadToken !== browserPreviewLoadToken || !browserPreviewPending) {
      URL.revokeObjectURL(objectUrl);
      return;
    }
    previousObjectUrl = browserPreviewObjectUrl;
    browserPreviewImageEl.src = objectUrl;
    await browserPreviewImageEl.decode();
    if (loadToken !== browserPreviewLoadToken || !browserPreviewPending) {
      URL.revokeObjectURL(objectUrl);
      return;
    }
    browserPreviewObjectUrl = objectUrl;
    objectUrl = "";
    if (previousObjectUrl) URL.revokeObjectURL(previousObjectUrl);
    browserPreviewPending = false;
    browserPreviewActive = true;
    if (browserPreviewEl) {
      browserPreviewEl.dataset.renderer = "fallback";
      browserPreviewEl.dataset.state = "ready";
    }
    revealBrowserPreviewSurface();
  } catch (error) {
    if (objectUrl) URL.revokeObjectURL(objectUrl);
    if (loadToken !== browserPreviewLoadToken) return;
    if (previousObjectUrl && browserPreviewActive) {
      browserPreviewImageEl.src = previousObjectUrl;
    }
    browserPreviewPending = false;
    console.warn("[brain-ui] browser preview unavailable:", error?.message || error);
    if (!browserPreviewActive) hideBrowserPreview();
  }
}

function handleBrowserPreviewEvent(data = {}) {
  // Closing a page is valid without selecting a presentation in this turn.
  // Deal with that lifecycle event before mode dispatch so it never needs an
  // implicit card/window fallback merely to dismiss an existing surface.
  if (data.state === "closed") {
    hideBrowserPreview();
    return;
  }
  if (data.mode === "window") {
    // Large mode detaches the same live WebContentsView into its own window;
    // no reload, screenshot swap, or browser-profile handoff is involved.
    if (browserEmbedBridge && data.state === "ready") void showNativeBrowserWindow(data);
    else hideBrowserPreview();
    return;
  }
  if (data.mode !== "card") return;
  if (data.state === "failed") {
    if (!browserPreviewActive) hideBrowserPreview();
    return;
  }
  if (data.state !== "ready") return;
  if (browserEmbedBridge) {
    void showNativeBrowserPreview(data);
    return;
  }
  void loadBrowserPreviewImage(data);
}

if (browserEmbedBridge) {
  callBrowserEmbed("hide");
  if (typeof browserEmbedBridge.getState === "function") {
    callBrowserEmbed("getState");
  }
  const browserPreviewResizeObserver = typeof ResizeObserver === "function"
    ? new ResizeObserver(scheduleNativeBrowserEmbedSync)
    : null;
  if (browserPreviewNativeSlotEl) browserPreviewResizeObserver?.observe(browserPreviewNativeSlotEl);
  if (browserPreviewEl) browserPreviewResizeObserver?.observe(browserPreviewEl);
  window.addEventListener("resize", scheduleNativeBrowserEmbedSync);
  window.addEventListener("scroll", scheduleNativeBrowserEmbedSync, true);
  window.visualViewport?.addEventListener("resize", scheduleNativeBrowserEmbedSync);
  window.visualViewport?.addEventListener("scroll", scheduleNativeBrowserEmbedSync);
  document.addEventListener("visibilitychange", () => {
    if (document.visibilityState === "hidden") hideNativeBrowserEmbed();
    else scheduleNativeBrowserEmbedSync();
  });
  window.addEventListener("pagehide", hideNativeBrowserEmbed);
  window.addEventListener("beforeunload", hideNativeBrowserEmbed);
}

function beginHeartbeatRound(ts = Date.now()) {
  activeHeartbeatRound = true;
  lastHeartbeatAt = Number(ts) || Date.now();
  heartbeatCount += 1;
  try { localStorage.setItem(HEARTBEAT_COUNT_KEY, JSON.stringify(heartbeatCount)); } catch {}
  updateHeartbeatFacts();
  triggerHeartbeatPulse(1);
}

function finishHeartbeatRound() {
  if (!activeHeartbeatRound) return;
  activeHeartbeatRound = false;
}

function rebuildActionLogFromHistory(events) {
  return events
    .filter(event => (
      event?.type === "tool_call"
      && event?.data?.name
      && event.data.ok !== false
      && !ACTION_LOG_IGNORED_TOOLS.has(event.data.name)
    ))
    .map(event => ({
      text: describeAction(event.data.name, event.data.args, event.data.result),
      kind: "action",
      tool: String(event.data.name),
      ts: Date.parse(event.ts) || Date.now(),
    }))
    .slice(-ACTION_LOG_LIMIT);
}

function updateHeartbeatFacts() {
  if (heartbeatCountEl) heartbeatCountEl.textContent = String(heartbeatCount);
  if (!heartbeatLastEl) return;
  if (!lastHeartbeatAt) {
    heartbeatLastEl.textContent = t("runtime.heartbeatWaiting");
    return;
  }
  const elapsed = Math.max(0, Date.now() - lastHeartbeatAt);
  if (elapsed < 60_000) heartbeatLastEl.textContent = t("runtime.justNow");
  else if (elapsed < 3_600_000) heartbeatLastEl.textContent = t("runtime.minutesAgo", { count: Math.floor(elapsed / 60_000) });
  else if (elapsed < 86_400_000) heartbeatLastEl.textContent = t("runtime.hoursAgo", { count: Math.floor(elapsed / 3_600_000) });
  else heartbeatLastEl.textContent = t("runtime.daysAgo", { count: Math.floor(elapsed / 86_400_000) });
}

function formatHeartbeatInterval(minutes = defaultHeartbeatIntervalMinutes) {
  const value = Number(minutes);
  return Number.isInteger(value) && value > 0
    ? t("runtime.intervalMinutes", { count: value })
    : t("runtime.defaultInterval");
}

function applyHeartbeatConfig(heartbeat = {}) {
  const intervalMinutes = Number(heartbeat.defaultIntervalMinutes);
  if (Number.isInteger(intervalMinutes) && intervalMinutes > 0) {
    defaultHeartbeatIntervalMinutes = intervalMinutes;
  }
  if (heartbeatConnectionState === "alive") {
    setHeartbeatConnection("alive", formatHeartbeatInterval());
  }
}

async function loadHeartbeatMonitorSettings() {
  try {
    const response = await fetch(`${API}/settings/heartbeat`, { cache: "no-store" });
    const data = await response.json();
    if (!response.ok || !data.ok) throw new Error(data.error || "读取失败");
    applyHeartbeatConfig(data.heartbeat);
  } catch (err) {
    console.warn("[brain-ui] heartbeat settings unavailable:", err?.message || err);
  }
}

function setHeartbeatConnection(state, label) {
  heartbeatConnectionState = state;
  if (heartbeatStateEl) heartbeatStateEl.dataset.state = state;
  if (heartbeatStateLabelEl) heartbeatStateLabelEl.textContent = label;
  if (heartbeatStateEl) {
    heartbeatStateEl.title = state === "alive"
      ? t("runtime.defaultHeartbeatInterval", { interval: formatHeartbeatInterval() })
      : label;
  }
}

function setCognitionState(label, state = "idle") {
  if (!cognitionStateEl) return;
  cognitionStateEl.textContent = label;
  cognitionStateEl.title = label;
  cognitionStateEl.dataset.state = state;
}

function setL3State(label = t("runtime.l3Standby"), state = "idle") {
  if (!l3StateEl) return;
  l3StateEl.textContent = label;
  l3StateEl.title = label;
  l3StateEl.dataset.state = state;
}

function setVoiceThinking(active) {
  const thinking = Boolean(active);
  document.body.classList.toggle("model-thinking", thinking);
  window.aliceVoice?.setThinking?.(thinking);
}

function revealCognitionStream() {
  if (cognitionEmptyEl?.parentElement) cognitionEmptyEl.remove();
}

function restoreUserStreamHistory(events) {
  const history = Array.isArray(events) ? events.slice(-120) : [];
  if (history.length === 0 || !L1.el) return;

  L1.beginRound();
  L1.el.replaceChildren();
  let roundActive = false;

  for (const event of history) {
    const type = event?.type;
    const data = event?.data || {};
    switch (type) {
      case "message_received": {
        roundActive = true;
        L1.beginRound();
        const parsed = parseUserMessageInput(data.input);
        L1.newLine("user message received", {
          content: parsed.content,
          time: parsed.time || heartbeatClock(Date.parse(event.ts) || Date.now()),
        });
        L1.startThinkingSession();
        break;
      }
      case "stream_start":
        if (roundActive) L1.startThinkingSession();
        break;
      case "stream_end":
        if (roundActive) L1.stopThinking();
        break;
      case "tool_preparing": {
        if (!roundActive) break;
        const action = data.name ? L1.toolAction(data.name) : t("runtime.preparingNext");
        L1.setStatus(t("runtime.preparingActionStatus", { action }), "busy");
        break;
      }
      case "tool_executing": {
        if (!roundActive) break;
        const action = data.name ? L1.toolAction(data.name) : t("runtime.activityGeneral");
        L1.setStatus(t("runtime.workingActionStatus", { action }), "busy");
        break;
      }
      case "tool_call":
        if (roundActive) L1.tool(data.name, data.args, data.result, data.ok);
        break;
      case "response":
        if (roundActive) L1.end();
        roundActive = false;
        break;
      case "processing_preempted":
      case "message_dropped":
      case "protocol_violation":
      case "error":
        if (roundActive) L1.end();
        roundActive = false;
        break;
      case "llm_retry":
      case "message_requeued":
        if (roundActive) L1.setStatus(t("runtime.waitingRetry"), "busy");
        break;
    }
  }

  if (roundActive) {
    L1.stopThinking();
    L1.setStatus(t("runtime.previousSessionIncomplete"), "failed");
  }
}

function restoreCognitionHistory(events) {
  const history = Array.isArray(events) ? events.slice(-120) : [];
  if (history.length === 0 || !L2.el) return;

  L2.beginRound();
  L2.el.replaceChildren();
  let roundActive = false;
  let lastSettledState = "idle";
  let lastL3State = { label: t("runtime.l3Standby"), state: "idle" };

  for (const event of history) {
    const type = event?.type;
    const data = event?.data || {};
    switch (type) {
      case "tick":
        roundActive = true;
        L2.beginRound();
        L2.newLine("heartbeat tick", { time: heartbeatClock(Date.parse(event.ts) || Date.now()) });
        L2.startThinkingSession();
        lastSettledState = "thinking";
        break;
      case "scheduled_task":
        roundActive = true;
        L2.beginRound();
        L2.newLine("L3 scheduled task", {
          content: data.task || t("runtime.scheduledTask"),
          time: heartbeatClock(Date.parse(event.ts) || Date.now()),
        });
        L2.startThinkingSession();
        lastSettledState = "thinking";
        lastL3State = { label: t("runtime.l3Running", { id: data.reminder_id || data.run_id || "?" }), state: "running" };
        break;
      case "scheduled_task_completed":
        lastL3State = { label: t("runtime.l3Completed"), state: "done" };
        break;
      case "scheduled_task_retry":
        lastL3State = { label: t("runtime.l3Retry", { attempt: data.next_attempt || "" }).trim(), state: "retry" };
        break;
      case "scheduled_task_failed":
        lastL3State = { label: t("runtime.l3Failed"), state: "failed" };
        break;
      case "stream_start":
        if (roundActive) L2.startThinkingSession();
        break;
      case "stream_end":
        if (roundActive) L2.stopThinking();
        break;
      case "tool_preparing": {
        if (!roundActive) break;
        const action = data.name ? L2.toolAction(data.name) : t("runtime.preparingNext");
        L2.setStatus(t("runtime.preparingActionStatus", { action }), "busy");
        lastSettledState = "tool";
        break;
      }
      case "tool_executing": {
        if (!roundActive) break;
        const action = data.name ? L2.toolAction(data.name) : t("runtime.activityGeneral");
        L2.setStatus(t("runtime.workingActionStatus", { action }), "busy");
        lastSettledState = "tool";
        break;
      }
      case "tool_call":
        if (roundActive) {
          L2.tool(data.name, data.args, data.result, data.ok);
          lastSettledState = "tool";
        }
        break;
      case "response":
        if (roundActive) L2.end();
        roundActive = false;
        lastSettledState = "done";
        break;
      case "processing_preempted":
      case "message_dropped":
      case "protocol_violation":
      case "error":
        if (roundActive) L2.end();
        roundActive = false;
        lastSettledState = "interrupted";
        break;
      case "llm_retry":
      case "message_requeued":
        if (roundActive) L2.setStatus(t("runtime.waitingRetry"), "busy");
        break;
    }
  }

  if (roundActive) {
    L2.stopThinking();
    L2.clearStatus();
    setCognitionState(t("runtime.previousRoundIncomplete"), "idle");
  } else if (lastSettledState === "done") {
    setCognitionState(t("runtime.recentRoundComplete"), "done");
  } else if (lastSettledState === "interrupted") {
    setCognitionState(t("runtime.recentRoundInterrupted"), "idle");
  }
  setL3State(lastL3State.label, lastL3State.state);
}

async function loadBrainUiHistory() {
  try {
    const response = await fetch(`${API}/events/history?path=all&limit=240`, { cache: "no-store" });
    const payload = await response.json();
    if (!response.ok || !payload.ok || !Array.isArray(payload.events)) throw new Error(payload.error || "历史读取失败");

    const l1Events = payload.events.filter(event => event?.path === "l1");
    const l2Events = payload.events.filter(event => !event?.path || event.path === "l2" || event.path === "l3");
    actionLog = rebuildActionLogFromHistory(payload.events);
    heartbeatCount = Math.max(0, Number(payload.heartbeatCount) || 0);
    lastHeartbeatAt = l2Events.filter(event => event?.type === "tick").at(-1)?.ts || 0;
    if (lastHeartbeatAt) lastHeartbeatAt = Date.parse(lastHeartbeatAt) || 0;
    try {
      localStorage.setItem(ACTION_LOG_KEY, JSON.stringify(actionLog));
      localStorage.setItem(HEARTBEAT_COUNT_KEY, JSON.stringify(heartbeatCount));
    } catch {}
    renderActionLog();
    updateHeartbeatFacts();
    restoreUserStreamHistory(l1Events);
    restoreCognitionHistory(l2Events);
  } catch (err) {
    // 旧后端或临时不可用时继续使用 localStorage 快照；实时 SSE 仍然照常连接。
    console.warn("[brain-ui] heartbeat history unavailable:", err?.message || err);
  }
}

const HEARTBEAT_SAMPLE_COUNT = 64;
const HEARTBEAT_FRAME_INTERVAL_MS = 120;
const HEARTBEAT_PULSE_SHAPE = [0.02, 0.08, -0.08, 0.2, 0.92, -0.4, 0.34, 0.1, 0.02];
const HEARTBEAT_MAJOR_STRENGTH = 1;
const HEARTBEAT_TOOL_STRENGTH = 0.8;
const TOOL_HEARTBEAT_INTERVAL_MS = 3000;
const heartbeatSamples = Array.from({ length: HEARTBEAT_SAMPLE_COUNT }, () => 0);
let heartbeatPulseQueue = [];
let heartbeatBeatTimer = null;
let toolHeartbeatTimer = null;
const activeToolExecutions = new Map();

function renderHeartbeatWave() {
  if (!heartbeatWaveEl || !heartbeatAreaEl) return;
  const width = 320;
  const baseline = 36;
  const amplitude = 28;
  const points = heartbeatSamples.map((sample, index) => {
    const x = index * width / (HEARTBEAT_SAMPLE_COUNT - 1);
    const y = baseline - sample * amplitude;
    return `${x.toFixed(1)} ${y.toFixed(1)}`;
  });
  const line = `M${points.join(" L")}`;
  heartbeatWaveEl.setAttribute("d", line);
  heartbeatAreaEl.setAttribute("d", `${line} L320 ${baseline} L0 ${baseline} Z`);
}

function triggerHeartbeatPulse(strength = HEARTBEAT_MAJOR_STRENGTH, kind = "major") {
  const numericStrength = Number(strength);
  const s = Number.isFinite(numericStrength) ? Math.max(0.2, Math.min(1.4, numericStrength)) : 1;
  heartbeatPulseQueue.push(...HEARTBEAT_PULSE_SHAPE.map(sample => sample * s));
  if (!heartbeatMonitorEl) return;
  if (heartbeatBeatTimer) clearTimeout(heartbeatBeatTimer);
  heartbeatMonitorEl.removeAttribute("data-beat");
  void heartbeatMonitorEl.offsetWidth;
  heartbeatMonitorEl.dataset.beat = kind;
  heartbeatBeatTimer = setTimeout(() => {
    heartbeatMonitorEl?.removeAttribute("data-beat");
    heartbeatBeatTimer = null;
  }, 760);
}

function toolExecutionKey(name) {
  return String(name || "__unknown_tool__");
}

function hasActiveToolExecutions() {
  return activeToolExecutions.size > 0;
}

function stopToolHeartbeatTimer() {
  if (!toolHeartbeatTimer) return;
  clearInterval(toolHeartbeatTimer);
  toolHeartbeatTimer = null;
}

function beginToolHeartbeat(name) {
  const key = toolExecutionKey(name);
  activeToolExecutions.set(key, (activeToolExecutions.get(key) || 0) + 1);
  triggerHeartbeatPulse(HEARTBEAT_TOOL_STRENGTH, "minor");
  if (toolHeartbeatTimer) return;
  toolHeartbeatTimer = setInterval(() => {
    if (!hasActiveToolExecutions()) {
      stopToolHeartbeatTimer();
      return;
    }
    // 长时间工具调用期间保持可视活动，但不计作 L2 Tick。
    triggerHeartbeatPulse(HEARTBEAT_TOOL_STRENGTH, "minor");
  }, TOOL_HEARTBEAT_INTERVAL_MS);
}

function finishToolHeartbeat(name) {
  const key = toolExecutionKey(name);
  const count = activeToolExecutions.get(key) || 0;
  if (count > 1) activeToolExecutions.set(key, count - 1);
  else if (count === 1) activeToolExecutions.delete(key);
  if (!hasActiveToolExecutions()) stopToolHeartbeatTimer();
}

function resetToolHeartbeats() {
  activeToolExecutions.clear();
  stopToolHeartbeatTimer();
}

function advanceHeartbeatWave() {
  // 没有真实消息、Tick 或工具活动时回到平直基线；不用随机噪声伪造心跳。
  const next = heartbeatPulseQueue.length
    ? heartbeatPulseQueue.shift()
    : 0;
  heartbeatSamples.push(next);
  heartbeatSamples.shift();
  renderHeartbeatWave();
}

renderActionLog();
updateHeartbeatFacts();
renderHeartbeatWave();
setInterval(advanceHeartbeatWave, HEARTBEAT_FRAME_INTERVAL_MS);
setInterval(updateHeartbeatFacts, 30_000);

// L1 = user messages; L2 = autonomous heartbeat; L3 = deterministic scheduled tasks.
// stream_*/tool_call events emitted by the backend carry no path tag;
// routing is determined by the most recent message_received / tick / scheduled_task event.
let currentPath = "l2";
function currentStream() { return currentPath === "l1" ? L1 : L2; }

function isBusyErrorMessage(message = "") {
  return /(429|rate limit|too many requests|busy|overload|temporarily unavailable|server busy|resource exhausted)/i.test(String(message || ""));
}

function formatRetryDelay(ms) {
  if (!ms || ms < 1000) return `${ms || 0}ms`;
  return `${(ms / 1000).toFixed(ms % 1000 === 0 ? 0 : 1)}s`;
}

let tokenAccum = 0;
let tokenWindow = Date.now();
const tokRateEl = document.getElementById("tok-rate");

// 记忆系统观测（Memory-Optimization v0.1 Phase 0）：每 60s 拉一次近 1 小时的 audit stats。
// 显示"N 次（平均 K 条）"——次数代表系统活跃度，平均条数代表召回/抽取的健康度。
// 0 命中数会让数字变橙提醒（命中率低 = 可能有召回漏）；纯网络/服务失败保持 — 不告警。
const memRecallEl = document.getElementById("mem-recall-rate");
const memExtractEl = document.getElementById("mem-extract-rate");

// ── AI 当前正在做什么：派生展示 ────────────────────────────────
// 北极星（[[feedback-ai-be-itself]]）：通信问题靠界面侧派生可视化解决，不逼 AI 学人开口。
// 工作方式：纯被动接收 tool_call 事件流，按工具名归类统计最近 60s 活动，自动推导当前活动标签。
// AI 完全不需要为此多做任何动作；它只管干活，UI 自己把"在干什么"翻译给用户看。
const AI_ACTIVITY_WINDOW_MS = 60_000;
const AI_ACTIVITY_IDLE_AFTER_MS = 15_000;
const AI_TOOL_GROUPS = {
  "runtime.activityScanFiles": new Set(["read_file", "list_dir"]),
  "runtime.activityChangeFiles": new Set(["write_file", "edit_file", "make_dir", "delete_file"]),
  "runtime.activityRunCommands": new Set(["run_command", "download_file", "kill_process", "list_processes"]),
  "runtime.activityBrowse": new Set([
    "browser_navigate", "browser_navigate_back", "browser_navigate_forward", "browser_reload", "browser_snapshot", "browser_find",
    "browser_click", "browser_type", "browser_fill_form", "browser_select_option",
    "browser_press_key", "browser_hover", "browser_drag", "browser_wait_for",
    "browser_handle_dialog", "browser_tabs", "browser_take_screenshot",
    "browser_console_messages", "browser_resize", "browser_close",
  ]),
  "runtime.activityClearBrowser": new Set(["browser_clear_data"]),
  "runtime.activityMemory": new Set(["search_memory", "recall_memory", "probe_memory", "upsert_memory", "merge_memories", "downgrade_memory"]),
  "runtime.activityUi": new Set(["ui_set", "focus_banner"]),
  "runtime.activityMedia": new Set(["speak", "generate_lyrics", "generate_music", "generate_image", "music", "media_mode"]),
  "runtime.activityReply": new Set(["send_message", "express"]),
};
const aiActivityLog = [];
let aiActivityFirstTs = 0;
let aiActivityTimer = null;
const aiActivityEl = document.getElementById("ai-activity");
const aiActivityLabelEl = document.getElementById("ai-activity-label");
const aiActivityDetailEl = document.getElementById("ai-activity-detail");

function classifyTool(name) {
  for (const [translationKey, set] of Object.entries(AI_TOOL_GROUPS)) {
    if (set.has(name)) return translationKey;
  }
  return "runtime.activityGeneral";
}

function recordAiActivity(name) {
  if (!name) return;
  const now = Date.now();
  if (aiActivityLog.length === 0) aiActivityFirstTs = now;
  aiActivityLog.push({ name, ts: now, group: classifyTool(name) });
  refreshAiActivity();
}

function refreshAiActivity() {
  if (!aiActivityEl) return;
  const now = Date.now();
  while (aiActivityLog.length && now - aiActivityLog[0].ts > AI_ACTIVITY_WINDOW_MS) {
    aiActivityLog.shift();
  }
  if (aiActivityLog.length === 0) {
    aiActivityEl.dataset.state = "idle";
    aiActivityLabelEl.textContent = t("runtime.activityIdle");
    aiActivityDetailEl.textContent = "";
    aiActivityFirstTs = 0;
    return;
  }
  const lastTs = aiActivityLog[aiActivityLog.length - 1].ts;
  if (now - lastTs > AI_ACTIVITY_IDLE_AFTER_MS) {
    aiActivityEl.dataset.state = "idle";
    aiActivityLabelEl.textContent = t("runtime.activityJustCompleted");
    const ago = Math.round((now - lastTs) / 1000);
    aiActivityDetailEl.textContent = t("runtime.activityStoppedAgo", { seconds: ago });
    return;
  }
  const counts = {};
  for (const e of aiActivityLog) counts[e.group] = (counts[e.group] || 0) + 1;
  let domGroup = "runtime.activityGeneral";
  let domCount = 0;
  for (const [g, c] of Object.entries(counts)) {
    if (c > domCount) { domCount = c; domGroup = g; }
  }
  aiActivityEl.dataset.state = "busy";
  aiActivityLabelEl.textContent = t("runtime.activityWorking", { activity: t(domGroup) });
  const elapsed = Math.round((now - (aiActivityFirstTs || lastTs)) / 1000);
  aiActivityDetailEl.textContent = t("runtime.activityDetail", { count: aiActivityLog.length, seconds: elapsed });
}

if (aiActivityEl) {
  aiActivityEl.dataset.state = "idle";
  aiActivityTimer = setInterval(refreshAiActivity, 1000);
}

async function refreshMemoryAuditStats() {
  if (!memRecallEl || !memExtractEl) return;
  try {
    const res = await fetch("/audit/stats?hours=1", { cache: "no-store" });
    if (!res.ok) return;
    const data = await res.json();
    const r = data?.recall || {};
    const e = data?.extract || {};
    const rTotal = Number(r.total || 0);
    const rAvg = Number(r.avg_chosen || 0);
    const rZero = Number(r.zero_match_count || 0);
    const eTotal = Number(e.total || 0);
    const eAvg = Number(e.avg_extracted || 0);
    const eSkip = Number(e.skipped_count || 0);
    memRecallEl.textContent = rTotal ? `${rTotal}·${rAvg.toFixed(1)}` : "0";
    memExtractEl.textContent = eTotal ? `${eTotal}·${eAvg.toFixed(1)}` : "0";
    memRecallEl.style.color = (rTotal > 0 && rZero / rTotal > 0.2) ? "var(--warn, #e8a23a)" : "";
    memExtractEl.style.color = (eTotal > 0 && eSkip / eTotal > 0.5) ? "var(--warn, #e8a23a)" : "";
  } catch {
    // 静默：dev/build 早期 audit 表可能还没数据，保持 — 即可
  }
}
refreshMemoryAuditStats();
setInterval(refreshMemoryAuditStats, 60_000);

function bumpTokens(text) {
  tokenAccum += (text || "").length / 3.4;
  const now = Date.now();
  if (now - tokenWindow > 700) {
    const rate = tokenAccum / ((now - tokenWindow) / 1000);
    tokRateEl.textContent = rate.toFixed(1);
    tokenAccum = 0;
    tokenWindow = now;
    setTimeout(() => { if (tokRateEl.textContent !== "—" && tokenAccum === 0) tokRateEl.textContent = "—"; }, 4000);
  }
}

// ── 专注帧观察面板 (focus stack) ────────────────────────────────
// 设计文档 7.5：用户必须看得见 Agent 此刻在专注什么。
// 纯事件驱动：focus_frame → 全量重渲染；focus_compressed → 在栈顶尾部追加 conclusion 并淡入。

function escapeFocusText(s) {
  return String(s == null ? "" : s)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
}

function truncateConclusion(text, max = 60) {
  const s = String(text || "").trim();
  if (s.length <= max) return s;
  return s.slice(0, max - 1).trim() + "…";
}

function renderFocusFrame(frame, { isTop }) {
  const conclusions = Array.isArray(frame?.conclusions) ? frame.conclusions : [];

  // 主行显示策略（progressive disclosure）：
  //   1. 有 conclusion → 显示最新一条（这是子帧 pop 时压缩出的 1-2 句话结论）
  //   2. 无 conclusion 但有 topic → 显示 topic（v0 是 ngram，几百 ms 后被 LLM refine 成人类可读短语）
  //   3. 都没 → 返回空主行（上层 renderFocusStack 会进一步过滤）
  // 早期 conclusion 作为弱化辅助行（栈顶帧才显示，避免视觉过载）
  const latest = conclusions.length > 0 ? conclusions[conclusions.length - 1] : "";
  const earlier = conclusions.length > 1 ? conclusions.slice(0, -1) : [];
  const topicSummary = Array.isArray(frame?.topic) && frame.topic.length > 0
    ? frame.topic.slice(0, 3).join(" · ")
    : "";

  let mainHTML = "";
  if (latest) {
    mainHTML = `<div class="focus-frame-main">${escapeFocusText(truncateConclusion(latest, isTop ? 120 : 80))}</div>`;
  } else if (topicSummary) {
    mainHTML = `<div class="focus-frame-main focus-frame-main-fallback">${escapeFocusText(truncateConclusion(topicSummary, isTop ? 60 : 40))}</div>`;
  }

  const earlierHTML = earlier.map((c) =>
    `<div class="focus-frame-conclusion focus-frame-conclusion-earlier">${escapeFocusText(truncateConclusion(c, isTop ? 100 : 60))}</div>`
  ).join("");

  // 该帧既无 conclusion 也无 topic（极短暂的"刚 push 还没赋 topic"状态），不渲染外层壳
  if (!mainHTML && !earlierHTML) return "";

  return (
    `<div class="focus-frame${isTop ? " top" : ""}">` +
      mainHTML +
      earlierHTML +
    `</div>`
  );
}

function renderFocusStack(stack) {
  if (!focusStackEl || !focusBlockEl) return;
  const list = Array.isArray(stack) ? stack : [];
  if (focusDepthEl) focusDepthEl.textContent = String(list.length);

  if (list.length === 0) {
    focusBlockEl.dataset.state = "empty";
    focusStackEl.innerHTML = `<div class="focus-empty">无专注</div>`;
    return;
  }

  focusBlockEl.dataset.state = "active";
  // 渲染策略：只渲染"有 conclusion 的帧 + 栈顶帧"。
  // 非栈顶 + 无 conclusion 的帧静默隐藏——这种帧是"已 push 但还没 pop"的活帧，
  // conclusion 永远空着，渲染出来只是占位文字（"…"），堆叠多了视觉很噪。
  // depth 数字仍然显示真实栈深度，让用户知道还有未压缩的帧挂着。
  // 栈底 → 栈顶；视觉上栈顶在最下（最近一次最强），跟终端 / 思考流方向一致。
  const html = list.map((frame, i) => {
    const isTop = i === list.length - 1;
    const hasConclusion = Array.isArray(frame?.conclusions) && frame.conclusions.length > 0;
    if (!isTop && !hasConclusion) return "";
    return renderFocusFrame(frame, { isTop });
  }).filter(Boolean).join("");
  focusStackEl.innerHTML = html;
}

function flashFocusCompressed() {
  if (!focusBlockEl) return;
  // 让栈顶帧的主行（最新 conclusion）走淡入动画；同时整块做一次柔和高光。
  focusBlockEl.classList.remove("focus-compress-pulse");
  // 强制 reflow 让动画重启
  void focusBlockEl.offsetWidth;
  focusBlockEl.classList.add("focus-compress-pulse");

  const topFrame = focusStackEl?.querySelector(".focus-frame.top");
  const mainEl = topFrame?.querySelector(".focus-frame-main");
  if (mainEl) {
    mainEl.classList.remove("just-added");
    void mainEl.offsetWidth;
    mainEl.classList.add("just-added");
  }
}

function connectSSE() {
  setConnectionState(t("runtime.connecting"), true);
  setHeartbeatConnection("waiting", t("runtime.connecting"));
  const eventsUrl = new URL("/events", `${API}/`);
  eventsUrl.searchParams.set("client_id", UI_CLIENT_ID);
  let lastEventId = "";
  try { lastEventId = sessionStorage.getItem(SSE_LAST_EVENT_KEY) || ""; } catch {}
  if (lastEventId) eventsUrl.searchParams.set("last_event_id", lastEventId);
  const es = new EventSource(eventsUrl);

  es.onopen = () => {
    chat?.restoreChatHistory?.();
    // SSE (重)连上说明事件流是通的：把「Agent 运行中」复位，避免上一轮
    // response 因断流丢失导致排队永久卡死。
    chat?.setAgentRunning?.(false);
    setConnectionState(t("runtime.connected"), true);
    setHeartbeatConnection("alive", formatHeartbeatInterval());
    voiceDiag("sse-open", { last_event_id: lastEventId || "none" });
  };

  es.onmessage = event => {
    try {
      const parsed = JSON.parse(event.data);
      handle(parsed);
      const eventId = event.lastEventId || parsed.event_id || "";
      if (eventId) {
        try { sessionStorage.setItem(SSE_LAST_EVENT_KEY, String(eventId)); } catch {}
      }
    } catch (error) {
      console.warn("[SSE] event handling failed:", error);
    }
  };

  es.onerror = () => {
    setConnectionState(t("runtime.reconnecting"), false);
    setHeartbeatConnection("offline", t("runtime.connectionLost"));
    voiceDiag("sse-error", { last_event_id: lastEventId || "none" });
    es.close();
    setTimeout(connectSSE, 3000);
  };
}

function extractNids(memList) {
  return (memList || [])
    .map(m => m.mem_id || (m.id != null ? String(m.id) : null))
    .filter(Boolean);
}

// Goal 事件到界面的推送桥（横幅在 goal-banner.js 里，是**另一个模块**）。
//
// 为什么是单个 alice:goal，而不是 alice:goal-created / -updated / -round：
// 消费方对这三种事件的反应是同一个——重读 GET /goal 再渲染，不需要按子类型分叉。
// 这与既有约定一致：一个模块一个事件，子命令放 detail 里（alice:media /
// alice:aivideo / alice:social_status 都是这个形状）。
//
// detail 带原事件数据 + 事件类型 + 顶层 goal_id：goal_round 的 payload 把目标对象
// 嵌在 data.goal 里（consciousness-loop 发的），而 created/updated 是扁平的
// （tools/goals.js 的 announce 发的）。这里统一把 goal_id 提到顶层，消费方和排查
// 都只认一个字段，不必知道两种形状的区别。
function emitGoalBridge(type, data = {}) {
  const goalId = data.goal_id || data.goal?.goalId || null;
  window.dispatchEvent(new CustomEvent("alice:goal", {
    detail: { ...data, type, goal_id: goalId },
  }));
}

function handle({ type, data = {}, ts = null }) {
  window.dispatchEvent(new CustomEvent("blm:sse", { detail: { type, data, ts } }));
  switch (type) {
    case "heartbeat_settings_updated":
      applyHeartbeatConfig(data);
      break;
    case "message_received": {
      // 新用户轮开始后，上一轮人物卡的简介更新窗口立即失效。只有本轮再次
      // 调用 person_card_mode，随后的有效人物说明才允许更新当前卡片。
      cancelPersonCardAssistantEnrichment();
      resetToolHeartbeats();
      chat.setAgentRunning(true);
      // L1 也是一次真实意识唤醒：只驱动波形，不累加 L2 心跳计数。
      triggerHeartbeatPulse(HEARTBEAT_MAJOR_STRENGTH, "major");
      if (activeHeartbeatRound) {
        finishHeartbeatRound("interrupted", "收到用户消息，心跳让路");
        setCognitionState(t("runtime.yielded"), "idle");
      }
      currentPath = "l1";
      setVoiceThinking(true);
      // 兜底：上一轮若被打断、message/response 均未到达，实时气泡会成孤儿、流式会话可能还挂着麦克风
      // ——定稿气泡、收尾流式会话（恢复麦克风）、复位状态，再开新一轮。
      if (sttsActive) endStreamingTTS();
      if (chat.hasLiveJarvisMsg()) chat.finalizeLiveJarvisMsg(null);
      liveReplyActive = false;
      liveRawText = "";
      liveTurnSpeak = false;
      L1.beginRound();
      const parsed = parseUserMessageInput(data.input);
      L1.newLine("user message received", {
        content: parsed.content,
        time: parsed.time || undefined,
      });
      // Immediately show a "thinking" indicator so the gap between message_received
      // and the first stream_start (injector + LLM TTFT, often 3–30s) doesn't look frozen.
      L1.startThinkingSession();
      break;
    }
    case "tick":
      resetToolHeartbeats();
      currentPath = "l2";
      setVoiceThinking(true);
      revealCognitionStream();
      beginHeartbeatRound(Date.parse(ts) || Date.now());
      setCognitionState(t("runtime.thinking"), "thinking");
      L2.beginRound();
      L2.newLine("heartbeat tick");
      L2.startThinkingSession();
      break;
    case "scheduled_task":
      resetToolHeartbeats();
      currentPath = "l3";
      setVoiceThinking(true);
      revealCognitionStream();
      setCognitionState(t("runtime.l3Executing"), "thinking");
      setL3State(t("runtime.l3Running", { id: data.reminder_id || data.run_id || "?" }), "running");
      L2.beginRound();
      L2.newLine("L3 scheduled task", {
        content: data.task || t("runtime.scheduledTask"),
        time: heartbeatClock(Date.parse(ts) || Date.now()),
      });
      L2.startThinkingSession();
      break;
    case "scheduled_task_completed":
      setL3State(t("runtime.l3Completed"), "done");
      break;
    case "scheduled_task_retry":
      setL3State(t("runtime.l3Retry", { attempt: data.next_attempt || "" }).trim(), "retry");
      break;
    case "scheduled_task_failed":
      setL3State(t("runtime.l3Failed"), "failed");
      break;
    case "stream_start":
      setVoiceThinking(true);
      if (currentPath !== "l1") {
        revealCognitionStream();
        setCognitionState(currentPath === "l3" ? t("runtime.l3Thinking") : t("runtime.thinking"), "thinking");
      }
      currentStream().startThinkingSession();
      // 正文流（plainReply）：把 token 实时打进聊天气泡。一轮可能有多段正文（正文→工具→正文），
      // 只在尚未开始时建气泡，后续段累积进同一个。speak 轮（语音）额外开启逐句流式合成。
      if (data.mode === "text" && data.plainReply) {
        const voiceDecision = voiceReplyCoordinator.streamStart(data, {
          streamingEnabled: isTTSStreamingEnabled(),
        });
        if (data.speak) {
          voiceDiag("stream-start", {
            turn_id: data.turn_id || "",
            target_client_id: data.target_client_id || "",
            target_matched: voiceDecision.turn.targetMatched,
            speak: true,
            playback_mode: voiceDecision.startStreaming ? "sentence-stream" : "whole-reply",
            reason: voiceDecision.reason,
          });
        }
        if (voiceDecision.eligible) liveTurnSpeak = true;
        if (!liveReplyActive) {
          liveReplyActive = true;
          liveRawText = "";
          chat.beginLiveJarvisMsg({ alert: true });
          if (voiceDecision.startStreaming) beginStreamingTTS(data);
        }
      }
      break;
    case "stream_chunk":
      // 推理摘要不进入聊天；commentary 是模型明确标记的可见过程说明，
      // 只显示在认知流里。二者都与 final_answer 聊天气泡严格分离。
      currentStream().clearStatus();
      bumpTokens(data.text);
      if (data.mode === "commentary") currentStream().appendCommentary(data.text);
      // 正文流：累积 + 实时重渲染气泡（剥离协议标记 / 藏半截标记）；语音轮喂给逐句合成队列
      if (data.mode === "text" && liveReplyActive) {
        liveRawText += data.text;
        chat.updateLiveJarvisMsg(cleanStreamText(liveRawText));
        if (sttsActive && isStreamingTTSTurn(data)) feedStreamingTTS(liveRawText);
      }
      break;
    case "stream_end":
      currentStream().stopThinking();
      setVoiceThinking(false);
      if (currentPath === "l2" && activeHeartbeatRound) setCognitionState(t("runtime.decidingNext"), "thinking");
      // 正文段结束：把残句先送去合成，降低尾句延迟（不结束会话，可能还有后续正文段）
      if (data.mode === "text" && sttsActive && isStreamingTTSTurn(data)) flushStreamingTTSBuf();
      break;
    case "subagent_start": {
      // 子代理（阶段 1）：主 Agent 派活后，把子代理自己的活动也在思考流里显出来，
      // 否则这一段工作对用户完全不可见。
      currentStream().subagent("start", data);
      setCognitionState(
        t("runtime.subagentWorking", { description: data.description || String(data.child_id || "").slice(-6) }),
        "tool",
      );
      break;
    }
    case "subagent_activity": {
      if (data.kind === "tool" || data.kind === "step_end") currentStream().subagent("activity", data);
      break;
    }
    case "subagent_end": {
      currentStream().subagent("end", data);
      break;
    }
    case "workflow_start": {
      // 工作流（阶段 2）：一次运行可能派几十个子代理，进度必须能看见。
      currentStream().workflow("start", data);
      setCognitionState(
        t("runtime.workflowRunning", { name: data.name || data.run_id || "workflow" }),
        "tool",
      );
      break;
    }
    case "workflow_phase": {
      currentStream().workflow("phase", data);
      break;
    }
    case "workflow_log": {
      currentStream().workflow("log", data);
      break;
    }
    case "workflow_agent_start":
    case "workflow_agent_end": {
      currentStream().workflow("agent", data);
      break;
    }
    case "workflow_end": {
      currentStream().workflow("end", data);
      setCognitionState(
        t(data.status === "completed" ? "runtime.workflowDone" : "runtime.workflowFailed", {
          name: data.name || data.run_id || "workflow",
        }),
        "tool",
      );
      break;
    }
    case "goal_created": {
      // 先派发、再画思考流：横幅的刷新不该被思考流的渲染异常挡住，
      // 而且「目标刚被立起来」正是最该立刻看到横幅的那一瞬。
      emitGoalBridge("goal_created", data);
      currentStream().goal("created", data);
      setCognitionState(t("runtime.goalArmed", { objective: data.objective || "" }), "tool");
      break;
    }
    case "goal_updated": {
      // 目标状态是「爱丽丝现在在为哪件长期事努力」，属于全局认知状态，
      // 所以除了思考流的一行，还要更新顶部状态条。
      emitGoalBridge("goal_updated", data);
      currentStream().goal("updated", data);
      if (data.status === "complete" || data.status === "blocked") {
        setCognitionState(t("runtime.goalClosed", { objective: data.objective || "" }), "tool");
      } else if (data.status === "paused" || data.armed === false) {
        setCognitionState(t("runtime.goalDisarmed", { objective: data.objective || "" }), "tool");
      } else {
        setCognitionState(t("runtime.goalArmed", { objective: data.objective || "" }), "tool");
      }
      break;
    }
    case "goal_round": {
      // 自动轮次 +1：横幅上的「本轮 X/Y」就是靠这个事件立刻更新的。
      emitGoalBridge("goal_round", data);
      currentStream().goal("round", data);
      break;
    }
    case "compaction_start": {
      currentStream().compaction("start", data);
      setCognitionState(t("runtime.compacting"), "tool");
      break;
    }
    case "compaction_end": {
      currentStream().compaction("end", data);
      if (data.ok) {
        setCognitionState(t("runtime.compacted", { n: data.covered_total || 0 }), "tool");
      }
      break;
    }
    case "plan_mode_changed": {
      const on = data.on === true;
      currentStream().planMode(on ? "on" : "off", data);
      setCognitionState(t(on ? "runtime.planModeOn" : "runtime.planModeOff"), "tool");
      break;
    }
    case "plan_submitted": {
      currentStream().planMode("submitted", data);
      setCognitionState(t("runtime.planAwaitingReview"), "tool");
      break;
    }
    case "plan_review_rejected": {
      currentStream().planMode("rejected", data);
      setCognitionState(t("runtime.planRevising"), "tool");
      break;
    }
    case "deliverables_presented": {
      currentStream().deliverables(data.files || []);
      setCognitionState(t("runtime.deliverables", { n: (data.files || []).length }), "tool");
      break;
    }
    case "tool_preparing": {
      setVoiceThinking(false);
      // 思考动画已停，但动作尚未真正执行 —— 给一个占位状态避免 UI 死寂
      const stream = currentStream();
      const action = data.name ? stream.toolAction(data.name, data.args) : "";
      if (isCardBrowserAction(data)) prepareBrowserPreview(data);
      else if (String(data.name || "").startsWith("browser_") && data.browser_display_mode === "window") {
        void showNativeBrowserWindow(data);
      }
      if (currentPath !== "l1") {
        revealCognitionStream();
        setCognitionState(action ? t("runtime.preparingAction", { action }) : t("runtime.preparingNext"), "tool");
      }
      stream.setStatus(action ? t("runtime.preparingActionStatus", { action }) : t("runtime.preparingNextStatus"), "busy");
      break;
    }
    case "tool_executing": {
      setVoiceThinking(false);
      // 开始时立即跳一次；未完成前每 3 秒继续小跳。
      beginToolHeartbeat(data.name);
      const stream = currentStream();
      const action = data.name ? stream.toolAction(data.name, data.args) : t("runtime.activityGeneral");
      if (isCardBrowserAction(data)) prepareBrowserPreview(data);
      else if (String(data.name || "").startsWith("browser_") && data.browser_display_mode === "window") {
        void showNativeBrowserWindow(data);
      }
      if (currentPath !== "l1") setCognitionState(t("runtime.workingAction", { action }), "tool");
      stream.setTimedStatus(t("runtime.workingActionStatus", { action }), "busy", {
        staleAfterMs: 45000,
        staleText: t("runtime.longRunningAction", { action }),
      });
      break;
    }
    case "tool_call": {
      finishToolHeartbeat(data.name);
      const stream = currentStream();
      if (currentPath !== "l1") {
        const action = stream.toolAction(data.name, data.args);
        setCognitionState(t(data.ok === false ? "runtime.incompleteAction" : "runtime.completedAction", { action }), "tool");
      }
      addActionLogEntry(data.name, data.args, data.result, data.ok, Date.parse(ts) || Date.now());
      stream.tool(data.name, data.args, data.result, data.ok);
      recordAiActivity(data.name);
      break;
    }
    case "command_run":
      handleCommandRunEvent(data, ts);
      break;
    case "command_output":
      handleCommandOutputEvent(data, ts);
      break;
    case "browser_preview":
      handleBrowserPreviewEvent(data);
    case "response":
      resetToolHeartbeats();
      currentStream().end();
      chat.setAgentRunning(false);
      currentStream().end();
      setVoiceThinking(false);
      if (currentPath === "l2") {
        finishHeartbeatRound("complete");
        setCognitionState(t("runtime.roundComplete"), "done");
      } else if (currentPath === "l3") {
        setCognitionState(t("runtime.l3RoundComplete"), "done");
      }
      // 兜底：本轮结束时（response 必在 message 之后发）若流式合成会话仍开着——极少见，模型只调了工具
      // 没产出可投递正文、message 未到达——标记正文已尽让队列放完即恢复麦克风，避免麦克风一直挂起。
      // 正常情况 message 已 finalize 过，此处幂等无副作用，不会打断仍在播放的尾句。
      if (sttsActive && isStreamingTTSTurn(data)) finalizeStreamingTTS();
      if (chat.hasLiveJarvisMsg()) chat.finalizeLiveJarvisMsg(null);
      liveReplyActive = false; liveRawText = ""; liveTurnSpeak = false;
      break;
    case "processing_preempted":
      resetToolHeartbeats();
      chat.setAgentRunning(false);
      currentStream().end();
      setVoiceThinking(false);
      hideBrowserPreview();
      if (currentPath === "l2") {
        finishHeartbeatRound("interrupted");
        setCognitionState(t("runtime.interrupted"), "idle");
      } else if (currentPath === "l3") {
        setCognitionState(t("runtime.l3Yielded"), "idle");
        setL3State(t("runtime.l3WaitingRetry"), "retry");
      }
      break;
    case "llm_retry": {
      setVoiceThinking(true);
      currentStream().startThinkingSession();
      const nextAttempt = Number(data.nextAttempt || 2);
      const delayText = formatRetryDelay(Number(data.delayMs || 0));
      currentStream().setStatus(t("runtime.llmRetry", { attempt: nextAttempt, delay: delayText }), "busy");
      break;
    }
    case "message_requeued": {
      setVoiceThinking(true);
      currentStream().startThinkingSession();
      const retryCount = Number(data.retryCount || 1);
      currentStream().setStatus(t("runtime.llmRequeued", { count: retryCount }), "busy");
      break;
    }
    case "message_dropped":
      resetToolHeartbeats();
      chat.setAgentRunning(false);
      setVoiceThinking(false);
      hideBrowserPreview();
      currentStream().startThinkingSession();
      currentStream().setStatus(t("runtime.llmRetryExhausted"), "failed");
      if (currentPath === "l2") {
        finishHeartbeatRound("interrupted", "心跳处理未完成 · 重试已用尽");
        setCognitionState(t("runtime.incomplete"), "idle");
      }
      break;
    case "error":
      resetToolHeartbeats();
      if (isBusyErrorMessage(data.error)) {
        setVoiceThinking(true);
        currentStream().startThinkingSession();
        currentStream().setStatus(t("runtime.llmRetryLater"), "busy");
      } else {
        setVoiceThinking(false);
        chat.setAgentRunning(false);
        hideBrowserPreview();
        currentStream().stopThinking();
        currentStream().setStatus(data.error || t("runtime.processingFailed"), "failed");
        if (currentPath === "l2") {
          finishHeartbeatRound("interrupted", "心跳处理遇到异常");
          setCognitionState(t("runtime.exception"), "idle");
        }
      }
      break;
    case "protocol_violation":
      resetToolHeartbeats();
      chat.setAgentRunning(false);
      currentStream().end();
      setVoiceThinking(false);
      hideBrowserPreview();
      if (currentPath === "l2") {
        finishHeartbeatRound("interrupted", "心跳协议校验未通过");
        setCognitionState(t("runtime.incomplete"), "idle");
      }
      break;
    case "injector_result": {
      const nids = [...extractNids(data.matchedMemories), ...extractNids(data.recallMemories)];
      if (nids.length) highlightNodes(nids, 10000);
      break;
    }
    case "focus_frame": {
      renderFocusStack(data.focusStack);
      break;
    }
    case "focus_compressed": {
      // 后端 emit 顺序：先 focus_frame（栈已 pop 完）→ 异步压缩完再 focus_compressed。
      // 触发时栈顶帧的 conclusions 数组在后端已被追加，但前端 DOM 里还是旧的。
      // 新布局：把新 conclusion 写入「主行」(.focus-frame-main)；
      // 若主行原本是 fallback（暂无沉淀结论），就把它升级为正常主行。
      // 若主行已有旧 conclusion，把旧值降级追加到「早期 conclusion」列表里，再覆盖主行。
      // 下一次 focus_frame 事件会带最新 conclusions 全量覆盖，所以即使错位也很快收敛。
      const topFrame = focusStackEl?.querySelector(".focus-frame.top");
      if (topFrame && data.conclusion) {
        const mainEl = topFrame.querySelector(".focus-frame-main");
        const newText = truncateConclusion(data.conclusion, 120);
        if (mainEl) {
          const wasFallback = mainEl.classList.contains("focus-frame-main-fallback");
          if (!wasFallback && mainEl.textContent) {
            const earlier = document.createElement("div");
            earlier.className = "focus-frame-conclusion focus-frame-conclusion-earlier";
            earlier.textContent = mainEl.textContent;
            topFrame.appendChild(earlier);
          }
          mainEl.classList.remove("focus-frame-main-fallback");
          mainEl.innerHTML = "";
          mainEl.textContent = newText;
        }
      }
      flashFocusCompressed();
      break;
    }
    case "memories_written":
      if (Array.isArray(data.memories) && data.memories.length) {
        addNewNodes(data.memories);
      }
      break;
    case "message":
      if (data.from === "consciousness") {
        lastJarvisContent = data.content;
        const viaLabel = friendlyChannelLabel(data.channel);
        const content = viaLabel ? `_→ ${viaLabel}_  \n${data.content}` : data.content;
        const messageId = data.conversation_id || data.conversationId || "";
        // 若本轮正文已流式进了实时气泡：用权威全文定稿同一个气泡，避免新建重复气泡
        if (chat.hasLiveJarvisMsg()) {
          chat.finalizeLiveJarvisMsg(content, { messageId });
        } else {
          addMsg("jarvis", content, { messageId });
        }
        const speechText = toPlainSpeech(data.content);
        const voiceDecision = voiceReplyCoordinator.finalMessage(data, speechText);
        if (data.speak === true) {
          voiceDiag("message-final", {
            turn_id: data.turn_id || "",
            conversation_id: messageId,
            target_client_id: data.target_client_id || "",
            target_matched: voiceDecision.turn?.targetMatched ?? isUiClientTarget(data),
            action: voiceDecision.action,
            reason: voiceDecision.reason,
            streaming_active: sttsActive,
          });
        }
        if (voiceDecision.action === "finalize_stream") {
          if (sttsActive && isStreamingTTSTurn(data)) finalizeStreamingTTS();
          else startVoiceFallback(voiceDecision, "stream-state-missing");
        } else if (voiceDecision.action === "play_full" || voiceDecision.action === "play_remaining") {
          startVoiceFallback(voiceDecision);
        }
        liveReplyActive = false;
        liveRawText = "";
        liveTurnSpeak = false;
        enrichVisiblePersonCardFromText(data.content, { source: 'assistant_message' });
        openChat(true);
      }
      break;
    case "message_in": {
      // 外部渠道判定：channel 非空且非本地，或 from_id 仍带外部前缀（兼容连接器直接 emit 的事件）
      const ch = String(data.channel || "").toUpperCase();
      const isExternal =
        (ch && ch !== "TUI" && ch !== "API" && ch !== "SYSTEM" && ch !== "REMINDER" && ch !== "APP_SIGNAL" && ch !== "VOICE" && ch !== "语音识别" && ch !== "RESOURCE")
        || (data.from_id && /^(wechat|discord|feishu|wecom):/i.test(data.from_id));
      if (isExternal) {
        const label = friendlyChannelLabel(data.channel) || data.from_id || "External";
        addMsg("external", data.content, { label, alert: false, messageId: data.conversation_id || data.conversationId || "" });
        openChat(true);
      } else {
        if (ch === "RESOURCE") {
          const reconciled = chat?.reconcileResourceMessage?.(
            data.client_message_id || data.clientMessageId,
            data.conversation_id || data.conversationId,
            data.resources || [],
            data.resource_state || "pending",
          );
          if (!reconciled) {
            addMsg("user", data.content, {
              label: t("shell.resourceLabel"),
              alert: false,
              pending: false,
              messageId: data.conversation_id || data.conversationId || "",
              channel: "RESOURCE",
              resources: data.resources || [],
              resourceState: data.resource_state || "pending",
            });
          }
          openChat();
          break;
        }
        const reconciled = chat?.reconcileSentMessage?.(
          data.client_message_id || data.clientMessageId,
          data.conversation_id || data.conversationId,
        );
        if (!reconciled) {
          const voiceMessage = ch === "VOICE" || ch === "语音识别";
          addMsg("user", data.content, {
            label: voiceMessage ? "You · 语音对话" : "You",
            alert: false,
            pending: false,
            messageId: data.conversation_id || data.conversationId || "",
          });
          openChat(true);
        }
      }
      break;
    }
    case "resources_consumed":
      chat?.markResourceMessagesConsumed?.(data.conversation_ids || data.conversationIds || []);
      break;
    case "agent_name_updated":
      setAgentName(data.name);
      break;
    case "media_mode":
      window.dispatchEvent(new CustomEvent("alice:media", { detail: data }));
      break;
    case "aivideo_mode":
      window.dispatchEvent(new CustomEvent("alice:aivideo", { detail: data }));
      break;
    case "computer_status_mode":
      setComputerStatusMode(!!data.active || data.action === "show" || data.action === "open", { source: "agent_event" });
      break;
    case "hotspot_mode":
      setHotspotMode(!!data.active || data.action === "show" || data.action === "open", { source: "agent_event" });
      break;
    case "worldcup_mode":
      setWorldcupMode(!!data.active || data.action === "show" || data.action === "open", { source: "agent_event" });
      break;
    case "typhoon_mode":
      setTyphoonMode(!!data.active || data.action === "show" || data.action === "open", { source: "agent_event" });
      break;
    case "doc_panel_mode":
      setDocPanelMode(!!data.active || data.action === "open", { topicId: data.topic || null, source: "agent_event" });
      break;
    case "person_card_mode":
      setPersonCardMode(!!data.active || data.action === "show" || data.action === "open" || data.action === "update", { source: "agent_event", card: data.card || null });
      break;
    case "knowledge_cortex_mode":
      setKnowledgeCortexMode(!!data.active || data.action === "show" || data.action === "open" || data.action === "update", {
        source: "agent_event",
        regionId: data.region_id || data.regionId,
        query: data.query,
        documentId: data.document_id || data.documentId,
      });
      break;
    case "social_status":
      window.dispatchEvent(new CustomEvent("alice:social_status", { detail: data }));
      break;
    case "show_wechat_popup":
      showWechatPopup();
      break;
    case "show_feishu_popup":
      showFeishuPopup();
      break;
    case "audio_created":
      if (data.autoPlay && data.path && isUiClientTarget(data)) {
        const audioUrl = `${API}/${data.path}`;
        const audioEl = new Audio(audioUrl);
        applyOutputSink(audioEl).catch(() => {}); // 与 TTS 同路由，避开虚拟/已拔出设备
        audioEl.play().catch(() => {});
      }
      break;
    case "tts_reply":
      if (data.text && isUiClientTarget(data)) playTTSReply(data.text);
      break;
    case "key_configured":
      chat.deleteLastUserMsg();
      if (data.ttsText && isUiClientTarget(data)) playTTSReply(data.ttsText);
      break;
    default:
      break;
  }
}

// ── TTS reply playback ────────────────────────────────────────────────────────
let ttsAudioEl = null;
let ttsCurrentText = '';
let activeTTSVoiceId = null; // 后端当前配置的 TTS 音色，用于决定播放时是否叠加机器人音效
let ttsInterruptedRemaining = '';
let lastJarvisContent = '';
let ttsInterruptedOriginalContent = '';
let ttsInterruptionApplied = false;
let ttsInterruptionDbTimer = null;
let ttsStreamReader = null; // 当前流式合成的网络读取器；打断/重播时取消，避免旧流继续占用
let ttsAudioGraph = null;   // 当前 TTS <audio> 的 Web Audio 图，用于音效和语音球可视化
let ttsAudioCancel = null;
let appleSharedAudioEl = null;
let appleAudioPrimed = false;
let pendingTTSPlayback = null;
const startedTTSPlaybackKeys = new Set();
let ttsPlaybackEpoch = 0;     // 整段播放轮次；替换/打断后旧异步结果不得回写当前状态

// ── 边出文字边逐句流式合成（streaming sentence TTS）─────────────────────────────
// 正文 token 边到边按句末标点切句入队，一个顺序播放队列逐句 /tts/stream 播放——第一句在
// 后面还在生成时就出声。麦克风的挂起/恢复由队列在首段/末段统一各做一次（不可每段反复，
// 否则 ttsStartTime/bargein 缓冲会被反复重置）。
let ttsStreamingMode = false; // 本轮 TTS 走逐句队列（true）还是单段整段（false）；stopTTS 据此分支
let sttsActive = false;       // 逐句会话进行中
let sttsConsumed = 0;         // liveRawText 已喂入切句器的「干净文本」长度
let sttsBuf = '';             // 尚未凑成整句的残句缓冲
let sttsQueue = [];           // 已切出、待合成播放的句子
let sttsPlaying = false;      // 当前有一段正在 fetch / 播放
let sttsCurSegStarted = false;
let sttsSpoken = '';          // 已完整播放过的句子拼接（打断时算"已说到哪"）
let sttsCurSeg = '';          // 当前正在播放的句子文本
let sttsStreamDone = false;   // 正文已全部到达（message 定稿），队列放完即收尾
let sttsMicSuspended = false; // 已对麦克风做过一次 suspendForTTS
let sttsTurnData = null;      // 当前逐句会话所属的后端 turn / target
let sttsEpoch = 0;            // 每次替换/结束递增；隔离旧播放 Promise 的迟到结果

const STTS_SENTENCE_RE = /[^。！？!?\n]*[。！？!?\n]+/g;
function sttsHasReadable(s) { return /[\p{L}\p{N}]/u.test(s); }

// 本轮流式回复状态：是否正在把正文打进实时气泡 / 累积的原始正文 / 本轮是否语音播报
let liveReplyActive = false;
let liveRawText = '';
let liveTurnSpeak = false;

// 流式语音合成：边下边播，首包到达即出声（后端 /tts/stream 本就分块返回，
// 这里用 MediaSource 消费，省去"等整段下载完再播"的延迟）。默认开启，可在设置关闭。
const TTS_STREAMING_KEY = 'alice.tts.streaming';
const TTS_RESPONSE_TIMEOUT_MS = 20_000;
function isTTSStreamingEnabled() {
  try { return localStorage.getItem(TTS_STREAMING_KEY) !== '0'; } catch { return true; } // 默认开启
}
function setTTSStreamingEnabled(on) {
  try { localStorage.setItem(TTS_STREAMING_KEY, on ? '1' : '0'); } catch {}
}
function isAppleMobileBrowser() {
  const ua = navigator.userAgent || "";
  return /iPad|iPhone|iPod/i.test(ua)
    || (navigator.platform === "MacIntel" && navigator.maxTouchPoints > 1);
}
// 仅当开启 + 浏览器支持 MSE 流式 MP3 时才走流式，否则退回整段 blob 播放（绝不让声音变哑）
function ttsCanStream() {
  if (!isTTSStreamingEnabled()) return false;
  // iPadOS may advertise audio/mpeg MSE support while sourceopen/addSourceBuffer
  // or background resume remains unreliable. Sentence streaming still works,
  // but each sentence is downloaded as a Blob before using the primed audio element.
  if (isAppleMobileBrowser()) return false;
  if (typeof window.MediaSource === 'undefined') return false;
  try { return MediaSource.isTypeSupported('audio/mpeg'); } catch { return false; }
}

function isStreamingTTSTurn(data = {}) {
  if (!sttsTurnData) return false;
  const activeTurn = String(sttsTurnData.turn_id || sttsTurnData.turnId || "");
  const eventTurn = String(data.turn_id || data.turnId || "");
  if (activeTurn && eventTurn) return activeTurn === eventTurn;
  return isUiClientTarget(data);
}

// Estimate spoken char count from audio progress, snapping to a sentence boundary
function calcRemainingText(text, currentTime, duration) {
  if (!text || !duration || duration <= 0) return { remaining: '', spokenUpTo: 0 };
  const progress = Math.min(1, currentTime / duration);
  const spokenChars = Math.floor(text.length * progress);
  const BOUNDARIES = /[。！？，.!?,\n]/g;
  let bestPos = spokenChars;
  let match;
  BOUNDARIES.lastIndex = Math.max(0, spokenChars - 10);
  while ((match = BOUNDARIES.exec(text)) !== null) {
    if (match.index >= spokenChars) {
      bestPos = match.index + 1;
      break;
    }
  }
  return { remaining: text.slice(bestPos).trim(), spokenUpTo: bestPos };
}

// Estimate cut position in original markdown based on spoken ratio in TTS plain text
function findMarkdownCutPos(markdown, ttsFullLen, ttsSpokenUpTo) {
  if (!markdown || ttsFullLen <= 0) return 0;
  const ratio = ttsSpokenUpTo / ttsFullLen;
  const approxPos = Math.floor(markdown.length * ratio);
  const BOUNDARIES = /[。！？\n.!?]/g;
  let bestPos = approxPos;
  BOUNDARIES.lastIndex = Math.max(0, approxPos - 15);
  let match;
  while ((match = BOUNDARIES.exec(markdown)) !== null) {
    if (match.index >= approxPos) { bestPos = match.index + 1; break; }
  }
  return bestPos;
}

// Apply interruption marker to chat UI; delay DB write so false triggers can be undone
function applyTTSInterruption(spokenUpTo) {
  const originalContent = lastJarvisContent || ttsCurrentText;
  if (!originalContent) return;
  ttsInterruptedOriginalContent = originalContent;
  ttsInterruptionApplied = true;

  const cutPos = findMarkdownCutPos(originalContent, ttsCurrentText.length, spokenUpTo);
  const spokenMarkdown = originalContent.slice(0, cutPos).trimEnd();
  const displayText = spokenMarkdown ? spokenMarkdown + ' ✋' : '✋';
  const dbContent = spokenMarkdown || '✋';

  updateLastJarvisMsg(displayText);

  if (ttsInterruptionDbTimer) clearTimeout(ttsInterruptionDbTimer);
  ttsInterruptionDbTimer = setTimeout(() => {
    ttsInterruptionDbTimer = null;
    fetch(`${API}/tts/interrupted`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ spokenContent: dbContent }),
    }).catch(() => {});
  }, 4000);
}

// Called by voice-panel interruption detection: stop current TTS and record cut point
window.stopTTS = () => {
  if (ttsStreamingMode && sttsActive) { stopStreamingTTS(); return; }
  // 即使音频元素尚未创建，请求也可能正在等待 TTS 响应；先废止该轮，防止稍后突然开播。
  ttsPlaybackEpoch += 1;
  if (!ttsAudioEl) { ttsCurrentText = ""; return; }
  const { remaining, spokenUpTo } = calcRemainingText(
    ttsCurrentText,
    ttsAudioEl.currentTime,
    ttsAudioEl.duration,
  );
  // When duration is not yet loaded (NaN): spokenUpTo=0, remaining='', falls back to full text
  ttsInterruptedRemaining = remaining || ttsCurrentText;
  applyTTSInterruption(spokenUpTo);
  releaseCurrentTTSAudio("interrupted");
};

// Called by voice-panel on impact noise: duck TTS volume without stopping
window.duckTTS = () => {
  if (ttsAudioEl) ttsAudioEl.volume = 0.15;
};

// Called by voice-panel after confirming noise: restore original volume
window.unduckTTS = () => {
  if (ttsAudioEl) ttsAudioEl.volume = 1.0;
};

// Called by voice-panel on false-positive noise: resume TTS from interruption point and restore chat
window.resumeTTSIfNoSpeech = () => {
  const text = ttsInterruptedRemaining;
  ttsInterruptedRemaining = '';
  if (!text) return;
  // Cancel the pending DB write and restore chat UI
  if (ttsInterruptionDbTimer) { clearTimeout(ttsInterruptionDbTimer); ttsInterruptionDbTimer = null; }
  if (ttsInterruptionApplied && ttsInterruptedOriginalContent) {
    updateLastJarvisMsg(ttsInterruptedOriginalContent);
  }
  ttsInterruptionApplied = false;
  ttsInterruptedOriginalContent = '';
  playTTSReply(text);
};

function activateTTSAudioGraph(graph) {
  if (ttsAudioGraph && ttsAudioGraph !== graph) {
    try { ttsAudioGraph.teardown?.(); } catch {}
  }
  ttsAudioGraph = graph || null;
  window.aliceVoice?.setTTSAnalyser?.(ttsAudioGraph?.analyser || null);
}

function clearTTSAudioGraph(graph) {
  if (arguments.length > 0) {
    if (!graph) return;
    if (graph !== ttsAudioGraph) {
      try { graph.teardown?.(); } catch {}
      return;
    }
  }
  if (ttsAudioGraph) {
    try { ttsAudioGraph.teardown?.(); } catch {}
    ttsAudioGraph = null;
  }
  window.aliceVoice?.setTTSAnalyser?.(null);
}

// 先抓住元素引用再触发 cancel：cancel 会同步把全局 ttsAudioEl 置空。
// 若之后再通过全局变量 pause，旧音频会继续在后台播放，且打断路径还可能抛空引用异常。
function releaseCurrentTTSAudio(kind = "cancelled") {
  const audioEl = ttsAudioEl;
  const audioSrc = audioEl?.src || "";
  try { audioEl?.pause(); } catch {}
  ttsAudioCancel?.(kind);
  clearTTSAudioGraph();
  if (audioEl) {
    try { audioEl.removeAttribute("src"); audioEl.load(); } catch {}
    if (audioSrc.startsWith("blob:")) { try { URL.revokeObjectURL(audioSrc); } catch {} }
  }
  if (ttsStreamReader) { try { ttsStreamReader.cancel(); } catch {} ttsStreamReader = null; }
  if (ttsAudioEl === audioEl) ttsAudioEl = null;
}

const SILENT_WAV_DATA_URL = "data:audio/wav;base64,UklGRiQAAABXQVZFZm10IBAAAAABAAEAQB8AAEAfAAABAAgAZGF0YQAAAAA=";

function createTTSAudio(url) {
  if (!isAppleMobileBrowser()) return new Audio(url);
  if (!appleSharedAudioEl) {
    appleSharedAudioEl = new Audio();
    appleSharedAudioEl.playsInline = true;
    appleSharedAudioEl.preload = "auto";
  }
  ttsAudioCancel?.("replaced");
  appleSharedAudioEl.pause();
  appleSharedAudioEl.removeAttribute("src");
  appleSharedAudioEl.load();
  appleSharedAudioEl.src = url;
  return appleSharedAudioEl;
}

function primeAppleTTSPlayback() {
  if (!isAppleMobileBrowser() || appleAudioPrimed) return;
  const audioEl = createTTSAudio(SILENT_WAV_DATA_URL);
  audioEl.volume = 1;
  const result = audioEl.play();
  Promise.resolve(result).then(() => {
    appleAudioPrimed = true;
    audioEl.pause();
    audioEl.currentTime = 0;
    voiceDiag("audio-primed", { platform: "apple-mobile" });
  }).catch(error => {
    voiceDiag("audio-prime-rejected", {
      error_name: error?.name || "",
      error: error?.message || String(error),
    });
  });
  resumeJarvisAudioContext().then(state => voiceDiag("audio-context-unlock", state));
}

for (const eventName of ["pointerdown", "touchstart", "keydown"]) {
  window.addEventListener(eventName, primeAppleTTSPlayback, { capture: true, passive: true });
}

// 接管一个 <audio> 元素并明确返回播放结果；Safari 的 play() 拒绝、解码错误不再静默吞掉。
async function startTTSAudio(audioEl, revokeUrl, opts = {}) {
  const { manageMic = true, onStart = null } = opts;
  const superseded = () => {
    try { audioEl.pause(); audioEl.removeAttribute("src"); audioEl.load(); } catch {}
    if (revokeUrl) { try { URL.revokeObjectURL(revokeUrl); } catch {} }
    if (ttsAudioEl === audioEl) ttsAudioEl = null;
    return { ok: false, kind: "superseded", started: false, error: new Error("superseded") };
  };
  if (opts.isCurrent?.() === false) return superseded();
  ttsAudioEl = audioEl;
  audioEl.volume = 1.0; // ensure full volume (avoid residual duck state from previous play)
  const audioContextState = await resumeJarvisAudioContext();
  if (opts.isCurrent?.() === false) return superseded();
  const audioGraph = isAppleMobileBrowser() ? null : attachJarvisAudioGraph(audioEl, activeTTSVoiceId);
  activateTTSAudioGraph(audioGraph);
  const sink = await applyOutputSink(audioEl).catch(error => ({ sinkApplyError: String(error?.message || error) }));
  if (opts.isCurrent?.() === false) {
    clearTTSAudioGraph(audioGraph);
    return superseded();
  }
  // 所有异步准备均完成且轮次仍有效后才挂起 ASR，避免被替换的旧播放留下悬挂状态。
  if (manageMic) window.aliceVoice?.suspendForTTS?.();

  return new Promise(resolve => {
    let settled = false;
    let started = false;
    let startTimer = null;
    let playbackWatchdog = null;
    const finish = (ok, kind, error = null) => {
      if (settled) return;
      settled = true;
      if (startTimer) clearTimeout(startTimer);
      playbackWatchdog?.stop();
      if (ttsAudioCancel === cancel) ttsAudioCancel = null;
      audioEl.onplaying = null;
      audioEl.onended = null;
      audioEl.onerror = null;
      // 无论成功、失败还是替换都主动释放解码器/输出设备；仅 revoke blob URL
      // 并不保证 Chromium 会立即停止已经缓冲的 MediaSource 音频。
      try { audioEl.pause(); audioEl.removeAttribute("src"); audioEl.load(); } catch {}
      clearTTSAudioGraph(audioGraph);
      if (revokeUrl) { try { URL.revokeObjectURL(revokeUrl); } catch {} }
      if (ttsAudioEl === audioEl) {
        if (ttsStreamReader) { try { ttsStreamReader.cancel(); } catch {} ttsStreamReader = null; }
        ttsAudioEl = null;
        if (manageMic) {
          ttsCurrentText = "";
          window.aliceVoice?.resumeAfterMedia();
        }
      }
      resolve({
        ok,
        kind,
        started,
        error,
        audioContextState,
        sink,
      });
    };
    const cancel = (kind = "cancelled") => finish(false, kind, new Error(kind));
    ttsAudioCancel = cancel;
    playbackWatchdog = createPlaybackProgressWatchdog({
      audioEl,
      onTerminal: ({ ok, kind, error }) => {
        if (!ok) { try { audioEl.pause(); } catch {} }
        finish(ok, kind, error);
      },
    });
    startTimer = setTimeout(() => {
      if (!started) finish(false, "playback-start-timeout", new Error("audio did not start within 10 seconds"));
    }, 10_000);
    audioEl.onplaying = () => {
      started = true;
      if (startTimer) { clearTimeout(startTimer); startTimer = null; }
      playbackWatchdog.start();
      onStart?.();
    };
    audioEl.onended = () => finish(true, "ended");
    audioEl.onerror = () => {
      const mediaError = audioEl.error;
      finish(false, "media-error", mediaError
        ? new Error(`MediaError ${mediaError.code}: ${mediaError.message || "audio decode/playback failed"}`)
        : new Error("audio element error"));
    };
    try {
      Promise.resolve(audioEl.play()).catch(error => finish(false, "play-rejected", error));
    } catch (error) {
      finish(false, "play-threw", error);
    }
  });
}

// 流式播放：把 /tts/stream 的分块响应喂进 MediaSource，首包到达即出声。
async function playTTSViaMediaSource(resp, opts = {}) {
  if (opts.isCurrent?.() === false) {
    try { await resp.body?.cancel(); } catch {}
    return { ok: false, kind: "superseded", started: false, error: new Error("superseded") };
  }
  const mediaSource = new MediaSource();
  const url = URL.createObjectURL(mediaSource);
  const audioEl = createTTSAudio(url);
  const isCurrentAudio = () => ttsAudioEl === audioEl;
  const failCurrentAudio = (kind, error = null) => {
    if (isCurrentAudio()) ttsAudioCancel?.(kind);
    voiceDiag(kind, { error: error?.message || (error ? String(error) : "") });
    try { audioEl.removeAttribute("src"); audioEl.load(); } catch {}
  };
  let sourceOpened = false;
  const sourceOpenTimer = setTimeout(() => {
    if (!sourceOpened && isCurrentAudio()) {
      failCurrentAudio("mse-sourceopen-timeout");
    }
  }, 4000);
  mediaSource.addEventListener('sourceopen', () => {
    sourceOpened = true;
    clearTimeout(sourceOpenTimer);
    if (!isCurrentAudio()) { try { mediaSource.endOfStream(); } catch {} return; }
    let sb;
    try { sb = mediaSource.addSourceBuffer('audio/mpeg'); }
    catch (error) {
      failCurrentAudio("mse-source-buffer-failed", error);
      return;
    }
    const reader = resp.body.getReader();
    if (!isCurrentAudio()) { try { reader.cancel(); } catch {} return; }
    ttsStreamReader = reader;
    const queue = [];
    let finished = false;
    let receivedBytes = 0;
    // appendBuffer 是异步的，更新中不能再次 append；用队列在 updateend 时串行送入
    const flush = () => {
      if (sb.updating) return;
      if (queue.length) {
        try { sb.appendBuffer(queue.shift()); }
        catch (error) {
          failCurrentAudio("mse-append-failed", error);
        }
        return;
      }
      if (finished && mediaSource.readyState === 'open') { try { mediaSource.endOfStream(); } catch {} }
    };
    sb.addEventListener('updateend', flush);
    sb.addEventListener('error', () => failCurrentAudio("mse-source-buffer-error"), { once: true });
    (async () => {
      try {
        for (;;) {
          const { done, value } = await reader.read();
          if (!isCurrentAudio()) {
            if (ttsStreamReader === reader) ttsStreamReader = null;
            try { reader.cancel(); } catch {}
            break;
          }
          if (done) {
            if (ttsStreamReader === reader) ttsStreamReader = null;
            if (!receivedBytes) {
              failCurrentAudio("mse-empty-stream");
              break;
            }
            finished = true; flush(); break;
          }
          if (value && value.byteLength) {
            receivedBytes += value.byteLength;
            queue.push(value);
            flush();
          }
        }
      } catch (error) {
        if (ttsStreamReader === reader) ttsStreamReader = null;
        voiceDiag("mse-read-failed", { error: error?.message || String(error) });
        finished = true; flush();
      } // 被取消/网络中断：收尾，已播部分照常结束
    })();
  }, { once: true });
  const result = await startTTSAudio(audioEl, url, opts);
  clearTimeout(sourceOpenTimer);
  return result;
}

async function requestTTS(text) {
  voiceDiag("tts-request", { text_length: text.length });
  const controller = new AbortController();
  const responseTimer = setTimeout(() => {
    controller.abort(new Error(`TTS response headers timed out after ${TTS_RESPONSE_TIMEOUT_MS}ms`));
  }, TTS_RESPONSE_TIMEOUT_MS);
  let resp;
  try {
    resp = await fetch(`${API}/tts/stream`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ text }),
      signal: controller.signal,
    });
  } finally {
    clearTimeout(responseTimer);
  }
  if (!resp.ok) {
    let errMsg = `HTTP ${resp.status}`;
    try { const j = await resp.json(); errMsg = j.error || errMsg; } catch {}
    throw new Error(errMsg);
  }
  voiceDiag("tts-response", {
    ok: true,
    content_type: resp.headers.get("content-type") || "",
  });
  return resp;
}

async function playTTSAsBlob(text, opts = {}) {
  if (opts.isCurrent?.() === false) {
    return { ok: false, kind: "superseded", started: false, error: new Error("superseded") };
  }
  const resp = await requestTTS(text);
  if (opts.isCurrent?.() === false) {
    try { await resp.body?.cancel(); } catch {}
    return { ok: false, kind: "superseded", started: false, error: new Error("superseded") };
  }
  const blob = await resp.blob();
  if (!blob.size) throw new Error("TTS returned an empty audio Blob");
  if (opts.isCurrent?.() === false) {
    return { ok: false, kind: "superseded", started: false, error: new Error("superseded") };
  }
  const url = URL.createObjectURL(blob);
  return startTTSAudio(createTTSAudio(url), url, opts);
}

async function synthesizeAndPlay(text, opts = {}) {
  if (opts.isCurrent?.() === false) {
    return { ok: false, kind: "superseded", started: false, error: new Error("superseded") };
  }
  if (ttsCanStream()) {
    try {
      const resp = await requestTTS(text);
      if (opts.isCurrent?.() === false) {
        try { await resp.body?.cancel(); } catch {}
        return { ok: false, kind: "superseded", started: false, error: new Error("superseded") };
      }
      const streamed = await playTTSViaMediaSource(resp, opts);
      if (opts.isCurrent?.() === false) {
        return { ok: false, kind: "superseded", started: streamed.started, error: new Error("superseded") };
      }
      if (streamed.ok || streamed.started) return { ...streamed, mode: "media-source" };
      voiceDiag("tts-stream-fallback", {
        reason: streamed.kind,
        error_name: streamed.error?.name || "",
        error: streamed.error?.message || "",
      });
    } catch (error) {
      if (opts.isCurrent?.() === false) {
        return { ok: false, kind: "superseded", started: false, error: new Error("superseded") };
      }
      voiceDiag("tts-stream-fallback", {
        reason: "stream-exception",
        error_name: error?.name || "",
        error: error?.message || String(error),
      });
    }
  }
  const blobResult = await playTTSAsBlob(text, opts);
  return { ...blobResult, mode: "blob" };
}

async function playTTSReply(text, { playbackKey = "", reason = "whole-reply" } = {}) {
  const normalized = String(text || "").trim();
  if (!normalized || !sttsHasReadable(normalized)) return false;
  if (playbackKey && startedTTSPlaybackKeys.has(playbackKey)) {
    voiceDiag("tts-duplicate-suppressed", { playback_key: playbackKey, reason });
    return false;
  }
  if (playbackKey) startedTTSPlaybackKeys.add(playbackKey);
  const playbackEpoch = ++ttsPlaybackEpoch;
  ttsStreamingMode = false; // 单段整段播放：stopTTS 走原有进度估算分支
  try {
    // 取消上一段仍在进行的音频和网络流，避免旧播放继续占用输出设备。
    if (ttsAudioEl || ttsStreamReader || ttsAudioGraph) {
      releaseCurrentTTSAudio("replaced");
    }
    // 必须在旧播放 cancel 完之后再写新状态；旧 finish 会清空 ttsCurrentText。
    ttsCurrentText = normalized;
    ttsInterruptedRemaining = '';
    ttsInterruptionApplied = false;
    ttsInterruptedOriginalContent = '';
    const result = await synthesizeAndPlay(normalized, {
      manageMic: true,
      isCurrent: () => playbackEpoch === ttsPlaybackEpoch,
      onStart: () => voiceDiag("audio-playing", {
        playback_key: playbackKey,
        mode: "whole-reply",
      }),
    });
    if (playbackEpoch !== ttsPlaybackEpoch) {
      if (playbackKey) startedTTSPlaybackKeys.delete(playbackKey);
      return false;
    }
    voiceDiag(result.ok ? "tts-complete" : "tts-playback-failed", {
      playback_key: playbackKey,
      playback_mode: result.mode,
      started: result.started,
      kind: result.kind,
      error_name: result.error?.name || "",
      error: result.error?.message || "",
      audio_context_state: result.audioContextState?.state || "",
    });
    if (!result.ok) {
      if (playbackKey) startedTTSPlaybackKeys.delete(playbackKey);
      pendingTTSPlayback = {
        text: normalized,
        playbackKey,
        reason: `${reason}:${result.kind}`,
      };
      return false;
    }
    pendingTTSPlayback = null;
    return true;
  } catch (error) {
    if (playbackEpoch !== ttsPlaybackEpoch) {
      if (playbackKey) startedTTSPlaybackKeys.delete(playbackKey);
      return false;
    }
    if (playbackKey) startedTTSPlaybackKeys.delete(playbackKey);
    clearTTSAudioGraph();
    ttsCurrentText = '';
    window.aliceVoice?.resumeAfterMedia();
    pendingTTSPlayback = { text: normalized, playbackKey, reason: `${reason}:exception` };
    voiceDiag("tts-playback-failed", {
      playback_key: playbackKey,
      error_name: error?.name || "",
      error: error?.message || String(error),
    });
    return false;
  }
}

// ── 流式回复文本工具 ───────────────────────────────────────────────────────────
// 协议标记（[RECALL:…]/[SET_TASK:…]/[CLEAR_TASK]/[UPDATE_PERSONA:…]）剥离。与后端 markers.js 等价；
// 流式场景额外把"末尾尚未闭合的标记起始"整段藏起，避免半截标记被显示或念出来（等 ] 到了再放出）。
const MARKER_STRIP_RE = /\[(?:RECALL:[\s\S]*?|SET_TASK:[\s\S]*?|CLEAR_TASK|UPDATE_PERSONA:[\s\S]*?)\]/g;
function cleanStreamText(raw) {
  let s = String(raw || '').replace(MARKER_STRIP_RE, '');
  const lastOpen = s.lastIndexOf('[');
  if (lastOpen >= 0 && s.indexOf(']', lastOpen) === -1) {
    // 仅当 '[' 后看起来是协议标记关键字（全大写/下划线，可带 ":..."）才藏；不误伤 [链接](url) 等普通括号
    if (/^\[[A-Z_]*(:[\s\S]*)?$/.test(s.slice(lastOpen))) s = s.slice(0, lastOpen);
  }
  return s;
}

// markdown → 朗读用纯文本（与后端 autoSpeakForVoiceReply 的剥离一致）
function toPlainSpeech(md) {
  return String(md || '').trim()
    .replace(/\*\*(.+?)\*\*/g, '$1')
    .replace(/\*(.+?)\*/g, '$1')
    .replace(/`(.+?)`/g, '$1')
    .replace(/#{1,6}\s+/g, '')
    .replace(/\[([^\]]+)\]\([^\)]+\)/g, '$1')
    .replace(/!\[[^\]]*\]\([^\)]+\)/g, '')
    .replace(/\n+/g, ' ')
    .trim();
}

function playTTSReplyIfReadable(text) {
  const plain = toPlainSpeech(text);
  if (plain && sttsHasReadable(plain)) playTTSReply(plain);
}

function startVoiceFallback(decision, overrideReason = "") {
  if (!decision?.turn || !decision.text) return;
  if (!voiceReplyCoordinator.markFallbackStarted(decision.turn)) {
    voiceDiag("tts-fallback-suppressed", {
      turn_id: decision.turn.id,
      reason: "already-started",
    });
    return;
  }
  voiceDiag("tts-fallback", {
    turn_id: decision.turn.id,
    target_client_id: decision.turn.targetClientId,
    playback_key: decision.playbackKey,
    fallback_kind: decision.action,
    reason: overrideReason || decision.reason,
    text_length: decision.text.length,
  });
  playTTSReply(decision.text, {
    playbackKey: decision.playbackKey,
    reason: overrideReason || decision.reason,
  });
}

function retryPendingTTSPlayback(trigger) {
  if (!pendingTTSPlayback || document.hidden) return;
  const pending = pendingTTSPlayback;
  pendingTTSPlayback = null;
  voiceDiag("tts-pending-retry", {
    trigger,
    playback_key: pending.playbackKey,
    reason: pending.reason,
  });
  playTTSReply(pending.text, {
    playbackKey: pending.playbackKey,
    reason: `resume:${trigger}`,
  });
}

function streamingSpokenPrefix() {
  return sttsSpoken + (sttsCurSegStarted ? sttsCurSeg : "");
}

function failStreamingTTS(reason, error = null, expectedEpoch = sttsEpoch) {
  if (!isCurrentStreamingTtsSession(expectedEpoch, sttsEpoch)) return;
  if (!sttsTurnData) return;
  const failedTurn = sttsTurnData;
  const spokenPrefix = streamingSpokenPrefix();
  const decision = voiceReplyCoordinator.streamFailed(failedTurn, { spokenPrefix, reason });
  voiceDiag("sentence-stream-failed", {
    turn_id: failedTurn.turn_id || "",
    target_client_id: failedTurn.target_client_id || "",
    reason,
    error_name: error?.name || "",
    error: error?.message || (error ? String(error) : ""),
    spoken_prefix_length: spokenPrefix.length,
    fallback_action: decision.action,
  });
  endStreamingTTS();
  if (decision.action === "play_full" || decision.action === "play_remaining") {
    startVoiceFallback(decision);
  }
}

// ── 逐句流式 TTS 队列 ──────────────────────────────────────────────────────────
function beginStreamingTTS(turnData = {}) {
  // 替换上一轮时，旧队列可能已经挂起了麦克风。所有权必须交给新轮，不能清零；
  // 否则新轮若只有 emoji/标点、没有可播放分段，就无人负责恢复麦克风和 speaking 状态。
  const nextSession = nextStreamingTtsSession(sttsEpoch, sttsMicSuspended);
  sttsEpoch = nextSession.epoch;
  ttsPlaybackEpoch += 1; // 同时废止仍在等待响应/Blob fallback 的旧整段播放
  // 停掉上一段仍在进行的单段播放 / 流读取
  releaseCurrentTTSAudio("replaced");
  ttsStreamingMode = true;
  sttsActive = true;
  sttsConsumed = 0; sttsBuf = ''; sttsQueue = []; sttsPlaying = false;
  sttsSpoken = ''; sttsCurSeg = ''; sttsStreamDone = false;
  sttsMicSuspended = nextSession.micSuspended;
  sttsCurSegStarted = false;
  sttsTurnData = { ...turnData };
  ttsCurrentText = '';
  voiceDiag("sentence-stream-begin", {
    turn_id: turnData.turn_id || "",
    target_client_id: turnData.target_client_id || "",
    transport: ttsCanStream() ? "media-source" : "blob",
    epoch: sttsEpoch,
    inherited_mic_suspension: sttsMicSuspended,
  });
}

// 喂入到目前为止的全部原始正文，内部只取新增的干净尾巴做切句
function feedStreamingTTS(rawFull) {
  if (!sttsActive) return;
  const cleaned = cleanStreamText(rawFull);
  if (cleaned.length <= sttsConsumed) return;
  sttsBuf += cleaned.slice(sttsConsumed);
  sttsConsumed = cleaned.length;
  extractSttsSentences({});
}

function extractSttsSentences({ flushPartial = false, markDone = false } = {}) {
  let lastIdx = 0, m;
  STTS_SENTENCE_RE.lastIndex = 0;
  while ((m = STTS_SENTENCE_RE.exec(sttsBuf)) !== null) {
    const s = toPlainSpeech(m[0]);
    lastIdx = STTS_SENTENCE_RE.lastIndex;
    if (s && sttsHasReadable(s)) sttsQueue.push(s);
  }
  sttsBuf = sttsBuf.slice(lastIdx);
  if (flushPartial) {
    const tail = toPlainSpeech(sttsBuf);
    sttsBuf = '';
    if (tail && sttsHasReadable(tail)) sttsQueue.push(tail);
  }
  if (markDone) sttsStreamDone = true;
  pumpSttsQueue();
}

async function pumpSttsQueue(expectedEpoch = sttsEpoch) {
  if (!sttsActive || sttsPlaying || !isCurrentStreamingTtsSession(expectedEpoch, sttsEpoch)) return;
  const seg = sttsQueue.shift();
  if (!seg) {
    if (sttsStreamDone) endStreamingTTS(); // 正文已尽且队列放完 → 收尾
    return;
  }
  sttsPlaying = true;
  sttsCurSeg = seg;
  sttsCurSegStarted = false;
  // 麦克风只在首段挂起一次（后续段之间保持挂起，避免反复重置 bargein 缓冲/预热计时）
  if (!sttsMicSuspended) { sttsMicSuspended = true; window.aliceVoice?.suspendForTTS?.(); }
  try {
    const result = await synthesizeAndPlay(seg, {
      manageMic: false,
      isCurrent: () => sttsActive && isCurrentStreamingTtsSession(expectedEpoch, sttsEpoch),
      onStart: () => {
        if (!isCurrentStreamingTtsSession(expectedEpoch, sttsEpoch)) return;
        sttsCurSegStarted = true;
        voiceReplyCoordinator.audioStarted(sttsTurnData || {});
        voiceDiag("sentence-audio-playing", {
          turn_id: sttsTurnData?.turn_id || "",
          text_length: seg.length,
        });
      },
    });
    if (!sttsActive || !isCurrentStreamingTtsSession(expectedEpoch, sttsEpoch)) return; // 期间被替换/打断/收尾
    if (!result.ok) {
      failStreamingTTS(result.kind || "audio-playback-failed", result.error, expectedEpoch);
      return;
    }
    sttsSpoken += seg;
    sttsCurSeg = '';
    sttsCurSegStarted = false;
    sttsPlaying = false;
    pumpSttsQueue(expectedEpoch);
  } catch (error) {
    if (!sttsActive || !isCurrentStreamingTtsSession(expectedEpoch, sttsEpoch)) return;
    failStreamingTTS("tts-request-failed", error, expectedEpoch);
  }
}

// 正文段落结束（stream_end text）：把残句也凑成一段送出，但不结束会话（可能还有后续正文段）
function flushStreamingTTSBuf() {
  if (sttsActive) extractSttsSentences({ flushPartial: true });
}

// message 定稿：flush 残句并标记正文已尽，队列放完即收尾
function finalizeStreamingTTS() {
  if (sttsActive) extractSttsSentences({ flushPartial: true, markDone: true });
}

function endStreamingTTS() {
  sttsEpoch += 1; // 让仍在 await 的旧 pump 结果失效
  sttsActive = false;
  ttsStreamingMode = false;
  clearTTSAudioGraph();
  if (sttsMicSuspended) { sttsMicSuspended = false; window.aliceVoice?.resumeAfterMedia(); }
  sttsQueue = []; sttsBuf = ''; sttsCurSeg = ''; sttsSpoken = ''; sttsPlaying = false;
  sttsCurSegStarted = false;
  sttsTurnData = null;
}

// 打断（barge-in）：停当前句、清队列，算出"已说到哪"标 ✋，并把剩余文本留给 resumeTTSIfNoSpeech 续播。
// 麦克风的恢复由 voice-panel 在调用 stopTTS 后自己 resumeVoiceInputFromMedia(true) 负责（与单段路径一致），
// 这里只置 sttsMicSuspended=false 防止重复恢复。
function stopStreamingTTS() {
  let curSpoken = '', curRemain = '';
  if (ttsAudioEl && sttsCurSeg) {
    const r = calcRemainingText(sttsCurSeg, ttsAudioEl.currentTime, ttsAudioEl.duration);
    curSpoken = sttsCurSeg.slice(0, r.spokenUpTo);
    curRemain = r.remaining || sttsCurSeg; // duration 未加载(NaN) → 整句视为未说
  }
  const spokenPlain = sttsSpoken + curSpoken;
  const remainingPlain = [curRemain, sttsQueue.join(''), sttsBuf].filter(Boolean).join('').trim();
  const fullPlain = (spokenPlain + remainingPlain) || (lastJarvisContent || '');
  ttsCurrentText = fullPlain;                       // 让 ✋/续播的文本计算有一致的全文基准
  ttsInterruptedRemaining = remainingPlain || fullPlain;
  applyTTSInterruption(spokenPlain.length);
  releaseCurrentTTSAudio("interrupted");
  sttsEpoch += 1; // 让仍在 await 的旧 pump 结果失效
  sttsActive = false; ttsStreamingMode = false;
  sttsQueue = []; sttsBuf = ''; sttsCurSeg = ''; sttsSpoken = ''; sttsPlaying = false;
  sttsCurSegStarted = false; sttsTurnData = null;
  sttsMicSuspended = false; // 麦克风恢复交给 voice-panel 的 resumeVoiceInputFromMedia(true)
}

resetViewBtn.addEventListener("click", () => resetGraphLayout({ reseed: true, restartAlpha: 1 }));

document.querySelectorAll(".panel, .console, .theme-switcher, .reset-view").forEach(el => {
  el.addEventListener("wheel", event => event.stopPropagation(), { passive: true });
});

physicsControl.addEventListener("wheel", event => event.stopPropagation(), { passive: true });

let graphResetTimer = null;
function scheduleGraphLayoutReset(delay = 140) {
  clearTimeout(graphResetTimer);
  graphResetTimer = setTimeout(() => {
    graphResetTimer = null;
    resetGraphLayout({ reseed: true, restartAlpha: 1 });
  }, delay);
}

function handleGraphViewportChange() {
  // 先同步 SVG 外框，连续 resize 停止后再重排节点，避免拖动窗口时反复打散。
  W = window.innerWidth;
  H = window.innerHeight;
  svg.attr("width", W).attr("height", H);
  scheduleGraphLayoutReset();
}

window.addEventListener("resize", handleGraphViewportChange);
window.addEventListener("orientationchange", () => scheduleGraphLayoutReset(260));
window.visualViewport?.addEventListener("resize", handleGraphViewportChange);
window.addEventListener("alice:panel-layout-change", () => scheduleGraphLayoutReset(440));

let _lastVisualRefresh = 0;
d3.timer(() => {
  if (!MEMORY_GRAPH_ENABLED) return true;
  if (glowSet.size === 0 && usePulseSet.size === 0) return;
  const now = Date.now();
  if (now - _lastVisualRefresh < 48) return;
  _lastVisualRefresh = now;
  refreshNodeVisuals();
});

setAgentName(DEFAULT_AGENT_NAME);
initUiZoom();
readPhysicsSettings();
updatePhysicsReadout();
refreshThemeColors();
chat = initChat({
  apiBase: API,
  historyPageSize: CHAT_HISTORY_PAGE_SIZE,
  activationWarmupKey: ACTIVATION_WARMUP_KEY,
  getAgentName: () => agentName,
  defaultInputPlaceholder,
  isSpacePttEnabled: () => localStorage.getItem(VOICE_SPACE_PTT_KEY) !== "false",
  openSettings: (tab) => openSettingsRef?.(tab),
  openSchedules: () => setSchedulesOpen(true),
  openWorktrees: () => setWorktreesOpen(true),
  openCompaction: () => setCompactionOpen(true),
  openWorkflow: () => setWorkflowOpen(true),
  onUserMessage: (text) => {
    if (document.body.classList.contains('hotspot-mode') && /关闭|退出|关掉|隐藏/.test(text)) {
      toggleHotspot();
      return;
    }
    if (document.body.classList.contains('worldcup-mode') && /关闭|退出|关掉|隐藏/.test(text)) {
      toggleWorldcup();
      return;
    }
    if (document.body.classList.contains('typhoon-mode') && /关闭|退出|关掉|隐藏/.test(text)) {
      toggleTyphoon();
      return;
    }
    if (document.body.classList.contains('computer-mode') && /关闭|退出|关掉|隐藏/.test(text)) {
      toggleComputerStatus();
      return;
    }
    if (/热点|热搜/.test(text) && !document.body.classList.contains('hotspot-mode')) {
      toggleHotspot();
    }
    if (/世界杯/.test(text) && !document.body.classList.contains('worldcup-mode')) {
      toggleWorldcup();
    }
    if (/台风|热带气旋/.test(text) && !document.body.classList.contains('typhoon-mode')) {
      toggleTyphoon();
    }
if (/电脑动态|系统状态|硬件状态/.test(text) && !document.body.classList.contains('computer-mode')) {
      toggleComputerStatus();
    }
  },
});
chat.applyActivationWarmupLock();
// 插件在清单里声明的斜杠命令（GET /plugins/ui）。接在这里而不是 initChat 的参数里：
// 面板模块先于 chat 启动，它会把已经拉到手的声明**补喂**一次，所以谁先就绪都不会漏。
// 传进去的是**数据**，不是函数——插件代码在主进程，函数跨不过来（见 plugin-panel.js 文件头）。
registerPluginCommandSink((commands) => chat?.registerPluginCommands?.(commands));
if (MEMORY_GRAPH_ENABLED) {
  if (graphEl) graphEl.style.display = "block";
  loadMemories();
  setInterval(() => {
    loadMemories();
  }, 5 * 60 * 1000);
}
loadHeartbeatMonitorSettings();
loadBrainUiHistory().finally(connectSSE);
loadAgentProfile();
initPersonCard();
initDocPanel().catch((err) => console.warn('[DocPanel] init failed:', err));
initKnowledgePanel();
chat.restoreChatHistory();
setInterval(() => chat?.restoreChatHistory?.(), 15_000);
window.addEventListener("focus", () => chat?.restoreChatHistory?.());
document.addEventListener("visibilitychange", () => {
  if (!document.hidden) {
    chat?.restoreChatHistory?.();
    resumeJarvisAudioContext().then(state => voiceDiag("visibility-audio-context", state));
    if (ttsAudioEl?.paused && !ttsAudioEl.ended) {
      Promise.resolve(ttsAudioEl.play()).then(() => {
        voiceDiag("visibility-audio-resumed");
      }).catch(error => {
        voiceDiag("visibility-audio-resume-failed", {
          error_name: error?.name || "",
          error: error?.message || String(error),
        });
        if (sttsActive) failStreamingTTS("visibility-resume-failed", error);
      });
    }
    retryPendingTTSPlayback("visibility");
  } else {
    voiceDiag("page-hidden", {
      tts_active: Boolean(ttsAudioEl),
      sentence_stream_active: sttsActive,
    });
  }
});
window.addEventListener("pageshow", () => retryPendingTTSPlayback("pageshow"));
chat.unlockAudioOnFirstGesture();

bootstrapScene();  // Scene 架构 shell(/scene):声明式 Agent-UI 投影层。
initPanelCollapse();
requestAnimationFrame(() => {
  requestAnimationFrame(() => resetGraphLayout({ reseed: true, restartAlpha: 1 }));
});
initWechatPopup();
initFeishuPopup();
initSettings({
  defaultAgentName: DEFAULT_AGENT_NAME,
  getAgentName: () => agentName,
  setAgentName,
  getTtsStreamingEnabled: isTTSStreamingEnabled,
  setTtsStreamingEnabled: setTTSStreamingEnabled,
  getTtsVoiceId: () => activeTTSVoiceId,
  setTtsVoiceId: (voiceId) => { activeTTSVoiceId = voiceId; },
  setOpenSettings: (openSettings) => { openSettingsRef = openSettings; },
  // 设置页保存心跳后要同步「意识心跳」面板（默认间隔 / 连接指示）
  applyHeartbeatConfig: (heartbeat) => applyHeartbeatConfig(heartbeat),
});
// ── Voice panel ──
initVoicePanel({
  btnId:      "voice-btn",
  panelId:    "voice-panel",
  canvasId:   "voice-canvas",
  statusId:   "voice-status",
  transcriptId: "voice-transcript",
  compactTranscriptId: "compact-voice-transcript",
  compactPanelId: "compact-voice-strip",
  getChatInput:  () => document.getElementById("msg-input"),
  getSendBtn:    () => document.getElementById("send-btn"),
  getSendMessage: (options) => chat?.send?.(options),
  getLang:       () => localStorage.getItem("alice-voice-lang") || "zh-CN",
  getAutoSend:   () => localStorage.getItem("alice-voice-auto-send") !== "false",
  getAutoMic:    () => localStorage.getItem("alice-voice-auto-mic") === "true",
});

// ── Composer 语音按钮接线 ──
// 输入区 .composer-tools 里的麦克风按钮自己不发请求：点击转发给顶栏 #voice-btn，
// 复用 voice-panel 的完整开/关麦链路；再用 MutationObserver 镜像它的 .active 状态，
// 保证两个按钮永远同步显示「是否在开麦」。
(function initComposerMic() {
  const micBtn = document.getElementById("composer-mic");
  const voiceBtn = document.getElementById("voice-btn");
  if (!micBtn || !voiceBtn) return;

  const sync = () => {
    const on = voiceBtn.classList.contains("active");
    micBtn.classList.toggle("active", on);
    micBtn.setAttribute("aria-pressed", on ? "true" : "false");
  };

  micBtn.addEventListener("click", (e) => {
    e.preventDefault();
    voiceBtn.click();
    sync();
  });

  new MutationObserver(sync).observe(voiceBtn, { attributes: true, attributeFilter: ["class"] });
  sync();
})();

// ── 语音输出设备路由 ──
// 监听设备插拔：拔耳机/虚拟设备占用系统默认时，把正在播的语音即时切到真实硬件；
// 完全无设备时弹一键修复横幅。getCurrentAudioEl 回传当前在播 TTS 元素。
initAudioOutputRouting({ getCurrentAudioEl: () => ttsAudioEl });

// ── Hotspot mode ──
initHotspot().catch((err) => console.warn('[Hotspot] init failed:', err));
initComputerStatus();

// ── Worldcup mode ──
initWorldcup().catch((err) => console.warn('[Worldcup] init failed:', err));
initTyphoon();
initMediaModes();
initAIVideoMode();

// ── Composer 模型下拉接线（DSH 壳）─────────────────────────────────────────
// 爱丽丝本来没有输入区级模型列表，这里把设置里的 provider/模型镜像到 composer：
// 数据源 GET /settings（providers[id].models），写回 POST /settings/model（与设置弹窗同一条链路）。
(function initComposerModelSelect() {
  const sel = document.getElementById("composer-model");
  if (!sel) return;

  const esc = (s) => String(s == null ? "" : s)
    .replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;").replace(/'/g, "&#39;");

  // 用户在本机 composer 里选定的模型（跨重载保留）。
  // 为什么要存：这个下拉每 60 秒会 load() 一次并重建 options（见文件末尾的 setInterval），
  // 原来 render() 最后无条件 `sel.value = 当前全局渠道`，于是「选完 60 秒内自己跳回去」。
  // 存一份之后重建 options 时优先还原用户的选择，全局值只在没有用户选择时兜底。
  const COMPOSER_MODEL_KEY = "alice-composer-model";
  const readStoredModel = () => { try { return localStorage.getItem(COMPOSER_MODEL_KEY) || ""; } catch { return ""; } };
  const writeStoredModel = (value) => {
    try {
      if (value) localStorage.setItem(COMPOSER_MODEL_KEY, value);
      else localStorage.removeItem(COMPOSER_MODEL_KEY);
    } catch { /* 隐私模式下写不了就算了，不影响功能 */ }
  };
  // 记住「每个渠道见过的模型」（都来自 /settings 的 llm.models，即后端为该渠道拿到的真实列表）。
  // 为什么需要：custom（中转站）这类渠道的 providers[id].models 是空的 —— 一旦切走，
  // 它的模型就不再出现在任何一份 /settings 数据里，于是「切过去就切不回来」。
  const COMPOSER_MODELS_CACHE_KEY = "alice-composer-models";
  const readModelsCache = () => {
    try { return JSON.parse(localStorage.getItem(COMPOSER_MODELS_CACHE_KEY) || "{}") || {}; } catch { return {}; }
  };
  const rememberModels = (provider, models) => {
    const id = String(provider || "").trim();
    const ids = (Array.isArray(models) ? models : [])
      .map((m) => (typeof m === "string" ? m : m && m.id))
      .filter(Boolean);
    if (!id || !ids.length) return;
    try {
      const cache = readModelsCache();
      cache[id] = Array.from(new Set([...(Array.isArray(cache[id]) ? cache[id] : []), ...ids]));
      localStorage.setItem(COMPOSER_MODELS_CACHE_KEY, JSON.stringify(cache));
    } catch { /* 忽略 */ }
  };

  let providers = null;
  let llm = null;
  let busy = false;
  const hasOption = (value) => Array.from(sel.options).some((o) => o.value === value);

  function render() {
    if (!providers) return;
    // 当前后端真正生效的渠道+模型（/settings 的 llm.provider / llm.model）
    const effective = (llm && llm.provider && llm.model) ? `${llm.provider}::${llm.model}` : "";
    const modelsCache = readModelsCache();
    const parts = [];
    for (const [id, p] of Object.entries(providers)) {
      const declared = Array.isArray(p && p.models) ? p.models.filter((m) => m && m.id) : [];
      // 当前生效渠道要额外并入 /settings.llm.models —— 那是后端为这个渠道拿到的实时模型列表。
      // custom（中转站）这类渠道 providers[id].models 是空的，真正在用的模型只在 llm.models 里；
      // 不并进来，下拉里就没有「当前正在用的模型」，sel.value 赋值会静默失败、浏览器把选中值
      // 重置成第一项（就是「选了的模型对不上/发出去还是旧的」的表象）。
      const extra = (id === (llm && llm.provider) && Array.isArray(llm && llm.models))
        ? llm.models.filter((m) => m && m.id && !declared.some((x) => x.id === m.id))
        : [];
      const known = new Set([...declared.map((m) => m.id), ...extra.map((m) => m.id)]);
      // 本页从上游拉到的目录（custom 中转站）也要并进来，否则每次重渲染都会把它冲掉
      const catalog = (catalogState && catalogState.models && Array.isArray(catalogState.models[id]))
        ? catalogState.models[id].filter((m) => m && m.id && !known.has(m.id))
        : [];
      const cached = (Array.isArray(modelsCache[id]) ? modelsCache[id] : [])
        .filter((mid) => mid && !known.has(mid) && !catalog.some((m) => m.id === mid))
        .map((mid) => ({ id: mid, label: mid }));
      const models = [...declared, ...extra, ...catalog, ...cached];
      if (!models.length) continue;
      parts.push(`<optgroup label="${esc(p.label || id)}">`);
      for (const m of models) {
        parts.push(`<option value="${esc(id)}::${esc(m.id)}">${esc(m.label || m.id)}</option>`);
      }
      parts.push("</optgroup>");
    }
    // 仍然没有「当前生效模型」时，单独补一条（值来自后端，不编造模型名）
    if (effective && !parts.some((html) => html.includes(`value="${esc(effective)}"`))) {
      parts.push(`<optgroup label="${esc((llm && llm.provider) || "当前渠道")}">`);
      parts.push(`<option value="${esc(effective)}">${esc(effective.split("::")[1] || effective)}（当前）</option>`);
      parts.push("</optgroup>");
    }
    if (!parts.length) {
      sel.innerHTML = '<option value="">（无可用模型）</option>';
      sel.disabled = true;
      return;
    }
    sel.innerHTML = parts.join("");
    sel.disabled = false;
    // 选中值优先级：用户上次的选择（且仍有对应选项）→ 后端当前生效值 → 保持浏览器默认
    const stored = readStoredModel();
    const want = (stored && hasOption(stored)) ? stored : effective;
    if (want && hasOption(want)) sel.value = want;
    if (want && want !== effective && !busy) sel.title = `待生效：${want.split("::")[1] || want}`;
  }

  async function load() {
    try {
      const data = await fetch(`${API}/settings`, { cache: "no-store" }).then((r) => r.json());
      providers = data && data.providers ? data.providers : null;
      llm = data ? data.llm : null;
      // 把当前渠道的实时模型列表记下来，切走之后还能切回来
      rememberModels(llm && llm.provider, llm && llm.models);
      rememberModels(llm && llm.provider, llm && llm.model ? [{ id: llm.model }] : []);
      render();
    } catch (err) {
      if (!providers) sel.innerHTML = '<option value="">（读取失败）</option>';
    }
  }

  // ── DSH 形态的 picker（模型 / 推理等级两行）──────────────────────────
  // 结构照搬 @deepseek-ai/dsh-client-ui-model-selection 的 ModelSelect：
  //   触发行 = 模型名 + 推理等级 + chevron；菜单 = 两行 cell（标签+当前值+›）+ 各自的选项面板。
  // 隐藏的 <select id="composer-model"> 仍是「值」的唯一载体（chat.js / resolveCtxWindow 照旧读它）。
  const trigger = document.getElementById("composer-model-trigger");
  const menu = document.getElementById("composer-model-menu");
  const labelEl = document.getElementById("composer-model-label");
  const effortEl = document.getElementById("composer-model-effort");
  const cellValueEl = document.getElementById("composer-model-cell-value");
  const effortCellValueEl = document.getElementById("composer-effort-cell-value");
  const groupsEl = document.getElementById("composer-model-groups");
  const effortGroupsEl = document.getElementById("composer-effort-groups");

  const modelName = (value) => {
    const opt = Array.from(sel.options).find((o) => o.value === value);
    return opt ? String(opt.textContent || "").trim() : (String(value || "").split("::")[1] || "—");
  };
  // 推理等级四档 —— 与后端 `src/config.js` 的 REASONING_EFFORT_LEVELS 一一对应，
  // 每档下发**互不相同**的 reasoning.effort（取值集合来自 OpenAI SDK 的 ReasoningEffort：
  // none|minimal|low|medium|high|xhigh）：
  //   低→minimal  中→low  高→medium  最高→high
  const EFFORT_LEVELS = [
    { key: "low", label: "低", effort: "minimal" },
    { key: "medium", label: "中", effort: "low" },
    { key: "high", label: "高", effort: "medium" },
    { key: "max", label: "最高", effort: "high" },
  ];
  const EFFORT_KEY = "alice-composer-effort";
  const readStoredEffort = () => { try { return localStorage.getItem(EFFORT_KEY) || ""; } catch { return ""; } };
  const writeStoredEffort = (key) => { try { localStorage.setItem(EFFORT_KEY, key); } catch { /* 忽略 */ } };
  const reasoningLevels = () => EFFORT_LEVELS;
  // 后端只在 deepseek / openai(gpt-5*·o*) 的请求体里带 reasoning 字段（llm-responses.js:136），
  // 其它渠道（含 custom 中转站）不下发 —— 面板里会如实写一行说明，但不挡用户选。
  const controllableReasoning = () => {
    const provider = String((llm && llm.provider) || "").toLowerCase();
    const model = String((llm && llm.model) || "").toLowerCase();
    return provider === "deepseek" || (provider === "openai" && (model.startsWith("gpt-5") || /^o\d/.test(model)));
  };
  // 当前档位：后端 reasoningEffort → 本地记忆 → 旧布尔 thinking 推导（老配置的等价档）
  const effectiveEffortKey = () => {
    const fromBackend = String((llm && llm.reasoningEffort) || "").toLowerCase();
    const byEffort = EFFORT_LEVELS.find((l) => l.effort === fromBackend);
    if (byEffort) return byEffort.key;
    const stored = readStoredEffort();
    if (stored && EFFORT_LEVELS.some((l) => l.key === stored)) return stored;
    return (llm && llm.thinking === true) ? "max" : "low";
  };
  const currentEffortLabel = () => {
    const key = effectiveEffortKey();
    return (EFFORT_LEVELS.find((l) => l.key === key) || {}).label || "—";
  };

  // ── 按需拉某个渠道的模型目录（custom 中转站的 GET {baseURL}/models）──
  // 只在「打开模型面板 / 切到该渠道」时拉一次，不在 60s 轮询里打上游；后端还有 60s 缓存。
  const catalogState = { loading: false, note: "" };
  const injectCatalogModels = (provider, models) => {
    // 先存进模块状态：render() 每次重建隐藏 select 的 options，只塞 DOM 会被下一次
    // 重渲染（60s 轮询 / model_switched）冲掉 —— 那就是「切了供应商过一会儿又变回去」。
    catalogState.models ||= {};
    catalogState.models[provider] = models;
    const group = Array.from(sel.querySelectorAll("optgroup")).find((g) => {
      const first = g.querySelector("option");
      return first && first.value.startsWith(`${provider}::`);
    });
    const target = group || (() => {
      const g = document.createElement("optgroup");
      g.label = (providers && providers[provider] && providers[provider].label) || provider;
      sel.appendChild(g);
      return g;
    })();
    for (const m of models) {
      const value = `${provider}::${m.id}`;
      if (!Array.from(sel.options).some((o) => o.value === value)) {
        target.appendChild(new Option(m.label || m.id, value));
      }
    }
  };
  const loadProviderCatalog = async (provider) => {
    if (!provider || catalogState.loading === provider) return;
    const declared = (providers && providers[provider] && Array.isArray(providers[provider].models))
      ? providers[provider].models.length : 0;
    // 只对「目录为空」的渠道按需拉（custom 就是这种）；已有静态目录的渠道不浪费请求
    if (declared > 0) return;
    catalogState.loading = true;
    catalogState.note = "正在获取渠道模型目录…";
    renderModelGroups();
    try {
      const res = await fetch(`${API}/settings/provider-models?provider=${encodeURIComponent(provider)}`, { cache: "no-store" });
      const data = await res.json();
      if (data && data.ok && Array.isArray(data.models) && data.models.length) {
        injectCatalogModels(provider, data.models);
        catalogState.note = `已获取 ${data.models.length} 个模型${data.cached ? "（缓存）" : ""}`;
        syncPickerUi();
      } else {
        catalogState.note = `未能获取中转站模型列表：${(data && data.error) || "上游没有返回模型"}`;
      }
    } catch (err) {
      catalogState.note = `未能获取中转站模型列表：${(err && err.message) || err}`;
    } finally {
      catalogState.loading = false;
      renderModelGroups();
    }
  };

  // 菜单定位：照搬 DSH ModelSelect（client.js:465-480）—— **始终向上展开**，左右/上下都做视口夹取：
  //   x = rect.right - lw        （右对齐触发芯片）
  //   y = rect.top - 8 - lh      （贴在触发芯片上方 8px）
  //   然后 clamp 到 [12, innerWidth - lw - 12] / [12, innerHeight - lh - 12]
  // DSH 没有翻转逻辑，就是固定向上；高度上限由 CSS 的 max-height:min(360px,100vh - 96px) + 内部滚动兜住。
  const placeMenu = () => {
    if (!menu || menu.hidden) return;
    const r = trigger.getBoundingClientRect();
    const MARGIN = 12;
    const lw = menu.offsetWidth;
    const lh = menu.offsetHeight;
    let x = r.right - lw;
    let y = r.top - 8 - lh;
    x = Math.min(Math.max(x, MARGIN), window.innerWidth - lw - MARGIN);
    y = Math.min(Math.max(y, MARGIN), window.innerHeight - lh - MARGIN);
    menu.style.left = `${Math.round(x)}px`;
    menu.style.top = `${Math.round(y)}px`;
  };
  const setPane = (pane) => {
    menu.querySelectorAll(".blm-ms-pane").forEach((el) => {
      el.hidden = el.dataset.pane !== pane;
    });
    // 面板内容高度变了 → 重新定位（DSH 的定位副作用也把 pane 列为依赖，client.js:488-491）
    placeMenu();
  };
  const closeMenu = () => {
    menu.hidden = true;
    trigger.setAttribute("aria-expanded", "false");
    trigger.querySelector(".blm-ms-chevron")?.classList.remove("blm-ms-chevronOpen");
  };
  const openMenu = () => {
    setPane("root");
    // 面板搬到 body 上做 fixed 定位（等价 DSH 的 createPortal）：聊天区带 backdrop-filter，
    // fixed 留在里面会被当成包含块、坐标整体错位。
    if (menu.parentElement !== document.body) document.body.appendChild(menu);
    menu.hidden = false;
    trigger.setAttribute("aria-expanded", "true");
    trigger.querySelector(".blm-ms-chevron")?.classList.add("blm-ms-chevronOpen");
    // 内容先渲染再量高度：否则首次打开时 offsetHeight 可能是 0，菜单会从触发行往下长出去。
    renderModelGroups();
    renderEffortGroups();
    placeMenu();
    requestAnimationFrame(() => { if (!menu.hidden) placeMenu(); });
    // 打开面板时按需拉模型目录（只对「静态目录为空」的渠道，如 custom 中转站）：
    // 既看当前选中项所在的渠道，也看后端正在生效的渠道 —— 两者可能不是同一个。
    const selectedProvider = String(sel.value || "").split("::")[0];
    void loadProviderCatalog(selectedProvider);
    void loadProviderCatalog(String((llm && llm.provider) || ""));
  };

  const renderModelGroups = () => {
    if (!groupsEl) return;
    const current = sel.value;
    // 当前渠道（选中项所在渠道，否则后端生效渠道）的分组排到最前 —— 其余分组照旧可用、排在后面。
    // 依据：DSH 的 ModelSelect 按目录顺序平铺、不做排序也不过滤（client.js:692 `state.groups.map`），
    // 但 DSH 的目录只有个位数分组；爱丽丝有 8 个渠道 70+ 项，平铺会让「我现在用的是哪个」第一眼看不到。
    const currentProvider = String(current || "").split("::")[0]
      || String((llm && llm.provider) || "");
    const groups = [];
    for (const g of sel.querySelectorAll("optgroup")) {
      const items = Array.from(g.children).map((o) => ({ value: o.value, label: String(o.textContent || "").trim() }));
      if (items.length) groups.push({ id: String(items[0].value).split("::")[0], label: g.label, items });
    }
    groups.sort((a, b) => {
      const rank = (g) => (g.id === currentProvider ? 0 : 1);
      return rank(a) - rank(b);
    });
    if (!groups.length) {
      groupsEl.innerHTML = '<div class="blm-ms-empty">（无可用模型）</div>';
      return;
    }
    groupsEl.innerHTML = groups.map((g) => `
      <div class="blm-ms-group">
        <div class="blm-ms-groupTitle">${esc(g.label)}</div>
        ${g.items.map((it) => `
          <button type="button" role="menuitem" class="blm-ms-option${it.value === current ? " blm-ms-selected" : ""}"${it.value === current ? ' aria-current="true"' : ""} data-model="${esc(it.value)}">
            <span class="blm-ms-optionCopy"><span class="blm-ms-modelName">${esc(it.label)}</span></span>
            <span class="blm-ms-check">${it.value === current ? "✓" : ""}</span>
          </button>`).join("")}
      </div>`).join("") + (catalogState.note ? `<div class="blm-ms-note">${esc(catalogState.note)}</div>` : "");
    // 选中项滚进可见位置（否则 70+ 项里用户还得自己找）
    const selectedEl = groupsEl.querySelector(".blm-ms-selected");
    if (selectedEl) {
      try { selectedEl.scrollIntoView({ block: "nearest" }); } catch { /* 忽略 */ }
    }
  };
  const renderEffortGroups = () => {
    if (!effortGroupsEl) return;
    const levels = reasoningLevels();
    const current = effectiveEffortKey();
    // 四档全部可点（用户要求）。只有当这个渠道根本不下发 reasoning 时，才补一行如实说明。
    const note = controllableReasoning()
      ? ""
      : "当前渠道不下发 reasoning 参数（后端只对 deepseek / openai 的 gpt-5·o 系列设置 reasoning.effort），档位会保存但这一轮不会带上";
    effortGroupsEl.innerHTML = `
      <div class="blm-ms-group">
        <div class="blm-ms-groupTitle">推理等级</div>
        ${levels.map((l) => `
          <button type="button" role="menuitem" class="blm-ms-option${l.key === current ? " blm-ms-selected" : ""}" data-effort="${esc(l.key)}">
            <span class="blm-ms-optionCopy"><span class="blm-ms-modelName">${esc(l.label)}</span></span>
            <span class="blm-ms-check">${l.key === current ? "✓" : ""}</span>
          </button>`).join("")}
        ${note ? `<div class="blm-ms-note">${esc(note)}</div>` : ""}
      </div>`;
  };
  const syncPickerUi = () => {
    const value = sel.value || "";
    const name = modelName(value);
    if (labelEl) labelEl.textContent = name;
    if (cellValueEl) cellValueEl.textContent = name;
    const effort = currentEffortLabel();
    if (effortEl) effortEl.textContent = effort === "不支持" ? "" : effort;
    if (effortCellValueEl) effortCellValueEl.textContent = effort;
    if (trigger) {
      trigger.title = effort === "不支持" ? `选择模型，当前 ${name}` : `选择模型，当前 ${name}，推理等级 ${effort}`;
      trigger.setAttribute("aria-label", trigger.title);
    }
    // 供应商一变就立刻补全该渠道的模型目录 —— 不能等用户打开面板才拉。
    // 触发点：model_switched(SSE) → load() → syncPickerUi()，以及 picker 里切模型后。
    // 只在「静态目录为空的渠道」(custom 中转站) 上做；每渠道 60s 最多试一次
    // （后端自己还有 60s 缓存），所以 60s 轮询不会变成反复打上游。
    const activeProvider = String((llm && llm.provider) || "");
    if (activeProvider) {
    }
    renderModelGroups();
    renderEffortGroups();
  };

  const chooseModel = async (value) => {
    const idx = String(value || "").indexOf("::");
    if (idx < 0) return;
    const provider = value.slice(0, idx);
    const model = value.slice(idx + 2);
    const previousValue = sel.value;
    writeStoredModel(value);
    sel.value = value;          // 先落到 select：即使请求还没回来，UI 也已经是用户选的那个
    syncPickerUi();
    if (busy) return;
    busy = true;
    try {
      const res = await fetch(`${API}/settings/model`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ provider, model }),
      });
      const data = await res.json();
      if (!res.ok || !data || !data.ok) throw new Error((data && data.error) || "切换失败");
      llm = Object.assign({}, llm || {}, data, { provider, model });
      if (trigger) trigger.title = `已切换：${model}`;
    } catch (err) {
      // 失败必须**看得见**。
      // 以前这里只写 trigger.title（要鼠标悬停才看得到），于是用户看到的就是
      // 「点了没反应 / 切换不过来」——而真正的原因（例如上游拒绝这个模型）
      // 就藏在一个 tooltip 里，永远没被人读到。
      writeStoredModel("");
      const detail = (err && err.message) || String(err);
      if (trigger) trigger.title = "切换失败：" + detail;
      showModelSwitchError(`切换模型失败：${detail}`);
      // 回滚到切换前的选中值：下拉要**如实反映后端仍在用的模型**，
      // 不能停在一个并没生效的选项上——那会让人误以为已经切过去了。
      if (previousValue && hasOption(previousValue)) sel.value = previousValue;
    } finally {
      busy = false;
      closeMenu();
      syncPickerUi();
    }
  };
  // 最小可见错误条：把后端原话显示出来，5 秒后自动消失。
  // 刻意不引入 toast 组件——这里只有「让失败原因浮出来」这一个用途。
  let errTimer = null;
  const showModelSwitchError = (message) => {
    const host = menu || sel.parentElement;
    if (!host) return;
    let box = document.getElementById("composer-model-error");
    if (!box) {
      box = document.createElement("div");
      box.id = "composer-model-error";
      box.className = "blm-ms-note blm-ms-note-error";
      box.setAttribute("role", "alert");
      host.appendChild(box);
    }
    box.textContent = message;
    box.hidden = false;
    if (errTimer) clearTimeout(errTimer);
    errTimer = setTimeout(() => { box.hidden = true; }, 5000);
  };
  const chooseEffort = async (key) => {
    const level = reasoningLevels().find((l) => l.key === key);
    if (!level) return;
    if (busy) return;
    writeStoredEffort(level.key);
    busy = true;
    try {
      // 真下发：reasoning.effort 由后端写进请求体（低/中/高/最高 = minimal/low/medium/high）
      const res = await fetch(`${API}/settings/reasoning-effort`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ effort: level.effort }),
      });
      const data = await res.json();
      if (!res.ok || !data || !data.ok) throw new Error((data && data.error) || "切换失败");
      llm = Object.assign({}, llm || {}, { reasoningEffort: data.reasoningEffort || level.effort });
    } catch (err) {
      writeStoredEffort("");
      if (trigger) trigger.title = "推理等级切换失败：" + ((err && err.message) || err);
    } finally {
      busy = false;
      closeMenu();
      syncPickerUi();
    }
  };

  // ── 键盘导航（移植 DSH ModelSelect 的键盘段落：client.js:500-527）───────────
  // DSH 的做法：
  //   · moveFocus(offset)（506-511）：把「当前渲染出来的 item」收成一个列表，
  //     从 document.activeElement 找到当前下标，focus 到 (index+offset+len)%len —— 真正的 DOM focus，循环绕回；
  //   · onRootKeyDown（512-524）：Escape → 子面板先回 root，root 再关闭（并 preventDefault）；
  //     ArrowDown/ArrowUp → moveFocus(±1) 且 preventDefault。**DSH 只处理这三个键**
  //     （Enter/Space 靠原生 button 激活；没有 ArrowLeft/Right、Home/End、aria-activedescendant）；
  //   · close(restoreFocus)（496-505）：关闭后把焦点还给触发芯片。
  // 两处我有意偏离 DSH（都会在报告里写明）：
  //   ① 焦点从「尚未聚焦任何 item」开始按 ArrowDown 时，DSH 的 Math.max(active,0)+offset 会跳到第 2 项；
  //      这里改成落到第 1 项（否则根面板第一下方向键会跳过「模型」直接到「推理等级」）。
  //   ② 用户额外要求「右键/退格返回上级」：DSH 没有，我补了 ArrowRight 进子面板、ArrowLeft/Backspace 回 root。
  const pickerItems = () => {
    const pane = menu.querySelector(".blm-ms-pane:not([hidden])");
    return pane ? Array.from(pane.querySelectorAll("button")).filter((b) => !b.disabled) : [];
  };
  const focusItem = (el) => {
    if (!el) return;
    try { el.focus({ preventScroll: true }); } catch { /* 忽略 */ }
    try { el.scrollIntoView({ block: "nearest" }); } catch { /* 忽略 */ }
  };
  const moveFocus = (offset) => {
    const items = pickerItems();
    if (!items.length) return;
    const active = items.findIndex((item) => item === document.activeElement);
    let next;
    if (active < 0) next = offset > 0 ? 0 : items.length - 1;
    else next = (active + offset + items.length) % items.length;
    focusItem(items[next]);
  };
  const onPickerKeyDown = (event) => {
    if (!menu || menu.hidden) return;
    if (event.key === "Escape") {
      event.preventDefault();
      const pane = menu.querySelector(".blm-ms-pane:not([hidden])")?.dataset.pane || "root";
      if (pane !== "root") { setPane("root"); focusItem(pickerItems()[0]); }
      else { closeMenu(); try { trigger.focus(); } catch { /* 忽略 */ } }   // DSH close(true)：焦点还给芯片
      return;
    }
    if (event.key === "ArrowDown" || event.key === "ArrowUp") {
      event.preventDefault();
      moveFocus(event.key === "ArrowDown" ? 1 : -1);
      return;
    }
    // 以下三行是 DSH 没有、按用户要求补的（见上方说明 ②）
    if (event.key === "ArrowRight") {
      const cell = document.activeElement?.closest?.("[data-cell]");
      if (cell) { event.preventDefault(); setPane(cell.dataset.cell); focusItem(pickerItems()[0]); }
      return;
    }
    if (event.key === "ArrowLeft" || event.key === "Backspace") {
      const pane = menu.querySelector(".blm-ms-pane:not([hidden])")?.dataset.pane || "root";
      if (pane !== "root") { event.preventDefault(); setPane("root"); focusItem(pickerItems()[0]); }
    }
  };

  trigger?.addEventListener("click", (event) => {
    event.stopPropagation();
    if (menu.hidden) openMenu(); else closeMenu();
  });
  trigger?.addEventListener("keydown", (event) => {
    // DSH 把 keydown 挂在 root 包裹层（583）；我的菜单是 portal 到 body 的，事件不会冒泡回触发器，
    // 所以同一套处理同时挂在触发芯片和菜单上（行为等价，且换面板后仍然可用）。
    if (menu.hidden && (event.key === "ArrowDown" || event.key === "ArrowUp")) {
      event.preventDefault();
      openMenu();
      focusItem(pickerItems()[0]);
      return;
    }
    onPickerKeyDown(event);
  });
  menu?.addEventListener("keydown", onPickerKeyDown);
  menu?.addEventListener("click", (event) => {
    event.stopPropagation();
    const cell = event.target.closest?.("[data-cell]");
    if (cell) { setPane(cell.dataset.cell); focusItem(pickerItems()[0]); return; }
    const modelBtn = event.target.closest?.("[data-model]");
    if (modelBtn) { chooseModel(modelBtn.dataset.model); return; }
    const effortBtn = event.target.closest?.("[data-effort]");
    if (effortBtn) chooseEffort(effortBtn.dataset.effort);
  });
  document.addEventListener("click", () => { if (!menu?.hidden) closeMenu(); });
  // 滚动时不关闭、而是**重新定位**（照搬 DSH：client.js:482 `window.addEventListener("scroll", place, true)`）。
  // 之前这里是「一滚就关」，结果键盘把焦点移到深处的选项时 scrollIntoView 会带动外层滚动，
  // 菜单直接被关掉（实测：模型面板按下 12 次方向键后菜单消失）。
  document.addEventListener("scroll", () => { if (!menu?.hidden) placeMenu(); }, true);
  // 供应商/模型被别处改了（设置页、别的客户端）→ 立刻重拉，不让列表留着上一个渠道的陈旧选项。
  // 同时清掉本地记忆的选择：那是「用户想要但已被外部改掉」的值，继续占着会让下拉显示与实际不符。
  window.addEventListener("blm:sse", (event) => {
    if (event.detail?.type === "model_switched") {
      writeStoredModel("");
      load();
    }
  });

  // load() 本身在上面（它只负责拉数据 + 重建隐藏 select），这里包一层：
  // 每次拉完都同步 picker 的触发行与两个面板，避免初始状态停在「模型 —」。
  const runLoad = load;
  load = async () => { await runLoad(); syncPickerUi(); };

  load();
  setInterval(load, 60000);
})();

// ── Composer 权限下拉接线（真实 /settings/security）──────────────────────────
// 后端是真闸门：executeTool → evaluateToolPolicy 读 config.security.blockedTools，
// 命中即返回 PERMISSION_DENIED 并写审计日志。GET/POST /settings/security 持久化到 config.json。
// 前端只做「读状态 + 写预设」，不自己造权限语义。
(function initComposerPermission() {
  const btn = document.getElementById("composer-permission");
  const menu = document.getElementById("composer-permission-menu");
  const label = document.getElementById("composer-permission-label");
  if (!btn || !menu || !label) return;

  // 后端 config.security 有三个独立闸门（GET/POST /settings/security，落盘 config.json）：
  //   blockedTools —— 工具级：命中即 PERMISSION_DENIED（tool-policy.js evaluateToolPolicy）
  //   fileSandbox  —— 路径级：为 true 时 read/list/write/edit 全被 assertInSandbox
  //                   限制在 SANDBOX_ROOT（工作区）内（sandbox.js）
  //   execSandbox  —— 命令级：为 true 时 run_command 拒绝绝对路径 / 上级目录 / 家目录
  // 三档就是这几个开关的组合。前端只做「读状态 + 写预设」，不自己造权限语义。
  // 工具名必须用「规范名」：config.js 的 LEGACY_BLOCKED_TOOL_MIGRATIONS 会把
  // exec_* 折叠成 run_command、把 web_search/browser_* 家族折叠成 chrome_devtools_browser。
  const READONLY_BLOCKED = [
    "run_command", "write_file", "edit_file", "delete_file", "make_dir",
    "install_software", "install_tool", "uninstall_tool", "manage_tool_factory",
    "kill_process", "download_file",
    "grant_agent_delegation", "delegate_to_agent",
    "manage_api_capability", "set_security",
    "chrome_devtools_browser",
  ];

  const PRESETS = [
    {
      id: "full",
      title: "完全权限",
      desc: "可读取、修改本机所有文件",
      blocked: [],
      fileSandbox: false,
      execSandbox: false,
    },
    {
      id: "workspace",
      title: "工作区修改",
      desc: "读写都限制在工作区内，不碰工作区外的文件",
      blocked: [],
      fileSandbox: true,
      execSandbox: true,
    },
    {
      id: "readonly",
      title: "只读",
      desc: "可读取查阅，禁用写入 / 执行 / 安装 / 授权类工具",
      blocked: READONLY_BLOCKED,
      fileSandbox: false,
      execSandbox: true,
    },
  ];

  // 后端 normalizeBlockedTools 会把「组名」展开（chrome_devtools_browser → 20 个 browser_*），
  // 所以回读到的数组不等于我提交的数组，不能直接比对。这里按展开后的规范集合判断档位。
  const CHROME_BROWSER_FAMILY = [
    "browser_navigate", "browser_navigate_back", "browser_navigate_forward", "browser_reload",
    "browser_snapshot", "browser_find", "browser_click", "browser_type", "browser_fill_form",
    "browser_select_option", "browser_press_key", "browser_hover", "browser_drag",
    "browser_wait_for", "browser_handle_dialog", "browser_tabs", "browser_take_screenshot",
    "browser_console_messages", "browser_resize", "browser_close",
  ];

  // 把预设里的规范键展开成后端最终会存下来的名字，用于精确比对。
  function expand(keys) {
    const out = [];
    for (const k of keys) {
      if (k === "chrome_devtools_browser") out.push(...CHROME_BROWSER_FAMILY);
      else out.push(k);
    }
    return [...new Set(out)];
  }

  function sameBlocked(a, b) {
    if (a.length !== b.length) return false;
    const s = new Set(a);
    return b.every((n) => s.has(n));
  }

  let state = { blockedTools: [], fileSandbox: false, execSandbox: false, accessMode: "" };

  // 档位判定必须同时看「禁了哪些工具」和「两个 sandbox 开关」——
  // 只看 blockedTools 的话，工作区档和完全权限档会被判成同一档。
  function levelOf() {
    // 显式档位优先：完全权限和「从未配置过」的默认组合完全一样，
    // 只靠闸门反推会把默认状态误显示成完全权限。
    if (["full", "workspace", "readonly"].includes(state.accessMode)) return state.accessMode;
    const blocked = state.blockedTools || [];
    for (const p of PRESETS) {
      if (!sameBlocked(blocked, expand(p.blocked))) continue;
      if ((state.fileSandbox === true) !== (p.fileSandbox === true)) continue;
      if ((state.execSandbox === true) !== (p.execSandbox === true)) continue;
      return p.id;
    }
    return "custom";
  }

  function render() {
    const blocked = state.blockedTools || [];
    const level = levelOf();
    const preset = PRESETS.find((p) => p.id === level);
    label.textContent = preset ? preset.title : `自定义 · 禁 ${blocked.length} 项`;
    btn.dataset.level = level;

    const bits = [];
    if (blocked.length) bits.push(`禁用 ${blocked.length} 个工具`);
    if (state.fileSandbox) bits.push("文件限制在工作区内");
    if (state.execSandbox) bits.push("命令限制在工作区内");
    btn.title = bits.length
      ? bits.join("；")
        + (blocked.length ? `：${blocked.slice(0, 6).join(", ")}${blocked.length > 6 ? " …" : ""}` : "")
      : "当前不限制任何工具，也不限制路径";

    menu.innerHTML = "";
    for (const p of PRESETS) {
      const item = document.createElement("button");
      item.type = "button";
      item.className = "composer-permission-item";
      item.setAttribute("role", "option");
      item.setAttribute("aria-selected", String(p.id === level));
      item.innerHTML = `<span class="cpi-title"></span><span class="cpi-desc"></span>`;
      item.querySelector(".cpi-title").textContent = p.title;
      item.querySelector(".cpi-desc").textContent = p.desc;
      item.addEventListener("click", () => apply(p));
      menu.appendChild(item);
    }
    if (level === "custom") {
      const sep = document.createElement("div");
      sep.className = "cpi-sep";
      sep.textContent = `当前是自定义组合（禁 ${blocked.length} 项 / 工作区 ${state.fileSandbox ? "开" : "关"}），非以上预设`;
      menu.appendChild(sep);
    }
  }

  function readSecurity(security) {
    state.blockedTools = Array.isArray(security && security.blockedTools) ? security.blockedTools : [];
    state.fileSandbox = security && security.fileSandbox === true;
    state.execSandbox = security && security.execSandbox === true;
    state.accessMode = security && ["full", "workspace", "readonly"].includes(security.accessMode)
      ? security.accessMode
      : "";
  }

  async function load() {
    try {
      const res = await fetch("/settings/security", { headers: { Accept: "application/json" } });
      const data = await res.json();
      if (!data || !data.ok || !data.security) throw new Error((data && data.error) || "bad response");
      readSecurity(data.security);
      render();
    } catch (err) {
      label.textContent = "权限读取失败";
      btn.title = `GET /settings/security 失败：${err.message}`;
    }
  }

  async function apply(preset) {
    const prev = Object.assign({}, state, { blockedTools: (state.blockedTools || []).slice() });
    state.blockedTools = preset.blocked.slice();
    state.fileSandbox = preset.fileSandbox;
    state.execSandbox = preset.execSandbox;
    state.accessMode = preset.id;
    render();
    try {
      const res = await fetch("/settings/security", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          blockedTools: preset.blocked,
          fileSandbox: preset.fileSandbox,
          execSandbox: preset.execSandbox,
          accessMode: preset.id,
        }),
      });
      const data = await res.json();
      if (!data || !data.ok) throw new Error((data && data.error) || "save failed");
      if (data.security) readSecurity(data.security);
      render();
    } catch (err) {
      state = prev;
      render();
      btn.title = `保存失败，已回滚：${err.message}`;
    }
  }

  btn.addEventListener("click", (e) => {
    e.stopPropagation();
    const open = menu.hidden;
    menu.hidden = !open;
    btn.setAttribute("aria-expanded", String(open));
  });
  document.addEventListener("click", (e) => {
    if (menu.hidden) return;
    if (e.target === btn || btn.contains(e.target)) return;
    menu.hidden = true;
    btn.setAttribute("aria-expanded", "false");
  });
  document.addEventListener("keydown", (e) => {
    if (e.key === "Escape" && !menu.hidden) {
      menu.hidden = true;
      btn.setAttribute("aria-expanded", "false");
    }
  });

  load();
  setInterval(load, 60000);
})();

// ── 输入区运行状态栏 + 用量悬浮卡（真实数据，原生渲染路径）────────────
// 口径与结构逐条对照 DSH dsh-client-ui-chat/lib/client.js：
//   文案 stats.dialog.* 2631-2636 / message.turnUsage.* 2702-2711 / message.turnTime.* 2712-2715
//   格式 formatRunDuration 930、formatLatencySeconds 945、formatTokensPerSecond 954、
//        formatTokens 3313、formatExactTokens 3325、formatCacheHitPercent 3361、
//        formatDuration 3916、billedInputTokens 3941
//   结构 TurnUsagePanel(本轮用量) 3490-3554、TurnTimePanel(本轮用时和速度) 3560-3608、
//        会话统计面板 3988-4010、Token 用量面板 4040-4075
// 数据来源只有一条：下面这个 SSE 监听（不另开 EventSource）；
//   轮/步 ← llm_usage / tool_call，模型用时/工具用时/TTFT ← llm_usage(durationMs/ttftMs) 或 SSE 到达时间兜底，
//   未缓存输入/缓存读取/输出/推理 ← llm_usage 的 inputTokens/cachedTokens/outputTokens/reasoningTokens。
// 用户轮开始（message_received）清零的是「本轮」，会话级累计一直累加。
(function initComposerStatus() {
  const root = document.getElementById("composer-status");
  if (!root) return;
  // DSH StatsPills：两个芯片的常显文案节点（原生标记，见 app-shell.js 的 #composer-status）
  const pillEls = {
    time: document.getElementById("stats-pill-time"),
    usage: document.getElementById("stats-pill-usage"),
    counts: document.getElementById("stat-counts"),
    countsSep: document.getElementById("stat-counts-sep"),
    tps: document.getElementById("stat-tps"),
    total: document.getElementById("stat-total-tok"),
    totalSep: document.getElementById("stat-total-sep"),
    cache: document.getElementById("stat-cache"),
    // 上下文 / 余额：爱丽丝原有的两项常显指标，按用户要求从输入框内部挪到状态栏，
    // 位置紧跟在「缓存命中」之后；DSH 没有这两项的 pill（上下文只有 ContextMeter
    // 圆环 + 系统/工具/对话拆分面板，余额完全没有 UI），所以沿用 DSH 的 stat-dialog
    // 面板结构自己组，字段全部取爱丽丝真实值，拿不到就 —。
    context: document.getElementById("stats-pill-context"),
    contextText: document.getElementById("stat-context"),
    contextPct: document.getElementById("stat-context-pct"),
    contextUsed: document.getElementById("stat-context-used"),
    contextWindow: document.getElementById("stat-context-window"),
    contextLeft: document.getElementById("stat-context-left"),
    balance: document.getElementById("stats-pill-balance"),
    balanceText: document.getElementById("stat-balance"),
    balanceValue: document.getElementById("stat-balance-value"),
    balanceCurrency: document.getElementById("stat-balance-currency"),
    balanceAmount: document.getElementById("stat-balance-amount"),
  };
  // 会话统计 / Token 用量两块面板里的 dd（同一批原生标记）
  const panelEls = {
    totalExact: document.getElementById("stat-total-exact"),
    llmTime: document.getElementById("stat-llm-time"),
    toolTime: document.getElementById("stat-tool-time"),
    ttft: document.getElementById("stat-ttft"),
    tps: document.getElementById("stat-tps-panel"),
    hit: document.getElementById("stat-hit"),
    uncached: document.getElementById("stat-uncached"),
    cacheRead: document.getElementById("stat-cache-read"),
    out: document.getElementById("stat-out"),
  };

  // ── 会话级累计（页面重载清零）。字段名对齐 DSH 的 sessionStats / tokenUsage 投影。──
  const session = {
    ready: false, turns: 0, steps: 0,
    llmMs: 0, toolMs: 0, ttftMs: 0, ttftSteps: 0, decodeMs: 0, decodeTokens: 0,
    uncachedInputTokens: 0, cacheReadTokens: 0, writeTokens: 0,
    outputTokens: 0, reasoningTokens: 0,
  };
  // ── 本轮累计（message_received 清零）。操作行那两张卡读它。──
  const turn = {
    ready: false, steps: 0, startMs: 0, endMs: 0,
    llmMs: 0, toolMs: 0, ttftMs: 0, ttftSum: 0, ttftSteps: 0, decodeMs: 0, decodeTokens: 0,
    uncachedInputTokens: 0, cacheReadTokens: 0, writeTokens: 0,
    outputTokens: 0, reasoningTokens: 0,
  };
  // DSH billedInputTokens：三个互斥的输入桶之和（爱丽丝不上报 cache-write，恒为 0）
  const promptTokensOf = u => u.uncachedInputTokens + u.cacheReadTokens + u.writeTokens;
  const totalTokensOf = u => promptTokensOf(u) + u.outputTokens;
  // 用量去重：SSE 事件与 /usage-last 兜底可能拿到同一次调用，用后端给的 at 判重。
  let lastUsageAt = 0;
  // 本轮计时：message_received 起表，response / message(from=consciousness) 停表。
  let turnStart = 0;
  let elapsedTimer = null;
  // 上一轮定稿的快照：定稿的用时芯片属于哪一轮，它的弹卡就显示哪一轮的数
  let finishedTurn = null;
  // 单次 LLM 调用的计时兜底（旧后端不带 durationMs/ttftMs 时用 SSE 到达时间估）
  let llmStartAt = 0;
  let llmFirstTokenAt = 0;
  const toolStarts = new Map();

  // ── 显示格式化：逐条照搬 DSH dsh-client-ui-chat（client.js 行号见上）──
  const toNum = v => (Number.isFinite(Number(v)) ? Number(v) : 0);
  const toInt = v => Math.max(0, Math.round(toNum(v)));
  // formatExactTokens 3325：三位分组（number.groupSeparator = ","）
  const formatExactTokens = n => {
    const digits = String(toInt(n));
    const groups = [];
    for (let end = digits.length; end > 0; end -= 3) groups.unshift(digits.slice(Math.max(0, end - 3), end));
    return groups.join(",");
  };
  // formatTokens 3313：<1e3 原样，<1e6 → K，否则 → M（scaled：≥100 取整，否则一位小数）
  const formatTokens = n => {
    const v = toInt(n);
    const scaled = c => (c >= 100 ? String(Math.round(c)) : String(Math.round(c * 10) / 10));
    if (v < 1e3) return String(v);
    if (v < 1e6) return `${scaled(v / 1e3)}K`;
    return `${scaled(v / 1e6)}M`;
  };
  // roundedPercentUnits 3332 / displayPercentUnits 3347 / formatCacheHitPercent 3361
  const roundedPercentUnits = (cacheReadTokens, denominator, decimalPlaces) => {
    const scale = (decimalPlaces === 0 ? 1 : 10) * 100;
    const doubledScale = scale * 2;
    const denominatorQuotient = Math.floor(denominator / doubledScale);
    const denominatorRemainder = denominator % doubledScale;
    let lower = 0;
    let upper = scale;
    while (lower < upper) {
      const candidate = Math.floor((lower + upper + 1) / 2);
      const factor = candidate * 2 - 1;
      if (cacheReadTokens >= factor * denominatorQuotient + Math.ceil((factor * denominatorRemainder) / doubledScale)) lower = candidate;
      else upper = candidate - 1;
    }
    return lower;
  };
  const displayPercentUnits = (units, decimalPlaces) => {
    if (decimalPlaces === 0) return String(units);
    const whole = Math.floor(units / 10);
    const tenths = units % 10;
    return tenths === 0 ? String(whole) : `${whole}.${tenths}`;
  };
  const formatCacheHitPercent = (cacheReadTokens, promptTokens, decimalPlaces = 0) => {
    if (promptTokens === 0) return null;
    const missedInputTokens = promptTokens - cacheReadTokens;
    if (missedInputTokens === 0) return "100";
    const roundedUnits = roundedPercentUnits(cacheReadTokens, promptTokens, decimalPlaces);
    if (roundedUnits < (decimalPlaces === 0 ? 100 : 1e3)) return displayPercentUnits(roundedUnits, decimalPlaces);
    let distinguishingPlaces = 1;
    let scaledDoubleGap = missedInputTokens * 200;
    const denominatorTens = Math.floor(promptTokens / 10);
    while (scaledDoubleGap <= denominatorTens) {
      scaledDoubleGap *= 10;
      distinguishingPlaces += 1;
    }
    const denominatorOnes = promptTokens % 10;
    let roundedLoss = 5;
    for (let loss = 1; loss < 5; loss += 1) {
      const factor = loss * 2 + 1;
      if (scaledDoubleGap <= factor * denominatorTens + Math.floor((factor * denominatorOnes) / 10)) {
        roundedLoss = loss;
        break;
      }
    }
    return `99.${"9".repeat(distinguishingPlaces - 1)}${10 - roundedLoss}`;
  };
  // formatRunDuration 930：秒向下取整，≥60s「M分SS秒」（秒补零）——芯片 / 本轮用时卡
  const fmtRunDuration = ms => {
    const total = Math.max(0, Math.floor(toNum(ms) / 1e3));
    const minutes = Math.floor(total / 60);
    const seconds = total % 60;
    return minutes > 0 ? `${minutes}分${String(seconds).padStart(2, "0")}秒` : `${seconds}秒`;
  };
  // formatDuration 3916：<60s 一位小数，≥60s「M分S秒」（秒不补零）——会话统计卡
  const fmtDuration = ms => {
    const s = toNum(ms) / 1e3;
    if (s < 60) return `${Math.round(s * 10) / 10}秒`;
    const whole = Math.round(s);
    return `${Math.floor(whole / 60)}分${whole % 60}秒`;
  };
  // formatLatencySeconds 945：<10s 一位小数，其余取整（无单位）
  const fmtLatencySeconds = ms => {
    const s = Math.max(0, toNum(ms)) / 1e3;
    return s < 10 ? String(Math.round(s * 10) / 10) : String(Math.round(s));
  };
  // formatTokensPerSecond 954：≥10 取整，<10 一位小数
  function formatTokensPerSecond(tps) {
    const v = Math.max(0, toNum(tps));
    return v >= 10 ? String(Math.round(v)) : String(Math.round(v * 10) / 10);
  }
  const fmtTps = formatTokensPerSecond;
  // message.turnUsage.count = "{count} tok"；message.tokensPerSecond = "{tps} tok/s"
  const countText = v => `${formatExactTokens(v)} tok`;
  const tpsText = v => `${formatTokensPerSecond(v)} tok/s`;
  // 紧凑 token（参考图 E/F 的 21M / 295M 写法，DSH formatTokens 同口径）
  const fmtCompactTokens = formatTokens;
  const setText = (el, text) => { if (el && el.textContent !== text) el.textContent = text; };
  const cacheHitOf = (u, places = 0) => formatCacheHitPercent(u.cacheReadTokens, promptTokensOf(u), places);

  // 模型上下文窗口（token）。没有 provider 的接口会返回这个数，
  // 所以分母是一张本地表 + 默认值——不是「拉来的数据」，改窗口改这里。
  const DEFAULT_CTX_WINDOW = 128000;
  const MODEL_CTX_WINDOW = [
    [/(^|[-_ ])1m($|[-_ ])/i, 1000000],
    [/glm-5\.3/i, 1000000],
    [/128k/i, 128000],
  ];
  const resolveCtxWindow = () => {
    const id = document.getElementById("composer-model")?.value || "";
    for (const [re, n] of MODEL_CTX_WINDOW) if (re.test(id)) return n;
    return DEFAULT_CTX_WINDOW;
  };
  // 上下文占用 = 最近一次 LLM 调用的真实 prompt 大小 ÷ 模型窗口。
  // 分子来自 llm_usage.inputTokens；分母是本地窗口表（接口不返回窗口大小）。
  let lastPromptTokens = 0;
  const paintContext = () => {
    const win = resolveCtxWindow();
    const used = lastPromptTokens;
    const has = used > 0 && win > 0;
    const pct = has ? Math.min(999, Math.round((used / win) * 100)) : null;
    setText(pillEls.contextText, has ? `上下文 ${formatExactTokens(used)}/${formatExactTokens(win)} · ${pct}%` : "上下文 —");
    setText(pillEls.contextPct, pct === null ? "—" : `${pct}%`);
    setText(pillEls.contextUsed, has ? countText(used) : "—");
    setText(pillEls.contextWindow, win > 0 ? countText(win) : "—");
    setText(pillEls.contextLeft, has ? countText(Math.max(0, win - used)) : "—");
    // 常显：没有真实用量时显示「上下文 —」，不做条件隐藏
    if (pillEls.context) pillEls.context.hidden = false;
    const btn = pillEls.context?.querySelector("button");
    if (btn) btn.setAttribute("aria-label", has ? `上下文 ${formatExactTokens(used)}/${formatExactTokens(win)} · ${pct}%` : "上下文 —");
  };
  // 余额：provider 真提供余额接口才有数字，其余一律 —（不编）。
  const paintBalance = async () => {
    try {
      const res = await fetch(`${API}/balance`);
      const data = await res.json();
      if (data?.ok && Number.isFinite(Number(data.total))) {
        const symbol = data.currency === "CNY" ? "¥" : data.currency === "USD" ? "$" : "";
        const text = `${symbol}${Number(data.total).toFixed(2)}`;
        setText(pillEls.balanceText, `余额 ${text}`);
        setText(pillEls.balanceValue, text);
        setText(pillEls.balanceCurrency, data.currency || "—");
        setText(pillEls.balanceAmount, text);
        if (pillEls.balance) pillEls.balance.hidden = false;
        const btn = pillEls.balance?.querySelector("button");
        if (btn) btn.setAttribute("aria-label", `账户余额 ${text}`);
      } else {
        setText(pillEls.balanceText, "余额 —");
        setText(pillEls.balanceValue, "—");
        setText(pillEls.balanceCurrency, "—");
        setText(pillEls.balanceAmount, "—");
        if (pillEls.balance) pillEls.balance.hidden = true;
      }
    } catch {
      setText(pillEls.balanceText, "余额 —");
      if (pillEls.balance) pillEls.balance.hidden = true;
    }
  };

  // ── 常显芯片 + 两块面板（同一份累计，同一套格式）───────────────────
  // DSH StatsPills（client.js:4079-4110）的组装与条件显示：
  //   · TimePill 文案：`{turns} 轮 {steps} 步` + ` · {tps}`
  //   · UsagePill 文案：`{formatTokens(total)} tok` + ` · 缓存命中 {p}%`
  // 与 DSH 的唯一有意差异：DSH 在 stats 为 0 时不渲染对应 pill（它的 stats 来自会话投影，
  // 一进页面就有值）；爱丽丝的会话累计是前端从 0 起算的，照搬会让刷新后只剩余额一枚。
  // 所以这里 4 枚 pill **常显**，值不可用时按已定口径显示 —（`0 轮 0 步 · — tok/s`）。
  const sessionTps = () => (session.decodeMs > 0 ? session.decodeTokens / (session.decodeMs / 1e3) : null);
  const paintSession = () => {
    const hit = cacheHitOf(session);
    const tps = sessionTps();
    const counts = `${session.turns} 轮 ${session.steps} 步`;
    const tpsLabel = tps === null ? "— tok/s" : tpsText(tps);
    const totalLabel = `${formatTokens(totalTokensOf(session))} tok`;
    const cacheLabel = hit === null ? "缓存命中 —" : `缓存命中 ${hit}%`;
    setText(pillEls.counts, counts);
    setText(pillEls.tps, tpsLabel);
    setText(pillEls.total, totalLabel);
    setText(pillEls.cache, cacheLabel);
    // 分隔符常显（两段文案都非空）
    if (pillEls.countsSep) pillEls.countsSep.hidden = false;
    if (pillEls.totalSep) pillEls.totalSep.hidden = false;
    // aria-label 与 DSH 一致：`{counts} · {tps}` / `{total} · {cacheHit}`
    if (pillEls.time) {
      pillEls.time.hidden = false;
      const btn = pillEls.time.querySelector("button");
      if (btn) btn.setAttribute("aria-label", `${counts} · ${tpsLabel}`);
    }
    if (pillEls.usage) {
      pillEls.usage.hidden = false;
      const btn = pillEls.usage.querySelector("button");
      if (btn) btn.setAttribute("aria-label", `${totalLabel} · ${cacheLabel}`);
    }
    // 会话统计面板（DSH TimePill 面板 4004-4007：模型/工具/TTFT/TPS 四行）
    setText(panelEls.totalExact, session.ready ? countText(totalTokensOf(session)) : "—");
    setText(panelEls.llmTime, session.llmMs > 0 ? fmtDuration(session.llmMs) : "—");
    setText(panelEls.toolTime, session.toolMs > 0 ? fmtDuration(session.toolMs) : "—");
    setText(panelEls.ttft, session.ttftSteps > 0 ? fmtDuration(session.ttftMs / session.ttftSteps) : "—");
    setText(panelEls.tps, tps === null ? "—" : tpsText(tps));
    // Token 用量面板（DSH UsagePill 面板 4065-4072）
    setText(panelEls.hit, hit === null ? "—" : `${hit}%`);
    setText(panelEls.uncached, session.ready ? countText(session.uncachedInputTokens) : "—");
    setText(panelEls.cacheRead, session.ready ? countText(session.cacheReadTokens) : "—");
    setText(panelEls.out, session.ready ? countText(session.outputTokens) : "—");
  };

  // ── 一轮的计时：起表 / 停表 / 把「用时」写进操作行 ──────────────────
  const currentTurnRunMs = () => {
    if (!turn.startMs) return null;
    const end = turn.endMs > 0 ? turn.endMs : Date.now();
    return end >= turn.startMs ? end - turn.startMs : null;
  };
  const lastJarvisBar = () => {
    const msgs = document.querySelectorAll("#chat-messages .msg-jarvis");
    const last = msgs[msgs.length - 1];
    return last ? last.querySelector(".msg-actions") : null;
  };
  // 面板会被挂到 body 上（DSH 的 createPortal），所以按芯片上的 data-panel-id 反查
  const panelOf = chip => {
    const id = chip?.dataset?.panelId;
    return id ? document.getElementById(id) : null;
  };
  // 本轮用时：芯片文案 + 弹卡（数据都来自本模块的累计器，和芯片同源）
  const paintTurnElapsed = () => {
    const bar = lastJarvisBar();
    if (!bar) return;
    const chip = bar.querySelector(".msg-elapsed");
    if (!chip) return;
    const ms = currentTurnRunMs();
    setText(chip.querySelector("span") || chip, `用时 ${ms === null ? "—" : fmtRunDuration(ms)}`);
    if (ms !== null) chip.dataset.blmRunMs = String(ms);
    else delete chip.dataset.blmRunMs;
    chip.hidden = false;
    const panel = panelOf(chip);
    if (!panel) return;
    setText(panel.querySelector(".blm-turn-duration"), ms === null ? "—" : fmtRunDuration(ms));
    const src = turn.endMs > 0 ? (finishedTurn || turn) : turn;
    setText(panel.querySelector(".blm-turn-tps"), src.decodeMs > 0 ? tpsText(src.decodeTokens / (src.decodeMs / 1e3)) : "—");
    setText(panel.querySelector(".blm-turn-ttft"), src.ttftMs > 0 ? `${fmtLatencySeconds(src.ttftMs)}秒` : "—");
  };
  const paintElapsed = paintTurnElapsed;
  const stopElapsed = () => {
    if (elapsedTimer) { clearInterval(elapsedTimer); elapsedTimer = null; }
  };
  const startElapsed = () => {
    stopElapsed();
    elapsedTimer = setInterval(paintTurnElapsed, 1000);
  };

  // ── 悬浮卡挂载：面板是 app-shell.js / chat.js 里的原生标记，这里只做显示与定位 ──
  mountStatPanel(document.querySelector('#composer-status [data-metric="session-stats"]'), document.querySelector('[data-panel="session-stats"]'));
  mountStatPanel(document.querySelector('#composer-status [data-metric="session-tokens"]'), document.querySelector('[data-panel="session-tokens"]'));
  mountStatPanel(document.querySelector('#composer-status [data-metric="context"]'), document.querySelector('[data-panel="context"]'));
  mountStatPanel(document.querySelector('#composer-status [data-metric="balance"]'), document.querySelector('[data-panel="balance"]'));

  // ── 一次真实用量 → 会话累计 + 本轮累计 + 最后一条回复的操作行 ──────
  // 幂等：同一次调用（同 at）重复进来直接忽略。
  const applyUsage = (u, tsMs = 0) => {
    if (!u) return;
    const at = toNum(u.at);
    if (at && at <= lastUsageAt) return;
    if (at) lastUsageAt = at;

    const inputTokens = toNum(u.inputTokens);
    const cacheRead = toNum(u.cachedTokens);
    const output = toNum(u.outputTokens);
    const reasoning = toNum(u.reasoningTokens);
    const uncached = Math.max(0, inputTokens - cacheRead);

    // 模型用时：优先后端实测 durationMs；旧后端没带时用 SSE 到达时间兜底。
    let durationMs = toNum(u.durationMs);
    if (!(durationMs > 0) && tsMs && llmStartAt > 0 && tsMs >= llmStartAt) durationMs = tsMs - llmStartAt;
    if (!(durationMs > 0) || durationMs >= 3 * 60 * 60 * 1000) durationMs = 0;
    // 首 token 延迟：优先后端 ttftMs；否则用 stream_start 的时刻算。
    let ttftMs = toNum(u.ttftMs);
    if (!(ttftMs > 0) && tsMs && llmStartAt > 0 && llmFirstTokenAt >= llmStartAt && llmFirstTokenAt <= tsMs) {
      ttftMs = llmFirstTokenAt - llmStartAt;
    }
    if (!(ttftMs > 0) || (durationMs > 0 && ttftMs > durationMs)) ttftMs = 0;

    // 会话累计（页面重载清零）
    session.ready = true;
    session.uncachedInputTokens += uncached;
    session.cacheReadTokens += cacheRead;
    session.outputTokens += output;
    session.reasoningTokens += reasoning;
    if (durationMs > 0) {
      session.llmMs += durationMs;
      // DSH 的 decode 统计：输出 token ÷ 解码耗时（总耗时扣掉首 token 等待）
      if (ttftMs > 0) { session.decodeMs += Math.max(0, durationMs - ttftMs); session.decodeTokens += output; }
    }
    if (ttftMs > 0) { session.ttftMs += ttftMs; session.ttftSteps += 1; }

    // 本轮累计（message_received 清零）
    turn.ready = true;
    turn.uncachedInputTokens += uncached;
    turn.cacheReadTokens += cacheRead;
    turn.outputTokens += output;
    turn.reasoningTokens += reasoning;
    if (durationMs > 0) {
      turn.llmMs += durationMs;
      if (ttftMs > 0) { turn.decodeMs += Math.max(0, durationMs - ttftMs); turn.decodeTokens += output; }
    }
    if (ttftMs > 0) {
      turn.ttftSum += ttftMs;
      turn.ttftSteps += 1;
      // TurnTimePanel 的 ttftMs 是本轮单个延迟：取本轮第一次调用
      if (!turn.ttftMs) turn.ttftMs = ttftMs;
    }

    // 下一次调用的起点 = 本次调用结束（工具执行会另行重置）
    llmStartAt = tsMs || Date.now();
    llmFirstTokenAt = 0;

    paintSession();
    // 上下文占用是「最近一次 LLM 调用的 prompt 大小」，不是累计量，单独刷新
    lastPromptTokens = inputTokens;
    paintContext();
    // 把本轮真实用量写到最后一条回复的操作行上（原生标记，由 chat.js 渲染）
    const bar = lastJarvisBar();
    if (!bar) { paintTurnElapsed(); return; }
    const usage = bar.querySelector(".msg-usage");
    if (usage) {
      usage.dataset.total = formatExactTokens(totalTokensOf(turn));
      usage.hidden = false;
      const label = usage.querySelector("span");
      // 触发文案（参考图 E）：「用量 21M tok」
      if (label) label.textContent = `用量 ${fmtCompactTokens(totalTokensOf(turn))} tok`;
      const panel = panelOf(usage);
      setText(panel?.querySelector(".blm-turn-total"), countText(totalTokensOf(turn)));
      setText(panel?.querySelector(".blm-turn-model"), currentProviderModel());
      const hit = cacheHitOf(turn, 1);
      setText(panel?.querySelector(".blm-turn-hit"), hit === null ? "—" : `${hit}%`);
      setText(panel?.querySelector(".blm-turn-uncached"), countText(turn.uncachedInputTokens));
      setText(panel?.querySelector(".blm-turn-cacheread"), countText(turn.cacheReadTokens));
      const outEl = panel?.querySelector(".blm-turn-output");
      if (outEl) {
        const base = countText(turn.outputTokens);
        outEl.textContent = "";
        outEl.appendChild(document.createTextNode(base));
        if (turn.reasoningTokens > 0) {
          const r = document.createElement("span");
          r.className = "blm-stat-reasoning";
          r.textContent = `（其中推理 ${countText(turn.reasoningTokens)}）`;
          outEl.appendChild(r);
        }
      }
    }
    paintTurnElapsed();
  };
  // 当前提供方 / 模型（composer 模型下拉的 value 形如 provider::model）
  function currentProviderModel() {
    const raw = document.getElementById("composer-model")?.value || "";
    const idx = raw.indexOf("::");
    if (idx < 0) return "—";
    const provider = raw.slice(0, idx).trim();
    const model = raw.slice(idx + 2).trim();
    return provider && model ? `${provider}/${model}` : "—";
  }

  window.addEventListener("blm:sse", event => {
    const { type, data, ts } = event.detail || {};
    const tsMs = Date.parse(ts) || 0;
    // 工具开始：记起点，tool_call 到达时算出这次工具的真实耗时
    if (type === "tool_executing") {
      const name = String(data?.name || "");
      if (name) {
        const list = toolStarts.get(name) || [];
        list.push(tsMs || Date.now());
        if (list.length > 32) list.shift();
        toolStarts.set(name, list);
      }
      return;
    }
    // 首 token：stream_start 就是「第一个增量到达」的时刻，与 llmStartAt 的差即 TTFT
    if (type === "stream_start") {
      if (llmStartAt > 0 && !llmFirstTokenAt) llmFirstTokenAt = tsMs || Date.now();
      return;
    }
    if (type === "message_received") {
      // 用户轮开始：清零的是「本轮」，会话累计继续保留
      // DSH 的 turns = 不同用户轮的数量（deriveStats 3873/3901），所以只在这里 +1
      session.turns += 1;
      turn.ready = false;
      turn.steps = 0;
      turn.startMs = tsMs || Date.now();
      turn.endMs = 0;
      turn.llmMs = 0;
      turn.toolMs = 0;
      turn.ttftMs = 0;
      turn.ttftSum = 0;
      turn.ttftSteps = 0;
      turn.decodeMs = 0;
      turn.decodeTokens = 0;
      turn.uncachedInputTokens = 0;
      turn.cacheReadTokens = 0;
      turn.writeTokens = 0;
      turn.outputTokens = 0;
      turn.reasoningTokens = 0;
      lastUsageAt = 0;
      turnStart = turn.startMs;
      llmStartAt = turnStart;
      llmFirstTokenAt = 0;
      startElapsed();
      paintTurnElapsed();
      return;
    }
    if (type === "tool_call") {
      const name = String(data?.name || "");
      const list = name ? toolStarts.get(name) : null;
      const startedAt = Array.isArray(list) && list.length ? list.shift() : 0;
      const endedAt = tsMs || Date.now();
      if (startedAt > 0 && endedAt >= startedAt && endedAt - startedAt < 6 * 60 * 60 * 1000) {
        session.toolMs += endedAt - startedAt;
        turn.toolMs += endedAt - startedAt;
      }
      // 步数只算 assistant 步（DSH deriveStats 3886-3888：tool-result 节点 continue 掉），
      // 所以工具调用只累计耗时，不 +1 步。
      // 工具跑完模型立刻接着推理：下一次 LLM 调用的起点定在这里
      llmStartAt = endedAt;
      llmFirstTokenAt = 0;
      paintSession();
      paintTurnElapsed();
      return;
    }
    if (type === "llm_usage") {
      // DSH 的 steps = assistant 步数（deriveStats 3886-3888），一次 LLM 调用算一步
      session.steps += 1;
      applyUsage(data, tsMs);
      return;
    }
    if (type === "response" || (type === "message" && data && data.from === "consciousness")) {
      // 本轮定稿：停表，把本轮用时快照下来（冻结的用时芯片与它的弹卡共用这一份）
      if (turn.startMs) {
        if (!turn.endMs) turn.endMs = tsMs || Date.now();
        finishedTurn = {
          ms: Math.max(0, turn.endMs - turn.startMs),
          decodeMs: turn.decodeMs,
          decodeTokens: turn.decodeTokens,
          ttftMs: turn.ttftMs,
        };
      }
      stopElapsed();
      turnStart = 0;
      paintTurnElapsed();
      if (type === "message") {
        // SSE 万一漏了 llm_usage，这里用拉取式兜底补一次（同 at 会被去重）
        fetch(`${API}/usage-last`)
          .then(r => r.json())
          .then(j => applyUsage(j?.usage))
          .catch(() => {});
      }
      return;
    }
  });

  // 两个芯片的 tps 走会话累计（DSH TimePill 用 stats.decodeMs/decodeTokens），
  // 不再镜像流式实时的 #tok-rate —— 常显芯片与悬停面板必须是同一套口径。
  paintSession();
  paintContext();
  paintTurnElapsed();
  paintBalance();
  setInterval(paintBalance, 300000);
})();
/* ── 输入框工具按钮接线：＋ 添加图片附件 / ◍ 打开命令菜单 ────────────────
   这两个按钮此前只有 app-shell.js 里的 HTML，全库没有任何 JS 引用它们，
   点下去毫无反应（假壳）。现在接上真实链路：
   ＋ → 系统文件选择器 → chat.addAttachmentFiles()
        （复用粘贴图片那条本来就在跑的通路：pendingPastedImages → 缩略图 → payload.attachments）
   ◍ → chat.openCommandMenu() 弹出斜杠命令菜单，不必手打 "/" */
(function initComposerTools() {
  const addBtn = document.getElementById("composer-add");
  const toolBtn = document.getElementById("composer-tool");
  const fileInput = document.getElementById("composer-file-input");

  if (addBtn && fileInput) {
    addBtn.addEventListener("click", (event) => {
      event.preventDefault();
      fileInput.click();
    });
    fileInput.addEventListener("change", () => {
      const files = Array.from(fileInput.files || []);
      fileInput.value = "";   // 清空，允许连续选同一个文件
      if (!files.length) return;
      chat?.addAttachmentFiles?.(files);
    });
  }

  if (toolBtn) {
    toolBtn.addEventListener("click", (event) => {
      event.preventDefault();
      const menu = document.getElementById("slash-menu");
      if (menu && !menu.hidden) {
        menu.hidden = true;
        return;
      }
      chat?.openCommandMenu?.();
    });
  }
})();

// ── X 键召唤内置网页面板（2026-09-27 用户要求：网页没开也能一键弹出）──────────
// 单键快捷键的坑：焦点在输入框里时单字母会被输入框先吞掉，所以这里只在
// 「焦点不在可编辑元素上」且「不带任何修饰键」时才接管，避免废掉正常打字。
const BROWSER_EMBED_SUMMON_URL = "https://www.baidu.com";

function isEditableShortcutTarget(target) {
  if (!target || typeof target.closest !== "function") return false;
  if (target.isContentEditable) return true;
  return Boolean(
    target.closest("input, textarea, select, [contenteditable=''], [contenteditable='true']"),
  );
}

function browserEmbedPanelVisible() {
  return browserPreviewActive && browserPreviewDisplayMode === "window";
}

function toggleBrowserEmbedPanel() {
  if (!browserEmbedBridge) return;
  if (browserEmbedPanelVisible()) {
    hideBrowserPreview();
    return;
  }
  void showNativeBrowserWindow({
    url: browserPreviewNativeUrl || BROWSER_EMBED_SUMMON_URL,
    transition: false,
  });
}

window.addEventListener(
  "keydown",
  (event) => {
    if (event.defaultPrevented || event.repeat) return;
    if (event.ctrlKey || event.metaKey || event.altKey || event.shiftKey) return;
    if (event.key !== "x" && event.key !== "X") return;
    if (isEditableShortcutTarget(event.target)) return;
    event.preventDefault();
    toggleBrowserEmbedPanel();
  },
  true,
);
