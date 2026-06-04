'use strict';

const { renderMarkdown: renderMarkdownHtml, createMarkdownEngine, getMarkdownEngine, escapeHtml } = require('./markdown-engine');
const { sanitizeHtml } = require('./sanitizer');
const { enhanceRenderedMarkdown, enhanceCodeCopy, initMermaidToggleUI, renderMermaidBlockOnDemand, showMermaidSource, renderMermaidBlocks } = require('./enhancer');
const { findStableBoundary, splitStableTail } = require('./stable-boundary');
const { createStreamingRenderer } = require('./streaming-renderer');
const dependencyLoader = require('./resource-loader');

function renderMarkdown(markdown = '', options = {}) {
  const engine = options.engine || getMarkdownEngine();
  return engine ? engine.render(markdown) : renderMarkdownHtml(markdown);
}

function renderMarkdownInto(container, markdown = '', options = {}) {
  if (!container) return Promise.resolve({ html: renderMarkdown(markdown, options), mermaid: [] });
  const html = renderMarkdown(markdown, options);
  container.innerHTML = html;
  return Promise.resolve(enhanceRenderedMarkdown(container, options)).then(mermaid => ({ html, mermaid }));
}

function createMarkdownRenderer(options = {}) {
  const engine = options.engine || createMarkdownEngine(options);
  return {
    engine,
    render(markdown = '') { return engine ? engine.render(markdown) : renderMarkdownHtml(markdown); },
    enhance(root, enhanceOptions = {}) { return enhanceRenderedMarkdown(root, { ...options, ...enhanceOptions }); },
    renderInto(container, markdown = '', renderOptions = {}) { return renderMarkdownInto(container, markdown, { ...options, ...renderOptions, engine }); },
  };
}

module.exports = {
  createMarkdownRenderer,
  renderMarkdown,
  renderMarkdownInto,
  renderMarkdownHtml,
  createMarkdownEngine,
  getMarkdownEngine,
  sanitizeHtml,
  enhanceRenderedMarkdown,
  enhanceCodeCopy,
  initMermaidToggleUI,
  renderMermaidBlockOnDemand,
  showMermaidSource,
  renderMermaidBlocks,
  findStableBoundary,
  splitStableTail,
  createStreamingRenderer,
  escapeHtml,
  dependencyLoader,
};
