'use strict';

const assert = require('assert');
const jobResumeWorkflow = require('../../client/app/job-resume-workflow');

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
  testImageResumeRejectsMissingExecutionContractBeforeNetwork,
];
