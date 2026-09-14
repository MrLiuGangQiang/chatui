'use strict';

const assert = require('assert');
const jobResumeWorkflow = require('../../client/app/job-resume-workflow');
const { makeDispatchContract } = require('../helpers/dispatch-contract-fixture');

async function testReplayedChatDeltasCoalesceToOneLiveDisplayUpdate() {
  const sessionId = 'resume-coalesce-live-display';
  const item = {
    id: 'display-coalesce',
    role: 'assistant',
    rawText: '',
    reasoningText: '',
    html: '',
    pending: '1',
    jobId: 'chatjob-coalesce',
    responseIndex: '1',
  };
  const state = {
    activeSessionId: sessionId,
    sessions: [{ id: sessionId, messages: [], display: [item] }],
    activeRuns: new Map(),
    resumingJobs: new Set(),
    followingChatJobs: new Set(),
    followingImageJobs: new Set(),
  };
  const liveUpdates = [];
  let drainCallback = null;
  const deps = {
    state,
    window: { ChatUIApp: {} },
    persistSessionDisplay() {},
    setSessionBusy() {},
    pendingFeedbackHtml: value => value,
    updateLiveDisplay: (...args) => liveUpdates.push(args),
    shouldFollowScroll: () => false,
    setInterval: () => 1,
    clearInterval() {},
    findMessageNodeByDisplayItem: () => null,
    showRunError() {},
    isMissingJobError: () => false,
    finishSessionTask: (_sessionId, options = {}) => {
      if (options.resumeKey) state.resumingJobs.delete(options.resumeKey);
    },
    loadLatestChatJob: () => ({
      id: item.jobId,
      submissionId: 'submission-coalesce',
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
    updateResumeStreamButton() {},
    armStreamingOutputFocus() {},
    isChatStatusText: () => false,
    getConfig: () => ({ baseUrl: 'https://example.invalid/v1' }),
    getChatJob: async () => null,
    waitChatJob: async (_jobId, onEvent) => {
      liveUpdates.length = 0;
      for (let index = 1; index <= 50; index += 1) {
        onEvent({ status: 'running', data: { content: `prefix-${String(index).padStart(3, '0')}` } });
      }
      if (liveUpdates.length !== 0) throw new Error('replay deltas escaped the coalescing window');
      onEvent({ status: 'done', data: { content: 'prefix-050' } });
      return { status: 'done', data: { content: 'prefix-050' } };
    },
    extractChatJobText: value => {
      const data = value?.data || value || {};
      return { content: String(data.content || ''), reasoning: String(data.reasoning || '') };
    },
    updateSessionDisplayItem() {},
    replaceAssistantMessageAt: () => true,
    saveSessionMessages: async () => {},
    compactAdjacentDuplicateMessages: messages => messages,
    cloneMessageList: messages => messages.map(message => ({ ...message })),
    playDoneSound() {},
    firstTokenTimeText: () => '',
    scheduleLiveDisplayDrain(callback) {
      drainCallback = callback;
      return 1;
    },
    cancelLiveDisplayDrain() {},
  };

  await jobResumeWorkflow.createJobResumeWorkflow(deps).resumeChatJob(sessionId);
  assert.strictEqual(typeof drainCallback, 'function');

  assert.strictEqual(liveUpdates.length, 1,
    'a same-session replay burst must retain only its latest aggregate for live rendering');
  assert.strictEqual(liveUpdates[0][3], 'prefix-050',
    'the coalesced frame must be the newest aggregate, not every 8KiB replay chunk');
  assert.strictEqual(state.resumingJobs.size, 0);
}

module.exports = [testReplayedChatDeltasCoalesceToOneLiveDisplayUpdate];
