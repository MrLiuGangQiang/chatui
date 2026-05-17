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

function sortCanonicalMessages(messages = []) {
  return [...messages].sort((a, b) => {
    const ai = Number(a.role === 'assistant' ? a.responseIndex : a.messageIndex);
    const bi = Number(b.role === 'assistant' ? b.responseIndex : b.messageIndex);
    const ao = Number.isFinite(ai) ? ai : Number.MAX_SAFE_INTEGER;
    const bo = Number.isFinite(bi) ? bi : Number.MAX_SAFE_INTEGER;
    if (ao !== bo) return ao - bo;
    if (a.role === b.role) return 0;
    return a.role === 'user' ? -1 : 1;
  });
}

function compactAdjacentDuplicateMessages(messages = []) {
  const result = [];
  for (const message of messages) {
    const prev = result[result.length - 1];
    const raw = String(message?.rawText ?? message?.content ?? '').trim();
    const prevRaw = String(prev?.rawText ?? prev?.content ?? '').trim();
    if (prev && prev.role === message.role && prevRaw === raw && raw) continue;
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
