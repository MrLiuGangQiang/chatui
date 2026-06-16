(function initChatUILongAnswerRenderer(root) {
  'use strict';

  const DEFAULTS = Object.freeze({
    streamChars: 12000,
    finalChars: 18000,
    streamNodeChars: 6000,
    streamingCommitMinChars: 0,
    streamingMaxImmediateBlocks: 16,
    streamingMergeMinChars: 1000,
    streamingMergeMaxChars: 6000,
    streamingSyncBudgetMs: 6,
    streamingSyncMaxBlocksPerFrame: 4,
    initialMarkdownBlocks: 16,
    blockSoftChars: 14000,
    blockHardChars: 12000,
    frameBudgetMs: 8,
    maxBlocksPerFrame: 6,
  });

  function shouldUseLongAnswerRenderer(text = '', options = {}) {
    const raw = String(text || '');
    if (!raw) return false;
    const streamChars = Number(options.streamChars) || DEFAULTS.streamChars;
    const finalChars = Number(options.finalChars) || DEFAULTS.finalChars;
    const limit = options.streaming ? streamChars : finalChars;
    if (raw.length >= limit) return true;
    const newlineLimit = options.streaming ? 220 : 320;
    let lines = 1;
    for (let i = 0; i < raw.length; i += 1) {
      if (raw.charCodeAt(i) === 10 && ++lines >= newlineLimit) return true;
    }
    return false;
  }

  function defaultSplitMarkdownRenderChunks(text = '') {
    const src = String(text || '').replace(/\r\n?/g, '\n');
    const chunks = [];
    let buf = '', inFence = false, fenceChar = '', fenceLen = 0, inMath = false;
    const flush = () => { if (buf) { chunks.push(buf); buf = ''; } };
    for (const line of src.split(/(?<=\n)/)) {
      const rawLine = line.replace(/\n$/, '');
      const fence = rawLine.match(/^\s{0,3}(`{3,}|~{3,})(.*)$/);
      if (!inMath && fence) {
        const marker = fence[1], ch = marker[0], info = String(fence[2] || '').trim();
        if (inFence && ch === fenceChar && marker.length >= fenceLen && !info) {
          inFence = false; fenceChar = ''; fenceLen = 0; buf += line; flush(); continue;
        }
        if (!inFence) { inFence = true; fenceChar = ch; fenceLen = marker.length; }
        buf += line; continue;
      }
      if (!inFence && /^\s*\$\$\s*$/.test(rawLine)) {
        inMath = !inMath; buf += line; if (!inMath) flush(); continue;
      }
      buf += line;
      if (!inFence && !inMath && /^\s*$/.test(rawLine)) flush();
      if (!inFence && !inMath && buf.length > 8000) flush();
    }
    flush();
    return chunks.length ? chunks : [src];
  }

  function createLongAnswerRenderer(messageNode, deps = {}) {
    const doc = deps.document || root?.document || (typeof document !== 'undefined' ? document : null);
    const perf = deps.performance || root?.performance || (typeof performance !== 'undefined' ? performance : null);
    const win = deps.window || root?.window || (typeof window !== 'undefined' ? window : null);
    const render = deps.renderMarkdown || (value => String(value || ''));
    const splitChunks = deps.splitMarkdownRenderChunks || defaultSplitMarkdownRenderChunks;
    const bindCopy = deps.bindInlineCopyButtons || (() => {});
    const enhance = deps.enhanceRenderedMarkdown || (() => {});
    const hydrate = deps.hydrateMessageMedia || (() => {});
    const resetActions = deps.resetMessageActionStates || (() => {});
    const cleanup = deps.cleanupGeneratedImageNumberArtifacts || (() => {});
    const logLongTask = deps.chatuiLogLongTask || (() => {});
    const cfg = { ...DEFAULTS, ...(deps.options || {}) };

    let raw = '', streamRoot = null, streamTextNode = null, streamTextNodeChars = 0;
    let blockRoot = null, tailNode = null, pendingText = '';
    let blocks = [], queue = [], queued = new Set(), rendered = new Set();
    let idleHandle = null, fallbackHandle = null, observer = null, cancelled = false, finalHash = '';
    let streamSyncWindowStart = 0, streamSyncUsedMs = 0, streamSyncBlocks = 0;

    const now = () => perf?.now ? perf.now() : Date.now();
    const scheduleTimeout = (fn, ms = 0) => deps.setTimeout ? deps.setTimeout.call(win || root || null, fn, ms) : setTimeout(fn, ms);
    const clearScheduledTimeout = id => { if (id != null) (deps.clearTimeout || clearTimeout).call(win || root || null, id); };
    const messageRoot = () => deps.getMessagesRoot?.() || deps.$?.('messages') || doc?.getElementById?.('messages') || null;
    const isConnected = () => !!messageNode?.isConnected;
    const isUserInteracting = () => !!(deps.isUserInteracting?.() || deps.state?.userScrollLocked || Date.now() < Number(deps.state?.outputPinSuppressUntil || 0));

    const isNearViewport = node => {
      if (!node?.getBoundingClientRect) return true;
      try {
        if (typeof deps.isNearViewport === 'function') return deps.isNearViewport(node, 900);
        const rect = node.getBoundingClientRect();
        const rootNode = messageRoot();
        if (rootNode?.getBoundingClientRect) {
          const rootRect = rootNode.getBoundingClientRect();
          return rect.bottom >= rootRect.top - 900 && rect.top <= rootRect.bottom + 900;
        }
        const height = win?.innerHeight || doc?.documentElement?.clientHeight || 800;
        return rect.bottom >= -900 && rect.top <= height + 900;
      } catch { return true; }
    };

    const cancelIdle = () => {
      if (idleHandle != null && typeof win?.cancelIdleCallback === 'function') win.cancelIdleCallback(idleHandle);
      clearScheduledTimeout(fallbackHandle);
      idleHandle = null;
      fallbackHandle = null;
    };

    const schedule = (delay = 0) => {
      if (cancelled || idleHandle != null || fallbackHandle != null) return;
      const runner = deadline => {
        idleHandle = null;
        clearScheduledTimeout(fallbackHandle);
        fallbackHandle = null;
        run(deadline || { timeRemaining: () => 4, didTimeout: true });
      };
      if (delay > 0) fallbackHandle = scheduleTimeout(() => runner({ timeRemaining: () => 4, didTimeout: true }), delay);
      else if (typeof win?.requestIdleCallback === 'function') {
        idleHandle = win.requestIdleCallback(runner, { timeout: 160 });
        fallbackHandle = scheduleTimeout(() => runner({ timeRemaining: () => 4, didTimeout: true }), 260);
      } else fallbackHandle = scheduleTimeout(() => runner({ timeRemaining: () => 6, didTimeout: true }), 0);
    };

    const enqueue = (index, front = false) => {
      if (!Number.isFinite(index) || index < 0 || index >= blocks.length || rendered.has(index) || queued.has(index)) return;
      queued.add(index);
      front ? queue.unshift(index) : queue.push(index);
    };

    const resetStreamingSyncWindowIfNeeded = () => {
      const t = now();
      if (!streamSyncWindowStart || t - streamSyncWindowStart > 16) {
        streamSyncWindowStart = t;
        streamSyncUsedMs = 0;
        streamSyncBlocks = 0;
      }
    };

    const canRenderStreamingBlockNow = () => {
      resetStreamingSyncWindowIfNeeded();
      if (streamSyncBlocks >= cfg.streamingSyncMaxBlocksPerFrame) return false;
      if (streamSyncUsedMs >= cfg.streamingSyncBudgetMs) return false;
      return true;
    };

    const noteStreamingRenderCost = duration => {
      resetStreamingSyncWindowIfNeeded();
      streamSyncUsedMs += Math.max(0, Number(duration) || 0);
      streamSyncBlocks += 1;
    };

    const mergeSmallStreamingChunks = chunks => {
      const merged = [];
      let buf = '';
      for (const chunk of chunks) {
        const value = String(chunk || '');
        if (!value) continue;
        if (!buf) {
          buf = value;
          continue;
        }
        const nextLen = buf.length + value.length;
        if (buf.length < cfg.streamingMergeMinChars && nextLen <= cfg.streamingMergeMaxChars) buf += value;
        else {
          merged.push(buf);
          buf = value;
        }
      }
      if (buf) merged.push(buf);
      return merged;
    };

    const ensureBlockRoot = content => {
      if (!doc || !content) return null;
      if (blockRoot?.isConnected && tailNode?.isConnected) return blockRoot;
      content.innerHTML = '';
      blockRoot = doc.createElement('div');
      blockRoot.className = 'long-answer-block-root';
      blockRoot.dataset.longAnswerBlocks = String(blocks.length);
      tailNode = doc.createElement('div');
      tailNode.className = 'long-answer-stream-tail plain-text';
      tailNode.dataset.longAnswerTail = '1';
      blockRoot.appendChild(tailNode);
      content.appendChild(blockRoot);
      return blockRoot;
    };

    const appendBlockNode = (text, { front = false, renderNow = false } = {}) => {
      if (!doc || !blockRoot || !tailNode) return;
      const chunk = String(text || '');
      if (!chunk) return;
      const node = doc.createElement('div');
      node.className = 'long-answer-block long-answer-block-pending plain-text';
      const index = blocks.length;
      node.dataset.longAnswerBlock = String(index);
      node.textContent = chunk;
      blocks.push({ text: chunk, node });
      const doRenderNow = renderNow && canRenderStreamingBlockNow();
      if (doRenderNow) {
        const started = now();
        try {
          node.classList.remove('plain-text', 'long-answer-block-pending');
          node.classList.add('markdown-body', 'long-answer-block-rendered');
          node.innerHTML = render(chunk);
          bindCopy(node);
          enhance(node, { deferMermaid: true, progressive: true, longAnswer: true, allowResourceLoad: true });
          cleanup(node);
          rendered.add(index);
          node.dataset.rendered = '1';
          const duration = now() - started;
          noteStreamingRenderCost(duration);
          logLongTask('message.longAnswer.streamRenderNow', duration, { chars: chunk.length, index });
        } catch (err) {
          console.warn('[long-answer] stream block render failed:', err);
          node.classList.add('plain-text', 'long-answer-block-error');
          node.textContent = chunk;
          rendered.add(index);
        }
      }
      blockRoot.insertBefore(node, tailNode);
      blockRoot.dataset.longAnswerBlocks = String(blocks.length);
      if (!doRenderNow) enqueue(index, front);
      try { observer?.observe?.(node); } catch {}
    };

    const shouldCommitStreamingTail = text => /\n\s*\n$/.test(String(text || '')) || String(text || '').length >= cfg.blockHardChars;

    const commitStreamingChunks = (content, { force = false } = {}) => {
      ensureBlockRoot(content);
      if (!blockRoot || !tailNode) return;
      if (!pendingText) {
        tailNode.textContent = '';
        tailNode.hidden = true;
        return;
      }
      const chunks = splitChunks(pendingText).flatMap(chunk => {
        const value = String(chunk || '');
        if (value.length <= cfg.blockSoftChars) return [value];
        const parts = [];
        for (let i = 0; i < value.length; i += cfg.blockHardChars) parts.push(value.slice(i, i + cfg.blockHardChars));
        return parts;
      });
      let stableCount = 0;
      if (force) stableCount = chunks.length;
      else if (chunks.length > 1) stableCount = Math.min(chunks.length - 1, cfg.streamingMaxImmediateBlocks);
      else if (chunks.length === 1 && shouldCommitStreamingTail(chunks[0])) stableCount = 1;
      const stableChunks = force ? chunks.slice(0, stableCount) : mergeSmallStreamingChunks(chunks.slice(0, stableCount));
      for (let i = 0; i < stableChunks.length; i += 1) appendBlockNode(stableChunks[i], { front: true, renderNow: !force });
      pendingText = chunks.slice(stableCount).join('');
      tailNode.textContent = pendingText;
      tailNode.hidden = !pendingText;
      if (stableCount > 0) schedule();
    };

    const renderBlock = index => {
      const block = blocks[index];
      if (!block?.node || rendered.has(index) || !block.node.isConnected) return;
      const started = now();
      try {
        block.node.classList.remove('plain-text', 'long-answer-block-pending');
        block.node.classList.add('markdown-body', 'long-answer-block-rendered');
        block.node.innerHTML = render(block.text);
        bindCopy(block.node);
        enhance(block.node, { deferMermaid: true, progressive: true, longAnswer: true, allowResourceLoad: true });
        cleanup(block.node);
        rendered.add(index);
        block.node.dataset.rendered = '1';
        logLongTask('message.longAnswer.blockRender', now() - started, { chars: block.text.length, index });
      } catch (err) {
        console.warn('[long-answer] block render failed:', err);
        block.node.classList.add('plain-text', 'long-answer-block-error');
        block.node.textContent = block.text;
        rendered.add(index);
      }
    };

    const finishIfDone = () => {
      if (!finalHash || rendered.size < blocks.length) return false;
      delete messageNode.dataset.progressiveRendering;
      messageNode.dataset.enhancedHash = finalHash;
      messageNode.dataset.longAnswerState = 'rendered';
      resetActions(messageNode);
      cleanup(messageNode);
      hydrate(messageNode, { save: false });
      return true;
    };

    function promoteVisibleBlocks(limit = 64) {
      let promoted = 0;
      for (let index = 0; index < blocks.length && promoted < limit; index += 1) {
        const block = blocks[index];
        if (!block?.node || rendered.has(index) || queued.has(index)) continue;
        if (isNearViewport(block.node)) {
          enqueue(index, true);
          promoted += 1;
        }
      }
      return promoted;
    }

    function run(deadline) {
      if (cancelled || !isConnected()) return;
      const interacting = isUserInteracting();
      promoteVisibleBlocks(interacting ? 24 : 80);
      const started = now();
      const frameBudget = interacting ? Math.max(4, cfg.frameBudgetMs / 2) : cfg.frameBudgetMs;
      const maxBlocks = interacting ? Math.max(1, Math.floor(cfg.maxBlocksPerFrame / 2)) : cfg.maxBlocksPerFrame;
      let renderedCount = 0;
      let attempts = 0;
      const maxAttempts = Math.max(12, Math.min(queue.length + 8, 160));
      while (queue.length && attempts < maxAttempts) {
        attempts += 1;
        const index = queue.shift();
        queued.delete(index);
        if (rendered.has(index)) continue;
        const block = blocks[index];
        if (!block?.node) continue;
        const near = isNearViewport(block.node);
        if (!near && attempts < maxAttempts && (renderedCount > 0 || interacting)) {
          enqueue(index);
          continue;
        }
        renderBlock(index);
        renderedCount += 1;
        const elapsed = now() - started;
        const remaining = typeof deadline?.timeRemaining === 'function' ? deadline.timeRemaining() : 0;
        if (elapsed >= frameBudget || (remaining && remaining < 3) || renderedCount >= maxBlocks) break;
      }
      if (!finishIfDone() && queue.length) schedule(interacting ? 80 : 0);
    }

    const ensureStreamRoot = content => {
      if (!doc || !content) return null;
      return ensureBlockRoot(content);
    };

    const appendPlain = (content, delta = '') => {
      ensureBlockRoot(content);
      if (!blockRoot || !tailNode || !delta) return;
      pendingText += String(delta || '');
      commitStreamingChunks(content, { force: false });
    };

    const set = (value = '', content) => {
      const next = String(value || '');
      messageNode.dataset.longAnswerMode = 'stream-block-progressive';
      messageNode.dataset.longAnswerState = 'streaming';
      messageNode.dataset.progressiveRendering = '1';
      if (next.startsWith(raw)) appendPlain(content, next.slice(raw.length));
      else {
        raw = '';
        blockRoot = null;
        tailNode = null;
        pendingText = '';
        blocks = [];
        queue = [];
        queued = new Set();
        rendered = new Set();
        appendPlain(content, next);
      }
      raw = next;
      return { raw, mode: 'stream-block-progressive', consumed: raw.length };
    };

    const buildBlocks = (content, text) => {
      if (!doc || !content) return;
      cancelIdle();
      if (observer?.__scrollRoot && observer.__scrollHandler) {
        try { observer.__scrollRoot.removeEventListener('scroll', observer.__scrollHandler); } catch {}
      }
      try { observer?.disconnect?.(); } catch {}
      observer = null;
      const onScroll = () => { promoteVisibleBlocks(80); schedule(); };
      const scrollRoot = messageRoot();
      if (typeof win?.IntersectionObserver === 'function') {
        try {
          observer = new win.IntersectionObserver(entries => {
            entries.forEach(entry => {
              if (entry.isIntersecting || entry.intersectionRatio > 0) enqueue(Number(entry.target?.dataset?.longAnswerBlock), true);
            });
            schedule();
          }, { root: messageRoot(), rootMargin: '1200px 0px', threshold: 0.01 });
          blocks.forEach(block => observer.observe(block.node));
        } catch {}
      }
      if (scrollRoot?.addEventListener) {
        try {
          scrollRoot.addEventListener('scroll', onScroll, { passive: true });
          observer = observer || {};
          observer.__scrollRoot = scrollRoot;
          observer.__scrollHandler = onScroll;
        } catch {}
      }
      ensureBlockRoot(content);
      if (!blocks.length && !pendingText) pendingText = String(text || '');
      commitStreamingChunks(content, { force: true });
      promoteVisibleBlocks(96);
      const seedLimit = blocks.length <= 80 ? blocks.length : Math.min(blocks.length, Math.max(cfg.initialMarkdownBlocks, 24));
      for (let index = 0; index < seedLimit; index += 1) {
        if (blocks.length <= 80 || isNearViewport(blocks[index]?.node)) enqueue(index, true);
      }
    };

    const final = (content, text = raw, hash = '') => {
      raw = String(text || '');
      finalHash = hash || deps.contentHash?.(raw) || '';
      cancelled = false;
      messageNode.dataset.longAnswerMode = 'block-progressive-final';
      messageNode.dataset.longAnswerState = 'rendering';
      messageNode.dataset.progressiveRendering = '1';
      messageNode.dataset.renderedHash = finalHash;
      messageNode.dataset.lazyMarkdown = '0';
      buildBlocks(content, raw);
      schedule();
      return { raw, mode: 'block-progressive-final', reason: 'long-answer-renderer', consumed: raw.length, enhanced: false };
    };

    const cancel = () => {
      cancelled = true;
      cancelIdle();
      try { observer?.disconnect?.(); } catch {}
      if (observer?.__scrollRoot && observer.__scrollHandler) {
        try { observer.__scrollRoot.removeEventListener('scroll', observer.__scrollHandler); } catch {}
      }
      observer = null;
      queue = [];
      queued.clear?.();
    };

    return {
      set,
      append: (delta, content) => {
        const value = String(delta || '');
        if (!value) return { raw, mode: messageNode.dataset.longAnswerMode || 'stream-block-progressive', consumed: raw.length };
        messageNode.dataset.longAnswerMode = 'stream-block-progressive';
        messageNode.dataset.longAnswerState = 'streaming';
        messageNode.dataset.progressiveRendering = '1';
        raw += value;
        appendPlain(content, value);
        return { raw, mode: 'stream-block-progressive', consumed: raw.length };
      },
      final,
      cancel,
      getRaw: () => raw,
      stats: () => ({ rawLength: raw.length, blocks: blocks.length, queued: queue.length, rendered: rendered.size, mode: messageNode.dataset.longAnswerMode || '', streamSync: { usedMs: Math.round(streamSyncUsedMs), blocks: streamSyncBlocks } }),
    };
  }

  const api = Object.freeze({ shouldUseLongAnswerRenderer, createLongAnswerRenderer, defaultSplitMarkdownRenderChunks });
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  if (root) root.ChatUILongAnswerRenderer = api;
  if (root?.window) root.window.ChatUILongAnswerRenderer = api;
})(typeof globalThis !== 'undefined' ? globalThis : (typeof window !== 'undefined' ? window : this));
