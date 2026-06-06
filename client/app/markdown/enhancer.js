(function initChatUIMarkdownEnhancer(root) {
'use strict';

const markdownEngine = root?.ChatUIMarkdownBrowserEngine
  || root?.window?.ChatUIMarkdownBrowserEngine
  || (typeof require === 'function' ? require('./markdown-engine') : {});
const mermaidNormalizer = root?.ChatUIMarkdownMermaidNormalizer
  || root?.window?.ChatUIMarkdownMermaidNormalizer
  || (typeof require === 'function' ? require('./mermaid-normalizer') : {});
const { slugify = (value = '') => String(value).trim().toLowerCase().replace(/[`~!@#$%^&*()+=[\]{};:'",.<>/?\|]/g, '').replace(/\s+/g, '-').replace(/-+/g, '-').replace(/^-|-$/g, '') } = markdownEngine;
const {
  normalizeBetaMermaidSource = source => String(source || ''),
  normalizeArchitectureMermaidSource = source => String(source || ''),
  normalizeSankeyMermaidSource = source => String(source || ''),
  normalizeRadarMermaidSource = source => String(source || ''),
  getSankeyLabelReplacements = () => [],
  restoreSankeySvgLabels = () => {},
} = mermaidNormalizer;

const COPY_ICON_SVG = '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M9 7.5A2.5 2.5 0 0 1 11.5 5h5A2.5 2.5 0 0 1 19 7.5v7A2.5 2.5 0 0 1 16.5 17h-5A2.5 2.5 0 0 1 9 14.5z"></path><path d="M7 19h5.5A2.5 2.5 0 0 0 15 16.5V16"></path><path d="M7 19A2.5 2.5 0 0 1 4.5 16.5v-7A2.5 2.5 0 0 1 7 7h5.5"></path></svg>';
const COPY_SUCCESS_ICON_SVG = '<svg class="copy-success-icon" viewBox="0 0 24 24" aria-hidden="true" focusable="false"><path d="M20 6 9 17l-5-5"></path></svg>';
const MERMAID_RENDER_ICON_SVG = '<svg viewBox="0 0 24 24" aria-hidden="true" fill="none" stroke="currentColor" stroke-linecap="round" stroke-linejoin="round"><path d="M7 7h7a3 3 0 0 1 3 3v1"></path><path d="m14 4 3 3-3 3"></path><path d="M17 17h-7a3 3 0 0 1-3-3v-1"></path><path d="m10 20-3-3 3-3"></path></svg>';
const MERMAID_SOURCE_ICON_SVG = '<svg viewBox="0 0 24 24" aria-hidden="true" fill="none" stroke="currentColor" stroke-linecap="round" stroke-linejoin="round"><path d="M7 7h7a3 3 0 0 1 3 3v1"></path><path d="m14 4 3 3-3 3"></path><path d="M17 17h-7a3 3 0 0 1-3-3v-1"></path><path d="m10 20-3-3 3-3"></path></svg>';
const MERMAID_LOADING_ICON_SVG = '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M12 5v3"></path><path d="M12 16v3"></path><path d="M5 12h3"></path><path d="M16 12h3"></path><path d="m7.05 7.05 2.12 2.12"></path><path d="m14.83 14.83 2.12 2.12"></path></svg>';
const MERMAID_ERROR_ICON_SVG = '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M12 8v5"></path><path d="M12 16.5h.01"></path><path d="M10.3 4.9 3.8 16.2A2 2 0 0 0 5.5 19h13a2 2 0 0 0 1.7-2.8L13.7 4.9a2 2 0 0 0-3.4 0z"></path></svg>';

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
  if (button.__copyBound) return;
  button.__copyBound = true;
  button.removeAttribute('data-copy-bound');
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
    }, 2000);
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
  if (!codeWrap) {
    const pre = block.querySelector(':scope > pre') || block.querySelector('pre');
    if (!pre) return null;
    codeWrap = document.createElement('div');
    codeWrap.className = 'code-block mermaid-source-view';
    pre.replaceWith(codeWrap);
    codeWrap.appendChild(pre);
  }
  codeWrap.classList.add('mermaid-source-view');
  codeWrap.hidden = block.dataset.mermaidRendered === '1';
  let code = codeWrap.querySelector('code.language-mermaid');
  if (!code) {
    code = codeWrap.querySelector('code') || document.createElement('code');
    code.className = 'language-mermaid';
    if (!code.parentNode) {
      const pre = codeWrap.querySelector('pre') || document.createElement('pre');
      pre.appendChild(code);
      if (!pre.parentNode) codeWrap.appendChild(pre);
    }
  }
  if (source && code.textContent !== source) code.textContent = source;
  if (!source) {
    source = code.textContent || '';
    block.dataset.mermaidSource = source;
  }
  return { codeWrap, source };
}

function setMermaidToggleState(button, state) {
  if (!button) return;
  button.dataset.mermaidState = state;
  button.classList.toggle('is-loading', state === 'rendering');
  button.classList.toggle('is-error', state === 'error');
  button.disabled = state === 'rendering';
  const labels = { source: '渲染 Mermaid 图表', rendering: '正在渲染 Mermaid 图表', rendered: '查看 Mermaid 源码', error: 'Mermaid 渲染失败，返回源码' };
  const icons = { source: MERMAID_RENDER_ICON_SVG, rendering: MERMAID_LOADING_ICON_SVG, rendered: MERMAID_SOURCE_ICON_SVG, error: MERMAID_ERROR_ICON_SVG };
  button.innerHTML = icons[state] || icons.source;
  button.title = labels[state] || labels.source;
  button.setAttribute('aria-label', button.title);
}

async function renderMermaidBlockOnDemand(block, loader = defaultLoadMermaid) {
  if (!block?.parentNode || block.dataset.mermaidRendered === 'rendering') return { ok: false, node: block, stale: true };
  const { codeWrap, source } = ensureMermaidSourceView(block) || {};
  const error = block.querySelector(':scope > .markdown-error');
  if (error) error.remove();
  block.querySelector(':scope > .mermaid')?.remove();
  const token = nextMermaidToken();
  block.dataset.mermaidRendered = 'rendering';
  block.dataset.mermaidToken = token;
  block.dataset.mermaidSource = source || '';
  if (codeWrap) codeWrap.hidden = true;
  let mermaid = null;
  try { mermaid = await loader(); } catch (err) { console.warn('[markdown] mermaid load failed:', err); }
  if (!mermaid) return restoreMermaidFallback(block, null, token, new Error('Mermaid unavailable'));
  try { mermaid.initialize?.({ startOnLoad: false, securityLevel: 'strict', theme: 'default', deterministicIds: false, deterministicIDSeed: undefined }); } catch {}
  return renderSingleMermaidBlock(block, mermaid);
}

function ensureRenderedMermaidToggle(block) {
  if (!block?.parentNode) return null;
  let btn = block.querySelector(':scope > .mermaid-render-toggle');
  if (!btn) {
    btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'inline-copy code-action-icon mermaid-toggle-btn mermaid-render-toggle';
    block.insertBefore(btn, block.firstChild);
  }
  if (!btn.__mermaidToggleBound) {
    btn.__mermaidToggleBound = true;
    btn.removeAttribute('data-mermaid-toggle-bound');
    btn.addEventListener('click', () => showMermaidSource(block));
  }
  setMermaidToggleState(btn, 'rendered');
  return btn;
}

function showMermaidSource(block) {
  if (!block?.parentNode) return;
  const source = block.dataset.mermaidSource || block.querySelector('code.language-mermaid')?.textContent || '';
  block.querySelector(':scope > .mermaid')?.remove();
  block.querySelector(':scope > .mermaid-render-toggle')?.remove();
  const error = block.querySelector(':scope > .markdown-error');
  if (error) error.hidden = true;
  block.dataset.mermaidRendered = '0';
  block.dataset.mermaidToken = '';
  block.dataset.mermaidSource = source;
  block.classList.add('markdown-mermaid-pending');
  block.classList.remove('mermaid-rendered-block', 'mermaid-fallback');
  const ensured = ensureMermaidSourceView(block);
  if (ensured?.codeWrap) ensured.codeWrap.hidden = false;
  const toggle = block.querySelector(':scope > .code-block > .mermaid-toggle-btn');
  setMermaidToggleState(toggle, 'source');
}

function initMermaidToggleUI(root, options = {}) {
  const blocks = collectMermaidBlocks(root);
  blocks.forEach((block) => {
    const ensured = ensureMermaidSourceView(block);
    if (!ensured) return;
    enhanceCodeCopy(ensured.codeWrap, options.copyText);
    let btn = ensured.codeWrap.querySelector(':scope > .mermaid-toggle-btn');
    if (!btn) {
      btn = document.createElement('button');
      btn.type = 'button';
      btn.className = 'inline-copy code-action-icon mermaid-toggle-btn';
      const copyBtn = ensured.codeWrap.querySelector(':scope > .code-copy-icon');
      ensured.codeWrap.insertBefore(btn, copyBtn ? copyBtn.nextSibling : ensured.codeWrap.firstChild);
    }
    if (!btn.__mermaidToggleBound) {
      btn.__mermaidToggleBound = true;
      btn.removeAttribute('data-mermaid-toggle-bound');
      btn.addEventListener('click', async () => {
        if (block.dataset.mermaidRendered === '1') { showMermaidSource(block); return; }
        setMermaidToggleState(btn, 'rendering');
        const result = await renderMermaidBlockOnDemand(block, options.loadMermaid || defaultLoadMermaid);
        if (result?.ok) setMermaidToggleState(btn, 'rendered');
        else {
          ensureMermaidSourceView(block);
          const visibleBtn = block.querySelector(':scope > .code-block > .mermaid-toggle-btn') || btn;
          setMermaidToggleState(visibleBtn, 'error');
          visibleBtn.disabled = false;
          setTimeout(() => { if (block.dataset.mermaidRendered === 'error') setMermaidToggleState(visibleBtn, 'source'); }, 1200);
        }
      });
    }
    setMermaidToggleState(btn, block.dataset.mermaidRendered === '1' ? 'rendered' : 'source');
  });
  return blocks;
}

async function defaultLoadMermaid() {
  if (root?.mermaid) return root.mermaid;
  await (root?.ChatUIMarkdownDependencyLoader?.loadMermaid?.() || root?.ChatUIMarkdownDependencyLoader?.loadScripts?.(resource => resource?.id === 'mermaid'));
  return root?.mermaid || null;
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
  if (typeof root?.requestIdleCallback === 'function') idleHandle = root.requestIdleCallback(run, { timeout: timeoutMs });
  else setTimeout(() => run({ didTimeout: false, timeRemaining: () => 8 }), 0);
  return { idleHandle, fallbackHandle };
}

function cancelIdle(handle) {
  if (!handle) return;
  if (typeof handle === 'object') {
    if (handle.idleHandle != null && typeof root?.cancelIdleCallback === 'function') root.cancelIdleCallback(handle.idleHandle);
    if (handle.fallbackHandle != null) clearTimeout(handle.fallbackHandle);
    return;
  }
  if (typeof root?.cancelIdleCallback === 'function') return root.cancelIdleCallback(handle);
  return clearTimeout(handle);
}

const performanceLog = [];

function measureStage(name, fn, details = {}) {
  const started = root?.performance?.now ? root.performance.now() : Date.now();
  const finish = (result) => {
    const ended = root?.performance?.now ? root.performance.now() : Date.now();
    const durationMs = ended - started;
    if (durationMs >= 50) {
      const entry = { name, durationMs: Math.round(durationMs), ...details };
      performanceLog.push(entry);
      if (performanceLog.length > 80) performanceLog.shift();
      if (typeof console !== 'undefined') console.warn?.('[ChatUI perf]', entry);
    }
    return result;
  };
  try {
    const result = fn();
    if (result && typeof result.then === 'function') return result.then(finish, (err) => { finish(null); throw err; });
    return finish(result);
  } catch (err) {
    finish(null);
    throw err;
  }
}

function isElementVisible(node) {
  if (!node?.getBoundingClientRect) return true;
  const rect = node.getBoundingClientRect();
  const margin = 900;
  const viewportHeight = root?.innerHeight || root?.document?.documentElement?.clientHeight || 800;
  return rect.bottom >= -margin && rect.top <= viewportHeight + margin;
}

function idleBatch(items, each, { batchSize = 8, budgetMs = 12, signal = null } = {}) {
  const list = [...items];
  return new Promise((resolve) => {
    let index = 0;
    const step = (deadline) => {
      if (signal?.cancelled) return resolve({ cancelled: true, processed: index });
      const started = root?.performance?.now ? root.performance.now() : Date.now();
      let count = 0;
      while (index < list.length) {
        each(list[index], index);
        index += 1;
        count += 1;
        const now = root?.performance?.now ? root.performance.now() : Date.now();
        const timeLeft = typeof deadline?.timeRemaining === 'function' ? deadline.timeRemaining() : Math.max(0, budgetMs - (now - started));
        if (count >= batchSize || timeLeft <= 2 || now - started >= budgetMs) break;
      }
      if (index >= list.length) return resolve({ cancelled: false, processed: index });
      scheduleIdle(step);
    };
    scheduleIdle(step);
  });
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
    if (!errorNode) {
      errorNode = document.createElement('div');
      errorNode.className = 'markdown-error';
      holder.insertBefore(errorNode, holder.firstChild);
    }
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

async function renderMermaidBlocks(root, loader = defaultLoadMermaid, options = {}) {
  return enqueueMermaidRender(async () => {
    const force = !!options.force;
    const blocks = collectMermaidBlocks(root).filter(node => root.contains?.(node) && node.dataset?.mermaidManual !== '1' && node.dataset?.mermaidRendered !== '1' && node.dataset?.mermaidRendered !== 'rendering' && node.dataset?.mermaidDeferred !== '1' && (force || isElementVisible(node)));
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

function enhanceRenderedMarkdown(root, options = {}) {
  if (!root?.querySelectorAll) return Promise.resolve([]);
  try { enhanceCodeCopy(root, options.copyText); } catch (err) { console.warn('[markdown] code copy enhance failed:', err); }
  try {
    if (options.allowResourceLoad === true && !options.streaming) globalThis.ChatUIMarkdownBrowserStreamingRenderer?.restoreMarkdownResources?.(root, { once: options.onceResourceLoad !== false });
    else globalThis.ChatUIMarkdownBrowserStreamingRenderer?.deferMarkdownResources?.(root);
  } catch {}
  const previous = root.__chatuiEnhanceJob;
  if (previous?.cancel) previous.cancel();
  const signal = { cancelled: false };
  root.__chatuiEnhanceJob = { cancel: () => { signal.cancelled = true; } };
  const runBasic = async () => {
    await idleBatch(root.querySelectorAll('h1,h2,h3,h4,h5,h6'), () => {}, { signal, batchSize: 1, budgetMs: 1 });
    if (signal.cancelled) return;
    measureStage('markdown.addHeadingAnchors', () => addHeadingAnchors(root));
    if (signal.cancelled) return;
    await idleBatch(root.querySelectorAll('table'), () => {}, { signal, batchSize: 1, budgetMs: 1 });
    if (signal.cancelled) return;
    measureStage('markdown.wrapTables', () => wrapTables(root));
    if (signal.cancelled) return;
    const pres = [...root.querySelectorAll('pre')];
    await idleBatch(pres, (pre) => enhanceCodeCopy(pre.parentElement || pre, options.copyText), { signal, batchSize: 4, budgetMs: 12 });
    if (signal.cancelled) return;
    measureStage('markdown.initMermaidToggleUI', () => initMermaidToggleUI(root, options));
  };
  const shouldAutoRenderMermaid = options.autoRenderMermaid === true;
  if (options.skipMermaid || !shouldAutoRenderMermaid) return runBasic().then(() => []);
  const run = (renderOptions = {}) => runBasic().then(() => signal.cancelled ? [] : renderMermaidBlocks(root, options.loadMermaid, { force: !!options.forceMermaid || !!renderOptions.force })).catch((err) => { console.warn('[markdown] mermaid enhance failed:', err); return []; });
  if (options.deferMermaid === false) return run({ force: !!options.forceMermaid });
  return new Promise(resolve => {
    let settled = false;
    let forceTimer = null;
    const finish = (promise) => Promise.resolve(promise).then(result => {
      if (!settled) { settled = true; if (forceTimer) clearTimeout(forceTimer); resolve(result); }
      return result;
    });
    const handle = scheduleIdle(() => finish(run()));
    forceTimer = setTimeout(() => {
      if (!settled && root?.isConnected !== false && collectMermaidBlocks(root).some(node => node.dataset?.mermaidRendered !== '1' && node.dataset?.mermaidRendered !== 'error')) finish(run({ force: true }));
    }, Number(options.mermaidFallbackMs) || 2600);
    root.__chatuiEnhanceJob.cancel = () => { signal.cancelled = true; cancelIdle(handle); if (forceTimer) clearTimeout(forceTimer); if (!settled) { settled = true; resolve([]); } };
  });
}

const api = Object.freeze({ normalizeBetaMermaidSource, normalizeArchitectureMermaidSource, normalizeSankeyMermaidSource, normalizeRadarMermaidSource, getSankeyLabelReplacements, restoreSankeySvgLabels, COPY_ICON_SVG, COPY_SUCCESS_ICON_SVG, addHeadingAnchors, wrapTables, bindCopyButton, enhanceCodeCopy, collectMermaidBlocks, initMermaidToggleUI, renderMermaidBlockOnDemand, showMermaidSource, renderMermaidBlocks, enhanceRenderedMarkdown, idleBatch, isElementVisible, performanceLog });

if (typeof module !== 'undefined' && module.exports) module.exports = api;
if (root) root.ChatUIMarkdownEnhancer = api;
if (root?.window) root.window.ChatUIMarkdownEnhancer = api;
})(typeof globalThis !== 'undefined' ? globalThis : (typeof window !== 'undefined' ? window : this));
