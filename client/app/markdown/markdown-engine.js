'use strict';

const { sanitizeHtml } = require('./sanitizer');
const { escapeHtml, applyMathPlugin } = require('./math-renderer');
const {
  normalizeEscapedUrlSlashes,
  normalizeMultilineMarkdownImageDataUris,
  normalizeMarkdownImageDataUris,
  normalizeMarkdownSource,
} = require('./source-normalizer');
const { isSafeMarkdownLink } = require('./link-policy');
const {
  MERMAID_LANGS,
  applyTaskListFallback,
  normalizeTableAlignToken,
  normalizeBlockquoteFencedCodeContent,
  decodeHtmlEntities,
  highlightedTextMatchesSource,
} = require('./engine-primitives');

const PLUGINS = Object.freeze([
  { packageName: 'markdown-it-texmath', globalName: 'markdownItTexmath', math: true },
  { packageName: 'markdown-it-multimd-table', globalName: 'markdownitMultimdTable', options: { multiline: true, rowspan: true, headerless: false, multibody: true, autolabel: true } },
  { packageName: 'markdown-it-task-lists', globalName: 'markdownItTaskLists', options: { enabled: true, label: true, labelAfter: true } },
  { packageName: 'markdown-it-emoji', globalName: 'markdownitEmoji' },
  { packageName: 'markdown-it-footnote', globalName: 'markdownitFootnote' },
  { packageName: 'markdown-it-deflist', globalName: 'markdownitDeflist' },
  { packageName: 'markdown-it-abbr', globalName: 'markdownitAbbr' },
  { packageName: 'markdown-it-mark', globalName: 'markdownitMark' },
  { packageName: 'markdown-it-sub', globalName: 'markdownitSub' },
  { packageName: 'markdown-it-sup', globalName: 'markdownitSup' },
]);

function readGlobal(name) {
  if (typeof globalThis === 'undefined') return null;
  const direct = String(name || '').split('.').filter(Boolean).reduce((target, key) => (target && target[key] ? target[key] : null), globalThis);
  if (direct) return direct;
  if (name === 'markdownItTaskLists') return globalThis.markdownitTaskLists || null;
  return null;
}
function loadOptional(packageName, globalName) { try { if (typeof require === 'function') return require(packageName); } catch {} return readGlobal(globalName || packageName); }
function pluginExport(mod) { return mod && (mod.default || mod.full || mod); }
function slugify(value = '') { return String(value).trim().toLowerCase().replace(/[`~!@#$%^&*()+=[\]{};:'",.<>/?\\|]/g, '').replace(/\s+/g, '-').replace(/-+/g, '-').replace(/^-|-$/g, ''); }
function applyPlugin(md, descriptor) {
  const plugin = pluginExport(loadOptional(descriptor.packageName, descriptor.globalName));
  if (!plugin) { console.warn(`[markdown] plugin unavailable: ${descriptor.packageName}`); return false; }
  try { md.use(plugin, descriptor.options); return true; } catch (err) { console.warn(`[markdown] plugin failed: ${descriptor.packageName}`, err); return false; }
}

function createMarkdownEngine(options = {}) {
  const MarkdownIt = options.MarkdownIt || loadOptional('markdown-it', 'markdownit');
  if (!MarkdownIt) return null;
  const hljs = options.hljs || loadOptional('highlight.js', 'hljs');
  const katex = options.katex || loadOptional('katex', 'katex');
  const md = MarkdownIt({
    html: options.allowHtml !== false,
    xhtmlOut: false,
    breaks: true,
    linkify: true,
    typographer: false,
    highlight(code, lang) {
      const language = String(lang || '').trim().split(/\s+/)[0];
      const raw = String(code || '');
      const rawHtml = escapeHtml(raw);
      try {
        if (hljs && language && hljs.getLanguage?.(language)) {
          const highlighted = hljs.highlight(raw, { language, ignoreIllegals: true }).value;
          const body = highlightedTextMatchesSource(highlighted, raw) ? highlighted : rawHtml;
          return `<pre><code class="hljs language-${escapeHtml(language)}">${body}</code></pre>`;
        }
        if (hljs) {
          const highlighted = hljs.highlightAuto(raw).value;
          const body = highlightedTextMatchesSource(highlighted, raw) ? highlighted : rawHtml;
          return `<pre><code class="hljs">${body}</code></pre>`;
        }
      } catch (err) { console.warn('[markdown] highlight failed:', err); }
      return `<pre><code${language ? ` class="language-${escapeHtml(language)}"` : ''}>${rawHtml}</code></pre>`;
    },
  }).enable(['table', 'strikethrough']);
  md.validateLink = isSafeMarkdownLink;
  const loadedPlugins = [];
  const mathPluginLoaded = applyMathPlugin(md, { loadOptional, katexOptions: options.katexOptions });
  if (mathPluginLoaded) loadedPlugins.push('markdown-it-texmath');
  for (const desc of PLUGINS.filter(item => !item.math)) {
    if (applyPlugin(md, desc)) loadedPlugins.push(desc.packageName);
  }

  const defaultFence = md.renderer.rules.fence;
  md.renderer.rules.fence = (tokens, idx, opts, env, slf) => {
    const token = tokens[idx];
    const lang = (token.info || '').trim().split(/\s+/)[0].toLowerCase();
    token.content = normalizeBlockquoteFencedCodeContent(token.content);
    if (MERMAID_LANGS.has(lang)) return `<div class="mermaid-block markdown-mermaid-pending" data-mermaid-rendered="0"><pre><code class="language-mermaid">${escapeHtml(token.content)}</code></pre></div>`;
    return defaultFence(tokens, idx, opts, env, slf);
  };
  const defaultLinkOpen = md.renderer.rules.link_open || ((tokens, idx, opts, env, slf) => slf.renderToken(tokens, idx, opts));
  md.renderer.rules.link_open = (tokens, idx, opts, env, slf) => {
    const href = tokens[idx].attrGet('href') || '';
    if (/^https?:/i.test(href)) { tokens[idx].attrSet('target', '_blank'); tokens[idx].attrSet('rel', 'noopener noreferrer'); }
    return defaultLinkOpen(tokens, idx, opts, env, slf);
  };
  ['th_open', 'td_open'].forEach(rule => {
    const defaultRule = md.renderer.rules[rule] || ((tokens, idx, opts, env, slf) => slf.renderToken(tokens, idx, opts));
    md.renderer.rules[rule] = (tokens, idx, opts, env, slf) => {
      normalizeTableAlignToken(tokens[idx]);
      return defaultRule(tokens, idx, opts, env, slf);
    };
  });

  function render(markdown = '') {
    const source = normalizeMarkdownSource(markdown);
    let html = '';
    try { html = md.render(source); } catch (err) { console.warn('[markdown] render failed:', err); html = `<p>${escapeHtml(source).replace(/\n/g, '<br>')}</p>`; }
    return applyTaskListFallback(sanitizeHtml(applyTaskListFallback(html)));
  }
  return { md, render, plugins: loadedPlugins };
}

let singleton = null;
function getMarkdownEngine() { if (!singleton) singleton = createMarkdownEngine(); return singleton; }
function renderMarkdown(markdown = '') { const engine = getMarkdownEngine(); return engine ? engine.render(markdown) : `<p>${escapeHtml(markdown).replace(/\n/g, '<br>')}</p>`; }

module.exports = { PLUGINS, MERMAID_LANGS, createMarkdownEngine, getMarkdownEngine, renderMarkdown, escapeHtml, slugify, normalizeEscapedUrlSlashes, normalizeMultilineMarkdownImageDataUris, normalizeMarkdownImageDataUris, normalizeMarkdownSource, normalizeBlockquoteFencedCodeContent, decodeHtmlEntities, highlightedTextMatchesSource };
