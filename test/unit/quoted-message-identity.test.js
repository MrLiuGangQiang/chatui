'use strict';

const assert = require('assert');
const routeService = require('../../client/services/route-service');
const submitHelpers = require('../../client/app/submit-workflow.helpers');
const messageWorkflow = require('../../client/app/message-workflow');

const isImageFile = item => String(item?.type || '').startsWith('image/');

function messageState(messages) {
  return {
    activeSessionId: 'session-a',
    sessions: [{ id: 'session-a', messages, display: [] }],
    messages,
  };
}

function userNode(messageIndex, rawText) {
  return {
    dataset: { messageIndex: String(messageIndex), rawText },
    classList: { contains: cls => cls === 'user' },
    __displayItem: null,
  };
}

function assistantNode(responseIndex, rawText, displayItemId) {
  return {
    dataset: { responseIndex: String(responseIndex), rawText, ...(displayItemId ? { displayItemId } : {}) },
    classList: { contains: cls => cls === 'assistant' },
    __displayItem: null,
  };
}

function testQuotedUserMessageCapturesStableIndexedIdentity() {
  const state = messageState([
    { role: 'user', content: '这是什么意思', rawText: '这是什么意思', messageIndex: 0 },
  ]);
  const workflow = messageWorkflow.createMessageWorkflow({ state });
  const quote = workflow.resolveQuoteContextForNode(userNode(0, '这是什么意思'));
  assert.ok(quote, 'a quoted user message must produce a quote context');
  assert.strictEqual(quote.role, 'user');
  assert.strictEqual(quote.id, 'user:0',
    'user-message quotes without a display id must still carry the canonical role:index identity');
  assert.strictEqual(quote.messageIndex, '0');
}

function testQuotedUserMessagePreferCanonicalIdWhenPresent() {
  const state = messageState([
    { role: 'user', content: '这是什么意思', rawText: '这是什么意思', messageIndex: 0, id: 'chat-msj4vwmi-yio86j:user:0' },
  ]);
  const workflow = messageWorkflow.createMessageWorkflow({ state });
  const quote = workflow.resolveQuoteContextForNode(userNode(0, '这是什么意思'));
  assert.strictEqual(quote.id, 'chat-msj4vwmi-yio86j:user:0',
    'an explicit canonical message id must win over the indexed fallback');
}

function testQuotedAssistantMessageKeepsDisplayIdentity() {
  const state = messageState([
    { role: 'user', content: '帮我选一个方案', rawText: '帮我选一个方案', messageIndex: 0 },
    { role: 'assistant', content: '选A更合适', rawText: '选A更合适', responseIndex: 1 },
  ]);
  const workflow = messageWorkflow.createMessageWorkflow({ state });
  const quote = workflow.resolveQuoteContextForNode(assistantNode(1, '选A更合适', 'display_msj5j3pc_mo5dfff'));
  assert.strictEqual(quote.id, 'display_msj5j3pc_mo5dfff');
  assert.strictEqual(quote.displayItemId, 'display_msj5j3pc_mo5dfff');
}

function testQuotedRouteContextCarriesTheQuoteIdentityIntoCandidates() {
  const built = submitHelpers.buildQuotedRouteContext({
    quotedMessage: { role: 'user', content: '这是什么意思', id: 'user:0', sessionId: 'session-a' },
    currentInput: '这有几个字',
  });
  assert.strictEqual(built.context.quoted_message.id, 'user:0');
  assert.strictEqual(built.context.recent_messages[0].id, 'user:0',
    'the quoted route context must expose the same identity on the quoted message and the recent message so candidates match');

  const intent = {
    operation: 'plain_chat',
    relation: 'followup',
    goal: '测试用户目标',
    task_shape: 'single',
    resource_refs: [{ candidate_key: 'm1', role: 'context' }],
  };
  const result = routeService.inspectModelRouteResult(JSON.stringify(intent), {
    input: '这有几个字',
    attachments: [],
    context: built.context,
  });
  assert.ok(result.route, `quoted user-message route must compile: ${result.reason} ${result.error || ''}`);
  assert.strictEqual(result.route.executionResources.messages[0].resource_id, 'res:message:user%3A0');
  assert.strictEqual(result.route.executionResources.messages[0].source, 'quoted');
  assert.strictEqual(result.route.executionResources.messages[0].id, 'user:0');
  assert.deepStrictEqual(result.route.dispatchContract.bindings, [{
    key: 'r1', type: 'message', role: 'context', resource_id: 'res:message:user%3A0', source: 'quoted',
  }]);

  const quotedObject = { role: 'user', content: '这是什么意思', id: 'user:0', sessionId: 'session-a' };
  const routeMessageProjection = submitHelpers.projectRouteMessageContext(
    result.route,
    [{ role: 'user', content: '这是什么意思', messageIndex: 0 }],
    quotedObject,
  );
  assert.ok(routeMessageProjection, 'the quoted user-message route must resolve its message projection');
  const pools = submitHelpers.buildExecutionResourcePools(
    { current: [], quoted: [], history: [], context: [] },
    { isImageFile, messages: routeMessageProjection.messages },
  );
  const media = submitHelpers.projectRouteExecutionMedia(result.route, pools);
  assert.strictEqual(media.chatMessages.length, 1);
  assert.strictEqual(media.chatMessages[0].routeResourceKey, 'r1');
  assert.strictEqual(media.chatMessages[0].resource_id, 'res:message:user%3A0');
}

module.exports = [
  testQuotedUserMessageCapturesStableIndexedIdentity,
  testQuotedUserMessagePreferCanonicalIdWhenPresent,
  testQuotedAssistantMessageKeepsDisplayIdentity,
  testQuotedRouteContextCarriesTheQuoteIdentityIntoCandidates,
];
