'use strict';

// Intent/execution responsibility regression tests.
//
// The route model owns the semantic goal. The application may expose compact
// previous-execution facts to the model and must then compile the returned goal
// unchanged; it must not repair a weak model answer with vocabulary patches.

const assert = require('assert');
const routeService = require('../../client/services/route-service');

function previousExecution(operation = 'edit_image', input = '把耳朵换成红色', referenceId = 'imgref_A') {
  return {
    schema_version: 'execution_continuity.v1',
    operation,
    family: operation === 'edit_image' ? 'edit' : 'generate',
    input,
    result_kind: 'image',
    result_reference_id: referenceId,
    source_message_index: 2,
    source_user_message_index: 1,
    context_role: 'execution_state',
    instruction_authority: 'application_state',
  };
}

function contextWith(overrides = {}) {
  return {
    previous_execution: previousExecution(),
    image_candidates: [{
      index: 1,
      source: 'current',
      image_id: 'img_B',
      resource_id: 'res:image:img_B',
      reference_id: 'imgref_B',
      description: '新上传的猫',
      prompt: '新猫',
    }],
    recent_messages: [],
    file_candidates: [],
    ...overrides,
  };
}

function compileGoal(goal, input = '你选错了猫，请改用这只猫继续处理上一项图片编辑请求。', context = contextWith()) {
  return routeService.compileLocalRoute({
    operation: 'edit_image',
    relation: 'followup',
    arguments: { prompt: goal },
    bindings: [{ key: 'r1', type: 'image', role: 'target', resource_id: 'res:image:img_B', source: 'current' }],
    constraints: [],
  }, {
    input,
    attachments: [],
    context,
    semanticAuthority: routeService.ROUTE_INTENT_VERSION,
    executionInput: goal,
  });
}

function testModelResolvedGoalIsTheOnlyExecutionPromptAuthority() {
  const route = compileGoal('把耳朵换成红色');
  assert.strictEqual(route.contextualImagePrompt, '把耳朵换成红色');
  assert.strictEqual(route.editInstruction, '把耳朵换成红色');
  assert.strictEqual(route.dispatchContract.arguments.prompt, '把耳朵换成红色');
  assert.strictEqual(route.needClarification, false);
}

function testApplicationDoesNotPatchAnUnresolvedModelGoal() {
  const raw = '你选错了猫，请改用这只猫继续处理上一项图片编辑请求。';
  const route = compileGoal(raw, raw);
  assert.strictEqual(route.contextualImagePrompt, raw,
    'the compiler must preserve the model goal rather than infer hidden task content');
  assert.strictEqual(route.dispatchContract.arguments.prompt, raw);
}

function testNewConcreteInstructionRemainsUnchanged() {
  const input = '改用这只猫，把耳朵换成蓝色';
  const route = compileGoal(input, input);
  assert.strictEqual(route.contextualImagePrompt, input);
  assert.strictEqual(route.dispatchContract.arguments.prompt, input);
}

function testEditFamilyPreviousExecutionInputTravelsOnTheWire() {
  const payload = JSON.parse(routeService.buildRoutePayload({
    model: 'route-model',
    input: '改用这只猫继续上一项编辑',
    attachments: [],
    context: contextWith(),
    currentTurn: { messageIndex: 3 },
  }).input[1].content);
  assert.strictEqual(payload.context.previous_execution.input, '把耳朵换成红色',
    'the model needs the prior task content to produce a self-contained goal');
}

function testGenerateFamilyPublishesTheBoundedTextTaskBaselineWithoutExposingLegacyInput() {
  const payload = JSON.parse(routeService.buildRoutePayload({
    model: 'route-model',
    input: '不要这个，重新生成',
    attachments: [],
    context: contextWith({ previous_execution: previousExecution('text_to_image', '生成一只猫') }),
  }).input[1].content);
  assert.strictEqual(payload.context.previous_execution.input, undefined,
    'generation results must not expose the edit-only legacy input field');
  assert.strictEqual(payload.context.previous_execution.resolved_goal, '生成一只猫',
    'text-only image redesigns need the bounded historical task baseline, not an old image binding');
}

function testPromptUsesGeneralRulesInsteadOfFailureCasePatches() {
  const prompt = routeService.ROUTE_SYSTEM_PROMPT;
  assert.match(prompt, /goal是资源消解[、\/]历史依赖[、\/]图片任务的下游执行指令/);
  assert.match(prompt, /正例："将目标图中的猫改为白色，保留构图不变。"/);
  assert.doesNotMatch(prompt, /选错了猫|耳朵换成红色|资源纠正/,
    'specific production failures belong in evaluation fixtures, not the system prompt');
}

module.exports = [
  testModelResolvedGoalIsTheOnlyExecutionPromptAuthority,
  testApplicationDoesNotPatchAnUnresolvedModelGoal,
  testNewConcreteInstructionRemainsUnchanged,
  testEditFamilyPreviousExecutionInputTravelsOnTheWire,
  testGenerateFamilyPublishesTheBoundedTextTaskBaselineWithoutExposingLegacyInput,
  testPromptUsesGeneralRulesInsteadOfFailureCasePatches,
];
