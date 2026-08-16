'use strict';

const assert = require('assert');
const routeService = require('../../client/services/route-service');

function routeResourceRefSchema(payload = {}) {
  return payload.text.format.schema.properties.resource_refs;
}

function testEmptyCandidateCatalogFallsBackToLocalResourceValidationWhenProviderSchemaUsesTheStrictSubset() {
  const payload = routeService.buildRoutePayload({
    model: 'route-model',
    input: '把这张图的背景换成蓝色。',
    attachments: [],
    context: {},
  });
  const wire = JSON.parse(payload.input[1].content);
  assert.deepStrictEqual(wire.resource_candidates, []);
  assert.strictEqual(Object.hasOwn(routeResourceRefSchema(payload), 'maxItems'), false,
    'provider strict schemas omit unsupported array-cardinality keywords');

  const result = routeService.inspectModelRouteResult(JSON.stringify({
    operation: 'edit_image',
    relation: 'new',
    goal: '把目标图的背景换成蓝色。',
    task_shape: 'single',
    resource_refs: [{ candidate_key: 'i1', role: 'target' }],
  }), {
    input: '把这张图的背景换成蓝色。',
    attachments: [],
    context: {},
  });
  assert.ok(result.route, result.reason || result.error || 'route compilation failed');
  assert.strictEqual(result.route.needClarification, true,
    'an invented resource must remain non-dispatchable when the provider subset cannot express maxItems=0');
  assert.strictEqual(result.route.dispatchAuthorized, false);
}

function testCandidateKeySchemaEnumeratesOnlyTheCatalogPublishedInTheSameRequest() {
  const payload = routeService.buildRoutePayload({
    model: 'route-model',
    input: '比较当前图片和合同。',
    attachments: [{ type: 'image', image_id: 'img-current', name: 'current.png' }],
    context: {
      file_candidates: [{
        source: 'history',
        file_id: 'file-history',
        name: 'contract.pdf',
        has_extracted_text: true,
      }],
    },
  });
  const wire = JSON.parse(payload.input[1].content);
  const publishedKeys = wire.resource_candidates.map(candidate => candidate.candidate_key);
  const candidateSchema = routeResourceRefSchema(payload).items.properties.candidate_key;

  assert.ok(publishedKeys.length >= 2, 'the test setup must publish both current and historical resources');
  assert.deepStrictEqual(candidateSchema.enum, publishedKeys,
    'candidate_key must be a request-specific enum backed by the exact published catalog');
  assert.strictEqual(routeService.ROUTE_INTENT_RESPONSE_FORMAT.json_schema.schema.properties.resource_refs.maxItems, 16,
    'building a request-specific schema must not mutate the canonical protocol schema');
  assert.strictEqual(
    Object.prototype.hasOwnProperty.call(
      routeService.ROUTE_INTENT_RESPONSE_FORMAT.json_schema.schema.properties.resource_refs.items.properties.candidate_key,
      'enum',
    ),
    false,
    'the canonical reusable schema must not retain candidate keys from an earlier request',
  );
}

module.exports = [
  testEmptyCandidateCatalogFallsBackToLocalResourceValidationWhenProviderSchemaUsesTheStrictSubset,
  testCandidateKeySchemaEnumeratesOnlyTheCatalogPublishedInTheSameRequest,
];
