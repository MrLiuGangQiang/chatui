const MATH_TAGS = ['math', 'mi', 'mn', 'mo', 'msup', 'msub', 'mrow', 'semantics', 'annotation'];
const SAFE_HTML_TAGS = [
  'div', 'span', 'br', 'details', 'summary', 'kbd', 'sub', 'sup', 'mark', 'small', 'ins', 'del',
  'table', 'thead', 'tbody', 'tfoot', 'tr', 'th', 'td', 'caption', 'colgroup', 'col',
];
const SAFE_ATTRS = [
  'target', 'rel', 'class', 'id', 'data-copy-text', 'data-mermaid-rendered', 'aria-hidden', 'aria-label',
  'title', 'type', 'checked', 'disabled', 'for', 'href', 'src', 'alt', 'role', 'fill', 'viewBox', 'style', 'open',
];
const FORBID_TAGS = ['script', 'style', 'iframe', 'object', 'embed', 'base', 'meta', 'link', 'form', 'button', 'textarea', 'select', 'option'];
const DISPLAY_FORBID_TAGS = ['script', 'style', 'iframe', 'object', 'embed', 'base', 'meta', 'link', 'form', 'input', 'textarea', 'select', 'option'];
const SAFE_URI_PATTERN = /^(?:(?:(?:https?|mailto|tel|blob):)|[^a-z]|[a-z+.-]+(?:[^a-z+.-:]|$)|data:image\/(?:png|gif|jpeg|jpg|webp);base64,)/i;
const { shouldKeepSanitizedUrl } = require('./link-policy');
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
  // equations, radicals and large operators. Without them the sanitized HTML
  // collapses vertically and formulas are visually clipped.
  'height', 'top', 'vertical-align',
]);
const UNSAFE_STYLE_VALUE = /url\s*\(|expression\s*\(|javascript\s*:|vbscript\s*:|data\s*:\s*text\/html|@import|-moz-binding/iu;

function sanitizeStyleValue(style = '') {
  const declarations = String(style || '').split(';');
  const safe = [];
  for (const declaration of declarations) {
    const colon = declaration.indexOf(':');
    if (colon === -1) continue;
    const property = declaration.slice(0, colon).trim().toLowerCase();
    const value = declaration.slice(colon + 1).trim();
    if (!property || !value || property.startsWith('--')) continue;
    if (!SAFE_STYLE_PROPERTIES.has(property)) continue;
    if (UNSAFE_STYLE_VALUE.test(value)) continue;
    safe.push(`${property}: ${value}`);
  }
  return safe.join('; ');
}

function domPurifyOptions() {
  return {
    ADD_TAGS: [...MATH_TAGS, ...SAFE_HTML_TAGS],
    ADD_ATTR: SAFE_ATTRS,
    ALLOW_DATA_ATTR: true,
    FORBID_TAGS,
    FORBID_ATTR: [/^on/i],
    ALLOWED_URI_REGEXP: SAFE_URI_PATTERN,
  };
}

function displayDomPurifyOptions() {
  return {
    ADD_ATTR: SAFE_ATTRS,
    ALLOW_DATA_ATTR: true,
    FORBID_TAGS: DISPLAY_FORBID_TAGS,
    FORBID_ATTR: [/^on/i, 'srcdoc'],
    ALLOWED_URI_REGEXP: SAFE_URI_PATTERN,
  };
}

function sanitizeAttribute(node, data) {
  if (data.attrName === 'style') {
    const safe = sanitizeStyleValue(data.attrValue);
    if (safe) data.attrValue = safe;
    else data.keepAttr = false;
    return;
  }
  if (!shouldKeepSanitizedUrl(node, data.attrName, data.attrValue)) data.keepAttr = false;
}

function createSanitizer(optionsFactory = domPurifyOptions) {
  if (typeof window !== 'undefined' && window.DOMPurify) {
    if (!window.DOMPurify.__chatuiSanitizeAttributeHook) {
      window.DOMPurify.addHook?.('uponSanitizeAttribute', sanitizeAttribute);
      window.DOMPurify.__chatuiSanitizeAttributeHook = true;
    }
    return html => window.DOMPurify.sanitize(String(html || ''), optionsFactory());
  }

  try {
    const { JSDOM } = require('jsdom');
    const createDOMPurify = require('dompurify');
    const purify = createDOMPurify(new JSDOM('').window);
    purify.addHook('uponSanitizeAttribute', sanitizeAttribute);
    return html => purify.sanitize(String(html || ''), optionsFactory());
  } catch (err) {
    throw new Error(`DOMPurify sanitizer unavailable: ${err && err.message || err}`);
  }
}

const sanitizeHtml = createSanitizer();
const sanitizeDisplayHtml = createSanitizer(displayDomPurifyOptions);
module.exports = { MATH_TAGS, SAFE_HTML_TAGS, SAFE_ATTRS, FORBID_TAGS, DISPLAY_FORBID_TAGS, SAFE_STYLE_PROPERTIES, sanitizeStyleValue, sanitizeAttribute, domPurifyOptions, displayDomPurifyOptions, createSanitizer, sanitizeHtml, sanitizeDisplayHtml };
