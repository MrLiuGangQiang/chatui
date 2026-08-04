(function initChatUIMessagePrimitives(root) {
  'use strict';

  function parseContext(value) {
    if (!value) return null;
    if (typeof value === 'string') {
      try { return parseContext(JSON.parse(value)); } catch { return null; }
    }
    return value && typeof value === 'object' && !Array.isArray(value) ? value : null;
  }

  function messageIdentity(message) {
    if (!message || !['user', 'assistant'].includes(message.role)) return '';
    const value = message.role === 'user' ? message.messageIndex : message.responseIndex;
    return value !== undefined && value !== null && value !== '' ? `${message.role}:${value}` : '';
  }

  function stripReasoningQuoteText(text = '') {
    return String(text || '')
      .replace(/思考中\s*/g, '')
      .replace(/思考完成\s*/g, '')
      .replace(/未返回思考内容\s*/g, '')
      .replace(/当前模型或接口没有返回可展示的思考内容[^\n。]*[。]?/g, '');
  }

  const api = Object.freeze({ parseContext, messageIdentity, stripReasoningQuoteText });
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  root?.[Symbol.for('chatui.module-registry.v1')]?.get('moduleRegistry')?.register('messagePrimitives', api);
})(typeof globalThis !== 'undefined' ? globalThis : this);
