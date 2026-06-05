(function initChatUIFileActions(root) {
  'use strict';

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

const api = Object.freeze({ safeFilenamePart, answerFilename });

if (typeof module !== 'undefined' && module.exports) module.exports = api;
if (root) root.ChatUIFileActions = api;
if (root?.window) root.window.ChatUIFileActions = api;
})(typeof globalThis !== 'undefined' ? globalThis : (typeof window !== 'undefined' ? window : this));
