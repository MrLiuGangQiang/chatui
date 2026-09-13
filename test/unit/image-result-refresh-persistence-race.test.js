'use strict';

const assert = require('assert');

const displayHistoryWorkflow = require('../../client/app/display-history-workflow');
const imageGenerationService = require('../../client/services/image-generation-service');
const imageResultReconciliation = require('../../client/app/image-result-reconciliation');
const imageWorkflow = require('../../client/app/image-workflow');
const routeService = require('../../client/services/route-service');
const sessionPersistence = require('../../client/app/session-persistence');

function durableImageContext(ref = 'indexeddb://generated-refresh-result') {
  return JSON.stringify({
    schema_version: 'image_result.v1',
    resultId: 'imgres-refresh-result',
    referenceId: 'imgref-refresh-result',
    attachments: [{
      id: 'image-refresh-result-1',
      imageId: 'image-refresh-result-1',
      src: ref,
      persistedSrc: ref,
      filename: 'refresh-result.png',
      type: 'image/png',
      ordinal: 1,
      sourceIndex: 1,
    }],
  });
}

function copyMessages(messages = []) {
  return messages.map(message => ({ ...message }));
}

async function testImageCompletionCommitsIntoLatestCanonicalArrayAfterSessionResync() {
  const session = {
    id: 'session-image-refresh-race',
    messages: [{ role: 'user', content: 'draw a blue lighthouse', rawText: 'draw a blue lighthouse', messageIndex: '0' }],
    display: [],
  };
  const state = {
    activeSessionId: session.id,
    sessions: [session],
    messages: copyMessages(session.messages),
    followingImageJobs: new Set(),
    lastGeneratedImage: null,
  };
  const liveItem = {
    id: 'display-image-refresh-race',
    role: 'assistant',
    pending: '1',
    rawText: '正在生成图片',
  };
  session.display.push(liveItem);
  const loadingNode = { dataset: {}, isConnected: false };
  const run = { stopped: false, token: 'run-image-refresh-race', abortController: new AbortController() };
  let resultPreparationStarted;
  let releaseResultPreparation;
  let renderCalls = 0;
  let finalDisplayUpdated = false;
  const resultPreparationReached = new Promise(resolve => { resultPreparationStarted = resolve; });
  const resultPreparationGate = new Promise(resolve => { releaseResultPreparation = resolve; });
  const noop = () => {};

  function updateSessionDisplayItem(_sessionId, item, role, content, options = {}) {
    if (!item) return;
    item.role = role;
    item.html = options.html ? String(content || '') : '';
    item.rawText = options.rawText ?? String(content || '');
    if (options.pending !== undefined) item.pending = options.pending ? '1' : '';
    if (options.responseIndex !== undefined && options.responseIndex !== null) item.responseIndex = String(options.responseIndex);
    if (options.imageContext !== undefined) item.imageContext = options.imageContext;
  }

  const route = routeService.createExplicitTextToImageRoute('draw a blue lighthouse');
  const workflow = imageWorkflow.createImageWorkflow({
    state,
    window: {
      ChatUIServices: {
        images: {
          buildImageRequestPayload: ({ model, prompt }) => ({ model, prompt }),
          createImageContext: imageGenerationService.createImageContext,
          buildImageCompletionMessage: () => '[图片生成完成] draw a blue lighthouse',
        },
      },
    },
    getConfig: () => ({ baseUrl: 'https://api.example.test/v1', imageModel: 'image-model', imageSize: 'auto' }),
    ensureActiveRun: () => run,
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
    makeClientImageJobId: () => 'imgjob-image-refresh-race',
    shouldSuppressRunUi: () => false,
    pendingFeedbackHtml: text => text,
    renderImageBatchResult: (_context, options = {}) => String(options.slotStatuses?.[0] || ''),
    updateLiveDisplay: (sessionId, item, role, content, options) => {
      finalDisplayUpdated = true;
      updateSessionDisplayItem(sessionId, item, role, content, options);
    },
    forceRenderCanonicalMessages: session => {
      renderCalls += 1;
      assert.strictEqual(finalDisplayUpdated, true,
        'a detached live image node must not trigger a canonical render before the completed DOM projection is finalized');
      assert.ok(session.messages.some(message => message.role === 'assistant'
        && /indexeddb:\/\/generated-refresh-result/.test(String(message.imageContext || ''))),
      'canonical image completion must be committed before the active session is rerendered');
      assert.notStrictEqual(liveItem.pending, '1',
        'the stale loading projection must be cleared before the canonical active-session render');
    },
    shouldFollowScroll: () => false,
    setInterval: () => 1,
    clearInterval: noop,
    performance: { now: () => 100 },
    addActiveRunJob: noop,
    saveImageJob: (_sessionId, job) => job,
    clearImageJob: noop,
    startImageGenerationJob: async () => ({ id: 'imgjob-image-refresh-race', createdAt: 1 }),
    waitImageGenerationJob: async () => ({ status: 'completed' }),
    formatElapsed: () => '1.0s',
    jobDurationMs: () => 1000,
    imageResultToHtml: async () => {
      resultPreparationStarted();
      await resultPreparationGate;
      return {
        html: '<div class="generated-image-grid"><img class="generated-thumb" data-persisted-src="indexeddb://generated-refresh-result"></div>',
        raw: 'image result',
        metaText: 'RT 1.0s',
        imageContext: JSON.parse(durableImageContext()),
      };
    },
    updateSessionDisplayItem,
    updateMessage: noop,
    setImageContext: noop,
    cloneMessageList: copyMessages,
    saveSessionMessages: async (_sessionId, incoming) => {
      session.messages = sessionPersistence.compactAdjacentDuplicateMessages([
        ...copyMessages(session.messages),
        ...copyMessages(incoming),
      ]);
      state.messages = copyMessages(session.messages);
      // Simulate a focus/pageshow session resync that rebuilds the active DOM
      // while the canonical image save is in flight. The pre-save connectivity
      // snapshot was true, but the original live node is now detached.
      loadingNode.isConnected = false;
    },
    reconcileSuccessfulImageResult: noop,
    playDoneSound: noop,
    mergeSelectedGeneratedImages: noop,
    normalizeLastGeneratedImage: value => value,
  });

  const completion = workflow.sendImage('draw a blue lighthouse', {
    loadingNode,
    liveItem,
    sessionId: session.id,
    userAlreadyAdded: true,
    dispatchContract: route.dispatchContract,
    executionMedia: route.executionResources,
    originalPrompt: 'draw a blue lighthouse',
    clientJobId: 'imgjob-image-refresh-race',
  });

  await resultPreparationReached;
  assert.strictEqual(liveItem.responseIndex, '1',
    'a pending image result created after an existing user turn must be anchored to that turn before completion');
  // A session checkpoint/switch re-projects the active canonical history to a
  // new array while the image result is still being persisted to IndexedDB.
  state.messages = copyMessages(session.messages);
  releaseResultPreparation();
  await completion;

  const completed = session.messages.find(message => message.role === 'assistant');
  assert.ok(completed, 'the completed image must be committed to the canonical session after a working-array replacement');
  assert.match(String(completed.imageContext || ''), /indexeddb:\/\/generated-refresh-result/,
    'the canonical completion must retain the durable image descriptor used after refresh');
  assert.strictEqual(renderCalls, 1,
    'a detached live image node must be replaced by one canonical active-session render after commit');
}

async function testLiveNodeDetachedDuringCanonicalSaveFallsBackToCanonicalRender() {
  const session = {
    id: 'session-image-connected-fallback',
    messages: [{ role: 'user', content: 'draw a blue lighthouse', rawText: 'draw a blue lighthouse', messageIndex: '0' }],
    display: [],
  };
  const state = {
    activeSessionId: session.id,
    sessions: [session],
    messages: copyMessages(session.messages),
    followingImageJobs: new Set(),
    lastGeneratedImage: null,
  };
  const liveItem = {
    id: 'display-image-connected-fallback',
    role: 'assistant',
    pending: '1',
    rawText: '正在生成图片',
  };
  session.display.push(liveItem);
  const loadingNode = {
    dataset: {},
    isConnected: true,
    // The temporary node is attached but does not own a .content subtree that
    // can accept the final rich image HTML.
    querySelector: () => null,
  };
  const run = { stopped: false, token: 'run-image-connected-fallback', abortController: new AbortController() };
  let renderCalls = 0;
  let finalDisplayUpdated = false;
  const noop = () => {};

  function updateSessionDisplayItem(_sessionId, item, role, content, options = {}) {
    if (!item) return;
    item.role = role;
    item.html = options.html ? String(content || '') : '';
    item.rawText = options.rawText ?? String(content || '');
    if (options.pending !== undefined) item.pending = options.pending ? '1' : '';
    if (options.responseIndex !== undefined && options.responseIndex !== null) item.responseIndex = String(options.responseIndex);
    if (options.imageContext !== undefined) item.imageContext = options.imageContext;
  }

  const route = routeService.createExplicitTextToImageRoute('draw a blue lighthouse');
  const workflow = imageWorkflow.createImageWorkflow({
    state,
    window: {
      ChatUIServices: {
        images: {
          buildImageRequestPayload: ({ model, prompt }) => ({ model, prompt }),
          createImageContext: imageGenerationService.createImageContext,
          buildImageCompletionMessage: () => '[图片生成完成] draw a blue lighthouse',
        },
      },
    },
    getConfig: () => ({ baseUrl: 'https://api.example.test/v1', imageModel: 'image-model', imageSize: 'auto' }),
    ensureActiveRun: () => run,
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
    makeImageItemId: (_referenceId, ordinal) => 'image-' + ordinal,
    makeClientImageJobId: () => 'imgjob-connected-fallback',
    shouldSuppressRunUi: () => false,
    pendingFeedbackHtml: text => text,
    renderImageBatchResult: (_context, options = {}) => String(options.slotStatuses?.[0] || ''),
    updateLiveDisplay: (sessionId, item, role, content, options) => {
      finalDisplayUpdated = true;
      updateSessionDisplayItem(sessionId, item, role, content, options);
    },
    forceRenderCanonicalMessages: targetSession => {
      renderCalls += 1;
      assert.strictEqual(finalDisplayUpdated, true,
        'the canonical fallback must run only after the final display projection is committed');
      assert.ok(targetSession.messages.some(message => message.role === 'assistant'
        && /indexeddb:\/\/generated-connected-fallback/.test(String(message.imageContext || ''))),
      'the canonical fallback must see the durable image completion');
      assert.notStrictEqual(liveItem.pending, '1',
        'the stale loading projection must be cleared before canonical rendering');
    },
    shouldFollowScroll: () => false,
    setInterval: () => 1,
    clearInterval: noop,
    performance: { now: () => 100 },
    addActiveRunJob: noop,
    saveImageJob: (_sessionId, job) => job,
    clearImageJob: noop,
    startImageGenerationJob: async () => ({ id: 'imgjob-connected-fallback', createdAt: 1 }),
    waitImageGenerationJob: async () => ({ status: 'completed' }),
    formatElapsed: () => '1.0s',
    jobDurationMs: () => 1000,
    imageResultToHtml: async () => ({
      html: '<div class="generated-image-grid"><img class="generated-thumb" data-persisted-src="indexeddb://generated-connected-fallback"></div>',
      raw: 'image result',
      metaText: 'RT 1.0s',
      imageContext: JSON.parse(durableImageContext('indexeddb://generated-connected-fallback')),
    }),
    updateSessionDisplayItem,
    updateMessage: () => false,
    findMessageNodeByDisplayItem: () => null,
    setImageContext: noop,
    cloneMessageList: copyMessages,
    saveSessionMessages: async (_sessionId, incoming) => {
      session.messages = sessionPersistence.compactAdjacentDuplicateMessages([
        ...copyMessages(session.messages),
        ...copyMessages(incoming),
      ]);
      state.messages = copyMessages(session.messages);
    },
    reconcileSuccessfulImageResult: noop,
    playDoneSound: noop,
    mergeSelectedGeneratedImages: noop,
    normalizeLastGeneratedImage: value => value,
  });

  await workflow.sendImage('draw a blue lighthouse', {
    loadingNode,
    liveItem,
    sessionId: session.id,
    userAlreadyAdded: true,
    replaceAssistantIndex: 1,
    dispatchContract: route.dispatchContract,
    executionMedia: route.executionResources,
    originalPrompt: 'draw a blue lighthouse',
    clientJobId: 'imgjob-connected-fallback',
  });

  assert.strictEqual(renderCalls, 1,
    'a live node detached during the canonical save must be replaced by one canonical render');
}

function testMarkerOnlyCompletionCannotWinCanonicalImageMerge() {
  const rich = {
    role: 'assistant',
    content: '[图片生成完成] draw a blue lighthouse',
    rawText: 'image result',
    responseIndex: '1',
    imageJobId: 'imgjob-image-refresh-race',
    displayItemId: 'display-image-refresh-race',
    imageContext: durableImageContext(),
  };
  const markerOnly = {
    role: 'assistant',
    content: '[图片生成完成] draw a blue lighthouse',
    rawText: '[图片生成完成]',
    responseIndex: '1',
    imageJobId: 'imgjob-image-refresh-race',
    displayItemId: 'display-image-refresh-race',
    // A pending edit can legitimately carry an IndexedDB-backed input context.
    // That input is not a generated output and must not count as refresh-safe.
    imageContext: JSON.stringify({
      mode: 'edit_image',
      target: 'previous',
      attachments: [{ src: 'indexeddb://input-reference' }],
    }),
  };

  const compacted = sessionPersistence.compactAdjacentDuplicateMessages([rich, markerOnly]);

  assert.strictEqual(compacted.length, 1);
  assert.match(String(compacted[0].imageContext || ''), /indexeddb:\/\/generated-refresh-result/,
    'a stale marker-only writer must not replace an IndexedDB-backed image result at the same canonical response index');
}

function testReconciliationRequiresCanonicalDurableImageAndKeepsRichWinner() {
  const markerOnly = {
    role: 'assistant',
    content: '[图片生成完成] draw a blue lighthouse',
    responseIndex: '1',
    imageJobId: 'imgjob-image-refresh-race',
    displayItemId: 'display-image-refresh-race',
    // A pending edit can legitimately carry an IndexedDB-backed input context.
    // That input is not a generated output and must not count as refresh-safe.
    imageContext: JSON.stringify({
      mode: 'edit_image',
      target: 'previous',
      attachments: [{ src: 'indexeddb://input-reference' }],
    }),
  };
  const rich = {
    ...markerOnly,
    rawText: 'image result',
    imageContext: durableImageContext(),
    html: '<img class="generated-thumb" data-persisted-src="indexeddb://generated-refresh-result">',
  };
  const durableDisplay = {
    id: 'display-image-refresh-race',
    role: 'assistant',
    pending: '',
    responseIndex: '1',
    imageContext: durableImageContext(),
    html: rich.html,
  };
  const job = { id: 'imgjob-image-refresh-race', displayItemId: durableDisplay.id, responseIndex: 1 };
  const markerSession = { messages: [markerOnly], display: [durableDisplay] };

  assert.strictEqual(imageResultReconciliation.hasSuccessfulImageResult({
    session: markerSession,
    item: durableDisplay,
    job,
    responseIndex: 1,
  }), false, 'live/display HTML alone cannot authorize durable-job cleanup when the canonical message is marker-only');

  const session = { messages: [markerOnly, rich], display: [durableDisplay] };
  const result = imageResultReconciliation.reconcileSuccessfulImageResult({
    session,
    currentItem: durableDisplay,
    job,
    responseIndex: 1,
  });

  assert.strictEqual(result.changed, true);
  assert.strictEqual(session.messages.length, 1);
  assert.match(String(session.messages[0].imageContext || ''), /indexeddb:\/\/generated-refresh-result/,
    'reconciliation must retain the durable image record and remove the marker-only collision');
  assert.strictEqual(imageResultReconciliation.hasSuccessfulImageResult({ session, item: durableDisplay, job, responseIndex: 1 }), true);
}

function testMarkerOnlyCompletionDoesNotDiscardRecoverablePendingImageProjection() {
  const pending = {
    id: 'display-image-refresh-race',
    role: 'assistant',
    pending: '1',
    responseIndex: '1',
    jobId: 'imgjob-image-refresh-race',
    rawText: '正在生成图片',
  };
  const session = {
    id: 'session-image-refresh-race',
    messages: [
      { role: 'user', content: 'draw a blue lighthouse', messageIndex: '0' },
      {
        role: 'assistant',
        content: '[图片生成完成] draw a blue lighthouse',
        responseIndex: '1',
        imageJobId: pending.jobId,
        displayItemId: pending.id,
        imageContext: JSON.stringify({
          mode: 'edit_image',
          target: 'previous',
          attachments: [{ src: 'indexeddb://input-reference' }],
        }),
      },
    ],
    display: [pending],
  };
  const workflow = displayHistoryWorkflow.createDisplayHistoryWorkflow({
    state: { activeSessionId: 'another-session', reasoningMode: false },
    getActiveSession: () => null,
    loadImageJob: () => ({ id: pending.jobId, displayItemId: pending.id, responseIndex: 1 }),
    loadLatestChatJob: () => null,
    loadPendingSubmit: () => null,
    isSessionBusy: () => false,
    getActiveRun: () => null,
    isChatStatusText: () => false,
    clearChatJob: () => {},
    isImagePendingDisplayItem: item => String(item?.jobId || '').startsWith('imgjob-'),
    sessionHasCompletedAssistantForResponse: () => false,
    compactDisplayItems: items => items,
    persistSessionDisplay: () => {},
    makeDisplayItemId: () => 'generated-display',
    $: () => ({ querySelectorAll: () => [] }),
    addDisplayItemNode: () => { throw new Error('a non-active session must not render DOM'); },
  });

  workflow.restorePendingDisplayItems(session, [pending]);

  assert.strictEqual(session.display.length, 1,
    'a marker-only message must not remove the pending image owner needed to recover the durable job');
  assert.strictEqual(session.display[0].pending, '1');
}


module.exports = [
  testImageCompletionCommitsIntoLatestCanonicalArrayAfterSessionResync,
  testLiveNodeDetachedDuringCanonicalSaveFallsBackToCanonicalRender,
  testMarkerOnlyCompletionCannotWinCanonicalImageMerge,
  testReconciliationRequiresCanonicalDurableImageAndKeepsRichWinner,
  testMarkerOnlyCompletionDoesNotDiscardRecoverablePendingImageProjection,
];
