(function initChatUIMessageVirtualizer(global) {
  'use strict';

  const DEFAULTS = Object.freeze({
    enabled: true,
    rootMargin: '1200px 0px',
    unloadMarginPx: 2600,
    minMessages: 30,
    defaultHeight: 180,
    placeholderPreviewChars: 360,
  });

  const escapeHtml = (global.ChatUIAppFormatting || global.ChatUIApp?.formatting || {}).escapeHtml || (value => String(value || '').replace(/[&<>"'`]/g, ch => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;', '`': '&#96;' }[ch])));

  function plainPreview(raw = '', limit = DEFAULTS.placeholderPreviewChars) {
    const text = String(raw || '');
    return `<div class="plain-text markdown-lazy-placeholder">${escapeHtml(text.slice(0, limit))}${text.length > limit ? '\n\n…（滚动到此处后继续渲染）' : ''}</div>`;
  }

  function nearViewport(node, margin, root = null) {
    if (!node?.getBoundingClientRect) return true;
    const r = node.getBoundingClientRect();
    if (root && root !== document && root !== document.documentElement && root.getBoundingClientRect) {
      const rr = root.getBoundingClientRect();
      return r.bottom >= rr.top - margin && r.top <= rr.bottom + margin;
    }
    const h = global.innerHeight || document.documentElement.clientHeight || 800;
    return r.bottom >= -margin && r.top <= h + margin;
  }

  function createMessageVirtualizer(options = {}) {
    const cfg = { ...DEFAULTS, ...options };
    let container = null;
    let observer = null;
    let callbacks = {};
    let generation = 0;
    const heights = new Map();

    function keyFor(node) {
      return node?.dataset?.displayItemId || [node?.dataset?.messageIndex || '', node?.dataset?.responseIndex || '', node?.dataset?.rawHash || ''].join(':');
    }

    function rememberHeight(node) {
      const key = keyFor(node);
      if (!key || !node?.getBoundingClientRect) return;
      const h = Math.ceil(node.getBoundingClientRect().height || node.offsetHeight || 0);
      if (h > 20) heights.set(key, h);
    }

    function cachedHeight(node) {
      return heights.get(keyFor(node)) || Number(node?.dataset?.virtualHeight) || cfg.defaultHeight;
    }

    function renderPlaceholder(node) {
      const content = node?.querySelector?.('.content');
      if (!content || node.dataset.virtualized === '1') return;
      rememberHeight(node);
      const height = cachedHeight(node);
      node.dataset.virtualHeight = String(height);
      node.style.minHeight = `${height}px`;
      content.style.minHeight = `${Math.max(48, height - 8)}px`;
      callbacks.cancel?.(node);
      content.innerHTML = plainPreview(node.dataset.rawText || '', cfg.placeholderPreviewChars);
      node.dataset.virtualized = '1';
      node.dataset.lazyMarkdown = '1';
      delete node.dataset.renderedHash;
      delete node.dataset.enhancedHash;
    }

    function hydrate(node, force = false) {
      if (!node?.isConnected) return;
      if (!force && !nearViewport(node, cfg.unloadMarginPx, cfg.root || container)) return;
      if (node.dataset.virtualized === '1') {
        node.dataset.virtualized = '0';
        node.style.minHeight = '';
        const content = node.querySelector?.('.content');
        if (content) content.style.minHeight = '';
      }
      callbacks.render?.(node, { force: true, generation });
    }

    function maybeUnload(node) {
      if (!cfg.enabled || !node?.isConnected || node.dataset.streaming === '1' || node.dataset.persist === '0') return;
      if (node.classList?.contains('user')) return;
      if (node.querySelector?.('.generated-image-grid,.user-attachment-preview-grid,img.generated-thumb,img.user-attachment-image')) return;
      if (nearViewport(node, cfg.unloadMarginPx, cfg.root || container)) return;
      renderPlaceholder(node);
    }

    function observeNode(node) {
      if (!node || node.dataset.virtualObserved === '1') return;
      node.dataset.virtualObserved = '1';
      observer?.observe(node);
    }

    function refresh() {
      if (!cfg.enabled || !container) return;
      const nodes = [...container.querySelectorAll('.message')];
      if (nodes.length < cfg.minMessages) return nodes.forEach(node => hydrate(node, true));
      const keepFrom = Math.max(0, nodes.length - 8);
      nodes.forEach((node, index) => {
        observeNode(node);
        if (index >= keepFrom || node.dataset.streaming === '1') hydrate(node, true);
        else if (nearViewport(node, cfg.unloadMarginPx / 2, cfg.root || container)) hydrate(node, true);
        else maybeUnload(node);
      });
    }

    function attach(root, cb = {}) {
      callbacks = cb;
      container = root;
      generation += 1;
      disconnect(false);
      if (!cfg.enabled || !container || !('IntersectionObserver' in global)) return { enabled: false };
      observer = new IntersectionObserver(entries => {
        entries.forEach(entry => {
          const node = entry.target;
          if (entry.isIntersecting || entry.intersectionRatio > 0) hydrate(node, true);
          else setTimeout(() => maybeUnload(node), 80);
        });
      }, { root: cfg.root || container || null, rootMargin: cfg.rootMargin, threshold: 0.01 });
      refresh();
      return { enabled: true };
    }

    function disconnect(bump = true) {
      if (bump) generation += 1;
      observer?.disconnect?.();
      observer = null;
      container?.querySelectorAll?.('.message[data-virtual-observed="1"]').forEach(node => { delete node.dataset.virtualObserved; });
    }

    return {
      attach,
      disconnect,
      refresh,
      observe: observeNode,
      hydrate,
      unload: renderPlaceholder,
      rememberHeight,
      stats() {
        const nodes = container ? [...container.querySelectorAll('.message')] : [];
        return { enabled: cfg.enabled, messages: nodes.length, virtualized: nodes.filter(n => n.dataset.virtualized === '1').length, heights: heights.size, generation };
      },
    };
  }

  const api = Object.freeze({ createMessageVirtualizer, plainPreview, nearViewport });
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  if (global) {
    const existing = global.ChatUI || {};
    global.ChatUI = Object.freeze({ ...existing, performance: Object.freeze({ ...(existing.performance || {}), createMessageVirtualizer }) });
  }
})(typeof window !== 'undefined' ? window : globalThis);
