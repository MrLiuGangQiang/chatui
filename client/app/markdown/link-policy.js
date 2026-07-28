(function initChatUIMarkdownLinkPolicy(global) {
  'use strict';

  function isSafeMarkdownLink(url = '') {
    const href = String(url || '').trim();
    if (/^data:image\/(?:png|gif|jpe?g|webp|svg\+xml);base64,[a-z0-9+/=]+$/i.test(href)) return true;
    if (/^(?:javascript|vbscript|file)\s*:/i.test(href) || /^data\s*:\s*text\/html/i.test(href)) return false;
    return true;
  }

  const api = Object.freeze({ isSafeMarkdownLink });

  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  if (global) global.ChatUIMarkdownLinkPolicy = api;
})(typeof window !== 'undefined' ? window : globalThis);
