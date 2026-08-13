'use strict';

const assert = require('assert');
const submitWorkflow = require('../../client/app/submit-workflow');
const jobWorkflow = require('../../client/app/job-workflow');
const taskState = require('../../client/core/task-state');
const submitHelpers = require('../../client/app/submit-workflow.helpers');
const { makeExecutionFixture } = require('../helpers/dispatch-contract-fixture');

function memoryStorage() {
  const values = new Map();
  return { getItem: key => values.get(key) || null, setItem: (key, value) => values.set(key, String(value)), removeItem: key => values.delete(key) };
}

function replaceGlobal(key, value) {
  const previous = global[key];
  global[key] = value;
  return () => { if (previous === undefined) delete global[key]; else global[key] = previous; };
}

function batchItem(prompt) {
  const fixture = makeExecutionFixture({ operation: 'text_to_image', relation: 'new', prompt });
  return {
    task: { task_type: 'generate', prompt, input_images: [] },
    operation: 'text_to_image',
    api: 'image_generation',
    mode: 'image',
    dispatchContract: fixture.dispatchContract,
    executionResources: fixture.executionResources,
    route: {
      mode: 'image', api: 'image_generation', operationType: 'text_to_image', operationApi: 'image_generation',
      operationMode: 'image', relation: 'new', readiness: 'ready', dispatchAuthorized: true, needClarification: false,
      taskShape: 'single', resources: [], imageRefs: [], fileRefs: [], messageRefs: [],
      selectedIndexes: [], selectedImageIndexes: [], selectedFileIndexes: [], selectedImageIds: [], selectedReferenceId: '',
      usePreviousImage: false, contextualImagePrompt: prompt, editInstruction: '',
      executionResources: fixture.executionResources, dispatchContract: fixture.dispatchContract,
    },
  };
}

function editItem(prompt, imageId) {
  const fixture = makeExecutionFixture({
    operation: 'edit_image', relation: 'new', prompt,
    resources: [{ key: 'r1', type: 'image', role: 'target', source: 'current', id: imageId }],
  });
  return {
    task: { task_type: 'edit', prompt, input_images: [{ candidate_key: 'i1', role: 'target' }] },
    operation: 'edit_image', api: 'image_edit', mode: 'edit_image',
    dispatchContract: fixture.dispatchContract, executionResources: fixture.executionResources,
    route: {
      mode: 'edit_image', api: 'image_edit', operationType: 'edit_image', operationApi: 'image_edit',
      operationMode: 'edit_image', relation: 'new', readiness: 'ready', dispatchAuthorized: true, needClarification: false,
      taskShape: 'single', resources: [], imageRefs: [], fileRefs: [], messageRefs: [],
      selectedIndexes: [], selectedImageIndexes: [], selectedFileIndexes: [], selectedImageIds: [], selectedReferenceId: '',
      usePreviousImage: false, contextualImagePrompt: prompt, editInstruction: prompt,
      executionResources: fixture.executionResources, dispatchContract: fixture.dispatchContract,
    },
  };
}

function makeFixture({ items = [], attachments = [], outerExecutionResources = null, sendImageImpl = null, omitDisplayItemId = false } = {}) {
  const session = { id: 'session-batch', messages: [], display: [] };
  const state = {
    activeSessionId: session.id, sessions: [session], messages: [], attachments: attachments || [],
    disposedSessionIds: new Set(), promptDrafts: new Map(), autoMode: true, mode: 'chat',
    editingIndex: null, editingNode: null, editingQuoteContext: '', followingImageJobs: new Set(), activeRuns: new Map(),
  };
  const prompt = { value: '猫、狗、鸟各一张', focus() {} };
  const run = { stopped: false, abortController: new AbortController() };
  const events = [];
  const imageCalls = [];
  const runErrors = [];
  const routeBase = {
    mode: 'image', api: 'image_generation', operationType: 'text_to_image', operationApi: 'image_generation',
    operationMode: 'image', relation: 'new', readiness: 'ready', dispatchAuthorized: true, needClarification: false,
    taskShape: 'multi', resources: [], imageRefs: [], fileRefs: [], messageRefs: [],
    selectedIndexes: [], selectedImageIndexes: [], selectedFileIndexes: [], selectedImageIds: [], selectedReferenceId: '',
    usePreviousImage: false, contextualImagePrompt: '分别生成一只猫、一只狗、一只鸟', editInstruction: '',
  };
  if (items.length) routeBase.imagePlanCompiled = { kind: 'batch', items };
  const finalRoute = { ...routeBase, dispatchContract: items[0]?.dispatchContract || null, executionResources: outerExecutionResources || items[0]?.executionResources || null };

  let gateResolve = null;
  let clientJobCounter = 0;
  const gate = new Promise(resolve => { gateResolve = resolve; });
  const workflow = submitWorkflow.createSubmitWorkflow({
    state, taskEvents: taskState.TASK_EVENTS,
    $: id => id === 'prompt' ? prompt : { querySelectorAll: () => [] },
    isSessionBusy: () => false, stopActiveRun: async () => {}, toast: () => {}, hasPendingUploads: () => false,
    updateSendAvailability: () => {}, unlockDoneSound: () => {}, saveConfig: () => {},
    ensureActiveRun: () => run, prepareUserAttachmentPreviews: async () => {}, prepareChatImageAttachments: async files => files,
    applyPendingEdit: () => null, renderUserMessageWithAttachments: text => text,
    buildUserMessageContent: text => text, buildUserApiContent: text => text,
    buildUploadedImageContext: async () => null, buildUserAttachmentContext: async () => null,
    addMessage: () => ({ dataset: {}, isConnected: false }),
    appendSessionDisplayMessage: (_sessionId, role, content, options = {}) => {
      const item = { ...(omitDisplayItemId ? {} : { id: `display-${session.display.length + 1}` }), role, content, ...options };
      session.display.push(item); return item;
    },
    persistSessionDisplay: () => {}, cloneMessageList: list => list.map(item => ({ ...item })),
    getActiveSession: () => session, saveChatHistory: async () => {}, saveSessionMessages: async () => {},
    clearAttachments: () => {}, clearQuotedMessage: () => {}, getQuotedMessage: () => null,
    scheduleAutoResize: () => {}, setSessionBusy: () => {}, prepareReplacementResponse: () => null,
    pendingFeedbackHtml: text => text, hasImageAttachments: () => false, normalizeRoute: value => value,
    getEffectiveRoute: async () => finalRoute,
    createRouteRecognitionUi: () => ({ startSlowNotice() {}, stopSlowNotice() {}, showSlowNotice() {} }),
    updateModeUi: () => {}, warnMissingModel: () => false, updateMessage: () => {},
    showRunError: (_sessionId, error) => { runErrors.push(error); },
    updateSessionDisplayItem: () => {}, clearPendingFeedback: () => {}, clearReasoning: () => {},
    sendChat: async () => {},
    sendImage: async (childPrompt, options) => {
      imageCalls.push({ prompt: childPrompt, options });
      await gate;
      if (sendImageImpl) return sendImageImpl(childPrompt, options);
    },
    getLatestUploadedImageContext: () => null, getUploadedImageContext: () => null,
    restoreImageAttachmentsFromContext: async () => [], restoreUserAttachmentsFromContext: async () => [],
    getConfig: () => ({ baseUrl: 'https://example.test/v1', apiKey: 'test-key', routeModel: 'route-model' }),
    getSessionRouteModel: () => 'route-model', quotedAttachmentTextFromContext: () => '', quotedFileCandidatesFromContext: () => [],
    clearActiveRun: () => {}, finishSessionTask: () => {}, dispatchTaskEvent: (_sessionId, event) => events.push(event),
    resumeSessionJobs: () => {}, makeClientChatJobId: () => 'chatjob-batch', makeClientImageJobId: () => `imgjob-batch-${++clientJobCounter}`,
    saveChatJob: () => {}, clearChatJob: () => {}, shouldPrepareManagedChatJob: () => true,
    findMessageNodeByDisplayItem: () => null, insertMessageNodeAtDisplayPosition: () => {},
    saveSessionsMeta: () => {},
  });
  return { workflow, state, session, events, imageCalls, runErrors, gate: () => gateResolve() };
}

async function testBatchRouteDispatchesEveryChildConcurrently() {
  const restore = [
    replaceGlobal('window', global),
    replaceGlobal('localStorage', memoryStorage()),
    replaceGlobal('ChatUIAppJobWorkflow', jobWorkflow),
    replaceGlobal('ChatUIRouteService', { isRouteDispatchable: () => true, cleanQuotedContent: v => String(v || ''), buildQuotedRouteContent: ({ text }) => text }),
  ];
  try {
    const fixture = makeFixture({ items: [batchItem('一张猫'), batchItem('一张狗'), batchItem('一张鸟')] });
    const submission = fixture.workflow.onSubmit({ preventDefault() {}, submitter: { id: 'sendBtn' } });
    // wait until every child has entered sendImage (all started before the gate opens)
    const deadline = Date.now() + 2000;
    while (fixture.imageCalls.length < 3 && Date.now() < deadline) await new Promise(resolve => setImmediate(resolve));
    assert.strictEqual(fixture.imageCalls.length, 3, 'all three children must start before any child completes');
    assert.deepStrictEqual(fixture.imageCalls.map(call => call.prompt), ['一张猫', '一张狗', '一张鸟']);
    fixture.gate();
    await submission;
    assert.strictEqual(fixture.imageCalls.length, 3);
    assert.ok(fixture.imageCalls.every(call => typeof call.options.batchChildKey === 'string' && call.options.batchChildKey.length > 0), 'each child must persist under its own durable recovery key');
    assert.strictEqual(new Set(fixture.imageCalls.map(call => call.options.batchChildKey)).size, 3, 'batch child recovery keys must be unique');
    assert.strictEqual(new Set(fixture.imageCalls.map(call => call.options.liveItem)).size, 1,
      'one multi-image request must use one shared assistant display item');
    assert.strictEqual(fixture.session.display.filter(item => item?.role === 'assistant').length, 1,
      'batch fan-out must not create one assistant message per child task');
    assert.deepStrictEqual(fixture.imageCalls.map(call => call.options.batchIndex), [0, 1, 2],
      'each child keeps only an internal batch ordinal for progress and ordering');
    assert.ok(fixture.imageCalls.every(call => call.options.deferBatchCompletion === true), 'children must defer terminal completion to the batch');
    assert.strictEqual(typeof fixture.imageCalls[0].options.acquireResultCommit, 'function', 'children must receive the serial result-commit queue');
    assert.deepStrictEqual(fixture.imageCalls.slice(1).map(call => call.options.loadingNode), [null, null],
      'non-leading batch children must not receive synthetic DOM placeholders that lack dataset/display identity');
    assert.ok(fixture.events.some(event => event.type === taskState.TASK_EVENTS.HANDOFF_PREPARED), 'batch handoff must publish task evidence');
  } finally {
    restore.forEach(fn => fn());
  }
}

async function testBatchWithMediaChildDispatchesThroughCanonicalExecutor() {
  const restore = [
    replaceGlobal('window', global),
    replaceGlobal('localStorage', memoryStorage()),
    replaceGlobal('ChatUIAppJobWorkflow', jobWorkflow),
    replaceGlobal('ChatUIRouteService', { isRouteDispatchable: () => true, cleanQuotedContent: v => String(v || ''), buildQuotedRouteContent: ({ text }) => text }),
  ];
  try {
    const edit = editItem('把猫改成白色', 'cat-1');
    const items = [batchItem('一张猫'), edit];
    const attachment = { imageId: 'cat-1', name: 'cat.png', type: 'image/png', dataUrl: 'data:image/png;base64,QUJDRA==' };
    const fixture = makeFixture({ items, attachments: [attachment], outerExecutionResources: edit.executionResources });
    const submission = fixture.workflow.onSubmit({ preventDefault() {}, submitter: { id: 'sendBtn' } });
    const deadline = Date.now() + 2000;
    while (fixture.imageCalls.length < 2 && Date.now() < deadline) await new Promise(resolve => setImmediate(resolve));
    fixture.gate();
    await submission;
    assert.deepStrictEqual(fixture.imageCalls.map(call => call.prompt), ['一张猫', '把猫改成白色']);
    const editCall = fixture.imageCalls[1];
    assert.strictEqual(editCall.options.attachments.length, 1, 'the edit child must receive its projected target attachment');
    assert.strictEqual(editCall.options.executionMedia.operation, 'edit_image');
    assert.strictEqual(editCall.options.statusPrefix, '任务 2/2');
  } finally {
    restore.forEach(fn => fn());
  }
}

async function testNewBatchClearsOrphanedChildSnapshotsFromPreviousBatch() {
  const restore = [
    replaceGlobal('window', global),
    replaceGlobal('localStorage', memoryStorage()),
    replaceGlobal('ChatUIAppJobWorkflow', jobWorkflow),
    replaceGlobal('ChatUIRouteService', { isRouteDispatchable: () => true, cleanQuotedContent: v => String(v || ''), buildQuotedRouteContent: ({ text }) => text }),
  ];
  try {
    const previousStorage = global.localStorage;
    const oldIndex = { schema_version: 'image_batch.v1', batchId: 'old-batch', children: [{ jobId: 'old-job-1', prompt: '旧任务', displayItemId: 'old-row', responseIndex: '1', mode: 'image', status: 'running' }] };
    previousStorage.setItem(submitHelpers.imageBatchIndexKey('session-batch'), JSON.stringify(oldIndex));
    previousStorage.setItem(submitHelpers.imageBatchChildKey('session-batch', 'old-job-1'), JSON.stringify({ id: 'old-job-1', prompt: '旧任务' }));
    const fixture = makeFixture({ items: [batchItem('一张猫'), batchItem('一张狗')] });
    const submission = fixture.workflow.onSubmit({ preventDefault() {}, submitter: { id: 'sendBtn' } });
    const deadline = Date.now() + 2000;
    while (fixture.imageCalls.length < 2 && Date.now() < deadline) await new Promise(resolve => setImmediate(resolve));
    fixture.gate();
    await submission;
    assert.strictEqual(previousStorage.getItem(submitHelpers.imageBatchChildKey('session-batch', 'old-job-1')), null,
      'a new batch must remove orphaned child snapshots from the previous batch so local storage cannot grow across retries');
    assert.strictEqual(previousStorage.getItem(submitHelpers.imageBatchIndexKey('session-batch')), null,
      'a fully completed new batch must also clear its recovery index');
  } finally {
    restore.forEach(fn => fn());
  }
}

async function testBatchChildFailureKeepsSiblingRows() {
  const restore = [
    replaceGlobal('window', global),
    replaceGlobal('localStorage', memoryStorage()),
    replaceGlobal('ChatUIAppJobWorkflow', jobWorkflow),
    replaceGlobal('ChatUIRouteService', { isRouteDispatchable: () => true, cleanQuotedContent: v => String(v || ''), buildQuotedRouteContent: ({ text }) => text }),
  ];
  try {
    const fixture = makeFixture({
      items: [batchItem('一张猫'), batchItem('一张狗'), batchItem('一张鸟')],
      sendImageImpl: (_prompt, options) => {
        if (options.dispatchContract?.arguments?.prompt === '一张狗') throw new Error('dog failed');
      },
    });
    const submission = fixture.workflow.onSubmit({ preventDefault() {}, submitter: { id: 'sendBtn' } });
    const deadline = Date.now() + 2000;
    while (fixture.imageCalls.length < 3 && Date.now() < deadline) await new Promise(resolve => setImmediate(resolve));
    fixture.gate();
    await submission;
    assert.strictEqual(fixture.imageCalls.length, 3, 'one failing child must not prevent sibling dispatch');
    assert.ok(fixture.runErrors.some(error => error?.message === 'dog failed'), 'the failed child row must surface its own error');
  } finally {
    restore.forEach(fn => fn());
  }
}

module.exports = [
  testBatchRouteDispatchesEveryChildConcurrently,
  testBatchWithMediaChildDispatchesThroughCanonicalExecutor,
  testBatchChildFailureKeepsSiblingRows,
  testNewBatchClearsOrphanedChildSnapshotsFromPreviousBatch,
];
