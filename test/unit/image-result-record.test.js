'use strict';

const assert = require('assert');
const { JSDOM } = require('jsdom');

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

function testImageResultContextsMergeIntoOneOrderedImageGrid() {
  const first = {
    schema_version: 'image_result.v1', resultId: 'batch-a', referenceId: 'ref-a',
    attachments: [{ imageId: 'cat', src: 'indexeddb://cat', persistedSrc: 'indexeddb://cat', width: 100, height: 80 }],
  };
  const second = {
    schema_version: 'image_result.v1', resultId: 'batch-b', referenceId: 'ref-b',
    attachments: [{ imageId: 'dog', src: 'indexeddb://dog', persistedSrc: 'indexeddb://dog', width: 120, height: 90 }],
  };
  const merged = imageResultWorkflow.mergeImageResultContexts(first, second);
  assert.deepStrictEqual(merged.attachments.map(item => [item.imageId, item.ordinal]), [['cat', 1], ['dog', 2]]);
  const html = imageResultWorkflow.renderImageResultContext(merged, {}, {
    escapeHtml: value => String(value),
    downloadAllImagesButtonHtml: () => '',
  });
  assert.match(html, /generated-image-grid/);
  assert.match(html, /data-image-id="cat"/);
  assert.match(html, /data-image-id="dog"/);
  assert.ok(html.indexOf('data-image-id="cat"') < html.indexOf('data-image-id="dog"'));
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
    assert.match(html, /width="208"/);
    assert.match(html, /height="120"/);
    assert.match(html, /data-thumb-width="208"/);
    assert.match(html, /data-thumb-height="120"/);
    assert.match(html, /data-original-width="900"/);
    assert.match(html, /data-original-height="520"/);
  }
}

function testObjectStringifiedMessageIdsAreRepairedCanonically() {
  const canonical = messageRecords.normalizeCanonicalMessage({
    role: 'assistant',
    id: '[object Object],[object Object]:assistant:1',
    responseIndex: 1,
    content: '答案',
  }, { sessionId: 'chat-session', sequence: 1 });
  assert.strictEqual(canonical.id, 'chat-session:assistant:1',
    'object-stringified ids must be rebuilt from the canonical session/role/index parts');
  assert.strictEqual(
    messageRecords.messageId({ role: 'assistant', responseIndex: 1 }, { sessionId: [{}, {}] }),
    'session:assistant:1',
    'non-scalar session ids must never produce object-stringified identity',
  );
  assert.strictEqual(
    messageRecords.messageId({ role: 'user', id: 'kept-id', messageIndex: 2 }),
    'kept-id',
    'valid scalar ids are preserved',
  );
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
  // Legacy compatibility identity stays deterministic; the bounded reference
  // part length (48) does not truncate ordinary canonical legacy keys.
  assert.strictEqual(context.resultId, 'legacy_legacy-image-session_assistant_3');
  assert.strictEqual(context.referenceId, 'imgref_legacy_legacy-image-session_assistant_3');
  assert.strictEqual(context.attachments[0].imageId, 'img_imgref_legacy_legacy-image-session_assistant_3_1');
  assert.strictEqual(context.attachments[0].ordinal, 1);
}


function testLiveBatchAccumulatorKeepsEveryCompletedChildImage() {
  const first = {
    schema_version: 'image_result.v1',
    resultId: 'cat-result',
    attachments: [{ imageId: 'cat', src: 'indexeddb://cat', persistedSrc: 'indexeddb://cat', width: 100, height: 80 }],
  };
  const second = {
    schema_version: 'image_result.v1',
    resultId: 'dog-result',
    attachments: [{ imageId: 'dog', src: 'indexeddb://dog', persistedSrc: 'indexeddb://dog', width: 100, height: 80 }],
  };
  const aggregate = { imageContext: null };
  aggregate.imageContext = imageResultWorkflow.mergeImageResultContexts(aggregate.imageContext || {}, first);
  aggregate.imageContext = imageResultWorkflow.mergeImageResultContexts(aggregate.imageContext, second);

  assert.deepStrictEqual(aggregate.imageContext.attachments.map(item => item.imageId), ['cat', 'dog'],
    'the second live result must extend—not replace—the already rendered first result');
  const html = imageResultWorkflow.renderImageResultContext(aggregate.imageContext, {}, {
    escapeHtml: value => String(value), downloadAllImagesButtonHtml: () => '',
  });
  assert.match(html, /data-image-id="cat"/);
  assert.match(html, /data-image-id="dog"/);
}



function testBatchImageSlotsStayMountedWhileEachTaskCompletes() {
  const cat = {
    schema_version: 'image_result.v1',
    resultId: 'batch-cat',
    attachments: [{ imageId: 'cat', src: 'indexeddb://cat', persistedSrc: 'indexeddb://cat', width: 100, height: 80 }],
  };
  const dog = {
    schema_version: 'image_result.v1',
    resultId: 'batch-dog',
    attachments: [{ imageId: 'dog', src: 'indexeddb://dog', persistedSrc: 'indexeddb://dog', width: 120, height: 90 }],
  };
  const renderOptions = {
    escapeHtml: value => String(value),
    downloadAllImagesButtonHtml: () => '',
    transparentPixel: 'data:image/gif;base64,slot-test',
  };
  const initial = imageResultWorkflow.renderImageBatchResultHtml({
    total: 2,
    childContexts: [cat, null],
    statusHtml: '<div class="pending-feedback">任务状态</div>',
    ...renderOptions,
  });
  const dom = new JSDOM(`<article class="message assistant"><div class="content">${initial}</div></article>`);
  const node = dom.window.document.querySelector('.message');
  const grid = node.querySelector('.generated-image-batch-grid');
  const firstSlot = node.querySelector('[data-image-batch-slot="0"]');
  const secondSlot = node.querySelector('[data-image-batch-slot="1"]');
  const firstImage = firstSlot.querySelector('[data-image-id="cat"]');

  assert.strictEqual(node.querySelectorAll('[data-image-batch-slot]').length, 2,
    'a batch must reserve exactly one stable slot per planned task before all images complete');
  assert.strictEqual(secondSlot.dataset.imageBatchSlotState, 'pending');
  assert.ok(secondSlot.querySelector('.generated-image-slot-skeleton'),
    'incomplete tasks must keep their allocated loading slot');
  assert.ok(secondSlot.querySelector('.generated-image-slot-status'),
    'waiting text must stay inside its reserved slot');
  const live = { ...cat, attachments: [{ ...cat.attachments[0], displaySrc: 'blob:cat-live' }] };
  const liveHtml = imageResultWorkflow.renderImageBatchResultHtml({ total: 1, childContexts: [live], ...renderOptions });
  assert.match(liveHtml, /src="blob:cat-live"/, 'a completed live batch slot must render the returned image immediately');

  const sized = imageResultWorkflow.renderImageBatchResultHtml({
    total: 2, childContexts: [null, null], slotSizes: ['1024x1024', '1536x1024'],
    slotStatuses: ['等待生成', '等待生成'], ...renderOptions,
  });
  assert.match(sized, /data-image-batch-slot-size="1024x1024"/);
  assert.match(sized, /data-image-batch-slot-size="1536x1024"/);
  assert.match(sized, /--batch-slot-width:120px/);
  assert.match(sized, /--batch-slot-height:120px/);
  assert.match(sized, /--batch-slot-aspect:auto/);
  assert.ok(!sized.includes('--batch-slot-width:180px'), 'pending slots must be square and must not retain the wider completed-thumbnail width');

  const patched = imageResultWorkflow.patchImageBatchDisplayNode(node, {
    total: 2,
    childContexts: [cat, dog],
    statusHtml: '<div class="pending-feedback">任务状态已更新</div>',
    ...renderOptions,
  });
  assert.strictEqual(patched, true);
  assert.strictEqual(node.querySelector('.generated-image-batch-grid'), grid,
    'filling one task must not replace the batch grid node');
  assert.strictEqual(node.querySelector('[data-image-batch-slot="0"]'), firstSlot,
    'a finished sibling slot must remain mounted when another task completes');
  assert.strictEqual(node.querySelector('[data-image-batch-slot="1"]'), secondSlot,
    'the pending slot itself must be filled in place rather than recreated');
  assert.strictEqual(firstSlot.querySelector('[data-image-id="cat"]'), firstImage,
    'an already displayed image must retain its DOM node during later task completion');
  assert.strictEqual(secondSlot.dataset.imageBatchSlotState, 'done');
  assert.ok(secondSlot.querySelector('[data-image-id="dog"]'),
    'the newly completed task must populate only its own planned slot');
}


function testSingleImageResultUsesBatchSlotGeometry() {
  const html = imageResultWorkflow.renderImageResultHtml([
    { imageId: 'single', src: 'indexeddb://single', persistedSrc: 'indexeddb://single', displaySrc: 'blob:single', width: 1536, height: 1024 },
  ], { escapeHtml: value => String(value), downloadAllImagesButtonHtml: () => '' });
  assert.match(html, /generated-image-batch-grid/);
  assert.match(html, /data-image-batch-slot="0"/);
  assert.match(html, /src="blob:single"/);
}

function testMultiImageResultDoesNotShowRedundantCountHeader() {
  const html = imageResultWorkflow.renderImageResultHtml([
    { imageId: 'cat', src: 'indexeddb://cat', persistedSrc: 'indexeddb://cat', width: 100, height: 80 },
    { imageId: 'dog', src: 'indexeddb://dog', persistedSrc: 'indexeddb://dog', width: 100, height: 80 },
  ], { escapeHtml: value => String(value), downloadAllImagesButtonHtml: () => '' });
  assert.ok(!html.includes('image-result-head'), 'multi-image result cards must not add a redundant image-count header');
  assert.ok(!html.includes('（2 张）'), 'multi-image result cards must not display a parenthesized count label');
}


function testRestoredImagePresentationUsesPersistedSrcAlias() {
  const displayHistorySource = require('fs').readFileSync(require('path').join(__dirname, '../../client/app/display-history-workflow.js'), 'utf8');
  assert.ok(displayHistorySource.includes('item.src, item.persistedSrc, item.persisted_src'), 'restored image rendering must accept persistedSrc descriptors from canonical snapshots');
}

module.exports = [
  testLiveBatchAccumulatorKeepsEveryCompletedChildImage,
  testImageResultRecordKeepsLiveAndRestoredImageOrder,
  testImageResultContextsMergeIntoOneOrderedImageGrid,
  testImageResultStorageKeepsLiveGeometryForCanonicalRestore,
  testRestoredImagePresentationUsesPersistedSrcAlias,
  testLegacyLatestImageResultGetsStableCompatibilityIdentity,
  testObjectStringifiedMessageIdsAreRepairedCanonically,
  testBatchImageSlotsStayMountedWhileEachTaskCompletes,
  testSingleImageResultUsesBatchSlotGeometry,
  testMultiImageResultDoesNotShowRedundantCountHeader,
];
