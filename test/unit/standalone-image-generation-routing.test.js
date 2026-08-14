'use strict';

const assert = require('assert');
const routeService = require('../../client/services/route-service');

function intent({ operation, relation = 'followup', resourceRefs = [] } = {}) {
  return JSON.stringify({
    operation,
    relation,
    goal: `处理当前 ${operation} 请求`,
    task_shape: 'single',
    resource_refs: resourceRefs,
  });
}

function historicalImageContext() {
  return {
    recent_messages: [
      { index: 1, role: 'user', content: '画一只猫。' },
      { index: 2, role: 'assistant', content: '[图片生成完成] 一只猫。' },
      { index: 3, role: 'user', content: '画一条金鱼。' },
      { index: 4, role: 'assistant', content: '[图片生成完成] 一条金鱼。' },
    ],
    image_candidates: [
      { index: 1, source_index: 1, source: 'history', image_id: 'cat-1', reference_id: 'cat-ref-1', target: 'previous', description: '一只猫' },
      { index: 2, source_index: 2, source: 'history', image_id: 'fish-1', reference_id: 'fish-ref-1', target: 'previous', description: '一条金鱼' },
    ],
    file_candidates: [],
    previous_execution: {
      family: 'generate', operation: 'text_to_image', input: '画一条金鱼。', result_reference_id: 'fish-ref-1',
    },
  };
}

function testModelEditProposalIsNotOverriddenByLocalRegenerationRules() {
  const input = '再画一只猫，换个品种。';
  const inspected = routeService.inspectModelRouteResult(intent({
    operation: 'edit_image',
    resourceRefs: [{ candidate_key: 'i1', role: 'target' }],
  }), {
    input,
    attachments: [],
    context: historicalImageContext(),
  });

  assert.ok(inspected.route, inspected.reason);
  assert.strictEqual(inspected.route.operationType, 'edit_image');
  assert.strictEqual(inspected.route.api, 'image_edit');
  assert.strictEqual(inspected.route.relation, 'followup');
  assert.deepStrictEqual(inspected.route.dispatchContract.bindings.map(binding => [binding.role, binding.resource_id]), [
    ['target', 'res:image:cat-1'],
  ]);
  assert.deepStrictEqual(inspected.route.executionResources.targets.map(resource => resource.id), ['cat-1']);
  assert.strictEqual(routeService.isRouteDispatchable(inspected.route), true);
}

function testModelGenerationProposalIsNotOverriddenByPromptAuthoringRules() {
  const input = '换一个场景 帮我生成提示词';
  const inspected = routeService.inspectModelRouteResult(intent({
    operation: 'text_to_image',
    resourceRefs: [{ candidate_key: 'i2', role: 'reference' }],
  }), {
    input,
    attachments: [],
    context: historicalImageContext(),
  });

  assert.ok(inspected.route, inspected.reason);
  assert.strictEqual(inspected.route.operationType, 'text_to_image');
  assert.strictEqual(inspected.route.api, 'image_generation');
  assert.strictEqual(inspected.route.relation, 'followup');
  assert.deepStrictEqual(inspected.route.dispatchContract.bindings, [],
    'the invalid image ref is rejected structurally without changing the model operation');
  assert.deepStrictEqual(inspected.route.executionResources.images, []);
  assert.strictEqual(routeService.isRouteDispatchable(inspected.route), true);
}

function testActualImageGenerationFromAnExistingPromptStillUsesTheImageService() {
  const input = '基于这个提示词帮我生成图片';
  const inspected = routeService.inspectModelRouteResult(intent({ operation: 'text_to_image' }), {
    input,
    attachments: [],
    context: historicalImageContext(),
  });

  assert.ok(inspected.route, inspected.reason);
  assert.strictEqual(inspected.route.operationType, 'text_to_image');
  assert.strictEqual(inspected.route.api, 'image_generation');
  assert.strictEqual(routeService.isRouteDispatchable(inspected.route), true);
}

function testExplicitReferenceStillAuthorizesReferenceGeneration() {
  const input = '再画一只猫，参考这张图的水彩风格。';
  const inspected = routeService.inspectModelRouteResult(intent({
    operation: 'image_reference_gen',
    resourceRefs: [{ candidate_key: 'i1', role: 'style_reference' }],
  }), {
    input,
    attachments: [],
    context: historicalImageContext(),
  });

  assert.ok(inspected.route, inspected.reason);
  assert.strictEqual(inspected.route.operationType, 'image_reference_gen');
  assert.deepStrictEqual(inspected.route.dispatchContract.bindings.map(binding => ({
    type: binding.type, role: binding.role, resource_id: binding.resource_id, source: binding.source,
  })), [{
    type: 'image', role: 'style_reference', resource_id: 'res:image:cat-1', source: 'history',
  }]);
}

function testQuotedTextPromptMisclassificationIsNotSemanticallyRewritten() {
  const input = '基于提示词 生成一只黑色的猫';
  const context = {
    quoted_message: {
      index: 1,
      id: 'quoted-cat-prompt',
      role: 'user',
      content: '生成一只黑色的猫，圆眼睛，暖白色室内背景。',
    },
    recent_messages: [{
      index: 1,
      id: 'quoted-cat-prompt',
      role: 'user',
      content: '生成一只黑色的猫，圆眼睛，暖白色室内背景。',
    }],
  };
  const inspected = routeService.inspectModelRouteResult(JSON.stringify({
    operation: 'image_reference_gen',
    relation: 'new',
    goal: '生成一只黑色的猫，圆眼睛，暖白色室内背景。',
    task_shape: 'single',
    resource_refs: [{ candidate_key: 'm1', role: 'reference' }],
  }), {
    input,
    attachments: [],
    context,
  });

  assert.ok(inspected.route, inspected.reason);
  assert.strictEqual(inspected.route.operationType, 'image_reference_gen');
  assert.strictEqual(inspected.route.readiness, 'needs_clarification');
  assert.strictEqual(inspected.route.dispatchContract, null);
  assert.strictEqual(inspected.route.normalizedFrom, null);
  assert.strictEqual(inspected.route.normalizationReason, '');
}

function testStaleTextReferenceCannotAuthorizeAReferenceGenerationRewrite() {
  const inspected = routeService.inspectModelRouteResult(JSON.stringify({
    operation: 'image_reference_gen',
    relation: 'new',
    goal: '生成一只幼年银灰白虎斑短毛猫，暖白色室内背景。',
    task_shape: 'single',
    resource_refs: [{ candidate_key: 'm1', role: 'reference' }],
  }), {
    input: '直接生成',
    attachments: [],
    context: {},
  });

  assert.ok(inspected.route, inspected.reason);
  assert.strictEqual(inspected.route.operationType, 'image_reference_gen');
  assert.strictEqual(inspected.route.readiness, 'needs_clarification');
  assert.strictEqual(inspected.route.dispatchAuthorized, false);
  assert.strictEqual(inspected.route.dispatchContract, null);
  assert.strictEqual(inspected.route.normalizedFrom, null);
}

module.exports = [
  testModelEditProposalIsNotOverriddenByLocalRegenerationRules,
  testModelGenerationProposalIsNotOverriddenByPromptAuthoringRules,
  testActualImageGenerationFromAnExistingPromptStillUsesTheImageService,
  testExplicitReferenceStillAuthorizesReferenceGeneration,
  testQuotedTextPromptMisclassificationIsNotSemanticallyRewritten,
  testStaleTextReferenceCannotAuthorizeAReferenceGenerationRewrite,
];
