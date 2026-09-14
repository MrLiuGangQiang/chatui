'use strict';

const assert = require('assert');
const { JSDOM } = require('jsdom');
const { compactDisplayItems } = require('../../client/app/session-persistence');
const displayHistory = require('../../client/app/display-history-workflow');
const messageRecords = require('../../client/app/message-records');

function testCompactDisplayItemsPreservesOutputStartedAcrossDuplicates() {
  const result = compactDisplayItems([
    { id: 'short', role: 'assistant', responseIndex: '1', rawText: '已输出', pending: '1', outputStarted: true },
    { id: 'long', role: 'assistant', responseIndex: '1', rawText: '已输出更多内容', pending: '1' },
  ]);
  assert.strictEqual(result.length, 1);
  assert.strictEqual(result[0].id, 'long', 'the richer duplicate should still win');
  assert.strictEqual(result[0].outputStarted, true,
    'outputStarted must survive identity compaction even when the selected duplicate lacks the field');

  const adjacent = compactDisplayItems([
    { role: 'assistant', responseIndex: '2', rawText: 'same', pending: '1' },
    { role: 'assistant', responseIndex: '2', rawText: 'same', pending: '1', outputStarted: true },
  ]);
  assert.strictEqual(adjacent[0].outputStarted, true,
    'outputStarted must also survive adjacent duplicate merging');
}

function createDisplayHistoryFixture({ item, node, sessionDisplay = [item], persistSessionDisplay = () => {}, addDisplayItemNode = () => { throw new Error('test expected the cached node to be reused'); } }) {
  const dom = new JSDOM('<!doctype html><main id="messages"></main>');
  const document = dom.window.document;
  const messages = document.getElementById('messages');
  if (node) messages.appendChild(node);
  const session = {
    id: 'session-output-started',
    messages: [],
    display: sessionDisplay,
  };
  const activeJob = item?.jobId
    ? { id: item.jobId, displayItemId: item.id, responseIndex: item.responseIndex }
    : null;
  const workflow = displayHistory.createDisplayHistoryWorkflow({
    state: {
      activeSessionId: session.id,
      sessions: [session],
      disposedSessionIds: new Set(),
      reasoningMode: false,
    },
    document,
    $: id => id === 'messages' ? messages : null,
    getActiveSession: () => session,
    loadImageJob: () => null,
    loadLatestChatJob: () => activeJob,
    loadPendingSubmit: () => null,
    isSessionBusy: () => true,
    getActiveRun: () => ({ stopped: false }),
    isImagePendingDisplayItem: () => false,
    sessionHasCompletedAssistantForResponse: () => false,
    clearChatJob: () => {},
    compactDisplayItems: items => items,
    persistSessionDisplay,
    makeDisplayItemId: () => 'display-generated',
    pendingFeedbackHtml: value => `<div class="pending-feedback">${value}</div>`,
    readMessageMetaText: () => '',
    sanitizeStoredDisplayItem: value => value,
    addDisplayItemNode,
    insertMessageNodeAtDisplayPosition: () => {},
    updateMessage: (target, html, options = {}) => {
      target.innerHTML = String(html || '');
      if (options.rawText !== undefined) target.dataset.rawText = String(options.rawText);
    },
    updateMessageContentLight: (target, text, options = {}) => {
      target.textContent = String(text || '');
      if (options.rawText !== undefined) target.dataset.rawText = String(options.rawText);
    },
    updateReasoning: () => {},
    reconcileMessageActions: () => {},
    addMessage: () => null,
    messageRecords,
    renderUserMessageWithAttachments: () => '',
    downloadAllImagesButtonHtml: '',
  });
  return { dom, session, messages, workflow };
}

function testRestoreClearsStaleOutputStartedOnReusedNode() {
  const dom = new JSDOM('<!doctype html><article class="message assistant"><div class="content"></div></article>');
  const node = dom.window.document.querySelector('.message');
  node.dataset.displayItemId = 'display-reset';
  node.dataset.jobId = 'chatjob-reset';
  node.dataset.responseIndex = '1';
  node.dataset.outputStarted = '1';
  const item = {
    id: 'display-reset',
    role: 'assistant',
    rawText: '正在处理 已等待 2 秒',
    html: '<div class="pending-feedback">正在处理 已等待 2 秒</div>',
    pending: '1',
    jobId: 'chatjob-reset',
    responseIndex: '1',
    outputStarted: false,
  };
  const fixture = createDisplayHistoryFixture({ item, node });
  try {
    fixture.workflow.restorePendingDisplayItems(fixture.session, [item]);
    assert.strictEqual(node.dataset.outputStarted, undefined,
      'restoring a pre-output item must remove a stale output-started marker from the reused DOM node');
  } finally {
    fixture.dom.window.close();
    dom.window.close();
  }
}

function testRestoreWithoutDomNodeDoesNotCrashOnOutputStartedItem() {
  const item = {
    id: 'display-no-node',
    role: 'assistant',
    rawText: 'partial answer',
    pending: '1',
    responseIndex: '',
    outputStarted: true,
  };
  const fixture = createDisplayHistoryFixture({
    item,
    node: null,
    addDisplayItemNode: () => null,
  });
  try {
    assert.doesNotThrow(() => fixture.workflow.restorePendingDisplayItems(fixture.session, [item]),
      'missing DOM projection must not crash while applying outputStarted state');
  } finally {
    fixture.dom.window.close();
  }
}

function testRestoreDropsBlankPendingItemWithoutAResolvableJob() {
  const item = { id: 'display-empty', role: 'assistant', rawText: '', html: '', pending: '1', responseIndex: '1' };
  const fixture = createDisplayHistoryFixture({
    item,
    node: null,
    addDisplayItemNode: () => { throw new Error('a blank pending item must not be rendered'); },
  });
  try {
    fixture.workflow.restorePendingDisplayItems(fixture.session, [item]);
    assert.strictEqual(fixture.session.display.length, 0, 'a blank pending item without a job must be discarded');
  } finally {
    fixture.dom.window.close();
  }
}

function testSaveDisplayHistoryCapturesOutputStartedFromDom() {
  const dom = new JSDOM('<!doctype html><main id="messages"><article class="message assistant"><div class="content">partial answer</div></article></main>');
  const node = dom.window.document.querySelector('.message');
  node.dataset.displayItemId = 'display-dom';
  node.dataset.jobId = 'chatjob-dom';
  node.dataset.responseIndex = '1';
  node.dataset.rawText = 'partial answer';
  node.dataset.outputStarted = '1';
  const item = {
    id: 'display-dom',
    role: 'assistant',
    rawText: 'partial answer',
    pending: '1',
    jobId: 'chatjob-dom',
    responseIndex: '1',
    outputStarted: true,
  };
  let persisted = 0;
  const fixture = createDisplayHistoryFixture({ item, node, persistSessionDisplay: () => { persisted += 1; } });
  // Force the DOM projection to be the source selected by saveDisplayHistory;
  // otherwise the cached __displayItem would mask a missing DOM field.
  node.__displayItem = null;
  try {
    fixture.workflow.saveDisplayHistory();
    assert.strictEqual(fixture.session.display[0].outputStarted, true,
      'DOM checkpoint serialization must retain the output-started phase');
    assert.strictEqual(persisted, 1);
  } finally {
    fixture.dom.window.close();
    dom.window.close();
  }
}


function testSaveDisplayHistoryPersistsOutputStartedOnlyStateChanges() {
  const dom = new JSDOM('<!doctype html><main id="messages"><article class="message assistant"><div class="content">partial answer</div></article></main>');
  const node = dom.window.document.querySelector('.message');
  node.dataset.displayItemId = 'display-dom-toggle';
  node.dataset.jobId = 'chatjob-dom-toggle';
  node.dataset.responseIndex = '1';
  node.dataset.rawText = 'partial answer';
  const item = {
    id: 'display-dom-toggle',
    role: 'assistant',
    rawText: 'partial answer',
    pending: '1',
    jobId: 'chatjob-dom-toggle',
    responseIndex: '1',
    outputStarted: false,
  };
  let persisted = 0;
  const fixture = createDisplayHistoryFixture({ item, node, persistSessionDisplay: () => { persisted += 1; } });
  node.__displayItem = null;
  try {
    fixture.workflow.saveDisplayHistory();
    node.dataset.outputStarted = '1';
    fixture.workflow.saveDisplayHistory();
    assert.strictEqual(fixture.session.display[0].outputStarted, true,
      'a DOM-only output phase transition must update the persisted display item');
    assert.strictEqual(persisted, 2,
      'the display snapshot key must include outputStarted so a phase-only change is not skipped');
  } finally {
    fixture.dom.window.close();
    dom.window.close();
  }
}

module.exports = [
  testRestoreWithoutDomNodeDoesNotCrashOnOutputStartedItem,
  testCompactDisplayItemsPreservesOutputStartedAcrossDuplicates,
  testRestoreClearsStaleOutputStartedOnReusedNode,
  testRestoreDropsBlankPendingItemWithoutAResolvableJob,
  testSaveDisplayHistoryCapturesOutputStartedFromDom,
  testSaveDisplayHistoryPersistsOutputStartedOnlyStateChanges,
];
