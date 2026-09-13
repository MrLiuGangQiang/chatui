'use strict';

const assert = require('assert');
const chatWorkflow = require('../../client/app/chat-workflow');
const { makeDispatchContract } = require('../helpers/dispatch-contract-fixture');

function deferred() {
  let resolve;
  const promise = new Promise(done => { resolve = done; });
  return { promise, resolve };
}

function createTimerHarness() {
  let nextId = 1;
  const intervals = new Map();
  return {
    setInterval(callback, delay) {
      const id = nextId++;
      intervals.set(id, { callback, delay });
      return id;
    },
    clearInterval(id) {
      intervals.delete(id);
    },
    tick() {
      for (const interval of [...intervals.values()]) interval.callback();
    },
    get size() {
      return intervals.size;
    },
  };
}

function createHarness(firstChunk, { reasoningMode = true } = {}) {
  let now = 0;
  const timers = createTimerHarness();
  const streamStarted = deferred();
  const chunkApplied = deferred();
  const releaseStream = deferred();
  const session = { id: 'session-response-start', messages: [], display: [], reasoningMode, reasoningType: reasoningMode ? 'high' : 'none' };
  const state = {
    sessions: [session],
    activeSessionId: session.id,
    messages: session.messages,
    reasoningMode,
    reasoningType: reasoningMode ? 'high' : 'none',
    pageUnloading: false,
    disposedSessionIds: new Set(),
  };
  const run = { token: 'run-response-start', stopped: false, abortController: new AbortController() };
  const assistantNode = {
    isConnected: true,
    dataset: { pendingFeedback: '1' },
    querySelector: () => null,
  };
  const liveItem = { id: 'display-response-start', role: 'assistant', pending: '1', responseIndex: '1' };
  const displayUpdates = [];
  const clearPendingFeedbackCalls = [];
  const dismissIntentTraceCalls = [];
  const reasoningUpdates = [];

  const workflow = chatWorkflow.createChatWorkflow({
    state,
    metricNow: () => now,
    setInterval: timers.setInterval,
    clearInterval: timers.clearInterval,
    loadPublicContext: async () => {},
    getConfig: () => ({ baseUrl: 'https://api.example.test/v1', apiKey: 'secret' }),
    getSessionChatModel: () => 'gpt-5-mini',
    ensureActiveRun: () => run,
    getActiveSession: () => session,
    prepareChatAttachments: async items => items,
    ensureChatAttachmentImageDataUrls: async items => items,
    buildChatMessagesWithAttachments: (prompt, attachments, base, systemPrompt) => [
      ...(systemPrompt ? [{ role: 'system', content: systemPrompt }] : []),
      ...base,
      { role: 'user', content: prompt },
    ],
    saveChatHistory: async () => {},
    saveSessionMessages: async (sessionId, messages) => { session.messages = messages; },
    addMessage: () => assistantNode,
    pendingFeedbackHtml: value => '<div class="pending-feedback">' + value + '</div>',
    appendSessionDisplayMessage: () => liveItem,
    persistSessionDisplay: async () => {},
    armStreamingOutputFocus: () => {},
    buildResponsesPayload: (model, messages, options) => ({ model, input: messages, ...options }),
    shouldUseResponsesReasoning: () => false,
    makeClientChatJobId: () => 'chatjob-response-start',
    addActiveRunJob: () => {},
    saveChatJobWithMedia: async (sessionId, job) => ({ ...job }),
    createRealtimeRenderer: callback => ({ set: callback, final: callback }),
    shouldSuppressRunUi: () => false,
    updateLiveDisplay: (sessionId, item, role, content, options = {}) => {
      displayUpdates.push({ content, options: { ...options } });
      if (options.rawText !== undefined) item.rawText = options.rawText;
      if (options.reasoning !== undefined) item.reasoningText = options.reasoning || '';
    },
    updateSessionDisplayItem: () => {},
    shouldFollowScroll: () => false,
    streamManagedChatCompletions: async (payload, config, jobId, onChunk) => {
      streamStarted.resolve();
      if (firstChunk) {
        onChunk(firstChunk);
        chunkApplied.resolve();
      }
      await releaseStream.promise;
      return { content: 'final answer', reasoning: firstChunk?.reasoning || '', firstTokenMs: 1, durationMs: 20 };
    },
    normalizeReasoningText: value => String(value || ''),
    normalizeContentText: value => String(value || ''),
    compactAdjacentDuplicateMessages: items => items,
    cloneMessageList: items => items.map(item => ({ ...item })),
    clearPendingFeedback: node => {
      clearPendingFeedbackCalls.push(node);
      delete node.dataset.pendingFeedback;
    },
    dismissIntentReasoningTrace: node => {
      dismissIntentTraceCalls.push(node);
      return true;
    },
    clearReasoning: () => {},
    updateReasoning: (node, content, options = {}) => reasoningUpdates.push({ content, ...options }),
    showReasoningUnavailable: () => {},
    setPendingFeedback: () => {},
    updateMessageContentLight: () => {},
    updateMessage: () => {},
    settleActiveOutput: () => {},
    finishReasoning: () => {},
    firstTokenTimeText: () => '',
    setMessageMetaText: () => {},
    playDoneSound: () => {},
    clearChatJob: () => {},
    isRunStopped: () => false,
    isAbortLikeError: () => false,
    formatElapsed: value => String(value),
  });

  return {
    workflow,
    session,
    timers,
    streamStarted,
    chunkApplied,
    releaseStream,
    assistantNode,
    displayUpdates,
    clearPendingFeedbackCalls,
    dismissIntentTraceCalls,
    reasoningUpdates,
    setNow(value) { now = value; },
  };
}

async function testFirstReasoningChunkImmediatelyEndsWaitingStatus() {
  const harness = createHarness({ reasoning: 'thinking', content: '', firstTokenMs: 1 });
  const sendPromise = harness.workflow.sendChat('Question', [], null, {
    sessionId: harness.session.id,
    requestPurpose: 'final_execution',
    dispatchContract: makeDispatchContract({ operation: 'plain_chat', prompt: 'Question' }),
    bindingEvidence: [],
  });

  await harness.streamStarted.promise;
  await harness.chunkApplied.promise;

  const updatesAfterChunk = harness.displayUpdates.length;
  assert.strictEqual(harness.timers.size, 0, 'the elapsed-status timer must stop on the first reasoning chunk');
  assert.strictEqual(harness.clearPendingFeedbackCalls.length, 1, 'the waiting message must be cleared on the first upstream content');
  assert.strictEqual(harness.dismissIntentTraceCalls.length, 1, 'the intent waiting surface must be removed when response output starts');
  assert.strictEqual(harness.displayUpdates.at(-1)?.options?.reasoning, 'thinking');
  assert.strictEqual(harness.displayUpdates.at(-1)?.options?.rawText, '',
    'receiving reasoning must not rewrite the answer placeholder back to the waiting status');

  harness.setNow(122000);
  harness.timers.tick();
  assert.strictEqual(harness.displayUpdates.length, updatesAfterChunk,
    'an upstream response must permanently stop elapsed-status updates');

  harness.releaseStream.resolve();
  await sendPromise;
}

async function testReturnedReasoningDisplaysEvenWhenThinkingControlWasOff() {
  const harness = createHarness({ reasoning: 'provider reasoning', content: '', firstTokenMs: 1 }, { reasoningMode: false });
  const sendPromise = harness.workflow.sendChat('Question', [], null, {
    sessionId: harness.session.id,
    requestPurpose: 'final_execution',
    dispatchContract: makeDispatchContract({ operation: 'plain_chat', prompt: 'Question' }),
    bindingEvidence: [],
  });

  await harness.streamStarted.promise;
  await harness.chunkApplied.promise;

  assert.strictEqual(harness.timers.size, 0);
  assert.strictEqual(harness.dismissIntentTraceCalls.length, 1);
  assert.strictEqual(harness.reasoningUpdates.at(-1)?.content, 'provider reasoning');
  assert.strictEqual(harness.reasoningUpdates.at(-1)?.forceDisplay, true,
    'reasoning returned by the provider must be displayed even if this session did not request thinking mode');
  assert.strictEqual(harness.displayUpdates.at(-1)?.options?.reasoning, 'provider reasoning');

  harness.releaseStream.resolve();
  await sendPromise;
}

module.exports = [
  testFirstReasoningChunkImmediatelyEndsWaitingStatus,
  testReturnedReasoningDisplaysEvenWhenThinkingControlWasOff,
];
