'use strict';

const assert = require('assert');
const routeIntentWorkflow = require('../../client/app/route-intent-workflow');
const submitWorkflow = require('../../client/app/submit-workflow');
const clarification = require('../../shared/clarification-answer');
const jobWorkflow = require('../../client/app/job-workflow');
const taskState = require('../../client/core/task-state');

function replaceGlobal(key, value) {
  const previous = globalThis[key];
  if (value === undefined) delete globalThis[key];
  else globalThis[key] = value;
  return () => {
    if (previous === undefined) delete globalThis[key];
    else globalThis[key] = previous;
  };
}

function memoryStorage() {
  const values = new Map();
  return {
    getItem(key) { return values.get(key) || null; },
    setItem(key, value) { values.set(key, String(value)); },
    removeItem(key) { values.delete(key); },
  };
}

function readyRoute() {
  return {
    mode: 'chat', api: 'chat', target: 'none', intent: 'plain_chat', relation: 'new',
    needClarification: false, dispatchAuthorized: true, readiness: 'ready',
    operationType: 'plain_chat', operationApi: 'chat', operationMode: 'chat',
  };
}

function routeServiceFor(textToRoute = () => readyRoute()) {
  return {
    buildRoutePayload: ({ model }) => ({ model, messages: [], response_format: { type: 'json_schema' } }),
    extractRouteText: response => String(response?.text || ''),
    inspectModelRouteResult: text => ({ route: textToRoute(text) }),
  };
}

function makeRouteWorkflow({ requestJson, primaryModel = 'route-model', routeService = routeServiceFor() } = {}) {
  const restore = replaceGlobal('ChatUIRouteService', routeService);
  const workflow = routeIntentWorkflow.createRouteIntentWorkflow({
    state: { mode: 'chat', autoMode: true, activeSessionId: 'session-outcome', sessions: [], messages: [] },
    getConfig: () => ({
      baseUrl: 'https://gateway.example/v1', apiKey: 'route-key',
      routeModel: primaryModel, chatModel: primaryModel,
    }),
    getSessionRouteModel: () => primaryModel,
    getSessionChatModel: () => primaryModel,
    buildRouteAttachmentMetadata: () => [],
    requestJson,
  });
  return { workflow, restore };
}

async function testRouteWorkflowPublishesTypedNonBusinessOutcomes() {
  {
    const { workflow, restore } = makeRouteWorkflow({ primaryModel: '' });
    try {
      const route = await workflow.getEffectiveRoute('hello', [], 'session-outcome');
      assert.strictEqual(route.outcome, 'configuration_error');
      assert.strictEqual(route.needClarification, false);
      assert.strictEqual(route.readiness, 'failed');
    } finally { restore(); }
  }

  {
    const { workflow, restore } = makeRouteWorkflow({
      requestJson: async () => {
        const error = new Error('network unavailable');
        error.code = 'NETWORK_REQUEST_FAILED';
        throw error;
      },
    });
    try {
      const route = await workflow.getEffectiveRoute('hello', [], 'session-outcome');
      assert.strictEqual(route.outcome, 'transient_error');
      assert.strictEqual(route.needClarification, false);
    } finally { restore(); }
  }

  {
    const { workflow, restore } = makeRouteWorkflow({
      requestJson: async () => ({ text: 'invalid' }),
      routeService: routeServiceFor(text => text === 'invalid' ? null : readyRoute()),
    });
    try {
      const route = await workflow.getEffectiveRoute('hello', [], 'session-outcome');
      assert.strictEqual(route.outcome, 'invalid_model_output');
      assert.strictEqual(route.needClarification, false);
    } finally { restore(); }
  }
}

async function testRouteWorkflowInfersReadyAndBusinessClarificationOutcomes() {
  const business = {
    ...readyRoute(),
    api: 'clarify', intent: 'clarify', needClarification: true,
    dispatchAuthorized: false, readiness: 'needs_clarification',
    clarificationQuestion: '请选择目标图片。', clarificationSlots: [],
  };
  const responses = ['ready', 'business'];
  const { workflow, restore } = makeRouteWorkflow({
    requestJson: async () => ({ text: responses.shift() }),
    routeService: routeServiceFor(text => text === 'business' ? business : readyRoute()),
  });
  try {
    const ready = await workflow.getEffectiveRoute('hello', [], 'session-outcome');
    const clarificationRoute = await workflow.getEffectiveRoute('edit it', [], 'session-outcome');
    assert.strictEqual(ready.outcome, 'ready');
    assert.strictEqual(clarificationRoute.outcome, 'business_clarification');
  } finally { restore(); }
}

function createSubmitFixture(routeInfo) {
  const session = { id: 'session-outcome', messages: [], display: [] };
  const state = {
    activeSessionId: session.id, sessions: [session], messages: [], attachments: [],
    disposedSessionIds: new Set(), promptDrafts: new Map(), autoMode: true, mode: 'chat',
    editingIndex: null, editingNode: null,
  };
  const prompt = { value: 'hello', focus() {} };
  const run = { stopped: false, abortController: new AbortController() };
  const events = [];
  const sent = [];
  const workflow = submitWorkflow.createSubmitWorkflow({
    state,
    taskEvents: taskState.TASK_EVENTS,
    $: id => id === 'prompt' ? prompt : { querySelectorAll: () => [] },
    isSessionBusy: () => false, stopActiveRun: async () => {}, toast: () => {}, hasPendingUploads: () => false,
    updateSendAvailability: () => {}, unlockDoneSound: () => {}, saveConfig: () => {},
    ensureActiveRun: () => run, prepareUserAttachmentPreviews: async () => {}, prepareChatImageAttachments: async files => files,
    buildUploadedImageContext: async () => null, buildUserAttachmentContext: async () => null,
    renderUserMessageWithAttachments: text => text, buildUserMessageContent: text => text, buildUserApiContent: text => text,
    addMessage: () => ({ dataset: {}, isConnected: false }),
    appendSessionDisplayMessage: (_sessionId, role, content, options = {}) => {
      const item = { id: `display-${session.display.length + 1}`, role, content, ...options };
      session.display.push(item);
      return item;
    },
    updateSessionDisplayItem: (_sessionId, item, role, content, options = {}) => Object.assign(item, { role, content, ...options }),
    persistSessionDisplay: () => {}, cloneMessageList: list => list.map(item => ({ ...item })),
    getActiveSession: () => session, saveChatHistory: async () => {}, saveSessionMessages: async () => {},
    clearAttachments: () => {}, clearQuotedMessage: () => {}, getQuotedMessage: () => null,
    scheduleAutoResize: () => {}, setSessionBusy: () => {}, prepareReplacementResponse: () => null,
    pendingFeedbackHtml: text => text, hasImageAttachments: () => false, normalizeRoute: value => value,
    getEffectiveRoute: async () => routeInfo,
    createRouteRecognitionUi: () => ({ startSlowNotice() {}, stopSlowNotice() {}, showSlowNotice() {} }),
    updateModeUi: () => {}, warnMissingModel: () => false, updateMessage: () => {},
    showRunError: () => { throw new Error('typed route outcomes must not fall into generic exception presentation'); },
    sendChat: async () => { sent.push('chat'); }, sendImage: async () => { sent.push('image'); },
    getLatestUploadedImageContext: () => null, getUploadedImageContext: () => null,
    restoreImageAttachmentsFromContext: async () => [], restoreUserAttachmentsFromContext: async () => [],
    getConfig: () => ({ baseUrl: 'https://example.test/v1', apiKey: 'test-key', routeModel: 'route-model' }),
    getSessionRouteModel: () => 'route-model', quotedAttachmentTextFromContext: () => '', quotedFileCandidatesFromContext: () => [],
    clearActiveRun: () => {}, finishSessionTask: () => {},
    dispatchTaskEvent: (_sessionId, event) => events.push(event), resumeSessionJobs: () => {},
    makeClientChatJobId: () => 'chatjob-outcome', makeClientImageJobId: () => 'imgjob-outcome',
    saveChatJob: () => {}, clearChatJob: () => {}, shouldPrepareManagedChatJob: () => true,
    findMessageNodeByDisplayItem: () => null, insertMessageNodeAtDisplayPosition: () => {},
    saveSessionsMeta: () => {}, buildRouteContext: () => ({}), requestJson: async () => ({}),
  });
  return { workflow, session, events, sent };
}

async function testNonBusinessRouteOutcomeRendersWithoutCreatingPendingClarification() {
  const restore = [
    replaceGlobal('window', globalThis),
    replaceGlobal('localStorage', memoryStorage()),
    replaceGlobal('ChatUIAppJobWorkflow', jobWorkflow),
    replaceGlobal('ChatUIClarificationService', clarification),
    replaceGlobal('ChatUIRouteService', { cleanQuotedContent: value => String(value || ''), buildQuotedRouteContent: ({ text }) => text, isRouteDispatchable: () => false }),
  ];
  try {
    const message = '本次未执行：无法连接意图模型服务。请检查 Endpoint 和网络连接。';
    const fixture = createSubmitFixture({
      ...readyRoute(),
      outcome: 'transient_error', outcomeMessage: message, evidence: 'route_model_network_error',
      api: 'clarify', intent: 'clarify', needClarification: true,
      dispatchAuthorized: false, readiness: 'needs_clarification',
      clarificationQuestion: message, clarificationSlots: [],
    });
    await fixture.workflow.onSubmit({ preventDefault() {}, submitter: { id: 'sendBtn' } });

    assert.strictEqual(fixture.session.pendingClarification, undefined,
      'network/config/model failures must never create business clarification state');
    assert.strictEqual(fixture.sent.length, 0);
    assert.ok(fixture.session.messages.some(item => item.role === 'assistant' && item.content === message));
    assert.strictEqual(fixture.events.filter(event => event.type === taskState.TASK_EVENTS.TASK_FAILED).length, 1,
      'a typed routing failure must terminate the task as failed');
    assert.strictEqual(fixture.events.some(event => event.type === taskState.TASK_EVENTS.TASK_COMPLETED_COMMITTED), false);
  } finally {
    restore.forEach(fn => fn());
  }
}

module.exports = [
  testRouteWorkflowPublishesTypedNonBusinessOutcomes,
  testRouteWorkflowInfersReadyAndBusinessClarificationOutcomes,
  testNonBusinessRouteOutcomeRendersWithoutCreatingPendingClarification,
];
