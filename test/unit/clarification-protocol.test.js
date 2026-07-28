'use strict';

const assert = require('assert');
const fs = require('fs');
const path = require('path');

const clarification = require('../../client/services/clarification-service');
const routeService = require('../../client/services/route-service');

function ambiguousContract() {
  return {
    schema_version: 'task_contract.v5',
    readiness: 'needs_clarification',
    operation: 'image_reference_gen',
    relation: 'followup',
    resources: [{
      key: 'r1', type: 'image', source: 'history', role: 'reference', index: 1,
      id: 'cat-id', reference_id: 'cat-ref', missing: false,
    }],
    directive: {
      mode: 'patch', base_resource_keys: ['r1', 'r2'], unmentioned_policy: 'preserve',
      operations: [{ op: 'add', target: 'composition', value: 'combine cat and selected fish' }], constraints: [],
    },
    clarification: {
      question: '请选择鱼图。',
      unresolved_resources: [{
        key: 'r2', type: 'image', role: 'reference', reason: 'ambiguous',
        choices: [
          { key: 'c1', source: 'history', index: 2, id: 'fish-a', reference_id: 'fish-a-ref', label: '手绘鱼' },
          { key: 'c2', source: 'history', index: 3, id: 'fish-b', reference_id: 'fish-b-ref', label: '彩色鱼' },
        ],
      }],
    },
    confidence: 0.9,
    review_reasons: [],
    rationale: 'two fish candidates remain',
  };
}

function makePending(contract = ambiguousContract()) {
  return clarification.createPendingClarification({
    messages: [{ role: 'user', content: '把猫和鱼合并成一张图' }],
    clarificationText: '请选择鱼图。',
    routeInfo: {
      mode: 'chat', api: 'clarify', readiness: 'needs_clarification', needClarification: true,
      clarificationQuestion: '请选择鱼图。', taskContract: contract,
    },
  });
}

function continuationJson(overrides = {}) {
  return JSON.stringify({
    schema_version: clarification.CONTINUATION_SCHEMA_VERSION,
    relation: 'pending_answer',
    confidence: 0.99,
    resolved_input: '把猫和彩色鱼合并成一张图',
    selections: [{ resource_key: 'r2', choice_key: 'c2' }],
    should_merge: true,
    should_clear_pending: true,
    assistant_reply: '',
    reason: 'explicit choice',
    ...overrides,
  });
}

function testContinuationV5UsesOneStrictNonExecutingSchema() {
  const pending = makePending();
  const payload = clarification.buildContinuationClassifierPayload({
    model: 'route-model', pending, currentInput: '彩色鱼', attachments: [],
  });
  assert.strictEqual(clarification.CONTINUATION_SCHEMA_VERSION, 'pending_continuation.v5');
  assert.strictEqual(payload.response_format.type, 'json_schema');
  assert.strictEqual(payload.response_format.json_schema.strict, true);
  assert.strictEqual(payload.response_format.json_schema.schema.additionalProperties, false);
  assert.ok(payload.messages[0].content.includes('一次只能选择一个 choice'));
  assert.ok(payload.messages[0].content.includes('返回 pending_assistance'));
  assert.ok(payload.messages[0].content.includes('无权决定或暗示这些字段'));
  assert.ok(!payload.messages[0].content.includes('final_task_mode'));

  assert.strictEqual(clarification.parseContinuationClassifierResult(continuationJson({ schema_version: 'pending_continuation.v4' }), { pending }), null);
  assert.strictEqual(clarification.parseContinuationClassifierResult(continuationJson({ final_task_mode: 'image' }), { pending }), null, 'extra execution controls must invalidate the whole response');
  assert.strictEqual(clarification.parseContinuationClassifierResult(continuationJson({ confidence: 0.84 }), { pending }), null, 'low confidence must fail closed');
}

function testModelContinuationSupportsPartialClarificationAnswers() {
  const contract = ambiguousContract();
  contract.operation = 'edit_image';
  contract.directive.operations = [];
  contract.clarification.question = '请指定要修改哪一张猫的图片，并说明希望改成什么姿势。';
  contract.clarification.unresolved_resources = [
    {
      key: 'r1', type: 'image', role: 'target', reason: 'ambiguous',
      choices: [
        { key: 'c1', source: 'history', index: 1, id: 'cat-a', reference_id: 'cat-a-ref', label: '候选图片 1' },
        { key: 'c2', source: 'history', index: 2, id: 'cat-b', reference_id: 'cat-b-ref', label: '候选图片 2' },
      ],
    },
    { key: 'r2', type: 'text', role: 'source', reason: 'missing', choices: [] },
  ];
  const pending = clarification.createPendingClarification({
    messages: [{ role: 'user', content: '猫的姿势换一下' }],
    clarificationText: contract.clarification.question,
    routeInfo: {
      mode: 'chat', api: 'clarify', readiness: 'needs_clarification', needClarification: true,
      clarificationQuestion: contract.clarification.question, taskContract: contract,
    },
  });

  const payload = clarification.buildContinuationClassifierPayload({
    model: 'route-model', pending, currentInput: '我选右边那只猫', attachments: [],
  });
  assert.match(payload.messages[0].content, /partial_answer/);
  assert.match(payload.messages[0].content, /"2"、"第二张"、"右边那只猫"或"选候选图二"/);
  assert.match(payload.response_format.json_schema.schema.properties.resolved_input.description, /partial_answer 可以保留尚未补齐的信息/);
  assert.strictEqual(JSON.parse(payload.messages[1].content).current_input, '我选右边那只猫');

  const decision = clarification.parseContinuationClassifierResult(JSON.stringify({
    schema_version: clarification.CONTINUATION_SCHEMA_VERSION,
    relation: 'partial_answer',
    confidence: 0.99,
    resolved_input: '猫的姿势换一下',
    selections: [{ resource_key: 'r1', choice_key: 'c2' }],
    should_merge: true,
    should_clear_pending: true,
    assistant_reply: '',
    reason: 'the user selected the second cat but did not provide the pose',
  }), { pending });
  assert.ok(decision, 'the model may preserve a valid partial answer for a combined clarification');
  assert.strictEqual(decision.resolvedInput, '猫的姿势换一下');
  assert.deepStrictEqual(decision.selections, [{ resource_key: 'r1', choice_key: 'c2' }]);

  const context = clarification.buildClarificationRouteContext({
    baseContext: {
      image_candidates: [
        { index: 1, source: 'history', image_id: 'cat-a', reference_id: 'cat-a-ref' },
        { index: 2, source: 'history', image_id: 'cat-b', reference_id: 'cat-b-ref' },
      ],
    },
    pending,
    currentInput: '我选右边那只猫',
    resolvedInput: decision.resolvedInput,
    continuationRelation: decision.relation,
    selections: decision.selections,
  });
  assert.strictEqual(context.clarification_context.base_task, '猫的姿势换一下');
  assert.strictEqual(context.clarification_context.selected_choices[0].id, 'cat-b', 'the second image must remain selected while the router asks for the missing pose');

  assert.strictEqual(clarification.parseContinuationClassifierResult(JSON.stringify({
    schema_version: clarification.CONTINUATION_SCHEMA_VERSION,
    relation: 'partial_answer', confidence: 0.99, resolved_input: '猫的姿势换一下',
    selections: [{ resource_key: 'r1', choice_key: 'c9' }], should_merge: true,
    should_clear_pending: true, assistant_reply: '', reason: 'invented choice',
  }), { pending }), null, 'model recognition must still fail closed for an unknown choice');

  const repairPayload = clarification.buildContinuationRepairPayload(payload, '{"relation":"partial_answer"}');
  assert.strictEqual(repairPayload.messages.at(-2).role, 'assistant');
  assert.match(repairPayload.messages.at(-1).content, /未通过 pending_continuation\.v5 严格校验/);
  assert.match(repairPayload.messages.at(-1).content, /partial_answer/);
}

function testStructuredChoiceIsValidatedThenOnlyForwardedAsRerouteContext() {
  const pending = makePending();
  const decision = clarification.parseContinuationClassifierResult(continuationJson(), { pending });
  assert.ok(decision);
  assert.strictEqual(clarification.parseContinuationClassifierResult(continuationJson({ selections: [] }), { pending }), null);
  assert.strictEqual(clarification.parseContinuationClassifierResult(continuationJson({ selections: [{ resource_key: 'r2', choice_key: 'c9' }] }), { pending }), null);

  const context = clarification.buildClarificationRouteContext({
    baseContext: {
      recent_messages: [{ index: 1, id: 'm1', role: 'user', content: '把猫和鱼合并成一张图' }],
      image_candidates: [
        { index: 1, source: 'history', image_id: 'cat-id', reference_id: 'cat-ref' },
        { index: 2, source: 'history', image_id: 'fish-a', reference_id: 'fish-a-ref' },
        { index: 3, source: 'history', image_id: 'fish-b', reference_id: 'fish-b-ref' },
      ],
    },
    pending,
    currentInput: '彩色鱼',
    resolvedInput: decision.resolvedInput,
    continuationRelation: decision.relation,
    selections: decision.selections,
  });
  assert.strictEqual(decision.resolvedInput, '把猫和鱼合并成一张图', 'a pure resource choice must restore the immutable original task instead of trusting model paraphrase');
  assert.strictEqual(context.clarification_context.selected_choices[0].id, 'fish-b');
  assert.strictEqual(context.clarification_context.prior_task_contract.readiness, 'needs_clarification');
  assert.match(context.clarification_context.source_policy, /Re-run the complete router/);

  const readyDecision = {
    schema_version: 'route_decision.v1', readiness: 'ready', operation: 'image_reference_gen', relation: 'continuation',
    bindings: [{ candidate_key: 'i1', role: 'reference' }, { candidate_key: 'i3', role: 'reference' }],
    changes: [{ op: 'add', target: 'composition', value: 'combine cat and selected fish' }], constraints: [],
    clarification: { question: '', unresolved: [] }, confidence: 0.99, rationale: 'preserved cat and selected fish',
  };
  const ready = routeService.inspectRouteResult(JSON.stringify(readyDecision), { input: decision.resolvedInput, context });
  assert.ok(ready.route, 'the reroute must preserve both the established cat and the selected fish');

  const droppedEstablished = routeService.inspectRouteResult(JSON.stringify({
    ...readyDecision,
    bindings: [{ candidate_key: 'i3', role: 'reference' }],
    rationale: 'dropped the established cat',
  }), { input: decision.resolvedInput, context });
  assert.strictEqual(droppedEstablished.route, null, 'a pure selection answer may not drop an already established resource');

  const changedRole = routeService.inspectRouteResult(JSON.stringify({
    ...readyDecision,
    bindings: [{ candidate_key: 'i1', role: 'reference' }, { candidate_key: 'i3', role: 'style_reference' }],
    rationale: 'changed the selected fish role',
  }), { input: decision.resolvedInput, context });
  assert.strictEqual(changedRole.route, null, 'a pure selection answer may not change a selected resource role');

  const inventedExtra = routeService.inspectRouteResult(JSON.stringify({
    ...readyDecision,
    bindings: [...readyDecision.bindings, { candidate_key: 'i2', role: 'reference' }],
    rationale: 'added an unselected fish',
  }), { input: decision.resolvedInput, context });
  assert.strictEqual(inventedExtra.route, null, 'a pure selection answer may not add an unselected resource');
}

function testResolvedInputIsRequiredAndNeverSynthesizedLocally() {
  const pending = clarification.createPendingClarification({
    messages: [{ role: 'user', content: '生成晚霞图' }],
    clarificationText: '要什么地点？',
  });
  const rejected = clarification.mergePendingInput(pending, { promptText: '山巅' });
  assert.strictEqual(rejected.merged, false);
  const merged = clarification.mergePendingInput(pending, {
    promptText: '山巅', resolvedInput: '生成山巅晚霞图',
  });
  assert.strictEqual(merged.promptText, '生成山巅晚霞图');
  assert.strictEqual(merged.pending.originalText, '生成山巅晚霞图');
  assert.ok(!/本轮补充|原始任务|追问来源/.test(merged.promptText));
}

function testImageChoiceOrdinalDoesNotReachTheExecutionPrompt() {
  const contract = {
    schema_version: 'task_contract.v5',
    readiness: 'needs_clarification',
    operation: 'edit_image',
    relation: 'followup',
    resources: [],
    directive: {
      mode: 'patch', base_resource_keys: ['r1'], unmentioned_policy: 'preserve',
      operations: [{ op: 'replace', target: '猫的颜色', value: '红色' }], constraints: [],
    },
    clarification: {
      question: '请选择要修改的图片。',
      unresolved_resources: [{
        key: 'r1', type: 'image', role: 'target', reason: 'ambiguous',
        choices: [
          { key: 'c1', source: 'history', index: 1, id: 'grid-a', reference_id: 'grid-ref-a', label: '第一张九宫格图片' },
          { key: 'c2', source: 'history', index: 2, id: 'grid-b', reference_id: 'grid-ref-b', label: '第二张九宫格图片' },
        ],
      }],
    },
    confidence: 0.9,
    review_reasons: [],
    rationale: 'two image targets remain',
  };
  const pending = clarification.createPendingClarification({
    messages: [{ role: 'user', content: '把猫的颜色换成红色' }],
    clarificationText: '请选择要修改的图片。',
    routeInfo: {
      mode: 'chat', api: 'clarify', readiness: 'needs_clarification', needClarification: true,
      clarificationQuestion: '请选择要修改的图片。', taskContract: contract,
    },
  });
  const classifierPayload = clarification.buildContinuationClassifierPayload({
    model: 'route-model', pending, currentInput: '第二张图改成红色', attachments: [],
  });
  assert.match(classifierPayload.messages[0].content, /只能体现在 selections 中/);
  assert.match(classifierPayload.messages[0].content, /把猫的颜色换成红色/);
  assert.match(classifierPayload.messages[0].content, /不能改写成泛化的“当前图片”/);
  assert.doesNotMatch(classifierPayload.response_format.json_schema.schema.properties.resolved_input.description, /第二张图/);

  const decision = clarification.parseContinuationClassifierResult(JSON.stringify({
    schema_version: clarification.CONTINUATION_SCHEMA_VERSION,
    relation: 'pending_answer',
    confidence: 0.99,
    resolved_input: '把当前图片换成红色',
    selections: [{ resource_key: 'r1', choice_key: 'c2' }],
    should_merge: true,
    should_clear_pending: true,
    assistant_reply: '',
    reason: 'the second external candidate was explicitly selected',
  }), { pending });
  assert.ok(decision);
  assert.strictEqual(decision.resolvedInput, '把猫的颜色换成红色', 'a pure image choice must not be allowed to generalize away the original edit subject');

  const merged = clarification.mergePendingInput(pending, {
    promptText: '第二张图改成红色', resolvedInput: decision.resolvedInput,
  });
  const context = clarification.buildClarificationRouteContext({
    baseContext: {
      image_candidates: [
        { index: 1, source: 'history', image_id: 'grid-a', reference_id: 'grid-ref-a' },
        { index: 2, source: 'history', image_id: 'grid-b', reference_id: 'grid-ref-b' },
      ],
    },
    pending,
    currentInput: '第二张图改成红色',
    resolvedInput: merged.promptText,
    continuationRelation: decision.relation,
    selections: decision.selections,
  });
  const routePayload = routeService.buildRoutePayload({
    model: 'route-model', input: merged.promptText, context,
  });
  const routeUserPayload = JSON.parse(routePayload.messages[1].content);
  assert.strictEqual(routeUserPayload.current_input, '把猫的颜色换成红色');
  assert.doesNotMatch(routeUserPayload.current_input, /第二张|第2张/);
  assert.strictEqual(routeUserPayload.context.clarification_context.selected_choices[0].id, 'grid-b');
  assert.match(routePayload.messages[0].content, /绝不能解释成图片内部的序号、宫格、图层或空间区域/);

  const selectedRoute = routeService.inspectRouteResult(JSON.stringify({
    schema_version: 'route_decision.v1',
    readiness: 'ready', operation: 'edit_image', relation: 'continuation',
    bindings: [{ candidate_key: 'i2', role: 'target' }],
    changes: [{ op: 'replace', target: '猫的颜色', value: '红色' }], constraints: [],
    clarification: { question: '', unresolved: [] }, confidence: 0.99, rationale: 'selected external image',
  }), { input: merged.promptText, attachments: [], context });
  assert.ok(selectedRoute.route, 'the chosen external image must bind into the executable route');
  assert.strictEqual(selectedRoute.route.editInstruction, '把猫的颜色换成红色');

  const semanticDrift = routeService.inspectRouteResult(JSON.stringify({
    schema_version: 'route_decision.v1',
    readiness: 'ready', operation: 'edit_image', relation: 'continuation',
    bindings: [{ candidate_key: 'i2', role: 'target' }],
    changes: [{ op: 'replace', target: '整张图片', value: '红色' }], constraints: [],
    clarification: { question: '', unresolved: [] }, confidence: 0.99, rationale: 'generalized the edit target',
  }), { input: '把当前图片换成红色', attachments: [], context });
  assert.strictEqual(semanticDrift.route, null, 'a ready reroute may bind the choice but may not replace the original task semantics');

  const droppedSelection = routeService.inspectRouteResult(JSON.stringify({
    schema_version: 'route_decision.v1',
    readiness: 'ready', operation: 'edit_image', relation: 'continuation',
    bindings: [{ candidate_key: 'i1', role: 'target' }],
    changes: [{ op: 'replace', target: '猫的颜色', value: '红色' }], constraints: [],
    clarification: { question: '', unresolved: [] }, confidence: 0.99, rationale: 'wrong image',
  }), { input: merged.promptText, attachments: [], context });
  assert.strictEqual(droppedSelection.route, null, 'a ready route may not silently discard the explicit image choice');

  const identityConflictContext = {
    ...context,
    image_candidates: context.image_candidates.map(candidate => Number(candidate.index) === 2
      ? { ...candidate, image_id: 'different-grid-b', reference_id: 'different-grid-ref-b' }
      : candidate),
  };
  const identityConflict = routeService.inspectRouteResult(JSON.stringify({
    schema_version: 'route_decision.v1',
    readiness: 'ready', operation: 'edit_image', relation: 'continuation',
    bindings: [{ candidate_key: 'i2', role: 'target' }],
    changes: [{ op: 'replace', target: '猫的颜色', value: '红色' }], constraints: [],
    clarification: { question: '', unresolved: [] }, confidence: 0.99, rationale: 'same display index but different stable identity',
  }), { input: merged.promptText, attachments: [], context: identityConflictContext });
  assert.strictEqual(identityConflict.route, null, 'conflicting stable IDs must never fall back to a matching source/index pair');
}

function testNewTaskMultiIntentAndAssistanceCannotDispatch() {
  const newTask = clarification.parseContinuationClassifierResult(JSON.stringify({
    schema_version: clarification.CONTINUATION_SCHEMA_VERSION,
    relation: 'new_task', confidence: 0.99, resolved_input: '', selections: [],
    should_merge: false, should_clear_pending: true, assistant_reply: '', reason: 'multiple independent goals',
  }));
  assert.ok(newTask);
  assert.strictEqual(newTask.shouldMerge, false);

  const assistance = clarification.parseContinuationClassifierResult(JSON.stringify({
    schema_version: clarification.CONTINUATION_SCHEMA_VERSION,
    relation: 'pending_assistance', confidence: 0.99, resolved_input: '', selections: [],
    should_merge: false, should_clear_pending: false, assistant_reply: '可选手绘鱼或彩色鱼，请选择一种。', reason: 'asked for choices',
  }));
  assert.ok(assistance);
  const submit = fs.readFileSync(path.join(__dirname, '../../client/app/submit-workflow.js'), 'utf8');
  assert.ok(!submit.includes('resolveClarificationRoute'));
  assert.ok(!submit.includes('pendingDecision?.operation') && !submit.includes('pendingDecision?.mode'));
  assert.ok(submit.indexOf('getEffectiveRouteWithSlowNotice(effectivePromptText,currentTurnAttachments') < submit.indexOf('if(routeUtils.isRouteDispatchable?.(routeInfo)!==!0)'));
}

function testClarificationContextPreservesCurrentQuotedAndPriorSources() {
  const pending = makePending();
  const context = clarification.buildClarificationRouteContext({
    baseContext: {
      recent_messages: [{ index: 1, id: 'history-message', role: 'user', content: '旧任务' }],
      image_candidates: [{ index: 1, source: 'history', image_id: 'cat-id', reference_id: 'cat-ref' }],
    },
    quotedContext: {
      quoted_message: { index: 1, id: 'quoted-message', role: 'user' },
      recent_messages: [{ index: 1, id: 'quoted-message', role: 'user', content: '引用消息' }],
      image_candidates: [{ index: 1, source: 'quoted', image_id: 'quote-image', reference_id: 'quote-ref' }],
      file_candidates: [],
    },
    pending,
    currentInput: '用新上传的图替换',
    resolvedInput: '把猫和彩色鱼合并，并参考新上传的图',
    selections: [{ resource_key: 'r2', choice_key: 'c2' }],
    attachments: [{ id: 'new-image', name: 'new.png', type: 'image/png' }],
    quoteText: '引用消息',
  });
  assert.strictEqual(context.clarification_context.attachments.current[0].source, 'current');
  assert.ok(context.clarification_context.attachments.prior_sources.every(item => item.source === 'history'));
  assert.ok(context.image_candidates.some(item => item.source === 'history' && item.image_id === 'cat-id'));
  assert.ok(context.image_candidates.some(item => item.source === 'quoted' && item.image_id === 'quote-image'));
  assert.strictEqual(context.quoted_message.id, 'quoted-message');
}

function testPendingClarificationCanReplayItsPersistedContract() {
  const pending = clarification.createPendingClarification({
    messages: [{ role: 'user', content: '换一下猫的姿势' }],
    clarificationText: '请选择要修改的猫图。',
    routeInfo: {
      mode: 'chat', api: 'clarify', needClarification: true,
      clarificationQuestion: '请选择要修改的猫图。',
      taskContract: ambiguousContract(),
    },
  });
  const message = {
    role: 'assistant', content: pending.clarificationText,
    clarificationId: pending.id,
  };
  assert.strictEqual(clarification.matchesPendingClarificationMessage(pending, {
    message, userText: '换一下猫的姿势',
  }), true);
  assert.strictEqual(clarification.matchesPendingClarificationMessage(pending, {
    message: { ...message, clarificationId: 'another-pending' }, userText: '换一下猫的姿势',
  }), false);

  const replayRoute = clarification.pendingClarificationRouteInfo(pending);
  assert.strictEqual(replayRoute.needClarification, true);
  assert.strictEqual(replayRoute.clarificationQuestion, pending.clarificationText);
  assert.deepStrictEqual(replayRoute.clarificationSlots, ambiguousContract().clarification.unresolved_resources);
}

function testCompletedClarificationReplayPersistsEveryConfirmedRoundAndSupportsEdit() {
  const pending = clarification.createPendingClarification({
    messages: [{ role: 'user', content: 'generate a product poster' }],
    clarificationText: 'which color and layout?',
    routeInfo: { mode: 'image', api: 'image_generation', taskContract: { schema_version: 'task_contract.v5' } },
  });
  const first = clarification.mergePendingInput(pending, {
    promptText: 'use orange', resolvedInput: 'generate a product poster in orange',
  });
  const second = clarification.mergePendingInput(first.pending, {
    promptText: 'use a vertical layout', resolvedInput: 'generate an orange product poster in a vertical layout',
  });
  const replay = clarification.createClarificationReplay({
    pending: first.pending,
    merge: second,
    routeInfo: { mode: 'image', api: 'image_generation', taskContract: { schema_version: 'task_contract.v5', readiness: 'ready' } },
    clarificationRouteContext: { clarification_context: { selected_choices: [] } },
  });
  assert.strictEqual(replay.schemaVersion, clarification.CLARIFICATION_REPLAY_VERSION);
  assert.deepStrictEqual(replay.supplements, ['use orange', 'use a vertical layout']);
  assert.strictEqual(replay.resolvedInput, 'generate an orange product poster in a vertical layout');
  assert.deepStrictEqual(replay.clarificationRouteContext, { clarification_context: { selected_choices: [] } });

  const revised = clarification.reviseClarificationReplay(replay, 'use a square layout');
  assert.deepStrictEqual(revised.supplements, ['use orange', 'use a square layout']);
  assert.match(revised.resolvedInput, /generate a product poster/);
  assert.match(revised.resolvedInput, /use orange/);
  assert.match(revised.resolvedInput, /use a square layout/);
}

module.exports = [
  testContinuationV5UsesOneStrictNonExecutingSchema,
  testStructuredChoiceIsValidatedThenOnlyForwardedAsRerouteContext,
  testResolvedInputIsRequiredAndNeverSynthesizedLocally,
  testImageChoiceOrdinalDoesNotReachTheExecutionPrompt,
  testModelContinuationSupportsPartialClarificationAnswers,
  testNewTaskMultiIntentAndAssistanceCannotDispatch,
  testClarificationContextPreservesCurrentQuotedAndPriorSources,
  testPendingClarificationCanReplayItsPersistedContract,
  testCompletedClarificationReplayPersistsEveryConfirmedRoundAndSupportsEdit,
];
