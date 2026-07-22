(function initChatUIMarkdownBrowserStreamingRenderer(global) {
  'use strict';

  const browserEngine = global.ChatUIMarkdownBrowserEngine || {};
  const browserEnhancer = global.ChatUIMarkdownBrowserEnhancer || {};
  const escapeHtml = browserEngine.escapeHtml || (value => String(value || '').replace(/[&<>"'`]/g, ch => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;', '`': '&#96;' }[ch])));
  const renderMarkdown = browserEngine.renderMarkdown || (markdown => `<p>${escapeHtml(markdown).replace(/\n/g, '<br>')}</p>`);
  const enhanceRenderedMarkdown = browserEnhancer.enhanceRenderedMarkdown || (() => Promise.resolve([]));
  const TPX = global.ChatUIApp?.imageStore?.TRANSPARENT_PIXEL || 'data:image/gif;base64,R0lGODlhAQABAIAAAAAAAP///ywAAAAAAQABAAACAUwAOw==';

  function shouldDeferStreamingResourceUrl(url = '') { const value = String(url || '').trim(); return !!value && !value.startsWith('data:') && !value.startsWith('blob:') && !value.startsWith('#') && value !== TPX && value !== 'about:blank'; }
  const STREAMING_RESOURCE_ATTRS = Object.freeze([
    ['img[src]', 'src', TPX],
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

  function normalizedHtml(value = '') { return String(value || '').replace(/\s+/g, ' ').trim(); }
  function finalMarkupMatchesCurrent(container, finalHtml = '') { const tpl = document.createElement('template'); tpl.innerHTML = String(finalHtml || ''); return normalizedHtml(container.innerHTML) === normalizedHtml(tpl.innerHTML); }
  function projectedIncrementalFinalMatches(container, finalHtml = '', finalDelta = '', renderMarkdown = null) { if (typeof renderMarkdown !== 'function') return false; const tpl = document.createElement('template'); tpl.innerHTML = String(finalHtml || ''); const current = container.cloneNode(true); const delta = document.createElement('template'); delta.innerHTML = renderMarkdown(finalDelta); current.append(...delta.content.childNodes); return normalizedHtml(current.innerHTML) === normalizedHtml(tpl.innerHTML); }

  const STREAMING_TAIL_SCAN_LIMIT = 65536;
  function boundedStreamingScanTail(text = '') {
    const value = String(text || '');
    return value.length > STREAMING_TAIL_SCAN_LIMIT ? value.slice(-STREAMING_TAIL_SCAN_LIMIT) : value;
  }

  function hasConservativeInlineMathTail(text = '') { const src = String(text || '').replace(/\r\n?/g, '\n'); const tail = src.slice(Math.max(0, src.lastIndexOf('\n') + 1)); let escaped = false; for (let i = 0; i < tail.length; i += 1) { const ch = tail[i]; if (escaped) { escaped = false; continue; } if (ch === '\\') { escaped = true; continue; } if (ch === '$' && tail[i + 1] !== '$' && tail[i - 1] !== '$') return true; } return false; }
  function splitLines(src) { const lines = []; let start = 0; for (let i = 0; i < src.length; i += 1) if (src[i] === '\n') { lines.push({ text: src.slice(start, i), start, end: i + 1, hasNl: true }); start = i + 1; } if (start < src.length) lines.push({ text: src.slice(start), start, end: src.length, hasNl: false }); return lines; }
  function fenceOfLine(line = '') { return String(line || '').match(/^\s{0,3}(`{3,}|~{3,})(.*)$/) || String(line || '').match(/^\s{0,3}>\s?(`{3,}|~{3,})(.*)$/); }
  function hasOpenFenceTail(text = '') {
    const src = String(text || '').replace(/\r\n?/g, '\n');
    let inFence = false, fenceChar = '', fenceLen = 0;
    for (const item of splitLines(src)) {
      const fence = fenceOfLine(item.text);
      if (!fence) continue;
      const marker = fence[1], ch = marker[0], info = String(fence[2] || '').trim();
      if (inFence) {
        if (ch === fenceChar && marker.length >= fenceLen && !info) { inFence = false; fenceChar = ''; fenceLen = 0; }
      } else {
        inFence = true; fenceChar = ch; fenceLen = marker.length;
      }
    }
    return inFence;
  }
  function activeStreamingFence(text = '') {
    const src = String(text || '').replace(/\r\n?/g, '\n');
    let active = null;
    for (const item of splitLines(src)) {
      const fence = fenceOfLine(item.text);
      if (!fence) continue;
      const marker = fence[1], ch = marker[0], info = String(fence[2] || '').trim();
      if (active) {
        if (ch === active.fenceChar && marker.length >= active.fenceLen && !info) active = null;
        continue;
      }
      if (!item.hasNl) continue;
      active = {
        openingStart: item.start,
        contentStart: item.end,
        fenceChar: ch,
        fenceLen: marker.length,
        info,
      };
    }
    if (!active) return null;
    const language = active.info.split(/\s+/)[0].replace(/^\{\.?/, '').replace(/^\./, '').replace(/\}$/, '').slice(0, 48);
    return {
      ...active,
      language,
      prefix: src.slice(0, active.openingStart),
      code: src.slice(active.contentStart),
    };
  }
  function isMarkdownTableRow(line = '') { const value = String(line || '').trim(); return /^\|.*\|$/.test(value) || /\S\s*\|\s*\S/.test(value); }
  function isMarkdownTableDivider(line = '') { return /^\|?\s*:?-{3,}:?\s*(?:\|\s*:?-{3,}:?\s*)+\|?\s*$/.test(String(line || '').trim()); }
  function activeTableBlockStart(text = '') {
    const src = String(text || '').replace(/\r\n?/g, '\n');
    if (!src || /\n\s*\n$/.test(src)) return -1;
    const beforeTailEnd = src.endsWith('\n') ? src.length - 1 : src.length;
    const blockBreak = src.lastIndexOf('\n\n', Math.max(0, beforeTailEnd - 1));
    const start = blockBreak >= 0 ? blockBreak + 2 : 0;
    let first = '', second = '', count = 0;
    for (let offset = start; offset < src.length;) {
      const nl = src.indexOf('\n', offset);
      const end = nl >= 0 ? nl : src.length;
      const line = src.slice(offset, end);
      if (line.trim()) {
        count += 1;
        if (count === 1) first = line;
        else if (count === 2) { second = line; break; }
      }
      if (nl < 0) break;
      offset = nl + 1;
    }
    if (!count) return -1;
    if (count === 1) return isMarkdownTableRow(first) ? start : -1;
    return isMarkdownTableRow(first) && isMarkdownTableDivider(second) ? start : -1;
  }
  function findStableBoundary(text = '') { const src = String(text || '').replace(/\r\n?/g, '\n'); if (!src) return 0; const lines = splitLines(src); let stable = 0, inFence = false, fenceChar = '', fenceLen = 0, inMath = false; const fenceOf = fenceOfLine, blank = l => /^\s*$/.test(l), mathFence = l => /^\s*\$\$\s*$/.test(l); for (const item of lines) { const line = item.text, complete = item.hasNl, fence = fenceOf(line); if (!inMath && fence) { const marker = fence[1], ch = marker[0], info = String(fence[2] || '').trim(); if (inFence) { if (ch === fenceChar && marker.length >= fenceLen && !info) { inFence = false; fenceChar = ''; fenceLen = 0; stable = item.end; } } else { inFence = true; fenceChar = ch; fenceLen = marker.length; } continue; } if (inFence) continue; if (mathFence(line)) { inMath = !inMath; if (!inMath && complete) stable = item.end; continue; } if (inMath) continue; if (blank(line) && complete && !hasConservativeInlineMathTail(src.slice(0, item.end))) stable = item.end; } if (!inFence && !inMath && src.endsWith('\n') && !hasConservativeInlineMathTail(src)) stable = Math.max(stable, src.length); if (hasConservativeInlineMathTail(src)) stable = Math.min(stable, Math.max(0, src.lastIndexOf('\n', src.length - 2) + 1)); const tableStart = activeTableBlockStart(src); if (tableStart >= 0) stable = Math.min(stable, tableStart); return Math.max(0, Math.min(stable, src.length)); }
  function splitStableTail(text = '') { const src = String(text || '').replace(/\r\n?/g, '\n'); const index = findStableBoundary(src); return { stable: src.slice(0, index), tail: src.slice(index), index }; }
  function createStreamingRenderer({
    renderMarkdown: render = renderMarkdown,
    enhance = enhanceRenderedMarkdown,
    highlighter = global.hljs,
    setTimer = global.setTimeout?.bind?.(global) || setTimeout,
    clearTimer = global.clearTimeout?.bind?.(global) || clearTimeout,
    highlightIntervalMs = 180,
  } = {}) {
    let raw = '', consumed = 0, tailText = '', closed = false;
    let scanOffset = 0, scanStable = 0, scanInFence = false, scanFenceChar = '', scanFenceLen = 0, scanInMath = false;
    let tailNode = null, tailTextNode = null;
    let streamingCodeNode = null, streamingCodeElement = null, streamingCodeAppendTextNode = null, streamingCodeRaw = '', streamingCodeKey = '';
    let streamingHighlightTimer = null;
    const htmlToFrag = (html, options = {}) => { const tpl = document.createElement('template'); tpl.innerHTML = String(html || ''); if (options.deferResources) deferStreamingResources(tpl.content); return tpl.content; };
    const insertRendered = (target, html, before, options = {}) => { const frag = htmlToFrag(html, options); const nodes = [...frag.childNodes]; target.insertBefore(frag, before); return nodes; };
    const fragmentRootFor = nodes => ({ querySelectorAll: selector => nodes.flatMap(node => node.nodeType === 1 ? [node, ...node.querySelectorAll(selector)] : []).filter(node => node.matches?.(selector)) });
    const wrapCompletedStreamingCodeBlocks = root => {
      root?.querySelectorAll?.('pre').forEach(pre => {
        if (pre.closest?.('.code-block')) return;
        const wrap = (pre.ownerDocument || document).createElement('div');
        wrap.className = 'code-block';
        pre.replaceWith(wrap);
        wrap.appendChild(pre);
      });
      return root;
    };
    const removeTailNode = () => {
      try { tailNode?.remove?.(); } catch {}
      tailNode = null;
      tailTextNode = null;
    };
    const clearStreamingHighlightTimer = () => {
      if (streamingHighlightTimer == null) return;
      try { clearTimer(streamingHighlightTimer); } catch {}
      streamingHighlightTimer = null;
    };
    const removeStreamingCodeNode = () => {
      clearStreamingHighlightTimer();
      try { streamingCodeNode?.remove?.(); } catch {}
      streamingCodeNode = null;
      streamingCodeElement = null;
      streamingCodeAppendTextNode = null;
      streamingCodeRaw = '';
      streamingCodeKey = '';
    };
    const ensureTailNode = container => {
      if (!container?.appendChild) return null;
      if (tailNode?.parentNode === container) return tailNode;
      removeTailNode();
      const doc = container.ownerDocument || document;
      tailNode = doc.createElement('span');
      tailNode.className = 'markdown-stream-tail';
      tailNode.setAttribute('data-markdown-streaming-tail', '1');
      tailNode.setAttribute('aria-live', 'polite');
      tailTextNode = doc.createTextNode('');
      tailNode.appendChild(tailTextNode);
      container.appendChild(tailNode);
      return tailNode;
    };
    const syncPlainTailNode = (container, text = '') => {
      const next = String(text || '');
      if (!next) return removeTailNode();
      const node = ensureTailNode(container);
      if (!node || !tailTextNode) return;
      const current = tailTextNode.nodeValue || '';
      if (current !== next) {
        if (next.startsWith(current) && typeof tailTextNode.appendData === 'function') tailTextNode.appendData(next.slice(current.length));
        else tailTextNode.nodeValue = next;
      }
      if (node.parentNode === container && node !== container.lastChild) container.appendChild(node);
    };
    const ensureStreamingCodeNode = (container, fence) => {
      if (!container?.appendChild) return null;
      const key = `${fence.fenceChar}:${fence.fenceLen}:${fence.language}`;
      if (streamingCodeNode?.parentNode === container && streamingCodeKey === key) return streamingCodeNode;
      removeStreamingCodeNode();
      const doc = container.ownerDocument || document;
      const block = doc.createElement('div');
      block.className = 'code-block streaming-code-block';
      block.setAttribute('data-markdown-streaming-code', '1');
      block.setAttribute('aria-busy', 'true');
      const label = doc.createElement('span');
      label.className = 'code-lang streaming-code-lang';
      label.textContent = fence.language ? `${fence.language} · 输出中` : '代码 · 输出中';
      const pre = doc.createElement('pre');
      const code = doc.createElement('code');
      const safeLanguage = /^[a-z0-9_+#.-]+$/i.test(fence.language) ? fence.language : '';
      if (safeLanguage) code.className = `language-${safeLanguage}`;
      code.dataset.streamingCodeLanguage = safeLanguage;
      streamingCodeAppendTextNode = doc.createTextNode('');
      code.appendChild(streamingCodeAppendTextNode);
      pre.appendChild(code);
      block.append(label, pre);
      streamingCodeNode = block;
      streamingCodeElement = code;
      streamingCodeRaw = '';
      streamingCodeKey = key;
      container.appendChild(block);
      return block;
    };
    const highlightedCodeFragment = (code, html, source) => {
      const doc = code?.ownerDocument || document;
      const tpl = doc.createElement('template');
      tpl.innerHTML = String(html || '');
      if (tpl.content.textContent !== source) return null;
      const elements = [...tpl.content.querySelectorAll('*')];
      const unsafe = elements.some(element => element.tagName !== 'SPAN' || [...element.attributes].some(attribute => attribute.name !== 'class'));
      return unsafe ? null : tpl.content;
    };
    const highlightStreamingCodeNow = () => {
      streamingHighlightTimer = null;
      const code = streamingCodeElement;
      const source = streamingCodeRaw;
      if (!code?.isConnected || !source || !highlighter) return false;
      const language = code.dataset.streamingCodeLanguage || '';
      let result = null;
      try {
        if (language && highlighter.getLanguage?.(language)) result = highlighter.highlight(source, { language, ignoreIllegals: true });
        else if (source.length <= 6000 && typeof highlighter.highlightAuto === 'function') result = highlighter.highlightAuto(source);
      } catch (err) {
        console.warn('[markdown] streaming code highlight failed:', err);
        return false;
      }
      if (!result?.value) return false;
      const fragment = highlightedCodeFragment(code, result.value, source);
      if (!fragment) return false;
      const pre = code.parentElement;
      const scrollTop = pre?.scrollTop || 0;
      const scrollLeft = pre?.scrollLeft || 0;
      code.replaceChildren(fragment);
      code.classList.add('hljs');
      code.dataset.streamingHighlighted = '1';
      streamingCodeAppendTextNode = null;
      if (pre) { pre.scrollTop = scrollTop; pre.scrollLeft = scrollLeft; }
      return true;
    };
    const scheduleStreamingCodeHighlight = () => {
      if (!highlighter || !streamingCodeElement || streamingHighlightTimer != null) return;
      const delay = Math.max(80, Number(highlightIntervalMs) || 180);
      streamingHighlightTimer = setTimer(highlightStreamingCodeNow, delay);
    };
    const syncStreamingCodeNode = (container, fence) => {
      const node = ensureStreamingCodeNode(container, fence);
      const code = streamingCodeElement;
      if (!node || !code) return;
      const next = String(fence.code || '');
      const current = streamingCodeRaw;
      if (current !== next) {
        if (next.startsWith(current)) {
          const delta = next.slice(current.length);
          if (delta) {
            if (!streamingCodeAppendTextNode?.parentNode) {
              streamingCodeAppendTextNode = code.ownerDocument.createTextNode('');
              code.appendChild(streamingCodeAppendTextNode);
            }
            streamingCodeAppendTextNode.appendData(delta);
          }
        } else {
          code.textContent = next;
          streamingCodeAppendTextNode = code.firstChild || code.appendChild(code.ownerDocument.createTextNode(''));
          code.classList.remove('hljs');
          delete code.dataset.streamingHighlighted;
        }
        streamingCodeRaw = next;
        scheduleStreamingCodeHighlight();
      }
      if (node.parentNode === container && node !== container.lastChild) container.appendChild(node);
    };
    const syncTailNode = (container, text = '') => {
      if (!container) return;
      const next = String(text || '');
      if (!next) {
        removeTailNode();
        removeStreamingCodeNode();
        return;
      }
      const fence = activeStreamingFence(next);
      if (!fence) {
        removeStreamingCodeNode();
        syncPlainTailNode(container, next);
        return;
      }
      syncPlainTailNode(container, fence.prefix);
      syncStreamingCodeNode(container, fence);
    };
    const enhanceSafe = (c, phase = {}) => {
      try {
        if (phase.streaming && !phase.final && !phase.reset) return;
        enhance?.(c, phase);
      } catch (err) { console.warn('[markdown] streaming enhance failed:', err); }
    };
    const hasInlineMathTailBefore = index => hasConservativeInlineMathTail(raw.slice(Math.max(0, index - STREAMING_TAIL_SCAN_LIMIT), index));
    const splitStableTailIncremental = () => {
      if (scanOffset > raw.length || consumed > raw.length) return splitStableTail(raw);
      const blank = l => /^\s*$/.test(l), mathFence = l => /^\s*\$\$\s*$/.test(l);
      while (scanOffset < raw.length) {
        const nl = raw.indexOf('\n', scanOffset);
        if (nl < 0) break;
        const end = nl + 1, line = raw.slice(scanOffset, nl), fence = fenceOfLine(line);
        if (!scanInMath && fence) {
          const marker = fence[1], ch = marker[0], info = String(fence[2] || '').trim();
          if (scanInFence) {
            if (ch === scanFenceChar && marker.length >= scanFenceLen && !info) { scanInFence = false; scanFenceChar = ''; scanFenceLen = 0; scanStable = end; }
          } else { scanInFence = true; scanFenceChar = ch; scanFenceLen = marker.length; }
        } else if (!scanInFence && mathFence(line)) {
          scanInMath = !scanInMath;
          if (!scanInMath) scanStable = end;
        } else if (!scanInFence && !scanInMath && blank(line) && !hasInlineMathTailBefore(end)) scanStable = end;
        scanOffset = end;
      }
      let index = scanStable;
      const tailScan = boundedStreamingScanTail(raw);
      const tailScanOffset = raw.length - tailScan.length;
      const inlineMathTail = hasConservativeInlineMathTail(tailScan);
      if (!scanInFence && !scanInMath && raw.endsWith('\n') && !inlineMathTail) index = Math.max(index, raw.length);
      if (inlineMathTail) index = Math.min(index, Math.max(0, raw.lastIndexOf('\n', raw.length - 2) + 1));
      const tableStartLocal = activeTableBlockStart(tailScan);
      const tableStart = tableStartLocal >= 0 ? tailScanOffset + tableStartLocal : -1;
      if (tableStart >= 0) index = Math.min(index, tableStart);
      index = Math.max(consumed, Math.min(index, raw.length));
      return { stable: raw.slice(0, index), tail: raw.slice(index), index };
    };
    return {
      append(delta, container) {
        if (closed) return { raw, consumed, tail: tailText, closed };
        raw += String(delta || '');
        const { stable, tail, index } = splitStableTailIncremental();
        if (index < consumed) {
          if (container) { container.replaceChildren(...htmlToFrag(render(raw), { deferResources: true }).childNodes); wrapCompletedStreamingCodeBlocks(container); enhanceSafe(container, { reset: true }); }
          consumed = raw.length; tailText = '';
          return { raw, consumed, tail: tailText, delta: raw, closed, reset: true, reason: 'stable-boundary-regressed' };
        }
        const part = stable.slice(consumed);
        if (container) {
          if (part) { const inserted = insertRendered(container, render(part), null, { deferResources: true }); consumed = stable.length; wrapCompletedStreamingCodeBlocks(fragmentRootFor(inserted)); enhanceSafe(fragmentRootFor(inserted), { streaming: true }); }
          syncTailNode(container, tail);
          tailText = tail;
        } else { if (part) consumed = stable.length; tailText = tail; }
        return { raw, consumed, tail: tailText, delta: part, closed };
      },
      set(value, container) { const next = String(value || ''); const delta = next.startsWith(raw) ? next.slice(raw.length) : next; if (!next.startsWith(raw)) this.reset(container); return this.append(delta, container); },
      preview(value, container) {
        const next = String(value || '');
        if (closed) return { raw, consumed, tail: tailText, closed, skipped: true };
        if (!next.startsWith(raw)) this.reset(container);
        raw = next;
        const tail = raw.slice(Math.min(consumed, raw.length));
        if (container) syncTailNode(container, tail);
        tailText = tail;
        return { raw, consumed, tail: tailText, closed, skipped: true, preview: true };
      },
      final(container, finalText = raw) {
        const next = String(finalText ?? raw ?? ''), previousRaw = raw, previousConsumed = consumed;
        raw = next; closed = true;
        let mode = 'noop', reason = '';
        if (container) {
          const canCommitTail = next === previousRaw && previousConsumed <= next.length, finalDelta = next.slice(previousConsumed);
          if (canCommitTail) {
            removeTailNode();
            removeStreamingCodeNode();
            if (finalDelta) { restoreStreamingResources(container); insertRendered(container, render(finalDelta), null); }
            else restoreStreamingResources(container);
            enhanceSafe(container, { final: true, streaming: true });
            consumed = raw.length; tailText = ''; mode = 'incremental-final';
          } else {
            removeTailNode();
            removeStreamingCodeNode();
            container.replaceChildren(...htmlToFrag(render(raw)).childNodes); consumed = raw.length; tailText = ''; enhanceSafe(container, { final: true, reset: true }); mode = 'full-rerender-final'; reason = 'final-text-diverged';
          }
        } else { consumed = raw.length; tailText = ''; mode = 'no-container'; }
        return { raw, mode, reason, consumed, closed, enhanced: !!container };
      },
      getRaw() { return raw; }, getConsumed() { return consumed; }, getTail() { return tailText; }, reset(container) { raw = ''; consumed = 0; tailText = ''; closed = false; scanOffset = 0; scanStable = 0; scanInFence = false; scanFenceChar = ''; scanFenceLen = 0; scanInMath = false; removeTailNode(); removeStreamingCodeNode(); if (container) container.innerHTML = ''; }
    };
  }

  const api = Object.freeze({
    findStableBoundary,
    splitStableTail,
    activeStreamingFence,
    activeTableBlockStart,
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
