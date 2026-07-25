'use strict';

const assert = require('assert');
const contextBudget = require('../../shared/config/context-budget');

function testContextBudgetPreservesSelectedRouteMessage() {
  const selected = { role: 'assistant', content: 'SELECTED_ROUTE_MESSAGE ' + 'x'.repeat(1800) };
  const result = contextBudget.applyContextBudget([
    { role: 'system', content: 'system' },
    { role: 'user', content: 'old unrelated turn ' + 'a'.repeat(2200) },
    { role: 'assistant', content: 'old unrelated answer ' + 'b'.repeat(2200) },
    selected,
    { role: 'user', content: 'Current question' },
  ], { inputBudgetTokens: 700, protectedMessageIndexes: [3] });

  assert.ok(result.messages.some(message => String(message.content || '').includes('SELECTED_ROUTE_MESSAGE')), 'the selected route message must remain in the request instead of being summarized away');
  assert.ok(result.messages.some(message => message.role === 'user' && String(message.content || '').includes('Current question')), 'the current user request must remain present');
}

module.exports = [
  testContextBudgetPreservesSelectedRouteMessage,
];
