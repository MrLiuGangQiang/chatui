'use strict';

const assert = require('assert');
const { publicJob } = require('../../server/jobs/events');

function compact(job) {
  return publicJob(job, { resumeUrl: '/api/chat-jobs/x/events' });
}

function testRunningJobCompactPayloadOmitsIdentityAndStatus() {
  const payload = publicJob({
    id: 'chatjob-secret-id', status: 'running',
    data: { choices: [{ message: { content: 'a', reasoning_content: '' } }] },
    createdAt: 1, updatedAt: 2, compactStream: true,
  }, { live: true });
  assert.deepStrictEqual(payload, { d: 'a' }, 'a live frame must contain only its content delta');
}

function testErrorJobCompactPayloadCarriesOnlyTerminalMessage() {
  const payload = compact({
    id: 'x', status: 'error', error: '上游 400: unknown variant `image_url`',
    createdAt: 1, updatedAt: 2, compactStream: true,
  });
  assert.deepStrictEqual(payload, { e: '上游 400: unknown variant `image_url`' });
}

function testDoneJobCompactPayloadOmitsStatusAndIdentity() {
  const payload = compact({
    id: 'x', status: 'done', data: { choices: [{ message: { content: 'ok' } }] },
    createdAt: 1, updatedAt: 2, compactStream: true,
  });
  assert.strictEqual(payload.status, undefined);
  assert.strictEqual(payload.id, undefined);
  assert.strictEqual(payload.d, 'ok');
  assert.strictEqual(payload.done, 1);
}

function testOffsetOverrunUsesResetMarkerOnce() {
  const payload = publicJob({
    id: 'x', status: 'running',
    data: { choices: [{ message: { content: 'canonical', reasoning_content: 'thought' } }] },
    createdAt: 1, updatedAt: 2, compactStream: true,
  }, { resumeUrl: '/api/chat-jobs/x/events?contentLength=999&reasoningLength=999' });
  assert.deepStrictEqual(payload, { z: 1, d: 'canonical', r: 'thought' });
}

module.exports = [
  testRunningJobCompactPayloadOmitsIdentityAndStatus,
  testErrorJobCompactPayloadCarriesOnlyTerminalMessage,
  testDoneJobCompactPayloadOmitsStatusAndIdentity,
  testOffsetOverrunUsesResetMarkerOnce,
];
