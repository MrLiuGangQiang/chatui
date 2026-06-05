(function initChatUIChatService(root) {
  'use strict';

function normalizeText(value) {
  if (!value) return '';
  if (typeof value === 'string') return value;
  if (Array.isArray(value)) return value.map(item => normalizeText(item?.text || item?.content || item?.output_text || item?.message || item?.delta || item)).filter(Boolean).join('');
  if (typeof value === 'object') {
    const output = Array.isArray(value.output)
      ? value.output.filter(item => !/reason/i.test(String(item?.type || item?.role || '')))
      : '';
    return normalizeText(value.text || value.content || value.output_text || value.message || value.delta || value.response || output || '');
  }
  return String(value || '');
}

function extractChatJobText(data) {
  const message = data?.choices?.[0]?.message || {};
  return {
    content: normalizeText(message.content || message.text || message.output_text || data?.output_text || data?.content || data?.text || data?.message || data?.response || data?.output || ''),
    reasoning: message.reasoning_content || message.reasoning || data?.reasoning_content || data?.reasoning || '',
    firstTokenMs: Number.isFinite(data?.metrics?.firstTokenMs) ? data.metrics.firstTokenMs : null,
  };
}

async function requestJson({ fetchImpl = fetch, url, payload, apiKey = '', directMode = false, baseUrl = '', method = 'POST', headers = {}, signal, toProxyUrl, parseResponseJson, normalizeError }) {
  const targetUrl = directMode ? url : toProxyUrl(url, baseUrl);
  const body = directMode ? payload : { baseUrl, apiKey, payload, method, headers };
  let response;
  try {
    response = await fetchImpl(targetUrl, {
      method,
      signal,
      headers: {
        'Content-Type': 'application/json',
        ...(directMode ? headers : {}),
        ...(directMode && apiKey ? { Authorization: `Bearer ${apiKey}` } : {}),
      },
      ...(method === 'GET' ? {} : { body: JSON.stringify(body) }),
    });
  } catch (err) {
    throw new Error(`连接接口失败：${err?.message || '网络请求失败'}`);
  }
  const parsed = await parseResponseJson(response);
  if (!response.ok) throw new Error(normalizeError(null, parsed));
  return parsed;
}

function parseSseLine(line, extractStreamDelta) {
  const trimmed = String(line || '').trim();
  if (!trimmed || trimmed.startsWith(':') || !trimmed.startsWith('data:')) return null;
  const data = trimmed.slice(5).trim();
  if (data === '[DONE]') return { done: true };
  const delta = extractStreamDelta(JSON.parse(data));
  return { done: false, delta };
}

const api = Object.freeze({ extractChatJobText, requestJson, parseSseLine });

if (typeof module !== 'undefined' && module.exports) module.exports = api;
if (root) root.ChatUIChatService = api;
if (root?.window) root.window.ChatUIChatService = api;
})(typeof globalThis !== 'undefined' ? globalThis : (typeof window !== 'undefined' ? window : this));
