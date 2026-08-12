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

function testIndependentGenerationWithoutRefsUsesOriginalInput() {
  const route = inspect(textToImageIntent({
    goal: '模型改写但没有资源消解依据。',
    messageKeys: [],
    relation: 'new',
  }));
  assert.strictEqual(route.needClarification, false);
  assert.strictEqual(route.contextualImagePrompt, INPUT);
  assert.strictEqual(route.dispatchContract.arguments.prompt, INPUT);
}

function testReferencedMessageUsesTheModelsSelfContainedGoal() {
  const goal = `${DESC_CN}\n\n生成一张符合该描述的人像图片。`;
  const route = inspect(textToImageIntent({ goal, messageKeys: ['m1'] }));
  assert.strictEqual(route.needClarification, false);
  assert.strictEqual(route.contextualImagePrompt, goal);
  assert.deepStrictEqual(route.dispatchContract.arguments, {
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
  assert.strictEqual(route.dispatchContract.arguments.prompt, input);
}

function testMultipleModelSelectedMessagesAreProjectedWithoutLocalChoiceLogic() {
  const goal = '综合所选两条描述，生成一张新图片。';
  const route = inspect(textToImageIntent({ goal, messageKeys: ['m1', 'm2'] }));
  assert.strictEqual(route.needClarification, false);
  assert.deepStrictEqual(route.executionResources.messages.map(resource => resource.id), ['message-1', 'message-2']);
  assert.strictEqual(route.dispatchContract.arguments.prompt, goal);
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
    resource_refs: [{ candidate_key: 'm1', role: 'context' }],
  }), {
    input: '简洁一点',
    attachments: [],
    context: baseContext,
  });
  assert.ok(result.route, result.error || result.reason);
  assert.strictEqual(result.route.dispatchContract.arguments.prompt, goal);
  assert.deepStrictEqual(result.route.executionResources.messages.map(resource => resource.id), ['message-1']);
}

function testRoutePromptDeclaresResolvedGoalAndUnifiedMessageRefs() {
  assert.ok(routeService.ROUTE_SYSTEM_PROMPT.includes('判断顺序 operation→relation→resource_refs→goal'));
  assert.ok(routeService.ROUTE_SYSTEM_PROMPT.includes('resource_refs 只绑必需、最少资源'));
  assert.ok(routeService.ROUTE_SYSTEM_PROMPT.includes('goal 是下游执行模型唯一任务指令'));
  assert.ok(routeService.ROUTE_SYSTEM_PROMPT.includes('正例"将目标图中的猫改为白色，保留构图不变。"'));
  assert.ok(routeService.ROUTE_SYSTEM_PROMPT.includes('reference 主体/构图参考'));
  assert.ok(routeService.ROUTE_SYSTEM_PROMPT.includes('style_reference 画风/配色参考'));
}

function testStructuredReferenceSchemaIsStrictProviderCompatible() {
  const schema = routeService.ROUTE_INTENT_RESPONSE_FORMAT.json_schema.schema;
  assert.deepStrictEqual(schema.required, ['operation', 'relation', 'goal', 'resource_refs']);
  assert.strictEqual(schema.properties.schema_version, undefined);
  assert.strictEqual(schema.properties.referenced_context, undefined);
  assert.deepStrictEqual(schema.properties.resource_refs.items.required, ['candidate_key', 'role']);
  assert.deepStrictEqual(schema.properties.resource_refs.items.properties.candidate_key.pattern, '^[ifm][1-9]\\d*$');
}

module.exports = [
  testIndependentGenerationWithoutRefsUsesOriginalInput,
  testReferencedMessageUsesTheModelsSelfContainedGoal,
  testOmittedHistoricalReferenceIsNotRecoveredLocally,
  testMultipleModelSelectedMessagesAreProjectedWithoutLocalChoiceLogic,
  testUnknownMessageCandidateFailsClosed,
  testChatOperationWithMessageRefAlsoUsesResolvedGoal,
  testRoutePromptDeclaresResolvedGoalAndUnifiedMessageRefs,
  testStructuredReferenceSchemaIsStrictProviderCompatible,
];
