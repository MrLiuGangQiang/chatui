'use strict';

const assert = require('assert');
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const IMAGE_STORE_SOURCE = fs.readFileSync(path.join(__dirname, '../../client/app/image-store.js'), 'utf8');

function loadImageStore(overrides = {}) {
  const warnings = [];
  const existingFeature = Object.freeze({ ready: true });
  const sandbox = {
    window: { ChatUIApp: { existingFeature } },
    console: { warn: (...args) => warnings.push(args) },
    fetch: overrides.fetch || (async () => { throw new Error('unexpected fetch'); }),
    ...overrides.globals,
  };
  vm.runInNewContext(IMAGE_STORE_SOURCE, sandbox, { filename: 'client/app/image-store.js' });
  return {
    api: sandbox.window.ChatUIApp.imageStore,
    app: sandbox.window.ChatUIApp,
    existingFeature,
    warnings,
  };
}

function createMemoryIndexedDb({ openError = null, transactionError = null, requestErrors = {} } = {}) {
  const data = new Map();
  const stats = {
    opens: [],
    createdStores: [],
    transactions: [],
    puts: [],
    deletes: [],
    clears: 0,
  };
  let upgraded = false;

  const db = {
    createObjectStore(name) {
      stats.createdStores.push(name);
      return {};
    },
    transaction(storeName, mode) {
      const tx = {
        error: null,
        oncomplete: null,
        onerror: null,
        objectStore(requestedStoreName) {
          assert.strictEqual(requestedStoreName, storeName);
          return {
            put(value, key) {
              stats.puts.push({ key, value });
              if (!transactionError) data.set(key, value);
            },
            get(key) {
              const request = { result: undefined, error: null, onsuccess: null, onerror: null };
              queueMicrotask(() => {
                const error = requestErrors.get;
                if (error) {
                  request.error = error;
                  request.onerror?.();
                  return;
                }
                request.result = data.get(key);
                request.onsuccess?.();
              });
              return request;
            },
            delete(key) {
              stats.deletes.push(key);
              if (!transactionError) data.delete(key);
            },
            clear() {
              stats.clears += 1;
              if (!transactionError) data.clear();
            },
            getAllKeys() {
              const request = { result: undefined, error: null, onsuccess: null, onerror: null };
              queueMicrotask(() => {
                const error = requestErrors.getAllKeys;
                if (error) {
                  request.error = error;
                  request.onerror?.();
                  return;
                }
                request.result = [...data.keys()];
                request.onsuccess?.();
              });
              return request;
            },
          };
        },
      };
      stats.transactions.push({ storeName, mode });
      queueMicrotask(() => {
        if (transactionError) {
          tx.error = transactionError;
          tx.onerror?.();
        } else {
          tx.oncomplete?.();
        }
      });
      return tx;
    },
  };

  return {
    data,
    stats,
    impl: {
      open(name, version) {
        stats.opens.push({ name, version });
        const request = { result: db, error: null, onupgradeneeded: null, onsuccess: null, onerror: null };
        queueMicrotask(() => {
          if (openError) {
            request.error = openError;
            request.onerror?.();
            return;
          }
          if (!upgraded) {
            request.onupgradeneeded?.();
            upgraded = true;
          }
          request.onsuccess?.();
        });
        return request;
      },
    },
  };
}

async function testImageStoreRegistersFrozenFacadeAndOpensVersionedSchema() {
  const loaded = loadImageStore();
  const fake = createMemoryIndexedDb();
  const store = loaded.api.createImageStore({
    dbName: 'test-image-db',
    storeName: 'test-images',
    indexedDBImpl: fake.impl,
  });

  assert.strictEqual(loaded.app.existingFeature, loaded.existingFeature, 'image-store registration must preserve existing app features');
  assert.strictEqual(Object.isFrozen(loaded.app), true);
  assert.strictEqual(Object.isFrozen(loaded.api), true);
  assert.strictEqual(Object.isFrozen(store), true);
  assert.deepStrictEqual(Object.keys(store).sort(), [
    'clearImageDb',
    'deleteImageDbKeys',
    'getImageBlob',
    'getImageDbKeys',
    'openImageDb',
    'putImageBlob',
  ]);

  const firstDb = await store.openImageDb();
  const secondDb = await store.openImageDb();
  assert.strictEqual(firstDb, secondDb);
  assert.deepStrictEqual(fake.stats.opens, [
    { name: 'test-image-db', version: 1 },
    { name: 'test-image-db', version: 1 },
  ]);
  assert.deepStrictEqual(fake.stats.createdStores, ['test-images'], 'the object store must be created only during the first schema upgrade');
}

async function testImageStoreCrudListsDeletesUniqueKeysAndClears() {
  const { api } = loadImageStore();
  const fake = createMemoryIndexedDb();
  const store = api.createImageStore({ indexedDBImpl: fake.impl });
  const firstBlob = Object.freeze({ type: 'image/png', bytes: 'first' });
  const secondBlob = Object.freeze({ type: 'image/webp', bytes: 'second' });

  await store.putImageBlob('first', firstBlob);
  await store.putImageBlob('second', secondBlob);
  assert.strictEqual(await store.getImageBlob('first'), firstBlob, 'the stored Blob-like value must not be cloned or rewritten by the wrapper');
  assert.strictEqual(await store.getImageBlob('missing'), null);

  const firstKeys = await store.getImageDbKeys();
  assert.deepStrictEqual(Array.from(firstKeys).sort(), ['first', 'second']);
  firstKeys.push('caller-only');
  assert.deepStrictEqual(Array.from(await store.getImageDbKeys()).sort(), ['first', 'second'], 'returned key arrays must not expose mutable store state');

  const requestedDeletes = ['first', 'first', '', null, 'missing'];
  const originalDeletes = [...requestedDeletes];
  await store.deleteImageDbKeys(requestedDeletes);
  assert.deepStrictEqual(requestedDeletes, originalDeletes, 'delete key normalization must not mutate caller input');
  assert.deepStrictEqual(fake.stats.deletes, ['first', 'missing'], 'truthy delete keys must be deduplicated before opening a transaction');
  assert.strictEqual(await store.getImageBlob('first'), null);
  assert.strictEqual(await store.getImageBlob('second'), secondBlob);

  const transactionCount = fake.stats.transactions.length;
  await store.deleteImageDbKeys([]);
  assert.strictEqual(fake.stats.transactions.length, transactionCount, 'an empty delete must not open a transaction');

  await store.clearImageDb();
  assert.deepStrictEqual(Array.from(await store.getImageDbKeys()), []);
  assert.strictEqual(fake.stats.clears, 1);
  assert.ok(fake.stats.transactions.some(item => item.mode === 'readonly'));
  assert.ok(fake.stats.transactions.some(item => item.mode === 'readwrite'));
}

function testImageStoreCollectsUniqueIndexedDbKeysAcrossCycles() {
  const { api } = loadImageStore();
  const seed = new Set(['seed-key']);
  const nested = {
    html: '<img src="indexeddb://image-a">',
    duplicate: 'indexeddb://image-a indexeddb://image-b',
    quoted: "indexeddb://image-c' ignored",
    escaped: 'indexeddb://image-d\\ignored',
    values: [null, false, { href: 'indexeddb://image-b' }],
  };
  nested.self = nested;

  const result = api.collectIndexedDbKeys(nested, seed);
  assert.strictEqual(result, seed, 'callers must be able to accumulate into one shared Set');
  assert.deepStrictEqual([...result].sort(), ['image-a', 'image-b', 'image-c', 'image-d', 'seed-key']);
  assert.strictEqual(nested.self, nested, 'cycle protection must not rewrite the scanned object graph');
  assert.strictEqual(nested.values.length, 3);
}

async function testImageStoreFallsBackSafelyForUnavailableIndexedDb() {
  const { api, warnings } = loadImageStore();
  const defaultStore = api.createImageStore();
  const store = api.createImageStore({ indexedDBImpl: null });

  await assert.rejects(defaultStore.openImageDb(), /IndexedDB is unavailable/);
  await assert.rejects(store.openImageDb(), /IndexedDB is unavailable/);
  await assert.rejects(store.putImageBlob('key', {}), /IndexedDB is unavailable/);
  await assert.rejects(store.getImageBlob('key'), /IndexedDB is unavailable/);

  assert.strictEqual(await store.clearImageDb(), undefined);
  assert.strictEqual(await store.deleteImageDbKeys(['key', 'key']), undefined);
  assert.deepStrictEqual(Array.from(await store.getImageDbKeys()), []);
  assert.deepStrictEqual(warnings.map(args => args[0]), [
    'clear image db failed',
    'delete image db keys failed',
    'list image db keys failed',
  ]);

  const warningCount = warnings.length;
  await store.deleteImageDbKeys([]);
  assert.strictEqual(warnings.length, warningCount, 'empty cleanup must remain a no-op when IndexedDB is unavailable');
}

async function testImageStorePropagatesOpenAndRequestFailures() {
  const { api } = loadImageStore();
  const openError = new Error('database open failed');
  const openFailure = api.createImageStore({ indexedDBImpl: createMemoryIndexedDb({ openError }).impl });
  await assert.rejects(openFailure.openImageDb(), error => error === openError);
  await assert.rejects(openFailure.putImageBlob('key', {}), error => error === openError);
  await assert.rejects(openFailure.getImageBlob('key'), error => error === openError);

  const transactionError = new Error('write transaction failed');
  const writeFailure = api.createImageStore({ indexedDBImpl: createMemoryIndexedDb({ transactionError }).impl });
  const value = Object.freeze({ type: 'image/png' });
  await assert.rejects(writeFailure.putImageBlob('key', value), error => error === transactionError);

  const readError = new Error('image read failed');
  const readFailure = api.createImageStore({ indexedDBImpl: createMemoryIndexedDb({ requestErrors: { get: readError } }).impl });
  await assert.rejects(readFailure.getImageBlob('key'), error => error === readError);

  const listError = new Error('key scan failed');
  const { api: fallbackApi, warnings } = loadImageStore();
  const listFailure = fallbackApi.createImageStore({ indexedDBImpl: createMemoryIndexedDb({ requestErrors: { getAllKeys: listError } }).impl });
  assert.deepStrictEqual(Array.from(await listFailure.getImageDbKeys()), []);
  assert.strictEqual(warnings.length, 1);
  assert.strictEqual(warnings[0][0], 'list image db keys failed');
  assert.strictEqual(warnings[0][1], listError);
}

module.exports = [
  testImageStoreRegistersFrozenFacadeAndOpensVersionedSchema,
  testImageStoreCrudListsDeletesUniqueKeysAndClears,
  testImageStoreCollectsUniqueIndexedDbKeysAcrossCycles,
  testImageStoreFallsBackSafelyForUnavailableIndexedDb,
  testImageStorePropagatesOpenAndRequestFailures,
];
