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

  function normalizeQuoteRole(role = '', fallback = 'user') {
    return role === 'assistant' ? 'assistant' : role === 'user' ? 'user' : fallback;
  }

  function defaultNormalizeQuoteText(text = '', limit = 1200) {
    return stripReasoningQuoteText(text).replace(/\s+/g, ' ').trim().slice(0, limit);
  }

  function normalizeQuoteContext(value, options = {}) {
    const context = parseContext(value);
    if (!context || Array.isArray(context)) return null;
    const normalizeQuoteText = typeof options.normalizeQuoteText === 'function'
      ? options.normalizeQuoteText
      : defaultNormalizeQuoteText;
    const hasImageContext = !!(context.imageContext || context.image_context);
    const content = normalizeQuoteText(
      context.content ?? context.rawText ?? (hasImageContext ? '[图片消息]' : ''),
      1200,
    );
    if (!content && !hasImageContext) return null;
    const quote = { role: normalizeQuoteRole(context.role, 'user'), content: content || '[图片消息]' };
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

  function isBlankReplacementMessage(record = {}) {
    if (record?.role !== 'assistant' || record?.replacing !== true) return false;
    const texts = [];
    appendAssistantText(record.content, texts);
    appendAssistantText(record.rawText, texts);
    appendAssistantText(record.presentation?.displayText, texts);
    const html = String(record.html || record.presentation?.html || '').trim();
    const reasoning = String(record.reasoning_content || record.reasoning || '').trim();
    const presentation = record.presentation || {};
    const attachments = Array.isArray(presentation.attachments) ? presentation.attachments : [];
    const images = Array.isArray(presentation.images) ? presentation.images : [];
    const hasClarification = !!(record.clarificationId || record.clarification_id || presentation.clarification);
    return texts.length === 0 && !html && !reasoning && !attachments.length && !images.length && !hasClarification && !hasPersistedImageResult(record);
  }

  function appendAssistantText(value, output = []) {
    if (typeof value === 'string') {
      const text = value.trim();
      if (text) output.push(text);
      return output;
    }
    if (Array.isArray(value)) {
      value.forEach(item => appendAssistantText(item, output));
      return output;
    }
    if (value && typeof value === 'object') {
      appendAssistantText(value.text, output);
      appendAssistantText(value.output_text, output);
      appendAssistantText(value.content, output);
    }
    return output;
  }

  function hasCompletedAssistantOutput(record = {}, options = {}) {
    if (record?.role !== 'assistant') return false;
    if (record?.pending === true || String(record?.pending || '') === '1') return false;
    const isStatusText = typeof options.isStatusText === 'function' ? options.isStatusText : (() => false);
    const hasRichMedia = typeof options.hasRichMedia === 'function' ? options.hasRichMedia : (() => false);
    const texts = [];
    appendAssistantText(record.content, texts);
    appendAssistantText(record.rawText, texts);
    appendAssistantText(record.presentation?.displayText, texts);
    const hasText = texts.some(text => {
      try { return !isStatusText(text); } catch { return true; }
    });
    if (hasText) return true;
    try { if (hasRichMedia(record) === true) return true; } catch {}
    return hasPersistedImageResult(record);
  }

  function countCompletedAssistantMessages(messages = [], options = {}) {
    return (Array.isArray(messages) ? messages : []).filter(message => hasCompletedAssistantOutput(message, options)).length;
  }

  function hasCompletedAssistantForResponse(session = {}, responseIndex = null, options = {}) {
    if (responseIndex === null || responseIndex === undefined || String(responseIndex).trim() === '') return false;
    const expected = String(responseIndex);
    return [...(Array.isArray(session?.messages) ? session.messages : []), ...(Array.isArray(session?.display) ? session.display : [])]
      .some(record => record?.role === 'assistant'
        && String(record?.responseIndex ?? '') === expected
        && hasCompletedAssistantOutput(record, options));
  }

  function stableMessageId(message = {}) {
    return String(message.id || message.messageId || '').trim();
  }

  function stableTurnId(message = {}) {
    return String(message.turnId || message.turn_id || '').trim();
  }

  function messageIdentity(message) {
    if (!message || !['user', 'assistant'].includes(message.role)) return '';
    // `id` and `turnId` are immutable persistence identities. Positional
    // indexes are rendering metadata only and remain a legacy fallback.
    const id = String(message.id || message.messageId || '').trim();
    if (id) return `${message.role}:id:${id}`;
    const turnId = String(message.turnId || message.turn_id || '').trim();
    if (turnId) return `${message.role}:turn:${turnId}`;
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

  const api = Object.freeze({ IMAGE_COMPLETION_RE, parseContext, normalizeQuoteContext, quoteContextJson, imageCompletionMarker, isPersistedImageRef, descriptorHasPersistedImage, contextHasPersistedImageResult, htmlHasPersistedImageResult, hasPersistedImageResult, isDurableImageCompletionMessage, hasCompletedAssistantOutput, hasCompletedAssistantForResponse, countCompletedAssistantMessages, stableMessageId, stableTurnId, messageIdentity, stripReasoningQuoteText, isBlankReplacementMessage });
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  root?.[Symbol.for('chatui.module-registry.v1')]?.get('moduleRegistry')?.register('messagePrimitives', api);
})(typeof globalThis !== 'undefined' ? globalThis : this);
