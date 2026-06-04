'use strict';

const { sanitizeHtml } = require('./sanitizer');
const { escapeHtml, applyMathPlugin } = require('./math-renderer');

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

const MERMAID_LANGS = new Set(['mermaid', 'flowchart', 'graph', 'sequencediagram', 'classdiagram', 'statediagram', 'erdiagram', 'gantt', 'pie', 'journey', 'gitgraph', 'mindmap', 'timeline', 'quadrantchart', 'xychart-beta', 'xychart', 'sankey-beta', 'sankey', 'radar-beta', 'architecture-beta']);

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
function decodeHtmlEntities(html = '') {
  return String(html || '').replace(/&(?:#x([0-9a-f]+)|#(\d+)|amp|lt|gt|quot|#39|apos|#96);/gi, (all, hex, dec) => {
    if (hex) return String.fromCodePoint(parseInt(hex, 16));
    if (dec) return String.fromCodePoint(parseInt(dec, 10));
    return ({ '&amp;': '&', '&lt;': '<', '&gt;': '>', '&quot;': '"', '&#39;': "'", '&apos;': "'", '&#96;': '`' }[all.toLowerCase()] || all);
  });
}
function highlightedTextMatchesSource(highlighted = '', source = '') {
  return decodeHtmlEntities(String(highlighted || '').replace(/<[^>]*>/g, '')) === String(source || '');
}
function applyPlugin(md, descriptor) {
  const plugin = pluginExport(loadOptional(descriptor.packageName, descriptor.globalName));
  if (!plugin) { console.warn(`[markdown] plugin unavailable: ${descriptor.packageName}`); return false; }
  try { md.use(plugin, descriptor.options); return true; } catch (err) { console.warn(`[markdown] plugin failed: ${descriptor.packageName}`, err); return false; }
}

function normalizeEscapedUrlSlashes(markdown = '') {
  return String(markdown || '').replace(/\b((?:https?:|mailto:|tel:)\\\/\\\/[^\s<>()\[\]{}"']+)/gi, (all) => all.replace(/\\\//g, '/'));
}


function encodeUtf8Base64(value = '') {
  if (typeof Buffer !== 'undefined') return Buffer.from(String(value), 'utf8').toString('base64');
  if (typeof btoa === 'function') return btoa(unescape(encodeURIComponent(String(value))));
  return '';
}

function normalizeMultilineMarkdownImageDataUris(markdown = '') {
  return String(markdown || '').replace(/!\[([^\]\n]*)\]\s*\n+\s*\(\s*(data:image\/(?:png|gif|jpe?g|webp|svg\+xml);base64,[A-Za-z0-9+/=\s]+)\s*\)/gi, (_all, alt, uri) => {
    const compact = String(uri || '').replace(/\s+/g, '');
    return `![${alt}](${compact})`;
  });
}

function normalizeMarkdownImageDataUris(markdown = '') {
  const src = String(markdown || '');
  const pattern = /(!\[[^\]\n]*\]\()data:image\/svg\+xml;(?:charset=)?utf-?8,([\s\S]*?<\/svg>)\)/gi;
  return src.replace(pattern, (all, prefix, svg) => {
    const encoded = encodeUtf8Base64(String(svg || '').trim());
    return encoded ? `${prefix}data:image/svg+xml;base64,${encoded})` : all;
  });
}
function normalizeMarkdownSource(markdown = '') {
  return normalizeMarkdownImageDataUris(normalizeMultilineMarkdownImageDataUris(normalizeEscapedUrlSlashes(markdown)));
}

function isSafeMarkdownLink(url = '') {
  const href = String(url || '').trim();
  if (/^data:image\/(?:png|gif|jpe?g|webp|svg\+xml);base64,[a-z0-9+/=]+$/i.test(href)) return true;
  if (/^(?:javascript|vbscript|file|data:text\/html)\s*:/i.test(href)) return false;
  return true;
}

function applyTaskListFallback(html = '') {
  return String(html || '').replace(/<li>(\[[ xX]\]\s*)([\s\S]*?)<\/li>/g, (_all, marker, body) => {
    const checked = /x/i.test(marker);
    return `<li class="task-list-item"><input class="task-list-item-checkbox" type="checkbox" disabled${checked ? ' checked' : ''}> ${body}</li>`;
  }).replace(/<ul>\s*<li class="task-list-item">/g, '<ul class="contains-task-list">\n<li class="task-list-item">');
}

function normalizeTableAlignToken(token) {
  const style = token.attrGet('style') || '';
  const match = style.match(/(?:^|;)\s*text-align\s*:\s*(left|center|right)\s*(?:;|$)/i);
  if (!match) return;
  const nextStyle = style.replace(/(?:^|;)\s*text-align\s*:\s*(?:left|center|right)\s*;?/ig, '').trim();
  if (nextStyle) token.attrSet('style', nextStyle);
  else {
    const styleIndex = token.attrIndex('style');
    if (styleIndex >= 0) token.attrs.splice(styleIndex, 1);
  }
  const cls = `md-align-${match[1].toLowerCase()}`;
  const current = token.attrGet('class') || '';
  if (!current.split(/\s+/).includes(cls)) token.attrSet('class', [current, cls].filter(Boolean).join(' '));
}


function normalizeBlockquoteFencedCodeContent(code = '') {
  const src = String(code || '').replace(/\r\n?/g, '\n');
  const lines = src.split('\n');
  const contentLines = lines.filter(line => line.length > 0);
  if (!contentLines.length) return code;
  const quotePrefixed = contentLines.filter(line => /^\s{0,3}> ?/.test(line));
  if (quotePrefixed.length !== contentLines.length) return code;
  const nonReplQuotePrefixed = quotePrefixed.filter(line => !/^\s{0,3}>>>/.test(line));
  if (!nonReplQuotePrefixed.length) return code;
  return lines.map(line => line.replace(/^(\s{0,3})> ?/, '$1')).join('\n');
}

function createMarkdownEngine(options = {}) {
  const MarkdownIt = options.MarkdownIt || loadOptional('markdown-it', 'markdownit');
  if (!MarkdownIt) return null;
  const hljs = options.hljs || loadOptional('highlight.js', 'hljs');
  const katex = options.katex || loadOptional('katex', 'katex');
  const md = MarkdownIt({
    html: options.allowHtml !== false,
    xhtmlOut: false,
    breaks: false,
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
