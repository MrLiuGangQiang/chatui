'use strict';

const assert = require('assert');

const clarification = require('../../client/services/clarification-service');
const jobWorkflow = require('../../client/app/job-workflow');
const submitWorkflow = require('../../client/app/submit-workflow');
const imageRouteContext = require('../../client/core/image-route-context');
const clarificationPresentation = require('../../client/features/clarification/presentation');

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
    const pendingRouteInfo = {
      mode: 'chat', api: 'clarify', readiness: 'needs_clarification', needClarification: true,
      clarificationQuestion,
      taskContract: {
        schema_version: 'task_contract.v5', readiness: 'needs_clarification', operation: 'file_qa', relation: 'followup',
        resources: [{ key: 'r1', type: 'file', source: 'history', role: 'attachment', index: 1, id: workbook.attachmentId, reference_id: '', missing: false }],
        directive: { mode: 'patch', base_resource_keys: ['r1'], unmentioned_policy: 'preserve', operations: [], constraints: [] },
        clarification: { question: clarificationQuestion, unresolved_resources: [{ key: 'r2', type: 'text', role: 'source', reason: 'missing', choices: [] }] },
        confidence: 0.99, review_reasons: [], rationale: 'the workbook is required for the estimate',
      },
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
    const finalRoute = {
      mode: 'chat', api: 'chat', needClarification: false,
      executionResources: {
        version: 'execution_resources.v1', operation: 'file_qa', images: [],
        files: [{ key: 'r1', type: 'file', source: 'current', role: 'attachment', index: 1, id: workbook.attachmentId, reference_id: '', missing: false, identity_aliases: [], index_aliases: [] }],
      },
      taskContract: {
        schema_version: 'task_contract.v5', readiness: 'ready', operation: 'file_qa', relation: 'continuation',
        resources: [{ key: 'r1', type: 'file', source: 'current', role: 'attachment', index: 1, id: workbook.attachmentId, reference_id: '', missing: false }],
        directive: { mode: 'standalone', base_resource_keys: [], unmentioned_policy: 'allow_change', operations: [], constraints: [] },
        clarification: { question: '', unresolved_resources: [] }, confidence: 0.99, review_reasons: [], rationale: 'the restored workbook is selected',
      },
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
      getEffectiveRoute: async (_input, routeAttachments) => {
        routed.push(routeAttachments);
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
      requestJson: async () => ({ choices: [{ message: { content: JSON.stringify({
        schema_version: clarification.CONTINUATION_SCHEMA_VERSION, relation: 'pending_answer', confidence: 0.99,
        resolved_input: 'Estimate all low-code-suitable functions in person-days.', selections: [], assistant_reply: '', reason: 'the estimate unit is explicit',
      }) } }] }),
    });

    await workflow.onSubmit({ preventDefault() {}, submitter: { id: 'sendBtn' } });

    assert.strictEqual(restored.length, 1);
    assert.strictEqual(restored[0].attachments[0].id, workbook.attachmentId);
    assert.deepStrictEqual(routed[0].map(item => item.attachmentId), [workbook.attachmentId]);
    assert.deepStrictEqual(sent[0].map(item => item.attachmentId), [workbook.attachmentId]);
    assert.strictEqual(session.pendingClarification, undefined, 'the old pending record is consumed only after the workbook-backed handoff');
  } finally {
    restoreGlobalState.reverse().forEach(restore => restore());
  }
}

async function testPendingAssistancePersistsAndDisplaysCandidateImageCards() {
  const restoreGlobalState = [
    replaceGlobal('window', global),
    replaceGlobal('localStorage', memoryStorage()),
    replaceGlobal('ChatUIAppJobWorkflow', jobWorkflow),
    replaceGlobal('ChatUIClarificationService', clarification),
    replaceGlobal('ChatUIRouteService', {
      cleanQuotedContent: value => String(value || ''),
      buildQuotedRouteContent: ({ text }) => text,
      isRouteDispatchable: () => false,
    }),
    replaceGlobal('ChatUIApp', {
      appContext: {
        getWorkflowModule: name => name === 'clarificationPresentation' ? clarificationPresentation : null,
      },
    }),
  ];
  try {
    const generatedMessages = [
      { role: 'user', content: '画一只猫', rawText: '画一只猫', messageIndex: 0 },
      {
        role: 'assistant', content: '[图片生成完成] 画一只猫', rawText: '[图片生成完成] 画一只猫', responseIndex: 1,
        imageContext: JSON.stringify({ attachments: [{ src: 'indexeddb://cat-original', name: 'original.png' }] }),
      },
      { role: 'user', content: '猫的品种换成波斯猫', rawText: '猫的品种换成波斯猫', messageIndex: 2 },
      {
        role: 'assistant', content: '[图片编辑完成] 猫的品种换成波斯猫', rawText: '[图片编辑完成] 猫的品种换成波斯猫', responseIndex: 3,
        imageContext: JSON.stringify({ attachments: [{ src: 'indexeddb://cat-persian', name: 'persian.png' }] }),
      },
    ];
    const choices = imageRouteContext.collectRecentImageReferences({ messages: generatedMessages, limit: 10 })
      .map((reference, index) => ({
        key: `c${index + 1}`,
        source: 'history',
        index: index + 1,
        id: reference.candidates[0].image_id,
        reference_id: reference.reference_id,
        label: reference.candidates[0].filename,
      }));
    const clarificationQuestion = '请确认要替换成哪一张你生成的猫：波斯猫图片，还是最初生成的猫图片？';
    const recoveredRoute = {
      mode: 'chat', api: 'clarify', readiness: 'needs_clarification', needClarification: true,
      clarificationQuestion,
      clarificationSlots: [{ key: 'r2', type: 'image', role: 'reference', reason: 'ambiguous', choices }],
      taskContract: null,
      clarificationDegraded: true,
      requiresRerouteAfterClarification: true,
    };
    const messages = [
      ...generatedMessages,
      { role: 'user', content: '不是这只猫，替换成你生成的猫', rawText: '不是这只猫，替换成你生成的猫', messageIndex: 4 },
      { role: 'assistant', content: clarificationQuestion, rawText: clarificationQuestion, responseIndex: 5 },
    ];
    const pending = clarification.createPendingClarification({
      messages,
      clarificationText: clarificationQuestion,
      routeInfo: {
        mode: 'chat', api: 'clarify', readiness: 'needs_clarification', needClarification: true,
        clarificationQuestion,
        // Reproduce the already-persisted broken pending record from the real
        // trace: its executable contract and candidate slots were both lost.
        clarificationSlots: [],
        taskContract: null,
        clarificationDegraded: true,
        requiresRerouteAfterClarification: true,
      },
    });
    const session = { id: 'session-images', messages: [...messages], display: [], pendingClarification: pending };
    const state = {
      activeSessionId: session.id, sessions: [session], messages: session.messages, attachments: [],
      disposedSessionIds: new Set(), promptDrafts: new Map(), autoMode: true, mode: 'chat', editingIndex: null, editingNode: null,
    };
    const prompt = { value: '你给我看看，我直接选择', focus() {} };
    const run = { stopped: false, abortController: new AbortController() };
    const displayUpdates = [];
    const classifierInputs = [];
    let routeCalls = 0;
    const assistantReply = '可以，我会把两张候选猫图片展示给你。请回复你要选择的那一张。';
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
      updateSessionDisplayItem: (_sessionId, item, role, content, options = {}) => {
        item.role = role;
        item.content = content;
        item.rawText = options.rawText;
        item.html = options.html ? content : '';
        item.pending = options.pending ? '1' : '';
        item.clarificationId = options.clarificationId || item.clarificationId || '';
        displayUpdates.push({ content, options: { ...options } });
      },
      persistSessionDisplay: () => {}, cloneMessageList: list => list.map(item => ({ ...item })),
      getActiveSession: () => session, saveChatHistory: async () => {}, saveSessionMessages: async () => {},
      clearAttachments: () => {}, clearQuotedMessage: () => {}, getQuotedMessage: () => null,
      scheduleAutoResize: () => {}, setSessionBusy: () => {},
      prepareReplacementResponse: () => null, pendingFeedbackHtml: text => text,
      hasImageAttachments: () => false, normalizeRoute: value => value,
      getEffectiveRoute: async input => {
        routeCalls += 1;
        assert.strictEqual(input, '不是这只猫，替换成你生成的猫');
        return recoveredRoute;
      },
      createRouteRecognitionUi: () => ({ startSlowNotice() {}, stopSlowNotice() {}, showSlowNotice() {} }),
      updateModeUi: () => {}, warnMissingModel: () => false,
      updateMessage: () => {}, showRunError: (_sessionId, error) => { throw error; },
      sendChat: async () => {}, sendImage: async () => {},
      getLatestUploadedImageContext: () => null, getUploadedImageContext: () => null,
      restoreImageAttachmentsFromContext: async () => [], restoreUserAttachmentsFromContext: async () => [],
      getConfig: () => ({ baseUrl: 'https://example.test/v1', apiKey: 'test-key', routeModel: 'route-model' }),
      getSessionRouteModel: () => 'route-model', quotedAttachmentTextFromContext: () => '', quotedFileCandidatesFromContext: () => [],
      clearActiveRun: () => {}, finishSessionTask: () => {}, dispatchTaskEvent: () => {}, resumeSessionJobs: () => {},
      makeClientChatJobId: () => 'chatjob-images', makeClientImageJobId: () => 'imgjob-images', saveChatJob: () => {}, clearChatJob: () => {},
      shouldPrepareManagedChatJob: () => true, findMessageNodeByDisplayItem: () => null, insertMessageNodeAtDisplayPosition: () => {},
      saveSessionsMeta: () => {}, buildRouteContext: () => ({ image_candidates: [] }),
      requestJson: async (_url, payload) => {
        classifierInputs.push(JSON.parse(payload.messages[1].content));
        return { choices: [{ message: { content: JSON.stringify({
          schema_version: clarification.CONTINUATION_SCHEMA_VERSION,
          relation: 'pending_assistance', confidence: 0.99,
          resolved_input: '', selections: [], assistant_reply: assistantReply,
          reason: 'the user asked to see the pending image candidates before choosing',
        }) } }] };
      },
    });

    await workflow.onSubmit({ preventDefault() {}, submitter: { id: 'sendBtn' } });

    assert.strictEqual(routeCalls, 1,
      'a legacy degraded pending without slots must reroute only to recover display choices, never to execute');
    assert.deepStrictEqual(classifierInputs[0].pending.unresolved_resources, [],
      'the recovery path must work for pending records created before choices were persisted');
    const finalUpdate = displayUpdates.at(-1);
    assert.ok(finalUpdate);
    assert.strictEqual(finalUpdate.options.html, true);
    assert.strictEqual(finalUpdate.options.rawText, assistantReply);
    assert.match(finalUpdate.content, /data-clarification-image-choices="1"/);
    assert.strictEqual((finalUpdate.content.match(/class="clarification-choice-card"/g) || []).length, 2);
    assert.strictEqual((finalUpdate.content.match(/class="clarification-choice-image"/g) || []).length, 2);
    assert.match(finalUpdate.content, /indexeddb:\/\/cat-persian/);
    assert.match(finalUpdate.content, /indexeddb:\/\/cat-original/);

    const assistantMessage = session.messages.at(-1);
    assert.strictEqual(assistantMessage.role, 'assistant');
    assert.strictEqual(assistantMessage.content, assistantReply, 'canonical model context must remain plain text');
    assert.strictEqual(assistantMessage.rawText, assistantReply);
    assert.match(assistantMessage.html, /clarification-image-list/);
    assert.strictEqual(assistantMessage.clarificationId, pending.id);
    assert.strictEqual(session.pendingClarification.id, pending.id, 'showing candidates must retain the same pending task identity');
    assert.deepStrictEqual(session.pendingClarification.routeInfo.clarificationSlots, recoveredRoute.clarificationSlots,
      'the recovered stable choices must be persisted for the next numbered answer');
    assert.strictEqual(session.pendingClarification.assistanceHistory.length, 1);
  } finally {
    restoreGlobalState.reverse().forEach(restore => restore());
  }
}

module.exports = [
  testClarificationHandoffRestoresTheOriginalWorkbookForRoutingAndChat,
  testPendingAssistancePersistsAndDisplaysCandidateImageCards,
];
