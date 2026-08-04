(function initChatUIMarkdownSanitizerPolicy(global) {
  'use strict';

  const MATH_TAGS = Object.freeze(['math', 'mi', 'mn', 'mo', 'msup', 'msub', 'mrow', 'semantics', 'annotation']);
  const SAFE_HTML_TAGS = Object.freeze([
    'div', 'span', 'br', 'details', 'summary', 'kbd', 'sub', 'sup', 'mark', 'small', 'ins', 'del',
    'table', 'thead', 'tbody', 'tfoot', 'tr', 'th', 'td', 'caption', 'colgroup', 'col',
  ]);
  const SAFE_ATTRS = Object.freeze([
    'target', 'rel', 'class', 'id', 'data-copy-text', 'data-mermaid-rendered', 'aria-hidden', 'aria-label',
    'title', 'type', 'checked', 'disabled', 'for', 'href', 'src', 'alt', 'role', 'fill', 'viewBox', 'style', 'open',
  ]);
  const FORBID_TAGS = Object.freeze(['script', 'style', 'iframe', 'object', 'embed', 'base', 'meta', 'link', 'form', 'input', 'button', 'textarea', 'select', 'option']);
  const URI_ATTRS = new Set(['href', 'src', 'xlink:href']);
  const SAFE_URI_PATTERN = /^(?:(?:(?:https?|mailto|tel):)|[^a-z]|[a-z+.-]+(?:[^a-z+.-:]|$)|data:image\/(?:png|gif|jpeg|jpg|webp|avif);base64,)/i;
  const SAFE_STYLE_PROPERTIES = new Set([
    'border', 'border-color', 'border-style', 'border-width', 'border-radius',
    'border-top', 'border-top-color', 'border-top-style', 'border-top-width',
    'border-right', 'border-right-color', 'border-right-style', 'border-right-width',
    'border-bottom', 'border-bottom-color', 'border-bottom-style', 'border-bottom-width',
    'border-left', 'border-left-color', 'border-left-style', 'border-left-width',
    'padding', 'padding-top', 'padding-right', 'padding-bottom', 'padding-left',
    'margin', 'margin-top', 'margin-right', 'margin-bottom', 'margin-left',
    'color', 'background-color', 'text-align', 'font-weight', 'font-style', 'font-size', 'line-height',
    // KaTeX emits these layout-only inline styles for matrices, cases, aligned
    // equations, radicals and large operators.
    'height', 'top', 'vertical-align',
  ]);
  const UNSAFE_STYLE_VALUE = /url\s*\(|expression\s*\(|javascript\s*:|vbscript\s*:|data\s*:\s*text\/html|@import|-moz-binding/iu;

  function defaultIsSafeMarkdownLink(url = '') {
    const href = String(url || '').trim();
    if (!href) return true;
    if (/[\u0000-\u001f\u007f]/.test(href)) return false;
    const scheme = href.match(/^([a-z][a-z0-9+.-]*):/i);
    return !scheme || /^(?:https?|mailto|tel)$/i.test(scheme[1]);
  }

  function sanitizeStyleValue(style = '') {
    const safe = [];
    String(style || '').split(';').forEach((declaration) => {
      const colon = declaration.indexOf(':');
      if (colon === -1) return;
      const property = declaration.slice(0, colon).trim().toLowerCase();
      const value = declaration.slice(colon + 1).trim();
      if (!property || !value || property.startsWith('--')) return;
      if (!SAFE_STYLE_PROPERTIES.has(property) || UNSAFE_STYLE_VALUE.test(value)) return;
      safe.push(`${property}: ${value}`);
    });
    return safe.join('; ');
  }

  function domPurifyOptions() {
    return {
      ADD_TAGS: [...MATH_TAGS, ...SAFE_HTML_TAGS],
      ADD_ATTR: [...SAFE_ATTRS],
      ALLOW_DATA_ATTR: true,
      FORBID_TAGS: [...FORBID_TAGS],
      FORBID_ATTR: [/^on/i],
      ALLOWED_URI_REGEXP: SAFE_URI_PATTERN,
    };
  }

  function installSanitizerHooks(purify, isSafeMarkdownLink = defaultIsSafeMarkdownLink) {
    if (!purify || purify.__chatuiSanitizerHooks) return purify;
    purify.addHook?.('uponSanitizeAttribute', (_node, data) => {
      if (URI_ATTRS.has(String(data.attrName || '').toLowerCase()) && !isSafeMarkdownLink(data.attrValue)) {
        data.keepAttr = false;
        return;
      }
      if (data.attrName === 'style') {
        const safe = sanitizeStyleValue(data.attrValue);
        if (safe) data.attrValue = safe;
        else data.keepAttr = false;
      }
    });
    purify.__chatuiSanitizerHooks = true;
    return purify;
  }

  const api = Object.freeze({
    MATH_TAGS,
    SAFE_HTML_TAGS,
    SAFE_ATTRS,
    FORBID_TAGS,
    URI_ATTRS,
    SAFE_URI_PATTERN,
    SAFE_STYLE_PROPERTIES,
    UNSAFE_STYLE_VALUE,
    sanitizeStyleValue,
    domPurifyOptions,
    installSanitizerHooks,
  });
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  global?.[Symbol.for('chatui.module-registry.v1')]?.get('moduleRegistry')?.register('markdownSanitizerPolicy', api);
})(typeof window !== 'undefined' ? window : globalThis);
