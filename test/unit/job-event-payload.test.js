'use strict';

const assert = require('assert');
const { publicJob } = require('../../server/jobs/events');

function compact(job) {
  return publicJob(job, { resumeUrl: '/api/chat-jobs/x/events' });
}

function testErrorJobCompactPayloadCarriesStatusAndMessage() {
  const payload = compact({
    id: 'x', status: 'error', error: '\u4e0a\u6e38 400: unknown variant `image_url`',
    createdAt: 1, updatedAt: 2, compactStream: true,
  });
  assert.strictEqual(payload.status, 'error', 'error events must carry a status any reader understands');
  assert.strictEqual(payload.e, '\u4e0a\u6e38 400: unknown variant `image_url`');
  assert.deepStrictEqual(payload.error, { message: '\u4e0a\u6e38 400: unknown variant `image_url`' });
}

function testDoneJobCompactPayloadCarriesStatus() {
  const payload = compact({
    id: 'x', status: 'done', data: { choices: [{ message: { content: 'ok' } }] },
    createdAt: 1, updatedAt: 2, compactStream: true,
  });
  assert.strictEqual(payload.status, 'done');
  assert.strictEqual(payload.done, 1);
}

function testRunningJobCompactPayloadCarriesStatusAndDeltas() {
  const payload = publicJob({
    id: 'x', status: 'running', streamDelta: { content: 'a' },
    createdAt: 1, updatedAt: 2, compactStream: true,
  }, { live: true });
  assert.strictEqual(payload.status, 'running');
  assert.strictEqual(payload.d, 'a');
}

module.exports = [
  testErrorJobCompactPayloadCarriesStatusAndMessage,
  testDoneJobCompactPayloadCarriesStatus,
  testRunningJobCompactPayloadCarriesStatusAndDeltas,
];
