'use strict';

const assert = require('assert');
const fs = require('fs');
const path = require('path');

const clarification = require('../../client/services/clarification-service');

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

function testContinuationV4UsesOneStrictNonExecutingSchema() {
  const pending = makePending();
  const payload = clarification.buildContinuationClassifierPayload({
    model: 'route-model', pending, currentInput: '彩色鱼', attachments: [],
  });
  assert.strictEqual(clarification.CONTINUATION_SCHEMA_VERSION, 'pending_continuation.v4');
  assert.strictEqual(payload.response_format.type, 'json_schema');
  assert.strictEqual(payload.response_format.json_schema.strict, true);
  assert.strictEqual(payload.response_format.json_schema.schema.additionalProperties, false);
  assert.ok(payload.messages[0].content.includes('一次只能选择一个 choice'));
  assert.ok(payload.messages[0].content.includes('返回 pending_assistance'));
  assert.ok(payload.messages[0].content.includes('无权决定或暗示这些字段'));
  assert.ok(!payload.messages[0].content.includes('final_task_mode'));

  assert.strictEqual(clarification.parseContinuationClassifierResult(continuationJson({ schema_version: 'pending_continuation.v3' }), { pending }), null);
  assert.strictEqual(clarification.parseContinuationClassifierResult(continuationJson({ final_task_mode: 'image' }), { pending }), null, 'extra execution controls must invalidate the whole response');
  assert.strictEqual(clarification.parseContinuationClassifierResult(continuationJson({ confidence: 0.84 }), { pending }), null, 'low confidence must fail closed');
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
    selections: decision.selections,
  });
  assert.strictEqual(context.clarification_context.selected_choices[0].id, 'fish-b');
  assert.strictEqual(context.clarification_context.prior_task_contract.readiness, 'needs_clarification');
  assert.match(context.clarification_context.source_policy, /Re-run the complete router/);
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

module.exports = [
  testContinuationV4UsesOneStrictNonExecutingSchema,
  testStructuredChoiceIsValidatedThenOnlyForwardedAsRerouteContext,
  testResolvedInputIsRequiredAndNeverSynthesizedLocally,
  testNewTaskMultiIntentAndAssistanceCannotDispatch,
  testClarificationContextPreservesCurrentQuotedAndPriorSources,
];
