'use strict';

const assert = require('assert');
const contextBudget = require('../../shared/config/context-budget');
const chatWorkflow = require('../../client/app/chat-workflow');

function testContextBudgetPreservesSelectedRouteMessage() {
  const selected = { role: 'assistant', content: 'SELECTED_ROUTE_MESSAGE ' + 'x'.repeat(600) };
  const current = { role: 'user', content: 'Current question' };
  const result = contextBudget.applyContextBudget([
    { role: 'system', content: 'system' },
    { role: 'user', content: 'old unrelated turn ' + 'a'.repeat(2200) },
    { role: 'assistant', content: 'old unrelated answer ' + 'b'.repeat(2200) },
    selected,
    current,
  ], { inputBudgetTokens: 400, protectedMessageIndexes: [3] });

  assert.ok(result.messages.some(message => message.content === selected.content), 'the selected route message must remain complete instead of being summarized or truncated');
  assert.ok(result.messages.some(message => message.content === current.content), 'the current user request must remain complete');
  assert.strictEqual(result.requiredOverflow, false);
}

function testContextBudgetKeepsProtectedHistoryInChronologicalOrder() {
  const result = contextBudget.applyContextBudget([
    { role: 'system', content: 'system' },
    { role: 'assistant', content: 'SELECTED_CONTEXT' },
    { role: 'user', content: 'old unrelated turn ' + 'a'.repeat(1800) },
    { role: 'assistant', content: 'old unrelated answer ' + 'b'.repeat(1800) },
    { role: 'user', content: 'RECENT_USER' },
    { role: 'assistant', content: 'RECENT_ASSISTANT' },
    { role: 'user', content: 'CURRENT_REQUEST' },
  ], { inputBudgetTokens: 300, protectedMessageIndexes: [1] });

  const contents = result.messages.map(message => String(message.content || ''));
  assert.ok(!contents.some(content => content.startsWith('old unrelated turn')), 'ordinary old history should be removed first instead of being retained verbatim');
  assert.ok(contents.indexOf('SELECTED_CONTEXT') < contents.indexOf('RECENT_USER'), 'a protected message must keep its original chronological position');
  assert.ok(contents.indexOf('RECENT_USER') < contents.indexOf('CURRENT_REQUEST'));
}

function testRequiredContextOverflowFailsWithoutSemanticTruncation() {
  const currentContent = `ORIGINAL_REQUIREMENT_KEEP_THIS_PREFIX\n\n[附件]\n${'z'.repeat(5000)}`;
  const messages = [
    { role: 'system', content: 'system' },
    { role: 'user', content: currentContent },
  ];
  const result = contextBudget.applyContextBudget(messages, { inputBudgetTokens: 200 });

  assert.strictEqual(result.requiredOverflow, true);
  assert.strictEqual(result.truncatedCurrentUser, false);
  assert.strictEqual(result.messages.at(-1).content, currentContent, 'the current request must never be silently tail-truncated');
  assert.throws(
    () => contextBudget.applyContextBudgetToChatPayload({ messages }, { inputBudgetTokens: 200 }),
    error => error?.code === 'CONTEXT_REQUIRED_CONTENT_TOO_LARGE' && error?.statusCode === 400,
  );
}

function testExplicitQuoteIsProtectedAndOverflowFailsClosed() {
  const workflow = chatWorkflow.createChatWorkflow({ state: {}, applyContextBudget: contextBudget.applyContextBudget });
  assert.strictEqual(workflow.protectedContextMessageCount({ quotedMessage: { role: 'assistant' } }), 1, 'an explicit quote is required execution context');
  assert.strictEqual(workflow.protectedContextMessageCount({ routeContextMessageCount: 2, quotedMessage: { role: 'assistant' } }), 2);
  assert.deepStrictEqual(workflow.protectedHistoryIndexes([
    { role: 'user', content: 'quoted body' },
    { role: 'user', content: 'current question' },
  ], 1), [0]);

  assert.throws(
    () => workflow.applyOutboundContextBudget([
      { role: 'user', content: `QUOTED_REQUIRED ${'q'.repeat(5000)}` },
      { role: 'user', content: 'CURRENT_REQUIRED' },
    ], { context: { windowTokens: 250 } }, { quotedMessage: { role: 'assistant' } }),
    error => error?.code === 'CONTEXT_REQUIRED_CONTENT_TOO_LARGE',
  );
}

module.exports = [
  testContextBudgetPreservesSelectedRouteMessage,
  testContextBudgetKeepsProtectedHistoryInChronologicalOrder,
  testRequiredContextOverflowFailsWithoutSemanticTruncation,
  testExplicitQuoteIsProtectedAndOverflowFailsClosed,
];
