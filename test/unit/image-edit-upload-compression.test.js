'use strict';

const assert = require('assert');
const imageService = require('../../client/services/image-service');

async function testImageEditUploadCompressesOversizedFile() {
  const original = { name: 'large.png', type: 'image/png', size: 30 * 1024 * 1024 };
  const compressed = { name: 'large.jpg', type: 'image/jpeg', size: 2 * 1024 * 1024 };
  let called = false;
  globalThis.compressImageIfNeeded = async file => {
    called = true;
    assert.strictEqual(file, original);
    return { file: compressed, changed: true };
  };

  const payload = await imageService.imageFileToJobPayload(
    { file: original, name: 'large.png', type: 'image/png' },
    async file => `data:${file.type || 'image/png'};base64,${Buffer.from('image-data').toString('base64')}`,
  );

  assert.strictEqual(called, true, 'oversized image must be compressed before upload');
  assert.strictEqual(payload.name, 'large.jpg');
  assert.strictEqual(payload.type, 'image/jpeg');
  assert.strictEqual(payload.data, Buffer.from('image-data').toString('base64'));

  delete globalThis.compressImageIfNeeded;
}

async function testImageEditUploadSkipsCompressionWhenUnavailable() {
  const payload = await imageService.imageFileToJobPayload(
    { file: { name: 'small.png', type: 'image/png' } },
    async file => `data:image/png;base64,${Buffer.from('small').toString('base64')}`,
  );
  assert.strictEqual(payload.name, 'small.png');
  assert.strictEqual(payload.data, Buffer.from('small').toString('base64'));
}

module.exports = [
  testImageEditUploadCompressesOversizedFile,
  testImageEditUploadSkipsCompressionWhenUnavailable,
];