const fs = require('fs');
const path = require('path');
const assert = require('assert');
const { JSDOM } = require('jsdom');
const formatting = require('../../client/app/formatting');
const displayHistoryWorkflow = require('../../client/app/display-history-workflow');
const messageRecords = require('../../client/app/message-records');

function createDisplayHistoryWorkflow(state, session, overrides = {}) {
  return displayHistoryWorkflow.createDisplayHistoryWorkflow({
    state,
    getActiveSession: () => session,
    loadImageJob: () => null,
    loadLatestChatJob: () => ({ id: 'chatjob-live', displayItemId: 'display-live', responseIndex: 1 }),
    loadPendingSubmit: () => null,
    isSessionBusy: () => true,
    getActiveRun: () => ({ stopped: false }),
    isChatStatusText: formatting.isChatStatusText,
    clearChatJob: () => {},
    isImagePendingDisplayItem: () => false,
    sessionHasCompletedAssistantForResponse: () => false,
    compactDisplayItems: items => items,
    persistSessionDisplay: () => {},
    makeDisplayItemId: () => 'generated',
    pendingFeedbackHtml: formatting.pendingFeedbackHtml,
    readMessageMetaText: () => '',
    $: () => ({ querySelectorAll: () => [], appendChild() {} }),
    addDisplayItemNode: () => ({ dataset: {}, classList: { contains: () => false }, querySelector: () => null }),
    updateMessage: () => {},
    updateMessageContentLight: () => {},
    updateReasoning: () => {},
    addMessage: () => ({}),
    messageRecords,
    renderUserMessageWithAttachments: () => '',
    downloadAllImagesButtonHtml: () => '',
    ...overrides,
  });
}

function testStatusDetectionNeverClassifiesRealAnswerContent() {
  const realAnswers = [
    '请稍等，我来解释一下这个问题。第一段已经显示。',
    '好的，已收到你的补充说明，接下来分析如下：',
    '系统已等待配置完成，现在继续。',
    '正在进行的项目进展如下：第一步已完成。',
    '任务正在处理中，我会在完成后通知你。',
    '正在处理中的文件列表如下：a.txt、b.txt。',
    '正在思考的结论是：先做 A 再做 B。',
    '已收到的消息我们已经归档，无需重复发送。',
  ];
  for (const answer of realAnswers) {
    assert.strictEqual(formatting.isChatStatusText(answer), false,
      `real assistant content must never be classified as status: ${answer}`);
  }
  const appStatuses = [
    '正在接收任务…',
    '正在准备消息…',
    '正在识别任务…',
    '正在连接模型…',
    '正在启动图片任务…',
    '正在处理中 请稍后',
    '正在处理… 已等待 5 秒',
    '正在处理 已等待 12 秒',
    '正在思考',
    '正在恢复聊天任务…',
    '正在等待模型生成回答',
    '正在准备执行任务',
    '正在读取当前对话上下文',
    '正在比较所选图片',
    '正在基于参考图生成图片… 已等待 12 秒',
    '已收到',
    '请稍等',
    '已等待 5 秒',
    '已停止恢复',
    '恢复任务不存在或已失效，已停止恢复，请重新发送',
    '任务 1/2：正在生成图片\n任务 2/2：等待开始',
    '正在生成图片… 已等待 3 秒',
    '正在修改图片 已等待 3 秒',
  ];
  for (const status of appStatuses) {
    assert.strictEqual(formatting.isChatStatusText(status), true,
      `app-generated status must still be recognized: ${JSON.stringify(status)}`);
  }
}

function testRestoreKeepsPartialStreamedContentContainingStatusWords() {
  const partial = '请稍等，我来解释一下这个问题。第一段已经显示。';
  const state = { activeSessionId: 'session-a', reasoningMode: false };
  const session = {
    id: 'session-a',
    messages: [{ role: 'user', content: 'question', messageIndex: '0' }],
    display: [{
      id: 'display-live', role: 'assistant', rawText: partial,
      html: '', responseIndex: '1', jobId: 'chatjob-live', pending: '1',
    }],
  };
  const workflow = createDisplayHistoryWorkflow(state, session);

  workflow.restorePendingDisplayItems(session, session.display);

  assert.strictEqual(session.display.length, 1, 'the pending streamed item must survive refresh');
  assert.strictEqual(session.display[0].rawText, partial,
    'the partial streamed content must not be overwritten by a status projection on refresh');
  assert.strictEqual(session.display[0].pending, '1');
}

function testReloadHistoryKeepsRealAnswersContainingStatusWords() {
  // Replicates the loadChatHistory assistant filter that previously dropped
  // completed answers containing status-like words (e.g. "请稍等").
  const realAnswer = '好的，请稍等，我来解释一下这个问题。第一段已经显示。';
  const hasLiveChatJob = false;
  const kept = !formatting.isChatStatusText(realAnswer) || hasLiveChatJob;
  assert.strictEqual(kept, true,
    'a completed real answer containing "请稍等" must survive reload even without a live chat job');
}

function testRegenerationRefreshRendersOrderedMessagesAndPendingContent() {
  const partial = '新的部分回答已经输出，还在继续';
  const state = { activeSessionId: 'session-a', reasoningMode: false };
  const messages = [
    { role: 'user', content: 'q1', rawText: 'q1', messageIndex: '0' },
    { role: 'assistant', content: 'a1', rawText: 'a1', responseIndex: '1' },
    { role: 'user', content: 'q2', rawText: 'q2', messageIndex: '2' },
    { role: 'assistant', content: '正在恢复聊天任务…', rawText: '正在恢复聊天任务…', responseIndex: '3', regenerating: true },
    { role: 'user', content: 'q3', rawText: 'q3', messageIndex: '4' },
    { role: 'assistant', content: 'a3', rawText: 'a3', responseIndex: '5' },
  ];
  const session = {
    id: 'session-a',
    messages: messages.map(message => ({ ...message })),
    display: [{
      id: 'display-live', role: 'assistant', rawText: partial,
      html: '', responseIndex: '3', jobId: 'chatjob-live', pending: '1',
    }],
  };

  const dom = new JSDOM('<!doctype html><html><body><section id="messages"></section></body></html>');
  const messagesRoot = dom.window.document.getElementById('messages');
  const rendered = [];
  const workflow = createDisplayHistoryWorkflow(state, session, {
    $: id => id === 'messages' ? messagesRoot : null,
    addDisplayItemNode: item => {
      const node = dom.window.document.createElement('article');
      node.className = `message ${item.role || 'assistant'}`;
      const content = dom.window.document.createElement('div');
      content.className = 'content';
      content.textContent = item.html || item.rawText || '';
      node.appendChild(content);
      node.dataset.rawText = item.rawText || '';
      node.dataset.responseIndex = String(item.responseIndex != null ? item.responseIndex : '');
      node.__displayItem = item;
      rendered.push({ via: 'add', node });
      messagesRoot.appendChild(node);
      return node;
    },
    updateMessageContentLight: (node, rawText) => {
      node.dataset.rawText = String(rawText || '');
      node.querySelector('.content').textContent = String(rawText || '');
      rendered.push({ via: 'update', node });
    },
  });

  // Canonical render (as loadChatHistory would) then pending restore.
  for (let index = 0; index < session.messages.length; index += 1) {
    const message = session.messages[index];
    const node = dom.window.document.createElement('article');
    node.className = `message ${message.role}`;
    const content = dom.window.document.createElement('div');
    content.className = 'content';
    content.textContent = message.content || '';
    node.appendChild(content);
    node.dataset.rawText = message.rawText || message.content || '';
    if (message.role === 'user') node.dataset.messageIndex = String(message.messageIndex);
    else node.dataset.responseIndex = String(message.responseIndex);
    messagesRoot.appendChild(node);
  }

  const before = session.messages.map(message => `${message.role}:${message.role === 'user' ? message.messageIndex : message.responseIndex}`);
  workflow.restorePendingDisplayItems(session, session.display);

  assert.strictEqual(session.display[0].rawText, partial, 'pending partial content must survive regeneration refresh');
  assert.deepStrictEqual(session.messages.map(message => `${message.role}:${message.role === 'user' ? message.messageIndex : message.responseIndex}`), before,
    'regeneration refresh must not reorder or drop canonical messages');

  const order = [...messagesRoot.querySelectorAll('.message')].map(node => {
    const role = node.classList.contains('user') ? 'user' : node.classList.contains('assistant') ? 'assistant' : '?';
    const index = role === 'user' ? node.dataset.messageIndex : node.dataset.responseIndex;
    return `${role}:${index}:${node.dataset.rawText || ''}`;
  });
  assert.deepStrictEqual(order, [
    'user:0:q1',
    'assistant:1:a1',
    'user:2:q2',
    `assistant:3:${partial}`,
    'user:4:q3',
    'assistant:5:a3',
  ], 'refresh during a regeneration must keep every turn in order with the pending partial content in its slot');
}

module.exports = [
  testStatusDetectionNeverClassifiesRealAnswerContent,
  testRestoreKeepsPartialStreamedContentContainingStatusWords,
  testReloadHistoryKeepsRealAnswersContainingStatusWords,
  testRegenerationRefreshRendersOrderedMessagesAndPendingContent,
];
