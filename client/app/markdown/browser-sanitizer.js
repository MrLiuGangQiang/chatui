(function initChatUIMarkdownSanitizer(global) {
  'use strict';

  const policy = global?.[Symbol.for('chatui.module-registry.v1')]?.get('markdownSanitizerPolicy') || {};
  const isSafeMarkdownLink = global.ChatUIMarkdownLinkPolicy?.isSafeMarkdownLink || ((url = '') => {
    const href = String(url || '').trim();
    if (!href) return true;
    if (/[\u0000-\u001f\u007f]/.test(href)) return false;
    const scheme = href.match(/^([a-z][a-z0-9+.-]*):/i);
    return !scheme || /^(?:https?|mailto|tel)$/i.test(scheme[1]);
  });

  function sanitizeHtml(html = '') {
    if (!global.DOMPurify?.sanitize) throw new Error('DOMPurify sanitizer unavailable');
    policy.installSanitizerHooks?.(global.DOMPurify, isSafeMarkdownLink);
    return global.DOMPurify.sanitize(String(html || ''), policy.domPurifyOptions());
  }

  const api = Object.freeze({
    MATH_TAGS: policy.MATH_TAGS,
    SAFE_HTML_TAGS: policy.SAFE_HTML_TAGS,
    SAFE_ATTRS: policy.SAFE_ATTRS,
    FORBID_TAGS: policy.FORBID_TAGS,
    SAFE_STYLE_PROPERTIES: policy.SAFE_STYLE_PROPERTIES,
    sanitizeStyleValue: policy.sanitizeStyleValue,
    domPurifyOptions: policy.domPurifyOptions,
    sanitizeHtml,
  });
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  if (global) global.ChatUIMarkdownSanitizer = api;
})(typeof window !== 'undefined' ? window : globalThis);
