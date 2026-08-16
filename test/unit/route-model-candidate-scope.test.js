'use strict';

const assert = require('assert');
const routeService = require('../../client/services/route-service');

function boundedImageContext() {
  return {
    recent_messages: [{ index: 1, id: 'message-1', resource_id: 'res:message:message-1', role: 'assistant', content: '这是一条普通文字回答。' }],
    image_candidates: [{
      image_id: 'bounded-history-image',
      resource_id: 'res:image:bounded-history-image',
      reference_id: 'bounded-history-ref',
      source: 'history',
      index: 1,
      description: '有界路由上下文中的旧猫图片',
    }],
  };
}

function modelIntent(resourceRefs = []) {
  return JSON.stringify({
    operation: 'image_qa',
    relation: 'followup',
    goal: '说明所选旧图片是什么。',
    task_shape: 'single',
    resource_refs: resourceRefs,
  });
}

function testBoundedMediaCatalogCrossesTheModelBoundaryWithoutLocalSemanticFiltering() {
  const options = {
    input: '说明一下',
    attachments: [],
    context: boundedImageContext(),
  };
  const payload = JSON.parse(routeService.buildRoutePayload({ model: 'route-model', ...options }).input[1].content);
  assert.deepStrictEqual(payload.resource_candidates.map(candidate => [candidate.candidate_key, candidate.type]), [
    ['i1', 'image'],
    ['m1', 'message'],
  ]);

  const inspected = routeService.inspectModelRouteResult(modelIntent([
    { candidate_key: 'i1', role: 'source' },
  ]), options);
  assert.ok(inspected.route, inspected.error || inspected.reason);
  assert.strictEqual(inspected.route.readiness, 'ready');
  assert.strictEqual(inspected.route.dispatchAuthorized, true);
  assert.deepStrictEqual(inspected.route.resources.map(resource => resource.id), ['bounded-history-image']);
}

function testHallucinatedCandidateKeyCannotBindARealHistoryImage() {
  const options = {
    input: '说明一下',
    attachments: [],
    context: boundedImageContext(),
  };
  const inspected = routeService.inspectModelRouteResult(modelIntent([
    { candidate_key: 'i2', role: 'source' },
  ]), options);

  assert.ok(inspected.route, inspected.error || inspected.reason);
  assert.strictEqual(inspected.route.readiness, 'needs_clarification');
  assert.strictEqual(inspected.route.dispatchAuthorized, false);
  assert.deepStrictEqual(inspected.route.resources, []);
  assert.strictEqual(inspected.route.dispatchContract, null);
  assert.ok(!JSON.stringify(inspected.route.resources).includes('bounded-history-image'));
}

function testTrustedLocalPlanCanStillUseAnExplicitCanonicalHistoryBinding() {
  const route = routeService.compileLocalRoute({
    operation: 'image_qa',
    relation: 'followup',
    arguments: { prompt: '说明这张明确选中的旧图片' },
    bindings: [{
      key: 'r1',
      type: 'image',
      role: 'source',
      resource_id: 'res:image:bounded-history-image',
      source: 'history',
    }],
    constraints: [],
  }, {
    input: '说明这张明确选中的旧图片',
    attachments: [],
    context: boundedImageContext(),
  });

  assert.strictEqual(route.readiness, 'ready');
  assert.strictEqual(route.dispatchAuthorized, true);
  assert.deepStrictEqual(route.resources.map(resource => resource.id), ['bounded-history-image']);
}

module.exports = [
  testBoundedMediaCatalogCrossesTheModelBoundaryWithoutLocalSemanticFiltering,
  testHallucinatedCandidateKeyCannotBindARealHistoryImage,
  testTrustedLocalPlanCanStillUseAnExplicitCanonicalHistoryBinding,
];
