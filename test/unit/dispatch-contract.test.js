const assert = require('assert');
const capabilities = require('../../shared/capability-registry');
const dispatchContract = require('../../shared/dispatch-contract');

function executionMedia(operation = 'plain_chat', groups = {}, relation = 'new') {
  return {
    version: 'execution_resources.v2',
    operation,
    api: operation === 'text_to_image' ? 'image_generation' : operation === 'plain_chat' ? 'chat' : undefined,
    relation,
    images: groups.images || [],
    files: groups.files || [],
    messages: groups.messages || [],
    targets: [],
    masks: [],
    references: [],
    imageInputs: groups.images || [],
    chatImages: groups.images || [],
    chatFiles: groups.files || [],
    selectedMessageRefs: groups.messages || [],
  };
}

function binding(resource = {}) {
  return {
    key: resource.key,
    type: resource.type,
    role: resource.role,
    resource_id: resource.resource_id,
    source: resource.source,
  };
}

function compile({ operation = 'plain_chat', relation = 'new', input = '', resources = [], defaults = {}, overrides = {}, constraints = [] } = {}) {
  return dispatchContract.compileDispatchContract({
    operation,
    relation,
    input,
    defaults,
    overrides,
    bindings: resources.map(binding),
    constraints,
  });
}

function testCapabilityRegistryParsesTypedImageArguments() {
  const input = 'Generate 2 images, portrait, transparent background, export PNG, high quality';
  const result = capabilities.resolveExecutionArguments({
    operation: 'text_to_image',
    input,
    defaults: { imageSize: '1024x1024' },
  });
  assert.deepStrictEqual(result.arguments, {
    prompt: input,
    size: '1024x1536',
    quality: 'high',
    background: 'transparent',
    output_format: 'png',
    count: 2,
  });
  assert.deepStrictEqual(result.evidence.size, ['portrait']);
  assert.strictEqual(capabilities.validateArguments('text_to_image', result.arguments), true);
}


function testCapabilityRegistryAppliesNegationAndLongestOverlapSemantics() {
  const noTransparent = capabilities.resolveExecutionArguments({
    operation: 'text_to_image',
    input: '生成一张猫，不要透明背景',
  });
  assert.deepStrictEqual(noTransparent.arguments?.background, 'opaque');
  assert.strictEqual(noTransparent.conflicts.length, 0);

  const opaque = capabilities.resolveExecutionArguments({
    operation: 'text_to_image',
    input: '生成一张猫，使用不透明背景',
  });
  assert.deepStrictEqual(opaque.arguments?.background, 'opaque');
  assert.strictEqual(opaque.conflicts.length, 0, 'the shorter transparent span must not conflict with 不透明背景');

  const noOpaque = capabilities.resolveExecutionArguments({
    operation: 'text_to_image',
    input: 'Do not use an opaque background',
  });
  assert.deepStrictEqual(noOpaque.arguments?.background, 'transparent');

  for (const [input, expected] of [
    ['生成一张猫，不是透明背景', 'opaque'],
    ['生成一张猫，不能使用透明背景', 'opaque'],
    ['I do not want a transparent background', 'opaque'],
    ["I don't want an opaque background", 'transparent'],
  ]) {
    const result = capabilities.resolveExecutionArguments({ operation: 'text_to_image', input });
    assert.deepStrictEqual(result.arguments?.background, expected, `negation must apply to: ${input}`);
  }

  const englishUnderspecifiedNegative = capabilities.resolveExecutionArguments({
    operation: 'text_to_image',
    input: 'I do not want high quality',
  });
  assert.strictEqual(englishUnderspecifiedNegative.arguments, null);
  assert.strictEqual(englishUnderspecifiedNegative.conflicts[0].name, 'quality');

  const underspecifiedNegative = capabilities.resolveExecutionArguments({
    operation: 'text_to_image',
    input: '生成一张猫，不要高质量',
  });
  assert.strictEqual(underspecifiedNegative.arguments, null, 'a negative directive with multiple valid alternatives must clarify instead of falling back to auto');
  assert.strictEqual(underspecifiedNegative.conflicts[0].name, 'quality');
  assert.ok(!/自动/.test(capabilities.clarificationQuestion(underspecifiedNegative)),
    'a clarification for an exclusion must not suggest auto, which could select an excluded value');

  const contradictoryBackground = capabilities.resolveExecutionArguments({
    operation: 'text_to_image',
    input: '使用透明背景，但不要透明背景',
  });
  assert.strictEqual(contradictoryBackground.arguments, null);
  assert.deepStrictEqual(contradictoryBackground.conflicts[0].values, ['opaque']);
  assert.deepStrictEqual(
    capabilities.choicesForArgument('background', contradictoryBackground.conflicts[0].values).map(choice => choice.value),
    ['opaque'],
    'contradictory clarification must not re-offer the explicitly excluded value',
  );

  const fullyExcludedBackground = capabilities.resolveExecutionArguments({
    operation: 'text_to_image',
    input: '不要透明背景，也不要不透明背景',
  });
  assert.strictEqual(fullyExcludedBackground.arguments, null);
  assert.deepStrictEqual(fullyExcludedBackground.conflicts[0].values, []);
  assert.deepStrictEqual(
    capabilities.choicesForArgument('background', fullyExcludedBackground.conflicts[0].values),
    [],
    'clarification must not re-offer values that the user explicitly excluded',
  );
  assert.ok(/均被排除|没有可用/.test(capabilities.clarificationQuestion(fullyExcludedBackground)));
}

function testCapabilityRegistryNormalizesFullWidthSyntaxWithoutChangingThePrompt() {
  const input = '生成２张１０２４×１０２４的猫图片，ｎ：２';
  const result = capabilities.resolveExecutionArguments({ operation: 'text_to_image', input });
  assert.strictEqual(result.arguments?.size, '1024x1024');
  assert.strictEqual(result.arguments?.count, 2);
  assert.strictEqual(result.arguments?.prompt, input, 'the provider prompt must retain the original user text');
  assert.ok(result.evidence.size.some(value => value.includes('１０２４×１０２４')));
}

function testCapabilityRegistryFailsClosedOnConflictingParameters() {
  const result = capabilities.resolveExecutionArguments({
    operation: 'text_to_image',
    input: 'Generate a landscape image, but it must also be portrait',
  });
  assert.strictEqual(result.arguments, null);
  assert.strictEqual(result.conflicts[0].name, 'size');
  assert.ok(capabilities.clarificationQuestion(result).length > 0);
}

function testCapabilityRegistryEnforcesOperationBindingSemantics() {
  const target = key => ({ key, type: 'image', role: 'target', resource_id: `res:image:${key}`, source: 'current' });
  const reference = key => ({ key, type: 'image', role: 'reference', resource_id: `res:image:${key}`, source: 'current' });
  assert.strictEqual(capabilities.validateExecutionBindings('edit_image', [target('r1')]), true);
  assert.strictEqual(capabilities.validateExecutionBindings('edit_image', [target('r1'), target('r2')]), false);
  assert.strictEqual(capabilities.validateExecutionBindings('edit_image', [reference('r1')]), false);
  assert.strictEqual(capabilities.validateExecutionBindings('image_reference_gen', [target('r1')]), false);
  assert.strictEqual(capabilities.validateExecutionBindings('image_reference_gen', [reference('r1')]), true);
  assert.strictEqual(capabilities.validateExecutionBindings('file_qa', []), false);
  assert.strictEqual(capabilities.validateExecutionBindings('plain_chat', []), true);
  assert.throws(
    () => capabilities.assertExecutionBindings('edit_image', [target('r1'), target('r2')]),
    error => error.code === 'EXECUTION_BINDING_CONTRACT_INVALID'
      && error.issues.some(issue => issue.code === 'binding_cardinality'),
  );
}

function testDispatchContractIsStableValidatedAndImmutable() {
  const first = compile({ operation: 'plain_chat', input: 'Explain this code' });
  const second = compile({ operation: 'plain_chat', input: 'Explain this code' });
  assert.strictEqual(first.schema_version, 'dispatch_contract.v1');
  assert.strictEqual(first.api, 'chat');
  assert.strictEqual(first.idempotency_key, second.idempotency_key);
  assert.strictEqual(dispatchContract.hasExactDispatchContract(first), true);
  assert.strictEqual(Object.isFrozen(first), true);
  assert.strictEqual(Object.isFrozen(first.arguments), true);
}

function testDispatchContractRejectsTampering() {
  const plan = compile({ operation: 'plain_chat', input: 'Hello' });
  const tampered = { ...plan, operation: 'text_to_image' };
  assert.strictEqual(dispatchContract.hasExactDispatchContract(tampered), false);
  assert.throws(() => dispatchContract.assertPayloadMatchesDispatchContract(tampered, { payload: {}, transportApi: 'chat' }), /Invalid dispatch_contract/);
}

function testChatPayloadMustContainPlannedPromptAndBindings() {
  const resource = { key: 'r1', type: 'image', source: 'current', role: 'source', index: 1, id: 'img-1', resource_id: 'res:image:img-1', reference_id: '', missing: false };
  const media = executionMedia('image_qa', { images: [{ ...resource, resourceId: resource.resource_id }] });
  const plan = compile({ operation: 'image_qa', resources: [resource], input: 'What is in this image?' });
  const payload = { messages: [{ role: 'user', content: [{ type: 'text', text: 'What is in this image?' }, { type: 'image_url', image_url: { url: 'data:image/png;base64,AA==' } }] }] };
  const bindingEvidence = dispatchContract.bindingEvidenceFromMedia(media);
  assert.strictEqual(dispatchContract.assertPayloadMatchesDispatchContract(plan, { payload, transportApi: 'chat', bindingEvidence }), true);
  assert.throws(() => dispatchContract.assertPayloadMatchesDispatchContract(plan, { payload, transportApi: 'chat', bindingEvidence: [] }), /binding evidence/);
  assert.throws(() => dispatchContract.assertPayloadMatchesDispatchContract(plan, { payload: { messages: [{ role: 'user', content: 'A different question' }] }, transportApi: 'chat', bindingEvidence }), /user instruction/);
}

function testImagePayloadMustMatchArgumentsAndStableBindings() {
  const resource = { key: 'r1', type: 'image', source: 'current', role: 'target', index: 1, id: 'img-1', resource_id: 'res:image:img-1', reference_id: '', missing: false };
  const media = executionMedia('edit_image', { images: [{ ...resource, resourceId: resource.resource_id }] });
  const prompt = 'Keep the subject, use a transparent background, export webp';
  const plan = compile({ operation: 'edit_image', resources: [resource], input: prompt });
  const payload = { prompt, background: 'transparent', output_format: 'webp' };
  const files = [{ routeResourceKey: 'r1', routeRole: 'target', routeResourceId: 'res:image:img-1', routeSource: 'current' }];
  const bindingEvidence = dispatchContract.bindingEvidenceFromMedia(media);
  assert.strictEqual(dispatchContract.assertPayloadMatchesDispatchContract(plan, { payload, mode: 'edit_image', files, masks: [], bindingEvidence }), true);
  assert.throws(() => dispatchContract.assertPayloadMatchesDispatchContract(plan, { payload, mode: 'edit_image', files, masks: [], bindingEvidence: [] }), /binding evidence/);
  assert.throws(() => dispatchContract.assertPayloadMatchesDispatchContract(plan, { payload: { ...payload, output_format: 'png' }, mode: 'edit_image', files, masks: [], bindingEvidence }), /output_format/);
}

function testBindingEvidenceNormalizesMediaMimeTypesToResourceTypes() {
  const file = { key: 'r1', type: 'file', source: 'current', role: 'attachment', index: 1, id: 'file-1', resource_id: 'res:file:file-1', reference_id: '', missing: false };
  const image = { key: 'r2', type: 'image', source: 'current', role: 'source', index: 1, id: 'image-1', resource_id: 'res:image:image-1', reference_id: '', missing: false };
  const plan = compile({ operation: 'multimodal_qa', resources: [file, image], input: 'Read the file and describe the image' });
  const runtimeProjection = {
    files: [{ ...file, type: 'text/plain', routeResourceKey: 'r1', routeResourceId: file.resource_id, routeRole: 'attachment', routeSource: 'current' }],
    images: [{ ...image, type: 'image/png', routeResourceKey: 'r2', routeResourceId: image.resource_id, routeRole: 'source', routeSource: 'current' }],
    messages: [],
  };
  const evidence = dispatchContract.bindingEvidenceFromMedia(runtimeProjection);
  assert.deepStrictEqual(evidence, [
    { key: 'r2', type: 'image', role: 'source', resource_id: image.resource_id, source: 'current' },
    { key: 'r1', type: 'file', role: 'attachment', resource_id: file.resource_id, source: 'current' },
  ]);
  assert.strictEqual(dispatchContract.assertBindingEvidence(plan, evidence), true);
}

function testQuotedMessageBindingUsesCanonicalRuntimeRouteFields() {
  const message = {
    key: 'r1', type: 'message', source: 'quoted', role: 'context', index: 1,
    id: 'assistant-message-1', resource_id: 'res:message:assistant-message-1', reference_id: '', missing: false,
  };
  const prompt = 'Generate another image from this description';
  const plan = compile({ operation: 'text_to_image', relation: 'followup', resources: [message], input: prompt });
  const runtimeProjection = {
    images: [],
    files: [],
    messages: [{
      id: message.id,
      role: 'assistant',
      content: 'A concise description of a login page.',
      routeResourceKey: 'r1',
      routeResourceType: 'message',
      routeRole: 'context',
      routeResourceId: message.resource_id,
      routeSource: 'quoted',
    }],
  };
  const bindingEvidence = dispatchContract.bindingEvidenceFromMedia(runtimeProjection);
  assert.deepStrictEqual(bindingEvidence, [{
    key: 'r1', type: 'message', role: 'context', resource_id: message.resource_id, source: 'quoted',
  }]);
  assert.strictEqual(dispatchContract.assertBindingEvidence(plan, bindingEvidence), true);
  assert.strictEqual(dispatchContract.assertPayloadMatchesDispatchContract(plan, {
    payload: { model: 'gpt-image-2', prompt },
    mode: 'image',
    files: [],
    masks: [],
    bindingEvidence,
  }), true);
}

module.exports = [
  testCapabilityRegistryParsesTypedImageArguments,
  testCapabilityRegistryAppliesNegationAndLongestOverlapSemantics,
  testCapabilityRegistryNormalizesFullWidthSyntaxWithoutChangingThePrompt,
  testCapabilityRegistryFailsClosedOnConflictingParameters,
  testCapabilityRegistryEnforcesOperationBindingSemantics,
  testDispatchContractIsStableValidatedAndImmutable,
  testDispatchContractRejectsTampering,
  testChatPayloadMustContainPlannedPromptAndBindings,
  testImagePayloadMustMatchArgumentsAndStableBindings,
  testBindingEvidenceNormalizesMediaMimeTypesToResourceTypes,
  testQuotedMessageBindingUsesCanonicalRuntimeRouteFields,
];
