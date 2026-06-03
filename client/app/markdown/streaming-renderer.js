'use strict';

const { splitStableTail } = require('./stable-boundary');

function defaultTailNode(text = '') {
  const span = document.createElement('span');
  span.className = 'streaming-tail';
  span.dataset.markdownStreamingTail = '1';
  span.textContent = String(text || '');
  return span;
}

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

function findTail(container) {
  return container?.querySelector?.('[data-markdown-streaming-tail="1"], .streaming-tail') || null;
}

function removeTail(container) {
  findTail(container)?.remove();
}

function createStreamingRenderer({ renderMarkdown, enhance, renderTailText } = {}) {
  if (typeof renderMarkdown !== 'function') throw new TypeError('createStreamingRenderer requires renderMarkdown');
  let raw = '';
  let consumed = 0;
  let closed = false;
  let tailText = '';
  const renderTail = renderTailText || defaultTailNode;

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
          removeTail(container);
          enhanceRoot(container, { reset: true });
        }
        consumed = raw.length;
        tailText = '';
        return { raw, consumed, tail: tailText, delta: raw, closed, reset: true, reason: 'stable-boundary-regressed' };
      }
      const delta = stable.slice(consumed);
      if (container) {
        let tailNode = findTail(container);
        if (delta) {
          const inserted = insertHtmlBefore(container, renderMarkdown(delta), tailNode);
          consumed = stable.length;
          enhanceRoot(fragmentRootFor(inserted), { streaming: true });
        }
        tailText = tail;
        tailNode = findTail(container);
        if (tailText) {
          if (tailNode) tailNode.textContent = tailText;
          else container.appendChild(renderTail(tailText));
        } else if (tailNode) {
          tailNode.textContent = '';
        }
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
      const previousTail = tailText;
      raw = next;
      closed = true;
      let mode = 'noop';
      let reason = '';
      if (container) {
        removeTail(container);
        const tpl = document.createElement('template');
        tpl.innerHTML = renderMarkdown(raw);
        container.replaceChildren(...tpl.content.childNodes);
        consumed = raw.length;
        tailText = '';
        enhanceRoot(container, { final: true });
        mode = 'full-rerender-final';
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
