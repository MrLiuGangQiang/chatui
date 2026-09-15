'use strict';

const assert = require('assert');
const storeApi = require('../../client/services/stream-checkpoint-store');

function createFakeIndexedDB() {
  const records = new Map();
  const db = {
    objectStoreNames: { contains: () => true },
    onversionchange: null,
    onclose: null,
    close() {},
    transaction() {
      const tx = {
        error: null,
        oncomplete: null,
        onerror: null,
        onabort: null,
        objectStore() {
          return {
            put(value, key) { records.set(String(key), value); },
            get(key) {
              const request = {};
              queueMicrotask(() => {
                request.result = records.get(String(key)) || null;
              });
              return request;
            },
            delete(key) { records.delete(String(key)); },
            clear() { records.clear(); },
          };
        },
      };
      queueMicrotask(() => tx.oncomplete?.());
      return tx;
    },
  };
  return {
    records,
    open() {
      const request = { result: db, error: null };
      queueMicrotask(() => request.onsuccess?.());
      return request;
    },
  };
}

function longItem(sessionId, suffix) {
  return {
    id: `display-${sessionId}`,
    role: 'assistant',
    rawText: 'x'.repeat(storeApi.DEFAULT_CONTENT_TAIL_LIMIT + 2000) + `-${suffix}`,
    reasoningText: 'r'.repeat(storeApi.DEFAULT_REASONING_TAIL_LIMIT + 1000),
    html: '<div>must not persist</div>',
    responseIndex: '1',
    jobId: `job-${sessionId}`,
    pending: '1',
  };
}

function testBuildStreamCheckpointBoundsTextAndOmitsHistory() {
  assert.strictEqual(globalThis.ChatUIStreamCheckpointStore, undefined, 'the service must register through the module registry, not a new browser global');
  const item = longItem('session-a', 'one');
  item.rawText += ' data:image/png;base64,' + 'A'.repeat(3000);
  const record = storeApi.buildStreamCheckpoint('session-a', [item], { now: 42 });

  assert.strictEqual(record.version, 1);
  assert.strictEqual(record.sessionId, 'session-a');
  assert.strictEqual(record.updatedAt, 42);
  assert.strictEqual(Object.hasOwn(record, 'messages'), false);
  assert.strictEqual(record.items.length, 1);
  assert.ok(record.items[0].rawText.length <= storeApi.DEFAULT_CONTENT_TAIL_LIMIT);
  assert.strictEqual(record.items[0].reasoningText.length, storeApi.DEFAULT_REASONING_TAIL_LIMIT);
  assert.strictEqual(record.items[0].html, '');
  assert.ok(record.items[0].streamCheckpoint.contentLength > record.items[0].rawText.length);
  assert.ok(record.items[0].streamCheckpoint.reasoningLength > record.items[0].reasoningText.length);
  assert.strictEqual(record.items[0].streamCheckpoint.tailOnly, true);
  assert.ok(!record.items[0].rawText.includes('AAAA'), 'bounded cursor text must strip large inline data URLs');
  assert.ok(record.items[0].rawText.includes('[inline-media-omitted]'));
}

function testMergeStreamCheckpointRestoresCursorIdentityAndTailMarker() {
  const older = [{ id: 'display-session-a', role: 'assistant', rawText: 'older', responseIndex: '1', pending: '1' }];
  const checkpoint = storeApi.buildStreamCheckpoint('session-a', [longItem('session-a', 'latest')], { now: 50 });
  const merged = storeApi.mergeStreamCheckpointItems(older, checkpoint);

  assert.strictEqual(merged.length, 1);
  assert.strictEqual(merged[0].rawText, checkpoint.items[0].rawText);
  assert.strictEqual(merged[0].streamCheckpointRecovered, true);
  assert.strictEqual(merged[0].streamCheckpointTailOnly, true);
  assert.strictEqual(merged[0].html, '');
}

// A long generated artifact used to come back as only the last 64K: the bounded
// cursor overwrote the durable projection, so the head was gone before the
// durable job could be followed from its real offset.
function testMergeStreamCheckpointNeverShrinksADurablePendingProjection() {
  const fullText = '<!DOCTYPE html><body>' + 'A'.repeat(storeApi.DEFAULT_CONTENT_TAIL_LIMIT + 10000) + '</body></html>';
  const durable = [{
    id: 'display-webpage',
    role: 'assistant',
    rawText: fullText,
    reasoningText: 'reasoning-head ' + 'r'.repeat(storeApi.DEFAULT_REASONING_TAIL_LIMIT + 500),
    responseIndex: '1',
    jobId: 'chatjob-webpage',
    outputStarted: true,
    pending: '1',
  }];
  const checkpoint = storeApi.buildStreamCheckpoint('session-webpage', durable, { now: 90 });
  assert.strictEqual(checkpoint.items[0].streamCheckpoint.tailOnly, true, 'the cursor itself must stay bounded');
  assert.strictEqual(checkpoint.items[0].rawText.length, storeApi.DEFAULT_CONTENT_TAIL_LIMIT);

  const merged = storeApi.mergeStreamCheckpointItems(durable, checkpoint);
  assert.strictEqual(merged.length, 1);
  assert.strictEqual(merged[0].rawText.length, fullText.length, 'the durable text must not shrink to the bounded cursor tail');
  assert.strictEqual(merged[0].rawText.startsWith('<!DOCTYPE html><body>'), true);
  assert.strictEqual(merged[0].reasoningText.startsWith('reasoning-head'), true);
  assert.strictEqual(merged[0].streamCheckpointTailOnly, true, 'the tail marker must survive so UI stays in the recovery state');
  assert.strictEqual(merged[0].jobId, 'chatjob-webpage');
}

async function testStoreCoalescesLatestCursorPerSession() {
  const indexedDBImpl = createFakeIndexedDB();
  const store = storeApi.createStreamCheckpointStore({ indexedDBImpl, flushWaitMs: 1000 });
  const first = longItem('session-a', 'first');
  const latest = longItem('session-a', 'latest');

  store.schedulePut('session-a', [first]);
  store.schedulePut('session-a', [latest]);
  await store.flush('session-a');

  const saved = indexedDBImpl.records.get('session-a');
  assert.ok(saved, 'the latest checkpoint must be persisted');
  assert.ok(saved.items[0].rawText.endsWith('latest'), 'an older queued checkpoint must be replaced by the latest state');
  store.close();
}

async function testStoreDeletesCursorAndAllowsSameSessionIdAgain() {
  const indexedDBImpl = createFakeIndexedDB();
  const store = storeApi.createStreamCheckpointStore({ indexedDBImpl, flushWaitMs: 1000 });

  await store.schedulePut('session-a', [longItem('session-a', 'first')]);
  await store.flush('session-a');
  assert.ok(indexedDBImpl.records.has('session-a'));

  await store.delete('session-a');
  assert.strictEqual(indexedDBImpl.records.has('session-a'), false);
  assert.strictEqual(await store.get('session-a'), null);

  await store.schedulePut('session-a', [longItem('session-a', 'recreated')]);
  await store.flush('session-a');
  assert.ok(indexedDBImpl.records.has('session-a'), 'a deleted session id must be writable again when recreated');
  store.close();
}

module.exports = [
  testBuildStreamCheckpointBoundsTextAndOmitsHistory,
  testMergeStreamCheckpointRestoresCursorIdentityAndTailMarker,
  testMergeStreamCheckpointNeverShrinksADurablePendingProjection,
  testStoreCoalescesLatestCursorPerSession,
  testStoreDeletesCursorAndAllowsSameSessionIdAgain,
];
