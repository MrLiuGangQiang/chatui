(function initChatUIResponsesOutput(root, factory) {
  'use strict';

  const api = factory();
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  const registry = root?.[Symbol.for('chatui.module-registry.v1')]?.get('moduleRegistry');
  if (registry?.register) registry.register('responsesOutput', api);
})(typeof globalThis !== 'undefined' ? globalThis : (typeof window !== 'undefined' ? window : this), function createChatUIResponsesOutput() {
  'use strict';

  // Extract only final textual output from an already selected Responses or
  // Chat Completions content branch. Reasoning/analysis items are never output.
  function extractResponsesOutputText(value, seen = new Set(), depth = 0) {
    if (depth > 12 || value === null || value === undefined) return '';
    if (typeof value === 'string') return value;
    if (typeof value !== 'object') return '';
    if (seen.has(value)) return '';
    seen.add(value);

    if (Array.isArray(value)) {
      return value.map(item => extractResponsesOutputText(item, seen, depth + 1)).filter(Boolean).join('');
    }

    const type = String(value.type || value.role || '').toLowerCase();
    if (/reasoning|analysis/.test(type)) return '';

    for (const field of ['output_text', 'text', 'content', 'message', 'delta', 'output']) {
      if (!Object.prototype.hasOwnProperty.call(value, field)) continue;
      const text = extractResponsesOutputText(value[field], seen, depth + 1);
      if (text) return text;
    }
    return '';
  }

  // Interpret only documented response-output positions. In particular, a
  // top-level Responses `text` object describes output formatting and is not
  // assistant content; callers must never traverse the whole envelope.
  function responseOutputText(response = {}) {
    const direct = extractResponsesOutputText(response?.output_text);
    if (direct) return direct;
    const responses = extractResponsesOutputText(response?.output);
    if (responses) return responses;
    const choice = response?.choices?.[0];
    return extractResponsesOutputText(choice?.message?.content || choice?.text);
  }

  return Object.freeze({
    extractResponsesOutputText,
    responseOutputText,
  });
});
