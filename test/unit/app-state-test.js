#!/usr/bin/env node
const assert = require('assert');
const { createSession, ensureActiveSession, isSessionBusy } = require('../../client/app/state');

const session = createSession('T', () => 123456, () => 0.123456);
assert.ok(session.id.startsWith('chat-'));
assert.strictEqual(session.title, 'T');
assert.deepStrictEqual(session.messages, []);
const state = { sessions: [], activeSessionId: '', busySessions: new Set() };
const active = ensureActiveSession(state, () => ({ ...session, id: 's1' }));
assert.strictEqual(active.id, 's1');
assert.strictEqual(state.activeSessionId, 's1');
state.busySessions.add('s1');
assert.strictEqual(isSessionBusy(state, 's1'), true);
state.busySessions.clear();
state.sessions[0].busy = true;
assert.strictEqual(isSessionBusy(state, 's1'), true);
console.log('app state ok');
