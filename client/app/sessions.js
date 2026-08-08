(function initChatUIAppSessions(root) {
  'use strict';

  function sessionStorageKey(baseKey, sessionId) {
    return `${baseKey}:${sessionId || 'default'}`;
  }

  function isGenericGreeting(text = '') {
    const value = String(text || '').trim().toLowerCase();
    if (!value) return false;
    return /^(?:你好|您好|hello|hi|hey|哈喽|嗨|在吗|在么|早上好|中午好|晚上好|下午好|good\s*morning|good\s*afternoon|good\s*evening)[!！。.，,\s~～]*$/i.test(value);
  }

  function userText(message = {}) {
    const content = message?.content;
    if (typeof content === 'string') return content;
    if (Array.isArray(content)) {
      return content
        .map(part => String(part?.text || part?.input_text || part?.content || '').trim())
        .filter(Boolean)
        .join(' ');
    }
    return String(message?.rawText || message?.text || '');
  }

  function deriveSessionTitle(session = {}) {
    const custom = String(session.customTitle || '').replace(/\s+/g, ' ').trim();
    if (custom) return custom.slice(0, 40);
    const stored = String(session.title || '').replace(/\s+/g, ' ').trim();
    const users = (Array.isArray(session.messages) ? session.messages : [])
      .filter(item => item?.role === 'user' && userText(item).trim());
    if (!users.length) return stored ? stored.slice(0, 22) : '新对话';
    // An established descriptive title stays stable; only generic placeholders
    // (greetings and the default label) are replaced by the first real topic.
    if (stored && stored !== '新对话' && !isGenericGreeting(stored)) return stored.slice(0, 22);
    const texts = users.map(item => userText(item).replace(/\s+/g, ' ').trim());
    const firstReal = texts.find(text => !isGenericGreeting(text));
    const title = firstReal || texts[texts.length - 1] || stored || '新对话';
    return title.slice(0, 22);
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
