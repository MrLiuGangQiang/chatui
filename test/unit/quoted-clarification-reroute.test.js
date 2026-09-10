'use strict';

const assert = require('assert');

const clarificationAnswer = require('../../shared/clarification-answer');
const dispatchContract = require('../../shared/dispatch-contract');
const imageRouteContext = require('../../client/core/image-route-context');
const routeService = require('../../client/services/route-service');
const submitHelpers = require('../../client/app/submit-workflow.helpers');

const QUOTED_CONTENT = '\u6309\u7167\u65b9\u6848\u4e09\u7684\u63cf\u8ff0\u4fee\u6539';
const QUOTED_PROMPT = '\u5c31\u662f\u4f60\u8f93\u51fa\u7684\u65b9\u6848\u4e09';
const PLAN_REPLY = [
  '\u62b1\u6b49\uff0c\u4e0a\u4e00\u5f20\u201c\u65f1\u9e2d\u5b50\u201d\u786e\u5b9e\u753b\u5f97\u6bd4\u8f83\u7b80\u5355\u3002',
  '\u65b9\u6848\u4e00\uff1a\u5927\u578b\u201c\u7ffb\u8f66\u201d\u73b0\u573a\uff08\u641e\u7b11\u7ec6\u8282\u62c9\u6ee1\uff09\u3002',
  '\u7ec6\u8282'.repeat(400),
  '\u65b9\u6848\u4e09\uff1a\u60b2\u58ee\u7684\u201c\u65f1\u9e2d\u5b50\u201d\u53f2\u8bd7\uff08\u620f\u5267\u5316\uff09\u3002',
].join('\\n');

function pendingTextClarification() {
  const slots = [{ key: 'r1', type: 'text', role: 'source', reason: 'missing', choices: [] }];
  return {
    slots,
    pending: clarificationAnswer.createPendingClarification({
      id: 'clarify-plan-reference',
      messages: [{ role: 'user', id: 'msg-5', content: QUOTED_CONTENT }],
      clarificationText: '\u201c\u65b9\u6848\u4e09\u201d\u7684\u5177\u4f53\u5185\u5bb9\u662f\u4ec0\u4e48\uff1f\u8bf7\u63cf\u8ff0\u9700\u8981\u5728\u8fd9\u5f20\u56fe\u4e0a\u4fee\u6539\u6210\u4ec0\u4e48\u6837\u3002',
      routeInfo: { operationType: 'edit_image', relation: 'followup', clarificationSlots: slots },
    }),
  };
}

function resolvedClarification() {
  const { slots, pending } = pendingTextClarification();
  const answer = clarificationAnswer.parseClarificationAnswer(QUOTED_PROMPT, {
    clarificationId: pending.id,
    slots,
  });
  return clarificationAnswer.applyPendingClarificationAnswer(pending, answer);
}

function buildQuotedRouteContext() {
  return submitHelpers.buildQuotedRouteContext({
    quotedMessage: { id: 'msg-5', messageId: 'msg-5', role: 'user', content: QUOTED_CONTENT },
    quotedImageContext: null,
    restoredImageAttachments: [],
    quotedFileCandidates: [],
    currentInput: QUOTED_PROMPT,
    cleanQuotedContent: routeService.cleanQuotedContent,
    buildQuotedRouteContent: routeService.buildQuotedRouteContent,
  }).context;
}

function testNumberedPlanReferentStaysVisibleInTheRouteWindow() {
  const messages = [
    { role: 'user', id: 'msg-1', content: '\u91cd\u65b0\u751f\u6210\u4e00\u7248\u66f4\u4e30\u5bcc\u7684\u65f1\u9e2d\u5b50' },
    { role: 'assistant', id: 'msg-2', content: PLAN_REPLY },
    { role: 'user', id: 'msg-3', content: '\u5e2e\u6211\u6309\u7167\u65b9\u6848\u4e09\u4fee\u6539\u4e00\u4e0b' },
    { role: 'assistant', id: 'msg-4', content: '[\u56fe\u7247\u6d88\u606f]' },
    { role: 'user', id: 'msg-5', content: QUOTED_CONTENT },
    { role: 'assistant', id: 'msg-6', content: '\u4f60\u60f3\u5728\u8fd9\u5f20\u56fe\u4e0a\u4fee\u6539\u4ec0\u4e48\uff1f' },
    { role: 'user', id: 'msg-7', content: '\u6309\u7167\u65b9\u6848\u4e09\u7684\u63cf\u8ff0\u4fee\u6539' },
  ];
  const context = imageRouteContext.buildRouteContext({ messages });
  const planMessage = context.recent_messages.find(message => message.id === 'msg-2');
  assert.ok(planMessage, 'the assistant plan reply must stay in the route window');
  assert.ok(planMessage.content.length > 800,
    'a long-form plan reply must not be cut to the legacy excerpt budget');
  assert.ok(planMessage.content.includes('\u65b9\u6848\u4e09'),
    'the numbered referent must survive route-context excerpting');
}

function testClarificationRerouteAnchorsQuoteWithoutDroppingHistory() {
  const applied = resolvedClarification();
  assert.strictEqual(applied.complete, true, 'the free-text answer must resolve the text slot');
  const context = clarificationAnswer.buildClarificationRouteContext({
    baseContext: {
      recent_messages: [
        { index: 1, role: 'assistant', id: 'msg-2', content: PLAN_REPLY },
        { index: 2, role: 'user', id: 'msg-5', content: QUOTED_CONTENT },
      ],
      image_candidates: [],
      file_candidates: [],
    },
    quotedContext: buildQuotedRouteContext(),
    pending: applied.pending,
  });
  assert.ok(context.quoted_message, 'the quote must survive the clarification reroute');
  assert.strictEqual(Number(context.quoted_message.index), 2,
    'the quoted anchor must realign to the referenced message inside the retained window');
  const anchored = context.recent_messages.find(message => Number(message.index) === 2);
  assert.ok(anchored && String(anchored.content).includes(QUOTED_CONTENT),
    'the anchor must point at the referenced message');
  assert.ok(context.recent_messages.some(message => String(message.content).includes('\u65b9\u6848\u4e09')),
    'the assistant reply that defines the numbered reference must be retained');
}

function testQuotedPlanAuthorizesTheQuotedBlockAndRejectsUnplannedQuotes() {
  const binding = { key: 'r1', type: 'message', role: 'context', resource_id: 'res:message:msg-5', source: 'quoted' };
  const authorized = dispatchContract.compileDispatchContract({
    operation: 'plain_chat',
    relation: 'followup',
    input: QUOTED_PROMPT,
    prompt: QUOTED_PROMPT,
    bindings: [binding],
  });
  assert.strictEqual(authorized.context_policy.quoted, true);
  assert.strictEqual(authorized.context_policy.history, 'bound_only');
  const payload = {
    model: 'chat-model',
    messages: [
      { role: 'user', content: `<quoted_message role="user">\n${QUOTED_CONTENT}\n</quoted_message>` },
      { role: 'user', content: QUOTED_PROMPT },
    ],
  };
  assert.strictEqual(dispatchContract.assertPayloadMatchesDispatchContract(authorized, {
    payload,
    transportApi: 'chat',
    bindingEvidence: [{ ...binding }],
    enforceContextPolicy: true,
  }), true);

  const unauthorized = dispatchContract.compileDispatchContract({
    operation: 'plain_chat',
    relation: 'followup',
    input: QUOTED_PROMPT,
    prompt: QUOTED_PROMPT,
    bindings: [],
  });
  assert.throws(
    () => dispatchContract.assertPayloadMatchesDispatchContract(unauthorized, {
      payload,
      transportApi: 'chat',
      bindingEvidence: [],
      enforceContextPolicy: true,
    }),
    error => error?.code === 'EXECUTION_CONTEXT_QUOTE_MISMATCH',
    'an unplanned quoted block must still be rejected fail-closed',
  );
}

module.exports = [
  testNumberedPlanReferentStaysVisibleInTheRouteWindow,
  testClarificationRerouteAnchorsQuoteWithoutDroppingHistory,
  testQuotedPlanAuthorizesTheQuotedBlockAndRejectsUnplannedQuotes,
];
