#!/usr/bin/env node
const assert = require('assert');
const { readJsonStorage, safeSetJsonStorage, sessionStorageKey, collectIndexedDbKeys } = require('../../client/core/storage');

function makeStorage(seed = {}) {
  const map = new Map(Object.entries(seed));
  return {
    getItem: key => map.has(key) ? map.get(key) : null,
    setItem: (key, value) => { map.set(key, String(value)); },
    removeItem: key => { map.delete(key); },
    has: key => map.has(key),
  };
}

const storage = makeStorage({ ok: '{"a":1}', bad: '{' });
assert.deepStrictEqual(readJsonStorage(storage, 'ok', {}), { a: 1 });
assert.deepStrictEqual(readJsonStorage(storage, 'missing', { fallback: true }), { fallback: true });
assert.deepStrictEqual(readJsonStorage(storage, 'bad', { clean: true }), { clean: true });
assert.strictEqual(storage.has('bad'), false, 'invalid json cache is removed');
assert.strictEqual(safeSetJsonStorage(storage, 'next', { b: 2 }), true);
assert.deepStrictEqual(readJsonStorage(storage, 'next', {}), { b: 2 });
assert.strictEqual(sessionStorageKey('base', 's1'), 'base:s1');
assert.strictEqual(sessionStorageKey('base', ''), 'base:default');
assert.deepStrictEqual([...collectIndexedDbKeys({ html: '<img src="indexeddb://img-a">', list: ['indexeddb://img-b'] })].sort(), ['img-a', 'img-b']);

let called = false;
const failingStorage = { setItem() { throw new Error('quota'); } };
assert.strictEqual(safeSetJsonStorage(failingStorage, 'x', {}, { onQuotaError: () => { called = true; } }), false);
assert.strictEqual(called, true);
console.log('storage ok');
