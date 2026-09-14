'use strict';

const assert = require('assert');
const fs = require('fs');
const path = require('path');
const vm = require('vm');
const sessionDisplay = require('../../client/app/session-display');
const streamCheckpoint = require('../../client/services/stream-checkpoint-store');

function createStorage() {
  const data = new Map();
  return {
    get length() { return data.size; },
    getItem(key) { return data.has(key) ? data.get(key) : null; },
    setItem(key, value) { data.set(key, String(value)); },
    removeItem(key) { data.delete(key); },
    key(index) { return [...data.keys()][index] ?? null; },
    data,
  };
}

function createSession(id, rawText = '正在处理') {
  return {
    id,
    title: id,
    messages: [{ role: 'user', content: 'question', messageIndex: '0' }],
    display: [{
      id: `display-${id}`,
      role: 'assistant',
      rawText,
      html: '<div class="pending-feedback">正在处理</div>',
      responseIndex: '1',
      jobId: `chatjob-${id}`,
      pending: '1',
    }],
    createdAt: 1,
    updatedAt: 1,
  };
}

function createCheckpointWorkflow({ sessions = [createSession('stream-session')], checkpoint = null } = {}) {
  const state = {
    sessions,
    activeSessionId: sessions[0].id,
    messages: sessions[0].messages,
    models: [],
    busySessions: new Set(),
    disposedSessionIds: new Set(),
  };
  const storage = createStorage();
  const timers = new Map();
  let nextTimer = 1;
  const snapshotWrites = [];
  const streamWrites = [];
  const streamDeletes = [];
  const streamFlushes = [];
  let flushCount = 0;
  const workflow = sessionDisplay.createSessionDisplayWorkflow({
    getState: () => state,
    getActiveSession: () => sessions.find(item => item.id === state.activeSessionId),
    createSession: () => createSession('new-session'),
    deriveSessionTitle: current => current.title || 'Session',
    readJsonStorage: (key, fallback) => {
      try { const raw = storage.getItem(key); return raw ? JSON.parse(raw) : fallback; } catch { return fallback; }
    },
    compactAdjacentDuplicateMessages: items => items,
    compactDisplayItems: items => items,
    sanitizeStoredDisplayItem: item => ({ ...item }),
    sanitizeStoredMessage: message => ({ ...message }),
    messageRecords: { normalizeCanonicalMessage: message => ({ ...message }) },
    localStorage: storage,
    snapshotStore: {
      supported: true,
      getSnapshot: async () => null,
      schedulePut: async value => { snapshotWrites.push(value); return value; },
      flush: async () => true,
      deleteSnapshot: async () => true,
      clear: async () => true,
    },
    streamCheckpointStore: {
      supported: true,
      schedulePut: async (sessionId, items) => {
        const value = streamCheckpoint.buildStreamCheckpoint(sessionId, items, { now: ++flushCount });
        streamWrites.push(value);
        return value;
      },
      get: async () => checkpoint,
      delete: async sessionId => { streamDeletes.push(sessionId); return true; },
      flush: async sessionId => { streamFlushes.push(sessionId); return true; },
      clear: async () => true,
    },
    constants: {
      SESSIONS_KEY: 'stream-refresh-sessions',
      ACTIVE_SESSION_KEY: 'stream-refresh-active',
    },
    pendingDisplayCheckpointMs: 500,
    setTimeout(callback, delay) {
      const id = nextTimer++;
      timers.set(id, { callback, delay });
      return id;
    },
    clearTimeout(id) { timers.delete(id); },
  });
  return { workflow, state, sessions, storage, timers, snapshotWrites, streamWrites, streamDeletes, streamFlushes };
}

async function testStreamingCheckpointsDoNotWriteFullSessionSnapshots() {
  const harness = createCheckpointWorkflow();
  const session = harness.sessions[0];
  const item = session.display[0];

  harness.workflow.checkpointSessionDisplayItem(session.id, item, 'assistant', 'first', { rawText: 'first' });
  harness.workflow.checkpointSessionDisplayItem(session.id, item, 'assistant', 'first second', { rawText: 'first second' });

  assert.strictEqual(harness.snapshotWrites.length, 0, 'pending output must not serialize the full session snapshot');
  assert.strictEqual(harness.timers.size, 1, 'high-frequency deltas must share one cursor checkpoint');
  const [{ callback, delay }] = [...harness.timers.values()];
  assert.strictEqual(delay, 500);
  callback();
  await Promise.resolve();

  assert.strictEqual(harness.snapshotWrites.length, 0);
  assert.strictEqual(harness.streamWrites.length, 1);
  const record = harness.streamWrites[0];
  assert.strictEqual(record.items.length, 1);
  assert.strictEqual(record.items[0].rawText, 'first second');
  assert.strictEqual(record.items[0].html, '', 'stream checkpoint must not copy rendered HTML');
  assert.strictEqual(Object.hasOwn(record, 'messages'), false, 'stream checkpoint must never contain canonical history');
}

async function testThreeLongSessionsUseBoundedLatestOnlyCheckpoints() {
  const sessions = [
    createSession('session-a'),
    createSession('session-b'),
    createSession('session-c'),
  ];
  const harness = createCheckpointWorkflow({ sessions });
  const longPrefix = 'x'.repeat(180000);

  sessions.forEach((session, sessionIndex) => {
    const item = session.display[0];
    for (let index = 0; index < 40; index += 1) {
      const rawText = `${longPrefix}${String(sessionIndex)}-${index}`;
      harness.workflow.checkpointSessionDisplayItem(session.id, item, 'assistant', rawText, { rawText, responseIndex: 1 });
    }
  });

  assert.strictEqual(harness.timers.size, 3, 'each session must have one coalesced checkpoint timer');
  for (const timer of harness.timers.values()) timer.callback();
  await Promise.resolve();

  assert.strictEqual(harness.snapshotWrites.length, 0, 'long output must not trigger full snapshots');
  assert.strictEqual(harness.streamWrites.length, 3, 'each session must write only its latest bounded cursor');
  for (const record of harness.streamWrites) {
    const item = record.items[0];
    assert.ok(item.rawText.length <= streamCheckpoint.DEFAULT_CONTENT_TAIL_LIMIT,
      'cursor text must remain bounded independently of total output length');
    assert.strictEqual(item.streamCheckpoint.contentLength > item.rawText.length, true,
      'cursor metadata must retain the total content offset');
  }
}

async function testCheckpointCadenceBacksOffUnderManyActiveStreams() {
  const sessions = Array.from({ length: 8 }, (_, index) => createSession(`session-${index}`));
  const harness = createCheckpointWorkflow({ sessions });
  harness.state.busySessions = new Set(sessions.map(session => session.id));

  for (const session of sessions) {
    harness.workflow.checkpointSessionDisplayItem(session.id, session.display[0], 'assistant', 'partial', { rawText: 'partial' });
  }

  assert.strictEqual(harness.timers.size, 8);
  assert.ok([...harness.timers.values()].every(timer => timer.delay === 2000),
    'eight concurrent long streams must back off cursor persistence instead of competing every 500ms');
}

async function testPageLeaveFlushesLatestCursorWithoutFullSnapshot() {
  const harness = createCheckpointWorkflow();
  const session = harness.sessions[0];
  const item = session.display[0];
  harness.workflow.checkpointSessionDisplayItem(session.id, item, 'assistant', 'visible prefix', { rawText: 'visible prefix' });

  await harness.workflow.flushPendingDisplayCheckpoints();

  assert.strictEqual(harness.timers.size, 0, 'page-leave flush must clear the pending timer');
  assert.strictEqual(harness.streamWrites.length, 1);
  assert.strictEqual(harness.streamWrites[0].items[0].rawText, 'visible prefix');
  assert.deepStrictEqual(harness.streamFlushes, [session.id]);
  assert.strictEqual(harness.snapshotWrites.length, 0);
}

async function testCompletedMessageDeletesCursorAfterCanonicalCommit() {
  const harness = createCheckpointWorkflow();
  const session = harness.sessions[0];
  const item = session.display[0];
  harness.workflow.checkpointSessionDisplayItem(session.id, item, 'assistant', 'partial', { rawText: 'partial' });

  harness.workflow.updateSessionDisplayItem(session.id, item, 'assistant', 'complete', {
    rawText: 'complete',
    pending: false,
  });
  await new Promise(resolve => setImmediate(resolve));

  assert.strictEqual(harness.snapshotWrites.length, 1, 'terminal completion must commit the canonical snapshot once');
  assert.deepStrictEqual(harness.streamDeletes, [session.id], 'terminal completion must remove the stream cursor');
  assert.deepStrictEqual(session.display, [], 'completed answers must not remain in pending display');
}

async function testLoadSessionsMergesBoundedTailCursorForRefreshResume() {
  const session = createSession('restored-session', 'older snapshot text');
  const tail = 'z'.repeat(streamCheckpoint.DEFAULT_CONTENT_TAIL_LIMIT);
  const checkpoint = {
    version: streamCheckpoint.CHECKPOINT_VERSION,
    sessionId: session.id,
    updatedAt: 99,
    items: [{
      id: session.display[0].id,
      role: 'assistant',
      rawText: tail,
      reasoningText: '',
      html: '',
      responseIndex: '1',
      jobId: session.display[0].jobId,
      pending: '1',
      outputStarted: true,
      streamCheckpoint: {
        version: 1,
        contentLength: 500000,
        reasoningLength: 0,
        contentTailStart: 500000 - tail.length,
        reasoningTailStart: 0,
        tailOnly: true,
      },
    }],
  };
  const harness = createCheckpointWorkflow({ sessions: [session], checkpoint });
  harness.storage.setItem('stream-refresh-sessions', JSON.stringify([{ id: session.id, title: session.title, updatedAt: 1 }]));
  harness.storage.setItem('stream-refresh-active', session.id);
  harness.workflow = sessionDisplay.createSessionDisplayWorkflow({
    getState: () => harness.state,
    getActiveSession: () => harness.state.sessions[0],
    createSession: () => createSession('new-session'),
    deriveSessionTitle: current => current.title || 'Session',
    readJsonStorage: (key, fallback) => {
      try { const raw = harness.storage.getItem(key); return raw ? JSON.parse(raw) : fallback; } catch { return fallback; }
    },
    compactAdjacentDuplicateMessages: items => items,
    compactDisplayItems: items => items,
    sanitizeStoredDisplayItem: item => ({ ...item }),
    sanitizeStoredMessage: message => ({ ...message }),
    messageRecords: { normalizeCanonicalMessage: message => ({ ...message }) },
    localStorage: harness.storage,
    snapshotStore: {
      supported: true,
      getSnapshot: async () => ({
        id: session.id,
        snapshotVersion: 2,
        updatedAt: 10,
        messages: [{ role: 'user', content: 'question', messageIndex: '0' }],
        pendingDisplay: [{ ...session.display[0], rawText: 'older snapshot text' }],
      }),
      schedulePut: async () => null,
      flush: async () => true,
      clear: async () => true,
    },
    streamCheckpointStore: {
      supported: true,
      schedulePut: async () => null,
      get: async () => checkpoint,
      delete: async () => true,
      flush: async () => true,
      clear: async () => true,
    },
    constants: { SESSIONS_KEY: 'stream-refresh-sessions', ACTIVE_SESSION_KEY: 'stream-refresh-active' },
  });

  await harness.workflow.loadSessions();

  const restored = harness.state.sessions[0].display[0];
  assert.strictEqual(restored.rawText, tail);
  assert.strictEqual(restored.streamCheckpointRecovered, true);
  assert.strictEqual(restored.streamCheckpointTailOnly, true);
  assert.strictEqual(harness.state.sessions[0].messages[0].content, 'question');
}

function testAppStillRoutesPendingProjectionThroughCheckpointBeforeDomShortcut() {
  const source = fs.readFileSync(path.join(__dirname, '../../app.js'), 'utf8');
  const liveStart = source.indexOf('function updateLiveDisplay(');
  assert.ok(liveStart >= 0);
  const liveSource = source.slice(liveStart, liveStart + 2200);
  assert.ok(liveSource.includes('o?checkpointSessionDisplayItem(e,t,s,n,{...a,pending:!0})'),
    'pending output must checkpoint state even when the DOM was already updated directly');
}

function loadRootFunction(source, functionName, terminator, sandbox = {}) {
  const start = source.indexOf(`function ${functionName}`);
  const end = source.indexOf(terminator, start);
  assert.ok(start >= 0 && end > start, `${functionName} must remain in app.js`);
  return vm.runInNewContext(`${source.slice(start, end)};${functionName}`, sandbox);
}

function testChatLiveItemRecoveryWritesOnlyTheBoundedCursor() {
  const source = fs.readFileSync(path.join(__dirname, '../../app.js'), 'utf-8');
  const calls = [];
  const session = {
    id: 'session-live-item',
    display: [{ id: 'display-live', role: 'assistant', rawText: 'partial', pending: '1' }],
  };
  const sandbox = {
    state: { sessions: [session] },
    appendSessionDisplayMessage() { throw new Error('the existing display item must be reused'); },
    makeDisplayItemId() { return 'unused'; },
    removeDisplayItemNode() {},
    persistSessionDisplay() { throw new Error('live chat recovery must not commit a full snapshot'); },
    checkpointSessionDisplayItem(...args) { calls.push(args); },
  };
  const take = loadRootFunction(source, 'takeChatJobLiveItem', 'function updateLiveDisplay', sandbox);
  const item = take(session.id, {
    id: 'chatjob-live-item',
    displayItemId: 'display-live',
    responseIndex: 1,
  }, '正在恢复聊天任务');

  assert.strictEqual(item, session.display[0]);
  assert.strictEqual(item.jobId, 'chatjob-live-item');
  assert.strictEqual(calls.length, 1, 'the live item handoff must schedule one bounded cursor');
  assert.strictEqual(calls[0][0], session.id);
  assert.strictEqual(calls[0][1], item);
  assert.strictEqual(calls[0][3], 'partial');
}

function testBusyPageLeaveSkipsCanonicalFullSnapshotWrites() {
  const source = fs.readFileSync(path.join(__dirname, '../../app.js'), 'utf-8');
  const activeSession = { id: 'session-busy-leave' };
  const state = { pageUnloading: false };
  const calls = [];
  const mark = name => () => calls.push(name);
  const sandbox = {
    state,
    getActiveSession: () => activeSession,
    getActiveRun: () => null,
    isSessionBusy: () => true,
    flushPendingDisplayCheckpoints: mark('cursor'),
    saveDisplayHistory: mark('display-full'),
    saveChatHistory: mark('canonical-full'),
    saveSessionsMeta: mark('metadata'),
    flushSessionSnapshots: mark('flush'),
    console: { warn() {} },
  };
  const persist = loadRootFunction(source, 'persistBeforePageLeave', 'let foregroundRefreshTimer', sandbox);
  persist();

  assert.deepStrictEqual(calls, ['cursor', 'metadata', 'flush'],
    'a busy page leave must flush cursors without serializing canonical history');

  calls.length = 0;
  sandbox.isSessionBusy = () => false;
  persist();
  assert.deepStrictEqual(calls, ['cursor', 'display-full', 'canonical-full', 'metadata', 'flush'],
    'an idle page leave must retain the canonical safety path');
}

module.exports = [
  testStreamingCheckpointsDoNotWriteFullSessionSnapshots,
  testChatLiveItemRecoveryWritesOnlyTheBoundedCursor,
  testBusyPageLeaveSkipsCanonicalFullSnapshotWrites,
  testThreeLongSessionsUseBoundedLatestOnlyCheckpoints,
  testCheckpointCadenceBacksOffUnderManyActiveStreams,
  testPageLeaveFlushesLatestCursorWithoutFullSnapshot,
  testCompletedMessageDeletesCursorAfterCanonicalCommit,
  testLoadSessionsMergesBoundedTailCursorForRefreshResume,
  testAppStillRoutesPendingProjectionThroughCheckpointBeforeDomShortcut,
];
