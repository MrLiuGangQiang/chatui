#!/usr/bin/env node
const assert = require('assert');
const { makeJobId, publicJob } = require('../../server/jobs/common');
const { createChatJobHandlers } = require('../../server/jobs/chat');
const { makeChatJob } = createChatJobHandlers({ chatJobs: new Map(), notifyJob: () => {}, upstreamTimeoutMs: 30000 });
const { buildImageEditMultipartBody, extractImageEditFiles, stripImageEditFileFields } = require('../../server/jobs/image');
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

const multipart = buildImageEditMultipartBody(
  { model: 'gpt-image-1', prompt: '改图', size: '1024x1024' },
  [{ name: 'a.png', type: 'image/png', data: Buffer.from('png-data').toString('base64') }]
);
const multipartText = multipart.body.toString('utf8');
assert.match(multipart.headers['Content-Type'], /^multipart\/form-data; boundary=----chatui-image-edit-/);
assert.strictEqual(Number(multipart.headers['Content-Length']), multipart.body.length);
assert.match(multipartText, /Content-Disposition: form-data; name="model"\r\n\r\ngpt-image-1/);
assert.match(multipartText, /Content-Disposition: form-data; name="prompt"\r\n\r\n改图/);
assert.match(multipartText, /Content-Disposition: form-data; name="image\[\]"; filename="a\.png"\r\nContent-Type: image\/png\r\n\r\npng-data/);
assert.doesNotMatch(multipartText, /Content-Disposition: form-data; name="image"; filename=/);
assert.ok(multipartText.endsWith('--\r\n'));

const multiImageMultipart = buildImageEditMultipartBody(
  { model: 'gpt-image-1', prompt: '合成两张图' },
  [
    { name: 'a.png', type: 'image/png', data: Buffer.from('first-image').toString('base64') },
    { name: 'b.png', type: 'image/png', data: Buffer.from('second-image').toString('base64') },
  ]
);
const multiImageText = multiImageMultipart.body.toString('utf8');
assert.strictEqual((multiImageText.match(/name="image\[\]"; filename=/g) || []).length, 2);
assert.match(multiImageText, /filename="a\.png"\r\nContent-Type: image\/png\r\n\r\nfirst-image/);
assert.match(multiImageText, /filename="b\.png"\r\nContent-Type: image\/png\r\n\r\nsecond-image/);
assert.doesNotMatch(multiImageText, /Content-Disposition: form-data; name="image"; filename=/);

const editBody = {
  payload: { model: 'gpt-image-1', prompt: '改图', files: [{ name: 'payload.png', data: 'bad' }] },
  files: [{ name: 'outer.png', type: 'image/png', data: Buffer.from('outer').toString('base64') }],
};
assert.deepStrictEqual(extractImageEditFiles(editBody).map(file => file.name), ['outer.png']);
assert.deepStrictEqual(stripImageEditFileFields(editBody.payload), { model: 'gpt-image-1', prompt: '改图' });

console.log('jobs ok');
