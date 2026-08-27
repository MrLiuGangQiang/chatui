'use strict';

const assert = require('assert');
const routeService = require('../../client/services/route-service');
const routePrompts = require('../../client/services/route-prompts');

function multiRoute() {
  return {
    operationType: 'file_qa',
    taskShape: 'multi',
    multiTask: true,
    needClarification: true,
    readiness: 'needs_clarification',
    userGoal: '读完这个文件后再画一只狗',
  };
}

function plan() {
  return {
    schema_version: 'multi_task_plan.v1',
    tasks: [
      { key: 't1', operation: 'file_qa', description: '分析引言.docx', goal: '分析引言.docx的内容', resource_refs: [{ candidate_key: 'f1', role: 'attachment' }] },
      { key: 't2', operation: 'text_to_image', description: '画一只狗', goal: '画一只狗', resource_refs: [] },
    ],
  };
}

function contextWithFile() {
  return {
    recent_messages: [],
    image_candidates: [],
    file_candidates: [{
      index: 1,
      source_index: 1,
      source: 'current',
      file_id: 'file-current',
      name: 'plan.md',
      has_extracted_text: true,
    }],
  };
}

function testShouldRequestMultiTaskPlanOnlyForNonImageMulti() {
  assert.strictEqual(routeService.shouldRequestMultiTaskPlan(multiRoute()), true);
  assert.strictEqual(routeService.shouldRequestMultiTaskPlan({ ...multiRoute(), operationType: 'text_to_image' }), false,
    'image multi stays on the existing image_plan path');
  assert.strictEqual(routeService.shouldRequestMultiTaskPlan({ ...multiRoute(), multiTask: false }), false);
}

function testCompiledMultiRouteExposesMultiTaskFlag() {
  const input = '读完这个文件之后再画一只狗';
  const attachments = [{
    index: 1, source_index: 1, media_index: 1, id: 'file-current', file_id: 'file-current',
    name: 'plan.md', type: 'text/markdown', is_image: false, has_extracted_text: true,
  }];
  const inspected = routeService.inspectModelRouteResult(JSON.stringify({
    operation: 'file_qa', relation: 'new', goal: input, goal_mode: 'replace',
    task_shape: 'multi', resource_refs: [{ candidate_key: 'f1', role: 'attachment' }],
  }), { input, attachments, context: contextWithFile() });
  assert.ok(inspected.route);
  assert.strictEqual(inspected.route.multiTask, true, 'the multi-intent flag must be exposed on the compiled route');
  assert.strictEqual(routeService.shouldRequestMultiTaskPlan(inspected.route), true);
}

function testMultiTaskPlanPromptAndInspect() {
  assert.ok(routePrompts.createRoutePromptSet().MULTI_TASK_PLAN_SYSTEM_PROMPT.includes('multi_task_plan.v1'),
    'the planner prompt must be available');
  const inspected = routeService.inspectMultiTaskPlan(JSON.stringify(plan()));
  assert.ok(inspected.plan);
  assert.strictEqual(inspected.plan.tasks.length, 2);
  assert.deepStrictEqual(routeService.inspectMultiTaskPlan('not json').plan, null);
}

function testCompileMultiTaskPlanBuildsIndependentExecutableRoutes() {
  const compiled = routeService.compileMultiTaskPlan(plan(), {
    attachments: [{
      index: 1,
      source_index: 1,
      media_index: 1,
      id: 'file-current',
      file_id: 'file-current',
      name: 'plan.md',
      type: 'text/markdown',
      is_image: false,
      has_extracted_text: true,
    }],
    context: contextWithFile(),
  });
  assert.strictEqual(compiled.ok, true, compiled.reason);
  assert.strictEqual(compiled.items.length, 2);
  assert.strictEqual(compiled.items[0].route.operationType, 'file_qa');
  assert.strictEqual(compiled.items[0].route.readiness, 'ready');
  assert.strictEqual(compiled.items[1].route.operationType, 'text_to_image');
  assert.strictEqual(compiled.items[1].route.readiness, 'ready');
}

function testSelectMultiTaskPlanChoiceByNumberOrDescription() {
  const compiled = routeService.compileMultiTaskPlan(plan(), {
    attachments: [{
      index: 1, source_index: 1, media_index: 1, id: 'file-current', file_id: 'file-current',
      name: 'plan.md', type: 'text/markdown', is_image: false, has_extracted_text: true,
    }],
    context: contextWithFile(),
  });
  assert.strictEqual(routeService.selectMultiTaskPlanChoice(compiled.items, '2').operationType, 'text_to_image');
  assert.strictEqual(routeService.selectMultiTaskPlanChoice(compiled.items, '分析引言.docx').operationType, 'file_qa');
  assert.strictEqual(routeService.selectMultiTaskPlanChoice(compiled.items, '画一只狗').operationType, 'text_to_image');
  assert.strictEqual(routeService.selectMultiTaskPlanChoice(compiled.items, '随便'), null);
}

module.exports = [
  testShouldRequestMultiTaskPlanOnlyForNonImageMulti,
  testCompiledMultiRouteExposesMultiTaskFlag,
  testMultiTaskPlanPromptAndInspect,
  testCompileMultiTaskPlanBuildsIndependentExecutableRoutes,
  testSelectMultiTaskPlanChoiceByNumberOrDescription,
];
