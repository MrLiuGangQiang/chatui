'use strict';

const assert = require('assert');
const fs = require('fs');
const path = require('path');
const jobWorkflow = require('../../client/app/job-workflow');
const displayHistoryWorkflow = require('../../client/app/display-history-workflow');
const sessionPersistence = require('../../client/app/session-persistence');

function makeStorage(values = {}) {
  const data = new Map(Object.entries(values));
  return {
    getItem(key) { return data.has(key) ? data.get(key) : null; },
    setItem(key, value) { data.set(key, String(value)); },
    removeItem(key) { data.delete(key); },
  };
}

function jobDeps(storage, sessions) {
  return {
    storage,
    sessions,
    sessionChatJobKey: sessionId => `chat:${sessionId}`,
    sessionImageJobKey: sessionId => `image:${sessionId}`,
    isImagePendingDisplayItem: () => false,
    hasCompletedAssistantForResponse: () => false,
  };
}

function testDurableChatJobWinsOverLaggingDisplayJobId() {
  const stored = {
    id: 'chatjob-durable',
    payload: { model: 'gpt-5', messages: [{ role: 'user', content: 'continue' }] },
    displayItemId: 'display-durable',
    responseIndex: 3,
  };
  const storage = makeStorage({ 'chat:session-a': JSON.stringify(stored) });
  const sessions = [{
    id: 'session-a',
    display: [{ id: 'display-stale', jobId: 'chatjob-stale', pending: '1', responseIndex: '3' }],
  }];

  const recovered = jobWorkflow.loadLatestChatJob('session-a', jobDeps(storage, sessions));

  assert.strictEqual(recovered.id, 'chatjob-durable', 'a stale display job id must not replace the durable job id');
  assert.deepStrictEqual(recovered.payload, stored.payload, 'the resumable request payload must be retained');
  assert.strictEqual(recovered.displayItemId, 'display-stale', 'the matching response display item should still be used as the UI anchor');
  assert.strictEqual(String(recovered.responseIndex), '3');
}

function testUnrelatedDisplayFallbackCannotDiscardDurableChatPayload() {
  const stored = {
    id: 'chatjob-durable',
    payload: { model: 'gpt-5', messages: [{ role: 'user', content: 'recover me' }] },
    displayItemId: 'display-durable',
    responseIndex: 4,
  };
  const storage = makeStorage({ 'chat:session-a': JSON.stringify(stored) });
  const sessions = [{
    id: 'session-a',
    display: [{ id: 'unrelated-display', jobId: 'chatjob-other', pending: '1', responseIndex: '9' }],
  }];

  const recovered = jobWorkflow.loadLatestChatJob('session-a', jobDeps(storage, sessions));

  assert.strictEqual(recovered.id, stored.id);
  assert.deepStrictEqual(recovered.payload, stored.payload);
  assert.strictEqual(recovered.displayItemId, stored.displayItemId);
  assert.strictEqual(recovered.responseIndex, stored.responseIndex);
}

function testPendingDisplayIsReconciledBeforeStaleCleanup() {
  let clearCalls = 0;
  let persistCalls = 0;
  const state = { activeSessionId: 'other-session', reasoningMode: false };
  const session = {
    id: 'session-a',
    messages: [
      { role: 'user', content: 'original question' },
      { role: 'assistant', content: 'original answer' },
    ],
    display: [{ id: 'display-stale', jobId: 'chatjob-stale', pending: '1', responseIndex: '1', role: 'assistant', rawText: 'pending response' }],
  };
  const workflow = displayHistoryWorkflow.createDisplayHistoryWorkflow({
    state,
    getActiveSession: () => null,
    loadImageJob: () => null,
    loadLatestChatJob: () => ({ id: 'chatjob-durable', displayItemId: 'display-durable', responseIndex: 1 }),
    isSessionBusy: () => false,
    getActiveRun: () => null,
    isChatStatusText: () => false,
    clearChatJob: () => { clearCalls += 1; },
    isImagePendingDisplayItem: () => false,
    sessionHasCompletedAssistantForResponse: () => false,
    compactDisplayItems: items => items,
    persistSessionDisplay: () => { persistCalls += 1; },
    makeDisplayItemId: () => 'generated-display',
    $: () => ({ querySelectorAll: () => [] }),
    addDisplayItemNode: () => { throw new Error('non-active restore must not render DOM'); },
  });

  workflow.restorePendingDisplayItems(session, session.display);

  assert.strictEqual(clearCalls, 0, 'an explicit active chat job must survive completed-message count heuristics');
  assert.strictEqual(session.display.length, 1, 'a lagging pending display item must not be discarded');
  assert.strictEqual(session.display[0].jobId, 'chatjob-durable', 'the stale display anchor must be linked to the durable chat job');
  assert.ok(persistCalls >= 1, 'the repaired pending job/display link must be persisted');
}

function testQuotaFailureRetainsPreviousResumableJob() {
  const previous = JSON.stringify({ id: 'chatjob-previous', payload: { model: 'gpt-5' } });
  let stored = previous;
  const quotaStorage = {
    setItem() { const error = new Error('QuotaExceededError'); error.name = 'QuotaExceededError'; throw error; },
    getItem() { return stored; },
    removeItem() { stored = null; },
  };

  const originalWarn = console.warn;
  console.warn = () => {};
  try {
    sessionPersistence.safeSetJobStorage('chat:session-a', {
      id: 'chatjob-next',
      payload: { model: 'gpt-5', messages: [{ role: 'user', content: 'large pending request' }] },
    }, { storage: quotaStorage });
  } finally {
    console.warn = originalWarn;
  }

  assert.strictEqual(stored, previous, 'a quota failure must not erase the only recovery record for an in-flight task');
}

function testSwitchAvoidsDuplicateResumeForLiveRunAndPendingCleanupReconciles() {
  const resumeSource = fs.readFileSync(path.join(__dirname, '../../client/app/job-resume-workflow.js'), 'utf8');
  const displaySource = fs.readFileSync(path.join(__dirname, '../../client/app/display-history-workflow.js'), 'utf8');

  assert.ok(resumeSource.includes('activeRun=state.activeRuns?.get(e),hasLiveRun=!!(activeRun&&!activeRun.stopped&&activeRun.jobIds?.has(`chat:${s.id}`))'), 'returning to a switched session must bind its existing in-memory stream instead of opening a duplicate recovery stream');
  assert.ok(displaySource.includes('if (hasCompletePair && !activeChatJob?.id) clearChatJob(session.id);'), 'message-count cleanup must not discard an explicitly persisted active chat job');
  assert.ok(displaySource.includes("if (item?.pending === '1' && matchesActiveChatJob(item)) item.jobId = activeChatJob.id;"), 'a lagging pending display snapshot must be re-linked to the durable job before stale cleanup');
}

module.exports = [
  testDurableChatJobWinsOverLaggingDisplayJobId,
  testUnrelatedDisplayFallbackCannotDiscardDurableChatPayload,
  testPendingDisplayIsReconciledBeforeStaleCleanup,
  testQuotaFailureRetainsPreviousResumableJob,
  testSwitchAvoidsDuplicateResumeForLiveRunAndPendingCleanupReconciles,
];
