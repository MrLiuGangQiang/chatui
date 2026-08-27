
'use strict';

const assert = require('assert');
const routeService = require('../../client/services/route-service');
const submitHelpers = require('../../client/app/submit-workflow.helpers');
const chatWorkflow = require('../../client/app/chat-workflow');

function sessionMessage(index, id, role, content) {
  return {
    index,
    id,
    resource_id: `res:message:${id}`,
    role,
    content,
  };
}

function quotedScenario() {
  const quotedMessage = { id: 'quote-1', role: 'assistant', content: '海盐-7391' };
  const sessionMessages = [
    sessionMessage(1, 'quote-1', 'assistant', '海盐-7391'),
    sessionMessage(2, 'question-2', 'user', '这个消息多少字'),
    sessionMessage(3, 'answer-3', 'assistant', '7 个字符'),
    sessionMessage(4, 'current-4', 'user', '这个呢'),
  ];
  const quote = submitHelpers.buildQuotedRouteContext({ quotedMessage, currentInput: '这个呢' });
  const context = submitHelpers.mergeQuotedRouteContext({ recent_messages: sessionMessages }, quote.context);
  return { quotedMessage, sessionMessages, context };
}

function testQuotedMessageAndLatestTaskReachIntentRecognitionTogether() {
  const { context } = quotedScenario();
  const payload = JSON.parse(routeService.buildRoutePayload({
    model: 'route-model',
    input: '这个呢',
    context,
    currentTurn: { messageIndex: 4 },
  }).input[1].content);

  assert.deepStrictEqual(payload.context.recent_messages.map(item => item.index), [1, 2, 3]);
  assert.strictEqual(payload.context.quoted_message.content, '海盐-7391');
  assert.ok(payload.context.recent_messages.some(item => item.content === '这个消息多少字'));
  assert.deepStrictEqual(
    payload.resource_candidates.filter(item => item.source === 'quoted').map(item => item.candidate_key),
    ['m1'],
  );
}

function testQuotedIntentContextExcludesUnrelatedSessionHistory() {
  const { quotedMessage, sessionMessages } = quotedScenario();
  const quoteContext = submitHelpers.buildQuotedRouteContext({
    quotedMessage,
    currentInput: '这个呢',
  }).context;
  const payload = JSON.parse(routeService.buildRoutePayload({
    model: 'route-model',
    input: '这个呢',
    context: quoteContext,
    currentTurn: { messageIndex: 4 },
  }).input[1].content);

  assert.deepStrictEqual(payload.context.recent_messages, [{
    index: 1,
    role: 'assistant',
    content: '海盐-7391',
  }], 'quoted submits must expose only the selected quote to intent recognition');
  assert.ok(!JSON.stringify(payload).includes(sessionMessages[1].content),
    'an unrelated session message must not influence quote intent recognition');
}

function testQuotedPlainChatKeepsRawUserInputAsProviderPrompt() {
  const { context } = quotedScenario();
  const result = routeService.inspectModelRouteResult(JSON.stringify({
    operation: 'plain_chat',
    relation: 'followup',
    goal: '统计当前引用消息的字数',
    task_shape: 'single',
    resource_refs: [{ candidate_key: 'm1', role: 'context' }],
  }), {
    input: '这个呢',
    context,
    currentTurn: { messageIndex: 4 },
  });

  assert.ok(result.route, result.error || result.reason);
  assert.strictEqual(result.route.userGoal, '统计当前引用消息的字数');
  assert.strictEqual(result.route.executionPrompt, '这个呢');
  assert.strictEqual(result.route.dispatchContract.arguments.prompt, '这个呢');
  // The explicit quote is still the selected context for a quoted reply.
  assert.strictEqual(result.route.dispatchContract.context_policy.history, 'bound_only');
  assert.strictEqual(result.route.dispatchContract.context_policy.quoted, true);
}

function testQuotedBindingAtAnyConversationIndexUsesExplicitQuoteProjection() {
  const quotedMessage = { id: 'quote-7', role: 'assistant', content: '被引用的第七条消息' };
  const messages = Array.from({ length: 8 }, (_, index) => sessionMessage(
    index + 1,
    index === 6 ? 'quote-7' : `message-${index + 1}`,
    index % 2 === 0 ? 'assistant' : 'user',
    index === 6 ? quotedMessage.content : `消息 ${index + 1}`,
  ));
  const route = {
    messageRefs: [{
      message_id: 'quote-7',
      resource_id: 'res:message:quote-7',
      index: 7,
      source: 'quoted',
    }],
  };

  const projection = submitHelpers.projectRouteMessageContext(route, messages, quotedMessage);
  assert.ok(projection);
  assert.strictEqual(projection.usesExplicitQuote, true);
  assert.deepStrictEqual(projection.messages, [quotedMessage]);
}

function testQuoteAndOtherExactMessagesAreBothPreserved() {
  const quotedMessage = { id: 'quote-2', role: 'assistant', content: '引用内容' };
  const otherMessage = { id: 'message-1', role: 'user', content: '另一条精确上下文' };
  const workflow = chatWorkflow.createChatWorkflow({ state: {} });
  const base = workflow.requestBaseMessagesForSend({
    quotedMessage,
    requestBaseMessages: [otherMessage, quotedMessage],
  }, [otherMessage, quotedMessage]);

  assert.strictEqual(base.length, 2);
  assert.strictEqual(base[0].content, '另一条精确上下文');
  assert.ok(base[1].content.includes('<quoted_message role="assistant">'));
  assert.ok(base[1].content.includes('引用内容'));
}

function testResolvedGoalIsMetadataWithoutResourceBinding() {
  const result = routeService.inspectModelRouteResult(JSON.stringify({
    operation: 'plain_chat',
    relation: 'followup',
    goal: '继续说明 Java 和 Python 在性能方面的差异。',
    task_shape: 'single',
    resource_refs: [],
  }), {
    input: '性能方面呢',
    context: {
      recent_messages: [
        { index: 1, role: 'user', content: 'Java 和 Python 有什么区别？' },
        { index: 2, role: 'assistant', content: '可以从语法、生态和性能方面比较。' },
      ],
    },
  });

  assert.ok(result.route, result.error || result.reason);
  assert.strictEqual(result.route.executionPrompt, '性能方面呢');
  assert.strictEqual(result.route.userGoal, '继续说明 Java 和 Python 在性能方面的差异。');
}

module.exports = [
  testQuotedMessageAndLatestTaskReachIntentRecognitionTogether,
  testQuotedIntentContextExcludesUnrelatedSessionHistory,
  testQuotedPlainChatKeepsRawUserInputAsProviderPrompt,
  testResolvedGoalIsMetadataWithoutResourceBinding,
  testQuotedBindingAtAnyConversationIndexUsesExplicitQuoteProjection,
  testQuoteAndOtherExactMessagesAreBothPreserved,
];
