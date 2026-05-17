#!/usr/bin/env node
const assert = require('assert');
const { extractImageResult, buildImageCompletionMessage, imageFileToJobPayload, imageFilesToJobPayload } = require('../../client/services/image-service');

(async () => {
  assert.deepStrictEqual(extractImageResult({ data: [{ url: 'https://x/img.png' }] }), { kind: 'image', src: 'https://x/img.png', url: 'https://x/img.png', b64: '', raw: 'https://x/img.png' });
  assert.deepStrictEqual(extractImageResult({ data: [{ b64_json: 'abc' }] }), { kind: 'image', src: 'data:image/png;base64,abc', url: '', b64: 'abc', raw: '[base64 image]' });
  assert.strictEqual(extractImageResult({ data: [] }).kind, 'empty');
  assert.strictEqual(extractImageResult({ data: [{ revised_prompt: 'x' }] }).kind, 'raw');
  assert.strictEqual(buildImageCompletionMessage({ prompt: '猫', mode: 'image' }), '[图片生成完成] 猫');
  assert.strictEqual(buildImageCompletionMessage({ prompt: '猫', mode: 'edit_image' }), '[图片编辑完成] 猫');

  const file = { name: 'a.png', type: 'image/png' };
  const payload = await imageFileToJobPayload({ file, name: 'custom.png' }, async () => 'data:image/png;base64,xyz');
  assert.deepStrictEqual(payload, { name: 'custom.png', type: 'image/png', data: 'xyz' });
  assert.deepStrictEqual(await imageFilesToJobPayload([{ file }], async () => 'data:image/png;base64,abc'), [{ name: 'a.png', type: 'image/png', data: 'abc' }]);

  console.log('image service ok');
})().catch(err => {
  console.error(err);
  process.exit(1);
});
