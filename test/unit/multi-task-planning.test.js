'use strict';

const assert = require('assert');
const routeService = require('../../client/services/route-service');
const routeIntentWorkflow = require('../../client/app/route-intent-workflow');
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

async function testWorkflowInvokesMultiTaskPlannerAndListsTasks() {
  const previousRouteService = globalThis.ChatUIRouteService;
  globalThis.ChatUIRouteService = routeService;
  const input = '读完这个文件之后再画一只狗 画完之后再讲一个笑话';
  const attachments = [{
    index: 1, source_index: 1, media_index: 1, id: 'file-current', file_id: 'file-current',
    name: 'plan.md', type: 'text/markdown', is_image: false, has_extracted_text: true,
  }];
  const calls = [];
  const workflow = routeIntentWorkflow.createRouteIntentWorkflow({
    state: { mode: 'chat', autoMode: true, sessions: [], messages: [] },
    getConfig: () => ({ baseUrl: 'https://gateway.example/v1', apiKey: 'route-secret', routeModel: 'route-model', chatModel: 'route-model' }),
    getSessionRouteModel: () => 'route-model',
    getSessionChatModel: () => 'route-model',
    requestJson: async () => {
      calls.push(true);
      if (calls.length >= 2) {
        return { output_text: JSON.stringify({
          schema_version: 'multi_task_plan.v1',
          tasks: [
            { key: 't1', operation: 'file_qa', description: '分析引言.docx', goal: '分析引言.docx的内容', resource_refs: [{ candidate_key: 'f1', role: 'attachment' }] },
            { key: 't2', operation: 'text_to_image', description: '画一只狗', goal: '画一只狗', resource_refs: [] },
            { key: 't3', operation: 'plain_chat', description: '讲一个笑话', goal: '讲一个笑话', resource_refs: [] },
          ],
        }) };
      }
      return { output_text: JSON.stringify({
        operation: 'file_qa', relation: 'new', goal: input, goal_mode: 'replace',
        task_shape: 'multi', resource_refs: [{ candidate_key: 'f1', role: 'attachment' }],
      }) };
    },
  });
  try {
    const route = await workflow.getEffectiveRoute(input, attachments, 'session-1');
    assert.strictEqual(calls.length, 2, 'the workflow must run intent recognition and then the multi-task planner');
    assert.strictEqual(route.needClarification, true);
    assert.ok(Array.isArray(route.multiTaskPlanCompiled));
    assert.strictEqual(route.multiTaskPlanCompiled.length, 3);
    assert.match(route.clarificationQuestion, /识别到 3 个独立任务/);
    assert.match(route.clarificationQuestion, /1\. 分析引言\.docx/);
    assert.match(route.clarificationQuestion, /2\. 画一只狗/);
    assert.match(route.clarificationQuestion, /3\. 讲一个笑话/);
    assert.strictEqual(route.multiTaskPlanCompiled[1].route.operationType, 'text_to_image');
  } finally {
    if (previousRouteService === undefined) delete globalThis.ChatUIRouteService;
    else globalThis.ChatUIRouteService = previousRouteService;
  }
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



function testClarificationContextCarriesMultiTaskPlanForModelSelection() {
  const clarificationAnswer = require('../../shared/clarification-answer');
  const pending = clarificationAnswer.createPendingClarification({
    messages: [],
    clarificationText: '识别到 2 个独立任务',
    routeInfo: {
      multiTaskPlan: {
        schema_version: 'multi_task_plan.v1',
        tasks: [
          { key: 't1', operation: 'file_qa', description: '总结文件', goal: '总结文件', resource_refs: [{ candidate_key: 'f1', role: 'attachment' }] },
          { key: 't2', operation: 'text_to_image', description: '画一只狗', goal: '画一只狗', resource_refs: [] },
        ],
      },
    },
  });
  const context = clarificationAnswer.buildClarificationRouteContext({ baseContext: {}, pending });
  assert.ok(context.clarification_context.multi_task_plan, 'the task list must be available to intent recognition');
  assert.strictEqual(context.clarification_context.multi_task_plan.tasks.length, 2);
  assert.deepStrictEqual(context.clarification_context.multi_task_plan.tasks[1], {
    index: 2, key: 't2', operation: 'text_to_image', description: '画一只狗', goal: '画一只狗', resource_refs: [],
  });
}

function testTaskSelectionStripsOriginalEvidenceAndExposesPlan() {
  const clarificationAnswer = require('../../shared/clarification-answer');
  const pending = clarificationAnswer.createPendingClarification({
    messages: [],
    clarificationText: '请回复要执行的编号',
    routeInfo: {
      multiTaskPlan: {
        schema_version: 'multi_task_plan.v1',
        tasks: [
          { key: 't1', operation: 'file_qa', description: '总结文件', goal: '总结文件', resource_refs: [{ candidate_key: 'f1', role: 'attachment' }] },
          { key: 't2', operation: 'text_to_image', description: '画一只狗', goal: '画一只狗', resource_refs: [] },
          { key: 't3', operation: 'plain_chat', description: '讲一个笑话', goal: '讲一个笑话', resource_refs: [] },
        ],
      },
    },
  });
  const context = clarificationAnswer.buildClarificationRouteContext({
    baseContext: {
      recent_messages: [{ index: 1, role: 'user', content: '原始多任务请求' }],
      image_candidates: [],
      file_candidates: [{ index: 1, source: 'current', file_id: 'file-current', name: 'plan.md' }],
    },
    pending,
  });
  assert.deepStrictEqual(context.recent_messages, [], 'the original multi request must not distract task selection');
  assert.deepStrictEqual(context.file_candidates, [], 'the original attachment must not dominate task selection');
  assert.ok(context.multi_task_plan, 'the generated task list must be the primary evidence');
  assert.strictEqual(context.multi_task_plan.tasks[2].description, '讲一个笑话');
}

function testClarificationWireContextRetainsMultiTaskPlan() {
  const clarificationAnswer = require('../../shared/clarification-answer');
  const pending = clarificationAnswer.createPendingClarification({
    messages: [],
    clarificationText: '请回复要执行的编号',
    routeInfo: {
      multiTaskPlan: {
        schema_version: 'multi_task_plan.v1',
        tasks: [
          { key: 't1', operation: 'file_qa', description: '总结文件', goal: '总结文件', resource_refs: [{ candidate_key: 'f1', role: 'attachment' }] },
          { key: 't2', operation: 'text_to_image', description: '画一只狗', goal: '画一只狗', resource_refs: [] },
        ],
      },
    },
  });
  const context = clarificationAnswer.buildClarificationRouteContext({ baseContext: {}, pending });
  const wire = routeService.compactWireRouteContext(context, '做任务2', []);
  assert.ok(wire.clarification_context.multi_task_plan, 'the task list must reach intent recognition');
  assert.strictEqual(wire.clarification_context.multi_task_plan.tasks.length, 2);
  assert.strictEqual(wire.clarification_context.multi_task_plan.tasks[1].description, '画一只狗');
}

function testRoutePromptDeclaresModelPoweredTaskSelection() {
  const routePrompts = require('../../client/services/route-prompts');
  const prompt = routePrompts.createRoutePromptSet().ROUTE_SYSTEM_PROMPT;
  assert.match(prompt, /【多任务选择】/);
  assert.match(prompt, /只输出所选任务对应的operation\/goal\/resource_refs/);
  assert.match(prompt, /task_shape=single/);
}

module.exports = [
  testShouldRequestMultiTaskPlanOnlyForNonImageMulti,
  testCompiledMultiRouteExposesMultiTaskFlag,
  testMultiTaskPlanPromptAndInspect,
  testWorkflowInvokesMultiTaskPlannerAndListsTasks,
  testCompileMultiTaskPlanBuildsIndependentExecutableRoutes,
  testClarificationContextCarriesMultiTaskPlanForModelSelection,
  testRoutePromptDeclaresModelPoweredTaskSelection,
  testClarificationWireContextRetainsMultiTaskPlan,
  testTaskSelectionStripsOriginalEvidenceAndExposesPlan,
];
