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

function testReasoningOnlyRestoreRemovesStaleWaitingStatus() {
  const dom = new JSDOM('<!doctype html><div id=messages></div>');
  const document = dom.window.document;
  const session = { id: 'session-reasoning-waiting', messages: [], display: [] };
  const waitText = '正在处理 已等待 18 秒';
  const item = {
    id: 'display-reasoning-waiting',
    role: 'assistant',
    rawText: '',
    html: '<div class=pending-feedback>' + waitText + '</div>',
    reasoningText: 'provider reasoning in progress',
    keepReasoning: true,
    pending: '1',
    jobId: 'chatjob-reasoning-waiting',
    responseIndex: '1',
  };
  const activeChatJob = { id: item.jobId, displayItemId: item.id, responseIndex: item.responseIndex };
  const reasoningUpdates = [];
  const workflow = displayHistory.createDisplayHistoryWorkflow({
    state: { activeSessionId: session.id, sessions: [session], disposedSessionIds: new Set(), reasoningMode: true },
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
      node.innerHTML = '<div class=bubble><div class=content>' + value.html + '</div></div>';
      document.getElementById('messages').appendChild(node);
      return node;
    },
    insertMessageNodeAtDisplayPosition: () => {},
    addMessage: () => null,
    updateMessage: (node, html) => {
      node.querySelector('.content').innerHTML = String(html || '');
    },
    updateMessageContentLight: (node, text) => {
      node.querySelector('.content').textContent = String(text || '');
    },
    updateReasoning: (node, text, options = {}) => {
      reasoningUpdates.push({ node, text, options });
      const panel = document.createElement('section');
      panel.className = 'reasoning-panel reasoning-live-panel';
      panel.innerHTML = '<div class=reasoning-content>' + text + '</div>';
      node.querySelector('.bubble').prepend(panel);
    },
    reconcileMessageActions: () => {},
    pendingFeedbackHtml: value => '<div class=pending-feedback>' + value + '</div>',
    isChatStatusText: value => /^正在处理/.test(String(value || '')),
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

  const node = document.getElementById('messages').querySelector('.message.assistant');
  assert.ok(node.querySelector('.reasoning-panel'), 'streaming reasoning must be restored');
  assert.strictEqual(node.querySelector('.pending-feedback'), null,
    'a restored reasoning stream must not keep the stale elapsed-waiting status');
  assert.strictEqual(node.dataset.pendingFeedback, undefined,
    'an output-started pending item must not be marked as waiting again');
  assert.strictEqual(item.html, '', 'stale waiting HTML must be removed from the recoverable display item');
  assert.strictEqual(item.outputStarted, true,
    'reasoning-only snapshots must recover to the output phase even when legacy snapshots omitted outputStarted');
  assert.strictEqual(reasoningUpdates.length, 1);
  dom.window.close();
}

module.exports = [
  testReasoningOnlyPendingItemRestoresAfterRefresh,
  testAppReasoningWrapperAllowsProviderReturnedThinkingWhenModeIsOff,
  testReasoningOnlyRestoreRemovesStaleWaitingStatus,
];
