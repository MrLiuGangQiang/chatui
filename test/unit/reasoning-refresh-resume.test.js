'use strict';

const assert = require('assert');
const fs = require('fs');
const path = require('path');
const vm = require('vm');
const { JSDOM } = require('jsdom');
const displayHistory = require('../../client/app/display-history-workflow');

function testReasoningOnlyPendingItemRestoresAfterRefresh() {
  const dom = new JSDOM('<!doctype html><div id="messages"></div>');
  const document = dom.window.document;
  const session = { id: 'session-reasoning-refresh', messages: [], display: [] };
  const item = {
    id: 'display-reasoning-refresh',
    role: 'assistant',
    rawText: '',
    html: '',
    reasoningText: 'provider reasoning',
    keepReasoning: true,
    pending: '1',
    jobId: 'chatjob-refresh1',
    responseIndex: '1',
  };
  const activeChatJob = { id: item.jobId, displayItemId: item.id, responseIndex: item.responseIndex };
  const reasoningUpdates = [];
  const workflow = displayHistory.createDisplayHistoryWorkflow({
    state: { activeSessionId: session.id, sessions: [session], disposedSessionIds: new Set(), reasoningMode: false },
    $: id => document.getElementById(id),
    getActiveSession: () => session,
    makeDisplayItemId: () => 'display-created',
    persistSessionDisplay: () => {},
    loadImageJob: () => null,
    loadLatestChatJob: () => activeChatJob,
    loadPendingSubmit: () => null,
    isImagePendingDisplayItem: () => false,
    addDisplayItemNode: value => {
      const node = document.createElement('article');
      node.className = 'message assistant';
      node.dataset.displayItemId = value.id;
      node.dataset.responseIndex = value.responseIndex;
      document.getElementById('messages').appendChild(node);
      return node;
    },
    insertMessageNodeAtDisplayPosition: () => {},
    addMessage: () => null,
    updateMessage: () => {},
    updateMessageContentLight: () => {},
    updateReasoning: (node, text, options = {}) => reasoningUpdates.push({ node, text, options }),
    reconcileMessageActions: () => {},
    pendingFeedbackHtml: value => '<div class="pending-feedback">' + value + '</div>',
    isChatStatusText: () => false,
    isSessionBusy: () => true,
    getActiveRun: () => null,
    readMessageMetaText: () => '',
    sessionHasCompletedAssistantForResponse: () => false,
    clearChatJob: () => {},
    sanitizeStoredDisplayItem: value => value,
    compactDisplayItems: items => items,
    messageRecords: {},
    renderUserMessageWithAttachments: () => '',
    downloadAllImagesButtonHtml: '',
  });

  workflow.restorePendingDisplayItems(session, [item]);

  assert.strictEqual(reasoningUpdates.length, 1, 'a reasoning-only pending item must restore its thought content after refresh');
  assert.strictEqual(reasoningUpdates[0].text, 'provider reasoning');
  assert.strictEqual(reasoningUpdates[0].options.done, false);
  assert.strictEqual(reasoningUpdates[0].options.forceDisplay, true,
    'restored provider reasoning must not be hidden by the current thinking-mode setting');
  assert.strictEqual(session.display[0].jobId, item.jobId, 'the durable chat job must remain bound to the restored pending item');
  dom.window.close();
}

function testAppReasoningWrapperAllowsProviderReturnedThinkingWhenModeIsOff() {
  const app = fs.readFileSync(path.join(__dirname, '../../app.js'), 'utf8');
  const start = app.indexOf('function updateReasoning');
  const end = app.indexOf('function finishReasoning', start);
  assert.ok(start >= 0 && end > start, 'the app reasoning wrapper must exist');
  const source = app.slice(start, end).trim();
  const updates = [];
  const removals = [];
  const context = {
    state: { reasoningMode: false },
    forceRemoveReasoning: node => removals.push(node),
    getReasoningWorkflow: () => ({
      updateReasoning: (...args) => updates.push(args),
    }),
  };
  vm.runInNewContext(source + "; updateReasoning('message-node', 'provider reasoning', { forceDisplay: true });", context);
  assert.strictEqual(removals.length, 0, 'the outer app wrapper must not remove provider reasoning when thinking mode is off');
  assert.strictEqual(updates.length, 1, 'forceDisplay must pass through to the reasoning renderer');
}

module.exports = [
  testReasoningOnlyPendingItemRestoresAfterRefresh,
  testAppReasoningWrapperAllowsProviderReturnedThinkingWhenModeIsOff,
];
