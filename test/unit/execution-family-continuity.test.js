'use strict';

const assert = require('assert');
const routeService = require('../../client/services/route-service');
const imageRouteContext = require('../../client/core/image-route-context');

function plan(overrides = {}) {
  const relation = String(overrides.relation || 'new');
  const operation = String(overrides.operation || 'plain_chat');
  const prompt = String(overrides.prompt || '');
  return {
    operation,
    relation,
    arguments: { prompt },
    bindings: Array.isArray(overrides.bindings) ? overrides.bindings : [],
    constraints: [],
  };
}

function previousExecution(operation = 'text_to_image', input = '帮我生成一个宣传图', referenceId = 'imgref_previous') {
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

function inspect(value, input, context = {}) {
  try {
    return {
      route: routeService.compileLocalRoute(value, {
        input, attachments: [], context, currentMode: 'chat', autoMode: true,
      }),
      reason: '',
    };
  } catch (error) {
    return { route: null, reason: 'route_compilation_failed', error: error.message };
  }
}

function imageContextWithPrevious(operation = 'text_to_image') {
  const referenceId = 'imgref_previous';
  return {
    previous_execution: previousExecution(operation, '帮我生成一个宣传图', referenceId),
    image_candidates: [{
      index: 1,
      source_index: 1,
      message_index: 2,
      source: 'history',
      image_id: 'img_previous_1',
      resource_id: 'res:image:img_previous_1',
      reference_id: referenceId,
      description: '上一张生成图片',
      prompt: '帮我生成一个宣传图',
    }],
    recent_messages: [],
    file_candidates: [],
  };
}

function testCompletedImageExecutionProjectsOneDurableStateFact() {
  const messages = [
    { role: 'user', content: '帮我生成一个宣传图' },
    {
      role: 'assistant',
      content: '[图片生成完成] 帮我生成一个宣传图',
      kind: 'image',
      imageContext: JSON.stringify({
        mode: 'image', prompt: '帮我生成一个宣传图', routePrompt: '帮我生成一个宣传图',
        referenceId: 'imgref_previous',
      }),
    },
    { role: 'user', content: '不要这个' },
  ];
  const context = imageRouteContext.buildRouteContext({ messages });
  assert.deepStrictEqual(context.previous_execution, {
    schema_version: 'execution_continuity.v1',
    operation: 'text_to_image',
    family: 'generate',
    input: '帮我生成一个宣传图',
    resolved_goal: '帮我生成一个宣传图',
    task_state: {
      schema_version: 'task_continuity.v1',
      goal_mode: 'replace',
      segments: [{ kind: 'base', text: '帮我生成一个宣传图' }],
    },
    result_kind: 'image',
    result_reference_id: 'imgref_previous',
    source_message_index: 2,
    source_user_message_index: 1,
    priority_coefficient: 0.72,
    priority_age_turns: 1,
    context_role: 'execution_state',
    instruction_authority: 'application_state',
  });

  const payload = routeService.buildRoutePayload({ model: 'route-model', input: '不要这个', context });
  const publicContext = JSON.parse(payload.input[1].content).context;
  assert.deepStrictEqual(publicContext.previous_execution, {
    operation: 'text_to_image',
    family: 'generate',
    result_kind: 'image',
    source_message_index: 2,
    source_user_message_index: 1,
    task_state: {
      schema_version: 'task_continuity.v1',
      goal_mode: 'replace',
      segments: [{ kind: 'base', text: '帮我生成一个宣传图' }],
    },
  }, 'the router receives the structured task baseline needed to classify a text-only image redesign, never durable resource IDs or internal metadata');
  const publicContextText = JSON.stringify(publicContext);
  assert.ok(!publicContextText.includes(context.previous_execution.result_reference_id));
  // Generate-family results do not expose the legacy edit-instruction field;
  // they publish a bounded resolved goal so a later text-only redesign can
  // preserve the design task without binding the old image.
  assert.strictEqual(publicContext.previous_execution.input, undefined);
  assert.strictEqual(publicContext.previous_execution.resolved_goal, undefined);
  assert.deepStrictEqual(publicContext.previous_execution.task_state, context.previous_execution.task_state);
  assert.ok(publicContext.recent_messages.some(message => message.content.includes(context.previous_execution.input)),
    'the bounded conversation window may still contain the original user-visible prompt');
  assert.ok(!publicContextText.includes('instruction_authority'));
}

function testExplicitReferenceGenerationLineageSurvivesStorageProjection() {
  const context = imageRouteContext.buildRouteContext({
    messages: [
      { role: 'user', content: '参考第一张图生成一张新的海报' },
      {
        role: 'assistant',
        content: '[图片生成完成] 参考第一张图生成一张新的海报',
        kind: 'image',
        imageContext: JSON.stringify({
          schema_version: 'image_result.v1',
          operation: 'image_reference_gen',
          executionInput: '参考第一张图生成一张新的海报',
          prompt: '新的海报',
          referenceId: 'imgref_reference_result',
        }),
      },
      { role: 'user', content: '再来一版' },
    ],
  });
  assert.strictEqual(context.previous_execution.operation, 'image_reference_gen');
  assert.strictEqual(context.previous_execution.family, 'generate');
  assert.strictEqual(context.previous_execution.input, '参考第一张图生成一张新的海报');
  assert.strictEqual(context.previous_execution.result_reference_id, 'imgref_reference_result');
}

function testLaterCompletedChatPreventsStaleVisualInheritance() {
  const context = imageRouteContext.buildRouteContext({
    messages: [
      { role: 'user', content: '生成一张产品海报' },
      {
        role: 'assistant', content: '[图片生成完成] 生成一张产品海报', kind: 'image',
        imageContext: JSON.stringify({ operation: 'text_to_image', executionInput: '生成一张产品海报', referenceId: 'imgref_old' }),
      },
      { role: 'user', content: '解释一下扩散模型原理' },
      { role: 'assistant', content: '扩散模型通过逐步去噪生成内容。' },
      { role: 'user', content: '再解释简单一点' },
    ],
  });
  assert.strictEqual(context.previous_execution, null,
    'the latest completed non-visual execution must block inheritance from an older image task');
}

function testClarificationDoesNotEraseLastCompletedVisualExecution() {
  const context = imageRouteContext.buildRouteContext({
    messages: [
      { role: 'user', content: '生成一张产品海报' },
      {
        role: 'assistant', content: '[图片生成完成] 生成一张产品海报', kind: 'image',
        imageContext: JSON.stringify({ operation: 'text_to_image', executionInput: '生成一张产品海报', referenceId: 'imgref_kept' }),
      },
      { role: 'user', content: '不要这个' },
      { role: 'assistant', content: '请说明需要调整什么。', clarificationId: 'clarify_1' },
      { role: 'user', content: '换一张' },
    ],
  });
  assert.strictEqual(context.previous_execution.operation, 'text_to_image');
  assert.strictEqual(context.previous_execution.result_reference_id, 'imgref_kept');
}

function testFollowupCannotDowngradeCompletedGenerationToChat() {
  const result = inspect(plan({ operation: 'plain_chat', relation: 'continuation', prompt: '不要这个' }), '不要这个', imageContextWithPrevious());
  assert.ok(result.route, result.reason);
  assert.strictEqual(result.route.operationType, 'image_reference_gen');
  assert.strictEqual(result.route.api, 'image_edit');
  assert.strictEqual(result.route.mode, 'image');
  assert.strictEqual(result.route.needClarification, false);
  assert.strictEqual(result.route.contextualImagePrompt, '不要这个');
  assert.deepStrictEqual(result.route.dispatchContract.bindings, [{
    key: 'r1', type: 'image', role: 'reference', resource_id: 'res:image:img_previous_1', source: 'history',
  }]);
  assert.strictEqual(routeService.isRouteDispatchable(result.route), true);
}

function testGenerateFollowupCannotBindPreviousResultAsEditTarget() {
  const result = inspect(plan({
    operation: 'text_to_image',
    relation: 'continuation',
    prompt: '不要这个',
    bindings: [{ key: 'r1', type: 'image', role: 'target', resource_id: 'res:image:img_previous_1', source: 'history' }],
  }), '不要这个', imageContextWithPrevious());

  assert.ok(result.route, result.reason);
  assert.strictEqual(result.route.operationType, 'image_reference_gen');
  assert.strictEqual(result.route.api, 'image_edit');
  assert.strictEqual(result.route.mode, 'image');
  assert.strictEqual(result.route.needClarification, false);
  assert.strictEqual(result.route.contextualImagePrompt, '不要这个');
  assert.deepStrictEqual(result.route.resources.map(resource => [resource.role, resource.id]), [['reference', 'img_previous_1']]);
  assert.strictEqual(routeService.isRouteDispatchable(result.route), true);
}

function testContinuationCannotDowngradeCompletedGenerationToChat() {
  const result = inspect(plan({ operation: 'plain_chat', relation: 'continuation', prompt: '再来一版' }), '再来一版', imageContextWithPrevious());
  assert.ok(result.route, result.reason);
  assert.strictEqual(result.route.operationType, 'image_reference_gen');
  assert.strictEqual(result.route.contextualImagePrompt, '再来一版');
  assert.strictEqual(routeService.isRouteDispatchable(result.route), true);
}

function testBoundGeneratedImageContinuationUsesOnlyCurrentInstruction() {
  const context = {
    previous_execution: previousExecution('text_to_image', '画一只猫', 'cat-reference'),
    image_candidates: [{
      index: 1,
      source_index: 1,
      message_index: 2,
      source: 'history',
      image_id: 'cat-result',
      resource_id: 'res:image:cat-result',
      reference_id: 'cat-reference',
      description: '一只猫',
    }],
    recent_messages: [],
    file_candidates: [],
  };
  const result = inspect(plan({
    operation: 'image_reference_gen',
    relation: 'continuation',
    prompt: '换一个姿势',
    bindings: [{ key: 'r1', type: 'image', role: 'reference', resource_id: 'res:image:cat-result', source: 'history' }],
  }), '换一个姿势', context);

  assert.ok(result.route, result.reason);
  assert.strictEqual(result.route.operationType, 'image_reference_gen');
  assert.strictEqual(result.route.contextualImagePrompt, '换一个姿势');
  assert.strictEqual(result.route.dispatchContract.arguments.prompt, '换一个姿势');
  assert.deepStrictEqual(result.route.dispatchContract.bindings, [{
    key: 'r1', type: 'image', role: 'reference', resource_id: 'res:image:cat-result', source: 'history',
  }]);
}


function testGeneratedResultReferenceRebindsAPlainGenerationContinuation() {
  const messages = [
    { role: 'user', content: '\u753b\u4e00\u53ea\u732b' },
    {
      role: 'assistant',
      displayItemId: 'display-only-id',
      content: '[\u56fe\u7247\u751f\u6210\u5b8c\u6210] \u753b\u4e00\u53ea\u732b',
      imageContext: JSON.stringify({
        schema_version: 'image_result.v1',
        operation: 'text_to_image',
        prompt: '\u753b\u4e00\u53ea\u732b',
        routePrompt: '\u753b\u4e00\u53ea\u732b',
        referenceId: 'imgref_durable_cat_result',
        attachments: [{ src: 'indexeddb://cat-result', name: 'cat.png' }],
      }),
    },
    { role: 'user', content: '\u6362\u4e00\u4e2a\u59ff\u52bf' },
  ];
  const context = imageRouteContext.buildRouteContext({
    messages,
    recentImageReferences: imageRouteContext.collectRecentImageReferences({ messages }),
  });
  const result = inspect(plan({
    operation: 'text_to_image', relation: 'continuation', prompt: '\u6362\u4e00\u4e2a\u59ff\u52bf',
  }), '\u6362\u4e00\u4e2a\u59ff\u52bf', context);

  assert.ok(result.route, result.reason);
  assert.strictEqual(context.previous_execution.result_reference_id, 'imgref_durable_cat_result');
  assert.deepStrictEqual(context.image_candidates.map(candidate => candidate.reference_id), ['imgref_durable_cat_result']);
  assert.strictEqual(result.route.operationType, 'image_reference_gen');
  assert.strictEqual(result.route.contextualImagePrompt, '\u6362\u4e00\u4e2a\u59ff\u52bf');
  assert.deepStrictEqual(result.route.resources.map(resource => [resource.id, resource.role]), [
    ['img_imgref_durable_cat_result_1', 'reference'],
  ]);
}

function testBadPendingClarificationCannotEraseCompletedExecutionFamily() {
  const context = {
    ...imageContextWithPrevious(),
    clarification_context: {
      schema_version: 'clarification_context.v3',
      pending_task: {
        base_input: '不要这个', supplements: [], question: '请说明要先处理哪一部分。',
        prior_actions: ['respond'], prior_task_facts: {}, established_bindings: [], unresolved: [],
      },
    },
  };
  const result = inspect(plan({ operation: 'text_to_image', relation: 'continuation', prompt: '换一张图' }), '换一张图', context);
  assert.ok(result.route, result.reason);
  assert.strictEqual(result.route.operationType, 'image_reference_gen');
  assert.strictEqual(result.route.mode, 'image');
  assert.strictEqual(routeService.isRouteDispatchable(result.route), true);
}

function testCurrentInputTextCannotRewriteIndependentSemanticFacts() {
  const result = inspect(plan({ operation: 'plain_chat', relation: 'new', prompt: '换一个图' }), '换一个图', imageContextWithPrevious());
  assert.ok(result.route, result.reason);
  assert.strictEqual(result.route.operationType, 'plain_chat');
  assert.strictEqual(result.route.mode, 'chat');
}

function testExplicitIndependentChatDoesNotInheritImageExecution() {
  const result = inspect(plan({ operation: 'plain_chat', relation: 'new', prompt: '解释一下扩散模型原理' }), '解释一下扩散模型原理', imageContextWithPrevious());
  assert.ok(result.route, result.reason);
  assert.strictEqual(result.route.operationType, 'plain_chat');
  assert.strictEqual(result.route.mode, 'chat');
}

function testImageAnalysisDependencyDoesNotInheritGenerationFamily() {
  const result = inspect(plan({
    operation: 'image_qa',
    relation: 'followup',
    prompt: '分析一下这张图',
    bindings: [{ key: 'r1', type: 'image', role: 'source', resource_id: 'res:image:img_previous_1', source: 'history' }],
  }), '分析一下这张图', imageContextWithPrevious());
  assert.ok(result.route, result.reason);
  assert.strictEqual(result.route.operationType, 'image_qa');
  assert.strictEqual(result.route.mode, 'chat');
}

function testFollowupWithTargetUsesImageEditInsteadOfChat() {
  const result = inspect(plan({
    operation: 'edit_image',
    relation: 'followup',
    prompt: '商品换成无线耳机',
    bindings: [{ key: 'r1', type: 'image', role: 'target', resource_id: 'res:image:img_previous_1', source: 'history' }],
  }), '商品换成无线耳机', imageContextWithPrevious());
  assert.ok(result.route, result.reason);
  assert.strictEqual(result.route.operationType, 'edit_image');
  assert.strictEqual(result.route.api, 'image_edit');
  assert.strictEqual(result.route.mode, 'edit_image');
  assert.strictEqual(routeService.isRouteDispatchable(result.route), true);
}

function testCompletedEditContinuationRebindsItsOwnResult() {
  const result = inspect(plan({ operation: 'plain_chat', relation: 'continuation', prompt: '再做一版' }), '再做一版', imageContextWithPrevious('edit_image'));
  assert.ok(result.route, result.reason);
  assert.strictEqual(result.route.operationType, 'edit_image');
  assert.strictEqual(result.route.needClarification, false);
  assert.strictEqual(result.route.selectedImageIds[0], 'img_previous_1');
  assert.strictEqual(routeService.isRouteDispatchable(result.route), true);
}

function testGenerationContentReadinessRemainsASeparateGate() {
  const missing = inspect(plan({ operation: 'text_to_image', relation: 'new', prompt: '生成一张图' }), '生成一张图', {});
  assert.ok(missing.route, missing.reason);
  assert.strictEqual(missing.route.clarificationQuestion, '你想生成什么样的图片？请补充画面内容描述，例如主体、场景和风格。');
  assert.strictEqual(routeService.isRouteDispatchable(missing.route), false);

  const delegated = inspect(plan({ operation: 'text_to_image', relation: 'new', prompt: '随机生成一张图' }), '随机生成一张图', {});
  assert.ok(delegated.route, delegated.reason);
  assert.strictEqual(delegated.route.needClarification, false);
  assert.strictEqual(routeService.isRouteDispatchable(delegated.route), true);
}

module.exports = [
  testCompletedImageExecutionProjectsOneDurableStateFact,
  testExplicitReferenceGenerationLineageSurvivesStorageProjection,
  testLaterCompletedChatPreventsStaleVisualInheritance,
  testClarificationDoesNotEraseLastCompletedVisualExecution,
  testFollowupCannotDowngradeCompletedGenerationToChat,
  testGenerateFollowupCannotBindPreviousResultAsEditTarget,
  testContinuationCannotDowngradeCompletedGenerationToChat,
  testBoundGeneratedImageContinuationUsesOnlyCurrentInstruction,
  testGeneratedResultReferenceRebindsAPlainGenerationContinuation,
  testBadPendingClarificationCannotEraseCompletedExecutionFamily,
  testCurrentInputTextCannotRewriteIndependentSemanticFacts,
  testExplicitIndependentChatDoesNotInheritImageExecution,
  testImageAnalysisDependencyDoesNotInheritGenerationFamily,
  testFollowupWithTargetUsesImageEditInsteadOfChat,
  testCompletedEditContinuationRebindsItsOwnResult,
  testGenerationContentReadinessRemainsASeparateGate,
];
