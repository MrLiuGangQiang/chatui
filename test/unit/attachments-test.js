#!/usr/bin/env node
const assert = require('assert');
const {
  isImageFile,
  isCompressibleRasterImage,
  formatBytes,
  normalizeImageContextForStorage,
  parseImageContext,
  looksLikeImageEditInstruction,
} = require('../../client/core/attachments');

assert.strictEqual(isImageFile({ type: 'image/png' }), true);
assert.strictEqual(isImageFile({ name: 'a.webp' }), true);
assert.strictEqual(isImageFile({ name: 'a.pdf' }), false);
assert.strictEqual(isCompressibleRasterImage({ type: 'image/gif' }), false);
assert.strictEqual(isCompressibleRasterImage({ name: 'a.jpg' }), true);
assert.strictEqual(formatBytes(512), '512 B');
assert.strictEqual(formatBytes(2048), '2.0 KB');
assert.strictEqual(formatBytes(3 * 1024 * 1024), '3.0 MB');
assert.deepStrictEqual(normalizeImageContextForStorage({ mode: 'edit_image', usePreviousImage: true, attachments: [{ name: 'a.png', type: 'image/png', size: '10', persistedSrc: 'indexeddb://x' }] }), {
  mode: 'edit_image',
  prompt: '',
  usePreviousImage: true,
  attachments: [{ name: 'a.png', type: 'image/png', size: 10, src: 'indexeddb://x' }],
});
assert.strictEqual(parseImageContext('{bad'), null);
assert.strictEqual(parseImageContext('{"attachments":[{"src":"x"}]}').attachments[0].src, 'x');
assert.strictEqual(looksLikeImageEditInstruction('把背景换成蓝色'), true);
assert.strictEqual(looksLikeImageEditInstruction('画一只猫'), false);
console.log('attachments ok');
