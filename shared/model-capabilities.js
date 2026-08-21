(function initChatUIModelCapabilities(root, factory) {
  'use strict';
  const api = factory();
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  const registry = root?.[Symbol.for('chatui.module-registry.v1')]?.get('moduleRegistry');
  if (registry?.register) registry.register('modelCapabilities', api);
})(typeof globalThis !== 'undefined' ? globalThis : this, function createChatUIModelCapabilities() {
  'use strict';
  const DEEPSEEK = Object.freeze({ family: 'deepseek', structuredOutputMode: 'json_object' });
  const MODEL_FAMILIES = Object.freeze([{ family: 'deepseek', match: id => /^deepseek[_-]/i.test(id), capabilities: DEEPSEEK }]);
  function normalizeModelId(value = '') { return String(value || '').trim().toLowerCase(); }
  function inferModelCapabilities(modelId = '') {
    const id = normalizeModelId(modelId);
    return MODEL_FAMILIES.find(entry => entry.match(id))?.capabilities || null;
  }
  function isDeepSeekModel(modelId = '') { return !!inferModelCapabilities(modelId); }
  function initialStructuredOutputMode(modelId = '') { return inferModelCapabilities(modelId)?.structuredOutputMode || ''; }
  return Object.freeze({ MODEL_FAMILIES, inferModelCapabilities, isDeepSeekModel, initialStructuredOutputMode });
});
