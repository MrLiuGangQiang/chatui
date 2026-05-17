function safeFilenamePart(value = '') {
  return String(value || '')
    .replace(/[\\/:*?"<>|\u0000-\u001f]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 32) || 'assistant-answer';
}

function answerFilename({ text = '', date = new Date() } = {}) {
  const stamp = date.toISOString().slice(0, 19).replace(/[:T]/g, '-');
  const firstLine = String(text || '').split('\n').find(Boolean) || 'assistant-answer';
  return `${stamp}-${safeFilenamePart(firstLine)}.md`;
}

module.exports = { safeFilenamePart, answerFilename };
