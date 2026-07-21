'use strict';

const assert = require('assert');
const sessionDisplay = require('../../client/app/session-display');
const sessionPersistence = require('../../client/app/session-persistence');
const messageRecords = require('../../client/app/message-records');
const appState = require('../../client/app/state');

function createStorage(initial = {}) {
  const values = new Map(Object.entries(initial).map(([key, value]) => [key, typeof value === 'string' ? value : JSON.stringify(value)]));
  return {
    getItem: key => values.has(key) ? values.get(key) : null,
    setItem: (key, value) => values.set(key, String(value)),
    removeItem: key => values.delete(key),
  };
}

function createWorkflow({ storage, state, snapshotStore, snapshotCommitWaitMs, snapshotFallbackTailCount, logger }) {
  return sessionDisplay.createSessionDisplayWorkflow({
    getState: () => state,
    getActiveSession: () => state.sessions.find(item => item.id === state.activeSessionId),
    createSession: appState.createSession,
    deriveSessionTitle: session => session.title || 'New chat',
    readJsonStorage: (key, fallback) => {
      try {
        const raw = storage.getItem(key);
        return raw ? JSON.parse(raw) : fallback;
      } catch {
        return fallback;
      }
    },
    compactDisplayItems: items => items,
    compactAdjacentDuplicateMessages: sessionPersistence.compactAdjacentDuplicateMessages,
    sanitizeStoredDisplayItem: sessionPersistence.sanitizeStoredDisplayItem,
    sanitizeStoredMessage: sessionPersistence.sanitizeStoredMessage,
    renderSessionList: () => {},
    localStorage: storage,
    messageRecords,
    snapshotStore,
    snapshotCommitWaitMs,
    snapshotFallbackTailCount,
    logger: logger || { warn() {} },
    constants: {
      SESSIONS_KEY: 'sessions',
      ACTIVE_SESSION_KEY: 'active',
    },
  });
}

function createState() {
  return { sessions: [], activeSessionId: '', messages: [], models: [], reasoningMode: false };
}

async function testCurrentSnapshotFormatLoadsNormally() {
  const sessionId = 'current-session';
  const storage = createStorage({
    sessions: [{ id: sessionId, title: 'Current', updatedAt: 20 }],
    active: sessionId,
  });
  const state = createState();
  let writes = 0;
  const workflow = createWorkflow({
    storage,
    state,
    snapshotStore: {
      supported: true,
      getSnapshot: async () => ({
        id: sessionId,
        snapshotVersion: 2,
        updatedAt: 30,
        messages: [
          { role: 'user', content: 'hello', messageIndex: '0' },
          { role: 'assistant', content: 'world', responseIndex: '1' },
        ],
        pendingDisplay: [{ id: 'pending', role: 'assistant', rawText: 'working', pending: '1' }],
        lastGeneratedImage: { src: 'indexeddb://latest-image' },
      }),
      schedulePut: async () => { writes += 1; },
    },
  });

  await workflow.loadSessions();

  assert.deepStrictEqual(state.messages.map(item => item.content), ['hello', 'world']);
  assert.deepStrictEqual(state.sessions[0].display.map(item => item.id), ['pending']);
  assert.deepStrictEqual(state.sessions[0].lastGeneratedImage, { src: 'indexeddb://latest-image' });
  assert.strictEqual(state.sessions[0].snapshotUpdatedAt, 30);
  assert.strictEqual(writes, 0, 'loading a current snapshot must not rewrite it');
}

async function testLegacyLocalStoragePayloadIsIgnored() {
  const sessionId = 'legacy-local-storage';
  const storage = createStorage({
    sessions: [{ id: sessionId, title: 'Legacy', updatedAt: 20 }],
    active: sessionId,
    [`chat:${sessionId}`]: [{ role: 'user', content: 'legacy message', messageIndex: '0' }],
    [`ui:${sessionId}`]: [{ id: 'legacy-answer', role: 'assistant', rawText: 'legacy answer', responseIndex: '1' }],
    [`image:${sessionId}`]: { src: 'indexeddb://legacy-image' },
  });
  const state = createState();
  let writes = 0;
  const workflow = createWorkflow({
    storage,
    state,
    snapshotStore: {
      supported: true,
      getSnapshot: async () => null,
      schedulePut: async () => { writes += 1; },
    },
  });

  await workflow.loadSessions();

  assert.deepStrictEqual(state.messages, [], 'per-session localStorage history is no longer loaded');
  assert.deepStrictEqual(state.sessions[0].display, []);
  assert.strictEqual(state.sessions[0].lastGeneratedImage, null);
  assert.strictEqual(writes, 0, 'legacy localStorage history must not be migrated');
}

async function testVersionOneSnapshotIsIgnored() {
  const sessionId = 'snapshot-v1';
  const storage = createStorage({
    sessions: [{ id: sessionId, title: 'Old snapshot', updatedAt: 20 }],
    active: sessionId,
  });
  const state = createState();
  let writes = 0;
  const workflow = createWorkflow({
    storage,
    state,
    snapshotStore: {
      supported: true,
      getSnapshot: async () => ({
        id: sessionId,
        snapshotVersion: 1,
        updatedAt: 15,
        messages: [{ role: 'user', content: 'old snapshot message', messageIndex: '0' }],
        display: [{ id: 'old-answer', role: 'assistant', rawText: 'old answer', responseIndex: '1' }],
      }),
      schedulePut: async () => { writes += 1; },
    },
  });

  await workflow.loadSessions();
  const reloaded = await workflow.reloadSessionSnapshot(sessionId);

  assert.deepStrictEqual(state.messages, [], 'snapshotVersion 1 history is no longer loaded');
  assert.strictEqual(state.sessions[0].snapshotUpdatedAt, 0);
  assert.strictEqual(reloaded, false, 'snapshotVersion 1 history must also be ignored by live reload');
  assert.strictEqual(writes, 0, 'snapshotVersion 1 history must not be migrated');
}


async function testStalledSnapshotWriteReleasesCompletionAndKeepsRecoverableFallback() {
  const sessionId = 'stalled-snapshot';
  const storage = createStorage({
    sessions: [{ id: sessionId, title: 'Stalled snapshot', updatedAt: 20 }],
    active: sessionId,
  });
  const session = {
    id: sessionId,
    title: 'Stalled snapshot',
    messages: [],
    display: [],
    updatedAt: 20,
    snapshotUpdatedAt: 0,
    persistenceUpdatedAt: 0,
  };
  const state = { ...createState(), sessions: [session], activeSessionId: sessionId, messages: [] };
  let resolveDurableWrite;
  let writtenSnapshot = null;
  const stalledWrite = new Promise(resolve => { resolveDurableWrite = resolve; });
  const workflow = createWorkflow({
    storage,
    state,
    snapshotCommitWaitMs: 5,
    snapshotStore: {
      supported: true,
      getSnapshot: async () => ({
        id: sessionId,
        snapshotVersion: 2,
        updatedAt: 10,
        messages: [{ role: 'user', content: 'older question', messageIndex: '0' }],
        pendingDisplay: [],
        lastGeneratedImage: null,
      }),
      schedulePut: snapshot => {
        writtenSnapshot = snapshot;
        return stalledWrite;
      },
    },
  });

  const completion = workflow.saveSessionMessages(sessionId, [
    { role: 'user', content: 'question', messageIndex: '0' },
    { role: 'assistant', content: 'answer already returned', responseIndex: '1' },
  ]);
  const released = await Promise.race([
    completion.then(() => true),
    new Promise(resolve => setTimeout(() => resolve(false), 200)),
  ]);

  assert.strictEqual(released, true, 'a stalled IndexedDB write must not leave the completed task waiting forever');
  const fallbackKey = `sessions:snapshot-fallback:${sessionId}`;
  const fallback = JSON.parse(storage.getItem(fallbackKey));
  assert.deepStrictEqual(fallback.messages.map(message => message.content), ['question', 'answer already returned']);
  assert.strictEqual(session.snapshotUpdatedAt, 0, 'a timed-out write must not be reported as an IndexedDB commit');

  const reloadedState = createState();
  const reloadedWorkflow = createWorkflow({
    storage,
    state: reloadedState,
    snapshotCommitWaitMs: 5,
    snapshotStore: {
      supported: true,
      getSnapshot: () => new Promise(() => {}),
      schedulePut: async () => {},
    },
  });
  await reloadedWorkflow.loadSessions();
  assert.deepStrictEqual(reloadedState.messages.map(message => message.content), ['question', 'answer already returned'],
    'reload must use the recoverable fallback even when the IndexedDB read itself is stalled');

  resolveDurableWrite(writtenSnapshot);
  await new Promise(resolve => setTimeout(resolve, 0));
  assert.strictEqual(storage.getItem(fallbackKey), null, 'the fallback should clear after the original durable write eventually commits');
}


async function testQuotaFallbackCompactsToIncrementalTailAndMergesDurableHistory() {
  const sessionId = 'quota-fallback';
  const fallbackKey = `sessions:snapshot-fallback:${sessionId}`;
  const baseStorage = createStorage({
    sessions: [{
      id: sessionId,
      title: 'Quota fallback',
      updatedAt: 20,
      snapshotUpdatedAt: 10,
      persistenceUpdatedAt: 10,
    }],
    active: sessionId,
  });
  const fallbackAttempts = [];
  const storage = {
    getItem: key => baseStorage.getItem(key),
    removeItem: key => baseStorage.removeItem(key),
    setItem(key, value) {
      if (key === fallbackKey) {
        const candidate = JSON.parse(String(value));
        fallbackAttempts.push(candidate);
        if (!candidate.partial || candidate.messages.length > 6) {
          const error = new Error('localStorage quota exceeded');
          error.name = 'QuotaExceededError';
          throw error;
        }
      }
      baseStorage.setItem(key, value);
    },
  };
  const messages = Array.from({ length: 20 }, (_, index) => ({
    role: index % 2 ? 'assistant' : 'user',
    content: `latest message ${index}`,
    rawText: `latest message ${index}`,
    html: `<p>${'rendered '.repeat(40)}${index}</p>`,
    presentation: { html: `<div>${'cached '.repeat(40)}</div>`, mode: 'markdown' },
    ...(index % 2 ? { responseIndex: String(index) } : { messageIndex: String(index) }),
  }));
  const session = {
    id: sessionId,
    title: 'Quota fallback',
    messages: [],
    display: [],
    updatedAt: 20,
    snapshotUpdatedAt: 10,
    persistenceUpdatedAt: 10,
  };
  const state = { ...createState(), sessions: [session], activeSessionId: sessionId, messages: [] };
  const workflow = createWorkflow({
    storage,
    state,
    snapshotCommitWaitMs: 5,
    snapshotFallbackTailCount: 12,
    snapshotStore: {
      supported: true,
      getSnapshot: async () => null,
      schedulePut: () => new Promise(() => {}),
    },
  });

  await workflow.saveSessionMessages(sessionId, messages);

  const fallback = JSON.parse(storage.getItem(fallbackKey));
  assert.strictEqual(fallback.partial, true, 'quota pressure should switch the fallback to incremental mode');
  assert.strictEqual(fallback.messages.length, 6, 'the fallback should progressively shrink until it fits');
  assert.ok(fallback.messages.every(message => !Object.prototype.hasOwnProperty.call(message, 'html')),
    'regenerable rendered HTML must not consume emergency fallback capacity');
  assert.ok(fallbackAttempts.length >= 3 && fallbackAttempts[0].partial === false && fallbackAttempts[1].messages.length === 12,
    'the writer should try compact full history before progressively smaller incremental candidates');

  const durableMessages = messages.slice(0, 16).map((message, index) => ({
    ...message,
    content: index >= 14 ? `stale message ${index}` : message.content,
    rawText: index >= 14 ? `stale message ${index}` : message.rawText,
  }));
  const reloadedState = createState();
  const reloadedWorkflow = createWorkflow({
    storage,
    state: reloadedState,
    snapshotCommitWaitMs: 20,
    snapshotStore: {
      supported: true,
      getSnapshot: async () => ({
        id: sessionId,
        snapshotVersion: 2,
        updatedAt: 10,
        messages: durableMessages,
        pendingDisplay: [],
        lastGeneratedImage: null,
      }),
      schedulePut: async () => {},
    },
  });

  await reloadedWorkflow.loadSessions();

  assert.strictEqual(reloadedState.messages.length, 20, 'incremental fallback should extend the last durable snapshot without losing earlier turns');
  assert.strictEqual(reloadedState.messages[14].content, 'latest message 14', 'newer fallback records must replace stale durable records with the same identity');
  assert.strictEqual(reloadedState.messages[15].content, 'latest message 15');
  assert.strictEqual(new Set(reloadedState.messages.map(message => `${message.role}:${message.messageIndex || message.responseIndex}`)).size, 20,
    'durable and fallback history must merge without duplicate user/assistant identities');
  assert.strictEqual(reloadedState.sessions[0].snapshotUpdatedAt, 10,
    'loading a localStorage fallback must not misreport it as a durable IndexedDB commit');
  assert.strictEqual(reloadedState.sessions[0].persistenceUpdatedAt, fallback.updatedAt,
    'the fallback revision must still participate in monotonic persistence ordering');
}


async function testUnsupportedIndexedDbUsesImmediateRecoverableFallback() {
  const sessionId = 'unsupported-indexeddb';
  const storage = createStorage({
    sessions: [{ id: sessionId, title: 'No IndexedDB', updatedAt: 20 }],
    active: sessionId,
  });
  const session = {
    id: sessionId,
    title: 'No IndexedDB',
    messages: [],
    display: [],
    updatedAt: 20,
    snapshotUpdatedAt: 0,
    persistenceUpdatedAt: 0,
  };
  const state = { ...createState(), sessions: [session], activeSessionId: sessionId, messages: [] };
  let writes = 0;
  const workflow = createWorkflow({
    storage,
    state,
    snapshotCommitWaitMs: 1000,
    snapshotStore: {
      supported: false,
      getSnapshot: async () => null,
      schedulePut: async () => { writes += 1; },
    },
  });

  const committed = await Promise.race([
    workflow.saveSessionMessages(sessionId, [
      { role: 'user', content: 'question without IndexedDB', messageIndex: '0' },
      { role: 'assistant', content: 'answer remains recoverable', responseIndex: '1' },
    ]).then(() => true),
    new Promise(resolve => setTimeout(() => resolve(false), 100)),
  ]);

  assert.strictEqual(committed, true, 'unsupported IndexedDB should not impose the normal commit wait');
  assert.strictEqual(writes, 0, 'the workflow should not call an unsupported snapshot writer');
  assert.strictEqual(session.snapshotUpdatedAt, 0, 'local fallback must remain distinct from a durable revision');
  const fallback = JSON.parse(storage.getItem(`sessions:snapshot-fallback:${sessionId}`));
  assert.deepStrictEqual(fallback.messages.map(message => message.content), ['question without IndexedDB', 'answer remains recoverable']);
}

module.exports = [
  testCurrentSnapshotFormatLoadsNormally,
  testLegacyLocalStoragePayloadIsIgnored,
  testVersionOneSnapshotIsIgnored,
  testStalledSnapshotWriteReleasesCompletionAndKeepsRecoverableFallback,
  testQuotaFallbackCompactsToIncrementalTailAndMergesDurableHistory,
  testUnsupportedIndexedDbUsesImmediateRecoverableFallback,
];
