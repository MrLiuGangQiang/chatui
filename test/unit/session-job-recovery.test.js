'use strict';

const assert = require('assert');
const fs = require('fs');
const path = require('path');
const vm = require('vm');
const bootstrapWorkflow = require('../../client/app/bootstrap-workflow');

function testBackgroundSessionsResumeAndShowBusyStateAfterRestore() {
  const app = fs.readFileSync(path.join(__dirname, '../../app.js'), 'utf8');
  const start = app.indexOf('function resumeBackgroundSessionJobs()');
  const end = app.indexOf('function formatElapsed(', start);
  assert.ok(start >= 0 && end > start, 'the compatibility entry must expose the background recovery coordinator');

  const state = {
    pageUnloading: true,
    activeSessionId: 'active',
    sessions: [
      { id: 'active' },
      { id: 'image-background' },
      { id: 'chat-background' },
      { id: 'pending-background' },
      { id: 'idle-background' },
      null,
    ],
  };
  const busy = [];
  const resumed = [];
  const resumeBackgroundSessionJobs = vm.runInNewContext(`(${app.slice(start, end)})`, {
    state,
    loadImageJob: sessionId => sessionId === 'image-background' ? { id: 'imgjob-a' } : null,
    loadLatestChatJob: sessionId => sessionId === 'chat-background' ? { id: 'chatjob-a' } : null,
    getSubmitWorkflow: () => ({
      loadPendingSubmit: sessionId => ['active', 'pending-background'].includes(sessionId) ? { id: `submit-${sessionId}` } : null,
    }),
    setSessionBusy: (sessionId, value) => busy.push([sessionId, value]),
    resumeSessionJobs: sessionId => resumed.push(sessionId),
  });

  resumeBackgroundSessionJobs();

  assert.strictEqual(state.pageUnloading, false);
  assert.deepStrictEqual(busy, [
    ['active', true],
    ['image-background', true],
    ['chat-background', true],
    ['pending-background', true],
  ], 'every session with a durable owner must project busy state before rendering');
  assert.deepStrictEqual(resumed, ['image-background', 'chat-background', 'pending-background'], 'only background sessions should reconnect immediately');
}

async function testBootstrapAwaitsSessionRestoreBeforeStartingBackgroundRecovery() {
  const calls = [];
  let historyAnchorInitializations = 0;
  let releaseSessions;
  const sessionsLoaded = new Promise(resolve => { releaseSessions = resolve; });
  const element = {
    dataset: {},
    classList: { add() {}, remove() {}, contains() { return false; } },
    addEventListener() {},
    setAttribute() {},
    contains() { return false; },
    closest() { return null; },
    click() {},
    focus() {},
    files: [],
    value: '',
    disabled: false,
  };
  const document = {
    body: { classList: { add() {}, remove() {}, contains() { return false; } } },
    visibilityState: 'visible',
    addEventListener() {},
    querySelector() { return null; },
    querySelectorAll() { return []; },
  };
  const window = {
    addEventListener() {},
    matchMedia() { return { matches: false }; },
    requestAnimationFrame(callback) { callback(); return 1; },
    setTimeout() { return 1; },
    clearTimeout() {},
  };
  const explicit = {
    $: () => element,
    state: { activeSessionId: 'active', mode: 'chat', autoMode: true },
    document,
    window,
    setTimeout: window.setTimeout,
    clearTimeout: window.clearTimeout,
    requestAnimationFrame: window.requestAnimationFrame,
    loadSessions: async () => { calls.push('load-sessions:start'); await sessionsLoaded; calls.push('load-sessions:end'); },
    historyAnchorNav: { init() { historyAnchorInitializations += 1; } },
    resumeBackgroundSessionJobs: () => calls.push('resume-background'),
    loadReasoningPreference: () => calls.push('load-reasoning'),
    waitForMarkdownReady: async () => true,
  };
  const deps = new Proxy(explicit, {
    get(target, property) {
      if (property in target) return target[property];
      return () => {};
    },
  });
  const bootstrap = bootstrapWorkflow.createBootstrapWorkflow(deps);
  const started = bootstrap.start();
  await Promise.resolve();
  assert.strictEqual(historyAnchorInitializations, 1, 'bootstrap must initialize the explicitly injected history anchor module');
  assert.deepStrictEqual(calls, ['load-sessions:start'], 'background recovery must not race an incomplete session-store restore');

  releaseSessions();
  await started;
  assert.deepStrictEqual(calls.slice(0, 4), [
    'load-sessions:start',
    'load-sessions:end',
    'resume-background',
    'load-reasoning',
  ]);
}

module.exports = [
  testBackgroundSessionsResumeAndShowBusyStateAfterRestore,
  testBootstrapAwaitsSessionRestoreBeforeStartingBackgroundRecovery,
];
