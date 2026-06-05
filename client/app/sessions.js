(function initChatUIAppSessions(root) {
  'use strict';

  function sessionStorageKey(baseKey, sessionId) {
    return `${baseKey}:${sessionId || 'default'}`;
  }

  function deriveSessionTitle(session = {}) {
    const custom = String(session.customTitle || '').replace(/\s+/g, ' ').trim();
    if (custom) return custom.slice(0, 40);
    const firstUser = session.messages?.find(item => item.role === 'user' && item.content)?.content || '';
    const title = String(firstUser || session.title || '新对话').replace(/\s+/g, ' ').trim();
    return title ? title.slice(0, 22) : '新对话';
  }

  function getSessionReturnCount({ session, activeSessionId, activeMessages = [], isBusy = false, domCount = 0 } = {}) {
    if (!session) return 0;
    const messages = session.id !== activeSessionId || isBusy ? session.messages || [] : activeMessages;
    const assistantCount = Array.isArray(messages) ? messages.filter(item => item?.role === 'assistant').length : 0;
    if (assistantCount) return assistantCount;
    const displayCount = session.id !== activeSessionId || isBusy
      ? (session.display || []).filter(item => item?.role === 'assistant' || item?.role === 'error').length
      : domCount;
    return Array.isArray(displayCount) ? displayCount.length : Number(displayCount) || 0;
  }

  const api = Object.freeze({ sessionStorageKey, deriveSessionTitle, getSessionReturnCount });

  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  if (root) root.ChatUIAppSessions = api;
  if (root?.window) root.window.ChatUIAppSessions = api;
})(typeof globalThis !== 'undefined' ? globalThis : (typeof window !== 'undefined' ? window : this));
