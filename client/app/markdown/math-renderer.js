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

function looksLikeMath(raw = '') {
  const value = String(raw || '').trim();
  if (!value) return false;
  if (/\\(?:alpha|beta|gamma|delta|epsilon|theta|lambda|mu|pi|rho|sigma|sum|prod|int|frac|sqrt|left|right|begin|end|cdot|times|leq|geq|neq|approx|infty|partial|nabla|sin|cos|tan|log|ln|lim|mathbf|mathbb|mathrm|text)\b/.test(value)) return true;
  if (/[A-Za-z0-9_}\])]\s*(?:[+\-*/=<>^]|<=|>=|!=|\\leq|\\geq|\\neq)\s*[A-Za-z0-9_\\{(]/.test(value)) return true;
  if (/(?:[+\-*/=<>^]|<=|>=|!=)\s*\\?[A-Za-z0-9]/.test(value)) return true;
  return false;
}

function scanLatexBracketMath(markdown = '') {
  const src = String(markdown || '');
  const segments = [];
  let out = '';
  let i = 0;
  let lineStart = true;
  let inFence = false;
  let fenceChar = '';
  let fenceLen = 0;
  const tokenFor = (raw, displayMode) => {
    const token = `@@CHATUI_BRACKET_MATH_${segments.length}@@`;
    segments.push({ token, raw, displayMode });
    return token;
  };
  while (i < src.length) {
    if (lineStart) {
      const lineEnd = src.indexOf('\n', i);
      const line = src.slice(i, lineEnd === -1 ? src.length : lineEnd);
      const fence = line.match(/^\s{0,3}(`{3,}|~{3,})(.*)$/);
      if (fence) {
        const marker = fence[1];
        const rest = String(fence[2] || '').trim();
        if (inFence) {
          if (marker[0] === fenceChar && marker.length >= fenceLen && !rest) { inFence = false; fenceChar = ''; fenceLen = 0; }
        } else { inFence = true; fenceChar = marker[0]; fenceLen = marker.length; }
        const chunk = lineEnd === -1 ? line : `${line}\n`;
        out += chunk; i += chunk.length; lineStart = true; continue;
      }
    }
    if (inFence) { out += src[i]; lineStart = src[i] === '\n'; i += 1; continue; }

    if (src.startsWith('\\[', i)) {
      const end = src.indexOf('\\]', i + 2);
      if (end !== -1) {
        const raw = src.slice(i + 2, end);
        if (looksLikeMath(raw)) { out += tokenFor(raw, true); i = end + 2; lineStart = false; continue; }
      }
    }
    if (src.startsWith('\\(', i)) {
      const end = src.indexOf('\\)', i + 2);
      if (end !== -1) {
        const raw = src.slice(i + 2, end);
        if (looksLikeMath(raw)) { out += tokenFor(raw, false); i = end + 2; lineStart = false; continue; }
      }
    }
    out += src[i]; lineStart = src[i] === '\n'; i += 1;
  }
  return { text: out, segments };
}

function restoreMathSegments(html = '', segments = [], katexInstance = null) {
  return segments.reduce((result, item) => result.replaceAll(item.token, renderMath(item.raw, item.displayMode, katexInstance)), String(html || ''));
}

function createKatexOptions(options = {}) {
  return { throwOnError: false, strict: false, trust: false, output: 'htmlAndMathml', ...(options.katexOptions || {}) };
}

function applyMathPlugin(md, { loadOptional, katexOptions } = {}) {
  const loader = typeof loadOptional === 'function' ? loadOptional : (() => null);
  const katexPlugin = loader('markdown-it-katex', 'markdownItKatex') || loader('markdown-it-katex', 'markdownitKatex');
  const plugin = katexPlugin && (katexPlugin.default || katexPlugin.full || katexPlugin);
  if (!plugin) return false;
  try {
    md.use(plugin, createKatexOptions({ katexOptions }));
    return true;
  } catch (err) {
    console.warn('[markdown] math plugin failed: markdown-it-katex', err);
    return false;
  }
}

module.exports = { escapeHtml, renderMath, looksLikeMath, scanLatexBracketMath, restoreMathSegments, applyMathPlugin, createKatexOptions };
