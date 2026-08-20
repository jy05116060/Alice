import { API } from "./api-client.js";
import {
  attachJarvisFx,
  getJarvisFxParams,
  isFxEnabledForVoice,
  isFxUnlocked,
  resetJarvisFxParams,
  setFxEnabledForVoice,
  setJarvisFxParams,
  tryUnlockFx,
} from "./tts-fx.js";
import {
  applyOutputSink,
  getOutputPreference,
  listOutputDevices,
  setOutputPreference,
} from "./audio-output.js";
import { getLocale, setLocale, t } from "./i18n/index.js";

export function initSettings({
  defaultAgentName,
  getAgentName,
  setAgentName,
  getTtsStreamingEnabled,
  setTtsStreamingEnabled,
  getTtsVoiceId,
  setTtsVoiceId,
  setOpenSettings,
  // app.js 里维护着「意识心跳」面板的展示状态（默认间隔 / 连接指示）。保存成功后
  // 必须回调它，否则 settings.js 这边会 ReferenceError → 前端报「自动保存失败」，
  // 尽管后端其实已经存成功了。
  applyHeartbeatConfig = () => {},
} = {}) {
const themeSwitcher = document.getElementById("theme-switcher");
const uiLanguageSelect = document.getElementById("settings-ui-language");
const MEMORY_GRAPH_STORAGE_KEY = "alice-memory-graph-enabled";
const VOICE_SPACE_PTT_KEY = "alice-voice-space-ptt-enabled";
const IGNORED_VERSION_KEY = "alice_ignored_update_version";
const SUPPRESS_UPDATES_KEY = "alice_suppress_update_notifications";
if (uiLanguageSelect) {
  uiLanguageSelect.value = getLocale();
  uiLanguageSelect.addEventListener("change", async () => {
    if (uiLanguageSelect.value === getLocale()) return;
    setLocale(uiLanguageSelect.value);
    try {
      await globalThis.alice?.setUiLanguage?.(uiLanguageSelect.value);
    } catch (error) {
      console.warn("[settings] failed to sync the native UI language:", error?.message || error);
    }
    globalThis.location?.reload?.();
  });
}
// ── TTS settings panel init ───────────────────────────────────────────────────
function updateSecretVisibility(input, toggle, visible, label = "API Key") {
  const isVisible = Boolean(visible);
  if (input) input.type = isVisible ? "text" : "password";
  if (toggle) {
    const action = isVisible ? "隐藏" : "显示";
    toggle.dataset.visible = String(isVisible);
    toggle.setAttribute("aria-label", `${action} ${label}`);
    toggle.title = `${action} ${label}`;
  }
}

function initTTSSettings({ createAutosave, feedback } = {}) {
  const providerSel = document.getElementById("tts-provider-select");
  const voiceSel    = document.getElementById("tts-voice-select");
  const testBtn     = document.getElementById("tts-test-btn");
  const testStatus  = document.getElementById("tts-test-status");
  const fxToggle    = document.getElementById("tts-fx-toggle");
  const doubaoKeyInput = document.getElementById("tts-doubao-key");
  const doubaoKeyToggle = document.getElementById("tts-doubao-key-toggle");
  if (!providerSel) return;

  let doubaoKeyVisible = false;
  function setDoubaoKeyVisible(visible) {
    doubaoKeyVisible = Boolean(visible);
    updateSecretVisibility(doubaoKeyInput, doubaoKeyToggle, doubaoKeyVisible);
  }
  doubaoKeyToggle?.addEventListener("click", () => setDoubaoKeyVisible(!doubaoKeyVisible));

  // 流式合成开关（默认开）：纯播放行为，存在 localStorage
  const streamingToggle = document.getElementById("tts-streaming-toggle");
  if (streamingToggle) {
    streamingToggle.checked = getTtsStreamingEnabled();
    streamingToggle.addEventListener("change", () => {
      setTtsStreamingEnabled(streamingToggle.checked);
      ttsAutosave?.schedule({ immediate: true });
    });
  }

  let allVoices = {};
  let ttsAutosave = null;

  // ── 机器人音效：开关 + 滑块面板 ──
  const fxSlidersBox = document.getElementById("tts-fx-sliders");
  // 滑块对应的参数键，及数值显示精度
  const FX_SLIDERS = [
    { key: "wet",              digits: 2 },
    { key: "reverbSeconds",    digits: 1 },
    { key: "driveMix",         digits: 2 },
    { key: "metallic",         digits: 2 },
    { key: "ring",             digits: 2 },
    { key: "chorus",           digits: 2 },
    { key: "metallicFeedback", digits: 2 },
    { key: "metallicDelayMs",  digits: 1 },
    { key: "ringHz",           digits: 0 },
  ];

  function loadFxSliders() {
    const p = getJarvisFxParams();
    for (const s of FX_SLIDERS) {
      const el = document.getElementById(`tts-fx-${s.key}`);
      const val = document.getElementById(`tts-fx-${s.key}-val`);
      const v = Number(p[s.key] ?? 0);
      if (el) el.value = v;
      if (val) val.textContent = v.toFixed(s.digits);
    }
  }

  for (const s of FX_SLIDERS) {
    const el = document.getElementById(`tts-fx-${s.key}`);
    const val = document.getElementById(`tts-fx-${s.key}-val`);
    if (!el) continue;
    el.addEventListener("input", () => {
      const v = parseFloat(el.value);
      setJarvisFxParams({ [s.key]: v });
      if (val) val.textContent = v.toFixed(s.digits);
      ttsAutosave?.schedule();
    });
  }

  const fxReset = document.getElementById("tts-fx-reset");
  if (fxReset) {
    fxReset.addEventListener("click", () => { resetJarvisFxParams(); loadFxSliders(); });
  }

  // 语速滑块（豆包 speech_rate，-50~100，0=正常）：显示更新；存档走保存/试听
  const fmtRate = (r) => (r === 0 ? "正常" : (r > 0 ? "+" + r : String(r)));
  const doubaoRateEl = document.getElementById("tts-doubao-rate");
  const doubaoRateVal = document.getElementById("tts-doubao-rate-val");
  if (doubaoRateEl) {
    doubaoRateEl.addEventListener("input", () => {
      if (doubaoRateVal) doubaoRateVal.textContent = fmtRate(parseInt(doubaoRateEl.value, 10) || 0);
      ttsAutosave?.schedule();
    });
    doubaoRateEl.addEventListener("change", () => ttsAutosave?.schedule({ immediate: true }));
  }

  // 付费解锁
  const fxLockBox = document.getElementById("tts-fx-lock");
  const fxPwInput = document.getElementById("tts-fx-pw");
  const fxUnlockBtn = document.getElementById("tts-fx-unlock");
  const fxUnlockMsg = document.getElementById("tts-fx-unlock-msg");

  // 机器人音效开关跟随当前选中的音色；未解锁则禁用开关+显示付费提示；解锁且开启时展开滑块
  function syncFxToggle() {
    const unlocked = isFxUnlocked();
    const on = unlocked && isFxEnabledForVoice(voiceSel?.value);
    if (fxToggle) { fxToggle.checked = on; fxToggle.disabled = !unlocked; }
    if (fxSlidersBox) fxSlidersBox.style.display = on ? "flex" : "none";
    if (fxLockBox) fxLockBox.style.display = unlocked ? "none" : "flex";
  }
  if (fxToggle) {
    fxToggle.addEventListener("change", () => {
      if (!isFxUnlocked()) { fxToggle.checked = false; syncFxToggle(); return; }
      setFxEnabledForVoice(voiceSel?.value, fxToggle.checked);
      if (fxSlidersBox) fxSlidersBox.style.display = fxToggle.checked ? "flex" : "none";
      ttsAutosave?.schedule({ immediate: true });
    });
  }
  if (fxUnlockBtn) {
    fxUnlockBtn.addEventListener("click", () => {
      const res = tryUnlockFx(fxPwInput?.value?.trim() || "");
      if (fxUnlockMsg) {
        fxUnlockMsg.textContent = res.ok ? "已解锁 ✓ 现在可以开启机器人音效了" : res.reason;
        fxUnlockMsg.style.color = res.ok ? "#3ba55d" : "#e05050";
      }
      if (res.ok) syncFxToggle();
    });
  }
  if (voiceSel) {
    voiceSel.addEventListener("change", () => {
      syncFxToggle();
      ttsAutosave?.schedule({ immediate: true });
    });
  }
  loadFxSliders();
  syncFxToggle();

  const credSections = {
    doubao:     document.getElementById("tts-creds-doubao"),
    minimax:    document.getElementById("tts-creds-minimax"),
    openai:     document.getElementById("tts-creds-openai"),
    elevenlabs: document.getElementById("tts-creds-elevenlabs"),
    volcano:    document.getElementById("tts-creds-volcano"),
  };

  function showCredSection(provider) {
    Object.entries(credSections).forEach(([k, el]) => {
      if (el) el.style.display = k === provider ? "" : "none";
    });
  }

  function updateVoiceOptions(provider, savedId) {
    if (!voiceSel) return;
    const voices = allVoices[provider] || [];
    voiceSel.innerHTML = voices.map(v =>
      `<option value="${v.id}">${v.label}</option>`
    ).join("");
    if (savedId && voices.some(v => v.id === savedId)) {
      voiceSel.value = savedId;
    }
    syncFxToggle();
  }

  providerSel.addEventListener("change", () => {
    showCredSection(providerSel.value);
    updateVoiceOptions(providerSel.value);
    ttsAutosave?.schedule({ immediate: true });
  });

  fetch(`${API}/settings/tts`).then(r => r.json()).then(({ tts, voices }) => {
    if (voices) allVoices = voices;
    const provider = tts?.ttsProvider || "doubao";
    if (tts?.ttsProvider) providerSel.value = tts.ttsProvider;
    else providerSel.value = "doubao";
    updateVoiceOptions(provider, tts?.ttsVoiceId);
    setTtsVoiceId(voiceSel?.value || tts?.ttsVoiceId || null);
    const appidEl = document.getElementById("tts-volcano-appid");
    if (appidEl && tts?.volcanoAppId?.value) appidEl.value = tts.volcanoAppId.value;
    if (doubaoKeyInput) doubaoKeyInput.value = typeof tts?.doubaoKey?.value === "string" ? tts.doubaoKey.value : "";
    const doubaoResourceEl = document.getElementById("tts-doubao-resource");
    if (doubaoResourceEl && tts?.doubaoResourceId) doubaoResourceEl.value = tts.doubaoResourceId;
    const rateEl = document.getElementById("tts-doubao-rate");
    if (rateEl) {
      const receivedRate = Number(tts?.doubaoSpeechRate ?? 20);
      const r = Number.isFinite(receivedRate) ? receivedRate : 20;
      rateEl.value = r;
      const rv = document.getElementById("tts-doubao-rate-val");
      if (rv) rv.textContent = r === 0 ? "正常" : (r > 0 ? "+" + r : String(r));
    }
    const baseurlEl = document.getElementById("tts-openai-baseurl");
    if (baseurlEl && tts?.openaiTtsBaseURL) baseurlEl.value = tts.openaiTtsBaseURL;
    showCredSection(provider);
  }).catch(() => {});

  showCredSection(providerSel.value);

  function collectTTSBody() {
    const body = { ttsProvider: providerSel.value };
    const voiceId = voiceSel?.value?.trim();
    if (voiceId) body.ttsVoiceId = voiceId;
    const fields = [
      ["tts-minimax-key", "minimaxKey"],
      ["tts-doubao-key", "doubaoKey"],
      ["tts-doubao-resource", "doubaoResourceId"],
      ["tts-openai-key", "openaiTtsKey"],
      ["tts-openai-baseurl", "openaiTtsBaseURL"],
      ["tts-elevenlabs-key", "elevenLabsKey"],
      ["tts-volcano-appid", "volcanoAppId"],
      ["tts-volcano-token", "volcanoToken"],
    ];
    for (const [id, key] of fields) {
      const value = document.getElementById(id)?.value?.trim();
      if (value) body[key] = value;
    }
    const rate = document.getElementById("tts-doubao-rate")?.value;
    if (rate != null) body.doubaoSpeechRate = rate;
    return body;
  }

  if (createAutosave) {
    ttsAutosave = createAutosave(async () => {
      const body = collectTTSBody();
      const response = await fetch(`${API}/settings/tts`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });
      const data = await response.json().catch(() => ({}));
      if (!response.ok || !data.ok) throw new Error(data.error || "语音合成配置保存失败");
      setTtsVoiceId(body.ttsVoiceId || getTtsVoiceId());
      const secretFields = ["tts-minimax-key", "tts-openai-key", "tts-elevenlabs-key", "tts-volcano-token"];
      for (const id of secretFields) {
        const el = document.getElementById(id);
        const bodyKey = {
          "tts-minimax-key": "minimaxKey",
          "tts-openai-key": "openaiTtsKey",
          "tts-elevenlabs-key": "elevenLabsKey",
          "tts-volcano-token": "volcanoToken",
        }[id];
        if (el && body[bodyKey] && el.value.trim() === body[bodyKey]) el.value = "";
      }
      return { message: "语音合成配置已自动保存" };
    }, { feedback });

    const ttsTextInputs = [
      "tts-minimax-key",
      "tts-doubao-key",
      "tts-doubao-resource",
      "tts-openai-key",
      "tts-openai-baseurl",
      "tts-elevenlabs-key",
      "tts-volcano-appid",
      "tts-volcano-token",
    ].map(id => document.getElementById(id)).filter(Boolean);
    for (const el of ttsTextInputs) {
      el.addEventListener("input", () => ttsAutosave.schedule());
      el.addEventListener("blur", () => ttsAutosave.schedule({ immediate: true }));
    }
  }

  if (testBtn) {
    testBtn.addEventListener("click", async () => {
      testBtn.disabled = true;
      if (testStatus) testStatus.textContent = "保存配置中…";
      try {
        const preBody = { ttsProvider: providerSel.value };
        const currentVoice = voiceSel?.value?.trim();
        if (currentVoice) { preBody.ttsVoiceId = currentVoice; setTtsVoiceId(currentVoice); }
        const minimaxKey2 = document.getElementById("tts-minimax-key")?.value?.trim();
        if (minimaxKey2) preBody.minimaxKey = minimaxKey2;
        const doubaoKey = document.getElementById("tts-doubao-key")?.value?.trim();
        if (doubaoKey) preBody.doubaoKey = doubaoKey;
        const doubaoResource = document.getElementById("tts-doubao-resource")?.value?.trim();
        if (doubaoResource) preBody.doubaoResourceId = doubaoResource;
        const rateEl3 = document.getElementById("tts-doubao-rate");
        if (rateEl3) preBody.doubaoSpeechRate = rateEl3.value;
        const openaiKey = document.getElementById("tts-openai-key")?.value?.trim();
        if (openaiKey) preBody.openaiTtsKey = openaiKey;
        const elevenKey = document.getElementById("tts-elevenlabs-key")?.value?.trim();
        if (elevenKey) preBody.elevenLabsKey = elevenKey;
        const volcanoAppId = document.getElementById("tts-volcano-appid")?.value?.trim();
        if (volcanoAppId) preBody.volcanoAppId = volcanoAppId;
        const volcanoToken = document.getElementById("tts-volcano-token")?.value?.trim();
        if (volcanoToken) preBody.volcanoToken = volcanoToken;
        await fetch(`${API}/settings/tts`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(preBody),
        });
        if (testStatus) testStatus.textContent = "合成中…";
        const ttsResp = await fetch(`${API}/tts/stream`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ text: "你好，这是一段语音合成测试，听起来清晰自然吗？" }),
        });
        if (!ttsResp.ok) {
          let errMsg = `合成失败（HTTP ${ttsResp.status}）`;
          try { const j = await ttsResp.json(); errMsg = j.error || errMsg; } catch {}
          if (testStatus) testStatus.textContent = errMsg;
          return;
        }
        const ttsBlob = await ttsResp.blob();
        if (ttsBlob.size === 0) {
          if (testStatus) testStatus.textContent = "合成失败：接口返回空数据，请检查 API Key 和账户配置。";
          return;
        }
        const ttsUrl = URL.createObjectURL(ttsBlob);
        const ttsAudio = new Audio(ttsUrl);
        attachJarvisFx(ttsAudio, voiceSel?.value || getTtsVoiceId()); // 试听按当前选中音色的开关决定是否叠加
        ttsAudio.onended = () => { URL.revokeObjectURL(ttsUrl); if (testStatus) testStatus.textContent = ""; };
        ttsAudio.onerror = () => { URL.revokeObjectURL(ttsUrl); if (testStatus) testStatus.textContent = "播放失败"; };
        await applyOutputSink(ttsAudio).catch(() => {}); // 试听也走同一输出路由
        await ttsAudio.play();
        if (testStatus) testStatus.textContent = "播放中";
        setTimeout(() => { if (testStatus && testStatus.textContent === "播放中") testStatus.textContent = ""; }, 8000);
      } catch {
        if (testStatus) testStatus.textContent = "失败 — 请检查配置和 API Key";
      } finally {
        testBtn.disabled = false;
      }
    });
  }
}

// ── Settings modal ──
(function initSettings() {
  const settingsBtn     = document.getElementById("settings-btn");
  const overlay         = document.getElementById("settings-overlay");
  const closeBtn        = document.getElementById("settings-close");
  const autosaveStatus  = document.getElementById("settings-autosave-status");
  const autosaveStatusText = document.getElementById("settings-autosave-status-text");
  const providerSelect  = document.getElementById("settings-provider-select");
  const modelSelect     = document.getElementById("settings-model-select");
  const officialCustomModelInput = document.getElementById("settings-official-custom-model");
  const llmKeyInput     = document.getElementById("settings-llm-key");
  const llmKeyToggle    = document.getElementById("settings-llm-key-toggle");
  const llmFeedback     = document.getElementById("settings-llm-feedback");
  const agentNameInput  = document.getElementById("settings-agent-name");
  const agentNameFeedback = document.getElementById("settings-agent-name-feedback");
  const tempSlider      = document.getElementById("settings-temperature");
  const tempVal         = document.getElementById("settings-temperature-val");
  const tempFeedback    = document.getElementById("settings-temperature-feedback");
  const thinkingToggle  = document.getElementById("settings-thinking");
  const thinkingFeedback = document.getElementById("settings-thinking-feedback");
  const contextRange = document.getElementById("settings-context-range");
  const chatContextSlider = document.getElementById("settings-chat-context-limit");
  const chatContextVal = document.getElementById("settings-chat-context-limit-val");
  const toolContextSlider = document.getElementById("settings-tool-context-limit");
  const toolContextVal = document.getElementById("settings-tool-context-limit-val");
  const contextWindowFeedback = document.getElementById("settings-context-window-feedback");
  const minimaxKeyInput = document.getElementById("settings-minimax-key");
  const minimaxFeedback = document.getElementById("settings-minimax-feedback");
  const socialFeedback  = document.getElementById("settings-social-feedback");
  const voiceFeedback   = document.getElementById("settings-voice-feedback");
  const voiceThreshSlider = document.getElementById("settings-voice-threshold");
  const voiceThreshVal    = document.getElementById("settings-voice-threshold-val");
  const voiceMicSelect    = document.getElementById("voice-mic-select");
  const voiceRefreshMicsBtn = document.getElementById("voice-refresh-mics");
  const voiceMicStatus    = document.getElementById("voice-mic-status");
  const voiceOutputSelect    = document.getElementById("voice-output-select");
  const voiceRefreshOutputsBtn = document.getElementById("voice-refresh-outputs");
  const voiceOutputStatus    = document.getElementById("voice-output-status");
  const volcAsrKeyInput      = document.getElementById("voice-volc-apikey");
  const volcAsrKeyToggle     = document.getElementById("voice-volc-apikey-toggle");
  const mapKeyInput          = document.getElementById("settings-amap-key");
  const mapKeyToggle         = document.getElementById("settings-amap-key-toggle");
  const mapSecurityInput     = document.getElementById("settings-amap-security");
  const mapSecurityToggle    = document.getElementById("settings-amap-security-toggle");
  const clearMapBtn          = document.getElementById("settings-clear-map");
  const mapFeedback          = document.getElementById("settings-map-feedback");
  const heartbeatToggle      = document.getElementById("settings-heartbeat-enabled");
  const heartbeatInterval    = document.getElementById("settings-heartbeat-interval");
  const heartbeatFeedback    = document.getElementById("settings-heartbeat-feedback");

  if (!settingsBtn || !overlay) return;

  let cachedProviders = null;
  let cachedMinimax = { configured: false };

  function syncContextWindowControls(changed = "load") {
    let chatMessageLimit = Math.min(40, Math.max(1, Number(chatContextSlider?.value) || 20));
    let toolCallLimit = Math.min(40, Math.max(0, Number(toolContextSlider?.value) || 0));
    if (toolCallLimit >= chatMessageLimit) {
      toolCallLimit = Math.max(0, chatMessageLimit - 1);
    }
    if (chatContextSlider) chatContextSlider.value = String(chatMessageLimit);
    if (toolContextSlider) {
      toolContextSlider.value = String(toolCallLimit);
      toolContextSlider.setAttribute("aria-valuemax", String(Math.max(0, chatMessageLimit - 1)));
    }
    if (chatContextVal) chatContextVal.textContent = t("format.items", { count: chatMessageLimit });
    if (toolContextVal) toolContextVal.textContent = t("format.items", { count: toolCallLimit });
    if (contextRange) {
      contextRange.style.setProperty("--chat-context-position", `${chatMessageLimit / 40 * 100}%`);
      contextRange.style.setProperty("--tool-context-position", `${toolCallLimit / 40 * 100}%`);
      contextRange.dataset.activeHandle = changed;
    }
  }
  let cachedLlm = null;
  let llmKeyVisible = false;
  let volcAsrKeyVisible = false;
  const agentNameRe = /^[一-龥A-Za-z0-9 _-]+$/;
  const CUSTOM_MODEL_VALUE = "__custom_model__";
  const feedbackTimers = new WeakMap();
  const autosaveControllers = new Set();
  const autosaveErrors = new Map();
  let activeAutosaves = 0;
  let autosaveIdleTimer = null;

  overlay.querySelectorAll(".settings-nav-item").forEach(btn => {
    btn.addEventListener("click", () => {
      overlay.querySelectorAll(".settings-nav-item").forEach(b => b.classList.remove("active"));
      overlay.querySelectorAll(".settings-tab").forEach(t => t.classList.remove("active"));
      btn.classList.add("active");
      const tab = btn.dataset.tab;
      overlay.querySelector(`.settings-tab[data-tab="${tab}"]`)?.classList.add("active");
      if (tab === "social") loadSocialSettings();
      if (tab === "security") loadSecuritySettings();
      if (tab === "mcp") loadMcpSettings();
      if (tab === "advanced") {
        loadHeartbeatSettings();
        loadMapSettings();
      }
      if (tab === "update") loadUpdateSettings();
    });
  });

  function showFeedback(el, msg, isError = false, { persistent = isError } = {}) {
    if (!el) return;
    const previousTimer = feedbackTimers.get(el);
    if (previousTimer) clearTimeout(previousTimer);
    el.textContent = msg;
    el.className = "settings-feedback" + (isError ? " error" : "");
    if (!persistent && msg) {
      const timer = setTimeout(() => {
        el.textContent = "";
        el.className = "settings-feedback";
        feedbackTimers.delete(el);
      }, 3000);
      feedbackTimers.set(el, timer);
    }
  }

  function setAutosaveStatus(state, text) {
    if (autosaveStatus) autosaveStatus.dataset.state = state;
    if (autosaveStatusText) autosaveStatusText.textContent = text;
  }

  function refreshAutosaveStatus({ recentlySaved = false } = {}) {
    if (autosaveIdleTimer) {
      clearTimeout(autosaveIdleTimer);
      autosaveIdleTimer = null;
    }
    if (activeAutosaves > 0) {
      setAutosaveStatus("saving", "正在保存…");
      return;
    }
    if (autosaveErrors.size > 0) {
      setAutosaveStatus("error", "自动保存失败 · 请检查");
      return;
    }
    if (recentlySaved) {
      setAutosaveStatus("saved", "已自动保存");
      autosaveIdleTimer = setTimeout(() => {
        setAutosaveStatus("idle", "所有更改自动保存");
        autosaveIdleTimer = null;
      }, 2200);
      return;
    }
    setAutosaveStatus("idle", "所有更改自动保存");
  }

  function createSettingsAutosave(save, {
    delay = 700,
    feedback = null,
    pendingMessage = "正在保存…",
    successMessage = "已自动保存",
  } = {}) {
    let timer = null;
    let running = false;
    let queued = false;
    let pending = false;

    const controller = {
      schedule({ immediate = false } = {}) {
        pending = true;
        if (running) {
          queued = true;
          return;
        }
        if (timer) clearTimeout(timer);
        if (immediate) {
          timer = null;
          void controller.flush();
        } else {
          timer = setTimeout(() => {
            timer = null;
            void controller.flush();
          }, delay);
        }
      },
      async flush() {
        if (timer) {
          clearTimeout(timer);
          timer = null;
        }
        if (running) {
          queued = true;
          return;
        }
        if (!pending && !queued) return;
        running = true;
        let didSave = false;
        do {
          queued = false;
          pending = false;
          activeAutosaves += 1;
          showFeedback(feedback, pendingMessage, false, { persistent: true });
          refreshAutosaveStatus();
          try {
            const result = await save();
            if (result?.skipped) {
              showFeedback(feedback, result.message || "", false, { persistent: Boolean(result.message) });
            } else {
              autosaveErrors.delete(controller);
              showFeedback(feedback, result?.message || successMessage);
              didSave = true;
            }
          } catch (error) {
            const message = error?.message || "自动保存失败";
            autosaveErrors.set(controller, message);
            showFeedback(feedback, message, true);
          } finally {
            activeAutosaves = Math.max(0, activeAutosaves - 1);
          }
        } while (queued || pending);
        running = false;
        refreshAutosaveStatus({ recentlySaved: didSave && !autosaveErrors.has(controller) });
      },
    };
    autosaveControllers.add(controller);
    return controller;
  }

  function bindDebouncedAutosave(elements, controller, { event = "input" } = {}) {
    for (const el of elements.filter(Boolean)) {
      el.addEventListener(event, () => controller.schedule());
      if (event === "input") {
        el.addEventListener("blur", () => controller.schedule({ immediate: true }));
      }
    }
  }

  function flushPendingAutosaves() {
    for (const controller of autosaveControllers) {
      void controller.flush();
    }
  }

  const localPreferenceAutosave = createSettingsAutosave(async () => ({
    message: "界面偏好已自动保存",
  }), { delay: 0 });

  themeSwitcher?.querySelectorAll(".theme-dot").forEach(el => {
    el.addEventListener("click", () => localPreferenceAutosave.schedule({ immediate: true }));
  });

  function refreshConfigSummary({ llm, minimax }) {
    const cfgLlm = document.getElementById("settings-cfg-llm");
    const cfgLlmDot = document.getElementById("settings-cfg-llm-dot");
    const cfgMedia = document.getElementById("settings-cfg-media");
    const cfgMediaDot = document.getElementById("settings-cfg-media-dot");
    if (cfgLlm) cfgLlm.textContent = `${llm.provider || "—"} · ${llm.model || "—"} · ${llm.apiFormat || "responses"}`;
    if (cfgLlmDot) {
      cfgLlmDot.textContent = "●";
      cfgLlmDot.className = `settings-config-dot ${llm.activated ? "active" : "inactive"}`;
      cfgLlmDot.title = llm.activated ? "Running" : "Inactive";
    }
    // 媒体通道那一行：以前只显示 minimax configured / not configured。
    // 现在后端会告诉我们「这个 key 看起来不是 MiniMax 的」，必须把这句话显示出来 ——
    // 否则用户面对的就是「明明显示已配置，生图却一直失败」，无从判断。
    if (cfgMedia) {
      const mismatch = minimax?.suspected_mismatch;
      // imageProvider 是后端算出来的「生图实际走谁」，比我们本地拼更权威
      const actual = vankitSnapshot?.imageProvider || (minimax?.configured ? "minimax" : null);
      const mmText = minimax?.configured ? "configured" : "not configured";
      cfgMedia.textContent = `minimax · ${mmText}`;
      if (actual) cfgMedia.textContent += ` · 生图走 ${actual}`;
      if (mismatch) {
        cfgMedia.textContent += ` · ⚠ ${mismatch.reason}`;
        cfgMedia.title = mismatch.reason;
      } else {
        cfgMedia.title = "";
      }
    }
    if (cfgMediaDot) {
      const mismatch = minimax?.suspected_mismatch;
      cfgMediaDot.textContent = "●";
      // 填错的 key 不能显示成绿色（那会让人以为能用了）
      cfgMediaDot.className = `settings-config-dot ${mismatch ? "inactive" : (minimax?.configured ? "active" : "inactive")}`;
      cfgMediaDot.title = mismatch ? "密钥疑似填错" : (minimax?.configured ? "Running" : "Inactive");
    }
  }

  function escapeHtml(text) {
    return String(text ?? "")
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;")
      .replace(/"/g, "&quot;")
      .replace(/'/g, "&#39;");
  }

  function syncOfficialCustomModelRow() {
    const customRow = document.getElementById("settings-official-custom-model-row");
    if (!customRow || !modelSelect) return;
    customRow.style.display = modelSelect.value === CUSTOM_MODEL_VALUE ? "" : "none";
  }

  function populateModelSelect(models, current) {
    if (!modelSelect || !models) return;
    const list = Array.isArray(models) ? models.filter(m => m?.id) : [];
    const currentModel = String(current || "").trim();
    const hasCurrent = currentModel && list.some(m => m.id === currentModel);
    modelSelect.innerHTML = list
      .map(m => `<option value="${escapeHtml(m.id)}"${m.deprecated ? " data-deprecated" : ""}>${escapeHtml(m.label || m.id)}</option>`)
      .concat(`<option value="${CUSTOM_MODEL_VALUE}">手动输入模型名…</option>`)
      .join("");
    if (hasCurrent) {
      modelSelect.value = currentModel;
      if (officialCustomModelInput) officialCustomModelInput.value = "";
    } else if (currentModel) {
      modelSelect.value = CUSTOM_MODEL_VALUE;
      if (officialCustomModelInput) officialCustomModelInput.value = currentModel;
    }
    syncOfficialCustomModelRow();
  }

  function populateProviderSelect(providers, current) {
    if (!providerSelect || !providers) return;
    const selected = current || providerSelect.value || "auto";
    const options = [`<option value="auto">Auto-detect</option>`]
      .concat(Object.entries(providers).map(([id, provider]) => {
        const label = provider.label || id;
        return `<option value="${escapeHtml(id)}">${escapeHtml(label)}</option>`;
      }));
    providerSelect.innerHTML = options.join("");
    providerSelect.value = providers[selected] || selected === "auto" ? selected : "auto";
  }

  function setLlmKeyVisible(visible) {
    llmKeyVisible = Boolean(visible);
    updateSecretVisibility(llmKeyInput, llmKeyToggle, llmKeyVisible);
  }

  function getProviderConfigForUI(provider, llm = cachedLlm) {
    const summary = cachedProviders?.[provider] || {};
    if (llm && provider === llm.provider) {
      return {
        ...summary,
        ...llm,
        apiKey: llm.apiKey ?? summary.apiKey ?? "",
      };
    }
    return summary;
  }

  function applyCustomProviderUI(providerOrLlm) {
    const provider = typeof providerOrLlm === "string"
      ? providerOrLlm
      : (providerOrLlm?.provider || "auto");
    const providerCfg = getProviderConfigForUI(provider, typeof providerOrLlm === "object" ? providerOrLlm : cachedLlm);
    const customSection = document.getElementById("settings-custom-llm-section");
    const modelRow = document.getElementById("settings-model-row");
    const officialCustomModelRow = document.getElementById("settings-official-custom-model-row");
    if (provider === "auto") {
      if (customSection) customSection.style.display = "none";
      if (modelRow) modelRow.style.display = "none";
      if (officialCustomModelRow) officialCustomModelRow.style.display = "none";
      if (llmKeyInput) llmKeyInput.value = "";
      setLlmKeyVisible(false);
      return;
    }
    if (provider === "custom") {
      if (customSection) customSection.style.display = "";
      if (modelRow) modelRow.style.display = "none";
      if (officialCustomModelRow) officialCustomModelRow.style.display = "none";
      const baseUrlEl = document.getElementById("settings-custom-baseurl");
      const modelEl = document.getElementById("settings-custom-model");
      if (baseUrlEl) baseUrlEl.value = providerCfg.baseURL || "";
      if (modelEl) modelEl.value = providerCfg.model || "";
    } else {
      if (customSection) customSection.style.display = "none";
      if (modelRow) modelRow.style.display = "";
      if (cachedProviders?.[provider]) {
        populateModelSelect(
          cachedProviders[provider].models,
          providerCfg.model || cachedProviders[provider].defaultModel,
        );
      }
    }
    if (llmKeyInput) llmKeyInput.value = providerCfg.apiKey || "";
    setLlmKeyVisible(false);
  }

  // VANKIT 图像端点的「上次已保存值」快照。
  // 必须在 loadSettings() 之前声明：loadSettings 会回填它（`let` 在 TDZ 里读会抛错）。
  // 用途：① 判断「用户到底改没改」——没改就不该因为打开设置页而触发一次保存；
  //       ② 顶部配置摘要要显示「生图实际走谁」，需要 configured。
  let vankitSnapshot = { apiKey: "", baseURL: "", model: "", configured: false, imageProvider: null };

  async function loadSettings() {
    try {
      const data = await fetch(`${API}/settings`).then(r => r.json());
      const { llm, minimax, providers } = data;
      if (providers) cachedProviders = providers;
      cachedLlm = llm;
      cachedMinimax = minimax || { configured: false };
      if (agentNameInput) agentNameInput.value = data.agent_name || getAgentName() || defaultAgentName;
      // 先回填 vankit 快照，再刷新摘要 —— 摘要要用 imageProvider 显示「生图走谁」，
      // 顺序反了就会先画一次「没有可用通道」的错误状态。
      if (data.vankit) {
        vankitSnapshot = {
          apiKey: "",
          baseURL: data.vankit.baseURL || "",
          model: data.vankit.model || "",
          configured: Boolean(data.vankit.configured),
          imageProvider: data.vankit.imageProvider || null,
        };
      }
      refreshConfigSummary({ llm, minimax });
      populateProviderSelect(providers, llm.provider || "auto");
      if (providerSelect && llm.provider) providerSelect.value = llm.provider;
      applyCustomProviderUI(llm);
      if (typeof llm.temperature === "number" && tempSlider) {
        tempSlider.value = String(llm.temperature);
        if (tempVal) tempVal.textContent = llm.temperature.toFixed(2);
      }
      if (thinkingToggle) thinkingToggle.checked = llm.thinking === true;
      const contextWindow = llm.contextWindow || {};
      const chatMessageLimit = Number(contextWindow.chatMessageLimit) || 20;
      const toolCallLimit = Number.isInteger(Number(contextWindow.toolCallLimit))
        ? Number(contextWindow.toolCallLimit)
        : 5;
      if (chatContextSlider) chatContextSlider.value = String(chatMessageLimit);
      if (toolContextSlider) toolContextSlider.value = String(toolCallLimit);
      syncContextWindowControls();

      // VANKIT 图像端点：回填地址与模型（密钥不回显明文，留空即「不修改」）。
      // 不回填的话，打开设置页看到的是空框，用户会以为根本没配过。
      const vk = data.vankit;
      if (vk) {
        const vkKey = document.getElementById("settings-vankit-key");
        const vkURL = document.getElementById("settings-vankit-baseurl");
        const vkModel = document.getElementById("settings-vankit-model");
        if (vkURL) vkURL.value = vk.baseURL || "";
        if (vkModel) vkModel.value = vk.model || "";
        if (vkKey) {
          vkKey.value = "";
          vkKey.placeholder = vk.configured ? "已保存，留空则不修改" : "填入 VANKIT API Key…";
        }
        // 注意：vankitSnapshot 已在上面（刷新摘要之前）回填过，这里只处理输入框。
      }
    } catch {}
  }

  const SOCIAL_FIELD_MAP = {
    "social-discord-token":  "DISCORD_BOT_TOKEN",
    "social-feishu-appid":   "FEISHU_APP_ID",
    "social-feishu-secret":  "FEISHU_APP_SECRET",
    "social-feishu-token":   "FEISHU_VERIFICATION_TOKEN",
    "social-wechat-appid":   "WECHAT_OFFICIAL_APP_ID",
    "social-wechat-secret":  "WECHAT_OFFICIAL_APP_SECRET",
    "social-wechat-token":   "WECHAT_OFFICIAL_TOKEN",
    "social-wecom-botkey":   "WECOM_BOT_KEY",
    "social-wecom-token":    "WECOM_INCOMING_TOKEN",
  };

  const SOCIAL_PLATFORM_STATUS = {
    "social-status-discord": ["DISCORD_BOT_TOKEN"],
    "social-status-feishu":  ["FEISHU_APP_ID", "FEISHU_APP_SECRET", "FEISHU_VERIFICATION_TOKEN"],
    "social-status-wechat":  ["WECHAT_OFFICIAL_APP_ID", "WECHAT_OFFICIAL_APP_SECRET", "WECHAT_OFFICIAL_TOKEN"],
    "social-status-wecom":   ["WECOM_BOT_KEY", "WECOM_INCOMING_TOKEN"],
  };

  async function loadSocialSettings() {
    try {
      const { social } = await fetch(`${API}/settings/social`).then(r => r.json());
      for (const [statusId, keys] of Object.entries(SOCIAL_PLATFORM_STATUS)) {
        const el = document.getElementById(statusId);
        if (!el) continue;
        const configuredCount = keys.filter(k => social[k]?.configured).length;
        if (configuredCount === keys.length) {
          el.textContent = t("dynamic.configuredDot");
          el.className = "settings-platform-status ok";
        } else if (configuredCount > 0) {
          el.textContent = t("format.partialConfig", { configured: configuredCount, total: keys.length });
          el.className = "settings-platform-status miss";
        } else {
          el.textContent = t("dynamic.notConfiguredDot");
          el.className = "settings-platform-status miss";
        }
      }
    } catch {}
  }

  const fileSandboxToggle = document.getElementById("security-file-sandbox");
  const execSandboxToggle = document.getElementById("security-exec-sandbox");
  const lanAccessToggle   = document.getElementById("security-lan-access");
  const lanAccessToken    = document.getElementById("security-lan-token");
  const copyLanTokenBtn   = document.getElementById("security-copy-lan-token");
  const lanAddressSelect  = document.getElementById("security-lan-address");
  const lanAccessUrl      = document.getElementById("security-lan-url");
  const copyLanUrlBtn     = document.getElementById("security-copy-lan-url");
  const lanSharePanel     = document.getElementById("security-lan-share");
  const lanAccessQr       = document.getElementById("security-lan-access-qr");
  const lanCertificateQr  = document.getElementById("security-lan-cert-qr");
  const lanCertificateLink = document.getElementById("security-lan-cert-link");
  const lanAccessHint     = document.getElementById("security-lan-hint");
  const restartSecurityBtn = document.getElementById("settings-restart-security");
  const securityFeedback  = document.getElementById("settings-security-feedback");

  const mcpServersJson = document.getElementById("mcp-servers-json");
  const mcpStatus = document.getElementById("mcp-status");
  const saveMcpBtn = document.getElementById("settings-save-mcp");
  const mcpFeedback = document.getElementById("settings-mcp-feedback");

  function renderMcpStatus(status = {}) {
    if (!mcpStatus) return;
    const servers = Array.isArray(status.servers) ? status.servers : [];
    if (servers.length === 0) {
      mcpStatus.textContent = t("mcp.none");
      return;
    }
    mcpStatus.textContent = servers.map(server => {
      const marker = server.status === "connected" ? "●" : server.status === "disabled" ? "○" : "×";
      const tools = `${server.loadedToolCount || 0}/${server.toolCount || 0} tools`;
      const error = server.error ? `\n  ${server.error}` : "";
      return `${marker} ${server.name || server.id} · ${server.status} · ${tools}${error}`;
    }).join("\n");
  }

  async function loadMcpSettings() {
    try {
      const data = await fetch(`${API}/settings/mcp`).then(r => r.json());
      if (!data.ok) throw new Error(data.error || "读取失败");
      if (mcpServersJson) {
        const servers = (data.mcp?.servers || []).map(({ envKeys, ...server }) => server);
        mcpServersJson.value = JSON.stringify(servers, null, 2);
      }
      renderMcpStatus(data.status);
    } catch (error) {
      if (mcpStatus) mcpStatus.textContent = error?.message || "读取 MCP 设置失败";
    }
  }

  if (saveMcpBtn) {
    saveMcpBtn.addEventListener("click", async () => {
      let servers;
      try {
        servers = JSON.parse(mcpServersJson?.value || "[]");
        if (!Array.isArray(servers)) throw new Error(t("dynamic.mcpJsonTopLevel"));
      } catch (error) {
        showFeedback(mcpFeedback, t("format.jsonError", { error: error.message }), true);
        return;
      }
      saveMcpBtn.disabled = true;
      showFeedback(mcpFeedback, "正在保存并连接…");
      try {
        const res = await fetch(`${API}/settings/mcp`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ servers }),
        });
        const data = await res.json();
        if (!data.ok) throw new Error(data.error || "保存失败");
        const publicServers = (data.mcp?.servers || []).map(({ envKeys, ...server }) => server);
        if (mcpServersJson) mcpServersJson.value = JSON.stringify(publicServers, null, 2);
        renderMcpStatus(data.status);
        showFeedback(mcpFeedback, t("format.mcpToolsLoaded", { count: data.status?.toolCount || 0 }));
      } catch (error) {
        showFeedback(mcpFeedback, error?.message || "请求失败", true);
      } finally {
        saveMcpBtn.disabled = false;
      }
    });
  }

  let lanAccessEntries = [];

  function showSelectedLanAccessEntry() {
    const index = Number(lanAddressSelect?.value || 0);
    const entry = lanAccessEntries[index] || lanAccessEntries[0] || null;
    if (lanAccessUrl) lanAccessUrl.value = entry?.url || "";
    if (lanAccessQr) lanAccessQr.src = entry?.qrDataUrl || "";
    if (lanCertificateQr) lanCertificateQr.src = entry?.certificateQrDataUrl || "";
    if (lanCertificateLink) {
      lanCertificateLink.href = entry?.certificateUrl || "#";
      lanCertificateLink.style.pointerEvents = entry ? "" : "none";
    }
    if (lanSharePanel) lanSharePanel.style.display = entry ? "" : "none";
  }

  function applyLanNetworkSettings(network = {}) {
    const previousAddress = lanAccessEntries[Number(lanAddressSelect?.value || 0)]?.address;
    if (lanAccessToggle) lanAccessToggle.checked = network.allowLanAccess === true;
    if (lanAccessToken) lanAccessToken.value = network.accessToken || "";
    lanAccessEntries = Array.isArray(network.accessEntries) ? network.accessEntries : [];
    if (lanAddressSelect) {
      lanAddressSelect.innerHTML = "";
      lanAccessEntries.forEach((entry, index) => {
        const option = document.createElement("option");
        option.value = String(index);
        option.textContent = entry.address;
        lanAddressSelect.appendChild(option);
      });
      const previousIndex = lanAccessEntries.findIndex(entry => entry.address === previousAddress);
      lanAddressSelect.value = String(previousIndex >= 0 ? previousIndex : 0);
      lanAddressSelect.disabled = lanAccessEntries.length === 0;
    }
    showSelectedLanAccessEntry();
    if (lanAccessHint) {
      if (!network.allowLanAccess) {
        lanAccessHint.textContent = "开启局域网访问并重启后，这里会生成完整链接和二维码。";
      } else if (network.httpsEnabled) {
        lanAccessHint.textContent = "首次使用先安装根证书并启用完全信任，再扫描访问二维码。完整链接包含访问口令，请勿发给不信任的人。";
      } else {
        lanAccessHint.textContent = "当前未启用 HTTPS，iPad Safari 无法使用麦克风。";
      }
    }
  }

  lanAddressSelect?.addEventListener("change", showSelectedLanAccessEntry);

  const ALICE_CHROME_BROWSER_TOOL_NAMES = [
    "browser_navigate", "browser_navigate_back", "browser_navigate_forward", "browser_reload", "browser_snapshot", "browser_find",
    "browser_click", "browser_type", "browser_fill_form", "browser_select_option",
    "browser_press_key", "browser_hover", "browser_drag", "browser_wait_for",
    "browser_handle_dialog", "browser_tabs", "browser_take_screenshot",
    "browser_console_messages", "browser_resize", "browser_close",
  ];

  let securitySnapshot = null;
  async function loadSecuritySettings() {
    try {
      const { security, network } = await fetch(`${API}/settings/security`).then(r => r.json());
      if (fileSandboxToggle) fileSandboxToggle.checked = security.fileSandbox === true;
      if (execSandboxToggle) execSandboxToggle.checked = security.execSandbox === true;
      applyLanNetworkSettings(network);
      restartSecurityBtn?.classList.add("hidden");
      document.querySelectorAll(".security-blocked-tool").forEach(cb => {
        const blocked = security.blockedTools || [];
        cb.checked = cb.value === "chrome_devtools_browser"
          ? ALICE_CHROME_BROWSER_TOOL_NAMES.every(name => blocked.includes(name))
          : blocked.includes(cb.value);
      });
      // 缓存加载时的档位与闸门：保存时若已偏离当前预设，把档位转成自定义，
      // 避免设置页的提交覆盖掉档位闸门、而 accessMode 仍显示旧档位（A9）。
      securitySnapshot = {
        accessMode: typeof security.accessMode === "string" ? security.accessMode : "",
        fileSandbox: security.fileSandbox === true,
        execSandbox: security.execSandbox === true,
        blockedTools: [...(security.blockedTools || [])],
      };
    } catch {}
  }

  const securityAutosave = createSettingsAutosave(async () => {
    try {
      const blockedTools = [...document.querySelectorAll(".security-blocked-tool")]
        .filter(cb => cb.checked)
        .map(cb => cb.value);
      const body = {
        fileSandbox: fileSandboxToggle ? fileSandboxToggle.checked : false,
        execSandbox: execSandboxToggle ? execSandboxToggle.checked : false,
        allowLanAccess: lanAccessToggle ? lanAccessToggle.checked : false,
        blockedTools,
      };
      // 闸门组合相对当前预设发生变化 → 转为自定义（accessMode=''），
      // 行为由实际闸门决定；未偏离则保留档位。只改局域网开关不影响档位。
      if (securitySnapshot && ["full", "workspace", "readonly"].includes(securitySnapshot.accessMode)) {
        const expandedBlocked = body.blockedTools.flatMap(v =>
          v === "chrome_devtools_browser" ? ALICE_CHROME_BROWSER_TOOL_NAMES : [v]);
        const sameBlocked = expandedBlocked.length === securitySnapshot.blockedTools.length
          && expandedBlocked.every(v => securitySnapshot.blockedTools.includes(v));
        const deviated = body.fileSandbox !== securitySnapshot.fileSandbox
          || body.execSandbox !== securitySnapshot.execSandbox
          || !sameBlocked;
        if (deviated) body.accessMode = "";
      }
      const res = await fetch(`${API}/settings/security`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });
      const data = await res.json();
      if (!res.ok || !data.ok) throw new Error(data.error || "安全设置保存失败");
      applyLanNetworkSettings(data.network);
      if (data.network?.restartRequired) {
        restartSecurityBtn?.classList.remove("hidden");
        return { message: "安全设置已自动保存 · 重启后生效" };
      }
      return { message: "安全设置已自动保存 · 立即生效" };
    } catch (error) {
      await loadSecuritySettings();
      throw error;
    }
  }, { feedback: securityFeedback });

  [
    fileSandboxToggle,
    execSandboxToggle,
    lanAccessToggle,
    ...document.querySelectorAll(".security-blocked-tool"),
  ].filter(Boolean).forEach(el => {
    el.addEventListener("change", () => securityAutosave.schedule({ immediate: true }));
  });

  if (restartSecurityBtn) {
    restartSecurityBtn.addEventListener("click", async () => {
      restartSecurityBtn.disabled = true;
      try {
        await fetch(`${API}/admin/restart`, { method: "POST" });
        showFeedback(securityFeedback, "正在重启…");
      } catch {
        showFeedback(securityFeedback, "重启请求失败，请手动重启应用", true);
        restartSecurityBtn.disabled = false;
      }
    });
  }

  const socialAutosave = createSettingsAutosave(async () => {
    const updates = {};
    const submittedFields = [];
    for (const [fieldId, envKey] of Object.entries(SOCIAL_FIELD_MAP)) {
      const el = document.getElementById(fieldId);
      const value = el?.value?.trim() || "";
      if (value) {
        updates[envKey] = value;
        submittedFields.push([el, value]);
      }
    }
    if (Object.keys(updates).length === 0) {
      return { skipped: true, message: "" };
    }
    const res = await fetch(`${API}/settings/social`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(updates),
    });
    const data = await res.json();
    if (!res.ok || !data.ok) throw new Error(data.error || "社交媒体配置保存失败");
    for (const [el, submittedValue] of submittedFields) {
      if (el.value.trim() === submittedValue) el.value = "";
    }
    await loadSocialSettings();
    return { message: "社交媒体配置已自动保存" };
  }, { feedback: socialFeedback });

  bindDebouncedAutosave(
    Object.keys(SOCIAL_FIELD_MAP).map(id => document.getElementById(id)),
    socialAutosave,
  );

  const temperatureAutosave = createSettingsAutosave(async () => {
    const temperature = parseFloat(tempSlider?.value ?? "0.5");
    const res = await fetch(`${API}/settings/temperature`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ temperature }),
    });
    const data = await res.json();
    if (!res.ok || !data.ok) throw new Error(data.error || "模型温度保存失败");
    if (cachedLlm) cachedLlm.temperature = data.temperature;
    return { message: `模型温度已设为 ${data.temperature.toFixed(2)}` };
  }, { feedback: tempFeedback, delay: 350 });

  if (tempSlider && tempVal) {
    tempSlider.addEventListener("input", () => {
      tempVal.textContent = parseFloat(tempSlider.value).toFixed(2);
      temperatureAutosave.schedule();
    });
    tempSlider.addEventListener("change", () => temperatureAutosave.schedule({ immediate: true }));
  }

  if (thinkingToggle) {
    const thinkingAutosave = createSettingsAutosave(async () => {
      const thinking = thinkingToggle.checked;
      thinkingToggle.disabled = true;
      try {
        const res = await fetch(`${API}/settings/thinking`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ thinking }),
        });
        const data = await res.json();
        if (!res.ok || !data.ok) throw new Error(data.error || "推理强度保存失败");
        if (cachedLlm) cachedLlm.thinking = data.thinking;
        return { message: data.thinking ? "已切换为高推理强度 · 下一轮生效" : "已切换为默认推理强度 · 下一轮生效" };
      } catch (error) {
        thinkingToggle.checked = !thinking;
        throw error;
      } finally {
        thinkingToggle.disabled = false;
      }
    }, { feedback: thinkingFeedback });
    thinkingToggle.addEventListener("change", () => {
      thinkingAutosave.schedule({ immediate: true });
    });
  }

  copyLanTokenBtn?.addEventListener("click", async () => {
    const token = lanAccessToken?.value?.trim();
    if (!token) {
      showFeedback(securityFeedback, "请先开启局域网访问并保存", true);
      return;
    }
    try {
      await navigator.clipboard.writeText(token);
      showFeedback(securityFeedback, "访问口令已复制");
    } catch {
      showFeedback(securityFeedback, "复制失败，请手动选择口令", true);
    }
  });

  copyLanUrlBtn?.addEventListener("click", async () => {
    const url = lanAccessUrl?.value?.trim();
    if (!url) {
      showFeedback(securityFeedback, "请先开启局域网访问并重启", true);
      return;
    }
    try {
      await navigator.clipboard.writeText(url);
      showFeedback(securityFeedback, "完整访问链接已复制");
    } catch {
      lanAccessUrl.focus();
      lanAccessUrl.select();
      showFeedback(securityFeedback, "已选中链接，请手动复制", true);
    }
  });

  const contextWindowAutosave = createSettingsAutosave(async () => {
    const body = {
      chatMessageLimit: Number(chatContextSlider?.value || 20),
      toolCallLimit: Number(toolContextSlider?.value || 0),
    };
    const res = await fetch(`${API}/settings/context-window`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
    const data = await res.json();
    if (!res.ok || !data.ok) throw new Error(data.error || "上下文设置保存失败");
    if (cachedLlm) cachedLlm.contextWindow = data.contextWindow;
    return { message: "上下文设置已自动保存 · 下一轮生效" };
  }, { feedback: contextWindowFeedback, delay: 350 });

  if (chatContextSlider) {
    chatContextSlider.addEventListener("input", () => {
      syncContextWindowControls("chat");
      contextWindowAutosave.schedule();
    });
    chatContextSlider.addEventListener("change", () => contextWindowAutosave.schedule({ immediate: true }));
  }
  if (toolContextSlider) {
    toolContextSlider.addEventListener("input", () => {
      syncContextWindowControls("tool");
      contextWindowAutosave.schedule();
    });
    toolContextSlider.addEventListener("change", () => contextWindowAutosave.schedule({ immediate: true }));
  }
  syncContextWindowControls();

  const VOICE_LANG_KEY       = "alice-voice-lang";
  const VOICE_AUTO_SEND_KEY  = "alice-voice-auto-send";
  const VOICE_AUTO_MIC_KEY   = "alice-voice-auto-mic";
  const VOICE_THRESHOLD_KEY  = "alice-voice-threshold";
  const VOICE_PROVIDER_KEY   = "alice-voice-provider";
  const VOICE_MIC_DEVICE_KEY = "alice-voice-mic-device-id";

  function applyVoiceProviderUI(provider) {
    const panels = {
      aliyun: "voice-cred-aliyun",
      volcengine: "voice-cred-volcengine",
      tencent: "voice-cred-tencent",
      xunfei: "voice-cred-xunfei",
      local: null,
    };
    for (const [key, id] of Object.entries(panels)) {
      if (!id) continue;
      const el = document.getElementById(id);
      if (el) el.style.display = key === provider ? "" : "none";
    }
  }

  function detectVoiceProviderFromKey(key) {
    const value = (key || "").trim();
    if (!value) return null;
    if (/^sk-[A-Za-z0-9_\-.]{20,}$/.test(value)) {
      return { provider: "aliyun", label: "阿里云 ASR", fieldId: "voice-aliyun-key" };
    }
    if (/^AKID/i.test(value)) {
      return { provider: "tencent", label: "腾讯云 ASR", fieldId: "voice-tencent-sid" };
    }
    if (/^\d{6,10}$/.test(value)) {
      return { provider: "xunfei", label: "科大讯飞", fieldId: "voice-xunfei-appid" };
    }
    if (/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(value)) {
      return {
        provider: "volcengine",
        label: "火山豆包 ASR",
        fieldId: "voice-volc-apikey",
      };
    }
    return null;
  }

  function setVoiceMicStatus(message, isError = false) {
    if (!voiceMicStatus) return;
    voiceMicStatus.textContent = message;
    voiceMicStatus.style.color = isError ? "var(--warm)" : "var(--dim)";
  }

  async function loadMicrophoneDevices({ requestPermission = false } = {}) {
    if (!voiceMicSelect) return;
    if (!navigator.mediaDevices?.enumerateDevices) {
      voiceMicSelect.disabled = true;
      setVoiceMicStatus(
        window.isSecureContext === false
          ? "当前局域网页面不是安全上下文，Safari 无法使用麦克风；请改用 HTTPS 安全访问链接。"
          : "当前环境不支持麦克风设备枚举，将使用系统默认麦克风。",
        true,
      );
      return;
    }

    const savedDeviceId = localStorage.getItem(VOICE_MIC_DEVICE_KEY) || "";
    const preferredDeviceId = voiceMicSelect.value || savedDeviceId;
    let permissionError = null;

    voiceMicSelect.disabled = true;
    if (voiceRefreshMicsBtn) voiceRefreshMicsBtn.disabled = true;

    try {
      if (requestPermission && navigator.mediaDevices.getUserMedia) {
        try {
          const permissionStream = await navigator.mediaDevices.getUserMedia({ audio: true });
          permissionStream.getTracks().forEach(track => track.stop());
        } catch (err) {
          permissionError = err;
        }
      }

      const devices = (await navigator.mediaDevices.enumerateDevices())
        .filter(device => device.kind === "audioinput");

      voiceMicSelect.innerHTML = "";
      const defaultOption = document.createElement("option");
      defaultOption.value = "";
      defaultOption.textContent = t("voice.defaultMic");
      voiceMicSelect.appendChild(defaultOption);

      devices.forEach((device, index) => {
        const option = document.createElement("option");
        option.value = device.deviceId;
        option.textContent = device.label || t("format.microphone", { count: index + 1 });
        voiceMicSelect.appendChild(option);
      });

      const selectedStillExists = !preferredDeviceId || devices.some(device => device.deviceId === preferredDeviceId);
      voiceMicSelect.value = selectedStillExists ? preferredDeviceId : "";
      if (!selectedStillExists && savedDeviceId) localStorage.removeItem(VOICE_MIC_DEVICE_KEY);

      const hasLabels = devices.some(device => device.label);
      if (permissionError) {
        setVoiceMicStatus("未获得麦克风权限，仍可使用系统默认麦克风；点刷新可重新授权。", true);
      } else if (!devices.length) {
        setVoiceMicStatus("未检测到独立麦克风，将使用系统默认麦克风。");
      } else if (!hasLabels) {
        setVoiceMicStatus(t("format.micsDetectedPermission", { count: devices.length }));
      } else {
        setVoiceMicStatus(t("format.micsDetected", { count: devices.length }));
      }
    } catch {
      setVoiceMicStatus("麦克风列表读取失败，将使用系统默认麦克风。", true);
    } finally {
      voiceMicSelect.disabled = false;
      if (voiceRefreshMicsBtn) voiceRefreshMicsBtn.disabled = false;
    }
  }

  function setVoiceOutputStatus(message, isError = false) {
    if (!voiceOutputStatus) return;
    voiceOutputStatus.textContent = message;
    voiceOutputStatus.style.color = isError ? "var(--warm)" : "var(--dim)";
  }

  // 填充"语音输出设备"下拉。结构对齐麦克风选择器：第一项=自动，其余=具体设备；
  // 虚拟/串流设备打标提示用户它们不会真正出声。
  async function loadOutputDevices({ requestPermission = false } = {}) {
    if (!voiceOutputSelect) return;
    if (!('setSinkId' in HTMLMediaElement.prototype)) {
      voiceOutputSelect.disabled = true;
      setVoiceOutputStatus("当前环境不支持指定输出设备，将使用系统默认。", true);
      return;
    }
    const savedDeviceId = getOutputPreference();
    const preferred = voiceOutputSelect.value || savedDeviceId;
    voiceOutputSelect.disabled = true;
    if (voiceRefreshOutputsBtn) voiceRefreshOutputsBtn.disabled = true;
    try {
      // label/deviceId 需要媒体权限；点"刷新"时主动请求一次，平时静默枚举
      if (requestPermission && navigator.mediaDevices?.getUserMedia) {
        try {
          const s = await navigator.mediaDevices.getUserMedia({ audio: true });
          s.getTracks().forEach(t => t.stop());
        } catch {}
      }
      const outs = await listOutputDevices();
      // 只列真实可选设备（隐藏 default/communications 别名，避免和"自动"重复）
      const selectable = outs.filter(d => !d.isDefault && d.label);
      voiceOutputSelect.innerHTML = "";
      const autoOpt = document.createElement("option");
      autoOpt.value = "";
      autoOpt.textContent = t("voice.autoOutput");
      voiceOutputSelect.appendChild(autoOpt);
      selectable.forEach((d, i) => {
        const opt = document.createElement("option");
        opt.value = d.deviceId;
        opt.textContent = (d.label || t("format.outputDevice", { count: i + 1 })) + (d.isVirtual ? t("format.virtualOutput") : "");
        voiceOutputSelect.appendChild(opt);
      });
      const stillExists = !preferred || selectable.some(d => d.deviceId === preferred);
      voiceOutputSelect.value = stillExists ? preferred : "";
      if (!stillExists && savedDeviceId) setOutputPreference(""); // 钉的设备没了 → 回到自动

      const hasLabels = selectable.some(d => d.label);
      if (!selectable.length) {
        setVoiceOutputStatus("未检测到独立扬声器/耳机，点刷新并授权后可显示。");
      } else if (!hasLabels) {
        setVoiceOutputStatus("点刷新并授权后可显示设备完整名称。");
      } else {
        setVoiceOutputStatus("语音从这里发声。默认自动；拔耳机会自动切回扬声器，不被虚拟声卡占用。");
      }
    } catch {
      setVoiceOutputStatus("输出设备列表读取失败，将使用系统默认。", true);
    } finally {
      voiceOutputSelect.disabled = false;
      if (voiceRefreshOutputsBtn) voiceRefreshOutputsBtn.disabled = false;
    }
  }

  voiceRefreshOutputsBtn?.addEventListener("click", () => loadOutputDevices({ requestPermission: true }));
  // 选择即时生效（无需点保存）：写偏好 → 模块自动把在播语音切过去并复评横幅
  voiceOutputSelect?.addEventListener("change", () => {
    setOutputPreference(voiceOutputSelect.value || "");
    setVoiceOutputStatus(voiceOutputSelect.value ? "已切换，立即生效。" : "已设为自动，立即生效。");
    voiceAutosave.schedule({ immediate: true });
  });

  const voiceProviderSelect = document.getElementById("voice-provider-select");
  if (voiceProviderSelect) {
    voiceProviderSelect.addEventListener("change", () => {
      applyVoiceProviderUI(voiceProviderSelect.value);
      voiceAutosave.schedule({ immediate: true });
    });
  }

  const voiceAutoKey = document.getElementById("voice-auto-key");
  const voiceAutoDetect = document.getElementById("voice-auto-detect");
  if (voiceAutoKey) {
    voiceAutoKey.addEventListener("input", () => {
      const detected = detectVoiceProviderFromKey(voiceAutoKey.value);
      if (!detected) {
        if (voiceAutoDetect) voiceAutoDetect.textContent = voiceAutoKey.value.trim() ? "未识别" : "";
        return;
      }
      if (voiceProviderSelect) voiceProviderSelect.value = detected.provider;
      applyVoiceProviderUI(detected.provider);
      const target = document.getElementById(detected.fieldId);
      if (target) target.value = voiceAutoKey.value.trim();
      for (const [id, value] of Object.entries(detected.defaults || {})) {
        const el = document.getElementById(id);
        if (el && !el.value.trim()) el.value = value;
      }
      if (voiceAutoDetect) voiceAutoDetect.textContent = detected.label;
      voiceAutosave.schedule();
    });
  }

  async function loadMapSettings() {
    const status = document.getElementById("settings-map-status");
    const dot = document.getElementById("settings-map-status-dot");
    try {
      const data = await fetch(`${API}/settings/map`).then(r => r.json());
      const map = data?.map || {};
      if (status) {
        status.textContent = map.configured
          ? t("format.mapConfigured")
          : t("format.mapStatus", {
            key: map.keyConfigured ? t("common.configured") : t("common.notConfigured"),
            security: map.securityConfigured ? t("common.configured") : t("common.notConfigured"),
          });
      }
      if (dot) {
        dot.textContent = "●";
        dot.className = `settings-config-dot ${map.configured ? "active" : "inactive"}`;
      }
    } catch {
      if (status) status.textContent = "读取配置失败";
      if (dot) dot.className = "settings-config-dot inactive";
    }
  }

  function syncHeartbeatControls() {
    if (heartbeatInterval) {
      heartbeatInterval.setAttribute(
        "aria-label",
        heartbeatToggle?.checked === false ? "重新启用心跳后使用的默认间隔（分钟）" : "默认心跳间隔（分钟）",
      );
    }
  }

  function applyVoiceConfigStatus(voice = null, error = "") {
    const el = document.getElementById("voice-config-status");
    if (!el) return;
    if (error) {
      el.textContent = error;
      el.style.color = "var(--warm)";
      return;
    }
    const provider = voice?.voiceProvider || "aliyun";
    const definitions = {
      local: { label: t("voice.localMac"), keys: [] },
      aliyun: { label: t("voice.aliyunAsr"), keys: ["aliyunApiKey"] },
      volcengine: { label: t("voice.volcAsr"), keys: ["volcAsrApiKey"] },
      tencent: { label: t("voice.tencentAsr"), keys: ["tencentSecretId", "tencentSecretKey", "tencentAppId"] },
      xunfei: { label: t("voice.xunfeiAsr"), keys: ["xunfeiAppId", "xunfeiApiKey", "xunfeiApiSecret"] },
    };
    const definition = definitions[provider] || definitions.aliyun;
    const configured = definition.keys.length === 0
      || definition.keys.every(key => voice?.[key]?.configured === true);
    el.textContent = configured
      ? t("format.hostVoiceConfigured", { provider: definition.label })
      : t("format.hostVoiceIncomplete", { provider: definition.label });
    el.style.color = configured ? "var(--ok, #4caf50)" : "var(--dim)";
  }

  async function loadHeartbeatSettings() {
    try {
      const response = await fetch(`${API}/settings/heartbeat`);
      const data = await response.json();
      if (!response.ok || !data.ok) throw new Error(data.error || "读取失败");
      const heartbeat = data.heartbeat || {};
      applyHeartbeatConfig(heartbeat);
      if (heartbeatToggle) heartbeatToggle.checked = heartbeat.enabled !== false;
      if (heartbeatInterval) heartbeatInterval.value = String(heartbeat.defaultIntervalMinutes || 20);
      syncHeartbeatControls();
    } catch (err) {
      showFeedback(heartbeatFeedback, err.message || "读取心跳设置失败", true);
    }
  }

  const heartbeatAutosave = createSettingsAutosave(async () => {
    const defaultIntervalMinutes = Number(heartbeatInterval?.value);
    if (!Number.isInteger(defaultIntervalMinutes) || defaultIntervalMinutes < 1 || defaultIntervalMinutes > 1440) {
      throw new Error("请输入 1–1440 之间的整数分钟");
    }
    const response = await fetch(`${API}/settings/heartbeat`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        enabled: heartbeatToggle?.checked !== false,
        defaultIntervalMinutes,
      }),
    });
    const data = await response.json();
    if (!response.ok || !data.ok) throw new Error(data.error || "心跳设置保存失败");
    applyHeartbeatConfig(data.heartbeat);
    syncHeartbeatControls();
    return { message: data.heartbeat?.enabled ? "心跳设置已自动保存并生效" : "心跳已关闭" };
  }, { feedback: heartbeatFeedback });

  heartbeatToggle?.addEventListener("change", () => {
    syncHeartbeatControls();
    heartbeatAutosave.schedule({ immediate: true });
  });
  heartbeatInterval?.addEventListener("input", () => heartbeatAutosave.schedule());
  heartbeatInterval?.addEventListener("blur", () => heartbeatAutosave.schedule({ immediate: true }));
  heartbeatInterval?.addEventListener("change", () => heartbeatAutosave.schedule({ immediate: true }));

  const mapAutosave = createSettingsAutosave(async () => {
    const jsKey = mapKeyInput?.value?.trim() || "";
    const securityCode = mapSecurityInput?.value?.trim() || "";
    if (!jsKey && !securityCode) return { skipped: true, message: "" };
    const response = await fetch(`${API}/settings/map`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ jsKey, securityCode }),
    });
    const data = await response.json();
    if (!response.ok || !data.ok) throw new Error(data.error || "地图配置保存失败");
    await loadMapSettings();
    return { message: data.map?.configured ? "地图服务已自动启用" : "地图配置已自动保存 · 请补全配置" };
  }, { feedback: mapFeedback });

  bindDebouncedAutosave([mapKeyInput, mapSecurityInput], mapAutosave);
  mapKeyToggle?.addEventListener("click", () => {
    updateSecretVisibility(mapKeyInput, mapKeyToggle, mapKeyInput?.type === "password", "Web 端 Key");
  });
  mapSecurityToggle?.addEventListener("click", () => {
    updateSecretVisibility(mapSecurityInput, mapSecurityToggle, mapSecurityInput?.type === "password", "安全密钥");
  });

  if (clearMapBtn) {
    clearMapBtn.addEventListener("click", async () => {
      clearMapBtn.disabled = true;
      try {
        const response = await fetch(`${API}/settings/map`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ clear: true }),
        });
        const data = await response.json();
        if (!response.ok || !data.ok) throw new Error(data.error || "清除失败");
        if (mapKeyInput) mapKeyInput.value = "";
        if (mapSecurityInput) mapSecurityInput.value = "";
        updateSecretVisibility(mapKeyInput, mapKeyToggle, false, "Web 端 Key");
        updateSecretVisibility(mapSecurityInput, mapSecurityToggle, false, "安全密钥");
        showFeedback(mapFeedback, "地图配置已清除");
        loadMapSettings();
      } catch (err) {
        showFeedback(mapFeedback, err.message || "清除失败", true);
      } finally {
        clearMapBtn.disabled = false;
      }
    });
  }

  function setVolcAsrKeyVisible(visible) {
    volcAsrKeyVisible = Boolean(visible);
    updateSecretVisibility(volcAsrKeyInput, volcAsrKeyToggle, volcAsrKeyVisible);
  }

  volcAsrKeyToggle?.addEventListener("click", () => {
    setVolcAsrKeyVisible(!volcAsrKeyVisible);
  });

  voiceRefreshMicsBtn?.addEventListener("click", () => {
    loadMicrophoneDevices({ requestPermission: true });
  });

  voiceMicSelect?.addEventListener("change", () => {
    setVoiceMicStatus("正在自动保存；重新开启语音对话后生效。");
  });

  navigator.mediaDevices?.addEventListener?.("devicechange", () => {
    if (!overlay.hidden) { loadMicrophoneDevices(); loadOutputDevices(); }
  });

  async function loadVoiceSettings() {
    const langSelect = document.getElementById("voice-lang-select");
    const autoSend   = document.getElementById("voice-auto-send");
    if (langSelect) langSelect.value = localStorage.getItem(VOICE_LANG_KEY) || "zh-CN";
    if (autoSend) autoSend.checked = localStorage.getItem(VOICE_AUTO_SEND_KEY) !== "false";
    const autoMic = document.getElementById("voice-auto-mic");
    if (autoMic) autoMic.checked = localStorage.getItem(VOICE_AUTO_MIC_KEY) === "true";
    const spacePtt = document.getElementById("voice-space-ptt");
    if (spacePtt) spacePtt.checked = localStorage.getItem(VOICE_SPACE_PTT_KEY) !== "false";
    const savedThresh = parseFloat(localStorage.getItem(VOICE_THRESHOLD_KEY) || "0.008");
    if (voiceThreshSlider) voiceThreshSlider.value = String(savedThresh);
    if (voiceThreshVal)    voiceThreshVal.textContent = savedThresh.toFixed(3);
    await loadMicrophoneDevices();
    await loadOutputDevices();

    let savedProvider = localStorage.getItem(VOICE_PROVIDER_KEY) || "aliyun";
    try {
      const resp = await fetch(`${API}/settings/voice`);
      const data = await resp.json().catch(() => ({}));
      if (resp.status === 403) {
        showFeedback(voiceFeedback, "局域网访问未配对，请使用带口令的访问链接", true);
        applyVoiceConfigStatus(null, "无法读取主机配置：局域网访问尚未配对");
      }
      if (resp.ok && data?.voice?.voiceProvider) {
        savedProvider = data.voice.voiceProvider;
        localStorage.setItem(VOICE_PROVIDER_KEY, savedProvider);
        applyVoiceConfigStatus(data.voice);
      }
      const savedVolcAsrKey = data?.voice?.volcAsrApiKey?.value;
      if (volcAsrKeyInput) volcAsrKeyInput.value = typeof savedVolcAsrKey === "string" ? savedVolcAsrKey : "";
    } catch {
      applyVoiceConfigStatus(null, "无法读取主机上的语音识别配置");
    }
    if (voiceProviderSelect) voiceProviderSelect.value = savedProvider;
    applyVoiceProviderUI(savedProvider);
  }

  if (voiceThreshSlider && voiceThreshVal) {
    voiceThreshSlider.addEventListener("input", () => {
      voiceThreshVal.textContent = parseFloat(voiceThreshSlider.value).toFixed(3);
      voiceAutosave.schedule();
    });
    voiceThreshSlider.addEventListener("change", () => voiceAutosave.schedule({ immediate: true }));
  }

  const voiceAutosave = createSettingsAutosave(async () => {
    const lang = document.getElementById("voice-lang-select")?.value || "zh-CN";
    const autoSend = document.getElementById("voice-auto-send")?.checked ?? true;
    const autoMic = document.getElementById("voice-auto-mic")?.checked ?? false;
    const spacePtt = document.getElementById("voice-space-ptt")?.checked ?? true;
    const threshold = parseFloat(voiceThreshSlider?.value ?? "0.008");
    const provider = voiceProviderSelect?.value || "aliyun";
    const micDeviceId = voiceMicSelect?.value || "";

    localStorage.setItem(VOICE_LANG_KEY, lang);
    localStorage.setItem(VOICE_AUTO_SEND_KEY, String(autoSend));
    localStorage.setItem(VOICE_AUTO_MIC_KEY, String(autoMic));
    localStorage.setItem(VOICE_SPACE_PTT_KEY, String(spacePtt));
    localStorage.setItem(VOICE_THRESHOLD_KEY, String(threshold));
    localStorage.setItem(VOICE_PROVIDER_KEY, provider);
    if (micDeviceId) localStorage.setItem(VOICE_MIC_DEVICE_KEY, micDeviceId);
    else localStorage.removeItem(VOICE_MIC_DEVICE_KEY);

    window.dispatchEvent(new CustomEvent("alice:voice-threshold", { detail: { threshold } }));
    window.dispatchEvent(new CustomEvent("alice:space-ptt-change", { detail: { enabled: spacePtt } }));
    const micLabel = voiceMicSelect?.selectedOptions?.[0]?.textContent || t("voice.defaultMic");
    setVoiceMicStatus(t("format.currentMic", { microphone: micLabel }));

    const body = { voiceProvider: provider };
    const credentialFields = [
      ["voice-aliyun-key", "aliyunApiKey"],
      ["voice-tencent-sid", "tencentSecretId"],
      ["voice-tencent-skey", "tencentSecretKey"],
      ["voice-tencent-appid", "tencentAppId"],
      ["voice-xunfei-appid", "xunfeiAppId"],
      ["voice-xunfei-apikey", "xunfeiApiKey"],
      ["voice-volc-apikey", "volcAsrApiKey"],
    ];
    for (const [id, key] of credentialFields) {
      const value = document.getElementById(id)?.value?.trim();
      if (value) body[key] = value;
    }

    const response = await fetch(`${API}/settings/voice`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
    const data = await response.json().catch(() => ({}));
    if (!response.ok || !data.ok) throw new Error(data.error || "语音识别配置保存失败");
    for (const [id, key] of credentialFields) {
      if (id === "voice-volc-apikey" || id === "voice-tencent-appid" || id === "voice-xunfei-appid") continue;
      const el = document.getElementById(id);
      if (el && body[key] && el.value.trim() === body[key]) el.value = "";
    }
    if (voiceAutoKey?.value.trim() && credentialFields.some(([, key]) => body[key] === voiceAutoKey.value.trim())) {
      voiceAutoKey.value = "";
      if (voiceAutoDetect) voiceAutoDetect.textContent = "";
    }
    applyVoiceConfigStatus(data.voice || null);
    return { message: "语音设置已自动保存" };
  }, { feedback: voiceFeedback });

  const immediateVoiceControls = [
    document.getElementById("voice-lang-select"),
    voiceMicSelect,
    document.getElementById("voice-auto-send"),
    document.getElementById("voice-auto-mic"),
    document.getElementById("voice-space-ptt"),
  ].filter(Boolean);
  for (const el of immediateVoiceControls) {
    el.addEventListener("change", () => voiceAutosave.schedule({ immediate: true }));
  }
  bindDebouncedAutosave([
    voiceAutoKey,
    ...[
      "voice-aliyun-key",
      "voice-tencent-sid",
      "voice-tencent-skey",
      "voice-tencent-appid",
      "voice-xunfei-appid",
      "voice-xunfei-apikey",
      "voice-volc-apikey",
    ].map(id => document.getElementById(id)),
  ], voiceAutosave);

  initTTSSettings({ createAutosave: createSettingsAutosave, feedback: voiceFeedback });

  const memoryGraphToggle = document.getElementById("settings-memory-graph-toggle");
  const memoryGraphFeedback = document.getElementById("settings-memory-graph-feedback");
  if (memoryGraphToggle) {
    memoryGraphToggle.checked = localStorage.getItem(MEMORY_GRAPH_STORAGE_KEY) !== "false";
    memoryGraphToggle.addEventListener("change", () => {
      localStorage.setItem(MEMORY_GRAPH_STORAGE_KEY, String(memoryGraphToggle.checked));
      localPreferenceAutosave.schedule({ immediate: true });
      if (memoryGraphFeedback) {
        memoryGraphFeedback.textContent = "下次刷新页面后生效";
        memoryGraphFeedback.className = "settings-feedback";
        setTimeout(() => { memoryGraphFeedback.textContent = ""; }, 3000);
      }
    });
  }

  function openSettings(tab = null) {
    overlay.hidden = false;
    refreshAutosaveStatus();
    loadSettings();
loadSettings();
    loadVoiceSettings();
    if (typeof window.__loadSuppliers === "function") window.__loadSuppliers();
    if (tab) {
      overlay.querySelectorAll(".settings-nav-item").forEach(b => {
        b.classList.toggle("active", b.dataset.tab === tab);
      });
      overlay.querySelectorAll(".settings-tab").forEach(t => {
        t.classList.toggle("active", t.dataset.tab === tab);
      });
      if (tab === "social") loadSocialSettings();
      if (tab === "mcp") loadMcpSettings();
      if (tab === "advanced") {
        loadHeartbeatSettings();
        loadMapSettings();
      }
      if (tab === "update") loadUpdateSettings();
    }
  }

  function closeSettings() {
    flushPendingAutosaves();
    updateSecretVisibility(mapKeyInput, mapKeyToggle, false, "Web 端 Key");
    updateSecretVisibility(mapSecurityInput, mapSecurityToggle, false, "安全密钥");
    overlay.hidden = true;
  }

  // 暴露给 chat.js 的斜杠命令使用
  setOpenSettings(openSettings);

  settingsBtn.addEventListener("click", () => {
    if (document.body.classList.contains("video-mode")) return;
    openSettings();
  });
  closeBtn.addEventListener("click", closeSettings);
  window.addEventListener("alice:video-mode", (event) => {
    const active = Boolean(event?.detail?.active);
    settingsBtn.disabled = active;
    settingsBtn.setAttribute("aria-disabled", String(active));
    if (active && !overlay.hidden) closeSettings();
  });
  overlay.addEventListener("click", (e) => { if (e.target === overlay) closeSettings(); });
  document.addEventListener("keydown", (e) => { if (e.key === "Escape" && !overlay.hidden) closeSettings(); });

  if (providerSelect) {
    providerSelect.addEventListener("change", () => {
      applyCustomProviderUI(providerSelect.value);
      llmAutosave.schedule({ immediate: true });
    });
  }

  if (modelSelect) {
    modelSelect.addEventListener("change", () => {
      syncOfficialCustomModelRow();
      llmAutosave.schedule({ immediate: true });
    });
  }
// ── 模型供应商（常驻列表）──────────────────────────────────────────
  // 借鉴天枢 provider-keys.json：填个地址就拉带能力的模型清单；
  // 加过的供应商常驻在下面，点一下切换，地址和 Key 不用重填。
  (function initSupplierPanel() {
    const nameInput    = document.getElementById("supplier-name");
    const baseUrlInput = document.getElementById("supplier-baseurl");
    const keyInput     = document.getElementById("supplier-key");
    const siteInput    = document.getElementById("supplier-site");
    const keyToggle    = document.getElementById("supplier-key-toggle");
    const fetchBtn     = document.getElementById("supplier-fetch");
    const saveBtn      = document.getElementById("supplier-save");
    const feedbackEl   = document.getElementById("supplier-feedback");
    const modelRow     = document.getElementById("supplier-model-row");
    const modelSel     = document.getElementById("supplier-model-select");
    const saveRow      = document.getElementById("supplier-save-row");
    const listEl       = document.getElementById("supplier-list");
    if (!listEl) return;

    let pendingModels = [];
    let supplierList = { activeId: null, suppliers: [] };

    function esc(value) {
      return String(value ?? "").replace(/[&<>"']/g, (c) => ({
        "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;",
      }[c]));
    }

    function fmtTokens(n) {
      const num = Number(n);
      if (!Number.isFinite(num) || num <= 0) return "";
      if (num >= 1000000) return `${(num / 1000000).toFixed(num % 1000000 ? 1 : 0)}M`;
      if (num >= 1000) return `${Math.round(num / 1000)}K`;
      return String(num);
    }

    // 一行能力徽标：上下文窗口 / 最大输出 / 视觉
    function modelBadges(model) {
      const bits = [];
      const ctx = fmtTokens(model?.contextWindow);
      if (ctx) bits.push(`<span class="settings-supplier-badge">上下文 ${ctx}</span>`);
      const out = fmtTokens(model?.maxTokens);
      if (out) bits.push(`<span class="settings-supplier-badge">输出 ${out}</span>`);
      if (model?.supportsVision) bits.push(`<span class="settings-supplier-badge is-vision">视觉</span>`);
      return bits.join("");
    }

    function setFeedback(text, state = "") {
      if (!feedbackEl) return;
      feedbackEl.textContent = text || "";
      feedbackEl.dataset.state = state;
    }

    function renderList() {
      const suppliers = supplierList.suppliers || [];
      if (!suppliers.length) {
        listEl.innerHTML = `<p class="settings-hint settings-supplier-empty">还没有加过自定义供应商。填个地址拉一次模型清单，就会留在这里。</p>`;
        return;
      }
      listEl.innerHTML = suppliers.map((s) => {
        const isActive = !!supplierList.activeId && s.id === supplierList.activeId;
        const current = s.lastModel || s.models?.[0]?.id || "";
        const currentModel = s.models?.find(m => m.id === current) || { id: current };
        const options = (s.models || []).map(m =>
          `<option value="${esc(m.id)}"${m.id === current ? " selected" : ""}>${esc(m.id)}</option>`
        ).join("");
        return `
          <div class="settings-supplier-card${isActive ? " is-active" : ""}" data-supplier-id="${esc(s.id)}">
            <div class="settings-supplier-head">
              <input class="settings-supplier-name settings-supplier-name-input" data-supplier-rename data-id="${esc(s.id)}" data-baseurl="${esc(s.baseURL)}" value="${esc(s.label || s.baseURL)}" placeholder="给它起个名" title="点这里就能改名" autocomplete="off" spellcheck="false">
              ${isActive ? `<span class="settings-supplier-tag">当前</span>` : ""}
              <button class="settings-supplier-mini" data-supplier-action="edit" data-id="${esc(s.id)}" type="button" title="改接口地址 / 密钥">编辑</button>
              <button class="settings-supplier-mini" data-supplier-action="remove" data-id="${esc(s.id)}" type="button">删除</button>
            </div>
            <!-- 编辑区默认收起。以前接口地址和密钥存下来之后就再也改不了：
                 地址填错一个字符、或换了 key，只能删掉重加一遍（还会丢掉模型清单）。 -->
            <div class="settings-supplier-edit" data-supplier-edit-body data-id="${esc(s.id)}" hidden>
              <div class="settings-row">
                <label class="settings-label">接口地址</label>
                <input class="settings-input" data-supplier-edit-baseurl data-id="${esc(s.id)}" type="text" value="${esc(s.baseURL)}" placeholder="https://xxx.com" autocomplete="off" spellcheck="false">
              </div>
              <div class="settings-row">
                <label class="settings-label">密钥</label>
                <input class="settings-input" data-supplier-edit-key data-id="${esc(s.id)}" type="password" value="" placeholder="${s.hasKey ? "已保存，留空则不修改" : "填入 API Key"}" autocomplete="new-password">
              </div>
              <div class="settings-row-action">
                <button class="settings-supplier-btn" data-supplier-action="edit-save" data-id="${esc(s.id)}" type="button">保存修改</button>
                <button class="settings-supplier-mini" data-supplier-action="edit-cancel" data-id="${esc(s.id)}" type="button">取消</button>
                <span class="settings-feedback" data-supplier-edit-feedback data-id="${esc(s.id)}"></span>
              </div>
            </div>
            <div class="settings-supplier-url">${esc(s.baseURL)}</div>
            <div class="settings-supplier-site-row">
              <input class="settings-supplier-site-input" data-supplier-site data-id="${esc(s.id)}" value="${esc(s.site || "")}" placeholder="填官网地址，如 https://xxx.com" title="填好点右边「打开」；留空就打开 Base URL 的域名" autocomplete="off" spellcheck="false">
              <button class="settings-supplier-mini" data-supplier-action="open-site" data-id="${esc(s.id)}" type="button">打开</button>
            </div>
            <div class="settings-supplier-row">
              <select class="settings-select settings-supplier-model" data-id="${esc(s.id)}">
                ${options || `<option value="${esc(current)}" selected>${esc(current || "（没有模型清单）")}</option>`}
              </select>
              <button class="settings-supplier-btn" data-supplier-action="activate" data-id="${esc(s.id)}" type="button"${isActive ? " disabled" : ""}>切换</button>
            </div>
            <div class="settings-supplier-row">
              <button class="settings-supplier-btn" data-supplier-action="fetch-models" data-id="${esc(s.id)}" type="button" title="用这条已保存的地址和密钥重新拉一次上游模型清单">拉取模型清单</button>
              <span class="settings-feedback" data-supplier-fetch-feedback data-id="${esc(s.id)}"></span>
            </div>
            <div class="settings-supplier-meta">
              <span>${s.models?.length || 0} 个模型</span>
              ${modelBadges(currentModel)}
              ${s.hasKey ? "" : `<span class="settings-supplier-badge is-warn">缺 Key</span>`}
            </div>
          </div>`;
      }).join("");
    }

    async function loadSuppliers() {
      try {
        const res = await fetch(`${API}/settings/suppliers`);
        const data = await res.json();
        if (data?.ok) {
          supplierList = { activeId: data.activeId || null, suppliers: data.suppliers || [] };
          renderList();
        }
      } catch {}
    }

    async function doFetchModels() {
      const baseURL = baseUrlInput?.value?.trim() || "";
      if (!baseURL) { setFeedback("先填 Base URL", "error"); return; }
      const apiKey = keyInput?.value?.trim() || "";
      // 名字留空就先用主机名占个位，随时能改
      if (nameInput && !nameInput.value.trim()) {
        try { nameInput.value = new URL(baseURL).host || ""; } catch { /* 地址不合法就交给后端兜底 */ }
      }
      setFeedback("正在拉取…");
      if (fetchBtn) fetchBtn.disabled = true;
      try {
        const res = await fetch(`${API}/settings/suppliers/models`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ baseURL, apiKey, refresh: true }),
        });
        const data = await res.json();
        if (!data?.ok) throw new Error(data?.error || "拉取失败");
        pendingModels = data.models || [];
        if (!pendingModels.length) throw new Error("上游没有返回任何模型");
        if (modelSel) {
          modelSel.innerHTML = pendingModels.map(m =>
            `<option value="${esc(m.id)}">${esc(m.id)}${m.supportsVision ? " · 视觉" : ""}${m.contextWindow ? ` · 上下文 ${fmtTokens(m.contextWindow)}` : ""}</option>`
          ).join("");
        }
        if (modelRow) modelRow.style.display = "";
        if (saveRow) saveRow.style.display = "";
        setFeedback(`拉到 ${pendingModels.length} 个模型`, "ok");
      } catch (err) {
        pendingModels = [];
        if (modelRow) modelRow.style.display = "none";
        // 拉不到模型清单不代表不能存：上游没开 /models、Key 不对、超时都可能。
        // 这时也把「保存这个供应商」露出来，先存进常驻列表，模型清单以后再补。
        if (saveRow) saveRow.style.display = baseURL ? "" : "none";
        setFeedback(`${err?.message || "拉取失败"}（也可以直接点「保存这个供应商」，先存下来，模型清单以后再拉）`, "error");
      } finally {
        if (fetchBtn) fetchBtn.disabled = false;
      }
    }

    async function doSave() {
      const baseURL = baseUrlInput?.value?.trim() || "";
      if (!baseURL) { setFeedback("先填 Base URL", "error"); return; }
      const apiKey = keyInput?.value?.trim() || "";
      const model = modelSel?.value || pendingModels?.[0]?.id || "";
      try {
        const res = await fetch(`${API}/settings/suppliers`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ baseURL, apiKey, site: siteInput?.value?.trim() || "", label: nameInput?.value?.trim() || "", models: pendingModels, lastModel: model }),
        });
        const data = await res.json();
        if (!data?.ok) throw new Error(data?.error || "保存失败");
        supplierList = { activeId: data.activeId || null, suppliers: data.suppliers || [] };
        renderList();
        if (nameInput) nameInput.value = "";
        if (siteInput) siteInput.value = "";
        setFeedback("已存进常驻列表", "ok");
      } catch (err) {
        setFeedback(err?.message || "保存失败", "error");
      }
    }

    async function activateSupplier(id) {
      const card = listEl.querySelector(`.settings-supplier-card[data-supplier-id="${CSS.escape(id)}"]`);
      const model = card?.querySelector(".settings-supplier-model")?.value || "";
      try {
        const res = await fetch(`${API}/settings/suppliers/activate`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ id, model }),
        });
        const data = await res.json();
        if (!data?.ok) throw new Error(data?.error || "切换失败");
        supplierList.activeId = id;
        const hit = supplierList.suppliers.find(s => s.id === id);
        if (hit) hit.lastModel = model;
        renderList();
        setFeedback(`已切到 ${hit?.label || id}`, "ok");
        // 切完刷新一次设置面板，让顶部「当前状态」与模型下拉同步
        loadSettings();
      } catch (err) {
        setFeedback(err?.message || "切换失败", "error");
      }
    }

    async function doRemove(id) {
      try {
        const res = await fetch(`${API}/settings/suppliers/remove`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ id }),
        });
        const data = await res.json();
        if (!data?.ok) throw new Error(data?.error || "删除失败");
        supplierList = { activeId: data.activeId || null, suppliers: data.suppliers || [] };
        renderList();
        setFeedback("已删除", "ok");
      } catch (err) {
        setFeedback(err?.message || "删除失败", "error");
      }
    }

    // 就地改名：只送 label，地址/Key/模型清单都沿用原来那条
    async function renameSupplier(id, baseURL, label) {
      const next = String(label || "").trim();
      const hit = supplierList.suppliers.find(s => s.id === id);
      if (!next || next === (hit?.label || "")) return;
      try {
        const res = await fetch(`${API}/settings/suppliers`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ id, baseURL, label: next }),
        });
        const data = await res.json();
        if (!data?.ok) throw new Error(data?.error || "改名失败");
        supplierList = { activeId: data.activeId || null, suppliers: data.suppliers || [] };
        renderList();
        setFeedback(`已改名为 ${next}`, "ok");
      } catch (err) {
        setFeedback(err?.message || "改名失败", "error");
        renderList();
      }
    }

    // 网站栏：就地改，改完（回车或点开别处）就存下来
    async function saveSite(id, site) {
      const next = String(site || "").trim();
      const hit = supplierList.suppliers.find(s => s.id === id);
      if (!hit || !next || next === (hit.site || "")) return;
      try {
        const res = await fetch(`${API}/settings/suppliers`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ id, baseURL: hit.baseURL, site: next }),
        });
        const data = await res.json();
        if (!data?.ok) throw new Error(data?.error || "网站保存失败");
        supplierList = { activeId: data.activeId || null, suppliers: data.suppliers || [] };
        renderList();
        setFeedback(`已记下网站 ${next}`, "ok");
      } catch (err) {
        setFeedback(err?.message || "网站保存失败", "error");
        renderList();
      }
    }

    // ── 已保存的供应商：重新拉取模型清单 ──────────────────────────────
    //
    // 以前只有「填地址 → 拉清单 → 保存」这一次性流程：存下来之后模型清单就冻住了，
    // 上游后来上了新模型也没办法更新（除非删掉重建，那又会丢掉已经攒下的清单）。
    //
    // 一个刻意的决定：**合并而不是覆盖**。
    // 中转站的 /v1/models 经常只列出它愿意公开的一部分（VANKIT 就只列了 4 个画图模型，
    // 而实际可用的对话模型远多于此）。如果拿这次的结果直接覆盖，用户手上已经能用、
    // 但上游不再列出的模型名会被抹掉 —— 那是把「有」变成「没有」，比不更新更糟。
    // 所以这里只做并集，并如实报告本次新增了几个。
    async function fetchSupplierModels(id) {
      const card = listEl.querySelector(`.settings-supplier-card[data-supplier-id="${CSS.escape(id)}"]`);
      const fbEl = card?.querySelector(`[data-supplier-fetch-feedback][data-id="${CSS.escape(id)}"]`);
      const hit = supplierList.suppliers.find(s => s.id === id);
      const showFb = (msg, kind) => {
        if (!fbEl) return;
        fbEl.textContent = msg;
        fbEl.classList.toggle("is-error", kind === "error");
        fbEl.classList.toggle("is-ok", kind === "ok");
      };
      if (!hit) return;

      showFb("正在拉取…");
      const btn = card.querySelector(`[data-supplier-action="fetch-models"][data-id="${CSS.escape(id)}"]`);
      if (btn) btn.disabled = true;
      try {
        // apiKey 不回显给前端（供应商列表接口里只有 hasKey），所以这里不带 key，
        // 由后端用**它自己存的**那条密钥去拉 —— 也就避免了「为了刷新清单，
        // 前端必须持有明文密钥」这个本来没必要的暴露。
        const res = await fetch(`${API}/settings/suppliers/models`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ baseURL: hit.baseURL, refresh: true }),
        });
        const data = await res.json();
        if (!data?.ok) throw new Error(data?.error || "拉取失败");
        const fetched = Array.isArray(data.models) ? data.models : [];
        if (!fetched.length) throw new Error("上游没有返回任何模型");

        const known = new Set((hit.models || []).map(m => m.id));
        const added = fetched.filter(m => !known.has(m.id));
        const merged = [...(hit.models || []), ...added];

        const res2 = await fetch(`${API}/settings/suppliers`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            id,
            baseURL: hit.baseURL,
            label: hit.label,
            models: merged,
            lastModel: hit.lastModel,
          }),
        });
        const saved = await res2.json();
        if (!saved?.ok) throw new Error(saved?.error || "清单保存失败");
        supplierList = { activeId: saved.activeId || null, suppliers: saved.suppliers || [] };
        renderList();
        setFeedback(
          added.length
            ? `拉到 ${fetched.length} 个，新增 ${added.length} 个（共 ${merged.length} 个）`
            : `拉到 ${fetched.length} 个，没有新模型（共 ${merged.length} 个）`,
          "ok",
        );
      } catch (err) {
        showFb(err?.message || "拉取失败", "error");
        if (btn) btn.disabled = false;
      }
    }

    // 打开网站：优先用栏里填的，没填就用 Base URL 的域名；走系统浏览器打开
    function openSite(id) {
      const card = listEl.querySelector(`.settings-supplier-card[data-supplier-id="${CSS.escape(id)}"]`);
      const typed = card?.querySelector("[data-supplier-site]")?.value?.trim() || "";
      const hit = supplierList.suppliers.find(s => s.id === id);
      let url = typed || hit?.site || "";
      if (!url && hit?.baseURL) {
        try { url = new URL(hit.baseURL).origin; } catch { url = hit.baseURL; }
      }
      if (!url) { setFeedback("这条还没有网站地址，先在上面填一个", "error"); return; }
      if (!/^[a-z][a-z0-9+.-]*:\/\//i.test(url)) url = `https://${url}`;
      window.open(url, "_blank");
      setFeedback(`已打开 ${url}`, "ok");
    }

    // ── 编辑已保存的供应商（接口地址 / 密钥）──────────────────────────
    //
    // 背景：供应商存下来之后，接口地址和密钥就**再也改不了**了 —— 名字和网站能就地改，
    // 但地址填错一个字符、或者换了 key，只能「删除再重新添加一遍」，而重加会丢掉
    // 已经拉好的模型清单（含上下文窗口、视觉能力那些标记）。所以补上编辑入口。
    //
    // 后端不需要动：`POST /settings/suppliers` 本来就是 upsert（带 id 即更新）。
    function toggleSupplierEdit(id, force) {
      const card = listEl.querySelector(`.settings-supplier-card[data-supplier-id="${CSS.escape(id)}"]`);
      const body = card?.querySelector(`[data-supplier-edit-body][data-id="${CSS.escape(id)}"]`);
      if (!body) return;
      const next = typeof force === "boolean" ? force : body.hidden;
      body.hidden = !next;
      if (next) body.querySelector("[data-supplier-edit-baseurl]")?.focus();
    }

    async function saveSupplierEdit(id) {
      const card = listEl.querySelector(`.settings-supplier-card[data-supplier-id="${CSS.escape(id)}"]`);
      if (!card) return;
      const urlEl = card.querySelector(`[data-supplier-edit-baseurl][data-id="${CSS.escape(id)}"]`);
      const keyEl = card.querySelector(`[data-supplier-edit-key][data-id="${CSS.escape(id)}"]`);
      const fbEl  = card.querySelector(`[data-supplier-edit-feedback][data-id="${CSS.escape(id)}"]`);
      const hit   = supplierList.suppliers.find(s => s.id === id);

      const nextURL = urlEl?.value?.trim() || "";
      const nextKey = keyEl?.value?.trim() || "";
      const showFb = (msg, kind) => {
        if (!fbEl) return;
        fbEl.textContent = msg;
        fbEl.classList.toggle("is-error", kind === "error");
        fbEl.classList.toggle("is-ok", kind === "ok");
      };

      if (!nextURL) { showFb("接口地址不能为空", "error"); return; }
      if (!/^https?:\/\//i.test(nextURL)) { showFb("接口地址要以 http:// 或 https:// 开头", "error"); return; }

      // 地址没变、也没填新 key → 什么都不用做，直接收起来
      const urlChanged = nextURL !== (hit?.baseURL || "");
      if (!urlChanged && !nextKey) { showFb("没有改动", "ok"); toggleSupplierEdit(id, false); return; }

      showFb("正在保存…");
      try {
        const body = { id, baseURL: nextURL };
        if (nextKey) body.apiKey = nextKey;
        const res = await fetch(`${API}/settings/suppliers`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(body),
        });
        const data = await res.json();
        if (!data?.ok) throw new Error(data?.error || "保存失败");

        supplierList = { activeId: data.activeId || null, suppliers: data.suppliers || [] };
        renderList();
        setFeedback(`已更新 ${nextURL}${nextKey ? "（含密钥）" : ""}`, "ok");
        // 如果改的正是当前生效的那条，让后端按新地址重新校验一遍 ——
        // 否则「地址改错了」要等到下一次真正调用才发现。
        const isActive = supplierList.activeId === id;
        if (isActive && urlChanged) {
          const model = supplierList.suppliers.find(s => s.id === id)?.lastModel || "";
          try {
            const r2 = await fetch(`${API}/settings/suppliers/activate`, {
              method: "POST",
              headers: { "Content-Type": "application/json" },
              body: JSON.stringify({ id, model }),
            });
            const d2 = await r2.json();
            if (!d2?.ok) throw new Error(d2?.error || "新地址校验未通过");
            setFeedback(`已更新并校验通过：${nextURL}`, "ok");
          } catch (e2) {
            // 地址改了但用不了：如实报告，不假装成功
            setFeedback(`地址已保存，但用它切换失败：${e2?.message || e2}`, "error");
          }
        }
      } catch (err) {
        showFb(err?.message || "保存失败", "error");
      }
    }



    fetchBtn?.addEventListener("click", doFetchModels);
    saveBtn?.addEventListener("click", doSave);
    keyToggle?.addEventListener("click", () => {
      if (!keyInput) return;
      const visible = keyInput.type === "text";
      keyInput.type = visible ? "password" : "text";
      keyToggle.dataset.visible = String(!visible);
    });
    baseUrlInput?.addEventListener("keydown", (e) => { if (e.key === "Enter") doFetchModels(); });
    // 只要填了地址就把「保存这个供应商」露出来：拉清单失败（没开 /models、Key 不对、超时）时也能先存进常驻列表
    baseUrlInput?.addEventListener("input", () => {
      if (!saveRow) return;
      saveRow.style.display = baseUrlInput.value.trim() ? "" : "none";
    });

    listEl.addEventListener("click", (e) => {
      const btn = e.target.closest("[data-supplier-action]");
      if (!btn) return;
      const id = btn.dataset.id;
      if (btn.dataset.supplierAction === "activate") activateSupplier(id);
      if (btn.dataset.supplierAction === "remove") doRemove(id);
      if (btn.dataset.supplierAction === "open-site") openSite(id);
      if (btn.dataset.supplierAction === "fetch-models") fetchSupplierModels(id);
      if (btn.dataset.supplierAction === "edit") toggleSupplierEdit(id);
      if (btn.dataset.supplierAction === "edit-save") saveSupplierEdit(id);
      if (btn.dataset.supplierAction === "edit-cancel") toggleSupplierEdit(id, false);
    });

    // 名字就地改：改完（回车或点开别处）就存下来
    listEl.addEventListener("change", (e) => {
      const input = e.target.closest("[data-supplier-rename]");
      if (input) renameSupplier(input.dataset.id, input.dataset.baseurl, input.value);
      const siteEl = e.target.closest("[data-supplier-site]");
      if (siteEl) saveSite(siteEl.dataset.id, siteEl.value);
    });

    // 打开设置面板时重新拉一次（供应商可能在别处被改过）
    window.__loadSuppliers = loadSuppliers;
    loadSuppliers();
  })();
  const agentNameAutosave = createSettingsAutosave(async () => {
    const nextName = agentNameInput?.value?.trim() || "";
    if (nextName.length > 32) {
      throw new Error("AI 名字不能超过 32 个字符");
    }
    if (nextName && !agentNameRe.test(nextName)) {
      throw new Error("AI 名字只允许中文、英文字母、数字、空格、下划线、短横线");
    }
    const res = await fetch(`${API}/settings/agent-name`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ agentName: nextName }),
    });
    const data = await res.json();
    if (!res.ok || !data.ok) throw new Error(data.error || "AI 名字保存失败");
    const savedName = data.agent_name || defaultAgentName;
    if (agentNameInput?.value.trim() === nextName) agentNameInput.value = savedName;
    setAgentName(savedName);
    return { message: "AI 名字已自动保存" };
  }, { feedback: agentNameFeedback });
  bindDebouncedAutosave([agentNameInput], agentNameAutosave);
  agentNameInput?.addEventListener("keydown", event => {
    if (event.key === "Enter") agentNameAutosave.schedule({ immediate: true });
  });

  llmKeyToggle?.addEventListener("click", () => {
    setLlmKeyVisible(!llmKeyVisible);
  });

  const llmAutosave = createSettingsAutosave(async () => {
    const provider = providerSelect?.value || "auto";
    const apiKey = llmKeyInput.value.trim();
    const selectedCfg = cachedProviders?.[provider] || {};
    const body = { provider };
    if (provider === "custom") {
      body.baseURL = document.getElementById("settings-custom-baseurl")?.value?.trim();
      body.model = document.getElementById("settings-custom-model")?.value?.trim();
      if (!body.baseURL || !body.model) {
        return { skipped: true, message: "补全 Base URL 和模型名称后会自动保存" };
      }
      if (apiKey !== (selectedCfg.apiKey || "")) body.apiKey = apiKey || "none";
    } else if (provider === "auto") {
      if (!apiKey) {
        return { skipped: true, message: "输入 API Key 后会自动识别并保存" };
      }
      body.apiKey = apiKey;
    } else {
      if (modelSelect.value === CUSTOM_MODEL_VALUE) {
        body.model = officialCustomModelInput?.value?.trim();
        if (!body.model) {
          return { skipped: true, message: "输入模型名称后会自动保存" };
        }
      } else {
        body.model = modelSelect.value;
      }
      if (apiKey && apiKey !== (selectedCfg.apiKey || "")) body.apiKey = apiKey;
    }

    const res = await fetch(`${API}/settings/model`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
    const data = await res.json();
    if (!res.ok || !data.ok) throw new Error(data.error || "LLM 配置保存失败");
    cachedLlm = {
      ...(cachedLlm || {}),
      ...data,
      provider: data.provider || provider,
      model: data.model || body.model || cachedLlm?.model,
      baseURL: data.baseURL || body.baseURL || cachedLlm?.baseURL,
      activated: true,
    };
    if (cachedProviders?.[provider]) {
      cachedProviders[provider] = {
        ...cachedProviders[provider],
        model: cachedLlm.model,
        baseURL: cachedLlm.baseURL,
        apiKey: apiKey || cachedProviders[provider].apiKey,
      };
    }
    refreshConfigSummary({ llm: cachedLlm, minimax: cachedMinimax });
    return { message: "LLM 配置已自动保存" };
  }, { feedback: llmFeedback });

  bindDebouncedAutosave([
    llmKeyInput,
    officialCustomModelInput,
    document.getElementById("settings-custom-baseurl"),
    document.getElementById("settings-custom-model"),
  ], llmAutosave);

  const minimaxAutosave = createSettingsAutosave(async () => {
    const apiKey = minimaxKeyInput.value.trim();
    if (!apiKey) return { skipped: true, message: "" };
    const res = await fetch(`${API}/settings/minimax`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ apiKey }),
    });
    const data = await res.json();
    if (!res.ok || !data.ok) throw new Error(data.error || "MiniMax API Key 保存失败");
    if (minimaxKeyInput.value.trim() === apiKey) minimaxKeyInput.value = "";
    cachedMinimax = { configured: true };
    if (cachedLlm) refreshConfigSummary({ llm: cachedLlm, minimax: cachedMinimax });
    return { message: "MiniMax API Key 已自动保存" };
  }, { feedback: minimaxFeedback });
  bindDebouncedAutosave([minimaxKeyInput], minimaxAutosave);

  // ── VANKIT 图像端点（生图备选）──────────────────────────────────────
  //
  // 与 MiniMax 那块的差别：这里**允许留空**——key 一旦留空就表示「取消这条备选」，
  // 是合法操作（不像 MiniMax 的 key 是 TTS/音乐/生图的唯一来源，清掉会让人一脸茫然）。
  // 另外只在真的改动过时才发请求（否则打开设置页就会平白触发一次保存）。
  const vankitKeyInput     = document.getElementById("settings-vankit-key");
  const vankitBaseURLInput = document.getElementById("settings-vankit-baseurl");
  const vankitModelInput   = document.getElementById("settings-vankit-model");
  const vankitFeedback     = document.getElementById("settings-vankit-feedback");
  const readVankitForm = () => ({
    apiKey: vankitKeyInput?.value?.trim() || "",
    baseURL: vankitBaseURLInput?.value?.trim() || "",
    model: vankitModelInput?.value?.trim() || "",
  });
  const vankitDirty = () => {
    const cur = readVankitForm();
    // key 输入框在保存后会被清空（不回显明文），所以它单独比：有值就算改动
    return Boolean(cur.apiKey)
      || cur.baseURL !== vankitSnapshot.baseURL
      || cur.model !== vankitSnapshot.model;
  };

  const vankitAutosave = createSettingsAutosave(async () => {
    if (!vankitDirty()) return { skipped: true, message: "" };
    const form = readVankitForm();
    // 留空 key + 其余也没填 = 明确要清掉这条配置
    const body = form.apiKey
      ? { apiKey: form.apiKey, baseURL: form.baseURL, model: form.model }
      : { apiKey: "", baseURL: form.baseURL, model: form.model };
    const res = await fetch(`${API}/settings/vankit`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
    const data = await res.json();
    if (!res.ok || !data.ok) throw new Error(data.error || "VANKIT 配置保存失败");
    if (vankitKeyInput?.value.trim() === form.apiKey) vankitKeyInput.value = "";
    // 保留 configured / imageProvider（后端响应里没有这两个以外的东西，但也不能丢）——
    // 丢了的话保存成功后顶部摘要会立刻显示成「生图没有可用通道」。
    vankitSnapshot = {
      ...vankitSnapshot,
      apiKey: "",
      baseURL: data.baseURL || "",
      model: data.model || "",
      configured: Boolean(data.configured),
    };
    if (vankitBaseURLInput) vankitBaseURLInput.value = vankitSnapshot.baseURL;
    if (vankitModelInput) vankitModelInput.value = vankitSnapshot.model;
    // 保存后立刻按最新配置重算「生图走谁」，别等下次打开设置页
    try {
      const s = await fetch(`${API}/settings`, { cache: "no-store" }).then(r => r.json());
      if (s?.vankit) {
        vankitSnapshot = {
          ...vankitSnapshot,
          configured: Boolean(s.vankit.configured),
          imageProvider: s.vankit.imageProvider || null,
        };
        cachedMinimax = s.minimax || cachedMinimax;
        if (cachedLlm) refreshConfigSummary({ llm: cachedLlm, minimax: cachedMinimax });
      }
    } catch { /* 摘要刷新失败不影响保存结果 */ }
    return {
      message: data.configured
        ? "VANKIT 图像端点已保存（未配置 MiniMax 时用于生图）"
        : "VANKIT 图像端点已清除",
    };
  }, { feedback: vankitFeedback });
  bindDebouncedAutosave([vankitKeyInput, vankitBaseURLInput, vankitModelInput], vankitAutosave);

  const clawbotConnectBtn = document.getElementById("clawbot-connect-btn");
  const clawbotLogoutBtn  = document.getElementById("clawbot-logout-btn");
  const clawbotQrArea     = document.getElementById("clawbot-qr-area");
  const clawbotQrImg      = document.getElementById("clawbot-qr-img");
  const clawbotQrHint     = document.getElementById("clawbot-qr-hint");
  const clawbotFeedback   = document.getElementById("clawbot-feedback");
  const clawbotStatus     = document.getElementById("social-status-clawbot");
  let clawbotPollTimer    = null;

  function setClawbotStatus(text, ok) {
    if (!clawbotStatus) return;
    clawbotStatus.textContent = ok ? `● ${text}` : `○ ${text}`;
    clawbotStatus.className = `settings-platform-status ${ok ? "ok" : "miss"}`;
  }

  function stopClawbotPoll() {
    if (clawbotPollTimer) { clearInterval(clawbotPollTimer); clawbotPollTimer = null; }
  }

  async function pollClawbotQR() {
    try {
      const data = await fetch(`${API}/social/wechat-clawbot/qr`).then(r => r.json());
      if (data.status === "connected") {
        stopClawbotPoll();
        if (clawbotQrArea) clawbotQrArea.style.display = "none";
        setClawbotStatus("已连接", true);
        if (clawbotFeedback) showFeedback(clawbotFeedback, "微信绑定成功！");
        loadSocialSettings();
      } else if (data.status === "qr_ready" && data.qr_url) {
        if (clawbotQrImg) clawbotQrImg.src = `https://api.qrserver.com/v1/create-qr-code/?size=200x200&data=${encodeURIComponent(data.qr_url)}`;
        if (clawbotQrArea) clawbotQrArea.style.display = "block";
        if (clawbotQrHint) clawbotQrHint.textContent = "等待扫码…";
        setClawbotStatus("等待扫码", false);
      } else if (data.status === "qr_pending") {
        if (clawbotQrHint) clawbotQrHint.textContent = "正在生成二维码…";
      } else if (data.status === "error") {
        stopClawbotPoll();
        if (clawbotQrArea) clawbotQrArea.style.display = "none";
        setClawbotStatus("连接失败", false);
        if (clawbotFeedback) showFeedback(clawbotFeedback, data.error || "连接失败", true);
      }
    } catch {}
  }

  if (clawbotConnectBtn) {
    pollClawbotQR();
  }

  clawbotConnectBtn?.addEventListener("click", async () => {
    if (clawbotQrArea) clawbotQrArea.style.display = "none";
    setClawbotStatus("启动中…", false);
    stopClawbotPoll();
    try {
      await fetch(`${API}/settings/social`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ _clawbot_connect: "1" }),
      });
    } catch {}
    await pollClawbotQR();
    clawbotPollTimer = setInterval(pollClawbotQR, 2000);
  });

  clawbotLogoutBtn?.addEventListener("click", async () => {
    stopClawbotPoll();
    if (clawbotQrArea) clawbotQrArea.style.display = "none";
    try {
      await fetch(`${API}/social/wechat-clawbot/logout`, { method: "POST" });
      setClawbotStatus("已断开", false);
      showFeedback(clawbotFeedback, "微信已断开");
    } catch {
      showFeedback(clawbotFeedback, "请求失败", true);
    }
  });

  window.addEventListener("alice:social_status", (e) => {
    const d = e.detail;
    if (d?.platform !== "wechat-clawbot") return;
    if (d.status === "connected") {
      stopClawbotPoll();
      if (clawbotQrArea) clawbotQrArea.style.display = "none";
      setClawbotStatus("已连接", true);
    } else if (d.status === "qr_ready") {
      if (!clawbotPollTimer) clawbotPollTimer = setInterval(pollClawbotQR, 2000);
      pollClawbotQR();
    } else if (d.status === "session_expired") {
      stopClawbotPoll();
      setClawbotStatus("会话已过期 — 请重新扫码", false);
    } else if (d.status === "idle") {
      setClawbotStatus("未连接", false);
    }
  });

  const settingsCheckUpdateBtn     = document.getElementById("settings-check-update-btn");
  const settingsDownloadUpdateBtn  = document.getElementById("settings-download-update-btn");
  const settingsInstallUpdateBtn   = document.getElementById("settings-install-update-btn");
  const settingsIgnoreUpdateBtn    = document.getElementById("settings-ignore-update-btn");
  const settingsUpdateStatusEl     = document.getElementById("settings-update-status");
  const settingsUpdateFeedback     = document.getElementById("settings-update-feedback");
  const settingsCurrentVersion     = document.getElementById("settings-current-version");
  const settingsSuppressToggle     = document.getElementById("settings-suppress-updates");
  const settingsIgnoredSection     = document.getElementById("settings-ignored-section");
  const settingsIgnoredVersionEl   = document.getElementById("settings-ignored-version-val");
  const settingsClearIgnoredBtn    = document.getElementById("settings-clear-ignored-btn");

  let pendingUpdateVersion = null;
  let removeUpdaterListener = null;

  function setUpdateStatusText(text, state = "idle") {
    if (!settingsUpdateStatusEl) return;
    settingsUpdateStatusEl.textContent = text;
    settingsUpdateStatusEl.dataset.state = state;
  }

  function setUpdateFeedback(text, isError = false) {
    if (!settingsUpdateFeedback) return;
    settingsUpdateFeedback.textContent = text || "";
    settingsUpdateFeedback.className = isError ? "settings-feedback error" : "settings-feedback";
  }

  function showUpdateButtons({ check = true, checkDisabled = false, checkLabel = t("update.check"), download = false, install = false, ignore = false } = {}) {
    if (settingsCheckUpdateBtn) {
      settingsCheckUpdateBtn.classList.toggle("hidden", !check);
      settingsCheckUpdateBtn.disabled = checkDisabled;
      settingsCheckUpdateBtn.textContent = checkLabel;
    }
    settingsDownloadUpdateBtn?.classList.toggle("hidden", !download);
    settingsInstallUpdateBtn?.classList.toggle("hidden", !install);
    settingsIgnoreUpdateBtn?.classList.toggle("hidden", !ignore);
  }

  function syncUpdateSettings() {
    const ignored = localStorage.getItem(IGNORED_VERSION_KEY) || null;
    const suppressed = localStorage.getItem(SUPPRESS_UPDATES_KEY) === "true";
    if (settingsSuppressToggle) settingsSuppressToggle.checked = suppressed;
    if (settingsIgnoredSection) settingsIgnoredSection.style.display = ignored ? "" : "none";
    if (settingsIgnoredVersionEl && ignored) settingsIgnoredVersionEl.textContent = ignored;
  }

  async function loadUpdateSettings() {
    syncUpdateSettings();
    const bridge = window.alice;
    if (!bridge?.isElectron) {
      if (settingsCurrentVersion) settingsCurrentVersion.textContent = "仅桌面端可用";
      if (settingsCheckUpdateBtn) settingsCheckUpdateBtn.disabled = true;
      setUpdateStatusText("仅桌面端可用", "muted");
      return;
    }
    try {
      const ver = await bridge.getVersion?.();
      if (settingsCurrentVersion && ver) settingsCurrentVersion.textContent = ver;
    } catch {}

    removeUpdaterListener = bridge.onUpdaterStatus?.((payload = {}) => {
      const stage = payload.stage || "idle";
      const ver = payload.version || "";
      const percent = typeof payload.percent === "number" ? Math.round(payload.percent) : null;

      switch (stage) {
        case "checking":
          setUpdateStatusText("正在检查更新…", "checking");
          showUpdateButtons({ checkDisabled: true, checkLabel: "检查中…" });
          break;
        case "available":
          pendingUpdateVersion = ver;
          setUpdateStatusText(t("format.updateAvailable", { version: ver }), "available");
          showUpdateButtons({ check: false, download: true, ignore: true });
          break;
        case "downloading":
          setUpdateStatusText(percent !== null
            ? t("format.updateDownloading", { percent })
            : t("format.updateDownloadingUnknown"), "downloading");
          showUpdateButtons({ check: false });
          break;
        case "downloaded":
          setUpdateStatusText(t("format.updateReady", { version: ver }), "ready");
          showUpdateButtons({ check: false, install: true });
          break;
        case "up-to-date":
          setUpdateStatusText(t("format.updateCurrent", { version: ver }), "idle");
          showUpdateButtons({ checkLabel: "检查更新" });
          break;
        case "error":
          setUpdateStatusText(t("format.updateFailed", { error: payload.message || t("dynamic.tryLater") }), "error");
          showUpdateButtons({ checkLabel: "重试" });
          break;
        case "dev":
          setUpdateStatusText("开发模式不检查更新", "muted");
          showUpdateButtons({ checkDisabled: true, checkLabel: "开发模式" });
          break;
        default:
          showUpdateButtons({});
          break;
      }
    }) || null;
  }

  window.addEventListener("beforeunload", () => {
    if (typeof removeUpdaterListener === "function") {
      removeUpdaterListener();
      removeUpdaterListener = null;
    }
  });

  settingsSuppressToggle?.addEventListener("change", () => {
    localStorage.setItem(SUPPRESS_UPDATES_KEY, settingsSuppressToggle.checked ? "true" : "false");
    syncUpdateSettings();
    localPreferenceAutosave.schedule({ immediate: true });
  });

  settingsClearIgnoredBtn?.addEventListener("click", () => {
    localStorage.removeItem(IGNORED_VERSION_KEY);
    syncUpdateSettings();
  });

  settingsCheckUpdateBtn?.addEventListener("click", async () => {
    const bridge = window.alice;
    if (!bridge?.isElectron) return;
    setUpdateStatusText("正在检查更新…", "checking");
    setUpdateFeedback("");
    showUpdateButtons({ checkDisabled: true, checkLabel: "检查中…" });
    try {
      const result = await bridge.checkForUpdates?.();
      if (result?.ok === false && result?.message) {
        setUpdateStatusText(t("format.updateFailed", { error: result.message }), "error");
        showUpdateButtons({ checkLabel: "重试" });
      }
    } catch (err) {
      setUpdateStatusText(t("format.updateFailed", { error: err?.message || t("dynamic.tryLater") }), "error");
      showUpdateButtons({ checkLabel: "重试" });
    }
  });

  settingsDownloadUpdateBtn?.addEventListener("click", async () => {
    const bridge = window.alice;
    if (!bridge?.isElectron) return;
    setUpdateStatusText("开始下载…", "downloading");
    showUpdateButtons({ check: false });
    try {
      await bridge.startDownload?.();
    } catch (err) {
      setUpdateStatusText(t("format.downloadFailed", { error: err?.message || t("dynamic.tryLater") }), "error");
      showUpdateButtons({ checkLabel: "重试" });
    }
  });

  settingsInstallUpdateBtn?.addEventListener("click", () => {
    window.alice?.quitAndInstall?.();
  });

  settingsIgnoreUpdateBtn?.addEventListener("click", () => {
    if (pendingUpdateVersion) {
      localStorage.setItem(IGNORED_VERSION_KEY, pendingUpdateVersion);
      syncUpdateSettings();
    }
    setUpdateStatusText("已忽略此版本", "muted");
    showUpdateButtons({ checkLabel: "检查更新" });
  });
})();
}
