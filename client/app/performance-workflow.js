(function initChatUIAppPerformanceWorkflow(root) {
  'use strict';

  const textHash = root?.[Symbol.for('chatui.module-registry.v1')]?.get('textHash')
    || (typeof require === 'function' ? require('../core/text-hash') : {});
  const contentHash = textHash.contentHash || (value => `${String(value || '').length}:0`);

  function createPerformanceWorkflow(deps = {}) {
    const {
      state,
      getElement,
      document,
      window,
      localStorage,
      performance,
      requestAnimationFrame,
      requestIdleCallback,
      cancelIdleCallback,
      setTimeout,
      clearTimeout,
      renderMarkdown,
      bindInlineCopyButtons,
      enhanceRenderedMarkdown,
      hydrateMessageMedia,
      escapeHtml,
    } = deps;

    function chatuiPerfNow() { return performance?.now ? performance.now() : Date.now(); }
    function chatuiLogLongTask(stage, durationMs, details = {}) {
      if (durationMs < 50) return;
      const entry = { stage, durationMs: Math.round(durationMs), ...details };
      window.__chatuiPerfLog = window.__chatuiPerfLog || [];
      window.__chatuiPerfLog.push(entry);
      if (window.__chatuiPerfLog.length > 120) window.__chatuiPerfLog.shift();
      console.warn('[ChatUI perf]', entry);
    }
    const chatuiContentHash = contentHash;
    function chatuiPlainPreview(value = '') {
      const text = String(value || '');
      return `<div class="plain-text markdown-lazy-placeholder">${escapeHtml(text.slice(0, 1600))}${text.length > 1600 ? '\n\n…（滚动到此处后继续渲染 Markdown）' : ''}</div>`;
    }

    const chatuiLazyRenderQueue = new Map();
    let chatuiLazyObserver = null;
    let chatuiMessageVirtualizer = null;
    let chatuiVirtualizerAttached = false;
    let chatuiVirtualizerRefreshFrame = null;
    let chatuiVirtualizerRefreshTimer = null;

    function chatuiScheduleIdle(callback, timeoutMs = 1500) {
      let done = false;
      let idleHandle = null;
      let fallbackHandle = null;
      const run = deadline => {
        if (done) return;
        done = true;
        if (fallbackHandle) clearTimeout(fallbackHandle);
        callback(deadline || { didTimeout: true, timeRemaining: () => 0 });
      };
      fallbackHandle = window.setTimeout.call(window, () => run({ didTimeout: true, timeRemaining: () => 0 }), timeoutMs + 100);
      if (typeof requestIdleCallback === 'function') idleHandle = requestIdleCallback(run, { timeout: timeoutMs });
      else window.setTimeout.call(window, () => run({ didTimeout: false, timeRemaining: () => 8 }), 0);
      return { idleHandle, fallbackHandle };
    }
    function chatuiCancelIdle(handle) {
      if (!handle) return;
      if (typeof handle === 'object') {
        if (handle.idleHandle != null && typeof cancelIdleCallback === 'function') cancelIdleCallback(handle.idleHandle);
        if (handle.fallbackHandle != null) window.clearTimeout.call(window, handle.fallbackHandle);
        return;
      }
      if (typeof cancelIdleCallback === 'function') cancelIdleCallback(handle);
      else clearTimeout(handle);
    }
    function chatuiGetMessagesRoot() { return getElement('messages') || document.scrollingElement || document.documentElement; }
    function chatuiIsNearViewport(node, margin = 900) {
      if (!node?.getBoundingClientRect) return true;
      const rect = node.getBoundingClientRect();
      const rootNode = chatuiGetMessagesRoot();
      if (rootNode && rootNode !== document.scrollingElement && rootNode !== document.documentElement && rootNode.getBoundingClientRect) {
        const rootRect = rootNode.getBoundingClientRect();
        return rect.bottom >= rootRect.top - margin && rect.top <= rootRect.bottom + margin;
      }
      const height = window.innerHeight || document.documentElement.clientHeight || 800;
      return rect.bottom >= -margin && rect.top <= height + margin;
    }
    function chatuiEnsureLazyObserver() {
      if (chatuiLazyObserver || !('IntersectionObserver' in window)) return chatuiLazyObserver;
      chatuiLazyObserver = new IntersectionObserver(entries => {
        entries.forEach(entry => {
          if (entry.isIntersecting || entry.intersectionRatio > 0) chatuiRenderLazyMessage(entry.target, { force: true });
        });
      }, { root: chatuiGetMessagesRoot(), rootMargin: '1000px 0px', threshold: 0.01 });
      return chatuiLazyObserver;
    }
    function chatuiReadBooleanFlag(key, fallback = false) {
      try {
        const value = localStorage.getItem(key);
        if (value === null) return fallback;
        if (/^(0|false|no|off)$/i.test(String(value))) return false;
        return /^(1|true|yes|on)$/i.test(String(value));
      } catch { return fallback; }
    }

    const CHATUI_ENABLE_VIRTUAL_RENDER = window.CHATUI_ENABLE_VIRTUAL_RENDER !== false && chatuiReadBooleanFlag('chatui:enableVirtualRender', true);
    const CHATUI_PERF_FLAGS = {
      virtualRender: CHATUI_ENABLE_VIRTUAL_RENDER,
      virtualMessages: false,
      lazyMarkdown: CHATUI_ENABLE_VIRTUAL_RENDER && chatuiReadBooleanFlag('chatui:enableLazyMarkdown', true),
      renderCache: CHATUI_ENABLE_VIRTUAL_RENDER && chatuiReadBooleanFlag('chatui:enableRenderCache', true),
      scheduler: CHATUI_ENABLE_VIRTUAL_RENDER && chatuiReadBooleanFlag('chatui:enableRenderScheduler', true),
    };
    try { window.CHATUI_ENABLE_VIRTUAL_RENDER = CHATUI_ENABLE_VIRTUAL_RENDER; } catch {}

    function messageIsTailCandidate(role, options = {}) {
      const total = Array.isArray(state?.messages) ? state.messages.length : 0;
      const rawIndex = role === 'user' ? options.messageIndex : options.responseIndex;
      const index = Number(rawIndex);
      if (!Number.isFinite(index) || index < 0 || !total) return false;
      return total - index <= 10;
    }
    function hasComplexMarkdown(text = '') {
      const raw = String(text || '');
      return /```|~~~|\|\s*[-:]+\s*\||<img\b|!\[[^\]]*\]\(|\bmermaid\b|\$\$|<table\b|<iframe\b/i.test(raw);
    }
    function chatuiShouldLazyRender(role, text, options = {}) {
      if (!CHATUI_PERF_FLAGS.lazyMarkdown) return false;
      const normalizedRole = role === 'error' ? 'assistant' : role;
      if (normalizedRole === 'user') return false;
      const raw = String(text || '');
      if (!raw.trim()) return false;
      const historyRender = options.noScroll || options.deferSave || options.history || options.restore;
      if (!historyRender && !options.final) return false;
      if (options.lazy === false || options.noLazy === true || options.forceRender === true) return false;
      if (options.html || options.streaming || options.streamKind || options.pending || options.deferEnhance) return false;
      if (messageIsTailCandidate(normalizedRole, options)) return false;
      if (raw.length > 1600 || raw.split('\n').length > 80) return true;
      return historyRender && hasComplexMarkdown(raw);
    }

    function chatuiRenderLazyMessage(node, options = {}) {
      if (!node?.isConnected) return;
      const queued = chatuiLazyRenderQueue.get(node);
      if (queued?.idle) chatuiCancelIdle(queued.idle);
      chatuiLazyRenderQueue.delete(node);
      chatuiLazyObserver?.unobserve?.(node);
      const content = node.querySelector('.content');
      const raw = node.dataset.rawText || '';
      const hash = node.dataset.rawHash || chatuiContentHash(raw);
      if (!content || (node.dataset.renderedHash === hash && node.dataset.enhancedHash === hash)) return;
      if (!chatuiIsNearViewport(node) && !options.force && !queued?.force) {
        chatuiQueueLazyMessage(node, raw, { force: false });
        return;
      }
      const started = chatuiPerfNow();
      const renderJob = () => {
        content.style.minHeight = '';
        content.innerHTML = renderMarkdown(raw);
        node.dataset.renderedHash = hash;
        node.dataset.lazyMarkdown = '0';
        bindInlineCopyButtons(node);
        const enhancePromise = enhanceRenderedMarkdown(node, { deferMermaid: true, allowResourceLoad: true, autoRenderMermaid: true, forceMermaid: true });
        window.ChatUIScrollCoordinator?.registerLayoutPromise?.(enhancePromise, 'lazy-enhance');
        hydrateMessageMedia(node, { save: false });
        node.dataset.enhancedHash = hash;
        window.ChatUIScrollCoordinator?.notifyLayoutChange?.('lazy-render');
        chatuiLogLongTask('message.lazyRender', chatuiPerfNow() - started, { chars: raw.length });
      };
      const scheduler = CHATUI_PERF_FLAGS.scheduler ? window.ChatUI?.performance?.scheduler : null;
      if (scheduler?.enqueue && !options.force) scheduler.enqueue(`lazy:${hash}:${node.dataset.displayItemId || node.dataset.responseIndex || ''}`, renderJob, { node });
      else renderJob();
    }
    function chatuiQueueLazyMessage(node, text, options = {}) {
      if (!node?.isConnected) return;
      const hash = chatuiContentHash(text);
      node.dataset.rawHash = hash;
      if (node.dataset.renderedHash === hash && node.dataset.enhancedHash === hash) return;
      const content = node.querySelector('.content');
      if (content && node.dataset.lazyMarkdown !== '1') {
        const currentHeight = Math.ceil(node.getBoundingClientRect?.().height || 0);
        if (currentHeight > 40) content.style.minHeight = `${Math.max(48, currentHeight - 8)}px`;
        content.innerHTML = chatuiPlainPreview(text);
        node.dataset.lazyMarkdown = '1';
      }
      const existing = chatuiLazyRenderQueue.get(node);
      if (existing?.idle) chatuiCancelIdle(existing.idle);
      chatuiEnsureLazyObserver()?.observe(node);
      if (options.force || chatuiIsNearViewport(node)) {
        const idle = chatuiScheduleIdle(() => chatuiRenderLazyMessage(node, { force: !!options.force }), 1200);
        chatuiLazyRenderQueue.set(node, { idle, hash, force: !!options.force });
      } else {
        chatuiLazyRenderQueue.set(node, { idle: null, hash, force: false });
      }
    }

    function chatuiCancelMessageJobs(node) {
      try { node?.__chatuiEnhanceJob?.cancel?.(); } catch {}
      try { node?.__markdownStreamingRenderer?.reset?.(); } catch {}
      const queued = chatuiLazyRenderQueue.get(node);
      if (queued?.idle) chatuiCancelIdle(queued.idle);
      chatuiLazyRenderQueue.delete(node);
      chatuiLazyObserver?.unobserve?.(node);
    }
    function chatuiDisconnectVirtualizer() {
      try { chatuiMessageVirtualizer?.disconnect?.(); } catch {}
      if (chatuiVirtualizerRefreshFrame != null) {
        try { window.cancelAnimationFrame?.(chatuiVirtualizerRefreshFrame); } catch {}
        chatuiVirtualizerRefreshFrame = null;
      }
      if (chatuiVirtualizerRefreshTimer != null) {
        clearTimeout(chatuiVirtualizerRefreshTimer);
        chatuiVirtualizerRefreshTimer = null;
      }
      chatuiVirtualizerAttached = false;
    }
    function chatuiEnsureVirtualizer() {
      if (!CHATUI_PERF_FLAGS.virtualMessages) return null;
      if (!chatuiMessageVirtualizer) {
        chatuiMessageVirtualizer = window.ChatUI?.performance?.createMessageVirtualizer?.({
          enabled: true,
          minMessages: 48,
          unloadMarginPx: 3200,
          rootMargin: '1400px 0px',
          root: getElement('messages'),
        }) || null;
      }
      return chatuiMessageVirtualizer;
    }
    function chatuiRunVirtualizerRefresh() {
      chatuiVirtualizerRefreshFrame = null;
      chatuiVirtualizerRefreshTimer = null;
      if (!CHATUI_PERF_FLAGS.virtualMessages) return;
      if (chatuiMessageVirtualizer && !chatuiVirtualizerAttached) chatuiAttachVirtualizer();
      if (chatuiMessageVirtualizer) chatuiMessageVirtualizer.refresh?.();
      else chatuiAttachVirtualizer();
    }
    function chatuiScheduleVirtualizerRefresh() {
      if (!CHATUI_PERF_FLAGS.virtualMessages) return;
      if (chatuiVirtualizerRefreshFrame != null || chatuiVirtualizerRefreshTimer != null) return;
      if (typeof requestAnimationFrame === 'function') {
        chatuiVirtualizerRefreshFrame = requestAnimationFrame(chatuiRunVirtualizerRefresh);
      } else {
        chatuiVirtualizerRefreshTimer = setTimeout(chatuiRunVirtualizerRefresh, 0);
      }
    }
    function chatuiAttachVirtualizer() {
      if (!CHATUI_PERF_FLAGS.virtualMessages) return;
      const messages = getElement('messages');
      const virtualizer = chatuiEnsureVirtualizer();
      if (!messages || !virtualizer) return;
      const nodes = [...messages.querySelectorAll('.message')];
      if (nodes.length < 48) return;
      virtualizer.attach(messages, { render: (node, options = {}) => chatuiRenderLazyMessage(node, { ...options, force: true }), cancel: chatuiCancelMessageJobs });
      chatuiVirtualizerAttached = true;
      chatuiScheduleVirtualizerRefresh();
    }
    function chatuiRefreshVirtualizer() {
      chatuiScheduleVirtualizerRefresh();
    }
    function chatuiPerfStats() {
      const messages = getElement('messages');
      const nodes = messages ? [...messages.querySelectorAll('.message')] : [];
      return {
        flags: CHATUI_PERF_FLAGS,
        modules: {
          cache: !!window.ChatUI?.performance?.renderCache,
          scheduler: !!window.ChatUI?.performance?.scheduler,
          virtualizer: !!chatuiMessageVirtualizer,
        },
        container: messages ? {
          selector: '#messages',
          children: messages.children.length,
          scrollTop: messages.scrollTop,
          scrollHeight: messages.scrollHeight,
          clientHeight: messages.clientHeight,
          overflowY: window.getComputedStyle(messages).overflowY,
        } : null,
        messages: nodes.length,
        lazy: nodes.filter(node => node.dataset.lazyMarkdown === '1' || node.dataset.lazy === '1').length,
        virtualized: nodes.filter(node => node.dataset.virtualized === '1').length,
        rendered: nodes.filter(node => node.dataset.renderedHash).length,
        cache: window.ChatUI?.performance?.renderCache?.stats?.() || null,
        scheduler: window.ChatUI?.performance?.scheduler?.stats?.() || null,
        virtualizer: chatuiMessageVirtualizer?.stats?.() || null,
        scroll: window.ChatUIScrollCoordinator ? { pinned: window.ChatUIScrollCoordinator.isPinned?.(), pending: window.ChatUIScrollCoordinator.pendingCount?.() } : null,
        perfLog: window.__chatuiPerfLog || [],
      };
    }

    window.ChatUIPerf = { getStats: chatuiPerfStats, flags: CHATUI_PERF_FLAGS, attachVirtualizer: chatuiAttachVirtualizer, refreshVirtualizer: chatuiRefreshVirtualizer, renderLazyMessage: chatuiRenderLazyMessage };
    window.chatuiRenderLazyMessage = chatuiRenderLazyMessage;
    window.chatuiEnsureVirtualizer = chatuiEnsureVirtualizer;
    window.chatuiAttachVirtualizer = chatuiAttachVirtualizer;
    window.chatuiRefreshVirtualizer = chatuiRefreshVirtualizer;

    return Object.freeze({
      chatuiPerfNow,
      chatuiLogLongTask,
      chatuiContentHash,
      chatuiPlainPreview,
      chatuiScheduleIdle,
      chatuiCancelIdle,
      chatuiGetMessagesRoot,
      chatuiIsNearViewport,
      chatuiEnsureLazyObserver,
      chatuiRenderLazyMessage,
      chatuiQueueLazyMessage,
      chatuiReadBooleanFlag,
      chatuiShouldLazyRender,
      chatuiCancelMessageJobs,
      chatuiDisconnectVirtualizer,
      chatuiEnsureVirtualizer,
      chatuiAttachVirtualizer,
      chatuiRefreshVirtualizer,
      chatuiPerfStats,
      flags: CHATUI_PERF_FLAGS,
    });
  }

  const api = Object.freeze({ createPerformanceWorkflow });
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  if (root) root.ChatUIAppPerformanceWorkflow = api;
  if (root?.window) root.window.ChatUIAppPerformanceWorkflow = api;
})(typeof globalThis !== 'undefined' ? globalThis : (typeof window !== 'undefined' ? window : this));
