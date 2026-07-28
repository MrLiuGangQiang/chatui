(function initChatUIFeaturesMessagesModel(root) {
  'use strict';

  const appContext = root?.ChatUIApp?.appContext || (() => {
    try { return typeof require === 'function' ? require('../../app/app-context') : null; } catch { return null; }
  })();

  function normalizeRole(role = '', fallback = 'user') {
    return role === 'assistant' ? 'assistant' : role === 'user' ? 'user' : fallback;
  }

  function parseMaybeJsonContext(value) {
    if (!value) return null;
    if (typeof value === 'string') {
      try { return parseMaybeJsonContext(JSON.parse(value)); } catch { return null; }
    }
    return value && typeof value === 'object' ? value : null;
  }

  function hasUsableImageContext(value) {
    const context = parseMaybeJsonContext(value);
    return !!(context && !Array.isArray(context) && Array.isArray(context.attachments) && context.attachments.length);
  }

  function stripReasoningQuoteText(text = '') {
    return String(text || '')
      .replace(/思考中\s*/g, '')
      .replace(/思考完成\s*/g, '')
      .replace(/未返回思考内容\s*/g, '')
      .replace(/当前模型或接口没有返回可展示的思考内容[^\n。]*[。]?/g, '');
  }

  function defaultNormalizeQuoteText(text = '', limit = 1200) {
    return stripReasoningQuoteText(text).replace(/\s+/g, ' ').trim().slice(0, limit);
  }

  function normalizeQuoteContext(value, options = {}) {
    const context = parseMaybeJsonContext(value);
    if (!context || Array.isArray(context)) return null;
    const normalizeQuoteText = options.normalizeQuoteText || defaultNormalizeQuoteText;
    const hasImageContext = !!(context.imageContext || context.image_context);
    const content = normalizeQuoteText(context.content ?? context.rawText ?? (hasImageContext ? '[图片消息]' : ''), 1200);
    if (!content && !hasImageContext) return null;
    const quote = { role: normalizeRole(context.role, 'user'), content: content || '[图片消息]' };
    ['sessionId', 'displayItemId', 'messageIndex', 'responseIndex', 'imageContext', 'attachmentContext'].forEach(key => {
      const altKey = key === 'imageContext' ? 'image_context' : key === 'attachmentContext' ? 'attachment_context' : key;
      const raw = context[key] ?? context[altKey];
      if (raw !== undefined && raw !== null && raw !== '') quote[key] = typeof raw === 'string' ? raw : JSON.stringify(raw);
    });
    return quote;
  }

  function quoteContextJson(value, options = {}) {
    const quote = normalizeQuoteContext(value, options);
    return quote ? JSON.stringify(quote) : '';
  }

  function resolveDisplayItemKey(source = {}) {
    const dataset = source?.dataset || {};
    const displayItem = source?.__displayItem || source?.displayItem || {};
    return {
      displayItemId: dataset.displayItemId || displayItem.id || source?.displayItemId || '',
      responseIndex: dataset.responseIndex || displayItem.responseIndex || source?.responseIndex || '',
      messageIndex: dataset.messageIndex || displayItem.messageIndex || source?.messageIndex || '',
    };
  }

  const api = Object.freeze({
    normalizeRole,
    parseMaybeJsonContext,
    hasUsableImageContext,
    normalizeQuoteContext,
    quoteContextJson,
    resolveDisplayItemKey,
  });

  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  if (appContext?.registerWorkflowModule) appContext.registerWorkflowModule('messageModel', api);
})(typeof globalThis !== 'undefined' ? globalThis : (typeof window !== 'undefined' ? window : this));
