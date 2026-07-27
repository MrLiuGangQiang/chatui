'use strict';

const assert = require('assert');

const routeService = require('../../client/services/route-service');

function decision(overrides = {}) {
  return {
    schema_version: 'route_decision.v1',
    readiness: 'ready',
    operation: 'plain_chat',
    relation: 'new',
    bindings: [],
    changes: [],
    constraints: [],
    clarification: { question: '', unresolved: [] },
    confidence: 0.95,
    rationale: 'semantic route decision',
    ...overrides,
  };
}

function currentResources() {
  return {
    input: '编辑第1张图片并执行要求',
    context: {},
    attachments: [
      { id: 'img-current-a', name: 'a.png', type: 'image/png', is_image: true, media_index: 1 },
      { id: 'img-current-b', name: 'b.png', type: 'image/png', is_image: true, media_index: 2 },
      { id: 'file-current-a', name: 'a.txt', type: 'text/plain', is_image: false, media_index: 1, has_extracted_text: true },
    ],
  };
}

function historicalAnimalOptions(images = []) {
  return {
    input: '把狗的颜色换一下',
    attachments: [],
    context: {
      image_candidates: images.map((image, index) => ({
        index: index + 1,
        source_index: 1,
        source: 'history',
        target: 'previous',
        image_id: image.id,
        reference_id: `${image.id}-ref`,
        description: image.description,
        labels: image.labels,
      })),
    },
  };
}

function testCompactDecisionCompilesEveryOperationToCanonicalExecution() {
  const options = currentResources();
  const cases = [
    ['plain_chat', [], 'chat', 'chat'],
    ['text_to_image', [], 'image', 'image_generation'],
    ['file_qa', [{ candidate_key: 'f1', role: 'attachment' }], 'chat', 'chat'],
    ['multimodal_qa', [{ candidate_key: 'i1', role: 'source' }, { candidate_key: 'f1', role: 'attachment' }], 'chat', 'chat'],
    ['image_qa', [{ candidate_key: 'i1', role: 'source' }], 'chat', 'vision'],
    ['ocr', [{ candidate_key: 'i1', role: 'source' }], 'chat', 'vision'],
    ['image_compare', [{ candidate_key: 'i1', role: 'compare_a' }, { candidate_key: 'i2', role: 'compare_b' }], 'chat', 'vision'],
    ['edit_image', [{ candidate_key: 'i1', role: 'target' }], 'edit_image', 'image_edit'],
    ['image_reference_gen', [{ candidate_key: 'i1', role: 'reference' }, { candidate_key: 'i2', role: 'style_reference' }], 'image', 'image_edit'],
  ];

  for (const [operation, bindings, mode, api] of cases) {
    const semantic = decision({ operation, bindings });
    const inspected = routeService.inspectRouteResult(JSON.stringify(semantic), options);
    assert.ok(inspected.route, `${operation} must compile into an executable task contract`);
    assert.strictEqual(inspected.route.taskContract.schema_version, 'task_contract.v5');
    assert.strictEqual(inspected.route.operationType, operation);
    assert.strictEqual(inspected.route.mode, mode);
    assert.strictEqual(inspected.route.api, api);
    assert.deepStrictEqual(inspected.route.routeDecision, semantic);
    assert.strictEqual(routeService.isRouteDispatchable(inspected.route), true);
  }
}

function testQuotedTextDecisionCompilesMessageIdentityAndPromptOnce() {
  const options = {
    input: '基于这个描述再生成一张图片',
    attachments: [],
    context: {
      quoted_message: { index: 1, id: 'quoted-cat', role: 'assistant', content: '银白色带灰色条纹的小猫坐在木地板上。' },
      recent_messages: [{ index: 1, id: 'quoted-cat', role: 'assistant', content: '银白色带灰色条纹的小猫坐在木地板上。' }],
    },
  };
  const payload = JSON.parse(routeService.buildRoutePayload({ model: 'router', ...options }).messages[1].content);
  assert.deepStrictEqual(payload.resource_candidates, [{ candidate_key: 'm1', type: 'message', source: 'quoted', label: '银白色带灰色条纹的小猫坐在木地板上。' }]);

  const semantic = decision({
    operation: 'text_to_image',
    relation: 'followup',
    bindings: [{ candidate_key: 'm1', role: 'context' }],
  });
  const route = routeService.inspectRouteResult(JSON.stringify(semantic), options).route;
  assert.ok(route);
  assert.deepStrictEqual(route.taskContract.resources, [{
    key: 'r1', type: 'message', source: 'quoted', role: 'context', index: 1,
    id: 'quoted-cat', reference_id: '', missing: false,
  }]);
  assert.deepStrictEqual(route.taskContract.directive, {
    mode: 'patch', base_resource_keys: ['r1'], unmentioned_policy: 'preserve', operations: [], constraints: [],
  });
  assert.ok(route.contextualImagePrompt.startsWith('银白色带灰色条纹的小猫坐在木地板上。'));
  assert.ok(route.contextualImagePrompt.endsWith(options.input));

  const omitted = decision({ operation: 'text_to_image', relation: 'new' });
  assert.strictEqual(routeService.inspectRouteResult(JSON.stringify(omitted), options).reason, 'resource_binding');
}

function testQuotedPlainChatDecisionUsesTheSameCanonicalMessageSource() {
  const options = {
    input: '把这段话改得更简洁',
    attachments: [],
    context: {
      quoted_message: { index: 7, id: 'quoted-paragraph', role: 'assistant', content: '这是一段需要压缩的较长文字。' },
      recent_messages: [{ index: 7, id: 'quoted-paragraph', role: 'assistant', content: '这是一段需要压缩的较长文字。' }],
    },
  };
  const semantic = decision({
    operation: 'plain_chat',
    relation: 'followup',
    bindings: [{ candidate_key: 'm1', role: 'context' }],
  });
  const inspected = routeService.inspectRouteResult(JSON.stringify(semantic), options);
  assert.ok(inspected.route, 'an explicitly quoted text message must compile for ordinary chat as well as image generation');
  assert.strictEqual(inspected.route.api, 'chat');
  assert.deepStrictEqual(inspected.route.taskContract.resources, [{
    key: 'r1', type: 'message', source: 'quoted', role: 'context', index: 7,
    id: 'quoted-paragraph', reference_id: '', missing: false,
  }]);
}

function testCompilerEnforcesOnlyAnExplicitFixedProductMode() {
  const semantic = decision({ operation: 'text_to_image' });
  const automatic = routeService.inspectRouteResult(JSON.stringify(semantic), {
    input: '画一只中国的猫', currentMode: 'edit_image', autoMode: true,
  });
  assert.ok(automatic.route, 'automatic routing must ignore the previous task mode');
  assert.strictEqual(automatic.route.mode, 'image');

  const fixedConflict = routeService.inspectRouteResult(JSON.stringify(semantic), {
    input: '画一只中国的猫', currentMode: 'edit_image', autoMode: false,
  });
  assert.strictEqual(fixedConflict.route, null);
  assert.strictEqual(fixedConflict.reason, 'mode_conflict');

  const declaredConflict = decision({
    readiness: 'needs_clarification',
    operation: 'text_to_image',
    clarification: {
      question: '当前固定功能与请求不一致，请调整固定功能或重述任务。',
      unresolved: [{ type: 'text', role: 'source', reason: 'missing', candidate_keys: [] }],
    },
  });
  const clarification = routeService.inspectRouteResult(JSON.stringify(declaredConflict), {
    input: '画一只中国的猫', currentMode: 'edit_image', autoMode: false,
  });
  assert.ok(clarification.route);
  assert.strictEqual(clarification.route.api, 'clarify');
  assert.strictEqual(clarification.route.dispatchAuthorized, false);
}

function testCompilerKeepsUnavailableAndAttachmentOnlyTurnsNonExecuting() {
  const unavailableOptions = {
    input: '总结这个文件',
    attachments: [{ id: 'scan', name: 'scan.pdf', type: 'application/pdf', is_image: false, media_index: 1, has_extracted_text: false, unsupported_reason: '未提取到正文' }],
    context: {},
  };
  const inventedBinding = decision({ operation: 'file_qa', bindings: [{ candidate_key: 'f1', role: 'attachment' }] });
  assert.strictEqual(routeService.inspectRouteResult(JSON.stringify(inventedBinding), unavailableOptions).reason, 'resource_binding');

  const unavailable = decision({
    readiness: 'needs_clarification',
    operation: 'file_qa',
    clarification: {
      question: '该文件无法读取，请重新上传可解析格式。',
      unresolved: [{ type: 'file', role: 'attachment', reason: 'unavailable', candidate_keys: [] }],
    },
  });
  const unavailableRoute = routeService.inspectRouteResult(JSON.stringify(unavailable), unavailableOptions).route;
  assert.ok(unavailableRoute);
  assert.strictEqual(unavailableRoute.dispatchAuthorized, false);
  assert.deepStrictEqual(unavailableRoute.taskContract.resources, []);
  assert.deepStrictEqual(unavailableRoute.taskContract.clarification.unresolved_resources[0].choices, []);

  const imageOnlyOptions = {
    input: '',
    attachments: [{ id: 'photo', name: 'photo.png', type: 'image/png', is_image: true, media_index: 1 }],
    context: {},
  };
  const attachmentOnly = decision({
    readiness: 'needs_clarification',
    operation: 'image_qa',
    bindings: [{ candidate_key: 'i1', role: 'source' }],
    clarification: {
      question: '请说明要对这张图片执行什么任务。',
      unresolved: [{ type: 'text', role: 'source', reason: 'missing', candidate_keys: [] }],
    },
  });
  const attachmentOnlyRoute = routeService.inspectRouteResult(JSON.stringify(attachmentOnly), imageOnlyOptions).route;
  assert.ok(attachmentOnlyRoute);
  assert.strictEqual(attachmentOnlyRoute.dispatchAuthorized, false);
  assert.strictEqual(attachmentOnlyRoute.taskContract.resources[0].id, 'photo');
}

function testCompilerDowngradesAnUnjustifiedSingleImageChoiceToClarification() {
  const options = historicalAnimalOptions([
    { id: 'dog-a', description: '草地上的金毛犬', labels: ['dog'] },
    { id: 'dog-b', description: '客厅里的拉布拉多犬', labels: ['dog'] },
    { id: 'cat-a', description: '窗边的猫', labels: ['cat'] },
  ]);
  const unjustified = decision({
    operation: 'edit_image',
    relation: 'followup',
    bindings: [{ candidate_key: 'i1', role: 'target' }],
  });
  const guarded = routeService.inspectRouteResult(JSON.stringify(unjustified), options).route;
  assert.ok(guarded);
  assert.strictEqual(guarded.api, 'clarify');
  assert.strictEqual(guarded.dispatchAuthorized, false);
  assert.strictEqual(guarded.taskContract.operation, 'edit_image');
  assert.deepStrictEqual(guarded.taskContract.review_reasons, ['ambiguous_target_selection']);
  assert.deepStrictEqual(
    guarded.taskContract.clarification.unresolved_resources[0].choices.map(choice => choice.id),
    ['dog-a', 'dog-b'],
    'the compiler must offer matching dog candidates without pulling in the unrelated cat',
  );
  assert.doesNotMatch(guarded.clarificationQuestion, /全部|所有|都要/);

  const multipleTargets = decision({
    operation: 'edit_image',
    relation: 'followup',
    bindings: [{ candidate_key: 'i1', role: 'target' }, { candidate_key: 'i2', role: 'target' }],
    changes: [{ op: 'replace', target: 'dog color', value: 'black' }],
  });
  const multipleTargetRoute = routeService.inspectRouteResult(JSON.stringify(multipleTargets), options).route;
  assert.ok(multipleTargetRoute);
  assert.strictEqual(multipleTargetRoute.api, 'clarify');
  assert.deepStrictEqual(
    multipleTargetRoute.taskContract.clarification.unresolved_resources[0].choices.map(choice => choice.id),
    ['dog-a', 'dog-b'],
    'multiple edit targets must become a single-choice clarification instead of a multi-image edit',
  );

  const explicitSecond = decision({
    operation: 'edit_image',
    relation: 'followup',
    bindings: [{ candidate_key: 'i2', role: 'target' }],
    changes: [{ op: 'replace', target: '狗的颜色', value: '黑色' }],
  });
  const explicitRoute = routeService.inspectRouteResult(JSON.stringify(explicitSecond), {
    ...options, input: '把第2张狗的颜色改成黑色',
  }).route;
  assert.ok(explicitRoute);
  assert.strictEqual(explicitRoute.api, 'image_edit');
  assert.strictEqual(explicitRoute.taskContract.readiness, 'ready');
  assert.deepStrictEqual(explicitRoute.selectedImageIds, ['dog-b']);

  const uniqueSubjectOptions = historicalAnimalOptions([
    { id: 'dog-only', description: '草地上的狗', labels: ['dog'] },
    { id: 'cat-only', description: '窗边的猫', labels: ['cat'] },
  ]);
  const uniqueDog = decision({
    operation: 'edit_image', relation: 'followup', bindings: [{ candidate_key: 'i1', role: 'target' }],
  });
  const uniqueRoute = routeService.inspectRouteResult(JSON.stringify(uniqueDog), uniqueSubjectOptions).route;
  assert.ok(uniqueRoute);
  assert.strictEqual(uniqueRoute.taskContract.readiness, 'ready', 'a uniquely matching dog must not be over-clarified merely because an unrelated cat exists');
}

function testCompilerClarifiesMissingEditValueWithoutRepairingSemantics() {
  const decisionWithMissingValue = decision({
    operation: 'edit_image',
    relation: 'correction',
    bindings: [{ candidate_key: 'i1', role: 'target' }],
    changes: [{ op: 'replace', target: 'color', value: '' }],
    rationale: 'the user wants to change the cat color',
  });
  const inspected = routeService.inspectRouteResult(JSON.stringify(decisionWithMissingValue), {
    input: 'change the cat color',
    context: {
      image_candidates: [{
        index: 1,
        source: 'history',
        image_id: 'img-cat',
        reference_id: 'imgref-cat',
        description: 'cat',
        labels: ['cat'],
      }],
    },
  });
  assert.ok(inspected.route, 'an incomplete edit must become a local clarification route');
  assert.strictEqual(inspected.route.api, 'clarify');
  assert.strictEqual(inspected.route.dispatchAuthorized, false);
  assert.strictEqual(inspected.route.taskContract.operation, 'edit_image');
  assert.strictEqual(inspected.route.taskContract.relation, 'correction');
  assert.deepStrictEqual(inspected.route.taskContract.directive.operations, []);
  assert.deepStrictEqual(inspected.route.taskContract.resources, [{
    key: 'r1', type: 'image', source: 'history', role: 'target', index: 1,
    id: 'img-cat', reference_id: 'imgref-cat', missing: false,
  }]);
  assert.deepStrictEqual(inspected.route.taskContract.clarification.unresolved_resources, [{
    key: 'r2', type: 'text', role: 'source', reason: 'missing', choices: [],
  }]);
  assert.match(inspected.route.clarificationQuestion, /目标颜色|具体效果/);
  assert.deepStrictEqual(inspected.route.taskContract.review_reasons, ['missing_change_detail']);
  assert.strictEqual(routeService.hasExactRouteDecision(decisionWithMissingValue), false);
  const schema = routeService.ROUTE_RESPONSE_FORMAT.json_schema.schema;
  const changeVariants = schema.properties.changes.items.anyOf;
  assert.ok(changeVariants.some(variant => variant.properties.value.pattern === '\\S'), 'structured output must require a non-empty add/replace value');
  const prompt = routeService.buildRoutePayload({ model: 'router', input: 'change the cat color' }).messages[0].content;
  assert.match(prompt, /value=""/);
}

function testSelfContainedImageFollowupDoesNotInheritPriorPrompt() {
  const context = {
    recent_messages: [{ index: 1, id: 'prior-dog-prompt', role: 'user', content: '画一只狗' }],
  };
  const selfContained = decision({
    operation: 'text_to_image',
    relation: 'followup',
    bindings: [{ candidate_key: 'm1', role: 'context' }],
  });
  const currentInput = '再画一只狗，换个品种';
  const currentRoute = routeService.inspectRouteResult(JSON.stringify(selfContained), { input: currentInput, context }).route;
  assert.ok(currentRoute);
  assert.strictEqual(currentRoute.api, 'image_generation');
  assert.strictEqual(currentRoute.relation, 'followup');
  assert.deepStrictEqual(currentRoute.taskContract.resources, []);
  assert.deepStrictEqual(currentRoute.taskContract.directive, {
    mode: 'standalone', base_resource_keys: [], unmentioned_policy: 'allow_change', operations: [], constraints: [],
  });
  assert.deepStrictEqual(currentRoute.taskContract.review_reasons, ['redundant_history_text_binding']);
  assert.strictEqual(currentRoute.contextualImagePrompt, currentInput);
  assert.doesNotMatch(currentRoute.contextualImagePrompt, /画一只狗\s+再画一只狗/);

  const dependentInput = '再生成一张';
  const dependentRoute = routeService.inspectRouteResult(JSON.stringify(selfContained), { input: dependentInput, context }).route;
  assert.ok(dependentRoute);
  assert.strictEqual(dependentRoute.taskContract.resources.length, 1);
  assert.match(dependentRoute.contextualImagePrompt, /^画一只狗\s+再生成一张$/);
}

function testDecisionCompilerBuildsClarificationChoicesWithoutModelAuthoredIds() {
  const options = {
    input: '用之前的鱼图再生成一张',
    attachments: [],
    context: {
      image_candidates: [
        { index: 1, source_index: 1, source: 'history', image_id: 'fish-a', reference_id: 'fish-a-ref', description: '鱼 A' },
        { index: 2, source_index: 1, source: 'history', image_id: 'fish-b', reference_id: 'fish-b-ref', description: '鱼 B' },
      ],
    },
  };
  const semantic = decision({
    readiness: 'needs_clarification',
    operation: 'image_reference_gen',
    relation: 'followup',
    clarification: {
      question: '请选择要使用的鱼图。',
      unresolved: [{ type: 'image', role: 'reference', reason: 'ambiguous', candidate_keys: ['i1', 'i2'] }],
    },
  });
  const route = routeService.inspectRouteResult(JSON.stringify(semantic), options).route;
  assert.ok(route);
  assert.strictEqual(route.api, 'clarify');
  assert.strictEqual(route.dispatchAuthorized, false);
  assert.deepStrictEqual(route.taskContract.directive.base_resource_keys, ['r1']);
  assert.deepStrictEqual(route.taskContract.clarification.unresolved_resources[0].choices.map(choice => ({
    id: choice.id, reference_id: choice.reference_id, label: choice.label,
  })), [
    { id: 'fish-a', reference_id: 'fish-a-ref', label: '鱼 A' },
    { id: 'fish-b', reference_id: 'fish-b-ref', label: '鱼 B' },
  ]);
}

function testDecisionBoundaryRejectsInventedKeysRolesAndSemanticRepairDrift() {
  const options = currentResources();
  const invented = decision({ operation: 'image_qa', bindings: [{ candidate_key: 'i9', role: 'source' }] });
  assert.strictEqual(routeService.inspectRouteResult(JSON.stringify(invented), options).reason, 'resource_binding');

  const wrongRole = decision({ operation: 'file_qa', bindings: [{ candidate_key: 'f1', role: 'source' }] });
  assert.strictEqual(routeService.inspectRouteResult(JSON.stringify(wrongRole), options).reason, 'resource_binding');

  const extra = { ...decision(), task_contract: {} };
  assert.strictEqual(routeService.hasExactRouteDecision(extra), false);

  const malformed = decision({
    operation: 'edit_image',
    bindings: [{ candidate_key: 'i1', role: 'target' }],
    changes: [{ op: 'replace', target: '背景', value: '海边' }],
    constraints: ['保持主体不变'],
  });
  delete malformed.rationale;
  const invariants = routeService.repairInvariantSnapshot(JSON.stringify(malformed));
  assert.strictEqual(invariants.protocol, 'route_decision.v1');
  const repaired = { ...malformed, rationale: 'edit the selected image' };
  assert.strictEqual(routeService.repairPreservesInvariants(invariants, { routeDecision: repaired }), true);
  const drifted = { ...repaired, bindings: [{ candidate_key: 'i1', role: 'reference' }] };
  assert.strictEqual(routeService.repairPreservesInvariants(invariants, { routeDecision: drifted }), false);
  const constraintDrift = { ...repaired, constraints: ['允许改变主体'] };
  assert.strictEqual(routeService.repairPreservesInvariants(invariants, { routeDecision: constraintDrift }), false);
  const missingSemanticFingerprint = { ...malformed };
  delete missingSemanticFingerprint.constraints;
  assert.strictEqual(routeService.repairInvariantSnapshot(missingSemanticFingerprint), null);
}

module.exports = [
  testCompactDecisionCompilesEveryOperationToCanonicalExecution,
  testQuotedTextDecisionCompilesMessageIdentityAndPromptOnce,
  testQuotedPlainChatDecisionUsesTheSameCanonicalMessageSource,
  testCompilerEnforcesOnlyAnExplicitFixedProductMode,
  testCompilerKeepsUnavailableAndAttachmentOnlyTurnsNonExecuting,
  testCompilerDowngradesAnUnjustifiedSingleImageChoiceToClarification,
  testCompilerClarifiesMissingEditValueWithoutRepairingSemantics,
  testSelfContainedImageFollowupDoesNotInheritPriorPrompt,
  testDecisionCompilerBuildsClarificationChoicesWithoutModelAuthoredIds,
  testDecisionBoundaryRejectsInventedKeysRolesAndSemanticRepairDrift,
];
