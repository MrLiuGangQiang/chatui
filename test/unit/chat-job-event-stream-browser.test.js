'use strict';

const assert = require('assert');
const path = require('path');
const vm = require('vm');
const staticBundle = require('../../server/services/static-bundle.service');

function browserRuntime() {
  const root = path.resolve(__dirname, '../..');
  const requiredPaths = [
    '/client/runtime/module-registry.js',
    '/client/core/job-event-aggregate.js',
    '/client/app/job-event-transport.js',
    '/client/app/job-event-stream.js',
    '/client/app/job-workflow.js',
  ];
  const entries = staticBundle.parseAssetManifest(root, `${root}${path.sep}`, 'js')
    .filter(entry => requiredPaths.includes(entry.urlPath));
  assert.deepStrictEqual(entries.map(entry => entry.urlPath), requiredPaths);

  const timers = new Map();
  let nextTimerId = 1;
  const sources = [];
  class BrowserEventSource {
    constructor(url) {
      this.url = url;
      this.closed = false;
      this.listeners = new Map();
      this.onmessage = null;
      sources.push(this);
    }
    addEventListener(type, listener) {
      this.listeners.set(type, listener);
    }
    emit(payload) {
      this.onmessage?.({ data: JSON.stringify(payload) });
    }
    close() {
      this.closed = true;
    }
  }
  const context = vm.createContext({
    URL, URLSearchParams, TextEncoder, AbortController, DOMException,
    EventSource: BrowserEventSource,
    setTimeout(callback) {
      const id = nextTimerId++;
      timers.set(id, callback);
      return id;
    },
    clearTimeout(id) {
      timers.delete(id);
    },
  });
  vm.runInContext('globalThis.window = globalThis;', context);
  // Real manifest entries and bundle assembly, without CommonJS or Node globals.
  vm.runInContext(staticBundle.buildBundleBody(entries, 'js').toString('utf8'), context, {
    filename: 'chat-job-browser.bundle.js',
  });
  assert.strictEqual(vm.runInContext('typeof require', context), 'undefined');
  assert.strictEqual(vm.runInContext('typeof module', context), 'undefined');
  assert.strictEqual(vm.runInContext('typeof Buffer', context), 'undefined');
  const registry = vm.runInContext("globalThis[Symbol.for('chatui.module-registry.v1')].get('moduleRegistry')", context);
  return {
    context, sources, registry, BrowserEventSource, timers,
    flushTimers() {
      for (let count = 0; timers.size; count += 1) {
        assert.ok(count < 20, 'browser test must not leave a recurring timer');
        const [id, callback] = timers.entries().next().value;
        timers.delete(id);
        callback();
      }
    },
  };
}

async function testBrowserJobWorkflowUsesOneStreamPerSession() {
  const runtime = browserRuntime();
  const workflow = runtime.context.ChatUIAppJobWorkflow;
  const controllers = [new AbortController(), new AbortController()];
  const waiters = [];
  const updates = [];
  try {
    waiters.push(workflow.waitJobEvent('/api/chat-jobs/chatjob-browser-a/events', (event, metadata) => {
      updates.push(['a', metadata.sessionId, event.data.choices[0].message.content]);
    }, {
      signal: controllers[0].signal,
      sessionId: 'session-a',
      resumeOffsets: { baseContent: '已有😀', baseReasoning: '思' },
      listenPageUnload: false,
    }));
    waiters.push(workflow.waitJobEvent('/api/chat-jobs/chatjob-browser-b/events', (event, metadata) => {
      updates.push(['b', metadata.sessionId, event.data.choices[0].message.content]);
    }, {
      signal: controllers[1].signal,
      sessionId: 'session-b',
      listenPageUnload: false,
    }));
    runtime.flushTimers();
    assert.strictEqual(runtime.sources.length, 2, 'each browser session must own one EventSource');
    const firstSource = runtime.sources[0];
    const secondSource = runtime.sources[1];
    assert.match(firstSource.url, /^\/api\/chat-jobs\/chatjob-browser-a\/events\?contentLength=4&reasoningLength=1$/);
    assert.ok(!firstSource.url.includes('ids='));
    firstSource.emit({ d: '正文', r: '考' });
    firstSource.emit({ done: 1 });
    assert.strictEqual(firstSource.closed, true, 'the finished session stream must close');
    assert.strictEqual(secondSource.closed, false, 'the other session must keep following');
    secondSource.emit({ d: '另一会话' });
    secondSource.emit({ done: 1 });
    const results = await Promise.all(waiters);
    assert.strictEqual(results[0].choices[0].message.content, '已有😀正文');
    assert.strictEqual(results[0].choices[0].message.reasoning_content, '思考');
    assert.strictEqual(results[1].choices[0].message.content, '另一会话');
    assert.deepStrictEqual(updates.map(([session]) => session), ['a', 'a', 'b', 'b']);
    assert.deepStrictEqual(updates.map(([, sessionId]) => sessionId), ['session-a', 'session-a', 'session-b', 'session-b']);
    assert.strictEqual(secondSource.closed, true);
    assert.strictEqual(runtime.timers.size, 0);
  } finally {
    for (const controller of controllers) controller.abort();
    await Promise.allSettled(waiters);
  }
}

function testBrowserJobTransportResolvesAggregateThroughTheRealRegistry() {
  const runtime = browserRuntime();
  const aggregate = runtime.registry.resolve('jobEventAggregate');
  const record = {
    id: 'chatjob-browser-transport',
    aggregate: aggregate.initialAggregate({ baseContent: '前缀', baseReasoning: '' }),
    sessionId: 'session-transport',
    transport: 'pending',
    source: null,
    epoch: 0,
    failureCount: 0,
    reconnectTimer: null,
  };
  const records = new Map([[record.id, record]]);
  // Do not inject aggregate: exercise the transport's own browser lookup too.
  const transport = runtime.registry.resolve('jobEventTransport').createJobEventTransport({
    EventSource: runtime.BrowserEventSource,
    records,
    applyPayload: aggregate.applyEvent,
  });
  try {
    transport.reconcile();
    runtime.flushTimers();
    assert.strictEqual(runtime.sources.length, 1);
    runtime.sources[0].emit({ d: '结果', r: '思考', done: 1 });
    assert.strictEqual(record.aggregate.data.choices[0].message.content, '前缀结果');
    assert.strictEqual(record.aggregate.data.choices[0].message.reasoning_content, '思考');
    assert.strictEqual(record.aggregate.status, 'done');
    transport.removeRecord(record);
    assert.strictEqual(transport.getState().recordCount, 0);
    assert.strictEqual(transport.getState().connectionCount, 0);
    assert.strictEqual(runtime.sources[0].closed, true);
    assert.strictEqual(runtime.timers.size, 0);
  } finally {
    transport.close();
  }
}

module.exports = [
  testBrowserJobWorkflowUsesOneStreamPerSession,
  testBrowserJobTransportResolvesAggregateThroughTheRealRegistry,
];
