#!/usr/bin/env node
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const root = path.resolve(__dirname, '../..');
const browserApp = fs.readFileSync(path.join(root, 'client/app/browser.js'), 'utf8');

for (const fn of ['makeRun', 'getActiveRun', 'ensureActiveRun', 'addActiveRunJob', 'isRunStopped', 'bindFollowingRun']) {
  assert.ok(!browserApp.includes(`function ${fn}`), `browser app must not duplicate runs.${fn}`);
}
assert.ok(browserApp.includes('window.ChatUIAppRuns'), 'browser app should reuse shared runs module');

const context = {
  window: { ChatUIApp: {} },
  globalThis: {},
  Date,
  Math,
  AbortController,
  console,
};
context.globalThis = context.window;
vm.createContext(context);
vm.runInContext(fs.readFileSync(path.join(root, 'client/app/runs.js'), 'utf8'), context, { filename: 'runs.js' });
vm.runInContext(browserApp, context, { filename: 'browser.js' });

assert.strictEqual(context.window.ChatUIApp.runs, context.window.ChatUIAppRuns, 'browser app reuses shared runs object');
const state = { activeRuns: new Map() };
const run = context.window.ChatUIApp.runs.ensureActiveRun(state, 's1');
assert.strictEqual(context.window.ChatUIApp.runs.getActiveRun(state, 's1'), run);
assert.strictEqual(context.window.ChatUIApp.runs.addActiveRunJob(state, 's1', 'chat', 'job1'), true);
assert.ok(run.jobIds.has('chat:job1'));
run.stopped = true;
assert.strictEqual(context.window.ChatUIApp.runs.isRunStopped(state, 's1'), true);

console.log('app browser runs adapter ok');
