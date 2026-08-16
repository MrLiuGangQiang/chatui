'use strict';

const assert = require('assert');
const routeService = require('../../client/services/route-service');
const dispatchContract = require('../../shared/dispatch-contract');

function generateTask(prompt) {
  return { task_type: 'generate', prompt, input_images: [] };
}

function imagePlan(tasks) {
  return { schema_version: 'image_plan.v1', tasks };
}

function compile(options = {}) {
  return routeService.compileImagePlan(imagePlan([
    generateTask('一只猫'),
    generateTask('一只狗'),
    generateTask('一只鸟'),
    generateTask('一座房子'),
    generateTask('一辆汽车'),
  ]), {
    input: '猫、狗、鸟、房子、汽车各一张',
    attachments: [],
    context: {},
    ...options,
  });
}

function testCompileImagePlanSplitsFiveGenerateTasksIntoIndependentContracts() {
  const result = compile();
  assert.strictEqual(result.ok, true);
  assert.strictEqual(result.kind, 'batch');
  assert.strictEqual(result.maxTasks, 5);
  assert.strictEqual(result.items.length, 5);
  assert.deepStrictEqual(result.items.map(item => item.operation), Array(5).fill('text_to_image'));
  assert.deepStrictEqual(result.items.map(item => item.dispatchContract.arguments.prompt),
    ['一只猫', '一只狗', '一只鸟', '一座房子', '一辆汽车']);
  assert.strictEqual(result.items.every(item => dispatchContract.hasExactDispatchContract(item.dispatchContract)), true);
  assert.strictEqual(new Set(result.items.map(item => item.dispatchContract.idempotency_key)).size, 5,
    'each child task must own an independent idempotency key');
  assert.strictEqual(result.items.every(item => item.executionResources.version === 'execution_resources.v2'), true);
}

function testCompileImagePlanRejectsOverLimitWithAnExplicitPrompt() {
  const result = routeService.compileImagePlan(imagePlan(Array.from({ length: 6 }, (_, index) => generateTask(`图${index}`))), {
    input: '一次生成六张',
    attachments: [],
    context: {},
  });
  assert.strictEqual(result.ok, false);
  assert.strictEqual(result.code, 'IMAGE_PLAN_OVER_LIMIT');
  assert.strictEqual(result.taskCount, 6);
  assert.strictEqual(result.maxTasks, 5);
  assert.match(result.question, /最多生成 5 张/);
}

function testCompileImagePlanCollapsesOneTaskBackToSingleExecution() {
  const result = routeService.compileImagePlan(imagePlan([generateTask('只生成这一张')]), {
    input: '只生成这一张',
    attachments: [],
    context: {},
  });
  assert.strictEqual(result.ok, true);
  assert.strictEqual(result.kind, 'single');
  assert.strictEqual(result.item.operation, 'text_to_image');
  assert.strictEqual(dispatchContract.hasExactDispatchContract(result.dispatchContract), true);
  assert.strictEqual(result.dispatchContract.arguments.prompt, '只生成这一张');
}

function testCompileImagePlanRejectsInvalidPlanningOutput() {
  const result = routeService.compileImagePlan({ schema_version: 'image_plan.v2', tasks: [generateTask('x')] }, {
    input: 'x', attachments: [], context: {},
  });
  assert.strictEqual(result.ok, false);
  assert.strictEqual(result.code, 'IMAGE_PLAN_INVALID');
}

function testCompileImagePlanResolvesEditTaskBindingsFromCandidateCatalog() {
  const context = {
    recent_messages: [
      { index: 1, role: 'user', content: '画一只猫。' },
      { index: 2, role: 'assistant', content: '[图片生成完成] 一只猫。' },
    ],
    image_candidates: [
      { index: 1, source_index: 1, source: 'history', image_id: 'cat-1', reference_id: 'cat-ref-1', target: 'previous', description: '一只猫' },
    ],
    file_candidates: [],
  };
  const result = routeService.compileImagePlan(imagePlan([
    { task_type: 'edit', prompt: '把猫改成白色', input_images: [{ candidate_key: 'i1', role: 'target' }] },
    generateTask('一只狗'),
  ]), { input: '猫 狗', attachments: [], context });

  assert.strictEqual(result.ok, true, result.question || result.error || '');
  assert.strictEqual(result.kind, 'batch');
  assert.deepStrictEqual(result.items.map(item => item.operation), ['edit_image', 'text_to_image']);
  assert.deepStrictEqual(result.items[0].dispatchContract.bindings.map(binding => [binding.role, binding.resource_id]),
    [['target', 'res:image:cat-1']]);
  assert.strictEqual(dispatchContract.hasExactDispatchContract(result.items[0].dispatchContract), true);
}

function testRouteIntentTaskShapeFlowsToRouteAndGatesPlanning() {
  const baseIntent = {
    operation: 'text_to_image',
    relation: 'new',
    goal: '分别生成一只猫和一只狗',
    task_shape: 'single',
    resource_refs: [],
  };
  const legacy = routeService.inspectModelRouteResult(JSON.stringify(baseIntent), {
    input: '分别生成一只猫和一只狗',
    attachments: [],
    context: {},
  });
  assert.ok(legacy.route, legacy.reason);
  assert.strictEqual(legacy.route.taskShape, 'single');
  assert.strictEqual(routeService.shouldRequestImagePlan(legacy.route), false);

  const multi = routeService.inspectModelRouteResult(JSON.stringify({ ...baseIntent, task_shape: 'multi' }), {
    input: '分别生成一只猫和一只狗',
    attachments: [],
    context: {},
  });
  assert.ok(multi.route, multi.reason);
  assert.strictEqual(multi.route.taskShape, 'multi');
  assert.strictEqual(routeService.shouldRequestImagePlan(multi.route), true);

  const multiChat = routeService.inspectModelRouteResult(JSON.stringify({
    operation: 'plain_chat',
    relation: 'new',
    goal: '解释一下',
    resource_refs: [],
    task_shape: 'multi',
  }), { input: '解释一下', attachments: [], context: {} });
  assert.ok(multiChat.route, multiChat.reason);
  assert.strictEqual(multiChat.route.taskShape, 'multi');
  assert.strictEqual(multiChat.route.readiness, 'needs_clarification',
    'non-image multi routes must fail closed instead of dispatching as one task');
  assert.strictEqual(multiChat.route.dispatchAuthorized, false);
  assert.strictEqual(routeService.shouldRequestImagePlan(multiChat.route), false,
    'task_shape must only authorize image generation/edit planning');
}

module.exports = [
  testCompileImagePlanSplitsFiveGenerateTasksIntoIndependentContracts,
  testCompileImagePlanRejectsOverLimitWithAnExplicitPrompt,
  testCompileImagePlanCollapsesOneTaskBackToSingleExecution,
  testCompileImagePlanRejectsInvalidPlanningOutput,
  testCompileImagePlanResolvesEditTaskBindingsFromCandidateCatalog,
  testRouteIntentTaskShapeFlowsToRouteAndGatesPlanning,
];
