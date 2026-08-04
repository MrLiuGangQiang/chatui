'use strict';

const policy = require('./sanitizer-policy');
const { isSafeMarkdownLink } = require('./link-policy');

function createSanitizer() {
  if (typeof window !== 'undefined' && window.DOMPurify) {
    policy.installSanitizerHooks(window.DOMPurify, isSafeMarkdownLink);
    return html => window.DOMPurify.sanitize(String(html || ''), policy.domPurifyOptions());
  }

  try {
    const { JSDOM } = require('jsdom');
    const createDOMPurify = require('dompurify');
    const purify = createDOMPurify(new JSDOM('').window);
    policy.installSanitizerHooks(purify, isSafeMarkdownLink);
    return html => purify.sanitize(String(html || ''), policy.domPurifyOptions());
  } catch (err) {
    throw new Error(`DOMPurify sanitizer unavailable: ${err && err.message || err}`);
  }
}

const sanitizeHtml = createSanitizer();
module.exports = {
  MATH_TAGS: policy.MATH_TAGS,
  SAFE_HTML_TAGS: policy.SAFE_HTML_TAGS,
  SAFE_ATTRS: policy.SAFE_ATTRS,
  FORBID_TAGS: policy.FORBID_TAGS,
  SAFE_STYLE_PROPERTIES: policy.SAFE_STYLE_PROPERTIES,
  sanitizeStyleValue: policy.sanitizeStyleValue,
  domPurifyOptions: policy.domPurifyOptions,
  createSanitizer,
  sanitizeHtml,
};
