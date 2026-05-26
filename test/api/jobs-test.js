#!/usr/bin/env node
const assert = require('assert');
const { makeJobId, publicJob } = require('../../server/jobs/common');
const { makeChatJob } = require('../../server/jobs/chat');
const { normalizeContentText, normalizeReasoningText } = require('../../server/jobs/reasoning');

const supplied = 'chatjob-12345678';
assert.strictEqual(makeJobId(supplied), supplied);
assert.ok(makeJobId('').startsWith('imgjob-'));

const job = makeChatJob('chatjob-abcdefgh', 'http://127.0.0.1:1/v1', '', { model: 'x' }, { stream: true });
assert.strictEqual(job.payload.stream, true);
assert.deepStrictEqual(publicJob({ id: 'x', status: 'done', createdAt: 1, updatedAt: 2, data: { ok: true }, error: '' }), {
  id: 'x', status: 'done', createdAt: 1, updatedAt: 2, data: { ok: true }, metrics: { firstTokenMs: null, durationMs: null }, error: null,
});
assert.deepStrictEqual(publicJob({ id: 'x', status: 'running', createdAt: 1, updatedAt: 2, data: { ok: true }, firstTokenMs: 123, durationMs: 456, error: '' }).metrics, { firstTokenMs: 123, durationMs: 456 });
assert.strictEqual(normalizeReasoningText([{ summary: 'a' }, { text: 'b' }]), 'a\nb');
assert.strictEqual(normalizeContentText([{ text: 'a' }, { content: 'b' }]), 'ab');
assert.strictEqual(normalizeContentText({ output: [{ type: 'message', content: [{ text: 'c' }] }] }), 'c');
assert.strictEqual(normalizeContentText({ message: { content: [{ text: 'd' }] } }), 'd');
console.log('jobs ok');
