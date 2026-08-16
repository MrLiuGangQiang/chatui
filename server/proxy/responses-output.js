'use strict';

// Extract final textual output from a non-streaming Responses envelope without
// traversing reasoning/analysis items. OpenAI-compatible gateways commonly
// return this canonical `output` array while omitting the convenience
// `output_text` field that older clients expect.
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

function responseOutputText(response = {}) {
  const direct = extractResponsesOutputText(response?.output_text);
  return direct || extractResponsesOutputText(response?.output);
}

function normalizeNonStreamingResponsesBody(raw = '') {
  const original = String(raw ?? '');
  if (!original.trim()) return Object.freeze({ text: original, normalized: false });
  try {
    const response = JSON.parse(original);
    if (!response || typeof response !== 'object' || Array.isArray(response)) {
      return Object.freeze({ text: original, normalized: false });
    }
    const outputText = responseOutputText(response);
    if (!outputText || (typeof response.output_text === 'string' && response.output_text === outputText)) {
      return Object.freeze({ text: original, normalized: false });
    }
    return Object.freeze({
      text: JSON.stringify({ ...response, output_text: outputText }),
      normalized: true,
    });
  } catch {
    return Object.freeze({ text: original, normalized: false });
  }
}

module.exports = {
  extractResponsesOutputText,
  responseOutputText,
  normalizeNonStreamingResponsesBody,
};
