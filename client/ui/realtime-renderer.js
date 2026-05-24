function createRealtimeRenderer(render, options = {}, schedule = cb => requestAnimationFrame(cb), cancel = id => cancelAnimationFrame(id), delay = (cb, ms) => setTimeout(cb, ms), clearDelay = id => clearTimeout(id)) {
  if (typeof options === 'function') {
    const legacySchedule = options;
    const legacyCancel = schedule;
    schedule = legacySchedule;
    cancel = legacyCancel;
    options = {};
  }
  let value = '';
  let scheduled = false;
  let cancelled = false;
  let handle = null;
  let useDelay = false;
  let lastRenderedAt = 0;
  const minIntervalMs = Number.isFinite(options.minIntervalMs) ? Math.max(0, options.minIntervalMs) : 0;
  return {
    set(next) {
      if (cancelled) return;
      value = String(next || '');
      if (scheduled) return;
      scheduled = true;
      const waitMs = Math.max(0, minIntervalMs - (Date.now() - lastRenderedAt));
      const run = () => {
        scheduled = false;
        handle = null;
        useDelay = false;
        lastRenderedAt = Date.now();
        if (!cancelled) render(value);
      };
      if (waitMs > 0) {
        useDelay = true;
        handle = delay(run, waitMs);
      } else {
        useDelay = false;
        handle = schedule(run);
      }
    },
    flush(next) {
      if (cancelled) return;
      value = String(next || '');
      if (handle !== null) (useDelay ? clearDelay : cancel)(handle);
      handle = null;
      useDelay = false;
      scheduled = false;
      lastRenderedAt = Date.now();
      render(value);
    },
    cancel() {
      cancelled = true;
      if (handle !== null) (useDelay ? clearDelay : cancel)(handle);
      handle = null;
      useDelay = false;
      scheduled = false;
      value = '';
    },
  };
}

module.exports = { createRealtimeRenderer };
