function createRealtimeRenderer(render, schedule = cb => requestAnimationFrame(cb), cancel = id => cancelAnimationFrame(id)) {
  let value = '';
  let scheduled = false;
  let cancelled = false;
  let handle = null;
  return {
    set(next) {
      if (cancelled) return;
      value = String(next || '');
      if (scheduled) return;
      scheduled = true;
      handle = schedule(() => {
        scheduled = false;
        handle = null;
        if (!cancelled) render(value);
      });
    },
    flush(next) {
      if (cancelled) return;
      value = String(next || '');
      if (handle !== null) cancel(handle);
      handle = null;
      scheduled = false;
      render(value);
    },
    cancel() {
      cancelled = true;
      if (handle !== null) cancel(handle);
      handle = null;
      scheduled = false;
      value = '';
    },
  };
}

module.exports = { createRealtimeRenderer };
