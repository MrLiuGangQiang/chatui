(function initChatUIMarkdownBrowser(global) {
  'use strict';

  const browserEngine = global.ChatUIMarkdownBrowserEngine || {};
  const sourceNormalizer = global.ChatUIMarkdownSourceNormalizer || {};
  const mermaidNormalizer = global.ChatUIMarkdownMermaidNormalizer || {};
  const escapeHtml = browserEngine.escapeHtml || (value => String(value || '').replace(/[&<>"'`]/g, ch => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;', '`': '&#96;' }[ch])));
  const normalizeEscapedUrlSlashes = sourceNormalizer.normalizeEscapedUrlSlashes || (markdown => String(markdown || ''));
  const normalizeMultilineMarkdownImageDataUris = sourceNormalizer.normalizeMultilineMarkdownImageDataUris || (markdown => String(markdown || ''));
  const normalizeMarkdownImageDataUris = sourceNormalizer.normalizeMarkdownImageDataUris || (markdown => String(markdown || ''));
  const normalizeMarkdownSource = sourceNormalizer.normalizeMarkdownSource || (markdown => String(markdown || ''));
  const normalizeBetaMermaidSource = mermaidNormalizer.normalizeBetaMermaidSource || (source => String(source || ''));
  const createMarkdownEngine = browserEngine.createMarkdownEngine || (() => null);
  const getMarkdownEngine = browserEngine.getMarkdownEngine || (() => null);
  const resetMarkdownEngine = browserEngine.resetMarkdownEngine || (() => {});
  const hasCriticalMarkdownPlugins = browserEngine.hasCriticalMarkdownPlugins || (() => false);
  const renderMarkdownFallback = markdown => `<p data-markdown-fallback="1">${escapeHtml(markdown).replace(/\n/g, '<br>')}</p>`;
  const browserStreaming = global.ChatUIMarkdownBrowserStreamingRenderer || {};
  const browserEnhancer = global.ChatUIMarkdownBrowserEnhancer || {};
  const enhanceRenderedMarkdown = browserEnhancer.enhanceRenderedMarkdown || (() => Promise.resolve([]));
  const enhanceCodeCopy = browserEnhancer.enhanceCodeCopy || (() => {});
  const initMermaidToggleUI = browserEnhancer.initMermaidToggleUI || (() => []);
  const renderMermaidBlockOnDemand = browserEnhancer.renderMermaidBlockOnDemand || (async block => ({ ok: false, node: block }));
  const showMermaidSource = browserEnhancer.showMermaidSource || (() => {});
  const renderMermaidBlocks = browserEnhancer.renderMermaidBlocks || (() => Promise.resolve([]));
  const loadMermaid = browserEnhancer.loadMermaid || (async () => global.mermaid || null);

  let markdownReadyPromise = null;
  let deferredRerenderScheduled = false;
  function rerenderFallbackMarkdownMessages() {
    const doc = global.document;
    if (!doc?.querySelectorAll || !hasCriticalMarkdownPlugins()) return;
    const root = doc.getElementById?.('messages') || doc;
    root.querySelectorAll('.message.assistant,.message.error').forEach(message => {
      if (message.dataset.streaming === '1') return;
      const content = message.querySelector?.('.content');
      const raw = (message.__chatuiRawText ?? message.dataset.rawText) || '';
      if (!content || !raw || !content.querySelector?.('[data-markdown-fallback="1"]')) return;
      content.innerHTML = browserEngine.renderMarkdown ? browserEngine.renderMarkdown(raw) : renderMarkdownFallback(raw);
      message.dataset.renderedHash = message.dataset.rawHash || message.dataset.renderedHash || '';
      delete message.dataset.enhancedHash;
      delete message.dataset.markdownFallback;
    });
  }
  function ensureMarkdownReady(options = {}) {
    if (hasCriticalMarkdownPlugins()) return Promise.resolve(true);
    if (!markdownReadyPromise) {
      const loader = global.ChatUIMarkdownDependencyLoader;
      markdownReadyPromise = (loader?.loadCore?.() || loader?.loadAll?.() || Promise.resolve(null))
        .then(() => { resetMarkdownEngine(); return hasCriticalMarkdownPlugins(); })
        .catch(err => { console.warn('[markdown] dependency load failed:', err); resetMarkdownEngine(); return false; });
      global.ChatUIMarkdownReady = markdownReadyPromise;
    }
    if (options.await === true) return markdownReadyPromise;
    if (!deferredRerenderScheduled) markdownReadyPromise.then((ready) => {
      deferredRerenderScheduled = false;
      if (!ready) return;
      try {
        global.ChatUI?.performance?.renderCache?.clear?.();
        rerenderFallbackMarkdownMessages();
        (global.ChatUIApp?.rerenderVisibleMarkdownMessages || global.rerenderVisibleMarkdownMessages)?.();
      } catch (err) { console.warn('[markdown] deferred rerender failed:', err); }
    });
    deferredRerenderScheduled = true;
    return markdownReadyPromise;
  }
  function renderMarkdown(markdown = '', options = {}) {
    if (!hasCriticalMarkdownPlugins()) {
      ensureMarkdownReady({ reason: options.reason || 'render' });
      return renderMarkdownFallback(markdown);
    }
    return browserEngine.renderMarkdown ? browserEngine.renderMarkdown(markdown) : renderMarkdownFallback(markdown);
  }

  function renderMarkdownInto(container, markdown = '', options = {}) { if (!container) return Promise.resolve({ html: renderMarkdown(markdown, options), mermaid: [] }); const html = renderMarkdown(markdown, options); container.innerHTML = html; return Promise.resolve(enhanceRenderedMarkdown(container, options)).then(mermaid => ({ html, mermaid })); }

  const findStableBoundary = browserStreaming.findStableBoundary || (() => 0);
  const splitStableTail = browserStreaming.splitStableTail || (text => ({ stable: '', tail: String(text || ''), index: 0 }));
  const createStreamingRenderer = browserStreaming.createStreamingRenderer || (() => { throw new Error('ChatUIMarkdownBrowserStreamingRenderer unavailable'); });


  const api = Object.freeze({ renderMarkdown, renderMarkdownInto, normalizeBetaMermaidSource, renderMarkdownHtml: renderMarkdown, enhanceRenderedMarkdown, enhanceCodeCopy, initMermaidToggleUI, renderMermaidBlockOnDemand, showMermaidSource, renderMermaidBlocks, loadMermaid, createMarkdownEngine, getMarkdownEngine, resetMarkdownEngine, hasCriticalMarkdownPlugins, ensureMarkdownReady, rerenderFallbackMarkdownMessages, findStableBoundary, splitStableTail, createStreamingRenderer, escapeHtml, normalizeEscapedUrlSlashes, normalizeMultilineMarkdownImageDataUris, normalizeMarkdownImageDataUris, normalizeMarkdownSource, dependencyLoader: global.ChatUIMarkdownDependencyLoader });
  global.ChatUIApp = Object.freeze({ ...(global.ChatUIApp || {}), markdown: api });
  global.ChatUIMarkdown = api;
  global.ChatUIMarkdownReady = hasCriticalMarkdownPlugins()
    ? Promise.resolve(true)
    : ensureMarkdownReady({ await: true, reason: 'bootstrap' });
})(typeof window !== 'undefined' ? window : globalThis);
