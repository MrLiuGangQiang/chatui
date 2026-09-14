'use strict';

const assert = require('assert');
const jobService = require('../../client/services/job-service');

async function testAbortManagedJobSendsKeepalivePostToExactChatJob() {
  const calls = [];
  const response = await jobService.abortManagedJob({
    kind: 'chat',
    jobId: 'chatjob-stop-exact',
    fetchImpl: async (url, options = {}) => {
      calls.push({ url, options });
      return { ok: true, status: 200 };
    },
  });

  assert.strictEqual(response.ok, true);
  assert.strictEqual(calls.length, 1);
  assert.strictEqual(calls[0].url, '/api/chat-jobs/chatjob-stop-exact/abort');
  assert.strictEqual(calls[0].options.method, 'POST');
  assert.strictEqual(calls[0].options.keepalive, true, 'stop must survive the local stream follower closing');
}

async function testAbortManagedJobRejectsWhenServerDoesNotAcceptStop() {
  await assert.rejects(
    jobService.abortManagedJob({
      kind: 'chat',
      jobId: 'chatjob-stop-rejected',
      fetchImpl: async () => ({
        ok: false,
        status: 409,
        json: async () => ({ error: { code: 'JOB_OWNER_IMMUTABLE', message: '任务标识不可用' } }),
      }),
    }),
    error => error.statusCode === 409 && error.code === 'JOB_OWNER_IMMUTABLE' && /任务标识不可用/.test(error.message),
  );
}

module.exports = [
  testAbortManagedJobSendsKeepalivePostToExactChatJob,
  testAbortManagedJobRejectsWhenServerDoesNotAcceptStop,
];
