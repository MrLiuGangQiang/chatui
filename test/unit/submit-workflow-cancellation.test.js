'use strict';

const assert = require('assert');
const jobWorkflow = require('../../client/app/job-workflow');
const submitWorkflow = require('../../client/app/submit-workflow');
const taskState = require('../../client/core/task-state');

function memoryStorage() {
  const values = new Map();
  return {
    getItem(key) { return values.get(key) || null; },
    setItem(key, value) { values.set(key, String(value)); },
    removeItem(key) { values.delete(key); },
  };
}

function replaceGlobal(key, value) {
  const previous = globalThis[key];
  if (value === undefined) delete globalThis[key];
  else globalThis[key] = value;
  return () => {
    if (previous === undefined) delete globalThis[key];
    else globalThis[key] = previous;
  };
}

async function testCancellationBeforeClarificationCommitProducesOnlyStoppedTerminalState() {
  const session = { id: 'session-cancel-route', messages: [], display: [] };
  const state = {
    activeSessionId: session.id,
    sessions: [session],
    messages: session.messages,
    attachments: [],
    disposedSessionIds: new Set(),
    promptDrafts: new Map(),
    autoMode: true,
    mode: 'chat',
    editingIndex: null,
    editingNode: null,
  };
  const prompt = { value: 'ambiguous request', focus() {} };
  const run = { token: 'run-cancel-route', stopped: false, abortController: new AbortController() };
  const events = [];
  const restore = [
    replaceGlobal('window', globalThis),
    replaceGlobal('localStorage', memoryStorage()),
    replaceGlobal('ChatUIAppJobWorkflow', jobWorkflow),
    replaceGlobal('ChatUIRouteService', {
      cleanQuotedContent: value => String(value || ''),
      buildQuotedRouteContent: ({ text }) => String(text || ''),
      isRouteDispatchable: () => false,
    }),
  ];

  try {
    const workflow = submitWorkflow.createSubmitWorkflow({
      state,
      taskEvents: taskState.TASK_EVENTS,
      dispatchTaskEvent: (_sessionId, event) => events.push(event),
      $: id => id === 'prompt' ? prompt : { querySelectorAll: () => [] },
      isSessionBusy: () => false,
      stopActiveRun: async () => {},
      toast: () => {},
      hasPendingUploads: () => false,
      updateSendAvailability: () => {},
      unlockDoneSound: () => {},
      saveConfig: () => {},
      ensureActiveRun: () => run,
      prepareUserAttachmentPreviews: async () => {},
      prepareChatImageAttachments: async files => files,
      buildUploadedImageContext: async () => null,
      buildUserAttachmentContext: async () => null,
      renderUserMessageWithAttachments: text => text,
      buildUserMessageContent: text => text,
      buildUserApiContent: text => text,
      addMessage: () => ({ dataset: {}, isConnected: false }),
      appendSessionDisplayMessage: (_sessionId, role, content, options = {}) => {
        const item = { id: `display-${session.display.length + 1}`, role, content, ...options };
        session.display.push(item);
        return item;
      },
      persistSessionDisplay: () => {},
      cloneMessageList: list => list.map(item => ({ ...item })),
      getActiveSession: () => session,
      saveChatHistory: async () => {},
      saveSessionMessages: async () => {},
      clearAttachments: () => {},
      clearQuotedMessage: () => {},
      getQuotedMessage: () => null,
      scheduleAutoResize: () => {},
      setSessionBusy: () => {},
      prepareReplacementResponse: () => null,
      pendingFeedbackHtml: text => text,
      hasImageAttachments: () => false,
      normalizeRoute: value => value,
      getEffectiveRoute: async () => {
        run.stopped = true;
        run.abortController.abort();
        return {
          mode: 'chat', api: 'clarify', intent: 'clarify', target: 'none',
          operationType: 'plain_chat', operationApi: 'chat', operationMode: 'chat', relation: 'new',
          readiness: 'needs_clarification', needClarification: true, dispatchAuthorized: false,
          resources: [], executionResources: null, dispatchContract: null,
          clarificationQuestion: 'This clarification must not be committed after cancellation.',
          clarificationSlots: [], localClarification: true,
        };
      },
      createRouteRecognitionUi: () => ({ startSlowNotice() {}, stopSlowNotice() {}, showSlowNotice() {} }),
      updateModeUi: () => {},
      warnMissingModel: () => false,
      updateMessage: () => {},
      showRunError: () => { throw new Error('a cancelled route must not render an error'); },
      updateSessionDisplayItem: () => {},
      sendChat: async () => { throw new Error('cancelled work must not dispatch chat'); },
      sendImage: async () => { throw new Error('cancelled work must not dispatch images'); },
      getLatestUploadedImageContext: () => null,
      getUploadedImageContext: () => null,
      restoreImageAttachmentsFromContext: async () => [],
      restoreUserAttachmentsFromContext: async () => [],
      getConfig: () => ({ baseUrl: 'https://example.test/v1', apiKey: 'test-key', routeModel: 'route-model' }),
      getSessionRouteModel: () => 'route-model',
      quotedAttachmentTextFromContext: () => '',
      quotedFileCandidatesFromContext: () => [],
      clearActiveRun: () => {},
      finishSessionTask: () => {},
      resumeSessionJobs: () => {},
      makeClientChatJobId: () => 'chatjob-cancel-route',
      makeClientImageJobId: () => 'imgjob-cancel-route',
      saveChatJob: () => {},
      clearChatJob: () => {},
      findMessageNodeByDisplayItem: () => null,
      insertMessageNodeAtDisplayPosition: () => {},
      saveSessionsMeta: () => {},
      buildRouteContext: () => ({}),
      requestJson: async () => { throw new Error('unexpected direct route request'); },
    });

    await workflow.onSubmit({ preventDefault() {}, submitter: { id: 'sendBtn' } });

    assert.strictEqual(
      session.messages.some(message => message.role === 'assistant' && /must not be committed/.test(String(message.content || ''))),
      false,
      'a cancelled submission must not persist the route clarification',
    );
    assert.strictEqual(
      events.some(event => event.type === taskState.TASK_EVENTS.TASK_COMPLETED_COMMITTED),
      false,
      'cancelled work must never commit a completed terminal state',
    );
    assert.strictEqual(
      events.filter(event => event.type === taskState.TASK_EVENTS.TASK_STOPPED).length,
      1,
      'a cancelled submission must publish exactly one stopped terminal event',
    );
  } finally {
    restore.reverse().forEach(fn => fn());
  }
}

module.exports = [
  testCancellationBeforeClarificationCommitProducesOnlyStoppedTerminalState,
];
