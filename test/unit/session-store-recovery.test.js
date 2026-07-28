'use strict';

const assert = require('assert');
const sessionStore = require('../../client/app/session-store');

function delay(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

function within(promise, timeoutMs = 500) {
  return Promise.race([
    promise,
    new Promise((_, reject) => setTimeout(() => reject(new Error(`timed out after ${timeoutMs}ms`)), timeoutMs)),
  ]);
}

function namedError(name, message = name) {
  const error = new Error(message);
  error.name = name;
  return error;
}

function createTransaction(operationHandler, stats) {
  const tx = {
    error: null,
    oncomplete: null,
    onerror: null,
    onabort: null,
    objectStore() {
      return {
        get: key => run('get', [key]),
        put: (value, key) => run('put', [value, key]),
        delete: key => run('delete', [key]),
        clear: () => run('clear', []),
      };
    },
    abort() {
      stats.aborts += 1;
      const handler = tx.onabort;
      if (typeof handler === 'function') setTimeout(() => handler(), 0);
    },
  };

  function run(operation, args) {
    const request = { result: undefined, error: null, onerror: null };
    operationHandler({ operation, args, request, tx });
    return request;
  }

  return tx;
}

function createFakeIndexedDb(operationHandler) {
  const stats = { openCalls: 0, closeCalls: 0, aborts: 0, transactions: [] };
  return {
    stats,
    impl: {
      open() {
        stats.openCalls += 1;
        const openCall = stats.openCalls;
        const request = { result: null, error: null };
        setTimeout(() => {
          const db = {
            objectStoreNames: { contains: () => true },
            onversionchange: null,
            onclose: null,
            createObjectStore() {},
            close() {
              stats.closeCalls += 1;
              const handler = db.onclose;
              if (typeof handler === 'function') handler();
            },
            transaction(storeName, mode) {
              const record = { storeName, mode, openCall };
              stats.transactions.push(record);
              return createTransaction(context => operationHandler({ ...context, mode, openCall, record }), stats);
            },
          };
          request.result = db;
          request.onsuccess?.();
        }, 0);
        return request;
      },
    },
  };
}

function createStore(indexedDBImpl, options = {}) {
  return sessionStore.createSessionSnapshotStore({
    indexedDBImpl,
    operationTimeoutMs: 15,
    retryBaseDelayMs: 5,
    retryMaxDelayMs: 20,
    flushWaitMs: 20,
    logger: { warn() {} },
    ...options,
  });
}

async function testIndexedDbOpenTimeoutClosesLateConnection() {
  let request;
  let closeCalls = 0;
  const store = createStore({
    open() {
      request = { result: null, error: null };
      return request;
    },
  });

  await assert.rejects(within(store.openDb()), error => {
    assert.strictEqual(error.name, 'IndexedDBTimeoutError');
    assert.strictEqual(error.code, 'IDB_OPERATION_TIMEOUT');
    assert.strictEqual(error.transient, true);
    return true;
  });

  request.result = {
    objectStoreNames: { contains: () => true },
    close() { closeCalls += 1; },
  };
  request.onsuccess();
  assert.strictEqual(closeCalls, 1, 'a database opened after the timeout must be closed instead of leaked');
}

async function testSnapshotReadTimeoutReopensConnection() {
  let readAttempts = 0;
  const fake = createFakeIndexedDb(({ operation, request, tx }) => {
    if (operation !== 'get') throw new Error(`unexpected operation ${operation}`);
    readAttempts += 1;
    if (readAttempts === 1) return;
    request.result = { id: 'read-session', snapshotVersion: 2, updatedAt: 2, messages: [] };
    setTimeout(() => tx.oncomplete?.(), 0);
  });
  const store = createStore(fake.impl);

  await assert.rejects(within(store.getSnapshot('read-session')), error => error.name === 'IndexedDBTimeoutError');
  const snapshot = await within(store.getSnapshot('read-session'));

  assert.strictEqual(snapshot.updatedAt, 2);
  assert.strictEqual(fake.stats.openCalls, 2, 'a timed-out read must discard the unhealthy connection');
  assert.ok(fake.stats.aborts >= 1, 'a timed-out transaction should be aborted');
}

async function testRetryPersistsNewestSnapshotAfterStalledWrite() {
  let writeAttempts = 0;
  let firstWriteStarted;
  const firstStarted = new Promise(resolve => { firstWriteStarted = resolve; });
  const durableWrites = [];
  const fake = createFakeIndexedDb(({ operation, args, request, tx }) => {
    if (operation !== 'put') throw new Error(`unexpected operation ${operation}`);
    writeAttempts += 1;
    if (writeAttempts === 1) {
      firstWriteStarted();
      return;
    }
    durableWrites.push(args[0]);
    request.result = args[1];
    setTimeout(() => tx.oncomplete?.(), 0);
  });
  const store = createStore(fake.impl);
  const first = store.schedulePut({ id: 'retry-session', snapshotVersion: 2, updatedAt: 1, messages: [{ role: 'user', content: 'old' }] });
  await within(firstStarted);
  const second = store.schedulePut({ id: 'retry-session', snapshotVersion: 2, updatedAt: 2, messages: [{ role: 'user', content: 'new' }] });

  assert.strictEqual(first, second, 'writes for one session should share one durable queue promise');
  const result = await within(second);

  assert.strictEqual(result.updatedAt, 2);
  assert.deepStrictEqual(durableWrites.map(snapshot => snapshot.updatedAt), [2], 'retry must persist the newest pending revision, not resurrect the stalled revision');
  assert.strictEqual(fake.stats.openCalls, 2, 'retry should use a rebuilt IndexedDB connection');
}

async function testDeleteCancelsScheduledRetryAndSettlesQueue() {
  let writeAttempts = 0;
  let retryScheduled;
  const scheduled = new Promise(resolve => { retryScheduled = resolve; });
  const fake = createFakeIndexedDb(({ operation, tx }) => {
    if (operation === 'put') {
      writeAttempts += 1;
      tx.error = namedError('UnknownError', 'temporary write failure');
      setTimeout(() => tx.onerror?.(), 0);
      return;
    }
    if (operation === 'delete') {
      setTimeout(() => tx.oncomplete?.(), 0);
      return;
    }
    throw new Error(`unexpected operation ${operation}`);
  });
  const store = createStore(fake.impl, {
    retryBaseDelayMs: 60,
    retryMaxDelayMs: 60,
    logger: {
      warn(message) {
        if (String(message).includes('retrying')) retryScheduled();
      },
    },
  });

  const queuedWrite = store.schedulePut({ id: 'deleted-session', snapshotVersion: 2, updatedAt: 1, messages: [] });
  await within(scheduled);
  await within(store.deleteSnapshot('deleted-session'));
  await within(queuedWrite);
  await delay(90);

  assert.strictEqual(writeAttempts, 1, 'deleting a session must cancel its pending retry timer');
  const ignored = await store.schedulePut({ id: 'deleted-session', updatedAt: 2, messages: [] });
  assert.strictEqual(ignored, null);
  assert.strictEqual(writeAttempts, 1, 'the deletion tombstone must prevent late code from recreating the snapshot');
}


async function testFlushIsBoundedAndClearCancelsStalledQueue() {
  let writeAttempts = 0;
  let clearAttempts = 0;
  let writeStarted;
  const started = new Promise(resolve => { writeStarted = resolve; });
  const fake = createFakeIndexedDb(({ operation, tx }) => {
    if (operation === 'put') {
      writeAttempts += 1;
      writeStarted();
      return;
    }
    if (operation === 'clear') {
      clearAttempts += 1;
      setTimeout(() => tx.oncomplete?.(), 0);
      return;
    }
    throw new Error(`unexpected operation ${operation}`);
  });
  const store = createStore(fake.impl, {
    operationTimeoutMs: 100,
    retryBaseDelayMs: 100,
    retryMaxDelayMs: 100,
    flushWaitMs: 15,
  });
  const queuedWrite = store.schedulePut({ id: 'clear-session', snapshotVersion: 2, updatedAt: 1, messages: [] });
  await within(started);

  const flushStartedAt = Date.now();
  await within(store.flush('clear-session'));
  assert.ok(Date.now() - flushStartedAt < 100, 'flush should return within its own bound while background recovery continues');

  await within(store.clear());
  await within(queuedWrite);
  await delay(130);
  assert.strictEqual(writeAttempts, 1, 'clear must cancel retries for all queued sessions');
  assert.strictEqual(clearAttempts, 1, 'clear should still remove already durable snapshots');
}

async function testPermanentWriteErrorIsNotRetried() {
  let writeAttempts = 0;
  const fake = createFakeIndexedDb(({ operation }) => {
    if (operation !== 'put') throw new Error(`unexpected operation ${operation}`);
    writeAttempts += 1;
    throw namedError('DataCloneError', 'unsupported snapshot value');
  });
  const store = createStore(fake.impl);

  await assert.rejects(within(store.schedulePut({ id: 'bad-session', snapshotVersion: 2, updatedAt: 1, messages: [] })),
    error => error.name === 'DataCloneError');
  await delay(40);
  assert.strictEqual(writeAttempts, 1, 'permanent serialization errors must not enter an endless retry loop');
}

module.exports = [
  testIndexedDbOpenTimeoutClosesLateConnection,
  testSnapshotReadTimeoutReopensConnection,
  testRetryPersistsNewestSnapshotAfterStalledWrite,
  testDeleteCancelsScheduledRetryAndSettlesQueue,
  testFlushIsBoundedAndClearCancelsStalledQueue,
  testPermanentWriteErrorIsNotRetried,
];
