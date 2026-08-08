'use strict';

const assert = require('assert');

const clarification = require('../../shared/clarification-answer');
const clarificationRelation = require('../../shared/clarification-relation');
const jobWorkflow = require('../../client/app/job-workflow');
const submitWorkflow = require('../../client/app/submit-workflow');
const { makeExecutionFixture } = require('../helpers/dispatch-contract-fixture');

const BASE_TASK_TEXT = '把两张图合成一张';
const CLARIFICATION_TEXT = '请选择要合成的第二张图片。';

function memoryStorage() {
  const values = new Map();
  return {
    getItem(key) { return values.get(key) || null; },
    setItem(key, value) { values.set(key, String(value)); },
    removeItem(key) { values.delete(key); },
  };
}

function replaceGlobal(key, value) {
  const previous = global[key];
  if (value === undefined) delete global[key];
  else global[key] = value;
  return () => {
    if (previous === undefined) delete global[key];
    else global[key] = previous;
  };
}

function makePending() {
  return clarification.createPendingClarification({
    messages: [{ role: 'user', content: BASE_TASK_TEXT }],
    clarificationText: CLARIFICATION_TEXT,
    routeInfo: {
      mode: 'chat', api: 'clarify', readiness: 'needs_clarification', needClarification: true,
      dispatchAuthorized: false, operationType: 'image_reference_gen', operationApi: 'image_edit',
      operationMode: 'edit_image', relation: 'followup', resources: [], executionResources: null, dispatchContract: null,
      clarificationQuestion: CLARIFICATION_TEXT,
      clarificationSlots: [{
        key: 'r1', type: 'image', role: 'reference', reason: 'ambiguous',
        choices: [
          { key: 'c1', source: 'history', index: 1, id: 'image-a', resource_id: 'res:image:image-a', reference_id: 'ref-a', label: '图片 A' },
          { key: 'c2', source: 'history', index: 2, id: 'image-b', resource_id: 'res:image:image-b', reference_id: 'ref-b', label: '图片 B' },
        ],
      }],
    },
  });
}

function makeFixture({ promptValue = '2' } = {}) {
  const pending = makePending();
  const session = { id: 'session-answer', messages: [], display: [], pendingClarification: pending };
  const state = {
    activeSessionId: session.id, sessions: [session], messages: [], attachments: [],
    disposedSessionIds: new Set(), promptDrafts: new Map(), autoMode: true, mode: 'chat',
    editingIndex: null, editingNode: null,
  };
  const prompt = { value: promptValue, focus() {} };
  const run = { stopped: false, abortController: new AbortController() };
  const routed = [];
  const sent = [];
  const finalExecution = makeExecutionFixture({
    operation: 'plain_chat',
    relation: 'followup',
    prompt: BASE_TASK_TEXT,
  });
  const finalRoute = {
    mode: 'chat', api: 'chat', needClarification: false, dispatchAuthorized: true, readiness: 'ready',
    operationType: 'plain_chat', operationApi: 'chat', operationMode: 'chat', relation: 'followup',
    resources: [], imageRefs: [], fileRefs: [], messageRefs: [],
    selectedIndexes: [], selectedImageIndexes: [], selectedFileIndexes: [],
    selectedImageIds: [], selectedReferenceId: '', usePreviousImage: false,
    contextualImagePrompt: BASE_TASK_TEXT, editInstruction: '', evidence: 'dispatch_contract.v1',
    localClarification: false,
    executionResources: finalExecution.executionResources,
    dispatchContract: finalExecution.dispatchContract,
  };
  const workflow = submitWorkflow.createSubmitWorkflow({
    state,
    $: id => id === 'prompt' ? prompt : { querySelectorAll: () => [] },
    isSessionBusy: () => false,
    stopActiveRun: async () => {}, toast: () => {}, hasPendingUploads: () => false,
    updateSendAvailability: () => {}, unlockDoneSound: () => {}, saveConfig: () => {},
    ensureActiveRun: () => run, prepareUserAttachmentPreviews: async () => {},
    prepareChatImageAttachments: async files => files,
    buildUploadedImageContext: async () => null, buildUserAttachmentContext: async () => null,
    renderUserMessageWithAttachments: text => text, buildUserMessageContent: text => text,
    buildUserApiContent: text => text, addMessage: () => ({ dataset: {}, isConnected: false }),
    appendSessionDisplayMessage: (_sessionId, role, content, options = {}) => {
      const item = { id: `display-${session.display.length + 1}`, role, content, ...options };
      session.display.push(item);
      return item;
    },
    persistSessionDisplay: () => {}, cloneMessageList: list => list.map(item => ({ ...item })),
    getActiveSession: () => session, saveChatHistory: async () => {}, saveSessionMessages: async () => {},
    clearAttachments: () => {}, clearQuotedMessage: () => {}, getQuotedMessage: () => null,
    scheduleAutoResize: () => {}, setSessionBusy: () => {},
    prepareReplacementResponse: () => null, pendingFeedbackHtml: text => text,
    hasImageAttachments: () => false, normalizeRoute: value => value,
    getEffectiveRoute: async (input, routeAttachments, _sessionId, _headers, routeContext) => {
      routed.push({ input, routeAttachments, routeContext });
      return finalRoute;
    },
    createRouteRecognitionUi: () => ({ startSlowNotice() {}, stopSlowNotice() {}, showSlowNotice() {} }),
    updateModeUi: () => {}, warnMissingModel: () => false,
    updateMessage: () => {}, showRunError: (_sessionId, error) => { throw error; }, updateSessionDisplayItem: () => {},
    sendChat: async (chatPrompt, files, _node, options) => { sent.push({ chatPrompt, files }); options.onDurableHandoff(); },
    sendImage: async () => {}, getLatestUploadedImageContext: () => null, getUploadedImageContext: () => null,
    restoreImageAttachmentsFromContext: async () => [], restoreUserAttachmentsFromContext: async () => [],
    getConfig: () => ({ baseUrl: 'https://example.test/v1', apiKey: 'test-key', routeModel: 'route-model' }),
    getSessionRouteModel: () => 'route-model', quotedAttachmentTextFromContext: () => '', quotedFileCandidatesFromContext: () => [],
    clearActiveRun: () => {}, finishSessionTask: () => {}, dispatchTaskEvent: () => {}, resumeSessionJobs: () => {},
    makeClientChatJobId: () => 'chatjob-answer', makeClientImageJobId: () => 'imgjob-answer', saveChatJob: () => {}, clearChatJob: () => {},
    shouldPrepareManagedChatJob: () => true, findMessageNodeByDisplayItem: () => null, insertMessageNodeAtDisplayPosition: () => {},
    saveSessionsMeta: () => {}, buildRouteContext: () => ({}),
    requestJson: async () => { throw new Error('a text clarification answer must never invoke an independent classifier'); },
  });
  return { workflow, state, session, routed, sent, pending, prompt, finalRoute };
}

async function testTextAnswerAppliesPendingAndReroutesTheBaseTask() {
  const restore = [
    replaceGlobal('window', global),
    replaceGlobal('localStorage', memoryStorage()),
    replaceGlobal('ChatUIAppJobWorkflow', jobWorkflow),
    replaceGlobal('ChatUIClarificationService', clarification),
    replaceGlobal('ChatUIRouteService', { cleanQuotedContent: value => String(value || ''), buildQuotedRouteContent: ({ text }) => text, isRouteDispatchable: () => true }),
  ];
  try {
    const fixture = makeFixture({ promptValue: '2' });
    await fixture.workflow.onSubmit({ preventDefault() {}, submitter: { id: 'sendBtn' } });

    assert.strictEqual(fixture.session.pendingClarification, undefined, 'a complete text answer must consume the pending clarification');
    assert.strictEqual(fixture.routed.length, 1);
    assert.strictEqual(fixture.routed[0].input, BASE_TASK_TEXT, 'the base task must be rerouted after a text answer');
    assert.ok(fixture.routed[0].routeContext?.clarification_context, 'the reroute must carry the answered clarification context');
    assert.strictEqual(fixture.sent.length, 1, 'the resolved task must reach chat dispatch');
  } finally {
    restore.forEach(fn => fn());
  }
}

async function testChoiceAnswerMarkerConsumesPendingAndReroutes() {
  const restore = [
    replaceGlobal('window', global),
    replaceGlobal('localStorage', memoryStorage()),
    replaceGlobal('ChatUIAppJobWorkflow', jobWorkflow),
    replaceGlobal('ChatUIClarificationService', clarification),
    replaceGlobal('ChatUIRouteService', { cleanQuotedContent: value => String(value || ''), buildQuotedRouteContent: ({ text }) => text, isRouteDispatchable: () => true }),
  ];
  try {
    const fixture = makeFixture({ promptValue: '' });
    const answer = clarification.createClarificationAnswer({
      clarificationId: fixture.pending.id,
      answers: [{ resource_key: 'r1', choice_key: 'c2' }],
      freeText: '图片 B',
    });
    await fixture.workflow.onSubmit({
      preventDefault() {},
      __chatuiClarificationAnswer: answer,
      __chatuiClarificationId: fixture.pending.id,
    });

    assert.strictEqual(fixture.session.pendingClarification, undefined, 'a complete choice answer must consume the pending clarification');
    assert.strictEqual(fixture.routed.length, 1);
    assert.strictEqual(fixture.routed[0].input, BASE_TASK_TEXT);
    assert.ok(fixture.routed[0].routeContext?.clarification_context?.pending_task, 'the reroute must carry the answered pending task');
    assert.strictEqual(fixture.sent.length, 1);
  } finally {
    restore.forEach(fn => fn());
  }
}

async function testRelationNewTaskClearsPendingAndSubmitsCurrentPrompt() {
  const restore = [
    replaceGlobal('window', global),
    replaceGlobal('localStorage', memoryStorage()),
    replaceGlobal('ChatUIAppJobWorkflow', jobWorkflow),
    replaceGlobal('ChatUIClarificationService', clarification),
    replaceGlobal('ChatUIRouteService', { cleanQuotedContent: value => String(value || ''), buildQuotedRouteContent: ({ text }) => text, isRouteDispatchable: () => true }),
  ];
  try {
    const fixture = makeFixture({ promptValue: '帮我写一份周报' });
    const pendingWithRelation = clarification.createPendingRelationClarification(fixture.pending, { input: '帮我写一份周报', sourceMessageIndex: 1 });
    fixture.session.pendingClarification = pendingWithRelation;
    const answer = clarificationRelation.createRelationAnswer({
      clarificationId: pendingWithRelation.relationClarification.clarification_id,
      pendingId: pendingWithRelation.id,
      decision: 'new_task',
    });
    await fixture.workflow.onSubmit({
      preventDefault() {},
      __chatuiClarificationRelationAnswer: answer,
      __chatuiClarificationId: pendingWithRelation.relationClarification.clarification_id,
    });

    assert.strictEqual(fixture.session.pendingClarification, undefined, 'new_task must clear the pending clarification');
    assert.strictEqual(fixture.routed.length, 1);
    assert.strictEqual(fixture.routed[0].input, '帮我写一份周报', 'new_task must submit the current composer text');
    assert.strictEqual(fixture.sent.length, 1);
  } finally {
    restore.forEach(fn => fn());
  }
}

async function testRelationContinueReroutesBaseTaskAndConsumesPendingOnHandoff() {
  const restore = [
    replaceGlobal('window', global),
    replaceGlobal('localStorage', memoryStorage()),
    replaceGlobal('ChatUIAppJobWorkflow', jobWorkflow),
    replaceGlobal('ChatUIClarificationService', clarification),
    replaceGlobal('ChatUIRouteService', { cleanQuotedContent: value => String(value || ''), buildQuotedRouteContent: ({ text }) => text, isRouteDispatchable: () => true }),
  ];
  try {
    const fixture = makeFixture({ promptValue: '继续' });
    const pendingWithRelation = clarification.createPendingRelationClarification(fixture.pending, { input: '继续', sourceMessageIndex: 1 });
    fixture.session.pendingClarification = pendingWithRelation;
    const answer = clarificationRelation.createRelationAnswer({
      clarificationId: pendingWithRelation.relationClarification.clarification_id,
      pendingId: pendingWithRelation.id,
      decision: 'continue',
    });
    await fixture.workflow.onSubmit({
      preventDefault() {},
      __chatuiClarificationRelationAnswer: answer,
      __chatuiClarificationId: pendingWithRelation.relationClarification.clarification_id,
    });

    assert.strictEqual(fixture.session.pendingClarification, undefined, 'a successful continued task must consume pending clarification at durable handoff');
    assert.strictEqual(fixture.routed.length, 1);
    assert.strictEqual(fixture.routed[0].input, BASE_TASK_TEXT, 'continue must reroute the base task');
    assert.strictEqual(fixture.sent.length, 1);
  } finally {
    restore.forEach(fn => fn());
  }
}

module.exports = [
  testTextAnswerAppliesPendingAndReroutesTheBaseTask,
  testChoiceAnswerMarkerConsumesPendingAndReroutes,
  testRelationNewTaskClearsPendingAndSubmitsCurrentPrompt,
  testRelationContinueReroutesBaseTaskAndConsumesPendingOnHandoff,
];
