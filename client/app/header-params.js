(function initChatUIAppHeaderParams(root) {
  'use strict';

  const HEADER_PARAM_MODES = new Set(['manual', 'session_short_uuid', 'message_short_uuid']);

  function normalizeHeaderParamConfig(params = []) {
    return (Array.isArray(params) ? params : [])
      .map(param => ({
        name: String(param?.name || '').trim(),
        mode: HEADER_PARAM_MODES.has(param?.mode) ? param.mode : 'manual',
        value: String(param?.value || ''),
      }))
      .filter(param => param.name);
  }

  function generateShortUuid(randomBytes = null, now = Date.now, random = Math.random) {
    if (randomBytes) {
      const bytes = randomBytes(8);
      if (bytes && typeof bytes[Symbol.iterator] === 'function') {
        return [...bytes].map(byte => Number(byte).toString(16).padStart(2, '0')).join('').slice(0, 12);
      }
    }
    return `${now().toString(36)}${random().toString(36).slice(2, 8)}`.slice(0, 12);
  }

  function buildRequestHeadersFromParams({ params = [], sessionValues = {}, messageUuid = () => '', sessionUuid = () => '' } = {}) {
    const headers = {};
    let changed = false;
    for (const param of normalizeHeaderParamConfig(params)) {
      let value = '';
      if (param.mode === 'manual') value = param.value;
      else if (param.mode === 'session_short_uuid') {
        if (!sessionValues[param.name]) {
          sessionValues[param.name] = sessionUuid();
          changed = true;
        }
        value = sessionValues[param.name];
      } else if (param.mode === 'message_short_uuid') value = messageUuid();
      if (param.name && value) headers[param.name] = value;
    }
    return { headers, changed, sessionValues };
  }

  const api = Object.freeze({ normalizeHeaderParamConfig, generateShortUuid, buildRequestHeadersFromParams });

  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  if (root) root.ChatUIAppHeaderParams = api;
  if (root?.window) root.window.ChatUIAppHeaderParams = api;
})(typeof globalThis !== 'undefined' ? globalThis : (typeof window !== 'undefined' ? window : this));
