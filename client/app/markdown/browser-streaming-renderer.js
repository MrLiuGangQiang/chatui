(function initChatUIMarkdownBrowserStreamingRenderer(global) {
  'use strict';

  const browserEngine = global.ChatUIMarkdownBrowserEngine || {};
  const browserEnhancer = global.ChatUIMarkdownBrowserEnhancer || {};
  const escapeHtml = browserEngine.escapeHtml || (value => String(value || '').replace(/[&<>"'`]/g, ch => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;', '`': '&#96;' }[ch])));
  const renderMarkdown = browserEngine.renderMarkdown || (markdown => `<p>${escapeHtml(markdown).replace(/\n/g, '<br>')}</p>`);
  const enhanceRenderedMarkdown = browserEnhancer.enhanceRenderedMarkdown || (() => Promise.resolve([]));
  const TRANSPARENT_PIXEL = 'data:image/gif;base64,R0lGODlhAQABAIAAAAAAAP///ywAAAAAAQABAAACAUwAOw==';

  function shouldDeferStreamingResourceUrl(url = '') { const value = String(url || '').trim(); return !!value && !value.startsWith('data:') && !value.startsWith('blob:') && !value.startsWith('#') && value !== TRANSPARENT_PIXEL && value !== 'about:blank'; }
  const STREAMING_RESOURCE_ATTRS = Object.freeze([
    ['img[src]', 'src', TRANSPARENT_PIXEL],
    ['img[srcset]', 'srcset', ''],
    ['source[src]', 'src', ''],
    ['source[srcset]', 'srcset', ''],
    ['video[src]', 'src', ''],
    ['audio[src]', 'src', ''],
    ['iframe[src]', 'src', 'about:blank'],
    ['embed[src]', 'src', ''],
    ['object[data]', 'data', ''],
    ['track[src]', 'src', ''],
  ]);
  const RESOURCE_ATTRS = STREAMING_RESOURCE_ATTRS;
  const markdownResourceObjectUrlCache = new Map();
  const markdownResourceInFlight = new Map();
  function dataAttrFor(prefix, attr) { return 'data-' + prefix + '-' + attr; }
  function canCacheResourceUrl(url = '') { const value = String(url || '').trim(); return /^https?:\/\//i.test(value) || value.startsWith('/.') || value.startsWith('/') || value.startsWith('./') || value.startsWith('../'); }
  function resolveResourceUrl(url = '') { try { return new URL(String(url || ''), globalThis.location?.href || 'http://localhost/').href; } catch { return String(url || ''); } }
  function isSameOriginResourceUrl(url = '') { try { return new URL(String(url || ''), globalThis.location?.href || 'http://localhost/').origin === globalThis.location?.origin; } catch { return false; } }
  function fetchCachedResourceUrl(url = '') {
    const key = resolveResourceUrl(url);
    if (!canCacheResourceUrl(url)) return Promise.resolve(url);
    if (!isSameOriginResourceUrl(url)) { markdownResourceObjectUrlCache.set(key, url); return Promise.resolve(url); }
    if (markdownResourceObjectUrlCache.has(key)) return Promise.resolve(markdownResourceObjectUrlCache.get(key));
    if (markdownResourceInFlight.has(key)) return markdownResourceInFlight.get(key);
    const promise = globalThis.fetch(key, { cache: 'force-cache' }).then(res => {
      if (!res.ok) throw new Error('resource fetch failed: ' + res.status);
      return res.blob();
    }).then(blob => {
      const objectUrl = globalThis.URL?.createObjectURL ? globalThis.URL.createObjectURL(blob) : key;
      markdownResourceObjectUrlCache.set(key, objectUrl);
      markdownResourceInFlight.delete(key);
      return objectUrl;
    }).catch(() => {
      markdownResourceInFlight.delete(key);
      markdownResourceObjectUrlCache.set(key, url);
      return url;
    });
    markdownResourceInFlight.set(key, promise);
    return promise;
  }
  function deferResources(root, prefix = 'stream', flag = 'data-stream-resource-deferred') {
    for (const [selector, attr, placeholder] of RESOURCE_ATTRS) root?.querySelectorAll?.(selector).forEach(node => {
      const value = node.getAttribute(attr) || '';
      if (!shouldDeferStreamingResourceUrl(value)) return;
      const dataAttr = dataAttrFor(prefix, attr);
      if (!node.getAttribute(dataAttr)) node.setAttribute(dataAttr, value);
      if (!node.getAttribute('data-original-' + attr)) node.setAttribute('data-original-' + attr, value);
      if (placeholder) node.setAttribute(attr, placeholder); else node.removeAttribute(attr);
      node.setAttribute(flag, '1');
    });
    return root;
  }
  function restoreResources(root, prefix = 'stream', flag = 'data-stream-resource-deferred', options = {}) {
    const useBlobCache = options.blobCache === true;
    for (const [, attr] of RESOURCE_ATTRS) root?.querySelectorAll?.('[' + dataAttrFor(prefix, attr) + ']').forEach(node => {
      const dataAttr = dataAttrFor(prefix, attr);
      const value = node.getAttribute(dataAttr) || '';
      if (!value) return;
      const finish = restored => {
        if (!node.isConnected && options.requireConnected !== false) return;
        if (!restored) return;
        node.setAttribute(attr, restored);
        node.removeAttribute(dataAttr);
        node.removeAttribute(flag);
      };
      if (useBlobCache && (attr === 'src' || attr === 'data')) fetchCachedResourceUrl(value).then(finish);
      else finish(value);
    });
    return root;
  }
  function deferStreamingResources(root) { return deferResources(root, 'stream', 'data-stream-resource-deferred'); }
  function restoreStreamingResources(root, options = {}) { return restoreResources(root, 'stream', 'data-stream-resource-deferred', { once: false, ...options }); }
  function deferMarkdownResources(root) { return deferResources(root, 'markdown-resource', 'data-markdown-resource-deferred'); }
  function restoreMarkdownResources(root, options = {}) { return restoreResources(root, 'markdown-resource', 'data-markdown-resource-deferred', { blobCache: true, ...options }); }
  function gateMarkdownResourceHtml(html = '') {
    if (typeof document === 'undefined') return String(html || '');
    const tpl = document.createElement('template');
    tpl.innerHTML = String(html || '');
    deferMarkdownResources(tpl.content);
    return tpl.innerHTML;
  }

  function normalizedHtml(value = '') { return String(value || '').replace(/\sdata-markdown-streaming-tail="1"/g, '').replace(/\s+/g, ' ').trim(); }
  function finalMarkupMatchesCurrent(container, finalHtml = '') { const tpl = document.createElement('template'); tpl.innerHTML = String(finalHtml || ''); const current = container.cloneNode(true); current.querySelector?.('[data-markdown-streaming-tail="1"], .streaming-tail')?.remove(); return normalizedHtml(current.innerHTML) === normalizedHtml(tpl.innerHTML); }
  function projectedIncrementalFinalMatches(container, finalHtml = '', finalDelta = '', renderMarkdown = null) { if (typeof renderMarkdown !== 'function') return false; const tpl = document.createElement('template'); tpl.innerHTML = String(finalHtml || ''); const current = container.cloneNode(true); current.querySelector?.('[data-markdown-streaming-tail="1"], .streaming-tail')?.remove(); const delta = document.createElement('template'); delta.innerHTML = renderMarkdown(finalDelta); current.append(...delta.content.childNodes); return normalizedHtml(current.innerHTML) === normalizedHtml(tpl.innerHTML); }

  function hasConservativeInlineMathTail(text = '') { const src = String(text || '').replace(/\r\n?/g, '\n'); const tail = src.slice(Math.max(0, src.lastIndexOf('\n') + 1)); let escaped = false; for (let i = 0; i < tail.length; i += 1) { const ch = tail[i]; if (escaped) { escaped = false; continue; } if (ch === '\\') { escaped = true; continue; } if (ch === '$' && tail[i + 1] !== '$' && tail[i - 1] !== '$') return true; } return false; }
  function splitLines(src) { const lines = []; let start = 0; for (let i = 0; i < src.length; i += 1) if (src[i] === '\n') { lines.push({ text: src.slice(start, i), start, end: i + 1, hasNl: true }); start = i + 1; } if (start < src.length) lines.push({ text: src.slice(start), start, end: src.length, hasNl: false }); return lines; }
  function findStableBoundary(text = '') { const src = String(text || '').replace(/\r\n?/g, '\n'); if (!src) return 0; const lines = splitLines(src); let stable = 0, inFence = false, fenceChar = '', fenceLen = 0, inMath = false; const fenceOf = l => l.match(/^\s{0,3}(`{3,}|~{3,})(.*)$/), blank = l => /^\s*$/.test(l), mathFence = l => /^\s*\$\$\s*$/.test(l); for (const item of lines) { const line = item.text, complete = item.hasNl, fence = fenceOf(line); if (!inMath && fence) { const marker = fence[1], ch = marker[0], info = String(fence[2] || '').trim(); if (inFence) { if (ch === fenceChar && marker.length >= fenceLen && !info) { inFence = false; fenceChar = ''; fenceLen = 0; stable = item.end; } } else { inFence = true; fenceChar = ch; fenceLen = marker.length; } continue; } if (inFence) continue; if (mathFence(line)) { inMath = !inMath; if (!inMath && complete) stable = item.end; continue; } if (inMath) continue; if (blank(line) && complete && !hasConservativeInlineMathTail(src.slice(0, item.end))) stable = item.end; } if (!inFence && !inMath && src.endsWith('\n') && !hasConservativeInlineMathTail(src)) stable = Math.max(stable, src.length); if (hasConservativeInlineMathTail(src)) stable = Math.min(stable, Math.max(0, src.lastIndexOf('\n', src.length - 2) + 1)); return Math.max(0, Math.min(stable, src.length)); }
  function splitStableTail(text = '') { const src = String(text || '').replace(/\r\n?/g, '\n'); const index = findStableBoundary(src); return { stable: src.slice(0, index), tail: src.slice(index), index }; }
  function createStreamingRenderer({ renderMarkdown: render = renderMarkdown, enhance = enhanceRenderedMarkdown, renderTailText } = {}) { let raw = '', consumed = 0, tailText = '', closed = false; const renderTail = renderTailText || (text => { const span = document.createElement('span'); span.className = 'streaming-tail'; span.dataset.markdownStreamingTail = '1'; span.textContent = text; return span; }); const findTail = c => c?.querySelector?.('[data-markdown-streaming-tail="1"], .streaming-tail') || null; const removeTail = c => findTail(c)?.remove(); const htmlToFrag = (html, options = {}) => { const tpl = document.createElement('template'); tpl.innerHTML = String(html || ''); if (options.deferResources) deferStreamingResources(tpl.content); return tpl.content; }; const insertRendered = (target, html, before, options = {}) => { const frag = htmlToFrag(html, options); const nodes = [...frag.childNodes]; target.insertBefore(frag, before); return nodes; }; const fragmentRootFor = nodes => ({ querySelectorAll: selector => nodes.flatMap(node => node.nodeType === 1 ? [node, ...node.querySelectorAll(selector)] : []).filter(node => node.matches?.(selector)) }); const enhanceSafe = (c, phase = {}) => { try { enhance?.(c, phase); } catch (err) { console.warn('[markdown] streaming enhance failed:', err); } }; return { append(delta, container) { if (closed) return { raw, consumed, tail: tailText, closed }; raw += String(delta || ''); const { stable, tail, index } = splitStableTail(raw); if (index < consumed) { if (container) { container.replaceChildren(...htmlToFrag(render(raw), { deferResources: true }).childNodes); removeTail(container); enhanceSafe(container, { reset: true }); } consumed = raw.length; tailText = ''; return { raw, consumed, tail: tailText, delta: raw, closed, reset: true, reason: 'stable-boundary-regressed' }; } const part = stable.slice(consumed); if (container) { let tailNode = findTail(container); if (part) { const inserted = insertRendered(container, render(part), tailNode, { deferResources: true }); consumed = stable.length; enhanceSafe(fragmentRootFor(inserted), { streaming: true }); } tailText = tail; tailNode = findTail(container); if (tailText) { if (tailNode) tailNode.textContent = tailText; else container.appendChild(renderTail(tailText)); } else if (tailNode) tailNode.textContent = ''; } else { if (part) consumed = stable.length; tailText = tail; } return { raw, consumed, tail: tailText, delta: part, closed }; }, set(value, container) { const next = String(value || ''); const delta = next.startsWith(raw) ? next.slice(raw.length) : next; if (!next.startsWith(raw)) this.reset(container); return this.append(delta, container); }, final(container, finalText = raw) { const next = String(finalText ?? raw ?? ''); const previousRaw = raw; const previousConsumed = consumed; raw = next; closed = true; let mode = 'noop', reason = ''; if (container) { const tailNode = findTail(container); const canCommitTail = next === previousRaw && previousConsumed <= next.length; const finalDelta = next.slice(previousConsumed); const finalHtml = render(next); const canSkipFullRerender = canCommitTail && (finalMarkupMatchesCurrent(container, finalHtml) || projectedIncrementalFinalMatches(container, finalHtml, finalDelta, render)); if (canSkipFullRerender) { if (tailNode) tailNode.remove(); if (finalDelta) { restoreStreamingResources(container); const inserted = insertRendered(container, render(finalDelta), null); enhanceSafe(fragmentRootFor(inserted), { final: true, streaming: true }); } else { restoreStreamingResources(container); enhanceSafe(container, { final: true, unchanged: true }); } consumed = raw.length; tailText = ''; mode = 'incremental-final'; } else { removeTail(container); container.replaceChildren(...htmlToFrag(render(raw)).childNodes); consumed = raw.length; tailText = ''; enhanceSafe(container, { final: true, reset: true }); mode = 'full-rerender-final'; reason = 'final-text-diverged'; } } else { consumed = raw.length; tailText = ''; mode = 'no-container'; } return { raw, mode, reason, consumed, closed, enhanced: !!container }; }, getRaw() { return raw; }, getConsumed() { return consumed; }, getTail() { return tailText; }, reset(container) { raw = ''; consumed = 0; tailText = ''; closed = false; if (container) container.innerHTML = ''; } }; }

  const api = Object.freeze({
    findStableBoundary,
    splitStableTail,
    createStreamingRenderer,
    deferStreamingResources,
    restoreStreamingResources,
    deferMarkdownResources,
    restoreMarkdownResources,
    fetchCachedResourceUrl,
    gateMarkdownResourceHtml,
  });

  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  if (global) global.ChatUIMarkdownBrowserStreamingRenderer = api;
})(typeof window !== 'undefined' ? window : globalThis);
