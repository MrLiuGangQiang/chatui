(function initChatUIAppSessionDisplay(root) {
  'use strict';

  function createSessionDisplayWorkflow(deps = {}) {
    const getState = deps.getState || (() => ({}));
    const getActiveSession = deps.getActiveSession;
    const createSession = deps.createSession;
    const deriveSessionTitle = deps.deriveSessionTitle;
    const sessionStorageKey = deps.sessionStorageKey;
    const readJsonStorage = deps.readJsonStorage;
    const safeSetJsonStorage = deps.safeSetJsonStorage;
    const compactDisplayItems = deps.compactDisplayItems;
    const compactAdjacentDuplicateMessages = deps.compactAdjacentDuplicateMessages;
    const sanitizeStoredDisplayItem = deps.sanitizeStoredDisplayItem;
    const sanitizeStoredMessage = deps.sanitizeStoredMessage;
    const renderSessionList = deps.renderSessionList || (() => {});
    const renderMarkdown = deps.renderMarkdown || (text => String(text || ''));
    const renderUserMessageContent = deps.renderUserMessageContent || (text => String(text || ''));
    const makeDisplayItemId = deps.makeDisplayItemId;
    const displayItemHasRichMedia = deps.displayItemHasRichMedia || (() => false);
    const normalizeLastGeneratedImage = deps.normalizeLastGeneratedImage || (value => value);
    const localStorageRef = deps.localStorage || root.localStorage;
    const constants = deps.constants || {};
    const CHAT_KEY = constants.CHAT_KEY || 'chat-history';
    const UI_KEY = constants.UI_KEY || 'chat-ui';
    const LAST_IMAGE_KEY = constants.LAST_IMAGE_KEY || 'last-image';
    const SESSIONS_KEY = constants.SESSIONS_KEY || 'chat-sessions';
    const ACTIVE_SESSION_KEY = constants.ACTIVE_SESSION_KEY || 'chat-active-session';

    function makeDisplayItem(role, content, { html = false, rawText = content, messageIndex = null, pending = false, responseIndex = null, jobId = '', id = '', imageContext = '', attachmentContext = '', quoteContext = '', metaText = '' } = {}) {
      return {
        id: id || makeDisplayItemId(),
        role,
        rawText: rawText || '',
        html: html ? String(content || '') : role === 'user' ? renderUserMessageContent(String(content || '')) : renderMarkdown(String(content || '')),
        reasoningText: '',
        keepReasoning: false,
        messageIndex: messageIndex != null ? String(messageIndex) : '',
        responseIndex: responseIndex != null ? String(responseIndex) : '',
        jobId: jobId || '',
        imageContext: imageContext || '',
        attachmentContext: attachmentContext || '',
        quoteContext: quoteContext || '',
        metaText: metaText || '',
        pending: pending ? '1' : '',
      };
    }

    function saveSessionsMeta() {
      const state = getState();
      try {
        const meta = state.sessions.map(session => ({
          id: session.id,
          title: deriveSessionTitle(session),
          customTitle: session.customTitle || '',
          systemPrompt: session.systemPrompt || '',
          hasSystemPromptOverride: !!session.hasSystemPromptOverride,
          imageStylePrompt: session.imageStylePrompt || '',
          hasImageStylePromptOverride: !!session.hasImageStylePromptOverride,
          chatModel: state.models.includes(session.chatModel) ? session.chatModel : '',
          headerValues: session.headerValues && typeof session.headerValues === 'object' ? session.headerValues : {},
          pendingClarification: session.pendingClarification && typeof session.pendingClarification === 'object' ? session.pendingClarification : null,
          createdAt: session.createdAt || Date.now(),
          updatedAt: session.updatedAt || Date.now(),
        }));
        localStorageRef.setItem(SESSIONS_KEY, JSON.stringify(meta));
        localStorageRef.setItem(ACTIVE_SESSION_KEY, state.activeSessionId || getActiveSession().id);
      } catch (err) { console.warn('save sessions meta failed', err); }
    }

    function persistSessionDisplay(sessionId) {
      const state = getState();
      const session = state.sessions.find(item => item.id === sessionId);
      if (!session) return;
      session.updatedAt = Date.now();
      session.display = compactDisplayItems((session.display || []).map(sanitizeStoredDisplayItem)).slice(-80);
      session.display = safeSetJsonStorage(sessionStorageKey(UI_KEY, sessionId), session.display, 80) || [];
      saveSessionsMeta();
    }

    function normalizeMessageForStorage(message) {
      const state = getState();
      if (!message || !message.role) return null;
      let content;
      if (typeof message.content === 'string') content = message.content;
      else if (Array.isArray(message.content)) content = message.content.map(item => {
        if (!item || typeof item !== 'object') return item;
        return JSON.parse(JSON.stringify(item));
      });
      else content = String(message.content || '');
      const clean = { role: message.role, content };
      ['rawText', 'imageContext', 'attachmentContext', 'quoteContext', 'messageIndex', 'responseIndex', 'kind', 'imageJobId', 'displayItemId', 'metaText'].forEach(key => {
        if (message[key] !== undefined && message[key] !== null && message[key] !== '') clean[key] = String(message[key]);
      });
      if (!clean.quoteContext && message.html) {
        const html = String(message.html || '');
        const match = html.match(/class=["'][^"']*sent-quote-preview[^"']*["'][\s\S]*?data-quote-context=(["'])([\s\S]*?)\1/i)
          || html.match(/data-quote-context=(["'])([\s\S]*?)\1[\s\S]*?class=["'][^"']*sent-quote-preview/i);
        if (match?.[2]) clean.quoteContext = match[2].replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&amp;/g, '&');
      }
      if (state.reasoningMode && message.reasoning_content !== undefined && message.reasoning_content !== null && message.reasoning_content !== '') clean.reasoning_content = String(message.reasoning_content);
      if (message.html !== undefined && message.html !== null && message.html !== '') {
        const html = String(message.html);
        if (displayItemHasRichMedia({ html })) clean.html = html;
      }
      return sanitizeStoredMessage(clean);
    }

    function saveSessionMessages(sessionId, messages) {
      const state = getState();
      const session = state.sessions.find(item => item.id === sessionId);
      if (!session) return;
      const normalized = compactAdjacentDuplicateMessages(messages).map(sanitizeStoredMessage);
      session.messages = normalized;
      session.title = deriveSessionTitle(session);
      session.updatedAt = Date.now();
      session.messages = safeSetJsonStorage(sessionStorageKey(CHAT_KEY, sessionId), normalized, 120) || [];
      saveSessionsMeta();
    }

    function appendSessionDisplayMessage(sessionId, role, content, options = {}) {
      const state = getState();
      const session = state.sessions.find(item => item.id === sessionId);
      if (!session) return null;
      session.display ||= [];
      const item = makeDisplayItem(role, content, options);
      session.display.push(item);
      session.display = compactDisplayItems(session.display).slice(-80);
      persistSessionDisplay(sessionId);
      return item;
    }

    function updateSessionDisplayItem(sessionId, item, role, content, options = {}) {
      const state = getState();
      if (!state.sessions.find(item => item.id === sessionId) || !item) return;
      item.role = role;
      item.rawText = options.rawText ?? content;
      if (options.deferPersist !== true && options.pending !== false) item.html = options.html ? String(content || '') : role === 'user' ? renderUserMessageContent(String(content || '')) : renderMarkdown(String(content || ''));
      if (!item.id) item.id = makeDisplayItemId();
      if (options.pending !== undefined) item.pending = options.pending ? '1' : '';
      if (options.id !== undefined && options.id) item.id = options.id;
      if (options.messageIndex !== undefined && options.messageIndex !== null) item.messageIndex = String(options.messageIndex);
      if (options.responseIndex !== undefined && options.responseIndex !== null) item.responseIndex = String(options.responseIndex);
      if (options.jobId !== undefined) item.jobId = options.jobId || '';
      if (options.imageContext !== undefined) item.imageContext = options.imageContext || '';
      if (options.attachmentContext !== undefined) item.attachmentContext = options.attachmentContext || '';
      if (options.quoteContext !== undefined) item.quoteContext = options.quoteContext || '';
      if (options.metaText !== undefined) item.metaText = options.metaText || '';
      const allowReasoning = !!state.reasoningMode;
      if (options.reasoning !== undefined) { item.reasoningText = allowReasoning ? options.reasoning || '' : ''; item.keepReasoning = allowReasoning && !!options.keepReasoning; }
      if (options.pending === false) { item.jobId = ''; item.pending = ''; if (!options.keepReasoning) { delete item.reasoningText; item.keepReasoning = false; } }
      if (options.deferPersist !== true) persistSessionDisplay(sessionId);
    }

    function persistDetachedResponse(sessionId, role, content, options = {}) {
      if (sessionId !== getState().activeSessionId) appendSessionDisplayMessage(sessionId, role, content, options);
    }
    function replaceLastSessionDisplayMessage(sessionId, role, content, options = {}) {
      const session = getState().sessions.find(item => item.id === sessionId);
      if (!session) return;
      session.display ||= [];
      for (let index = session.display.length - 1; index >= 0; index -= 1) {
        if (session.display[index].role === role) { updateSessionDisplayItem(sessionId, session.display[index], role, content, options); return; }
      }
      appendSessionDisplayMessage(sessionId, role, content, options);
    }
    function syncActiveSession({ skipSave = false } = {}) {
      const state = getState();
      const session = getActiveSession();
      state.messages = [...(session.messages || [])];
      state.lastGeneratedImage = normalizeLastGeneratedImage(session.lastGeneratedImage || null);
      if (session) session.lastGeneratedImage = state.lastGeneratedImage || null;
      if (!skipSave) saveSessionsMeta();
      renderSessionList();
    }
    function loadSessions() {
      const state = getState();
      let sessions = [];
      try {
        const stored = readJsonStorage(SESSIONS_KEY, []);
        if (Array.isArray(stored)) sessions = stored.filter(item => item && item.id).map(item => ({
          id: item.id,
          title: item.title || '新对话',
          customTitle: item.customTitle || '',
          systemPrompt: item.systemPrompt || '',
          hasSystemPromptOverride: !!item.hasSystemPromptOverride,
          imageStylePrompt: item.imageStylePrompt || '',
          hasImageStylePromptOverride: !!item.hasImageStylePromptOverride,
          chatModel: state.models.includes(item.chatModel) ? item.chatModel : '',
          headerValues: item.headerValues && typeof item.headerValues === 'object' ? item.headerValues : {},
          pendingClarification: item.pendingClarification && typeof item.pendingClarification === 'object' ? item.pendingClarification : null,
          createdAt: item.createdAt || Date.now(),
          updatedAt: item.updatedAt || Date.now(),
          messages: readJsonStorage(sessionStorageKey(CHAT_KEY, item.id), []),
          display: readJsonStorage(sessionStorageKey(UI_KEY, item.id), []),
          lastGeneratedImage: readJsonStorage(sessionStorageKey(LAST_IMAGE_KEY, item.id), null),
          busy: false,
        }));
      } catch (err) { console.warn('load sessions failed', err); }
      if (!sessions.length) {
        const session = createSession();
        session.title = deriveSessionTitle(session);
        sessions = [session];
      }
      state.sessions = sessions;
      const storedActiveSessionId = localStorageRef.getItem(ACTIVE_SESSION_KEY);
      state.activeSessionId = sessions.some(session => session.id === storedActiveSessionId) ? storedActiveSessionId : sessions[0].id;
      syncActiveSession({ skipSave: true });
    }
    function sessionTitleHtml(session) {
      return String(deriveSessionTitle(session)).replace(/[&<>"']/g, value => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[value]));
    }
    function getSessionReturnCount(session, { domCount = 0, isBusy = () => false } = {}) {
      const state = getState();
      if (!session) return 0;
      const messages = session.id !== state.activeSessionId || isBusy(session.id) ? session.messages || [] : state.messages;
      const assistantCount = Array.isArray(messages) ? messages.filter(item => item?.role === 'assistant').length : 0;
      if (assistantCount) return assistantCount;
      const display = session.id !== state.activeSessionId || isBusy(session.id) ? (session.display || []).filter(item => item.role === 'assistant' || item.role === 'error') : domCount;
      return Array.isArray(display) ? display.length : display;
    }

    return Object.freeze({ makeDisplayItem, normalizeMessageForStorage, persistSessionDisplay, saveSessionMessages, appendSessionDisplayMessage, updateSessionDisplayItem, persistDetachedResponse, replaceLastSessionDisplayMessage, syncActiveSession, saveSessionsMeta, loadSessions, sessionTitleHtml, getSessionReturnCount });
  }

  const api = Object.freeze({ createSessionDisplayWorkflow });
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  if (root) root.ChatUIAppSessionDisplay = api;
  if (root?.window) root.window.ChatUIAppSessionDisplay = api;
})(typeof globalThis !== 'undefined' ? globalThis : (typeof window !== 'undefined' ? window : this));
