'use strict';

const assert = require('assert');

const imageGenerationService = require('../../client/services/image-generation-service');
const imageWorkflow = require('../../client/app/image-workflow');
const routeService = require('../../client/services/route-service');

async function testRejectedImageDispatchClearsDurableJobAndPendingProjection() {
  const session = {
    id: 'session-rejected-image',
    messages: [{
      role: 'user',
      content: 'draw a rejected image',
      rawText: 'draw a rejected image',
      messageIndex: '0',
    }],
    display: [],
  };
  const state = {
    activeSessionId: session.id,
    sessions: [session],
    messages: session.messages.map(message => ({ ...message })),
    followingImageJobs: new Set(),
    lastGeneratedImage: null,
  };
  const liveItem = {
    id: 'display-rejected-image',
    role: 'assistant',
    pending: '1',
    responseIndex: '1',
    rawText: '正在生成图片',
  };
  session.display.push(liveItem);
  const route = routeService.createExplicitTextToImageRoute('draw a rejected image');
  const updates = [];
  let clearedJobs = 0;
  const noop = () => {};

  function updateSessionDisplayItem(_sessionId, item, role, content, options = {}) {
    item.role = role;
    item.rawText = options.rawText ?? String(content || '');
    if (options.pending !== undefined) item.pending = options.pending ? '1' : '';
    if (options.responseIndex !== undefined) item.responseIndex = String(options.responseIndex);
  }

  const workflow = imageWorkflow.createImageWorkflow({
    state,
    getConfig: () => ({ baseUrl: 'https://api.example.test/v1', imageModel: 'image-model', imageSize: 'auto' }),
    ensureActiveRun: () => ({ stopped: false, token: 'run-rejected', abortController: new AbortController() }),
    setActiveOutputForSession: noop,
    persistSessionDisplay: noop,
    clearReasoning: noop,
    clearPendingFeedback: noop,
    buildImagePromptWithStylePrompt: prompt => prompt,
    getEffectiveImageStylePrompt: () => '',
    persistImageAttachmentRefs: async attachments => attachments,
    imageFilesToJobPayload: async () => [],
    restoreImageAttachmentsFromContext: async () => [],
    normalizeImageContextForStorage: value => value,
    makeImageItemId: (_referenceId, ordinal) => `image-${ordinal}`,
    makeClientImageJobId: () => 'imgjob-rejected-image',
    shouldSuppressRunUi: () => false,
    pendingFeedbackHtml: text => String(text || ''),
    renderImageBatchResult: (_context, options = {}) => String(options.slotStatuses?.[0] || ''),
    updateLiveDisplay: (sessionId, item, role, content, options) => {
      updates.push({ sessionId, role, content, pending: options?.pending });
      updateSessionDisplayItem(sessionId, item, role, content, options);
    },
    updateSessionDisplayItem,
    updateMessage: noop,
    setImageContext: noop,
    cloneMessageList: messages => (messages || []).map(message => ({ ...message })),
    saveSessionMessages: async (_sessionId, messages) => {
      session.messages = (messages || []).map(message => ({ ...message }));
      state.messages = session.messages.map(message => ({ ...message }));
    },
    reconcileSuccessfulImageResult: noop,
    playDoneSound: noop,
    saveImageJob: (_sessionId, job) => job,
    clearImageJob: () => { clearedJobs += 1; },
    startImageGenerationJob: async () => {
      const error = new Error('internal provider validation details must not reach the UI');
      error.statusCode = 400;
      error.code = 'IMAGE_ROLE_MAP_MISMATCH';
      throw error;
    },
    waitImageGenerationJob: async () => ({ status: 'completed' }),
    formatElapsed: () => '1.0s',
    jobDurationMs: () => 1000,
    shouldFollowScroll: () => false,
    setInterval: () => 1,
    clearInterval: noop,
    performance: { now: () => 100 },
    addActiveRunJob: noop,
    imageResultToHtml: async () => {
      throw new Error('a rejected dispatch must never materialize an image result');
    },
  });

  await assert.rejects(
    workflow.sendImage('draw a rejected image', {
      liveItem,
      loadingNode: { isConnected: false, dataset: {} },
      sessionId: session.id,
      userAlreadyAdded: true,
      dispatchContract: route.dispatchContract,
      executionMedia: route.executionResources,
      originalPrompt: 'draw a rejected image',
      clientJobId: 'imgjob-rejected-image',
      submissionId: 'image-edit-rejected',
    }),
    error => error?.statusCode === 400
      && error?.code === 'IMAGE_ROLE_MAP_MISMATCH'
      && error?.message === '图片用途信息不一致，请重新上传图片后再试'
      && error?.rawMessage.includes('internal provider'),
  );

  assert.strictEqual(clearedJobs, 1, 'a rejected dispatch must clear its stale durable image job');
  assert.strictEqual(liveItem.pending, '', 'a rejected dispatch must not leave a loading projection');
  assert.strictEqual(liveItem.role, 'error');
  assert.strictEqual(liveItem.rawText, '图片用途信息不一致，请重新上传图片后再试');
  assert.strictEqual(updates.at(-1)?.role, 'error');
  assert.strictEqual(updates.at(-1)?.pending, false);
}

module.exports = [
  testRejectedImageDispatchClearsDurableJobAndPendingProjection,
];
