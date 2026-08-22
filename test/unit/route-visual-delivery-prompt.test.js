'use strict';

const assert = require('assert');
const routeService = require('../../client/services/route-service');

function testRoutePromptDelegatesVisualDeliveryUnderstandingToTheModel() {
  const prompt = routeService.ROUTE_SYSTEM_PROMPT;
  assert.match(prompt, /交付模态连续性/);
  assert.match(prompt, /最近用户确认的任务共同理解交付物/);
  assert.match(prompt, /previous_execution\.result_kind=image/);
  assert.match(prompt, /assistant 的文字声称不是图片已交付的证据/);
  assert.match(prompt, /解释、尺寸、原因、建议或事实时才选 plain_chat/);
}

function testModelOwnedVisualDeliveryDecisionIsNotLocallyOverridden() {
  const result = routeService.inspectModelRouteResult(JSON.stringify({
    operation: 'plain_chat',
    relation: 'followup',
    goal: '解释堂屋正中的入户双开门。',
    goal_mode: 'replace',
    task_shape: 'single',
    resource_refs: [],
  }), {
    input: '堂屋正中的入户双开门多宽？',
    attachments: [],
    context: {
      recent_messages: [
        { index: 1, role: 'user', content: '生成住宅户型图，中央设置堂屋。' },
        { index: 2, role: 'assistant', content: '建议采用内开双开门。' },
      ],
    },
  });
  assert.ok(result.route, result.reason);
  assert.strictEqual(result.route.operationType, 'plain_chat');
  assert.strictEqual(result.route.dispatchAuthorized, true);
}

module.exports = [
  testRoutePromptDelegatesVisualDeliveryUnderstandingToTheModel,
  testModelOwnedVisualDeliveryDecisionIsNotLocallyOverridden,
];
