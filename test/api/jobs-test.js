#!/usr/bin/env node
const assert = require('assert');
const { makeJobId, publicJob } = require('../../server/jobs/common');
const { makeChatJob } = require('../../server/jobs/chat');
const { normalizeReasoningText } = require('../../server/jobs/reasoning');

const supplied = 'chatjob-12345678';
assert.strictEqual(makeJobId(supplied), supplied);
assert.ok(makeJobId('').startsWith('imgjob-'));

const job = makeChatJob('chatjob-abcdefgh', 'http://127.0.0.1:1/v1', '', { model: 'x' }, { stream: true });
assert.strictEqual(job.payload.stream, true);
assert.deepStrictEqual(publicJob({ id: 'x', status: 'done', createdAt: 1, updatedAt: 2, data: { ok: true }, error: '' }), {
  id: 'x', status: 'done', createdAt: 1, updatedAt: 2, data: { ok: true }, error: null,
});
assert.strictEqual(normalizeReasoningText([{ summary: 'a' }, { text: 'b' }]), 'a\nb');
console.log('jobs ok');
