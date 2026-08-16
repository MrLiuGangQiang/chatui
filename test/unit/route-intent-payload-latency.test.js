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

function assertMinimalNonStreamingResponsesPayload(payload, label) {
  assert.strictEqual(payload.stream, false, `${label} must explicitly disable streaming for compatible gateways`);
  assert.strictEqual(payload.reasoning, undefined, `${label} must not request visible reasoning summaries`);
  assert.strictEqual(payload.temperature, undefined, `${label} must not carry Chat Completions sampling controls`);
  assert.deepStrictEqual(Object.keys(payload).sort(), ['input', 'model', 'stream', 'text'], `${label} must use the minimal Responses request shape`);
  assert.ok(payload.text?.format?.schema, `${label} must retain strict structured output`);
}

function assertMinimalIntentResponsesPayload(payload) {
  assert.strictEqual(payload.stream, false, 'intent recognition must explicitly disable streaming');
  assert.strictEqual(payload.reasoning, undefined, 'intent recognition must keep normal model reasoning available');
  assert.strictEqual(payload.temperature, undefined, 'intent recognition must not add a sampling override');
  assert.strictEqual(payload.max_output_tokens, undefined, 'intent recognition must not cap reasoning with a transport limit');
  assert.strictEqual(payload.tool_choice, 'none', 'intent recognition must explicitly disable tools');
  assert.strictEqual(Object.hasOwn(payload, 'tools'), false, 'the classifier request must not include tools');
  assert.deepStrictEqual(Object.keys(payload).sort(), [
    'input', 'model', 'stream', 'text', 'tool_choice',
  ]);
  assert.ok(payload.text?.format?.schema, 'intent recognition must retain strict structured output');
}

function testIntentPayloadKeepsResponsesNonStreamingAndMinimalForGpt5RouteModels() {
  const payload = routeService.buildRoutePayload({
    model: 'gpt-5.6-luna',
    input: '描述一下最后一张图',
    context: representativeContext(),
  });
  assertMinimalIntentResponsesPayload(payload);
  const userPayload = JSON.parse(payload.input[1].content);
  assert.strictEqual(userPayload.output_format, 'json', 'the gateway-required JSON marker must remain in the user envelope');
}

function testImagePlanPayloadKeepsResponsesNonStreamingAndMinimalForGpt5RouteModels() {
  const payload = routeService.buildImagePlanPayload({
    model: 'gpt-5.6-luna',
    input: '分别生成一只猫和一只狗',
    goal: '分别生成一只猫和一只狗',
    context: representativeContext(),
  });
  assertMinimalNonStreamingResponsesPayload(payload, 'image planning');
  const userPayload = JSON.parse(payload.input[1].content);
  assert.strictEqual(userPayload.output_format, 'json', 'image planning must retain the JSON marker in user input');
}

function testIntentPayloadCapsRecentMessageLength() {
  const userPayload = JSON.parse(routeService.buildRoutePayload({
    model: 'gpt-5.6-luna',
    input: '描述一下最后一张图',
    context: representativeContext(),
  }).input[1].content);
  assert.ok(Array.isArray(userPayload.context.recent_messages) && userPayload.context.recent_messages.length === 2);
  for (const message of userPayload.context.recent_messages) {
    assert.ok(
      String(message.content || '').length > 0,
      'wire recent-message content must be non-empty after context assembly',
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
  const userContent = JSON.stringify(payload.input[1].content);
  assert.ok(
    userContent.length <= 2600,
    `intent user payload must stay bounded for the representative scenario, got ${userContent.length} chars`,
  );
  const userPayload = JSON.parse(payload.input[1].content);
  assert.ok(
    userPayload.resource_candidates.length >= 6,
    'all six historical image candidates must remain visible to the route model',
  );
}

module.exports = [
  testIntentPayloadKeepsResponsesNonStreamingAndMinimalForGpt5RouteModels,
  testImagePlanPayloadKeepsResponsesNonStreamingAndMinimalForGpt5RouteModels,
  testIntentPayloadCapsRecentMessageLength,
  testIntentPayloadStaysBoundedForRepresentativeScenario,
];
