'use strict';

const assert = require('assert');

const imageActions = require('../../client/ui/image-actions');

function testEditSourceFallsBackToTheLiveImageAttributes() {
  assert.strictEqual(
    imageActions.imageEditSource({ dataset: { persistedSrc: 'indexeddb://attachment-1' }, src: 'blob:stale' }),
    'indexeddb://attachment-1',
  );
  assert.strictEqual(
    imageActions.imageEditSource({ dataset: {}, src: 'blob:live-object-url' }),
    'blob:live-object-url',
    'a stripped data-persisted-src must fall back to the live src',
  );
  assert.strictEqual(
    imageActions.imageEditSource({ dataset: { originalSrc: 'https://cdn.test/a.png' }, src: 'blob:x' }),
    'https://cdn.test/a.png',
  );
  assert.strictEqual(imageActions.imageEditSource({ dataset: {} }), '');
  assert.strictEqual(imageActions.imageEditSource(null), '');
}

function testImageActionsNoLongerExposesAnInlineToolbarInserter() {
  assert.strictEqual(typeof imageActions.insertImageEditToolbar, 'undefined',
    'the inline image tool strip was replaced by the single-surface image editor');
}

function testGeneratedImageDownloadsUsePngFilename() {
  assert.strictEqual(imageActions.pngFilename('photo.jpg'), 'photo.png');
  assert.strictEqual(imageActions.pngFilename('photo.webp'), 'photo.png');
  assert.strictEqual(imageActions.pngFilename('photo'), 'photo.png');
  assert.strictEqual(imageActions.pngFilename('photo.png'), 'photo.png');
  assert.strictEqual(imageActions.pngFilename('', 'generated-image'), 'generated-image.png');
}

module.exports = [
  testEditSourceFallsBackToTheLiveImageAttributes,
  testImageActionsNoLongerExposesAnInlineToolbarInserter,
  testGeneratedImageDownloadsUsePngFilename,
];
