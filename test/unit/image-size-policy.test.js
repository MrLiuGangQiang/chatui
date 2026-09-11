'use strict';

const assert = require('assert');

const imageSizePolicy = require('../../shared/image-size-policy');

function testPresetSizesStayValid() {
  for (const size of ['auto', '1024x1024', '1536x1024', '1024x1536']) {
    const result = imageSizePolicy.validateImageSize(size);
    assert.strictEqual(result.valid, true, `${size} must stay a valid preset`);
    assert.strictEqual(result.size, size);
    assert.strictEqual(result.preset, true);
  }
}

function testCustomSizesFollowOpenAiBounds() {
  const valid = imageSizePolicy.validateImageSize('1536x864');
  assert.strictEqual(valid.valid, true);
  assert.strictEqual(valid.size, '1536x864');
  assert.strictEqual(valid.preset, false);
  assert.strictEqual(valid.width, 1536);
  assert.strictEqual(valid.height, 864);

  assert.strictEqual(imageSizePolicy.validateImageSize('3840x2160').valid, true);
  assert.strictEqual(imageSizePolicy.validateImageSize('1024x1024').valid, true);

  assert.strictEqual(imageSizePolicy.validateImageSize('1000x1000').code, 'multiple');
  assert.strictEqual(imageSizePolicy.validateImageSize('4096x2160').code, 'edge');
  assert.strictEqual(imageSizePolicy.validateImageSize('400x2000').code, 'aspect');
  assert.strictEqual(imageSizePolicy.validateImageSize('3840x3840').code, 'pixels');
  assert.strictEqual(imageSizePolicy.validateImageSize('16x16').code, 'pixels');
  assert.strictEqual(imageSizePolicy.validateImageSize('not-a-size').code, 'format');
  assert.strictEqual(imageSizePolicy.validateImageSize('').code, 'empty');
}

function testSizeValidationMessagesAreActionable() {
  const multiple = imageSizePolicy.validateImageSize('1000x1000');
  assert.ok(multiple.message.includes('16'));
  const edge = imageSizePolicy.validateImageSize('4096x2160');
  assert.ok(edge.message.includes('3840'));
  const pixels = imageSizePolicy.validateImageSize('16x16');
  assert.ok(/[\d,]{3,}/.test(pixels.message), 'pixel budget message must state the numeric bounds');
}

function testParsedSizeNormalizesSeparators() {
  const parsed = imageSizePolicy.parseImageSize(' 1536 × 864 ');
  assert.deepStrictEqual({ width: parsed.width, height: parsed.height }, { width: 1536, height: 864 });
  assert.strictEqual(imageSizePolicy.parseImageSize('1536x'), null);
}

module.exports = [
  testPresetSizesStayValid,
  testCustomSizesFollowOpenAiBounds,
  testSizeValidationMessagesAreActionable,
  testParsedSizeNormalizesSeparators,
];
