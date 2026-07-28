(function initChatUIRenderCache(global) {
  'use strict';

  function fnv1a(value = '') {
    const text = String(value || '');
    let hash = 2166136261;
    for (let i = 0; i < text.length; i += 1) {
      hash ^= text.charCodeAt(i);
      hash = Math.imul(hash, 16777619);
    }
    return `${text.length}:${(hash >>> 0).toString(36)}`;
  }

  function createLRUCache(maxEntries = 180, maxChars = 3_000_000) {
    const limit = Math.max(20, Number(maxEntries) || 180);
    const charLimit = Math.max(100_000, Number(maxChars) || 3_000_000);
    const map = new Map();
    let chars = 0;
    const touch = key => {
      if (!map.has(key)) return null;
      const value = map.get(key);
      map.delete(key);
      map.set(key, value);
      return value;
    };
    const trim = () => {
      while (map.size > limit || chars > charLimit) {
        const first = map.keys().next().value;
        if (first === undefined) break;
        const item = map.get(first);
        chars -= item?.size || 0;
        map.delete(first);
      }
    };
    return {
      get(key) { return touch(key); },
      set(key, value) {
        if (map.has(key)) {
          const old = map.get(key);
          chars -= old?.size || 0;
          map.delete(key);
        }
        const item = { value, size: String(value || '').length, at: Date.now() };
        chars += item.size;
        map.set(key, item);
        trim();
        return value;
      },
      has(key) { return map.has(key); },
      clear() { map.clear(); chars = 0; },
      stats() { return { entries: map.size, chars, maxEntries: limit, maxChars: charLimit }; },
      size() { return map.size; },
    };
  }

  function markdownCacheNamespace(options = {}) {
    const explicit = options.namespace || global.CHATUI_RENDER_CACHE_NAMESPACE || global.CHATUI_MARKDOWN_CACHE_VERSION || 'md-v2';
    let readiness = 'fallback';
    try { readiness = global.ChatUIMarkdownBrowserEngine?.hasCriticalMarkdownPlugins?.() ? 'ready' : 'fallback'; } catch {}
    return `${explicit}:${readiness}`;
  }

  function createRenderCache(options = {}) {
    const htmlCache = createLRUCache(options.maxEntries || 180, options.maxChars || 3_000_000);
    let hits = 0;
    let misses = 0;
    function keyFor(raw = '') { return `${markdownCacheNamespace(options)}:${fnv1a(raw)}`; }
    return {
      keyFor,
      render(raw = '', renderer) {
        const text = String(raw || '');
        const key = keyFor(text);
        const cached = htmlCache.get(key)?.value;
        if (cached && cached.raw === text) {
          hits += 1;
          return cached.value;
        }
        misses += 1;
        const html = renderer(text);
        htmlCache.set(key, { raw: text, value: html });
        return html;
      },
      get(raw = '') {
        const text = String(raw || '');
        const cached = htmlCache.get(keyFor(text))?.value;
        return cached && cached.raw === text ? cached.value : null;
      },
      put(raw = '', html = '') { htmlCache.set(keyFor(raw), { raw: String(raw || ''), value: String(html || '') }); return html; },
      clear() { htmlCache.clear(); hits = 0; misses = 0; },
      stats() { const base = htmlCache.stats(); return { ...base, entries: htmlCache.size ? htmlCache.size() : base.entries, hits, misses, namespace: markdownCacheNamespace(options) }; },
    };
  }

  const renderCache = createRenderCache(global.CHATUI_RENDER_CACHE_OPTIONS || {});
  const api = Object.freeze({ createLRUCache, createRenderCache, renderCache, fnv1a });

  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  if (global) {
    const existing = global.ChatUI || {};
    global.ChatUI = Object.freeze({ ...existing, performance: Object.freeze({ ...(existing.performance || {}), createLRUCache, createRenderCache, renderCache }) });
  }
})(typeof window !== 'undefined' ? window : globalThis);
