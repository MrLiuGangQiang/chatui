'use strict';

const assert = require('assert');
const imageBatchWorkflow = require('../../client/app/image-batch-workflow');
const imageResultWorkflow = require('../../client/app/image-result-workflow');
const submitHelpers = require('../../client/app/submit-workflow.helpers');
const { makeExecutionFixture } = require('../helpers/dispatch-contract-fixture');

function memoryStorage() {
  const values = new Map();
  return { getItem: key => values.get(key) || null, setItem: (key, value) => values.set(key, String(value)), removeItem: key => values.delete(key) };
}

function fixtureItem(prompt) {
  const fixture = makeExecutionFixture({ operation: 'text_to_image', relation: 'new', prompt });
  return {
    dispatchContract: fixture.dispatchContract,
    executionMedia: fixture.executionResources,
    prompt,
  };
}

function makeDeps({ parentJob = null, parentStatus = 'done', captureStart = true } = {}) {
  const session = { id: 'session-batch', messages: [], display: [] };
  const parent = { id: 'batch-parent', role: 'assistant', pending: '1', responseIndex: '1', rawText: 'pending' };
  session.display.push(parent);
  const state = {
    activeSessionId: session.id,
    sessions: [session],
    messages: session.messages,
    followingImageJobs: new Set(),
    activeRuns: new Map(),
  };
  let childCounter = 0;
  const savedMessages = [];
  const displayUpdates = [];
  const errors = [];
  const startCalls = [];
  const activeRunJobs = new Set();
  const disposed = [];
  const doneTasks = parentStatus === 'done'
    ? [{ id: 'imgjob-1', status: 'done', data: { data: [{ url: 'https://img.example/1.png' }] }, error: null }, { id: 'imgjob-2', status: 'done', data: { data: [{ url: 'https://img.example/2.png' }] }, error: null }]
    : [{ id: 'imgjob-1', status: 'done', data: { data: [{ url: 'https://img.example/1.png' }] }, error: null }, { id: 'imgjob-2', status: 'error', data: null, error: { message: 'upstream failed' } }];
  const parentSnapshot = parentJob || { id: 'imgbatch-test12345', status: parentStatus, data: { tasks: doneTasks }, error: parentStatus === 'error' ? { message: 'one failed' } : null };

  const deps = {
    state,
    getConfig: () => ({ baseUrl: 'https://api.example.test/v1', apiKey: 'test-key', imageModel: 'gpt-image-1', imageSize: 'auto' }),
    ensureActiveRun: () => ({ stopped: false, token: 'run-batch', abortController: new AbortController() }),
    addActiveRunJob: (_sessionId, kind, jobId) => { activeRunJobs.add(`${kind}:${jobId}`); },
    setActiveOutputForSession() {},
    shouldSuppressRunUi: () => false,
    pendingFeedbackHtml: value => value,
    renderImageBatchResult: imageResultWorkflow.renderImageBatchResult,
    patchImageBatchDisplayNode() {},
    renderImageResultContext() { return ''; },
    updateSessionDisplayItem: (_sessionId, item, _role, markup, options = {}) => { displayUpdates.push({ markup, options }); return Object.assign(item, { ...options, html: markup }); },
    persistSessionDisplay() {},
    findMessageNodeByDisplayItem: () => null,
    updateMessage() {},
    setImageContext() {},
    clearPendingFeedback() {},
    clearReasoning() {},
    normalizeImageContextForStorage: value => value,
    mergeImageResultContexts: imageResultWorkflow.mergeImageResultContexts,
    imageResultToHtml: async (data, _elapsed, options = {}) => {
      const imageId = options.prompt === 'a cat' ? 'cat' : 'dog';
      return {
        raw: imageId,
        html: `<div data-image-id="${imageId}"></div>`,
        metaText: 'RT 1s',
        imageContext: { schema_version: 'image_result.v1', resultId: imageId, attachments: [{ imageId, src: `indexeddb://${imageId}`, persistedSrc: `indexeddb://${imageId}` }] },
      };
    },
    formatElapsed: () => '1s',
    jobDurationMs: () => 1,
    saveSessionMessages: async (_sessionId, messages) => { savedMessages.push(messages.map(item => ({ ...item }))); },
    cloneMessageList: list => list.map(item => ({ ...item })),
    showRunError: (_sessionId, error, _item, _node) => { errors.push(error); },
    playDoneSound() {},
    getEffectiveImageStylePrompt: () => '',
    buildImagePromptWithStylePrompt: (prompt, style) => style ? `${prompt}\n\n${style}` : prompt,
    persistImageAttachmentRefs: async list => list,
    imageFilesToJobPayload: async () => [],
    restoreImageAttachmentsFromContext: async () => [],
    makeImageItemId: () => 'img_test',
    makeClientImageJobId: () => `imgjob-client-${++childCounter}`,
    startImageBatchJob: async options => { startCalls.push(options); return parentSnapshot; },
    getImageBatchJob: async () => parentSnapshot,
    disposeImageBatchJob: async ({ batchId }) => { disposed.push(batchId); },
  };
  return { deps, session, parent, savedMessages, displayUpdates, errors, startCalls, activeRunJobs, disposed };
}

async function testRunImageBatchDispatchesOneServerCallAndCommitsMergedResult() {
  const previousLocalStorage = globalThis.localStorage;
  globalThis.localStorage = memoryStorage();
  try {
    const { deps, session, parent, savedMessages, startCalls, activeRunJobs, disposed } = makeDeps({ parentStatus: 'done' });
    const workflow = imageBatchWorkflow.createImageBatchWorkflow(deps);
    await workflow.runImageBatch(session.id, {
      items: [fixtureItem('a cat'), fixtureItem('a dog')],
      batchJobId: 'imgbatch-test12345',
      submissionId: 'submit-batch',
      batchParent: parent,
      responseIndex: '1',
    });

    assert.strictEqual(startCalls.length, 1, 'the page must call the server batch endpoint exactly once');
    assert.ok(activeRunJobs.has('image_batch:imgbatch-test12345'), 'the parent batch id must be registered in the active run for stop/abort');
    const call = startCalls[0];
    assert.strictEqual(call.batchId, 'imgbatch-test12345');
    assert.strictEqual(call.tasks.length, 2);
    call.tasks.forEach(task => {
      assert.strictEqual(task.requestPurpose, 'final_execution');
      assert.ok(task.dispatchContract && task.payload && Array.isArray(task.bindingEvidence));
      assert.deepStrictEqual(task.files, []);
      assert.deepStrictEqual(task.masks, []);
    });
    const message = session.messages.find(item => item.role === 'assistant');
    assert.ok(message, 'a completed server batch must commit one canonical assistant message');
    assert.strictEqual(message.displayItemId, parent.id);
    assert.deepStrictEqual(JSON.parse(message.imageContext).attachments.map(item => item.imageId), ['cat', 'dog']);
    assert.strictEqual(submitHelpers.loadImageBatchIndex(globalThis.localStorage, session.id), null);
    assert.deepStrictEqual(disposed, ['imgbatch-test12345']);
    assert.strictEqual(savedMessages.length, 1);
  } finally {
    if (previousLocalStorage === undefined) delete globalThis.localStorage;
    else globalThis.localStorage = previousLocalStorage;
  }
}

async function testRunImageBatchClearsRecoveryStateOnTerminalFailure() {
  const previousLocalStorage = globalThis.localStorage;
  globalThis.localStorage = memoryStorage();
  try {
    const { deps, session, parent, errors, disposed } = makeDeps({ parentStatus: 'error' });
    const workflow = imageBatchWorkflow.createImageBatchWorkflow(deps);
    await assert.rejects(
      () => workflow.runImageBatch(session.id, {
        items: [fixtureItem('a cat'), fixtureItem('a dog')],
        batchJobId: 'imgbatch-test12345',
        submissionId: 'submit-batch',
        batchParent: parent,
        responseIndex: '1',
      }),
      error => error && error.terminalJob === true,
    );
    assert.strictEqual(submitHelpers.loadImageBatchIndex(globalThis.localStorage, session.id), null,
      'a terminal batch cannot recover and must not leave an index that retries forever after reload');
    assert.strictEqual(submitHelpers.loadImageBatchChild(globalThis.localStorage, session.id, 'imgjob-client-1'), null);
    assert.strictEqual(submitHelpers.loadImageBatchChild(globalThis.localStorage, session.id, 'imgjob-client-2'), null);
    assert.deepStrictEqual(disposed, ['imgbatch-test12345'], 'terminal server state must be disposed after local cleanup');
    assert.strictEqual(errors.length, 0, 'the batch layer must propagate errors and leave presentation to its caller');
    assert.strictEqual(session.messages.some(item => item.role === 'assistant'), false, 'a partial batch must not commit a canonical message');
  } finally {
    if (previousLocalStorage === undefined) delete globalThis.localStorage;
    else globalThis.localStorage = previousLocalStorage;
  }
}

async function testRunImageBatchKeepsRecoveryStateOnTransientWaitFailure() {
  const previousLocalStorage = globalThis.localStorage;
  globalThis.localStorage = memoryStorage();
  try {
    const { deps, session, parent, errors, disposed } = makeDeps({ parentStatus: 'done' });
    deps.getImageBatchJob = async () => { throw new Error('temporary network failure'); };
    const workflow = imageBatchWorkflow.createImageBatchWorkflow(deps);
    await assert.rejects(
      () => workflow.runImageBatch(session.id, {
        items: [fixtureItem('a cat'), fixtureItem('a dog')],
        batchJobId: 'imgbatch-test12345',
        submissionId: 'submit-batch',
        batchParent: parent,
        responseIndex: '1',
        pollIntervalMs: 0,
      }),
      error => error?.message === 'temporary network failure',
    );
    assert.ok(submitHelpers.loadImageBatchIndex(globalThis.localStorage, session.id),
      'a transient wait failure must retain the durable batch index for reload recovery');
    assert.ok(submitHelpers.loadImageBatchChild(globalThis.localStorage, session.id, 'imgjob-client-1'));
    assert.ok(submitHelpers.loadImageBatchChild(globalThis.localStorage, session.id, 'imgjob-client-2'));
    assert.deepStrictEqual(disposed, [], 'a transient wait failure must not destroy the running server batch');
    assert.strictEqual(errors.length, 0, 'the batch layer must not render the same propagated error itself');
  } finally {
    if (previousLocalStorage === undefined) delete globalThis.localStorage;
    else globalThis.localStorage = previousLocalStorage;
  }
}


async function testWaitImageBatchJobRejectsMissingStatusResponse() {
  const { deps } = makeDeps({ parentStatus: 'done' });
  deps.getImageBatchJob = async () => undefined;
  const workflow = imageBatchWorkflow.createImageBatchWorkflow(deps);
  await assert.rejects(
    () => workflow.waitImageBatchJob('imgbatch-test12345'),
    error => error?.code === 'IMAGE_BATCH_STATUS_INVALID'
      && !String(error?.message || '').includes("reading 'status'")
  );
}


async function testRunImageBatchRendersEachCompletedChildBeforeBatchTerminal() {
  const previousLocalStorage = globalThis.localStorage;
  globalThis.localStorage = memoryStorage();
  try {
    const fixture = makeDeps({ parentStatus: 'done' });
    const runningTasks = [
      { id: 'imgjob-1', status: 'done', data: { data: [{ url: 'https://img.example/1.png' }] }, error: null },
      { id: 'imgjob-2', status: 'running', data: null, error: null },
    ];
    const doneTasks = [
      ...runningTasks.slice(0, 1),
      { id: 'imgjob-2', status: 'done', data: { data: [{ url: 'https://img.example/2.png' }] }, error: null },
    ];
    let poll = 0;
    fixture.deps.getImageBatchJob = async () => ({
      id: 'imgbatch-test12345',
      status: poll++ === 0 ? 'running' : 'done',
      data: { tasks: poll === 1 ? runningTasks : doneTasks },
      error: null,
    });
    const workflow = imageBatchWorkflow.createImageBatchWorkflow(fixture.deps);
    await workflow.runImageBatch(fixture.session.id, {
      items: [fixtureItem('a cat'), fixtureItem('a dog')],
      batchJobId: 'imgbatch-test12345',
      submissionId: 'submit-batch',
      batchParent: fixture.parent,
      responseIndex: '1',
      pollIntervalMs: 0,
    });
    const firstCompletedUpdate = fixture.displayUpdates.findIndex(update => update.markup.includes('data-image-id="cat"'));
    assert.ok(firstCompletedUpdate >= 0, 'the first completed image must render before the terminal batch update');
    const finalUpdate = fixture.displayUpdates.findIndex(update => update.markup.includes('data-image-id="dog"'));
    assert.ok(finalUpdate > firstCompletedUpdate, 'later child completion must update after the first slot');
  } finally {
    if (previousLocalStorage === undefined) delete globalThis.localStorage;
    else globalThis.localStorage = previousLocalStorage;
  }
}

async function testRunImageBatchSerializesTerminalSnapshotProcessing() {
  const previousLocalStorage = globalThis.localStorage;
  globalThis.localStorage = memoryStorage();
  try {
    const fixture = makeDeps({ parentStatus: 'done' });
    let releaseFirstRender;
    const firstRenderGate = new Promise(resolve => { releaseFirstRender = resolve; });
    let firstTaskRenderCalls = 0;
    const defaultImageResultToHtml = fixture.deps.imageResultToHtml;
    fixture.deps.imageResultToHtml = async (data, elapsed, options = {}) => {
      if (options.prompt === 'a cat') {
        firstTaskRenderCalls += 1;
        await firstRenderGate;
      }
      return defaultImageResultToHtml(data, elapsed, options);
    };

    const workflow = imageBatchWorkflow.createImageBatchWorkflow(fixture.deps);
    const runPromise = workflow.runImageBatch(fixture.session.id, {
      items: [fixtureItem('a cat'), fixtureItem('a dog')],
      batchJobId: 'imgbatch-test12345',
      submissionId: 'submit-batch',
      batchParent: fixture.parent,
      responseIndex: '1',
      pollIntervalMs: 0,
    });

    await new Promise(resolve => setImmediate(resolve));
    const callsBeforeRelease = firstTaskRenderCalls;
    releaseFirstRender();
    await runPromise;

    assert.strictEqual(callsBeforeRelease, 1,
      'a terminal snapshot must wait for its queued update before the final pass processes the same child');
    assert.strictEqual(firstTaskRenderCalls, 1,
      'the same completed child must be converted and persisted exactly once');
  } finally {
    if (previousLocalStorage === undefined) delete globalThis.localStorage;
    else globalThis.localStorage = previousLocalStorage;
  }
}

async function testRunImageBatchDoesNotPersistUnchangedRunningState() {
  const previousLocalStorage = globalThis.localStorage;
  globalThis.localStorage = memoryStorage();
  try {
    const fixture = makeDeps({ parentStatus: 'done' });
    const runningTasks = [
      { id: 'imgjob-1', status: 'running', data: null, error: null },
      { id: 'imgjob-2', status: 'running', data: null, error: null },
    ];
    const doneTasks = [
      { id: 'imgjob-1', status: 'done', data: { data: [{ url: 'https://img.example/1.png' }] }, error: null },
      { id: 'imgjob-2', status: 'done', data: { data: [{ url: 'https://img.example/2.png' }] }, error: null },
    ];
    let poll = 0;
    fixture.deps.getImageBatchJob = async () => {
      const snapshot = poll < 2
        ? { id: 'imgbatch-test12345', status: 'running', data: { tasks: runningTasks }, error: null }
        : { id: 'imgbatch-test12345', status: 'done', data: { tasks: doneTasks }, error: null };
      poll += 1;
      return snapshot;
    };
    const workflow = imageBatchWorkflow.createImageBatchWorkflow(fixture.deps);
    await workflow.runImageBatch(fixture.session.id, {
      items: [fixtureItem('a cat'), fixtureItem('a dog')],
      batchJobId: 'imgbatch-test12345',
      submissionId: 'submit-batch',
      batchParent: fixture.parent,
      responseIndex: '1',
      pollIntervalMs: 0,
    });
    const unchangedRunningWrites = fixture.displayUpdates.filter(update => update.options.rawText === '正在生成 0/2 张图片').length;
    assert.strictEqual(unchangedRunningWrites, 1,
      'an unchanged running batch snapshot must not write the same display record again');
  } finally {
    if (previousLocalStorage === undefined) delete globalThis.localStorage;
    else globalThis.localStorage = previousLocalStorage;
  }
}


function testBatchWorkflowProvidesPersistenceFallbackToTaskPreparation() {
  const source = require('fs').readFileSync(require('path').join(__dirname, '../../client/app/image-batch-workflow.js'), 'utf8');
  assert.match(source, /persistImageAttachmentRefsDep/);
  assert.match(source, /root\?\.persistImageAttachmentRefs/);
  assert.match(source, /persistImageAttachmentRefs,\n    \}\);/);
  const appSource = require('fs').readFileSync(require('path').join(__dirname, '../../app.js'), 'utf8');
  assert.match(appSource, /imageFilesToJobPayload,persistImageAttachmentRefs,getEffectiveImageStylePrompt,buildImagePromptWithStylePrompt,updateLiveDisplay/);

}

module.exports = [
  testRunImageBatchDispatchesOneServerCallAndCommitsMergedResult,
  testRunImageBatchClearsRecoveryStateOnTerminalFailure,
  testRunImageBatchKeepsRecoveryStateOnTransientWaitFailure,
  testWaitImageBatchJobRejectsMissingStatusResponse,
  testRunImageBatchRendersEachCompletedChildBeforeBatchTerminal,
  testRunImageBatchSerializesTerminalSnapshotProcessing,
  testRunImageBatchDoesNotPersistUnchangedRunningState,
  testBatchWorkflowProvidesPersistenceFallbackToTaskPreparation,
];
