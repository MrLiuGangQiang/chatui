(function initMarkdownDependencyLoader(global) {
  'use strict';

  const VERSION = '2.0.3';
  const DEFAULT_TIMEOUT_MS = 2500;
  const LOCAL_FIRST = true;
  const GLOBAL_ALIASES = Object.freeze({ markdownItTaskLists: 'markdownitTaskLists', markdownItTexmath: 'texmath' });
  const resources = Object.freeze({
    styles: Object.freeze([
      Object.freeze({ id: 'katex-css', cdn: 'https://registry.npmmirror.com/katex/0.16.47/files/dist/katex.min.css', local: './vendor/katex.min.css' }),
      Object.freeze({ id: 'highlight-css', cdn: 'https://registry.npmmirror.com/@highlightjs/cdn-assets/11.11.1/files/styles/github.min.css', local: './vendor/highlight-github.min.css' }),
    ]),
    scripts: Object.freeze([
      Object.freeze({ id: 'dompurify', cdn: 'https://registry.npmmirror.com/dompurify/3.4.7/files/dist/purify.min.js', local: './vendor/purify.min.js', global: 'DOMPurify' }),
      Object.freeze({ id: 'markdown-it', cdn: 'https://registry.npmmirror.com/markdown-it/14.2.0/files/dist/markdown-it.min.js', local: './vendor/markdown-it.min.js', global: 'markdownit' }),
      Object.freeze({ id: 'markdown-it-texmath', cdn: 'https://registry.npmmirror.com/markdown-it-texmath/1.0.0/files/texmath.js', local: './vendor/markdown-it-plugins/markdown-it-texmath.min.js', global: 'markdownItTexmath' }),
      Object.freeze({ id: 'markdown-it-multimd-table', cdn: 'https://cdn.jsdelivr.net/npm/markdown-it-multimd-table@4.2.3/dist/markdown-it-multimd-table.min.js', local: './vendor/markdown-it-plugins/markdown-it-multimd-table.min.js', global: 'markdownitMultimdTable' }),
      Object.freeze({ id: 'markdown-it-task-lists', cdn: 'https://cdn.jsdelivr.net/npm/markdown-it-task-lists@2.1.1/dist/markdown-it-task-lists.min.js', local: './vendor/markdown-it-plugins/markdown-it-task-lists.min.js', global: 'markdownItTaskLists' }),
      Object.freeze({ id: 'markdown-it-emoji', cdn: 'https://registry.npmmirror.com/markdown-it-emoji/3.0.0/files/dist/markdown-it-emoji.min.js', local: './vendor/markdown-it-plugins/markdown-it-emoji.min.js', global: 'markdownitEmoji' }),
      Object.freeze({ id: 'markdown-it-footnote', cdn: 'https://registry.npmmirror.com/markdown-it-footnote/4.0.0/files/dist/markdown-it-footnote.min.js', local: './vendor/markdown-it-plugins/markdown-it-footnote.min.js', global: 'markdownitFootnote' }),
      Object.freeze({ id: 'markdown-it-deflist', cdn: 'https://registry.npmmirror.com/markdown-it-deflist/3.0.1/files/dist/markdown-it-deflist.min.js', local: './vendor/markdown-it-plugins/markdown-it-deflist.min.js', global: 'markdownitDeflist' }),
      Object.freeze({ id: 'markdown-it-abbr', cdn: 'https://registry.npmmirror.com/markdown-it-abbr/2.0.0/files/dist/markdown-it-abbr.min.js', local: './vendor/markdown-it-plugins/markdown-it-abbr.min.js', global: 'markdownitAbbr' }),
      Object.freeze({ id: 'markdown-it-mark', cdn: 'https://registry.npmmirror.com/markdown-it-mark/4.0.0/files/dist/markdown-it-mark.min.js', local: './vendor/markdown-it-plugins/markdown-it-mark.min.js', global: 'markdownitMark' }),
      Object.freeze({ id: 'markdown-it-sub', cdn: 'https://registry.npmmirror.com/markdown-it-sub/2.0.0/files/dist/markdown-it-sub.min.js', local: './vendor/markdown-it-plugins/markdown-it-sub.min.js', global: 'markdownitSub' }),
      Object.freeze({ id: 'markdown-it-sup', cdn: 'https://registry.npmmirror.com/markdown-it-sup/2.0.0/files/dist/markdown-it-sup.min.js', local: './vendor/markdown-it-plugins/markdown-it-sup.min.js', global: 'markdownitSup' }),
      Object.freeze({ id: 'highlight-js', cdn: 'https://registry.npmmirror.com/@highlightjs/cdn-assets/11.11.1/files/highlight.min.js', local: './vendor/highlight-common.min.js', global: 'hljs' }),
      Object.freeze({ id: 'katex', cdn: 'https://registry.npmmirror.com/katex/0.16.47/files/dist/katex.min.js', local: './vendor/katex.min.js', global: 'katex' }),
      Object.freeze({ id: 'mermaid', cdn: 'https://registry.npmmirror.com/mermaid/11.15.0/files/dist/mermaid.min.js', local: './vendor/mermaid.min.js', global: 'mermaid' }),
    ]),
  });

  function readGlobal(path, root = global) {
    const direct = String(path || '').split('.').filter(Boolean).reduce((target, key) => (target && target[key] ? target[key] : undefined), root);
    return direct !== undefined ? direct : (GLOBAL_ALIASES[path] ? readGlobal(GLOBAL_ALIASES[path], root) : undefined);
  }
  function hasGlobal(path, root = global) { return readGlobal(path, root) !== undefined; }
  function getReadiness(root = global) {
    const scripts = resources.scripts.reduce((result, resource) => { result[resource.id] = hasGlobal(resource.global, root); return result; }, {});
    return { version: VERSION, scripts, ready: Object.values(scripts).every(Boolean) };
  }

  function createBrowserLoader(root = global, doc = root.document) {
    const loadState = new Map();
    const appendNode = (node) => (node.tagName === 'LINK' ? doc.head : doc.body || doc.head).appendChild(node);
    const log = (level, message, detail) => { try { (root.console?.[level] || root.console?.log || (() => {})).call(root.console, message, detail || ''); } catch {} };
    function markExisting(resource) { const element = doc?.querySelector?.(`[data-markdown-dependency="${resource.id}"]`); if (element && !element.dataset.markdownDependencyLoaded) element.dataset.markdownDependencyLoaded = 'global'; }
    function loadOrder(resource) { const local = resource.local ? [{ url: resource.local, from: 'local' }] : []; const cdn = resource.cdn ? [{ url: resource.cdn, from: 'cdn' }] : []; const list = root.ChatUIMarkdownPreferCdn === true ? cdn.concat(local) : local.concat(cdn); return list.filter((item, index, all) => item.url && all.findIndex(candidate => candidate.url === item.url) === index); }
    function loadElement(resource, createNode) {
      if (!doc) return Promise.resolve({ id: resource.id, from: 'no-document' });
      if (resource.global && hasGlobal(resource.global, root)) { markExisting(resource); return Promise.resolve({ id: resource.id, from: 'global' }); }
      if (loadState.has(resource.id)) return loadState.get(resource.id);
      const promise = new Promise((resolve, reject) => {
        let node = null; let timer = null;
        const cleanup = () => { clearTimeout(timer); if (node) { node.onload = null; node.onerror = null; } };
        const attempts = loadOrder(resource);
        const attempt = (index = 0) => {
          const candidate = attempts[index];
          if (!candidate) { cleanup(); reject(new Error(`Failed to load markdown dependency: ${resource.id}`)); return; }
          cleanup(); node = createNode(candidate.url); node.dataset.markdownDependency = resource.id;
          node.onload = () => { cleanup(); const alias = GLOBAL_ALIASES[resource.global]; if (alias && !root[resource.global] && readGlobal(alias, root)) root[resource.global] = readGlobal(alias, root); node.dataset.markdownDependencyLoaded = candidate.from; log('info', `[markdown] dependency loaded: ${resource.id} (${candidate.from})`); resolve({ id: resource.id, from: candidate.from }); };
          node.onerror = () => { log('warn', `[markdown] dependency failed: ${resource.id} (${candidate.from})`, candidate.url); if (attempts[index + 1]) { attempt(index + 1); return; } cleanup(); reject(new Error(`Failed to load markdown dependency: ${resource.id}`)); };
          timer = setTimeout(() => node.onerror(), DEFAULT_TIMEOUT_MS); appendNode(node);
        };
        attempt(0);
      }).catch((err) => { loadState.delete(resource.id); throw err; });
      loadState.set(resource.id, promise); return promise;
    }
    const loadStyle = resource => loadElement(resource, href => { const link = doc.createElement('link'); link.rel = 'stylesheet'; link.href = href; return link; });
    const loadScript = resource => loadElement(resource, src => { const script = doc.createElement('script'); script.src = src; script.defer = false; return script; });
    const loadStyles = () => Promise.allSettled(resources.styles.map(loadStyle)).then(results => results.map(r => r.status === 'fulfilled' ? r.value : { error: r.reason?.message || String(r.reason) }));
    const loadScripts = (filter = () => true) => Promise.all(resources.scripts.filter(filter).map(resource => loadScript(resource).catch(err => { log('warn', `[markdown] optional dependency unavailable: ${resource.id}`, err); return { id: resource.id, error: err.message || String(err) }; })));
    const isCoreScript = resource => resource.id !== 'mermaid';
    const loadCore = () => Promise.all([loadStyles(), loadScripts(isCoreScript)]).then(([styles, scripts]) => ({ styles, scripts, readiness: getReadiness(root) }));
    const loadMermaid = () => loadScript(resources.scripts.find(resource => resource.id === 'mermaid')).catch(err => { log('warn', '[markdown] optional dependency unavailable: mermaid', err); return { id: 'mermaid', error: err.message || String(err) }; });
    const loadAll = loadCore;
    return { VERSION, DEFAULT_TIMEOUT_MS, LOCAL_FIRST, resources, getReadiness: () => getReadiness(root), loadStyles, loadScripts, loadCore, loadMermaid, loadAll };
  }

  const api = { VERSION, DEFAULT_TIMEOUT_MS, LOCAL_FIRST, resources, readGlobal, hasGlobal, getReadiness, createBrowserLoader };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  if (global?.document) global.ChatUIMarkdownDependencyLoader = Object.freeze(createBrowserLoader(global, global.document));
})(typeof window !== 'undefined' ? window : globalThis);
