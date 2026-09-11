'use strict';

const assert = require('assert');

const imageJobs = require('../../server/jobs/image');

const editPayload = {
  model: 'gpt-image-2.5-sunburst',
  prompt: 'Remove the selected area and fill it naturally.',
  size: '1536x864',
  background: 'transparent',
  output_format: 'png',
};

function makeEditJob(overrides = {}) {
  return {
    mode: 'edit_image',
    transport: 'responses',
    payload: editPayload,
    files: [{ name: 'target.png', type: 'image/png', data: Buffer.from('TARGET').toString('base64') }],
    masks: [{ name: 'mask.png', type: 'image/png', data: Buffer.from('MASK').toString('base64'), routeRole: 'mask' }],
    ...overrides,
  };
}

function testImageEditTransportOnlyAppliesToEditImages() {
  assert.strictEqual(imageJobs.resolveImageJobTransport('edit_image', 'responses'), 'responses');
  assert.strictEqual(imageJobs.resolveImageJobTransport('edit_image', 'nonsense'), 'image_api');
  assert.strictEqual(imageJobs.resolveImageJobTransport('edit_image', ''), 'image_api',
    'without a configured transport the default stays on the Image API');
  assert.strictEqual(imageJobs.resolveImageJobTransport('text_to_image', 'responses'), 'image_api',
    'generation must never switch transport');
}

function testResponsesEditRequestCarriesToolMaskAndOptions() {
  const job = makeEditJob();
  const body = imageJobs.buildResponsesImageEditRequest(job, imageJobs.stripImageEditFileFields(job.payload));
  assert.strictEqual(body.tools.length, 1);
  const tool = body.tools[0];
  assert.strictEqual(tool.type, 'image_generation');
  assert.strictEqual(tool.action, 'edit');
  assert.strictEqual(tool.model, 'gpt-image-2.5-sunburst');
  assert.strictEqual(tool.size, '1536x864');
  assert.strictEqual(tool.background, 'transparent');
  assert.strictEqual(tool.output_format, 'png');
  assert.ok(String(tool.input_image_mask?.image_url || '').startsWith('data:image/png;base64,'),
    'the mask must travel as an input_image_mask data URL');
  const content = body.input[0].content;
  assert.strictEqual(content[0].type, 'input_text');
  assert.ok(content.some(part => part.type === 'input_image' && String(part.image_url).startsWith('data:image/png;base64,')),
    'the target image must travel as an input_image part');
  assert.strictEqual(body.previous_response_id, undefined, 'a first turn has no previous response id');
}

function testResponsesEditRequestForwardsPreviousResponseId() {
  const job = makeEditJob({ previousResponseId: 'resp_123', transportModel: 'gpt-6-astra' });
  const body = imageJobs.buildResponsesImageEditRequest(job, imageJobs.stripImageEditFileFields(job.payload));
  assert.strictEqual(body.previous_response_id, 'resp_123');
  assert.strictEqual(body.model, 'gpt-6-astra', 'the Responses model comes from the transport model');
}

function testResponsesResultNormalizesToImageApiShape() {
  const normalized = imageJobs.normalizeResponsesImageResult({
    id: 'resp_1',
    created_at: 123,
    output: [
      { type: 'message', content: [] },
      { type: 'image_generation_call', result: 'AAAA' },
    ],
  });
  assert.deepStrictEqual(normalized.data, [{ b64_json: 'AAAA' }]);
  assert.strictEqual(normalized.response_id, 'resp_1');
  assert.strictEqual(normalized.created, 123);
}

function testResponsesResultWithoutImageFailsClosed() {
  assert.throws(
    () => imageJobs.normalizeResponsesImageResult({ id: 'resp_2', output: [{ type: 'message' }] }),
    error => error?.code === 'IMAGE_RESPONSES_RESULT_MISSING',
  );
}

function testCreateImageJobTargetsTheResponsesEndpointWhenRequested() {
  const prepared = { mode: 'edit_image', payload: editPayload, files: [], masks: [] };
  const responsesJob = imageJobs.createImageJobFromRequestBody('job-1', { transport: 'responses' }, {
    baseUrl: 'https://upstream.test/v1',
    apiKey: 'test-key',
    prepared,
  });
  assert.strictEqual(responsesJob.transport, 'responses');
  assert.strictEqual(responsesJob.targetUrl, 'https://upstream.test/v1/responses');

  const defaultJob = imageJobs.createImageJobFromRequestBody('job-2', {}, {
    baseUrl: 'https://upstream.test/v1',
    apiKey: 'test-key',
    prepared,
  });
  assert.strictEqual(defaultJob.transport, 'image_api');
  assert.strictEqual(defaultJob.targetUrl, 'https://upstream.test/v1/images/edits');
}

module.exports = [
  testImageEditTransportOnlyAppliesToEditImages,
  testResponsesEditRequestCarriesToolMaskAndOptions,
  testResponsesEditRequestForwardsPreviousResponseId,
  testResponsesResultNormalizesToImageApiShape,
  testResponsesResultWithoutImageFailsClosed,
  testCreateImageJobTargetsTheResponsesEndpointWhenRequested,
];
