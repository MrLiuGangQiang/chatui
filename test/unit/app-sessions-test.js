#!/usr/bin/env node
const assert = require('assert');
const { sessionStorageKey, deriveSessionTitle, getSessionReturnCount } = require('../../client/app/sessions');

assert.strictEqual(sessionStorageKey('base', 's1'), 'base:s1');
assert.strictEqual(sessionStorageKey('base', ''), 'base:default');
assert.strictEqual(deriveSessionTitle({ customTitle: '  自定义   标题  ' }), '自定义 标题');
assert.strictEqual(deriveSessionTitle({ messages: [{ role: 'user', content: '这是一条很长很长很长很长很长的消息' }] }), '这是一条很长很长很长很长很长的消息'.slice(0, 22));
assert.strictEqual(getSessionReturnCount({ session: { id: 's1', messages: [{ role: 'assistant' }] }, activeSessionId: 's2' }), 1);
assert.strictEqual(getSessionReturnCount({ session: { id: 's1', display: [{ role: 'error' }] }, activeSessionId: 's2' }), 1);
assert.strictEqual(getSessionReturnCount({ session: { id: 's1', messages: [] }, activeSessionId: 's1', activeMessages: [], domCount: 3 }), 3);
console.log('app sessions ok');
