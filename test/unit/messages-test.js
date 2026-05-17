#!/usr/bin/env node
const assert = require('assert');
const {
  cloneMessageList,
  normalizeMessageOrderFields,
  sortCanonicalMessages,
  compactAdjacentDuplicateMessages,
  sanitizeStoredMessage,
  assistantMessageCount,
} = require('../../client/core/messages');

const original = [{ role: 'user', content: 'a', nested: { x: 1 } }];
const cloned = cloneMessageList(original);
cloned[0].nested.x = 2;
assert.strictEqual(original[0].nested.x, 1, 'clone is deep enough for stored messages');
assert.strictEqual(normalizeMessageOrderFields({ role: 'user', content: 'u' }, 3).messageIndex, 3);
assert.strictEqual(normalizeMessageOrderFields({ role: 'assistant', content: 'a' }, 4).responseIndex, 4);
assert.deepStrictEqual(sortCanonicalMessages([
  { role: 'assistant', responseIndex: 1, content: 'a1' },
  { role: 'user', messageIndex: 0, content: 'u0' },
  { role: 'assistant', responseIndex: 0, content: 'a0' },
]).map(m => m.content), ['u0', 'a0', 'a1']);
assert.deepStrictEqual(compactAdjacentDuplicateMessages([
  { role: 'user', rawText: 'x' },
  { role: 'user', rawText: 'x' },
  { role: 'assistant', rawText: 'x' },
]).map(m => m.role), ['user', 'assistant']);
assert.deepStrictEqual(sanitizeStoredMessage({ role: 'assistant', content: 'ok', pending: true, streaming: true }), { role: 'assistant', content: 'ok', rawText: 'ok' });
assert.strictEqual(assistantMessageCount([{ role: 'user' }, { role: 'assistant' }, { role: 'assistant' }]), 2);
console.log('messages ok');
