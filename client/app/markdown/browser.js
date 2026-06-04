(function initChatUIMarkdownBrowser(global) {
  'use strict';

  const COPY_ICON_SVG = '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M9 7.5A2.5 2.5 0 0 1 11.5 5h5A2.5 2.5 0 0 1 19 7.5v7A2.5 2.5 0 0 1 16.5 17h-5A2.5 2.5 0 0 1 9 14.5z"></path><path d="M7 19h5.5A2.5 2.5 0 0 0 15 16.5V16"></path><path d="M7 19A2.5 2.5 0 0 1 4.5 16.5v-7A2.5 2.5 0 0 1 7 7h5.5"></path></svg>';
  const COPY_SUCCESS_ICON_SVG = '<svg class="copy-success-icon" viewBox="0 0 24 24" aria-hidden="true" focusable="false"><path d="M20 6 9 17l-5-5"></path></svg>';
const MERMAID_RENDER_ICON_SVG = '<svg viewBox="0 0 24 24" aria-hidden="true" fill="none" stroke="currentColor" stroke-linecap="round" stroke-linejoin="round"><path d="M7 7h7a3 3 0 0 1 3 3v1"></path><path d="m14 4 3 3-3 3"></path><path d="M17 17h-7a3 3 0 0 1-3-3v-1"></path><path d="m10 20-3-3 3-3"></path></svg>';
const MERMAID_SOURCE_ICON_SVG = '<svg viewBox="0 0 24 24" aria-hidden="true" fill="none" stroke="currentColor" stroke-linecap="round" stroke-linejoin="round"><path d="M7 7h7a3 3 0 0 1 3 3v1"></path><path d="m14 4 3 3-3 3"></path><path d="M17 17h-7a3 3 0 0 1-3-3v-1"></path><path d="m10 20-3-3 3-3"></path></svg>';
const MERMAID_LOADING_ICON_SVG = '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M12 5v3"></path><path d="M12 16v3"></path><path d="M5 12h3"></path><path d="M16 12h3"></path><path d="m7.05 7.05 2.12 2.12"></path><path d="m14.83 14.83 2.12 2.12"></path></svg>';
const MERMAID_ERROR_ICON_SVG = '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M12 8v5"></path><path d="M12 16.5h.01"></path><path d="M10.3 4.9 3.8 16.2A2 2 0 0 0 5.5 19h13a2 2 0 0 0 1.7-2.8L13.7 4.9a2 2 0 0 0-3.4 0z"></path></svg>';
  const MERMAID_LANGS = new Set(['mermaid', 'flowchart', 'graph', 'sequencediagram', 'classdiagram', 'statediagram', 'erdiagram', 'gantt', 'pie', 'journey', 'gitgraph', 'mindmap', 'timeline', 'quadrantchart', 'xychart-beta', 'xychart', 'sankey-beta', 'sankey', 'radar-beta', 'architecture-beta']);

  function escapeHtml(value = '') { return String(value).replace(/[&<>"'`]/g, ch => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;', '`': '&#96;' }[ch])); }
  const SAFE_STYLE_PROPERTIES = new Set(['border', 'border-color', 'border-style', 'border-width', 'border-radius', 'border-top', 'border-top-color', 'border-top-style', 'border-top-width', 'border-right', 'border-right-color', 'border-right-style', 'border-right-width', 'border-bottom', 'border-bottom-color', 'border-bottom-style', 'border-bottom-width', 'border-left', 'border-left-color', 'border-left-style', 'border-left-width', 'padding', 'padding-top', 'padding-right', 'padding-bottom', 'padding-left', 'margin', 'margin-top', 'margin-right', 'margin-bottom', 'margin-left', 'color', 'background-color', 'text-align', 'font-weight', 'font-style', 'font-size', 'line-height', 'height', 'top', 'vertical-align']);
  const UNSAFE_STYLE_VALUE = /url\s*\(|expression\s*\(|javascript\s*:|vbscript\s*:|data\s*:\s*text\/html|@import|-moz-binding/iu;
  function sanitizeStyleValue(style = '') { const safe = []; String(style || '').split(';').forEach(decl => { const colon = decl.indexOf(':'); if (colon === -1) return; const property = decl.slice(0, colon).trim().toLowerCase(); const value = decl.slice(colon + 1).trim(); if (!property || !value || property.startsWith('--')) return; if (!SAFE_STYLE_PROPERTIES.has(property)) return; if (UNSAFE_STYLE_VALUE.test(value)) return; safe.push(`${property}: ${value}`); }); return safe.join('; '); }
  function sanitizeHtml(html = '') {
    const options = {
      ADD_TAGS: ['math', 'mi', 'mn', 'mo', 'msup', 'msub', 'mrow', 'semantics', 'annotation', 'div', 'span', 'br', 'details', 'summary', 'kbd', 'sub', 'sup', 'mark', 'small', 'ins', 'del', 'table', 'thead', 'tbody', 'tfoot', 'tr', 'th', 'td', 'caption', 'colgroup', 'col'],
      ADD_ATTR: ['target', 'rel', 'class', 'id', 'data-copy-text', 'data-mermaid-rendered', 'data-markdown-streaming-tail', 'aria-hidden', 'aria-label', 'title', 'type', 'checked', 'disabled', 'for', 'href', 'src', 'alt', 'role', 'fill', 'viewBox', 'style'],
      ALLOW_DATA_ATTR: true,
      FORBID_TAGS: ['script', 'style', 'iframe', 'object', 'embed', 'base', 'meta', 'link', 'form', 'button', 'textarea', 'select', 'option'],
      FORBID_ATTR: [/^on/i],
      ALLOWED_URI_REGEXP: /^(?:(?:(?:https?|mailto|tel):)|[^a-z]|[a-z+.-]+(?:[^a-z+.-:]|$)|data:image\/(?:png|gif|jpeg|jpg|webp|svg\+xml);base64,)/i,
    };
    const strip = value => String(value || '').replace(/<\/?(?:script|style|iframe|object|embed|base|meta|link|form|button|textarea|select|option)\b[\s\S]*?>/gi, '').replace(/\sstyle=("[^"]*"|'[^']*'|[^\s>]+)/gi, (_all, raw) => { const quote = raw[0] === '"' || raw[0] === "'" ? raw[0] : ''; const value = quote ? raw.slice(1, -1) : raw; const safe = sanitizeStyleValue(value); return safe ? ` style="${safe.replace(/"/g, '&quot;')}"` : ''; }).replace(/\s(?:on\w+)=("[^"]*"|'[^']*'|[^\s>]+)/gi, '').replace(/\s(?:href|src)\s*=\s*("|')?\s*(?:javascript:|data:text\/html|vbscript:)[^"'\s>]*/gi, '').replace(/(?:javascript:|data:text\/html|vbscript:)/gi, '');
    if (global.DOMPurify?.sanitize) { if (!global.DOMPurify.__chatuiStyleHook) { global.DOMPurify.addHook?.('uponSanitizeAttribute', (_node, data) => { if (data.attrName === 'style') { const safe = sanitizeStyleValue(data.attrValue); if (safe) data.attrValue = safe; else data.keepAttr = false; } }); global.DOMPurify.__chatuiStyleHook = true; } return strip(global.DOMPurify.sanitize(String(html || ''), options)); }
    return strip(html);
  }
  function pluginExport(mod) { return mod && (mod.default || mod.full || mod); }
  function pluginGlobal(name) { return global[name] || (name === 'markdownItTaskLists' ? global.markdownitTaskLists : name === 'markdownitMultimdTable' ? (global.markdownitMultimdTable || global.markdownItMultimdTable || global.markdownItMultiMdTable) : name === 'markdownItTexmath' ? (global.markdownItTexmath || global.texmath) : null); }
  function normalizedHtml(value = '') { return String(value || '').replace(/\sdata-markdown-streaming-tail="1"/g, '').replace(/\s+/g, ' ').trim(); }
  function finalMarkupMatchesCurrent(container, finalHtml = '') { const tpl = document.createElement('template'); tpl.innerHTML = String(finalHtml || ''); const current = container.cloneNode(true); current.querySelector?.('[data-markdown-streaming-tail="1"], .streaming-tail')?.remove(); return normalizedHtml(current.innerHTML) === normalizedHtml(tpl.innerHTML); }
  function projectedIncrementalFinalMatches(container, finalHtml = '', finalDelta = '', renderMarkdown = null) { if (typeof renderMarkdown !== 'function') return false; const tpl = document.createElement('template'); tpl.innerHTML = String(finalHtml || ''); const current = container.cloneNode(true); current.querySelector?.('[data-markdown-streaming-tail="1"], .streaming-tail')?.remove(); const delta = document.createElement('template'); delta.innerHTML = renderMarkdown(finalDelta); current.append(...delta.content.childNodes); return normalizedHtml(current.innerHTML) === normalizedHtml(tpl.innerHTML); }
  function applyMathPlugin(md) { const plugin = pluginExport(pluginGlobal('markdownItTexmath') || pluginGlobal('texmath')); if (!plugin) return false; try { md.use(plugin, { engine: global.katex, delimiters: ['dollars', 'brackets', 'beg_end'], katexOptions: { throwOnError: false, strict: false, trust: false, output: 'htmlAndMathml' } }); return true; } catch (err) { console.warn('[markdown] math plugin failed: markdown-it-texmath', err); return false; } }
  function normalizeEscapedUrlSlashes(markdown = '') { return String(markdown || '').replace(/\b((?:https?:|mailto:|tel:)\\\/\\\/[^\s<>()\[\]{}\"']+)/gi, all => all.replace(/\\\//g, '/')); }
  
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

function applyTaskListFallback(html = '') { return String(html || '').replace(/<li>(\[[ xX]\]\s*)([\s\S]*?)<\/li>/g, (_all, marker, body) => `<li class="task-list-item"><input class="task-list-item-checkbox" type="checkbox" disabled${/x/i.test(marker) ? ' checked' : ''}> ${body}</li>`).replace(/<ul>\s*<li class="task-list-item">/g, '<ul class="contains-task-list">\n<li class="task-list-item">'); }

  function normalizeTableAlignToken(token) { const style = token.attrGet('style') || ''; const match = style.match(/(?:^|;)\s*text-align\s*:\s*(left|center|right)\s*(?:;|$)/i); if (!match) return; const nextStyle = style.replace(/(?:^|;)\s*text-align\s*:\s*(?:left|center|right)\s*;?/ig, '').trim(); if (nextStyle) token.attrSet('style', nextStyle); else { const styleIndex = token.attrIndex('style'); if (styleIndex >= 0) token.attrs.splice(styleIndex, 1); } const cls = `md-align-${match[1].toLowerCase()}`; const current = token.attrGet('class') || ''; if (!current.split(/\s+/).includes(cls)) token.attrSet('class', [current, cls].filter(Boolean).join(' ')); }

  function normalizeBlockquoteFencedCodeContent(code = '') { const src = String(code || '').replace(/\r\n?/g, '\n'); const lines = src.split('\n'); const contentLines = lines.filter(line => line.length > 0); if (!contentLines.length) return code; const quotePrefixed = contentLines.filter(line => /^\s{0,3}> ?/.test(line)); if (quotePrefixed.length !== contentLines.length) return code; const nonReplQuotePrefixed = quotePrefixed.filter(line => !/^\s{0,3}>>>/.test(line)); if (!nonReplQuotePrefixed.length) return code; return lines.map(line => line.replace(/^(\s{0,3})> ?/, '$1')).join('\n'); }
  function decodeHtmlEntities(html = '') { return String(html || '').replace(/&(?:#x([0-9a-f]+)|#(\d+)|amp|lt|gt|quot|#39|apos|#96);/gi, (all, hex, dec) => { if (hex) return String.fromCodePoint(parseInt(hex, 16)); if (dec) return String.fromCodePoint(parseInt(dec, 10)); return ({ '&amp;': '&', '&lt;': '<', '&gt;': '>', '&quot;': '"', '&#39;': "'", '&apos;': "'", '&#96;': '`' }[all.toLowerCase()] || all); }); }
  function highlightedTextMatchesSource(highlighted = '', source = '') { return decodeHtmlEntities(String(highlighted || '').replace(/<[^>]*>/g, '')) === String(source || ''); }

  function hasCriticalMarkdownPlugins() { return !!pluginGlobal('markdownItTexmath') && !!pluginGlobal('markdownitMultimdTable'); }
  function createMarkdownEngine() {
    const MarkdownIt = global.markdownit || global.markdownIt || global.MarkdownIt;
    if (!MarkdownIt) return null;
    const md = MarkdownIt({ html: true, breaks: false, linkify: true, typographer: false, highlight(code, lang) { const language = String(lang || '').trim().split(/\s+/)[0]; const raw = String(code || ''); const rawHtml = escapeHtml(raw); try { if (global.hljs && language && global.hljs.getLanguage?.(language)) { const highlighted = global.hljs.highlight(raw, { language, ignoreIllegals: true }).value; const body = highlightedTextMatchesSource(highlighted, raw) ? highlighted : rawHtml; return `<pre><code class="hljs language-${escapeHtml(language)}">${body}</code></pre>`; } if (global.hljs) { const highlighted = global.hljs.highlightAuto(raw).value; const body = highlightedTextMatchesSource(highlighted, raw) ? highlighted : rawHtml; return `<pre><code class="hljs">${body}</code></pre>`; } } catch (err) { console.warn('[markdown] highlight failed:', err); } return `<pre><code${language ? ` class="language-${escapeHtml(language)}"` : ''}>${rawHtml}</code></pre>`; } }).enable(['table', 'strikethrough']); md.validateLink = isSafeMarkdownLink;
    applyMathPlugin(md);
    const tablePlugin = pluginExport(pluginGlobal('markdownitMultimdTable')); if (tablePlugin) { try { md.use(tablePlugin, { multiline: true, rowspan: true, headerless: false, multibody: true, autolabel: true }); } catch (err) { console.warn('[markdown] plugin failed: markdownitMultimdTable', err); } } else console.warn('[markdown] plugin unavailable: markdownitMultimdTable');
    [['markdownItTaskLists', { enabled: true, label: true, labelAfter: true }], ['markdownitEmoji'], ['markdownitFootnote'], ['markdownitDeflist'], ['markdownitAbbr'], ['markdownitMark'], ['markdownitSub'], ['markdownitSup']].forEach(([name, options]) => { const plugin = pluginExport(pluginGlobal(name)); if (plugin) { try { md.use(plugin, options); } catch (err) { console.warn(`[markdown] plugin failed: ${name}`, err); } } else console.warn(`[markdown] plugin unavailable: ${name}`); });
    const defaultFence = md.renderer.rules.fence;
    md.renderer.rules.fence = (tokens, idx, opts, env, slf) => { const token = tokens[idx]; const lang = (token.info || '').trim().split(/\s+/)[0].toLowerCase(); token.content = normalizeBlockquoteFencedCodeContent(token.content); if (MERMAID_LANGS.has(lang)) return `<div class="mermaid-block markdown-mermaid-pending" data-mermaid-rendered="0"><pre><code class="language-mermaid">${escapeHtml(token.content)}</code></pre></div>`; return defaultFence(tokens, idx, opts, env, slf); };
    const defaultLinkOpen = md.renderer.rules.link_open || ((tokens, idx, opts, env, slf) => slf.renderToken(tokens, idx, opts));
    md.renderer.rules.link_open = (tokens, idx, opts, env, slf) => { const href = tokens[idx].attrGet('href') || ''; if (/^https?:/i.test(href)) { tokens[idx].attrSet('target', '_blank'); tokens[idx].attrSet('rel', 'noopener noreferrer'); } return defaultLinkOpen(tokens, idx, opts, env, slf); };
    ['th_open', 'td_open'].forEach(rule => { const defaultRule = md.renderer.rules[rule] || ((tokens, idx, opts, env, slf) => slf.renderToken(tokens, idx, opts)); md.renderer.rules[rule] = (tokens, idx, opts, env, slf) => { normalizeTableAlignToken(tokens[idx]); return defaultRule(tokens, idx, opts, env, slf); }; });
    return { md, render(markdown = '') { const source = normalizeMarkdownSource(markdown); let html = ''; try { html = md.render(source); } catch (err) { console.warn('[markdown] render failed:', err); html = `<p>${escapeHtml(source).replace(/\n/g, '<br>')}</p>`; } return applyTaskListFallback(sanitizeHtml(applyTaskListFallback(html))); } };
  }
  let engine = null; let engineReady = false; function resetMarkdownEngine() { engine = null; engineReady = false; } function getMarkdownEngine() { const ready = hasCriticalMarkdownPlugins(); if (!engine || ready && !engineReady) { engine = createMarkdownEngine(); engineReady = ready; } return engine; }
  function renderMarkdown(markdown = '') { const current = getMarkdownEngine(); return current ? current.render(markdown) : `<p>${escapeHtml(markdown).replace(/\n/g, '<br>')}</p>`; }

  function slugify(value = '') { return String(value).trim().toLowerCase().replace(/[`~!@#$%^&*()+=[\]{};:'",.<>/?\\|]/g, '').replace(/\s+/g, '-').replace(/-+/g, '-').replace(/^-|-$/g, ''); }
  let mermaidRenderSequence = 0;
  let mermaidRenderQueue = Promise.resolve();

  function nextMermaidToken() {
    mermaidRenderSequence += 1;
    return `mmd-${Date.now().toString(36)}-${mermaidRenderSequence.toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
  }

  function enqueueMermaidRender(task) {
    const run = mermaidRenderQueue.then(task, task);
    mermaidRenderQueue = run.catch(() => {});
    return run;
  }

  function addHeadingAnchors(root) {
    if (!root?.querySelectorAll) return;
    const seen = new Map();
    root.querySelectorAll('h1,h2,h3,h4,h5,h6').forEach((heading) => {
      if (heading.id) return;
      const base = slugify(heading.textContent || '');
      if (!base) return;
      const count = seen.get(base) || 0;
      seen.set(base, count + 1);
      heading.id = count ? `${base}-${count}` : base;
    });
  }

  function wrapTables(root) {
    if (!root?.querySelectorAll) return;
    root.querySelectorAll('table').forEach((table) => {
      if (table.parentElement?.classList.contains('table-wrap')) return;
      const wrap = document.createElement('div');
      wrap.className = 'table-wrap';
      table.replaceWith(wrap);
      wrap.appendChild(table);
    });
  }

  function bindCopyButton(button, text, copyText) {
    if (!button) return;
    button.dataset.copyText = text;
    if (button.dataset.copyBound === '1') return;
    button.dataset.copyBound = '1';
    button.addEventListener('click', async () => {
      const currentText = button.dataset.copyText || '';
      clearTimeout(button._copyResetTimer);
      button.title = '复制代码';
      button.setAttribute('aria-label', '复制代码');
      try {
        await (copyText ? copyText(currentText) : navigator.clipboard.writeText(currentText));
        button.classList.remove('copy-failed');
        button.classList.add('copied');
        button.innerHTML = COPY_SUCCESS_ICON_SVG;
        button.title = '已复制';
        button.setAttribute('aria-label', '已复制');
      } catch (err) {
        console.warn('[markdown] copy failed:', err);
        button.classList.remove('copied');
        button.classList.add('copy-failed');
        button.textContent = '!';
        button.title = '复制失败';
        button.setAttribute('aria-label', '复制失败');
      }
      button._copyResetTimer = setTimeout(() => {
        button.classList.remove('copied', 'copy-failed');
        button.innerHTML = COPY_ICON_SVG;
        button.title = '复制代码';
        button.setAttribute('aria-label', '复制代码');
      }, 900);
    });
  }

  function enhanceCodeCopy(root, copyText) {
    if (!root?.querySelectorAll) return;
    root.querySelectorAll('pre').forEach((pre) => {
      const code = pre.querySelector('code');
      const text = code?.textContent || pre.textContent || '';
      if (!text.trim()) return;
      let wrap = pre.closest('.code-block');
      if (!wrap) {
        wrap = document.createElement('div');
        wrap.className = 'code-block';
        pre.replaceWith(wrap);
        wrap.appendChild(pre);
      }
      const langClass = [...(code?.classList || [])].find(c => c.startsWith('language-')) || '';
      const lang = langClass.replace(/^language-/, '');
      if (lang && !/^(text|txt|plain|plaintext)$/i.test(lang) && !wrap.querySelector(':scope > .code-lang')) {
        const label = document.createElement('span');
        label.className = 'code-lang';
        label.textContent = lang;
        wrap.insertBefore(label, wrap.firstChild);
      }
      let btn = wrap.querySelector(':scope > .code-copy-icon');
      if (!btn) {
        btn = document.createElement('button');
        btn.className = 'inline-copy code-action-icon code-copy-icon';
        btn.type = 'button';
        btn.title = '复制代码';
        btn.setAttribute('aria-label', '复制代码');
        btn.innerHTML = COPY_ICON_SVG;
        wrap.insertBefore(btn, wrap.firstChild);
      }
      bindCopyButton(btn, text, copyText);
    });
  }

  function ensureMermaidSourceView(block) {
    if (!block?.parentNode) return null;
    block.classList.add('mermaid-block', 'markdown-mermaid-pending');
    if (block.dataset.mermaidRendered !== '1' && block.dataset.mermaidRendered !== 'rendering' && block.dataset.mermaidRendered !== 'error') block.dataset.mermaidRendered = '0';
    let source = block.dataset.mermaidSource || block.querySelector('code.language-mermaid')?.textContent || '';
    block.dataset.mermaidSource = source;
    let codeWrap = block.querySelector(':scope > .code-block');
    if (!codeWrap) { const pre = block.querySelector(':scope > pre') || block.querySelector('pre'); if (!pre) return null; codeWrap = document.createElement('div'); codeWrap.className = 'code-block mermaid-source-view'; pre.replaceWith(codeWrap); codeWrap.appendChild(pre); }
    codeWrap.classList.add('mermaid-source-view');
    codeWrap.hidden = block.dataset.mermaidRendered === '1';
    let code = codeWrap.querySelector('code.language-mermaid');
    if (!code) { code = codeWrap.querySelector('code') || document.createElement('code'); code.className = 'language-mermaid'; if (!code.parentNode) { const pre = codeWrap.querySelector('pre') || document.createElement('pre'); pre.appendChild(code); if (!pre.parentNode) codeWrap.appendChild(pre); } }
    if (source && code.textContent !== source) code.textContent = source;
    if (!source) { source = code.textContent || ''; block.dataset.mermaidSource = source; }
    return { codeWrap, source };
  }

  function setMermaidToggleState(button, state) { if (!button) return; button.dataset.mermaidState = state; button.classList.toggle('is-loading', state === 'rendering'); button.classList.toggle('is-error', state === 'error'); button.disabled = state === 'rendering'; const labels = { source: '渲染 Mermaid 图表', rendering: '正在渲染 Mermaid 图表', rendered: '查看 Mermaid 源码', error: 'Mermaid 渲染失败，返回源码' }; const icons = { source: MERMAID_RENDER_ICON_SVG, rendering: MERMAID_LOADING_ICON_SVG, rendered: MERMAID_SOURCE_ICON_SVG, error: MERMAID_ERROR_ICON_SVG }; button.innerHTML = icons[state] || icons.source; button.title = labels[state] || labels.source; button.setAttribute('aria-label', button.title); }

  async function renderMermaidBlockOnDemand(block, loader = loadMermaid) { if (!block?.parentNode || block.dataset.mermaidRendered === 'rendering') return { ok: false, node: block, stale: true }; const { codeWrap, source } = ensureMermaidSourceView(block) || {}; const error = block.querySelector(':scope > .markdown-error'); if (error) error.remove(); block.querySelector(':scope > .mermaid')?.remove(); const token = nextMermaidToken(); block.dataset.mermaidRendered = 'rendering'; block.dataset.mermaidToken = token; block.dataset.mermaidSource = source || ''; if (codeWrap) codeWrap.hidden = true; let mermaid = null; try { mermaid = await loader(); } catch (err) { console.warn('[markdown] mermaid load failed:', err); } if (!mermaid) return restoreMermaidFallback(block, null, token, new Error('Mermaid unavailable')); try { mermaid.initialize?.({ startOnLoad: false, securityLevel: 'strict', theme: 'default', deterministicIds: false, deterministicIDSeed: undefined }); } catch {} return renderSingleMermaidBlock(block, mermaid); }

  function ensureRenderedMermaidToggle(block) {
    if (!block?.parentNode) return null;
    let btn = block.querySelector(':scope > .mermaid-render-toggle');
    if (!btn) {
      btn = document.createElement('button');
      btn.type = 'button';
      btn.className = 'inline-copy code-action-icon mermaid-toggle-btn mermaid-render-toggle';
      block.insertBefore(btn, block.firstChild);
    }
    if (btn.dataset.mermaidToggleBound !== '1') {
      btn.dataset.mermaidToggleBound = '1';
      btn.addEventListener('click', () => showMermaidSource(block));
    }
    setMermaidToggleState(btn, 'rendered');
    return btn;
  }

  function showMermaidSource(block) { if (!block?.parentNode) return; const source = block.dataset.mermaidSource || block.querySelector('code.language-mermaid')?.textContent || ''; block.querySelector(':scope > .mermaid')?.remove(); block.querySelector(':scope > .mermaid-render-toggle')?.remove(); const error = block.querySelector(':scope > .markdown-error'); if (error) error.hidden = true; block.dataset.mermaidRendered = '0'; block.dataset.mermaidToken = ''; block.dataset.mermaidSource = source; block.classList.add('markdown-mermaid-pending'); block.classList.remove('mermaid-rendered-block', 'mermaid-fallback'); const ensured = ensureMermaidSourceView(block); if (ensured?.codeWrap) ensured.codeWrap.hidden = false; const toggle = block.querySelector(':scope > .code-block > .mermaid-toggle-btn'); setMermaidToggleState(toggle, 'source'); }

  function initMermaidToggleUI(root, options = {}) { const blocks = collectMermaidBlocks(root); blocks.forEach((block) => { const ensured = ensureMermaidSourceView(block); if (!ensured) return; enhanceCodeCopy(ensured.codeWrap, options.copyText); let btn = ensured.codeWrap.querySelector(':scope > .mermaid-toggle-btn'); if (!btn) { btn = document.createElement('button'); btn.type = 'button'; btn.className = 'inline-copy code-action-icon mermaid-toggle-btn'; const copyBtn = ensured.codeWrap.querySelector(':scope > .code-copy-icon'); ensured.codeWrap.insertBefore(btn, copyBtn ? copyBtn.nextSibling : ensured.codeWrap.firstChild); } if (btn.dataset.mermaidToggleBound !== '1') { btn.dataset.mermaidToggleBound = '1'; btn.addEventListener('click', async () => { if (block.dataset.mermaidRendered === '1') { showMermaidSource(block); return; } setMermaidToggleState(btn, 'rendering'); const result = await renderMermaidBlockOnDemand(block, options.loadMermaid || loadMermaid); if (result?.ok) setMermaidToggleState(btn, 'rendered'); else { ensureMermaidSourceView(block); const visibleBtn = block.querySelector(':scope > .code-block > .mermaid-toggle-btn') || btn; setMermaidToggleState(visibleBtn, 'error'); visibleBtn.disabled = false; setTimeout(() => { if (block.dataset.mermaidRendered === 'error') setMermaidToggleState(visibleBtn, 'source'); }, 1200); } }); } setMermaidToggleState(btn, block.dataset.mermaidRendered === '1' ? 'rendered' : 'source'); }); return blocks; }

  async function loadMermaid() {
    if (global.mermaid) return global.mermaid;
    await global.ChatUIMarkdownDependencyLoader?.loadScripts?.();
    resetMarkdownEngine();
    return global.mermaid || null;
  }

  function collectMermaidBlocks(root) {
    if (!root?.querySelectorAll) return [];
    return [...root.querySelectorAll('.markdown-mermaid-pending, pre code.language-mermaid')]
      .map(node => node.matches?.('code.language-mermaid') ? (node.closest('.markdown-mermaid-pending,.mermaid-block') || node.closest('pre')) : node)
      .filter(Boolean)
      .filter((node, index, all) => all.indexOf(node) === index);
  }

  function scheduleIdle(callback, timeoutMs = 1200) {
    let done = false;
    let idleHandle = null;
    const run = (deadline) => {
      if (done) return;
      done = true;
      if (fallbackHandle) clearTimeout(fallbackHandle);
      callback(deadline || { didTimeout: true, timeRemaining: () => 0 });
    };
    const fallbackHandle = setTimeout(() => run({ didTimeout: true, timeRemaining: () => 0 }), timeoutMs + 80);
    if (typeof requestIdleCallback === 'function') idleHandle = requestIdleCallback(run, { timeout: timeoutMs });
    else setTimeout(() => run({ didTimeout: false, timeRemaining: () => 8 }), 0);
    return { idleHandle, fallbackHandle };
  }

  function markMermaidUnavailable(blocks, error) {
    blocks.forEach((block) => {
      if (!block?.parentNode) return;
      block.dataset.mermaidRendered = 'error';
      block.dataset.mermaidToken = '';
      block.classList.add('mermaid-fallback');
      if (!block.querySelector('.markdown-error')) block.insertAdjacentHTML('afterbegin', '<div class="markdown-error">Mermaid 资源加载失败，已保留源码。</div>');
    });
    return blocks.map(block => ({ ok: false, node: block, error }));
  }

  function staleMermaidBlock(holder, container, token) {
    return !holder?.parentNode || !container?.parentNode || holder.dataset?.mermaidToken !== token || container.dataset?.mermaidToken !== token;
  }



  function mermaidSafeId(value = '', fallback = 'item') {
    const ascii = String(value || '').normalize('NFKD').replace(/[\u0300-\u036f]/g, '').replace(/[^a-zA-Z0-9]+/g, '_').replace(/^_+|_+$/g, '').toLowerCase();
    if (ascii && /^[a-z]/.test(ascii)) return ascii;
    return fallback;
  }

  function mermaidQuoteLabel(value = '') {
    return String(value || '').trim().replace(/\\/g, '\\\\').replace(/"/g, '\\"');
  }

  function normalizeArchitectureMermaidSource(source = '') {
    const text = String(source || '');
    if (!/^\s*architecture-beta\b/i.test(text)) return text;
    return text.replace(/\[([^\]\n]*[^\x00-\x7F][^\]\n]*)\]/g, (all, label) => {
      const trimmed = String(label || '').trim();
      if (!trimmed || /^['"].*['"]$/.test(trimmed)) return all;
      return `["${mermaidQuoteLabel(trimmed)}"]`;
    });
  }


  function getSankeyLabelReplacements(source = '') {
    const text = String(source || '');
    if (!/^\s*sankey-beta\b/i.test(text)) return [];
    const seen = new Map();
    const replacements = [];
    const labelFor = (raw) => {
      const label = String(raw || '').trim();
      if (!label || /^[\x00-\x7F]+$/.test(label)) return label;
      if (!seen.has(label)) {
        const id = `sankey_node_${seen.size + 1}`;
        seen.set(label, id);
        replacements.push({ id, label });
      }
      return seen.get(label);
    };
    text.split(/\r?\n/).slice(1).forEach((line) => {
      const parts = line.trim().split(',');
      if (parts.length >= 3) {
        labelFor(parts[0]);
        labelFor(parts[1]);
      }
    });
    return replacements;
  }

  function restoreSankeySvgLabels(container, source = '') {
    const replacements = getSankeyLabelReplacements(source);
    if (!replacements.length || !container?.querySelectorAll) return;
    const map = new Map(replacements.map(item => [item.id, item.label]));
    container.querySelectorAll('text').forEach((node) => {
      for (const [id, label] of map) {
        if ((node.textContent || '').includes(id)) node.textContent = String(node.textContent || '').replaceAll(id, label);
      }
    });
  }
  function normalizeSankeyMermaidSource(source = '') {
    const text = String(source || '');
    if (!/^\s*sankey-beta\b/i.test(text)) return text;
    const replacements = getSankeyLabelReplacements(text);
    const map = new Map(replacements.map(item => [item.label, item.id]));
    return text.split(/\r?\n/).map((line, index) => {
      if (index === 0) return line.trim();
      const parts = line.trim().split(',');
      if (parts.length >= 3) {
        parts[0] = map.get(parts[0].trim()) || parts[0].trim();
        parts[1] = map.get(parts[1].trim()) || parts[1].trim();
        return parts.join(',');
      }
      return line.trimStart();
    }).join('\n');
  }

  function normalizeRadarMermaidSource(source = '') {
    const text = String(source || '');
    if (!/^\s*radar-beta\b/i.test(text)) return text;
    const lines = text.split(/\r?\n/);
    const out = [];
    let axisLabels = null;
    let curveCount = 0;
    for (const rawLine of lines) {
      const line = rawLine.trim();
      if (!line) { out.push(''); continue; }
      if (/^radar-beta\b/i.test(line)) { out.push('radar-beta'); continue; }
      const axisMatch = line.match(/^axis\s+(.+)$/i);
      if (axisMatch && !/[\[{]/.test(axisMatch[1])) {
        axisLabels = axisMatch[1].split(',').map(item => item.trim()).filter(Boolean);
        out.push('axis ' + axisLabels.map((label, index) => `${mermaidSafeId(label, `axis${index + 1}`)}["${mermaidQuoteLabel(label)}"]`).join(', '));
        continue;
      }
      const curveMatch = line.match(/^(?:["']([^"']+)["']|([^:]+))\s*:\s*([\d.,\s+-]+)$/);
      if (curveMatch) {
        curveCount += 1;
        const label = String(curveMatch[1] || curveMatch[2] || `curve${curveCount}`).trim();
        const values = String(curveMatch[3] || '').split(',').map(item => item.trim()).filter(Boolean).join(', ');
        out.push(`curve ${mermaidSafeId(label, `curve${curveCount}`)}["${mermaidQuoteLabel(label)}"]{${values}}`);
        continue;
      }
      out.push(line);
    }
    return out.join('\n');
  }

  function normalizeBetaMermaidSource(source = '') {
    let text = String(source || '');
    text = normalizeSankeyMermaidSource(text);
    text = normalizeRadarMermaidSource(text);
    text = normalizeArchitectureMermaidSource(text);
    return text;
  }
  function restoreMermaidFallback(holder, container, token, error) {
    if (!holder?.parentNode && container?.parentNode) container.replaceWith(holder);
    if (holder?.parentNode && holder.dataset?.mermaidToken === token) {
      const source = holder.dataset.mermaidSource || holder.querySelector?.('code.language-mermaid')?.textContent || '';
      holder.querySelector(':scope > .mermaid')?.remove();
      holder.dataset.mermaidRendered = 'error';
      holder.dataset.mermaidToken = '';
      holder.dataset.mermaidSource = source;
      holder.classList.add('markdown-mermaid-pending', 'mermaid-fallback');
      holder.classList.remove('mermaid-rendered-block');
      let errorNode = holder.querySelector(':scope > .markdown-error');
      if (!errorNode) { errorNode = document.createElement('div'); errorNode.className = 'markdown-error'; holder.insertBefore(errorNode, holder.firstChild); }
      errorNode.hidden = false;
      errorNode.textContent = 'Mermaid 图表渲染失败，已保留源码。';
      const ensured = ensureMermaidSourceView(holder);
      if (ensured?.codeWrap) ensured.codeWrap.hidden = false;
    }
    return { ok: false, node: holder, error };
  }

  async function renderSingleMermaidBlock(holder, mermaid) {
    const token = holder.dataset.mermaidToken;
    const source = holder.dataset.mermaidSource || holder.querySelector?.('code.language-mermaid')?.textContent || holder.textContent || '';
    const renderSource = normalizeBetaMermaidSource(source);
    const container = document.createElement('div');
    const renderId = `${token}-svg`;
    container.className = 'mermaid';
    // Keep the host container id distinct from Mermaid's render id. Mermaid v11
    // may create/query an SVG with the render id; reusing that id on the host
    // div makes flowcharts hit getBBox on the div instead of the generated SVG.
    container.id = `${token}-container`;
    container.dataset.mermaidRenderId = renderId;
    container.dataset.mermaidRendered = 'rendering';
    container.dataset.mermaidToken = token;
    container.dataset.mermaidSourceHash = String(renderSource.length);
    container.textContent = renderSource;
    holder.querySelector(':scope > .mermaid')?.remove();
    holder.querySelector(':scope > .mermaid-render-toggle')?.remove();
    const sourceView = holder.querySelector(':scope > .code-block');
    if (sourceView) sourceView.hidden = true;
    holder.appendChild(container);
    try {
      if (staleMermaidBlock(holder, container, token)) return { ok: false, node: holder, stale: true };
      if (typeof mermaid.render === 'function') {
        const result = await mermaid.render(renderId, renderSource, container);
        if (staleMermaidBlock(holder, container, token)) return { ok: false, node: holder, stale: true };
        container.replaceChildren();
        if (result?.svg) {
          container.innerHTML = result.svg;
          restoreSankeySvgLabels(container, source);
        } else if (result?.nodeType) container.appendChild(result);
        result?.bindFunctions?.(container);
      } else {
        await mermaid.run?.({ nodes: [container] });
        if (staleMermaidBlock(holder, container, token)) return { ok: false, node: holder, stale: true };
      }
      holder.dataset.mermaidRendered = '1';
      holder.classList.remove('markdown-mermaid-pending', 'mermaid-fallback');
      holder.classList.add('mermaid-rendered-block');
      container.dataset.mermaidRendered = '1';
      ensureRenderedMermaidToggle(holder);
      return { ok: true, node: container, holder };
    } catch (err) {
      console.warn('[markdown] mermaid block failed:', err);
      if (staleMermaidBlock(holder, container, token)) return { ok: false, node: holder, error: err, stale: true };
      return restoreMermaidFallback(holder, container, token, err);
    }
  }

  async function renderMermaidBlocks(root, loader = loadMermaid, options = {}) {
    return enqueueMermaidRender(async () => {
      const force = !!options.force;
      const blocks = collectMermaidBlocks(root).filter(node => root.contains?.(node) && node.dataset?.mermaidManual !== '1' && node.dataset?.mermaidRendered !== '1' && node.dataset?.mermaidRendered !== 'rendering' && (force || isVisible(node)));
      if (!blocks.length) return [];
      blocks.forEach((block) => {
        const code = block.querySelector?.('code.language-mermaid') || block;
        const source = code.textContent || '';
        const token = nextMermaidToken();
        if (block.dataset) {
          block.dataset.mermaidRendered = 'rendering';
          block.dataset.mermaidToken = token;
          block.dataset.mermaidSource = source;
        }
        block.classList.add('mermaid-block');
      });
      let mermaid = null;
      try { mermaid = await loader(); } catch (err) { console.warn('[markdown] mermaid load failed:', err); }
      if (!mermaid) return markMermaidUnavailable(blocks, new Error('Mermaid unavailable'));
      try { mermaid.initialize?.({ startOnLoad: false, securityLevel: 'strict', theme: 'default', deterministicIds: false, deterministicIDSeed: undefined }); } catch {}
      const results = [];
      for (const holder of blocks) {
        if (!root.contains?.(holder) || holder.dataset?.mermaidRendered !== 'rendering') {
          results.push({ ok: false, node: holder, stale: true });
          continue;
        }
        results.push(await renderSingleMermaidBlock(holder, mermaid));
      }
      return results;
    });
  }

  function cancelIdle(handle) { if (!handle) return; if (typeof handle === 'object') { if (handle.idleHandle != null && typeof global.cancelIdleCallback === 'function') global.cancelIdleCallback(handle.idleHandle); if (handle.fallbackHandle != null) clearTimeout(handle.fallbackHandle); return; } if (typeof global.cancelIdleCallback === 'function') return global.cancelIdleCallback(handle); return clearTimeout(handle); }
  function isVisible(node) { if (!node?.getBoundingClientRect) return true; const r = node.getBoundingClientRect(); const h = global.innerHeight || document.documentElement.clientHeight || 800; return r.bottom >= -900 && r.top <= h + 900; }
  function idleBatch(items, each, opts = {}) { const list = [...items]; const signal = opts.signal; const batchSize = opts.batchSize || 6; const budgetMs = opts.budgetMs || 12; return new Promise(resolve => { let i = 0; const step = deadline => { if (signal?.cancelled) return resolve({ cancelled: true, processed: i }); const started = performance?.now ? performance.now() : Date.now(); let c = 0; while (i < list.length) { each(list[i], i); i += 1; c += 1; const now = performance?.now ? performance.now() : Date.now(); const left = typeof deadline?.timeRemaining === 'function' ? deadline.timeRemaining() : Math.max(0, budgetMs - (now - started)); if (c >= batchSize || left <= 2 || now - started >= budgetMs) break; } if (i >= list.length) return resolve({ cancelled: false, processed: i }); scheduleIdle(step); }; scheduleIdle(step); }); }
  function enhanceRenderedMarkdown(root, options = {}) { if (!root?.querySelectorAll) return Promise.resolve([]); const old = root.__chatuiEnhanceJob; old?.cancel?.(); const signal = { cancelled: false }; root.__chatuiEnhanceJob = { cancel: () => { signal.cancelled = true; } }; const basic = async () => { await idleBatch(root.querySelectorAll('h1,h2,h3,h4,h5,h6'), () => {}, { signal, batchSize: 1, budgetMs: 1 }); if (signal.cancelled) return; addHeadingAnchors(root); await idleBatch(root.querySelectorAll('table'), () => {}, { signal, batchSize: 1, budgetMs: 1 }); if (signal.cancelled) return; wrapTables(root); await idleBatch(root.querySelectorAll('pre'), pre => enhanceCodeCopy(pre.parentElement || pre, options.copyText), { signal, batchSize: 4, budgetMs: 12 }); if (signal.cancelled) return; initMermaidToggleUI(root, options); }; const shouldAutoRenderMermaid = options.autoRenderMermaid === true; if (options.skipMermaid || !shouldAutoRenderMermaid) return basic().then(() => []); const run = (renderOptions = {}) => basic().then(() => signal.cancelled ? [] : renderMermaidBlocks(root, options.loadMermaid, { force: !!options.forceMermaid || !!renderOptions.force })).catch(err => { console.warn('[markdown] mermaid enhance failed:', err); return []; }); if (options.deferMermaid === false) return run({ force: !!options.forceMermaid }); return new Promise(resolve => { let settled = false; let forceTimer = null; const finish = promise => Promise.resolve(promise).then(result => { if (!settled) { settled = true; if (forceTimer) clearTimeout(forceTimer); resolve(result); } return result; }); const h = scheduleIdle(() => finish(run())); forceTimer = setTimeout(() => { if (!settled && root?.isConnected !== false && collectMermaidBlocks(root).some(node => node.dataset?.mermaidRendered !== '1' && node.dataset?.mermaidRendered !== 'error')) finish(run({ force: true })); }, Number(options.mermaidFallbackMs) || 2600); root.__chatuiEnhanceJob.cancel = () => { signal.cancelled = true; cancelIdle(h); if (forceTimer) clearTimeout(forceTimer); if (!settled) { settled = true; resolve([]); } }; }); }
  function renderMarkdownInto(container, markdown = '', options = {}) { if (!container) return Promise.resolve({ html: renderMarkdown(markdown), mermaid: [] }); const html = renderMarkdown(markdown); container.innerHTML = html; return Promise.resolve(enhanceRenderedMarkdown(container, options)).then(mermaid => ({ html, mermaid })); }

  function hasConservativeInlineMathTail(text = '') { const src = String(text || '').replace(/\r\n?/g, '\n'); const tail = src.slice(Math.max(0, src.lastIndexOf('\n') + 1)); let escaped = false; for (let i = 0; i < tail.length; i += 1) { const ch = tail[i]; if (escaped) { escaped = false; continue; } if (ch === '\\') { escaped = true; continue; } if (ch === '$' && tail[i + 1] !== '$' && tail[i - 1] !== '$') return true; } return false; }
  function splitLines(src) { const lines = []; let start = 0; for (let i = 0; i < src.length; i += 1) if (src[i] === '\n') { lines.push({ text: src.slice(start, i), start, end: i + 1, hasNl: true }); start = i + 1; } if (start < src.length) lines.push({ text: src.slice(start), start, end: src.length, hasNl: false }); return lines; }
  function findStableBoundary(text = '') { const src = String(text || '').replace(/\r\n?/g, '\n'); if (!src) return 0; const lines = splitLines(src); let stable = 0, inFence = false, fenceChar = '', fenceLen = 0, inMath = false; const fenceOf = l => l.match(/^\s{0,3}(`{3,}|~{3,})(.*)$/), blank = l => /^\s*$/.test(l), mathFence = l => /^\s*\$\$\s*$/.test(l); for (const item of lines) { const line = item.text, complete = item.hasNl, fence = fenceOf(line); if (!inMath && fence) { const marker = fence[1], ch = marker[0], info = String(fence[2] || '').trim(); if (inFence) { if (ch === fenceChar && marker.length >= fenceLen && !info) { inFence = false; fenceChar = ''; fenceLen = 0; stable = item.end; } } else { inFence = true; fenceChar = ch; fenceLen = marker.length; } continue; } if (inFence) continue; if (mathFence(line)) { inMath = !inMath; if (!inMath && complete) stable = item.end; continue; } if (inMath) continue; if (blank(line) && complete && !hasConservativeInlineMathTail(src.slice(0, item.end))) stable = item.end; } if (!inFence && !inMath && src.endsWith('\n') && !hasConservativeInlineMathTail(src)) stable = Math.max(stable, src.length); if (hasConservativeInlineMathTail(src)) stable = Math.min(stable, Math.max(0, src.lastIndexOf('\n', src.length - 2) + 1)); return Math.max(0, Math.min(stable, src.length)); }
  function splitStableTail(text = '') { const src = String(text || '').replace(/\r\n?/g, '\n'); const index = findStableBoundary(src); return { stable: src.slice(0, index), tail: src.slice(index), index }; }
  function createStreamingRenderer({ renderMarkdown: render = renderMarkdown, enhance = enhanceRenderedMarkdown, renderTailText } = {}) { let raw = '', consumed = 0, tailText = '', closed = false; const renderTail = renderTailText || (text => { const span = document.createElement('span'); span.className = 'streaming-tail'; span.dataset.markdownStreamingTail = '1'; span.textContent = text; return span; }); const findTail = c => c?.querySelector?.('[data-markdown-streaming-tail="1"], .streaming-tail') || null; const removeTail = c => findTail(c)?.remove(); const htmlToFrag = html => { const tpl = document.createElement('template'); tpl.innerHTML = String(html || ''); return tpl.content; }; const insertRendered = (target, html, before) => { const frag = htmlToFrag(html); const nodes = [...frag.childNodes]; target.insertBefore(frag, before); return nodes; }; const fragmentRootFor = nodes => ({ querySelectorAll: selector => nodes.flatMap(node => node.nodeType === 1 ? [node, ...node.querySelectorAll(selector)] : []).filter(node => node.matches?.(selector)) }); const enhanceSafe = (c, phase = {}) => { try { enhance?.(c, phase); } catch (err) { console.warn('[markdown] streaming enhance failed:', err); } }; return { append(delta, container) { if (closed) return { raw, consumed, tail: tailText, closed }; raw += String(delta || ''); const { stable, tail, index } = splitStableTail(raw); if (index < consumed) { if (container) { container.innerHTML = render(raw); removeTail(container); enhanceSafe(container, { reset: true }); } consumed = raw.length; tailText = ''; return { raw, consumed, tail: tailText, delta: raw, closed, reset: true, reason: 'stable-boundary-regressed' }; } const part = stable.slice(consumed); if (container) { let tailNode = findTail(container); if (part) { const inserted = insertRendered(container, render(part), tailNode); consumed = stable.length; enhanceSafe(fragmentRootFor(inserted), { streaming: true }); } tailText = tail; tailNode = findTail(container); if (tailText) { if (tailNode) tailNode.textContent = tailText; else container.appendChild(renderTail(tailText)); } else if (tailNode) tailNode.textContent = ''; } else { if (part) consumed = stable.length; tailText = tail; } return { raw, consumed, tail: tailText, delta: part, closed }; }, set(value, container) { const next = String(value || ''); const delta = next.startsWith(raw) ? next.slice(raw.length) : next; if (!next.startsWith(raw)) this.reset(container); return this.append(delta, container); }, final(container, finalText = raw) { const next = String(finalText ?? raw ?? ''); const previousRaw = raw; const previousConsumed = consumed; raw = next; closed = true; let mode = 'noop', reason = ''; if (container) { const tailNode = findTail(container); const canCommitTail = next === previousRaw && previousConsumed <= next.length; const finalDelta = next.slice(previousConsumed); const finalHtml = render(next); const canSkipFullRerender = canCommitTail && (finalMarkupMatchesCurrent(container, finalHtml) || projectedIncrementalFinalMatches(container, finalHtml, finalDelta, render)); if (canSkipFullRerender) { if (tailNode) tailNode.remove(); if (finalDelta) { const inserted = insertRendered(container, render(finalDelta), null); enhanceSafe(fragmentRootFor(inserted), { final: true, streaming: true }); } else { enhanceSafe(container, { final: true, unchanged: true }); } consumed = raw.length; tailText = ''; mode = 'incremental-final'; } else { removeTail(container); container.replaceChildren(...htmlToFrag(render(raw)).childNodes); consumed = raw.length; tailText = ''; enhanceSafe(container, { final: true, reset: true }); mode = 'full-rerender-final'; reason = 'final-text-diverged'; } } else { consumed = raw.length; tailText = ''; mode = 'no-container'; } return { raw, mode, reason, consumed, closed, enhanced: !!container }; }, getRaw() { return raw; }, getConsumed() { return consumed; }, getTail() { return tailText; }, reset(container) { raw = ''; consumed = 0; tailText = ''; closed = false; if (container) container.innerHTML = ''; } }; }

  const api = Object.freeze({ renderMarkdown, renderMarkdownInto, normalizeBetaMermaidSource, renderMarkdownHtml: renderMarkdown, enhanceRenderedMarkdown, enhanceCodeCopy, initMermaidToggleUI, renderMermaidBlockOnDemand, showMermaidSource, renderMermaidBlocks, loadMermaid, createMarkdownEngine, getMarkdownEngine, resetMarkdownEngine, hasCriticalMarkdownPlugins, findStableBoundary, splitStableTail, createStreamingRenderer, escapeHtml, normalizeEscapedUrlSlashes, normalizeMultilineMarkdownImageDataUris, normalizeMarkdownImageDataUris, normalizeMarkdownSource, dependencyLoader: global.ChatUIMarkdownDependencyLoader });
  global.ChatUIApp = Object.freeze({ ...(global.ChatUIApp || {}), markdown: api });
  global.ChatUIMarkdown = api;
  global.ChatUIMarkdownReady = (global.ChatUIMarkdownDependencyLoader?.loadAll?.() || Promise.resolve()).then(result => { resetMarkdownEngine(); return result; }).catch(err => { console.warn('[markdown] dependency load failed:', err); resetMarkdownEngine(); return null; });
})(typeof window !== 'undefined' ? window : globalThis);
