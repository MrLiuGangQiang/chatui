(function initChatUIMarkdownLinkPolicy(global) {
  'use strict';

  const SAFE_ABSOLUTE_SCHEMES = new Set(['http', 'https', 'mailto', 'tel']);
  const SAFE_IMAGE_DATA_URL = /^data:image\/(?:png|gif|jpe?g|webp|avif);base64,[a-z0-9+/]+={0,2}$/i;

  function isSafeMarkdownLink(url = '') {
    const href = String(url || '').trim();
    if (!href) return true;
    if (/[\u0000-\u001f\u007f]/.test(href)) return false;
    if (SAFE_IMAGE_DATA_URL.test(href)) return true;
    const scheme = href.match(/^([a-z][a-z0-9+.-]*):/i);
    if (!scheme) return true;
    return SAFE_ABSOLUTE_SCHEMES.has(scheme[1].toLowerCase());
  }

  const api = Object.freeze({ isSafeMarkdownLink });

  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  if (global) global.ChatUIMarkdownLinkPolicy = api;
})(typeof window !== 'undefined' ? window : globalThis);
