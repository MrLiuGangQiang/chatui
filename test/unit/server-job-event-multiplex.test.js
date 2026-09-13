'use strict';

const assert = require('assert');
const { createJobEvents } = require('../../server/jobs/events');
const { bindJobOwner } = require('../../server/security/job-ownership');
const { createRequestPrincipalService } = require('../../server/security/request-principal');

function createSseResponse() {
  return {
    status: 0,
    headers: {},
    chunks: [],
    ended: false,
    writeHead(status, headers = {}) { this.status = status; this.headers = headers; },
    write(chunk) { this.chunks.push(String(chunk || '')); },
    flushHeaders() {},
    end(chunk = '') {
      if (chunk) this.chunks.push(String(chunk));
      this.ended = true;
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

async function testChatJobGroupUsesOneSseConnectionAndScopesEventsByJobId() {
  const service = createRequestPrincipalService({ secret: 's'.repeat(32) });
  const principal = service.resolveRequest({ headers: {} }).principal;
  const store = new Map();
  for (const [id, status, content] of [
    ['chatjob-group-a', 'running', 'a'],
    ['chatjob-group-b', 'done', 'b'],
  ]) {
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
  const jobSubscribers = new Map();
  const { notifyJob, subscribeJobGroup } = createJobEvents({ jobSubscribers });
  const res = createSseResponse();
  let closeHandler = null;
  const req = {
    url: '/api/chat-jobs/events?ids=chatjob-group-a,chatjob-group-b&offset=chatjob-group-a%3A1%3A0&offset=chatjob-group-b%3A0%3A0',
    authPrincipal: principal,
    on(type, handler) { if (type === 'close') closeHandler = handler; },
  };

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

module.exports = [
  testChatJobGroupUsesOneSseConnectionAndScopesEventsByJobId,
];
