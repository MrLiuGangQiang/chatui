'use strict';

const assert = require('assert');
const routeIntent = require('../../shared/route-intent');
const routeService = require('../../client/services/route-service');

function legacyIntent() {
  return {
    operation: 'plain_chat',
    relation: 'new',
    goal: '解释事件循环',
    resource_refs: [],
  };
}

function testLiveRouteParserRejectsLegacyFourFieldOutput() {
  const inspected = routeService.inspectModelRouteResult(JSON.stringify(legacyIntent()), {
    input: '解释事件循环',
    attachments: [],
    context: {},
  });
  assert.strictEqual(inspected.route, null);
  assert.strictEqual(inspected.reason, 'route_intent_invalid');
}

function testRouteTextExtractionAcceptsNonStreamingResponsesAndChatContentParts() {
  const intent = {
    operation: 'plain_chat',
    relation: 'new',
    goal: '联苯苄唑溶液能上飞机么',
    goal_mode: 'replace',
    resource_refs: [],
    task_shape: 'single',
  };
  const serialized = JSON.stringify(intent);
  const responseEnvelopes = [
    {
      name: 'Responses output content',
      value: {
        text: {
          format: {
            type: 'json_schema',
            name: 'chatui_route_intent_v3',
            schema: { type: 'object' },
            strict: true,
          },
        },
        output: [{
          type: 'message',
          role: 'assistant',
          content: [{ type: 'output_text', text: serialized }],
        }],
      },
    },
    {
      name: 'Chat Completions content parts',
      value: {
        choices: [{
          message: {
            role: 'assistant',
            content: [{ type: 'text', text: serialized }],
          },
        }],
      },
    },
    {
      name: 'parsed structured output',
      value: { output_parsed: intent },
    },
  ];

  for (const envelope of responseEnvelopes) {
    const text = routeService.extractRouteText(envelope.value);
    assert.strictEqual(text, serialized, `${envelope.name} must unwrap into the exact JSON text`);
    const inspected = routeService.inspectModelRouteResult(text, {
      input: intent.goal,
      attachments: [],
      context: {},
      currentMode: 'chat',
      autoMode: true,
    });
    assert.ok(inspected.route, `${envelope.name} must pass strict route validation`);
    assert.strictEqual(inspected.route.operationType, 'plain_chat');
  }
}

function testLegacyRouteIntentRequiresAnExplicitAdapter() {
  const adapted = routeIntent.adaptLegacyRouteIntentV1(legacyIntent());
  assert.deepStrictEqual(adapted, { ...legacyIntent(), goal_mode: 'replace', task_shape: 'single' });
  assert.strictEqual(routeIntent.hasExactRouteIntent(adapted), true);
  assert.throws(() => routeIntent.adaptLegacyRouteIntentV1({ ...legacyIntent(), extra: true }), error => (
    error?.code === 'ROUTE_INTENT_V1_INVALID'
  ));
}

function testLiveRouteSchemaPublishesV3AndRequiresAllSixFields() {
  const format = routeIntent.ROUTE_INTENT_RESPONSE_FORMAT;
  assert.strictEqual(routeIntent.ROUTE_INTENT_VERSION, 'route_intent.v3');
  assert.strictEqual(format.json_schema.name, 'chatui_route_intent_v3');
  assert.deepStrictEqual(format.json_schema.schema.required,
    ['operation', 'relation', 'goal', 'goal_mode', 'resource_refs', 'task_shape']);
}

module.exports = [
  testLiveRouteParserRejectsLegacyFourFieldOutput,
  testRouteTextExtractionAcceptsNonStreamingResponsesAndChatContentParts,
  testLegacyRouteIntentRequiresAnExplicitAdapter,
  testLiveRouteSchemaPublishesV3AndRequiresAllSixFields,
];
