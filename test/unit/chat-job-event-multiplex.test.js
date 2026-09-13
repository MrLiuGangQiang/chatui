'use strict';

const assert = require('assert');
const { createJobEventMultiplexer, jobIdFromEventUrl } = require('../../client/app/job-event-multiplex');
const jobWorkflow = require('../../client/app/job-workflow');
const jobService = require('../../client/services/job-service');

function fakeEventSource() {
  const instances = [];
  class FakeEventSource {
    constructor(url) {
      this.url = url;
      this.closed = false;
      this.listeners = new Map();
      instances.push(this);
    }

    addEventListener(type, listener) {
      if (!this.listeners.has(type)) this.listeners.set(type, []);
      this.listeners.get(type).push(listener);
    }

    emit(type, payload) {
      for (const listener of this.listeners.get(type) || []) listener({ data: JSON.stringify(payload) });
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

function utf8ByteLength(value) {
  return new TextEncoder().encode(String(value)).length;
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

async function testConcurrentChatWaitersShareOneEventSource() {
  assert.strictEqual(jobIdFromEventUrl('/api/chat-jobs/chatjob-a/events?contentLength=4'), 'chatjob-a');
  const { FakeEventSource, instances } = fakeEventSource();
  const multiplexer = createJobEventMultiplexer({ EventSource: FakeEventSource });
  const updates = [];
  const first = multiplexer.subscribe('chatjob-a', event => updates.push(['a', event]), {
    resumeOffsets: { baseContent: 'a:', baseReasoning: '' },
  });
  const second = multiplexer.subscribe('chatjob-b', event => updates.push(['b', event]), {
    resumeOffsets: { baseContent: '', baseReasoning: '' },
  });

  await nextTurn();
  assert.strictEqual(instances.length, 1, 'all chat job waiters must share one SSE connection');
  assert.match(instances[0].url, /^\/api\/chat-jobs\/events\?/);
  assert.match(instances[0].url, /ids=chatjob-a%2Cchatjob-b/);
  assert.match(instances[0].url, /offset=chatjob-a%3A2%3A0/);

  instances[0].emit('job', { id: 'chatjob-a', status: 'running', d: '1' });
  instances[0].emit('job', { id: 'chatjob-a', status: 'done', done: 1 });
  instances[0].emit('job', { id: 'chatjob-b', status: 'running', d: 'b' });
  instances[0].emit('job', { id: 'chatjob-b', status: 'done', done: 1 });

  const [firstResult, secondResult] = await Promise.all([first, second]);
  assert.strictEqual(firstResult.choices[0].message.content, 'a:1');
  assert.strictEqual(secondResult.choices[0].message.content, 'b');
  assert.strictEqual(instances[0].closed, true, 'the shared stream must close after every owned job settles');
  assert.deepStrictEqual(updates.map(item => item[0]), ['a', 'a', 'b', 'b']);
}

async function testJobWorkflowRoutesChatWaitersThroughTheSharedStream() {
  const { FakeEventSource, instances } = fakeEventSource();
  const first = jobWorkflow.waitJobEvent('/api/chat-jobs/chatjob-route-a/events', () => {}, {
    EventSource: FakeEventSource,
    resumeOffsets: { baseContent: 'a:', baseReasoning: '' },
  });
  const second = jobWorkflow.waitJobEvent('/api/chat-jobs/chatjob-route-b/events', () => {}, {
    EventSource: FakeEventSource,
    resumeOffsets: { baseContent: '', baseReasoning: '' },
  });

  await nextTurn();
  assert.strictEqual(instances.length, 1, 'job workflow chat waiters must not open one EventSource per session');
  instances[0].emit('job', { id: 'chatjob-route-a', status: 'done', d: '1', done: 1 });
  instances[0].emit('job', { id: 'chatjob-route-b', status: 'done', d: '2', done: 1 });
  const results = await Promise.all([first, second]);
  assert.strictEqual(results[0].choices[0].message.content, 'a:1');
  assert.strictEqual(results[1].choices[0].message.content, '2');
}

async function testMissingMultiplexedJobRejectsOnlyItsWaiter() {
  const { FakeEventSource, instances } = fakeEventSource();
  const multiplexer = createJobEventMultiplexer({ EventSource: FakeEventSource });
  const missing = multiplexer.subscribe('chatjob-missing', () => {});
  const healthy = multiplexer.subscribe('chatjob-healthy', () => {});
  await nextTurn();

  instances[0].emit('job', { id: 'chatjob-missing', status: 'error', error: { message: '任务不存在' } });
  await assert.rejects(missing, error => error.terminalJob === true && error.message === '任务不存在');

  instances[0].emit('job', { id: 'chatjob-healthy', status: 'running', d: 'ok' });
  instances[0].emit('job', { id: 'chatjob-healthy', status: 'done', done: 1 });
  const result = await healthy;
  assert.strictEqual(result.choices[0].message.content, 'ok');
}

async function testChatJobsUseStableBoundedFirstFitShards() {
  const { FakeEventSource, instances } = fakeEventSource();
  const multiplexer = createJobEventMultiplexer({ EventSource: FakeEventSource });
  const waiters = Array.from({ length: 130 }, (_, index) => multiplexer.subscribe(`chatjob-${String(index).padStart(3, '0')}`, () => {}));
  try {
    await nextTurn();
    assert.strictEqual(instances.length, 3, '130 short ids must use stable first-fit shards of at most 64 ids');
    const shardIds = instances.map(source => {
      const query = new URL(source.url, 'http://localhost').searchParams;
      const ids = query.get('ids').split(',');
      assert.ok(ids.length <= 64, 'each shard must carry at most 64 ids');
      assert.ok(utf8ByteLength(source.url) <= 6144, 'the complete request-target must stay within 6144 UTF-8 bytes');
      assert.deepStrictEqual(ids, [...ids].sort(), 'ids in a shard must be sorted');
      return ids;
    });
    assert.deepStrictEqual(shardIds.flat(), Array.from({ length: 130 }, (_, index) => `chatjob-${String(index).padStart(3, '0')}`));
  } finally {
    multiplexer.close();
    await Promise.allSettled(waiters);
  }
}

async function testLongIdsOverflowIntoBoundedPollingInsteadOfAFifthEventSource() {
  const { FakeEventSource, instances } = fakeEventSource();
  const pollCalls = [];
  let activePolls = 0;
  let maxActivePolls = 0;
  const multiplexer = createJobEventMultiplexer({
    EventSource: FakeEventSource,
    pollJob: async (jobId) => {
      pollCalls.push(jobId);
      activePolls += 1;
      maxActivePolls = Math.max(maxActivePolls, activePolls);
      await new Promise(resolve => setTimeout(resolve, 10));
      activePolls -= 1;
      return { id: jobId, status: 'done', done: 1, data: { choices: [{ message: { content: 'polled', reasoning_content: '' } }] } };
    },
  });
  const ids = Array.from({ length: 64 }, (_, index) => `chatjob-${index}-${'x'.repeat(400)}`);
  const waiters = ids.map(id => multiplexer.subscribe(id, () => {}));
  try {
    await nextTurn();
    assert.ok(instances.length <= 4, 'overflow must never create a fifth EventSource');
    assert.ok(multiplexer.getState().overflowJobIds.length > 0, 'jobs that cannot fit the URL must be visible as overflow jobs');
    assert.ok(multiplexer.getState().overflowJobIds.length < ids.length, 'first-fit should retain every job that can fit');
    assert.ok(multiplexer.getState().pollConcurrency <= 4, 'overflow polling concurrency must be bounded at four');
    await new Promise(resolve => setTimeout(resolve, 2600));
    assert.ok(pollCalls.length > 0, 'overflow jobs must use GET polling after the fixed interval');
    assert.ok(maxActivePolls <= 4, 'GET polling must never exceed four in-flight requests');
  } finally {
    multiplexer.close();
    await Promise.allSettled(waiters);
  }
}

async function testCanonicalAggregatePreservesStatusOnlyUsesUtf16AndRejectsCrossSessionFollowers() {
  const { FakeEventSource, instances } = fakeEventSource();
  const multiplexer = createJobEventMultiplexer({ EventSource: FakeEventSource });
  const firstUpdates = [];
  const secondUpdates = [];
  const first = multiplexer.subscribe('chatjob-canonical', (event, meta) => firstUpdates.push({ event, meta }), {
    sessionId: 'session-a',
    displayItemId: 'display-a',
    responseIndex: 7,
    resumeOffsets: { baseContent: 'stale', baseReasoning: '' },
  });
  await nextTurn();
  instances[0].emit('job', {
    id: 'chatjob-canonical',
    status: 'running',
    data: { choices: [{ message: { content: '😀a', reasoning_content: '思' } }] },
  });

  const second = multiplexer.subscribe('chatjob-canonical', (event, meta) => secondUpdates.push({ event, meta }), {
    sessionId: 'session-a',
    displayItemId: 'display-b',
    responseIndex: 8,
    resumeOffsets: { baseContent: 'wrong-local-base', baseReasoning: 'wrong' },
  });
  await nextTurn();
  assert.strictEqual(secondUpdates[0].event.data.choices[0].message.content, '😀a', 'a later waiter must receive the canonical aggregate, not its local base');
  assert.deepStrictEqual(secondUpdates[0].meta, {
    jobId: 'chatjob-canonical',
    sessionId: 'session-a',
    displayItemId: 'display-b',
    responseIndex: 8,
    liveItemId: '',
    submissionId: '',
    ownerToken: '',
  });
  await assert.rejects(
    multiplexer.subscribe('chatjob-canonical', () => {}, { sessionId: 'session-b' }),
    error => error.code === 'JOB_SESSION_CONFLICT',
    'a conflicting session follower must be rejected without changing the existing canonical record',
  );

  instances[0].emit('job', { id: 'chatjob-canonical', status: 'running' });
  instances[0].emit('job', { id: 'chatjob-canonical', d: '好' });
  instances[0].emit('job', { id: 'chatjob-canonical', done: 1 });
  const [firstResult, secondResult] = await Promise.all([first, second]);
  assert.strictEqual(firstResult.choices[0].message.content, '😀a好');
  assert.strictEqual(secondResult.choices[0].message.content, '😀a好');
  assert.strictEqual(firstResult.choices[0].message.reasoning_content, '思');
  assert.match(multiplexer.getState().lastBuiltUrl || '', /offset=chatjob-canonical%3A4%3A1/);
  assert.ok(firstUpdates.every(update => update.meta.sessionId === 'session-a'));
}


async function testAbortOnlyLeavesOtherCanonicalWaiterFollowing() {
  const { FakeEventSource, instances } = fakeEventSource();
  const multiplexer = createJobEventMultiplexer({ EventSource: FakeEventSource });
  const firstController = new AbortController();
  const first = multiplexer.subscribe('chatjob-abort-one', () => {}, { sessionId: 'session-a', signal: firstController.signal });
  const second = multiplexer.subscribe('chatjob-abort-one', () => {}, { sessionId: 'session-a' });
  await nextTurn();
  firstController.abort();
  await assert.rejects(first, error => error.name === 'AbortError');
  assert.strictEqual(instances[0].closed, false, 'aborting one waiter must not close a shared source');
  instances[0].emit('job', { id: 'chatjob-abort-one', status: 'done', data: { choices: [{ message: { content: 'kept', reasoning_content: '' } }] } });
  const result = await second;
  assert.strictEqual(result.choices[0].message.content, 'kept');
  assert.strictEqual(instances[0].closed, true);
}

async function testRebuiltShardClosesOldSourceAndIgnoresStaleCallbacks() {
  const { FakeEventSource, instances } = fakeEventSource();
  const multiplexer = createJobEventMultiplexer({ EventSource: FakeEventSource });
  const first = multiplexer.subscribe('chatjob-stale-a', () => {});
  await nextTurn();
  const second = multiplexer.subscribe('chatjob-stale-b', () => {});
  await nextTurn();
  await nextTurn();
  assert.ok(instances.length >= 2, 'adding a Job to a live shard must rebuild that shard');
  assert.strictEqual(instances[0].closed, true, 'the old EventSource must close before replacement');
  instances[0].emit('job', { id: 'chatjob-stale-a', status: 'done', d: 'stale' });
  instances[1].emit('job', { id: 'chatjob-stale-a', status: 'done', d: 'fresh-a', done: 1 });
  instances[1].emit('job', { id: 'chatjob-stale-b', status: 'done', d: 'fresh-b', done: 1 });
  const [firstResult, secondResult] = await Promise.all([first, second]);
  assert.strictEqual(firstResult.choices[0].message.content, 'fresh-a');
  assert.strictEqual(secondResult.choices[0].message.content, 'fresh-b');
}

async function testPageUnloadStopsReconnectAndRejectsFollower() {
  const { FakeEventSource, instances } = fakeEventSource();
  const page = fakePageTarget();
  const multiplexer = createJobEventMultiplexer({ EventSource: FakeEventSource, pageEventTarget: page });
  const waiter = multiplexer.subscribe('chatjob-page-unload', () => {});
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
  testConcurrentChatWaitersShareOneEventSource,
  testJobWorkflowRoutesChatWaitersThroughTheSharedStream,
  testMissingMultiplexedJobRejectsOnlyItsWaiter,
  testChatJobsUseStableBoundedFirstFitShards,
  testLongIdsOverflowIntoBoundedPollingInsteadOfAFifthEventSource,
  testCanonicalAggregatePreservesStatusOnlyUsesUtf16AndRejectsCrossSessionFollowers,
  testAbortOnlyLeavesOtherCanonicalWaiterFollowing,
  testRebuiltShardClosesOldSourceAndIgnoresStaleCallbacks,
  testPageUnloadStopsReconnectAndRejectsFollower,
  testDefaultChatJobPollingUsesServiceGet,
];
