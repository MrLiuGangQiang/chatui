'use strict';

const assert = require('assert');
const chatWorkflow = require('../../client/app/chat-workflow');
const prompts = require('../../client/services/route-prompts');
const { makeDispatchContract } = require('../helpers/dispatch-contract-fixture');

const sessionMessages = Object.freeze([
  { role: 'user', content: '记住暗号：海盐-7391。', id: 'message-1' },
  { role: 'assistant', content: '已记住。', id: 'message-2' },
]);

function workflowProjection(plan) {
  const workflow = chatWorkflow.createChatWorkflow({ state: {} });
  return workflow.applyExecutionContextPolicy([...sessionMessages], { dispatchContract: plan });
}

function testMisjudgedNewPlainChatStillCarriesSessionHistory() {
  const plan = makeDispatchContract({ operation: 'plain_chat', relation: 'new', prompt: '暗号是什么' });

  // relation remains the router's decision; only the plain-chat history
  // consequence changes so one misread "new" cannot wipe the conversation.
  assert.strictEqual(plan.relation, 'new');
  assert.strictEqual(plan.context_policy.history, 'conversation');
  assert.deepStrictEqual(workflowProjection(plan), sessionMessages);
}

function testNewEvidenceTaskStillDropsConversationHistory() {
  const plan = makeDispatchContract({ operation: 'web_search', relation: 'new', prompt: '查询今天的天气' });

  assert.strictEqual(plan.context_policy.history, 'none');
  assert.deepStrictEqual(workflowProjection(plan), []);
}

function testQuotedPlainChatRemainsBoundOnly() {
  const plan = makeDispatchContract({
    operation: 'plain_chat',
    relation: 'followup',
    prompt: '把这条消息压缩成一句话',
    resources: [{ type: 'message', source: 'quoted', role: 'context', id: 'msg-quote' }],
  });

  assert.strictEqual(plan.context_policy.quoted, true);
  assert.strictEqual(plan.context_policy.history, 'bound_only');
}

function testRoutePromptsBiasAmbiguousFollowupsAwayFromNew() {
  for (const [name, prompt] of [
    ['full', prompts.ROUTE_NODE_SYSTEM_PROMPT],
    ['simple', prompts.ROUTE_NODE_SYSTEM_PROMPT_SIMPLE],
  ]) {
    assert.match(
      prompt,
      /无法确定[^。]*独立新主题[^。]*不得选new，按3选followup/,
      name + ' prompt must resolve relation ambiguity as followup instead of new',
    );
  }
}

module.exports = [
  testMisjudgedNewPlainChatStillCarriesSessionHistory,
  testNewEvidenceTaskStillDropsConversationHistory,
  testQuotedPlainChatRemainsBoundOnly,
  testRoutePromptsBiasAmbiguousFollowupsAwayFromNew,
];
