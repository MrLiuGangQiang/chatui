'use strict';

const assert = require('assert');

const coreAttachments = require('../../client/core/attachments');
const imageContextWorkflow = require('../../client/app/image-context-workflow');
const imageResultWorkflow = require('../../client/app/image-result-workflow');
const messageRecords = require('../../client/app/message-records');

function imageResultDeps({ width = 512, height = 512 } = {}) {
  let count = 0;
  return {
    extractImageResult: value => value,
    getConfig: () => ({}),
    persistImageSrc: async () => ({ persistedSrc: `indexeddb://result-${++count}`, displaySrc: 'blob:live-result' }),
    settleWithin: async value => value,
    imageSrcSize: async () => ({ width, height }),
    splitPromptSubjects: () => [],
    imageCandidateLabels: () => [],
    makeImageItemId: (referenceId, ordinal) => `img_${referenceId}_${ordinal}`,
    escapeHtml: value => String(value),
    downloadAllImagesButtonHtml: () => '',
    saveLatestGeneratedImage: () => {},
  };
}

async function testImageResultRecordKeepsLiveAndRestoredImageOrder() {
  const result = await imageResultWorkflow.imageResultToHtml({
    kind: 'image',
    images: [{ src: 'data:image/png;base64,one' }, { src: 'data:image/png;base64,two' }],
  }, '1s', { resultId: 'imgres_stable_order', prompt: 'two cats' }, imageResultDeps());

  assert.strictEqual(result.imageContext.schema_version, 'image_result.v1');
  assert.strictEqual(result.imageContext.resultId, 'imgres_stable_order');
  assert.strictEqual(result.imageContext.referenceId, 'imgref_imgres_stable_order');
  assert.deepStrictEqual(result.imageContext.attachments.map(item => [item.imageId, item.ordinal, item.sourceIndex]), [
    ['img_imgref_imgres_stable_order_1', 1, 1],
    ['img_imgref_imgres_stable_order_2', 2, 2],
  ]);

  const canonical = messageRecords.normalizeCanonicalMessage({
    role: 'assistant',
    content: '[图片生成完成] two cats',
    responseIndex: '1',
    imageContext: JSON.stringify(result.imageContext),
  }, { sessionId: 'stable-image-session', sequence: 1 });
  const restored = imageResultWorkflow.renderImageResultHtml(canonical.presentation.images, {
    escapeHtml: value => String(value),
    downloadAllImagesButtonHtml: () => '',
  });
  assert.match(restored, /data-image-result-id="imgres_stable_order"/);
  assert.ok(restored.indexOf('img_imgref_imgres_stable_order_1') < restored.indexOf('img_imgref_imgres_stable_order_2'));
  assert.ok(restored.indexOf('data-image-index="1"') < restored.indexOf('data-image-index="2"'));
}

async function testImageResultStorageKeepsLiveGeometryForCanonicalRestore() {
  const deps = imageResultDeps({ width: 900, height: 520 });
  const result = await imageResultWorkflow.imageResultToHtml({
    kind: 'image',
    images: [{
      src: 'data:image/png;base64,wide',
      raw: 'transient raw response',
      url: 'blob:transient-result',
      prompt: 'wide blue cover',
      labels: ['wide-cover'],
    }],
  }, '250ms', {
    resultId: 'imgres_wide_geometry',
    prompt: 'draw a wide blue cover',
    routePrompt: 'wide cover route prompt',
  }, deps);

  const workflow = imageContextWorkflow.createImageContextWorkflow({
    isImageFile: item => String(item.type || '').startsWith('image/') || /\.(?:png|jpe?g|gif|webp|svg)$/i.test(String(item.name || item.filename || '')),
    makeImageItemId: (referenceId, ordinal) => `img_${referenceId}_${ordinal}`,
    normalizeImageSelection: value => Array.isArray(value) ? value : [],
    normalizeSelectedImageIds: value => Array.isArray(value) ? value : [],
  });
  const stored = workflow.normalizeImageContextForStorage(result.imageContext);
  const sharedStored = coreAttachments.normalizeImageContextForStorage(stored);

  assert.strictEqual(stored.schema_version, 'image_result.v1');
  assert.strictEqual(stored.resultId, 'imgres_wide_geometry');
  assert.strictEqual(stored.routePrompt, 'wide cover route prompt');
  assert.strictEqual(stored.attachments[0].width, 900);
  assert.strictEqual(stored.attachments[0].height, 520);
  assert.strictEqual(stored.attachments[0].ordinal, 1);
  assert.strictEqual(stored.attachments[0].resultId, 'imgres_wide_geometry');
  assert.strictEqual(stored.attachments[0].prompt, 'wide blue cover');
  assert.deepStrictEqual(stored.attachments[0].labels, ['wide-cover']);
  assert.strictEqual(sharedStored.attachments[0].width, 900, 'the shared parser must preserve generated-image geometry too');
  assert.strictEqual(sharedStored.attachments[0].height, 520);
  assert.ok(!Object.prototype.hasOwnProperty.call(stored.attachments[0], 'displaySrc'), 'transient object URLs must not enter canonical storage');
  assert.ok(!Object.prototype.hasOwnProperty.call(stored.attachments[0], 'raw'), 'raw provider payloads must not enter canonical storage');
  assert.ok(!Object.prototype.hasOwnProperty.call(stored.attachments[0], 'url'), 'provider URLs must not compete with the persisted src');

  const canonical = messageRecords.normalizeCanonicalMessage({
    role: 'assistant',
    content: '[鍥剧墖鐢熸垚瀹屾垚] draw a wide blue cover',
    responseIndex: '1',
    imageContext: JSON.stringify(stored),
  }, { sessionId: 'wide-image-session', sequence: 1 });
  const restored = imageResultWorkflow.renderImageResultHtml(canonical.presentation.images, {
    escapeHtml: value => String(value),
    downloadAllImagesButtonHtml: () => '',
  });

  for (const html of [result.html, restored]) {
    assert.match(html, /width="180"/);
    assert.match(html, /height="104"/);
    assert.match(html, /data-thumb-width="180"/);
    assert.match(html, /data-thumb-height="104"/);
    assert.match(html, /data-original-width="900"/);
    assert.match(html, /data-original-height="520"/);
  }
}

function testLegacyLatestImageResultGetsStableCompatibilityIdentity() {
  const canonical = messageRecords.normalizeCanonicalMessage({
    role: 'assistant',
    content: '[图片生成完成] legacy',
    responseIndex: '3',
    imageContext: JSON.stringify({
      referenceId: 'imgref_latest',
      attachments: [{ imageId: 'img_imgref_latest_1', src: 'indexeddb://legacy-image', sourceIndex: 1 }],
    }),
  }, { sessionId: 'legacy-image-session', sequence: 3 });
  const context = JSON.parse(canonical.imageContext);
  assert.strictEqual(context.resultId, 'legacy_legacy-image-session_assistant_3');
  assert.strictEqual(context.referenceId, 'imgref_legacy_legacy-image-session_assistant_3');
  assert.strictEqual(context.attachments[0].imageId, 'img_imgref_legacy_legacy-image-session_assistant_3_1');
  assert.strictEqual(context.attachments[0].ordinal, 1);
}

module.exports = [
  testImageResultRecordKeepsLiveAndRestoredImageOrder,
  testImageResultStorageKeepsLiveGeometryForCanonicalRestore,
  testLegacyLatestImageResultGetsStableCompatibilityIdentity,
];
