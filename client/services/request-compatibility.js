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

  function structuredOutputFormat(payload = {}) {
    if (!payload || typeof payload !== 'object' || Array.isArray(payload)) return null;
    if (payload.text?.format && typeof payload.text.format === 'object') {
      return { transport: 'responses', format: payload.text.format };
    }
    if (payload.response_format && typeof payload.response_format === 'object') {
      return { transport: 'chat', format: payload.response_format };
    }
    return null;
  }

  function schemaFromFormat(format = null) {
    if (!format || typeof format !== 'object') return null;
    if (format.type !== 'json_schema') return null;
    return format.json_schema?.schema || format.schema || null;
  }

  function withStructuredOutputFormat(payload = {}, descriptor = null, format = null) {
    if (!descriptor?.transport || !format) return { ...payload };
    if (descriptor.transport === 'responses') {
      return { ...payload, text: { ...(payload.text || {}), format } };
    }
    return { ...payload, response_format: format };
  }

  function withoutStructuredOutputFormat(payload = {}, descriptor = null) {
    if (descriptor?.transport === 'responses') {
      const next = { ...payload };
      const text = { ...(next.text || {}) };
      delete text.format;
      if (Object.keys(text).length) next.text = text;
      else delete next.text;
      return next;
    }
    const next = { ...payload };
    delete next.response_format;
    return next;
  }

  function fallbackFormatInstruction(responseFormat = null) {
    const schema = schemaFromFormat(responseFormat);
    if (!schema || typeof schema !== 'object') return '只返回一个严格 json 对象，不要输出 Markdown、代码围栏或解释。';
    return `当前接口不支持结构化输出参数。仍须只返回符合以下 JSON Schema 的 json 对象，不要输出 Markdown、代码围栏或解释：${JSON.stringify(schema)}`;
  }

  function appendFallbackFormatInstruction(payload = {}, responseFormat = null) {
    const instruction = fallbackFormatInstruction(responseFormat);
    if (Array.isArray(payload.messages)) {
      const messages = payload.messages.map(message => ({ ...message }));
      messages.push({ role: 'system', content: instruction });
      return { ...payload, messages };
    }
    if (Array.isArray(payload.input)) {
      const input = payload.input.map(message => ({ ...message }));
      input.push({ role: 'system', content: instruction });
      return { ...payload, input };
    }
    return { ...payload };
  }

  function fallbackPayloads(payload = {}) {
    const descriptor = structuredOutputFormat(payload);
    if (!descriptor) return [];
    const responseFormat = descriptor.format;
    const compatible = appendFallbackFormatInstruction(payload, responseFormat);
    const payloads = [];
    if (responseFormat?.type !== 'json_object') {
      payloads.push(withStructuredOutputFormat(compatible, descriptor, { type: 'json_object' }));
    }
    payloads.push(withoutStructuredOutputFormat(compatible, descriptor));
    return payloads;
  }


  function errorStatusCode(error) {
    const candidates = [
      error?.statusCode,
      error?.status,
      error?.error?.statusCode,
      error?.error?.status,
    ];
    for (const candidate of candidates) {
      const status = Number(candidate);
      if (Number.isFinite(status) && status > 0) return status;
    }
    return 0;
  }

  // A small number of OpenAI-compatible gateways accept an explicitly
  // non-streaming Responses request, then fail internally while attempting to
  // assemble the one-shot response. This classifier is deliberately narrow:
  // an arbitrary 5xx, timeout, or a streaming failure must not switch the
  // transport.
  function isNonStreamingResponsesEmptyStreamChunks(error) {
    if (errorStatusCode(error) !== 500) return false;
    const message = String(error?.message || error?.error?.message || '');
    return /\bempty\s+stream\s+chunks\b/i.test(message);
  }

  function chatCompletionsResponseFormatFromResponsesTextFormat(format = null) {
    if (!format || typeof format !== 'object' || Array.isArray(format)) return null;
    if (format.type === 'json_object') return { type: 'json_object' };
    if (format.type !== 'json_schema') return null;

    const jsonSchema = {};
    for (const field of ['name', 'strict', 'schema']) {
      if (Object.prototype.hasOwnProperty.call(format, field)) jsonSchema[field] = format[field];
    }
    if (!jsonSchema.name || !jsonSchema.schema || typeof jsonSchema.schema !== 'object') return null;
    return { type: 'json_schema', json_schema: jsonSchema };
  }

  // The intent/image-plan payloads use only role+string-content input messages.
  // Convert that well-defined subset instead of carrying Responses-only fields
  // into Chat Completions, so the fallback remains compatible with strict
  // gateways. Return null for an unsupported Responses payload; callers then
  // retain the original error rather than issuing a malformed retry.
  function chatCompletionsPayloadFromResponsesPayload(payload = {}) {
    if (!payload || typeof payload !== 'object' || Array.isArray(payload)
        || payload.stream !== false || !Array.isArray(payload.input)) return null;
    const messages = [];
    for (const item of payload.input) {
      if (!item || typeof item !== 'object' || Array.isArray(item)) return null;
      const role = String(item.role || '').trim();
      if (!role || !Object.prototype.hasOwnProperty.call(item, 'content')) return null;
      messages.push({ role, content: item.content });
    }

    const next = {};
    // Preserve only fields that are shared by the non-streaming Chat
    // Completions request used for routing. In particular, do not leak
    // Responses-only input/text/reasoning parameters into the fallback.
    for (const field of [
      'model', 'stream', 'temperature', 'top_p', 'max_tokens',
      'max_completion_tokens', 'n', 'stop', 'presence_penalty',
      'frequency_penalty', 'seed', 'logprobs', 'top_logprobs', 'user',
    ]) {
      if (Object.prototype.hasOwnProperty.call(payload, field)) next[field] = payload[field];
    }
    next.messages = messages;
    const responseFormat = chatCompletionsResponseFormatFromResponsesTextFormat(payload.text?.format);
    if (responseFormat) next.response_format = responseFormat;
    return next;
  }

  function reasoningParamUnsupported(error) {
    const code = String(error?.code || error?.error?.code || '').toLowerCase();
    const message = String(error?.message || error?.error?.message || error || '').toLowerCase();
    const text = `${code} ${message}`;
    if (!/reasoning/.test(text)) return false;
    return /unsupported|not\s+support(?:ed)?|unknown|unrecognized|invalid|not\s+permitted|not\s+allowed|extra\s+input|unexpected|reject(?:ed|s)?/.test(text);
  }

  async function requestJsonWithReasoningParamFallback(request, payload) {
    if (typeof request !== 'function') throw new TypeError('requestJsonWithReasoningParamFallback requires a request function');
    if (!payload?.reasoning_effort && !payload?.reasoning) return request(payload);
    try {
      return await request(payload);
    } catch (error) {
      if (!reasoningParamUnsupported(error)) throw error;
      const compatible = { ...payload };
      delete compatible.reasoning_effort;
      delete compatible.reasoning;
      return request(compatible);
    }
  }

  function toolChoiceParamUnsupported(error) {
    const code = String(error?.code || error?.error?.code || '').toLowerCase();
    const message = String(error?.message || error?.error?.message || error || '').toLowerCase();
    const text = `${code} ${message}`;
    if (!/tool[_\s-]?choice|tools?/.test(text)) return false;
    return /unsupported|not\s+support(?:ed)?|unknown|unrecognized|invalid|not\s+permitted|not\s+allowed|extra\s+input|unexpected|reject(?:ed|s)?/.test(text);
  }

  async function requestJsonWithToolChoiceParamFallback(request, payload) {
    if (typeof request !== 'function') throw new TypeError('requestJsonWithToolChoiceParamFallback requires a request function');
    if (!Object.prototype.hasOwnProperty.call(payload || {}, 'tool_choice')) return request(payload);
    try {
      return await request(payload);
    } catch (error) {
      if (!toolChoiceParamUnsupported(error)) throw error;
      const compatible = { ...payload };
      delete compatible.tool_choice;
      return request(compatible);
    }
  }

  async function requestJsonWithStructuredOutputFallback(request, payload) {
    if (typeof request !== 'function') throw new TypeError('requestJsonWithStructuredOutputFallback requires a request function');
    try {
      return await request(payload);
    } catch (error) {
      if (!structuredOutputFormat(payload) || !structuredOutputUnsupported(error)) throw error;
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
    structuredOutputFormat,
    schemaFromFormat,
    withStructuredOutputFormat,
    withoutStructuredOutputFormat,
    reasoningParamUnsupported,
    toolChoiceParamUnsupported,
    errorStatusCode,
    isNonStreamingResponsesEmptyStreamChunks,
    chatCompletionsResponseFormatFromResponsesTextFormat,
    chatCompletionsPayloadFromResponsesPayload,
    fallbackFormatInstruction,
    appendFallbackFormatInstruction,
    fallbackPayloads,
    requestJsonWithStructuredOutputFallback,
    requestJsonWithReasoningParamFallback,
    requestJsonWithToolChoiceParamFallback,
  });
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  root?.[Symbol.for('chatui.module-registry.v1')]?.get('moduleRegistry')?.register('requestCompatibility', api);
})(typeof globalThis !== 'undefined' ? globalThis : this);
