'use strict';

const {
  extractResponsesOutputText,
  responseOutputText,
} = require('../../shared/responses-output');

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
