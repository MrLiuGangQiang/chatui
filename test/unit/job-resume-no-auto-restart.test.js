'use strict';

const assert = require('assert');
const fs = require('fs');
const path = require('path');
const jobResumeWorkflow = require('../../client/app/job-resume-workflow');
const { makeDispatchContract } = require('../helpers/dispatch-contract-fixture');

function createState(sessionId) {
  return {
    activeSessionId: sessionId,
    sessions: [{ id: sessionId, messages: [], display: [] }],
    activeRuns: new Map(),
    resumingJobs: new Set(),
    followingChatJobs: new Set(),
    followingImageJobs: new Set(),
  };
}

async function testMissingChatJobIsTerminalAndNeverReRegistered() {
  const sessionId = 'restart-no-resubmit-chat';
  const state = createState(sessionId);
  const item = {
    id: 'display-restart-chat',
    role: 'assistant',
    rawText: '',
    reasoningText: '',
    pending: '1',
    jobId: 'chatjob-restart',
    responseIndex: '1',
  };
  state.sessions[0].display.push(item);
  const snapshot = {
    id: item.jobId,
    submissionId: 'submit-restart-chat',
    requestPurpose: 'final_execution',
    responseIndex: 1,
    startedAt: Date.now(),
    dispatchContract: makeDispatchContract({ operation: 'plain_chat', prompt: 'question' }),
    bindingEvidence: [],
    payload: { model: 'chat-model', messages: [{ role: 'user', content: 'question' }] },
  };
  const events = [];
  let registrations = 0;
  let waits = 0;
  let cleanups = 0;
  const deps = {
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
    showRunError: (_sessionId, error) => events.push(['error', error?.code]),
    isMissingJobError: error => String(error?.message || '').includes('任务不存在'),
    finishSessionTask: (_sessionId, options = {}) => {
      events.push(['finish', options.outcome || 'cleanup']);
      if (options.resumeKey) state.resumingJobs.delete(options.resumeKey);
    },
    loadLatestChatJob: () => snapshot,
    clearChatJob: () => events.push('clear'),
    sessionHasCompletedAssistantForResponse: () => false,
    takeChatJobLiveItem: () => item,
    updateResumeStreamButton() {},
    armStreamingOutputFocus() {},
    isChatStatusText: () => false,
    getConfig: () => ({ baseUrl: 'https://example.invalid/v1' }),
    getChatJob: async () => { throw new Error('任务不存在或服务已重启'); },
    registerChatStreamJob: async () => { registrations += 1; return null; },
    waitChatJob: async () => { waits += 1; return null; },
    cleanupStalePendingDisplay: () => { cleanups += 1; },
    addMessage: () => null,
    compactAdjacentDuplicateMessages: items => items,
    saveSessionMessages: async () => {},
  };

  await jobResumeWorkflow.createJobResumeWorkflow(deps).resumeChatJob(sessionId);

  assert.strictEqual(registrations, 0, 'a missing job after restart must never be POSTed again');
  assert.strictEqual(waits, 0, 'a missing job must fail before opening another follower');
  assert.strictEqual(cleanups, 1, 'the interrupted pending projection must be cleaned locally');
  assert.ok(events.includes('clear'), 'the durable job owner must be cleared');
  assert.deepStrictEqual(state.sessions[0].display.map(value => value.id), ['display-restart-chat']);
  assert.strictEqual(state.resumingJobs.size, 0);
}

function testResumeSourceHasNoAutomaticChatOrImageRestartBranch() {
  const source = fs.readFileSync(path.join(__dirname, '../../client/app/job-resume-workflow.js'), 'utf8');
  assert.ok(!source.includes('registerChatStreamJob('), 'chat resume must not auto-POST a missing job');
  assert.ok(!source.includes('await startImageGenerationJob('), 'image resume must not auto-POST a missing job');
  assert.ok(!source.includes('buildResumeChatPayload('), 'chat resume must not rebuild and submit a missing job payload');
}

module.exports = [
  testMissingChatJobIsTerminalAndNeverReRegistered,
  testResumeSourceHasNoAutomaticChatOrImageRestartBranch,
];
