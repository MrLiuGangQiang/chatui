'use strict';

const assert = require('assert');
const fs = require('fs');
const path = require('path');
const { JSDOM } = require('jsdom');

const displayItems = require('../../client/app/display-items');
const imageGenerationService = require('../../client/services/image-generation-service');
const imageWorkflow = require('../../client/app/image-workflow');
const routeService = require('../../client/services/route-service');

function messageOrder(container) {
  return [...container.querySelectorAll('.message')].map(node => node.id);
}

function createMessageNode(document, { id, role, index }) {
  const node = document.createElement('article');
  node.id = id;
  node.className = `message ${role}`;
  node.dataset[role === 'user' ? 'messageIndex' : 'responseIndex'] = String(index);
  const content = document.createElement('div');
  content.className = 'content';
  node.appendChild(content);
  return node;
}

async function testActiveImageCompletionKeepsInsertedCanonicalReplyBeforeTheShiftedNextTurn() {
  const dom = new JSDOM('<main id="messages"></main>');
  const document = dom.window.document;
  const container = document.getElementById('messages');
  const firstUser = createMessageNode(document, { id: 'first-user', role: 'user', index: 0 });
  const liveImage = createMessageNode(document, { id: 'live-image', role: 'assistant', index: 1 });
  const shiftedUser = createMessageNode(document, { id: 'shifted-user', role: 'user', index: 1 });
  const shiftedAssistant = createMessageNode(document, { id: 'shifted-assistant', role: 'assistant', index: 2 });
  container.append(firstUser, liveImage, shiftedUser, shiftedAssistant);

  // The canonical replacement slot was inserted at index 1. The live DOM still
  // has the old suffix indexes until reconciliation projects that insertion.
  const session = {
    id: 'session-image-position',
    messages: [
      { role: 'user', content: 'first question', messageIndex: '0' },
      { role: 'assistant', content: '', rawText: '', responseIndex: '1', replacing: true },
      { role: 'user', content: 'next question', messageIndex: '2' },
      { role: 'assistant', content: 'next answer', responseIndex: '3' },
    ],
    display: [],
  };
  const state = {
    activeSessionId: session.id,
    sessions: [session],
    messages: session.messages,
    followingImageJobs: new Set(),
    lastGeneratedImage: null,
  };
  const liveItem = {
    id: 'display-image-position',
    role: 'assistant',
    pending: '1',
    responseIndex: '1',
    rawText: 'pending image',
    jobId: '',
  };
  session.display.push(liveItem);
  liveImage.__displayItem = liveItem;
  liveImage.dataset.displayItemId = liveItem.id;

  function updateSessionDisplayItem(_sessionId, item, role, content, options = {}) {
    item.role = role;
    item.rawText = options.rawText ?? content;
    item.html = options.html ? String(content || '') : '';
    if (options.responseIndex !== undefined && options.responseIndex !== null) item.responseIndex = String(options.responseIndex);
    if (options.pending !== undefined) item.pending = options.pending ? '1' : '';
  }

  function updateMessage(node, content, options = {}) {
    if (options.responseIndex !== undefined && options.responseIndex !== null) node.dataset.responseIndex = String(options.responseIndex);
    const role = node.classList.contains('user') ? 'user' : 'assistant';
    const index = role === 'user' ? node.dataset.messageIndex : node.dataset.responseIndex;
    displayItems.reconcileCanonicalMessageNode(container, node, { role, index });
    node.querySelector('.content').innerHTML = String(content || '');
  }

  function updateLiveDisplay(sessionId, item, role, content, options = {}) {
    updateSessionDisplayItem(sessionId, item, role, content, options);
    const node = [...container.querySelectorAll('.message')].find(candidate => (
      candidate.__displayItem === item || candidate.dataset.displayItemId === item.id
    ));
    assert.ok(node, 'the active image result must retain a live node');
    displayItems.insertMessageNodeAtDisplayPosition(container, node, item);
    updateMessage(node, content, options);
  }

  const noop = () => {};
  const route = routeService.createExplicitTextToImageRoute('draw the first answer');
  const workflow = imageWorkflow.createImageWorkflow({
    state,
    window: {
      ChatUIServices: {
        images: {
          buildImageRequestPayload: ({ model, prompt }) => ({ model, prompt }),
          createImageContext: imageGenerationService.createImageContext,
          buildImageCompletionMessage: () => '[图片生成完成] draw the first answer',
        },
      },
    },
    getConfig: () => ({ baseUrl: 'https://api.example.test/v1', imageModel: 'image-model', imageSize: 'auto' }),
    ensureActiveRun: () => ({ stopped: false, token: 'run-image-position', abortController: new AbortController() }),
    setActiveOutputForSession: noop,
    getActiveSession: () => session,
    persistSessionDisplay: noop,
    clearReasoning: noop,
    clearPendingFeedback: noop,
    buildImagePromptWithStylePrompt: prompt => prompt,
    getEffectiveImageStylePrompt: () => '',
    buildRequestHeaders: () => ({}),
    persistImageAttachmentRefs: async attachments => attachments,
    normalizeImageContextForStorage: value => value,
    makeImageItemId: (_referenceId, ordinal) => `image-${ordinal}`,
    makeClientImageJobId: () => 'imgjob-position',
    shouldSuppressRunUi: () => false,
    pendingFeedbackHtml: text => text,
    updateLiveDisplay,
    shouldFollowScroll: () => false,
    setInterval: () => 1,
    clearInterval: noop,
    performance: { now: () => 100 },
    addActiveRunJob: noop,
    saveImageJob: (_sessionId, job) => job,
    clearImageJob: noop,
    startImageGenerationJob: async () => ({ id: 'imgjob-position', createdAt: 1 }),
    waitImageGenerationJob: async () => ({ status: 'completed' }),
    formatElapsed: () => '1.0s',
    jobDurationMs: () => 1000,
    imageResultToHtml: async () => ({
      html: '<div class="generated-image-grid"></div>',
      raw: 'image result',
      metaText: 'RT 1.0s',
      imageContext: { attachments: [] },
    }),
    updateSessionDisplayItem,
    updateMessage,
    setImageContext: noop,
    cloneMessageList: messages => messages.map(message => ({ ...message })),
    saveSessionMessages: async (_sessionId, messages) => {
      session.messages = messages.map(message => ({ ...message }));
      state.messages = session.messages;
    },
    reconcileSuccessfulImageResult: noop,
    playDoneSound: noop,
    mergeSelectedGeneratedImages: noop,
    normalizeLastGeneratedImage: value => value,
  });

  await workflow.sendImage('draw the first answer', {
    loadingNode: liveImage,
    liveItem,
    sessionId: session.id,
    userAlreadyAdded: true,
    replaceAssistantIndex: 1,
    taskContract: route.taskContract,
    executionMedia: route.executionResources,
    originalPrompt: 'draw the first answer',
    clientJobId: 'imgjob-position',
  });

  assert.deepStrictEqual(
    messageOrder(container),
    ['first-user', 'live-image', 'shifted-user', 'shifted-assistant'],
    'the live image must stay in the inserted canonical answer slot instead of moving below the next question',
  );
  assert.strictEqual(shiftedUser.dataset.messageIndex, '2');
  assert.strictEqual(shiftedAssistant.dataset.responseIndex, '3');
}

function testCanonicalInsertionOrderingIsCacheBusted() {
  const index = fs.readFileSync(path.join(__dirname, '../../index.html'), 'utf8');
  assert.ok(
    index.includes('client/app/display-items.js?v=1.2.71-canonical-insertion-order'),
    'the browser must load the canonical insertion reconciliation instead of a cached ordering implementation',
  );
}

module.exports = [
  testActiveImageCompletionKeepsInsertedCanonicalReplyBeforeTheShiftedNextTurn,
  testCanonicalInsertionOrderingIsCacheBusted,
];
