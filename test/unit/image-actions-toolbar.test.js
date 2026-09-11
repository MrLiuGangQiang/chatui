'use strict';

const assert = require('assert');

const imageActions = require('../../client/ui/image-actions');

function testToolbarIsPrependedToTheContentContainer() {
  const calls = [];
  const firstChild = { id: 'image-wrapper' };
  const toolbar = { id: 'toolbar' };
  const content = {
    firstChild,
    insertBefore: (node, reference) => calls.push(['insertBefore', node, reference]),
    appendChild: node => calls.push(['appendChild', node]),
  };
  const inserted = imageActions.insertImageEditToolbar(content, toolbar);
  assert.strictEqual(inserted, true);
  assert.deepStrictEqual(calls, [['insertBefore', toolbar, firstChild]],
    'the toolbar must be inserted into the content layer, not the thumbnail wrapper');
}

function testToolbarAppendsWhenTheContentIsEmpty() {
  const calls = [];
  const toolbar = { id: 'toolbar' };
  const content = {
    firstChild: null,
    insertBefore: () => calls.push('insertBefore'),
    appendChild: node => calls.push(['appendChild', node]),
  };
  assert.strictEqual(imageActions.insertImageEditToolbar(content, toolbar), true);
  assert.deepStrictEqual(calls, [['appendChild', toolbar]]);
}

function testToolbarSkipsMissingContainers() {
  const toolbar = { id: 'toolbar' };
  assert.strictEqual(imageActions.insertImageEditToolbar(null, toolbar), false);
  assert.strictEqual(imageActions.insertImageEditToolbar({ firstChild: { id: 'x' } }, toolbar), false,
    'a container without insertBefore must be skipped');
  assert.strictEqual(imageActions.insertImageEditToolbar({ insertBefore() {} }, null), false);
}

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

module.exports = [
  testToolbarIsPrependedToTheContentContainer,
  testToolbarAppendsWhenTheContentIsEmpty,
  testToolbarSkipsMissingContainers,
  testEditSourceFallsBackToTheLiveImageAttributes,
];
