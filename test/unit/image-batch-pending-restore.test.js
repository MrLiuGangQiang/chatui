'use strict';

const assert = require('assert');
const fs = require('fs');
const path = require('path');
const { JSDOM } = require('jsdom');
const displayHistory = require('../../client/app/display-history-workflow');
const messageRecords = require('../../client/app/message-records');
const jobWorkflow = require('../../client/app/job-workflow');

function createBatchFixture({ batchRawText, completedMessages = [] }) {
  const dom = new JSDOM('<main id="messages"></main>');
  const document = dom.window.document;
  const container = document.getElementById('messages');
  const session = { id: 'A', messages: completedMessages, display: [] };
  const item = {
    id: 'batch-parent-1',
    role: 'assistant',
    rawText: batchRawText,
    html: '<div class="generated-image-batch-grid" data-image-batch-total="2"><div class="generated-image-batch-slot">正在生成图片</div><div class="generated-image-batch-slot">正在生成图片</div></div>',
    pending: '1',
    jobId: 'imgbatch-g1ke9dfe2l',
    responseIndex: '1',
    imageContext: '',
    attachmentContext: '',
    quoteContext: '',
    metaText: '',
  };
  session.display.push(item);
  const workflow = displayHistory.createDisplayHistoryWorkflow({
    state: { activeSessionId: 'A' },
    $: id => document.getElementById(id),
    document,
    loadImageJob: () => null,
    loadLatestChatJob: () => null,
    loadPendingSubmit: () => null,
    isSessionBusy: () => true,
    getActiveRun: () => ({ id: 'run-a' }),
    isChatStatusText: text => /已等待|正在生成图片|正在修改图片|正在处理|正在恢复|任务\s*\d+(?:\/\d+)?：|图\s*片\s*生\s*成\s*完\s*成/.test(String(text || '')),
    isImagePendingDisplayItem: item => !!item.imageContext || /正在生成图片|正在修改图片|正在恢复图片生成任务|正在恢复图片修改任务/.test(String(item.rawText || '')),
    sessionHasCompletedAssistantForResponse: () => false,
    clearChatJob: () => {},
    persistSessionDisplay: () => {},
    makeDisplayItemId: () => 'item-new',
    compactDisplayItems: items => items,
    pendingFeedbackHtml: text => `<div class="pending-feedback">${text}</div>`,
    addDisplayItemNode: item => {
      const node = document.createElement('article');
      node.className = 'message assistant';
      node.__displayItem = item;
      if (item.id) node.dataset.displayItemId = item.id;
      if (item.jobId) node.dataset.jobId = item.jobId;
      const content = document.createElement('div');
      content.className = 'content';
      content.innerHTML = item.html || item.rawText || '';
      node.appendChild(content);
      container.appendChild(node);
      return node;
    },
    updateMessage: () => {},
    updateMessageContentLight: () => {},
    updateReasoning: () => {},
    messageRecords,
  });
  return { dom, session, workflow, container };
}

function appIsImagePendingDisplayItem() {
  const app = fs.readFileSync(path.join(__dirname, '..', '..', 'app.js'), 'utf8');
  const match = app.match(/function isImagePendingDisplayItem\([^)]*\)\{[^}]*\}/);
  assert.ok(match, 'app.js must define isImagePendingDisplayItem');
  // eslint-disable-next-line no-new-func
  return new Function(`return (${match[0]})`)();
}

function testSwitchBackKeepsInFlightImageBatchParentCard() {
  const fixture = createBatchFixture({ batchRawText: '任务 1/2：正在准备图片任务\n任务 2/2：正在准备图片任务' });
  try {
    fixture.workflow.restorePendingDisplayItems(fixture.session, [fixture.session.display[0]]);
    const kept = fixture.session.display.some(item => item.id === 'batch-parent-1');
    assert.strictEqual(kept, true, 'an in-flight batch parent card must survive a session switch restore');
    assert.ok(
      fixture.container.querySelector('.generated-image-batch-grid'),
      'the restored batch parent must render its multi-image slot grid',
    );
  } finally {
    fixture.dom.window.close();
  }
}

function testCompletedBatchParentIsNotRestoredAsPending() {
  const completed = {
    role: 'assistant',
    content: '[图片生成完成] 一只猫、一只狗',
    html: '<div class="generated-image-batch-grid">done</div>',
    rawText: '图片生成完成',
    responseIndex: '1',
    imageJobId: 'imgbatch-g1ke9dfe2l',
    imageContext: JSON.stringify({ schema_version: 'image_result.v1', resultId: 'imgres-1', attachments: [{ src: 'indexeddb://img-1', persistedSrc: 'indexeddb://img-1' }] }),
  };
  const fixture = createBatchFixture({
    batchRawText: '任务 1/2：正在准备图片任务\n任务 2/2：正在准备图片任务',
    completedMessages: [completed],
  });
  try {
    fixture.workflow.restorePendingDisplayItems(fixture.session, [fixture.session.display[0]]);
    const kept = fixture.session.display.some(item => item.id === 'batch-parent-1');
    assert.strictEqual(kept, false, 'a completed batch parent must be dropped rather than shown as pending');
  } finally {
    fixture.dom.window.close();
  }
}

function testLoadLatestChatJobDoesNotTreatBatchParentAsChatJob() {
  // An image-batch parent card must never be classified as a resumable chat
  // job, otherwise switching back runs resumeChatJob and paints the batch as a
  // generic '正在处理… 已等待 N 秒' status instead of its image slots.
  const isImagePendingDisplayItem = appIsImagePendingDisplayItem();
  const session = { id: 'A', display: [
    { id: 'batch-parent-1', role: 'assistant', rawText: '任务 1/2：正在准备图片任务\n任务 2/2：正在准备图片任务', pending: '1', jobId: 'imgbatch-g1ke9dfe2l', responseIndex: '1', imageContext: '' },
  ] };
  const chatJob = jobWorkflow.loadLatestChatJob('A', {
    sessionChatJobKey: () => 'chat-key',
    storage: { getItem: () => null },
    sessions: [session],
    isImagePendingDisplayItem,
  });
  assert.strictEqual(chatJob, null, 'a running image batch must not be surfaced as a resumable chat job');
}

module.exports = [
  testSwitchBackKeepsInFlightImageBatchParentCard,
  testCompletedBatchParentIsNotRestoredAsPending,
  testLoadLatestChatJobDoesNotTreatBatchParentAsChatJob,
];
