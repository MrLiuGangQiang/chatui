'use strict';

const assert = require('assert');
const fs = require('fs');
const mediaWorkflow = require('../../client/app/media-workflow');
const path = require('path');
const { JSDOM } = require('jsdom');

function testMediaWorkflowUsesExplicitDependencies() {
  const source = fs.readFileSync(path.join(__dirname, '..', '..', 'client', 'app', 'media-workflow.js'), 'utf8');
  assert.ok(!/\bwith\s*\(/.test(source), 'media workflow should not use a dynamic with-scope');
}

async function testMediaWorkflowExposesImageSourceSize() {
  const { workflow } = createWorkflow();
  assert.strictEqual(typeof workflow.imageSrcSize, 'function');
  assert.deepStrictEqual(await workflow.imageSrcSize('data:image/png;base64,AA=='), { width: 180, height: 120 });
}

function makeImage({ persistedSrc, src = '' } = {}) {
  const attributes = new Map();
  if (src) attributes.set('src', src);
  const classes = new Set(['generated-thumb']);
  return {
    tagName: 'IMG',
    dataset: { persistedSrc, thumbWidth: '180', thumbHeight: '120' },
    style: { setProperty() {} },
    classList: {
      contains: name => classes.has(name),
      add: (...names) => names.forEach(name => classes.add(name)),
      remove: (...names) => names.forEach(name => classes.delete(name)),
    },
    getAttribute(name) { return attributes.get(name) || null; },
    setAttribute(name, value) { attributes.set(name, String(value)); },
    complete: true,
    naturalWidth: 180,
    naturalHeight: 120,
    get src() { return attributes.get('src') || ''; },
    hasClass(name) { return classes.has(name); },
  };
}

function createWorkflow({ getImageBlob = async () => null, setTimeout, clearTimeout } = {}) {
  let getCalls = 0;
  let objectUrlSequence = 0;
  const stored = new Map();
  const workflow = mediaWorkflow.createMediaWorkflow({
    IMAGE_DB: 'test-db',
    IMAGE_STORE: 'images',
    TRANSPARENT_PIXEL: 'data:image/gif;base64,transparent',
    URL: {
      createObjectURL() { objectUrlSequence += 1; return `blob:cached-${objectUrlSequence}`; },
      revokeObjectURL() {},
    },
    imageStoreHelpers: {
      createImageStore: () => ({
        openImageDb: async () => null,
        putImageBlob: async (key, blob) => { stored.set(key, blob); },
        getImageBlob: async key => { getCalls += 1; return getImageBlob(key); },
        clearImageDb: async () => {},
        deleteImageDbKeys: async () => {},
        getImageDbKeys: async () => [...stored.keys()],
      }),
      dataUrlToBlob: async () => ({ type: 'image/png' }),
      imageBlobSize: async () => ({ width: 180, height: 120 }),
      fitImageThumb: () => ({ width: 180, height: 120 }),
      collectIndexedDbKeys: (_value, target) => target,
    },
    localStorage: { getItem: () => null },
    state: { sessions: [], attachments: [], activeRuns: new Map(), liveRuns: new Map(), activeSessionId: '' },
    sessionImageJobKey: () => 'image-job',
    sessionChatJobKey: () => 'chat-job',
    pendingSubmitKey: () => 'pending-submit',
    setTimeout,
    clearTimeout,
  });
  return { workflow, getCalls: () => getCalls };
}

function testClarificationImagesBypassGenericStableMediaBox() {
  const { workflow } = createWorkflow();
  const attributes = new Map([['width', '160'], ['height', '120']]);
  const properties = new Map([
    ['--thumb-w', '160px'],
    ['--thumb-h', '120px'],
    ['--markdown-media-w', '160px'],
    ['--markdown-media-h', '120px'],
    ['width', '160px'],
    ['height', '120px'],
    ['aspect-ratio', '4 / 3'],
    ['object-fit', 'contain'],
  ]);
  const image = {
    dataset: {
      thumbWidth: '160', thumbHeight: '120', markdownWidth: '160', markdownHeight: '120',
      markdownMediaPending: '0', markdownMediaBound: '1',
    },
    classList: { contains: name => name === 'clarification-choice-image' },
    getAttribute: name => attributes.get(name) || null,
    removeAttribute: name => attributes.delete(name),
    style: {
      setProperty: (name, value) => properties.set(name, value),
      removeProperty: name => properties.delete(name),
    },
  };

  workflow.stabilizeImageBoxes({
    querySelectorAll: selector => selector === '.markdown-body img.clarification-choice-image' ? [image] : [],
  });

  assert.strictEqual(attributes.has('width'), false);
  assert.strictEqual(attributes.has('height'), false);
  assert.strictEqual(properties.has('--markdown-media-w'), false);
  assert.strictEqual(properties.has('--markdown-media-h'), false);
  assert.strictEqual(properties.has('aspect-ratio'), false);
  assert.strictEqual(properties.has('object-fit'), false);
  assert.strictEqual('markdownMediaBound' in image.dataset, false);
  assert.strictEqual('markdownWidth' in image.dataset, false);
}

async function testMediaWorkflowUsesInjectedTimerDependencies() {
  let scheduled = 0;
  let cleared = null;
  const { workflow } = createWorkflow({
    setTimeout: () => { scheduled += 1; return 73; },
    clearTimeout: timer => { cleared = timer; },
  });

  const result = await workflow.settleWithin(Promise.resolve('ready'), 20, 'fallback');
  assert.strictEqual(result, 'ready');
  assert.strictEqual(scheduled, 1);
  assert.strictEqual(cleared, 73);
}

async function testGeneratedObjectUrlSurvivesImmediateSessionSwitch() {
  const { workflow, getCalls } = createWorkflow();
  const persisted = await workflow.persistImageSrc('data:image/png;base64,AAAA', 'result.png', { returnDisplayUrl: true });
  const switchedSessionImage = makeImage({ persistedSrc: persisted.persistedSrc });

  await workflow.resolvePersistedImages({ querySelectorAll: () => [switchedSessionImage] });

  assert.strictEqual(switchedSessionImage.src, persisted.displaySrc, 'switching back should reuse the already-decoded generated image URL');
  assert.strictEqual(switchedSessionImage.hasClass('image-restoring'), false, 'a cached completed image must not return to the loading state');
  assert.strictEqual(getCalls(), 0, 'the immediate switch path must not wait for another IndexedDB read');
}

async function testLiveBlobHydrationDoesNotHideCompletedImage() {
  const { workflow, getCalls } = createWorkflow();
  const image = makeImage({ persistedSrc: 'indexeddb://already-persisted', src: 'blob:live-result' });

  await workflow.resolvePersistedImages({ querySelectorAll: () => [image] });

  assert.strictEqual(image.src, 'blob:live-result');
  assert.strictEqual(image.hasClass('image-restoring'), false, 'hydration must keep a visible live Blob URL visible');
  assert.strictEqual(getCalls(), 0, 'a live Blob URL already paired with its durable key does not need rehydration');
}

async function testImportedBlobHydratesRenderedHistoryImage() {
  const restoredBlob = new Blob(['restored image'], { type: 'image/png' });
  const { workflow } = createWorkflow({
    getImageBlob: async key => key === 'restored-image' ? restoredBlob : null,
  });
  const dom = new JSDOM('<img class="generated-thumb image-restoring" src="data:image/gif;base64,transparent" data-persisted-src="indexeddb://restored-image" data-thumb-width="180" data-thumb-height="120" alt="已恢复图片">');
  const image = dom.window.document.querySelector('img');

  await workflow.resolvePersistedImages(dom.window.document);

  assert.strictEqual(image.getAttribute('src'), 'blob:cached-1', 'a history image must be rehydrated from the imported IndexedDB Blob');
  assert.strictEqual(image.dataset.persistedSrc, 'indexeddb://restored-image');
  assert.strictEqual(image.classList.contains('image-missing'), false);
}

module.exports = [
  testMediaWorkflowUsesExplicitDependencies,
  testMediaWorkflowExposesImageSourceSize,
  testClarificationImagesBypassGenericStableMediaBox,
  testMediaWorkflowUsesInjectedTimerDependencies,
  testGeneratedObjectUrlSurvivesImmediateSessionSwitch,
  testLiveBlobHydrationDoesNotHideCompletedImage,
  testImportedBlobHydratesRenderedHistoryImage,
];
