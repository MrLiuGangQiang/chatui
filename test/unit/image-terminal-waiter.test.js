'use strict';

const assert = require('assert');

const jobWorkflow = require('../../client/app/job-workflow');
const jobService = require('../../client/services/job-service');

function nextTurn() {
  return new Promise(resolve => setImmediate(resolve));
}

function fakeClock() {
  let now = 0;
  let nextId = 1;
  const timers = new Map();
  return {
    setTimeout(callback, delay = 0) {
      const id = nextId++;
      timers.set(id, { id, at: now + Math.max(0, Number(delay) || 0), callback });
      return id;
    },
    clearTimeout(id) {
      timers.delete(id);
    },
    runNext() {
      let next = null;
      for (const timer of timers.values()) {
        if (!next || timer.at < next.at || (timer.at === next.at && timer.id < next.id)) next = timer;
      }
      if (!next) return false;
      timers.delete(next.id);
      now = next.at;
      next.callback();
      return true;
    },
  };
}

class SilentEventSource {
  constructor() {}
  addEventListener() {}
  close() {}
}

async function settleOutcome(promise) {
  return Promise.race([
    promise.then(() => ({ kind: 'resolved' }), error => ({ kind: 'rejected', error })),
    new Promise(resolve => setTimeout(() => resolve({ kind: 'pending' }), 40)),
  ]);
}

async function testImageTerminalErrorSettlesWhenUpdateCallbackThrows() {
  const clock = fakeClock();
  const controller = new AbortController();
  let polls = 0;
  const waiting = jobWorkflow.waitJobEvent(
    '/api/image-jobs/imgjob-terminal-update/events',
    () => { throw new Error('DOM update failed'); },
    {
      EventSource: SilentEventSource,
      signal: controller.signal,
      setTimeout: clock.setTimeout,
      clearTimeout: clock.clearTimeout,
      pollJob: async () => {
        polls += 1;
        if (polls === 1) return { id: 'imgjob-terminal-update', status: 'running', data: null };
        return {
          id: 'imgjob-terminal-update',
          status: 'error',
          data: null,
          metrics: {},
          error: { message: '上游请求失败：quota exceeded' },
        };
      },
    },
  );
  const outcomePromise = settleOutcome(waiting);
  let outcome;
  try {
    await nextTurn();
    assert.strictEqual(polls, 1, 'the first poll must run immediately');
    assert.strictEqual(clock.runNext(), true, 'polling must schedule its next attempt');
    await nextTurn();
    outcome = await outcomePromise;
  } finally {
    controller.abort();
  }
  assert.strictEqual(outcome.kind, 'rejected', 'a terminal error must settle even when the UI update callback throws');
  assert.strictEqual(outcome.error.terminalJob, true);
  assert.match(outcome.error.message, /quota exceeded/);
}

async function testMissingImageJobPollFailureRejectsInsteadOfPollingForever() {
  const clock = fakeClock();
  const controller = new AbortController();
  const missing = new Error('任务不存在或服务已重启');
  missing.statusCode = 404;
  const waiting = jobWorkflow.waitJobEvent(
    '/api/image-jobs/imgjob-missing-poll/events',
    () => {},
    {
      EventSource: SilentEventSource,
      signal: controller.signal,
      setTimeout: clock.setTimeout,
      clearTimeout: clock.clearTimeout,
      pollJob: async () => { throw missing; },
    },
  );
  const outcomePromise = settleOutcome(waiting);
  let outcome;
  try {
    await nextTurn();
    outcome = await outcomePromise;
  } finally {
    controller.abort();
  }
  assert.strictEqual(outcome.kind, 'rejected', 'a 404 poll must become a terminal result instead of an infinite retry loop');
  assert.strictEqual(outcome.error.terminalJob, true);
  assert.match(outcome.error.message, /任务不存在|服务已重启/);
}

async function testRepeatedObservationFailuresRejectInsteadOfPollingForever() {
  const clock = fakeClock();
  const controller = new AbortController();
  let polls = 0;
  const waiting = jobWorkflow.waitJobEvent(
    '/api/image-jobs/imgjob-poll-failures/events',
    () => {},
    {
      EventSource: SilentEventSource,
      signal: controller.signal,
      setTimeout: clock.setTimeout,
      clearTimeout: clock.clearTimeout,
      pollJob: async () => {
        polls += 1;
        throw new Error('network down');
      },
    },
  );
  const outcomePromise = settleOutcome(waiting);
  let outcome;
  try {
    await nextTurn();
    for (let attempt = 1; attempt < 5; attempt += 1) {
      assert.strictEqual(clock.runNext(), true, 'a failed observation must schedule its bounded retry');
      await nextTurn();
    }
    outcome = await outcomePromise;
  } finally {
    controller.abort();
  }
  assert.strictEqual(polls, 5);
  assert.strictEqual(outcome.kind, 'rejected', 'repeated observation failures must end the waiter');
  assert.match(outcome.error.message, /任务状态获取失败/);
}

async function testServiceTerminalErrorSettlesWhenUpdateCallbackThrows() {
  const controller = new AbortController();
  const waiting = jobService.waitJobEvent({
    url: '/api/image-jobs/imgjob-service-terminal/events',
    onUpdate: () => { throw new Error('DOM update failed'); },
    signal: controller.signal,
    fetchImpl: async () => ({ ok: false, body: null }),
    pollJob: async () => ({
      id: 'imgjob-service-terminal',
      status: 'error',
      data: null,
      metrics: {},
      error: { message: '上游请求失败：quota exceeded' },
    }),
    pollIntervalMs: 2500,
  });
  let outcome;
  try {
    outcome = await settleOutcome(waiting);
  } finally {
    controller.abort();
  }
  assert.strictEqual(outcome.kind, 'rejected', 'the service waiter must settle terminal errors independently of the UI callback');
  assert.strictEqual(outcome.error.terminalJob, true);
  assert.match(outcome.error.message, /quota exceeded/);
}

module.exports = [
  testImageTerminalErrorSettlesWhenUpdateCallbackThrows,
  testMissingImageJobPollFailureRejectsInsteadOfPollingForever,
  testServiceTerminalErrorSettlesWhenUpdateCallbackThrows,
  testRepeatedObservationFailuresRejectInsteadOfPollingForever,
];
