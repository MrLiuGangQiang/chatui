(function (root) {
function stripLargeDataUrlsFromText(text = '') {
  return String(text || '').replace(/data:[^"'<>`\s]+;base64,[A-Za-z0-9+/=]{2048,}/g, '[attachment-data-omitted]');
}

const TRANSIENT_MEDIA_FIELD_RE = /^(?:url|src|image|image_url|dataUrl|data_url|previewSrc|preview_src|objectUrl|object_url)$/i;
const TRANSIENT_MEDIA_ARRAY_RE = /^(?:images?|attachments?)$/i;

function sanitizeStorageValue(value, parentKey = '') {
  if (typeof value === 'string') {
    if ((TRANSIENT_MEDIA_FIELD_RE.test(parentKey) || TRANSIENT_MEDIA_ARRAY_RE.test(parentKey)) && /^(?:data:|blob:)/i.test(value)) return '';
    return stripLargeDataUrlsFromText(value);
  }
  if (Array.isArray(value)) return value.map(item => sanitizeStorageValue(item, parentKey)).filter(item => item !== '');
  if (value && typeof value === 'object') {
    const copy = { ...value };
    Object.keys(copy).forEach(key => { copy[key] = sanitizeStorageValue(copy[key], key); });
    return copy;
  }
  return value;
}

function sanitizeAttachmentContextForStorage(value) {
  if (!value) return '';
  try {
    const context = typeof value === 'string' ? JSON.parse(value) : value;
    if (!context || typeof context !== 'object' || Array.isArray(context)) return '';
    const sanitized = sanitizeStorageValue(context);
    if (Array.isArray(sanitized.attachments)) {
      sanitized.attachments = sanitized.attachments.filter(item => item && typeof item === 'object' && (
        item.name || item.filename || item.src || item.url || item.text || item.id || item.attachmentId || item.attachment_id || item.imageId || item.image_id
      ));
    }
    return JSON.stringify(sanitized);
  } catch {
    return '';
  }
}

function sanitizeStoredDisplayItem(item = {}) {
  const next = {
    ...item,
    html: stripLargeDataUrlsFromText(item.html || '').replace(/\s(?:src|href|data-persisted-src|data-original-src|data-object-url|data-preview-object-url)=(['"])(?:data:|blob:|[^'"]*\[(?:attachment|image)-data-omitted\])[^'"]*\1/gi, ''),
    rawText: stripLargeDataUrlsFromText(item.rawText || ''),
    imageContext: sanitizeAttachmentContextForStorage(item.imageContext) || item.imageContext || '',
    attachmentContext: sanitizeAttachmentContextForStorage(item.attachmentContext),
  };
  if (next.presentation && typeof next.presentation === 'object' && !Array.isArray(next.presentation)) {
    next.presentation = sanitizeStorageValue(next.presentation);
    if (next.presentation.html) next.presentation.html = stripLargeDataUrlsFromText(next.presentation.html).replace(/\s(?:src|href|data-persisted-src|data-original-src|data-object-url|data-preview-object-url)=(['"])(?:data:|blob:|[^'"]*\[(?:attachment|image)-data-omitted\])[^'"]*\1/gi, '');
  }
  return next;
}

function sanitizeStoredMessage(message = {}) {
  const next = { ...message };
  next.content = stripLargePayloadData(next.content ?? '');
  next.rawText = stripLargeDataUrlsFromText(next.rawText || '');
  if (next.html) next.html = stripLargeDataUrlsFromText(next.html);
  next.imageContext = sanitizeAttachmentContextForStorage(next.imageContext) || next.imageContext || '';
  next.attachmentContext = sanitizeAttachmentContextForStorage(next.attachmentContext);
  if (next.presentation && typeof next.presentation === 'object' && !Array.isArray(next.presentation)) {
    next.presentation = sanitizeStorageValue(next.presentation);
    if (next.presentation.html) next.presentation.html = stripLargeDataUrlsFromText(next.presentation.html).replace(/\s(?:src|href|data-persisted-src|data-original-src|data-object-url|data-preview-object-url)=(['"])(?:data:|blob:|[^'"]*\[(?:attachment|image)-data-omitted\])[^'"]*\1/gi, '');
  }
  return next;
}

function safeSetJsonStorage(storage, key, value, maxItems = 80) {
  try {
    storage.setItem(key, JSON.stringify(value));
  } catch (err) {
    if (!/quota|exceed/i.test(`${err?.name || ''} ${err?.message || ''} ${err || ''}`)) throw err;
    try { root?.console?.warn?.('localStorage backup quota exceeded; full session history retained in memory/IndexedDB', key); } catch {}
  }
  return value;
}

function stripLargePayloadData(value) {
  if (typeof value === 'string') return stripLargeDataUrlsFromText(value);
  if (Array.isArray(value)) return value.map(stripLargePayloadData);
  if (value && typeof value === 'object') {
    const copy = { ...value };
    if (Array.isArray(copy.messages)) copy.messages = copy.messages.slice(-20);
    Object.keys(copy).forEach(key => { copy[key] = stripLargePayloadData(copy[key]); });
    return copy;
  }
  return value;
}

function compactJobForStorage(job, keepPayload = true) {
  if (!job || typeof job !== 'object') return job;
  const copy = { ...job };
  if (copy.payload) copy.payload = keepPayload ? stripLargePayloadData(copy.payload) : null;
  return copy;
}

function safeSetJobStorage(storage, key, job) {
  if (!job?.id) return null;
  const fallbacks = [
    compactJobForStorage(job, true),
    compactJobForStorage(job, false),
    {
      id: job.id,
      prompt: job.prompt || '',
      startedAt: job.startedAt || Date.now(),
      displayItemId: job.displayItemId || '',
      responseIndex: job.responseIndex ?? null,
      mode: job.mode || '',
      api: job.api || 'chat',
      submissionId: job.submissionId || '',
      imageContext: job.imageContext || null,
      liveItemRawText: job.liveItemRawText || '',
    },
  ];
  for (const candidate of fallbacks) {
    try {
      storage.setItem(key, JSON.stringify(candidate));
      return candidate;
    } catch (err) {
      if (!/quota|exceed/i.test(`${err?.name || ''} ${err?.message || ''} ${err || ''}`)) throw err;
    }
  }
  return null;
}

const persistenceApi = Object.freeze({
  stripLargeDataUrlsFromText,
  sanitizeAttachmentContextForStorage,
  sanitizeStoredDisplayItem,
  sanitizeStoredMessage,
  safeSetJsonStorage,
  stripLargePayloadData,
  compactJobForStorage,
  safeSetJobStorage,
});
if (typeof module !== 'undefined' && module.exports) module.exports = persistenceApi;
if (root) root.ChatUIAppPersistence = persistenceApi;
if (root?.window) root.window.ChatUIAppPersistence = persistenceApi;
})(typeof globalThis !== 'undefined' ? globalThis : (typeof window !== 'undefined' ? window : this));
