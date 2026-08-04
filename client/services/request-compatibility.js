(function initChatUIRequestCompatibility(root) {
  'use strict';

  function structuredOutputUnsupported(error) {
    const text = String(error?.message || error || '').toLowerCase();
    return /response_format|json_schema|structured.?output/.test(text)
      && /unsupported|not support|unknown|invalid parameter|unrecognized/.test(text);
  }

  function fallbackPayloads(payload = {}) {
    if (!payload?.response_format) return [];
    const payloads = [];
    if (payload.response_format?.type !== 'json_object') {
      payloads.push({ ...payload, response_format: { type: 'json_object' } });
    }
    const plainJsonPayload = { ...payload };
    delete plainJsonPayload.response_format;
    payloads.push(plainJsonPayload);
    return payloads;
  }

  async function requestJsonWithStructuredOutputFallback(request, payload) {
    if (typeof request !== 'function') throw new TypeError('requestJsonWithStructuredOutputFallback requires a request function');
    try {
      return await request(payload);
    } catch (error) {
      if (!payload?.response_format || !structuredOutputUnsupported(error)) throw error;
      let lastError = error;
      for (const fallbackPayload of fallbackPayloads(payload)) {
        try {
          return await request(fallbackPayload);
        } catch (fallbackError) {
          if (!structuredOutputUnsupported(fallbackError)) throw fallbackError;
          lastError = fallbackError;
        }
      }
      throw lastError;
    }
  }

  const api = Object.freeze({
    structuredOutputUnsupported,
    fallbackPayloads,
    requestJsonWithStructuredOutputFallback,
  });
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  root?.[Symbol.for('chatui.module-registry.v1')]?.get('moduleRegistry')?.register('requestCompatibility', api);
})(typeof globalThis !== 'undefined' ? globalThis : this);
