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
  return url.startsWith(baseUrl) ? `/api${url.slice(baseUrl.length)}` : url;
}

async function parseResponseJson(response) {
  const text = await response.text();
  try {
    return text ? JSON.parse(text) : null;
  } catch {
    return { raw: text };
  }
}

module.exports = { normalizeError, toProxyUrl, parseResponseJson };
