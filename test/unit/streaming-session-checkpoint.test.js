'use strict';

const assert = require('assert');
const fs = require('fs');
const path = require('path');
const sessionDisplay = require('../../client/app/session-display');

function createStorage() {
  const data = new Map();
  return {
    get length() { return data.size; },
    getItem(key) { return data.has(key) ? data.get(key) : null; },
    setItem(key, value) { data.set(String(key), String(value)); },
    removeItem(key) { data.delete(String(key)); },
    key(index) { return [...data.keys()][index] ?? null; },
    data,
  };
}

function createCheckpointWorkflow() {
  const session = {
    id: 'stream-refresh-session',
    title: 'Streaming refresh',
    messages: [{ role: 'user', content: 'describe it', messageIndex: '0' }],
    display: [{
      id: 'stream-display',
      role: 'assistant',
      rawText: '正在等待模型生成回答',
      html: '<div class="pending-feedback">正在等待模型生成回答</div>',
      responseIndex: '1',
      jobId: 'chatjob-stream-refresh',
      pending: '1',
    }],
    createdAt: 1,
    updatedAt: 1,
  };
  const state = {
    sessions: [session],
    activeSessionId: session.id,
    messages: session.messages,
    models: [],
    disposedSessionIds: new Set(),
  };
  const storage = createStorage();
  const timers = new Map();
  let nextTimer = 1;
  const workflow = sessionDisplay.createSessionDisplayWorkflow({
    getState: () => state,
    getActiveSession: () => session,
    deriveSessionTitle: current => current.title || 'Session',
    compactAdjacentDuplicateMessages: items => items,
    compactDisplayItems: items => items,
    sanitizeStoredDisplayItem: item => ({ ...item }),
    sanitizeStoredMessage: message => ({ ...message }),
    messageRecords: {
      normalizeCanonicalMessage: message => ({ ...message }),
    },
    localStorage: storage,
    snapshotStore: { supported: false },
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
  return { workflow, session, state, storage, timers };
}

function fallbackSnapshot(storage, sessionId = 'stream-refresh-session') {
  const raw = storage.getItem(`stream-refresh-sessions:snapshot-fallback:${sessionId}`);
  return raw ? JSON.parse(raw) : null;
}

async function testStreamingCheckpointPersistsLatestVisiblePrefixForRefresh() {
  const { workflow, session, storage, timers } = createCheckpointWorkflow();
  const item = session.display[0];

  workflow.checkpointSessionDisplayItem(session.id, item, 'assistant', '第一段已经显示', {
    rawText: '第一段已经显示',
    responseIndex: 1,
    jobId: item.jobId,
  });
  workflow.checkpointSessionDisplayItem(session.id, item, 'assistant', '第一段已经显示，第二段也已经显示', {
    rawText: '第一段已经显示，第二段也已经显示',
    responseIndex: 1,
    jobId: item.jobId,
  });

  assert.strictEqual(item.rawText, '第一段已经显示，第二段也已经显示');
  assert.strictEqual(item.html, '', 'durable streaming state must not retain an older pending-status HTML projection');
  assert.strictEqual(item.pending, '1');
  assert.strictEqual(timers.size, 1, 'high-frequency deltas must share one bounded persistence checkpoint');
  assert.strictEqual(fallbackSnapshot(storage), null, 'the checkpoint remains batched until its timer or page-leave flush');

  const [{ callback, delay }] = [...timers.values()];
  assert.strictEqual(delay, 500);
  callback();
  await Promise.resolve();

  const snapshot = fallbackSnapshot(storage);
  assert.ok(snapshot, 'the timed checkpoint must synchronously retain a refresh recovery snapshot');
  assert.strictEqual(snapshot.pendingDisplay.length, 1);
  assert.strictEqual(snapshot.pendingDisplay[0].rawText, '第一段已经显示，第二段也已经显示');
  assert.strictEqual(snapshot.pendingDisplay[0].jobId, item.jobId);
  assert.strictEqual(snapshot.pendingDisplay[0].responseIndex, '1');
}

async function testPageLeaveFlushPersistsUnexpiredStreamingCheckpoint() {
  const { workflow, session, storage, timers } = createCheckpointWorkflow();
  const item = session.display[0];

  workflow.checkpointSessionDisplayItem(session.id, item, 'assistant', '刷新前屏幕上可见的完整前缀', {
    rawText: '刷新前屏幕上可见的完整前缀',
    responseIndex: 1,
    jobId: item.jobId,
  });
  assert.strictEqual(timers.size, 1);

  await workflow.flushPendingDisplayCheckpoints();

  assert.strictEqual(timers.size, 0, 'page-leave flush must cancel the delayed writer');
  const snapshot = fallbackSnapshot(storage);
  assert.ok(snapshot);
  assert.strictEqual(snapshot.pendingDisplay[0].rawText, '刷新前屏幕上可见的完整前缀');
}

async function testCompletedMessageCancelsStalePartialCheckpoint() {
  const { workflow, session, timers } = createCheckpointWorkflow();
  const item = session.display[0];

  workflow.checkpointSessionDisplayItem(session.id, item, 'assistant', '部分回答', {
    rawText: '部分回答',
    responseIndex: 1,
    jobId: item.jobId,
  });
  assert.strictEqual(timers.size, 1);

  workflow.updateSessionDisplayItem(session.id, item, 'assistant', '最终完整回答', {
    rawText: '最终完整回答',
    responseIndex: 1,
    pending: false,
  });

  assert.strictEqual(timers.size, 0, 'completion must cancel the older partial checkpoint');
  assert.deepStrictEqual(session.display, [], 'completed answers belong to canonical messages, not pending display state');
}

function testRootStreamingProjectionCheckpointsStateBeforeSkippingDuplicateDomWork() {
  const source = fs.readFileSync(path.join(__dirname, '../../app.js'), 'utf8');
  const liveStart = source.indexOf('function updateLiveDisplay(');
  const leaveStart = source.indexOf('function persistBeforePageLeave(');
  assert.ok(liveStart >= 0 && leaveStart >= 0);
  const liveSource = source.slice(liveStart, liveStart + 2200);
  const leaveSource = source.slice(leaveStart, leaveStart + 500);

  assert.ok(liveSource.includes('o?checkpointSessionDisplayItem(e,t,s,n,{...a,pending:!0})'),
    'pending output must checkpoint session state even when the DOM was already updated directly');
  assert.ok(liveSource.indexOf('checkpointSessionDisplayItem') < liveSource.indexOf('if(!0===a.deferDomUpdate'),
    'the state checkpoint must happen before deferDomUpdate returns');
  assert.ok(leaveSource.includes('flushPendingDisplayCheckpoints(),saveDisplayHistory()'),
    'page leave must force all unexpired stream checkpoints before session snapshot flushing');
}

module.exports = [
  testStreamingCheckpointPersistsLatestVisiblePrefixForRefresh,
  testPageLeaveFlushPersistsUnexpiredStreamingCheckpoint,
  testCompletedMessageCancelsStalePartialCheckpoint,
  testRootStreamingProjectionCheckpointsStateBeforeSkippingDuplicateDomWork,
];
