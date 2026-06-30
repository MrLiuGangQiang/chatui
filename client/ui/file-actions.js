(function initChatUIFileActions(root) {
  'use strict';

const fileNames = root?.ChatUIFileNames || (typeof require === 'function' ? require('../../shared/file-names') : null);

function safeFilenamePart(value = '') {
  return fileNames?.safeFilenamePart ? fileNames.safeFilenamePart(value, 'assistant-answer', 32) : String(value || '')
    .replace(/[\\/:*?"<>|\u0000-\u001f]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 32) || 'assistant-answer';
}

function answerFilename({ text = '', date = new Date() } = {}) {
  if (fileNames?.timestampedFilename) return fileNames.timestampedFilename({ ext: 'md', date });
  const stamp = date.toISOString().slice(0, 19).replace(/[:T]/g, '-');
  return `${stamp}.md`;
}

const api = Object.freeze({ safeFilenamePart, answerFilename });

if (typeof module !== 'undefined' && module.exports) module.exports = api;
if (root) root.ChatUIFileActions = api;
if (root?.window) root.window.ChatUIFileActions = api;
})(typeof globalThis !== 'undefined' ? globalThis : (typeof window !== 'undefined' ? window : this));
