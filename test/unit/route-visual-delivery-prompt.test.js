'use strict';

const assert = require('assert');
const routeService = require('../../client/services/route-service');

function testRoutePromptDelegatesVisualDeliveryUnderstandingToTheModel() {
  const prompt = routeService.ROUTE_SYSTEM_PROMPT;
  assert.match(prompt, /图片交付事实/);
  assert.match(prompt, /delivery_evidence/);
  assert.match(prompt, /actual_image_result\.available=true/);
  assert.ok(prompt.includes('assistant_image_claim未验证不算'));
  assert.ok(prompt.includes('当前输入依赖当前图片/文件时必须选image_qa/file_qa并绑定当前附件'));
  assert.match(prompt, /不能因问题是解释、建议、费用或事实就降级为plain_chat/);
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
