(function initChatUIAppSessionPersistence(root) {
  'use strict';

  function normalizeMessageOrderFields(messages = []) {
    let next = 0;
    return (Array.isArray(messages) ? messages : []).map(message => {
      if (!message || !message.role) return message;
      const copy = { ...message };
      const raw = message.role === 'user' ? Number(message.messageIndex) : Number(message.responseIndex);
      const index = Number.isFinite(raw) ? raw : next;
      if (message.role === 'user') copy.messageIndex = String(index);
      if (message.role === 'assistant') copy.responseIndex = String(index);
      next = Math.max(next, index + 1);
      return copy;
    });
  }

  function messageSortIndex(message, fallback) {
    const value = message?.role === 'user' ? Number(message.messageIndex) : message?.role === 'assistant' ? Number(message.responseIndex) : NaN;
    return Number.isFinite(value) ? value : fallback;
  }
  function roleSortWeight(role) { return role === 'system' ? 0 : role === 'user' ? 1 : role === 'assistant' ? 2 : 3; }
  function sortCanonicalMessages(messages = []) {
    return normalizeMessageOrderFields(messages).map((msg, fallback) => ({ msg, fallback })).sort((a, b) => {
      const byIndex = messageSortIndex(a.msg, a.fallback) - messageSortIndex(b.msg, b.fallback);
      if (byIndex) return byIndex;
      const byRole = roleSortWeight(a.msg?.role) - roleSortWeight(b.msg?.role);
      return byRole || a.fallback - b.fallback;
    }).map(item => item.msg);
  }

  function cloneMessageList(messages = [], normalizeMessageForStorage = value => value) {
    return messages.map(item => normalizeMessageForStorage(item)).filter(Boolean);
  }
  function mergeMessageMeta(current, next) {
    return current && next && current.role === next.role && current.content === next.content ? {
      ...current,
      ...(!current.metaText && next.metaText ? { metaText: next.metaText } : {}),
      ...(!current.rawText && next.rawText ? { rawText: next.rawText } : {}),
      ...(!current.html && next.html ? { html: next.html } : {}),
      ...(!current.displayItemId && next.displayItemId ? { displayItemId: next.displayItemId } : {}),
      ...(!current.imageJobId && next.imageJobId ? { imageJobId: next.imageJobId } : {}),
      ...(!current.quoteContext && next.quoteContext ? { quoteContext: next.quoteContext } : {}),
      ...(!current.imageContext && next.imageContext ? { imageContext: next.imageContext } : {}),
      ...(!current.attachmentContext && next.attachmentContext ? { attachmentContext: next.attachmentContext } : {}),
      ...(!current.reasoning_content && next.reasoning_content ? { reasoning_content: next.reasoning_content } : {}),
    } : current;
  }
  function compactAdjacentDuplicateMessages(messages = [], normalizeMessageForStorage = value => value) {
    const result = [];
    for (const message of sortCanonicalMessages(messages).map(normalizeMessageForStorage).filter(Boolean)) {
      const previous = result[result.length - 1];
      if (previous && previous.role === message.role && previous.content === message.content) result[result.length - 1] = mergeMessageMeta(previous, message);
      else result.push(message);
    }
    return result;
  }
  function compactDisplayItems(items = []) {
    const result = [];
    for (const item of items || []) {
      if (!item) continue;
      const previous = result[result.length - 1];
      const key = [item.role || '', item.rawText || '', item.html || '', item.pending || '', item.jobId || '', item.responseIndex || '', item.messageIndex || '', item.quoteContext || ''].join('');
      const prevKey = previous ? [previous.role || '', previous.rawText || '', previous.html || '', previous.pending || '', previous.jobId || '', previous.responseIndex || '', previous.messageIndex || '', previous.quoteContext || ''].join('') : '';
      if (previous && key === prevKey) {
        if (item.metaText && !previous.metaText) previous.metaText = item.metaText;
        if (item.reasoningText && !previous.reasoningText) previous.reasoningText = item.reasoningText;
        if (item.keepReasoning && !previous.keepReasoning) previous.keepReasoning = item.keepReasoning;
        if (item.quoteContext && !previous.quoteContext) previous.quoteContext = item.quoteContext;
        if (item.imageContext && !previous.imageContext) previous.imageContext = item.imageContext;
        if (item.attachmentContext && !previous.attachmentContext) previous.attachmentContext = item.attachmentContext;
      } else result.push(item);
    }
    return result;
  }

  function stripGeneratedImageActionMarkup(html = '', documentRef = root.document) {
    const text = String(html || '');
    if (!/(data-(?:download|copy|share)-image|image-download-row|generated-image-actions|image-icon-btn)/i.test(text)) return text;
    try {
      const template = documentRef.createElement('template');
      template.innerHTML = text;
      template.content.querySelectorAll('.image-download-row,.generated-image-actions,button[data-download-image],button[data-copy-image],button[data-share-image],a[data-download-image],a[data-copy-image],a[data-share-image],.generated-image-item > .image-icon-btn').forEach(node => node.remove());
      return template.innerHTML;
    } catch { return text; }
  }
  function stripTransientBlobUrlsFromHtml(html = '', documentRef = root.document) {
    const stripped = stripGeneratedImageActionMarkup(String(html || '').replace(/\s(?:src|href)=(['"])blob:[^'"]*\1/gi, '').replace(/\sdata-object-url=(['"])blob:[^'"]*\1/gi, '').replace(/\sdata-preview-object-url=(['"])blob:[^'"]*\1/gi, ''), documentRef);
    try {
      const template = documentRef.createElement('template');
      template.innerHTML = stripped;
      template.content.querySelectorAll('img').forEach(img => {
        const src = img.getAttribute('src') || '';
        const persisted = img.getAttribute('data-persisted-src') || '';
        const srcOmitted = src.includes('attachment-data-omitted') || src.includes('image-data-omitted');
        const persistedOmitted = persisted.includes('attachment-data-omitted') || persisted.includes('image-data-omitted');
        if (!srcOmitted && !persistedOmitted) return;
        if (srcOmitted) img.removeAttribute('src');
        if (persistedOmitted) img.removeAttribute('data-persisted-src');
        const remainingPersisted = img.getAttribute('data-persisted-src') || '';
        if (!remainingPersisted) {
          img.classList.add('image-missing');
          if (!img.getAttribute('alt')) img.setAttribute('alt', '图片数据已省略');
        }
      });
      template.content.querySelectorAll('img[data-persisted-src], img[src^="indexeddb://"]').forEach(img => {
        const persisted = img.getAttribute('data-persisted-src') || img.getAttribute('src') || '';
        const currentSrc = img.getAttribute('src') || '';
        if (persisted && !img.getAttribute('data-persisted-src')) img.setAttribute('data-persisted-src', persisted);
        if (persisted && !img.getAttribute('data-original-src')) img.setAttribute('data-original-src', persisted);
        const shouldRemoveSrc = persisted.startsWith('indexeddb://') && (!currentSrc || currentSrc.startsWith('indexeddb://') || /^undefined|null$/i.test(currentSrc) || currentSrc.includes('[attachment-data-omitted]'));
        if (shouldRemoveSrc) img.removeAttribute('src');
      });
      return template.innerHTML;
    } catch {
      return stripped
        .replace(/(<img\b[^>]*?)\ssrc=(['"])[^'"]*(?:attachment-data-omitted|image-data-omitted)[^'"]*\2/gi, '$1')
        .replace(/(<img\b[^>]*?)\sdata-persisted-src=(['"])[^'"]*(?:attachment-data-omitted|image-data-omitted)[^'"]*\2/gi, '$1')
        .replace(/(<img\b[^>]*?)\ssrc=(['"])(indexeddb:\/\/[^'"]*)\2/gi, (_all, before, quote, src) => `${before} data-persisted-src=${quote}${src}${quote}`);
    }
  }
  function sanitizeAttachmentContextForStorage(value) {
    if (!value) return '';
    try {
      const context = typeof value === 'string' ? JSON.parse(value) : value;
      if (!context || typeof context !== 'object') return '';
      const clean = { ...context, attachments: Array.isArray(context.attachments) ? context.attachments.map(item => { const copy = { ...item }; if (copy.src && String(copy.src).startsWith('data:')) copy.src = ''; return copy; }).filter(item => item.name || item.src || item.text) : [] };
      return JSON.stringify(clean);
    } catch { return ''; }
  }

  function escapeRegExp(value = '') {
    return String(value || '').replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  }
  function stripLeadingMessageMeta(text = '', metaText = '') {
    let result = String(text || '');
    const meta = String(metaText || '').trim();
    if (meta) result = result.replace(new RegExp(`^\\s*${escapeRegExp(meta)}\\s*(?:\\n+|$)`, 'i'), '');
    return result.replace(/^\s*(?:TTFT|RT)\s+\d+(?:\.\d+)?\s*(?:ms|s)(?:\s*·\s*(?:TTFT|RT)\s+\d+(?:\.\d+)?\s*(?:ms|s))*\s*(?:\n+|$)/i, '');
  }
  function displayHtmlHasRichMedia(html = '') {
    return /data-persisted-src=|data-persisted-href=|user-attachment-preview-grid|class=["'][^"']*(?:generated-thumb|user-attachment-image)|image-download-row/i.test(String(html || ''));
  }
  function sanitizeStoredDisplayItem(item = {}, deps = {}) {
    const stripLargeDataUrlsFromText = deps.stripLargeDataUrlsFromText || (text => String(text || ''));
    const clean = { ...item };
    const rawText = stripLargeDataUrlsFromText(clean.rawText || '');
    clean.rawText = stripLeadingMessageMeta(rawText, clean.metaText);
    clean.html = stripTransientBlobUrlsFromHtml(stripLargeDataUrlsFromText(clean.html || ''), deps.document);
    if (clean.rawText !== rawText && clean.html && !displayHtmlHasRichMedia(clean.html)) clean.html = '';
    clean.imageContext = sanitizeAttachmentContextForStorage(clean.imageContext);
    clean.attachmentContext = sanitizeAttachmentContextForStorage(clean.attachmentContext);
    return clean;
  }
  function sanitizeStoredMessage(message = {}, deps = {}) {
    const stripLargeDataUrlsFromText = deps.stripLargeDataUrlsFromText || (text => String(text || ''));
    const sanitizeValue = (value, parentKey = '') => {
      if (typeof value === 'string') {
        if (/^(url|src|image|image_url|dataUrl|data_url)$/i.test(parentKey) && /^data:/i.test(value)) return '[attachment-data-omitted]';
        return stripLargeDataUrlsFromText(value);
      }
      if (Array.isArray(value)) return value.map(item => sanitizeValue(item, ''));
      if (value && typeof value === 'object') {
        const copy = { ...value };
        Object.keys(copy).forEach(key => { copy[key] = sanitizeValue(copy[key], key); });
        return copy;
      }
      return value;
    };
    const clean = { ...message };
    clean.content = sanitizeValue(clean.content ?? '');
    if (typeof clean.content === 'string') clean.content = stripLeadingMessageMeta(clean.content, clean.metaText);
    const rawText = stripLargeDataUrlsFromText(clean.rawText || '');
    clean.rawText = stripLeadingMessageMeta(rawText, clean.metaText);
    clean.html = stripTransientBlobUrlsFromHtml(stripLargeDataUrlsFromText(clean.html || ''), deps.document);
    if ((clean.rawText !== rawText || (typeof message.content === 'string' && clean.content !== message.content)) && clean.html && !displayHtmlHasRichMedia(clean.html)) clean.html = '';
    clean.imageContext = sanitizeAttachmentContextForStorage(clean.imageContext);
    clean.attachmentContext = sanitizeAttachmentContextForStorage(clean.attachmentContext);
    return clean;
  }

  function safeSetJsonStorage(key, value, maxItems = 80, storage = root.localStorage) {
    let list = Array.isArray(value) ? value : value ? [value] : [];
    for (let count = Math.min(Number(maxItems) || 80, list.length || 1); count >= 0; count = Math.floor(count / 2)) {
      const payload = Array.isArray(value) ? list.slice(-count) : value;
      try { storage.setItem(key, JSON.stringify(payload)); return payload; }
      catch (err) { if (!/quota|exceed/i.test(String(err?.name || err?.message || err))) throw err; }
      if (count <= 1) break;
    }
    try { storage.removeItem(key); } catch {}
    return Array.isArray(value) ? [] : null;
  }
  function stripLargePayloadData(value, stripLargeDataUrlsFromText = text => String(text || '')) {
    if (typeof value === 'string') return stripLargeDataUrlsFromText(value);
    if (Array.isArray(value)) return value.map(item => stripLargePayloadData(item, stripLargeDataUrlsFromText));
    if (value && typeof value === 'object') {
      const copy = { ...value };
      if (Array.isArray(copy.messages)) copy.messages = copy.messages.slice(-20);
      Object.keys(copy).forEach(key => { copy[key] = stripLargePayloadData(copy[key], stripLargeDataUrlsFromText); });
      return copy;
    }
    return value;
  }
  function compactJobForStorage(job, keepPayload = true, stripLargeDataUrlsFromText = text => String(text || '')) {
    if (!job || typeof job !== 'object') return job;
    const copy = { ...job };
    if (copy.payload) copy.payload = keepPayload ? stripLargePayloadData(copy.payload, stripLargeDataUrlsFromText) : null;
    return copy;
  }
  function safeSetJobStorage(key, job, { storage = root.localStorage, stripLargeDataUrlsFromText = text => String(text || '') } = {}) {
    if (!job?.id) return;
    const candidates = [
      compactJobForStorage(job, true, stripLargeDataUrlsFromText),
      compactJobForStorage(job, false, stripLargeDataUrlsFromText),
      { id: job.id, prompt: job.prompt || '', startedAt: job.startedAt || Date.now(), displayItemId: job.displayItemId || '', responseIndex: job.responseIndex ?? null, mode: job.mode || '', imageContext: job.imageContext || null, liveItemRawText: job.liveItemRawText || '' },
    ];
    for (const candidate of candidates) try { storage.setItem(key, JSON.stringify(candidate)); return; } catch (err) { if (!/quota|exceed/i.test(String(err?.name || err?.message || err))) throw err; }
    try { storage.removeItem(key); } catch {}
  }

  const api = Object.freeze({ normalizeMessageOrderFields, messageSortIndex, roleSortWeight, sortCanonicalMessages, cloneMessageList, mergeMessageMeta, compactAdjacentDuplicateMessages, compactDisplayItems, stripGeneratedImageActionMarkup, stripTransientBlobUrlsFromHtml, sanitizeAttachmentContextForStorage, sanitizeStoredDisplayItem, sanitizeStoredMessage, safeSetJsonStorage, stripLargePayloadData, compactJobForStorage, safeSetJobStorage });
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  if (root) root.ChatUIAppSessionPersistence = api;
  if (root?.window) root.window.ChatUIAppSessionPersistence = api;
})(typeof globalThis !== 'undefined' ? globalThis : (typeof window !== 'undefined' ? window : this));
