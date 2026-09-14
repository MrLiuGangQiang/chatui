'use strict';

const assert = require('assert');
const recoveryApi = require('../../client/services/session-snapshot-recovery');

function createStorage({ maxValueLength = 65536 } = {}) {
  const values = new Map();
  const attempts = [];
  const usedBytes = () => [...values.values()].reduce((total, value) => total + String(value).length, 0);
  return {
    values,
    attempts,
    get length() { return values.size; },
    key(index) { return [...values.keys()][Number(index)] ?? null; },
    getItem(key) { return values.has(key) ? values.get(key) : null; },
    setItem(key, value) {
      const text = String(value);
      const previous = values.get(String(key));
      attempts.push(text.length);
      if (usedBytes() - String(previous || '').length + text.length > maxValueLength) {
        const error = new Error('quota exceeded');
        error.name = 'QuotaExceededError';
        throw error;
      }
      values.set(String(key), text);
    },
    removeItem(key) { values.delete(String(key)); },
  };
}

function testSessionFallbackNeverSerializesTheWholeConversation() {
  const localStorage = createStorage({ maxValueLength: 65536 });
  const recovery = recoveryApi.createSessionSnapshotRecovery({
    localStorageRef: localStorage,
    sessionStoreApi: { buildSessionSnapshot: session => ({ ...session }) },
    logger: { warn() {} },
  });
  const messages = Array.from({ length: 200 }, (_, index) => ({
    role: index % 2 === 0 ? 'user' : 'assistant',
    content: `message-${index}-` + 'x'.repeat(2000),
    rawText: `message-${index}-` + 'x'.repeat(2000),
    messageIndex: index % 2 === 0 ? String(index) : undefined,
    responseIndex: index % 2 === 1 ? String(index) : undefined,
  }));
  const snapshot = {
    id: 'session-large',
    snapshotVersion: 2,
    updatedAt: 100,
    messages,
    pendingDisplay: [],
    lastGeneratedImage: null,
  };

  assert.strictEqual(recovery.writeSnapshotFallback(snapshot, 0), true);
  assert.ok(localStorage.attempts.length >= 1);
  assert.ok(localStorage.attempts.every(length => length <= 65536),
    'fallback serialization must never attempt the complete conversation');
  const fallback = JSON.parse(localStorage.getItem('chat-sessions:snapshot-fallback:session-large'));
  assert.strictEqual(fallback.partial, true);
  assert.ok(fallback.messages.length <= 12);
}


function testSingleDocumentSizedMessageIsTruncatedInTheFallback() {
  const localStorage = createStorage({ maxValueLength: 65536 });
  const recovery = recoveryApi.createSessionSnapshotRecovery({
    localStorageRef: localStorage,
    sessionStoreApi: { buildSessionSnapshot: session => ({ ...session }) },
    logger: { warn() {} },
  });
  const snapshot = {
    id: 'session-huge-message',
    snapshotVersion: 2,
    updatedAt: 101,
    messages: [{
      role: 'assistant',
      content: 'answer:' + 'x'.repeat(500000),
      rawText: 'answer:' + 'x'.repeat(500000),
      responseIndex: '1',
    }],
    pendingDisplay: [],
    lastGeneratedImage: null,
  };

  assert.strictEqual(recovery.writeSnapshotFallback(snapshot, 0), true);
  assert.ok(localStorage.attempts.every(length => length <= 65536));
  const fallback = JSON.parse(localStorage.getItem('chat-sessions:snapshot-fallback:session-huge-message'));
  assert.strictEqual(fallback.messages.length, 1);
  assert.ok(fallback.messages[0].content.length <= 4096,
    'a single document-sized message must be truncated before entering localStorage');
}

function testQuotaPurgesLegacyFullHistoryFallbackRecords() {
  const localStorage = createStorage({ maxValueLength: 65536 });
  const legacyKey = 'chat-sessions:snapshot-fallback:legacy-session';
  localStorage.values.set(legacyKey, JSON.stringify({ id: 'legacy-session', updated: 1, messages: 'x'.repeat(500000) }));
  const recovery = recoveryApi.createSessionSnapshotRecovery({
    localStorageRef: localStorage,
    sessionStoreApi: { buildSessionSnapshot: session => ({ ...session }) },
    logger: { warn() {} },
  });
  const snapshot = {
    id: 'session-after-legacy',
    snapshotVersion: 2,
    updatedAt: 102,
    messages: [{ role: 'user', content: 'latest question', messageIndex: '0' }],
    pendingDisplay: [],
    lastGeneratedImage: null,
  };

  assert.strictEqual(recovery.writeSnapshotFallback(snapshot, 0), true);
  assert.strictEqual(localStorage.getItem(legacyKey), null,
    'a quota retry must purge disposable legacy full-history fallback records');
  assert.ok(localStorage.getItem('chat-sessions:snapshot-fallback:session-after-legacy'));
}

function testMetadataFailureRetriesAfterFallbackRecovery() {
  const localStorage = createStorage({ maxValueLength: 65536 });
  let metadataCalls = 0;
  const recovery = recoveryApi.createSessionSnapshotRecovery({
    localStorageRef: localStorage,
    sessionStoreApi: { buildSessionSnapshot: session => ({ ...session }) },
    logger: { warn() {} },
    saveSessionsMeta() {
      metadataCalls += 1;
      return metadataCalls > 1;
    },
  });
  const result = recovery.retainRecoverableSnapshot({
    id: 'session-metadata-retry',
    snapshotVersion: 2,
    updatedAt: 103,
    messages: [{ role: 'assistant', content: 'answer', responseIndex: '1' }],
    pendingDisplay: [],
    lastGeneratedImage: null,
  });

  assert.strictEqual(metadataCalls, 2);
  assert.strictEqual(result.recoverable, true);
  assert.strictEqual(result.metadataAvailable, true);
  assert.strictEqual(result.fallbackRetained, true);
}

module.exports = [
  testSessionFallbackNeverSerializesTheWholeConversation,
  testSingleDocumentSizedMessageIsTruncatedInTheFallback,
  testQuotaPurgesLegacyFullHistoryFallbackRecords,
  testMetadataFailureRetriesAfterFallbackRecovery,
];
