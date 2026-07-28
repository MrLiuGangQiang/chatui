'use strict';

const assert = require('assert');
const routeService = require('../../client/services/route-service');

function clone(value) {
  return JSON.parse(JSON.stringify(value));
}

function baseContract(overrides = {}) {
  return {
    schema_version: 'task_contract.v5',
    readiness: 'ready',
    operation: 'plain_chat',
    relation: 'new',
    resources: [],
    directive: {
      mode: 'standalone',
      base_resource_keys: [],
      unmentioned_policy: 'allow_change',
      operations: [],
      constraints: [],
    },
    clarification: { question: '', unresolved_resources: [] },
    confidence: 1,
    review_reasons: [],
    rationale: 'unit test',
    ...overrides,
  };
}

function validChatRoute() {
  return routeService.parseRouteResult(JSON.stringify(baseContract()), { input: 'hello' });
}

function validEditRoute() {
  const contract = baseContract({
    operation: 'edit_image',
    resources: [{
      key: 'r1', type: 'image', source: 'current', role: 'target', index: 1,
      id: 'image-1', reference_id: 'reference-1', missing: false,
    }],
    directive: {
      mode: 'patch',
      base_resource_keys: ['r1'],
      unmentioned_policy: 'preserve',
      operations: [{ op: 'replace', target: 'background', value: 'blue' }],
      constraints: [],
    },
  });
  return routeService.parseRouteResult(JSON.stringify(contract), {
    input: 'make the background blue',
    attachments: [{
      id: 'image-1', image_id: 'image-1', reference_id: 'reference-1',
      media_index: 1, source_index: 1, is_image: true, type: 'image/png',
    }],
  });
}

function testDispatchGateAcceptsOnlyCanonicalConsistentRoutes() {
  const chat = validChatRoute();
  const edit = validEditRoute();
  assert.ok(chat);
  assert.ok(edit);
  assert.strictEqual(routeService.isRouteDispatchable(chat), true);
  assert.strictEqual(routeService.isRouteDispatchable(edit), true);

  const historicalMessageContract = baseContract({
    operation: 'text_to_image',
    relation: 'followup',
    resources: [{
      key: 'r1', type: 'message', source: 'history', role: 'context', index: 1,
      id: 'message-1', reference_id: '', missing: false,
    }],
    directive: {
      mode: 'patch', base_resource_keys: ['r1'], unmentioned_policy: 'preserve',
      operations: [], constraints: [],
    },
  });
  const messageRoute = routeService.parseRouteResult(JSON.stringify(historicalMessageContract), {
    input: 'generate an image from that description',
    context: { recent_messages: [{ index: 1, id: 'message-1', role: 'user', content: 'a red fox' }] },
  });
  assert.ok(messageRoute);
  assert.strictEqual(routeService.isRouteDispatchable(messageRoute), true);
}

function testDispatchGateRejectsMissingOrDowngradedContracts() {
  const valid = validChatRoute();
  assert.strictEqual(routeService.isRouteDispatchable({ mode: 'chat', api: 'chat', dispatchAuthorized: true }), false);

  const legacy = clone(valid);
  legacy.taskContract = {
    schema_version: 'task_contract.v4',
    operation: 'plain_chat',
    relation: 'new',
    resources: [],
    directive: clone(valid.taskContract.directive),
    clarification: { question: '', resume_operation: '', unresolved_resources: [] },
    confidence: 1,
    review_reasons: [],
    rationale: 'legacy route',
  };
  assert.strictEqual(routeService.isRouteDispatchable(legacy), false);

  const notReady = clone(valid);
  notReady.readiness = 'needs_clarification';
  assert.strictEqual(routeService.isRouteDispatchable(notReady), false);

  const unauthorized = clone(valid);
  unauthorized.dispatchAuthorized = false;
  assert.strictEqual(routeService.isRouteDispatchable(unauthorized), false);
}

function testDispatchGateRejectsRouteAndProjectionDrift() {
  const valid = validEditRoute();
  const mutations = [
    route => { route.executionResources = null; },
    route => { route.executionResources.version = 'execution_resources.v0'; },
    route => { route.api = 'chat'; },
    route => { route.operationApi = 'chat'; },
    route => { route.operationType = 'plain_chat'; },
    route => { route.operationMode = 'chat'; },
    route => { route.mode = 'chat'; },
    route => { route.relation = 'followup'; },
    route => { route.executionResources.operation = 'plain_chat'; },
    route => { route.executionResources.api = 'chat'; },
    route => { route.executionResources.images[0].id = 'different-image'; },
    route => { route.executionResources.imageInputs = []; },
    route => { route.imageRefs[0].index = 2; },
  ];

  for (const mutate of mutations) {
    const route = clone(valid);
    mutate(route);
    assert.strictEqual(routeService.isRouteDispatchable(route), false);
  }
}

function testExplicitForceImageRouteUsesTheSameGate() {
  assert.strictEqual(routeService.createExplicitTextToImageRoute('   '), null);
  const route = routeService.createExplicitTextToImageRoute('a cinematic red fox');
  assert.ok(route);
  assert.strictEqual(route.taskContract.schema_version, 'task_contract.v5');
  assert.strictEqual(route.taskContract.operation, 'text_to_image');
  assert.strictEqual(route.executionResources.version, 'execution_resources.v1');
  assert.strictEqual(routeService.isRouteDispatchable(route), true);
}

module.exports = [
  testDispatchGateAcceptsOnlyCanonicalConsistentRoutes,
  testDispatchGateRejectsMissingOrDowngradedContracts,
  testDispatchGateRejectsRouteAndProjectionDrift,
  testExplicitForceImageRouteUsesTheSameGate,
];
