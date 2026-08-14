(function initChatUIMessagePrimitives(root) {
  'use strict';

  const IMAGE_COMPLETION_RE = /^\[图片(?:生成|编辑|修改)完成\]/;
  const IMAGE_MEDIA_KEYS = Object.freeze(['src', 'persistedSrc', 'persisted_src', 'url']);

  function parseContext(value) {
    if (!value) return null;
    if (typeof value === 'string') {
      try { return parseContext(JSON.parse(value)); } catch { return null; }
    }
    return value && typeof value === 'object' && !Array.isArray(value) ? value : null;
  }

  function imageCompletionMarker(record = {}) {
    return [record.content, record.rawText, record.presentation?.displayText]
      .some(value => IMAGE_COMPLETION_RE.test(String(value || '')));
  }

  function isPersistedImageRef(value = '') {
    const ref = String(value || '').trim();
    return /^indexeddb:\/\/[^\s]+$/i.test(ref);
  }

  function descriptorHasPersistedImage(item) {
    if (typeof item === 'string') return isPersistedImageRef(item);
    if (!item || typeof item !== 'object' || Array.isArray(item)) return false;
    return IMAGE_MEDIA_KEYS.some(key => isPersistedImageRef(item[key]));
  }

  function contextHasPersistedImageResult(value) {
    const context = parseContext(value);
    if (!context) return false;
    const schema = String(context.schema_version || context.schemaVersion || '');
    const hasResultIdentity = /^image_result\./i.test(schema)
      || !!String(context.resultId || context.result_id || '').trim();
    if (!hasResultIdentity) return false;
    const descriptors = Array.isArray(context.attachments)
      ? context.attachments
      : Array.isArray(context.images)
        ? context.images
        : [];
    return descriptors.some(descriptorHasPersistedImage);
  }

  function htmlHasPersistedImageResult(html = '') {
    return /(?:data-persisted-src|src)\s*=\s*(["'])indexeddb:\/\/[^"']+\1/i.test(String(html || ''));
  }

  function hasPersistedImageResult(record = {}) {
    if (!record || typeof record !== 'object') return false;
    const presentationImages = Array.isArray(record.presentation?.images) ? record.presentation.images : [];
    const directImages = Array.isArray(record.images) ? record.images : [];
    return contextHasPersistedImageResult(record.imageContext)
      || presentationImages.some(descriptorHasPersistedImage)
      || directImages.some(descriptorHasPersistedImage)
      || htmlHasPersistedImageResult(record.html)
      || htmlHasPersistedImageResult(record.presentation?.html);
  }

  function isDurableImageCompletionMessage(message = {}) {
    if (message?.role !== 'assistant' || !hasPersistedImageResult(message)) return false;
    const context = parseContext(message.imageContext);
    const schema = String(context?.schema_version || context?.schemaVersion || '');
    return imageCompletionMarker(message)
      || message.presentation?.kind === 'image-result'
      || /^image_result\./i.test(schema)
      || !!String(context?.resultId || context?.result_id || '').trim();
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

  const api = Object.freeze({ IMAGE_COMPLETION_RE, parseContext, imageCompletionMarker, isPersistedImageRef, descriptorHasPersistedImage, contextHasPersistedImageResult, htmlHasPersistedImageResult, hasPersistedImageResult, isDurableImageCompletionMessage, messageIdentity, stripReasoningQuoteText });
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  root?.[Symbol.for('chatui.module-registry.v1')]?.get('moduleRegistry')?.register('messagePrimitives', api);
})(typeof globalThis !== 'undefined' ? globalThis : this);
