(function initChatUIModelRecommendation(root, factory) {
  'use strict';

  const api = factory();
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  const registry = root?.[Symbol.for('chatui.module-registry.v1')]?.get('moduleRegistry');
  if (registry?.register) registry.register('modelRecommendationConfig', api);
})(typeof globalThis !== 'undefined' ? globalThis : (typeof window !== 'undefined' ? window : this), function createChatUIModelRecommendation() {
  'use strict';

  const MAX_MODEL_RECOMMENDATION_BYTES = 64 * 1024;
  const MAX_MODEL_NAME_LENGTH = 120;
  const MAX_MODEL_NOTE_LENGTH = 300;
  const DEFAULT_MODEL_RECOMMENDATION = Object.freeze({
    routeModel: 'gpt-6-astra',
    chatModel: 'gpt-6-astra',
    imageModel: 'gpt-image-2',
    note: '处理文档、联网搜索请使用 GPT 系列。',
  });

  function normalizedText(value, fallback, maxLength) {
    if (value === undefined || value === null) return fallback;
    const text = String(value).replace(/[\u0000-\u001f\u007f]+/g, ' ').trim();
    return (text || fallback).slice(0, maxLength);
  }

  function normalizeModelRecommendation(value = {}) {
    const source = value && typeof value === 'object' && !Array.isArray(value) ? value : {};
    return Object.freeze({
      routeModel: normalizedText(source.route_model ?? source.routeModel, DEFAULT_MODEL_RECOMMENDATION.routeModel, MAX_MODEL_NAME_LENGTH),
      chatModel: normalizedText(source.chat_model ?? source.chatModel, DEFAULT_MODEL_RECOMMENDATION.chatModel, MAX_MODEL_NAME_LENGTH),
      imageModel: normalizedText(source.image_model ?? source.imageModel, DEFAULT_MODEL_RECOMMENDATION.imageModel, MAX_MODEL_NAME_LENGTH),
      note: normalizedText(source.note, DEFAULT_MODEL_RECOMMENDATION.note, MAX_MODEL_NOTE_LENGTH),
    });
  }

  function formatWelcomeModelNote(value = DEFAULT_MODEL_RECOMMENDATION) {
    const recommendation = normalizeModelRecommendation(value);
    const models = `推荐模型：意图 ${recommendation.routeModel} / 聊天 ${recommendation.chatModel} / 生图 ${recommendation.imageModel}`;
    return recommendation.note ? `${models} ｜ ${recommendation.note}` : models;
  }

  return Object.freeze({
    MAX_MODEL_RECOMMENDATION_BYTES,
    MAX_MODEL_NAME_LENGTH,
    MAX_MODEL_NOTE_LENGTH,
    DEFAULT_MODEL_RECOMMENDATION,
    normalizeModelRecommendation,
    formatWelcomeModelNote,
  });
});
