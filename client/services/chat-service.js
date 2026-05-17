function extractChatJobText(data) {
  const message = data?.choices?.[0]?.message || {};
  return {
    content: message.content || data?.output_text || '',
    reasoning: message.reasoning_content || message.reasoning || data?.reasoning_content || data?.reasoning || '',
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

module.exports = { extractChatJobText, requestJson, parseSseLine };
