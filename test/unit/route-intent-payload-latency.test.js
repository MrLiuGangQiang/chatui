'use strict';

const assert = require('assert');
const routeService = require('../../client/services/route-service');

// A representative intent-recognition scenario: one simple follow-up question
// over six historical image candidates. It mirrors the latency-sensitive path
// that must never grow into a large model payload or trigger full reasoning.
function representativeContext() {
  return {
    recent_messages: [
      {
        index: 1,
        role: 'user',
        content: '描述一下第四张图\n\n[image id=att_msmveadm_1_01__.png name=01_助理.png type=image/png size=208593]\n[image id=att_msmveadn_2_02__.png name=02_总控.png type=image/png size=234219]\n[image id=att_msmveadn_3_03__.png name=03_老板.png type=image/png size=224188]',
      },
      {
        index: 2,
        role: 'assistant',
        content: '图片为一个圆形徽章式图标，背景是由亮橙到珊瑚橙的渐变色。'.repeat(24),
      },
    ],
    image_candidates: Array.from({ length: 6 }, (_, index) => ({
      index: index + 1,
      source: 'history',
      image_id: `img-history-${index + 1}`,
      reference_id: `imgref-history-${index + 1}`,
      label: `${String(index + 1).padStart(2, '0')}_${['助理', '总控', '老板', '前端', '后端', '产品'][index]}.png`,
    })),
    file_candidates: [],
    last_generated_image: { count: 6 },
    latest_uploaded_image: { count: 6 },
    latest_image_reference: { target: 'uploaded', count: 6 },
    previous_resource_execution: {
      operation: 'image_qa', resource_kind: 'image', image_count: 1, file_count: 0,
      source_message_index: 1, response_message_index: 2,
    },
    previous_visual_execution: { operation: 'image_qa', image_count: 1 },
    conversation_focus: { kind: 'image' },
  };
}

function testIntentPayloadCapsReasoningEffortForGpt5RouteModels() {
  const payload = routeService.buildRoutePayload({
    model: 'gpt-5.6-luna',
    input: '描述一下最后一张图',
    context: representativeContext(),
  });
  assert.strictEqual(
    routeService.INTENT_REASONING_EFFORT,
    'low',
    'intent routing must run at a shallow, fast reasoning profile',
  );
  assert.strictEqual(
    payload.reasoning_effort,
    routeService.INTENT_REASONING_EFFORT,
    'gpt-5 route models must receive the shallow reasoning effort on every intent call',
  );
  assert.strictEqual(payload.temperature, 0, 'intent classification stays deterministic');
  assert.ok(payload.response_format?.json_schema, 'strict structured output stays enabled');
}

function testIntentPayloadOmitsReasoningControlForNonReasoningModels() {
  const payload = routeService.buildRoutePayload({
    model: 'deepseek-chat',
    input: '描述一下最后一张图',
    context: representativeContext(),
  });
  assert.strictEqual(
    payload.reasoning_effort,
    undefined,
    'non-reasoning route models must not receive a reasoning parameter they cannot honor',
  );
}

function testIntentPayloadCapsRecentMessageLength() {
  const userPayload = JSON.parse(routeService.buildRoutePayload({
    model: 'gpt-5.6-luna',
    input: '描述一下最后一张图',
    context: representativeContext(),
  }).messages[1].content);
  assert.ok(Array.isArray(userPayload.context.recent_messages) && userPayload.context.recent_messages.length === 2);
  for (const message of userPayload.context.recent_messages) {
    assert.ok(
      String(message.content || '').length <= 240,
      `wire recent-message content must stay capped, got ${String(message.content || '').length} chars`,
    );
  }
}

function testIntentPayloadStaysBoundedForRepresentativeScenario() {
  const payload = routeService.buildRoutePayload({
    model: 'gpt-5.6-luna',
    input: '描述一下最后一张图',
    context: representativeContext(),
    currentTurn: { messageIndex: 3 },
  });
  const userContent = JSON.stringify(payload.messages[1].content);
  assert.ok(
    userContent.length <= 2600,
    `intent user payload must stay bounded for the representative scenario, got ${userContent.length} chars`,
  );
  const userPayload = JSON.parse(payload.messages[1].content);
  assert.ok(
    userPayload.resource_candidates.length >= 6,
    'all six historical image candidates must remain visible to the route model',
  );
}

module.exports = [
  testIntentPayloadCapsReasoningEffortForGpt5RouteModels,
  testIntentPayloadOmitsReasoningControlForNonReasoningModels,
  testIntentPayloadCapsRecentMessageLength,
  testIntentPayloadStaysBoundedForRepresentativeScenario,
];
