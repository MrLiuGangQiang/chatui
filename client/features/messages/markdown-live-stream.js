(function initChatUIFeaturesMessagesMarkdownLiveStream(root) {
  'use strict';

  function createMarkdownLiveStream(options = {}) {
    const renderMarkdown = options.renderMarkdown || (value => String(value || ''));
    const createStreamingRenderer = options.createStreamingRenderer || root.ChatUIApp?.markdown?.createStreamingRenderer || root.ChatUIMarkdownBrowserStreamingRenderer?.createStreamingRenderer;
    const bindInlineCopyButtons = options.bindInlineCopyButtons || (() => {});
    const enhanceRenderedMarkdown = options.enhanceRenderedMarkdown || (() => {});
    const getNow = options.now || (() => Date.now());
    const minIntervalMs = Number.isFinite(options.minIntervalMs) ? options.minIntervalMs : 90;

    let renderer = null;
    let raw = '';
    let lastRenderAt = 0;

    const makeRenderer = () => createStreamingRenderer?.({
      renderMarkdown,
      enhance: (scopeRoot, phase = {}) => {
        if (phase.final || phase.reset) {
          bindInlineCopyButtons(scopeRoot);
          return enhanceRenderedMarkdown(scopeRoot, {
            streaming: !!phase.streaming,
            deferMermaid: true,
            allowResourceLoad: !!phase.final,
            autoRenderMermaid: !!phase.final,
            forceMermaid: !!phase.final,
          });
        }
        if (phase.streaming && !phase.final) {
          bindInlineCopyButtons(scopeRoot);
          return null;
        }
        bindInlineCopyButtons(scopeRoot);
        return null;
      },
    });

    function ensure(container) {
      if (!renderer) {
        renderer = makeRenderer();
        if (container) container.innerHTML = '';
      }
      return renderer;
    }

    function append(container, value = '', meta = {}) {
      const next = String(value || '');
      const now = getNow();
      const deltaLength = Math.max(0, next.length - raw.length);
      const force = !!meta.force || now - lastRenderAt >= minIntervalMs || next.endsWith('\n') || deltaLength > 3000;
      raw = next;
      const active = ensure(container);
      if (!active) return { raw, skipped: true, missingRenderer: true };
      if (!force && !meta.final) return active.preview?.(next, container) || { raw, skipped: true };
      lastRenderAt = now;
      return active.set(next, container);
    }

    function final(container, value = raw) {
      raw = String(value || '');
      const active = ensure(container);
      if (!active) return { raw, mode: 'missing-renderer', enhanced: false };
      return active.final(container, raw);
    }

    function reset(container) {
      try { renderer?.reset?.(container); } catch {}
      renderer = null;
      raw = '';
      lastRenderAt = 0;
    }

    return Object.freeze({ append, final, reset, getRaw: () => raw });
  }

  const api = Object.freeze({ createMarkdownLiveStream });
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  if (root) root.ChatUIFeaturesMessagesMarkdownLiveStream = api;
  if (root?.window) root.window.ChatUIFeaturesMessagesMarkdownLiveStream = api;
})(typeof globalThis !== 'undefined' ? globalThis : (typeof window !== 'undefined' ? window : this));
