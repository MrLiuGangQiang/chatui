(function initChatUIRequestCompatibility(root) {
  'use strict';

  function structuredOutputUnsupported(error) {
    const code = String(error?.code || error?.error?.code || '').toLowerCase();
    const message = String(error?.message || error?.error?.message || error || '').toLowerCase();
    const text = `${code} ${message}`;
    const structuredOutputContext = /response[_\s-]?format|json[_\s-]?schema|structured[\s_-]?output|text\.format/.test(text);
    if (!structuredOutputContext) return false;
    const capabilityRejection = /unsupported|not\s+support(?:ed)?|unknown|unavailable|invalid\s+parameter|unrecognized/.test(text);
    const schemaRejection = /invalid[_\s-]?json[_\s-]?schema|invalid\s+schema|not\s+permitted|not\s+allowed/.test(text);
    const inputJsonRequirement = /must\s+contain(?:s)?\s+the\s+word\s+['\"]?json['\"]?/.test(text);
    return capabilityRejection || schemaRejection || inputJsonRequirement;
  }

  function fallbackFormatInstruction(responseFormat = null) {
    const schema = responseFormat?.json_schema?.schema;
    if (!schema || typeof schema !== 'object') return '只返回一个严格 json 对象，不要输出 Markdown、代码围栏或解释。';
    return `当前接口不支持结构化输出参数。仍须只返回符合以下 JSON Schema 的 json 对象，不要输出 Markdown、代码围栏或解释：${JSON.stringify(schema)}`;
  }

  function appendFallbackFormatInstruction(payload = {}, responseFormat = null) {
    const instruction = fallbackFormatInstruction(responseFormat);
    const messages = Array.isArray(payload.messages) ? payload.messages.map(message => ({ ...message })) : [];
    messages.push({ role: 'system', content: instruction });
    return { ...payload, messages };
  }

  function fallbackPayloads(payload = {}) {
    if (!payload?.response_format) return [];
    const responseFormat = payload.response_format;
    const compatible = appendFallbackFormatInstruction(payload, responseFormat);
    const payloads = [];
    if (responseFormat?.type !== 'json_object') {
      payloads.push({ ...compatible, response_format: { type: 'json_object' } });
    }
    const plainJsonPayload = { ...compatible };
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
    fallbackFormatInstruction,
    appendFallbackFormatInstruction,
    fallbackPayloads,
    requestJsonWithStructuredOutputFallback,
  });
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  root?.[Symbol.for('chatui.module-registry.v1')]?.get('moduleRegistry')?.register('requestCompatibility', api);
})(typeof globalThis !== 'undefined' ? globalThis : this);
