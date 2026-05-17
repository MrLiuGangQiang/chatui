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
      if (!/quota|exceed/i.test(String(err?.name || err?.message || err))) throw err;
    }
    if (limit <= 1) break;
  }
  try { storage.removeItem(key); } catch {}
  return Array.isArray(value) ? [] : null;
}

module.exports = {
  stripLargeDataUrlsFromText,
  sanitizeAttachmentContextForStorage,
  sanitizeStoredDisplayItem,
  sanitizeStoredMessage,
  safeSetJsonStorage,
};
