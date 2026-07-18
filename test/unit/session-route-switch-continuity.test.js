'use strict';

const assert = require('assert');
const fs = require('fs');
const path = require('path');
const vm = require('vm');
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

function testPendingSessionDomCacheUsesStableOwnershipIdentity() {
  const root = path.join(__dirname, '../..');
  const app = fs.readFileSync(path.join(root, 'app.js'), 'utf8');
  const signatureStart = app.indexOf('function sessionDomCacheSignature(');
  const signatureEnd = app.indexOf('function sessionNeedsDomContinuity(', signatureStart);
  const signatureSource = app.slice(signatureStart, signatureEnd);
  const sessionDomCacheSignature = vm.runInNewContext(`(${signatureSource})`, {
    messagesDomSignature: messages => JSON.stringify(messages || []),
  });
  const before = {
    messages: [{ role: 'user', content: 'question' }],
    display: [{ id: 'pending-submit-a', role: 'assistant', rawText: 'pending before handoff', html: '<div>old</div>', reasoningText: '', pending: '1', responseIndex: '', jobId: '' }],
  };
  const afterStreamUpdate = {
    messages: [{ role: 'user', content: 'question' }],
    display: [{ id: 'pending-submit-a', role: 'assistant', rawText: 'partial answer', html: '<div>new</div>', reasoningText: 'thinking', pending: '1', responseIndex: '1', jobId: 'chatjob-a' }],
  };

  assert.strictEqual(sessionDomCacheSignature(before), sessionDomCacheSignature(afterStreamUpdate), 'mutable pending text, reasoning, indexes, and handoff metadata must reconcile into the cached node instead of invalidating the whole DOM');
  assert.notStrictEqual(sessionDomCacheSignature(before), sessionDomCacheSignature({ ...afterStreamUpdate, messages: [...afterStreamUpdate.messages, { role: 'assistant', content: 'done' }] }), 'canonical history changes must invalidate a stale pending DOM cache');
  assert.notStrictEqual(sessionDomCacheSignature(before), sessionDomCacheSignature({ ...afterStreamUpdate, display: [{ ...afterStreamUpdate.display[0], id: 'pending-submit-b' }] }), 'a different pending owner must not reuse another task DOM');
  assert.notStrictEqual(sessionDomCacheSignature(before), sessionDomCacheSignature({ ...afterStreamUpdate, display: [{ ...afterStreamUpdate.display[0], pending: '0' }] }), 'completion must invalidate the pending-only cache projection');

  const discardStart = app.indexOf('function discardSessionDomCacheEntry(');
  const discardEnd = app.indexOf('function captureActiveSessionDom(', discardStart);
  const discardSource = app.slice(discardStart, discardEnd);
  const sessionDomCache = new Map([['session-a', { fragment: { containsBlobUrls: true } }]]);
  const discardSessionDomCacheEntry = vm.runInNewContext(`(${discardSource})`, { sessionDomCache });
  assert.doesNotThrow(() => discardSessionDomCacheEntry('session-a'), 'cache invalidation must not call a resource-lifecycle method that the cache does not own');
  assert.strictEqual(sessionDomCache.has('session-a'), false);
  assert.ok(!discardSource.includes('revokeObjectUrlsInNode'), 'shared media object URLs remain owned by the media workflow, not by detached DOM cache entries');
  assert.ok(app.includes('t&&(sessionNeedsDomContinuity(t)?captureActiveSessionDom(t.id):discardSessionDomCacheEntry(t.id))'), 'only sessions with an active durable task owner should retain detached DOM');
}

function testSessionSwitchRecoveryRebindsWithoutDuplicateExecution() {
  const root = path.join(__dirname, '../..');
  const app = fs.readFileSync(path.join(root, 'app.js'), 'utf8');
  const submit = fs.readFileSync(path.join(root, 'client/app/submit-workflow.js'), 'utf8');
  const index = fs.readFileSync(path.join(root, 'index.html'), 'utf8');

  const resumeStart = app.indexOf('function resumeSessionJobs');
  const activeRunGuard = app.indexOf('isLiveRun?.(liveRun)', resumeStart);
  const durableJobLookup = app.indexOf('const liveImageJob=loadImageJob(e),liveChatJob=loadLatestChatJob(e)', resumeStart);
  const pendingSubmitLookup = app.indexOf('const pendingSubmit=', resumeStart);
  assert.ok(resumeStart >= 0 && activeRunGuard > resumeStart && durableJobLookup > activeRunGuard && pendingSubmitLookup > durableJobLookup, 'a live run may inspect its own durable job only to rebind UI, but must return before pending-submit or recovery replay');
  assert.ok(app.includes('liveRun.jobIds?.has(`image:${liveImageJob.id}`)') && app.includes('liveRun.jobIds?.has(`chat:${liveChatJob.id}`)'), 'live-run rebinding must be restricted to job ids already owned by that run');
  assert.ok(submit.includes('beginPendingSubmitResume?.(deps.state, sessionId)') && submit.includes('finishPendingSubmitResume?.(deps.state, sessionId)'), 'pending-submit recovery must hold a per-session single-flight owner');
  assert.ok(submit.includes('(!assistantNode||!assistantNode.isConnected)') && submit.includes('findMessageNodeByDisplayItem(liveItem)||assistantNode'), 'dispatch must rebind the assistant node rendered after switching back');
  assert.ok(app.includes('updateLiveDisplay(e,n,"assistant",l'), 'intent-recognition stage updates must target the currently rendered display item, not a detached pre-switch node');
  assert.ok(index.includes('runs.js?v=1.2.66-session-run-owner') && index.includes('submit-workflow.js?v=1.2.82-canonical-task-state') && index.includes('app.js?v=2.1.28-canonical-task-state') && index.includes('chatui.bundle.js?v=1.3.115-canonical-task-state'), 'browser cache versions must deliver the session-run ownership fix');
}

module.exports = [
  testLiveRunOwnsPendingSubmitAcrossSessionSwitches,
  testPendingSubmitRecoveryIsSingleFlightAfterReload,
  testStoppedOrAbortedRunDoesNotBlockDurableRecovery,
  testPendingSessionDomCacheUsesStableOwnershipIdentity,
  testSessionSwitchRecoveryRebindsWithoutDuplicateExecution,
];
