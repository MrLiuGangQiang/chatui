'use strict';

const assert = require('assert');
const { createJobEventStream, jobIdFromEventUrl } = require('../../client/app/job-event-stream');
const jobWorkflow = require('../../client/app/job-workflow');
const jobService = require('../../client/services/job-service');

function fakeEventSource() {
  const instances = [];
  class FakeEventSource {
    constructor(url) {
      this.url = url;
      this.closed = false;
      this.listeners = new Map();
      this.onmessage = null;
      instances.push(this);
    }

    addEventListener(type, listener) {
      if (!this.listeners.has(type)) this.listeners.set(type, []);
      this.listeners.get(type).push(listener);
    }

    emit(type, payload) {
      const event = { data: JSON.stringify(payload) };
      if (type === 'message') this.onmessage?.(event);
      for (const listener of this.listeners.get(type) || []) listener(event);
    }

    close() {
      this.closed = true;
    }
  }
  return { FakeEventSource, instances };
}

function nextTurn() {
  return new Promise(resolve => setTimeout(resolve, 0));
}

function fakeClock() {
  let nextId = 1;
  let now = 0;
  const timers = new Map();
  function setTimeoutRef(callback, delay = 0) {
    const id = nextId++;
    timers.set(id, { callback, due: now + Math.max(0, Number(delay) || 0) });
    return id;
  }
  function clearTimeoutRef(id) {
    timers.delete(id);
  }
  function runNext() {
    if (!timers.size) return false;
    const [id, timer] = [...timers.entries()].sort((left, right) => left[1].due - right[1].due || left[0] - right[0])[0];
    timers.delete(id);
    now = timer.due;
    timer.callback();
    return true;
  }
  return { setTimeout: setTimeoutRef, clearTimeout: clearTimeoutRef, runNext, pending: () => timers.size };
}

function fakePageTarget() {
  const listeners = new Map();
  return {
    addEventListener(type, listener) {
      if (!listeners.has(type)) listeners.set(type, new Set());
      listeners.get(type).add(listener);
    },
    removeEventListener(type, listener) {
      listeners.get(type)?.delete(listener);
    },
    emit(type) {
      for (const listener of listeners.get(type) || []) listener();
    },
  };
}

async function testDifferentSessionsUseDedicatedEventSources() {
  assert.strictEqual(jobIdFromEventUrl('/api/chat-jobs/chatjob-a/events?contentLength=4'), 'chatjob-a');
  const { FakeEventSource, instances } = fakeEventSource();
  const stream = createJobEventStream({ EventSource: FakeEventSource });
  const first = stream.subscribe('chatjob-session-a', () => {}, { sessionId: 'session-a' });
  const second = stream.subscribe('chatjob-session-b', () => {}, { sessionId: 'session-b' });

  await nextTurn();
  assert.strictEqual(instances.length, 2, 'each active session must own a dedicated Chat Job EventSource');
  assert.match(instances[0].url, /^\/api\/chat-jobs\/chatjob-session-a\/events\?contentLength=0&reasoningLength=0$/);
  assert.match(instances[1].url, /^\/api\/chat-jobs\/chatjob-session-b\/events\?contentLength=0&reasoningLength=0$/);
  assert.ok(!instances[0].url.includes('ids='), 'a session stream must not multiplex task ids');
  instances[0].emit('message', { d: 'a' });
  instances[0].emit('message', { done: 1 });
  instances[1].emit('message', { d: 'b' });
  instances[1].emit('message', { done: 1 });
  const [firstResult, secondResult] = await Promise.all([first, second]);
  assert.strictEqual(firstResult.choices[0].message.content, 'a');
  assert.strictEqual(secondResult.choices[0].message.content, 'b');
}

async function testSameSessionJobReusesOneEventSource() {
  const { FakeEventSource, instances } = fakeEventSource();
  const stream = createJobEventStream({ EventSource: FakeEventSource });
  const first = stream.subscribe('chatjob-shared', () => {}, { sessionId: 'session-a' });
  const second = stream.subscribe('chatjob-shared', () => {}, { sessionId: 'session-a' });

  await nextTurn();
  assert.strictEqual(instances.length, 1, 'multiple waiters for one session/job must share its dedicated stream');
  instances[0].emit('message', { d: 'answer' });
  instances[0].emit('message', { r: 'thought' });
  instances[0].emit('message', { done: 1, rt: 12 });
  const results = await Promise.all([first, second]);
  assert.strictEqual(results[0].choices[0].message.content, 'answer');
  assert.strictEqual(results[0].choices[0].message.reasoning_content, 'thought');
  assert.strictEqual(results[0].metrics.durationMs, 12);
}

async function testJobWorkflowRoutesChatWaiterToItsSessionStream() {
  const { FakeEventSource, instances } = fakeEventSource();
  const updates = [];
  const waiting = jobWorkflow.waitJobEvent('/api/chat-jobs/chatjob-route/events', event => updates.push(event), {
    EventSource: FakeEventSource,
    sessionId: 'session-route',
    resumeOffsets: { baseContent: 'a:', baseReasoning: '' },
  });

  await nextTurn();
  assert.strictEqual(instances.length, 1);
  assert.match(instances[0].url, /^\/api\/chat-jobs\/chatjob-route\/events\?contentLength=2&reasoningLength=0$/);
  instances[0].emit('message', { d: '1' });
  instances[0].emit('message', { done: 1 });
  const result = await waiting;
  assert.strictEqual(result.choices[0].message.content, 'a:1');
  assert.strictEqual(updates.length, 2);
}

async function testMissingJobRejectsOnlyItsSessionStream() {
  const { FakeEventSource, instances } = fakeEventSource();
  const stream = createJobEventStream({ EventSource: FakeEventSource });
  const missing = stream.subscribe('chatjob-missing', () => {}, { sessionId: 'session-missing' });
  const healthy = stream.subscribe('chatjob-healthy', () => {}, { sessionId: 'session-healthy' });
  await nextTurn();

  instances[0].emit('message', { e: '任务不存在' });
  await assert.rejects(missing, error => error.terminalJob === true && error.message === '任务不存在');
  instances[1].emit('message', { d: 'ok' });
  instances[1].emit('message', { done: 1 });
  const result = await healthy;
  assert.strictEqual(result.choices[0].message.content, 'ok');
}

async function testSessionCannotOwnTwoLiveJobs() {
  const { FakeEventSource } = fakeEventSource();
  const stream = createJobEventStream({ EventSource: FakeEventSource });
  const first = stream.subscribe('chatjob-a', () => {}, { sessionId: 'session-a' });
  await assert.rejects(
    stream.subscribe('chatjob-b', () => {}, { sessionId: 'session-a' }),
    error => error.code === 'JOB_SESSION_CONFLICT',
  );
  stream.close();
  await assert.rejects(first, error => error.name === 'AbortError');
}

async function testResetFrameReplacesStaleResumeContent() {
  const { FakeEventSource, instances } = fakeEventSource();
  const stream = createJobEventStream({ EventSource: FakeEventSource });
  const waiting = stream.subscribe('chatjob-reset', () => {}, {
    sessionId: 'session-reset',
    resumeOffsets: { baseContent: 'stale', baseReasoning: 'old' },
  });
  await nextTurn();
  instances[0].emit('message', { z: 1, d: 'fresh', r: 'new', done: 1 });
  const result = await waiting;
  assert.strictEqual(result.choices[0].message.content, 'fresh');
  assert.strictEqual(result.choices[0].message.reasoning_content, 'new');
}

async function testReconnectUsesLatestCanonicalOffsets() {
  const { FakeEventSource, instances } = fakeEventSource();
  const clock = fakeClock();
  const stream = createJobEventStream({
    EventSource: FakeEventSource,
    setTimeout: clock.setTimeout,
    clearTimeout: clock.clearTimeout,
    random: () => 0.5,
  });
  const waiting = stream.subscribe('chatjob-reconnect', () => {}, { sessionId: 'session-reconnect' });
  await nextTurn();
  instances[0].emit('message', { d: 'a' });
  instances[0].onerror();
  assert.ok(clock.runNext(), 'a failed session stream must schedule one reconnect');
  assert.strictEqual(instances.length, 2);
  assert.match(instances[1].url, /contentLength=1&reasoningLength=0/);
  instances[1].emit('message', { d: 'b' });
  instances[1].emit('message', { done: 1 });
  const result = await waiting;
  assert.strictEqual(result.choices[0].message.content, 'ab');
}

async function testImagePollingContinuesWhilePageIsMarkedHidden() {
  const { FakeEventSource } = fakeEventSource();
  const clock = fakeClock();
  let polls = 0;
  const waiting = jobWorkflow.waitJobEvent('/api/image-jobs/imgjob-hidden/events', () => {}, {
    EventSource: FakeEventSource,
    isPageUnloading: () => true,
    setTimeout: clock.setTimeout,
    clearTimeout: clock.clearTimeout,
    pollJob: async () => {
      polls += 1;
      return polls === 1
        ? { status: 'running', data: null }
        : { status: 'done', data: { data: [{ url: 'https://img.example/hidden.png' }] } };
    },
  });
  await nextTurn();
  assert.strictEqual(polls, 1, 'a hidden-but-alive page must still perform the first completion poll');
  assert.ok(clock.runNext(), 'the completion poll must schedule its next turn even while hidden');
  await nextTurn();
  const result = await waiting;
  assert.strictEqual(polls, 2);
  assert.strictEqual(result.data[0].url, 'https://img.example/hidden.png');
}

async function testPageUnloadStopsReconnectAndRejectsFollower() {
  const { FakeEventSource, instances } = fakeEventSource();
  const page = fakePageTarget();
  const stream = createJobEventStream({ EventSource: FakeEventSource, pageEventTarget: page });
  const waiter = stream.subscribe('chatjob-page-unload', () => {}, { sessionId: 'session-page' });
  await nextTurn();
  page.emit('pagehide');
  await assert.rejects(waiter, error => error.name === 'AbortError');
  assert.strictEqual(instances[0].closed, true);
  await nextTurn();
  assert.strictEqual(instances.length, 1, 'page unload must stop reconnect timers');
}

async function testDefaultChatJobPollingUsesServiceGet() {
  const signal = new AbortController().signal;
  let request = null;
  const result = await jobService.getChatJob({
    jobId: 'chatjob/service',
    signal,
    fetchImpl: async (...args) => {
      request = args;
      return { ok: true, json: async () => ({ id: 'chatjob/service', status: 'running' }) };
    },
  });
  assert.strictEqual(request[0], '/api/chat-jobs/chatjob%2Fservice');
  assert.strictEqual(request[1].method, 'GET');
  assert.strictEqual(request[1].signal, signal);
  assert.strictEqual(result.status, 'running');
}

module.exports = [
  testDifferentSessionsUseDedicatedEventSources,
  testSameSessionJobReusesOneEventSource,
  testJobWorkflowRoutesChatWaiterToItsSessionStream,
  testMissingJobRejectsOnlyItsSessionStream,
  testSessionCannotOwnTwoLiveJobs,
  testResetFrameReplacesStaleResumeContent,
  testReconnectUsesLatestCanonicalOffsets,
  testImagePollingContinuesWhilePageIsMarkedHidden,
  testPageUnloadStopsReconnectAndRejectsFollower,
  testDefaultChatJobPollingUsesServiceGet,
];
