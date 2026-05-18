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
  return session;
}

function isSessionBusy(appState, sessionId) {
  return !!appState.busySessions?.has?.(sessionId) || !!appState.sessions?.find(item => item.id === sessionId)?.busy;
}

module.exports = { createSession, ensureActiveSession, isSessionBusy };
