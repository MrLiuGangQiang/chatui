'use strict';

const assert = require('assert');
const fs = require('fs');
const path = require('path');
const { JSDOM } = require('jsdom');
const chatWorkflow = require('../../client/app/chat-workflow');
const messageWorkflow = require('../../client/app/message-workflow');

function deferred() {
  let resolve;
  const promise = new Promise(done => { resolve = done; });
  return { promise, resolve };
}

async function testResponsesUsesDurableManagedJobAndCommitBeforeClear() {
  const session = { id: 'session-a', messages: [], display: [], reasoningMode: true, reasoningType: 'high' };
  const state = { sessions: [session], activeSessionId: session.id, messages: session.messages, reasoningMode: true, reasoningType: 'high' };
  const run = { token: 'run-a', stopped: false, abortController: new AbortController() };
  const liveItem = { id: 'display-a', role: 'assistant', pending: '1', responseIndex: '1' };
  const completionCommit = deferred();
  const events = [];
  let saveCount = 0;
  let persistedJob = null;
  let managedOptions = null;
  let cleared = false;

  const workflow = chatWorkflow.createChatWorkflow({
    state,
    loadPublicContext: async () => {},
    getConfig: () => ({ baseUrl: 'https://api.example.test/v1', apiKey: 'secret' }),
    getSessionChatModel: () => 'gpt-5-mini',
    ensureActiveRun: () => run,
    getActiveSession: () => session,
    ensureChatAttachmentImageDataUrls: async items => items,
    buildChatMessagesWithAttachments: (prompt, attachments, base) => [...base, { role: 'user', content: prompt }],
    saveChatHistory: () => {
      saveCount += 1;
      events.push(saveCount === 1 ? 'user-committed' : 'assistant-commit-started');
      return saveCount === 1 ? Promise.resolve() : completionCommit.promise.then(() => events.push('assistant-committed'));
    },
    saveSessionMessages: async () => {},
    addMessage: () => ({ isConnected: false, dataset: {} }),
    pendingFeedbackHtml: text => text,
    appendSessionDisplayMessage: () => liveItem,
    persistSessionDisplay: () => Promise.resolve(),
    armStreamingOutputFocus: () => {},
    buildChatPayload: () => { throw new Error('chat/completions payload must not be used for Responses reasoning'); },
    buildResponsesPayload: (model, messages, options) => ({ model, input: messages, ...options, marker: 'responses-payload' }),
    buildRequestHeaders: () => ({}),
    shouldUseResponsesReasoning: () => true,
    makeClientChatJobId: () => 'chatjob-durable123',
    addActiveRunJob: () => {},
    makeDisplayItemId: () => 'display-generated',
    saveChatJobWithMedia: async (sessionId, job) => {
      events.push('job-committed');
      persistedJob = { sessionId, ...job };
      return persistedJob;
    },
    createRealtimeRenderer: callback => ({ set: callback, final: callback }),
    shouldSuppressRunUi: () => false,
    updateLiveDisplay: () => {},
    shouldFollowScroll: () => false,
    streamManagedChatCompletions: async (payload, config, jobId, onChunk, options) => {
      events.push('managed-stream-started');
      managedOptions = { payload, config, jobId, options };
      onChunk({ reasoning: 'durable reasoning', content: 'durable answer', firstTokenMs: 8 });
      return { reasoning: 'durable reasoning', content: 'durable answer', firstTokenMs: 8, durationMs: 20 };
    },
    streamChatCompletions: async () => { throw new Error('browser-direct Responses stream must not run'); },
    normalizeReasoningText: value => String(value || ''),
    normalizeContentText: value => String(value || ''),
    compactAdjacentDuplicateMessages: items => items,
    cloneMessageList: items => items.map(item => ({ ...item })),
    clearPendingFeedback: () => {},
    playDoneSound: () => {},
    clearChatJob: () => { cleared = true; events.push('job-cleared'); },
    isRunStopped: () => false,
    isAbortLikeError: () => false,
    formatElapsed: value => String(value),
  });

  const sendPromise = workflow.sendChat('Question', [], null, {
    sessionId: session.id,
    onDurableHandoff: () => events.push('pending-submit-cleared'),
  });

  for (let index = 0; index < 8 && !events.includes('assistant-commit-started'); index += 1) await Promise.resolve();
  assert.strictEqual(cleared, false, 'the durable job must remain until the completed canonical message commits');
  assert.ok(persistedJob, 'a durable local job snapshot must exist before streaming starts');
  assert.strictEqual(persistedJob.api, 'responses');
  assert.strictEqual(persistedJob.payload.marker, 'responses-payload');
  assert.strictEqual(managedOptions.jobId, 'chatjob-durable123');
  assert.strictEqual(managedOptions.options.api, 'responses');
  assert.ok(events.indexOf('job-committed') < events.indexOf('pending-submit-cleared'));
  assert.ok(events.indexOf('pending-submit-cleared') < events.indexOf('managed-stream-started'));

  completionCommit.resolve();
  await sendPromise;
  assert.strictEqual(cleared, true);
  assert.ok(events.indexOf('assistant-committed') < events.indexOf('job-cleared'));
  assert.strictEqual(session.messages.at(-1).content, 'durable answer');
  assert.strictEqual(session.messages.at(-1).reasoning_content, 'durable reasoning');
}


async function testIncompleteChatSnapshotPreventsUpstreamHandoff() {
  const session = { id: 'session-a', messages: [], display: [] };
  const state = { sessions: [session], activeSessionId: session.id, messages: session.messages };
  const run = { token: 'run-a', stopped: false, abortController: new AbortController() };
  const liveItem = { id: 'display-a', role: 'assistant', pending: '1', responseIndex: '1' };
  let streamStarts = 0;
  let handoffs = 0;
  let clearCalls = 0;

  const workflow = chatWorkflow.createChatWorkflow({
    state,
    loadPublicContext: async () => {},
    getConfig: () => ({ baseUrl: 'https://api.example.test/v1', apiKey: 'secret' }),
    getSessionChatModel: () => 'gpt-5-mini',
    ensureActiveRun: () => run,
    getActiveSession: () => session,
    ensureChatAttachmentImageDataUrls: async items => items,
    buildChatMessagesWithAttachments: (prompt, attachments, base) => [...base, { role: 'user', content: prompt }],
    saveChatHistory: async () => {},
    saveSessionMessages: async () => {},
    addMessage: () => ({ isConnected: false, dataset: {} }),
    pendingFeedbackHtml: text => text,
    appendSessionDisplayMessage: () => liveItem,
    persistSessionDisplay: () => Promise.resolve(),
    armStreamingOutputFocus: () => {},
    buildChatPayload: (model, messages) => ({ model, messages, stream: true }),
    buildRequestHeaders: () => ({}),
    shouldUseResponsesReasoning: () => false,
    makeClientChatJobId: () => 'chatjob-incomplete',
    addActiveRunJob: () => {},
    saveChatJobWithMedia: async (sessionId, job) => ({ id: job.id, payload: null }),
    createRealtimeRenderer: callback => ({ set: callback, final: callback }),
    shouldSuppressRunUi: () => false,
    updateLiveDisplay: () => {},
    shouldFollowScroll: () => false,
    streamManagedChatCompletions: async () => { streamStarts += 1; return { content: 'must not run' }; },
    normalizeReasoningText: value => String(value || ''),
    compactAdjacentDuplicateMessages: items => items,
    cloneMessageList: items => items.map(item => ({ ...item })),
    clearPendingFeedback: () => {},
    clearChatJob: () => { clearCalls += 1; },
    isRunStopped: () => false,
    isAbortLikeError: () => false,
  });

  await assert.rejects(
    workflow.sendChat('Question', [], null, { sessionId: session.id, onDurableHandoff: () => { handoffs += 1; } }),
    error => error.message.includes('\u6062\u590d\u6570\u636e')
  );
  assert.strictEqual(streamStarts, 0, 'an unrestartable local snapshot must block the upstream request');
  assert.strictEqual(handoffs, 0, 'pending-submit ownership must not be cleared by a failed job snapshot');
  assert.strictEqual(clearCalls, 1, 'the incomplete local job record must be removed');
}

function testCompletedMessageActionsReconcileWithoutAnimationFrame() {
  const dom = new JSDOM('<article class="message assistant" data-streaming="1" data-stream-kind="chat" data-stream-run-token="run" data-pending-feedback="1" data-job-id="chatjob-a"><div class="msg-actions" aria-hidden="true" hidden></div></article>');
  const node = dom.window.document.querySelector('.message');
  let resetCalls = 0;
  messageWorkflow.reconcileCompletedMessageUi(node, () => { resetCalls += 1; });
  assert.strictEqual(node.dataset.streaming, undefined);
  assert.strictEqual(node.dataset.streamKind, undefined);
  assert.strictEqual(node.dataset.streamRunToken, undefined);
  assert.strictEqual(node.dataset.pendingFeedback, undefined);
  assert.strictEqual(node.dataset.jobId, undefined);
  assert.strictEqual(node.querySelector('.msg-actions').hidden, false);
  assert.strictEqual(node.querySelector('.msg-actions').hasAttribute('aria-hidden'), false);
  assert.strictEqual(resetCalls, 1);
}

function testRouteToJobHandoffHasNoUnownedRefreshWindow() {
  const submit = fs.readFileSync(path.join(__dirname, '../../client/app/submit-workflow.js'), 'utf8');
  const image = fs.readFileSync(path.join(__dirname, '../../client/app/image-workflow.js'), 'utf8');
  const app = fs.readFileSync(path.join(__dirname, '../../app.js'), 'utf8');
  assert.ok(!submit.includes('clearPendingSubmit(sessionId);const replacementResponseIndex='), 'pending submit must not be cleared before dispatch owns a durable job');
  assert.ok(submit.includes('stage:"accepted"') && submit.includes('stage:"captured"') && submit.includes('stage:"routing"') && submit.includes('stage:"handoff"'), 'submission ownership must be explicit across every pre-job phase');
  assert.ok(submit.includes('completeDurableHandoff=(jobId,jobKind)=>{handoffCommitted=!0;emitTaskEvent(sessionId,taskEvents.HANDOFF_COMMITTED,{submissionId,jobId,jobKind});clearPendingSubmit(sessionId)}'));
  assert.ok(submit.includes('onDurableHandoff:()=>completeDurableHandoff(activeJobId,activeJobKind)'));
  assert.ok(!submit.includes('saveChatJob(sessionId,{id:preparedChatJobId'), 'routing must not create an incomplete chat job that can outrank pending-submit recovery');
  assert.ok(image.includes('savedImageJob=saveImageJob(n,durableImageJob)') && image.includes('isRecoverableJobSnapshot(savedImageJob,durableImageJob)') && image.includes('completeDurableHandoff();T=performance.now()'), 'image dispatch must verify a restartable local owner before clearing pending-submit');
  assert.ok(app.includes('setSessionBusy(e.id,!0),e.id!==t&&resumeSessionJobs(e.id)'), 'active task evidence must mark the session busy before first render');
  assert.ok(app.includes('flushSessionSnapshots()'), 'page leave must flush every session snapshot, including background tasks');
}

module.exports = [
  testResponsesUsesDurableManagedJobAndCommitBeforeClear,
  testIncompleteChatSnapshotPreventsUpstreamHandoff,
  testCompletedMessageActionsReconcileWithoutAnimationFrame,
  testRouteToJobHandoffHasNoUnownedRefreshWindow,
];
