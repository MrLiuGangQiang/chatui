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

  function parseContext(value) {
    if (!value) return null;
    if (typeof value === 'string') {
      try { return parseContext(JSON.parse(value)); } catch { return null; }
    }
    return value && typeof value === 'object' && !Array.isArray(value) ? value : null;
  }

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
    const value = Number(raw);
    return Number.isFinite(value) && value >= 0 ? value : fallback;
  }

  function messageId(message = {}, { sessionId = 'session', sequence = 0 } = {}) {
    const existing = String(message.id || message.messageId || '').trim();
    if (existing) return existing;
    const role = message.role === 'assistant'
      ? 'assistant'
      : message.role === 'user'
        ? 'user'
        : message.role || 'message';
    return `${sessionId || 'session'}:${role}:${legacyOrderIndex(message, sequence)}`;
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

  function attachmentDisplayText(message = {}, context = null) {
    const parsed = context || parseContext(message.attachmentContext);
    const prompt = String(parsed?.prompt || '').trim();
    if (prompt) return prompt;
    const names = (parsed?.attachments || [])
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
      const contextImages = attachmentList(imageContext);
      presentation.images = contextImages.length ? contextImages : existing.images || [];
      presentation.displayText = imageCompletionText({ ...message, presentation: existing }, imageContext);
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

  function displayIndex(item = {}, fallback = 0) {
    const raw = item.role === 'user' ? item.messageIndex : item.responseIndex;
    const value = Number(raw);
    return Number.isFinite(value) && value >= 0 ? value : fallback;
  }

  function displayMatchesMessage(item, message, fallback = 0) {
    if (!item || !message || item.role !== message.role) return false;
    if (item.id && message.displayItemId && String(item.id) === String(message.displayItemId)) return true;
    return displayIndex(item, fallback) === legacyOrderIndex(message, fallback);
  }

  function legacyDisplayKind(item = {}) {
    if (item.role === 'assistant' && (
      htmlHasGeneratedImages(item.html)
      || hasDurableMedia(item.imageContext)
      || item.presentation?.kind === 'image-result'
    )) return 'image-result';
    if (item.role === 'user' && (
      htmlHasUserAttachments(item.html)
      || attachmentList(item.attachmentContext).length
      || item.presentation?.kind === 'attachment'
    )) return 'attachment';
    return 'text';
  }

  function desiredLegacyKind(message = {}, candidates = []) {
    const detected = detectPresentationKind(message);
    if (detected !== 'text') return detected;
    const raw = `${typeof message.content === 'string' ? message.content : ''}\n${message.rawText || ''}`;
    if (HAS_BASE64_PLACEHOLDER_RE.test(raw) && candidates.some(item => legacyDisplayKind(item) === 'image-result')) return 'image-result';
    if (/(?:^|\n)\[attachments?\]|\[(?:image|file)\s+id=|\u5df2\u53d1\u9001\u9644\u4ef6/.test(raw)
      && candidates.some(item => legacyDisplayKind(item) === 'attachment')) return 'attachment';
    return 'text';
  }

  function legacyDisplayScore(item, message, desiredKind) {
    const kind = legacyDisplayKind(item);
    let score = 0;
    if (item.id && message.displayItemId && String(item.id) === String(message.displayItemId)) score += 10000;
    if (kind === desiredKind) score += 1000;
    else if (desiredKind !== 'text' && kind !== 'text') score -= 500;
    else if (desiredKind === 'text' && kind !== 'text') score -= 200;
    if (kind === 'image-result') score += htmlHasGeneratedImages(item.html) ? 120 : 0;
    if (kind === 'attachment') score += htmlHasUserAttachments(item.html) ? 120 : 0;
    if (item.imageContext || item.attachmentContext) score += 60;
    if (String(item.html || '').trim()) score += 20;
    const raw = String(item.rawText || '').trim();
    if (raw && !HAS_BASE64_PLACEHOLDER_RE.test(raw)) score += 10;
    return score;
  }

  function selectLegacyDisplayItem(completedDisplay, message, fallback = 0) {
    const candidates = completedDisplay.filter(candidate => displayMatchesMessage(candidate, message, fallback));
    if (!candidates.length) return null;
    const desiredKind = desiredLegacyKind(message, candidates);
    return candidates.reduce((best, item) => (
      !best || legacyDisplayScore(item, message, desiredKind) > legacyDisplayScore(best, message, desiredKind)
        ? item
        : best
    ), null);
  }

  function enrichFromDisplay(message, item) {
    if (!item) return message;
    const next = { ...message };
    const itemKind = legacyDisplayKind(item);
    if (itemKind === 'image-result') {
      if (item.html) next.html = item.html;
      if (item.imageContext) next.imageContext = item.imageContext;
    } else if (itemKind === 'attachment') {
      if (item.html) next.html = item.html;
      if (item.attachmentContext) next.attachmentContext = item.attachmentContext;
      if (item.imageContext && !next.imageContext) next.imageContext = item.imageContext;
    }
    ['html', 'imageContext', 'attachmentContext', 'quoteContext', 'metaText'].forEach(key => {
      if (!next[key] && item[key]) next[key] = item[key];
    });
    if (!next.displayItemId && item.id) next.displayItemId = item.id;
    return next;
  }

  function messageFromLegacyDisplay(item = {}, { sessionId = 'session', sequence = 0 } = {}) {
    if (!item || !['user', 'assistant'].includes(item.role) || item.pending === '1') return null;
    const itemKind = legacyDisplayKind(item);
    const hasImage = item.role === 'assistant' && itemKind === 'image-result';
    const hasAttachment = item.role === 'user' && itemKind === 'attachment';
    const raw = String(item.rawText || '').trim();
    if (!hasImage && !hasAttachment && (!raw || /^\[base64 image\](?:\s|$)/i.test(raw))) return null;
    const attachmentContext = parseContext(item.attachmentContext);
    const completionText = imageCompletionText({ role: item.role, content: '', imageContext: item.imageContext });
    const message = {
      role: item.role,
      content: hasImage
        ? completionText
        : hasAttachment
          ? attachmentContext?.content || attachmentDisplayText(item, attachmentContext)
          : raw,
      rawText: hasImage ? completionText : hasAttachment ? attachmentDisplayText(item, attachmentContext) : raw,
      html: item.html || '',
      imageContext: item.imageContext || '',
      attachmentContext: item.attachmentContext || '',
      quoteContext: item.quoteContext || '',
      metaText: item.metaText || extractMetricText(raw),
      displayItemId: item.id || '',
      ...(item.role === 'user'
        ? { messageIndex: String(displayIndex(item, sequence)) }
        : { responseIndex: String(displayIndex(item, sequence)) }),
    };
    return normalizeCanonicalMessage(message, { sessionId, sequence });
  }

  function migrateLegacySession({ sessionId = 'session', messages = [], display = [] } = {}) {
    const legacyMessages = Array.isArray(messages) ? messages.filter(Boolean) : [];
    const legacyDisplay = Array.isArray(display) ? display.filter(Boolean) : [];
    const completedDisplay = legacyDisplay.filter(item => item?.pending !== '1');
    const pendingDisplay = legacyDisplay.filter(item => item?.pending === '1');
    const merged = legacyMessages.map((message, index) => {
      const item = selectLegacyDisplayItem(completedDisplay, message, index);
      return normalizeCanonicalMessage(enrichFromDisplay(message, item), {
        sessionId,
        sequence: legacyOrderIndex(message, index),
      });
    }).filter(Boolean);
    const identities = new Set(merged.map(message => `${message.role}:${legacyOrderIndex(message, message.sequence)}`));
    completedDisplay.forEach((item, index) => {
      const identity = `${item.role}:${displayIndex(item, index)}`;
      if (identities.has(identity)) return;
      const recovered = messageFromLegacyDisplay(item, { sessionId, sequence: displayIndex(item, index) });
      if (!recovered) return;
      merged.push(recovered);
      identities.add(identity);
    });
    merged.sort((a, b) => (
      legacyOrderIndex(a, a.sequence) - legacyOrderIndex(b, b.sequence)
      || (a.role === 'user' ? -1 : 1)
    ));
    return {
      schemaVersion: SCHEMA_VERSION,
      messages: merged.map((message, index) => normalizeCanonicalMessage(message, {
        sessionId,
        sequence: legacyOrderIndex(message, index),
      })),
      pendingDisplay,
    };
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
    sanitizePresentationHtml,
    stripBase64Placeholder,
    extractMetricText,
    attachmentDisplayText,
    imageCompletionText,
    detectPresentationKind,
    buildPresentation,
    normalizeCanonicalMessage,
    messageFromLegacyDisplay,
    migrateLegacySession,
    presentationAttachments,
    presentationImages,
  });

  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  if (root) root.ChatUIMessageRecords = api;
  if (root?.window) root.window.ChatUIMessageRecords = api;
})(typeof globalThis !== 'undefined' ? globalThis : (typeof window !== 'undefined' ? window : this));
