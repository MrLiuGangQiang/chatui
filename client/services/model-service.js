(function initChatUIModelService(root) {
  'use strict';

async function requestModels({ fetchImpl = fetch, baseUrl, apiKey = '', parseResponseJson, normalizeError }) {
  if (!baseUrl) throw new Error('请先配置 Endpoint Base URL');
  let response;
  try {
    response = await fetchImpl('/api/models', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ baseUrl, apiKey, query: {}, payload: {}, method: 'GET' }),
    });
  } catch (err) {
    throw new Error(`连接接口失败：${err?.message || '网络请求失败'}`);
  }
  const payload = await parseResponseJson(response);
  if (!response.ok) throw new Error(normalizeError(null, payload));
  return payload;
}

const api = Object.freeze({ requestModels });

if (typeof module !== 'undefined' && module.exports) module.exports = api;
if (root) root.ChatUIModelService = api;
if (root?.window) root.window.ChatUIModelService = api;
})(typeof globalThis !== 'undefined' ? globalThis : (typeof window !== 'undefined' ? window : this));
