#!/usr/bin/env node
const assert = require('assert');
const fs = require('fs');
const vm = require('vm');
const path = require('path');

function loadImageStore() {
  const win = { ChatUIApp: {}, console: { warn() {} }, fetch() {} };
  win.window = win;
  win.indexedDB = { open() { throw new Error('not used'); } };
  win.Image = class {};
  win.URL = { createObjectURL() { return 'blob:x'; }, revokeObjectURL() {} };
  vm.runInNewContext(fs.readFileSync(path.join(__dirname, '../../client/app/image-store.js'), 'utf8'), win);
  return win.ChatUIApp.imageStore;
}

const imageStore = loadImageStore();
assert.strictEqual(imageStore.TRANSPARENT_PIXEL.startsWith('data:image/gif;base64,'), true);
assert.deepStrictEqual([...imageStore.collectIndexedDbKeys({ html: '<img src="indexeddb://img-a">', list: ['indexeddb://img-b'] })].sort(), ['img-a', 'img-b']);
assert.deepStrictEqual(JSON.parse(JSON.stringify(imageStore.fitImageThumb(1000, 500, 200, 200))), { width: 200, height: 100 });
assert.deepStrictEqual(JSON.parse(JSON.stringify(imageStore.fitImageThumb(0, 0, 160, 120))), { width: 160, height: 120 });
console.log('image store ok');
