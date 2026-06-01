function createRealtimeRenderer(render, options = {}) {
  const minIntervalMs = Number.isFinite(options.minIntervalMs) ? options.minIntervalMs : 50;
  let value = '';
  let pendingValue = '';
  let timer = null;
  let lastRenderAt = 0;
  let cancelled = false;

  const renderNow = next => {
    if (cancelled) return;
    value = String(next || '');
    pendingValue = value;
    lastRenderAt = Date.now();
    render(value);
  };

  return {
    set(next) {
      if (cancelled) return;
      const normalized = String(next || '');
      if (normalized === pendingValue) return;
      pendingValue = normalized;
      const elapsed = Date.now() - lastRenderAt;
      if (elapsed >= minIntervalMs) {
        if (timer) clearTimeout(timer);
        timer = null;
        renderNow(pendingValue);
        return;
      }
      if (timer) clearTimeout(timer);
      timer = setTimeout(() => {
        timer = null;
        renderNow(pendingValue);
      }, minIntervalMs - elapsed);
    },
    flush(next) {
      if (timer) clearTimeout(timer);
      timer = null;
      renderNow(next);
    },
    cancel() {
      if (timer) clearTimeout(timer);
      timer = null;
      cancelled = true;
      value = '';
      pendingValue = '';
    },
  };
}

module.exports = { createRealtimeRenderer };
