(function initChatUIMessageRecords(root) {
  'use strict';

  const SCHEMA_VERSION = 2;
  const IMAGE_COMPLETION_RE = /^\[\u56fe\u7247(?:\u751f\u6210|\u7f16\u8f91|\u4fee\u6539)\u5b8c\u6210\]/;
  const BASE64_PLACEHOLDER_RE = /\[base64 image\]/gi;
  const HAS_BASE64_PLACEHOLDER_RE = /\[base64 image\]/i;
  const VALID_PRESENTATION_KINDS = new Set(['text', 'attachment', 'image-result']);
  const MEDIA_KEYS = ['src', 'url', 'dataUrl', 'data_url', 'previewSrc', 'preview_src', 'objectUrl', 'object_url'];
  const TRANSIENT_MEDIA_RE = /^(?:data:|blob:)/i;
  const OMITTED_MEDIA_RE = /\[(?:attachment|image)-data-omitted\]/i;
  const GENERIC_ATTACHMENT_TEXT_RE = /^(?:\u5df2\u53d1\u9001\u9644\u4ef6|\u9644\u4ef6)$/;

  const { parseContext } = root?.[Symbol.for('chatui.module-registry.v1')]?.get('messagePrimitives')
    || (typeof require === 'function' ? require('../core/message-primitives') : {});

  function stringifyContext(value) {
    if (!value) return '';
    if (typeof value === 'string') return value;
    try { return JSON.stringify(value); } catch { return ''; }
  }

  function legacyOrderIndex(message, fallback = 0) {
    const raw = message?.role === 'user'
      ? message?.messageIndex
      : message?.role === 'assistant'
        ? message?.responseIndex
        : message?.sequence;
    if (raw === null || raw === undefined || typeof raw === 'string' && !raw.trim()) return fallback;
    const value = Number(raw);
    return Number.isFinite(value) && value >= 0 ? value : fallback;
  }

  // Object-stringified ids (e.g. "[object Object],[object Object]:assistant:1")
  // are corruption of the canonical `${sessionId}:${role}:${index}` identity
  // contract and must never be treated as durable identity. Rebuild the id
  // deterministically from scalar parts instead.
  const OBJECT_STRINGIFIED_ID_RE = /\[object (?:Object|Undefined|Null|Array)\]/;

  function messageId(message = {}, { sessionId = 'session', sequence = 0 } = {}) {
    const existing = String(message.id || message.messageId || '').trim();
    if (existing && !OBJECT_STRINGIFIED_ID_RE.test(existing)) return existing;
    const session = typeof sessionId === 'string' && sessionId.trim() ? sessionId.trim() : 'session';
    const role = message.role === 'assistant'
      ? 'assistant'
      : message.role === 'user'
        ? 'user'
        : message.role || 'message';
    return `${session}:${role}:${legacyOrderIndex(message, sequence)}`;
  }

  function durableMediaRef(value = '') {
    const ref = String(value || '').trim();
    return ref && !TRANSIENT_MEDIA_RE.test(ref) && !OMITTED_MEDIA_RE.test(ref) ? ref : '';
  }

  function sanitizePresentationHtml(html = '') {
    return String(html || '')
      .replace(/\s(?:src|srcset|href|data-persisted-src|data-original-src|data-persisted-href|data-object-url|data-preview-object-url)\s*=\s*(['"])(?:data:|blob:)[^'"]*\1/gi, '')
      .replace(/\s(?:src|srcset|href|data-persisted-src|data-original-src|data-persisted-href|data-object-url|data-preview-object-url)\s*=\s*(?:data:|blob:)[^\s>]+/gi, '')
      .replace(/\s(?:src|href|data-persisted-src|data-original-src|data-persisted-href)\s*=\s*(['"])[^'"]*\[(?:attachment|image)-data-omitted\][^'"]*\1/gi, '');
  }

  function sanitizeMediaItem(item = {}) {
    if (typeof item === 'string') {
      const src = durableMediaRef(item);
      return src ? { src } : null;
    }
    if (!item || typeof item !== 'object' || Array.isArray(item)) return null;
    const next = { ...item };
    const preferredRef = MEDIA_KEYS.map(key => durableMediaRef(item[key])).find(Boolean) || '';
    MEDIA_KEYS.forEach(key => {
      if (key in next) next[key] = durableMediaRef(next[key]);
    });
    if (preferredRef && !next.src) next.src = preferredRef;
    return next;
  }

  function attachmentList(value) {
    const context = parseContext(value);
    if (!context) return [];
    const source = Array.isArray(context.attachments)
      ? context.attachments
      : Array.isArray(context.images)
        ? context.images
        : [];
    return source.map(sanitizeMediaItem).filter(Boolean);
  }

  function stableImageResultPart(value = '') {
    return String(value || '').replace(/[^a-zA-Z0-9_-]+/g, '_').replace(/^_+|_+$/g, '').slice(0, 48) || 'legacy';
  }

  // Image result identity is a durable record contract, not a rendering detail.
  // Older sessions used the moving `imgref_latest` alias for every result. Keep
  // them readable by deterministically upgrading that alias from the canonical
  // message ID while every new result writes an explicit resultId.
  function normalizeImageResultContext(value, { messageId: canonicalMessageId = '', sequence = 0 } = {}) {
    const context = parseContext(value);
    if (!context) return null;
    const source = Array.isArray(context.attachments)
      ? context.attachments
      : Array.isArray(context.images)
        ? context.images
        : [];
    const images = source.map(sanitizeMediaItem).filter(item => MEDIA_KEYS.some(key => !!durableMediaRef(item?.[key])));
    if (!images.length) return context;

    const existingResultId = String(context.resultId || context.result_id || '').trim();
    const existingReferenceId = String(context.referenceId || context.reference_id || '').trim();
    const legacyKey = stableImageResultPart(canonicalMessageId || `message_${sequence}_${context.updatedAt || context.updated_at || ''}`);
    const resultId = existingResultId || (existingReferenceId && existingReferenceId !== 'imgref_latest'
      ? existingReferenceId.replace(/^imgref_/, '')
      : `legacy_${legacyKey}`);
    const referenceId = existingReferenceId && existingReferenceId !== 'imgref_latest'
      ? existingReferenceId
      : `imgref_${stableImageResultPart(resultId)}`;
    const attachments = images.map((item, index) => {
      const ordinal = Number(item.ordinal || item.position || item.sourceIndex || item.source_index || index + 1) || index + 1;
      const currentImageId = String(item.imageId || item.image_id || item.id || '').trim();
      const legacyImageId = !currentImageId || /^img_imgref_latest_\d+$/.test(currentImageId);
      const imageId = legacyImageId ? `img_${referenceId}_${ordinal}` : currentImageId;
      return { ...item, id: imageId, imageId, referenceId, resultId, ordinal, sourceIndex: ordinal };
    });
    return {
      ...context,
      schema_version: 'image_result.v1',
      resultId,
      referenceId,
      selectedReferenceId: referenceId,
      attachments,
    };
  }

  function hasDurableMedia(value) {
    return attachmentList(value).some(item => MEDIA_KEYS.some(key => !!durableMediaRef(item?.[key])));
  }

  function htmlHasGeneratedImages(html = '') {
    return /generated-image-grid|class=["'][^"']*generated-thumb|data-generated-images/i.test(String(html || ''));
  }

  function htmlHasUserAttachments(html = '') {
    return /user-attachment-preview-grid|class=["'][^"']*user-attachment-image|attachment-summary/i.test(String(html || ''));
  }

  function stripBase64Placeholder(text = '') {
    return String(text || '')
      .replace(BASE64_PLACEHOLDER_RE, '')
      .replace(/^\s*\u8017\u65f6\s*[:\uff1a][^\n]+\s*$/gim, '')
      .replace(/^\s*(?:TTFT|RT)\s+[^\n]+\s*$/gim, '')
      .replace(/\n{3,}/g, '\n\n')
      .trim();
  }

  function extractMetricText(text = '') {
    const metric = String(text || '').match(/(?:^|\n)\s*((?:TTFT\s+[^\n\u00b7]+(?:\s*\u00b7\s*)?)?RT\s+[^\n]+|\u8017\u65f6\s*[:\uff1a][^\n]+)\s*$/i);
    return metric ? metric[1].trim() : '';
  }

  function attachmentIsImage(item = {}) {
    const type = String(item?.type || item?.mime || item?.mimeType || '').trim();
    if (/^image\//i.test(type)) return true;
    const name = String(item?.name || item?.filename || '').trim();
    return /\.(?:png|jpe?g|gif|webp|bmp|svg|avif|heic|heif)$/i.test(name);
  }

  function attachmentDisplayText(message = {}, context = null) {
    const parsed = context || parseContext(message.attachmentContext);
    const prompt = String(parsed?.prompt || '').trim();
    if (prompt) return prompt;
    const attachments = Array.isArray(parsed?.attachments) ? parsed.attachments : [];
    const visibleAttachments = attachments.filter(item => !attachmentIsImage(item));
    if (attachments.length && !visibleAttachments.length) return '';
    const names = visibleAttachments
      .map(item => String(item?.name || item?.filename || '').trim())
      .filter(Boolean);
    if (names.length) return `\u9644\u4ef6\uff1a${names.join('\u3001')}`;
    const raw = stripBase64Placeholder(String(message.rawText || '').trim());
    return raw && !GENERIC_ATTACHMENT_TEXT_RE.test(raw) ? raw : '\u9644\u4ef6';
  }

  function imageCompletionText(message = {}, context = null) {
    const content = String(message.content || '').trim();
    if (IMAGE_COMPLETION_RE.test(content)) return content;
    const presentationText = String(message.presentation?.displayText || '').trim();
    if (IMAGE_COMPLETION_RE.test(presentationText)) return presentationText;
    const parsed = context || parseContext(message.imageContext);
    const prompt = stripBase64Placeholder(String(parsed?.prompt || parsed?.routePrompt || '').trim());
    const mode = String(message.kind || parsed?.mode || 'image');
    const prefix = mode === 'edit_image'
      ? '[\u56fe\u7247\u7f16\u8f91\u5b8c\u6210]'
      : '[\u56fe\u7247\u751f\u6210\u5b8c\u6210]';
    return `${prefix}${prompt ? ` ${prompt}` : ''}`;
  }

  function sanitizePresentation(presentation = {}) {
    if (!presentation || typeof presentation !== 'object' || Array.isArray(presentation)) return {};
    const next = { ...presentation };
    if (!VALID_PRESENTATION_KINDS.has(next.kind)) delete next.kind;
    next.html = sanitizePresentationHtml(next.html || '');
    if (Array.isArray(next.attachments)) next.attachments = next.attachments.map(sanitizeMediaItem).filter(Boolean);
    if (Array.isArray(next.images)) next.images = next.images.map(sanitizeMediaItem).filter(Boolean);
    if (next.displayText !== undefined) next.displayText = String(next.displayText || '');
    return next;
  }

  function detectPresentationKind(message = {}, existing = sanitizePresentation(message.presentation)) {
    const imageContext = parseContext(message.imageContext);
    const attachmentContext = parseContext(message.attachmentContext);
    if (message.role === 'assistant' && (
      IMAGE_COMPLETION_RE.test(String(message.content || ''))
      || IMAGE_COMPLETION_RE.test(String(existing.displayText || ''))
      || htmlHasGeneratedImages(message.html)
      || htmlHasGeneratedImages(existing.html)
      || hasDurableMedia(imageContext)
      || existing.kind === 'image-result'
    )) return 'image-result';
    if (message.role === 'user' && (
      htmlHasUserAttachments(message.html)
      || htmlHasUserAttachments(existing.html)
      || attachmentList(attachmentContext).length
      || existing.kind === 'attachment'
    )) return 'attachment';
    return 'text';
  }

  function buildPresentation(message = {}) {
    const existing = sanitizePresentation(message.presentation);
    const kind = detectPresentationKind(message, existing);
    const attachmentContext = parseContext(message.attachmentContext);
    const imageContext = parseContext(message.imageContext);
    const html = sanitizePresentationHtml(message.html || '') || existing.html || '';
    const presentation = { kind, html };
    if (kind === 'attachment') {
      const contextAttachments = attachmentList(attachmentContext);
      presentation.attachments = contextAttachments.length ? contextAttachments : existing.attachments || [];
      const displayContext = attachmentContext || { attachments: presentation.attachments };
      const derived = attachmentDisplayText(message, displayContext);
      presentation.displayText = derived === '\u9644\u4ef6' && existing.displayText && !GENERIC_ATTACHMENT_TEXT_RE.test(existing.displayText)
        ? existing.displayText
        : derived;
    } else if (kind === 'image-result') {
      const normalizedImageContext = normalizeImageResultContext(imageContext, { messageId: message.id, sequence: message.sequence });
      const contextImages = attachmentList(normalizedImageContext);
      presentation.images = contextImages.length ? contextImages : existing.images || [];
      presentation.resultId = normalizedImageContext?.resultId || '';
      presentation.displayText = imageCompletionText({ ...message, presentation: existing }, normalizedImageContext || imageContext);
    } else {
      const canonicalText = message.rawText || (typeof message.content === 'string' ? message.content : '');
      presentation.displayText = stripBase64Placeholder(canonicalText)
        || stripBase64Placeholder(existing.displayText || '');
    }
    return presentation;
  }

  function normalizeCanonicalMessage(message = {}, options = {}) {
    if (!message || !message.role) return null;
    const sequence = Number.isFinite(Number(message.sequence))
      ? Number(message.sequence)
      : Number(options.sequence) || 0;
    const next = {
      ...message,
      id: messageId(message, { sessionId: options.sessionId, sequence }),
      sequence,
    };
    next.html = sanitizePresentationHtml(next.html || '');
    const normalizedImageContext = normalizeImageResultContext(next.imageContext, { messageId: next.id, sequence });
    if (normalizedImageContext) next.imageContext = stringifyContext(normalizedImageContext);
    next.presentation = buildPresentation(next);
    if (next.presentation.kind === 'image-result') {
      next.content = imageCompletionText(next, parseContext(next.imageContext));
      next.rawText = next.presentation.displayText || next.content;
      if (!next.metaText) next.metaText = extractMetricText(message.rawText || '');
    } else if (next.presentation.kind === 'attachment') {
      next.rawText = next.presentation.displayText;
    } else if (
      typeof next.rawText === 'string' && HAS_BASE64_PLACEHOLDER_RE.test(next.rawText)
      || typeof next.content === 'string' && HAS_BASE64_PLACEHOLDER_RE.test(next.content)
    ) {
      const cleanText = stripBase64Placeholder(next.rawText || next.content || '');
      next.rawText = cleanText;
      if (typeof next.content === 'string') next.content = stripBase64Placeholder(next.content) || cleanText;
      next.presentation.displayText = cleanText;
    }
    if (next.presentation.html) next.html = next.presentation.html;
    else if (next.html) next.presentation.html = next.html;
    return next;
  }

  function presentationAttachments(message = {}) {
    const presentation = buildPresentation(message);
    return presentation.kind === 'attachment' ? presentation.attachments || [] : [];
  }

  function presentationImages(message = {}) {
    const presentation = buildPresentation(message);
    return presentation.kind === 'image-result' ? presentation.images || [] : [];
  }

  const api = Object.freeze({
    SCHEMA_VERSION,
    IMAGE_COMPLETION_RE,
    parseContext,
    stringifyContext,
    legacyOrderIndex,
    messageId,
    durableMediaRef,
    normalizeImageResultContext,
    sanitizePresentationHtml,
    stripBase64Placeholder,
    extractMetricText,
    attachmentDisplayText,
    imageCompletionText,
    detectPresentationKind,
    buildPresentation,
    normalizeCanonicalMessage,
    presentationAttachments,
    presentationImages,
  });

  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  if (root) root.ChatUIMessageRecords = api;
  if (root?.window) root.window.ChatUIMessageRecords = api;
})(typeof globalThis !== 'undefined' ? globalThis : (typeof window !== 'undefined' ? window : this));
