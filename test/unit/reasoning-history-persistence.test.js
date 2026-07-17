const assert = require('assert');
const fs = require('fs');
const path = require('path');
const displayHistory = require('../../client/app/display-history-workflow');
const messageRecords = require('../../client/app/message-records');
const sessionDisplay = require('../../client/app/session-display');
const chatWorkflow = require('../../client/app/chat-workflow');

async function testCompletedReasoningIsPersistedWhenFutureReasoningIsDisabled() {
  const session = { id: 'reasoning-history', title: 'Session', messages: [], display: [] };
  const state = { sessions: [session], activeSessionId: session.id, reasoningMode: false };
  const storage = { getItem: () => null, setItem: () => {}, removeItem: () => {} };
  const workflow = sessionDisplay.createSessionDisplayWorkflow({
    getState: () => state,
    deriveSessionTitle: current => current.title || 'Session',
    compactAdjacentDuplicateMessages: items => items,
    sanitizeStoredMessage: message => message,
    messageRecords,
    localStorage: storage,
    snapshotStore: { supported: false, schedulePut: async () => {} },
  });

  await workflow.saveSessionMessages(session.id, [{
    role: 'assistant',
    content: 'Answer',
    reasoning_content: 'Persist this completed reasoning trace.',
    responseIndex: '0',
  }]);

  assert.strictEqual(
    session.messages[0].reasoning_content,
    'Persist this completed reasoning trace.',
    'disabling reasoning for future requests must not delete completed reasoning from canonical history'
  );
}

function testCompletedReasoningRendersAfterRefreshWhenReasoningIsDisabled() {
  const state = { activeSessionId: 'reasoning-history', reasoningMode: false };
  const reasoningCalls = [];
  const workflow = displayHistory.createDisplayHistoryWorkflow({
    state,
    messageRecords,
    displayItemHasRichMedia: () => false,
    extractQuoteContextFromHtml: () => '',
    addMessage: () => ({ dataset: {} }),
    updateReasoning: (node, content, options) => reasoningCalls.push({ node, content, options }),
  });

  workflow.renderMessageFromCanonical({ id: state.activeSessionId }, {
    role: 'assistant',
    content: 'Answer',
    reasoning_content: 'Restored reasoning trace.',
    responseIndex: '0',
  }, 0);

  assert.strictEqual(reasoningCalls.length, 1, 'saved reasoning should be restored even if the composer is currently disabled');
  assert.strictEqual(reasoningCalls[0].content, 'Restored reasoning trace.');
  assert.deepStrictEqual(reasoningCalls[0].options, { done: true, keepReasoning: true, restoreHistory: true });
}


async function testInFlightReasoningPersistsAfterSwitchAndReload() {
  const sessionA = {
    id: 'reasoning-a',
    title: 'Reasoning A',
    reasoningMode: true,
    reasoningType: 'high',
    messages: [],
    display: [],
  };
  const sessionB = {
    id: 'reasoning-b',
    title: 'Reasoning B',
    reasoningMode: false,
    reasoningType: 'none',
    messages: [],
    display: [],
  };
  const state = {
    sessions: [sessionA, sessionB],
    activeSessionId: sessionA.id,
    messages: sessionA.messages,
    reasoningMode: true,
    reasoningType: 'high',
    pageUnloading: false,
    disposedSessionIds: new Set(),
  };
  const storageValues = new Map();
  const snapshots = new Map();
  const storage = {
    getItem: key => storageValues.get(key) ?? null,
    setItem: (key, value) => storageValues.set(key, String(value)),
    removeItem: key => storageValues.delete(key),
  };
  const snapshotStore = {
    supported: true,
    schedulePut(snapshot) {
      snapshots.set(snapshot.id, JSON.parse(JSON.stringify(snapshot)));
      return Promise.resolve();
    },
    getSnapshot: async id => snapshots.get(id) || null,
  };
  const persistence = sessionDisplay.createSessionDisplayWorkflow({
    getState: () => state,
    getActiveSession: () => state.sessions.find(item => item.id === state.activeSessionId),
    deriveSessionTitle: current => current.title || 'Session',
    compactAdjacentDuplicateMessages: items => items,
    sanitizeStoredMessage: message => message,
    messageRecords,
    localStorage: storage,
    snapshotStore,
    constants: { SESSIONS_KEY: 'sessions', ACTIVE_SESSION_KEY: 'active' },
  });
  const requestOptions = [];
  const liveItem = { id: 'live-a', role: 'assistant', pending: '1', responseIndex: '1' };
  const run = { token: 'run-a', stopped: false, abortController: new AbortController() };
  const realtimeRenderer = callback => ({
    set: value => callback(value),
    final: value => callback(value),
  });
  const workflow = chatWorkflow.createChatWorkflow({
    state,
    loadPublicContext: async () => {},
    getConfig: () => ({ baseUrl: 'https://example.invalid', apiKey: 'test' }),
    getSessionChatModel: () => 'gpt-5-mini',
    ensureActiveRun: () => run,
    getActiveSession: () => sessionA,
    ensureChatAttachmentImageDataUrls: async items => items,
    buildChatMessagesWithAttachments: (prompt, attachments, baseMessages) => [
      ...baseMessages,
      { role: 'user', content: prompt },
    ],
    saveChatHistory: () => {},
    saveSessionMessages: (sessionId, messages) => persistence.saveSessionMessages(sessionId, messages),
    addMessage: () => ({ isConnected: false, dataset: {} }),
    pendingFeedbackHtml: text => text,
    appendSessionDisplayMessage: () => liveItem,
    persistSessionDisplay: () => Promise.resolve(),
    armStreamingOutputFocus: () => {},
    buildChatPayload: (model, messages, options) => {
      requestOptions.push({ ...options });
      return { model, messages, ...options };
    },
    buildRequestHeaders: () => ({}),
    shouldUseResponsesReasoning: () => false,
    makeClientChatJobId: () => '',
    createRealtimeRenderer: realtimeRenderer,
    shouldSuppressRunUi: () => false,
    updateLiveDisplay: () => {},
    shouldFollowScroll: () => false,
    streamManagedChatCompletions: async () => {
      state.activeSessionId = sessionB.id;
      state.messages = sessionB.messages;
      state.reasoningMode = false;
      state.reasoningType = 'none';
      return { content: 'Final answer', reasoning: 'Durable reasoning trace.', durationMs: 25 };
    },
    normalizeReasoningText: value => String(value || '').trim(),
    compactAdjacentDuplicateMessages: items => items,
    cloneMessageList: items => items.map(item => ({ ...item })),
    clearPendingFeedback: () => {},
    playDoneSound: () => {},
    isRunStopped: () => false,
    isAbortLikeError: () => false,
    formatElapsed: value => `${value}ms`,
  });

  await workflow.sendChat('Question', [], null, { sessionId: sessionA.id });
  await Promise.resolve();
  persistence.saveSessionsMeta();

  assert.deepStrictEqual(
    requestOptions[0],
    { stream: true, reasoning: true, reasoningEffort: 'high' },
    'the request must retain the target session reasoning settings even if another session becomes active'
  );
  assert.strictEqual(
    sessionA.messages.at(-1).reasoning_content,
    'Durable reasoning trace.',
    'completion must persist reasoning using request-scoped settings rather than the newly active session preference'
  );

  const reloadedState = { sessions: [], activeSessionId: '', messages: [], models: [], disposedSessionIds: new Set() };
  storage.setItem('active', sessionA.id);
  const reloadedPersistence = sessionDisplay.createSessionDisplayWorkflow({
    getState: () => reloadedState,
    getActiveSession: () => reloadedState.sessions.find(item => item.id === reloadedState.activeSessionId),
    createSession: () => ({ id: 'fallback', title: 'Fallback', messages: [], display: [] }),
    deriveSessionTitle: current => current.title || 'Session',
    readJsonStorage: (key, fallback) => {
      const value = storage.getItem(key);
      return value ? JSON.parse(value) : fallback;
    },
    compactAdjacentDuplicateMessages: items => items,
    sanitizeStoredMessage: message => message,
    messageRecords,
    localStorage: storage,
    snapshotStore,
    constants: { SESSIONS_KEY: 'sessions', ACTIVE_SESSION_KEY: 'active' },
  });

  await reloadedPersistence.loadSessions();
  assert.strictEqual(
    reloadedState.sessions.find(item => item.id === sessionA.id).messages.at(-1).reasoning_content,
    'Durable reasoning trace.',
    'a full persistence reload must restore the completed reasoning trace'
  );
}

function testHistoryRestoreBypassesOnlyTheNewRequestReasoningGuard() {
  const reasoningSource = fs.readFileSync(path.join(__dirname, '../../client/app/reasoning-workflow.js'), 'utf8');
  const appSource = fs.readFileSync(path.join(__dirname, '../../app.js'), 'utf8');

  assert.ok(
    reasoningSource.includes('if(!state.reasoningMode&&!s.restoreHistory){forceRemoveReasoning(e); return;}'),
    'the reasoning renderer must allow explicit completed-history restoration while keeping new request reasoning disabled'
  );
  assert.ok(
    appSource.includes('function updateReasoning(e,t,s={}){if(!state.reasoningMode&&!s.restoreHistory){forceRemoveReasoning(e);return}'),
    'the app-level reasoning wrapper must forward explicit completed-history restoration to the workflow'
  );
  assert.strictEqual(
    (reasoningSource.match(/if \(!state\.reasoningMode\) clearAllReasoningDisplays\(\);/g) || []).length,
    0,
    'changing the next-request reasoning preference must not clear completed response reasoning from the current view'
  );
}

module.exports = [
  testCompletedReasoningIsPersistedWhenFutureReasoningIsDisabled,
  testCompletedReasoningRendersAfterRefreshWhenReasoningIsDisabled,
  testInFlightReasoningPersistsAfterSwitchAndReload,
  testHistoryRestoreBypassesOnlyTheNewRequestReasoningGuard,
];
