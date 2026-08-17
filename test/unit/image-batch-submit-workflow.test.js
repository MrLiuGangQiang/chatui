'use strict';

const assert = require('assert');
const submitWorkflow = require('../../client/app/submit-workflow');
const jobWorkflow = require('../../client/app/job-workflow');
const taskState = require('../../client/core/task-state');
const taskContinuity = require('../../shared/task-continuity');
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
  const imageTaskState = taskContinuity.transitionTaskContinuity({ goalMode: 'replace', goal: prompt });
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
      imageTaskState, resolvedImageGoal: prompt,
      executionResources: fixture.executionResources, dispatchContract: fixture.dispatchContract,
    },
  };
}

function editItem(prompt, imageId) {
  const fixture = makeExecutionFixture({
    operation: 'edit_image', relation: 'new', prompt,
    resources: [{ key: 'r1', type: 'image', role: 'target', source: 'current', id: imageId }],
  });
  const imageTaskState = taskContinuity.transitionTaskContinuity({ goalMode: 'replace', goal: prompt });
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
      imageTaskState, resolvedImageGoal: prompt,
      executionResources: fixture.executionResources, dispatchContract: fixture.dispatchContract,
    },
  };
}

function makeFixture({ items = [], attachments = [], outerExecutionResources = null, sendImageBatchImpl = null, omitDisplayItemId = false, parentDispatchContract = undefined, getEffectiveRouteImpl = null } = {}) {
  const session = { id: 'session-batch', messages: [], display: [] };
  const state = {
    activeSessionId: session.id, sessions: [session], messages: [], attachments: attachments || [],
    disposedSessionIds: new Set(), promptDrafts: new Map(), autoMode: true, mode: 'chat',
    editingIndex: null, editingNode: null, editingQuoteContext: '', followingImageJobs: new Set(), activeRuns: new Map(),
  };
  const prompt = { value: '猫、狗、鸟各一张', focus() {} };
  const run = { stopped: false, abortController: new AbortController() };
  const events = [];
  const batchCalls = [];
  const runErrors = [];
  const routeBase = {
    mode: 'image', api: 'image_generation', operationType: 'text_to_image', operationApi: 'image_generation',
    operationMode: 'image', relation: 'new', readiness: 'ready', dispatchAuthorized: true, needClarification: false,
    taskShape: 'multi', resources: [], imageRefs: [], fileRefs: [], messageRefs: [],
    selectedIndexes: [], selectedImageIndexes: [], selectedFileIndexes: [], selectedImageIds: [], selectedReferenceId: '',
    usePreviousImage: false, contextualImagePrompt: '分别生成一只猫、一只狗、一只鸟', editInstruction: '',
  };
  if (items.length) routeBase.imagePlanCompiled = { kind: 'batch', items };
  const finalRoute = { ...routeBase, dispatchContract: parentDispatchContract === undefined ? items[0]?.dispatchContract || null : parentDispatchContract, executionResources: outerExecutionResources || items[0]?.executionResources || null };

  const workflow = submitWorkflow.createSubmitWorkflow({
    state, taskEvents: taskState.TASK_EVENTS,
    $: id => id === 'prompt' ? prompt : { querySelectorAll: () => [] },
    isSessionBusy: () => false, stopActiveRun: async () => {}, toast: () => {}, hasPendingUploads: () => false,
    updateSendAvailability: () => {}, unlockDoneSound: () => {}, saveConfig: () => {},
    ensureActiveRun: () => run,
    prepareUserAttachmentPreviews: async () => {}, prepareChatImageAttachments: async files => files,
    applyPendingEdit: () => null, replaceSessionMessages: async () => {},
    renderUserMessageWithAttachments: text => text,
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
    getEffectiveRoute: async () => getEffectiveRouteImpl ? getEffectiveRouteImpl(finalRoute) : finalRoute,
    createRouteRecognitionUi: () => ({ startSlowNotice() {}, stopSlowNotice() {}, showSlowNotice() {} }),
    updateModeUi: () => {}, warnMissingModel: () => false, updateMessage: () => {},
    showRunError: (_sessionId, error) => { runErrors.push(error); },
    updateSessionDisplayItem: () => {}, clearPendingFeedback: () => {}, clearReasoning: () => {},
    sendChat: async () => {},
    sendImageBatch: async (sessionId, options) => {
      batchCalls.push({ sessionId, options });
      if (sendImageBatchImpl) return sendImageBatchImpl(sessionId, options);
      options.onDurableHandoff?.(options.batchJobId, 'image_batch');
      options.onInterfaceCompleted?.({ sessionId, submissionId: options.submissionId, jobId: options.batchJobId, jobKind: 'image_batch' });
    },
    getLatestUploadedImageContext: () => null, getUploadedImageContext: () => null,
    restoreImageAttachmentsFromContext: async () => [], restoreUserAttachmentsFromContext: async () => [],
    getConfig: () => ({ baseUrl: 'https://example.test/v1', apiKey: 'test-key', routeModel: 'route-model' }),
    getSessionRouteModel: () => 'route-model', quotedAttachmentTextFromContext: () => '', quotedFileCandidatesFromContext: () => [],
    clearActiveRun: () => {}, finishSessionTask: () => {}, dispatchTaskEvent: (_sessionId, event) => events.push(event),
    resumeSessionJobs: () => {}, makeClientChatJobId: () => 'chatjob-batch', makeClientImageJobId: () => 'imgjob-batch', makeClientBatchJobId: () => 'imgbatch-batch',
    saveChatJob: () => {}, clearChatJob: () => {}, shouldPrepareManagedChatJob: () => true,
    findMessageNodeByDisplayItem: () => null, insertMessageNodeAtDisplayPosition: () => {},
    saveSessionsMeta: () => {},
  });
  return { workflow, state, session, events, batchCalls, runErrors };
}

async function testBatchRouteDelegatesAllChildrenToOneServerCall() {
  const restore = [
    replaceGlobal('window', global),
    replaceGlobal('localStorage', memoryStorage()),
    replaceGlobal('ChatUIAppJobWorkflow', jobWorkflow),
    replaceGlobal('ChatUIRouteService', { isRouteDispatchable: () => true, cleanQuotedContent: v => String(v || ''), buildQuotedRouteContent: ({ text }) => text }),
  ];
  try {
    const fixture = makeFixture({ items: [batchItem('一张猫'), batchItem('一张狗'), batchItem('一张鸟')] });
    await fixture.workflow.onSubmit({ preventDefault() {}, submitter: { id: 'sendBtn' } });
    assert.strictEqual(fixture.batchCalls.length, 1, 'a multi-image submit must make exactly one server batch call');
    const call = fixture.batchCalls[0];
    assert.strictEqual(call.sessionId, 'session-batch');
    assert.strictEqual(call.options.items.length, 3);
    assert.deepStrictEqual(call.options.items.map(item => item.prompt), ['一张猫', '一张狗', '一张鸟']);
    assert.deepStrictEqual(
      call.options.items.map(item => item.taskState?.segments?.[0]?.text),
      ['一张猫', '一张狗', '一张鸟'],
      'each planned child must carry its own structured task state into batch execution',
    );
    assert.ok(/^imgbatch-/.test(call.options.batchJobId), 'the parent batch must use a batch job identity');
    assert.ok(call.options.batchParent?.id, 'all children must aggregate into one parent display item');
    assert.strictEqual(fixture.session.display.filter(item => item?.role === 'assistant').length, 1);
  } finally {
    restore.forEach(fn => fn());
  }
}

async function testConcurrentSubmitsShareOneRoutePipeline() {
  const restore = [
    replaceGlobal('window', global),
    replaceGlobal('localStorage', memoryStorage()),
    replaceGlobal('ChatUIAppJobWorkflow', jobWorkflow),
    replaceGlobal('ChatUIRouteService', { isRouteDispatchable: () => true, cleanQuotedContent: v => String(v || ''), buildQuotedRouteContent: ({ text }) => text }),
  ];
  try {
    let routeCalls = 0;
    let releaseRoute;
    const routeGate = new Promise(resolve => { releaseRoute = resolve; });
    const fixture = makeFixture({
      items: [batchItem('一张中国美女人像'), batchItem('一张俄罗斯美女人像')],
      parentDispatchContract: null,
      getEffectiveRouteImpl: async route => {
        routeCalls += 1;
        await routeGate;
        return route;
      },
    });
    const first = fixture.workflow.onSubmit({ preventDefault() {}, submitter: { id: 'sendBtn' } });
    for (let attempt = 0; attempt < 20 && routeCalls === 0; attempt += 1) {
      await new Promise(resolve => setImmediate(resolve));
    }
    assert.strictEqual(routeCalls, 1, 'the first submit must reach exactly one route pipeline');
    const second = fixture.workflow.onSubmit({ preventDefault() {}, submitter: { id: 'sendBtn' } });
    await new Promise(resolve => setImmediate(resolve));
    assert.strictEqual(routeCalls, 1,
      'a second submit during routing must not start a duplicate model pipeline for the same session');
    releaseRoute();
    await Promise.all([first, second]);
    assert.strictEqual(fixture.batchCalls.length, 1,
      'deduplicating the route entry must still allow the original batch handoff to complete');
  } finally {
    restore.forEach(fn => fn());
  }
}

async function testCompiledBatchDoesNotRequireAnInvalidParentImagePrompt() {
  const restore = [
    replaceGlobal('window', global),
    replaceGlobal('localStorage', memoryStorage()),
    replaceGlobal('ChatUIAppJobWorkflow', jobWorkflow),
    replaceGlobal('ChatUIRouteService', { isRouteDispatchable: () => true, cleanQuotedContent: v => String(v || ''), buildQuotedRouteContent: ({ text }) => text }),
  ];
  try {
    const fixture = makeFixture({
      items: [batchItem('一张中国美女人像'), batchItem('一张俄罗斯美女人像')],
      parentDispatchContract: null,
    });
    await fixture.workflow.onSubmit({ preventDefault() {}, submitter: { id: 'sendBtn' } });
    assert.strictEqual(fixture.batchCalls.length, 1,
      'a validated batch owns child prompts and must reach the batch handoff without a parent dispatch contract');
    assert.deepStrictEqual(fixture.batchCalls[0].options.items.map(item => item.prompt), ['一张中国美女人像', '一张俄罗斯美女人像']);
    assert.strictEqual(fixture.runErrors.length, 0,
      'the single-image prompt guard must not reject a compiled batch before handoff');
  } finally {
    restore.forEach(fn => fn());
  }
}

async function testBatchWithMediaChildKeepsItsCanonicalExecutionProjection() {
  const restore = [
    replaceGlobal('window', global),
    replaceGlobal('localStorage', memoryStorage()),
    replaceGlobal('ChatUIAppJobWorkflow', jobWorkflow),
    replaceGlobal('ChatUIRouteService', { isRouteDispatchable: () => true, cleanQuotedContent: v => String(v || ''), buildQuotedRouteContent: ({ text }) => text }),
  ];
  try {
    const edit = editItem('把猫改成白色', 'cat-1');
    const attachment = { imageId: 'cat-1', name: 'cat.png', type: 'image/png', dataUrl: 'data:image/png;base64,QUJDRA==' };
    const items = [batchItem('一张猫'), edit];
    const fixture = makeFixture({ items, attachments: [attachment], outerExecutionResources: edit.executionResources });
    await fixture.workflow.onSubmit({ preventDefault() {}, submitter: { id: 'sendBtn' } });
    assert.ok(fixture.batchCalls[0]);
    const call = fixture.batchCalls[0];
    assert.deepStrictEqual(call.options.items.map(item => item.prompt), ['一张猫', '把猫改成白色']);
    assert.strictEqual(call.options.items[1].executionMedia.operation, 'edit_image');
    assert.strictEqual(call.options.items[1].executionMedia.images.length, 1);
  } finally {
    restore.forEach(fn => fn());
  }
}

async function testBatchProjectsEachChildAgainstItsOwnTarget() {
  const restore = [
    replaceGlobal('window', global),
    replaceGlobal('localStorage', memoryStorage()),
    replaceGlobal('ChatUIAppJobWorkflow', jobWorkflow),
    replaceGlobal('ChatUIRouteService', { isRouteDispatchable: () => true, cleanQuotedContent: v => String(v || ''), buildQuotedRouteContent: ({ text }) => text }),
  ];
  try {
    const first = editItem('将第一张改成真实风格', 'cat-1');
    const second = editItem('将第二张改成真实风格', 'dog-1');
    const attachments = [
      { imageId: 'cat-1', name: 'cat.png', type: 'image/png', dataUrl: 'data:image/png;base64,Q0FU' },
      { imageId: 'dog-1', name: 'dog.png', type: 'image/png', dataUrl: 'data:image/png;base64,RE9H' },
    ];
    const fixture = makeFixture({ items: [first, second], attachments, outerExecutionResources: first.executionResources });
    await fixture.workflow.onSubmit({ preventDefault() {}, submitter: { id: 'sendBtn' } });
    const sent = fixture.batchCalls[0]?.options?.items || [];
    assert.strictEqual(sent.length, 2);
    assert.deepStrictEqual(sent.map(item => item.executionMedia.targets.map(target => target.imageId || target.id || target.resource_id)), [['cat-1'], ['dog-1']]);
    assert.deepStrictEqual(sent.map(item => item.executionMedia.imageInputs.map(input => input.imageId || input.id || input.resource_id)), [['cat-1'], ['dog-1']]);
  } finally {
    restore.forEach(fn => fn());
  }
}

async function testBatchServerFailureSurfacesOnce() {
  const restore = [
    replaceGlobal('window', global),
    replaceGlobal('localStorage', memoryStorage()),
    replaceGlobal('ChatUIAppJobWorkflow', jobWorkflow),
    replaceGlobal('ChatUIRouteService', { isRouteDispatchable: () => true, cleanQuotedContent: v => String(v || ''), buildQuotedRouteContent: ({ text }) => text }),
  ];
  try {
    const fixture = makeFixture({
      items: [batchItem('一张猫'), batchItem('一张狗')],
      sendImageBatchImpl: async () => { throw new Error('batch failed'); },
    });
    await fixture.workflow.onSubmit({ preventDefault() {}, submitter: { id: 'sendBtn' } });
    assert.strictEqual(fixture.runErrors.filter(error => error?.message === 'batch failed').length, 1,
      'the submit boundary must present a propagated batch failure exactly once');
  } finally {
    restore.forEach(fn => fn());
  }
}

async function testBatchHandoffAndInterfaceCompletionUseTheParentIdentity() {
  const restore = [
    replaceGlobal('window', global),
    replaceGlobal('localStorage', memoryStorage()),
    replaceGlobal('ChatUIAppJobWorkflow', jobWorkflow),
    replaceGlobal('ChatUIRouteService', { isRouteDispatchable: () => true, cleanQuotedContent: v => String(v || ''), buildQuotedRouteContent: ({ text }) => text }),
  ];
  try {
    let handoffCalled = false;
    const fixture = makeFixture({
      items: [batchItem('一张猫'), batchItem('一张狗')],
      sendImageBatchImpl: async (_sessionId, options) => {
        options.onDurableHandoff?.(options.batchJobId, 'image_batch');
        handoffCalled = true;
      },
    });
    await fixture.workflow.onSubmit({ preventDefault() {}, submitter: { id: 'sendBtn' } });
    assert.strictEqual(handoffCalled, true);
    assert.strictEqual(global.localStorage.getItem(jobWorkflow.pendingSubmitKey('session-batch')), null,
      'the single server batch handoff must clear pending ownership');
    assert.ok(fixture.events.some(event => event.type === taskState.TASK_EVENTS.HANDOFF_COMMITTED));
  } finally {
    restore.forEach(fn => fn());
  }
}

module.exports = [
  testBatchRouteDelegatesAllChildrenToOneServerCall,
  testConcurrentSubmitsShareOneRoutePipeline,
  testCompiledBatchDoesNotRequireAnInvalidParentImagePrompt,
  testBatchWithMediaChildKeepsItsCanonicalExecutionProjection,
  testBatchProjectsEachChildAgainstItsOwnTarget,
  testBatchServerFailureSurfacesOnce,
  testBatchHandoffAndInterfaceCompletionUseTheParentIdentity,
];
