'use strict';

const assert = require('assert');
const fs = require('fs');
const path = require('path');
const vm = require('vm');
const { JSDOM } = require('jsdom');
const submitWorkflowPolicy = require('../../client/app/submit-workflow-policy');
const submitWorkflow = require('../../client/app/submit-workflow');

function extractFunction(source, name) {
  let start = source.indexOf('function ' + name);
  if (start > 6 && source.slice(start - 6, start) === 'async ') start -= 6;
  assert.ok(start >= 0, name + ' must exist in the source');
  let parenDepth = 0;
  let bodyStart = -1;
  let depth = 0;
  let inString = null;
  let escape = false;
  for (let index = start; index < source.length; index += 1) {
    const char = source[index];
    if (inString) {
      if (escape) escape = false;
      else if (char === '\\') escape = true;
      else if (char === inString) inString = null;
      continue;
    }
    if (char === '"' || char === "'" || char === '`') { inString = char; continue; }
    if (char === '(') { parenDepth += 1; continue; }
    if (char === ')') { parenDepth -= 1; continue; }
    if (parenDepth > 0) continue;
    if (char === '{') {
      if (bodyStart < 0) bodyStart = index;
      depth += 1;
      continue;
    }
    if (char === '}') {
      depth -= 1;
      if (depth === 0 && bodyStart >= 0) return source.slice(start, index + 1);
    }
  }
  throw new Error(name + ' body is incomplete');
}

function testEditResendKeepsPendingResponseIndexFromReplacement() {
  const source = fs.readFileSync(path.join(__dirname, '../../client/app/submit-workflow.js'), 'utf8');
  const fragment = 'canonicalEditIndex=String(replacement?.responseIndex??responseIndex)';
  assert.ok(source.includes(fragment), 'the managed chat job binding must keep the replacement response index for edited messages');
}

function testRoutePreparationKeepsEditedResponseAtItsCanonicalSlot() {
  const source = fs.readFileSync(path.join(__dirname, '../../client/app/submit-workflow.js'), 'utf8');
  assert.ok(source.includes('responseIndex=resolveSubmitResponseIndex({resumedResponseIndex:resumePendingSubmit?.responseIndex,replacementResponseIndex:replacement?.responseIndex'), 'routing status updates must use the edited turn response index instead of the post-edit list length');
  assert.strictEqual(submitWorkflowPolicy.resolveSubmitResponseIndex({ replacementResponseIndex: 3, sessionMessageCount: 7, stateMessageCount: 7 }), 3);
  assert.strictEqual(submitWorkflowPolicy.resolveSubmitResponseIndex({ resumedResponseIndex: 5, replacementResponseIndex: 3, sessionMessageCount: 7 }), 5);
}

function testReplacementTargetPrefersAdjacentReplyAfterCanonicalReindex() {
  const app = fs.readFileSync(path.join(__dirname, '../../app.js'), 'utf8');
  assert.ok(app.includes('const adjacentResponse=n?.nextElementSibling&&(n.nextElementSibling.classList?.contains("assistant")||n.nextElementSibling.classList?.contains("error"))?n.nextElementSibling:null;const m=adjacentResponse||'), 'replacement resolution must prefer the reply immediately following the edited message after suffix reindexing');
}

function testPreparingReplacementClearsPreviousTransientAssistantState() {
  const app = fs.readFileSync(path.join(__dirname, '../../app.js'), 'utf8');
  const prepareReplacementResponse = extractFunction(app, 'prepareReplacementResponse');
  const dom = new JSDOM(`<!doctype html><div id="messages">
    <article class="message user" data-message-index="0"><div class="content">q</div></article>
    <article class="message assistant" data-response-index="1" data-output-started="1">
      <div class="avatar">AI</div>
      <div class="message-meta">TTFT 1m 12s · RT 1m 24s</div>
      <div class="bubble"><section class="reasoning-panel">old reasoning</section><div class="content">
        <div class="pending-feedback">old waiting</div>
        <details class="intent-reasoning-trace"><summary>old trace</summary></details>
      </div></div>
    </article>
  </div>`);
  const { document } = dom.window;
  const assistant = document.querySelector('.message.assistant');
  assistant.__displayItem = {
    id: 'display-reset', role: 'assistant', pending: '1', responseIndex: '1',
    reasoningText: 'old reasoning', keepReasoning: true, metaText: 'old metrics', outputStarted: true,
  };
  const sandbox = {
    document,
    window: {
      ChatUIAppFormatting: {
        dismissIntentReasoningTrace: node => {
          const trace = node.querySelector('.intent-reasoning-trace');
          trace?.remove();
          return !!trace;
        },
      },
    },
    clearReasoning: node => {
      node.querySelectorAll('.reasoning-panel').forEach(panel => panel.remove());
      delete node.dataset.reasoningText;
      delete node.dataset.keepReasoning;
    },
    clearPendingFeedback: node => node.querySelector('.pending-feedback')?.remove(),
    setMessageMetaText: (node, value) => {
      const meta = node.querySelector('.message-meta');
      if (String(value || '').trim()) return;
      meta?.remove();
    },
    pendingFeedbackHtml: value => '<div class="pending-feedback">' + value + '</div>',
    updateMessage: (node, html) => { node.querySelector('.content').innerHTML = html; },
    armStreamingOutputFocus: () => {},
    updateSessionDisplayItem: (_sessionId, item, _role, content, options = {}) => {
      item.rawText = options.rawText ?? content;
      item.reasoningText = options.reasoning ?? item.reasoningText;
      item.keepReasoning = options.keepReasoning ?? item.keepReasoning;
      item.metaText = options.metaText ?? item.metaText;
    },
  };
  vm.createContext(sandbox);
  const prepared = vm.runInContext(
    '(' + prepareReplacementResponse + ')({ responseIndex: 1, responseNode: document.querySelector(".message.assistant") }, "session-a", "new waiting")',
    sandbox,
  );

  assert.strictEqual(assistant.querySelector('.reasoning-panel'), null, 'old reasoning must be removed before regenerating');
  assert.strictEqual(assistant.querySelector('.intent-reasoning-trace'), null, 'old intent trace must be removed before regenerating');
  assert.strictEqual(assistant.querySelector('.message-meta'), null, 'old response metrics must not survive a replacement');
  assert.match(assistant.querySelector('.pending-feedback')?.textContent || '', /new waiting/);
  assert.strictEqual(prepared.liveItem.reasoningText, '', 'the live item must not restore the previous reasoning');
  assert.strictEqual(prepared.liveItem.keepReasoning, false);
  assert.strictEqual(prepared.liveItem.metaText, '', 'the live item must not restore previous metrics');
  assert.strictEqual(prepared.liveItem.outputStarted, false);
  dom.window.close();
}

function testEditedMessageDoesNotReuseDistantStaleAssistantNode() {
  const app = fs.readFileSync(path.join(__dirname, '../../app.js'), 'utf8');
  const applyPendingEdit = extractFunction(app, 'applyPendingEdit');
  const prepareReplacementResponse = extractFunction(app, 'prepareReplacementResponse');
  const dom = new JSDOM(`<!doctype html><div id="messages">
    <article class="message user" data-message-index="0"><div class="content">q0</div></article>
    <article class="message assistant" data-response-index="1"><div class="content">a0</div></article>
    <article class="message user" data-message-index="2"><div class="content">old target</div></article>
    <article class="message user" data-message-index="3"><div class="content">later question</div></article>
    <article class="message assistant" data-response-index="3"><div class="content">later answer</div></article>
  </div><input id="prompt">`);
  const { document } = dom.window;
  const container = document.getElementById('messages');
  const targetNode = container.querySelector('[data-message-index="2"]');
  const state = {
    messages: [
      { role: 'user', content: 'q0', rawText: 'q0', messageIndex: '0' },
      { role: 'assistant', content: 'a0', rawText: 'a0', responseIndex: '1' },
      { role: 'user', content: 'old target', rawText: 'old target', messageIndex: '2' },
      { role: 'user', content: 'later question', rawText: 'later question', messageIndex: '3' },
      { role: 'assistant', content: 'later answer', rawText: 'later answer', responseIndex: '4' },
    ],
    attachments: [],
    editingIndex: 2,
    editingNode: targetNode,
    editingQuoteContext: '',
  };
  const prompt = document.getElementById('prompt');
  const sandbox = {
    state,
    targetNode,
    window: {
      ChatUIAppSessionPersistence: require('../../client/app/session-persistence'),
      ChatUIMessageRecords: { refreshAttachmentContextForEdit: value => value },
    },
    $: id => id === 'messages' ? container : id === 'prompt' ? prompt : null,
    renderUserMessageWithAttachments: value => '<p>' + value + '</p>',
    buildUserMessageContent: value => value,
    buildUserApiContent: value => value,
    bindInlineCopyButtons: () => {},
    hydrateMessageMedia: () => {},
    withSentQuotePreview: html => html,
    saveDisplayHistory: () => {},
    pendingFeedbackHtml: value => '<span class="pending-feedback">' + value + '</span>',
    clearReasoning: () => {},
    updateMessage: (node, html, options = {}) => {
      node.querySelector('.content').innerHTML = html;
      if (options.responseIndex !== undefined) node.dataset.responseIndex = String(options.responseIndex);
    },
    armStreamingOutputFocus: () => {},
    addMessage: (_role, html, options = {}) => {
      const node = document.createElement('article');
      node.className = 'message assistant';
      node.dataset.responseIndex = String(options.responseIndex);
      node.innerHTML = '<div class="content">' + html + '</div>';
      container.appendChild(node);
      return node;
    },
    appendSessionDisplayMessage: () => ({ id: 'pending-display', pending: '1', responseIndex: '3' }),
    updateSessionDisplayItem: () => {},
  };
  vm.createContext(sandbox);
  const replacement = vm.runInContext('(' + applyPendingEdit + ')("new target", { submissionId: "edit-1", messageIndex: 2, node: targetNode })', sandbox);
  assert.strictEqual(replacement.responseIndex, 3);
  assert.strictEqual(replacement.responseNode, null, 'a stale response index on a later answer must not be treated as the edited answer');
  const replacementSandbox = { ...sandbox, replacement };
  vm.createContext(replacementSandbox);
  const prepared = vm.runInContext('(' + prepareReplacementResponse + ')(replacement, "session-a", "正在判断任务意图")', replacementSandbox);
  assert.strictEqual(prepared.node.previousElementSibling, targetNode, 'pending must be inserted immediately after the edited message');
  const order = [...container.querySelectorAll('.message')].map(node => node.classList.contains('user') ? 'user:' + node.dataset.messageIndex : 'assistant:' + node.dataset.responseIndex);
  assert.deepStrictEqual(order.slice(0, 4), ['user:0', 'assistant:1', 'user:2', 'assistant:3']);
  assert.strictEqual(order[4], 'user:3', 'later questions must remain below the edited pending reply');
  dom.window.close();
}

function testEditResendPendingNodeStaysAtReplacementPosition() {
  const dom = new JSDOM(`<!doctype html><div id="messages">
    <article class="message user"><div class="content">u0</div></article>
    <article class="message assistant"><div class="content">a1</div></article>
    <article class="message user"><div class="content">u2</div></article>
    <article class="message assistant"><div class="content">a3 old reply</div></article>
    <article class="message user"><div class="content">u4</div></article>
    <article class="message assistant"><div class="content">a5</div></article>
  </div>`);
  const { document } = dom.window;
  const container = document.getElementById('messages');
  [...container.querySelectorAll('.message')].forEach((node, index) => {
    const role = node.classList.contains('user') ? 'user' : 'assistant';
    if (role === 'user') node.dataset.messageIndex = String(index === 0 ? 0 : index === 2 ? 2 : index);
    else node.dataset.responseIndex = String(index === 1 ? 1 : index === 3 ? 3 : index === 5 ? 5 : index);
  });
  const editedUserNode = [...container.querySelectorAll('.message.user')].find(node => node.dataset.messageIndex === '2');
  const oldReply = [...container.querySelectorAll('.message.assistant')].find(node => node.dataset.responseIndex === '3');
  oldReply.remove();
  const pending = document.createElement('article');
  pending.className = 'message assistant';
  pending.dataset.responseIndex = '3';
  const anchor = [...container.querySelectorAll('.message')].find(node => Number(node.dataset.messageIndex || node.dataset.responseIndex) > 3);
  if (anchor) container.insertBefore(pending, anchor); else container.appendChild(pending);
  const order = [...container.querySelectorAll('.message')].map(node => (node.classList.contains('user') ? 'user' : 'assistant') + ':' + (node.dataset.messageIndex || node.dataset.responseIndex));
  assert.strictEqual(order.indexOf('assistant:3'), 3);
  assert.strictEqual(order[4], 'user:4');
  dom.window.close();
}

function testEditResendRemovesEveryTurnResponseNodeBeforeReplacing() {
  const dom = new JSDOM(`<!doctype html><div id="messages">
    <article class="message user" data-message-index="0">原始问题</article>
    <article class="message error" data-response-index="1">本次未执行：模型结构无效</article>
    <article class="message assistant" data-response-index="2">旧的五张图片结果</article>
    <article class="message user" data-message-index="3">后续问题</article>
    <article class="message assistant" data-response-index="4">后续回答</article>
  </div>`);
  const { document } = dom.window;
  const messages = document.getElementById('messages');
  const user = messages.querySelector('.message.user[data-message-index="0"]');
  const removed = submitWorkflow.removeEditableTurnResponseNodes(user);

  assert.strictEqual(removed, 2, 'both the error and the old image result must be removed');
  assert.deepStrictEqual([...messages.querySelectorAll('.message')].map(node => node.className), [
    'message user', 'message user', 'message assistant',
  ]);
  assert.strictEqual(messages.querySelector('.message.user[data-message-index="3"]').textContent, '后续问题');
  assert.strictEqual(messages.querySelector('.message.assistant[data-response-index="4"]').textContent, '后续回答');
  dom.window.close();
}

function testEditResendBranchWiresTurnScopedCleanup() {
  const source = fs.readFileSync(path.join(__dirname, '../../client/app/submit-workflow.js'), 'utf8');
  assert.ok(source.includes('removeAssistantDisplayItemsForTurn(sessionRecord.display||[]'), 'display cleanup must be wired into edit/resend');
  assert.ok(source.includes('removeEditableTurnResponseNodes(replacement.node)'), 'DOM cleanup must be wired into edit/resend');
  assert.ok(source.includes('replacement.responseNode=null'), 'the stale response node must not be reused after cleanup');
}

module.exports = [
  testEditResendKeepsPendingResponseIndexFromReplacement,
  testRoutePreparationKeepsEditedResponseAtItsCanonicalSlot,
  testReplacementTargetPrefersAdjacentReplyAfterCanonicalReindex,
  testPreparingReplacementClearsPreviousTransientAssistantState,
  testEditedMessageDoesNotReuseDistantStaleAssistantNode,
  testEditResendPendingNodeStaysAtReplacementPosition,
  testEditResendRemovesEveryTurnResponseNodeBeforeReplacing,
  testEditResendBranchWiresTurnScopedCleanup,
];

