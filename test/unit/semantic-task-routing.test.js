'use strict';

const assert = require('assert');
const routeService = require('../../client/services/route-service');

function task(overrides = {}) {
  return {
    schema_version: 'semantic_task.v2',
    actions: ['respond'],
    discourse: 'independent',
    pending_effect: 'none',
    slots: [],
    changes: [],
    constraints: [],
    ...overrides,
  };
}

function inspect(value, options = {}) {
  return routeService.inspectRouteResult(JSON.stringify(value), options);
}

function imageContext(images = [], extra = {}) {
  return {
    recent_messages: [],
    image_candidates: images.map((item, index) => ({
      index: index + 1,
      source_index: index + 1,
      source: item.source || 'history',
      target: item.target || 'previous',
      image_id: item.id,
      reference_id: item.reference_id || `${item.id}-ref`,
      description: item.description || item.id,
      labels: item.labels || [],
    })),
    file_candidates: [],
    ...extra,
  };
}

function testSemanticPromptIsCompactAndHasNoScenarioExamples() {
  const prompt = routeService.ROUTE_SYSTEM_PROMPT;
  assert.ok(prompt.length < 1200, `semantic prompt unexpectedly long: ${prompt.length}`);
  assert.match(prompt, /semantic_task\.v2/);
  assert.match(prompt, /current_input/);
  assert.match(prompt, /operation、readiness/);
  assert.doesNotMatch(prompt, /再画一只狗/);
  assert.doesNotMatch(prompt, /把猫的颜色换一下/);
  assert.doesNotMatch(prompt, /输出前自检/);
  assert.doesNotMatch(prompt, /唯一结构：/);
}

function testSemanticSchemaDoesNotExposeDerivedContractFields() {
  const schema = routeService.ROUTE_RESPONSE_FORMAT.json_schema.schema;
  const fields = Object.keys(schema.properties);
  assert.deepStrictEqual(fields, ['schema_version', 'actions', 'discourse', 'pending_effect', 'slots', 'changes', 'constraints']);
  for (const field of ['operation', 'readiness', 'bindings', 'clarification', 'confidence', 'rationale']) {
    assert.ok(!fields.includes(field), `${field} must be compiler-derived`);
  }
}

function testProviderSchemaUsesPortableSubsetAndLocalValidationRejectsDuplicateActions() {
  const actionsSchema = routeService.ROUTE_RESPONSE_FORMAT.json_schema.schema.properties.actions;
  assert.strictEqual(Object.prototype.hasOwnProperty.call(actionsSchema, 'uniqueItems'), false);
  assert.strictEqual(routeService.hasExactSemanticTask(task({ actions: ['respond'] })), true);
  assert.strictEqual(routeService.hasExactSemanticTask(task({ actions: ['respond', 'respond'] })), false);
}

function testSemanticPromptAndSchemaEncodeSlotCardinality() {
  assert.match(routeService.ROUTE_SYSTEM_PROMPT, /current_input 自身是隐式文本源/);
  assert.match(routeService.ROUTE_SYSTEM_PROMPT, /slots=\[\]/);
  assert.match(routeService.ROUTE_SYSTEM_PROMPT, /bound 恰好 1 个/);

  const variants = routeService.ROUTE_RESPONSE_FORMAT.json_schema.schema.properties.slots.items.anyOf;
  assert.strictEqual(variants.length, 3);
  const bound = variants.find(variant => variant.properties.resolution.const === 'bound');
  const ambiguous = variants.find(variant => variant.properties.resolution.const === 'ambiguous');
  const unresolved = variants.find(variant => Array.isArray(variant.properties.resolution.enum));
  assert.deepStrictEqual(
    { minItems: bound.properties.candidate_keys.minItems, maxItems: bound.properties.candidate_keys.maxItems },
    { minItems: 1, maxItems: 1 },
  );
  assert.strictEqual(ambiguous.properties.candidate_keys.minItems, 2);
  assert.strictEqual(unresolved.properties.candidate_keys.maxItems, 0);
}

function testModelBoundaryNormalizesLoggedImplicitCurrentInputTextSlot() {
  const currentInput = 'ChatUI现已升级意图识别协议 使用到了一些特殊定义而目前DeepSeek模型不支持此定义 请更换GPT系列模型 帮我优化一下上面的描述 我要作为全员公告';
  const loggedInvalid = task({
    slots: [{
      kind: 'text', purpose: 'source', label: '待优化的公告描述', resolution: 'bound', candidate_keys: [],
    }],
    constraints: ['优化为适合全员公告发布的清晰、正式表述'],
  });
  assert.strictEqual(routeService.inspectRouteResult(JSON.stringify(loggedInvalid), { input: currentInput }).route, null,
    'the general compatibility parser must remain strict');

  const normalized = routeService.inspectModelRouteResult(JSON.stringify(loggedInvalid), {
    input: currentInput,
    attachments: [],
    context: {},
  });
  assert.ok(normalized.route, `the logged response should be safely normalized: ${normalized.reason}`);
  assert.strictEqual(normalized.route.operationType, 'plain_chat');
  assert.deepStrictEqual(normalized.route.semanticTask.slots, []);
  assert.deepStrictEqual(normalized.route.semanticTask.constraints, loggedInvalid.constraints);

  const nonRespond = routeService.inspectModelRouteResult(JSON.stringify(task({
    actions: ['edit'],
    slots: loggedInvalid.slots,
  })), { input: '修改内容', attachments: [], context: {} });
  assert.strictEqual(nonRespond.route, null, 'implicit text-slot recovery must not authorize non-chat execution');
  assert.strictEqual(nonRespond.reason, 'semantic_task_shape');
}

function testSemanticActionsCompileToCanonicalOperations() {
  const cases = [
    [task({ actions: ['respond'] }), 'plain_chat'],
    [task({ actions: ['generate'] }), 'text_to_image'],
    [task({ actions: ['extract_text'], slots: [{ kind: 'image', purpose: 'source', label: '', resolution: 'bound', candidate_keys: ['i1'] }] }), 'ocr'],
    [task({ actions: ['compare'], slots: [
      { kind: 'image', purpose: 'compare_a', label: '', resolution: 'bound', candidate_keys: ['i1'] },
      { kind: 'image', purpose: 'compare_b', label: '', resolution: 'bound', candidate_keys: ['i2'] },
    ] }), 'image_compare'],
    [task({ actions: ['edit'], slots: [{ kind: 'image', purpose: 'target', label: '', resolution: 'bound', candidate_keys: ['i1'] }] }), 'edit_image'],
    [task({ actions: ['generate'], slots: [{ kind: 'image', purpose: 'reference', label: '', resolution: 'bound', candidate_keys: ['i1'] }] }), 'image_reference_gen'],
  ];
  for (const [semantic, operation] of cases) {
    const options = operation === 'plain_chat' || operation === 'text_to_image'
      ? { input: 'request', attachments: [], context: {} }
      : { input: 'request', attachments: [], context: imageContext([{ id: 'one' }, { id: 'two' }]) };
    const result = inspect(semantic, options);
    assert.ok(result.route, `${operation} should compile: ${result.reason}`);
    assert.strictEqual(result.route.operationType, operation);
  }
}

function testSemanticMissingAndAmbiguousSlotsAreNonExecuting() {
  const missing = inspect(task({
    actions: ['edit'],
    slots: [
      { kind: 'image', purpose: 'target', label: '目标图片', resolution: 'missing', candidate_keys: [] },
      { kind: 'text', purpose: 'change_value', label: '目标颜色', resolution: 'missing', candidate_keys: [] },
    ],
  }), { input: '把猫改成黑色', attachments: [], context: {} });
  assert.ok(missing.route);
  assert.strictEqual(missing.route.needClarification, true);
  assert.strictEqual(routeService.isRouteDispatchable(missing.route), false);
  assert.match(missing.route.clarificationQuestion, /目标图片/);
  assert.match(missing.route.clarificationQuestion, /目标颜色/);

  const context = imageContext([{ id: 'a', description: '狗图 A' }, { id: 'b', description: '狗图 B' }]);
  const ambiguous = inspect(task({
    actions: ['edit'],
    slots: [
      { kind: 'image', purpose: 'target', label: '目标狗图', resolution: 'ambiguous', candidate_keys: ['i1', 'i2'] },
    ],
  }), { input: '把狗改成黑色', attachments: [], context });
  assert.ok(ambiguous.route);
  assert.strictEqual(ambiguous.route.needClarification, true);
  assert.strictEqual(routeService.isRouteDispatchable(ambiguous.route), false);
}

function testSemanticContextBoundaryUsesDependencyNotFollowupWord() {
  const context = imageContext([{ id: 'prior', description: '之前的狗图' }], {
    recent_messages: [{ index: 1, id: 'prior-prompt', role: 'user', content: '画一只狗' }],
  });
  const selfContained = inspect(task({ actions: ['generate'], discourse: 'followup' }), {
    input: '再画一只狗，换个品种', attachments: [], context,
  });
  assert.ok(selfContained.route);
  assert.deepStrictEqual(selfContained.route.taskContract.resources, []);

  const dependent = inspect(task({
    actions: ['generate'], discourse: 'followup',
    slots: [{ kind: 'message', purpose: 'context', label: '前一条描述', resolution: 'bound', candidate_keys: ['m1'] }],
  }), {
    input: '再生成一张', attachments: [], context,
  });
  assert.ok(dependent.route);
  assert.strictEqual(dependent.route.taskContract.resources[0].type, 'message');
}

function testCrossExecutionActionsClarifyWithoutPartialDispatch() {
  const options = {
    input: '先总结，再生成海报',
    attachments: [{ id: 'plan', file_id: 'plan', name: 'plan.md', type: 'text/markdown', is_image: false, text: 'plan', input_file_available: true }],
    context: imageContext([], { file_candidates: [{ index: 1, source_index: 1, source: 'current', file_id: 'plan', name: 'plan.md', has_extracted_text: true }] }),
  };
  for (const actions of [['respond', 'generate'], ['generate', 'respond']]) {
    const result = inspect(task({
      actions,
      slots: [{ kind: 'file', purpose: 'attachment', label: '方案文件', resolution: 'bound', candidate_keys: ['f1'] }],
    }), options);
    assert.ok(result.route, `action order ${actions.join(',')} must produce a terminal clarification`);
    assert.strictEqual(result.route.needClarification, true);
    assert.strictEqual(result.route.semanticClarification, true);
    assert.strictEqual(result.route.taskContract, null, 'a multi-operation request must not be squeezed into a partial contract');
    assert.strictEqual(routeService.isRouteDispatchable(result.route), false);
  }
}

function testSameFamilyUnsupportedResourceCombinationClarifiesLocally() {
  const options = {
    input: '比较两张图，并结合文件说明差异',
    attachments: [{ id: 'notes', file_id: 'notes', name: 'notes.md', type: 'text/markdown', is_image: false, text: 'notes', input_file_available: true }],
    context: imageContext([
      { id: 'one', description: '图片一' },
      { id: 'two', description: '图片二' },
    ], {
      file_candidates: [{ index: 1, source_index: 1, source: 'current', file_id: 'notes', name: 'notes.md', has_extracted_text: true }],
    }),
  };
  const result = inspect(task({
    actions: ['compare'],
    slots: [
      { kind: 'image', purpose: 'compare_a', label: '第一张图', resolution: 'bound', candidate_keys: ['i1'] },
      { kind: 'image', purpose: 'compare_b', label: '第二张图', resolution: 'bound', candidate_keys: ['i2'] },
      { kind: 'file', purpose: 'attachment', label: '说明文件', resolution: 'bound', candidate_keys: ['f1'] },
    ],
  }), options);
  assert.ok(result.route);
  assert.strictEqual(result.route.needClarification, true);
  assert.strictEqual(result.route.semanticClarification, true);
  assert.strictEqual(result.route.taskContract, null);
  assert.match(result.route.clarificationQuestion, /同一次执行/);
  assert.strictEqual(routeService.isRouteDispatchable(result.route), false);
}

function testModelBoundaryRejectsDerivedLegacyProtocols() {
  const legacyDecision = {
    schema_version: 'route_decision.v1',
    readiness: 'ready',
    operation: 'text_to_image',
    relation: 'new',
    bindings: [],
    changes: [],
    constraints: [],
    clarification: { question: '', unresolved: [] },
    confidence: 1,
    rationale: 'legacy output must not execute at the model boundary',
  };
  const compatibility = routeService.inspectRouteResult(JSON.stringify(legacyDecision), { input: 'request' });
  assert.ok(compatibility.route, 'the explicit compatibility parser may still read legacy data');
  const modelBoundary = routeService.inspectModelRouteResult(JSON.stringify(legacyDecision), { input: 'request' });
  assert.strictEqual(modelBoundary.route, null);
  assert.strictEqual(modelBoundary.reason, 'semantic_task_required');
  assert.strictEqual(routeService.parseModelRouteResult(JSON.stringify(legacyDecision), { input: 'request' }), null);
}

module.exports = [
  testSemanticPromptIsCompactAndHasNoScenarioExamples,
  testSemanticSchemaDoesNotExposeDerivedContractFields,
  testProviderSchemaUsesPortableSubsetAndLocalValidationRejectsDuplicateActions,
  testSemanticPromptAndSchemaEncodeSlotCardinality,
  testModelBoundaryNormalizesLoggedImplicitCurrentInputTextSlot,
  testSemanticActionsCompileToCanonicalOperations,
  testSemanticMissingAndAmbiguousSlotsAreNonExecuting,
  testSemanticContextBoundaryUsesDependencyNotFollowupWord,
  testCrossExecutionActionsClarifyWithoutPartialDispatch,
  testSameFamilyUnsupportedResourceCombinationClarifiesLocally,
  testModelBoundaryRejectsDerivedLegacyProtocols,
];
