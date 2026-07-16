(function initChatUIRequestAuth(root) {
  'use strict';

  const STORAGE_KEY = 'openapi-chat-image-config-v2:managed-access-token';
  const PUBLIC_API_PATHS = new Set(['/api/version', '/api/config/public']);
  const nativeFetch = typeof root?.fetch === 'function' ? root.fetch.bind(root) : null;
  let accessToken = '';

  function readStoredToken() {
    try { return String(root?.sessionStorage?.getItem(STORAGE_KEY) || '').trim(); } catch { return ''; }
  }

  function setToken(value = '') {
    accessToken = String(value || '').trim();
    return accessToken;
  }

  function getToken() {
    return accessToken || setToken(readStoredToken());
  }

  function isProtectedSameOriginApi(input) {
    try {
      const url = new URL(typeof input === 'string' ? input : input?.url || '', root?.location?.origin || 'http://localhost');
      const origin = root?.location?.origin;
      return (!origin || url.origin === origin) && url.pathname.startsWith('/api/') && !PUBLIC_API_PATHS.has(url.pathname);
    } catch {
      return false;
    }
  }

  function withAuthorization(input, init = {}) {
    if (!isProtectedSameOriginApi(input)) return init;
    const token = getToken();
    if (!token) return init;
    const headers = new Headers(init.headers || (typeof input === 'object' ? input.headers : undefined) || {});
    if (!headers.has('Authorization')) headers.set('Authorization', `Bearer ${token}`);
    return { ...init, headers };
  }

  function installFetchInterceptor() {
    if (!nativeFetch || root.__chatuiRequestAuthInstalled) return;
    root.__chatuiRequestAuthInstalled = true;
    root.fetch = (input, init) => nativeFetch(input, withAuthorization(input, init));
  }

  const api = Object.freeze({ STORAGE_KEY, setToken, getToken, withAuthorization, isProtectedSameOriginApi, installFetchInterceptor });
  installFetchInterceptor();
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  if (root) root.ChatUIRequestAuth = api;
})(typeof globalThis !== 'undefined' ? globalThis : (typeof window !== 'undefined' ? window : this));
