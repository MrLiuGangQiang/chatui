(function initChatUIMarkdownBrowserEngine(global) {
  'use strict';

  const enginePrimitives = global?.[Symbol.for('chatui.module-registry.v1')]?.get('markdownEnginePrimitives')
    || (typeof require === 'function' ? require('./engine-primitives') : {});
  const {
    MERMAID_LANGS,
    applyTaskListFallback,
    normalizeTableAlignToken,
    normalizeBlockquoteFencedCodeContent,
    decodeHtmlEntities,
    highlightedTextMatchesSource,
  } = enginePrimitives;
  const sourceNormalizer = global.ChatUIMarkdownSourceNormalizer || {};
  const linkPolicy = global.ChatUIMarkdownLinkPolicy || {};
  const normalizeMarkdownSource = sourceNormalizer.normalizeMarkdownSource || (markdown => String(markdown || ''));
  const isSafeMarkdownLink = linkPolicy.isSafeMarkdownLink || (() => true);

  function escapeHtml(value = '') { return String(value).replace(/[&<>"'`]/g, ch => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;', '`': '&#96;' }[ch])); }

  const sanitizer = global.ChatUIMarkdownSanitizer || {};
  const sanitizeHtml = sanitizer.sanitizeHtml || (() => { throw new Error('DOMPurify sanitizer unavailable'); });

  function pluginExport(mod) { return mod && (mod.default || mod.full || mod); }
  function pluginGlobal(name) { return global[name] || (name === 'markdownItTaskLists' ? global.markdownitTaskLists : name === 'markdownitMultimdTable' ? (global.markdownitMultimdTable || global.markdownItMultimdTable || global.markdownItMultiMdTable) : name === 'markdownItTexmath' ? (global.markdownItTexmath || global.texmath) : null); }
  function applyMathPlugin(md) { const plugin = pluginExport(pluginGlobal('markdownItTexmath') || pluginGlobal('texmath')); if (!plugin) return false; try { md.use(plugin, { engine: global.katex, delimiters: ['dollars', 'brackets', 'beg_end'], katexOptions: { throwOnError: false, strict: false, trust: false, output: 'htmlAndMathml' } }); return true; } catch (err) { console.warn('[markdown] math plugin failed: markdown-it-texmath', err); return false; } }
  function hasCriticalMarkdownPlugins() { return !!(global.markdownit || global.markdownIt || global.MarkdownIt) && !!global.katex?.renderToString && !!pluginGlobal('markdownItTexmath') && !!pluginGlobal('markdownitMultimdTable'); }

  function createMarkdownEngine() {
    const MarkdownIt = global.markdownit || global.markdownIt || global.MarkdownIt;
    if (!MarkdownIt) return null;
    const md = MarkdownIt({ html: true, breaks: true, linkify: true, typographer: false, highlight(code, lang) { const language = String(lang || '').trim().split(/\s+/)[0]; const raw = String(code || ''); const rawHtml = escapeHtml(raw); try { if (global.hljs && language && global.hljs.getLanguage?.(language)) { const highlighted = global.hljs.highlight(raw, { language, ignoreIllegals: true }).value; const body = highlightedTextMatchesSource(highlighted, raw) ? highlighted : rawHtml; return `<pre><code class="hljs language-${escapeHtml(language)}">${body}</code></pre>`; } if (global.hljs && global.hljs.highlightAuto && raw.length <= 6000) { const highlighted = global.hljs.highlightAuto(raw).value; const body = highlightedTextMatchesSource(highlighted, raw) ? highlighted : rawHtml; return `<pre><code class="hljs">${body}</code></pre>`; } } catch (err) { console.warn('[markdown] highlight failed:', err); } return `<pre><code${language ? ` class="language-${escapeHtml(language)}"` : ''}>${rawHtml}</code></pre>`; } }).enable(['table', 'strikethrough']);
    md.validateLink = isSafeMarkdownLink;
    applyMathPlugin(md);
    const tablePlugin = pluginExport(pluginGlobal('markdownitMultimdTable'));
    if (tablePlugin) { try { md.use(tablePlugin, { multiline: true, rowspan: true, headerless: false, multibody: true, autolabel: true }); } catch (err) { console.warn('[markdown] plugin failed: markdownitMultimdTable', err); } } else console.warn('[markdown] plugin unavailable: markdownitMultimdTable');
    [['markdownItTaskLists', { enabled: true, label: true, labelAfter: true }], ['markdownitEmoji'], ['markdownitFootnote'], ['markdownitDeflist'], ['markdownitAbbr'], ['markdownitMark'], ['markdownitSub'], ['markdownitSup']].forEach(([name, options]) => { const plugin = pluginExport(pluginGlobal(name)); if (plugin) { try { md.use(plugin, options); } catch (err) { console.warn(`[markdown] plugin failed: ${name}`, err); } } else console.warn(`[markdown] plugin unavailable: ${name}`); });
    const defaultFence = md.renderer.rules.fence;
    md.renderer.rules.fence = (tokens, idx, opts, env, slf) => { const token = tokens[idx]; const lang = (token.info || '').trim().split(/\s+/)[0].toLowerCase(); token.content = normalizeBlockquoteFencedCodeContent(token.content); if (MERMAID_LANGS.has(lang)) { const lines = Math.max(6, String(token.content || '').split('\n').length); const reserved = Math.max(180, Math.min(560, 120 + lines * 18)); return `<div class="mermaid-block markdown-mermaid-pending" data-mermaid-rendered="0" data-mermaid-reserved-height="${reserved}" style="--mermaid-reserved-height:${reserved}px"><pre><code class="language-mermaid">${escapeHtml(token.content)}</code></pre></div>`; } return defaultFence(tokens, idx, opts, env, slf); };
    const defaultLinkOpen = md.renderer.rules.link_open || ((tokens, idx, opts, env, slf) => slf.renderToken(tokens, idx, opts));
    md.renderer.rules.link_open = (tokens, idx, opts, env, slf) => { const href = tokens[idx].attrGet('href') || ''; if (/^https?:/i.test(href)) { tokens[idx].attrSet('target', '_blank'); tokens[idx].attrSet('rel', 'noopener noreferrer'); } return defaultLinkOpen(tokens, idx, opts, env, slf); };
    ['th_open', 'td_open'].forEach((rule) => { const defaultRule = md.renderer.rules[rule] || ((tokens, idx, opts, env, slf) => slf.renderToken(tokens, idx, opts)); md.renderer.rules[rule] = (tokens, idx, opts, env, slf) => { normalizeTableAlignToken(tokens[idx]); return defaultRule(tokens, idx, opts, env, slf); }; });
    return { md, render(markdown = '') { const source = normalizeMarkdownSource(markdown); let html = ''; try { html = md.render(source); } catch (err) { console.warn('[markdown] render failed:', err); html = `<p>${escapeHtml(source).replace(/\n/g, '<br>')}</p>`; } return applyTaskListFallback(sanitizeHtml(applyTaskListFallback(html))); } };
  }

  let engine = null;
  let engineReady = false;
  function resetMarkdownEngine() { engine = null; engineReady = false; }
  function getMarkdownEngine() { const ready = hasCriticalMarkdownPlugins(); if (!engine || ready && !engineReady) { engine = createMarkdownEngine(); engineReady = ready; } return engine; }
  function renderMarkdown(markdown = '') { const current = getMarkdownEngine(); return current ? current.render(markdown) : `<p>${escapeHtml(markdown).replace(/\n/g, '<br>')}</p>`; }

  const api = Object.freeze({
    MERMAID_LANGS,
    escapeHtml,
    sanitizeHtml,
    normalizeBlockquoteFencedCodeContent,
    decodeHtmlEntities,
    highlightedTextMatchesSource,
    hasCriticalMarkdownPlugins,
    createMarkdownEngine,
    resetMarkdownEngine,
    getMarkdownEngine,
    renderMarkdown,
  });

  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  if (global) global.ChatUIMarkdownBrowserEngine = api;
})(typeof window !== 'undefined' ? window : globalThis);
