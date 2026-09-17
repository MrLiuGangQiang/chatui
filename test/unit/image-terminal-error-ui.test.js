'use strict';

const assert = require('assert');

const imageWorkflow = require('../../client/app/image-workflow');
const routeService = require('../../client/services/route-service');

function createFixture({ throwOnErrorProjection = false } = {}) {
  const session = {
    id: 'session-terminal-image',
    messages: [{
      role: 'user',
      content: 'draw a terminal image',
      rawText: 'draw a terminal image',
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
    id: 'display-terminal-image',
    role: 'assistant',
    pending: '1',
    responseIndex: '1',
    rawText: '正在生成图片',
  };
  session.display.push(liveItem);
  const route = routeService.createExplicitTextToImageRoute('draw a terminal image');
  const updates = [];
  const noop = () => {};
  let clearedJobs = 0;

  function updateSessionDisplayItem(_sessionId, item, role, content, options = {}) {
    if (throwOnErrorProjection && role === 'error') throw new Error('display projection failed');
    item.role = role;
    item.rawText = options.rawText ?? String(content || '');
    if (options.pending !== undefined) item.pending = options.pending ? '1' : '';
    if (options.responseIndex !== undefined) item.responseIndex = String(options.responseIndex);
  }

  const workflow = imageWorkflow.createImageWorkflow({
    state,
    getConfig: () => ({ baseUrl: 'https://api.example.test/v1', imageModel: 'image-model', imageSize: 'auto' }),
    ensureActiveRun: () => ({ stopped: false, token: 'run-terminal', abortController: new AbortController() }),
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
    makeClientImageJobId: () => 'imgjob-terminal-image',
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
    startImageGenerationJob: async () => ({ id: 'imgjob-terminal-image' }),
    waitImageGenerationJob: async () => {
      const error = new Error('上游请求过于频繁或额度已用尽（HTTP 429），请稍后重试或检查账户额度');
      error.name = 'JobTerminalError';
      error.terminalJob = true;
      throw error;
    },
    formatElapsed: () => '1.0s',
    jobDurationMs: () => 1000,
    shouldFollowScroll: () => false,
    setInterval: () => 1,
    clearInterval: noop,
    performance: { now: () => 100 },
    addActiveRunJob: noop,
    imageResultToHtml: async () => {
      throw new Error('a terminal upstream failure must never materialize an image result');
    },
  });

  return {
    workflow, session, liveItem, updates,
    clearedJobs: () => clearedJobs,
  };
}

function sendTerminalImage(workflow, liveItem, session) {
  const route = routeService.createExplicitTextToImageRoute('draw a terminal image');
  return workflow.sendImage('draw a terminal image', {
    liveItem,
    loadingNode: { isConnected: false, dataset: {} },
    sessionId: session.id,
    userAlreadyAdded: true,
    dispatchContract: route.dispatchContract,
    executionMedia: route.executionResources,
    originalPrompt: 'draw a terminal image',
    clientJobId: 'imgjob-terminal-image',
    submissionId: 'image-terminal',
  });
}

async function testTerminalImageJobErrorEndsPendingCardAndClearsDurableJob() {
  const fixture = createFixture();
  await assert.rejects(
    sendTerminalImage(fixture.workflow, fixture.liveItem, fixture.session),
    error => error?.terminalJob === true && /HTTP 429/.test(error.message || ''),
  );

  assert.strictEqual(fixture.clearedJobs(), 1, 'a terminal image failure must clear its durable job snapshot');
  assert.strictEqual(fixture.liveItem.pending, '', 'a terminal image failure must end the pending card');
  assert.strictEqual(fixture.liveItem.role, 'error');
  assert.match(fixture.liveItem.rawText, /HTTP 429/);
  assert.strictEqual(fixture.updates.at(-1)?.role, 'error');
  assert.strictEqual(fixture.updates.at(-1)?.pending, false);
}

async function testTerminalImageJobErrorStillRejectsWhenErrorProjectionThrows() {
  const fixture = createFixture({ throwOnErrorProjection: true });
  await assert.rejects(
    sendTerminalImage(fixture.workflow, fixture.liveItem, fixture.session),
    error => error?.terminalJob === true && /HTTP 429/.test(error.message || ''),
  );
  assert.strictEqual(fixture.clearedJobs(), 1, 'durable cleanup must survive an error projection failure');
}

module.exports = [
  testTerminalImageJobErrorEndsPendingCardAndClearsDurableJob,
  testTerminalImageJobErrorStillRejectsWhenErrorProjectionThrows,
];
