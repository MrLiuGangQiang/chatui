'use strict';

function escapeHtml(value = '') {
  return String(value).replace(/[&<>"'`]/g, ch => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;', '`': '&#96;' }[ch]));
}

function renderMath(raw = '', displayMode = false, katexInstance = null) {
  const source = String(raw || '');
  const katex = katexInstance || (typeof globalThis !== 'undefined' ? globalThis.katex : null);
  try {
    if (!katex?.renderToString) throw new Error('KaTeX unavailable');
    return katex.renderToString(source, { displayMode: !!displayMode, throwOnError: false, strict: false, trust: false, output: 'htmlAndMathml' });
  } catch (err) {
    const text = displayMode ? `$$${source}$$` : `$${source}$`;
    const tag = displayMode ? 'div' : 'span';
    return `<${tag} class="math-fallback" title="数学公式渲染降级">${escapeHtml(text)}</${tag}>`;
  }
}

function createKatexOptions(options = {}) {
  return { throwOnError: false, strict: false, trust: false, output: 'htmlAndMathml', ...(options.katexOptions || {}) };
}

function applyMathPlugin(md, { loadOptional, katexOptions } = {}) {
  const loader = typeof loadOptional === 'function' ? loadOptional : (() => null);
  const texmathPlugin = loader('markdown-it-texmath', 'markdownItTexmath') || loader('markdown-it-texmath', 'texmath');
  const plugin = texmathPlugin && (texmathPlugin.default || texmathPlugin.full || texmathPlugin);
  if (!plugin) return false;
  try {
    const katex = loader('katex', 'katex');
    md.use(plugin, { engine: katex, delimiters: ['dollars', 'brackets', 'beg_end'], katexOptions: createKatexOptions({ katexOptions }) });
    return true;
  } catch (err) {
    console.warn('[markdown] math plugin failed: markdown-it-texmath', err);
    return false;
  }
}

module.exports = { escapeHtml, renderMath, applyMathPlugin, createKatexOptions };
