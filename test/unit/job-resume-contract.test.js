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

async function testBackgroundChatResumeNeverUpdatesActiveSessionReasoningNode() {
  const activeSessionId = 'session-active';
  const backgroundSessionId = 'session-background';
  const backgroundItem = {
    id: 'display-background',
    role: 'assistant',
    rawText: '',
    reasoningText: '',
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
    waitChatJob: async (_jobId, onEvent) => {
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
    playDoneSound: () => {},
    firstTokenTimeText: () => '',
  };

  await jobResumeWorkflow.createJobResumeWorkflow(deps).resumeChatJob(backgroundSessionId);

  assert.ok(events.includes('wait-chat-job'), `the test must reach chat recovery polling: ${JSON.stringify(events)}`);
  assert.strictEqual(liveUpdates.length >= 1, true, 'the background job must update its own session projection');
  assert.strictEqual(liveUpdates.every(args => args[0] === backgroundSessionId), true, 'background resume updates must remain session-scoped');
  assert.strictEqual(liveUpdates.some(args => args[4]?.reasoning === 'background reasoning'), true, 'the test must observe the background reasoning delta before asserting DOM isolation');
  assert.deepStrictEqual(reasoningUpdates, [], 'background reasoning must never mutate the active session DOM node');
  assert.strictEqual(activeSessionNode.reasoningText, undefined, 'the active session node must remain untouched');
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
  const deps = {
    ...commonResumeDeps(state, events),
    loadLatestChatJob: () => ({
      id: item.jobId,
      displayItemId: item.id,
      responseIndex: 1,
    }),
    takeChatJobLiveItem: () => item,
    updateLiveDisplay: (...args) => liveUpdates.push(args),
    findMessageNodeByDisplayItem: () => ({ dataset: {}, isConnected: true }),
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
  testChatResumeRejectsMissingExecutionContractBeforeNetwork,
  testBackgroundChatResumeNeverUpdatesActiveSessionReasoningNode,
  testActiveChatResumeReplaysAccumulatedStateBeforeNextDelta,
  testLiveChatResumeReplaysAccumulatedStateAfterSessionSwitch,
  testLiveChatResumeReplaysWaitingStatusBeforeFirstDelta,
  testImageResumeRejectsMissingExecutionContractBeforeNetwork,
];
