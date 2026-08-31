'use strict';

const assert = require('assert');

const jobWorkflow = require('../../client/app/job-workflow');
const submitWorkflow = require('../../client/app/submit-workflow');
const taskState = require('../../client/core/task-state');
const { makeExecutionFixture } = require('../helpers/dispatch-contract-fixture');

const ORIGINAL_TEXT = '旧提示';
const EDITED_TEXT = '新的编辑提示';
const NEW_SEND_TEXT = '新发送提示';

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

function makeFixture({ editing = false, promptValue = NEW_SEND_TEXT } = {}) {
  const session = {
    id: 'session-edit-intent',
    messages: [{ role: 'user', content: ORIGINAL_TEXT, rawText: ORIGINAL_TEXT, messageIndex: '0', id: 'message-original', turnId: 'turn-original' }],
    display: [],
  };
  const state = {
    activeSessionId: session.id,
    sessions: [session],
    messages: session.messages.map(item => ({ ...item })),
    attachments: [],
    disposedSessionIds: new Set(),
    promptDrafts: new Map(),
    autoMode: true,
    mode: 'chat',
    editingIndex: editing ? 0 : null,
    editingNode: editing ? { dataset: { rawText: ORIGINAL_TEXT, messageIndex: '0' } } : null,
    editingQuoteContext: '',
  };
  const prompt = { value: promptValue, focus() {} };
  const run = { stopped: false, abortController: new AbortController() };
  const routed = [];
  const sent = [];
  const edits = [];
  const order = [];
  const events = [];
  const finalExecution = makeExecutionFixture({ operation: 'plain_chat', relation: 'new', prompt: promptValue });
  const finalRoute = {
    mode: 'chat', api: 'chat', needClarification: false, dispatchAuthorized: true, readiness: 'ready',
    operationType: 'plain_chat', operationApi: 'chat', operationMode: 'chat', relation: 'new',
    resources: [], imageRefs: [], fileRefs: [], messageRefs: [],
    selectedIndexes: [], selectedImageIndexes: [], selectedFileIndexes: [],
    selectedImageIds: [], selectedReferenceId: '', usePreviousImage: false,
    contextualImagePrompt: promptValue, editInstruction: '', evidence: 'dispatch_contract.v1',
    localClarification: false,
    executionResources: finalExecution.executionResources,
    dispatchContract: finalExecution.dispatchContract,
  };
  const workflow = submitWorkflow.createSubmitWorkflow({
    state,
    taskEvents: taskState.TASK_EVENTS,
    $: id => (id === 'prompt' ? prompt : { querySelectorAll: () => [] }),
    applyPendingEdit: (newText, options) => {
      edits.push({ newText, messageIndex: options.messageIndex });
      const index = Number(options.messageIndex);
      const updated = {
        role: 'user', content: newText, rawText: newText, messageIndex: String(index),
        id: 'message-edited', turnId: 'turn-edited', submissionId: options.submissionId,
      };
      state.messages[index] = updated;
      session.messages[index] = { ...updated };
      return { index, responseIndex: index + 1 };
    },
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
    replaceSessionMessages: async () => {},
    clearAttachments: () => {}, clearQuotedMessage: () => {}, getQuotedMessage: () => null,
    scheduleAutoResize: () => {}, setSessionBusy: () => {},
    prepareReplacementResponse: () => ({ node: { dataset: {}, isConnected: false }, liveItem: { id: 'display-edit-replacement' } }), pendingFeedbackHtml: text => text,
    hasImageAttachments: () => false, normalizeRoute: value => value,
    getEffectiveRoute: async (input, routeAttachments, _sessionId, _headers, routeContext, routeOptions) => {
      routed.push({ input, routeAttachments, routeContext, routeOptions });
      order.push(`route:${input}`);
      return finalRoute;
    },
    createRouteRecognitionUi: () => ({ startSlowNotice() {}, stopSlowNotice() {}, showSlowNotice() {} }),
    updateModeUi: () => {}, warnMissingModel: () => false,
    updateMessage: () => {}, showRunError: (_sessionId, error) => { throw error; }, updateSessionDisplayItem: () => {},
    sendChat: async (chatPrompt, files, _node, options) => {
      sent.push({ chatPrompt, files });
      order.push(`send:${chatPrompt}`);
      return options.onDurableHandoff();
    },
    sendImage: async () => {}, sendImageBatch: async () => {},
    getLatestUploadedImageContext: () => null, getUploadedImageContext: () => null,
    restoreImageAttachmentsFromContext: async () => [], restoreUserAttachmentsFromContext: async () => [],
    getConfig: () => ({ baseUrl: 'https://example.test/v1', apiKey: 'test-key', routeModel: 'route-model' }),
    getSessionRouteModel: () => 'route-model', quotedAttachmentTextFromContext: () => '', quotedFileCandidatesFromContext: () => [],
    clearActiveRun: () => {}, finishSessionTask: () => {}, dispatchTaskEvent: (_sessionId, event) => events.push(event), resumeSessionJobs: () => {},
    makeClientChatJobId: () => 'chatjob-edit-intent', makeClientImageJobId: () => 'imgjob-edit-intent', saveChatJob: () => {}, clearChatJob: () => {},
    shouldPrepareManagedChatJob: () => true, findMessageNodeByDisplayItem: () => null, insertMessageNodeAtDisplayPosition: () => {},
    saveSessionsMeta: () => {}, buildRouteContext: () => ({}),
    requestJson: async () => { throw new Error('an edited resend must never invoke an independent classifier outside the route recognizer'); },
  });
  return { workflow, state, session, routed, sent, edits, order, events, prompt };
}

async function testEditResendRunsIntentRecognitionBeforeExecution() {
  const restore = [
    replaceGlobal('window', global),
    replaceGlobal('localStorage', memoryStorage()),
    replaceGlobal('ChatUIAppJobWorkflow', jobWorkflow),
    replaceGlobal('ChatUIRouteService', { cleanQuotedContent: value => String(value || ''), buildQuotedRouteContent: ({ text }) => text, isRouteDispatchable: () => true }),
  ];
  try {
    const fixture = makeFixture({ editing: true, promptValue: EDITED_TEXT });
    await fixture.workflow.onSubmit({ preventDefault() {}, submitter: { id: 'sendBtn' } });

    assert.strictEqual(fixture.edits.length, 1, 'the submit pipeline must enter the edit-resend branch');
    assert.strictEqual(fixture.routed.length, 1, 'edit/resend must run intent recognition exactly once');
    assert.strictEqual(fixture.routed[0].input, EDITED_TEXT, 'intent recognition must receive the edited text');
    assert.strictEqual(fixture.sent.length, 1, 'the edited message must reach execution after routing');
    assert.ok(
      fixture.order.findIndex(entry => entry.startsWith('route:')) < fixture.order.findIndex(entry => entry.startsWith('send:')),
      'execution must wait for the routed intent result',
    );
    assert.strictEqual(fixture.state.editingIndex, null, 'the edit mode must be cleared after the resend');
  } finally {
    restore.forEach(fn => fn());
  }
}

async function testEditResendSharesNewSendIntentRecognitionPipeline() {
  const restore = [
    replaceGlobal('window', global),
    replaceGlobal('localStorage', memoryStorage()),
    replaceGlobal('ChatUIAppJobWorkflow', jobWorkflow),
    replaceGlobal('ChatUIRouteService', { cleanQuotedContent: value => String(value || ''), buildQuotedRouteContent: ({ text }) => text, isRouteDispatchable: () => true }),
  ];
  try {
    const newSend = makeFixture({ editing: false, promptValue: NEW_SEND_TEXT });
    await newSend.workflow.onSubmit({ preventDefault() {}, submitter: { id: 'sendBtn' } });

    const editResend = makeFixture({ editing: true, promptValue: EDITED_TEXT });
    await editResend.workflow.onSubmit({ preventDefault() {}, submitter: { id: 'sendBtn' } });

    for (const fixture of [newSend, editResend]) {
      assert.strictEqual(fixture.routed.length, 1, 'every send mode must route through intent recognition');
      assert.strictEqual(fixture.sent.length, 1);
      assert.ok(
        fixture.order.findIndex(entry => entry.startsWith('route:')) < fixture.order.findIndex(entry => entry.startsWith('send:')),
        'dispatch must only start after the routed intent result',
      );
    }
    assert.strictEqual(newSend.routed[0].input, NEW_SEND_TEXT);
    assert.strictEqual(editResend.routed[0].input, EDITED_TEXT);
    assert.strictEqual(newSend.sent[0].chatPrompt, NEW_SEND_TEXT);
    assert.strictEqual(editResend.sent[0].chatPrompt, EDITED_TEXT);
  } finally {
    restore.forEach(fn => fn());
  }
}

module.exports = [
  testEditResendRunsIntentRecognitionBeforeExecution,
  testEditResendSharesNewSendIntentRecognitionPipeline,
];



