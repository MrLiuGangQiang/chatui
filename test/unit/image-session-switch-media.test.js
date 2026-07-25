'use strict';

const assert = require('assert');
const fs = require('fs');
const mediaWorkflow = require('../../client/app/media-workflow');
const path = require('path');

function testMediaWorkflowUsesExplicitDependencies() {
  const source = fs.readFileSync(path.join(__dirname, '..', '..', 'client', 'app', 'media-workflow.js'), 'utf8');
  assert.ok(!/\bwith\s*\(/.test(source), 'media workflow should not use a dynamic with-scope');
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

module.exports = [
  testMediaWorkflowUsesExplicitDependencies,
  testMediaWorkflowUsesInjectedTimerDependencies,
  testGeneratedObjectUrlSurvivesImmediateSessionSwitch,
  testLiveBlobHydrationDoesNotHideCompletedImage,
];

