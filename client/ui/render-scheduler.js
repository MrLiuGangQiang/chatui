(function initChatUIRenderScheduler(global) {
  'use strict';

  function now() { return global.performance?.now ? global.performance.now() : Date.now(); }

  function scheduleIdle(callback, timeoutMs = 1200) {
    let done = false;
    const handle = { idleHandle: null, fallbackHandle: null, timerHandle: null, cancelled: false, cancel: null };
    const run = deadline => {
      if (done || handle.cancelled) return;
      done = true;
      if (handle.fallbackHandle != null) clearTimeout(handle.fallbackHandle);
      if (handle.timerHandle != null) clearTimeout(handle.timerHandle);
      if (handle.idleHandle != null && typeof global.cancelIdleCallback === 'function') global.cancelIdleCallback(handle.idleHandle);
      callback(deadline || { didTimeout: true, timeRemaining: () => 0 });
    };
    handle.fallbackHandle = setTimeout(() => run({ didTimeout: true, timeRemaining: () => 0 }), timeoutMs + 80);
    if (typeof global.requestIdleCallback === 'function') handle.idleHandle = global.requestIdleCallback(run, { timeout: timeoutMs });
    else handle.timerHandle = setTimeout(() => run({ didTimeout: false, timeRemaining: () => 8 }), 0);
    handle.cancel = () => cancelIdle(handle);
    return handle;
  }

  function cancelIdle(handle) {
    if (!handle) return;
    handle.cancelled = true;
    if (handle.idleHandle != null && typeof global.cancelIdleCallback === 'function') global.cancelIdleCallback(handle.idleHandle);
    if (handle.fallbackHandle != null) clearTimeout(handle.fallbackHandle);
    if (handle.timerHandle != null) clearTimeout(handle.timerHandle);
  }

  function createRenderScheduler(options = {}) {
    const budgetMs = Number(options.budgetMs) || 10;
    const batchSize = Number(options.batchSize) || 4;
    const queue = [];
    const ids = new Set();
    let handle = null;
    let generation = 0;

    const pump = deadline => {
      handle = null;
      const token = generation;
      const started = now();
      let count = 0;
      while (queue.length && token === generation) {
        const job = queue.shift();
        ids.delete(job.id);
        if (job.cancelled || job.signal?.cancelled || (job.node && job.node.isConnected === false)) continue;
        try { job.run?.(); } catch (err) { console.warn('[ChatUI scheduler] job failed', err); }
        count += 1;
        const left = typeof deadline?.timeRemaining === 'function' ? deadline.timeRemaining() : Math.max(0, budgetMs - (now() - started));
        if (count >= batchSize || left <= 2 || now() - started >= budgetMs) break;
      }
      if (queue.length && token === generation) handle = scheduleIdle(pump, options.timeoutMs || 1000);
    };

    const ensure = () => { if (!handle) handle = scheduleIdle(pump, options.timeoutMs || 1000); };

    return {
      enqueue(id, run, meta = {}) {
        const key = String(id || `job-${Date.now()}-${Math.random()}`);
        if (ids.has(key)) return { id: key, cancel: () => this.cancel(key) };
        ids.add(key);
        queue.push({ id: key, run, ...meta });
        ensure();
        return { id: key, cancel: () => this.cancel(key) };
      },
      cancel(id) {
        const key = String(id || '');
        ids.delete(key);
        queue.forEach(job => { if (job.id === key) job.cancelled = true; });
      },
      cancelAll() {
        generation += 1;
        queue.splice(0).forEach(job => { job.cancelled = true; });
        ids.clear();
        cancelIdle(handle);
        handle = null;
      },
      stats() { return { queued: queue.length, deduped: ids.size, generation }; },
    };
  }

  const scheduler = createRenderScheduler(global.CHATUI_RENDER_SCHEDULER_OPTIONS || {});
  const api = Object.freeze({ scheduleIdle, cancelIdle, createRenderScheduler, scheduler });
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  if (global) {
    const existing = global.ChatUI || {};
    global.ChatUI = Object.freeze({ ...existing, performance: Object.freeze({ ...(existing.performance || {}), scheduler, scheduleIdle, cancelIdle, createRenderScheduler }) });
  }
})(typeof window !== 'undefined' ? window : globalThis);
