'use strict';

const assert = require('assert');
const chatWorkflow = require('../../client/app/chat-workflow');

function workflow() {
  return chatWorkflow.createChatWorkflow({ state: {} });
}

function testDefaultChatPolicyConstrainsMissingPersonalizationAndNarrowing() {
  const instance = workflow();
  const prompt = instance.composeSystemPrompt({ input: '帮我制定一个适合我的计划。' }, {}, {});
  assert.ok(prompt.includes('缺少会显著影响适用性或安全性的关键条件时，先只询问最少必要信息'));
  assert.ok(prompt.includes('只输出筛选后保留的内容'));
  assert.ok(prompt.includes('把上一条答案当作唯一候选集合'));
  assert.ok(!prompt.includes('负责人、责任人、审批人、值守、值班、观察窗口'),
    'the general chat policy must not inject release-operations rules into unrelated chats');
  assert.strictEqual(prompt, instance.defaultChatOutputPolicy);
  assert.strictEqual(instance.composeSystemPrompt({}, {}, {}), '',
    'ordinary chats should not pay the extra output-boundary prompt cost');
}

function testExplicitlyClearedSessionPromptSuppressesDefaultPolicy() {
  const prompt = workflow().composeSystemPrompt({ input: '只保留最重要的 P0 项。' }, {
    hasSystemPromptOverride: true,
    systemPrompt: '',
  }, {});
  assert.strictEqual(prompt, '');
}

function testExplicitSystemPromptDoesNotGetSilentlyReplaced() {
  const prompt = workflow().composeSystemPrompt({}, {
    hasSystemPromptOverride: true,
    systemPrompt: '请用团队内部术语回答。',
  }, {});
  assert.strictEqual(prompt, '请用团队内部术语回答。');
  assert.ok(!prompt.includes('只输出筛选后保留的内容'));
}

module.exports = [
  testDefaultChatPolicyConstrainsMissingPersonalizationAndNarrowing,
  testExplicitSystemPromptDoesNotGetSilentlyReplaced,
  testExplicitlyClearedSessionPromptSuppressesDefaultPolicy,
];
