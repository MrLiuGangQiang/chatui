(function initChatUIAppMarkdownUtils(root) {
  'use strict';

  function slugifyHeading(value = '') {
    return String(value || '')
      .trim()
      .toLowerCase()
      .replace(/[`~!@#$%^&*()+=[\]{};:'",.<>/?\\|]/g, '')
      .replace(/\s+/g, '-')
      .replace(/-+/g, '-');
  }

  const markdownUtilsApi = Object.freeze({
    slugifyHeading,
  });

  if (typeof module !== 'undefined' && module.exports) module.exports = markdownUtilsApi;
  if (root) root.ChatUIAppMarkdownUtils = markdownUtilsApi;
  if (root?.window) root.window.ChatUIAppMarkdownUtils = markdownUtilsApi;
})(typeof globalThis !== 'undefined' ? globalThis : (typeof window !== 'undefined' ? window : this));
