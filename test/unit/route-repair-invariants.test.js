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

function readyDecision() {
  return {
    schema_version: 'route_decision.v1', readiness: 'ready', operation: 'edit_image', relation: 'followup',
    bindings: [{ candidate_key: 'i1', role: 'target' }, { candidate_key: 'i2', role: 'mask' }],
    changes: [{ op: 'replace', target: 'background', value: 'red' }], constraints: [],
    clarification: { question: '', unresolved: [] }, confidence: 0.9, rationale: 'edit the selected historical image',
  };
}

function clarificationDecision() {
  return {
    schema_version: 'route_decision.v1', readiness: 'needs_clarification', operation: 'image_compare', relation: 'continuation',
    bindings: [], changes: [], constraints: [],
    clarification: {
      question: '请选择要比较的两张图片。',
      unresolved: [
        { type: 'image', role: 'compare_a', reason: 'ambiguous', candidate_keys: ['i1', 'i2'] },
        { type: 'image', role: 'compare_b', reason: 'ambiguous', candidate_keys: ['i3', 'i4'] },
      ],
    },
    confidence: 0.7, rationale: 'two image slots remain ambiguous',
  };
}

function testRepairInvariantSnapshotPermitsOnlyBindingAndStructuralRepair() {
  const malformed = { ...readyDecision(), accidental_field: true };
  const invariants = routeService.repairInvariantSnapshot(JSON.stringify(malformed));
  assert.ok(invariants);
  assert.strictEqual(invariants.operation, 'edit_image');
  assert.strictEqual(invariants.resource_count, 2);

  const bindingRepair = { ...readyDecision(), rationale: 'structural field repaired' };
  assert.strictEqual(routeService.repairPreservesInvariants(invariants, bindingRepair), true);

  const reordered = { ...bindingRepair, bindings: [...bindingRepair.bindings].reverse() };
  assert.strictEqual(routeService.repairPreservesInvariants(invariants, reordered), false,
    'binding order determines canonical resource order and must not be normalized away');

  for (const mutate of [
    value => { value.operation = 'image_qa'; },
    value => { value.relation = 'correction'; },
    value => { value.readiness = 'needs_clarification'; value.clarification = { question: 'choose', unresolved: [{ type: 'image', role: 'target', reason: 'ambiguous', candidate_keys: ['i1', 'i2'] }] }; },
    value => { value.bindings[0].role = 'reference'; },
    value => { value.bindings[0].candidate_key = 'i3'; },
    value => { value.bindings.push({ candidate_key: 'i3', role: 'reference' }); },
  ]) {
    const drifted = structuredClone(bindingRepair);
    mutate(drifted);
    assert.strictEqual(routeService.repairPreservesInvariants(invariants, drifted), false);
  }
}

function testRepairInvariantSnapshotProtectsUnresolvedChoiceOrder() {
  const original = clarificationDecision();
  const invariants = routeService.repairInvariantSnapshot(original);
  assert.ok(invariants);

  const harmless = { ...original, rationale: 'labels and confidence are not repair invariants', confidence: 0.6 };
  assert.strictEqual(routeService.repairPreservesInvariants(invariants, harmless), true);

  const reversedChoices = structuredClone(original);
  reversedChoices.clarification.unresolved[0].candidate_keys.reverse();
  assert.strictEqual(routeService.repairPreservesInvariants(invariants, reversedChoices), false,
    'candidate order determines clarification choice keys and must remain stable');

  const swappedSlots = structuredClone(original);
  swappedSlots.clarification.unresolved.reverse();
  assert.strictEqual(routeService.repairPreservesInvariants(invariants, swappedSlots), false,
    'unresolved slot order must remain stable');

  const fewerChoices = structuredClone(original);
  fewerChoices.clarification.unresolved[0].candidate_keys.pop();
  assert.strictEqual(routeService.repairPreservesInvariants(invariants, fewerChoices), false);
  assert.strictEqual(routeService.repairInvariantSnapshot('not json'), null);
}

function testRepairRejectsLegacyTaskContractAndIncompleteDecisionBoundary() {
  assert.strictEqual(routeService.repairInvariantSnapshot(readyContract()), null,
    'model-authored task_contract.v5 output must not enter the semantic repair path');
  const legacy = structuredClone(readyContract());
  legacy.schema_version = 'task_contract.v4';
  delete legacy.readiness;
  legacy.clarification = { question: '', resume_operation: '', unresolved_resources: [] };
  assert.strictEqual(routeService.repairInvariantSnapshot(legacy), null,
    'a v4 response must not be repaired into newly executable v5 semantics');

  const missingReadiness = structuredClone(readyDecision());
  delete missingReadiness.readiness;
  assert.strictEqual(routeService.repairInvariantSnapshot(missingReadiness), null, 'readiness must be explicit before repair');

  const oversized = JSON.stringify({ ...readyDecision(), padding: 'x'.repeat(12000) });
  assert.strictEqual(routeService.repairInvariantSnapshot(oversized), null,
    'oversized malformed output must fail closed instead of being silently truncated for repair');
  assert.throws(
    () => routeService.buildIntentRepairPayload({ model: 'route-model', input: 'request', previousOutput: JSON.stringify(legacy) }),
    /complete route semantic invariant/,
  );
}

function testRepairPayloadCarriesMachineCheckedInvariantBoundary() {
  const previous = JSON.stringify({ ...readyDecision(), accidental_field: true });
  const payload = routeService.buildIntentRepairPayload({
    model: 'route-model', input: 'make it red', currentMode: 'edit_image', autoMode: false, previousOutput: previous,
  });
  const user = JSON.parse(payload.messages[1].content);
  assert.deepStrictEqual(user.repair_invariants, routeService.repairInvariantSnapshot(previous));
  assert.strictEqual(user.current_mode, 'edit_image');
  assert.strictEqual(user.auto_mode, false);
  assert.ok(payload.messages[0].content.includes('repair_invariants 是不可变边界'));
  assert.ok(payload.messages[0].content.includes('增删候选'));
  assert.ok(payload.messages[0].content.includes('数组顺序也不可改变'));
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
  const malformed = { ...readyDecision(), accidental_field: true };
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
  testRepairInvariantSnapshotProtectsUnresolvedChoiceOrder,
  testRepairRejectsLegacyTaskContractAndIncompleteDecisionBoundary,
  testRepairPayloadCarriesMachineCheckedInvariantBoundary,
  testPrimaryAndFallbackShareOneAbsoluteIntentDeadline,
  testRepairConsumesTheSameIntentDeadlineAndCannotStartFallbackAfterExpiry,
  testStructuredOutputCompatibilityRetrySharesTheSameDeadline,
];
