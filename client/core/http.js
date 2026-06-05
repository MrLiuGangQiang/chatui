(function initChatUICoreHttp(root) {
  'use strict';

  function normalizeError(error, payload) {
    return payload?.error?.message
      ? payload.error.message
      : payload?.error?.code
        ? payload.error.code
        : payload?.message
          ? payload.message
          : payload?.raw
            ? payload.raw
            : error?.message || '请求失败';
  }

  function toProxyUrl(url, baseUrl) {
    return String(url || '').startsWith(baseUrl) ? `/api${String(url || '').slice(String(baseUrl).length)}` : url;
  }

  async function parseResponseJson(response) {
    const text = await response.text();
    try {
      return text ? JSON.parse(text) : null;
    } catch {
      return { raw: text };
    }
  }

  const api = Object.freeze({ normalizeError, toProxyUrl, parseResponseJson });

  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  if (root) root.ChatUICoreHttp = api;
  if (root?.window) root.window.ChatUICoreHttp = api;
})(typeof globalThis !== 'undefined' ? globalThis : (typeof window !== 'undefined' ? window : this));
