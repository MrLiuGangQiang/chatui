(function initChatUITextHash(root) {
  'use strict';

  function normalizedText(value = '') {
    return String(value || '');
  }

  function fnv1aBase36(value = '') {
    const text = normalizedText(value);
    let hash = 2166136261;
    for (let index = 0; index < text.length; index += 1) {
      hash ^= text.charCodeAt(index);
      hash = Math.imul(hash, 16777619);
    }
    return (hash >>> 0).toString(36);
  }

  function contentHash(value = '') {
    const text = normalizedText(value);
    return `${text.length}:${fnv1aBase36(text)}`;
  }

  const api = Object.freeze({ normalizedText, fnv1aBase36, contentHash });
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  root?.[Symbol.for('chatui.module-registry.v1')]?.get('moduleRegistry')?.register('textHash', api);
})(typeof globalThis !== 'undefined' ? globalThis : this);
