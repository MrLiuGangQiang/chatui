'use strict';

const assert = require('assert');
const fs = require('fs');
const path = require('path');
const taskLifecycle = require('../../client/app/task-lifecycle');
const taskState = require('../../client/core/task-state');
const jobResumeWorkflow = require('../../client/app/job-resume-workflow');

function testTaskLifecycleDispatchesCanonicalStateAndBusyProjection() {
  const state = { taskStates: new Map() };
  const busyCalls = [];
  const lifecycle = taskLifecycle.createTaskLifecycle({
    state,
    taskState,
    setSessionBusy: (sessionId, value, options) => busyCalls.push([sessionId, value, options]),
  });

  lifecycle.dispatchTaskEvent('session-a', {
    type: taskState.TASK_EVENTS.TASK_ACCEPTED,
    submissionId: 'submit-a',
  });
  lifecycle.dispatchTaskEvent('session-a', {
    type: taskState.TASK_EVENTS.ROUTING_STARTED,
    submissionId: 'submit-a',
  });
  lifecycle.dispatchTaskEvent('session-a', {
    type: taskState.TASK_EVENTS.TASK_COMPLETED_COMMITTED,
    submissionId: 'submit-a',
  });

  assert.strictEqual(lifecycle.getTaskState('session-a').phase, taskState.TASK_PHASES.COMPLETED);
  assert.strictEqual(lifecycle.getTaskControls('session-a').isBusy, false);
  assert.deepStrictEqual(busyCalls.map(call => call[1]), [true, true, false]);
  assert.ok(busyCalls.every(call => call[2]?.canonical === true));

  const completed = lifecycle.getTaskState('session-a');
  lifecycle.dispatchTaskEvent('session-a', {
    type: taskState.TASK_EVENTS.JOB_COMPLETED_COMMITTED,
    submissionId: 'submit-old',
    jobId: 'chatjob-old',
  });
  assert.strictEqual(lifecycle.getTaskState('session-a'), completed, 'stale events must not trigger another busy projection');
  assert.strictEqual(busyCalls.length, 3);
}

async function testStopSessionTaskOwnsTheEntireStopBoundary() {
  const run = {
    token: 'run-a',
    stopped: false,
    abortController: new AbortController(),
    jobIds: new Set(),
  };
  const state = {
    activeRuns: new Map([['session-a', run]]),
    stoppedSessions: new Map(),
    resumingJobs: new Set(),
    followingChatJobs: new Set(),
    followingImageJobs: new Set(),
    taskStates: new Map(),
  };
  const calls = [];
  let releaseAbort;
  const abortGate = new Promise(resolve => { releaseAbort = resolve; });
  const lifecycle = taskLifecycle.createTaskLifecycle({
    state,
    taskState,
    clearActiveRun: (sessionId, ownedRun) => {
      calls.push(['clear-run', sessionId]);
      if (state.activeRuns.get(sessionId) === ownedRun) state.activeRuns.delete(sessionId);
    },
    setSessionBusy: (sessionId, value, options) => calls.push(['busy', sessionId, value, options?.canonical === true]),
    updateSendAvailability: () => calls.push(['availability']),
    stop: {
      getActiveRun: sessionId => state.activeRuns.get(sessionId),
      ensureActiveRun: () => run,
      clearPendingSubmit: sessionId => calls.push(['clear-pending', sessionId]),
      loadChatJob: () => ({ id: 'chatjob-a' }),
      loadImageJob: () => ({ id: 'imgjob-a' }),
      abortManagedJob: (kind, jobId) => {
        calls.push(['abort-job', kind, jobId]);
        return kind === 'chat' ? abortGate : Promise.resolve();
      },
      clearChatJob: (sessionId, jobId) => calls.push(['clear-chat', sessionId, jobId]),
      clearImageJob: (sessionId, jobId) => calls.push(['clear-image', sessionId, jobId]),
      markStopping: sessionId => calls.push(['mark-stopping', sessionId]),
      finalizeStopped: sessionId => calls.push(['finalize-stopped', sessionId]),
    },
  });

  const events = taskState.TASK_EVENTS;
  lifecycle.dispatchTaskEvent('session-a', { type: events.TASK_ACCEPTED, submissionId: 'submit-a' });
  lifecycle.dispatchTaskEvent('session-a', { type: events.ROUTING_STARTED, submissionId: 'submit-a' });
  lifecycle.dispatchTaskEvent('session-a', { type: events.HANDOFF_PREPARED, submissionId: 'submit-a', jobId: 'chatjob-a', jobKind: 'chat' });
  lifecycle.dispatchTaskEvent('session-a', { type: events.HANDOFF_COMMITTED, submissionId: 'submit-a', jobId: 'chatjob-a', jobKind: 'chat' });
  calls.length = 0;

  const stopping = lifecycle.stopSessionTask('session-a');
  await Promise.resolve();

  assert.strictEqual(lifecycle.getTaskState('session-a').phase, taskState.TASK_PHASES.STOPPING);
  assert.strictEqual(lifecycle.getTaskControls('session-a').sendAction, 'wait');
  assert.strictEqual(run.stopped, true);
  assert.strictEqual(run.abortController.signal.aborted, true);
  assert.ok(calls.findIndex(call => call[0] === 'clear-pending') < calls.findIndex(call => call[0] === 'abort-job'),
    'pending ownership must clear before asynchronous job abort starts');
  assert.strictEqual(calls.some(call => call[0] === 'finalize-stopped'), false, 'final projection must wait for job abort settlement');

  releaseAbort();
  await stopping;

  assert.strictEqual(lifecycle.getTaskState('session-a').phase, taskState.TASK_PHASES.STOPPED);
  assert.strictEqual(lifecycle.getTaskControls('session-a').canSubmit, true);
  assert.strictEqual(state.activeRuns.has('session-a'), false);
  assert.ok(calls.some(call => call[0] === 'clear-chat' && call[2] === 'chatjob-a'));
  assert.ok(calls.some(call => call[0] === 'clear-image' && call[2] === 'imgjob-a'));
  assert.ok(calls.some(call => call[0] === 'finalize-stopped'));
}

async function testLateStopCompletionCannotFinalizeANewerTask() {
  const oldRun = { token: 'run-old', stopped: false, abortController: new AbortController(), jobIds: new Set() };
  const newRun = { token: 'run-new', stopped: false, abortController: new AbortController(), jobIds: new Set() };
  const state = {
    activeRuns: new Map([['session-a', oldRun]]),
    stoppedSessions: new Map(),
    resumingJobs: new Set(),
    followingChatJobs: new Set(),
    followingImageJobs: new Set(),
    taskStates: new Map(),
  };
  let releaseAbort;
  const abortGate = new Promise(resolve => { releaseAbort = resolve; });
  let finalized = 0;
  const lifecycle = taskLifecycle.createTaskLifecycle({
    state,
    taskState,
    clearActiveRun: (sessionId, run) => { if (state.activeRuns.get(sessionId) === run) state.activeRuns.delete(sessionId); },
    setSessionBusy: () => {},
    stop: {
      getActiveRun: sessionId => state.activeRuns.get(sessionId),
      ensureActiveRun: () => oldRun,
      clearPendingSubmit: () => {},
      loadChatJob: () => ({ id: 'chatjob-old' }),
      abortManagedJob: () => abortGate,
      clearChatJob: () => {},
      finalizeStopped: () => { finalized += 1; },
    },
  });
  const events = taskState.TASK_EVENTS;
  lifecycle.dispatchTaskEvent('session-a', { type: events.TASK_ACCEPTED, submissionId: 'submit-old' });
  lifecycle.dispatchTaskEvent('session-a', { type: events.ROUTING_STARTED, submissionId: 'submit-old' });
  lifecycle.dispatchTaskEvent('session-a', { type: events.HANDOFF_PREPARED, submissionId: 'submit-old', jobId: 'chatjob-old', jobKind: 'chat' });
  lifecycle.dispatchTaskEvent('session-a', { type: events.HANDOFF_COMMITTED, submissionId: 'submit-old', jobId: 'chatjob-old', jobKind: 'chat' });

  const stopping = lifecycle.stopSessionTask('session-a');
  await Promise.resolve();

  let newer = taskState.createTaskState();
  newer = taskState.reduceTaskState(newer, { type: events.TASK_ACCEPTED, sessionId: 'session-a', submissionId: 'submit-new' });
  state.taskStates.set('session-a', newer);
  state.activeRuns.set('session-a', newRun);
  releaseAbort();
  await stopping;

  assert.strictEqual(lifecycle.getTaskState('session-a').submissionId, 'submit-new');
  assert.strictEqual(lifecycle.getTaskState('session-a').phase, taskState.TASK_PHASES.ACCEPTED);
  assert.strictEqual(state.activeRuns.get('session-a'), newRun);
  assert.strictEqual(finalized, 0, 'late stop completion must not rewrite the newer task projection');
}

function testSubmitButtonUsesCanonicalTaskProjection() {
  const root = path.join(__dirname, '../..');
  const app = fs.readFileSync(path.join(root, 'app.js'), 'utf8');
  const submit = fs.readFileSync(path.join(root, 'client/app/submit-workflow.js'), 'utf8');

  assert.ok(app.includes('function isSessionBusy(e=state.activeSessionId){const t=taskControls(e);return t?t.isBusy:'),
    'canonical task controls must take precedence over legacy busy flags');
  assert.ok(app.includes('const n=taskControls(e)?.isBusy??!!t'),
    'late legacy cleanup must project the current canonical task instead of clearing it');
  assert.ok(app.includes('const e=taskControls(state.activeSessionId)') && app.includes('e?.sendAction'),
    'send/stop button rendering must derive from canonical task controls');
  assert.ok(submit.includes('emitTaskEvent(sessionId,taskEvents.JOB_COMPLETED_COMMITTED')
    && submit.indexOf('emitTaskEvent(sessionId,taskEvents.JOB_COMPLETED_COMMITTED') < submit.indexOf('finishSessionTask(sessionId,{run'),
    'canonical completion must be emitted before shared legacy cleanup runs');
  assert.ok(submit.includes('failureEvent===taskEvents.JOB_RECOVERY_STARTED&&root.setTimeout?.(()=>deps.resumeSessionJobs?.(sessionId),0)'),
    'recoverable managed-job errors must schedule the existing recovery workflow');
}

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

  assert.ok(index.indexOf('task-lifecycle.js?v=1.2.0-explicit-stop') < index.indexOf('submit-workflow.js?v=1.2.86-message-projection'),
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
  testTaskLifecycleDispatchesCanonicalStateAndBusyProjection,
  testStopSessionTaskOwnsTheEntireStopBoundary,
  testLateStopCompletionCannotFinalizeANewerTask,
  testSubmitButtonUsesCanonicalTaskProjection,
  testFinishSessionTaskReleasesAllTransientOwners,
  testFinishSessionTaskPreservesNewerRunBusyState,
  testCompletedRecoverySnapshotEmitsFinishEvent,
  testAllTaskCompletionPathsUseSharedLifecycleFinalizer,
];

