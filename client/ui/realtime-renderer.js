const { createStreamingRenderer } = require('../app/markdown/streaming-renderer');

function createRealtimeRenderer(render, options = {}) {
  const minIntervalMs = Number.isFinite(options.minIntervalMs) ? options.minIntervalMs : 50;
  let value = '';
  let pendingValue = '';
  let timer = null;
  let lastRenderAt = 0;
  let cancelled = false;
  let finalized = false;

  const clearTimer = () => {
    if (timer) clearTimeout(timer);
    timer = null;
  };

  const renderNow = next => {
    if (cancelled || finalized) return false;
    const normalized = String(next || '');
    value = normalized;
    pendingValue = normalized;
    lastRenderAt = Date.now();
    render(value);
    return true;
  };

  const flushValue = next => {
    if (cancelled || finalized) return false;
    clearTimer();
    return renderNow(next === undefined ? pendingValue : next);
  };

  return {
    set(next) {
      if (cancelled || finalized) return;
      const normalized = String(next || '');
      if (normalized === pendingValue) return;
      pendingValue = normalized;
      const elapsed = Date.now() - lastRenderAt;
      if (elapsed >= minIntervalMs) {
        clearTimer();
        renderNow(pendingValue);
        return;
      }
      clearTimer();
      timer = setTimeout(() => {
        timer = null;
        renderNow(pendingValue);
      }, Math.max(0, minIntervalMs - elapsed));
    },
    flush(next) {
      return flushValue(next);
    },
    final(next) {
      const rendered = flushValue(next);
      clearTimer();
      finalized = true;
      return rendered;
    },
    cancel() {
      clearTimer();
      cancelled = true;
      value = '';
      pendingValue = '';
    },
    hasTimer() {
      return !!timer;
    },
  };
}

module.exports = { createRealtimeRenderer, createStreamingRenderer };
