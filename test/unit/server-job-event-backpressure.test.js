'use strict';

const assert = require('assert');
const { EventEmitter } = require('events');
const { createJobEvents } = require('../../server/jobs/events');
const { createSseWriter } = require('../../server/http/sse-writer');
const { bindJobOwner } = require('../../server/security/job-ownership');
const { createRequestPrincipalService } = require('../../server/security/request-principal');

class BackpressureResponse extends EventEmitter {
  constructor() {
    super();
    this.status = 0;
    this.headers = {};
    this.chunks = [];
    this.ended = false;
    this.blockNextWrite = false;
    this.destroyed = false;
    this.endCalls = 0;
  }

  writeHead(status, headers = {}) {
    this.status = status;
    this.headers = headers;
  }

  write(chunk) {
    this.chunks.push(String(chunk || ''));
    if (this.blockNextWrite) {
      this.blockNextWrite = false;
      return false;
    }
    return true;
  }

  flushHeaders() {}

  end(chunk = '') {
    if (chunk) this.chunks.push(String(chunk));
    this.endCalls += 1;
    this.ended = true;
  }

  destroy() {
    this.destroyed = true;
    this.emit('close');
  }
}

function makeRequest(url, principal, onClose = () => {}) {
  return {
    url,
    authPrincipal: principal,
    on(type, handler) { if (type === 'close') onClose(handler); },
  };
}

function makeJob(principal, id = 'chatjob-backpressure') {
  const job = {
    id,
    status: 'running',
    createdAt: 1,
    updatedAt: 2,
    compactStream: true,
    data: { choices: [{ message: { content: 'a', reasoning_content: '' } }] },
    error: '',
  };
  bindJobOwner(job, principal);
  return job;
}

function parseEvents(chunks) {
  return chunks.join('').split('\n\n').filter(block => block.includes('data: ')).map(block => {
    const data = block.split('\n').find(line => line.startsWith('data: '));
    return JSON.parse(data.slice(6));
  });
}

function testBackpressureWaitsForDrainAndMergesDirtyNotifications() {
  const principal = createRequestPrincipalService({ secret: 's'.repeat(32) }).resolveRequest({ headers: {} }).principal;
  const job = makeJob(principal);
  const store = new Map([[job.id, job]]);
  const subscribers = new Map();
  const { subscribeJob, notifyJob } = createJobEvents({ jobSubscribers: subscribers });
  const response = new BackpressureResponse();
  response.blockNextWrite = true;
  subscribeJob(makeRequest(`/api/chat-jobs/${encodeURIComponent(job.id)}/events?contentLength=0&reasoningLength=0`, principal), response, store);

  assert.strictEqual(response.ended, false, 'a false write must not close the response');
  const writesWhileBlocked = response.chunks.length;
  job.data.choices[0].message.content = 'abc';
  notifyJob(job);
  job.data.choices[0].message.content = 'abcd';
  notifyJob(job);
  assert.strictEqual(response.chunks.length, writesWhileBlocked, 'dirty notifications must not write while blocked');

  response.emit('drain');
  const events = parseEvents(response.chunks);
  assert.strictEqual(events.length, 2, 'the initial frame and one merged live frame should be written');
  assert.strictEqual(events.at(-1).d, 'bcd');
  assert.strictEqual(response.endCalls, 0);
}

function createFakeClock() {
  let now = 0;
  let sequence = 0;
  const timers = new Set();
  const immediates = [];
  function add(timer) { timers.add(timer); return timer; }
  function setTimeoutImpl(callback, delay) { return add({ type: 'timeout', callback, delay, due: now + delay, sequence: sequence++, cancelled: false, unref() {} }); }
  function setIntervalImpl(callback, delay) { return add({ type: 'interval', callback, delay, due: now + delay, sequence: sequence++, cancelled: false, unref() {} }); }
  function clearTimer(timer) { if (timer) timer.cancelled = true; timers.delete(timer); }
  function setImmediateImpl(callback) { immediates.push(callback); return { callback, cancelled: false }; }
  function clearImmediateImpl(timer) { if (timer) timer.cancelled = true; }
  function runImmediates() { while (immediates.length) { const callback = immediates.shift(); callback(); } }
  function advance(ms) {
    const target = now + ms;
    while (true) {
      const due = [...timers].filter(timer => !timer.cancelled && timer.due <= target).sort((a, b) => a.due - b.due || a.sequence - b.sequence)[0];
      if (!due) break;
      now = due.due;
      if (due.type === 'timeout') timers.delete(due);
      else due.due += due.delay;
      if (!due.cancelled) due.callback();
      runImmediates();
    }
    now = target;
    runImmediates();
  }
  return { setTimeoutImpl, setIntervalImpl, clearTimeoutImpl: clearTimer, clearIntervalImpl: clearTimer, setImmediateImpl, clearImmediateImpl, advance, pending: () => timers.size };
}

function testSseWriterSerializesUtf8ChunksAndDoesNotRewriteFalseChunk() {
  const response = new BackpressureResponse();
  response.blockNextWrite = true;
  const writer = createSseWriter(response, { heartbeatMs: 60_000 });
  const text = '😀'.repeat(5000);
  let accepted = 0;
  writer.enqueue(text, () => { accepted += 1; });
  assert.strictEqual(accepted, 0);
  assert.ok(response.chunks.length >= 1);
  assert.ok(response.chunks.every(chunk => Buffer.byteLength(chunk, 'utf8') <= 16 * 1024));
  response.emit('drain');
  assert.strictEqual(accepted, 1);
  assert.strictEqual(response.chunks.join(''), text);
  assert.strictEqual(response.chunks.length, Math.ceil(Buffer.byteLength(text, 'utf8') / (16 * 1024)), 'the blocked chunk must not be rewritten');
  writer.close();
  assert.strictEqual(response.endCalls, 1);
}

function testDrainTimeoutDestroysOnlyTheBlockedSubscriberAndCleansState() {
  const clock = createFakeClock();
  const principal = createRequestPrincipalService({ secret: 's'.repeat(32) }).resolveRequest({ headers: {} }).principal;
  const job = makeJob(principal, 'chatjob-drain-timeout');
  const subscribers = new Map();
  const response = new BackpressureResponse();
  response.blockNextWrite = true;
  const events = createJobEvents({
    jobSubscribers: subscribers,
    setTimeoutImpl: clock.setTimeoutImpl,
    clearTimeoutImpl: clock.clearTimeoutImpl,
    setImmediateImpl: clock.setImmediateImpl,
    clearImmediateImpl: clock.clearImmediateImpl,
    writerOptions: { setTimeoutImpl: clock.setTimeoutImpl, clearTimeoutImpl: clock.clearTimeoutImpl, setIntervalImpl: clock.setIntervalImpl, clearIntervalImpl: clock.clearIntervalImpl },
  });
  events.subscribeJob({ url: '/api/chat-jobs/' + encodeURIComponent(job.id) + '/events?contentLength=0&reasoningLength=0', authPrincipal: principal, on() {} }, response, new Map([[job.id, job]]));
  clock.advance(9_999);
  assert.strictEqual(response.destroyed, false);
  clock.advance(1);
  assert.strictEqual(response.destroyed, true);
  assert.strictEqual(subscribers.size, 0);
  assert.strictEqual(response.endCalls, 0);
  clock.advance(10_000);
  assert.strictEqual(response.destroyed, true, 'a stale timeout callback must not close twice');
  assert.strictEqual(clock.pending(), 0);
}

function testKeepaliveIsFifteenSecondsAndResponseCloseCleansIt() {
  const clock = createFakeClock();
  const principal = createRequestPrincipalService({ secret: 's'.repeat(32) }).resolveRequest({ headers: {} }).principal;
  const job = makeJob(principal, 'chatjob-keepalive');
  const subscribers = new Map();
  let requestClose = null;
  const response = new BackpressureResponse();
  const events = createJobEvents({
    jobSubscribers: subscribers,
    setTimeoutImpl: clock.setTimeoutImpl,
    clearTimeoutImpl: clock.clearTimeoutImpl,
    writerOptions: { setTimeoutImpl: clock.setTimeoutImpl, clearTimeoutImpl: clock.clearTimeoutImpl, setIntervalImpl: clock.setIntervalImpl, clearIntervalImpl: clock.clearIntervalImpl },
  });
  events.subscribeJob({ url: '/api/chat-jobs/' + encodeURIComponent(job.id) + '/events?contentLength=0&reasoningLength=0', authPrincipal: principal, on(type, handler) { if (type === 'close') requestClose = handler; } }, response, new Map([[job.id, job]]));
  const before = response.chunks.length;
  const updatedAt = job.updatedAt;
  clock.advance(14_999);
  assert.strictEqual(response.chunks.length, before);
  clock.advance(1);
  assert.strictEqual(response.chunks.at(-1), ': keepalive\n\n');
  assert.strictEqual(job.updatedAt, updatedAt);
  requestClose?.();
  assert.strictEqual(subscribers.size, 0);
  assert.strictEqual(clock.pending(), 0);
}

function testSseWriterClosesOnceAndCleansDrainTimeoutAndKeepalive() {
  const response = new BackpressureResponse();
  const timers = [];
  const cleared = [];
  const writer = createSseWriter(response, {
    setTimeoutImpl(callback, delay) {
      const timer = { callback, delay, unref() {} };
      timers.push(timer);
      return timer;
    },
    clearTimeoutImpl(timer) { cleared.push(timer); },
    setIntervalImpl(callback, delay) {
      const timer = { callback, delay, unref() {} };
      timers.push(timer);
      return timer;
    },
    clearIntervalImpl(timer) { cleared.push(timer); },
  });

  assert.strictEqual(writer.enqueue(': data\n\n', () => {}), true);
  const heartbeat = timers.find(timer => timer.delay === 15_000);
  assert.ok(heartbeat, 'the writer must install the 15 second keepalive timer');
  heartbeat.callback();
  assert.ok(response.chunks.includes(': keepalive\n\n'));

  writer.close();
  writer.close();
  assert.strictEqual(response.endCalls, 1, 'close must end the response exactly once');
  assert.ok(cleared.length >= 1, 'close must clear writer timers');
}


async function testLegacyCompactDeltasSurviveABlockedWriter() {
  const { createJobEvents } = require('../../server/jobs/events');
  const { bindJobOwner } = require('../../server/security/job-ownership');
  const owner = require('../helpers/request-principal-fixture').makeTestPrincipal();
  const job = { id:'chatjob-legacy-backpressure', status:'running', compactStream:true, data:{choices:[{message:{}}]}, streamDelta:null };
  bindJobOwner(job, owner);
  const store = new Map([[job.id, job]]); const subscribers = new Map();
  const events = createJobEvents({ jobSubscribers: subscribers });
  const res = { status:0, chunks:[], endCalls:0, blocked:true, listeners:{}, writeHead(s){this.status=s}, flushHeaders(){}, write(chunk){this.chunks.push(String(chunk)); return !this.blocked}, once(k,f){this.listeners[k]=f}, removeListener(k){delete this.listeners[k]}, end(){this.endCalls++} };
  const req = { url:'/api/chat-jobs/'+encodeURIComponent(job.id)+'/events?contentLength=0&reasoningLength=0', authPrincipal:owner, listeners:{}, on(k,f){this.listeners[k]=f}, removeListener(k){delete this.listeners[k]} };
  events.subscribeJob(req,res,store);
  job.streamDelta={content:'A',reasoning:''}; events.notifyJob(job);
  job.streamDelta={content:'B',reasoning:''}; events.notifyJob(job);
  res.blocked=false; res.listeners.drain?.();
  await new Promise(resolve=>setImmediate(resolve));
  assert.strictEqual(res.chunks.join('').includes('B'), true, 'legacy deltas produced while blocked must not be overwritten');
}

module.exports = [
  testLegacyCompactDeltasSurviveABlockedWriter,
  testBackpressureWaitsForDrainAndMergesDirtyNotifications,
  testSseWriterSerializesUtf8ChunksAndDoesNotRewriteFalseChunk,
  testDrainTimeoutDestroysOnlyTheBlockedSubscriberAndCleansState,
  testKeepaliveIsFifteenSecondsAndResponseCloseCleansIt,
  testSseWriterClosesOnceAndCleansDrainTimeoutAndKeepalive,
];
