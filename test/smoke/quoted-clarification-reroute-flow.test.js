'use strict';

const assert = require('assert');

const clarificationAnswer = require('../../shared/clarification-answer');
const dispatchContract = require('../../shared/dispatch-contract');
const chatWorkflow = require('../../client/app/chat-workflow');
const imageRouteContext = require('../../client/core/image-route-context');
const routeService = require('../../client/services/route-service');
const submitHelpers = require('../../client/app/submit-workflow.helpers');

const QUOTED_CONTENT = '\u6309\u7167\u65b9\u6848\u4e09\u7684\u63cf\u8ff0\u4fee\u6539';
const QUOTED_PROMPT = '\u5c31\u662f\u4f60\u8f93\u51fa\u7684\u65b9\u6848\u4e09';
const PLAN_REPLY = [
  '\u62b1\u6b49\uff0c\u4e0a\u4e00\u5f20\u201c\u65f1\u9e2d\u5b50\u201d\u786e\u5b9e\u753b\u5f97\u6bd4\u8f83\u7b80\u5355\u3002',
  '\u65b9\u6848\u4e00\uff1a\u5927\u578b\u7ffb\u8f66\u73b0\u573a\u3002',
  '\u7ec6\u8282'.repeat(400),
  '\u65b9\u6848\u4e09\uff1a\u60b2\u58ee\u7684\u65f1\u9e2d\u5b50\u53f2\u8bd7\u3002',
].join('\\n');

function testQuotedClarificationAnswerReroutesToACompliantFinalRequest() {
  const sessionMessages = [
    { role: 'user', id: 'msg-1', content: '\u91cd\u65b0\u751f\u6210\u4e00\u7248\u66f4\u4e30\u5bcc\u7684\u65f1\u9e2d\u5b50' },
    { role: 'assistant', id: 'msg-2', content: PLAN_REPLY },
    { role: 'user', id: 'msg-3', content: '\u5e2e\u6211\u6309\u7167\u65b9\u6848\u4e09\u4fee\u6539\u4e00\u4e0b' },
    {
      role: 'assistant',
      id: 'msg-4',
      content: '[\u56fe\u7247\u751f\u6210\u5b8c\u6210]',
      kind: 'image',
      imageContext: JSON.stringify({
        mode: 'edit_image',
        prompt: PLAN_REPLY,
        routePrompt: PLAN_REPLY,
        referenceId: 'imgref-1',
        attachments: [{ id: 'img-1', src: 'blob:generated' }],
      }),
    },
    { role: 'user', id: 'msg-5', content: QUOTED_CONTENT },
    { role: 'assistant', id: 'msg-6', content: '\u4f60\u60f3\u5728\u8fd9\u5f20\u56fe\u4e0a\u4fee\u6539\u4ec0\u4e48\uff1f' },
  ];
  const baseContext = imageRouteContext.buildRouteContext({ messages: sessionMessages });
  assert.ok(
    baseContext.recent_messages.some(message => String(message.content).includes('\u65b9\u6848\u4e09')),
    'the retained window must still carry the reply that defines the numbered reference',
  );
  assert.ok(baseContext.image_candidates.length >= 1, 'the retained window must keep the editable image');

  const quotedMessage = { id: 'msg-5', messageId: 'msg-5', role: 'user', content: QUOTED_CONTENT };
  const quotedContext = submitHelpers.buildQuotedRouteContext({
    quotedMessage,
    quotedImageContext: null,
    restoredImageAttachments: [],
    quotedFileCandidates: [],
    currentInput: QUOTED_PROMPT,
    cleanQuotedContent: routeService.cleanQuotedContent,
    buildQuotedRouteContent: routeService.buildQuotedRouteContent,
  }).context;
  const slots = [{ key: 'r1', type: 'text', role: 'source', reason: 'missing', choices: [] }];
  const pending = clarificationAnswer.createPendingClarification({
    id: 'clarify-plan-reference',
    messages: [{ role: 'user', id: 'msg-5', content: QUOTED_CONTENT }],
    clarificationText: '\u201c\u65b9\u6848\u4e09\u201d\u7684\u5177\u4f53\u5185\u5bb9\u662f\u4ec0\u4e48\uff1f',
    routeInfo: {
      operationType: 'plain_chat',
      relation: 'followup',
      clarificationSlots: slots,
      resources: [{ type: 'image', role: 'target', id: 'img-1', resource_id: 'res:image:img-1', source: 'history', index: 1 }],
    },
  });
  const answer = clarificationAnswer.parseClarificationAnswer(QUOTED_PROMPT, {
    clarificationId: pending.id,
    slots,
  });
  const applied = clarificationAnswer.applyPendingClarificationAnswer(pending, answer);
  assert.strictEqual(applied.complete, true, 'the free-text answer must resolve the text clarification');

  const routeContext = clarificationAnswer.buildClarificationRouteContext({
    baseContext,
    quotedContext,
    pending: applied.pending,
  });
  assert.ok(routeContext.quoted_message, 'the reroute context must carry the quote');
  assert.ok(
    routeContext.recent_messages.some(message => String(message.content).includes('\u65b9\u6848\u4e09')),
    'the reroute context must keep the numbered referent',
  );
  const anchor = routeContext.recent_messages.find(message => (
    Number(message.index) === Number(routeContext.quoted_message.index)
  ));
  assert.ok(anchor && String(anchor.content).includes(QUOTED_CONTENT),
    'the quoted anchor must point at the referenced message inside the retained window');

  const plan = routeService.compileLocalRoute({
    operation: 'plain_chat',
    relation: 'followup',
    arguments: { prompt: QUOTED_PROMPT },
    bindings: [],
    constraints: [],
  }, {
    input: QUOTED_PROMPT,
    attachments: [],
    context: routeContext,
    skipLocalRouteGates: true,
  });
  assert.ok(plan && plan.dispatchContract, 'the reroute must compile an executable contract');
  assert.strictEqual(plan.dispatchContract.context_policy.quoted, true,
    'a chat turn that keeps the quote must authorize it in the execution plan');
  assert.strictEqual(plan.dispatchContract.context_policy.history, 'bound_only');

  const workflow = chatWorkflow.createChatWorkflow({ state: {} });
  const baseMessages = sessionMessages.map(message => ({
    role: message.role,
    content: message.content,
    id: message.id,
    messageId: message.id,
  }));
  const withQuote = workflow.normalizeQuotedBaseMessages(baseMessages, quotedMessage);
  const evidence = plan.dispatchContract.bindings.map(binding => ({ ...binding }));
  const bounded = workflow.applyExecutionContextPolicy(withQuote, {
    dispatchContract: plan.dispatchContract,
    bindingEvidence: evidence,
  });
  const payload = {
    model: 'chat-model',
    messages: [
      ...bounded.map(message => ({ role: message.role, content: message.content })),
      { role: 'user', content: QUOTED_PROMPT },
    ],
  };
  assert.strictEqual(
    payload.messages.filter(message => String(message.content).includes('<quoted_message')).length,
    1,
    'the final request must carry exactly the quoted block the plan authorized',
  );
  assert.strictEqual(dispatchContract.assertPayloadMatchesDispatchContract(plan.dispatchContract, {
    payload,
    transportApi: 'chat',
    bindingEvidence: evidence,
    enforceContextPolicy: true,
  }), true, 'the final request must pass the server-side contract check');
}

module.exports = [
  testQuotedClarificationAnswerReroutesToACompliantFinalRequest,
];
