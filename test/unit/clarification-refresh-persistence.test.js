'use strict';

const assert = require('assert');
const displayHistory = require('../../client/app/display-history-workflow');
const messageRecords = require('../../client/app/message-records');

function testRefreshRebuildsActiveClarificationChoicesFromDurablePendingState() {
  const session = {
    id: 'clarification-refresh',
    messages: [{
      role: 'assistant',
      content: '匹配到多个候选资源，请选择要使用的对象后继续。',
      clarificationId: 'clarify-images',
      responseIndex: 0,
      clarification: {
        schema_version: 'clarification_presentation.v1',
        id: 'clarify-images',
        question: '匹配到多个候选资源，请选择要使用的对象后继续。',
        sourceImageContext: { attachments: [{ imageId: 'current-image' }] },
        routeInfo: {
          clarificationQuestion: '匹配到多个候选资源，请选择要使用的对象后继续。',
          clarificationSlots: [{
            key: 'r1', type: 'image', role: 'reference', reason: 'ambiguous',
            choices: [{ key: 'c1', image_id: 'first-image' }, { key: 'c2', image_id: 'third-image' }],
          }],
        },
      },
    }],
    lastGeneratedImage: { referenceId: 'generated-image-ref' },
    // The answer already consumed the active pending task before this refresh.
    pendingClarification: null,
  };
  const state = { activeSessionId: session.id };
  const calls = [];
  const workflow = displayHistory.createDisplayHistoryWorkflow({
    state,
    messageRecords,
    displayItemHasRichMedia: () => false,
    clarificationPresentation: {
      buildClarificationPresentation(routeInfo, options) {
        assert.strictEqual(routeInfo.clarificationSlots[0].choices.length, 2);
        assert.strictEqual(options.messages, session.messages);
        assert.strictEqual(options.currentImageContext, session.messages[0].clarification.sourceImageContext);
        return {
          rawText: routeInfo.clarificationQuestion,
          html: '<div class="clarification-presentation"><ol><li>候选图片 1</li><li>候选图片 2</li></ol></div>',
          hasChoices: true,
        };
      },
    },
    addMessage: (role, content, options) => {
      calls.push({ role, content, options });
      return { dataset: {} };
    },
  });

  const node = workflow.renderMessageFromCanonical(session, session.messages[0], 0);

  assert.strictEqual(calls.length, 1);
  assert.strictEqual(calls[0].role, 'assistant');
  assert.strictEqual(calls[0].options.html, true, 'clarification choices must remain rich after refresh');
  assert.match(calls[0].content, /候选图片 1/);
  assert.match(calls[0].content, /候选图片 2/);
  assert.strictEqual(node.dataset.clarificationId, 'clarify-images', 'restored choice controls must retain their pending-task identity');
}


function testLegacyActiveClarificationKeepsItsPersistedChoiceMarkup() {
  const session = {
    id: 'clarification-refresh-legacy',
    messages: [],
    pendingClarification: null,
  };
  const calls = [];
  const workflow = displayHistory.createDisplayHistoryWorkflow({
    state: { activeSessionId: session.id },
    messageRecords,
    displayItemHasRichMedia: () => false,
    addMessage: (role, content, options) => {
      calls.push({ role, content, options });
      return { dataset: {} };
    },
  });

  workflow.renderMessageFromCanonical(session, {
    role: 'assistant', content: '历史候选', clarificationId: 'clarify-legacy', responseIndex: 0,
    html: '<div class="clarification-presentation" data-clarification-image-choices="1"><ol><li>候选图片 1</li></ol></div>',
  }, 0);

  assert.strictEqual(calls[0].options.html, true, 'existing persisted clarifications must not lose their candidates on refresh');
  assert.match(calls[0].content, /候选图片 1/);
}

function testHistoricalClarificationDoesNotUseAReplacedPendingTask() {
  const session = {
    id: 'clarification-refresh-stale',
    messages: [],
    pendingClarification: {
      id: 'clarify-current',
      routeInfo: { clarificationSlots: [] },
    },
  };
  const calls = [];
  const workflow = displayHistory.createDisplayHistoryWorkflow({
    state: { activeSessionId: session.id },
    messageRecords,
    clarificationPresentation: {
      buildClarificationPresentation: () => {
        throw new Error('a historical clarification must not be rebuilt from an unrelated pending task');
      },
    },
    displayItemHasRichMedia: () => false,
    addMessage: (role, content, options) => {
      calls.push({ role, content, options });
      return { dataset: {} };
    },
  });

  workflow.renderMessageFromCanonical(session, {
    role: 'assistant', content: '旧澄清问题', clarificationId: 'clarify-old', responseIndex: 0,
  }, 0);

  assert.strictEqual(calls[0].options.html, undefined);
  assert.strictEqual(calls[0].content, '旧澄清问题');
}

module.exports = [
  testRefreshRebuildsActiveClarificationChoicesFromDurablePendingState,
  testLegacyActiveClarificationKeepsItsPersistedChoiceMarkup,
  testHistoricalClarificationDoesNotUseAReplacedPendingTask,
];
