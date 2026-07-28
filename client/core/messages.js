function cloneMessageList(messages = []) {
  return JSON.parse(JSON.stringify(Array.isArray(messages) ? messages : []));
}

function normalizeMessageOrderFields(message, index = 0) {
  const next = { ...message };
  if (next.role === 'user') {
    if (next.messageIndex === undefined || next.messageIndex === null || next.messageIndex === '') next.messageIndex = index;
  } else if (next.role === 'assistant') {
    if (next.responseIndex === undefined || next.responseIndex === null || next.responseIndex === '') next.responseIndex = index;
  }
  return next;
}

function messageSortIndex(message, fallback) {
  const raw = message?.role === 'assistant' ? message.responseIndex : message?.messageIndex;
  const index = Number(raw);
  return Number.isFinite(index) ? index : fallback;
}

function roleSortWeight(role) {
  if (role === 'system') return 0;
  if (role === 'user') return 1;
  if (role === 'assistant') return 2;
  return 3;
}

function sortCanonicalMessages(messages = []) {
  return [...messages]
    .map((message, fallback) => ({
      message: normalizeMessageOrderFields(message, fallback),
      fallback,
    }))
    .sort((a, b) => {
      const diff = messageSortIndex(a.message, a.fallback) - messageSortIndex(b.message, b.fallback);
      if (diff) return diff;
      const roleDiff = roleSortWeight(a.message?.role) - roleSortWeight(b.message?.role);
      return roleDiff || a.fallback - b.fallback;
    })
    .map(item => item.message);
}

function mergeDuplicateMessageMeta(prev, message) {
  if (!prev || !message || prev.role !== message.role) return prev;
  return {
    ...prev,
    ...(!prev.metaText && message.metaText ? { metaText: message.metaText } : {}),
    ...(!prev.rawText && message.rawText ? { rawText: message.rawText } : {}),
    ...(!prev.html && message.html ? { html: message.html } : {}),
    ...(!prev.displayItemId && message.displayItemId ? { displayItemId: message.displayItemId } : {}),
    ...(!prev.imageJobId && message.imageJobId ? { imageJobId: message.imageJobId } : {}),
  };
}

function compactAdjacentDuplicateMessages(messages = []) {
  const result = [];
  for (const message of messages) {
    const prev = result[result.length - 1];
    const raw = String(message?.rawText ?? message?.content ?? '').trim();
    const prevRaw = String(prev?.rawText ?? prev?.content ?? '').trim();
    if (prev && prev.role === message.role && prevRaw === raw && raw) {
      result[result.length - 1] = mergeDuplicateMessageMeta(prev, message);
      continue;
    }
    result.push(message);
  }
  return result;
}

function sanitizeStoredMessage(message = {}) {
  const next = { ...message };
  delete next.pending;
  delete next.streaming;
  if (next.rawText === undefined && typeof next.content === 'string') next.rawText = next.content;
  return next;
}

function assistantMessageCount(messages = []) {
  return messages.filter(message => message?.role === 'assistant').length;
}

module.exports = {
  cloneMessageList,
  normalizeMessageOrderFields,
  sortCanonicalMessages,
  compactAdjacentDuplicateMessages,
  sanitizeStoredMessage,
  assistantMessageCount,
};
