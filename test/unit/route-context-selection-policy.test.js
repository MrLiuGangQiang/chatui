
'use strict';

const assert = require('assert');
const routeService = require('../../client/services/route-service');
const submitHelpers = require('../../client/app/submit-workflow.helpers');
const chatWorkflow = require('../../client/app/chat-workflow');
const contextBudget = require('../../shared/config/context-budget');

function message(index, role, content) {
  return {
    index,
    id: `message-${index}`,
    resource_id: `res:message:message-${index}`,
    role,
    content,
  };
}

const sessionMessages = [
  message(1, 'user', '第一条上下文'),
  message(2, 'assistant', '第二条上下文'),
  message(3, 'user', '第三条上下文'),
];

function compileIntent({ relation = 'followup', refs = [], goal = '处理当前请求', input = '继续' } = {}) {
  const result = routeService.inspectModelRouteResult(JSON.stringify({
    operation: 'plain_chat',
    relation,
    goal,
    resource_refs: refs.map(candidate_key => ({ candidate_key, role: 'context' })),
  }), {
    input,
    context: { recent_messages: sessionMessages },
  });
  assert.ok(result.route, result.error || result.reason);
  return result.route;
}

function testExactSingleMessageUsesBoundOnlyHistory() {
  const route = compileIntent({ refs: ['m2'] });
  assert.strictEqual(route.dispatchContract.context_policy.history, 'bound_only');
  assert.deepStrictEqual(route.dispatchContract.context_policy.message_resource_ids, ['res:message:message-2']);

  const projection = submitHelpers.projectRouteMessageContext(route, sessionMessages);
  assert.ok(projection);
  assert.deepStrictEqual(projection.messages.map(item => item.content), ['第二条上下文']);
}

function testExactMultipleMessagesKeepConversationOrder() {
  const route = compileIntent({ refs: ['m3', 'm1'] });
  assert.strictEqual(route.dispatchContract.context_policy.history, 'bound_only');

  const projection = submitHelpers.projectRouteMessageContext(route, sessionMessages);
  assert.ok(projection);
  assert.deepStrictEqual(
    projection.messages.map(item => item.content),
    ['第一条上下文', '第三条上下文'],
    'selected messages must be sent in original conversation order rather than model selection order',
  );
}

function testExplicitNewTaskDropsConversationHistory() {
  const route = compileIntent({ relation: 'new', refs: [], goal: '解释量子纠缠', input: '解释量子纠缠' });
  assert.strictEqual(route.dispatchContract.context_policy.history, 'none');

  const workflow = chatWorkflow.createChatWorkflow({ state: {} });
  const projected = workflow.applyExecutionContextPolicy(sessionMessages, {
    dispatchContract: route.dispatchContract,
  });
  assert.deepStrictEqual(projected, []);
}

function testUncertainFollowupKeepsConversationHistory() {
  const route = compileIntent({ relation: 'followup', refs: [], goal: '继续解释上一条回答', input: '为什么' });
  assert.strictEqual(route.dispatchContract.context_policy.history, 'conversation');

  const workflow = chatWorkflow.createChatWorkflow({ state: {} });
  const projected = workflow.applyExecutionContextPolicy(sessionMessages, {
    dispatchContract: route.dispatchContract,
  });
  assert.deepStrictEqual(projected, sessionMessages);
}

function testOutboundBudgetDropsOldestTurnsWithoutSyntheticSummary() {
  let receivedOptions = null;
  const workflow = chatWorkflow.createChatWorkflow({
    state: {},
    applyContextBudget(messages, options) {
      receivedOptions = options;
      return contextBudget.applyContextBudget(messages, { ...options, inputBudgetTokens: 70 });
    },
  });
  const outbound = [
    { role: 'system', content: '系统' },
    { role: 'user', content: `最早用户 ${'早'.repeat(30)}` },
    { role: 'assistant', content: `最早回答 ${'旧'.repeat(30)}` },
    { role: 'user', content: `较新用户 ${'新'.repeat(12)}` },
    { role: 'assistant', content: `较新回答 ${'近'.repeat(12)}` },
    { role: 'user', content: '当前问题' },
  ];

  const result = workflow.applyOutboundContextBudget(outbound, { context: { windowTokens: 4096 } });
  const text = result.map(item => String(item.content || '')).join('\n');
  assert.strictEqual(receivedOptions.summarizeOmitted, false);
  assert.ok(!text.includes('[自动上下文摘要]'));
  assert.ok(!text.includes('最早用户') && !text.includes('最早回答'), 'the oldest turn must be evicted first');
  assert.ok(text.includes('较新用户') && text.includes('较新回答') && text.includes('当前问题'));
}

module.exports = [
  testExactSingleMessageUsesBoundOnlyHistory,
  testExactMultipleMessagesKeepConversationOrder,
  testExplicitNewTaskDropsConversationHistory,
  testUncertainFollowupKeepsConversationHistory,
  testOutboundBudgetDropsOldestTurnsWithoutSyntheticSummary,
];
