'use strict';

const assert = require('assert');
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const ROOT = path.join(__dirname, '../..');

function extractFunction(source, name) {
  let start = source.indexOf('function ' + name);
  if (start > 6 && source.slice(start - 6, start) === 'async ') start -= 6;
  assert.ok(start >= 0, name + ' must exist in the source');
  let parenDepth = 0;
  let bodyStart = -1;
  let depth = 0;
  let inString = null;
  let escape = false;
  let end = -1;
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
      if (depth === 0 && bodyStart >= 0) { end = index + 1; break; }
    }
  }
  assert.ok(end > start, name + ' body must be extractable');
  return source.slice(start, end);
}

function testEditUserMessageCapturesTheOriginalQuote() {
  const app = fs.readFileSync(path.join(ROOT, 'app.js'), 'utf8');
  const fn = extractFunction(app, 'editUserMessage');
  const state = {
    messages: [{ role: 'user', messageIndex: 0, rawText: '旧问题', quoteContext: '{"role":"assistant","id":"quote-1"}' }],
    attachments: [],
    editingIndex: null,
    editingNode: null,
    editingQuoteContext: '',
  };
  const node = {
    dataset: { rawText: '旧问题', messageIndex: '0', quoteContext: '{"role":"assistant","id":"quote-1"}' },
    __displayItem: { quoteContext: '{"role":"assistant","id":"quote-1"}' },
    classList: { add() {}, remove() {} },
  };
  const prompt = { value: '', dataset: {}, focus() {} };
  const sandbox = {
    state,
    node,
    window: { ChatUIAppSessionPersistence: { resolveUserMessageTurn: () => ({ userIndex: 0 }) } },
    $: id => (id === 'prompt' ? prompt : null),
    toast: () => {},
    getUserAttachmentContextFromNode: () => '',
    restoreUserAttachmentsFromContext: async () => [],
    renderAttachments: () => {},
    autoResize: () => {},
  };
  vm.createContext(sandbox);
  return Promise.resolve(vm.runInContext('(' + fn + ')(node)', sandbox)).then(() => {
    assert.strictEqual(state.editingQuoteContext, '{"role":"assistant","id":"quote-1"}',
      'editing must capture the original message quote for the resubmit');
    assert.strictEqual(prompt.value, '旧问题');
  });
}

function testApplyPendingEditPreservesQuoteContext() {
  const app = fs.readFileSync(path.join(ROOT, 'app.js'), 'utf8');
  const fn = extractFunction(app, 'applyPendingEdit');
  const quote = '{"role":"assistant","id":"quote-1","content":"旧回答"}';
  const state = {
    messages: [{ role: 'user', messageIndex: 0, rawText: '旧问题', quoteContext: quote }],
    attachments: [],
    editingIndex: 0,
    editingNode: null,
    editingQuoteContext: quote,
  };
  const prompt = { value: '', dataset: {} };
  const contentEl = { innerHTML: '' };
  const node = {
    dataset: { rawText: '旧问题', messageIndex: '0', quoteContext: quote },
    __displayItem: { quoteContext: quote },
    classList: { remove() {} },
    querySelector: selector => (selector === '.content' ? contentEl : null),
    nextElementSibling: null,
  };
  const sandbox = {
    state,
    node,
    window: { ChatUIAppSessionPersistence: {
      resolveUserMessageTurn: () => ({ userIndex: 0, assistantIndex: 1, hasAssistant: false }),
      ensureAssistantReplacementSlot: (messages, turn) => turn,
      parseMessageOrderIndex: value => Number(value),
    } },
    $: id => (id === 'messages' ? { querySelectorAll: () => [] } : id === 'prompt' ? prompt : null),
    renderUserMessageWithAttachments: text => '<p>' + text + '</p>',
    buildUserMessageContent: text => text,
    buildUserApiContent: text => text,
    bindInlineCopyButtons: () => {},
    hydrateMessageMedia: () => {},
    withSentQuotePreview: (html, quoteValue) => html + '<span data-quote="' + quoteValue + '"></span>',
    saveDisplayHistory: () => {},
  };
  vm.createContext(sandbox);
  const result = vm.runInContext('(' + fn + ')("新问题", { submissionId: "edit-1", node: node })', sandbox);
  assert.strictEqual(result.index, 0);
  assert.strictEqual(state.messages[0].quoteContext, quote, 'the edited message record must keep the quote');
  assert.strictEqual(node.dataset.quoteContext, quote, 'the edited node must keep the quote dataset');
  assert.strictEqual(node.__displayItem.quoteContext, quote, 'the edited display item must keep the quote');
  assert.ok(contentEl.innerHTML.includes('data-quote='), 'the edited bubble must render the quote preview again');
  assert.strictEqual(state.editingQuoteContext, '', 'applyPendingEdit must clear the captured edit quote');
}

function testEditQuoteRestorationIsWiredThroughSubmitAndSessionState() {
  const app = fs.readFileSync(path.join(ROOT, 'app.js'), 'utf8');
  const submit = fs.readFileSync(path.join(ROOT, 'client/app/submit-workflow.js'), 'utf8');
  const sessionUi = fs.readFileSync(path.join(ROOT, 'client/app/session-ui-workflow.js'), 'utf8');
  assert.ok(app.includes('state.editingQuoteContext=String(e?.dataset?.quoteContext'), 'edit must capture the original quote');
  assert.ok(submit.includes('state.editingQuoteContext?parseContextValue(state.editingQuoteContext):null'),
    'submit must restore the original quote while editing');
  assert.ok(submit.includes('state.editingIndex=null,state.editingNode=null,state.editingQuoteContext=""'),
    'submit must clear the captured edit quote when the edit completes');
  assert.ok(sessionUi.includes('state.editingQuoteContext = "";'), 'session switches must clear the captured edit quote');
}

module.exports = [
  testEditUserMessageCapturesTheOriginalQuote,
  testApplyPendingEditPreservesQuoteContext,
  testEditQuoteRestorationIsWiredThroughSubmitAndSessionState,
];
