'use strict';

const assert = require('assert');
const fs = require('fs');
const path = require('path');
const jobWorkflow = require('../../client/app/job-workflow');
const displayHistoryWorkflow = require('../../client/app/display-history-workflow');
const sessionPersistence = require('../../client/app/session-persistence');
const displayItems = require('../../client/app/display-items');
const formatting = require('../../client/app/formatting');

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

function fakeMessageNode(role, index, rawText, { pending = false, jobId = '' } = {}) {
  return {
    classList: { contains(value) { return value === role; } },
    dataset: {
      rawText,
      ...(role === 'user' ? { messageIndex: String(index) } : { responseIndex: String(index) }),
      ...(pending ? { pendingFeedback: '1' } : {}),
      ...(jobId ? { jobId } : {}),
    },
    innerText: rawText,
    textContent: rawText,
    __displayItem: pending ? { pending: '1' } : null,
    querySelector(selector) { return pending && selector === '.pending-feedback' ? {} : null; },
  };
}

function testCanonicalTailVerificationIgnoresPendingFollower() {
  const userNode = fakeMessageNode('user', 1, 'question');
  const pendingNode = fakeMessageNode('assistant', 2, '\u6b63\u5728\u5904\u7406\u2026 \u5df2\u7b49\u5f85 1 \u79d2', { pending: true, jobId: 'chatjob-a' });
  const canonicalTail = { role: 'user', content: 'question', rawText: 'question', messageIndex: '1' };

  const matched = displayItems.findCanonicalMessageNode([userNode, pendingNode], canonicalTail, 1);

  const completedNodeWithStaleJobId = fakeMessageNode('user', 1, 'question', { jobId: 'completed-job' });
  assert.strictEqual(matched, userNode, 'a legitimate pending response after the canonical tail must not trigger a destructive history repair');
  assert.strictEqual(displayItems.findCanonicalMessageNode([pendingNode], canonicalTail, 1), null, 'pending nodes must never impersonate canonical history');
  assert.strictEqual(displayItems.findCanonicalMessageNode([completedNodeWithStaleJobId], canonicalTail, 1), completedNodeWithStaleJobId, 'stale completed-job metadata without streaming state must not make a canonical node look pending');
}

function testPendingOwnerProjectsImmediateStatusBeforeFirstResponse() {
  let renderedItem = null;
  let persistCalls = 0;
  const state = { activeSessionId: 'session-a', reasoningMode: false };
  const session = { id: 'session-a', messages: [], display: [] };
  const messagesNode = { querySelectorAll: () => [] };
  const workflow = displayHistoryWorkflow.createDisplayHistoryWorkflow({
    state,
    getActiveSession: () => session,
    loadImageJob: () => null,
    loadLatestChatJob: () => null,
    loadPendingSubmit: () => ({ submissionId: 'submit-a', stage: 'accepted', submitMode: 'chat', startedAt: Date.now() }),
    isSessionBusy: () => true,
    getActiveRun: () => ({ stopped: false }),
    isChatStatusText: formatting.isChatStatusText,
    clearChatJob: () => {},
    isImagePendingDisplayItem: () => false,
    sessionHasCompletedAssistantForResponse: () => false,
    compactDisplayItems: items => items,
    persistSessionDisplay: () => { persistCalls += 1; },
    pendingFeedbackHtml: formatting.pendingFeedbackHtml,
    makeDisplayItemId: () => 'generated-display',
    $: () => messagesNode,
    addDisplayItemNode: item => {
      renderedItem = item;
      return { dataset: {}, classList: { contains: () => false } };
    },
  });

  workflow.restorePendingDisplayItems(session, []);

  assert.ok(renderedItem, 'the durable pending owner must project a visible node immediately, before any upstream token arrives');
  assert.strictEqual(renderedItem.id, 'pending-submit-submit-a');
  assert.strictEqual(renderedItem.rawText, '\u6b63\u5728\u63a5\u6536\u4efb\u52a1\u2026');
  assert.strictEqual(renderedItem.pending, '1');
  assert.ok(renderedItem.html.includes('pending-feedback'));
  assert.strictEqual(session.display[0], renderedItem, 'the projected node must become the stable pending display owner');
  assert.ok(persistCalls >= 1, 'the immediate visual projection must be persisted for another switch or refresh');
}

function testCachedPendingProjectionReconcilesInPlace() {
  const startedAt = Date.now() - 5000;
  const item = {
    id: 'display-a',
    role: 'assistant',
    rawText: '\u6b63\u5728\u5904\u7406\u2026 \u5df2\u7b49\u5f85 1 \u79d2',
    html: formatting.pendingFeedbackHtml('\u6b63\u5728\u5904\u7406\u2026 \u5df2\u7b49\u5f85 1 \u79d2'),
    reasoningText: '',
    pending: '1',
    responseIndex: '1',
    jobId: 'chatjob-a',
  };
  const session = {
    id: 'session-a',
    messages: [{ role: 'user', content: 'question', messageIndex: '0' }],
    display: [item],
  };
  const node = {
    dataset: { displayItemId: item.id, jobId: item.jobId, responseIndex: item.responseIndex, rawText: item.rawText },
    __displayItem: item,
    classList: { contains: value => value === 'assistant' },
  };
  let addedNodes = 0;
  let updatedNode = null;
  const workflow = displayHistoryWorkflow.createDisplayHistoryWorkflow({
    state: { activeSessionId: session.id, reasoningMode: false },
    getActiveSession: () => session,
    loadImageJob: () => null,
    loadLatestChatJob: () => ({ id: item.jobId, displayItemId: item.id, responseIndex: 1, startedAt }),
    loadPendingSubmit: () => null,
    isSessionBusy: () => true,
    getActiveRun: () => ({ stopped: false }),
    isChatStatusText: formatting.isChatStatusText,
    clearChatJob: () => {},
    isImagePendingDisplayItem: () => false,
    sessionHasCompletedAssistantForResponse: () => false,
    compactDisplayItems: items => items,
    persistSessionDisplay: () => {},
    pendingFeedbackHtml: formatting.pendingFeedbackHtml,
    makeDisplayItemId: () => 'generated-display',
    $: () => ({ querySelectorAll: selector => selector === '.message' ? [node] : [] }),
    addDisplayItemNode: () => { addedNodes += 1; return node; },
    updateMessage: (target, html, options) => {
      updatedNode = target;
      target.dataset.rawText = options.rawText;
      target.renderedHtml = html;
    },
  });

  workflow.restorePendingDisplayItems(session, [item]);

  assert.strictEqual(addedNodes, 0, 'a restored pending task must update its cached node instead of creating a second bubble');
  assert.strictEqual(updatedNode, node);
  assert.match(item.rawText, /^\u6b63\u5728\u5904\u7406\u2026 \u5df2\u7b49\u5f85 [45] \u79d2$/, 'the cached task bubble should immediately catch up to current elapsed state');
  assert.strictEqual(node.dataset.streaming, '1');
  assert.strictEqual(node.dataset.streamKind, 'chat');
}

function testResumeCompletionKeepsExistingDomNode() {
  const resumeSource = fs.readFileSync(path.join(__dirname, '../../client/app/job-resume-workflow.js'), 'utf8');
  const appSource = fs.readFileSync(path.join(__dirname, '../../app.js'), 'utf8');
  assert.ok(!resumeSource.includes('forceRenderCanonicalMessages('), 'managed-job completion must settle the existing streamed node instead of clearing and rebuilding the whole page');
  assert.ok(appSource.includes('findCanonicalMessageNode?.(s.querySelectorAll(".message"),t,r)'), 'tail verification must locate the canonical node rather than assuming the last DOM node is canonical');
  assert.ok(appSource.includes('restorePendingDisplayItems(e,compactDisplayItems([...e?.display||[]])'), 'a real tail repair must restore pending task projections in the same render transaction');
}

module.exports = [
  testDurableChatJobWinsOverLaggingDisplayJobId,
  testUnrelatedDisplayFallbackCannotDiscardDurableChatPayload,
  testPendingDisplayIsReconciledBeforeStaleCleanup,
  testQuotaFailureRetainsPreviousResumableJob,
  testSwitchAvoidsDuplicateResumeForLiveRunAndPendingCleanupReconciles,
  testCanonicalTailVerificationIgnoresPendingFollower,
  testPendingOwnerProjectsImmediateStatusBeforeFirstResponse,
  testCachedPendingProjectionReconcilesInPlace,
  testResumeCompletionKeepsExistingDomNode,
];
