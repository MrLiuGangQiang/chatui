'use strict';

const assert = require('assert');
const { JSDOM } = require('jsdom');
const displayHistory = require('../../client/app/display-history-workflow');

function createFixture({ itemRawText, itemHtml, job }) {
  const dom = new JSDOM('<main id="messages"></main>');
  const document = dom.window.document;
  const container = document.getElementById('messages');
  const session = { id: 'A', messages: [{ role: 'user' }, { role: 'assistant', content: 'ok' }], display: [] };
  const item = {
    id: 'pending-1',
    role: 'assistant',
    rawText: itemRawText,
    html: itemHtml || `<div class="pending-feedback">${itemRawText}</div>`,
    pending: '1',
    jobId: 'img-1',
    responseIndex: '1',
  };
  session.display.push(item);
  const workflow = displayHistory.createDisplayHistoryWorkflow({
    state: { activeSessionId: 'A' },
    $: id => document.getElementById(id),
    document,
    loadImageJob: () => job,
    loadLatestChatJob: () => null,
    loadPendingSubmit: () => null,
    isSessionBusy: () => true,
    getActiveRun: () => ({ id: 'run-a' }),
    isChatStatusText: text => /已等待|正在生成图片|正在修改图片|正在处理|正在恢复/.test(String(text || '')),
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
      if (item.responseIndex) node.dataset.responseIndex = String(item.responseIndex);
      node.textContent = item.rawText || '';
      container.appendChild(node);
      return node;
    },
    updateMessage: (node, content, options) => {
      node.textContent = String(content).replace(/<[^>]+>/g, '');
      if (options && options.rawText !== undefined) node.dataset.rawText = options.rawText;
    },
    updateMessageContentLight: (node, text, options) => {
      node.textContent = text;
      if (options && options.rawText !== undefined) node.dataset.rawText = options.rawText;
    },
    updateReasoning: () => {},
  });
  return { dom, session, workflow };
}

function testSwitchBackDoesNotDowngradeLiveImageStatusToZeroSeconds() {
  // A live image run is still ticking: the persisted display item already
  // carries a real elapsed status (42s). The durable job snapshot missing
  // startedAt must not project "已等待 0 秒" over the live status when the user
  // switches back to the generating session.
  const { dom, session, workflow } = createFixture({
    itemRawText: '正在生成图片… 已等待 42 秒',
    job: { id: 'img-1', mode: 'image' }, // no startedAt
  });
  try {
    workflow.restorePendingDisplayItems(session, [session.display[0]]);
    const restored = session.display[0];
    assert.strictEqual(
      restored.rawText,
      '正在生成图片… 已等待 42 秒',
      'switching back must not overwrite a live elapsed status with a zero-second projection',
    );
  } finally {
    dom.window.close();
  }
}

function testRestoreStillRefreshesStaleStatusFromDurableJobStartedAt() {
  // Refresh recovery remains intact: when the persisted status is stale (5s)
  // and the durable job has a real startedAt (30s ago), the projection is
  // allowed to advance the status to the correct elapsed time.
  const startedAt = Date.now() - 30000;
  const { dom, session, workflow } = createFixture({
    itemRawText: '正在生成图片… 已等待 5 秒',
    job: { id: 'img-1', mode: 'image', startedAt },
  });
  try {
    workflow.restorePendingDisplayItems(session, [session.display[0]]);
    const restored = session.display[0];
    const match = /已等待\s*(\d+)\s*秒/.exec(restored.rawText);
    assert.ok(match, 'the restored image status must keep an elapsed-seconds marker');
    assert.ok(
      Number(match[1]) >= 25,
      `the projection must advance a stale status toward the durable job elapsed time, got ${match[1]}s`,
    );
  } finally {
    dom.window.close();
  }
}

module.exports = [
  testSwitchBackDoesNotDowngradeLiveImageStatusToZeroSeconds,
  testRestoreStillRefreshesStaleStatusFromDurableJobStartedAt,
];
