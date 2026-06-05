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

  function renderMarkdownPlainTextFallback(value, { escapeHtml = String } = {}) {
    const text = escapeHtml(String(value || ''));
    return `<p>${text.replace(/\n/g, '<br>')}</p>`;
  }

  const markdownUtilsApi = Object.freeze({
    slugifyHeading,
    renderMarkdownPlainTextFallback,
  });

  if (typeof module !== 'undefined' && module.exports) module.exports = markdownUtilsApi;
  if (root) root.ChatUIAppMarkdownUtils = markdownUtilsApi;
  if (root?.window) root.window.ChatUIAppMarkdownUtils = markdownUtilsApi;
})(typeof globalThis !== 'undefined' ? globalThis : (typeof window !== 'undefined' ? window : this));
