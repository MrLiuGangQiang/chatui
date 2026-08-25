const assert = require('assert');

const imageService = require('../../client/services/image-service');
const dispatchContract = require('../../shared/dispatch-contract');

function assertImageSources(result, expectedSources) {
  const extracted = imageService.extractImageResult(result);
  assert.strictEqual(extracted.kind, 'image');
  assert.deepStrictEqual(extracted.images.map(item => item.src), expectedSources);
  assert.strictEqual(extracted.src, expectedSources[0]);
  return extracted;
}

function testImageResultParsesContainerArrays() {
  assertImageSources({ images: [{ src: 'https://img.example/images-src.png' }] }, ['https://img.example/images-src.png']);
  assertImageSources({ output: [{ image_url: 'https://img.example/output-url.png' }] }, ['https://img.example/output-url.png']);
  assertImageSources(['https://img.example/string-array.png'], ['https://img.example/string-array.png']);
}

function testImageResultParsesItemAliases() {
  const extracted = assertImageSources({
    data: [
      { src: 'https://img.example/src.png', revised_prompt: 'a semantic cat portrait' },
      { image_url: 'https://img.example/image-url.png' },
      { image_url: { url: 'https://img.example/nested-image-url.png' } },
      { image: { src: 'https://img.example/nested-image-src.png' } },
      { image: 'https://img.example/image.png' },
      { image_base64: 'BASE64A' },
      { base64: 'BASE64B' },
      { b64_json: 'BASE64C' },
      { b64_json: 'data:image/webp;base64,DATAURLB64' },
    ],
  }, [
    'https://img.example/src.png',
    'https://img.example/image-url.png',
    'https://img.example/nested-image-url.png',
    'https://img.example/nested-image-src.png',
    'https://img.example/image.png',
    'data:image/png;base64,BASE64A',
    'data:image/png;base64,BASE64B',
    'data:image/png;base64,BASE64C',
    'data:image/webp;base64,DATAURLB64',
  ]);

  assert.strictEqual(extracted.images[0].revisedPrompt, 'a semantic cat portrait');
  assert.strictEqual(extracted.images[5].raw, '[base64 image]');
  assert.ok(extracted.raw.includes('https://img.example/src.png'));
  assert.ok(extracted.raw.includes('[base64 image]'));
}

function testImageResultEmptyAndRawContracts() {
  assert.deepStrictEqual(imageService.extractImageResult({ data: [] }), { kind: 'empty', url: '', b64: '', raw: '{\n  "data": []\n}' });
  const raw = imageService.extractImageResult({ data: [{ revised_prompt: 'x' }] });
  assert.strictEqual(raw.kind, 'raw');
  assert.strictEqual(raw.url, '');
  assert.strictEqual(raw.b64, '');
  assert.ok(raw.raw.includes('revised_prompt'));
}

async function testImageFileToJobPayloadContracts() {
  const fromExistingDataUrl = await imageService.imageFileToJobPayload({
    name: '已有.png',
    type: 'image/png',
    dataUrl: 'data:image/png;base64,AAAA',
  }, async () => { throw new Error('readFileAsDataURL should not be called'); });
  assert.deepStrictEqual(fromExistingDataUrl, { name: '已有.png', type: 'image/png', data: 'AAAA' });

  const file = { name: 'from-file.webp', type: 'image/webp' };
  const fromFile = await imageService.imageFileToJobPayload({ file }, async passedFile => {
    assert.strictEqual(passedFile, file);
    return 'data:image/webp;base64,BBBB';
  });
  assert.deepStrictEqual(fromFile, { name: 'from-file.webp', type: 'image/webp', data: 'BBBB' });

  const boundAttachment = {
    name: 'reference.png', type: 'image/png', dataUrl: 'data:image/png;base64,CCCC',
    routeRole: 'style_reference', routeResourceKey: 'r2', routeResourceId: 'res:image:style-2',
    routeSource: 'history', routeId: 'style-2', routeReferenceId: 'ref-2',
  };
  const bound = await imageService.imageFileToJobPayload(boundAttachment, async () => '');
  assert.deepStrictEqual(bound, {
    name: 'reference.png', type: 'image/png', data: 'CCCC',
    routeResourceKey: 'r2', routeResourceType: 'image', routeRole: 'style_reference',
    routeResourceId: 'res:image:style-2', routeSource: 'history', routeId: 'style-2', routeReferenceId: 'ref-2',
  }, 'image upload serialization must retain the complete execution binding');

  const referencePlan = dispatchContract.compileDispatchContract({
    operation: 'image_reference_gen', relation: 'followup', input: '参考这张图生成新的深色版本',
    bindings: [{ key: 'r2', type: 'image', role: 'style_reference', resource_id: 'res:image:style-2', source: 'history' }],
  });
  assert.strictEqual(dispatchContract.assertPayloadMatchesDispatchContract(referencePlan, {
    payload: { prompt: referencePlan.arguments.prompt }, mode: 'edit_image', files: [bound], masks: [],
    bindingEvidence: dispatchContract.bindingEvidenceFromMedia({ images: [boundAttachment] }),
  }), true, 'the serialized file must remain valid against the exact execution plan');

  await assert.rejects(
    imageService.imageFileToJobPayload({
      name: 'partial.png', type: 'image/png', dataUrl: 'data:image/png;base64,DDDD',
      routeRole: 'reference', routeResourceKey: 'r3',
    }, async () => ''),
    error => error?.code === 'EXECUTION_RESOURCE_BINDING_INVALID',
    'partial route metadata must fail instead of crossing the execution boundary',
  );

  assert.strictEqual(await imageService.imageFileToJobPayload({ name: 'remote.png', src: 'https://img.example/remote.png' }, async () => ''), null);
  assert.strictEqual(await imageService.imageFileToJobPayload({ name: 'empty.png', dataUrl: 'data:image/png;base64,' }, async () => ''), null);
}

async function testImageFilesToJobPayloadContracts() {
  const result = await imageService.imageFilesToJobPayload([
    { name: 'a.png', type: 'image/png', dataUrl: 'data:image/png;base64,AAAA' },
    { name: 'remote.png', src: 'https://img.example/remote.png' },
    { name: 'b.jpg', type: 'image/jpeg', dataUrl: 'data:image/jpeg;base64,BBBB' },
  ], async () => '');

  assert.deepStrictEqual(result, [
    { name: 'a.png', type: 'image/png', data: 'AAAA' },
    { name: 'b.jpg', type: 'image/jpeg', data: 'BBBB' },
  ]);
}

module.exports = [
  testImageResultParsesContainerArrays,
  testImageResultParsesItemAliases,
  testImageResultEmptyAndRawContracts,
  testImageFileToJobPayloadContracts,
  testImageFilesToJobPayloadContracts,
];
