'use strict';

const assert = require('assert');
const routeService = require('../../client/services/route-service');

function testRoutePromptDelegatesVisualDeliveryUnderstandingToTheModel() {
  const prompt = routeService.ROUTE_SYSTEM_PROMPT;
  assert.match(prompt, /图片交付事实/);
  assert.match(prompt, /delivery_evidence/);
  assert.match(prompt, /actual_image_result\.available=true/);
  assert.match(prompt, /assistant_image_claim 未验证时不代表交付/);
  assert.match(prompt, /明确问解释、尺寸、原因、建议或事实才选 plain_chat/);
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
