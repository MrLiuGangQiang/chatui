'use strict';

const assert = require('assert');
const fs = require('fs');
const path = require('path');

const clarification = require('../../client/services/clarification-service');
const routeService = require('../../client/services/route-service');

function semanticTask(overrides = {}) {
  return {
    schema_version: 'semantic_task.v2',
    actions: ['respond'],
    discourse: 'continuation',
    pending_effect: 'answer',
    slots: [],
    changes: [],
    constraints: [],
    ...overrides,
  };
}

function ambiguousEditContract() {
  return {
    schema_version: 'task_contract.v5',
    readiness: 'needs_clarification',
    operation: 'edit_image',
    relation: 'followup',
    resources: [],
    directive: {
      mode: 'patch', base_resource_keys: ['r1'], unmentioned_policy: 'preserve',
      operations: [{ op: 'replace', target: '狗的颜色', value: '黑色' }], constraints: ['保持背景'],
    },
    clarification: {
      question: '请选择目标狗图。',
      unresolved_resources: [{
        key: 'r1', type: 'image', role: 'target', reason: 'ambiguous',
        choices: [
          { key: 'c1', source: 'history', index: 1, id: 'dog-a', reference_id: 'dog-a-ref', label: '狗图 A' },
          { key: 'c2', source: 'history', index: 2, id: 'dog-b', reference_id: 'dog-b-ref', label: '狗图 B' },
        ],
      }],
    },
    confidence: 1,
    review_reasons: [],
    rationale: '',
  };
}

function pendingFor(contract = ambiguousEditContract(), semantic = semanticTask({
  actions: ['edit'], pending_effect: 'none', discourse: 'followup',
  slots: [{ kind: 'image', purpose: 'target', label: '目标狗图', resolution: 'ambiguous', candidate_keys: ['i1', 'i2'] }],
  changes: [{ op: 'replace', target: '狗的颜色', value: '黑色' }],
  constraints: ['保持背景'],
})) {
  return clarification.createPendingClarification({
    messages: [{ role: 'user', content: '把狗改成黑色，保持背景' }],
    clarificationText: contract.clarification.question,
    routeInfo: {
      mode: 'edit_image', api: 'clarify', readiness: 'needs_clarification', needClarification: true,
      clarificationQuestion: contract.clarification.question, taskContract: contract, semanticTask: semantic,
    },
  });
}

function imageContext() {
  return {
    image_candidates: [
      { index: 1, source: 'history', image_id: 'dog-a', reference_id: 'dog-a-ref', description: '狗图 A' },
      { index: 2, source: 'history', image_id: 'dog-b', reference_id: 'dog-b-ref', description: '狗图 B' },
    ],
  };
}

function inspectSemantic(task, options) {
  return routeService.inspectRouteResult(JSON.stringify(task), options);
}

function testPendingClarificationIdentityIsCreatedOnceAndMigratedExplicitly() {
  const created = clarification.createPendingClarification({
    messages: [{ role: 'user', content: '把猫改成黑色' }],
    clarificationText: '请选择要修改的图片。',
  });
  assert.match(created.id, /^clarify-/);
  assert.strictEqual(clarification.normalizePendingClarification(created).id, created.id);

  const legacy = { originalText: '把猫改成黑色', clarificationText: '请选择要修改的图片。' };
  assert.strictEqual(clarification.normalizePendingClarification(legacy).id, '');
  const migrated = clarification.migratePendingClarification(legacy);
  assert.match(migrated.id, /^clarify-/);
  assert.strictEqual(clarification.migratePendingClarification(migrated).id, migrated.id);
}

function testIndependentContinuationClassifierWasRemoved() {
  const source = fs.readFileSync(path.join(__dirname, '../../client/services/clarification-service.js'), 'utf8');
  for (const name of [
    'buildContinuationClassifierPayload', 'buildContinuationRepairPayload',
    'parseContinuationClassifierResult', 'CONTINUATION_SYSTEM_PROMPT', 'CONTINUATION_RESPONSE_FORMAT',
  ]) {
    assert.strictEqual(clarification[name], undefined, `${name} must not remain as a second semantic router`);
  }
  assert.ok(!source.includes('pending_continuation.v6'));
  assert.ok(!source.includes('assistant_reply'));
}

function testClarificationContextHasOneCanonicalPendingTaskAndPublicPayloadIsSemanticOnly() {
  const pending = pendingFor();
  const context = clarification.buildClarificationRouteContext({ baseContext: imageContext(), pending });
  assert.strictEqual(context.clarification_context.schema_version, 'clarification_context.v3');
  assert.deepStrictEqual(Object.keys(context.clarification_context), ['schema_version', 'pending_task']);
  assert.strictEqual(context.clarification_context.pending_task.base_input, '把狗改成黑色，保持背景');
  assert.ok(context.clarification_context.pending_task.prior_task_contract);
  assert.ok(context.clarification_context.pending_task.prior_semantic_task);

  const payload = routeService.buildRoutePayload({ model: 'route-model', input: '第二张', context, attachments: [] });
  const user = JSON.parse(payload.messages[1].content);
  const publicPending = user.context.clarification_context.pending_task;
  assert.strictEqual(publicPending.base_input, '把狗改成黑色，保持背景');
  assert.deepStrictEqual(publicPending.prior_actions, ['edit']);
  assert.deepStrictEqual(publicPending.unresolved[0].candidate_keys, ['i1', 'i2']);
  assert.strictEqual(Object.hasOwn(publicPending, 'prior_task_contract'), false);
  assert.strictEqual(Object.hasOwn(publicPending, 'prior_semantic_task'), false);
  assert.strictEqual(JSON.stringify(user).includes('task_contract.v5'), false, 'mechanical task contracts must not be sent back to the model');
}

function testMergePendingInputIsDeterministicAndNeverAcceptsModelRewriting() {
  const pending = pendingFor();
  const first = clarification.mergePendingInput(pending, {
    promptText: '第二张',
    resolvedInput: '模型擅自改写的内容',
  });
  assert.strictEqual(first.promptText, '把狗改成黑色，保持背景\n\n第二张');
  assert.strictEqual(first.resolvedInput, first.promptText);
  assert.deepStrictEqual(first.pending.supplements, ['第二张']);
}

function testPendingResourceOriginsPreserveHistoricalIdentity() {
  const contract = ambiguousEditContract();
  contract.resources = [{
    key: 'r0', type: 'image', source: 'current', role: 'reference', index: 3,
    id: 'reference-dog', reference_id: 'reference-dog-ref', missing: false,
  }];
  const origins = clarification.pendingResourceOrigins(pendingFor(contract));
  assert.ok(origins.some(item => item.id === 'reference-dog' && item.source === 'history' && item.index === 3));
  assert.ok(origins.some(item => item.id === 'dog-b' && item.role === 'target'));
}

function testPureResourceSelectionPreservesOriginalOperationAndDirective() {
  const pending = pendingFor();
  const context = clarification.buildClarificationRouteContext({ baseContext: imageContext(), pending });
  const inspected = inspectSemantic(semanticTask({
    actions: ['respond'],
    slots: [{ kind: 'image', purpose: 'target', label: '目标狗图', resolution: 'bound', candidate_keys: ['i2'] }],
  }), { input: '第二张', attachments: [], context });
  assert.ok(inspected.route, inspected.reason);
  assert.strictEqual(inspected.route.operationType, 'edit_image');
  assert.strictEqual(inspected.route.needClarification, false);
  assert.deepStrictEqual(inspected.route.taskContract.directive.operations, [{ op: 'replace', target: '狗的颜色', value: '黑色' }]);
  assert.deepStrictEqual(inspected.route.taskContract.directive.constraints, ['保持背景']);
  assert.strictEqual(inspected.route.taskContract.resources[0].id, 'dog-b');
  assert.strictEqual(inspected.route.taskContract.resources[0].role, 'target');
}

function testPartialAnswerKeepsUnansweredSemanticValueMissing() {
  const priorSemantic = semanticTask({
    actions: ['edit'], discourse: 'independent', pending_effect: 'none',
    slots: [
      { kind: 'image', purpose: 'target', label: '目标图片', resolution: 'bound', candidate_keys: ['i1'] },
      { kind: 'text', purpose: 'change_value', label: '目标颜色', resolution: 'missing', candidate_keys: [] },
    ],
  });
  const contract = {
    schema_version: 'task_contract.v5', readiness: 'needs_clarification', operation: 'edit_image', relation: 'new',
    resources: [{ key: 'r1', type: 'image', source: 'history', role: 'target', index: 1, id: 'cat', reference_id: 'cat-ref', missing: false }],
    directive: { mode: 'patch', base_resource_keys: ['r1', 'r2'], unmentioned_policy: 'preserve', operations: [], constraints: [] },
    clarification: { question: '请补充目标颜色。', unresolved_resources: [{ key: 'r2', type: 'text', role: 'source', reason: 'missing', choices: [] }] },
    confidence: 1, review_reasons: [], rationale: '',
  };
  const pending = pendingFor(contract, priorSemantic);
  const context = clarification.buildClarificationRouteContext({
    baseContext: { image_candidates: [{ index: 1, source: 'history', image_id: 'cat', reference_id: 'cat-ref', description: '猫图' }] },
    pending,
  });
  const partial = inspectSemantic(semanticTask({ pending_effect: 'partial' }), { input: '先保持背景', attachments: [], context });
  assert.ok(partial.route);
  assert.strictEqual(partial.route.operationType, 'edit_image');
  assert.strictEqual(partial.route.needClarification, true);
  assert.match(partial.route.clarificationQuestion, /目标颜色/);

  const complete = inspectSemantic(semanticTask({
    actions: ['edit'],
    changes: [{ op: 'replace', target: '猫的颜色', value: '黑色' }],
  }), { input: '黑色', attachments: [], context });
  assert.ok(complete.route);
  assert.strictEqual(complete.route.needClarification, false);
}

function testPendingAssistanceAndNewTaskDoNotInheritExecutionSemantics() {
  const pending = pendingFor();
  const context = clarification.buildClarificationRouteContext({ baseContext: imageContext(), pending });
  const assistance = inspectSemantic(semanticTask({
    actions: ['respond'], discourse: 'followup', pending_effect: 'assistance', slots: [], changes: [], constraints: [],
  }), { input: '你能解释一下怎么选吗', attachments: [], context });
  assert.ok(assistance.route);
  assert.strictEqual(assistance.route.operationType, 'plain_chat');
  assert.strictEqual(assistance.route.needClarification, false);
  assert.deepStrictEqual(assistance.route.taskContract.resources, []);

  const fresh = inspectSemantic(semanticTask({
    actions: ['generate'], discourse: 'independent', pending_effect: 'new_task', slots: [], changes: [], constraints: [],
  }), { input: '画一只猫', attachments: [], context });
  assert.ok(fresh.route);
  assert.strictEqual(fresh.route.operationType, 'text_to_image');
  assert.strictEqual(fresh.route.relation, 'new');
  assert.deepStrictEqual(fresh.route.taskContract.resources, []);
}

function testUnavailablePriorResourceFailsClosed() {
  const contract = {
    schema_version: 'task_contract.v5', readiness: 'needs_clarification', operation: 'file_qa', relation: 'followup',
    resources: [{ key: 'r1', type: 'file', source: 'history', role: 'attachment', index: 1, id: 'lost-file', reference_id: '', missing: false }],
    directive: { mode: 'patch', base_resource_keys: ['r1', 'r2'], unmentioned_policy: 'preserve', operations: [], constraints: [] },
    clarification: { question: '请补充分析范围。', unresolved_resources: [{ key: 'r2', type: 'text', role: 'source', reason: 'missing', choices: [] }] },
    confidence: 1, review_reasons: [], rationale: '',
  };
  const priorSemantic = semanticTask({
    actions: ['respond'], pending_effect: 'none',
    slots: [{ kind: 'file', purpose: 'attachment', label: '工作簿', resolution: 'bound', candidate_keys: ['f1'] }],
  });
  const pending = pendingFor(contract, priorSemantic);
  const context = clarification.buildClarificationRouteContext({ baseContext: {}, pending });
  const inspected = inspectSemantic(semanticTask({ actions: ['respond'], slots: [] }), {
    input: '分析趋势', attachments: [], context,
  });
  assert.ok(inspected.route);
  assert.strictEqual(inspected.route.operationType, 'file_qa');
  assert.strictEqual(inspected.route.needClarification, true);
  assert.match(inspected.route.clarificationQuestion, /不可用/);
  assert.strictEqual(routeService.isRouteDispatchable(inspected.route), false);
}

function testPendingClarificationSnapshotsHistoricalAttachmentContexts() {
  const routeInfo = {
    taskContract: {
      schema_version: 'task_contract.v5', resources: [
        { key: 'r1', type: 'file', source: 'history', role: 'attachment', index: 1, id: 'book-1', reference_id: '', missing: false },
      ],
      clarification: { unresolved_resources: [] },
    },
  };
  const historicalContext = { attachments: [{ id: 'book-1', name: 'book.xlsx', type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' }] };
  const contexts = clarification.collectPendingAttachmentContexts({
    messages: [{ role: 'user', attachmentContext: JSON.stringify(historicalContext) }],
    routeInfo,
  });
  assert.deepStrictEqual(contexts, [historicalContext]);
}

function testCompletedClarificationReplayPersistsConfirmedRoundsAndSupportsEdit() {
  const pending = clarification.createPendingClarification({
    messages: [{ role: 'user', content: '生成产品海报' }],
    clarificationText: '请补充颜色和版式。',
    routeInfo: { mode: 'image', api: 'clarify', taskContract: { schema_version: 'task_contract.v5' } },
  });
  const first = clarification.mergePendingInput(pending, { promptText: '橙色' });
  const second = clarification.mergePendingInput(first.pending, { promptText: '竖版' });
  const replay = clarification.createClarificationReplay({
    pending: first.pending,
    merge: second,
    routeInfo: { mode: 'image', api: 'image_generation', taskContract: { schema_version: 'task_contract.v5', readiness: 'ready' } },
    clarificationRouteContext: { clarification_context: { schema_version: 'clarification_context.v3' } },
  });
  assert.deepStrictEqual(replay.supplements, ['橙色', '竖版']);
  assert.strictEqual(replay.resolvedInput, '生成产品海报\n\n橙色\n\n竖版');
  const revised = clarification.reviseClarificationReplay(replay, '方形');
  assert.deepStrictEqual(revised.supplements, ['橙色', '方形']);
}

module.exports = [
  testPendingClarificationIdentityIsCreatedOnceAndMigratedExplicitly,
  testIndependentContinuationClassifierWasRemoved,
  testClarificationContextHasOneCanonicalPendingTaskAndPublicPayloadIsSemanticOnly,
  testMergePendingInputIsDeterministicAndNeverAcceptsModelRewriting,
  testPendingResourceOriginsPreserveHistoricalIdentity,
  testPureResourceSelectionPreservesOriginalOperationAndDirective,
  testPartialAnswerKeepsUnansweredSemanticValueMissing,
  testPendingAssistanceAndNewTaskDoNotInheritExecutionSemantics,
  testUnavailablePriorResourceFailsClosed,
  testPendingClarificationSnapshotsHistoricalAttachmentContexts,
  testCompletedClarificationReplayPersistsConfirmedRoundsAndSupportsEdit,
];
