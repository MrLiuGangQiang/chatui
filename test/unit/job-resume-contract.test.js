'use strict';

const assert = require('assert');
const jobResumeWorkflow = require('../../client/app/job-resume-workflow');
const { makeDispatchContract } = require('../helpers/dispatch-contract-fixture');

function makeState(sessionId) {
  return {
    activeSessionId: sessionId,
    sessions: [{ id: sessionId, messages: [], display: [] }],
    activeRuns: new Map(),
    resumingJobs: new Set(),
    followingChatJobs: new Set(),
    followingImageJobs: new Set(),
  };
}

function commonResumeDeps(state, events) {
  return {
    state,
    window: { ChatUIApp: {} },
    persistSessionDisplay() {},
    setSessionBusy() {},
    scheduleLiveDisplayDrain(callback) { callback(); return 1; },
    cancelLiveDisplayDrain() {},
    pendingFeedbackHtml: value => value,
    updateLiveDisplay() {},
    shouldFollowScroll: () => false,
    setInterval: () => 1,
    clearInterval() {},
    findMessageNodeByDisplayItem: () => null,
    showRunError: (_sessionId, error) => events.push(['error', error.code]),
    isMissingJobError: () => false,
    finishSessionTask: (_sessionId, options = {}) => {
      events.push(['finish', options.outcome || 'cleanup']);
      if (options.resumeKey) state.resumingJobs.delete(options.resumeKey);
    },
  };
}

async function testChatResumeRejectsMissingExecutionContractBeforeNetwork() {
  const sessionId = 'resume-chat-invalid';
  const state = makeState(sessionId);
  const events = [];
  const deps = {
    ...commonResumeDeps(state, events),
    loadLatestChatJob: () => ({
      id: 'chatjob-invalid-contract',
      requestPurpose: 'final_execution',
      payload: { model: 'chat-model', messages: [] },
      responseIndex: 1,
    }),
    clearChatJob: () => events.push('clear'),
    sessionHasCompletedAssistantForResponse: () => false,
    takeChatJobLiveItem: () => ({ id: 'display-chat', rawText: '', reasoningText: '', responseIndex: '1' }),
    updateResumeStreamButton() {},
    armStreamingOutputFocus() {},
    isChatStatusText: () => false,
    getConfig: () => ({ baseUrl: 'https://example.invalid/v1' }),
    getChatJob: async () => { events.push('poll'); return null; },
    registerChatStreamJob: async () => { events.push('register'); },
    waitChatJob: async () => { events.push('wait'); return null; },
  };

  await jobResumeWorkflow.createJobResumeWorkflow(deps).resumeChatJob(sessionId);

  assert.deepStrictEqual(events.filter(event => typeof event === 'string'), ['clear']);
  assert.deepStrictEqual(events.filter(event => Array.isArray(event)), [
    ['error', 'RESUME_EXECUTION_CONTRACT_INVALID'],
    ['finish', 'failed'],
  ]);
  assert.strictEqual(events.includes('poll'), false);
  assert.strictEqual(events.includes('register'), false);
  assert.strictEqual(events.includes('wait'), false);
  assert.strictEqual(state.resumingJobs.size, 0);
}

async function testDisplayOnlyChatRefreshCanFollowServerJobWithoutReRegistering() {
  const sessionId = 'resume-chat-display-only';
  const state = makeState(sessionId);
  const events = [];
  const liveUpdates = [];
  const item = {
    id: 'display-chat-refresh',
    role: 'assistant',
    rawText: 'recovered tail',
    reasoningText: '',
    streamCheckpointRecovered: true,
    streamCheckpointTailOnly: true,
    outputStarted: true,
    pending: '1',
    jobId: 'chatjob-display-refresh',
    responseIndex: '1',
  };
  state.sessions[0].display = [item];
  const deps = {
    ...commonResumeDeps(state, events),
    loadLatestChatJob: () => ({
      id: item.jobId,
      prompt: '',
      payload: null,
      startedAt: Date.now(),
      displayItemId: item.id,
      responseIndex: 1,
    }),
    clearChatJob: () => events.push('clear-chat'),
    sessionHasCompletedAssistantForResponse: () => false,
    takeChatJobLiveItem: () => item,
    updateLiveDisplay: (...args) => liveUpdates.push(args),
    armStreamingOutputFocus() {},
    updateResumeStreamButton() {},
    isChatStatusText: () => false,
    getConfig: () => ({ baseUrl: 'https://example.invalid/v1' }),
    getChatJob: async () => null,
    registerChatStreamJob: async () => { events.push('register'); },
    waitChatJob: async (_jobId, onEvent) => {
      events.push('wait');
      onEvent({ status: 'running', data: { choices: [{ message: { content: 'full server answer' } }] } });
      return { status: 'done', data: { choices: [{ message: { content: 'full server answer' } }] } };
    },
    extractChatJobText: value => ({
      content: String(value?.choices?.[0]?.message?.content || ''),
      reasoning: String(value?.choices?.[0]?.message?.reasoning_content || ''),
      firstTokenMs: null,
      durationMs: null,
    }),
    updateSessionDisplayItem: () => {},
    replaceAssistantMessageAt: () => true,
    saveSessionMessages: async () => {},
    compactAdjacentDuplicateMessages: messages => messages,
    cloneMessageList: messages => messages,
    playDoneSound: () => {},
    firstTokenTimeText: () => '',
  };

  await jobResumeWorkflow.createJobResumeWorkflow(deps).resumeChatJob(sessionId);

  assert.strictEqual(events.includes('register'), false, 'a display-only refresh pointer must never re-POST the job');
  assert.strictEqual(events.filter(event => event === 'wait').length, 1, 'the existing server Job must be followed');
  assert.strictEqual(events.includes('clear-chat'), true, 'completion must clear the local owner');
  assert.strictEqual(item.streamCheckpointRecovered, undefined, 'server aggregate must replace the provisional cursor');
  assert.strictEqual(liveUpdates.at(-1)?.[3], 'full server answer');
}
async function testBackgroundChatResumeNeverUpdatesActiveSessionReasoningNode() {
  const activeSessionId = 'session-active';
  const backgroundSessionId = 'session-background';
  const backgroundItem = {
    id: 'display-background',
    role: 'assistant',
    rawText: '',
    html: '<div class="pending-feedback">正在处理 已等待 2 秒</div>',
    metaText: 'TTFT 2s',
    reasoningText: '',
    outputStarted: false,
    pending: '1',
    jobId: 'chatjob-background',
    responseIndex: '1',
  };
  const state = {
    activeSessionId,
    sessions: [
      { id: activeSessionId, messages: [], display: [] },
      { id: backgroundSessionId, messages: [], display: [backgroundItem] },
    ],
    activeRuns: new Map(),
    resumingJobs: new Set(),
    followingChatJobs: new Set(),
    followingImageJobs: new Set(),
  };
  const events = [];
  const liveUpdates = [];
  const reasoningUpdates = [];
  const activeSessionNode = { id: 'active-session-node' };
  const snapshot = {
    id: 'chatjob-background',
    submissionId: 'submission-background',
    requestPurpose: 'final_execution',
    responseIndex: 1,
    startedAt: Date.now(),
    dispatchContract: makeDispatchContract({ operation: 'plain_chat', prompt: 'background question' }),
    bindingEvidence: [],
    payload: { model: 'chat-model', messages: [{ role: 'user', content: 'background question' }] },
  };
  const deps = {
    ...commonResumeDeps(state, events),
    loadLatestChatJob: () => snapshot,
    clearChatJob: () => events.push('clear-chat'),
    showRunError: (_sessionId, error) => events.push(['error', error.code, error.message]),
    sessionHasCompletedAssistantForResponse: () => false,
    takeChatJobLiveItem: () => backgroundItem,
    updateLiveDisplay: (...args) => liveUpdates.push(args),
    shouldFollowScroll: () => true,
    findMessageNodeByDisplayItem: () => activeSessionNode,
    updateReasoning: (node, text, options) => reasoningUpdates.push({ node, text, options }),
    getConfig: () => ({ baseUrl: 'https://example.invalid/v1' }),
    restoreJobPayloadMedia: async payload => payload,
    isChatStatusText: () => false,
    getChatJob: async () => { events.push('get-chat-job'); return null; },
    registerChatStreamJob: async () => { events.push('register-chat-job'); return null; },
    waitChatJob: async (_jobId, onEvent, options) => {
      events.push(['wait-chat-job-options', options]);
      events.push('wait-chat-job');
      onEvent({ status: 'running', data: { reasoning: 'background reasoning' } });
      return { status: 'done', data: { content: 'background answer', reasoning: 'background reasoning' } };
    },
    extractChatJobText: value => {
      const data = value?.data || value || {};
      return {
        content: String(data.content || ''),
        reasoning: String(data.reasoning || ''),
      };
    },
    updateSessionDisplayItem: () => {},
    replaceAssistantMessageAt: () => true,
    saveSessionMessages: async () => {},
    compactAdjacentDuplicateMessages: messages => messages,
    cloneMessageList: messages => messages,
    playDoneSound: () => {},
    firstTokenTimeText: () => '',
  };

  await jobResumeWorkflow.createJobResumeWorkflow(deps).resumeChatJob(backgroundSessionId);

  assert.ok(events.includes('wait-chat-job'), `the test must reach chat recovery polling: ${JSON.stringify(events)}`);
  assert.strictEqual(events.find(event => Array.isArray(event) && event[0] === 'wait-chat-job-options')?.[1]?.sessionId, backgroundSessionId, 'chat recovery must bind the waiter to its target session');
  assert.strictEqual(liveUpdates.length >= 1, true, 'the background job must update its own session projection');
  assert.strictEqual(liveUpdates.every(args => args[0] === backgroundSessionId), true, 'background resume updates must remain session-scoped');
  assert.strictEqual(liveUpdates.some(args => args[4]?.reasoning === 'background reasoning'), true, 'the test must observe the background reasoning delta before asserting DOM isolation');
  assert.deepStrictEqual(reasoningUpdates, [], 'background reasoning must never mutate the active session DOM node');
  assert.strictEqual(activeSessionNode.reasoningText, undefined, 'the active session node must remain untouched');
  assert.strictEqual(backgroundItem.outputStarted, true, 'background resume must persist that real output has started');
  assert.strictEqual(backgroundItem.metaText, '', 'background resume must clear stale waiting metrics');
  assert.strictEqual(backgroundItem.html, '', 'background resume must clear stale waiting HTML');
}

async function testActiveChatResumeReplaysAccumulatedStateBeforeNextDelta() {
  const sessionId = 'resume-chat-active-replay';
  const item = {
    id: 'display-active-replay',
    role: 'assistant',
    rawText: 'visible prefix',
    reasoningText: 'visible reasoning',
    pending: '1',
    jobId: 'chatjob-active-replay',
    responseIndex: '1',
  };
  const state = makeState(sessionId);
  state.sessions[0].display = [item];
  const events = [];
  const liveUpdates = [];
  const snapshot = {
    id: item.jobId,
    submissionId: 'submission-active-replay',
    requestPurpose: 'final_execution',
    responseIndex: 1,
    startedAt: Date.now(),
    dispatchContract: makeDispatchContract({ operation: 'plain_chat', prompt: 'question' }),
    bindingEvidence: [],
    payload: { model: 'chat-model', messages: [{ role: 'user', content: 'question' }] },
  };
  const deps = {
    ...commonResumeDeps(state, events),
    loadLatestChatJob: () => snapshot,
    clearChatJob: () => events.push('clear-chat'),
    sessionHasCompletedAssistantForResponse: () => false,
    takeChatJobLiveItem: () => item,
    updateLiveDisplay: (...args) => liveUpdates.push(args),
    shouldFollowScroll: () => false,
    findMessageNodeByDisplayItem: () => ({ dataset: {}, isConnected: true }),
    armStreamingOutputFocus() {},
    updateResumeStreamButton() {},
    isChatStatusText: () => false,
    getConfig: () => ({ baseUrl: 'https://example.invalid/v1' }),
    restoreJobPayloadMedia: async payload => payload,
    getChatJob: async () => null,
    registerChatStreamJob: async () => null,
    waitChatJob: async () => ({
      status: 'done',
      data: { content: 'visible prefix', reasoning: 'visible reasoning' },
    }),
    extractChatJobText: value => {
      const data = value?.data || value || {};
      return { content: String(data.content || ''), reasoning: String(data.reasoning || '') };
    },
    updateSessionDisplayItem() {},
    replaceAssistantMessageAt: () => true,
    saveSessionMessages: async () => {},
    compactAdjacentDuplicateMessages: messages => messages,
    playDoneSound() {},
    firstTokenTimeText: () => '',
  };

  await jobResumeWorkflow.createJobResumeWorkflow(deps).resumeChatJob(sessionId);

  assert.strictEqual(liveUpdates.length, 1, 'refresh recovery must replay the accumulated visible state immediately');
  const [resumeSessionId, resumeItem, , resumeContent, resumeOptions] = liveUpdates[0];
  assert.strictEqual(resumeSessionId, sessionId);
  assert.strictEqual(resumeItem, item);
  assert.strictEqual(resumeContent, 'visible prefix');
  assert.strictEqual(resumeOptions.reasoning, 'visible reasoning');
  assert.strictEqual(resumeOptions.forceDisplay, true, 'provider reasoning must remain visible even when the thinking control is off');
}

async function testChatResumeFollowsAnExistingRunningJobWithoutReRegistering() {
  const sessionId = 'resume-chat-running-existing';
  const item = {
    id: 'display-chat-running-existing',
    role: 'assistant',
    rawText: '',
    reasoningText: '',
    pending: '1',
    jobId: 'chatjob-running-existing',
    responseIndex: '1',
  };
  const state = makeState(sessionId);
  state.sessions[0].display = [item];
  const events = [];
  const snapshot = {
    id: item.jobId,
    submissionId: 'submission-running-existing',
    requestPurpose: 'final_execution',
    responseIndex: 1,
    startedAt: Date.now(),
    dispatchContract: makeDispatchContract({ operation: 'plain_chat', prompt: 'question' }),
    bindingEvidence: [],
    payload: { model: 'chat-model', messages: [{ role: 'user', content: 'question' }] },
  };
  const deps = {
    ...commonResumeDeps(state, events),
    loadLatestChatJob: () => snapshot,
    clearChatJob: () => events.push('clear-chat'),
    sessionHasCompletedAssistantForResponse: () => false,
    takeChatJobLiveItem: () => item,
    isChatStatusText: () => false,
    getConfig: () => ({ baseUrl: 'https://example.invalid/v1' }),
    getChatJob: async () => {
      events.push('get-running');
      return {
        id: snapshot.id,
        status: 'running',
        data: { choices: [{ message: { content: '已有前缀', reasoning_content: '' } }] },
      };
    },
    restoreJobPayloadMedia: async payload => payload,
    registerChatStreamJob: async () => { events.push('register'); return null; },
    waitChatJob: async (_jobId, _onEvent, options) => {
      events.push(['wait', options.sessionId]);
      return {
        status: 'done',
        data: { choices: [{ message: { content: '最终答案', reasoning_content: '' } }] },
      };
    },
    extractChatJobText: value => {
      const message = value?.data?.choices?.[0]?.message || {};
      return {
        content: String(message.content || ''),
        reasoning: String(message.reasoning_content || ''),
      };
    },
    updateSessionDisplayItem() {},
    replaceAssistantMessageAt: () => true,
    saveSessionMessages: async () => {},
    compactAdjacentDuplicateMessages: messages => messages,
    playDoneSound() {},
    firstTokenTimeText: () => '',
  };

  await jobResumeWorkflow.createJobResumeWorkflow(deps).resumeChatJob(sessionId);

  assert.strictEqual(events.includes('get-running'), true);
  assert.strictEqual(events.includes('register'), false,
    'refresh recovery must not POST the same client job again when GET confirms it is running');
  assert.deepStrictEqual(events.find(event => Array.isArray(event) && event[0] === 'wait'), ['wait', sessionId]);
}

async function testLiveChatResumeReplaysAccumulatedStateAfterSessionSwitch() {
  const sessionId = 'resume-chat-live-switch';
  const item = {
    id: 'display-live-switch',
    role: 'assistant',
    rawText: 'cached prefix',
    reasoningText: 'cached reasoning',
    pending: '1',
    jobId: 'chatjob-live-switch',
    responseIndex: '1',
  };
  const state = makeState(sessionId);
  state.sessions[0].display = [item];
  const run = {
    stopped: false,
    abortController: { signal: { aborted: false } },
    jobIds: new Set(['chat:chatjob-live-switch']),
  };
  state.activeRuns.set(sessionId, run);
  state.followingChatJobs.add(item.jobId);
  const events = [];
  const liveUpdates = [];
  const outputNode = { dataset: {}, isConnected: true };
  let pendingClears = 0;
  let traceDismissals = 0;
  const deps = {
    ...commonResumeDeps(state, events),
    loadLatestChatJob: () => ({
      id: item.jobId,
      displayItemId: item.id,
      responseIndex: 1,
    }),
    takeChatJobLiveItem: () => item,
    updateLiveDisplay: (...args) => liveUpdates.push(args),
    findMessageNodeByDisplayItem: () => outputNode,
    clearPendingFeedback: node => { assert.strictEqual(node, outputNode); pendingClears += 1; },
    dismissIntentReasoningTrace: node => { assert.strictEqual(node, outputNode); traceDismissals += 1; },
    armStreamingOutputFocus() {},
    updateResumeStreamButton() {},
    addActiveRunJob() {},
    isChatStatusText: () => false,
  };

  await jobResumeWorkflow.createJobResumeWorkflow(deps).resumeChatJob(sessionId);

  assert.strictEqual(liveUpdates.length, 1, 'switching back must replay the cached live state before the next SSE delta');
  const [resumeSessionId, resumeItem, , resumeContent, resumeOptions] = liveUpdates[0];
  assert.strictEqual(resumeSessionId, sessionId);
  assert.strictEqual(resumeItem, item);
  assert.strictEqual(resumeContent, 'cached prefix');
  assert.strictEqual(resumeOptions.reasoning, 'cached reasoning');
  assert.strictEqual(resumeOptions.forceDisplay, true);
  assert.strictEqual(item.outputStarted, true, 'resumed content must mark the output phase');
  assert.strictEqual(outputNode.dataset.outputStarted, '1');
  assert.strictEqual(pendingClears, 1, 'resumed output must clear the waiting feedback immediately');
  assert.strictEqual(traceDismissals, 1, 'resumed output must dismiss the intent waiting trace immediately');
}

async function testLiveChatResumeReplaysWaitingStatusBeforeFirstDelta() {
  const sessionId = 'resume-chat-live-status';
  const statusText = '正在处理 已等待 2 秒';
  const item = {
    id: 'display-live-status',
    role: 'assistant',
    rawText: statusText,
    html: `<div class="pending-feedback">${statusText}</div>`,
    reasoningText: '',
    pending: '1',
    jobId: 'chatjob-live-status',
    responseIndex: '1',
  };
  const state = makeState(sessionId);
  state.sessions[0].display = [item];
  state.activeRuns.set(sessionId, {
    stopped: false,
    abortController: { signal: { aborted: false } },
    jobIds: new Set(['chat:chatjob-live-status']),
  });
  state.followingChatJobs.add(item.jobId);
  const events = [];
  const liveUpdates = [];
  const deps = {
    ...commonResumeDeps(state, events),
    loadLatestChatJob: () => ({ id: item.jobId, displayItemId: item.id, responseIndex: 1 }),
    takeChatJobLiveItem: () => item,
    updateLiveDisplay: (...args) => liveUpdates.push(args),
    findMessageNodeByDisplayItem: () => ({ dataset: {}, isConnected: true }),
    armStreamingOutputFocus() {},
    updateResumeStreamButton() {},
    addActiveRunJob() {},
    isChatStatusText: value => String(value || '').startsWith('正在处理'),
    pendingFeedbackHtml: value => `<div class="pending-feedback">${value}</div>`,
  };

  await jobResumeWorkflow.createJobResumeWorkflow(deps).resumeChatJob(sessionId);

  assert.strictEqual(liveUpdates.length, 1, 'switching back must restore the waiting status before the next SSE delta');
  const [, resumeItem, , resumeContent, resumeOptions] = liveUpdates[0];
  assert.strictEqual(resumeItem, item);
  assert.strictEqual(resumeContent, item.html);
  assert.strictEqual(resumeOptions.html, true);
  assert.strictEqual(resumeOptions.rawText, statusText);
}

async function testLiveChatResumeHonorsOutputStartedWithoutBufferedText() {
  const sessionId = 'resume-chat-output-started';
  const statusText = '正在处理 已等待 2 秒';
  const item = {
    id: 'display-output-started',
    role: 'assistant',
    rawText: statusText,
    html: `<div class=pending-feedback>${statusText}</div>`,
    reasoningText: '',
    outputStarted: true,
    pending: '1',
    jobId: 'chatjob-output-started',
    responseIndex: '1',
  };
  const state = makeState(sessionId);
  state.sessions[0].display = [item];
  state.activeRuns.set(sessionId, {
    stopped: false,
    abortController: { signal: { aborted: false } },
    jobIds: new Set(['chat:' + item.jobId]),
  });
  state.followingChatJobs.add(item.jobId);
  const events = [];
  const liveUpdates = [];
  const outputNode = { dataset: {}, isConnected: true, querySelector: () => null };
  let pendingClears = 0;
  let traceDismissals = 0;
  const deps = {
    ...commonResumeDeps(state, events),
    loadLatestChatJob: () => ({ id: item.jobId, displayItemId: item.id, responseIndex: 1 }),
    takeChatJobLiveItem: () => item,
    updateLiveDisplay: (...args) => liveUpdates.push(args),
    findMessageNodeByDisplayItem: () => outputNode,
    clearPendingFeedback: node => { assert.strictEqual(node, outputNode); pendingClears += 1; },
    dismissIntentReasoningTrace: node => { assert.strictEqual(node, outputNode); traceDismissals += 1; },
    armStreamingOutputFocus() {},
    updateResumeStreamButton() {},
    addActiveRunJob() {},
    isChatStatusText: value => String(value || '').startsWith('正在处理'),
    pendingFeedbackHtml: value => `<div class=pending-feedback>${value}</div>`,
  };

  await jobResumeWorkflow.createJobResumeWorkflow(deps).resumeChatJob(sessionId);

  assert.strictEqual(liveUpdates.length, 1, 'switching back must replay the output phase before the next stream delta');
  const [, resumeItem, , resumeContent, resumeOptions] = liveUpdates[0];
  assert.strictEqual(resumeItem, item);
  assert.strictEqual(resumeContent, '', 'the waiting text must not be replayed after output has started');
  assert.strictEqual(resumeOptions.html, undefined, 'the stale waiting HTML must not be restored');
  assert.strictEqual(item.html, '', 'the stale waiting HTML must be cleared from the display item');
  assert.strictEqual(pendingClears, 1, 'the waiting feedback must be cleared even before the first buffered delta');
  assert.strictEqual(traceDismissals, 1, 'the intent waiting trace must be dismissed on the output boundary');
}

async function testChatRefreshAppliesServerSnapshotBeforeDerivingResumeOffsets() {
  const sessionId = 'resume-chat-offset-race';
  const state = makeState(sessionId);
  const events = [];
  const liveUpdates = [];
  const item = {
    id: 'display-chat-offset-race',
    role: 'assistant',
    rawText: 'old-tail',
    reasoningText: '',
    streamCheckpointRecovered: true,
    streamCheckpointTailOnly: true,
    outputStarted: true,
    pending: '1',
    jobId: 'chatjob-offset-race',
    responseIndex: '1',
  };
  state.sessions[0].display = [item];
  let resumeOffsets = null;
  let queuedDrain = null;
  const deps = {
    ...commonResumeDeps(state, events),
    scheduleLiveDisplayDrain(callback) { queuedDrain = callback; return 1; },
    cancelLiveDisplayDrain() { queuedDrain = null; },
    loadLatestChatJob: () => ({
      id: item.jobId,
      submissionId: 'submit-offset-race',
      requestPurpose: 'final_execution',
      responseIndex: 1,
      startedAt: Date.now(),
      dispatchContract: makeDispatchContract({ operation: 'plain_chat', prompt: 'question' }),
      bindingEvidence: [],
      payload: { model: 'chat-model', messages: [{ role: 'user', content: 'question' }] },
    }),
    clearChatJob() {},
    sessionHasCompletedAssistantForResponse: () => false,
    takeChatJobLiveItem: () => item,
    updateLiveDisplay: (_sessionId, liveItem, _role, _content, options = {}) => {
      liveUpdates.push(options);
      liveItem.rawText = String(options.rawText || '');
      liveItem.reasoningText = String(options.reasoning || '');
    },
    armStreamingOutputFocus() {},
    updateResumeStreamButton() {},
    isChatStatusText: () => false,
    getConfig: () => ({ baseUrl: 'https://example.invalid/v1' }),
    getChatJob: async () => ({
      status: 'running',
      data: { choices: [{ message: { content: 'full-server-prefix' } }] },
    }),
    waitChatJob: async (_jobId, onEvent, options) => {
      resumeOffsets = options.resumeOffsets;
      const done = { status: 'done', data: { choices: [{ message: { content: 'full-server-prefix' } }] } };
      onEvent(done);
      return done.data;
    },
    extractChatJobText: value => ({
      content: String(value?.choices?.[0]?.message?.content || value?.data?.choices?.[0]?.message?.content || ''),
      reasoning: String(value?.choices?.[0]?.message?.reasoning_content || value?.data?.choices?.[0]?.message?.reasoning_content || ''),
    }),
    updateSessionDisplayItem() {},
    replaceAssistantMessageAt: () => true,
    saveSessionMessages: async () => {},
    compactAdjacentDuplicateMessages: messages => messages,
    cloneMessageList: messages => messages.map(message => ({ ...message })),
    playDoneSound() {},
    firstTokenTimeText: () => '',
  };

  await jobResumeWorkflow.createJobResumeWorkflow(deps).resumeChatJob(sessionId);

  assert.strictEqual(item.rawText, 'full-server-prefix', 'the server snapshot must replace the provisional tail before SSE resume');
  assert.deepStrictEqual(resumeOffsets, {
    baseContent: 'full-server-prefix',
    baseReasoning: '',
    contentLength: 'full-server-prefix'.length,
    reasoningLength: 0,
  }, 'SSE resume must continue after the applied server snapshot, never after the stale local tail');
  assert.ok(liveUpdates.length >= 1);
}

async function testResumedChatStreamIsBoundToTheStopSignal() {
  const sessionId = 'resume-chat-stop-binding';
  const state = makeState(sessionId);
  const events = [];
  const item = {
    id: 'display-chat-stop-binding',
    role: 'assistant',
    rawText: 'partial answer',
    reasoningText: '',
    outputStarted: true,
    pending: '1',
    jobId: 'chatjob-stop-binding',
    responseIndex: '1',
  };
  state.sessions[0].display = [item];
  let ensuredRun = null;
  let capturedOptions = null;
  const liveUpdates = [];
  const deps = {
    ...commonResumeDeps(state, events),
    ensureActiveRun: currentSessionId => {
      ensuredRun = {
        sessionId: currentSessionId,
        token: 'run-stop-binding',
        abortController: new AbortController(),
        jobIds: new Set(),
        stopped: false,
      };
      state.activeRuns.set(currentSessionId, ensuredRun);
      return ensuredRun;
    },
    addActiveRunJob: (currentSessionId, kind, jobId) => {
      const run = state.activeRuns.get(currentSessionId);
      if (run) run.jobIds.add(`${kind}:${jobId}`);
    },
    loadLatestChatJob: () => ({
      id: item.jobId,
      submissionId: 'submit-stop-binding',
      requestPurpose: 'final_execution',
      responseIndex: 1,
      startedAt: Date.now(),
      dispatchContract: makeDispatchContract({ operation: 'plain_chat', prompt: 'question' }),
      bindingEvidence: [],
      payload: { model: 'chat-model', messages: [{ role: 'user', content: 'question' }] },
    }),
    clearChatJob() {},
    sessionHasCompletedAssistantForResponse: () => false,
    takeChatJobLiveItem: () => item,
    updateLiveDisplay: (_sessionId, _item, _role, _content, options = {}) => liveUpdates.push(options),
    armStreamingOutputFocus() {},
    updateResumeStreamButton() {},
    isChatStatusText: () => false,
    getConfig: () => ({ baseUrl: 'https://example.invalid/v1' }),
    getChatJob: async () => null,
    waitChatJob: async (_jobId, onEvent, options) => {
      capturedOptions = options;
      onEvent({ status: 'done', data: { choices: [{ message: { content: 'partial answer' } }] } });
      return { status: 'done', data: { choices: [{ message: { content: 'partial answer' } }] } };
    },
    extractChatJobText: value => ({
      content: String(value?.choices?.[0]?.message?.content || value?.data?.choices?.[0]?.message?.content || ''),
      reasoning: '',
    }),
    updateSessionDisplayItem() {},
    replaceAssistantMessageAt: () => true,
    saveSessionMessages: async () => {},
    compactAdjacentDuplicateMessages: messages => messages,
    cloneMessageList: messages => messages.map(message => ({ ...message })),
    playDoneSound() {},
    firstTokenTimeText: () => '',
  };

  await jobResumeWorkflow.createJobResumeWorkflow(deps).resumeChatJob(sessionId);

  assert.ok(ensuredRun, 'refresh resume must create an active run');
  assert.ok(ensuredRun.jobIds.has(`chat:${item.jobId}`), 'the resumed job must belong to the active run');
  assert.strictEqual(capturedOptions?.signal, ensuredRun.abortController.signal,
    'the resumed SSE waiter must be cancelled by the stop button signal');
  assert.strictEqual(capturedOptions?.runToken, ensuredRun.token,
    'the resume waiter must carry the run token used by UI suppression');
  assert.ok(liveUpdates.some(options => options.runToken === ensuredRun.token),
    'resumed live updates must be suppressed after this run is stopped');
}

async function testChatRefreshContinuesReasoningBeyondCompactFrameBoundary() {
  const sessionId = 'resume-reasoning-frame-boundary';
  const state = makeState(sessionId);
  const events = [];
  const firstFrame = 'A'.repeat(8192);
  const tailFrame = 'B'.repeat(1000);
  const item = {
    id: 'display-reasoning-boundary',
    role: 'assistant',
    rawText: '',
    reasoningText: '',
    pending: '1',
    jobId: 'chatjob-reasoning-boundary',
    responseIndex: '1',
  };
  state.sessions[0].display = [item];
  const liveReasoningLengths = [];
  const deps = {
    ...commonResumeDeps(state, events),
    loadLatestChatJob: () => ({
      id: item.jobId,
      submissionId: 'submit-reasoning-boundary',
      requestPurpose: 'final_execution',
      responseIndex: 1,
      startedAt: Date.now(),
      dispatchContract: makeDispatchContract({ operation: 'plain_chat', prompt: 'question' }),
      bindingEvidence: [],
      payload: { model: 'chat-model', messages: [{ role: 'user', content: 'question' }] },
    }),
    clearChatJob() {},
    sessionHasCompletedAssistantForResponse: () => false,
    takeChatJobLiveItem: () => item,
    updateLiveDisplay: (_sessionId, liveItem, _role, _content, options = {}) => {
      liveReasoningLengths.push(String(options.reasoning || '').length);
      liveItem.reasoningText = String(options.reasoning || '');
    },
    armStreamingOutputFocus() {},
    updateResumeStreamButton() {},
    isChatStatusText: () => false,
    getConfig: () => ({ baseUrl: 'https://example.invalid/v1' }),
    getChatJob: async () => ({
      status: 'running',
      data: { choices: [{ message: { content: '', reasoning_content: firstFrame } }] },
    }),
    waitChatJob: async (_jobId, onEvent) => {
      const running = { status: 'running', data: { choices: [{ message: { content: '', reasoning_content: firstFrame + tailFrame } }] } };
      onEvent(running);
      const done = { status: 'done', data: { choices: [{ message: { content: '', reasoning_content: firstFrame + tailFrame } }] } };
      onEvent(done);
      return done.data;
    },
    extractChatJobText: value => {
      const message = value?.choices?.[0]?.message || value?.data?.choices?.[0]?.message || {};
      return { content: String(message.content || ''), reasoning: String(message.reasoning_content || '') };
    },
    updateSessionDisplayItem() {},
    replaceAssistantMessageAt: () => true,
    saveSessionMessages: async () => {},
    compactAdjacentDuplicateMessages: messages => messages,
    cloneMessageList: messages => messages.map(message => ({ ...message })),
    playDoneSound() {},
    firstTokenTimeText: () => '',
  };

  await jobResumeWorkflow.createJobResumeWorkflow(deps).resumeChatJob(sessionId);

  assert.strictEqual(item.reasoningText.length, 8192 + 1000,
    'reasoning must continue after the first 8192-character compact frame');
  assert.ok(liveReasoningLengths.some(length => length >= 8192 + 1000),
    'the resumed live renderer must receive the post-boundary reasoning content');
}

async function testTerminalReasoningResumeFrameIsRenderedWithChatStreamIdentity() {
  const sessionId = 'resume-terminal-reasoning-frame';
  const state = makeState(sessionId);
  const item = {
    id: 'display-terminal-reasoning',
    role: 'assistant',
    rawText: '',
    reasoningText: '',
    pending: '1',
    jobId: 'chatjob-terminal-reasoning',
    responseIndex: '1',
  };
  state.sessions[0].display = [item];
  const liveUpdates = [];
  const deps = {
    ...commonResumeDeps(state, []),
    loadLatestChatJob: () => ({
      id: item.jobId,
      submissionId: 'submit-terminal-reasoning',
      requestPurpose: 'final_execution',
      responseIndex: 1,
      startedAt: Date.now(),
      dispatchContract: makeDispatchContract({ operation: 'plain_chat', prompt: 'question' }),
      bindingEvidence: [],
      payload: { model: 'chat-model', messages: [{ role: 'user', content: 'question' }] },
    }),
    clearChatJob() {},
    sessionHasCompletedAssistantForResponse: () => false,
    takeChatJobLiveItem: () => item,
    updateLiveDisplay: (_sessionId, _item, _role, content, options = {}) => liveUpdates.push({ content, options }),
    armStreamingOutputFocus() {},
    updateResumeStreamButton() {},
    isChatStatusText: () => false,
    getConfig: () => ({ baseUrl: 'https://example.invalid/v1' }),
    getChatJob: async () => null,
    waitChatJob: async (_jobId, onEvent) => {
      onEvent({
        status: 'done',
        data: { choices: [{ message: { content: '', reasoning_content: 'terminal thought' } }] },
      });
      return { choices: [{ message: { content: '', reasoning_content: 'terminal thought' } }] };
    },
    extractChatJobText: value => {
      const message = value?.choices?.[0]?.message || value?.data?.choices?.[0]?.message || {};
      return { content: String(message.content || ''), reasoning: String(message.reasoning_content || '') };
    },
    updateSessionDisplayItem() {},
    replaceAssistantMessageAt: () => true,
    saveSessionMessages: async () => {},
    compactAdjacentDuplicateMessages: messages => messages,
    cloneMessageList: messages => messages.map(message => ({ ...message })),
    playDoneSound() {},
    firstTokenTimeText: () => '',
  };

  await jobResumeWorkflow.createJobResumeWorkflow(deps).resumeChatJob(sessionId);

  const reasoningUpdates = liveUpdates.filter(entry => entry.options.reasoning === 'terminal thought');
  assert.strictEqual(reasoningUpdates.length, 1,
    'a terminal reasoning-only resume frame must still update the live display');
  assert.strictEqual(reasoningUpdates[0].content, '');
  assert.strictEqual(reasoningUpdates[0].options.reasoning, 'terminal thought');
  assert.strictEqual(reasoningUpdates[0].options.streamKind, 'chat');
  assert.strictEqual(reasoningUpdates[0].options.sessionId, sessionId);
}

async function testImageResumeRejectsMissingExecutionContractBeforeNetwork() {
  const sessionId = 'resume-image-invalid';
  const state = makeState(sessionId);
  const events = [];
  const deps = {
    ...commonResumeDeps(state, events),
    loadImageJob: () => ({
      id: 'imgjob-invalid-contract',
      mode: 'image',
      requestPurpose: 'final_execution',
      payload: { model: 'image-model', prompt: 'draw' },
      responseIndex: 1,
    }),
    clearImageJob: () => events.push('clear'),
    hasSuccessfulImageResult: () => false,
    isFollowingImageJob: () => false,
    takePendingLiveItem: () => ({ id: 'display-image', rawText: '', responseIndex: '1' }),
    getConfig: () => ({ baseUrl: 'https://example.invalid/v1' }),
    getImageGenerationJob: async () => { events.push('poll'); return null; },
    startImageGenerationJob: async () => { events.push('register'); },
    waitImageGenerationJob: async () => { events.push('wait'); return null; },
  };

  await jobResumeWorkflow.createJobResumeWorkflow(deps).resumeImageJob(sessionId);

  assert.deepStrictEqual(events.filter(event => typeof event === 'string'), ['clear']);
  const arrayEvents = events.filter(event => Array.isArray(event));
  assert.deepStrictEqual(arrayEvents.slice(0, 2), [
    ['error', 'RESUME_EXECUTION_CONTRACT_INVALID'],
    ['finish', 'failed'],
  ]);
  assert.strictEqual(events.includes('poll'), false);
  assert.strictEqual(events.includes('register'), false);
  assert.strictEqual(events.includes('wait'), false);
  assert.strictEqual(state.resumingJobs.size, 0);
}

module.exports = [
  testChatResumeFollowsAnExistingRunningJobWithoutReRegistering,
  testChatResumeRejectsMissingExecutionContractBeforeNetwork,
  testDisplayOnlyChatRefreshCanFollowServerJobWithoutReRegistering,
  testChatRefreshAppliesServerSnapshotBeforeDerivingResumeOffsets,
  testResumedChatStreamIsBoundToTheStopSignal,
  testBackgroundChatResumeNeverUpdatesActiveSessionReasoningNode,
  testActiveChatResumeReplaysAccumulatedStateBeforeNextDelta,
  testLiveChatResumeReplaysAccumulatedStateAfterSessionSwitch,
  testLiveChatResumeReplaysWaitingStatusBeforeFirstDelta,
  testLiveChatResumeHonorsOutputStartedWithoutBufferedText,
  testChatRefreshContinuesReasoningBeyondCompactFrameBoundary,
  testTerminalReasoningResumeFrameIsRenderedWithChatStreamIdentity,
  testImageResumeRejectsMissingExecutionContractBeforeNetwork,
];
