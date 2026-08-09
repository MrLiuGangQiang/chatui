
'use strict';

const assert = require('assert');
const jobWorkflow = require('../../client/app/job-workflow');
const routeIntentWorkflow = require('../../client/app/route-intent-workflow');
const routeService = require('../../client/services/route-service');
const submitWorkflow = require('../../client/app/submit-workflow');

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

async function testQuotedImageTimeoutBlocksExecutionWithoutLocalFallback() {
  const restoreGlobalState = [
    replaceGlobal('window', global),
    replaceGlobal('localStorage', memoryStorage()),
    replaceGlobal('ChatUIAppJobWorkflow', jobWorkflow),
    replaceGlobal('ChatUIRouteService', routeService),
  ];
  try {
    const quotedImage = {
      type: 'image/png',
      imageId: 'quoted-image-submit-timeout',
      resource_id: 'res:image:quoted-image-submit-timeout',
      referenceId: 'quoted-ref-submit-timeout',
      name: 'quoted.png',
      file: { type: 'image/png', name: 'quoted.png' },
    };
    const quotedMessage = {
      id: 'quoted-message-submit-timeout',
      role: 'assistant',
      content: '[图片消息]',
      imageContext: JSON.stringify({
        target: 'previous',
        referenceId: quotedImage.referenceId,
        attachments: [{
          type: quotedImage.type,
          image_id: quotedImage.imageId,
          resource_id: quotedImage.resource_id,
          reference_id: quotedImage.referenceId,
          name: quotedImage.name,
          persistedSrc: 'indexeddb://quoted-image-submit-timeout',
        }],
      }),
    };
    const session = { id: 'session-quoted-timeout-submit', messages: [], display: [] };
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
    const prompt = { value: '这个呢', focus() {} };
    const run = { stopped: false, abortController: new AbortController() };
    const sent = [];
    let requestAborted = false;
    let requestStarted = false;
    const routeWorkflow = routeIntentWorkflow.createRouteIntentWorkflow({
      state,
      getConfig: () => ({
        baseUrl: 'https://gateway.example/v1',
        apiKey: 'route-secret',
        routeModel: 'route-model',
        chatModel: 'route-model',
      }),
      getSessionRouteModel: () => 'route-model',
      getSessionChatModel: () => 'route-model',
      requestJson: (_url, _payload, _apiKey, options = {}) => new Promise((resolve, reject) => {
        requestStarted = true;
        const rejectAsAborted = () => {
          requestAborted = true;
          const error = new Error('aborted');
          error.name = 'AbortError';
          reject(error);
        };
        if (options.signal?.aborted) rejectAsAborted();
        else options.signal?.addEventListener?.('abort', rejectAsAborted, { once: true });
      }),
    });

    const workflow = submitWorkflow.createSubmitWorkflow({
      state,
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
      getQuotedMessage: () => quotedMessage,
      scheduleAutoResize: () => {},
      setSessionBusy: () => {},
      prepareReplacementResponse: () => null,
      pendingFeedbackHtml: text => text,
      hasImageAttachments: () => false,
      normalizeRoute: value => value,
      getEffectiveRoute: (input, attachments, sessionId, headers, context, options = {}) => (
        routeWorkflow.getEffectiveRoute(input, attachments, sessionId, headers, context, {
          ...options,
          deadlineMs: 5,
        })
      ),
      createRouteRecognitionUi: () => ({ startSlowNotice() {}, stopSlowNotice() {}, showSlowNotice() {} }),
      updateModeUi: () => {},
      warnMissingModel: () => false,
      updateMessage: () => {},
      showRunError: (_sessionId, error) => { throw error; },
      updateSessionDisplayItem: () => {},
      sendChat: async (chatPrompt, files, _node, options) => {
        sent.push({ chatPrompt, files, options });
        options.onDurableHandoff();
      },
      sendImage: async () => {},
      getLatestUploadedImageContext: () => null,
      getUploadedImageContext: () => null,
      getPreviousImageAttachments: async () => {
        throw new Error('the quoted image must not be restored through history');
      },
      restoreImageAttachmentsFromContext: async () => [quotedImage],
      restoreUserAttachmentsFromContext: async () => [],
      isImageFile: item => String(item?.type || item?.file?.type || '').startsWith('image/'),
      getConfig: () => ({ baseUrl: 'https://gateway.example/v1', apiKey: 'route-secret', routeModel: 'route-model' }),
      getSessionRouteModel: () => 'route-model',
      quotedAttachmentTextFromContext: () => '',
      quotedFileCandidatesFromContext: () => [],
      clearActiveRun: () => {},
      finishSessionTask: () => {},
      dispatchTaskEvent: () => {},
      resumeSessionJobs: () => {},
      makeClientChatJobId: () => 'chatjob-quoted-timeout',
      makeClientImageJobId: () => 'imgjob-quoted-timeout',
      saveChatJob: () => {},
      clearChatJob: () => {},
      findMessageNodeByDisplayItem: () => null,
      insertMessageNodeAtDisplayPosition: () => {},
      saveSessionsMeta: () => {},
      buildRouteContext: () => ({ image_candidates: [] }),
      requestJson: async () => { throw new Error('the route workflow owns intent requests'); },
    });

    await workflow.onSubmit({ preventDefault() {}, submitter: { id: 'sendBtn' } });

    assert.strictEqual(requestAborted || !requestStarted, true, 'the deadline must prevent a late provider attempt or abort an attempt already in flight');
    assert.strictEqual(sent.length, 0, 'a timeout must not dispatch chat through a local media fallback');
    const finalAssistant = [...state.messages].reverse().find(item => item.role === 'assistant');
    assert.ok(finalAssistant, 'the blocked route must still produce a visible terminal message');
    assert.match(finalAssistant.content, /意图识别超时/);
  } finally {
    restoreGlobalState.reverse().forEach(restore => restore());
  }
}

module.exports = [
  testQuotedImageTimeoutBlocksExecutionWithoutLocalFallback,
];
