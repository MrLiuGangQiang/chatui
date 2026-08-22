(function initChatUIRuntimeService(global) {
  'use strict';

  async function requestRuntimeIdentity(options = {}) {
    const fetchImpl = options.fetchImpl || global.fetch?.bind(global);
    if (!fetchImpl) throw new Error('当前环境不支持 fetch');
    const response = await fetchImpl('/api/version', { cache: 'no-store' });
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    const payload = await response.json();
    return Object.freeze({
      version: String(payload?.version || '').trim(),
      gitSha: String(payload?.gitSha || '').trim(),
      sourceRevision: String(payload?.sourceRevision || '').trim(),
    });
  }

  async function requestAppVersion(options = {}) {
    return (await requestRuntimeIdentity(options)).version;
  }

  const api = Object.freeze({ requestRuntimeIdentity, requestAppVersion });
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  if (global) global.ChatUIRuntimeService = api;
  if (global?.window) global.window.ChatUIRuntimeService = api;
})(typeof globalThis !== 'undefined' ? globalThis : (typeof window !== 'undefined' ? window : this));
