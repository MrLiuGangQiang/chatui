'use strict';

const assert = require('assert');
const jobResumeWorkflow = require('../../client/app/job-resume-workflow');
const submitHelpers = require('../../client/app/submit-workflow.helpers');
const imageResultWorkflow = require('../../client/app/image-result-workflow');
const jobWorkflow = require('../../client/app/job-workflow');

function memoryStorage() {
  const values = new Map();
  return { getItem: key => values.get(key) || null, setItem: (key, value) => values.set(key, String(value)), removeItem: key => values.delete(key) };
}

function makeState(sessionId) {
  return {
    activeSessionId: sessionId,
    sessions: [{ id: sessionId, messages: [], display: [] }],
    activeRuns: new Map(),
    resumingJobs: new Set(),
    followingChatJobs: new Set(),
    followingImageJobs: new Set(),
  };
}

function childSnapshot(jobId, prompt) {
  return {
    id: jobId,
    prompt,
    mode: 'image',
    requestPurpose: 'final_execution',
    payload: { model: 'gpt-image-1', prompt },
    dispatchContract: null,
    bindingEvidence: [],
    imageContext: { mode: 'image' },
    startedAt: Date.now() - 1000,
    submissionId: 'submit-test',
  };
}

function saveIndex(storage, sessionId, children, batchId = 'batch-1') {
  assert.strictEqual(submitHelpers.saveImageBatchIndex(storage, sessionId, {
    schema_version: 'image_batch.v1',
    batchId,
    submissionId: 'submit-test',
    sessionId,
    startedAt: Date.now(),
    children,
  }), true);
}

function testBatchSnapshotHelpersRoundTrip() {
  const storage = memoryStorage();
  const sessionId = 'session-keys';
  const children = [
    { jobId: 'imgjob-1', prompt: '一张猫', displayItemId: 'display-1', responseIndex: '1', mode: 'image', status: 'running' },
    { jobId: 'imgjob-2', prompt: '一张狗', displayItemId: 'display-2', responseIndex: '1', mode: 'image', status: 'running' },
  ];
  saveIndex(storage, sessionId, children);

  const loaded = submitHelpers.loadImageBatchIndex(storage, sessionId);
  assert.ok(loaded);
  assert.strictEqual(loaded.batchId, 'batch-1');
  assert.deepStrictEqual(loaded.children.map(child => child.jobId), ['imgjob-1', 'imgjob-2']);

  submitHelpers.saveImageBatchIndex?.(storage, sessionId, { schema_version: 'image_batch.v2', batchId: 'bad', children: [] });
  assert.strictEqual(submitHelpers.loadImageBatchIndex(storage, sessionId), null);

  assert.strictEqual(submitHelpers.normalizeImageBatchIndex({ schema_version: 'image_batch.v1', batchId: 'b', children: [{ jobId: '', prompt: 'x' }] }), null);
  assert.strictEqual(submitHelpers.imageBatchChildKey(sessionId, 'imgjob-1'), 'openapi-chat-image-batch-child-v1:session-keys:imgjob-1');
}

async function testResumeImageBatchWithoutIndexCleansUp() {
  const sessionId = 'resume-no-index';
  const state = makeState(sessionId);
  const events = [];
  const deps = {
    state,
    window: { ChatUIApp: {} },
    persistSessionDisplay() {}, setSessionBusy() {}, pendingFeedbackHtml: v => v,
    updateLiveDisplay() {}, shouldFollowScroll: () => false, setInterval: () => 1, clearInterval() {},
    findMessageNodeByDisplayItem: () => null, showRunError() {}, isMissingJobError: () => false,
    finishSessionTask: (_sessionId, options = {}) => { events.push(['finish', options.outcome || 'cleanup']); if (options.resumeKey) state.resumingJobs.delete(options.resumeKey); },
  };
  global.localStorage = memoryStorage();
  try {
    await jobResumeWorkflow.createJobResumeWorkflow(deps).resumeImageBatch(sessionId);
    assert.deepStrictEqual(events, [['finish', 'cleanup']]);
    assert.strictEqual(state.resumingJobs.size, 0);
  } finally {
    delete global.localStorage;
  }
}

async function testResumeImageBatchSkipsCompletedChildrenAndClearsIndex() {
  const sessionId = 'resume-completed';
  const state = makeState(sessionId);
  const storage = memoryStorage();
  const events = [];
  const children = [
    { jobId: 'imgjob-1', prompt: '一张猫', displayItemId: 'display-1', responseIndex: '1', mode: 'image', status: 'done' },
    { jobId: 'imgjob-2', prompt: '一张狗', displayItemId: 'display-2', responseIndex: '1', mode: 'image', status: 'done' },
  ];
  saveIndex(storage, sessionId, children);
  submitHelpers.saveImageBatchIndex(storage, sessionId, { schema_version: 'image_batch.v1', batchId: 'batch-1', children });
  storage.setItem(submitHelpers.imageBatchChildKey(sessionId, 'imgjob-1'), JSON.stringify(childSnapshot('imgjob-1', '一张猫')));
  storage.setItem(submitHelpers.imageBatchChildKey(sessionId, 'imgjob-2'), JSON.stringify(childSnapshot('imgjob-2', '一张狗')));

  const deps = {
    state,
    window: { ChatUIApp: {} },
    persistSessionDisplay() {}, setSessionBusy() {}, pendingFeedbackHtml: v => v,
    updateLiveDisplay() {}, shouldFollowScroll: () => false, setInterval: () => 1, clearInterval() {},
    findMessageNodeByDisplayItem: () => null, showRunError() {}, isMissingJobError: () => false,
    finishSessionTask: (_sessionId, options = {}) => { events.push(['finish', options.outcome || 'cleanup']); if (options.resumeKey) state.resumingJobs.delete(options.resumeKey); },
    hasSuccessfulImageResult: () => true,
    getImageGenerationJob: async () => { events.push('poll'); return { status: 'done', data: { data: [] } }; },
  };
  global.localStorage = storage;
  try {
    await jobResumeWorkflow.createJobResumeWorkflow(deps).resumeImageBatch(sessionId);
    assert.strictEqual(events.includes('poll'), false, 'completed children must not poll upstream');
    assert.deepStrictEqual(events, [['finish', 'cleanup']]);
    assert.strictEqual(submitHelpers.loadImageBatchIndex(storage, sessionId), null, 'a fully completed batch must clear its recovery index');
  } finally {
    delete global.localStorage;
  }
}

async function testResumeImageBatchRendersRunningChildAndKeepsPartialIndexOnMissingSibling() {
  const sessionId = 'resume-running';
  const state = makeState(sessionId);
  const storage = memoryStorage();
  const events = [];
  const children = [
    { jobId: 'imgjob-1', prompt: '一张猫', displayItemId: 'display-1', responseIndex: '1', mode: 'image', status: 'running' },
    { jobId: 'imgjob-2', prompt: '一张狗', displayItemId: 'display-2', responseIndex: '1', mode: 'image', status: 'running' },
  ];
  const batch = { schema_version: 'image_batch.v1', batchId: 'batch-1', submissionId: 'submit-test', sessionId, startedAt: Date.now(), children };
  submitHelpers.saveImageBatchIndex(storage, sessionId, batch);
  storage.setItem(submitHelpers.imageBatchChildKey(sessionId, 'imgjob-1'), JSON.stringify(childSnapshot('imgjob-1', '一张猫')));

  const deps = {
    state,
    window: { ChatUIApp: {} },
    persistSessionDisplay() {}, setSessionBusy() {}, pendingFeedbackHtml: v => v,
    updateLiveDisplay() {}, shouldFollowScroll: () => false, setInterval: () => 1, clearInterval() {},
    findMessageNodeByDisplayItem: () => null, showRunError() {}, isMissingJobError: () => false,
    finishSessionTask: (_sessionId, options = {}) => { events.push(['finish', options.outcome || 'cleanup']); if (options.resumeKey) state.resumingJobs.delete(options.resumeKey); },
    hasSuccessfulImageResult: () => false,
    findImageDisplayItemByJob: () => null,
    takePendingLiveItem: () => ({ id: 'row-live', responseIndex: '1' }),
    getConfig: () => ({ baseUrl: 'https://example.test/v1' }),
    getImageGenerationJob: async () => { events.push('poll'); return { status: 'done', data: { data: [{ url: 'https://img.example/1.png' }] } }; },
    jobDurationMs: () => 0,
    formatElapsed: () => 'RT 0',
    imageResultToHtml: async () => ({ html: '<div class="generated-thumb"></div>', raw: 'raw', metaText: 'RT 1', imageContext: { mode: 'image' } }),
    normalizeImageContextForStorage: v => v,
    updateSessionDisplayItem() {}, updateMessage() {}, setImageContext() {},
    upsertImageAssistantMessage: () => 0,
    reconcileSuccessfulImageResult() {},
    saveSessionMessages: async () => {},
  };
  global.localStorage = storage;
  try {
    await jobResumeWorkflow.createJobResumeWorkflow(deps).resumeImageBatch(sessionId);
    assert.ok(events.some(event => event === 'poll'), 'running children must poll their managed job');
    assert.ok(submitHelpers.loadImageBatchIndex(storage, sessionId),
      'a batch with a missing sibling must keep its recovery index so the remaining child can be retried');
    assert.strictEqual(submitHelpers.loadImageBatchChild(storage, sessionId, 'imgjob-1'), null,
      'a resolved child must clear its own durable snapshot');
  } finally {
    delete global.localStorage;
  }
}


async function testResumeImageBatchMergesChildrenIntoOneParentMessage() {
  const sessionId = 'resume-shared-parent';
  const state = makeState(sessionId);
  const storage = memoryStorage();
  const parent = { id: 'display-batch-parent', role: 'assistant', pending: '1', responseIndex: '0', imageContext: '' };
  state.sessions[0].display.push(parent);
  const children = [
    { jobId: 'imgjob-cat', prompt: '猫', displayItemId: parent.id, responseIndex: '0', mode: 'image', status: 'running' },
    { jobId: 'imgjob-dog', prompt: '狗', displayItemId: parent.id, responseIndex: '0', mode: 'image', status: 'running' },
  ];
  saveIndex(storage, sessionId, children, 'batch-shared-parent');
  storage.setItem(submitHelpers.imageBatchChildKey(sessionId, 'imgjob-cat'), JSON.stringify(childSnapshot('imgjob-cat', '猫')));
  storage.setItem(submitHelpers.imageBatchChildKey(sessionId, 'imgjob-dog'), JSON.stringify(childSnapshot('imgjob-dog', '狗')));
  const saved = [];
  const deps = {
    state, window: { ChatUIApp: {} }, setSessionBusy() {}, finishSessionTask() {}, persistSessionDisplay() {},
    getConfig: () => ({}), isMissingJobError: () => false, findImageDisplayItemByJob: () => parent,
    getImageGenerationJob: async jobId => ({ status: 'done', data: { data: [{ url: `https://img.example/${jobId}.png` }] } }),
    formatElapsed: () => '0s', jobDurationMs: () => 0,
    imageResultToHtml: async (data, _elapsed, options) => {
      const imageId = options.prompt === '猫' ? 'cat' : 'dog';
      return {
        raw: imageId,
        html: `<div data-image-id="${imageId}"></div>`,
        metaText: 'RT 0s',
        imageContext: { schema_version: 'image_result.v1', resultId: imageId, attachments: [{ imageId, src: `indexeddb://${imageId}`, persistedSrc: `indexeddb://${imageId}`, width: 100, height: 80 }] },
      };
    },
    normalizeImageContextForStorage: value => value,
    mergeImageResultContexts: imageResultWorkflow.mergeImageResultContexts,
    renderImageResultContext: context => imageResultWorkflow.renderImageResultContext(context, {}, { escapeHtml: value => String(value), downloadAllImagesButtonHtml: () => '' }),
    updateSessionDisplayItem: (_sessionId, item, _role, markup, options) => Object.assign(item, { ...options, html: markup }),
    findMessageNodeByDisplayItem: () => null, updateMessage() {}, setImageContext() {}, reconcileSuccessfulImageResult() {},
    saveSessionMessages: async (_sessionId, messages) => { saved.push(messages.map(message => ({ ...message }))); },
  };
  global.localStorage = storage;
  try {
    await jobResumeWorkflow.createJobResumeWorkflow(deps).resumeImageBatch(sessionId);
    assert.strictEqual(state.sessions[0].display.length, 1, 'recovery must keep one shared assistant display item');
    assert.strictEqual(state.sessions[0].messages.filter(message => message.role === 'assistant').length, 1,
      'recovery must commit one canonical assistant message for the batch');
    const message = state.sessions[0].messages[0];
    assert.strictEqual(message.displayItemId, parent.id);
    assert.deepStrictEqual(JSON.parse(message.imageContext).attachments.map(item => item.imageId), ['cat', 'dog']);
    assert.match(parent.html, /data-image-id="cat"/);
    assert.match(parent.html, /data-image-id="dog"/);
    assert.strictEqual(submitHelpers.loadImageBatchIndex(storage, sessionId), null, 'fully recovered shared batch must clear its index');
    assert.strictEqual(submitHelpers.loadImageBatchChild(storage, sessionId, 'imgjob-cat'), null);
    assert.strictEqual(submitHelpers.loadImageBatchChild(storage, sessionId, 'imgjob-dog'), null);
    assert.strictEqual(saved.length, 1, 'only the final merged canonical message should be persisted');
  } finally {
    delete global.localStorage;
  }
}


async function testResumeImageBatchRestoresCompletedSiblingFromDurableIndex() {
  const sessionId = 'resume-completed-sibling';
  const state = makeState(sessionId);
  const storage = memoryStorage();
  const parent = { id: 'display-batch-parent', role: 'assistant', pending: '1', responseIndex: '0', imageContext: '' };
  state.sessions[0].display.push(parent);
  const catContext = {
    schema_version: 'image_result.v1', resultId: 'cat-result',
    attachments: [{ imageId: 'cat', src: 'indexeddb://cat', persistedSrc: 'indexeddb://cat', width: 100, height: 80 }],
  };
  const children = [
    { jobId: 'imgjob-cat', prompt: 'cat', displayItemId: parent.id, responseIndex: '0', mode: 'image', status: 'done', imageContext: catContext },
    { jobId: 'imgjob-dog', prompt: 'dog', displayItemId: parent.id, responseIndex: '0', mode: 'image', status: 'running' },
  ];
  saveIndex(storage, sessionId, children, 'batch-completed-sibling');
  storage.setItem(submitHelpers.imageBatchChildKey(sessionId, 'imgjob-dog'), JSON.stringify(childSnapshot('imgjob-dog', 'dog')));
  const deps = {
    state, window: { ChatUIApp: {} }, setSessionBusy() {}, finishSessionTask() {}, persistSessionDisplay() {},
    getConfig: () => ({}), isMissingJobError: () => false, findImageDisplayItemByJob: () => parent,
    getImageGenerationJob: async () => ({ status: 'done', data: { data: [{ url: 'https://img.example/dog.png' }] } }),
    formatElapsed: () => '0s', jobDurationMs: () => 0,
    imageResultToHtml: async () => ({
      raw: 'dog', html: '<div data-image-id="dog"></div>', metaText: 'RT 0s',
      imageContext: { schema_version: 'image_result.v1', resultId: 'dog-result', attachments: [{ imageId: 'dog', src: 'indexeddb://dog', persistedSrc: 'indexeddb://dog', width: 100, height: 80 }] },
    }),
    normalizeImageContextForStorage: value => value,
    mergeImageResultContexts: imageResultWorkflow.mergeImageResultContexts,
    renderImageResultContext: context => imageResultWorkflow.renderImageResultContext(context, {}, { escapeHtml: value => String(value), downloadAllImagesButtonHtml: () => '' }),
    updateSessionDisplayItem: (_sessionId, item, _role, markup, options) => Object.assign(item, { ...options, html: markup }),
    findMessageNodeByDisplayItem: () => null, updateMessage() {}, setImageContext() {}, reconcileSuccessfulImageResult() {},
    saveSessionMessages: async () => {},
  };
  global.localStorage = storage;
  try {
    await jobResumeWorkflow.createJobResumeWorkflow(deps).resumeImageBatch(sessionId);
    const message = state.sessions[0].messages.find(item => item.role === 'assistant');
    assert.deepStrictEqual(JSON.parse(message.imageContext).attachments.map(item => item.imageId), ['cat', 'dog'],
      'refresh recovery must rebuild a completed child from the durable batch index before merging the remaining child');
    assert.strictEqual(state.sessions[0].messages.filter(item => item.role === 'assistant').length, 1,
      'the merged batch record must remain the only canonical assistant result for its response index');
    assert.match(parent.html, /data-image-id="cat"/);
    assert.match(parent.html, /data-image-id="dog"/);
    assert.strictEqual(submitHelpers.loadImageBatchIndex(storage, sessionId), null);
  } finally {
    delete global.localStorage;
  }
}


async function testResumeRunningBatchChildrenFollowExistingJobsWithoutRestart() {
  const sessionId = 'resume-running-follow';
  const state = makeState(sessionId);
  const storage = memoryStorage();
  const parent = { id: 'display-running-parent', role: 'assistant', pending: '1', responseIndex: '0', imageContext: '' };
  state.sessions[0].display.push(parent);
  const children = ['cat', 'dog', 'bird'].map(imageId => ({
    jobId: `imgjob-${imageId}`, prompt: imageId, displayItemId: parent.id,
    responseIndex: '0', mode: 'image', status: 'running',
  }));
  saveIndex(storage, sessionId, children, 'batch-running-follow');
  children.forEach(child => storage.setItem(
    submitHelpers.imageBatchChildKey(sessionId, child.jobId),
    JSON.stringify(childSnapshot(child.jobId, child.prompt)),
  ));
  const waited = [];
  let starts = 0;
  const deps = {
    state, window: { ChatUIApp: {} }, setSessionBusy() {}, finishSessionTask() {}, persistSessionDisplay() {},
    getConfig: () => ({}), isMissingJobError: () => false, findImageDisplayItemByJob: () => parent,
    getImageGenerationJob: async () => ({ status: 'running', data: null }),
    waitImageGenerationJob: async jobId => {
      waited.push(jobId);
      return { data: [{ url: `https://img.example/${jobId}.png` }] };
    },
    startImageGenerationJob: async () => { starts += 1; },
    formatElapsed: () => '0s', jobDurationMs: () => 0,
    imageResultToHtml: async (_data, _elapsed, options) => {
      const imageId = options.prompt;
      return {
        raw: imageId, html: `<div data-image-id="${imageId}"></div>`, metaText: 'RT 0s',
        imageContext: {
          schema_version: 'image_result.v1', resultId: `${imageId}-result`,
          attachments: [{ imageId, src: `indexeddb://${imageId}`, persistedSrc: `indexeddb://${imageId}`, width: 100, height: 80 }],
        },
      };
    },
    normalizeImageContextForStorage: value => value,
    mergeImageResultContexts: imageResultWorkflow.mergeImageResultContexts,
    renderImageResultContext: context => imageResultWorkflow.renderImageResultContext(context, {}, { escapeHtml: value => String(value), downloadAllImagesButtonHtml: () => '' }),
    updateSessionDisplayItem: (_sessionId, item, _role, markup, options) => Object.assign(item, { ...options, html: markup }),
    findMessageNodeByDisplayItem: () => null, updateMessage() {}, setImageContext() {}, reconcileSuccessfulImageResult() {},
    saveSessionMessages: async () => {},
  };
  global.localStorage = storage;
  try {
    await jobResumeWorkflow.createJobResumeWorkflow(deps).resumeImageBatch(sessionId);
    assert.deepStrictEqual(waited.sort(), children.map(child => child.jobId).sort(),
      'a refresh must attach to every existing running child job');
    assert.strictEqual(starts, 0,
      'a running provider job must not be POSTed again with the same job id');
    const message = state.sessions[0].messages.find(item => item.role === 'assistant');
    assert.deepStrictEqual(JSON.parse(message.imageContext).attachments.map(item => item.imageId), ['cat', 'dog', 'bird'],
      'all reattached children must survive the final canonical batch message');
    assert.strictEqual(submitHelpers.loadImageBatchIndex(storage, sessionId), null,
      'the batch recovery record is cleared only after all reattached jobs complete');
  } finally {
    delete global.localStorage;
  }
}

async function testResumeCompletedFiveImageBatchKeepsAllImagesAfterRefresh() {
  const sessionId = 'resume-five-completed';
  const state = makeState(sessionId);
  const storage = memoryStorage();
  const parent = { id: 'display-five-parent', role: 'assistant', pending: '', responseIndex: '0', imageContext: '' };
  state.sessions[0].display.push(parent);
  const imageIds = ['one', 'two', 'three', 'four', 'five'];
  const children = imageIds.map((imageId, index) => ({
    jobId: `imgjob-${imageId}`, prompt: imageId, displayItemId: parent.id,
    responseIndex: '0', mode: 'image', status: 'done',
    imageContext: {
      schema_version: 'image_result.v1', resultId: `${imageId}-result`,
      attachments: [{ imageId, src: `indexeddb://${imageId}`, persistedSrc: `indexeddb://${imageId}`, width: 100, height: 80, ordinal: index + 1 }],
    },
  }));
  saveIndex(storage, sessionId, children, 'batch-five-completed');
  const deps = {
    state, window: { ChatUIApp: {} }, setSessionBusy() {}, finishSessionTask() {}, persistSessionDisplay() {},
    isMissingJobError: () => false, findImageDisplayItemByJob: () => parent,
    normalizeImageContextForStorage: value => value,
    mergeImageResultContexts: imageResultWorkflow.mergeImageResultContexts,
    renderImageResultContext: context => imageResultWorkflow.renderImageResultContext(context, {}, { escapeHtml: value => String(value), downloadAllImagesButtonHtml: () => '' }),
    updateSessionDisplayItem: (_sessionId, item, _role, markup, options) => Object.assign(item, { ...options, html: markup }),
    findMessageNodeByDisplayItem: () => null, updateMessage() {}, setImageContext() {}, reconcileSuccessfulImageResult() {},
    saveSessionMessages: async () => {},
  };
  global.localStorage = storage;
  try {
    await jobResumeWorkflow.createJobResumeWorkflow(deps).resumeImageBatch(sessionId);
    const message = state.sessions[0].messages.find(item => item.role === 'assistant');
    assert.deepStrictEqual(JSON.parse(message.imageContext).attachments.map(item => item.imageId), imageIds,
      'a completed five-image batch must restore every durable child context, not only the last card context');
    imageIds.forEach(imageId => assert.match(parent.html, new RegExp(`data-image-id="${imageId}"`)));
    assert.strictEqual(submitHelpers.loadImageBatchIndex(storage, sessionId), null);
  } finally {
    delete global.localStorage;
  }
}

async function testResumeImageBatchFallsBackToPendingSubmitWhenAChildSnapshotIsMissing() {
  const sessionId = 'resume-missing-snapshot';
  const state = makeState(sessionId);
  const storage = memoryStorage();
  const children = [
    { jobId: 'imgjob-1', prompt: '一张猫', displayItemId: 'display-1', responseIndex: '1', mode: 'image', status: 'running' },
    { jobId: 'imgjob-2', prompt: '一张狗', displayItemId: 'display-1', responseIndex: '1', mode: 'image', status: 'running' },
  ];
  saveIndex(storage, sessionId, children, 'batch-missing');
  storage.setItem(submitHelpers.imageBatchChildKey(sessionId, 'imgjob-1'), JSON.stringify(childSnapshot('imgjob-1', '一张猫')));

  global.localStorage = storage;
  try {
    assert.strictEqual(jobWorkflow.savePendingSubmit(sessionId, {
      submissionId: 'submit-test',
      jobId: 'batch-missing',
      jobKind: 'image_batch',
      stage: 'handoff',
      promptText: '一只猫和一只狗',
      rawPromptText: '一只猫和一只狗',
      userCommitted: true,
    }, { storage }), true);

    const events = [];
    let resumed = false;
    let jobLookups = 0;
    const deps = {
      state,
      window: { ChatUIApp: {} },
      persistSessionDisplay() {},
      setSessionBusy() {},
      finishSessionTask() {},
      loadPendingSubmit: session => jobWorkflow.loadPendingSubmit(session, { storage }),
      resumePendingSubmit: async session => { resumed = true; events.push(['resume-pending', session]); return true; },
      getImageGenerationJob: async () => { jobLookups += 1; throw new Error('a missing child snapshot must be re-dispatched, not queried'); },
      isMissingJobError: () => false,
      findImageDisplayItemByJob: () => null,
      takePendingLiveItem: () => null,
      normalizeImageContextForStorage: value => value,
      mergeImageResultContexts: imageResultWorkflow.mergeImageResultContexts,
      renderImageResultContext: () => '',
      updateSessionDisplayItem() {},
      findMessageNodeByDisplayItem: () => null,
      updateMessage() {},
      setImageContext() {},
      reconcileSuccessfulImageResult() {},
      saveSessionMessages: async () => {},
      cleanupStalePendingDisplay() {},
      showRunError() {},
      formatElapsed: () => '0s',
      jobDurationMs: () => 0,
      imageResultToHtml: async () => ({ html: '', raw: '', imageContext: {} }),
    };

    await jobResumeWorkflow.createJobResumeWorkflow(deps).resumeImageBatch(sessionId);

    assert.strictEqual(resumed, true, 'an incomplete child durable set must resume the original pending submission');
    assert.strictEqual(jobLookups, 0, 'resume must not query a child that has no durable snapshot yet');
    assert.deepStrictEqual(events, [['resume-pending', sessionId]]);
    assert.ok(submitHelpers.loadImageBatchIndex(storage, sessionId), 'the batch index remains as the durable owner while pending-submit recovery re-dispatches');
  } finally {
    delete global.localStorage;
  }
}

module.exports = [
  testBatchSnapshotHelpersRoundTrip,
  testResumeImageBatchWithoutIndexCleansUp,
  testResumeImageBatchSkipsCompletedChildrenAndClearsIndex,
  testResumeImageBatchRendersRunningChildAndKeepsPartialIndexOnMissingSibling,
  testResumeImageBatchMergesChildrenIntoOneParentMessage,
  testResumeImageBatchRestoresCompletedSiblingFromDurableIndex,
  testResumeRunningBatchChildrenFollowExistingJobsWithoutRestart,
  testResumeCompletedFiveImageBatchKeepsAllImagesAfterRefresh,
  testResumeImageBatchFallsBackToPendingSubmitWhenAChildSnapshotIsMissing,
];
