'use strict';

const assert = require('assert');
const routeService = require('../../client/services/route-service');

function message(index, role, content) {
  return {
    index,
    id: `message-${index}`,
    resource_id: `res:message:message-${index}`,
    role,
    content,
  };
}

function ordinalConversationContext() {
  return {
    recent_messages: [
      message(1, 'user', '你好'),
      message(2, 'assistant', '你好！有什么我可以帮你的吗？'),
      message(3, 'user', '上面消息多少字'),
      message(4, 'assistant', '不含标点：12 个字；含标点：14 个字符'),
      message(5, 'user', '第一条'),
    ],
    conversation_focus: { kind: 'text' },
  };
}

function modelPlainChat(relation = 'new') {
  return JSON.stringify({
    operation: 'plain_chat',
    relation,
    goal: '处理当前聊天请求',
    task_shape: 'single',
    resource_refs: [],
  });
}

function testShortOrdinalFollowupReceivesCompleteBoundedPriorTextWindow() {
  const payload = JSON.parse(routeService.buildRoutePayload({
    model: 'route-model',
    input: '第一条',
    context: ordinalConversationContext(),
    currentTurn: { messageIndex: 5 },
  }).input[1].content);

  assert.deepStrictEqual(
    payload.context.recent_messages.map(item => item.index),
    [1, 2, 3, 4],
    'the router must receive every prior message that fits the bounded route window',
  );
  assert.ok(
    payload.context.recent_messages.every(item => item.content !== '第一条'),
    'the current user turn must not be duplicated into its own history window',
  );
  assert.deepStrictEqual(
    payload.resource_candidates.map(item => item.candidate_key),
    ['m1', 'm2', 'm3', 'm4'],
    'message candidate keys must retain their canonical mapping after current-turn filtering',
  );
}

function testModelNewRelationIsNotCanonicalizedLocally() {
  const result = routeService.inspectModelRouteResult(modelPlainChat('new'), {
    input: '第一条',
    context: ordinalConversationContext(),
    currentTurn: { messageIndex: 5 },
  });

  assert.ok(result.route, result.error || result.reason);
  assert.strictEqual(result.route.relation, 'new');
  assert.strictEqual(result.route.dispatchContract.relation, 'new');
  assert.strictEqual(
    result.route.dispatchContract.context_policy.history,
    'none',
    'relation is an intent-model decision and must not be rewritten from local wording rules',
  );
}

function testShortImplicitQuestionReceivesPriorContextWithoutExplicitDeictic() {
  const context = {
    recent_messages: [
      message(1, 'user', '记住暗号：海盐-7391。'),
      message(2, 'assistant', '已记住。'),
      message(3, 'user', '暗号是什么'),
    ],
    conversation_focus: { kind: 'text' },
  };
  const payload = JSON.parse(routeService.buildRoutePayload({
    model: 'route-model',
    input: '暗号是什么',
    context,
    currentTurn: { messageIndex: 3 },
  }).input[1].content);

  assert.deepStrictEqual(payload.context.recent_messages.map(item => item.index), [1, 2]);
  assert.deepStrictEqual(payload.resource_candidates.map(item => item.candidate_key), ['m1', 'm2']);
}

function testVisualContinuationReceivesBoundedChatHistoryForIntentResolution() {
  const context = {
    recent_messages: [
      message(1, 'assistant', '一段与图片无关的长文字回答'),
      message(2, 'user', '再换一个场景'),
    ],
    last_generated_image: { count: 1, prompt: '旧图片提示词' },
    previous_visual_execution: { operation: 'text_to_image', image_count: 1 },
  };
  const payload = JSON.parse(routeService.buildRoutePayload({
    model: 'route-model',
    input: '再换一个场景',
    context,
    currentTurn: { messageIndex: 2 },
  }).input[1].content);

  assert.deepStrictEqual(payload.context.recent_messages.map(item => item.index), [1]);
  assert.deepStrictEqual(payload.resource_candidates.filter(item => item.type === 'message').map(item => item.candidate_key), ['m1']);
}

function testStandaloneGreetingCanRemainNew() {
  const context = {
    recent_messages: [
      message(1, 'assistant', '之前的话题'),
      message(2, 'user', '你好'),
    ],
  };
  const result = routeService.inspectModelRouteResult(modelPlainChat('new'), {
    input: '你好',
    context,
    currentTurn: { messageIndex: 2 },
  });

  assert.ok(result.route, result.error || result.reason);
  assert.strictEqual(result.route.relation, 'new');
  assert.strictEqual(result.route.dispatchContract.context_policy.history, 'none');
}

module.exports = [
  testShortOrdinalFollowupReceivesCompleteBoundedPriorTextWindow,
  testModelNewRelationIsNotCanonicalizedLocally,
  testShortImplicitQuestionReceivesPriorContextWithoutExplicitDeictic,
  testVisualContinuationReceivesBoundedChatHistoryForIntentResolution,
  testStandaloneGreetingCanRemainNew,
];
