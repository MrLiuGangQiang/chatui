function createRealtimeRenderer(render, options = {}) {
  let value = '';
  let cancelled = false;
  return {
    set(next) {
      if (cancelled) return;
      value = String(next || '');
      render(value);
    },
    flush(next) {
      if (cancelled) return;
      value = String(next || '');
      render(value);
    },
    cancel() {
      cancelled = true;
      value = '';
    },
  };
}

module.exports = { createRealtimeRenderer };
