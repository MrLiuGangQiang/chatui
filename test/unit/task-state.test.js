'use strict';

const assert = require('assert');
const fs = require('fs');
const path = require('path');
const vm = require('vm');
const taskState = require('../../client/core/task-state');

const {
  TASK_PHASES,
  TASK_EVENTS,
  TASK_OWNERS,
  createTaskState,
  deriveTaskControls,
  reduceTaskState,
} = taskState;

function event(type, patch = {}) {
  return { type, sessionId: 'session-a', submissionId: 'submit-a', ...patch };
}

function buildRunningTask() {
  let state = createTaskState();
  state = reduceTaskState(state, event(TASK_EVENTS.TASK_ACCEPTED));
  state = reduceTaskState(state, event(TASK_EVENTS.ATTACHMENT_CAPTURE_STARTED));
  state = reduceTaskState(state, event(TASK_EVENTS.ATTACHMENT_CAPTURED));
  state = reduceTaskState(state, event(TASK_EVENTS.HANDOFF_PREPARED, { jobId: 'chatjob-a', jobKind: 'chat' }));
  return reduceTaskState(state, event(TASK_EVENTS.HANDOFF_COMMITTED, { jobId: 'chatjob-a', jobKind: 'chat' }));
}

function testTaskStateStartsIdleWithSubmitControls() {
  const state = createTaskState();
  assert.strictEqual(state.phase, TASK_PHASES.IDLE);
  assert.strictEqual(state.owner, TASK_OWNERS.NONE);
  assert.deepStrictEqual(deriveTaskControls(state), {
    isBusy: false,
    canSubmit: true,
    canStop: false,
    sendAction: 'submit',
  });
}

function testTaskStateFollowsDurableOwnershipChain() {
  let state = createTaskState();
  const initial = state;

  state = reduceTaskState(state, event(TASK_EVENTS.TASK_ACCEPTED));
  assert.notStrictEqual(state, initial);
  assert.strictEqual(state.phase, TASK_PHASES.ACCEPTED);
  assert.strictEqual(state.owner, TASK_OWNERS.PENDING_SUBMISSION);

  state = reduceTaskState(state, event(TASK_EVENTS.ATTACHMENT_CAPTURE_STARTED));
  assert.strictEqual(state.phase, TASK_PHASES.CAPTURING);

  state = reduceTaskState(state, event(TASK_EVENTS.ATTACHMENT_CAPTURED));
  assert.strictEqual(state.phase, TASK_PHASES.ROUTING);

  state = reduceTaskState(state, event(TASK_EVENTS.HANDOFF_PREPARED, { jobId: 'chatjob-a', jobKind: 'chat' }));
  assert.strictEqual(state.phase, TASK_PHASES.HANDOFF);
  assert.strictEqual(state.owner, TASK_OWNERS.PENDING_SUBMISSION, 'pending submit owns the task until the job snapshot is restartable');

  state = reduceTaskState(state, event(TASK_EVENTS.HANDOFF_COMMITTED, { jobId: 'chatjob-a', jobKind: 'chat' }));
  assert.strictEqual(state.phase, TASK_PHASES.RUNNING);
  assert.strictEqual(state.owner, TASK_OWNERS.MANAGED_JOB);
  assert.deepStrictEqual(deriveTaskControls(state), {
    isBusy: true,
    canSubmit: false,
    canStop: true,
    sendAction: 'stop',
  });

  state = reduceTaskState(state, event(TASK_EVENTS.JOB_COMPLETED_COMMITTED, { jobId: 'chatjob-a' }));
  assert.strictEqual(state.phase, TASK_PHASES.COMPLETED);
  assert.strictEqual(state.owner, TASK_OWNERS.CANONICAL_SESSION, 'completion becomes terminal only after the canonical session commit');
  assert.strictEqual(deriveTaskControls(state).canSubmit, true);
}

function testTaskStateCompletesCommittedLocalReply() {
  let state = createTaskState();
  state = reduceTaskState(state, event(TASK_EVENTS.TASK_ACCEPTED));
  state = reduceTaskState(state, event(TASK_EVENTS.ROUTING_STARTED));
  state = reduceTaskState(state, event(TASK_EVENTS.TASK_COMPLETED_COMMITTED));
  assert.strictEqual(state.phase, TASK_PHASES.COMPLETED);
  assert.strictEqual(state.owner, TASK_OWNERS.CANONICAL_SESSION);
  assert.strictEqual(deriveTaskControls(state).isBusy, false);
}

function testTaskStateSupportsNoAttachmentRoute() {
  let state = createTaskState();
  state = reduceTaskState(state, event(TASK_EVENTS.TASK_ACCEPTED));
  state = reduceTaskState(state, event(TASK_EVENTS.ROUTING_STARTED));
  assert.strictEqual(state.phase, TASK_PHASES.ROUTING);
}

function testTaskStateIgnoresStaleCompletionFromOlderTask() {
  let oldTask = buildRunningTask();
  oldTask = reduceTaskState(oldTask, event(TASK_EVENTS.JOB_COMPLETED_COMMITTED, { jobId: 'chatjob-a' }));

  let current = reduceTaskState(oldTask, event(TASK_EVENTS.TASK_ACCEPTED, { submissionId: 'submit-b' }));
  current = reduceTaskState(current, event(TASK_EVENTS.ROUTING_STARTED, { submissionId: 'submit-b' }));
  current = reduceTaskState(current, event(TASK_EVENTS.HANDOFF_PREPARED, { submissionId: 'submit-b', jobId: 'chatjob-b', jobKind: 'chat' }));
  current = reduceTaskState(current, event(TASK_EVENTS.JOB_STARTED, { submissionId: 'submit-b', jobId: 'chatjob-b', jobKind: 'chat' }));

  const afterLateCompletion = reduceTaskState(current, event(TASK_EVENTS.JOB_COMPLETED_COMMITTED, { submissionId: 'submit-a', jobId: 'chatjob-a' }));
  assert.strictEqual(afterLateCompletion, current, 'a late event must not mutate the newer task');
  assert.strictEqual(afterLateCompletion.phase, TASK_PHASES.RUNNING);
  assert.strictEqual(afterLateCompletion.submissionId, 'submit-b');
  assert.strictEqual(deriveTaskControls(afterLateCompletion).sendAction, 'stop');
}

function testTaskStateMovesRunningJobIntoRecovery() {
  const running = buildRunningTask();
  const recovering = reduceTaskState(running, event(TASK_EVENTS.JOB_RECOVERY_STARTED, {
    jobId: 'chatjob-a',
    jobKind: 'chat',
  }));
  assert.strictEqual(recovering.phase, TASK_PHASES.RECOVERING);
  assert.strictEqual(recovering.owner, TASK_OWNERS.MANAGED_JOB);
  assert.strictEqual(deriveTaskControls(recovering).isBusy, true);
}

function testTaskStateRejectsMismatchedJobEvents() {
  const running = buildRunningTask();
  const mismatched = reduceTaskState(running, event(TASK_EVENTS.JOB_FAILED, {
    jobId: 'chatjob-other',
    error: new Error('stale failure'),
  }));
  assert.strictEqual(mismatched, running);
}

function testTaskStateStopUsesOneTerminalPath() {
  let state = buildRunningTask();
  state = reduceTaskState(state, event(TASK_EVENTS.TASK_STOP_REQUESTED, { jobId: 'chatjob-a' }));
  assert.strictEqual(state.phase, TASK_PHASES.STOPPING);
  assert.deepStrictEqual(deriveTaskControls(state), {
    isBusy: true,
    canSubmit: false,
    canStop: false,
    sendAction: 'wait',
  });

  state = reduceTaskState(state, event(TASK_EVENTS.TASK_STOPPED, { jobId: 'chatjob-a' }));
  assert.strictEqual(state.phase, TASK_PHASES.STOPPED);
  assert.strictEqual(state.owner, TASK_OWNERS.NONE);
  assert.strictEqual(deriveTaskControls(state).canSubmit, true);
}

function testTaskStateCanBootstrapManagedJobRecovery() {
  const state = reduceTaskState(createTaskState(), {
    type: TASK_EVENTS.JOB_RECOVERY_STARTED,
    sessionId: 'session-a',
    submissionId: 'submit-a',
    jobId: 'imgjob-a',
    jobKind: 'image',
  });
  assert.strictEqual(state.phase, TASK_PHASES.RECOVERING);
  assert.strictEqual(state.owner, TASK_OWNERS.MANAGED_JOB);
  assert.strictEqual(state.jobId, 'imgjob-a');
  assert.strictEqual(deriveTaskControls(state).sendAction, 'stop');
}

function testTaskStateDoesNotReviveTerminalTaskFromStaleRecovery() {
  let state = buildRunningTask();
  state = reduceTaskState(state, event(TASK_EVENTS.JOB_COMPLETED_COMMITTED, { jobId: 'chatjob-a' }));

  const staleRecovery = reduceTaskState(state, {
    type: TASK_EVENTS.JOB_RECOVERY_STARTED,
    sessionId: 'session-a',
    submissionId: 'submit-old',
    jobId: 'chatjob-old',
    jobKind: 'chat',
  });
  assert.strictEqual(staleRecovery, state);
  assert.strictEqual(staleRecovery.phase, TASK_PHASES.COMPLETED);
}

function testTaskStateIgnoresUnknownAndOutOfOrderEvents() {
  const idle = createTaskState();
  assert.strictEqual(reduceTaskState(idle, event(TASK_EVENTS.JOB_COMPLETED_COMMITTED, { jobId: 'chatjob-a' })), idle);
  assert.strictEqual(reduceTaskState(idle, { type: 'UNKNOWN' }), idle);

  const accepted = reduceTaskState(idle, event(TASK_EVENTS.TASK_ACCEPTED));
  const routing = reduceTaskState(accepted, event(TASK_EVENTS.ROUTING_STARTED));
  assert.strictEqual(
    reduceTaskState(routing, event(TASK_EVENTS.JOB_STARTED, { jobId: 'chatjob-a' })),
    routing,
    'a managed job cannot take ownership before the durable handoff is prepared',
  );
  const duplicateAccept = reduceTaskState(accepted, event(TASK_EVENTS.TASK_ACCEPTED, { submissionId: 'submit-b' }));
  assert.strictEqual(duplicateAccept, accepted, 'an active task cannot be replaced by a second acceptance event');
}

function testBrowserCoreRegistersTaskStateWithoutAnotherGlobal() {
  const browser = {};
  const context = vm.createContext({ window: browser, globalThis: browser, console });
  const root = path.join(__dirname, '../..');
  vm.runInContext(fs.readFileSync(path.join(root, 'client/core/browser.js'), 'utf8'), context);
  vm.runInContext(fs.readFileSync(path.join(root, 'client/core/task-state.js'), 'utf8'), context);

  assert.strictEqual(typeof browser.ChatUICore.taskState.reduceTaskState, 'function');
  assert.deepStrictEqual(Object.keys(browser).filter(key => /^ChatUI/.test(key)), ['ChatUICore']);
  assert.throws(() => browser.ChatUICore.registerModule('taskState', {}), /already registered/);
}

function testCoreIndexExportsTaskStateWithoutBrowserGlobal() {
  const core = require('../../client/core');
  assert.strictEqual(core.taskState, taskState);
  assert.ok(!Object.keys(globalThis).some(key => /^ChatUI.*TaskState$/.test(key)), 'the pure reducer must not add another browser global');
}

module.exports = [
  testTaskStateStartsIdleWithSubmitControls,
  testTaskStateFollowsDurableOwnershipChain,
  testTaskStateCompletesCommittedLocalReply,
  testTaskStateSupportsNoAttachmentRoute,
  testTaskStateIgnoresStaleCompletionFromOlderTask,
  testTaskStateMovesRunningJobIntoRecovery,
  testTaskStateRejectsMismatchedJobEvents,
  testTaskStateStopUsesOneTerminalPath,
  testTaskStateCanBootstrapManagedJobRecovery,
  testTaskStateDoesNotReviveTerminalTaskFromStaleRecovery,
  testTaskStateIgnoresUnknownAndOutOfOrderEvents,
  testBrowserCoreRegistersTaskStateWithoutAnotherGlobal,
  testCoreIndexExportsTaskStateWithoutBrowserGlobal,
];
