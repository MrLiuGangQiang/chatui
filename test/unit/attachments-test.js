#!/usr/bin/env node
const assert = require('assert');
const {
  isImageFile,
  isCompressibleRasterImage,
  formatBytes,
  normalizeImageContextForStorage,
  parseImageContext,
  getLatestImageReferenceTarget,
  buildRouteAttachmentMetadata,
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
  target: '',
  prompt: '',
  usePreviousImage: true,
  updatedAt: null,
  attachments: [{ name: 'a.png', type: 'image/png', size: 10, src: 'indexeddb://x' }],
});
assert.strictEqual(parseImageContext('{bad'), null);
assert.strictEqual(parseImageContext('{"attachments":[{"src":"x"}]}').attachments[0].src, 'x');
const latestPrevious = getLatestImageReferenceTarget({
  display: [
    { role: 'user', imageContext: JSON.stringify({ target: 'uploaded', attachments: [{ src: 'indexeddb://uploaded' }] }) },
    { role: 'assistant', html: '<img class=\"generated-thumb\" />' },
  ],
  lastGeneratedImage: { images: [{ src: 'indexeddb://generated-1' }, { src: 'indexeddb://generated-2' }] },
});
assert.strictEqual(latestPrevious.target, 'previous');
assert.strictEqual(latestPrevious.count, 2);
assert.strictEqual(latestPrevious.selection, 'all');
const latestUploaded = getLatestImageReferenceTarget({
  display: [{ role: 'user', imageContext: JSON.stringify({ target: 'uploaded', attachments: [{ src: 'indexeddb://uploaded-1' }, { src: 'indexeddb://uploaded-2' }] }) }],
  lastGeneratedImage: null,
});
assert.strictEqual(latestUploaded.target, 'uploaded');
assert.strictEqual(latestUploaded.count, 2);
assert.strictEqual(latestUploaded.selection, 'all');
assert.deepStrictEqual(buildRouteAttachmentMetadata([{ name: 'a.png', type: 'image/png', size: 12, dataUrl: 'data:image/png;base64,SECRET', text: 'SECRET' }]), [{ name: 'a.png', type: 'image/png', size: 12, is_image: true }]);
console.log('attachments ok');
