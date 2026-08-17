'use strict';

const assert = require('assert');
const routeService = require('../../client/services/route-service');

const INPUT = '基于这个描述再生成一张图片。';
const DESC_CN = '一位年轻优雅的中国女性，精致自然的五官，温柔自信的微笑，乌黑柔顺的长发，白皙细腻的肌肤。';
const DESC_US = '一位成年美国女性的时尚肖像，纽约街头背景，自然微卷的栗色长发，明亮自信的微笑。';

const baseContext = {
  recent_messages: [
    { index: 1, id: 'message-1', resource_id: 'res:message:message-1', role: 'assistant', content: DESC_CN },
    { index: 2, id: 'message-2', resource_id: 'res:message:message-2', role: 'assistant', content: DESC_US },
  ],
};

function textToImageIntent({ goal = INPUT, messageKeys = [], relation = 'followup' } = {}) {
  return {
    operation: 'text_to_image',
    relation,
    goal,
    task_shape: 'single',
    resource_refs: messageKeys.map(candidateKey => ({ candidate_key: candidateKey, role: 'context' })),
  };
}

function inspect(intent, input = INPUT, context = baseContext) {
  const result = routeService.inspectModelRouteResult(JSON.stringify(intent), {
    input,
    attachments: [],
    context,
  });
  assert.ok(result.route, `route compilation failed: ${result.reason} ${result.error || ''}`);
  return result.route;
}

function assertPromptRetainsGoal(prompt, goal, message = 'prompt must retain the model-resolved goal') {
  assert.ok(String(prompt || '').endsWith(String(goal || '')), message);
}

function testIndependentGenerationWithoutRefsUsesSelfContainedImageGoal() {
  const input = '基于这个生成图片';
  const goal = '生成一幅超写实野生动物摄影作品：一只成年非洲草原象独自伫立在金色稀树草原中央，夕阳侧后方的暖光勾勒耳缘、象牙、粗粝褶皱皮肤与扬起的尘埃，电影级构图。';
  const route = inspect(textToImageIntent({
    goal,
    messageKeys: [],
    relation: 'new',
  }), input, {
    recent_messages: [],
    image_candidates: [],
    file_candidates: [],
  });
  assert.strictEqual(route.needClarification, false);
  assertPromptRetainsGoal(route.executionPrompt, goal, 'execution prompt must retain the self-contained image goal');
  assertPromptRetainsGoal(route.contextualImagePrompt, goal, 'contextual prompt must retain the self-contained image goal');
  assertPromptRetainsGoal(route.dispatchContract.arguments.prompt, goal, 'dispatch prompt must retain the self-contained image goal');
  assert.notStrictEqual(route.dispatchContract.arguments.prompt, input);
}

function testFollowupWithoutRefsUsesTheResolvedImageGoal() {
  const input = '基于这个生成图片';
  const goal = '生成一张超写实野生动物摄影风格的图片：一只威严的尼罗鳄趴伏在热带沼泽的浅水边，粗糙厚重的深绿色鳞甲、锋利的牙齿和琥珀色眼睛清晰可见，阳光穿过茂密的棕榈叶洒在它的背部，水面有细微波纹与倒影，周围环绕湿润泥土、芦苇和热带植物，低机位特写，电影级光影，细节丰富，8K，高对比度，真实质感，浅景深。避免卡通、动漫、插画、模糊、低清晰度、畸形、额外肢体、多头、错误牙齿、塑料质感、过度饱和、文字、水印、边框、人类和血腥画面。';
  const route = inspect(textToImageIntent({ goal, relation: 'followup' }), input, {
    recent_messages: [],
    image_candidates: [],
    file_candidates: [],
  });

  assert.strictEqual(route.needClarification, false);
  assertPromptRetainsGoal(route.executionPrompt, goal, 'execution prompt must retain the self-contained image goal');
  assertPromptRetainsGoal(route.contextualImagePrompt, goal, 'contextual prompt must retain the self-contained image goal');
  assertPromptRetainsGoal(route.dispatchContract.arguments.prompt, goal, 'dispatch prompt must retain the self-contained image goal');
  assert.notStrictEqual(route.dispatchContract.arguments.prompt, input);
}

function testReferencedMessageUsesTheModelsSelfContainedGoal() {
  const goal = `${DESC_CN}\n\n生成一张符合该描述的人像图片。`;
  const route = inspect(textToImageIntent({ goal, messageKeys: ['m1'] }));
  assert.strictEqual(route.needClarification, false);
  assertPromptRetainsGoal(route.contextualImagePrompt, goal, 'contextual prompt must retain the self-contained image goal');
  assertPromptRetainsGoal(route.dispatchContract.arguments.prompt, goal,
    'the selected message goal must survive semantic prompt assembly');
  assert.deepStrictEqual({ ...route.dispatchContract.arguments, prompt: goal }, {
    prompt: goal,
    size: 'auto',
    quality: 'auto',
    background: 'auto',
    output_format: 'auto',
    count: 1,
  });
  assert.deepStrictEqual(route.dispatchContract.bindings.map(binding => ({
    type: binding.type,
    role: binding.role,
    resource_id: binding.resource_id,
  })), [{
    type: 'message', role: 'context', resource_id: 'res:message:message-1',
  }]);
}

function testOmittedHistoricalReferenceIsNotRecoveredLocally() {
  const input = '基于历史中的提示词给我生成一个图片';
  const route = inspect(textToImageIntent({ goal: input, messageKeys: [] }), input);
  assert.strictEqual(route.needClarification, false);
  assert.deepStrictEqual(route.resources, []);
  assertPromptRetainsGoal(route.dispatchContract.arguments.prompt, input, 'dispatch prompt must retain the input when the model explicitly selects it as the goal');
}

function testMultipleModelSelectedMessagesAreProjectedWithoutLocalChoiceLogic() {
  const goal = '综合所选两条描述，生成一张新图片。';
  const route = inspect(textToImageIntent({ goal, messageKeys: ['m1', 'm2'] }));
  assert.strictEqual(route.needClarification, false);
  assert.deepStrictEqual(route.executionResources.messages.map(resource => resource.id), ['message-1', 'message-2']);
  assertPromptRetainsGoal(route.dispatchContract.arguments.prompt, goal, 'dispatch prompt must retain the self-contained image goal');
}

function testUnknownMessageCandidateFailsClosed() {
  const route = inspect(textToImageIntent({
    goal: '根据所选历史描述生成图片。',
    messageKeys: ['m9'],
  }));
  assert.strictEqual(route.needClarification, true);
  assert.strictEqual(route.dispatchAuthorized, false);
  assert.strictEqual(route.dispatchContract, null);
}

function testChatOperationWithMessageRefAlsoUsesResolvedGoal() {
  const goal = '将所选历史描述改写得更简洁。';
  const result = routeService.inspectModelRouteResult(JSON.stringify({
    operation: 'plain_chat',
    relation: 'followup',
    goal,
    task_shape: 'single',
    resource_refs: [{ candidate_key: 'm1', role: 'context' }],
  }), {
    input: '简洁一点',
    attachments: [],
    context: baseContext,
  });
  assert.ok(result.route, result.error || result.reason);
  assert.match(result.route.dispatchContract.arguments.prompt, /^\[execution_semantic_context\.v1\]/);
  assert.ok(result.route.dispatchContract.arguments.prompt.includes('简洁一点'));
  assert.ok(result.route.dispatchContract.arguments.prompt.includes(goal));
  assert.deepStrictEqual(result.route.executionResources.messages.map(resource => resource.id), ['message-1']);
}

function testRoutePromptDeclaresResolvedGoalAndUnifiedMessageRefs() {
  assert.ok(routeService.ROUTE_SYSTEM_PROMPT.includes('1 operation → 2 task_shape → 3 resource_refs → 4 relation → 5 goal → 6 goal_mode'));
  assert.match(routeService.ROUTE_SYSTEM_PROMPT, /resource_refs[^。\n]*只绑[^。\n]*必需[^。\n]*最少[^。\n]*明确/);
  assert.match(routeService.ROUTE_SYSTEM_PROMPT, /goal是资源消解[、\/]历史依赖[、\/]图片任务的下游执行指令/);
  assert.match(routeService.ROUTE_SYSTEM_PROMPT, /edit_image的amend goal同时就是发给目标图的本轮编辑指令/);
  assert.match(routeService.ROUTE_SYSTEM_PROMPT, /reference\s*主体\/构图(?:参考)?/);
  assert.match(routeService.ROUTE_SYSTEM_PROMPT, /style_reference\s*画风\/配色(?:参考)?/);
}

function testStructuredReferenceSchemaIsStrictProviderCompatible() {
  const schema = routeService.ROUTE_INTENT_RESPONSE_FORMAT.json_schema.schema;
  assert.deepStrictEqual(schema.required, ['operation', 'relation', 'goal', 'goal_mode', 'resource_refs', 'task_shape']);
  assert.strictEqual(schema.properties.schema_version, undefined);
  assert.strictEqual(schema.properties.referenced_context, undefined);
  assert.deepStrictEqual(schema.properties.resource_refs.items.required, ['candidate_key', 'role']);
  assert.deepStrictEqual(schema.properties.resource_refs.items.properties.candidate_key.pattern, '^[ifm][1-9]\\d*$');
}

module.exports = [
  testIndependentGenerationWithoutRefsUsesSelfContainedImageGoal,
  testFollowupWithoutRefsUsesTheResolvedImageGoal,
  testReferencedMessageUsesTheModelsSelfContainedGoal,
  testOmittedHistoricalReferenceIsNotRecoveredLocally,
  testMultipleModelSelectedMessagesAreProjectedWithoutLocalChoiceLogic,
  testUnknownMessageCandidateFailsClosed,
  testChatOperationWithMessageRefAlsoUsesResolvedGoal,
  testRoutePromptDeclaresResolvedGoalAndUnifiedMessageRefs,
  testStructuredReferenceSchemaIsStrictProviderCompatible,
];
