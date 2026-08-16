'use strict';

// Extract final textual output from a non-streaming Responses or Chat
// Completions envelope without traversing reasoning/analysis items.
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
  if (direct) return direct;
  const responses = extractResponsesOutputText(response?.output);
  if (responses) return responses;
  const choice = response?.choices?.[0];
  return extractResponsesOutputText(choice?.message?.content || choice?.text);
}

function parseNonStreamingResponse(raw = '') {
  const original = String(raw ?? '');
  if (!original.trim()) return { original, response: null };
  try {
    const response = JSON.parse(original);
    return response && typeof response === 'object' && !Array.isArray(response)
      ? { original, response }
      : { original, response: null };
  } catch {
    return { original, response: null };
  }
}

function normalizeNonStreamingResponsesBody(raw = '') {
  const { original, response } = parseNonStreamingResponse(raw);
  if (!response) return Object.freeze({ text: original, normalized: false });
  const outputText = responseOutputText(response);
  if (!outputText || (typeof response.output_text === 'string' && response.output_text === outputText)) {
    return Object.freeze({ text: original, normalized: false });
  }
  return Object.freeze({
    text: JSON.stringify({ ...response, output_text: outputText }),
    normalized: true,
  });
}

// Intent recognition is an internal classifier boundary. Browser code needs only
// the schema-constrained answer; upstream IDs, usage, tools, and encrypted
// reasoning must never cross this boundary.
function compactNonStreamingIntentBody(raw = '') {
  const { original, response } = parseNonStreamingResponse(raw);
  if (!response) return Object.freeze({ text: original, normalized: false });
  const outputText = responseOutputText(response);
  if (!outputText) return Object.freeze({ text: original, normalized: false });
  return Object.freeze({
    text: JSON.stringify({ output_text: outputText }),
    normalized: true,
  });
}

module.exports = {
  extractResponsesOutputText,
  responseOutputText,
  normalizeNonStreamingResponsesBody,
  compactNonStreamingIntentBody,
};
