'use strict';

// v2.7 section 7.1 provider capability negotiation tests: unconfigured
// baseline allow, operation/role/argument gaps, equivalent-alternative
// detection (registry-declared condition token), and fail-closed assert.

const assert = require('assert');
const providerCapability = require('../../server/validators/provider-capability.validator');
const capabilityRegistry = require('../../shared/capability-registry');

function providerWith(operations = {}) {
  return { operations };
}

function testUnconfiguredProviderAllowsEverything() {
  for (const provider of [null, undefined, {}, { operations: {} }]) {
    const result = providerCapability.validateProviderCapability({
      operation: 'edit_image', bindings: [], argumentsValue: {}, provider,
    });
    assert.strictEqual(result.supported, true, String(provider));
  }
}

function testProviderOperationUnsupportedFailsClosed() {
  const result = providerCapability.validateProviderCapability({
    operation: 'edit_image',
    bindings: [],
    argumentsValue: {},
    provider: providerWith({ edit_image: { supported: false } }),
  });
  assert.strictEqual(result.supported, false);
  assert.ok(result.issues.some(issue => issue.code === 'provider_operation_unsupported'));
}

function testProviderRoleUnsupportedIsReported() {
  // 'target' has no registry-declared condition token, so the generic role
  // code is reported. (mask maps to the declared 'provider_unsupported_mask'
  // token and is covered by the equivalent-alternative test below.)
  const result = providerCapability.validateProviderCapability({
    operation: 'edit_image',
    bindings: [{ key: 'r1', type: 'image', role: 'target' }],
    argumentsValue: {},
    provider: providerWith({ edit_image: { supported: true, roles: { target: false } } }),
  });
  assert.strictEqual(result.supported, false);
  assert.ok(result.issues.some(issue => issue.code === 'provider_role_unsupported' && issue.role === 'target'));
}

function testProviderArgumentUnsupportedIsReported() {
  const result = providerCapability.validateProviderCapability({
    operation: 'edit_image',
    bindings: [],
    argumentsValue: { mask: { data: 'x' } },
    provider: providerWith({ edit_image: { supported: true, arguments: { mask: { supported: false } } } }),
  });
  assert.strictEqual(result.supported, false);
  assert.ok(result.issues.some(issue => issue.code === 'provider_argument_unsupported' && issue.argument === 'mask'));
}

function testProviderArgumentValueUnsupportedIsReported() {
  const result = providerCapability.validateProviderCapability({
    operation: 'text_to_image',
    bindings: [],
    argumentsValue: { size: '512x512' },
    provider: providerWith({ text_to_image: { supported: true, arguments: { size: { values: ['1024x1024'] } } } }),
  });
  assert.strictEqual(result.supported, false);
  assert.ok(result.issues.some(issue => issue.code === 'provider_argument_value_unsupported' && issue.argument === 'size'));
}

function testEquivalentAlternativeIsReportedForMaskUnsupported() {
  // edit_image declares equivalent_alternatives with condition
  // 'provider_unsupported_mask' in the registry; the provider reports the
  // same token as the issue code so the two fact sources agree.
  const result = providerCapability.validateProviderCapability({
    operation: 'edit_image',
    bindings: [{ key: 'r1', type: 'image', role: 'mask' }],
    argumentsValue: {},
    provider: providerWith({ edit_image: { supported: true, roles: { mask: false } } }),
  });
  assert.strictEqual(result.supported, false);
  assert.strictEqual(result.alternative?.operation, 'image_reference_gen');
  assert.strictEqual(result.alternative?.condition, 'provider_unsupported_mask');
  assert.strictEqual(result.alternative?.original_operation, 'edit_image');
}

function testEquivalentAlternativeForUsesRegistryConditionToken() {
  const alternative = providerCapability.equivalentAlternativeFor('edit_image', [
    { code: 'provider_unsupported_mask' },
  ]);
  assert.strictEqual(alternative?.operation, 'image_reference_gen');
  // A foreign issue code must never invent a replacement.
  assert.strictEqual(providerCapability.equivalentAlternativeFor('edit_image', [
    { code: 'provider_some_other_failure' },
  ]), null);
}

function testRegistryDeclaresEditImageEquivalentAlternative() {
  assert.deepStrictEqual(capabilityRegistry.equivalentAlternativesFor('edit_image'), [
    { operation: 'image_reference_gen', condition: 'provider_unsupported_mask' },
  ]);
}

function testAssertProviderCapabilityThrowsWithoutAlternative() {
  assert.throws(
    () => providerCapability.assertProviderCapability({
      operation: 'plain_chat', bindings: [], argumentsValue: {},
      provider: providerWith({ plain_chat: { supported: false } }),
    }),
    error => error?.code === 'PROVIDER_CAPABILITY_UNSUPPORTED' && error?.statusCode === 400,
  );
}

function testAssertProviderCapabilityAllowsWithAlternativeFlag() {
  const result = providerCapability.assertProviderCapability({
    operation: 'edit_image',
    bindings: [{ key: 'r1', type: 'image', role: 'mask' }],
    argumentsValue: {},
    provider: providerWith({ edit_image: { supported: true, roles: { mask: false } } }),
    allowAlternative: true,
  });
  assert.strictEqual(result.supported, false);
  assert.strictEqual(result.alternative?.operation, 'image_reference_gen');
}

function testProviderSupportsOperationDefaultAllowsUnconfigured() {
  assert.strictEqual(providerCapability.providerSupportsOperation({}, 'edit_image'), true);
  assert.strictEqual(providerCapability.providerSupportsOperation({ operations: { edit_image: {} } }, 'edit_image'), true);
  assert.strictEqual(providerCapability.providerSupportsOperation({ operations: { edit_image: { supported: false } } }, 'edit_image'), false);
}

function testUnknownOperationFailsClosedInValidate() {
  assert.throws(
    () => providerCapability.validateProviderCapability({
      operation: 'not_a_real_operation', bindings: [], argumentsValue: {}, provider: {},
    }),
    error => error?.code === 'PROVIDER_CAPABILITY_OPERATION_UNKNOWN',
  );
}

module.exports = [
  testUnconfiguredProviderAllowsEverything,
  testProviderOperationUnsupportedFailsClosed,
  testProviderRoleUnsupportedIsReported,
  testProviderArgumentUnsupportedIsReported,
  testProviderArgumentValueUnsupportedIsReported,
  testEquivalentAlternativeIsReportedForMaskUnsupported,
  testEquivalentAlternativeForUsesRegistryConditionToken,
  testRegistryDeclaresEditImageEquivalentAlternative,
  testAssertProviderCapabilityThrowsWithoutAlternative,
  testAssertProviderCapabilityAllowsWithAlternativeFlag,
  testProviderSupportsOperationDefaultAllowsUnconfigured,
  testUnknownOperationFailsClosedInValidate,
];
