(function initChatUIRealtimeRenderer(root) {
  'use strict';

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

const createStreamingRenderer = root?.ChatUIAppMarkdownStreamingRenderer?.createStreamingRenderer
  || root?.window?.ChatUIAppMarkdownStreamingRenderer?.createStreamingRenderer
  || root?.ChatUIApp?.markdown?.createStreamingRenderer
  || root?.window?.ChatUIApp?.markdown?.createStreamingRenderer
  || (typeof require === 'function' ? require('../app/markdown/streaming-renderer').createStreamingRenderer : undefined);

const api = Object.freeze({ createRealtimeRenderer, createStreamingRenderer });

if (typeof module !== 'undefined' && module.exports) module.exports = api;
if (root) root.ChatUIRealtimeRenderer = api;
if (root?.window) root.window.ChatUIRealtimeRenderer = api;
})(typeof globalThis !== 'undefined' ? globalThis : (typeof window !== 'undefined' ? window : this));
