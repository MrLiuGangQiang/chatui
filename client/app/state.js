(function initChatUIAppState(root) {
  'use strict';

  function createSession(title = '新对话', now = Date.now, random = Math.random) {
    return {
      id: `chat-${now().toString(36)}-${random().toString(36).slice(2, 8)}`,
      title,
      customTitle: '',
      messages: [],
      display: [],
      lastGeneratedImage: null,
      systemPrompt: '',
      hasSystemPromptOverride: false,
      imageStylePrompt: '',
      hasImageStylePromptOverride: false,
      chatModel: '',
      headerValues: {},
      createdAt: now(),
      updatedAt: now(),
      busy: false,
    };
  }

  function ensureActiveSession(appState, create = createSession) {
    if (!Array.isArray(appState.sessions)) appState.sessions = [];
    if (!appState.sessions.length) {
      const session = create();
      appState.sessions = [session];
      appState.activeSessionId = session.id;
    }
    let session = appState.sessions.find(item => item.id === appState.activeSessionId);
    if (!session) {
      session = appState.sessions[0];
      appState.activeSessionId = session.id;
    }
    session.messages ||= [];
    session.display ||= [];
    session.headerValues ||= {};
    session.systemPrompt ||= '';
    session.imageStylePrompt ||= '';
    session.chatModel ||= '';
    if (session.hasSystemPromptOverride !== true) session.hasSystemPromptOverride = false;
    if (session.hasImageStylePromptOverride !== true) session.hasImageStylePromptOverride = false;
    return session;
  }

  function isSessionBusy(appState, sessionId) {
    return !!appState.busySessions?.has?.(sessionId) || !!appState.sessions?.find(item => item.id === sessionId)?.busy;
  }

  const api = Object.freeze({ createSession, ensureActiveSession, isSessionBusy });

  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  if (root) root.ChatUIAppState = api;
  if (root?.window) root.window.ChatUIAppState = api;
})(typeof globalThis !== 'undefined' ? globalThis : (typeof window !== 'undefined' ? window : this));
