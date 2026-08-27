'use strict';

const assert = require('assert');
const imageRouteContext = require('../../client/core/image-route-context');
const routeService = require('../../client/services/route-service');

function intent(overrides = {}) {
  const operation = String(overrides.operation || 'image_reference_gen');
  return {
    operation,
    relation: String(overrides.relation || 'followup'),
    goal: String(overrides.goal || '执行模型已解析的当前任务。'),
    task_shape: String(overrides.taskShape || 'single'),
    resource_refs: Array.isArray(overrides.resourceRefs) ? overrides.resourceRefs : [],
  };
}

function visualTask(goal = '基于所选图片生成一个更复杂的版本。') {
  return intent({
    operation: 'image_reference_gen',
    goal,
    resourceRefs: [{ candidate_key: 'i1', role: 'reference' }],
  });
}

function markdownAfterImageContext() {
  const messages = [
    { role: 'user', content: '生成一辆红色跑车。' },
    {
      role: 'assistant',
      content: '[图片生成完成] 生成一辆红色跑车。',
      kind: 'image',
      imageContext: { mode: 'image', referenceId: 'imgref-car-result' },
    },
    { role: 'user', content: '输出一个md' },
    {
      role: 'assistant',
      content: '# Markdown 示例\n\n这是一个 **Markdown** 文档。\n\n- 条目一\n- 条目二',
    },
  ];
  const recentImageReferences = [{
    reference_id: 'imgref-car-result',
    target: 'previous',
    source: 'history',
    message_index: 2,
    prompt: '生成一辆红色跑车。',
    candidates: [{
      image_id: 'img-car-result',
      resource_id: 'res:image:img-car-result',
      filename: 'car.png',
      description: '一辆红色跑车',
    }],
  }];
  return imageRouteContext.buildRouteContext({
    messages,
    recentImageReferences,
    lastGeneratedImage: {
      reference_id: 'imgref-car-result',
      prompt: '生成一辆红色跑车。',
      count: 1,
    },
    latestImageReference: {
      reference_id: 'imgref-car-result',
      target: 'previous',
      reason: 'last-generated-image',
      selection: 'all',
      count: 1,
      use_previous_image: true,
    },
  });
}

function inspect(value, input, context) {
  return routeService.inspectModelRouteResult(JSON.stringify(value), {
    input,
    attachments: [],
    context,
  });
}

function ambiguousSubjectContext() {
  const context = markdownAfterImageContext();
  context.conversation_focus = {
    schema_version: 'conversation_focus.v1',
    kind: 'ambiguous',
    text_format: 'markdown',
    source_message_index: 4,
    text_message_index: 4,
    image_message_index: 4,
    priority_coefficient: 1,
    priority_age_turns: 0,
  };
  return context;
}

function selectedSubjectContext(subject, clarificationId) {
  return {
    ...ambiguousSubjectContext(),
    clarification_context: {
      schema_version: 'clarification_context.v4',
      base_task: '要复杂一点',
      clarification_question: '你想让哪一个更复杂？',
      operation: 'image_reference_gen',
      relation: 'followup',
      unresolved_resources: [],
      pending_task: { base_input: '要复杂一点', id: clarificationId, supplements: [] },
      selected_choices: [],
      selected_parameters: { followup_subject: subject },
      selected_resources: [],
      answer_complete: true,
    },
  };
}

function assertReadyVisualRoute(route, goal) {
  assert.strictEqual(route.operationType, 'image_reference_gen');
  assert.strictEqual(route.api, 'image_edit');
  assert.strictEqual(route.readiness, 'ready');
  assert.strictEqual(route.dispatchAuthorized, true);
  assert.strictEqual(route.needClarification, false);
  assert.deepStrictEqual(route.imageRefs.map(ref => ref.image_id), ['img-car-result']);
  assert.strictEqual(route.dispatchContract.arguments.prompt, goal);
}

function testConversationFocusIsPublishedAsEvidenceOnly() {
  const context = markdownAfterImageContext();
  assert.strictEqual(context.conversation_focus.kind, 'text');
  assert.strictEqual(context.previous_execution, null);

  const payload = routeService.buildRoutePayload({
    model: 'route-model', input: '要复杂一点', attachments: [], context,
  });
  const publicInput = JSON.parse(payload.input[1].content);
  assert.strictEqual(publicInput.context.conversation_focus.kind, 'text');
  assert.strictEqual(publicInput.context.last_generated_image.count, 1);
}

function testModelVisualTaskIsNotOverriddenByNewerMarkdownFocus() {
  const goal = '基于所选跑车图片生成一个更复杂的版本。';
  const inspected = inspect(visualTask(goal), '要复杂一点', markdownAfterImageContext());
  assert.ok(inspected.route, `${inspected.reason}: ${inspected.error || ''}`);
  assertReadyVisualRoute(inspected.route, goal);
}

function testLocalTextWordingCannotRewriteTheModelVisualTask() {
  const context = markdownAfterImageContext();
  for (const input of [
    '让它更具叙事纵深',
    '改成分层论证，并加入反例和结论',
    'make it denser and more nuanced',
    '让上一段 Markdown 更复杂一点',
  ]) {
    const goal = `基于所选跑车图片执行：${input}`;
    const inspected = inspect(visualTask(goal), input, context);
    assert.ok(inspected.route, `${input}: ${inspected.reason}`);
    assertReadyVisualRoute(inspected.route, goal);
  }
}

function testAmbiguousLocalFocusDoesNotCreateASecondSemanticDecision() {
  const goal = '基于所选跑车图片生成一个更复杂的版本。';
  const inspected = inspect(visualTask(goal), '要复杂一点', ambiguousSubjectContext());
  assert.ok(inspected.route, inspected.reason);
  assertReadyVisualRoute(inspected.route, goal);
}

function testClarificationSubjectMetadataCannotOverrideModelVisualTask() {
  const goal = '基于所选跑车图片继续生成。';
  const inspected = inspect(
    visualTask(goal),
    '已选择：要调整的对象：上一段 Markdown 输出',
    selectedSubjectContext('text', 'clar-subject-text'),
  );
  assert.ok(inspected.route, inspected.reason);
  assertReadyVisualRoute(inspected.route, goal);
}

function testClarificationSubjectMetadataCannotOverrideModelPlainChat() {
  const inspected = inspect(
    intent({ operation: 'plain_chat', goal: '继续修改上一段 Markdown 文本。' }),
    '已选择：要调整的对象：上一张图片',
    selectedSubjectContext('image', 'clar-subject-image'),
  );
  assert.ok(inspected.route, inspected.reason);
  assert.strictEqual(inspected.route.operationType, 'plain_chat');
  assert.strictEqual(inspected.route.api, 'chat');
  assert.strictEqual(inspected.route.readiness, 'ready');
  assert.deepStrictEqual(inspected.route.imageRefs, []);
}

function testExplicitNewImageRequestRemainsModelDirected() {
  const context = markdownAfterImageContext();
  const input = '生成一张更复杂的赛博朋克城市插画';
  const inspected = inspect(intent({ operation: 'text_to_image', relation: 'new', goal: input }), input, context);
  assert.ok(inspected.route, inspected.reason);
  assert.strictEqual(inspected.route.operationType, 'text_to_image');
  assert.strictEqual(inspected.route.readiness, 'ready');
  assert.strictEqual(inspected.route.dispatchAuthorized, true);
  assert.strictEqual(inspected.route.api, 'image_generation');
}

function testPromptDeclaresContextAsEvidence() {
  assert.match(routeService.ROUTE_SYSTEM_PROMPT, /resource_candidates.*context.*事实/);
  assert.match(routeService.ROUTE_SYSTEM_PROMPT, /任一ref的source≠current[^。]*绝不new/);
  assert.match(routeService.ROUTE_SYSTEM_PROMPT, /资源选择[^。\n]*operation[^。\n]*必需角色/);
  assert.match(routeService.ROUTE_SYSTEM_PROMPT, /各角色按P1→P5/);
  assert.ok(routeService.ROUTE_SYSTEM_PROMPT.length <= 5600);
}

module.exports = [
  testConversationFocusIsPublishedAsEvidenceOnly,
  testModelVisualTaskIsNotOverriddenByNewerMarkdownFocus,
  testLocalTextWordingCannotRewriteTheModelVisualTask,
  testAmbiguousLocalFocusDoesNotCreateASecondSemanticDecision,
  testClarificationSubjectMetadataCannotOverrideModelVisualTask,
  testClarificationSubjectMetadataCannotOverrideModelPlainChat,
  testExplicitNewImageRequestRemainsModelDirected,
  testPromptDeclaresContextAsEvidence,
];
