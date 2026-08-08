'use strict';

const assert = require('assert');
const routeService = require('../../client/services/route-service');
const submitHelpers = require('../../client/app/submit-workflow.helpers');

const isImageFile = item => String(item?.type || '').startsWith('image/');

function quotedPlainChatIntent() {
  return {
    operation: 'plain_chat',
    relation: 'followup',
    goal: '测试用户目标',
    resource_refs: [{ candidate_key: 'm2', role: 'context' }],
  };
}

function quotedMessageContext() {
  return {
    recent_messages: [
      { index: 1, id: 'chat-msj4vwmi-yio86j:user:0', role: 'user', content: '帮我选一个方案', resource_id: '', identity_aliases: [] },
      {
        index: 2, id: 'display_msj5j3pc_mo5dfff', role: 'assistant', content: '选A更合适',
        resource_id: 'res:message:display_msj5j3pc_mo5dfff',
        identity_aliases: ['res:message:display_msj5j3pc_mo5dfff', 'display_msj5j3pc_mo5dfff'],
      },
    ],
    quoted_message: { index: 2, role: 'assistant', id: 'display_msj5j3pc_mo5dfff', resource_id: 'res:message:display_msj5j3pc_mo5dfff' },
  };
}

function compileQuotedPlainChat() {
  const result = routeService.inspectModelRouteResult(JSON.stringify(quotedPlainChatIntent()), {
    input: '这是什么意思',
    attachments: [],
    context: quotedMessageContext(),
  });
  assert.ok(result.route, 'route compilation failed: ' + result.reason + ' ' + (result.error || ''));
  return result.route;
}

function testQuotedPlainChatProjectionFailsClosedWithoutMessagePool() {
  const route = compileQuotedPlainChat();
  const pools = submitHelpers.buildExecutionResourcePools(
    { current: [], quoted: [], history: [], context: [] },
    { isImageFile },
  );
  assert.throws(
    () => submitHelpers.projectRouteExecutionMedia(route, pools),
    error => error.code === 'EXECUTION_RESOURCE_UNRESOLVED'
      && error.resourceKey === 'r1'
      && /not uniquely available for execution/.test(error.message),
    'a message binding without a populated message pool must fail closed at projection',
  );
}

function testQuotedPlainChatProjectionBindsWithCallerMessagePoolWiring() {
  const route = compileQuotedPlainChat();
  const sessionMessages = [
    { role: 'user', content: '帮我选一个方案', id: 'chat-msj4vwmi-yio86j:user:0' },
    { role: 'assistant', content: '选A更合适', id: 'display_msj5j3pc_mo5dfff', displayItemId: 'display_msj5j3pc_mo5dfff' },
  ];
  const pools = submitHelpers.buildExecutionResourcePools(
    { current: [], quoted: [], history: [], context: [] },
    { isImageFile, messages: sessionMessages },
  );
  const media = submitHelpers.projectRouteExecutionMedia(route, pools);
  assert.strictEqual(media.chatMessages.length, 1);
  assert.strictEqual(media.chatMessages[0].routeResourceKey, 'r1');
  assert.strictEqual(media.chatMessages[0].resource_id, 'res:message:display_msj5j3pc_mo5dfff');
  assert.strictEqual(media.chatMessages[0].routeRole, 'context');
}

function testRouteMessageProjectionDrivesMessagePoolWithoutDuplicateAmbiguity() {
  const route = compileQuotedPlainChat();
  const sessionMessages = [
    { role: 'user', content: '帮我选一个方案', id: 'chat-msj4vwmi-yio86j:user:0' },
    { role: 'assistant', content: '选A更合适', id: 'display_msj5j3pc_mo5dfff', displayItemId: 'display_msj5j3pc_mo5dfff' },
  ];
  // A separately restored quoted copy with the same identity must not make the
  // pool ambiguous when callers use the route-validated projection.
  const separateQuoted = { role: 'assistant', content: '选A更合适', id: 'display_msj5j3pc_mo5dfff', displayItemId: 'display_msj5j3pc_mo5dfff' };
  const routeMessageProjection = submitHelpers.projectRouteMessageContext(route, sessionMessages, separateQuoted);
  assert.ok(routeMessageProjection, 'the quoted route must resolve to the explicit quoted message');
  const pools = submitHelpers.buildExecutionResourcePools(
    { current: [], quoted: [], history: [], context: [] },
    { isImageFile, messages: routeMessageProjection.messages },
  );
  const media = submitHelpers.projectRouteExecutionMedia(route, pools);
  assert.strictEqual(media.chatMessages.length, 1);
  assert.strictEqual(media.chatMessages[0].routeResourceKey, 'r1');
}

module.exports = [
  testQuotedPlainChatProjectionFailsClosedWithoutMessagePool,
  testQuotedPlainChatProjectionBindsWithCallerMessagePoolWiring,
  testRouteMessageProjectionDrivesMessagePoolWithoutDuplicateAmbiguity,
];
