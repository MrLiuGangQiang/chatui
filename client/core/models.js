(function initChatUICoreModels(root) {
  'use strict';

  function normalizeModelType(type = '') {
    const value = String(type || '').trim().toLowerCase();
    if (!value) return '';
    if (/image|image_generation|image-generation|imagegeneration|vision|picture|img|dall|gpt-image|flux|sd|stable|midjourney|wan|kling/.test(value)) return 'image';
    if (/chat|text|llm|language|completion|reason|assistant|gpt|claude|gemini|qwen|deepseek|llama|mistral/.test(value)) return 'chat';
    if (/embedding|embed/.test(value)) return 'embedding';
    return value;
  }

  function inferModelType(model = {}) {
    const explicit = normalizeModelType(model.type || model.capability || model.mode);
    if (explicit) return explicit;
    const id = String(model.id || model.name || model || '').toLowerCase();
    if (/embedding|embed/.test(id)) return 'embedding';
    if (/image|dall-e|gpt-image|imagen|flux|sdxl|midjourney|wan2\.?[0-9]?/.test(id)) return 'image';
    return 'chat';
  }

  function normalizeModelMeta(models = [], meta = {}) {
    const result = {};
    for (const item of Array.isArray(models) ? models : []) {
      const id = typeof item === 'string' ? item : item?.id || item?.name;
      if (!id) continue;
      const current = meta?.[id] || {};
      const type = normalizeModelType(current.type) || inferModelType(item);
      result[id] = {
        id,
        type,
        unrecognized: current.unrecognized === true || !type,
      };
    }
    return result;
  }

  function isModelAllowedFor(modelId, targetType, meta = {}) {
    const type = normalizeModelType(meta?.[modelId]?.type || '');
    if (!targetType) return true;
    if (!type) return true;
    return type === normalizeModelType(targetType);
  }

  function extractModels(payload) {
    const data = Array.isArray(payload?.data) ? payload.data : Array.isArray(payload) ? payload : [];
    return data
      .map(item => typeof item === 'string' ? { id: item } : item)
      .filter(item => item?.id || item?.name)
      .map(item => ({ id: String(item.id || item.name), type: inferModelType(item) }));
  }

  const api = Object.freeze({ normalizeModelType, inferModelType, normalizeModelMeta, isModelAllowedFor, extractModels });

  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  if (root) root.ChatUICoreModels = api;
  if (root?.window) root.window.ChatUICoreModels = api;
})(typeof globalThis !== 'undefined' ? globalThis : (typeof window !== 'undefined' ? window : this));
