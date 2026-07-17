'use strict';

const assert = require('assert');
const fs = require('fs');
const path = require('path');
const runs = require('../../client/app/runs');

function stateWithRun(run = null) {
  return {
    activeRuns: new Map(run ? [['session-a', run]] : []),
    resumingJobs: new Set(),
  };
}

function testLiveRunOwnsPendingSubmitAcrossSessionSwitches() {
  const run = runs.makeRun('session-a', () => 1, () => 0.5);
  const state = stateWithRun(run);

  assert.strictEqual(runs.isLiveRun(run), true);
  assert.strictEqual(runs.beginPendingSubmitResume(state, 'session-a'), '', 'an in-memory route/chat run must remain the sole owner after switching back');
  assert.deepStrictEqual([...state.resumingJobs], [], 'blocked recovery must not leave a stale resume marker');
}

function testPendingSubmitRecoveryIsSingleFlightAfterReload() {
  const state = stateWithRun();
  const firstKey = runs.beginPendingSubmitResume(state, 'session-a');

  assert.strictEqual(firstKey, 'submit:session-a');
  assert.strictEqual(runs.beginPendingSubmitResume(state, 'session-a'), '', 'repeated switch/visibility recovery must not start a second pending submit');
  runs.finishPendingSubmitResume(state, 'session-a');
  assert.strictEqual(runs.beginPendingSubmitResume(state, 'session-a'), 'submit:session-a', 'recovery ownership should be reusable after the prior attempt finishes');
  runs.finishPendingSubmitResume(state, 'session-a');
}

function testStoppedOrAbortedRunDoesNotBlockDurableRecovery() {
  const stopped = runs.makeRun('session-a', () => 2, () => 0.5);
  stopped.stopped = true;
  assert.strictEqual(runs.isLiveRun(stopped), false);

  const aborted = runs.makeRun('session-a', () => 3, () => 0.5);
  aborted.abortController.abort();
  assert.strictEqual(runs.isLiveRun(aborted), false);

  const state = stateWithRun(aborted);
  assert.strictEqual(runs.beginPendingSubmitResume(state, 'session-a'), 'submit:session-a');
  runs.finishPendingSubmitResume(state, 'session-a');
}

function testSessionSwitchRecoveryRebindsWithoutDuplicateExecution() {
  const root = path.join(__dirname, '../..');
  const app = fs.readFileSync(path.join(root, 'app.js'), 'utf8');
  const submit = fs.readFileSync(path.join(root, 'client/app/submit-workflow.js'), 'utf8');
  const index = fs.readFileSync(path.join(root, 'index.html'), 'utf8');

  const resumeStart = app.indexOf('function resumeSessionJobs');
  const activeRunGuard = app.indexOf('isLiveRun?.(getActiveRun(e))', resumeStart);
  const durableJobLookup = app.indexOf('loadImageJob(e)', resumeStart);
  assert.ok(resumeStart >= 0 && activeRunGuard > resumeStart && activeRunGuard < durableJobLookup, 'session recovery must stop before pending-submit or job replay when the original run is still alive');
  assert.ok(submit.includes('beginPendingSubmitResume?.(deps.state, sessionId)') && submit.includes('finishPendingSubmitResume?.(deps.state, sessionId)'), 'pending-submit recovery must hold a per-session single-flight owner');
  assert.ok(submit.includes('(!assistantNode||!assistantNode.isConnected)') && submit.includes('findMessageNodeByDisplayItem(liveItem)||assistantNode'), 'dispatch must rebind the assistant node rendered after switching back');
  assert.ok(app.includes('updateLiveDisplay(e,n,"assistant",l'), 'intent-recognition stage updates must target the currently rendered display item, not a detached pre-switch node');
  assert.ok(index.includes('runs.js?v=1.2.66-session-run-owner') && index.includes('submit-workflow.js?v=1.2.79-task-lifecycle-state-machine') && index.includes('app.js?v=2.1.25-task-lifecycle-state-machine') && index.includes('chatui.bundle.js?v=1.3.112-task-lifecycle-state-machine'), 'browser cache versions must deliver the session-run ownership fix');
}

module.exports = [
  testLiveRunOwnsPendingSubmitAcrossSessionSwitches,
  testPendingSubmitRecoveryIsSingleFlightAfterReload,
  testStoppedOrAbortedRunDoesNotBlockDurableRecovery,
  testSessionSwitchRecoveryRebindsWithoutDuplicateExecution,
];
