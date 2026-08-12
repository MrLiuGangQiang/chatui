'use strict';

const assert = require('assert');
const routeService = require('../../client/services/route-service');

function intent(goal) {
  return {
    operation: 'image_reference_gen',
    relation: 'followup',
    goal,
    resource_refs: [{ candidate_key: 'i1', role: 'reference' }],
  };
}

function generatedImageContext() {
  return {
    recent_messages: [
      { index: 1, role: 'user', content: '一辆红色跑车停在未来城市街道上。' },
      { index: 2, role: 'assistant', content: '[图片生成完成] 一辆红色跑车停在未来城市街道上。' },
    ],
    image_candidates: [{
      index: 1,
      source_index: 1,
      source: 'history',
      target: 'previous',
      image_id: 'generated-image-1',
      reference_id: 'generated-image-ref-1',
      description: '上一张生成的图片',
      labels: ['generated'],
    }],
    file_candidates: [],
    previous_execution: {
      schema_version: 'execution_continuity.v1',
      operation: 'text_to_image',
      family: 'generate',
      result_kind: 'image',
      input: '一辆红色跑车停在未来城市街道上。',
      result_reference_id: 'generated-image-ref-1',
      source_message_index: 1,
    },
    last_generated_image: {
      image_id: 'generated-image-1',
      reference_id: 'generated-image-ref-1',
    },
  };
}

function testModelResolvedVagueImageContinuationDispatchesWithoutLocalSemanticGate() {
  const context = generatedImageContext();
  const vagueInputs = [
    '要复杂一点',
    '更丰富一些',
    '再精致一点',
    '高级一点',
    '更有层次',
    '细节多一点',
    '做得更丰富',
    '再加强一点',
    'make it more complex',
  ];

  for (const input of vagueInputs) {
    const goal = `基于所选图片执行以下修改：${input}`;
    const inspected = routeService.inspectModelRouteResult(JSON.stringify(intent(goal)), {
      input,
      attachments: [],
      context,
    });
    assert.ok(inspected.route, `${input}: ${inspected.reason}`);
    assert.strictEqual(inspected.route.operationType, 'image_reference_gen', input);
    assert.strictEqual(inspected.route.readiness, 'ready', input);
    assert.strictEqual(inspected.route.needClarification, false, input);
    assert.strictEqual(inspected.route.dispatchAuthorized, true, input);
    assert.strictEqual(routeService.isRouteDispatchable(inspected.route), true, input);
    assert.strictEqual(inspected.route.dispatchContract.arguments.prompt, goal, input);
    assert.deepStrictEqual(inspected.route.resources.map(resource => ({
      type: resource.type,
      role: resource.role,
      id: resource.id,
      reference_id: resource.reference_id,
    })), [{
      type: 'image',
      role: 'reference',
      id: 'generated-image-1',
      reference_id: 'generated-image-ref-1',
    }], `${input}: the model-selected image remains the only execution reference`);
    assert.deepStrictEqual(inspected.route.clarificationSlots, [], input);
  }
}

function testConcreteImageChangesRemainImmediatelyDispatchable() {
  const context = generatedImageContext();
  const scenarios = [
    '把背景改成雪山。',
    '增加主体上的机械细节。',
    '让背景更丰富，加入远处的建筑和雾气。',
    '把杯子改成带金色纹理的玻璃杯。',
    '参考上一张图，但把构图改成电影海报布局。',
    'make the background more complex',
  ];

  for (const input of scenarios) {
    const goal = `基于所选图片执行以下修改：${input}`;
    const inspected = routeService.inspectModelRouteResult(JSON.stringify(intent(goal)), {
      input,
      attachments: [],
      context,
    });

    assert.ok(inspected.route, `${input}: ${inspected.reason}`);
    assert.strictEqual(inspected.route.readiness, 'ready', input);
    assert.strictEqual(inspected.route.needClarification, false, input);
    assert.strictEqual(routeService.isRouteDispatchable(inspected.route), true, input);
    assert.strictEqual(inspected.route.dispatchContract.arguments.prompt, goal, input);
  }
}

function testVagueImageRuleKeepsSemanticsAtTheModelBoundary() {
  assert.match(routeService.ROUTE_SYSTEM_PROMPT, /多候选同等合理省略resource_refs/);
  assert.match(routeService.ROUTE_SYSTEM_PROMPT, /goal 是下游执行模型唯一指令/);
  assert.doesNotMatch(routeService.ROUTE_SYSTEM_PROMPT, /复杂一点|主体细节|背景和环境/,
    'scenario-specific clarification patches must stay out of the route prompt');
  assert.doesNotMatch(routeService.ROUTE_SYSTEM_PROMPT, /change_value missing/,
    'local clarification implementation details must not leak into the model contract');
}

module.exports = [
  testModelResolvedVagueImageContinuationDispatchesWithoutLocalSemanticGate,
  testConcreteImageChangesRemainImmediatelyDispatchable,
  testVagueImageRuleKeepsSemanticsAtTheModelBoundary,
];
