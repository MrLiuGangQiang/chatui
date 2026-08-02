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
    ['edit_image', [{ candidate_key: 'i1', role: 'target' }, { candidate_key: 'i2', role: 'reference' }], 'edit_image', 'image_edit'],
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

function testReferenceGenerationPolicyUsesBoundResourceStructure() {
  const options = currentResources();
  const inspectPolicy = bindings => routeService.inspectRouteResult(JSON.stringify(decision({
    operation: 'image_reference_gen',
    bindings,
  })), options).route?.taskContract?.directive?.unmentioned_policy;

  assert.strictEqual(inspectPolicy([{ candidate_key: 'i1', role: 'reference' }]), 'preserve',
    'one full reference is a preservation baseline');
  assert.strictEqual(inspectPolicy([{ candidate_key: 'i1', role: 'style_reference' }]), 'allow_change',
    'a style-only reference must not freeze unrelated image structure');
  assert.strictEqual(inspectPolicy([
    { candidate_key: 'i1', role: 'reference' },
    { candidate_key: 'i2', role: 'reference' },
  ]), 'allow_change', 'combining multiple references must allow a newly composed result');
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

function testQuotedClarificationTextQuestionRoutesAsPlainChat() {
  const options = {
    input: '有几个颜色',
    attachments: [],
    context: {
      quoted_message: { index: 4, id: 'quoted-clarification', role: 'assistant' },
      recent_messages: [{
        index: 4, id: 'quoted-clarification', role: 'assistant',
        content: '请明确选择一种颜色，例如狸花色、橘色、白色、黑色、三花色、玳瑁色、灰色或奶牛色。',
      }],
    },
  };
  const payload = routeService.buildRoutePayload({ model: 'route-model', ...options });
  assert.ok(payload.messages[0].content.includes('询问显式引用文本本身'));
  assert.ok(payload.messages[0].content.includes('current_input="有几个颜色"'));
  assert.ok(payload.messages[0].content.includes('不得返回 edit_image'));

  const semantic = decision({
    operation: 'plain_chat', relation: 'followup',
    bindings: [{ candidate_key: 'm1', role: 'context' }],
  });
  const inspected = routeService.inspectRouteResult(JSON.stringify(semantic), options);
  assert.ok(inspected.route);
  assert.strictEqual(inspected.route.api, 'chat');
  assert.strictEqual(inspected.route.needClarification, false);
  assert.strictEqual(inspected.route.taskContract.resources[0].id, 'quoted-clarification');
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

function testNativeMarkdownDecisionCompilesWhileUnreadableFilesAndInvalidKeysStayRejected() {
  const name = '\u516c\u53f8OpenClaw\u5b89\u88c5\u8fc7\u7a0b.md';
  const nativeMarkdown = {
    id: 'native-markdown-current',
    file_id: 'native-markdown-current',
    name,
    type: 'text/markdown',
    size: 128,
    is_image: false,
    media_index: 1,
    source_index: 1,
    has_extracted_text: false,
    input_file_available: true,
  };
  const options = {
    input: '\u603b\u7ed3\u5185\u5bb9',
    attachments: [nativeMarkdown],
    context: {},
  };
  const semantic = decision({
    operation: 'file_qa',
    bindings: [{ candidate_key: 'f1', role: 'attachment' }],
    confidence: 0.99,
    rationale: '\u7528\u6237\u8bf7\u6c42\u603b\u7ed3\u672c\u8f6e\u4e0a\u4f20\u7684 Markdown \u6587\u4ef6\u5185\u5bb9\u3002',
  });

  const inspected = routeService.inspectRouteResult(JSON.stringify(semantic), options);
  assert.strictEqual(inspected.reason, '');
  assert.ok(inspected.route, 'the valid route_decision returned for a native Markdown file must compile');
  assert.strictEqual(inspected.route.operationType, 'file_qa');
  assert.strictEqual(inspected.route.api, 'chat');
  assert.strictEqual(inspected.route.dispatchAuthorized, true);
  assert.deepStrictEqual(inspected.route.taskContract.resources, [{
    key: 'r1',
    type: 'file',
    source: 'current',
    role: 'attachment',
    index: 1,
    id: 'native-markdown-current',
    reference_id: '',
    missing: false,
  }]);

  const camelCaseAvailability = { ...nativeMarkdown, inputFileAvailable: true };
  delete camelCaseAvailability.input_file_available;
  assert.ok(routeService.inspectRouteResult(JSON.stringify(semantic), {
    ...options,
    attachments: [camelCaseAvailability],
  }).route, 'the camelCase availability alias must remain readable at compatibility boundaries');

  const markerWithoutContent = {
    ...nativeMarkdown,
    id: 'marker-only-file',
    file_id: 'marker-only-file',
    inputFile: true,
    input_file_available: false,
  };
  const missingContent = routeService.inspectRouteResult(JSON.stringify(semantic), {
    ...options,
    attachments: [markerWithoutContent],
  });
  assert.strictEqual(missingContent.route, null, 'inputFile marks the transport mode, not readable content');
  assert.strictEqual(missingContent.reason, 'resource_binding');

  const unsupported = {
    ...nativeMarkdown,
    id: 'unsupported-file',
    file_id: 'unsupported-file',
    input_file_available: false,
    unsupported_reason: 'Unsupported file input type',
  };
  const unsupportedResult = routeService.inspectRouteResult(JSON.stringify(semantic), {
    ...options,
    attachments: [unsupported],
  });
  assert.strictEqual(unsupportedResult.route, null);
  assert.strictEqual(unsupportedResult.reason, 'resource_binding');

  const invalidReference = decision({
    operation: 'file_qa',
    bindings: [{ candidate_key: 'f2', role: 'attachment' }],
  });
  const invalidReferenceResult = routeService.inspectRouteResult(JSON.stringify(invalidReference), options);
  assert.strictEqual(invalidReferenceResult.route, null, 'availability must not weaken exact candidate-key binding');
  assert.strictEqual(invalidReferenceResult.reason, 'resource_binding');
}

function testCompilerMapsDeclaredImageClarificationWithoutChoosingLocally() {
  const options = historicalAnimalOptions([
    { id: 'dog-a', description: '草地上的金毛犬', labels: ['dog'] },
    { id: 'dog-b', description: '客厅里的拉布拉多犬', labels: ['dog'] },
    { id: 'cat-a', description: '窗边的猫', labels: ['cat'] },
  ]);
  const declaredClarification = decision({
    readiness: 'needs_clarification',
    operation: 'edit_image',
    relation: 'followup',
    bindings: [],
    clarification: {
      question: '检测到两张狗的图片，请选择要修改的其中一张。',
      unresolved: [{ type: 'image', role: 'target', reason: 'ambiguous', candidate_keys: ['i1', 'i2'] }],
    },
  });
  const mapped = routeService.inspectRouteResult(JSON.stringify(declaredClarification), options).route;
  assert.ok(mapped);
  assert.strictEqual(mapped.api, 'clarify');
  assert.strictEqual(mapped.dispatchAuthorized, false);
  assert.strictEqual(mapped.taskContract.operation, 'edit_image');
  assert.deepStrictEqual(mapped.taskContract.review_reasons, []);
  assert.deepStrictEqual(
    mapped.taskContract.clarification.unresolved_resources[0].choices.map(choice => choice.id),
    ['dog-a', 'dog-b'],
    'the compiler must map exactly the candidates selected by the first route decision',
  );
  assert.doesNotMatch(mapped.clarificationQuestion, /全部|所有|都要/);

  const multipleTargets = decision({
    operation: 'edit_image',
    relation: 'followup',
    bindings: [{ candidate_key: 'i1', role: 'target' }, { candidate_key: 'i2', role: 'target' }],
    changes: [{ op: 'replace', target: 'dog color', value: 'black' }],
  });
  const rejectedMultipleTargets = routeService.inspectRouteResult(JSON.stringify(multipleTargets), options);
  assert.strictEqual(rejectedMultipleTargets.route, null, 'the compiler must reject multiple edit targets instead of rewriting them');

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

function testCompilerRejectsMissingEditValueWithoutLocalClarification() {
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
  assert.strictEqual(inspected.route, null, 'an incomplete change must be rejected rather than converted into a local clarification');
  assert.strictEqual(routeService.hasExactRouteDecision(decisionWithMissingValue), false);

  const declaredClarification = decision({
    readiness: 'needs_clarification',
    operation: 'edit_image',
    relation: 'correction',
    bindings: [{ candidate_key: 'i1', role: 'target' }],
    changes: [],
    clarification: {
      question: '请补充目标颜色或具体效果。',
      unresolved: [{ type: 'text', role: 'source', reason: 'missing', candidate_keys: [] }],
    },
  });
  const declared = routeService.inspectRouteResult(JSON.stringify(declaredClarification), {
    input: 'change the cat color',
    context: {
      image_candidates: [{
        index: 1, source: 'history', image_id: 'img-cat', reference_id: 'imgref-cat', description: 'cat', labels: ['cat'],
      }],
    },
  }).route;
  assert.ok(declared);
  assert.strictEqual(declared.api, 'clarify');
  assert.deepStrictEqual(declared.taskContract.review_reasons, []);
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
    bindings: [],
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
  assert.deepStrictEqual(currentRoute.taskContract.review_reasons, []);
  assert.strictEqual(currentRoute.contextualImagePrompt, currentInput);
  assert.doesNotMatch(currentRoute.contextualImagePrompt, /画一只狗\s+再画一只狗/);

  const dependentInput = '再生成一张';
  const dependent = decision({
    operation: 'text_to_image', relation: 'followup', bindings: [{ candidate_key: 'm1', role: 'context' }],
  });
  const dependentRoute = routeService.inspectRouteResult(JSON.stringify(dependent), { input: dependentInput, context }).route;
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

function testEditClarificationPreservesTargetAndSelectedReferenceWithoutSemanticDrift() {
  const options = {
    input: '不是这只猫，替换成你生成的猫',
    attachments: [],
    context: {
      image_candidates: [
        { index: 1, source: 'history', image_id: 'composite-cat', reference_id: 'composite-cat-ref', filename: 'composite.png' },
        { index: 2, source: 'history', image_id: 'persian-cat', reference_id: 'persian-cat-ref', filename: 'persian.png' },
        { index: 3, source: 'history', image_id: 'original-cat', reference_id: 'original-cat-ref', filename: 'original.png' },
      ],
    },
  };
  const semantic = decision({
    readiness: 'needs_clarification',
    operation: 'edit_image',
    relation: 'continuation',
    bindings: [{ candidate_key: 'i1', role: 'target' }],
    changes: [{ op: 'replace', target: '目标图中的猫', value: '用户选择的参考猫' }],
    clarification: {
      question: '请确认要替换成哪一张猫图。',
      unresolved: [{ type: 'image', role: 'reference', reason: 'ambiguous', candidate_keys: ['i2', 'i3'] }],
    },
  });
  const pending = routeService.inspectRouteResult(JSON.stringify(semantic), options).route;
  assert.ok(pending, 'target-plus-reference edits must remain a valid pending task contract');
  assert.ok(pending.taskContract);
  assert.strictEqual(pending.clarificationDegraded, undefined);
  assert.strictEqual(routeService.isRouteDispatchable(pending), false);
  assert.deepStrictEqual(pending.taskContract.resources.map(resource => [resource.id, resource.role]), [
    ['composite-cat', 'target'],
  ]);
  assert.deepStrictEqual(pending.taskContract.directive.base_resource_keys, ['r1', 'r2']);
  assert.strictEqual(pending.taskContract.directive.unmentioned_policy, 'preserve');
  assert.deepStrictEqual(pending.taskContract.clarification.unresolved_resources[0].choices.map(choice => ({
    id: choice.id, role: pending.taskContract.clarification.unresolved_resources[0].role,
  })), [
    { id: 'persian-cat', role: 'reference' },
    { id: 'original-cat', role: 'reference' },
  ]);

  const slot = pending.taskContract.clarification.unresolved_resources[0];
  const selected = slot.choices[1];
  const readySemantic = decision({
    operation: 'edit_image',
    relation: 'continuation',
    bindings: [
      { candidate_key: 'i1', role: 'target' },
      { candidate_key: 'i3', role: 'reference' },
    ],
    changes: semantic.changes,
  });
  const readyOptions = {
    ...options,
    context: {
      ...options.context,
      clarification_context: {
        schema_version: 'clarification_context.v1',
        base_task: options.input,
        clarification_question: semantic.clarification.question,
        prior_task_contract: pending.taskContract,
        unresolved_resources: pending.taskContract.clarification.unresolved_resources,
        current_answer: '2',
        resolved_input: options.input,
        continuation_relation: 'pending_answer',
        selected_choices: [{
          resource_key: slot.key,
          choice_key: selected.key,
          type: slot.type,
          role: slot.role,
          source: selected.source,
          index: selected.index,
          id: selected.id,
          reference_id: selected.reference_id,
          label: selected.label,
        }],
        explicit_quote_text: '',
        attachments: { current: [], quoted: [], prior_sources: [] },
        source_policy: 'test',
      },
    },
  };
  const ready = routeService.inspectRouteResult(JSON.stringify(readySemantic), readyOptions).route;
  assert.ok(ready, 'the completed selection must compile without a repair/fallback route');
  assert.strictEqual(routeService.isRouteDispatchable(ready), true);
  assert.deepStrictEqual(ready.taskContract.resources.map(resource => [resource.id, resource.role]), [
    ['composite-cat', 'target'],
    ['original-cat', 'reference'],
  ]);
  assert.strictEqual(ready.routeDecision.bindings[1].role, 'reference');

  const reversedInputs = structuredClone(readySemantic);
  reversedInputs.bindings.reverse();
  const rejectedReversedInputs = routeService.inspectRouteResult(JSON.stringify(reversedInputs), readyOptions);
  assert.strictEqual(rejectedReversedInputs.route, null,
    'the edit target must remain the first multipart image input');

  const roleDrift = structuredClone(readySemantic);
  roleDrift.bindings[1].role = 'style_reference';
  const rejectedRoleDrift = routeService.inspectRouteResult(JSON.stringify(roleDrift), readyOptions);
  assert.strictEqual(rejectedRoleDrift.route, null,
    'a completed selection must not weaken the compiler-owned reference role merely to avoid a retry');
  assert.strictEqual(rejectedRoleDrift.reason, 'resource_binding');
}

function testDegradedClarificationRetainsCompilerValidatedChoicesWithoutAuthorizingExecution() {
  const options = {
    input: '分析目标图，但先确认参考图',
    attachments: [],
    context: {
      image_candidates: [
        { index: 1, source: 'history', image_id: 'source-image', reference_id: 'source-image-ref', filename: 'source.png' },
        { index: 2, source: 'history', image_id: 'reference-a', reference_id: 'reference-a-ref', filename: 'a.png' },
        { index: 3, source: 'history', image_id: 'reference-b', reference_id: 'reference-b-ref', filename: 'b.png' },
      ],
    },
  };
  const semantic = decision({
    readiness: 'needs_clarification',
    operation: 'image_qa',
    relation: 'continuation',
    bindings: [{ candidate_key: 'i1', role: 'source' }],
    clarification: {
      question: '请选择参考图。',
      // image_qa cannot consume a reference role. Candidate identities are
      // compiler-valid, but operation semantics still fail closed.
      unresolved: [{ type: 'image', role: 'reference', reason: 'ambiguous', candidate_keys: ['i2', 'i3'] }],
    },
  });
  const inspected = routeService.inspectRouteResult(JSON.stringify(semantic), options);
  assert.ok(inspected.route, 'a declared clarification remains a successful non-executing route');
  assert.strictEqual(inspected.route.taskContract, null);
  assert.strictEqual(inspected.route.clarificationDegraded, true);
  assert.strictEqual(routeService.isRouteDispatchable(inspected.route), false);
  assert.deepStrictEqual(inspected.route.clarificationSlots, [{
    key: 'r2', type: 'image', role: 'reference', reason: 'ambiguous',
    choices: [
      { key: 'c1', source: 'history', index: 2, id: 'reference-a', reference_id: 'reference-a-ref', label: 'a.png' },
      { key: 'c2', source: 'history', index: 3, id: 'reference-b', reference_id: 'reference-b-ref', label: 'b.png' },
    ],
  }], 'compiler-validated candidate identities must survive only as clarification display/selection data');

  const invented = structuredClone(semantic);
  invented.clarification.unresolved[0].candidate_keys = ['i2', 'i9'];
  const rejected = routeService.inspectRouteResult(JSON.stringify(invented), options);
  assert.strictEqual(rejected.route, null, 'an invented candidate key must still fail before any degraded slot is retained');
  assert.strictEqual(rejected.reason, 'resource_binding');
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

function currentGifOptions(historyCount = 0) {
  const input = '识别这是什么';
  const transientId = 'gif-current-transient';
  const durableId = 'img_imgref_uploaded_current_1';
  const currentMessageIndex = historyCount + 1;
  const recentMessages = Array.from({ length: historyCount }, (_, index) => ({
    index: index + 1,
    role: 'user',
    content: `历史图片 ${index + 1}`,
  }));
  recentMessages.push({
    index: currentMessageIndex,
    role: 'user',
    content: `${input}\n\n[image id=${transientId} name=路飞2.gif type=image/gif size=128]`,
  });
  const historicalCandidates = Array.from({ length: historyCount }, (_, index) => ({
    index: index + 1,
    source_index: 1,
    message_index: index + 1,
    image_id: `history-image-${index + 1}`,
    reference_id: `history-reference-${index + 1}`,
    source: 'user_message',
    target: 'uploaded',
    filename: `history-${index + 1}.png`,
  }));
  const currentCandidate = {
    index: historyCount + 1,
    source_index: 1,
    message_index: currentMessageIndex,
    image_id: durableId,
    reference_id: 'imgref_uploaded_current',
    source: 'user_message',
    target: 'uploaded',
    filename: '路飞2.gif',
  };
  return {
    input,
    transientId,
    durableId,
    context: {
      recent_messages: recentMessages,
      image_candidates: [...historicalCandidates, currentCandidate],
    },
    currentTurn: { messageIndex: currentMessageIndex },
    attachments: [{
      index: 1,
      source_index: 1,
      media_index: 1,
      id: transientId,
      image_id: transientId,
      name: '路飞2.gif',
      type: 'image/gif',
      size: 128,
      is_image: true,
    }],
  };
}

function testCurrentGifDecisionCanonicalizesIdentityAndDispatches() {
  const options = currentGifOptions();
  const payload = JSON.parse(routeService.buildRoutePayload({ model: 'router', ...options }).messages[1].content);
  assert.deepStrictEqual(payload.resource_candidates, [{
    candidate_key: 'i1', type: 'image', source: 'current', label: '路飞2.gif',
  }], 'the persisted copy of the current GIF must not duplicate its attachment candidate');

  const semantic = decision({
    operation: 'image_qa',
    bindings: [{ candidate_key: 'i1', role: 'source' }],
  });
  const inspected = routeService.inspectRouteResult(JSON.stringify(semantic), options);
  assert.ok(inspected.route);
  assert.strictEqual(inspected.reason, '');
  assert.strictEqual(inspected.route.taskContract.resources[0].id, options.durableId);
  assert.ok(inspected.route.executionResources.images[0].identity_aliases.includes(options.transientId));
  assert.strictEqual(routeService.isRouteDispatchable(inspected.route), true,
    'a uniquely resolved current GIF alias must pass the canonical dispatch gate');
}

function testExistingImageHistoryKeepsCurrentGifCandidateStable() {
  const options = currentGifOptions(4);
  const payload = JSON.parse(routeService.buildRoutePayload({ model: 'router', ...options }).messages[1].content);
  assert.deepStrictEqual(payload.resource_candidates.filter(candidate => candidate.type === 'image').map(candidate => ({
    key: candidate.candidate_key,
    source: candidate.source,
    label: candidate.label,
  })), [
    { key: 'i1', source: 'history', label: 'history-1.png' },
    { key: 'i2', source: 'history', label: 'history-2.png' },
    { key: 'i3', source: 'history', label: 'history-3.png' },
    { key: 'i4', source: 'history', label: 'history-4.png' },
    { key: 'i5', source: 'current', label: '路飞2.gif' },
  ]);

  const semantic = decision({
    operation: 'image_qa',
    relation: 'followup',
    bindings: [{ candidate_key: 'i5', role: 'source' }],
  });
  const inspected = routeService.inspectRouteResult(JSON.stringify(semantic), options);
  assert.ok(inspected.route, 'the model-selected current i5 GIF must retain its binding after context compaction');
  assert.strictEqual(inspected.reason, '');
  assert.strictEqual(inspected.route.taskContract.resources[0].id, options.durableId);
  assert.strictEqual(routeService.isRouteDispatchable(inspected.route), true);
}


function attachmentOnlyCurrentOptions() {
  const transientId = 'attachment-only-transient';
  const durableId = 'img_imgref_uploaded_attachment_only_1';
  return {
    input: '',
    transientId,
    durableId,
    currentTurn: { messageIndex: 1, messageId: 'current-attachment-turn' },
    context: {
      recent_messages: [{ index: 1, id: 'current-attachment-turn', role: 'user', content: '[image attachment]' }],
      image_candidates: [{
        index: 1,
        source_index: 1,
        message_index: 1,
        image_id: durableId,
        reference_id: 'imgref_uploaded_attachment_only',
        source: 'user_message',
        target: 'uploaded',
        filename: 'only.png',
      }],
    },
    attachments: [{
      index: 1,
      source_index: 1,
      media_index: 1,
      id: transientId,
      image_id: transientId,
      name: 'only.png',
      type: 'image/png',
      size: 64,
      is_image: true,
    }],
  };
}

function testAttachmentOnlyCurrentTurnUsesOneCurrentCandidateAndNoHistoryMessage() {
  const options = attachmentOnlyCurrentOptions();
  const payload = JSON.parse(routeService.buildRoutePayload({ model: 'router', ...options }).messages[1].content);
  assert.deepStrictEqual(payload.resource_candidates, [{
    candidate_key: 'i1', type: 'image', source: 'current', label: 'only.png',
  }]);
  assert.ok(!payload.context?.recent_messages, 'the current attachment-only message must not be exposed again as historical context');
  assert.ok(!payload.context?.image_candidates, 'the persisted copy of the current upload must be removed before cataloguing attachments');

  const trimmedPayload = JSON.parse(routeService.buildRoutePayload({
    model: 'router', ...options, context: { ...options.context, recent_messages: [] },
  }).messages[1].content);
  assert.deepStrictEqual(trimmedPayload.resource_candidates, payload.resource_candidates,
    'the explicit turn index must still remove persisted media when context trimming drops the message row');

  const inferredPayload = JSON.parse(routeService.buildRoutePayload({
    model: 'router', ...options, currentTurn: null,
  }).messages[1].content);
  assert.deepStrictEqual(inferredPayload.resource_candidates, payload.resource_candidates,
    'attachment identity must safely recover the current turn for direct service callers');

  const semantic = decision({
    operation: 'image_qa',
    bindings: [{ candidate_key: 'i1', role: 'source' }],
  });
  const inspected = routeService.inspectRouteResult(JSON.stringify(semantic), options);
  assert.ok(inspected.route);
  assert.strictEqual(inspected.route.taskContract.resources[0].id, options.durableId);
  assert.ok(inspected.route.executionResources.images[0].identity_aliases.includes(options.transientId));
  assert.strictEqual(routeService.isRouteDispatchable(inspected.route), true);
}

function testPartialClarificationSelectionMustRemainBoundWhileOtherSlotStaysUnresolved() {
  const context = {
    image_candidates: [
      { index: 1, source: 'history', image_id: 'left-a', reference_id: 'left-a-ref', filename: 'left-a.png' },
      { index: 2, source: 'history', image_id: 'left-b', reference_id: 'left-b-ref', filename: 'left-b.png' },
      { index: 3, source: 'history', image_id: 'right-a', reference_id: 'right-a-ref', filename: 'right-a.png' },
      { index: 4, source: 'history', image_id: 'right-b', reference_id: 'right-b-ref', filename: 'right-b.png' },
    ],
    clarification_context: {
      schema_version: 'clarification_context.v1',
      continuation_relation: 'partial_answer',
      selected_choices: [{
        resource_key: 'r1', choice_key: 'c2', type: 'image', role: 'compare_a',
        source: 'history', index: 2, id: 'left-b', reference_id: 'left-b-ref', label: 'left B',
      }],
    },
  };
  const semantic = decision({
    readiness: 'needs_clarification',
    operation: 'image_compare',
    relation: 'continuation',
    bindings: [{ candidate_key: 'i2', role: 'compare_a' }],
    clarification: {
      question: '请选择右侧要比较的图片。',
      unresolved: [{ type: 'image', role: 'compare_b', reason: 'ambiguous', candidate_keys: ['i3', 'i4'] }],
    },
  });
  const inspected = routeService.inspectRouteResult(JSON.stringify(semantic), {
    input: '左边选第二张', attachments: [], context,
  });
  assert.ok(inspected.route, 'a partial selection must compile with the selected resource bound and the other slot unresolved');
  assert.strictEqual(inspected.route.needClarification, true);
  assert.strictEqual(inspected.route.taskContract.resources[0].id, 'left-b');
  assert.deepStrictEqual(inspected.route.taskContract.clarification.unresolved_resources[0].choices.map(choice => choice.id), ['right-a', 'right-b']);

  const omittedSelection = { ...semantic, bindings: [] };
  assert.strictEqual(routeService.inspectRouteResult(JSON.stringify(omittedSelection), {
    input: '左边选第二张', attachments: [], context,
  }).route, null, 'the rerouter must not silently forget a choice already made in a partial answer');
}

function testLegacyTaskContractsAreConvertedBackThroughCandidateDecisions() {
  const context = {
    image_candidates: [{
      index: 1, source: 'history', image_id: 'legacy-cat', reference_id: 'legacy-cat-ref',
      filename: 'cat.png', description: '灰色猫',
    }],
  };
  const legacy = {
    schema_version: 'task_contract.v5', readiness: 'ready', operation: 'edit_image', relation: 'followup',
    resources: [{
      key: 'r1', type: 'image', source: 'history', role: 'target', index: 1,
      id: 'legacy-cat', reference_id: 'legacy-cat-ref', missing: false,
    }],
    directive: {
      mode: 'patch', base_resource_keys: ['r1'], unmentioned_policy: 'preserve',
      operations: [{ op: 'replace', target: '猫的颜色', value: '黑色' }], constraints: [],
    },
    clarification: { question: '', unresolved_resources: [] },
    confidence: 0.97, review_reasons: [], rationale: 'legacy compatible output',
  };
  const converted = routeService.convertLegacyTaskContractToDecision(legacy, {
    input: '把猫改成黑色', attachments: [], context,
  });
  assert.ok(converted);
  assert.deepStrictEqual(converted.bindings, [{ candidate_key: 'i1', role: 'target' }]);
  assert.deepStrictEqual(converted.changes, [{ op: 'replace', target: '猫的颜色', value: '黑色' }]);

  const inspected = routeService.inspectRouteResult(JSON.stringify(legacy), {
    input: '把猫改成黑色', attachments: [], context,
  });
  assert.ok(inspected.route);
  assert.strictEqual(inspected.route.legacyModelOutputConverted, true);
  assert.deepStrictEqual(inspected.route.routeDecision, converted);
  assert.strictEqual(routeService.isRouteDispatchable(inspected.route), true);
}

function testLegacyConversionFailsClosedWhenIdentityIsNotUnique() {
  const context = {
    image_candidates: [
      { index: 1, source: 'history', image_id: 'duplicate-cat', reference_id: '', filename: 'a.png' },
      { index: 2, source: 'history', image_id: 'duplicate-cat', reference_id: '', filename: 'b.png' },
    ],
  };
  const legacy = {
    schema_version: 'task_contract.v5', readiness: 'ready', operation: 'edit_image', relation: 'followup',
    resources: [{
      key: 'r1', type: 'image', source: 'history', role: 'target', index: 1,
      id: 'duplicate-cat', reference_id: '', missing: false,
    }],
    directive: {
      mode: 'patch', base_resource_keys: ['r1'], unmentioned_policy: 'preserve',
      operations: [{ op: 'replace', target: '背景', value: '白色' }], constraints: [],
    },
    clarification: { question: '', unresolved_resources: [] },
    confidence: 0.9, review_reasons: [], rationale: 'ambiguous copied identity',
  };
  assert.strictEqual(routeService.convertLegacyTaskContractToDecision(legacy, { input: '背景改白色', context }), null);
  const inspected = routeService.inspectRouteResult(JSON.stringify(legacy), { input: '背景改白色', context });
  assert.strictEqual(inspected.route, null, 'an ambiguous legacy identity must never bypass candidate-key compilation');
}

function testPartialClarificationCannotDropPreviouslyBoundResources() {
  const context = {
    image_candidates: [
      { index: 1, source: 'history', image_id: 'base-reference', reference_id: 'base-reference-ref', filename: 'base.png' },
      { index: 2, source: 'history', image_id: 'selected-style', reference_id: 'selected-style-ref', filename: 'selected.png' },
      { index: 3, source: 'history', image_id: 'remaining-a', reference_id: 'remaining-a-ref', filename: 'remaining-a.png' },
      { index: 4, source: 'history', image_id: 'remaining-b', reference_id: 'remaining-b-ref', filename: 'remaining-b.png' },
    ],
    clarification_context: {
      schema_version: 'clarification_context.v1',
      continuation_relation: 'partial_answer',
      prior_task_contract: {
        resources: [{
          key: 'r1', type: 'image', source: 'history', role: 'reference', index: 1,
          id: 'base-reference', reference_id: 'base-reference-ref', missing: false,
        }],
      },
      selected_choices: [{
        resource_key: 'r2', choice_key: 'c1', type: 'image', role: 'style_reference',
        source: 'history', index: 2, id: 'selected-style', reference_id: 'selected-style-ref', label: 'selected style',
      }],
    },
  };
  const semantic = decision({
    readiness: 'needs_clarification',
    operation: 'image_reference_gen',
    relation: 'continuation',
    bindings: [
      { candidate_key: 'i1', role: 'reference' },
      { candidate_key: 'i2', role: 'style_reference' },
    ],
    clarification: {
      question: '请选择剩余的风格参考图。',
      unresolved: [{ type: 'image', role: 'style_reference', reason: 'ambiguous', candidate_keys: ['i3', 'i4'] }],
    },
  });
  const options = { input: '第二项选第一张', attachments: [], context };
  const inspected = routeService.inspectRouteResult(JSON.stringify(semantic), options);
  assert.ok(inspected.route, 'a valid partial answer must preserve the prior binding, the new selection, and the remaining unresolved slot');
  assert.deepStrictEqual(inspected.route.taskContract.resources.map(resource => [resource.id, resource.role]), [
    ['base-reference', 'reference'],
    ['selected-style', 'style_reference'],
  ]);
  assert.deepStrictEqual(inspected.route.taskContract.clarification.unresolved_resources[0].choices.map(choice => choice.id), [
    'remaining-a',
    'remaining-b',
  ]);

  const droppedPriorBinding = {
    ...semantic,
    bindings: [{ candidate_key: 'i2', role: 'style_reference' }],
  };
  const rejected = routeService.inspectRouteResult(JSON.stringify(droppedPriorBinding), options);
  assert.strictEqual(rejected.route, null, 'the rerouter must not discard a binding established before the partial answer');
  assert.strictEqual(rejected.reason, 'resource_binding');
}

module.exports = [
  testCompactDecisionCompilesEveryOperationToCanonicalExecution,
  testReferenceGenerationPolicyUsesBoundResourceStructure,
  testQuotedTextDecisionCompilesMessageIdentityAndPromptOnce,
  testQuotedPlainChatDecisionUsesTheSameCanonicalMessageSource,
  testQuotedClarificationTextQuestionRoutesAsPlainChat,
  testCompilerEnforcesOnlyAnExplicitFixedProductMode,
  testCompilerKeepsUnavailableAndAttachmentOnlyTurnsNonExecuting,
  testNativeMarkdownDecisionCompilesWhileUnreadableFilesAndInvalidKeysStayRejected,
  testCompilerMapsDeclaredImageClarificationWithoutChoosingLocally,
  testCompilerRejectsMissingEditValueWithoutLocalClarification,
  testSelfContainedImageFollowupDoesNotInheritPriorPrompt,
  testDecisionCompilerBuildsClarificationChoicesWithoutModelAuthoredIds,
  testEditClarificationPreservesTargetAndSelectedReferenceWithoutSemanticDrift,
  testDegradedClarificationRetainsCompilerValidatedChoicesWithoutAuthorizingExecution,
  testDecisionBoundaryRejectsInventedKeysRolesAndSemanticRepairDrift,
  testCurrentGifDecisionCanonicalizesIdentityAndDispatches,
  testExistingImageHistoryKeepsCurrentGifCandidateStable,
  testAttachmentOnlyCurrentTurnUsesOneCurrentCandidateAndNoHistoryMessage,
  testLegacyTaskContractsAreConvertedBackThroughCandidateDecisions,
  testLegacyConversionFailsClosedWhenIdentityIsNotUnique,
  testPartialClarificationSelectionMustRemainBoundWhileOtherSlotStaysUnresolved,
  testPartialClarificationCannotDropPreviouslyBoundResources,
];
