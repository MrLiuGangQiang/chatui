'use strict';

const assert = require('assert');
const fs = require('fs');
const path = require('path');
const taskLifecycle = require('../../client/app/task-lifecycle');
const jobResumeWorkflow = require('../../client/app/job-resume-workflow');

function testFinishSessionTaskReleasesAllTransientOwners() {
  const run = { token: 'run-a' };
  const state = {
    activeRuns: new Map([['session-a', run]]),
    resumingJobs: new Set(['chat:session-a']),
    followingChatJobs: new Set(['chat-job-a']),
    followingImageJobs: new Set(),
  };
  const calls = [];
  const lifecycle = taskLifecycle.createTaskLifecycle({
    state,
    clearInterval: timer => calls.push(['timer', timer]),
    setSessionBusy: (sessionId, value) => calls.push(['busy', sessionId, value]),
    updateSendAvailability: () => calls.push(['availability']),
    getPrompt: () => ({ focus: () => calls.push(['focus']) }),
  });

  lifecycle.finishSessionTask('session-a', {
    run,
    resumeKey: 'chat:session-a',
    followingKind: 'chat',
    jobId: 'chat-job-a',
    timer: 42,
    stopSlowNotice: () => calls.push(['slow-notice']),
    focusPrompt: true,
  });

  assert.strictEqual(state.activeRuns.has('session-a'), false);
  assert.strictEqual(state.resumingJobs.has('chat:session-a'), false);
  assert.strictEqual(state.followingChatJobs.has('chat-job-a'), false);
  assert.deepStrictEqual(calls, [
    ['slow-notice'],
    ['timer', 42],
    ['busy', 'session-a', false],
    ['availability'],
    ['focus'],
  ]);
}

function testFinishSessionTaskPreservesNewerRunBusyState() {
  const completedRun = { token: 'run-old' };
  const currentRun = { token: 'run-new' };
  const state = {
    activeRuns: new Map([['session-a', currentRun]]),
    resumingJobs: new Set(),
    followingChatJobs: new Set(),
    followingImageJobs: new Set(),
  };
  let busy = true;
  const lifecycle = taskLifecycle.createTaskLifecycle({
    state,
    setSessionBusy: (_sessionId, value) => { busy = value; },
  });

  lifecycle.finishSessionTask('session-a', { run: completedRun });

  assert.strictEqual(state.activeRuns.get('session-a'), currentRun, 'a late completion must not delete a newer run');
  assert.strictEqual(busy, true, 'a late completion must not release the busy UI owned by the newer run');
}



async function testCompletedRecoverySnapshotEmitsFinishEvent() {
  const session = { id: 'session-a', messages: [], display: [] };
  const state = { sessions: [session], activeSessionId: session.id, activeRuns: new Map(), resumingJobs: new Set(), followingChatJobs: new Set() };
  const calls = [];
  const workflow = jobResumeWorkflow.createJobResumeWorkflow({
    state,
    loadLatestChatJob: () => ({ id: 'chat-job-a', responseIndex: 1 }),
    clearChatJob: sessionId => calls.push(['clear', sessionId]),
    sessionHasCompletedAssistantForResponse: () => true,
    finishSessionTask: (sessionId, options) => {
      calls.push(['finish', sessionId, options.resumeKey]);
      state.resumingJobs.delete(options.resumeKey);
    },
  });

  await workflow.resumeChatJob(session.id);

  assert.deepStrictEqual(calls, [
    ['clear', session.id],
    ['finish', session.id, `chat:${session.id}`],
  ]);
  assert.deepStrictEqual([...state.resumingJobs], []);
}

function testAllTaskCompletionPathsUseSharedLifecycleFinalizer() {
  const root = path.join(__dirname, '../..');
  const app = fs.readFileSync(path.join(root, 'app.js'), 'utf8');
  const submit = fs.readFileSync(path.join(root, 'client/app/submit-workflow.js'), 'utf8');
  const resume = fs.readFileSync(path.join(root, 'client/app/job-resume-workflow.js'), 'utf8');
  const index = fs.readFileSync(path.join(root, 'index.html'), 'utf8');

  assert.ok(index.indexOf('task-lifecycle.js?v=1.0.0') < index.indexOf('submit-workflow.js?v=1.2.81-task-lifecycle'),
    'the shared lifecycle must load before workflows that emit completion events');
  assert.ok(submit.includes('finishSessionTask(sessionId,{run,stopSlowNotice:'),
    'normal submit completion must use the shared lifecycle finalizer');
  assert.ok(resume.includes('finishSessionTask(e,{resumeKey:t,followingKind:"image"')
    && resume.includes('finishSessionTask(e,{resumeKey:t,followingKind:"chat"'),
    'resumed image and chat completion must use the same finalizer');
  assert.ok(app.includes('return clearImageJob(e),void finishSessionTask(e)')
    && app.includes('return clearChatJob(e),void finishSessionTask(e)'),
    'already-completed recovery snapshots must release stale busy state before returning');
  assert.ok(app.includes('if(a>0&&i>=a)clearChatJob(e);finishSessionTask(e)'),
    'recovery with no remaining owner must still settle the session lifecycle');
}

module.exports = [
  testFinishSessionTaskReleasesAllTransientOwners,
  testFinishSessionTaskPreservesNewerRunBusyState,
  testCompletedRecoverySnapshotEmitsFinishEvent,
  testAllTaskCompletionPathsUseSharedLifecycleFinalizer,
];

