'use strict';

const assert = require('assert');

const routeService = require('../../client/services/route-service');
const routeDecisionWorkflow = require('../../client/app/route-decision-workflow');

function readyContract() {
  return {
    schema_version: 'task_contract.v5', readiness: 'ready', operation: 'edit_image', relation: 'followup',
    resources: [{ key: 'r1', type: 'image', source: 'history', role: 'target', index: 1, id: 'old-id', reference_id: 'old-ref', missing: false }],
    directive: { mode: 'patch', base_resource_keys: ['r1'], unmentioned_policy: 'preserve', operations: [{ op: 'replace', target: 'background', value: 'red' }], constraints: [] },
    clarification: { question: '', unresolved_resources: [] },
    confidence: 0.9, review_reasons: [], rationale: 'edit the selected historical image',
  };
}

function clarificationContract() {
  return {
    schema_version: 'task_contract.v5', readiness: 'needs_clarification', operation: 'image_reference_gen', relation: 'followup',
    resources: [{ key: 'r1', type: 'image', source: 'history', role: 'reference', index: 1, id: 'cat', reference_id: 'cat-ref', missing: false }],
    directive: { mode: 'patch', base_resource_keys: ['r1', 'r2'], unmentioned_policy: 'preserve', operations: [], constraints: [] },
    clarification: { question: '请选择鱼图。', unresolved_resources: [{
      key: 'r2', type: 'image', role: 'reference', reason: 'ambiguous', choices: [
        { key: 'c1', source: 'history', index: 2, id: 'fish-a', reference_id: 'fish-a-ref', label: '鱼 A' },
        { key: 'c2', source: 'history', index: 3, id: 'fish-b', reference_id: 'fish-b-ref', label: '鱼 B' },
      ],
    }] },
    confidence: 0.7, review_reasons: [], rationale: 'fish is ambiguous',
  };
}

function testRepairInvariantSnapshotPermitsOnlyBindingAndStructuralRepair() {
  const malformed = { ...readyContract(), accidental_field: true };
  const invariants = routeService.repairInvariantSnapshot(JSON.stringify(malformed));
  assert.ok(invariants);
  assert.strictEqual(invariants.operation, 'edit_image');
  assert.strictEqual(invariants.resource_count, 1);

  const bindingRepair = structuredClone(readyContract());
  bindingRepair.resources[0].index = 7;
  bindingRepair.resources[0].id = 'canonical-id';
  bindingRepair.resources[0].reference_id = 'canonical-ref';
  assert.strictEqual(routeService.repairPreservesInvariants(invariants, bindingRepair), true, 'candidate identity and display index may be canonicalized');

  for (const mutate of [
    task => { task.operation = 'image_qa'; },
    task => { task.relation = 'correction'; },
    task => { task.readiness = 'needs_clarification'; task.clarification = clarificationContract().clarification; },
    task => { task.resources[0].role = 'reference'; },
    task => { task.resources[0].source = 'current'; },
    task => { task.resources.push({ ...task.resources[0], key: 'r2' }); },
  ]) {
    const drifted = structuredClone(bindingRepair);
    mutate(drifted);
    assert.strictEqual(routeService.repairPreservesInvariants(invariants, drifted), false);
  }
}

function testRepairInvariantSnapshotProtectsUnresolvedChoiceShape() {
  const original = clarificationContract();
  const invariants = routeService.repairInvariantSnapshot(original);
  assert.ok(invariants);
  const relabeled = structuredClone(original);
  relabeled.clarification.unresolved_resources[0].choices[0].label = '更清晰的用户标签';
  relabeled.clarification.unresolved_resources[0].choices[0].index = 20;
  assert.strictEqual(routeService.repairPreservesInvariants(invariants, relabeled), true);

  const selectedForUser = structuredClone(original);
  selectedForUser.readiness = 'ready';
  selectedForUser.resources.push({ key: 'r2', type: 'image', source: 'history', role: 'reference', index: 2, id: 'fish-a', reference_id: 'fish-a-ref', missing: false });
  selectedForUser.clarification = { question: '', unresolved_resources: [] };
  assert.strictEqual(routeService.repairPreservesInvariants(invariants, selectedForUser), false);

  const fewerChoices = structuredClone(original);
  fewerChoices.clarification.unresolved_resources[0].choices.pop();
  assert.strictEqual(routeService.repairPreservesInvariants(invariants, fewerChoices), false);
  assert.strictEqual(routeService.repairInvariantSnapshot('not json'), null);
}

function testRepairRequiresExplicitCompleteV5SemanticBoundary() {
  const legacy = structuredClone(readyContract());
  legacy.schema_version = 'task_contract.v4';
  delete legacy.readiness;
  legacy.clarification = { question: '', resume_operation: '', unresolved_resources: [] };
  assert.strictEqual(routeService.repairInvariantSnapshot(legacy), null, 'a v4 response must not be repaired into newly executable v5 semantics');

  const missingReadiness = structuredClone(readyContract());
  delete missingReadiness.readiness;
  assert.strictEqual(routeService.repairInvariantSnapshot(missingReadiness), null, 'readiness must be explicit before repair');

  const oversized = JSON.stringify({ ...readyContract(), padding: 'x'.repeat(12000) });
  assert.strictEqual(routeService.repairInvariantSnapshot(oversized), null, 'oversized malformed output must fail closed instead of being silently truncated for repair');
  assert.throws(
    () => routeService.buildIntentRepairPayload({ model: 'route-model', input: 'request', previousOutput: JSON.stringify(legacy) }),
    /complete route semantic invariant/,
  );
}

function testRepairPayloadCarriesMachineCheckedInvariantBoundary() {
  const previous = JSON.stringify({ ...readyContract(), accidental_field: true });
  const payload = routeService.buildIntentRepairPayload({
    model: 'route-model', input: 'make it red', currentMode: 'edit_image', autoMode: false, previousOutput: previous,
  });
  const user = JSON.parse(payload.messages[1].content);
  assert.deepStrictEqual(user.repair_invariants, routeService.repairInvariantSnapshot(previous));
  assert.strictEqual(user.current_mode, 'edit_image');
  assert.strictEqual(user.auto_mode, false);
  assert.ok(payload.messages[0].content.includes('repair_invariants 是不可变边界'));
  assert.ok(payload.messages[0].content.includes('增删候选'));
}

function hangingRequest(signal) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('test request outlived deadline')), 1000);
    const abort = () => {
      clearTimeout(timer);
      const error = new Error('aborted');
      error.name = 'AbortError';
      reject(error);
    };
    if (signal?.aborted) abort();
    else signal?.addEventListener?.('abort', abort, { once: true });
  });
}

function createDeadlineHarness(requestJson) {
  const previousWindow = global.window;
  global.window = { ChatUIServices: { route: routeService }, ChatUIRouteService: routeService };
  const state = { activeSessionId: 'session-a', sessions: [{ id: 'session-a', messages: [] }], attachments: [], mode: 'chat', autoMode: true };
  const workflow = routeDecisionWorkflow.createRouteDecisionWorkflow({
    state,
    loadPublicContext: async () => {},
    getConfig: () => ({ baseUrl: 'https://example.test/v1', apiKey: 'key', routeModel: 'route-model', chatModel: 'chat-model' }),
    getSessionRouteModel: () => 'route-model',
    getSessionChatModel: () => 'chat-model',
    buildRequestHeaders: () => ({}),
    buildRouteAttachmentMetadata: () => [],
    requestJson,
    parseRouteResult: routeService.parseRouteResult,
  });
  return { workflow, restore: () => { if (previousWindow === undefined) delete global.window; else global.window = previousWindow; } };
}

async function testPrimaryAndFallbackShareOneAbsoluteIntentDeadline() {
  const signals = [];
  let calls = 0;
  const harness = createDeadlineHarness(async (_url, _payload, _key, options = {}) => {
    calls += 1;
    signals.push(options.signal);
    if (calls === 1) throw new Error('primary unavailable');
    return hangingRequest(options.signal);
  });
  const originalWarn = console.warn;
  console.warn = () => {};
  const started = Date.now();
  try {
    await assert.rejects(
      () => harness.workflow.getEffectiveRoute('question', [], 'session-a', {}, {}, { deadlineMs: 60 }),
      error => error?.code === 'ROUTE_INTENT_TIMEOUT' && error?.timeoutMs === 60,
    );
    assert.strictEqual(calls, 2);
    assert.strictEqual(signals[0], signals[1], 'primary and fallback must use the same deadline signal');
    assert.ok(Date.now() - started < 500, 'fallback must not receive a fresh timeout window');
  } finally {
    console.warn = originalWarn;
    harness.restore();
  }
}

async function testRepairConsumesTheSameIntentDeadlineAndCannotStartFallbackAfterExpiry() {
  let calls = 0;
  const malformed = { ...readyContract(), accidental_field: true };
  const harness = createDeadlineHarness(async (_url, _payload, _key, options = {}) => {
    calls += 1;
    if (calls === 1) return { choices: [{ message: { content: JSON.stringify(malformed) } }] };
    return hangingRequest(options.signal);
  });
  const originalWarn = console.warn;
  console.warn = () => {};
  try {
    await assert.rejects(
      () => harness.workflow.getEffectiveRoute('make it red', [], 'session-a', {}, {}, { deadlineMs: 60 }),
      error => error?.code === 'ROUTE_INTENT_TIMEOUT',
    );
    assert.strictEqual(calls, 2, 'deadline expiry during repair must not start a chat-model fallback');
  } finally {
    console.warn = originalWarn;
    harness.restore();
  }
}

async function testStructuredOutputCompatibilityRetrySharesTheSameDeadline() {
  let calls = 0;
  const signals = [];
  const harness = createDeadlineHarness(async (_url, payload, _key, options = {}) => {
    calls += 1;
    signals.push(options.signal);
    if (calls === 1) {
      assert.ok(payload.response_format, 'the primary attempt must request strict structured output');
      throw new Error('response_format json_schema is unsupported by this endpoint');
    }
    assert.deepStrictEqual(payload.response_format, { type: 'json_object' }, 'the compatibility retry must retain machine-readable JSON mode');
    return hangingRequest(options.signal);
  });
  const originalWarn = console.warn;
  console.warn = () => {};
  try {
    await assert.rejects(
      () => harness.workflow.getEffectiveRoute('question', [], 'session-a', {}, {}, { deadlineMs: 60 }),
      error => error?.code === 'ROUTE_INTENT_TIMEOUT',
    );
    assert.strictEqual(calls, 2, 'deadline expiry in the compatibility retry must not start a fallback model');
    assert.strictEqual(signals[0], signals[1], 'structured and compatibility attempts must share one abort signal');
  } finally {
    console.warn = originalWarn;
    harness.restore();
  }
}

module.exports = [
  testRepairInvariantSnapshotPermitsOnlyBindingAndStructuralRepair,
  testRepairInvariantSnapshotProtectsUnresolvedChoiceShape,
  testRepairRequiresExplicitCompleteV5SemanticBoundary,
  testRepairPayloadCarriesMachineCheckedInvariantBoundary,
  testPrimaryAndFallbackShareOneAbsoluteIntentDeadline,
  testRepairConsumesTheSameIntentDeadlineAndCannotStartFallbackAfterExpiry,
  testStructuredOutputCompatibilityRetrySharesTheSameDeadline,
];
