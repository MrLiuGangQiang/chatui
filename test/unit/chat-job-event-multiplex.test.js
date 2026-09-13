'use strict';

const assert = require('assert');
const { createJobEventMultiplexer, jobIdFromEventUrl } = require('../../client/app/job-event-multiplex');
const jobWorkflow = require('../../client/app/job-workflow');

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

module.exports = [
  testConcurrentChatWaitersShareOneEventSource,
  testJobWorkflowRoutesChatWaitersThroughTheSharedStream,
  testMissingMultiplexedJobRejectsOnlyItsWaiter,
];
