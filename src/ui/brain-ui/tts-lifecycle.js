// TTS lifecycle helpers kept separate from app.js so the failure-prone timing
// and replacement rules can be regression tested without booting the full UI.

export function nextStreamingTtsSession(currentEpoch, micSuspended) {
  const epoch = Number.isSafeInteger(currentEpoch) && currentEpoch >= 0
    ? currentEpoch + 1
    : 1;
  return { epoch, micSuspended: Boolean(micSuspended) };
}

export function isCurrentStreamingTtsSession(expectedEpoch, currentEpoch) {
  return Number.isSafeInteger(expectedEpoch) && expectedEpoch === currentEpoch;
}

export function createPlaybackProgressWatchdog({
  audioEl,
  onTerminal,
  intervalMs = 1000,
  stallMs = 15000,
  minProgressSeconds = 0.02,
  now = () => Date.now(),
  schedule = (callback, ms) => setInterval(callback, ms),
  cancel = timer => clearInterval(timer),
} = {}) {
  if (!audioEl || typeof onTerminal !== 'function') {
    throw new TypeError('audioEl and onTerminal are required');
  }

  let timer = null;
  let active = false;
  let terminal = false;
  let lastMediaTime = 0;
  let lastProgressAt = 0;

  const mediaTime = () => {
    const value = Number(audioEl.currentTime);
    return Number.isFinite(value) && value >= 0 ? value : 0;
  };

  function stop() {
    active = false;
    if (timer != null) {
      cancel(timer);
      timer = null;
    }
  }

  function finish(ok, kind, error = null) {
    if (terminal) return;
    terminal = true;
    stop();
    onTerminal({ ok, kind, error });
  }

  function check() {
    if (!active || terminal) return;
    if (audioEl.ended) {
      finish(true, 'ended-without-event');
      return;
    }

    const current = mediaTime();
    if (current >= lastMediaTime + minProgressSeconds) {
      lastMediaTime = current;
      lastProgressAt = now();
      return;
    }

    if (now() - lastProgressAt >= stallMs) {
      finish(false, 'playback-stalled', new Error(`audio playback made no progress for ${stallMs}ms`));
    }
  }

  function start() {
    if (active || terminal) return;
    active = true;
    lastMediaTime = mediaTime();
    lastProgressAt = now();
    timer = schedule(check, intervalMs);
  }

  return { start, stop, check };
}
