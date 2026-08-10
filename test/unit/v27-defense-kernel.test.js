'use strict';

// v2.7 defense kernel tests: clarification round counter, multi-intent
// split/merge prompt, changes path-family gate, confirmation-style provider
// alternative, and the model-call ceiling. All assertions mirror the manual
// verification runs recorded in temp/v27-implementation/HANDOFF.md.

const assert = require('assert');
const routeService = require('../../client/services/route-service');
const taskConstants = require('../../shared/task-constants');
const capabilityRegistry = require('../../shared/capability-registry');

function compile(plan, options = {}) {
  return routeService.compileLocalRoute(plan, {
    input: plan.arguments?.prompt || '',
    attachments: [],
    context: {},
    ...options,
  });
}

function answeredContext(rounds = 0, overrides = {}) {
  return {
    clarification_context: {
      schema_version: 'clarification_context.v4',
      answer_complete: true,
      operation: 'edit_image',
      selected_parameters: {},
      established_resources: [],
      selected_resources: [],
    },
    clarification_rounds: rounds,
    ...overrides,
  };
}

function editPlan(overrides = {}) {
  return {
    operation: 'edit_image',
    relation: 'new',
    arguments: { prompt: '把猫改成蓝色' },
    bindings: [],
    constraints: [],
    ...overrides,
  };
}

function editContextWithTarget() {
  return {
    image_candidates: [{
      index: 1, source_index: 1, source: 'history', image_id: 'img-1',
      resource_id: 'res:image:img-1', reference_id: 'ref-1',
      description: '上一张图片', prompt: '之前的图',
    }],
    recent_messages: [],
    file_candidates: [],
  };
}

function testTaskConstantsCarryTheDocumentedLimits() {
  assert.strictEqual(taskConstants.MAX_CLARIFICATION_ROUNDS, 3);
  assert.strictEqual(taskConstants.MAX_MODEL_CALLS, 6);
  assert.strictEqual(taskConstants.TASK_CONSTANTS_VERSION, 'task_constants.v1');
  assert.strictEqual(taskConstants.RECENT_MESSAGES_WINDOW, 20);
  assert.strictEqual(taskConstants.CHANGES_LOG_RETENTION, 20);
}

function testClarificationRoundAdvancesWhenAnswerIsConsumed() {
  const route = compile(editPlan(), { context: answeredContext(2) });
  assert.strictEqual(route.clarificationRounds, 3);
  assert.strictEqual(route.clarificationExhausted, false);
  assert.strictEqual(route.maxClarificationRounds, 3);
}

function testClarificationRoundCeilingFailsClosed() {
  const route = compile(editPlan(), { context: answeredContext(4) });
  assert.strictEqual(route.clarificationRounds, 5);
  assert.strictEqual(route.clarificationExhausted, true);
  assert.strictEqual(route.needClarification, true);
  assert.strictEqual(route.dispatchAuthorized, false);
  assert.match(route.clarificationQuestion, /上限/);
  // Exhausted clarification must never hand back a dispatchable contract.
  assert.strictEqual(route.dispatchContract, null);
  assert.strictEqual(route.executionResources, null);
}

function testFreshTurnStartsWithZeroRounds() {
  const route = compile({ operation: 'text_to_image', relation: 'new', arguments: { prompt: '画一只橘猫' }, bindings: [], constraints: [] });
  assert.strictEqual(route.clarificationRounds, 0);
  assert.strictEqual(route.clarificationExhausted, false);
  assert.strictEqual(route.readiness, 'ready');
}

function testChangesFamilyIncompatiblePathFailsClosed() {
  // generation-family path (subject.*) on edit_image is rejected.
  const route = compile(editPlan(), { changes: [{ path: 'subject.animal', op: 'replace', value: 'dog' }] });
  assert.strictEqual(route.changesFamilyInvalid, true);
  assert.strictEqual(route.needClarification, true);
  assert.strictEqual(route.dispatchAuthorized, false);
  assert.match(route.clarificationQuestion, /不兼容|重新描述/);
}

function testChangesFamilyCompatiblePathPasses() {
  const route = compile(editPlan(), { changes: [{ path: 'modifications.color', op: 'replace', value: 'blue' }] });
  assert.strictEqual(route.changesFamilyInvalid, false);
}

function testChangesNonArrayShapeFailsClosed() {
  // Protocol violation: changes must be an array of { path, op, value }.
  const route = compile(editPlan(), { changes: { subject: { value: 'dog' } } });
  assert.strictEqual(route.changesFamilyInvalid, true);
  assert.strictEqual(route.needClarification, true);
}

function testChangesUnsupportedOnChatOperationFailsClosed() {
  const route = compile(
    { operation: 'plain_chat', relation: 'new', arguments: { prompt: '你好' }, bindings: [], constraints: [] },
    { changes: [{ path: 'subject.animal', op: 'replace', value: 'dog' }] },
  );
  assert.strictEqual(route.changesFamilyInvalid, true);
}

function testSharedChangesFamilyValidatorRejectsForbiddenPrefix() {
  assert.throws(
    () => capabilityRegistry.assertChangesFamilyCompatible('edit_image', [{ path: 'prompt.text', op: 'replace', value: 'x' }]),
    error => error?.code === 'EXECUTION_CHANGES_FAMILY_INVALID',
  );
  assert.throws(
    () => capabilityRegistry.assertChangesFamilyCompatible('edit_image', [{ path: '__proto__.polluted', op: 'replace', value: 'x' }]),
    error => error?.code === 'EXECUTION_CHANGES_FAMILY_INVALID',
  );
  assert.throws(
    () => capabilityRegistry.assertChangesFamilyCompatible('edit_image', [{ path: 'modifications.color', op: 'replace', value: 'x' }, { path: 'modifications.color', op: 'replace', value: 'y' }]),
    error => error?.code === 'EXECUTION_CHANGES_FAMILY_INVALID',
  );
  assert.throws(
    () => capabilityRegistry.assertChangesFamilyCompatible('edit_image', [{ path: 'modifications', op: 'replace', value: 'x' }, { path: 'modifications.color', op: 'replace', value: 'y' }]),
    error => error?.code === 'EXECUTION_CHANGES_FAMILY_INVALID',
  );
}

function testProviderAlternativeRequiresConfirmation() {
  const route = compile(editPlan({ relation: 'followup', bindings: [{ key: 'r1', type: 'image', role: 'target', resource_id: 'res:image:img-1', source: 'history' }] }), {
    context: editContextWithTarget(),
    providerCapabilities: { operations: { edit_image: { supported: false } } },
  });
  assert.strictEqual(route.providerAlternative?.operation, 'image_reference_gen');
  assert.strictEqual(route.needClarification, true);
  assert.strictEqual(route.dispatchAuthorized, false);
  assert.match(route.clarificationQuestion, /等效/);
}

function testProviderUnsupportedWithoutAlternativeFailsClosed() {
  const route = compile(
    { operation: 'plain_chat', relation: 'new', arguments: { prompt: '你好' }, bindings: [], constraints: [] },
    { providerCapabilities: { operations: { plain_chat: { supported: false } } } },
  );
  assert.strictEqual(route.providerUnsupported, true);
  assert.strictEqual(route.needClarification, true);
  assert.strictEqual(route.dispatchAuthorized, false);
  assert.match(route.clarificationQuestion, /不支持/);
}

function testProviderCapabilitiesAbsentKeepsBaselineBehavior() {
  const route = compile(
    { operation: 'plain_chat', relation: 'new', arguments: { prompt: '你好' }, bindings: [], constraints: [] },
  );
  assert.strictEqual(route.providerUnsupported, false);
  assert.strictEqual(route.providerAlternative, null);
}

function testMultiIntentPromptsSplitOrMergeClarification() {
  const route = compile(
    { operation: 'plain_chat', relation: 'new', arguments: { prompt: '先总结这份周报，然后根据它生成一张海报' }, bindings: [], constraints: [] },
  );
  assert.strictEqual(route.needClarification, true);
  assert.match(route.clarificationQuestion, /分开做|合并做/);
}

function testMultiIntentStableSingleTaskIsNotBlocked() {
  const route = compile(
    { operation: 'text_to_image', relation: 'new', arguments: { prompt: '生成一张海报，主题是夏日促销' }, bindings: [], constraints: [] },
  );
  assert.strictEqual(route.readiness, 'ready');
}

module.exports = [
  testTaskConstantsCarryTheDocumentedLimits,
  testClarificationRoundAdvancesWhenAnswerIsConsumed,
  testClarificationRoundCeilingFailsClosed,
  testFreshTurnStartsWithZeroRounds,
  testChangesFamilyIncompatiblePathFailsClosed,
  testChangesFamilyCompatiblePathPasses,
  testChangesNonArrayShapeFailsClosed,
  testChangesUnsupportedOnChatOperationFailsClosed,
  testSharedChangesFamilyValidatorRejectsForbiddenPrefix,
  testProviderAlternativeRequiresConfirmation,
  testProviderUnsupportedWithoutAlternativeFailsClosed,
  testProviderCapabilitiesAbsentKeepsBaselineBehavior,
  testMultiIntentPromptsSplitOrMergeClarification,
  testMultiIntentStableSingleTaskIsNotBlocked,
];
