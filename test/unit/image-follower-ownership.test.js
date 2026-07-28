'use strict';

const assert = require('assert');
const jobResumeWorkflow = require('../../client/app/job-resume-workflow');

async function testLiveImageRunPreventsSecondRecoveryFollower() {
  const sessionId = 'session-image-live';
  const jobId = 'imgjob-live';
  const displayItem = {
    id: 'display-live',
    role: 'assistant',
    pending: '1',
    responseIndex: '1',
    jobId,
  };
  const state = {
    activeSessionId: sessionId,
    sessions: [{ id: sessionId, messages: [], display: [displayItem] }],
    activeRuns: new Map([[sessionId, {
      stopped: false,
      abortController: { signal: { aborted: false } },
      jobIds: new Set([`image:${jobId}`]),
    }]]),
    resumingJobs: new Set(),
    followingImageJobs: new Set(),
  };
  let timersStarted = 0;
  let waitsStarted = 0;
  let runBindings = 0;
  const node = { dataset: {} };
  const workflow = jobResumeWorkflow.createJobResumeWorkflow({
    state,
    window: {
      ChatUIApp: {
        runs: {
          bindFollowingRun() { runBindings += 1; },
        },
      },
    },
    loadImageJob: () => ({ id: jobId, displayItemId: displayItem.id, responseIndex: 1 }),
    hasSuccessfulImageResult: () => false,
    isFollowingImageJob: () => false,
    persistSessionDisplay() {},
    setSessionBusy() {},
    findMessageNodeByDisplayItem: () => node,
    armStreamingOutputFocus() {},
    updateResumeStreamButton() {},
    setInterval() { timersStarted += 1; return 1; },
    waitImageGenerationJob() { waitsStarted += 1; },
  });

  await workflow.resumeImageJob(sessionId);

  assert.strictEqual(runBindings, 1, 'the existing in-memory owner should only rebind its UI');
  assert.strictEqual(timersStarted, 0, 'returning to the session must not start a second elapsed timer');
  assert.strictEqual(waitsStarted, 0, 'returning to the session must not start a second managed-job follower');
  assert.strictEqual(state.resumingJobs.size, 0, 'the short rebind must release its single-flight marker');
  assert.strictEqual(state.followingImageJobs.size, 0, 'a rebind must not claim recovery follower ownership');
  assert.strictEqual(node.dataset.jobId, jobId);
}

async function testRecoveredImageCompletionUsesCanonicalMessagePosition() {
  const sessionId = 'session-image-recovery';
  const jobId = 'imgjob-recovery';
  const displayItem = {
    id: 'display-recovery',
    role: 'assistant',
    pending: '1',
    responseIndex: '1',
    jobId,
  };
  const session = {
    id: sessionId,
    messages: [{ role: 'user', content: 'draw', messageIndex: '0' }],
    display: [displayItem],
  };
  const state = {
    activeSessionId: sessionId,
    sessions: [session],
    activeRuns: new Map(),
    resumingJobs: new Set(),
    followingImageJobs: new Set(),
  };
  const node = { dataset: {}, parentNode: {} };
  const placements = [];
  const workflow = jobResumeWorkflow.createJobResumeWorkflow({
    state,
    loadImageJob: () => ({
      id: jobId,
      displayItemId: displayItem.id,
      responseIndex: 1,
      mode: 'image',
      prompt: 'draw',
      startedAt: Date.now() - 1000,
    }),
    clearImageJob() {},
    hasSuccessfulImageResult: () => false,
    isFollowingImageJob: () => false,
    normalizeImageContextForStorage: value => value,
    persistSessionDisplay() {},
    setSessionBusy() {},
    pendingFeedbackHtml: text => text,
    updateLiveDisplay() {},
    shouldFollowScroll: () => false,
    setInterval: () => 17,
    getConfig: () => ({}),
    getImageGenerationJob: async () => ({
      status: 'completed',
      data: { images: [{ url: 'https://example.test/result.png' }] },
      metrics: { durationMs: 1000 },
    }),
    isMissingJobError: () => false,
    formatElapsed: () => '1.0s',
    jobDurationMs: () => 1000,
    imageResultToHtml: async () => ({
      html: '<div class="generated-image-grid"></div>',
      raw: 'image result',
      metaText: 'RT 1.0s',
      imageContext: { mode: 'image', attachments: [{ src: 'indexeddb://result' }] },
    }),
    updateSessionDisplayItem() {},
    findMessageNodeByDisplayItem: () => node,
    updateMessage() {},
    setImageContext() {},
    upsertImageAssistantMessage: () => 1,
    insertMessageNodeAtDisplayPosition(target, item) { placements.push({ target, item }); },
    reconcileSuccessfulImageResult() {},
    saveSessionMessages: async () => {},
    playDoneSound() {},
    settleSessionTask(_id, options) {
      state.resumingJobs.delete(options.resumeKey);
      state.followingImageJobs.delete(options.jobId);
    },
    finishSessionTask(_id, options) {
      state.resumingJobs.delete(options.resumeKey);
      state.followingImageJobs.delete(options.jobId);
    },
  });

  await workflow.resumeImageJob(sessionId);

  assert.deepStrictEqual(placements, [{
    target: node,
    item: { role: 'assistant', responseIndex: 1 },
  }], 'the live result should be placed at the same canonical index used after refresh');
  assert.strictEqual(node.dataset.responseIndex, '1');
}

module.exports = [
  testLiveImageRunPreventsSecondRecoveryFollower,
  testRecoveredImageCompletionUsesCanonicalMessagePosition,
];
