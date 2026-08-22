'use strict';

const assert = require('assert');
const upgrade = require('../../client/app/runtime-upgrade-workflow');

function createStorage(initial = {}) {
  const values = new Map(Object.entries(initial));
  return {
    get length() { return values.size; },
    key(index) { return [...values.keys()][index] || null; },
    getItem(key) { return values.has(key) ? values.get(key) : null; },
    setItem(key, value) { values.set(key, String(value)); },
    removeItem(key) { values.delete(key); },
    has(key) { return values.has(key); },
  };
}

const identity = sourceRevision => ({ version: '1.10.68', gitSha: 'new-sha', sourceRevision });

function testRuntimeChangeInvalidatesOnlyTransientExecutionState() {
  const storage = createStorage({
    'chatui:runtime-state': JSON.stringify({
      schema_version: 'runtime_state.v1',
      source_revision: 'sha256:old',
      version: '1.10.67',
    }),
    'openapi-chat-image-job-v1:session-a': '{}',
    'openapi-chat-image-chat-job-v1:session-a': '{}',
    'openapi-chat-image-pending-submit-v1:session-a': '{}',
    'openapi-chat-image-sessions-v1': 'historical sessions stay',
    'openapi-chat-image-config-v2': 'configuration stays',
  });
  const sessions = [{
    id: 'session-a',
    display: [{ id: 'pending', pending: '1' }, { id: 'done', pending: '' }],
  }];
  const persisted = [];
  const savedMessages = [];
  sessions[0].messages = [{ role: 'user', content: 'retry me' }];
  return upgrade.reconcileRuntimeUpgrade({
    identity: identity('sha256:new'),
    storage,
    sessions,
    persistSessionDisplay: async id => persisted.push(id),
    saveSessionMessages: async id => savedMessages.push(id),
    now: () => 100,
  }).then(result => {
    assert.strictEqual(result.changed, true);
    assert.strictEqual(storage.has('openapi-chat-image-job-v1:session-a'), false);
    assert.strictEqual(storage.has('openapi-chat-image-chat-job-v1:session-a'), false);
    assert.strictEqual(storage.has('openapi-chat-image-pending-submit-v1:session-a'), false);
    assert.strictEqual(storage.has('openapi-chat-image-sessions-v1'), true);
    assert.strictEqual(storage.has('openapi-chat-image-config-v2'), true);
    assert.deepStrictEqual(sessions[0].display.map(item => item.id), ['done']);
    assert.deepStrictEqual(persisted, ['session-a']);
    assert.deepStrictEqual(savedMessages, ['session-a']);
    assert.match(sessions[0].messages.at(-1).content, /应用已更新/);
    assert.deepStrictEqual(upgrade.readRuntimeState(storage), {
      version: '1.10.68', gitSha: 'new-sha', sourceRevision: 'sha256:new',
    });
  });
}

async function testSameRuntimeDoesNotTouchHistoricalSessionsOrTasks() {
  const storage = createStorage({
    'chatui:runtime-state': JSON.stringify({
      schema_version: 'runtime_state.v1',
      source_revision: 'sha256:same',
      version: '1.10.68',
    }),
    'openapi-chat-image-job-v1:session-a': '{}',
  });
  const sessions = [{ id: 'session-a', display: [{ id: 'pending', pending: '1' }] }];
  let writes = 0;
  const result = await upgrade.reconcileRuntimeUpgrade({
    identity: identity('sha256:same'), storage, sessions,
    persistSessionDisplay: async () => { writes += 1; },
  });
  assert.strictEqual(result.changed, false);
  assert.strictEqual(storage.has('openapi-chat-image-job-v1:session-a'), true);
  assert.strictEqual(writes, 0);
  assert.strictEqual(sessions[0].display.length, 1);
}


async function testMissingRuntimeMarkerQuarantinesLegacyTransientTasksOnce() {
  const storage = createStorage({
    'openapi-chat-image-job-v1:session-a': '{}',
    'openapi-chat-image-sessions-v1': 'completed history stays',
  });
  const sessions = [{ id: 'session-a', display: [{ id: 'pending', pending: '1' }] }];
  const result = await upgrade.reconcileRuntimeUpgrade({
    identity: identity('sha256:first-new-runtime'), storage, sessions,
    persistSessionDisplay: async () => {},
  });
  assert.strictEqual(result.changed, true);
  assert.strictEqual(result.reason, 'legacy-runtime-state');
  assert.strictEqual(storage.has('openapi-chat-image-job-v1:session-a'), false);
  assert.strictEqual(storage.has('openapi-chat-image-sessions-v1'), true);
  assert.deepStrictEqual(sessions[0].display, []);
}

module.exports = [testRuntimeChangeInvalidatesOnlyTransientExecutionState, testSameRuntimeDoesNotTouchHistoricalSessionsOrTasks, testMissingRuntimeMarkerQuarantinesLegacyTransientTasksOnce];
