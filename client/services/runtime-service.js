(function initChatUIRuntimeService(global) {
  'use strict';

  async function requestAppVersion(options = {}) {
    const fetchImpl = options.fetchImpl || global.fetch?.bind(global);
    if (!fetchImpl) throw new Error('当前环境不支持 fetch');
    const response = await fetchImpl('/api/version', { cache: 'no-store' });
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    const payload = await response.json();
    const version = String(payload?.version || '').trim();
    const gitSha = String(payload?.gitSha || '').trim();
    if (!version || !gitSha || gitSha === 'unknown') return version;
    return `${version}+${gitSha.slice(0, 8)}${payload?.dirty ? '.dirty' : ''}`;
  }

  const api = Object.freeze({ requestAppVersion });
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  if (global) global.ChatUIRuntimeService = api;
  if (global?.window) global.window.ChatUIRuntimeService = api;
})(typeof globalThis !== 'undefined' ? globalThis : (typeof window !== 'undefined' ? window : this));
