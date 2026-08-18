'use strict';

const assert = require('assert');
const chatService = require('../../client/services/chat-service');
const routeService = require('../../client/services/route-service');
const routeIntent = require('../../shared/route-intent');

const UNSUPPORTED_STRICT_PROVIDER_KEYWORDS = new Set([
  'minLength', 'maxLength', 'pattern', 'format',
  'minItems', 'maxItems', 'uniqueItems', 'contains', 'minContains', 'maxContains',
  'const', 'minimum', 'maximum', 'multipleOf', 'exclusiveMinimum', 'exclusiveMaximum',
]);

function unsupportedKeywordPaths(value, path = '$', paths = []) {
  if (Array.isArray(value)) {
    value.forEach((item, index) => unsupportedKeywordPaths(item, `${path}[${index}]`, paths));
    return paths;
  }
  if (!value || typeof value !== 'object') return paths;
  for (const [key, child] of Object.entries(value)) {
    const childPath = `${path}.${key}`;
    if (UNSUPPORTED_STRICT_PROVIDER_KEYWORDS.has(key)) paths.push(childPath);
    unsupportedKeywordPaths(child, childPath, paths);
  }
  return paths;
}

function testStrictResponsesSchemaUsesThePortableProviderSubsetWithoutMutatingLocalProtocol() {
  const canonical = routeService.ROUTE_INTENT_RESPONSE_FORMAT.json_schema.schema;
  const payload = routeService.buildRoutePayload({
    model: 'route-model',
    input: '把第一张图改为水彩风。',
    attachments: [{ type: 'image/png', image_id: 'image-1', name: 'first.png' }],
    context: {},
  });
  const providerSchema = payload.text.format.schema;

  assert.deepStrictEqual(unsupportedKeywordPaths(providerSchema), [],
    'strict Responses payloads must not contain unsupported lexical/cardinality schema keywords');
  assert.strictEqual(canonical.properties.goal.minLength, 1,
    'local protocol validation must retain the non-empty goal constraint');
  assert.ok(Number(canonical.properties.goal.maxLength) > 0,
    'local protocol validation must retain the bounded goal constraint');
  assert.strictEqual(canonical.properties.resource_refs.maxItems, routeIntent.ROUTE_INTENT_MAX_RESOURCE_REFS,
    'local protocol validation must retain the resource-reference cap');
  assert.strictEqual(canonical.properties.resource_refs.items.properties.candidate_key.pattern, '^[ifm][1-9]\\d*$',
    'local protocol validation must retain candidate-key syntax validation');
  assert.deepStrictEqual(
    providerSchema.properties.resource_refs.items.properties.candidate_key.enum,
    ['i1'],
    'the portable provider schema must preserve request-specific candidate authorization',
  );
}


function testRouteGoalLengthRulesRemainLocalWhileTheWireSchemaStaysPortable() {
  const input = '把目标图中的客厅改大。';
  const payload = routeService.buildRoutePayload({
    model: 'route-model',
    input,
    attachments: [],
    context: {},
  });
  const localGoalSchema = routeIntent.ROUTE_INTENT_RESPONSE_FORMAT.json_schema.schema.properties.goal;
  const providerGoalSchema = payload.text.format.schema.properties.goal;

  assert.deepStrictEqual(localGoalSchema, {
    type: 'string',
    minLength: 1,
    maxLength: routeIntent.ROUTE_INTENT_MAX_GOAL_LENGTH,
  }, 'the canonical local validator must retain the non-empty and bounded goal contract');
  assert.deepStrictEqual(providerGoalSchema, { type: 'string' },
    'the strict wire schema must send the goal as a plain string: no minLength/maxLength and no user-input enum literal');
  assert.strictEqual(routeIntent.hasExactRouteIntent({
    operation: 'plain_chat',
    relation: 'new',
    goal: '字'.repeat(routeIntent.ROUTE_INTENT_MAX_GOAL_LENGTH + 1),
    resource_refs: [],
    task_shape: 'single',
  }), false, 'removing a wire constraint must never weaken the local route-intent validator');
}

function testStrictSchemaSanitizerAppliesRecursivelyToOtherStructuredWorkflows() {
  const payload = routeService.buildImagePlanPayload({
    model: 'route-model',
    input: '分别生成一只猫和一只狗。',
    goal: '分别生成一只猫和一只狗。',
    attachments: [],
    context: {},
  });

  assert.deepStrictEqual(unsupportedKeywordPaths(payload.text.format.schema), [],
    'the shared Responses boundary must protect image planning from the same provider schema rejection');
  assert.strictEqual(routeService.IMAGE_PLAN_RESPONSE_FORMAT.json_schema.schema.properties.tasks.minItems, 1,
    'the canonical image-plan validator must retain its local cardinality requirement');
}

function testProviderSchemaSanitizerDoesNotMutateCallerOwnedSchema() {
  const source = {
    type: 'object',
    additionalProperties: false,
    required: ['value'],
    properties: {
      value: { type: 'string', minLength: 1, maxLength: 5, pattern: '^[a-z]+$' },
      items: { type: 'array', minItems: 1, maxItems: 2, items: { type: 'string' } },
      fixed: { type: 'string', const: 'v1' },
      count: { type: 'integer', minimum: 1, maximum: 4, multipleOf: 1 },
    },
  };
  const compacted = chatService.strictStructuredOutputProviderSchema(source);

  assert.deepStrictEqual(unsupportedKeywordPaths(compacted), []);
  assert.strictEqual(source.properties.value.minLength, 1);
  assert.strictEqual(source.properties.value.maxLength, 5);
  assert.strictEqual(source.properties.items.maxItems, 2);
  assert.strictEqual(source.properties.fixed.const, 'v1');
  assert.strictEqual(source.properties.count.minimum, 1);
}

module.exports = [
  testStrictResponsesSchemaUsesThePortableProviderSubsetWithoutMutatingLocalProtocol,
  testRouteGoalLengthRulesRemainLocalWhileTheWireSchemaStaysPortable,
  testStrictSchemaSanitizerAppliesRecursivelyToOtherStructuredWorkflows,
  testProviderSchemaSanitizerDoesNotMutateCallerOwnedSchema,
];
