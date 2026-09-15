(function initChatUIFeaturesMessagesModel(root) {
  'use strict';

  const appContext = root?.ChatUIApp?.appContext || (() => {
    try { return typeof require === 'function' ? require('../../app/app-context') : null; } catch { return null; }
  })();

  const messagePrimitives = root?.[Symbol.for('chatui.module-registry.v1')]?.get('messagePrimitives')
    || (() => { try { return typeof require === 'function' ? require('../../core/message-primitives') : {}; } catch { return {}; } })();
  const normalizeQuoteContextCore = messagePrimitives.normalizeQuoteContext;
  const quoteContextJsonCore = messagePrimitives.quoteContextJson;

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

  function normalizeQuoteContext(value, options = {}) {
    return typeof normalizeQuoteContextCore === 'function'
      ? normalizeQuoteContextCore(value, options)
      : null;
  }

  function quoteContextJson(value, options = {}) {
    return typeof quoteContextJsonCore === 'function'
      ? quoteContextJsonCore(value, options)
      : '';
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
