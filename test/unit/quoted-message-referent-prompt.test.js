'use strict';

const assert = require('assert');
const chatWorkflow = require('../../client/app/chat-workflow');
const { makeExecutionFixture } = require('../helpers/dispatch-contract-fixture');

function workflow() {
  return chatWorkflow.createChatWorkflow({ state: {} });
}

function testQuotedSystemPromptStatesTheCoreReferentPrinciple() {
  const composed = workflow().composeSystemPrompt(
    { quotedMessage: { role: 'user', content: '这是什么意思' } },
    {},
    {},
  );
  assert.ok(composed.includes('用户的问题是针对这条被引用消息提出的'),
    'the prompt must state the core principle: the question is asked about the quoted message');
  assert.ok(composed.includes('以被引用消息为背景'),
    'the prompt must frame the quoted message as the background of the question');
  assert.ok(composed.includes('指代对象就是被引用消息'),
    'the prompt must close alternative interpretations of the referent');
  assert.ok(composed.includes('不要给出基于其它解释的替代答案'),
    'the prompt must forbid hedging with alternative interpretations');
  assert.ok(!/这、这个、它/.test(composed), 'the prompt must not enumerate surface pronouns');
  assert.ok(!composed.includes('字数'), 'the prompt must not special-case task types like character counts');
  assert.ok(!composed.includes('当前用户消息是执行问题'), 'the prompt must not frame the question as its own referent');
}

function testQuotedSystemPromptPrincipleAppliesWithoutSerializingDispatchContract() {
  const contract = makeExecutionFixture({ operation: 'plain_chat', prompt: '这有几个字', relation: 'followup' });
  const composed = workflow().composeSystemPrompt(
    { dispatchContract: contract.dispatchContract, quotedMessage: { role: 'user', content: '这是什么意思' } },
    {},
    {},
  );
  assert.ok(!composed.includes('<dispatch_contract>'));
  assert.ok(!composed.includes('dispatch_contract.v1'));
  assert.ok(composed.includes('以被引用消息为背景'),
    'the referent principle must remain available without serializing the internal dispatch contract');
}

function testQuotedSystemPromptPrincipleAbsentWithoutQuote() {
  const composed = workflow().composeSystemPrompt({}, {}, {});
  assert.ok(!composed.includes('被引用的消息'), 'normal chats must not carry the quoted-message rule');
}

function testNormalizeQuotedBaseMessagesKeepsQuotedContentIntact() {
  const quoted = { role: 'user', content: '这是什么意思' };
  const base = workflow().normalizeQuotedBaseMessages([quoted], quoted);
  assert.strictEqual(base.length, 1);
  const content = base[0].content;
  assert.ok(content.includes('这是什么意思'), 'the six-character quoted content must be forwarded verbatim');
  assert.ok(content.includes('<quoted_message role="user">'), 'the quoted block must be wrapped in the canonical quote marker');
  const quotedBody = content.match(/<quoted_message role="user">\n([\s\S]*?)\n<\/quoted_message>/)?.[1] || '';
  assert.strictEqual(quotedBody, '这是什么意思', 'the quoted body must contain exactly the six characters');
}

module.exports = [
  testQuotedSystemPromptStatesTheCoreReferentPrinciple,
  testQuotedSystemPromptPrincipleAppliesWithoutSerializingDispatchContract,
  testQuotedSystemPromptPrincipleAbsentWithoutQuote,
  testNormalizeQuotedBaseMessagesKeepsQuotedContentIntact,
];
