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

function testLegacyRouteIntentRequiresAnExplicitAdapter() {
  const adapted = routeIntent.adaptLegacyRouteIntentV1(legacyIntent());
  assert.deepStrictEqual(adapted, { ...legacyIntent(), task_shape: 'single' });
  assert.strictEqual(routeIntent.hasExactRouteIntent(adapted), true);
  assert.throws(() => routeIntent.adaptLegacyRouteIntentV1({ ...legacyIntent(), extra: true }), error => (
    error?.code === 'ROUTE_INTENT_V1_INVALID'
  ));
}

function testLiveRouteSchemaPublishesV2AndRequiresAllFiveFields() {
  const format = routeIntent.ROUTE_INTENT_RESPONSE_FORMAT;
  assert.strictEqual(routeIntent.ROUTE_INTENT_VERSION, 'route_intent.v2');
  assert.strictEqual(format.json_schema.name, 'chatui_route_intent_v2');
  assert.deepStrictEqual(format.json_schema.schema.required,
    ['operation', 'relation', 'goal', 'resource_refs', 'task_shape']);
}

module.exports = [
  testLiveRouteParserRejectsLegacyFourFieldOutput,
  testLegacyRouteIntentRequiresAnExplicitAdapter,
  testLiveRouteSchemaPublishesV2AndRequiresAllFiveFields,
];
