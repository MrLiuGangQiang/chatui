'use strict';

const assert = require('assert');
const skinCore = require('../../client/core/skin');

function makeStorage(initial = {}) {
  const data = new Map(Object.entries(initial));
  return {
    data,
    getItem(key) { return data.has(key) ? data.get(key) : null; },
    setItem(key, value) { data.set(key, value); },
    removeItem(key) { data.delete(key); },
  };
}

function testSkinCatalogIsBoundedAndStable() {
  assert.ok(Array.isArray(skinCore.SKINS));
  assert.deepStrictEqual(skinCore.SKINS.map(skin => skin.id), ['default', 'ink', 'snow']);
  for (const skin of skinCore.SKINS) {
    assert.strictEqual(typeof skin.id, 'string');
    assert.strictEqual(typeof skin.label, 'string');
    assert.strictEqual(typeof skin.description, 'string');
  }
  assert.strictEqual(skinCore.SKINS.find(skin => skin.id === 'ink')?.label, '古韵', 'the ink skin must keep its renamed label');
  assert.strictEqual(skinCore.SKINS.find(skin => skin.id === 'snow')?.label, '雪山', 'the snow skin must keep its label');
}

function testUnknownSkinIdFallsBackToDefault() {
  assert.strictEqual(skinCore.normalizeSkinId('ink'), 'ink');
  assert.strictEqual(skinCore.normalizeSkinId('Ink'), 'default');
  assert.strictEqual(skinCore.normalizeSkinId(''), 'default');
  assert.strictEqual(skinCore.normalizeSkinId(null), 'default');
  assert.strictEqual(skinCore.normalizeSkinId('<script>'), 'default');
}

function testSkinReadIsSafeAndDefaultsWhenStorageFails() {
  const storage = makeStorage({ [skinCore.SKIN_STORAGE_KEY]: 'ink' });
  assert.strictEqual(skinCore.readSkinId(storage), 'ink');
  assert.strictEqual(skinCore.readSkinId(makeStorage({ [skinCore.SKIN_STORAGE_KEY]: 'broken' })), 'default');
  assert.strictEqual(skinCore.readSkinId(null), 'default');
  const throwingStorage = { getItem() { throw new Error('blocked'); } };
  assert.strictEqual(skinCore.readSkinId(throwingStorage), 'default');
}

function testSkinWritePersistsOnlyValidIds() {
  const storage = makeStorage();
  assert.strictEqual(skinCore.writeSkinId(storage, 'ink'), 'ink');
  assert.strictEqual(storage.data.get(skinCore.SKIN_STORAGE_KEY), 'ink');
  assert.strictEqual(skinCore.writeSkinId(storage, 'nope'), 'default');
  assert.strictEqual(storage.data.get(skinCore.SKIN_STORAGE_KEY), 'default');
  const errors = [];
  const throwingStorage = { setItem() { throw new Error('quota'); } };
  assert.strictEqual(skinCore.writeSkinId(throwingStorage, 'ink', { onError: error => errors.push(error) }), 'ink');
  assert.strictEqual(errors.length, 1);
}

module.exports = [
  testSkinCatalogIsBoundedAndStable,
  testUnknownSkinIdFallsBackToDefault,
  testSkinReadIsSafeAndDefaultsWhenStorageFails,
  testSkinWritePersistsOnlyValidIds,
];
