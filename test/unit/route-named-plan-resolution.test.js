'use strict';

const assert = require('assert');
const routeService = require('../../client/services/route-service');
const taskContinuity = require('../../shared/task-continuity');

const SELECTED_PLAN = '保留三房两厅，缩短交通动线，厨房靠近入口，白色现代简约风格。';
const UNSELECTED_PLAN = '增加储物间，扩大客厅，改成红砖工业风。';
const OPTIONS_MESSAGE = `方案A：${SELECTED_PLAN}\n\n方案B：${UNSELECTED_PLAN}`;

function routeIntent(operation, goal, resourceRefs = []) {
  return {
    operation,
    relation: 'followup',
    goal,
    goal_mode: 'replace',
    resource_refs: resourceRefs,
    task_shape: 'single',
  };
}

function previousExecution() {
  return {
    operation: 'text_to_image',
    family: 'generate',
    task_state: taskContinuity.createReplacementTaskContinuity('过期的旧方案，不应污染新的执行指令。'),
  };
}

function initialRoute({ operation = 'text_to_image', input = '按照方案A重新设计', attachments = [], resourceRefs = [] } = {}) {
  const context = {
    recent_messages: [{ index: 1, id: 'message-options', resource_id: 'res:message:message-options', role: 'assistant', content: OPTIONS_MESSAGE }],
    previous_execution: previousExecution(),
  };
  const result = routeService.inspectModelRouteResult(JSON.stringify(routeIntent(operation, input, resourceRefs)), {
    input,
    attachments,
    context,
  });
  assert.strictEqual(result.reason, '');
  assert.ok(result.route, result.error || 'route compilation failed');
  return { route: result.route, context };
}

function testRouteKeepsSelectionSemanticsSeparateFromPromptMaterialization() {
  const { route, context } = initialRoute();

  assert.strictEqual(route.dispatchAuthorized, true);
  assert.strictEqual(route.dispatchContract.arguments.prompt, '按照方案A重新设计');
  assert.strictEqual(routeService.requiresImageInstructionMaterialization(route), true);

  const payload = routeService.buildImageInstructionPayload({
    model: 'route-model',
    input: '按照方案A重新设计',
    route,
    context,
  });
  const envelope = JSON.parse(payload.input.find(item => item.role === 'user').content);
  assert.strictEqual(envelope.provisional_instruction, '按照方案A重新设计');
  assert.strictEqual(envelope.context.recent_messages[0].content, OPTIONS_MESSAGE);
  assert.match(payload.input.find(item => item.role === 'system').content, /完整 instruction/);

  const materialized = routeService.applyMaterializedImageInstruction(route, SELECTED_PLAN, { context });
  assert.strictEqual(materialized.goalMode, 'replace');
  assert.strictEqual(materialized.dispatchAuthorized, true);
  assert.strictEqual(materialized.dispatchContract.arguments.prompt, SELECTED_PLAN);
  assert.doesNotMatch(materialized.dispatchContract.arguments.prompt, /方案A|方案B|过期的旧方案/);
  assert.strictEqual(materialized.imageTaskState.segments.length, 1);
  assert.strictEqual(materialized.imageTaskState.segments[0].text, SELECTED_PLAN);
}

function testMaterializerClarificationStopsDispatchRatherThanForwardingReferenceText() {
  const { route } = initialRoute({ input: '按照方案C重新设计' });
  const blocked = routeService.clarifyImageInstructionRoute(route, '找不到方案C的具体内容，请确认要采用哪一项。');

  assert.strictEqual(blocked.readiness, 'needs_clarification');
  assert.strictEqual(blocked.dispatchAuthorized, false);
  assert.strictEqual(blocked.dispatchContract, null);
  assert.match(blocked.clarificationQuestion, /方案C/);
}

function testImageInstructionProtocolRejectsProviderPromptThatIsNotReady() {
  const unresolved = routeService.inspectImageInstructionResult(JSON.stringify({
    schema_version: 'image_instruction.v1',
    status: 'needs_clarification',
    instruction: '',
    clarification: '请明确方案内容。',
  }));
  assert.strictEqual(unresolved.reason, '');
  assert.strictEqual(unresolved.materialization.status, 'needs_clarification');

  const invalid = routeService.inspectImageInstructionResult(JSON.stringify({
    schema_version: 'image_instruction.v1',
    status: 'ready',
    instruction: '按照方案A重新生成',
    clarification: '不应同时出现',
  }));
  assert.strictEqual(invalid.materialization, null);
  assert.strictEqual(invalid.reason, 'image_instruction_invalid');

  const conversationalReady = routeService.inspectImageInstructionResult(JSON.stringify({
    schema_version: 'image_instruction.v1',
    status: 'ready',
    instruction: '按照方案A重新生成',
    clarification: '',
  }));
  assert.strictEqual(conversationalReady.materialization, null);
  assert.strictEqual(conversationalReady.reason, 'image_instruction_not_standalone',
    'the execution boundary must reject a ready-shaped response that still needs chat history to execute');
  assert.strictEqual(routeService.hasUnresolvedImageInstructionReference('按照方案A重新生成'), true);
  assert.strictEqual(routeService.hasUnresolvedImageInstructionReference(SELECTED_PLAN), false);
}

function testMaterializedEditInstructionKeepsOnlyTargetBinding() {
  const attachment = {
    type: 'image/png', image_id: 'target-image', resource_id: 'res:image:target-image', index: 1, source_index: 1, name: 'target.png',
  };
  const { route, context } = initialRoute({
    operation: 'edit_image',
    input: '按照方案A编辑这张图',
    attachments: [attachment],
    resourceRefs: [{ candidate_key: 'i1', role: 'target' }],
  });
  const instruction = '保留人物姿态和服装，将背景改为黄昏海边，加入电影感侧逆光与浅景深。';
  const materialized = routeService.applyMaterializedImageInstruction(route, instruction, { context });

  assert.strictEqual(materialized.dispatchContract.arguments.prompt, instruction);
  assert.deepStrictEqual(materialized.dispatchContract.bindings.map(binding => ({ type: binding.type, role: binding.role })), [
    { type: 'image', role: 'target' },
  ]);
}

module.exports = [
  testRouteKeepsSelectionSemanticsSeparateFromPromptMaterialization,
  testMaterializerClarificationStopsDispatchRatherThanForwardingReferenceText,
  testImageInstructionProtocolRejectsProviderPromptThatIsNotReady,
  testMaterializedEditInstructionKeepsOnlyTargetBinding,
];
