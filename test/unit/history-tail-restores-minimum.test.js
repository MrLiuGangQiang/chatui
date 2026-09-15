'use strict';

const assert = require('assert');
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const ROOT = path.join(__dirname, '../..');

function loadTailSelector() {
  const source = fs.readFileSync(path.join(ROOT, 'app.js'), 'utf8');
  const start = source.indexOf('function historyMessageTextSize');
  const end = source.indexOf('function renderCanonicalMessagesNewestFirst', start);
  assert.ok(start >= 0 && end > start, 'history tail selector must be present in the startup facade');
  const selectorSource = source.slice(start, end);
  const context = {};
  vm.createContext(context);
  return vm.runInContext(`${selectorSource}; chooseHistoryTailStart;`, context);
}

function message(size, role = 'user') {
  return { role, content: role === 'assistant' ? `answer-${size}` : 'x'.repeat(size) };
}

function testHistoryTailAlwaysRestoresMinimumMessageCount() {
  const chooseHistoryTailStart = loadTailSelector();
  // The newest generated-image message has a large persisted HTML payload.
  const messages = Array.from({ length: 30 }, (_, index) => message(index === 29 ? 100000 : 40));
  const start = chooseHistoryTailStart(messages);
  assert.strictEqual(start, messages.length - 12);
  assert.strictEqual(messages.length - start, 12);
}

function testHistoryTailRestoresAllMessagesWhenFewerThanMinimum() {
  const chooseHistoryTailStart = loadTailSelector();
  const messages = Array.from({ length: 5 }, () => message(100000));
  assert.strictEqual(chooseHistoryTailStart(messages), 0);
}

module.exports = [
  testHistoryTailAlwaysRestoresMinimumMessageCount,
  testHistoryTailRestoresAllMessagesWhenFewerThanMinimum,
];