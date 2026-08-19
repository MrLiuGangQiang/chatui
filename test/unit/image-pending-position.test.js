'use strict';

const assert = require('assert');
const { JSDOM } = require('jsdom');
const displayItems = require('../../client/app/display-items');
const messageWorkflow = require('../../client/app/message-workflow');
const sessionDisplay = require('../../client/app/session-display');
const sessionPersistence = require('../../client/app/session-persistence');
const messageRecords = require('../../client/app/message-records');
const imageGenerationService = require('../../client/services/image-generation-service');
const imageWorkflow = require('../../client/app/image-workflow');
const routeService = require('../../client/services/route-service');

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

function messageOrder(container) {
  return [...container.querySelectorAll('.message')].map(node => node.id);
}

function createMessageWorkflowFixture() {
  const dom = new JSDOM(`
    <main id="messages">
      <article id="first-user" class="message user" data-message-index="0"><div class="content"></div></article>
      <article id="next-user" class="message user" data-message-index="2"><div class="content"></div></article>
      <article id="next-answer" class="message assistant" data-response-index="3"><div class="content"></div></article>
    </main>
    <template id="messageTemplate">
      <article class="message">
        <div class="avatar"></div>
        <div class="content"></div>
        <button class="quote-btn"></button>
        <button class="edit-btn"></button>
        <button class="force-image-btn"></button>
        <button class="refresh-btn"></button>
        <button class="copy-btn"></button>
        <button class="download-answer-btn"></button>
        <div class="msg-actions"></div>
      </article>
    </template>
  `);
  const document = dom.window.document;
  const messages = document.getElementById('messages');
  const noop = () => {};
  const deps = {
    state: { userScrollLocked: true, activeSessionId: 'session-position' },
    document,
    $: id => document.getElementById(id),
    clearEmpty: noop,
    chatuiContentHash: value => `hash:${value}`,
    quoteContextJson: () => '',
    chatuiShouldLazyRender: () => false,
    renderUserMessageContent: value => String(value || ''),
    renderMarkdown: value => String(value || ''),
    stripTransientBlobUrlsFromHtml: value => String(value || ''),
    withSentQuotePreview: value => String(value || ''),
    cleanupGeneratedImageNumberArtifacts: noop,
    bindSentQuotePreviews: noop,
    bindMobileMoreActions: noop,
    selectQuotedMessage: noop,
    editUserMessage: noop,
    forceImageFromUserMessage: noop,
    regenerateAssistantMessage: noop,
    copyText: async () => {},
    messageCopyText: value => String(value || ''),
    showCopySuccess: noop,
    downloadAnswerFile: noop,
    bindInlineCopyButtons: noop,
    hydrateMessageMedia: noop,
    enhanceRenderedMarkdown: noop,
    syncWebPreviews: noop,
    chatuiRefreshVirtualizer: noop,
    setMessageMetaText: noop,
    revealNodeAboveComposer: noop,
    scrollToBottom: noop,
    saveDisplayHistory: noop,
    shouldFollowScroll: () => false,
    resetMessageActionStates: noop,
    updateResumeStreamButton: noop,
  };
  return { dom, document, messages, workflow: messageWorkflow.createMessageWorkflow(deps) };
}

function testAddMessageWithCanonicalResponseIndexUsesOriginalSlotImmediately() {
  const fixture = createMessageWorkflowFixture();
  try {
    const waiting = fixture.workflow.addMessage('assistant', '正在生成图片', {
      html: true,
      rawText: '正在生成图片',
      responseIndex: 1,
      skipSave: true,
      noScroll: true,
    });
    waiting.id = 'waiting-message';
    assert.deepStrictEqual(
      messageOrder(fixture.messages),
      ['first-user', 'waiting-message', 'next-user', 'next-answer'],
      'a waiting assistant node with responseIndex must be inserted before the next turn',
    );
  } finally {
    fixture.dom.window.close();
  }
}

function createStorage() {
  const values = new Map();
  return {
    getItem: key => values.has(key) ? values.get(key) : null,
    setItem: (key, value) => values.set(key, String(value)),
    removeItem: key => values.delete(key),
  };
}

function testPendingDisplayItemsRemainInCanonicalOrderWhenCreatedOutOfOrder() {
  const session = { id: 'session-display-order', title: 'Order', messages: [], display: [] };
  const state = { sessions: [session], activeSessionId: session.id, messages: [], models: [] };
  const storage = createStorage();
  const workflow = sessionDisplay.createSessionDisplayWorkflow({
    getState: () => state,
    getActiveSession: () => session,
    deriveSessionTitle: current => current.title,
    compactDisplayItems: items => items,
    compactAdjacentDuplicateMessages: items => items,
    sanitizeStoredDisplayItem: item => item,
    sanitizeStoredMessage: item => item,
    renderSessionList: () => {},
    localStorage: storage,
    messageRecords,
    sessionStoreApi: {
      buildSessionSnapshot: current => ({
        id: current.id,
        snapshotVersion: 2,
        updatedAt: current.updatedAt,
        messages: current.messages,
        pendingDisplay: current.display,
        lastGeneratedImage: null,
      }),
    },
    snapshotStore: { supported: false },
    constants: { SESSIONS_KEY: 'sessions', ACTIVE_SESSION_KEY: 'active' },
  });

  workflow.appendSessionDisplayMessage(session.id, 'assistant', 'later', {
    id: 'later',
    pending: true,
    responseIndex: 3,
  });
  workflow.appendSessionDisplayMessage(session.id, 'assistant', 'earlier', {
    id: 'earlier',
    pending: true,
    responseIndex: 1,
  });

  assert.deepStrictEqual(session.display.map(item => item.id), ['earlier', 'later']);
  assert.deepStrictEqual(
    JSON.parse(storage.getItem('sessions:snapshot-fallback:session-display-order')).pendingDisplay.map(item => item.id),
    ['earlier', 'later'],
    'the persisted pending display must retain canonical order as well',
  );
}

function testImageWorkflowCreatesInitialWaitingNodeWithCanonicalResponseIndex() {
  const dom = new JSDOM('<main id="messages"></main>');
  const document = dom.window.document;
  const container = document.getElementById('messages');
  const firstUser = createMessageNode(document, { id: 'first-user', role: 'user', index: 0 });
  const nextUser = createMessageNode(document, { id: 'next-user', role: 'user', index: 2 });
  const nextAssistant = createMessageNode(document, { id: 'next-assistant', role: 'assistant', index: 3 });
  container.append(firstUser, nextUser, nextAssistant);

  const session = { id: 'session-image-pending-position', messages: [], display: [] };
  const state = {
    activeSessionId: session.id,
    sessions: [session],
    messages: session.messages,
    followingImageJobs: new Set(),
    lastGeneratedImage: null,
  };
  const route = routeService.createExplicitTextToImageRoute('draw the first answer');
  const addMessageOptions = [];
  const noop = () => {};
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
    ensureActiveRun: () => ({ stopped: false, token: 'run-image-pending-position', abortController: new AbortController() }),
    setActiveOutputForSession: noop,
    getActiveSession: () => session,
    persistSessionDisplay: noop,
    clearReasoning: noop,
    clearPendingFeedback: noop,
    buildImagePromptWithStylePrompt: prompt => prompt,
    getEffectiveImageStylePrompt: () => '',
    persistImageAttachmentRefs: async attachments => attachments,
    normalizeImageContextForStorage: value => value,
    makeImageItemId: (_referenceId, ordinal) => `image-${ordinal}`,
    makeClientImageJobId: () => 'imgjob-pending-position',
    shouldSuppressRunUi: () => false,
    pendingFeedbackHtml: text => text,
    addMessage: (_role, _content, options = {}) => {
      addMessageOptions.push(options);
      const node = createMessageNode(document, { id: 'waiting-image', role: 'assistant', index: options.responseIndex });
      container.appendChild(node);
      return node;
    },
    appendSessionDisplayMessage: (_sessionId, role, content, options = {}) => {
      const item = {
        id: 'pending-image',
        role,
        rawText: options.rawText || content,
        pending: options.pending ? '1' : '',
        responseIndex: options.responseIndex == null ? '' : String(options.responseIndex),
      };
      session.display.push(item);
      return item;
    },
    updateLiveDisplay: (_sessionId, item, role, content, options = {}) => {
      item.role = role;
      item.rawText = options.rawText || content;
      if (options.responseIndex !== undefined && options.responseIndex !== null) item.responseIndex = String(options.responseIndex);
      displayItems.insertMessageNodeAtDisplayPosition(container, [...container.querySelectorAll('.message')].find(node => node.__displayItem === item || node.dataset.displayItemId === item.id), item);
    },
    updateMessage: (node, content, options = {}) => {
      if (options.responseIndex !== undefined && options.responseIndex !== null) node.dataset.responseIndex = String(options.responseIndex);
      const role = node.classList.contains('user') ? 'user' : 'assistant';
      displayItems.reconcileCanonicalMessageNode(container, node, {
        role,
        index: role === 'user' ? node.dataset.messageIndex : node.dataset.responseIndex,
      });
      node.querySelector('.content').textContent = String(content || '');
    },
    shouldFollowScroll: () => false,
    setInterval: () => 1,
    clearInterval: noop,
    performance: { now: () => 100 },
    addActiveRunJob: noop,
    saveImageJob: (_sessionId, job) => job,
    clearImageJob: noop,
    startImageGenerationJob: async () => ({ id: 'imgjob-pending-position', createdAt: 1 }),
    waitImageGenerationJob: async () => ({ status: 'completed' }),
    formatElapsed: () => '1.0s',
    jobDurationMs: () => 1000,
    imageResultToHtml: async () => ({
      html: '<div class="generated-image-grid"></div>',
      raw: 'image result',
      metaText: 'RT 1.0s',
      imageContext: { attachments: [] },
    }),
    updateSessionDisplayItem: noop,
    setImageContext: noop,
    cloneMessageList: messages => messages.map(message => ({ ...message })),
    saveSessionMessages: async () => {},
    reconcileSuccessfulImageResult: noop,
    playDoneSound: noop,
    mergeSelectedGeneratedImages: noop,
    normalizeLastGeneratedImage: value => value,
  });

  return workflow.sendImage('draw the first answer', {
    sessionId: session.id,
    userAlreadyAdded: true,
    replaceAssistantIndex: 1,
    dispatchContract: route.dispatchContract,
    executionMedia: route.executionResources,
    originalPrompt: 'draw the first answer',
    clientJobId: 'imgjob-pending-position',
  }).then(() => {
    try {
      assert.strictEqual(addMessageOptions[0].responseIndex, 1, 'the initial image waiting node must receive its canonical response index at creation');
      assert.deepStrictEqual(messageOrder(container), ['first-user', 'waiting-image', 'next-user', 'next-assistant']);
      assert.strictEqual(session.display[0].responseIndex, '1');
    } finally {
      dom.window.close();
    }
  });
}

function testCanonicalWaitingPositionBundleIsCacheBusted() {
  const index = require('fs').readFileSync(require('path').join(__dirname, '../../index.html'), 'utf8');
  for (const asset of [
    'client/app/session-display.js?v=2.1.13-canonical-pending-order',
    'client/app/chat-workflow.js?v=1.6.2-canonical-waiting-position',
    'client/app/image-workflow.js?v=1.6.6-canonical-waiting-position',
    'client/app/message-workflow.js?v=1.3.43-canonical-waiting-position',
    'app.js?v=2.3.12-edit-pending-slot',
  ]) {
    assert.ok(index.includes(asset), `the browser must load the cache-busted ${asset} implementation`);
  }
}

module.exports = [
  testAddMessageWithCanonicalResponseIndexUsesOriginalSlotImmediately,
  testPendingDisplayItemsRemainInCanonicalOrderWhenCreatedOutOfOrder,
  testImageWorkflowCreatesInitialWaitingNodeWithCanonicalResponseIndex,
  testCanonicalWaitingPositionBundleIsCacheBusted,
];
