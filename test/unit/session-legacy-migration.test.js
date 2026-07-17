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
    values,
  };
}

function createWorkflow({ storage, state, snapshotStore }) {
  return sessionDisplay.createSessionDisplayWorkflow({
    getState: () => state,
    getActiveSession: () => state.sessions.find(item => item.id === state.activeSessionId),
    createSession: appState.createSession,
    deriveSessionTitle: session => session.title || '???',
    sessionStorageKey: (key, sessionId) => `${key}:${sessionId}`,
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
    constants: {
      CHAT_KEY: 'chat',
      UI_KEY: 'ui',
      LAST_IMAGE_KEY: 'image',
      SESSIONS_KEY: 'sessions',
      ACTIVE_SESSION_KEY: 'active',
    },
  });
}

async function testLegacyLocalStorageSessionMigratesIntoSnapshotV2() {
  const sessionId = 'legacy-session';
  const lastGeneratedImage = { src: 'indexeddb://legacy-image', prompt: 'legacy cat' };
  const storage = createStorage({
    sessions: [{ id: sessionId, title: '???', createdAt: 10, updatedAt: 20 }],
    active: sessionId,
    [`chat:${sessionId}`]: [{ role: 'user', content: '???', messageIndex: '0' }],
    [`ui:${sessionId}`]: [
      { id: 'done-answer', role: 'assistant', rawText: '???', responseIndex: '1', pending: '' },
      { id: 'pending-answer', role: 'assistant', rawText: '????', responseIndex: '2', pending: '1', jobId: 'job-old' },
    ],
    [`image:${sessionId}`]: lastGeneratedImage,
  });
  const state = { sessions: [], activeSessionId: '', messages: [], models: [], reasoningMode: false };
  let migratedSnapshot = null;
  const workflow = createWorkflow({
    storage,
    state,
    snapshotStore: {
      supported: true,
      getSnapshot: async () => null,
      schedulePut: async snapshot => { migratedSnapshot = JSON.parse(JSON.stringify(snapshot)); },
    },
  });

  await workflow.loadSessions();

  assert.deepStrictEqual(state.messages.map(item => item.content), ['???', '???'], 'legacy message and completed display records should be restored as canonical messages');
  assert.deepStrictEqual(state.sessions[0].display.map(item => item.id), ['pending-answer'], 'only pending legacy display records should remain outside canonical history');
  assert.deepStrictEqual(state.sessions[0].lastGeneratedImage, lastGeneratedImage, 'legacy last-image state should remain available');
  assert.strictEqual(migratedSnapshot.snapshotVersion, 2, 'legacy data should be written into the current snapshot format');
  assert.deepStrictEqual(migratedSnapshot.messages.map(item => item.content), ['???', '???']);
  assert.deepStrictEqual(migratedSnapshot.pendingDisplay.map(item => item.id), ['pending-answer']);
  assert.ok(storage.getItem(`chat:${sessionId}`), 'legacy backup should not be deleted until the v2 snapshot is safely established');
}

async function testCurrentSnapshotWinsOverStaleLegacyBackup() {
  const sessionId = 'current-session';
  const storage = createStorage({
    sessions: [{ id: sessionId, title: '????', updatedAt: 20 }],
    active: sessionId,
    [`chat:${sessionId}`]: [{ role: 'user', content: '????', messageIndex: '0' }],
  });
  const state = { sessions: [], activeSessionId: '', messages: [], models: [], reasoningMode: false };
  let migrationWrites = 0;
  const workflow = createWorkflow({
    storage,
    state,
    snapshotStore: {
      supported: true,
      getSnapshot: async () => ({
        id: sessionId,
        snapshotVersion: 2,
        updatedAt: 30,
        messages: [{ role: 'user', content: '????', messageIndex: '0' }],
        pendingDisplay: [],
      }),
      schedulePut: async () => { migrationWrites += 1; },
    },
  });

  await workflow.loadSessions();

  assert.deepStrictEqual(state.messages.map(item => item.content), ['????'], 'a valid v2 snapshot must take precedence over stale localStorage backups');
  assert.strictEqual(migrationWrites, 0, 'current snapshots should not be rewritten as legacy migrations');
}


async function testPartialCurrentSnapshotRecoversRicherLegacyHistory() {
  const sessionId = 'partial-current-session';
  const storage = createStorage({
    sessions: [{ id: sessionId, title: '??????', updatedAt: 40 }],
    active: sessionId,
    [`chat:${sessionId}`]: [
      { role: 'user', content: '????', messageIndex: '0' },
      { role: 'assistant', content: '????', responseIndex: '1' },
      { role: 'user', content: '????', messageIndex: '2' },
      { role: 'assistant', content: '????', responseIndex: '3' },
    ],
  });
  const state = { sessions: [], activeSessionId: '', messages: [], models: [], reasoningMode: false };
  let repairedSnapshot = null;
  const workflow = createWorkflow({
    storage,
    state,
    snapshotStore: {
      supported: true,
      getSnapshot: async () => ({
        id: sessionId,
        snapshotVersion: 2,
        updatedAt: 50,
        messages: [
          { role: 'user', content: '????????', messageIndex: '0' },
          { role: 'assistant', content: '????????', responseIndex: '1' },
        ],
        pendingDisplay: [],
      }),
      schedulePut: async snapshot => { repairedSnapshot = JSON.parse(JSON.stringify(snapshot)); },
    },
  });

  await workflow.loadSessions();

  assert.deepStrictEqual(state.messages.map(item => item.content), [
    '????',
    '????',
    '????',
    '????',
    '????????',
    '????????',
  ], 'a partial v2 snapshot created during the storage transition must not hide the richer legacy history');
  assert.deepStrictEqual(
    state.messages.map(item => item.role === 'user' ? item.messageIndex : item.responseIndex),
    ['0', '1', '2', '3', '4', '5'],
    'recovered and current messages should receive one collision-free canonical order',
  );
  assert.ok(repairedSnapshot, 'the repaired combined history should be persisted back to snapshot v2');
  assert.deepStrictEqual(repairedSnapshot.messages.map(item => item.content), state.messages.map(item => item.content));
}


async function testPartialSnapshotThatMatchesLegacyPrefixRestoresLegacyTail() {
  const sessionId = 'partial-prefix-session';
  const storage = createStorage({
    sessions: [{ id: sessionId, title: '????', updatedAt: 40 }],
    active: sessionId,
    [`chat:${sessionId}`]: [
      { role: 'user', content: '?????', messageIndex: '0' },
      { role: 'assistant', content: '?????', responseIndex: '1' },
      { role: 'user', content: '??????', messageIndex: '2' },
      { role: 'assistant', content: '??????', responseIndex: '3' },
    ],
  });
  const state = { sessions: [], activeSessionId: '', messages: [], models: [], reasoningMode: false };
  let repairedSnapshot = null;
  const workflow = createWorkflow({
    storage,
    state,
    snapshotStore: {
      supported: true,
      getSnapshot: async () => ({
        id: sessionId,
        snapshotVersion: 2,
        updatedAt: 50,
        messages: [
          { role: 'user', content: '?????', messageIndex: '0' },
          { role: 'assistant', content: '?????', responseIndex: '1', reasoning_content: '???????' },
        ],
        pendingDisplay: [],
      }),
      schedulePut: async snapshot => { repairedSnapshot = JSON.parse(JSON.stringify(snapshot)); },
    },
  });

  await workflow.loadSessions();

  assert.deepStrictEqual(state.messages.map(item => item.content), ['?????', '?????', '??????', '??????']);
  assert.strictEqual(state.messages[1].reasoning_content, '???????', 'newer snapshot metadata should enrich matching recovered records');
  assert.ok(repairedSnapshot, 'a prefix-only snapshot should be repaired with the legacy tail');
}

async function testRicherCurrentSnapshotStillWinsOverShortLegacyBackup() {
  const sessionId = 'richer-current-session';
  const storage = createStorage({
    sessions: [{ id: sessionId, title: '????', updatedAt: 40 }],
    active: sessionId,
    [`chat:${sessionId}`]: [
      { role: 'user', content: '????', messageIndex: '0' },
      { role: 'assistant', content: '????', responseIndex: '1' },
    ],
  });
  const state = { sessions: [], activeSessionId: '', messages: [], models: [], reasoningMode: false };
  let migrationWrites = 0;
  const workflow = createWorkflow({
    storage,
    state,
    snapshotStore: {
      supported: true,
      getSnapshot: async () => ({
        id: sessionId,
        snapshotVersion: 2,
        updatedAt: 50,
        messages: [
          { role: 'user', content: '?????', messageIndex: '0' },
          { role: 'assistant', content: '?????', responseIndex: '1' },
          { role: 'user', content: '?????', messageIndex: '2' },
          { role: 'assistant', content: '?????', responseIndex: '3' },
        ],
        pendingDisplay: [],
      }),
      schedulePut: async () => { migrationWrites += 1; },
    },
  });

  await workflow.loadSessions();

  assert.deepStrictEqual(state.messages.map(item => item.content), ['?????', '?????', '?????', '?????']);
  assert.strictEqual(migrationWrites, 0, 'a richer current snapshot must not be rewritten from a shorter stale backup');
}

async function testVersionOneSnapshotUsesLegacyNormalizer() {
  const sessionId = 'snapshot-v1';
  const storage = createStorage({
    sessions: [{ id: sessionId, title: '???', updatedAt: 20 }],
    active: sessionId,
  });
  const state = { sessions: [], activeSessionId: '', messages: [], models: [], reasoningMode: false };
  let migratedSnapshot = null;
  const workflow = createWorkflow({
    storage,
    state,
    snapshotStore: {
      supported: true,
      getSnapshot: async () => ({
        id: sessionId,
        snapshotVersion: 1,
        updatedAt: 15,
        messages: [{ role: 'user', content: '?????', messageIndex: '0' }],
        display: [{ id: 'v1-answer', role: 'assistant', rawText: '?????', responseIndex: '1', pending: '' }],
      }),
      schedulePut: async snapshot => { migratedSnapshot = JSON.parse(JSON.stringify(snapshot)); },
    },
  });

  await workflow.loadSessions();

  assert.deepStrictEqual(state.messages.map(item => item.content), ['?????', '?????']);
  assert.strictEqual(migratedSnapshot.snapshotVersion, 2, 'older IndexedDB snapshots should also be upgraded to v2');
}

module.exports = [
  testLegacyLocalStorageSessionMigratesIntoSnapshotV2,
  testCurrentSnapshotWinsOverStaleLegacyBackup,
  testPartialCurrentSnapshotRecoversRicherLegacyHistory,
  testPartialSnapshotThatMatchesLegacyPrefixRestoresLegacyTail,
  testRicherCurrentSnapshotStillWinsOverShortLegacyBackup,
  testVersionOneSnapshotUsesLegacyNormalizer,
];
