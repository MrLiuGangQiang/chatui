const assert = require('assert');
const fs = require('fs');
const path = require('path');
const displayHistory = require('../../client/app/display-history-workflow');
const messageRecords = require('../../client/app/message-records');
const sessionDisplay = require('../../client/app/session-display');

async function testCompletedReasoningIsPersistedWhenFutureReasoningIsDisabled() {
  const session = { id: 'reasoning-history', title: 'Session', messages: [], display: [] };
  const state = { sessions: [session], activeSessionId: session.id, reasoningMode: false };
  const storage = { getItem: () => null, setItem: () => {}, removeItem: () => {} };
  const workflow = sessionDisplay.createSessionDisplayWorkflow({
    getState: () => state,
    deriveSessionTitle: current => current.title || 'Session',
    compactAdjacentDuplicateMessages: items => items,
    sanitizeStoredMessage: message => message,
    messageRecords,
    localStorage: storage,
    snapshotStore: { supported: false, schedulePut: async () => {} },
  });

  await workflow.saveSessionMessages(session.id, [{
    role: 'assistant',
    content: 'Answer',
    reasoning_content: 'Persist this completed reasoning trace.',
    responseIndex: '0',
  }]);

  assert.strictEqual(
    session.messages[0].reasoning_content,
    'Persist this completed reasoning trace.',
    'disabling reasoning for future requests must not delete completed reasoning from canonical history'
  );
}

function testCompletedReasoningRendersAfterRefreshWhenReasoningIsDisabled() {
  const state = { activeSessionId: 'reasoning-history', reasoningMode: false };
  const reasoningCalls = [];
  const workflow = displayHistory.createDisplayHistoryWorkflow({
    state,
    messageRecords,
    displayItemHasRichMedia: () => false,
    extractQuoteContextFromHtml: () => '',
    addMessage: () => ({ dataset: {} }),
    updateReasoning: (node, content, options) => reasoningCalls.push({ node, content, options }),
  });

  workflow.renderMessageFromCanonical({ id: state.activeSessionId }, {
    role: 'assistant',
    content: 'Answer',
    reasoning_content: 'Restored reasoning trace.',
    responseIndex: '0',
  }, 0);

  assert.strictEqual(reasoningCalls.length, 1, 'saved reasoning should be restored even if the composer is currently disabled');
  assert.strictEqual(reasoningCalls[0].content, 'Restored reasoning trace.');
  assert.deepStrictEqual(reasoningCalls[0].options, { done: true, keepReasoning: true, restoreHistory: true });
}

function testHistoryRestoreBypassesOnlyTheNewRequestReasoningGuard() {
  const reasoningSource = fs.readFileSync(path.join(__dirname, '../../client/app/reasoning-workflow.js'), 'utf8');
  const appSource = fs.readFileSync(path.join(__dirname, '../../app.js'), 'utf8');

  assert.ok(
    reasoningSource.includes('if(!state.reasoningMode&&!s.restoreHistory){forceRemoveReasoning(e); return;}'),
    'the reasoning renderer must allow explicit completed-history restoration while keeping new request reasoning disabled'
  );
  assert.ok(
    appSource.includes('function updateReasoning(e,t,s={}){if(!state.reasoningMode&&!s.restoreHistory){forceRemoveReasoning(e);return}'),
    'the app-level reasoning wrapper must forward explicit completed-history restoration to the workflow'
  );
  assert.strictEqual(
    (reasoningSource.match(/if \(!state\.reasoningMode\) clearAllReasoningDisplays\(\);/g) || []).length,
    0,
    'changing the next-request reasoning preference must not clear completed response reasoning from the current view'
  );
}

module.exports = [
  testCompletedReasoningIsPersistedWhenFutureReasoningIsDisabled,
  testCompletedReasoningRendersAfterRefreshWhenReasoningIsDisabled,
  testHistoryRestoreBypassesOnlyTheNewRequestReasoningGuard,
];
