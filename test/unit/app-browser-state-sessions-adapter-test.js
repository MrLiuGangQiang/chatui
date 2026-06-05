#!/usr/bin/env node
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const root = path.resolve(__dirname, '../..');
const browserApp = fs.readFileSync(path.join(root, 'client/app/browser.js'), 'utf8');

for (const fn of [
  'createSession',
  'ensureActiveSession',
  'isSessionBusy',
  'sessionStorageKey',
  'deriveSessionTitle',
  'getSessionReturnCount',
]) {
  assert.ok(!browserApp.includes(`function ${fn}`), `browser app must not duplicate ${fn}`);
}
assert.ok(browserApp.includes('window.ChatUIAppState'), 'browser app should reuse shared state module');
assert.ok(browserApp.includes('window.ChatUIAppSessions'), 'browser app should reuse shared sessions module');

const context = { window: {}, AbortController, Date, Math };
vm.createContext(context);
for (const file of [
  'client/app/state.js',
  'client/app/sessions.js',
  'client/app/session-config.js',
  'client/app/header-params.js',
  'client/app/formatting.js',
  'client/app/markdown-utils.js',
  'client/app/display-items.js',
  'client/app/persistence.js',
  'client/app/runs.js',
  'client/app/browser.js',
]) {
  vm.runInContext(fs.readFileSync(path.join(root, file), 'utf8'), context, { filename: file });
}

assert.strictEqual(context.window.ChatUIApp.state, context.window.ChatUIAppState);
assert.strictEqual(context.window.ChatUIApp.sessions, context.window.ChatUIAppSessions);
const session = context.window.ChatUIApp.state.createSession('T', () => 123456, () => 0.123456);
assert.strictEqual(session.id, 'chat-2n9c-4fzyo8');
const appState = { sessions: [], activeRuns: new Map() };
assert.strictEqual(context.window.ChatUIApp.state.ensureActiveSession(appState).title, '新对话');
assert.strictEqual(context.window.ChatUIApp.sessions.sessionStorageKey('jobs', 's1'), 'jobs:s1');
assert.strictEqual(context.window.ChatUIApp.sessions.deriveSessionTitle({ messages: [{ role: 'user', content: ' hello world ' }] }), 'hello world');

console.log('app browser state sessions adapter ok');
