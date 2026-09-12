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

async function testChatExecutionElapsedStatusTicksWithoutSessionSwitch() {
  let now = 0;
  const timers = createTimerHarness();
  const streamStarted = deferred();
  const releaseStream = deferred();
  const session = { id: 'session-timer', messages: [], display: [], reasoningMode: false, reasoningType: 'none' };
  const state = {
    sessions: [session],
    activeSessionId: session.id,
    messages: session.messages,
    reasoningMode: false,
    reasoningType: 'none',
    pageUnloading: false,
    disposedSessionIds: new Set(),
  };
  const run = { token: 'run-timer', stopped: false, abortController: new AbortController() };
  const assistantNode = { isConnected: true, dataset: {}, querySelector: () => null };
  const liveItem = { id: 'display-timer', role: 'assistant', pending: '1', responseIndex: '1' };
  const displayUpdates = [];

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
    pendingFeedbackHtml: text => `<div class="pending-feedback"><span class="pending-text">${text}</span></div>`,
    appendSessionDisplayMessage: () => liveItem,
    persistSessionDisplay: async () => {},
    armStreamingOutputFocus: () => {},
    buildResponsesPayload: (model, messages, options) => ({ model, input: messages, ...options }),
    shouldUseResponsesReasoning: () => false,
    makeClientChatJobId: () => 'chatjob-timer',
    addActiveRunJob: () => {},
    saveChatJobWithMedia: async (sessionId, job) => ({ ...job }),
    createRealtimeRenderer: callback => ({ set: callback, final: callback }),
    shouldSuppressRunUi: () => false,
    updateLiveDisplay: (sessionId, item, role, content, options = {}) => {
      displayUpdates.push({ sessionId, item, role, content, options });
      if (options.rawText !== undefined) item.rawText = options.rawText;
      if (options.html !== undefined) item.html = options.html;
    },
    updateSessionDisplayItem: () => {},
    shouldFollowScroll: () => false,
    streamManagedChatCompletions: async () => {
      streamStarted.resolve();
      await releaseStream.promise;
      return { content: 'answer', reasoning: '', firstTokenMs: 1, durationMs: 139000 };
    },
    normalizeReasoningText: value => String(value || ''),
    normalizeContentText: value => String(value || ''),
    compactAdjacentDuplicateMessages: items => items,
    cloneMessageList: items => items.map(item => ({ ...item })),
    clearPendingFeedback: () => {},
    clearReasoning: () => {},
    updateReasoning: () => {},
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

  const sendPromise = workflow.sendChat('Question', [], null, {
    sessionId: session.id,
    requestPurpose: 'final_execution',
    dispatchContract: makeDispatchContract({ operation: 'plain_chat', prompt: 'Question' }),
    bindingEvidence: [],
  });
  await streamStarted.promise;

  assert.strictEqual(timers.size, 1, 'active chat execution must own one elapsed-status timer');
  assert.strictEqual(displayUpdates.at(-1)?.options?.rawText, '正在处理 已等待 0 秒');

  now = 139000;
  timers.tick();
  assert.strictEqual(
    displayUpdates.at(-1)?.options?.rawText,
    '正在处理 已等待 139 秒',
    'the elapsed status must advance while the request is still waiting; session switches are not required',
  );

  releaseStream.resolve();
  await sendPromise;

  assert.strictEqual(timers.size, 0, 'the elapsed-status timer must be released when the stream settles');
}

module.exports = [
  testChatExecutionElapsedStatusTicksWithoutSessionSwitch,
];
