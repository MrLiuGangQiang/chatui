'use strict';

const assert = require('assert');
const routeService = require('../../client/services/route-service');

const DEFAULT_ALL_IMAGE_ANALYSIS = /分析所有已上传图片/;

function currentImages(count = 4) {
  return Array.from({ length: count }, (_, index) => ({
    id: `upload-${index + 1}`,
    imageId: `upload-${index + 1}`,
    type: 'image/png',
    name: `image-${index + 1}.png`,
    dataUrl: `data:image/png;base64,IMAGE${index + 1}`,
  }));
}

function intent(overrides = {}) {
  return {
    operation: 'image_qa',
    relation: 'new',
    goal: '分析第一张图片。',
    task_shape: 'single',
    resource_refs: [{ candidate_key: 'i1', role: 'source' }],
    ...overrides,
  };
}

function testEmptyMultiImageTurnAnalyzesEveryCurrentImage() {
  const result = routeService.inspectModelRouteResult(JSON.stringify(intent()), {
    input: '',
    attachments: currentImages(4),
    context: {},
  });

  assert.ok(result.route, result.error || result.reason);
  assert.strictEqual(result.route.operationType, 'image_qa');
  assert.strictEqual(result.route.needClarification, false);
  assert.deepStrictEqual(
    result.route.resources.map(resource => [resource.id, resource.source, resource.role]),
    [1, 2, 3, 4].map(index => [`upload-${index}`, 'current', 'source']),
    'an empty image-only turn must not silently analyze a model-selected subset',
  );
  assert.strictEqual(result.route.executionResources.chatImages.length, 4);
  assert.strictEqual(result.route.dispatchContract.bindings.length, 4);
  assert.match(result.route.dispatchContract.arguments.prompt, DEFAULT_ALL_IMAGE_ANALYSIS);
  assert.strictEqual(routeService.isRouteDispatchable(result.route), true);
}

function testExplicitImageSubsetStillUsesOnlyTheRequestedImages() {
  const goal = '只分析第一张图片。';
  const result = routeService.inspectModelRouteResult(JSON.stringify(intent({ goal })), {
    input: goal,
    attachments: currentImages(4),
    context: {},
  });

  assert.ok(result.route, result.error || result.reason);
  assert.deepStrictEqual(result.route.resources.map(resource => resource.id), ['upload-1']);
  assert.strictEqual(result.route.dispatchContract.arguments.prompt, goal);
}

function testRoutePromptDeclaresTheEmptyMultiImageDefault() {
  assert.match(
    routeService.ROUTE_SYSTEM_PROMPT,
    /仅多张current图→image_qa且source全绑/,
    'the model prompt and deterministic compiler must agree on the empty multi-image default',
  );
}

module.exports = [
  testEmptyMultiImageTurnAnalyzesEveryCurrentImage,
  testExplicitImageSubsetStillUsesOnlyTheRequestedImages,
  testRoutePromptDeclaresTheEmptyMultiImageDefault,
];
