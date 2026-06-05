(function (root) {
function stripLargeDataUrlsFromText(text = '') {
  return String(text || '').replace(/data:[^"'<>`\s]+;base64,[A-Za-z0-9+/=]{2048,}/g, '[attachment-data-omitted]');
}

function sanitizeAttachmentContextForStorage(value) {
  if (!value) return '';
  try {
    const context = typeof value === 'string' ? JSON.parse(value) : value;
    if (!context || typeof context !== 'object') return '';
    const sanitized = {
      ...context,
      attachments: Array.isArray(context.attachments)
        ? context.attachments.map(item => {
          const copy = { ...item };
          if (copy.src && String(copy.src).startsWith('data:')) copy.src = '';
          return copy;
        }).filter(item => item.name || item.src || item.text)
        : [],
    };
    return JSON.stringify(sanitized);
  } catch {
    return '';
  }
}

function sanitizeStoredDisplayItem(item = {}) {
  return {
    ...item,
    html: stripLargeDataUrlsFromText(item.html || ''),
    rawText: stripLargeDataUrlsFromText(item.rawText || ''),
    imageContext: sanitizeAttachmentContextForStorage(item.imageContext) || item.imageContext || '',
    attachmentContext: sanitizeAttachmentContextForStorage(item.attachmentContext),
  };
}

function sanitizeStoredMessage(message = {}) {
  const next = { ...message };
  next.content = stripLargeDataUrlsFromText(next.content || '');
  next.rawText = stripLargeDataUrlsFromText(next.rawText || '');
  if (next.html) next.html = stripLargeDataUrlsFromText(next.html);
  next.imageContext = sanitizeAttachmentContextForStorage(next.imageContext) || next.imageContext || '';
  next.attachmentContext = sanitizeAttachmentContextForStorage(next.attachmentContext);
  return next;
}

function safeSetJsonStorage(storage, key, value, maxItems = 80) {
  let items = Array.isArray(value) ? value : value ? [value] : [];
  for (let limit = Math.min(Number(maxItems) || 80, items.length || 1); limit >= 0; limit = Math.floor(limit / 2)) {
    const candidate = Array.isArray(value) ? items.slice(-limit) : value;
    try {
      storage.setItem(key, JSON.stringify(candidate));
      return candidate;
    } catch (err) {
      if (!/quota|exceed/i.test(`${err?.name || ''} ${err?.message || ''} ${err || ''}`)) throw err;
    }
    if (limit <= 1) break;
  }
  try { storage.removeItem(key); } catch {}
  return Array.isArray(value) ? [] : null;
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
  if (!job?.id) return;
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
      imageContext: job.imageContext || null,
      liveItemRawText: job.liveItemRawText || '',
    },
  ];
  for (const candidate of fallbacks) {
    try {
      storage.setItem(key, JSON.stringify(candidate));
      return;
    } catch (err) {
      if (!/quota|exceed/i.test(`${err?.name || ''} ${err?.message || ''} ${err || ''}`)) throw err;
    }
  }
  try { storage.removeItem(key); } catch {}
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
