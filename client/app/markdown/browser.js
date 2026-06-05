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
  const renderMarkdown = browserEngine.renderMarkdown || (markdown => `<p>${escapeHtml(markdown).replace(/\n/g, '<br>')}</p>`);
  const browserEnhancer = global.ChatUIMarkdownBrowserEnhancer || {};
  const enhanceRenderedMarkdown = browserEnhancer.enhanceRenderedMarkdown || (() => Promise.resolve([]));
  const enhanceCodeCopy = browserEnhancer.enhanceCodeCopy || (() => {});
  const initMermaidToggleUI = browserEnhancer.initMermaidToggleUI || (() => []);
  const renderMermaidBlockOnDemand = browserEnhancer.renderMermaidBlockOnDemand || (async block => ({ ok: false, node: block }));
  const showMermaidSource = browserEnhancer.showMermaidSource || (() => {});
  const renderMermaidBlocks = browserEnhancer.renderMermaidBlocks || (() => Promise.resolve([]));
  const loadMermaid = browserEnhancer.loadMermaid || (async () => global.mermaid || null);


  function renderMarkdownInto(container, markdown = '', options = {}) { if (!container) return Promise.resolve({ html: renderMarkdown(markdown), mermaid: [] }); const html = renderMarkdown(markdown); container.innerHTML = html; return Promise.resolve(enhanceRenderedMarkdown(container, options)).then(mermaid => ({ html, mermaid })); }

  const browserStreaming = global.ChatUIMarkdownBrowserStreamingRenderer || {};
  const findStableBoundary = browserStreaming.findStableBoundary || (() => 0);
  const splitStableTail = browserStreaming.splitStableTail || (text => ({ stable: '', tail: String(text || ''), index: 0 }));
  const createStreamingRenderer = browserStreaming.createStreamingRenderer || (() => { throw new Error('ChatUIMarkdownBrowserStreamingRenderer unavailable'); });


  const api = Object.freeze({ renderMarkdown, renderMarkdownInto, normalizeBetaMermaidSource, renderMarkdownHtml: renderMarkdown, enhanceRenderedMarkdown, enhanceCodeCopy, initMermaidToggleUI, renderMermaidBlockOnDemand, showMermaidSource, renderMermaidBlocks, loadMermaid, createMarkdownEngine, getMarkdownEngine, resetMarkdownEngine, hasCriticalMarkdownPlugins, findStableBoundary, splitStableTail, createStreamingRenderer, escapeHtml, normalizeEscapedUrlSlashes, normalizeMultilineMarkdownImageDataUris, normalizeMarkdownImageDataUris, normalizeMarkdownSource, dependencyLoader: global.ChatUIMarkdownDependencyLoader });
  global.ChatUIApp = Object.freeze({ ...(global.ChatUIApp || {}), markdown: api });
  global.ChatUIMarkdown = api;
  global.ChatUIMarkdownReady = (global.ChatUIMarkdownDependencyLoader?.loadAll?.() || Promise.resolve()).then(result => { resetMarkdownEngine(); return result; }).catch(err => { console.warn('[markdown] dependency load failed:', err); resetMarkdownEngine(); return null; });
})(typeof window !== 'undefined' ? window : globalThis);
