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
    write(chunk) { this.chunks.push(String(chunk || '')); },
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

function makeOwnedStore(principal, entries) {
  const store = new Map();
  for (const [id, status, content] of entries) {
    const job = {
      id,
      status,
      createdAt: 1,
      updatedAt: 2,
      compactStream: true,
      data: { choices: [{ message: { content, reasoning_content: '' } }] },
      error: '',
    };
    bindJobOwner(job, principal);
    store.set(id, job);
  }
  return store;
}

function makeRequest(url, principal, onClose = () => {}) {
  return {
    url,
    authPrincipal: principal,
    on(type, handler) { if (type === 'close') onClose(handler); },
  };
}

async function testChatJobGroupUsesOneSseConnectionAndScopesEventsByJobId() {
  const service = createRequestPrincipalService({ secret: 's'.repeat(32) });
  const principal = service.resolveRequest({ headers: {} }).principal;
  const store = makeOwnedStore(principal, [
    ['chatjob-group-a', 'running', 'a'],
    ['chatjob-group-b', 'done', 'b'],
  ]);
  const jobSubscribers = new Map();
  const { notifyJob, subscribeJobGroup } = createJobEvents({ jobSubscribers });
  const res = createSseResponse();
  let closeHandler = null;
  const req = makeRequest(
    '/api/chat-jobs/events?ids=chatjob-group-a,chatjob-group-b&offset=chatjob-group-a%3A1%3A0&offset=chatjob-group-b%3A0%3A0',
    principal,
    handler => { closeHandler = handler; },
  );

  subscribeJobGroup(req, res, store);

  assert.strictEqual(res.status, 200);
  const initial = parseJobEvents(res.chunks.join(''));
  assert.deepStrictEqual(initial.map(item => item.event), ['job', 'job']);
  assert.deepStrictEqual(initial.map(item => item.data.id), ['chatjob-group-a', 'chatjob-group-b']);
  assert.strictEqual(initial[0].data.d, undefined, 'the running snapshot must not resend the cached prefix');
  assert.strictEqual(initial[1].data.d, 'b');
  assert.strictEqual(initial[1].data.done, 1);
  assert.strictEqual(jobSubscribers.get('chatjob-group-a')?.size, 1);
  assert.strictEqual(jobSubscribers.has('chatjob-group-b'), false, 'terminal jobs need no live subscriber');

  const running = store.get('chatjob-group-a');
  running.data.choices[0].message.content = 'ab';
  running.streamDelta = { content: 'b', reasoning: '' };
  running.updatedAt = 3;
  notifyJob(running);
  await new Promise(resolve => setTimeout(resolve, 35));
  const afterDelta = parseJobEvents(res.chunks.at(-1));
  assert.strictEqual(afterDelta[0].event, 'job');
  assert.strictEqual(afterDelta[0].data.id, 'chatjob-group-a');
  assert.strictEqual(afterDelta[0].data.d, 'b');

  running.status = 'done';
  running.done = undefined;
  notifyJob(running);
  assert.strictEqual(res.ended, true, 'the shared SSE response may close only after every subscribed job is terminal');
  assert.strictEqual(jobSubscribers.has('chatjob-group-a'), false);
  assert.strictEqual(typeof closeHandler, 'function');
}

async function testCompactTerminalReplayUsesUtf16OffsetsAndDeliversSuffixBeforeDone() {
  const principal = createRequestPrincipalService({ secret: 's'.repeat(32) }).resolveRequest({ headers: {} }).principal;
  const job = {
    id: 'chatjob-utf16-replay', status: 'done', createdAt: 1, updatedAt: 2, compactStream: true,
    data: { choices: [{ message: { content: '😀a'.repeat(4500), reasoning_content: '思考' } }] }, error: '',
  };
  bindJobOwner(job, principal);
  const store = new Map([[job.id, job]]);
  const response = createSseResponse();
  const subscribers = new Map();
  const { subscribeJobGroup } = createJobEvents({ jobSubscribers: subscribers });
  subscribeJobGroup(makeRequest('/api/chat-jobs/events?ids=' + job.id + '&offset=' + job.id + '%3A1%3A1', principal), response, store);
  const events = parseJobEvents(response.chunks.join(''));
  const content = events.map(item => item.data.d || '').join('');
  assert.strictEqual(content, job.data.choices[0].message.content.slice(1));
  assert.strictEqual(events.at(-1).data.done, 1);
  assert.strictEqual(events.slice(0, -1).every(item => item.data.status === 'running'), true);
  assert.strictEqual(events.reduce((sum, item) => sum + String(item.data.d || '').length + String(item.data.r || '').length, 0) > 8192, true);
  assert.strictEqual(response.ended, true);
}

function testOffsetPastAggregateLengthFallsBackToFullSnapshot() {
  const principal = createRequestPrincipalService({ secret: 's'.repeat(32) }).resolveRequest({ headers: {} }).principal;
  const job = {
    id: 'chatjob-overrun-offset', status: 'done', createdAt: 1, updatedAt: 2, compactStream: true,
    data: { choices: [{ message: { content: 'complete', reasoning_content: '思考' } }] }, error: '',
  };
  bindJobOwner(job, principal);
  const response = createSseResponse();
  const { subscribeJobGroup } = createJobEvents({ jobSubscribers: new Map() });
  subscribeJobGroup(makeRequest('/api/chat-jobs/events?ids=' + job.id + '&offset=' + job.id + '%3A99%3A0', principal), response, new Map([[job.id, job]]));
  const data = parseJobEvents(response.chunks.join(''))[0].data;
  assert.ok(data.data, 'an overrun offset must receive the complete DTO snapshot');
  assert.strictEqual(data.data.choices[0].message.content, 'complete');
  assert.strictEqual(data.status, 'done');
}

function testStaleObjectNotificationCannotTouchReplacementBinding() {
  const principal = createRequestPrincipalService({ secret: 's'.repeat(32) }).resolveRequest({ headers: {} }).principal;
  const id = 'chatjob-reused-binding';
  const oldJob = { id, status: 'running', createdAt: 1, updatedAt: 2, compactStream: true, data: { choices: [{ message: { content: 'old', reasoning_content: '' } }] } };
  const replacement = { id, status: 'running', createdAt: 3, updatedAt: 4, compactStream: true, data: { choices: [{ message: { content: 'new', reasoning_content: '' } }] } };
  bindJobOwner(oldJob, principal);
  bindJobOwner(replacement, principal);
  const subscribers = new Map();
  const { subscribeJobGroup, notifyJob } = createJobEvents({ jobSubscribers: subscribers });
  const oldResponse = createSseResponse();
  let oldClose = null;
  subscribeJobGroup(makeRequest('/api/chat-jobs/events?ids=' + id, principal, handler => { oldClose = handler; }), oldResponse, new Map([[id, oldJob]]));
  oldClose();
  const replacementResponse = createSseResponse();
  subscribeJobGroup(makeRequest('/api/chat-jobs/events?ids=' + id, principal), replacementResponse, new Map([[id, replacement]]));
  const before = replacementResponse.chunks.join('');
  oldJob.status = 'error';
  oldJob.error = 'old object error';
  notifyJob(oldJob);
  assert.strictEqual(replacementResponse.chunks.join(''), before);
  assert.strictEqual(replacementResponse.ended, false);
}

function testShutdownDeduplicatesOneSubscriberBoundToManyJobs() {
  const principal = createRequestPrincipalService({ secret: 's'.repeat(32) }).resolveRequest({ headers: {} }).principal;
  const jobs = ['chatjob-shutdown-a', 'chatjob-shutdown-b'].map(id => {
    const job = { id, status: 'running', createdAt: 1, updatedAt: 2, compactStream: true, data: { choices: [{ message: { content: id, reasoning_content: '' } }] } };
    bindJobOwner(job, principal);
    return job;
  });
  const subscribers = new Map();
  const { subscribeJobGroup } = createJobEvents({ jobSubscribers: subscribers });
  const response = createSseResponse();
  subscribeJobGroup(makeRequest('/api/chat-jobs/events?ids=' + jobs.map(job => job.id).join(','), principal), response, new Map(jobs.map(job => [job.id, job])));
  assert.strictEqual(closeJobSubscribers(subscribers), 1);
  assert.strictEqual(response.endCalls, 1);
  assert.strictEqual(subscribers.size, 0);
}

function testChatJobGroupRejectsDuplicateAndOverLimitIds() {
  const principal = createRequestPrincipalService({ secret: 's'.repeat(32) }).resolveRequest({ headers: {} }).principal;
  const { subscribeJobGroup } = createJobEvents({ jobSubscribers: new Map() });
  for (const ids of [
    ['chatjob-a,chatjob-a'],
    Array.from({ length: 65 }, (_, index) => `chatjob-${index + 1}`).join(','),
  ]) {
    const res = createSseResponse();
    subscribeJobGroup(makeRequest(`/api/chat-jobs/events?ids=${ids}`, principal), res, new Map());
    assert.strictEqual(res.status, 400);
    assert.strictEqual(res.ended, true);
    assert.match(res.chunks.join(''), /INVALID_JOB_GROUP/);
  }
}

function testChatJobGroupRejectsMalformedOffsetsWithoutTruncation() {
  const principal = createRequestPrincipalService({ secret: 's'.repeat(32) }).resolveRequest({ headers: {} }).principal;
  const { subscribeJobGroup } = createJobEvents({ jobSubscribers: new Map() });
  const invalidUrls = [
    '/api/chat-jobs/events?ids=chatjob-a&offset=chatjob-a%3A1',
    '/api/chat-jobs/events?ids=chatjob-a&offset=chatjob-other%3A1%3A0',
    '/api/chat-jobs/events?ids=chatjob-a&offset=chatjob-a%3A01%3A0',
    '/api/chat-jobs/events?ids=chatjob-a&offset=chatjob-a%3A1.5%3A0',
    '/api/chat-jobs/events?ids=chatjob-a&offset=chatjob-a%3A-1%3A0',
    '/api/chat-jobs/events?ids=chatjob-a&offset=chatjob-a%3A9007199254740992%3A0',
    '/api/chat-jobs/events?ids=chatjob-a&offset=chatjob-a%3A1%3A0&offset=chatjob-a%3A2%3A0',
  ];
  for (const url of invalidUrls) {
    const res = createSseResponse();
    subscribeJobGroup(makeRequest(url, principal), res, new Map());
    assert.strictEqual(res.status, 400, url);
    assert.strictEqual(res.ended, true, url);
  }
}

function testChatJobGroupRejectsLongUrlsAndRepeatedIdsParameter() {
  const principal = createRequestPrincipalService({ secret: 's'.repeat(32) }).resolveRequest({ headers: {} }).principal;
  const { subscribeJobGroup } = createJobEvents({ jobSubscribers: new Map() });
  const repeated = createSseResponse();
  subscribeJobGroup(makeRequest('/api/chat-jobs/events?ids=chatjob-a&ids=chatjob-b', principal), repeated, new Map());
  assert.strictEqual(repeated.status, 400);

  const longUrl = `/api/chat-jobs/events?ids=chatjob-a&note=${encodeURIComponent('x'.repeat(6200))}`;
  const long = createSseResponse();
  subscribeJobGroup(makeRequest(longUrl, principal), long, new Map());
  assert.strictEqual(long.status, 414);
  assert.strictEqual(long.ended, true);
}

module.exports = [
  testChatJobGroupUsesOneSseConnectionAndScopesEventsByJobId,
  testCompactTerminalReplayUsesUtf16OffsetsAndDeliversSuffixBeforeDone,
  testOffsetPastAggregateLengthFallsBackToFullSnapshot,
  testStaleObjectNotificationCannotTouchReplacementBinding,
  testShutdownDeduplicatesOneSubscriberBoundToManyJobs,
  testChatJobGroupRejectsDuplicateAndOverLimitIds,
  testChatJobGroupRejectsMalformedOffsetsWithoutTruncation,
  testChatJobGroupRejectsLongUrlsAndRepeatedIdsParameter,
];
