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
  let availabilityUpdates = 0;
  const lifecycle = taskLifecycle.createTaskLifecycle({
    state,
    taskState,
    setSessionBusy: (sessionId, value, options) => busyCalls.push([sessionId, value, options]),
    updateSendAvailability: () => { availabilityUpdates += 1; },
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
  assert.strictEqual(availabilityUpdates, 3, 'every canonical transition must refresh the composer controls immediately');

  const completed = lifecycle.getTaskState('session-a');
  lifecycle.dispatchTaskEvent('session-a', {
    type: taskState.TASK_EVENTS.JOB_COMPLETED_COMMITTED,
    submissionId: 'submit-old',
    jobId: 'chatjob-old',
  });
  assert.strictEqual(lifecycle.getTaskState('session-a'), completed, 'stale events must not trigger another busy projection');
  assert.strictEqual(busyCalls.length, 3);
}

function testInterfaceCompletionReleasesComposerByMatchingTaskIdentity() {
  const state = { taskStates: new Map() };
  const busyCalls = [];
  let availabilityUpdates = 0;
  const lifecycle = taskLifecycle.createTaskLifecycle({
    state,
    taskState,
    setSessionBusy: (sessionId, value, options) => busyCalls.push([sessionId, value, options]),
    updateSendAvailability: () => { availabilityUpdates += 1; },
  });

  const details = { sessionId: 'session-a', submissionId: 'submit-a', jobId: 'chatjob-a', jobKind: 'chat' };
  lifecycle.dispatchTaskEvent('session-a', { type: taskState.TASK_EVENTS.TASK_ACCEPTED, submissionId: details.submissionId });
  lifecycle.dispatchTaskEvent('session-a', { type: taskState.TASK_EVENTS.ROUTING_STARTED, submissionId: details.submissionId });
  lifecycle.dispatchTaskEvent('session-a', { type: taskState.TASK_EVENTS.HANDOFF_PREPARED, ...details });
  lifecycle.dispatchTaskEvent('session-a', { type: taskState.TASK_EVENTS.HANDOFF_COMMITTED, ...details });
  const completed = lifecycle.dispatchTaskEvent('session-a', {
    type: taskState.TASK_EVENTS.JOB_COMPLETED_COMMITTED,
    ...details,
  });

  assert.strictEqual(completed.phase, taskState.TASK_PHASES.COMPLETED);
  assert.strictEqual(lifecycle.getTaskControls('session-a').sendAction, 'submit');
  assert.strictEqual(lifecycle.getTaskControls('session-a').isBusy, false);
  assert.strictEqual(busyCalls.at(-1)[1], false);
  const updatesAfterCompletion = availabilityUpdates;

  assert.strictEqual(lifecycle.dispatchTaskEvent('session-a', {
    type: taskState.TASK_EVENTS.JOB_COMPLETED_COMMITTED,
    ...details,
  }), completed, 'duplicate interface completion must be idempotent');
  assert.strictEqual(availabilityUpdates, updatesAfterCompletion);

  assert.strictEqual(lifecycle.dispatchTaskEvent('session-a', {
    type: taskState.TASK_EVENTS.JOB_COMPLETED_COMMITTED,
    sessionId: 'session-a',
    submissionId: 'submit-old',
    jobId: 'chatjob-old',
    jobKind: 'chat',
  }), completed, 'a late completion from an older interface must not release a newer task');
  assert.strictEqual(lifecycle.getTaskControls('session-a').sendAction, 'submit');
}

function testCompletedSessionWithoutTaskStateSettlesCleanly() {
  const state = {
    activeRuns: new Map(),
    resumingJobs: new Set(),
    followingChatJobs: new Set(),
    followingImageJobs: new Set(),
    taskStates: new Map(),
  };
  const busyCalls = [];
  let availabilityUpdates = 0;
  const lifecycle = taskLifecycle.createTaskLifecycle({
    state,
    taskState,
    setSessionBusy: (sessionId, value) => busyCalls.push([sessionId, value]),
    updateSendAvailability: () => { availabilityUpdates += 1; },
  });

  assert.doesNotThrow(() => {
    lifecycle.settleSessionTask('session-a', { outcome: 'completed' });
  }, 'restoring an already-completed message history must not dereference a missing task state');
  assert.strictEqual(lifecycle.getTaskState('session-a'), null, 'plain persisted history should not synthesize a canonical task');
  assert.deepStrictEqual(busyCalls, [['session-a', false]]);
  assert.strictEqual(availabilityUpdates, 1);
}

function testRecoveredCompletionSettlesCanonicalBusyProjection() {
  const state = {
    activeRuns: new Map(),
    resumingJobs: new Set(['image:session-a']),
    followingChatJobs: new Set(),
    followingImageJobs: new Set(['imgjob-a']),
    taskStates: new Map(),
  };
  const busyCalls = [];
  const lifecycle = taskLifecycle.createTaskLifecycle({
    state,
    taskState,
    setSessionBusy: (sessionId, value, options) => busyCalls.push([sessionId, value, options?.canonical === true]),
  });

  lifecycle.dispatchTaskEvent('session-a', {
    type: taskState.TASK_EVENTS.JOB_RECOVERY_STARTED,
    submissionId: 'submit-a',
    jobId: 'imgjob-a',
    jobKind: 'image',
  });
  assert.strictEqual(lifecycle.getTaskControls('session-a').isBusy, true);

  lifecycle.settleSessionTask('session-a', {
    outcome: 'completed',
    submissionId: 'submit-a',
    jobId: 'imgjob-a',
    jobKind: 'image',
  });

  assert.strictEqual(lifecycle.getTaskState('session-a').phase, taskState.TASK_PHASES.COMPLETED);
  assert.strictEqual(lifecycle.getTaskControls('session-a').isBusy, false);
  assert.strictEqual(state.resumingJobs.has('image:session-a'), false);
  assert.strictEqual(state.followingImageJobs.has('imgjob-a'), false);
  assert.strictEqual(busyCalls.at(-1)[1], false, 'a committed background result must release the input and sidebar busy projection');
}

function testRecoveredCompletionUsesCanonicalIdentityButCleansActualFollowerJob() {
  const state = {
    activeRuns: new Map(),
    resumingJobs: new Set(['image:session-a']),
    followingChatJobs: new Set(),
    followingImageJobs: new Set(['imgjob-resumed']),
    taskStates: new Map(),
  };
  const lifecycle = taskLifecycle.createTaskLifecycle({
    state,
    taskState,
    setSessionBusy: () => {},
  });

  lifecycle.dispatchTaskEvent('session-a', {
    type: taskState.TASK_EVENTS.JOB_RECOVERY_STARTED,
    submissionId: 'submit-a',
    jobId: 'imgjob-canonical',
    jobKind: 'image',
  });
  lifecycle.settleSessionTask('session-a', {
    outcome: 'completed',
    submissionId: 'submit-a',
    jobId: 'imgjob-resumed',
    jobKind: 'image',
  });

  assert.strictEqual(lifecycle.getTaskState('session-a').phase, taskState.TASK_PHASES.COMPLETED);
  assert.strictEqual(lifecycle.getTaskState('session-a').jobId, 'imgjob-canonical');
  assert.strictEqual(lifecycle.getTaskControls('session-a').isBusy, false);
  assert.strictEqual(state.resumingJobs.has('image:session-a'), false);
  assert.strictEqual(state.followingImageJobs.has('imgjob-resumed'), false);
}

async function testStopSessionTaskReleasesLocallyWhenRemoteAbortNeverSettles() {
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
  let finalized = 0;
  const lifecycle = taskLifecycle.createTaskLifecycle({
    state,
    taskState,
    stopAbortWaitMs: 5,
    clearActiveRun: (sessionId, ownedRun) => {
      if (state.activeRuns.get(sessionId) === ownedRun) state.activeRuns.delete(sessionId);
    },
    setSessionBusy: () => {},
    stop: {
      getActiveRun: sessionId => state.activeRuns.get(sessionId),
      ensureActiveRun: () => run,
      clearPendingSubmit: () => {},
      loadImageJob: () => ({ id: 'imgjob-hung' }),
      abortManagedJob: () => new Promise(() => {}),
      clearImageJob: () => {},
      markStopping: () => {},
      finalizeStopped: () => { finalized += 1; },
    },
  });
  const events = taskState.TASK_EVENTS;
  lifecycle.dispatchTaskEvent('session-a', { type: events.TASK_ACCEPTED, submissionId: 'submit-a' });
  lifecycle.dispatchTaskEvent('session-a', { type: events.ROUTING_STARTED, submissionId: 'submit-a' });
  lifecycle.dispatchTaskEvent('session-a', { type: events.HANDOFF_PREPARED, submissionId: 'submit-a', jobId: 'imgjob-hung', jobKind: 'image' });
  lifecycle.dispatchTaskEvent('session-a', { type: events.HANDOFF_COMMITTED, submissionId: 'submit-a', jobId: 'imgjob-hung', jobKind: 'image' });

  await lifecycle.stopSessionTask('session-a');

  assert.strictEqual(lifecycle.getTaskState('session-a').phase, taskState.TASK_PHASES.STOPPED);
  assert.strictEqual(lifecycle.getTaskControls('session-a').canSubmit, true);
  assert.strictEqual(state.activeRuns.has('session-a'), false);
  assert.strictEqual(finalized, 1);
}

function testCompletionWithoutSubmissionCannotSettleAMismatchedCurrentJob() {
  const state = {
    activeRuns: new Map(),
    resumingJobs: new Set(),
    followingChatJobs: new Set(['chatjob-old']),
    followingImageJobs: new Set(),
    taskStates: new Map(),
  };
  const lifecycle = taskLifecycle.createTaskLifecycle({ state, taskState, setSessionBusy: () => {} });
  const events = taskState.TASK_EVENTS;
  lifecycle.dispatchTaskEvent('session-a', { type: events.TASK_ACCEPTED, submissionId: 'submit-current' });
  lifecycle.dispatchTaskEvent('session-a', { type: events.ROUTING_STARTED, submissionId: 'submit-current' });
  lifecycle.dispatchTaskEvent('session-a', { type: events.HANDOFF_PREPARED, submissionId: 'submit-current', jobId: 'chatjob-current', jobKind: 'chat' });
  lifecycle.dispatchTaskEvent('session-a', { type: events.HANDOFF_COMMITTED, submissionId: 'submit-current', jobId: 'chatjob-current', jobKind: 'chat' });

  lifecycle.settleSessionTask('session-a', {
    outcome: 'completed',
    jobId: 'chatjob-old',
    jobKind: 'chat',
  });

  assert.strictEqual(lifecycle.getTaskState('session-a').phase, taskState.TASK_PHASES.RUNNING);
  assert.strictEqual(lifecycle.getTaskState('session-a').jobId, 'chatjob-current');
  assert.strictEqual(lifecycle.getTaskControls('session-a').isBusy, true);
  assert.strictEqual(state.followingChatJobs.has('chatjob-old'), false);
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




function testTerminalTaskPrunesStaleResumeOwnerAndKeepsComposerSendable() {
  const run = { token: 'run-a', stopped: false, abortController: new AbortController(), jobIds: new Set(['chat:chatjob-a']) };
  const session = { id: 'session-a', busy: false };
  const state = {
    sessions: [session],
    activeSessionId: session.id,
    activeRuns: new Map([[session.id, run]]),
    resumingJobs: new Set([`chat:${session.id}`]),
    followingChatJobs: new Set(),
    followingImageJobs: new Set(),
    busySessions: new Set(),
    taskStates: new Map(),
  };
  const warnings = [];
  let busy = false;
  let sendAction = 'submit';
  let lifecycle = null;
  const setSessionBusy = (sessionId, value, options = {}) => {
    if (value && !options.canonical) {
      const controls = lifecycle.getTaskControls(sessionId);
      if (controls && !controls.isBusy) state.taskStates.delete(sessionId);
    }
    const canonicalBusy = lifecycle.getTaskControls(sessionId)?.isBusy ?? !!value;
    session.busy = canonicalBusy;
    if (canonicalBusy) state.busySessions.add(sessionId);
    else state.busySessions.delete(sessionId);
    busy = canonicalBusy;
    sendAction = lifecycle.getTaskControls(sessionId)?.sendAction || (canonicalBusy ? 'stop' : 'submit');
  };
  lifecycle = taskLifecycle.createTaskLifecycle({
    state,
    taskState,
    clearActiveRun: (sessionId, ownedRun) => {
      if (state.activeRuns.get(sessionId) === ownedRun) state.activeRuns.delete(sessionId);
    },
    setSessionBusy,
    logger: { warn: (...args) => warnings.push(args) },
  });
  const events = taskState.TASK_EVENTS;
  lifecycle.dispatchTaskEvent(session.id, { type: events.TASK_ACCEPTED, submissionId: 'submit-a' });
  lifecycle.dispatchTaskEvent(session.id, { type: events.ROUTING_STARTED, submissionId: 'submit-a' });
  lifecycle.dispatchTaskEvent(session.id, { type: events.HANDOFF_PREPARED, submissionId: 'submit-a', jobId: 'chatjob-a', jobKind: 'chat' });
  lifecycle.dispatchTaskEvent(session.id, { type: events.HANDOFF_COMMITTED, submissionId: 'submit-a', jobId: 'chatjob-a', jobKind: 'chat' });
  lifecycle.dispatchTaskEvent(session.id, { type: events.JOB_COMPLETED_COMMITTED, submissionId: 'submit-a', jobId: 'chatjob-a', jobKind: 'chat' });

  lifecycle.finishSessionTask(session.id, { run });

  assert.strictEqual(lifecycle.getTaskState(session.id).phase, taskState.TASK_PHASES.COMPLETED,
    'a stale recovery marker must never delete the committed terminal task state');
  assert.strictEqual(state.resumingJobs.has(`chat:${session.id}`), false, 'the stale resume lock must be pruned');
  assert.strictEqual(state.activeRuns.has(session.id), false);
  assert.strictEqual(busy, false);
  assert.strictEqual(sendAction, 'submit', 'the composer must return to send mode after the committed answer');
  assert.strictEqual(warnings.length, 1, 'the invariant repair should remain observable in production diagnostics');
}

function testTerminalCleanupPreservesANewerLiveRunOwner() {
  const oldRun = { token: 'run-old', stopped: false, abortController: new AbortController(), jobIds: new Set(['chat:chatjob-old']) };
  const newRun = { token: 'run-new', stopped: false, abortController: new AbortController(), jobIds: new Set(['chat:chatjob-new']) };
  const state = {
    activeRuns: new Map([['session-a', oldRun]]),
    resumingJobs: new Set(),
    followingChatJobs: new Set(),
    followingImageJobs: new Set(),
    taskStates: new Map(),
  };
  let busy = false;
  const lifecycle = taskLifecycle.createTaskLifecycle({
    state,
    taskState,
    clearActiveRun: (sessionId, ownedRun) => {
      if (state.activeRuns.get(sessionId) === ownedRun) state.activeRuns.delete(sessionId);
    },
    setSessionBusy: (_sessionId, value) => { busy = !!value; },
    logger: { warn() {} },
  });
  const events = taskState.TASK_EVENTS;
  lifecycle.dispatchTaskEvent('session-a', { type: events.TASK_ACCEPTED, submissionId: 'submit-old' });
  lifecycle.dispatchTaskEvent('session-a', { type: events.ROUTING_STARTED, submissionId: 'submit-old' });
  lifecycle.dispatchTaskEvent('session-a', { type: events.HANDOFF_PREPARED, submissionId: 'submit-old', jobId: 'chatjob-old', jobKind: 'chat' });
  lifecycle.dispatchTaskEvent('session-a', { type: events.HANDOFF_COMMITTED, submissionId: 'submit-old', jobId: 'chatjob-old', jobKind: 'chat' });
  lifecycle.dispatchTaskEvent('session-a', { type: events.JOB_COMPLETED_COMMITTED, submissionId: 'submit-old', jobId: 'chatjob-old', jobKind: 'chat' });
  state.activeRuns.set('session-a', newRun);
  state.resumingJobs.add('chat:session-a');

  lifecycle.finishSessionTask('session-a', { run: oldRun });

  assert.strictEqual(state.activeRuns.get('session-a'), newRun, 'late cleanup must not delete a newer run');
  assert.strictEqual(state.resumingJobs.has('chat:session-a'), true, 'the newer run recovery marker must remain owned');
  assert.strictEqual(busy, true, 'the newer live run must keep the composer in stop mode');
}

async function testChatResumePreflightFailureAlwaysReleasesResumeOwner() {
  const session = { id: 'session-a', messages: [], display: [] };
  const state = {
    sessions: [session],
    activeSessionId: session.id,
    activeRuns: new Map(),
    resumingJobs: new Set(),
    followingChatJobs: new Set(),
    followingImageJobs: new Set(),
  };
  const finishes = [];
  const finishSessionTask = (sessionId, options = {}) => {
    finishes.push([sessionId, options]);
    if (options.resumeKey) state.resumingJobs.delete(options.resumeKey);
    if (options.jobId && options.followingKind === 'chat') state.followingChatJobs.delete(options.jobId);
  };
  const workflow = jobResumeWorkflow.createJobResumeWorkflow({
    state,
    loadLatestChatJob: () => ({ id: 'chatjob-a', responseIndex: 1, submissionId: 'submit-a' }),
    clearChatJob: () => {},
    sessionHasCompletedAssistantForResponse: () => false,
    takeChatJobLiveItem: () => { throw new Error('chat projection failed before polling'); },
    finishSessionTask,
  });

  await assert.rejects(workflow.resumeChatJob(session.id), /chat projection failed before polling/);

  assert.strictEqual(state.resumingJobs.has(`chat:${session.id}`), false,
    'a pre-poll rendering failure must not leave the session recovery-locked');
  assert.ok(finishes.some(([, options]) => options.resumeKey === `chat:${session.id}` && options.jobId === 'chatjob-a'));
}

async function testImageResumePreflightFailureAlwaysReleasesEveryOwnedMarker() {
  const session = { id: 'session-a', messages: [], display: [] };
  const state = {
    sessions: [session],
    activeSessionId: session.id,
    activeRuns: new Map(),
    resumingJobs: new Set(),
    followingChatJobs: new Set(),
    followingImageJobs: new Set(),
  };
  const finishSessionTask = (_sessionId, options = {}) => {
    if (options.resumeKey) state.resumingJobs.delete(options.resumeKey);
    if (options.jobId && options.followingKind === 'image') state.followingImageJobs.delete(options.jobId);
  };
  const workflow = jobResumeWorkflow.createJobResumeWorkflow({
    state,
    loadImageJob: () => ({ id: 'imgjob-a', submissionId: 'submit-a', mode: 'image' }),
    clearImageJob: () => {},
    hasSuccessfulImageResult: () => false,
    isFollowingImageJob: () => false,
    takePendingLiveItem: () => { throw new Error('image projection failed before polling'); },
    finishSessionTask,
  });

  await assert.rejects(workflow.resumeImageJob(session.id), /image projection failed before polling/);

  assert.strictEqual(state.resumingJobs.has(`image:${session.id}`), false);
  assert.strictEqual(state.followingImageJobs.has('imgjob-a'), false,
    'the follower id claimed before rendering must be released by the outer lifecycle boundary');
}

async function testCompletedImageRecoverySnapshotClearsCanonicalBusyState() {
  const session = { id: 'session-image', messages: [], display: [] };
  const state = {
    sessions: [session],
    activeSessionId: session.id,
    activeRuns: new Map(),
    resumingJobs: new Set(),
    followingChatJobs: new Set(),
    followingImageJobs: new Set(['image-job-a']),
    taskStates: new Map(),
  };
  let busy = false;
  const lifecycle = taskLifecycle.createTaskLifecycle({
    state,
    taskState,
    setSessionBusy: (_sessionId, value) => { busy = value; },
  });
  lifecycle.dispatchTaskEvent(session.id, {
    type: taskState.TASK_EVENTS.JOB_RECOVERY_STARTED,
    submissionId: 'submit-image-a',
    jobId: 'image-job-a',
    jobKind: 'image',
  });

  const workflow = jobResumeWorkflow.createJobResumeWorkflow({
    state,
    loadImageJob: () => ({ id: 'image-job-a', submissionId: 'submit-image-a', responseIndex: 1 }),
    hasSuccessfulImageResult: () => true,
    clearImageJob: () => {},
    settleSessionTask: lifecycle.settleSessionTask,
    finishSessionTask: () => { throw new Error('completed image recovery must use canonical settlement'); },
  });

  await workflow.resumeImageJob(session.id);

  assert.strictEqual(lifecycle.getTaskState(session.id).phase, taskState.TASK_PHASES.COMPLETED);
  assert.strictEqual(lifecycle.getTaskControls(session.id).isBusy, false);
  assert.strictEqual(state.resumingJobs.has(`image:${session.id}`), false);
  assert.strictEqual(state.followingImageJobs.has('image-job-a'), false);
  assert.strictEqual(busy, false, 'switching back after background image completion must show a sendable composer');
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
    finishSessionTask: () => { throw new Error('a completed recovery snapshot must settle canonical task state, not only legacy busy flags'); },
    settleSessionTask: (sessionId, options) => {
      calls.push(['settle', sessionId, options.resumeKey, options.outcome, options.jobId, options.jobKind]);
      state.resumingJobs.delete(options.resumeKey);
    },
  });

  await workflow.resumeChatJob(session.id);

  assert.deepStrictEqual(calls, [
    ['clear', session.id],
    ['settle', session.id, `chat:${session.id}`, 'completed', 'chat-job-a', 'chat'],
  ]);
  assert.deepStrictEqual([...state.resumingJobs], []);
}

function testAllTaskCompletionPathsUseSharedLifecycleFinalizer() {
  const root = path.join(__dirname, '../..');
  const app = fs.readFileSync(path.join(root, 'app.js'), 'utf8');
  const submit = fs.readFileSync(path.join(root, 'client/app/submit-workflow.js'), 'utf8');
  const resume = fs.readFileSync(path.join(root, 'client/app/job-resume-workflow.js'), 'utf8');
  const index = fs.readFileSync(path.join(root, 'index.html'), 'utf8');

  assert.ok(index.indexOf('task-lifecycle.js?v=1.2.5-interface-completion-projection') < index.indexOf('submit-workflow.js?v=1.2.91-strict-model-only-continuation'),
    'the shared lifecycle must load before workflows that emit completion events');
  assert.ok(submit.includes('finishSessionTask(sessionId,{run,stopSlowNotice:'),
    'normal submit completion must use the shared lifecycle finalizer');
  assert.ok(resume.includes('taskOutcome?settleSessionTask(e,{...options')
    && resume.includes('jobKind:"image"') && resume.includes('jobKind:"chat"'),
    'resumed image and chat terminal outcomes must settle canonical task state through one method');
  assert.ok(app.includes('return clearImageJob(e),void settleSessionTask(e,{outcome:"completed"')
    && app.includes('return clearChatJob(e),void settleSessionTask(e,{outcome:"completed"'),
    'already-completed recovery snapshots must settle canonical busy state before returning');
  assert.ok(app.includes('if(a>0&&i>=a)return clearChatJob(e),void settleSessionTask(e,{outcome:"completed"})'),
    'recovery with no remaining owner and a committed answer must settle the canonical lifecycle');
}

module.exports = [
  testTaskLifecycleDispatchesCanonicalStateAndBusyProjection,
  testInterfaceCompletionReleasesComposerByMatchingTaskIdentity,
  testCompletedSessionWithoutTaskStateSettlesCleanly,
  testRecoveredCompletionSettlesCanonicalBusyProjection,
  testRecoveredCompletionUsesCanonicalIdentityButCleansActualFollowerJob,
  testStopSessionTaskReleasesLocallyWhenRemoteAbortNeverSettles,
  testCompletionWithoutSubmissionCannotSettleAMismatchedCurrentJob,
  testStopSessionTaskOwnsTheEntireStopBoundary,
  testLateStopCompletionCannotFinalizeANewerTask,
  testSubmitButtonUsesCanonicalTaskProjection,
  testFinishSessionTaskReleasesAllTransientOwners,
  testFinishSessionTaskPreservesNewerRunBusyState,
  testTerminalTaskPrunesStaleResumeOwnerAndKeepsComposerSendable,
  testTerminalCleanupPreservesANewerLiveRunOwner,
  testChatResumePreflightFailureAlwaysReleasesResumeOwner,
  testImageResumePreflightFailureAlwaysReleasesEveryOwnedMarker,
  testCompletedImageRecoverySnapshotClearsCanonicalBusyState,
  testCompletedRecoverySnapshotEmitsFinishEvent,
  testAllTaskCompletionPathsUseSharedLifecycleFinalizer,
];

