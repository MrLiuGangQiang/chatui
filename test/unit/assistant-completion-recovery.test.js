'use strict';

const assert = require('assert');
const fs = require('fs');
const path = require('path');
const formatting = require('../../client/app/formatting');
const displayItems = require('../../client/app/display-items');
const messagePrimitives = require('../../client/core/message-primitives');

const completionOptions = {
  isStatusText: formatting.isChatStatusText,
  hasRichMedia: displayItems.displayItemHasRichMedia,
};

function completedAssistant(overrides = {}) {
  return {
    role: 'assistant',
    content: '完整回答',
    rawText: '完整回答',
    responseIndex: '1',
    ...overrides,
  };
}

function testBlankReplacementAssistantDoesNotCountAsCompleted() {
  const session = {
    messages: [
      { role: 'user', content: '重新回答', rawText: '重新回答', messageIndex: '0' },
      { role: 'assistant', content: '', rawText: '', html: '', responseIndex: '1', replacing: true },
    ],
    display: [],
  };

  assert.strictEqual(
    messagePrimitives.hasCompletedAssistantForResponse(session, 1, completionOptions),
    false,
    'a persisted blank replacement slot must not be mistaken for a completed answer',
  );

  assert.strictEqual(
    messagePrimitives.countCompletedAssistantMessages(session.messages, completionOptions),
    0,
    'the resume fallback count must ignore the blank replacement slot as well',
  );
}

function testCompletedAssistantAndRichMediaStillCountAsCompleted() {
  const textSession = { messages: [completedAssistant()], display: [] };
  assert.strictEqual(
    messagePrimitives.hasCompletedAssistantForResponse(textSession, 1, completionOptions),
    true,
    'a real completed text answer must remain a completion marker',
  );

  const legacyReplacementSession = {
    messages: [completedAssistant({ replacing: true })],
    display: [],
  };
  assert.strictEqual(
    messagePrimitives.hasCompletedAssistantForResponse(legacyReplacementSession, 1, completionOptions),
    true,
    'legacy completed replies with a stale replacing flag must remain recoverable history',
  );

  const imageSession = {
    messages: [],
    display: [{
      role: 'assistant',
      rawText: '',
      html: '<img class="generated-thumb" data-persisted-src="indexeddb://image-1">',
      responseIndex: '1',
      pending: '',
    }],
  };
  assert.strictEqual(
    messagePrimitives.hasCompletedAssistantForResponse(imageSession, 1, completionOptions),
    true,
    'durable rich media without text must remain a completion marker',
  );
}

function testPendingAndStatusOnlyAssistantDoesNotCountAsCompleted() {
  const pendingSession = {
    messages: [completedAssistant({ pending: '1' })],
    display: [{ role: 'assistant', rawText: '完整回答', responseIndex: '1', pending: '1' }],
  };
  assert.strictEqual(
    messagePrimitives.hasCompletedAssistantForResponse(pendingSession, 1, completionOptions),
    false,
    'pending assistant projections must not be treated as completed',
  );

  const statusSession = {
    messages: [],
    display: [{ role: 'assistant', rawText: '正在处理', responseIndex: '1', pending: '' }],
  };
  assert.strictEqual(
    messagePrimitives.hasCompletedAssistantForResponse(statusSession, 1, completionOptions),
    false,
    'status-only projections must not be treated as completed',
  );
}

function testRecoveryCompletionCheckUsesSharedMessagePrimitives() {
  const app = fs.readFileSync(path.join(__dirname, '..', '..', 'app.js'), 'utf8');
  assert.ok(
    app.includes('coreMessagePrimitives.hasCompletedAssistantForResponse'),
    'the recovery completion check must delegate to the shared pure predicate',
  );
  assert.ok(
    app.includes('coreMessagePrimitives.countCompletedAssistantMessages'),
    'the recovery fallback count must use the same shared completion predicate',
  );
}

module.exports = [
  testBlankReplacementAssistantDoesNotCountAsCompleted,
  testCompletedAssistantAndRichMediaStillCountAsCompleted,
  testPendingAndStatusOnlyAssistantDoesNotCountAsCompleted,
  testRecoveryCompletionCheckUsesSharedMessagePrimitives,
];