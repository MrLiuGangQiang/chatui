'use strict';

const { splitStableTail } = require('./stable-boundary');

function appendHtml(container, html = '') {
  const tpl = document.createElement('template');
  tpl.innerHTML = String(html || '');
  container.append(...tpl.content.childNodes);
}

function insertHtmlBefore(container, html = '', beforeNode = null) {
  const tpl = document.createElement('template');
  tpl.innerHTML = String(html || '');
  const nodes = [...tpl.content.childNodes];
  container.insertBefore(tpl.content, beforeNode);
  return nodes;
}

function fragmentRootFor(nodes = []) {
  const root = document.createElement('span');
  root.dataset.markdownStreamingFragment = '1';
  nodes.forEach((node) => {
    if (node.nodeType === 1) root.appendChild(node.cloneNode(false));
  });
  root.querySelectorAll = selector => nodes.flatMap(node => (node.nodeType === 1 ? [node, ...node.querySelectorAll(selector)] : [])).filter(node => node.matches?.(selector));
  return { querySelectorAll: root.querySelectorAll.bind(root) };
}

function wrapCompletedStreamingCodeBlocks(root) {
  root?.querySelectorAll?.('pre').forEach((pre) => {
    if (pre.closest?.('.code-block')) return;
    const wrap = (pre.ownerDocument || document).createElement('div');
    wrap.className = 'code-block';
    pre.replaceWith(wrap);
    wrap.appendChild(pre);
  });
  return root;
}

function normalizedHtml(value = '') {
  return String(value || '').replace(/\s+/g, ' ').trim();
}

function finalMarkupMatchesCurrent(container, finalHtml = '') {
  const tpl = document.createElement('template');
  tpl.innerHTML = String(finalHtml || '');
  return normalizedHtml(container.innerHTML) === normalizedHtml(tpl.innerHTML);
}

function projectedIncrementalFinalMatches(container, finalHtml = '', finalDelta = '', renderMarkdown = null) {
  if (typeof renderMarkdown !== 'function') return false;
  const tpl = document.createElement('template');
  tpl.innerHTML = String(finalHtml || '');
  const current = container.cloneNode(true);
  const delta = document.createElement('template');
  delta.innerHTML = renderMarkdown(finalDelta);
  current.append(...delta.content.childNodes);
  return normalizedHtml(current.innerHTML) === normalizedHtml(tpl.innerHTML);
}

function createStreamingRenderer({ renderMarkdown, enhance } = {}) {
  if (typeof renderMarkdown !== 'function') throw new TypeError('createStreamingRenderer requires renderMarkdown');
  let raw = '';
  let consumed = 0;
  let closed = false;
  let tailText = '';

  function enhanceRoot(root, phase = {}) {
    try { return enhance?.(root, phase); }
    catch (err) { console.warn('[markdown] streaming enhance failed:', err); return null; }
  }

  return {
    append(chunk, container) {
      if (closed) return { raw, consumed, tail: tailText, closed };
      raw += String(chunk || '');
      const { stable, tail, index } = splitStableTail(raw);
      if (index < consumed) {
        if (container) {
          container.innerHTML = renderMarkdown(raw);
          wrapCompletedStreamingCodeBlocks(container);
          enhanceRoot(container, { reset: true });
        }
        consumed = raw.length;
        tailText = '';
        return { raw, consumed, tail: tailText, delta: raw, closed, reset: true, reason: 'stable-boundary-regressed' };
      }
      const delta = stable.slice(consumed);
      if (container) {
        if (delta) {
          const inserted = insertHtmlBefore(container, renderMarkdown(delta), null);
          consumed = stable.length;
          wrapCompletedStreamingCodeBlocks(fragmentRootFor(inserted));
          enhanceRoot(fragmentRootFor(inserted), { streaming: true });
        }
        tailText = tail;
      } else {
        if (delta) consumed = stable.length;
        tailText = tail;
      }
      return { raw, consumed, tail: tailText, delta, closed };
    },
    set(value, container) {
      const next = String(value || '');
      const delta = next.startsWith(raw) ? next.slice(raw.length) : next;
      if (!next.startsWith(raw)) this.reset(container);
      return this.append(delta, container);
    },
    final(container, finalText = raw) {
      const next = String(finalText ?? raw ?? '');
      const previousRaw = raw;
      const previousConsumed = consumed;
      raw = next;
      closed = true;
      let mode = 'noop';
      let reason = '';
      if (container) {
        const canCommitTail = next === previousRaw && previousConsumed <= next.length;
        const finalDelta = next.slice(previousConsumed);
        if (canCommitTail) {
          if (finalDelta) {
            const inserted = insertHtmlBefore(container, renderMarkdown(finalDelta), null);
            enhanceRoot(fragmentRootFor(inserted), { final: true, streaming: true });
          } else {
            enhanceRoot(container, { final: true, unchanged: true });
          }
          consumed = raw.length;
          tailText = '';
          mode = 'incremental-final';
        } else {
          const tpl = document.createElement('template');
          tpl.innerHTML = renderMarkdown(raw);
          container.replaceChildren(...tpl.content.childNodes);
          consumed = raw.length;
          tailText = '';
          enhanceRoot(container, { final: true, reset: true });
          mode = 'full-rerender-final';
          reason = 'final-text-diverged';
        }
      } else {
        consumed = raw.length;
        tailText = '';
        mode = 'no-container';
      }
      return { raw, mode, reason, consumed, closed, enhanced: !!container };
    }, 
    reset(container) {
      raw = '';
      consumed = 0;
      closed = false;
      tailText = '';
      if (container) container.innerHTML = '';
    },
    getRaw() { return raw; },
    getConsumed() { return consumed; },
    getTail() { return tailText; },
  };
}

module.exports = { createStreamingRenderer };
