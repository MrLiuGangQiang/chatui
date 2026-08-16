'use strict';

const assert = require('assert');
const imageRouteContext = require('../../client/core/image-route-context');
const routeIntent = require('../../shared/route-intent');
const routeService = require('../../client/services/route-service');

const BASE = '住宅户型总长18米、总宽8米，左右严格镜像对称，中央堂屋，两侧各有完整居住单元。';
const COMPLETE_REDESIGN = '重新设计住宅户型平面图：总长18米、总宽8米，左右严格镜像对称；中央堂屋主入口保持无遮挡，卧室1入口不被家具阻挡；卫生间与餐厅明确分隔且不得相邻；不使用旧图。';

function contextWithPreviousTask() {
  return imageRouteContext.buildRouteContext({
    messages: [
      { role: 'user', content: BASE },
      {
        role: 'assistant',
        content: '[图片生成完成] 旧布局',
        imageContext: JSON.stringify({
          schema_version: 'image_result.v1',
          operation: 'text_to_image',
          prompt: BASE,
          routePrompt: BASE,
          resolvedGoal: BASE,
          taskState: {
            schema_version: 'task_continuity.v1',
            goal_mode: 'replace',
            segments: [{ kind: 'base', text: BASE }],
          },
          referenceId: 'old-layout',
          attachments: [{ src: 'indexeddb://old-layout.png', name: 'old-layout.png' }],
        }),
      },
    ],
  });
}

function inspect(intent, input, context) {
  const result = routeService.inspectModelRouteResult(JSON.stringify(intent), {
    input,
    attachments: [],
    context,
  });
  assert.ok(result.route, result.error || result.reason);
  return result.route;
}

function testRouteIntentV3CarriesExplicitGoalMode() {
  const value = {
    operation: 'text_to_image',
    relation: 'followup',
    goal: COMPLETE_REDESIGN,
    goal_mode: 'replace',
    task_shape: 'single',
    resource_refs: [],
  };
  assert.strictEqual(routeIntent.ROUTE_INTENT_VERSION, 'route_intent.v3');
  assert.strictEqual(routeIntent.hasExactRouteIntent(value), true);
  assert.deepStrictEqual(Object.keys(value), [
    'operation', 'relation', 'goal', 'goal_mode', 'task_shape', 'resource_refs',
  ]);
}

function testCompleteRedesignReplacesTextStateWithoutBindingTheOldImage() {
  const context = contextWithPreviousTask();
  const route = inspect({
    operation: 'text_to_image',
    relation: 'followup',
    goal: COMPLETE_REDESIGN,
    goal_mode: 'replace',
    task_shape: 'single',
    resource_refs: [],
  }, COMPLETE_REDESIGN, context);
  assert.deepStrictEqual(route.resources, []);
  assert.strictEqual(route.goalMode, 'replace');
  assert.strictEqual(route.executionPrompt, COMPLETE_REDESIGN);
  assert.strictEqual(route.dispatchContract.arguments.prompt, COMPLETE_REDESIGN);
  assert.deepStrictEqual(route.imageTaskState.segments, [{ kind: 'base', text: COMPLETE_REDESIGN }]);
}

function testImageRevisionAmendsStructuredTaskStateWithoutChangingEditInstruction() {
  const context = contextWithPreviousTask();
  const delta = '把堂屋主入口前的家具全部移开，确保从门到堂屋内部形成连续直线通道。';
  const route = inspect({
    operation: 'edit_image',
    relation: 'followup',
    goal: delta,
    goal_mode: 'amend',
    task_shape: 'single',
    resource_refs: [{ candidate_key: 'i1', role: 'target' }],
  }, delta, context);
  assert.strictEqual(route.goalMode, 'amend');
  assert.strictEqual(route.dispatchContract.arguments.prompt, delta);
  assert.deepStrictEqual(route.imageTaskState.segments, [
    { kind: 'base', text: BASE },
    { kind: 'amendment', text: delta },
  ]);
  assert.match(route.resolvedImageGoal, /住宅户型总长18米/);
  assert.match(route.resolvedImageGoal, /把堂屋主入口前的家具全部移开/);
}

module.exports = [
  testRouteIntentV3CarriesExplicitGoalMode,
  testCompleteRedesignReplacesTextStateWithoutBindingTheOldImage,
  testImageRevisionAmendsStructuredTaskStateWithoutChangingEditInstruction,
];
