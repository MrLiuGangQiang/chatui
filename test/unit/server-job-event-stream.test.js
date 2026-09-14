'use strict';

const assert = require('assert');
const { createJobEvents, closeJobSubscribers } = require('../../server/jobs/events');
const { bindJobOwner } = require('../../server/security/job-ownership');
const { createRequestPrincipalService } = require('../../server/security/request-principal');

function createSseResponse() {
  return {
    status: 0,
    headers: {},
    chunks: [],
    ended: false,
    endCalls: 0,
    writeHead(status, headers = {}) { this.status = status; this.headers = headers; },
    write(chunk) { this.chunks.push(String(chunk || '')); return true; },
    flushHeaders() {},
    end(chunk = '') {
      if (chunk) this.chunks.push(String(chunk));
      this.ended = true;
      this.endCalls += 1;
    },
  };
}

function parseJobEvents(body) {
  return String(body || '').split('\n\n').filter(Boolean).map(block => {
    const event = block.split('\n').find(line => line.startsWith('event: '))?.slice(7) || '';
    const data = block.split('\n').find(line => line.startsWith('data: '))?.slice(6) || '{}';
    return { event, data: JSON.parse(data) };
  });
}

function makeOwnedJob(principal, id, status, content, reasoning = '') {
  const job = {
    id,
    status,
    createdAt: 1,
    updatedAt: 2,
    compactStream: true,
    data: { choices: [{ message: { content, reasoning_content: reasoning } }] },
    error: '',
  };
  bindJobOwner(job, principal);
  return job;
}

function makeRequest(url, principal, onClose = () => {}) {
  return {
    url,
    authPrincipal: principal,
    on(type, handler) { if (type === 'close') onClose(handler); },
  };
}

function jobEventsUrl(jobId, contentLength = 0, reasoningLength = 0) {
  return '/api/chat-jobs/' + encodeURIComponent(jobId) + '/events?contentLength=' + contentLength + '&reasoningLength=' + reasoningLength;
}

async function testChatJobStreamUsesMinimalDefaultMessageFrames() {
  const principal = createRequestPrincipalService({ secret: 's'.repeat(32) }).resolveRequest({ headers: {} }).principal;
  const job = makeOwnedJob(principal, 'chatjob-minimal', 'running', 'a');
  const store = new Map([[job.id, job]]);
  const jobSubscribers = new Map();
  const { notifyJob, subscribeJob } = createJobEvents({ jobSubscribers });
  const res = createSseResponse();
  subscribeJob(makeRequest(jobEventsUrl(job.id), principal), res, store);

  const initial = parseJobEvents(res.chunks.join(''));
  assert.strictEqual(initial.length, 1);
  assert.strictEqual(initial[0].event, '', 'compact chat frames must use the default SSE message event');
  assert.deepStrictEqual(initial[0].data, { d: 'a' }, 'the initial frame must contain content only');

  job.data.choices[0].message.content = 'ab';
  job.streamDelta = { content: 'b', reasoning: '' };
  notifyJob(job);
  await new Promise(resolve => setTimeout(resolve, 35));
  assert.deepStrictEqual(parseJobEvents(res.chunks.at(-1))[0].data, { d: 'b' });

  job.status = 'done';
  job.durationMs = 12;
  notifyJob(job);
  const terminal = parseJobEvents(res.chunks.at(-1))[0].data;
  assert.deepStrictEqual(terminal, { done: 1, rt: 12 });
  assert.strictEqual(res.ended, true);
  assert.strictEqual(jobSubscribers.has(job.id), false);
}

async function testCompactTerminalReplayUsesUtf16OffsetsAndDeliversSuffixBeforeDone() {
  const principal = createRequestPrincipalService({ secret: 's'.repeat(32) }).resolveRequest({ headers: {} }).principal;
  const content = '😀a'.repeat(4500);
  const job = makeOwnedJob(principal, 'chatjob-utf16-replay', 'done', content, '思考');
  const response = createSseResponse();
  const { subscribeJob } = createJobEvents({ jobSubscribers: new Map() });
  subscribeJob(makeRequest(jobEventsUrl(job.id, 1, 1), principal), response, new Map([[job.id, job]]));
  const events = parseJobEvents(response.chunks.join(''));
  assert.strictEqual(events.map(item => item.data.d || '').join(''), content.slice(1));
  assert.strictEqual(events.at(-1).data.done, 1);
  assert.strictEqual(events.slice(0, -1).every(item => item.data.z === undefined), true);
  assert.strictEqual(events.reduce((sum, item) => sum + String(item.data.d || '').length + String(item.data.r || '').length, 0) > 8192, true);
  assert.strictEqual(response.ended, true);
}

function testOffsetPastAggregateLengthUsesCompactResetSnapshot() {
  const principal = createRequestPrincipalService({ secret: 's'.repeat(32) }).resolveRequest({ headers: {} }).principal;
  const job = makeOwnedJob(principal, 'chatjob-overrun-offset', 'done', 'complete', '思考');
  const response = createSseResponse();
  const { subscribeJob } = createJobEvents({ jobSubscribers: new Map() });
  subscribeJob(makeRequest(jobEventsUrl(job.id, 99, 0), principal), response, new Map([[job.id, job]]));
  const frames = parseJobEvents(response.chunks.join(''));
  assert.deepStrictEqual(frames[0].data, { z: 1, d: 'complete', r: '思考', done: 1 });
  assert.strictEqual(frames.length, 1, 'a complete terminal snapshot needs one frame');
}

function testStaleObjectNotificationCannotTouchReplacementBinding() {
  const principal = createRequestPrincipalService({ secret: 's'.repeat(32) }).resolveRequest({ headers: {} }).principal;
  const id = 'chatjob-reused-binding';
  const oldJob = makeOwnedJob(principal, id, 'running', 'old');
  const replacement = makeOwnedJob(principal, id, 'running', 'new');
  const subscribers = new Map();
  const { subscribeJob, notifyJob } = createJobEvents({ jobSubscribers: subscribers });
  const oldResponse = createSseResponse();
  let oldClose = null;
  subscribeJob(makeRequest(jobEventsUrl(id), principal, handler => { oldClose = handler; }), oldResponse, new Map([[id, oldJob]]));
  oldClose();
  const replacementResponse = createSseResponse();
  subscribeJob(makeRequest(jobEventsUrl(id), principal), replacementResponse, new Map([[id, replacement]]));
  const before = replacementResponse.chunks.join('');
  oldJob.status = 'error';
  oldJob.error = 'old object error';
  notifyJob(oldJob);
  assert.strictEqual(replacementResponse.chunks.join(''), before);
  assert.strictEqual(replacementResponse.ended, false);
}

function testShutdownClosesSingleJobSubscriberOnce() {
  const principal = createRequestPrincipalService({ secret: 's'.repeat(32) }).resolveRequest({ headers: {} }).principal;
  const job = makeOwnedJob(principal, 'chatjob-shutdown', 'running', 'answer');
  const subscribers = new Map();
  const { subscribeJob } = createJobEvents({ jobSubscribers: subscribers });
  const response = createSseResponse();
  subscribeJob(makeRequest(jobEventsUrl(job.id), principal), response, new Map([[job.id, job]]));
  assert.strictEqual(closeJobSubscribers(subscribers), 1);
  assert.strictEqual(response.endCalls, 1);
  assert.strictEqual(subscribers.size, 0);
}

module.exports = [
  testChatJobStreamUsesMinimalDefaultMessageFrames,
  testCompactTerminalReplayUsesUtf16OffsetsAndDeliversSuffixBeforeDone,
  testOffsetPastAggregateLengthUsesCompactResetSnapshot,
  testStaleObjectNotificationCannotTouchReplacementBinding,
  testShutdownClosesSingleJobSubscriberOnce,
];
