'use strict';

const assert = require('assert');

const clarification = require('../../shared/clarification-answer');
const jobWorkflow = require('../../client/app/job-workflow');
const submitWorkflow = require('../../client/app/submit-workflow');
const { makeExecutionFixture } = require('../helpers/dispatch-contract-fixture');

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

async function testClarificationHandoffRestoresTheOriginalWorkbookForRoutingAndChat() {
  const restoreGlobalState = [
    replaceGlobal('window', global),
    replaceGlobal('localStorage', memoryStorage()),
    replaceGlobal('ChatUIAppJobWorkflow', jobWorkflow),
    replaceGlobal('ChatUIClarificationService', clarification),
    replaceGlobal('ChatUIRouteService', {
      cleanQuotedContent: value => String(value || ''),
      buildQuotedRouteContent: ({ text }) => text,
      isRouteDispatchable: () => true,
    }),
  ];
  try {
    const workbook = {
      attachmentId: 'workbook-low-code',
      name: 'low-code-scope.xlsx',
      type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
      size: 2048,
      inputFile: true,
      file: {
        name: 'low-code-scope.xlsx',
        type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
        size: 2048,
      },
    };
    const attachmentContext = JSON.stringify({
      attachments: [{
        id: workbook.attachmentId,
        name: workbook.name,
        type: workbook.type,
        size: workbook.size,
        persistedSrc: 'indexeddb://attachment-file-workbook-low-code',
        inputFile: true,
      }],
    });
    const clarificationQuestion = 'Estimate in person-days, person-months, or project duration?';
    const workbookResource = {
      key: 'r1', type: 'file', source: 'history', role: 'attachment', index: 1,
      id: workbook.attachmentId, resource_id: 'res:file:workbook-low-code', reference_id: '',
      identity_aliases: ['res:file:workbook-low-code', workbook.attachmentId], index_aliases: [1], missing: false,
    };
    const pendingRouteInfo = {
      mode: 'chat', api: 'clarify', readiness: 'needs_clarification', needClarification: true,
      dispatchAuthorized: false, operationType: 'file_qa', operationApi: 'chat', operationMode: 'chat', relation: 'followup',
      resources: [workbookResource], executionResources: null, dispatchContract: null,
      clarificationQuestion,
      clarificationSlots: [{ key: 'r2', type: 'text', role: 'source', reason: 'missing', choices: [] }],
    };
    const messages = [
      { role: 'user', content: 'Analyze this spreadsheet.', rawText: 'Analyze this spreadsheet.', attachmentContext },
      { role: 'assistant', content: 'Initial analysis complete.', rawText: 'Initial analysis complete.' },
      { role: 'user', content: 'Estimate all low-code-suitable functions.', rawText: 'Estimate all low-code-suitable functions.' },
      { role: 'assistant', content: clarificationQuestion, rawText: clarificationQuestion },
    ];
    const pending = clarification.createPendingClarification({
      messages, clarificationText: clarificationQuestion, routeInfo: pendingRouteInfo,
    });
    const session = { id: 'session-a', messages: [...messages], display: [], pendingClarification: pending };
    const state = {
      activeSessionId: session.id, sessions: [session], messages: session.messages, attachments: [],
      disposedSessionIds: new Set(), promptDrafts: new Map(), autoMode: true, mode: 'chat', editingIndex: null, editingNode: null,
    };
    const prompt = { value: 'Use person-days.', focus() {} };
    const run = { stopped: false, abortController: new AbortController() };
    const routed = [];
    const sent = [];
    const restored = [];
    const finalExecution = makeExecutionFixture({
      operation: 'file_qa', relation: 'continuation', prompt: 'Use person-days.', resources: [workbookResource],
    });
    const finalRoute = {
      mode: 'chat', api: 'chat', needClarification: false, dispatchAuthorized: true, readiness: 'ready',
      operationType: 'file_qa', operationApi: 'chat', operationMode: 'chat', relation: 'continuation',
      resources: finalExecution.resources, imageRefs: [], fileRefs: [{ key: 'r1', role: 'attachment', file_id: workbook.attachmentId, resource_id: 'res:file:workbook-low-code', index: 1, source: 'history' }], messageRefs: [],
      selectedIndexes: [], selectedImageIndexes: [], selectedFileIndexes: [1], selectedImageIds: [], selectedReferenceId: '', usePreviousImage: false,
      contextualImagePrompt: 'Use person-days.', editInstruction: '', localClarification: false,
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
      sendChat: async (_prompt, files, _node, options) => { sent.push(files); options.onDurableHandoff(); },
      sendImage: async () => {}, getLatestUploadedImageContext: () => null, getUploadedImageContext: () => null,
      restoreImageAttachmentsFromContext: async () => [],
      restoreUserAttachmentsFromContext: async context => {
        restored.push(context);
        return [workbook];
      },
      getConfig: () => ({ baseUrl: 'https://example.test/v1', apiKey: 'test-key', routeModel: 'route-model' }),
      getSessionRouteModel: () => 'route-model', quotedAttachmentTextFromContext: () => '', quotedFileCandidatesFromContext: () => [],
      clearActiveRun: () => {}, finishSessionTask: () => {}, dispatchTaskEvent: () => {}, resumeSessionJobs: () => {},
      makeClientChatJobId: () => 'chatjob-a', makeClientImageJobId: () => 'imgjob-a', saveChatJob: () => {}, clearChatJob: () => {},
      shouldPrepareManagedChatJob: () => true, findMessageNodeByDisplayItem: () => null, insertMessageNodeAtDisplayPosition: () => {},
      saveSessionsMeta: () => {}, buildRouteContext: () => ({ file_candidates: [] }),
      requestJson: async () => { throw new Error('pending replies must not invoke an independent classifier'); },
    });

    await workflow.onSubmit({ preventDefault() {}, submitter: { id: 'sendBtn' } });

    assert.ok(restored.length >= 1);
    assert.ok(restored.every(context => context.attachments[0].id === workbook.attachmentId));
    assert.strictEqual(routed.length, 1);
    assert.strictEqual(routed[0].input, 'Use person-days.');
    assert.strictEqual(routed[0].routeContext.clarification_context.pending_task.base_input, 'Estimate all low-code-suitable functions.');
    assert.deepStrictEqual(routed[0].routeAttachments.map(item => [item.attachmentId, item.routeSource]), [[workbook.attachmentId, 'history']]);
    assert.strictEqual(routed[0].routeContext.clarification_context.schema_version, 'clarification_context.v4');
    assert.deepStrictEqual(sent[0].map(item => [item.attachmentId, item.routeSource]), [[workbook.attachmentId, 'history']]);
    assert.strictEqual(session.pendingClarification, undefined, 'the old pending record is consumed only after the workbook-backed handoff');
  } finally {
    restoreGlobalState.reverse().forEach(restore => restore());
  }
}

async function testPendingAssistanceUsesChatAndConsumesPendingOnHandoff() {
  const restoreGlobalState = [
    replaceGlobal('window', global),
    replaceGlobal('localStorage', memoryStorage()),
    replaceGlobal('ChatUIAppJobWorkflow', jobWorkflow),
    replaceGlobal('ChatUIClarificationService', clarification),
    replaceGlobal('ChatUIRouteService', {
      cleanQuotedContent: value => String(value || ''),
      buildQuotedRouteContent: ({ text }) => text,
      isRouteDispatchable: () => true,
    }),
  ];
  try {
    const baseTaskText = 'Replace the cat with the generated cat.';
    const clarificationQuestion = 'Which generated cat should replace it?';
    const assistanceText = 'Explain how I should choose.';
    const clarificationSlots = [{
      key: 'r1', type: 'image', role: 'reference', reason: 'ambiguous', choices: [
        { key: 'c1', source: 'history', index: 1, id: 'cat-a', resource_id: 'res:image:cat-a', reference_id: 'cat-a-ref', label: 'Cat A' },
        { key: 'c2', source: 'history', index: 2, id: 'cat-b', resource_id: 'res:image:cat-b', reference_id: 'cat-b-ref', label: 'Cat B' },
      ],
    }];
    const messages = [
      { role: 'user', content: baseTaskText, rawText: baseTaskText, messageIndex: 0 },
      { role: 'assistant', content: clarificationQuestion, rawText: clarificationQuestion, responseIndex: 1 },
    ];
    const pending = clarification.createPendingClarification({
      messages,
      clarificationText: clarificationQuestion,
      routeInfo: {
        mode: 'chat', api: 'clarify', readiness: 'needs_clarification', needClarification: true,
        dispatchAuthorized: false, operationType: 'edit_image', operationApi: 'image_edit', operationMode: 'edit_image', relation: 'followup',
        resources: [], executionResources: null, dispatchContract: null,
        clarificationQuestion, clarificationSlots,
      },
    });
    const session = { id: 'session-images', messages: [...messages], display: [], pendingClarification: pending };
    const state = {
      activeSessionId: session.id, sessions: [session], messages: session.messages, attachments: [],
      disposedSessionIds: new Set(), promptDrafts: new Map(), autoMode: true, mode: 'chat', editingIndex: null, editingNode: null,
    };
    const prompt = { value: assistanceText, focus() {} };
    const run = { stopped: false, abortController: new AbortController() };
    const routed = [];
    const sent = [];
    const assistanceExecution = makeExecutionFixture({
      operation: 'plain_chat', relation: 'followup', prompt: assistanceText,
    });
    const assistanceRoute = {
      mode: 'chat', api: 'chat', needClarification: false, dispatchAuthorized: true, readiness: 'ready',
      operationType: 'plain_chat', operationApi: 'chat', operationMode: 'chat', relation: 'followup',
      resources: [], imageRefs: [], fileRefs: [], messageRefs: [], selectedIndexes: [], selectedImageIndexes: [], selectedFileIndexes: [],
      selectedImageIds: [], selectedReferenceId: '', usePreviousImage: false, contextualImagePrompt: assistanceText, editInstruction: '', localClarification: false,
      executionResources: assistanceExecution.executionResources,
      dispatchContract: assistanceExecution.dispatchContract,
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
      appendSessionDisplayMessage: (_sessionId, role, content, options = {}) => ({ id: `display-${role}`, role, content, ...options }),
      persistSessionDisplay: () => {}, cloneMessageList: list => list.map(item => ({ ...item })),
      getActiveSession: () => session, saveChatHistory: async () => {}, saveSessionMessages: async () => {},
      clearAttachments: () => {}, clearQuotedMessage: () => {}, getQuotedMessage: () => null,
      scheduleAutoResize: () => {}, setSessionBusy: () => {},
      prepareReplacementResponse: () => null, pendingFeedbackHtml: text => text,
      hasImageAttachments: () => false, normalizeRoute: value => value,
      getEffectiveRoute: async (input, _attachments, _sessionId, _headers, routeContext) => {
        routed.push({ input, routeContext });
        return assistanceRoute;
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
      makeClientChatJobId: () => 'chatjob-images', makeClientImageJobId: () => 'imgjob-images', saveChatJob: () => {}, clearChatJob: () => {},
      shouldPrepareManagedChatJob: () => true, findMessageNodeByDisplayItem: () => null, insertMessageNodeAtDisplayPosition: () => {},
      saveSessionsMeta: () => {}, buildRouteContext: () => ({ image_candidates: [] }),
      requestJson: async () => { throw new Error('pending assistance must use the unified route result, not a classifier'); },
    });

    await workflow.onSubmit({ preventDefault() {}, submitter: { id: 'sendBtn' } });

    assert.strictEqual(routed.length, 1);
    assert.strictEqual(routed[0].input, assistanceText);
    assert.strictEqual(routed[0].routeContext.clarification_context.pending_task.base_input, baseTaskText);
    assert.strictEqual(routed[0].routeContext.clarification_context.schema_version, 'clarification_context.v4');
    assert.deepStrictEqual(sent, [{ chatPrompt: assistanceText, files: [] }]);
    assert.strictEqual(session.pendingClarification, undefined, 'a successful assistance handoff consumes the active pending task');
  } finally {
    restoreGlobalState.reverse().forEach(restore => restore());
  }
}
module.exports = [
  testClarificationHandoffRestoresTheOriginalWorkbookForRoutingAndChat,
  testPendingAssistanceUsesChatAndConsumesPendingOnHandoff,
];
