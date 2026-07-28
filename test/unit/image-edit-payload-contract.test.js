const assert = require('assert');

const imageEditPayload = require('../../server/services/image-edit-payload.service');

const PNG_1PX = 'iVBORw0KGgo=';

function imageFile(overrides = {}) {
  return { name: 'source.png', type: 'image/png', data: PNG_1PX, ...overrides };
}

function testImageEditTextEntriesContract() {
  const dataUrl = 'data:image/png;base64,' + PNG_1PX;
  const entries = imageEditPayload.imageEditTextEntries({
    model: 'gpt-image-1',
    prompt: `改一下 ${dataUrl}`,
    size: '1024x1024',
    n: 2,
    unknown: 'skip-me',
    image: imageFile(),
    files: [imageFile()],
    input_fidelity: 'high',
    output_format: 'png',
    output_compression: 90,
    stream: false,
    partial_images: 1,
  });

  assert.deepStrictEqual(Object.fromEntries(entries), {
    model: 'gpt-image-1',
    prompt: '改一下 [image-data-omitted]',
    size: '1024x1024',
    input_fidelity: 'high',
    output_format: 'png',
    output_compression: '90',
    stream: 'false',
    partial_images: '1',
  });
}

function testImageEditTextEntryHelperContract() {
  assert.deepStrictEqual(imageEditPayload.imageEditTextEntry({}, 'size', '1024x1024'), ['size', '1024x1024']);
  assert.strictEqual(imageEditPayload.imageEditTextEntry({}, 'unknown', 'skip-me'), null);
  assert.strictEqual(imageEditPayload.imageEditTextEntry({}, 'size', 'x'.repeat(imageEditPayload.multipartTextFieldLimit('size') + 1)), null);

  const promptEntry = imageEditPayload.imageEditTextEntry({}, 'prompt', `改图 data:image/png;base64,${PNG_1PX}`);
  assert.strictEqual(promptEntry[0], 'prompt');
  assert.strictEqual(promptEntry[1], '改图 [image-data-omitted]');

  const longPrompt = 'p'.repeat(imageEditPayload.multipartTextFieldLimit('prompt') + 8);
  assert.strictEqual(imageEditPayload.imageEditTextEntry({}, 'prompt', longPrompt), null);
}

function testImageEditForwardFieldBoundaryContract() {
  const dataUrl = 'data:image/png;base64,' + PNG_1PX;
  const largeImage = 'iVBOR' + 'A'.repeat(5000);

  assert.strictEqual(imageEditPayload.shouldSkipMultipartField('input_image', largeImage), true);
  assert.strictEqual(imageEditPayload.shouldSkipMultipartField('input_images', largeImage), true);
  assert.strictEqual(imageEditPayload.shouldSkipMultipartField('mask', largeImage), true);
  assert.strictEqual(imageEditPayload.shouldSkipMultipartField('images', [{ data: PNG_1PX }]), true);
  assert.strictEqual(imageEditPayload.shouldSkipMultipartField('prompt', `改图 ${dataUrl}`), false);
  assert.strictEqual(imageEditPayload.shouldSkipMultipartField('size', `x ${dataUrl}`), true);

  assert.strictEqual(imageEditPayload.shouldForwardImageEditField({}, 'prompt', `改图 ${dataUrl}`), true);
  assert.strictEqual(imageEditPayload.shouldForwardImageEditField({}, 'unknown', 'value'), false);
  assert.strictEqual(imageEditPayload.shouldForwardImageEditField({}, 'n', 2), false);
  assert.strictEqual(imageEditPayload.shouldForwardImageEditField({}, 'size', '1024x1024'), true);
}

function testOpenAiImageEditPayloadUsesSharedTextEntries() {
  const payload = imageEditPayload.buildOpenAiImageEditPayload({
    model: 'gpt-image-1',
    prompt: '改成黑白',
    size: '1024x1024',
    n: 2,
    unknown: 'skip-me',
    image: imageFile(),
  }, [imageFile({ name: 'one.png' }), imageFile({ name: 'two.png' })], { masks: [imageFile({ name: 'mask.png' })] });

  assert.deepStrictEqual(payload, {
    model: 'gpt-image-1',
    prompt: '改成黑白',
    size: '1024x1024',
    images: ['data:image/png;base64,' + PNG_1PX, 'data:image/png;base64,' + PNG_1PX],
    masks: ['data:image/png;base64,' + PNG_1PX],
  });
}

function testMultipartBodyUsesSharedTextEntries() {
  const multipart = imageEditPayload.buildImageEditMultipartBody({
    model: 'gpt-image-1',
    prompt: '改成黑白',
    n: 2,
    unknown: 'skip-me',
  }, [imageFile({ name: 'one.png' })]);

  assert.match(multipart.headers['Content-Type'], /^multipart\/form-data; boundary=chatui-/);
  const body = multipart.body.toString('latin1');
  assert.ok(body.includes('name="model"'));
  assert.ok(body.includes('name="prompt"'));
  assert.ok(body.includes('name="image"; filename="one.png"'));
  assert.ok(!body.includes('name="n"'));
  assert.ok(!body.includes('name="unknown"'));
  assert.ok(!body.includes('skip-me'));
}

function testMultipartBodyUsesArrayFieldForMultipleImages() {
  const multipart = imageEditPayload.buildImageEditMultipartBody({
    model: 'gpt-image-1',
    prompt: 'combine two images',
  }, [imageFile({ name: 'one.png' }), imageFile({ name: 'two.png' })]);

  const body = multipart.body.toString('latin1');
  assert.strictEqual((body.match(/name="image\[\]"/g) || []).length, 2);
  assert.ok(body.includes('name="image[]"; filename="one.png"'));
  assert.ok(body.includes('name="image[]"; filename="two.png"'));
  assert.ok(!body.includes('name="image"; filename='));
}

function testImageEditFileExtractionContract() {
  const imageA = imageFile({ name: 'a.png' });
  const imageB = imageFile({ name: 'b.png' });
  const mask = imageFile({ name: 'mask.png', field: 'mask' });

  assert.deepStrictEqual(imageEditPayload.extractImageEditFiles({ files: [imageA, mask] }), [imageA]);
  assert.deepStrictEqual(imageEditPayload.extractImageEditFiles({ payload: { images: [imageA, imageB] } }), [imageA, imageB]);
  assert.deepStrictEqual(imageEditPayload.extractImageEditFiles({ payload: { files: [mask] } }), []);
  assert.deepStrictEqual(imageEditPayload.extractImageEditFiles({ payload: { image_files: [imageA] } }), [imageA]);
}

function testImageEditFileFilterHelpersContract() {
  const imageA = imageFile({ name: 'a.png' });
  const imageB = imageFile({ name: 'b.png' });
  const maskA = imageFile({ name: 'mask-a.png', field: 'mask' });
  const empty = { name: 'empty.png' };

  assert.deepStrictEqual(imageEditPayload.dataFiles([imageA, empty, maskA]), [imageA, maskA]);
  assert.deepStrictEqual(imageEditPayload.imageFilesOnly([imageA, maskA, imageB, empty]), [imageA, imageB]);
  assert.deepStrictEqual(imageEditPayload.maskFilesOnly([imageA, maskA, imageB, empty]), [maskA]);
  assert.deepStrictEqual(imageEditPayload.dataFiles(imageA), [imageA]);
  assert.deepStrictEqual(imageEditPayload.imageFilesOnly(null), []);
}

function testImageEditCandidateHelpersContract() {
  const imageA = imageFile({ name: 'a.png' });
  const imageB = imageFile({ name: 'b.png' });
  const maskA = imageFile({ name: 'mask-a.png', field: 'mask' });

  const fileCandidates = imageEditPayload.imageEditFileCandidates({ files: [imageA], payload: { images: [imageB] } });
  assert.deepStrictEqual(fileCandidates[0], [imageA]);
  assert.deepStrictEqual(fileCandidates[6], [imageB]);

  const maskCandidates = imageEditPayload.imageEditMaskCandidates({ files: [imageA, maskA], payload: { files: [maskA] } });
  assert.deepStrictEqual(maskCandidates[4], [maskA]);
  assert.deepStrictEqual(maskCandidates[5], [maskA]);
}

function testImageEditCandidateExtractionBehaviorContract() {
  const bodyImage = imageFile({ name: 'body.png' });
  const payloadImage = imageFile({ name: 'payload.png' });
  const taggedMask = imageFile({ name: 'mask-tagged.png', fieldName: 'mask' });
  const payloadMask = imageFile({ name: 'payload-mask.png' });

  assert.deepStrictEqual(imageEditPayload.extractImageEditFiles({
    files: [bodyImage],
    payload: { images: [payloadImage] },
  }), [bodyImage]);

  assert.deepStrictEqual(imageEditPayload.extractImageEditFiles({
    files: [taggedMask],
    payload: { images: [payloadImage] },
  }), []);

  assert.deepStrictEqual(imageEditPayload.extractImageEditMasks({
    masks: [payloadMask],
    payload: { files: [taggedMask] },
  }), [payloadMask, taggedMask]);
}

function testImageEditMaskExtractionContract() {
  const imageA = imageFile({ name: 'a.png' });
  const maskA = imageFile({ name: 'mask-a.png', field: 'mask' });
  const maskB = imageFile({ name: 'mask-b.png' });
  const maskC = imageFile({ name: 'mask-c.png', multipartName: 'mask' });

  assert.deepStrictEqual(imageEditPayload.extractImageEditMasks({ mask: maskA }), [maskA]);
  assert.deepStrictEqual(imageEditPayload.extractImageEditMasks({ masks: [maskA, maskB] }), [maskA, maskB]);
  assert.deepStrictEqual(imageEditPayload.extractImageEditMasks({ files: [imageA, maskA] }), [maskA]);
  assert.deepStrictEqual(imageEditPayload.extractImageEditMasks({ payload: { files: [imageA, maskC], masks: [maskB] } }), [maskB, maskC]);
}

function testStripImageEditFileFieldsContract() {
  const stripped = imageEditPayload.stripImageEditFileFields({
    model: 'gpt-image-1',
    prompt: '改图',
    image: imageFile(),
    images: [imageFile()],
    mask: imageFile(),
    masks: [imageFile()],
    files: [imageFile()],
    imageFiles: [imageFile()],
    image_files: [imageFile()],
    keep: 'yes',
  });

  assert.deepStrictEqual(stripped, { model: 'gpt-image-1', prompt: '改图', keep: 'yes' });
}

function testImageEditPromptFallbackContract() {
  assert.deepStrictEqual(imageEditPayload.imageEditPromptCandidates({ prompt: 'p1' }, { prompt: 'body' }), ['p1', undefined, undefined, undefined, undefined, undefined, undefined, 'body', undefined, undefined, undefined, undefined, undefined, undefined]);
  assert.strictEqual(imageEditPayload.resolveImageEditPrompt({ prompt: '  p1  ', editInstruction: 'p2' }, { prompt: 'body' }), 'p1');
  assert.strictEqual(imageEditPayload.resolveImageEditPrompt({ prompt: '   ', editInstruction: ' fallback edit ' }, { prompt: 'body' }), 'fallback edit');
  assert.strictEqual(imageEditPayload.resolveImageEditPrompt({ edit_instruction: ' snake edit ' }, {}), 'snake edit');
  assert.strictEqual(imageEditPayload.resolveImageEditPrompt({ routePrompt: ' route camel ' }, {}), 'route camel');
  assert.strictEqual(imageEditPayload.resolveImageEditPrompt({ original_prompt: ' original snake ' }, {}), 'original snake');
  assert.strictEqual(imageEditPayload.resolveImageEditPrompt({}, { editInstruction: ' body edit ' }), 'body edit');
  assert.strictEqual(imageEditPayload.resolveImageEditPrompt({}, { route_prompt: ' body route ' }), 'body route');
  assert.strictEqual(imageEditPayload.resolveImageEditPrompt({}, { originalPrompt: ' body original ' }), 'body original');
  assert.strictEqual(imageEditPayload.resolveImageEditPrompt({}, {}), '');
}

function testEnsureImageEditPromptContract() {
  const source = { model: 'gpt-image-1', editInstruction: '改成蓝色' };
  const ensured = imageEditPayload.ensureImageEditPrompt(source, {});
  assert.deepStrictEqual(ensured, { model: 'gpt-image-1', editInstruction: '改成蓝色', prompt: '改成蓝色' });
  assert.notStrictEqual(ensured, source);
  assert.deepStrictEqual(imageEditPayload.ensureImageEditPrompt({ model: 'gpt-image-1' }, { prompt: 'body prompt' }), { model: 'gpt-image-1', prompt: 'body prompt' });
  assert.deepStrictEqual(imageEditPayload.ensureImageEditPrompt({ model: 'gpt-image-1' }, {}), { model: 'gpt-image-1' });
}

function testMultipartFileSafetyContracts() {
  assert.strictEqual(imageEditPayload.safeImageExtension('image/png', ''), 'png');
  assert.strictEqual(imageEditPayload.safeImageExtension('image/jpeg', ''), 'jpeg');
  assert.strictEqual(imageEditPayload.safeImageExtension('image/webp', ''), 'webp');
  assert.strictEqual(imageEditPayload.safeImageExtension('application/octet-stream', 'photo.jpg'), 'jpeg');
  assert.strictEqual(imageEditPayload.safeImageExtension('application/octet-stream', 'unknown.bmp'), 'png');

  assert.strictEqual(imageEditPayload.safeMultipartContentType('image/jpg'), 'image/jpeg');
  assert.strictEqual(imageEditPayload.safeMultipartContentType('image/png; charset=utf-8'), 'image/png');
  assert.strictEqual(imageEditPayload.safeMultipartContentType('text/html'), 'application/octet-stream');
  assert.strictEqual(imageEditPayload.safeMultipartContentType('image/svg+xml'), 'application/octet-stream');

  assert.strictEqual(imageEditPayload.safeMultipartFilename({ name: '../bad\r\nname.jpg', type: 'image/png' }, 0), 'bad_name.jpg');
  assert.strictEqual(imageEditPayload.safeMultipartFilename({ name: 'nested/path/中文 logo', type: 'image/webp' }, 1), '_ logo.webp');
  assert.strictEqual(imageEditPayload.safeMultipartFilename({ name: 'data:image/png;base64,AAAA', type: 'image/png' }, 2), 'image-3.png');
  assert.strictEqual(imageEditPayload.safeMultipartFilename({ name: 'no-extension', type: 'image/jpeg' }, 3), 'no-extension.jpeg');
  assert.strictEqual(imageEditPayload.safeMultipartFilename({ name: 'x'.repeat(181), type: 'image/gif' }, 4), 'image-5.gif');

  assert.deepStrictEqual(imageEditPayload.multipartFileMetadata({ name: '../bad\r\nname.jpg', type: 'image/jpg' }, 0), {
    filename: 'bad_name.jpg',
    contentType: 'image/jpeg',
  });
}

function testImageBase64ValidationContract() {
  assert.strictEqual(imageEditPayload.normalizeImageBase64Data({ data: ' QUJD\nRA== ' }), 'QUJDRA==');
  assert.strictEqual(imageEditPayload.imageFileToBuffer({ data: 'QUJDRA==' }).toString('utf8'), 'ABCD');
  assert.strictEqual(imageEditPayload.imageFileToDataUrl({ type: 'image/png', data: 'QUJDRA==' }), 'data:image/png;base64,QUJDRA==');
  assert.strictEqual(imageEditPayload.imageFileToDataUrl({ type: 'image/png', data: 'data:text/html;base64,QUJDRA==' }), 'data:text/html;base64,QUJDRA==');
  assert.throws(() => imageEditPayload.normalizeImageBase64Data({ data: 'QUJD====' }), /图片附件数据无效/);
  assert.throws(() => imageEditPayload.normalizeImageBase64Data({ data: 'QUJD-RA==' }), /图片附件数据无效/);
  assert.throws(() => imageEditPayload.normalizeImageBase64Data({ data: 'abcde' }), /图片附件数据无效/);
  assert.throws(() => imageEditPayload.imageFileToBuffer({ data: '' }), /图片附件数据无效/);
}

function testPromptImageDataSanitizationContract() {
  const dataUrl = 'data:image/png;base64,' + 'A'.repeat(128);
  assert.strictEqual(imageEditPayload.normalizeImageEditFieldValue('prompt', `改图 ${dataUrl}`), '改图 [image-data-omitted]');
  const bare = `prefix iVBOR${'A'.repeat(5000)} suffix`;
  const normalizedBare = imageEditPayload.normalizeImageEditFieldValue('prompt', bare);
  assert.ok(normalizedBare.includes('[image-data-omitted]'));
  assert.ok(!normalizedBare.includes('iVBORAAAA'));
  const longPrompt = 'x'.repeat(imageEditPayload.multipartTextFieldLimit('prompt') + 10);
  const truncated = imageEditPayload.normalizeImageEditFieldValue('prompt', longPrompt);
  assert.ok(truncated.endsWith('\n[prompt-truncated]'));
  assert.strictEqual(imageEditPayload.normalizeImageEditFieldValue('size', { width: 1 }), '{"width":1}');
}

module.exports = [
  testImageEditTextEntriesContract,
  testImageEditTextEntryHelperContract,
  testImageEditForwardFieldBoundaryContract,
  testOpenAiImageEditPayloadUsesSharedTextEntries,
  testMultipartBodyUsesSharedTextEntries,
  testMultipartBodyUsesArrayFieldForMultipleImages,
  testImageEditFileExtractionContract,
  testImageEditFileFilterHelpersContract,
  testImageEditCandidateHelpersContract,
  testImageEditCandidateExtractionBehaviorContract,
  testImageEditMaskExtractionContract,
  testStripImageEditFileFieldsContract,
  testImageEditPromptFallbackContract,
  testEnsureImageEditPromptContract,
  testMultipartFileSafetyContracts,
  testImageBase64ValidationContract,
  testPromptImageDataSanitizationContract,
];
