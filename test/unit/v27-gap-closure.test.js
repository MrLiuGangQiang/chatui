'use strict';

// v2.7 gap-closure tests: the four confirmed gaps that were not covered by
// the earlier v27 defense-kernel batch:
//   §11.5 semantic_choice (enumerable semantic ask → candidate list)
//   §8.1  Attachment Modality Preflight (visual↔document normalization)
//   §11.1 durable pending fields (state_version / idempotency_key /
//         expires_at / consumed_at) and the advance/consume lifecycle
//   §9    Visual Task changes log (append-only, retention, fold, locate)

const assert = require('assert');
const routeService = require('../../client/services/route-service');
const clarificationAnswer = require('../../shared/clarification-answer');
const changesLog = require('../../shared/changes-log');

function compile(plan, options = {}) {
  return routeService.compileLocalRoute(plan, {
    input: plan.arguments?.prompt || '',
    attachments: [],
    context: {},
    ...options,
  });
}

function previousImageExecutionContext(overrides = {}) {
  return {
    previous_execution: {
      schema_version: 'execution_continuity.v1',
      operation: 'image_reference_gen',
      family: 'generate',
      input: '生成一张猫的图片',
      result_kind: 'image',
      result_reference_id: 'imgref_prev',
      source_message_index: 1,
      source_user_message_index: 1,
      context_role: 'execution_state',
      instruction_authority: 'application_state',
    },
    image_candidates: [{
      type: 'image', index: 1, source: 'history',
      resource_id: 'res:image:prev', image_id: 'img_prev', reference_id: 'imgref_prev',
    }],
    ...overrides,
  };
}

function visualFollowupPlan(input) {
  return {
    operation: 'image_reference_gen',
    relation: 'followup',
    arguments: { prompt: input },
    bindings: [],
    constraints: [],
  };
}

// ── §11.5 semantic_choice ─────────────────────────────────────────────────

function testSemanticChoiceEnumeratesColorCandidates() {
  const route = compile(visualFollowupPlan('换个颜色'), {
    input: '换个颜色',
    context: previousImageExecutionContext(),
  });
  assert.strictEqual(route.needClarification, true);
  const slot = route.clarificationSlots.find(item => item.interaction === 'semantic_choice');
  assert.ok(slot, 'semantic_choice slot must be present for an enumerable color ask');
  assert.strictEqual(slot.key, 'p1');
  assert.strictEqual(slot.type, 'parameter');
  assert.strictEqual(slot.role, 'argument');
  assert.strictEqual(slot.parameter_name, 'color');
  assert.strictEqual(slot.parameter_label, '颜色');
  assert.strictEqual(slot.min_select, 1);
  assert.strictEqual(slot.max_select, 1);
  assert.strictEqual(slot.allow_free_text, true);
  assert.ok(Array.isArray(slot.choices) && slot.choices.length <= 6 && slot.choices.length > 0);
  assert.strictEqual(slot.choices[0].key, 'v1');
  assert.ok(slot.choices.every(choice => /^v[1-9]\d*$/.test(choice.key)));
  assert.ok(slot.choices.some(choice => String(choice.swatch_ref).startsWith('color:')));
  assert.strictEqual(route.clarificationQuestion, '想换成哪种颜色？');
}

function testSemanticChoiceEnumeratesStyleCandidates() {
  const route = compile(visualFollowupPlan('换个风格'), {
    input: '换个风格',
    context: previousImageExecutionContext(),
  });
  assert.strictEqual(route.needClarification, true);
  const slot = route.clarificationSlots.find(item => item.interaction === 'semantic_choice');
  assert.ok(slot, 'semantic_choice slot must be present for an enumerable style ask');
  assert.strictEqual(slot.parameter_name, 'style');
  assert.strictEqual(slot.question, '想换成什么风格？');
}

function testSemanticChoiceSkipsConcreteValueAlreadyNamed() {
  // "改成红色" names a concrete candidate value: the domain must not fire and
  // must not ask for what the user already gave.
  const route = compile(visualFollowupPlan('改成红色'), {
    input: '改成红色',
    context: previousImageExecutionContext(),
  });
  const slot = (route.clarificationSlots || []).find(item => item.interaction === 'semantic_choice');
  assert.strictEqual(slot, undefined, 'concrete values must not trigger semantic_choice');
}

function testSemanticChoiceFallsBackToSemanticTextForNonEnumerableAsk() {
  // "复杂一点" is an intensity tweak, not an enumerable domain: it keeps the
  // vague-visual semantic_text fallback instead of fabricating candidates.
  const route = compile(visualFollowupPlan('复杂一点'), {
    input: '复杂一点',
    context: previousImageExecutionContext(),
  });
  assert.strictEqual(route.needClarification, true);
  const slot = route.clarificationSlots.find(item => item.type === 'text');
  assert.ok(slot, 'non-enumerable vague asks must fall back to a text slot');
  assert.notStrictEqual(slot.interaction, 'semantic_choice');
}

function testSemanticChoiceAnswerBindsParameterWithoutModelCalls() {
  // §13.3 #22: picking a candidate binds the parameter directly; the round
  // counter advances by one (it consumes a completed answer), and no model
  // call budget is spent on a clarification round-trip.
  const slot = {
    key: 'p1', type: 'parameter', interaction: 'semantic_choice', role: 'argument',
    parameter_name: 'color', parameter_label: '颜色', min_select: 1, max_select: 1,
    choices: [
      { key: 'v1', value: 'red', label: '红色', swatch_ref: 'color:#ff0000' },
      { key: 'v2', value: 'blue', label: '蓝色', swatch_ref: 'color:#0000ff' },
    ],
  };
  const answer = clarificationAnswer.createClarificationAnswer({
    clarificationId: 'clr_choice',
    answers: [{ resource_key: 'p1', choice_key: 'v1' }],
  });
  const application = clarificationAnswer.applyClarificationAnswer(
    answer,
    [slot],
    { clarificationId: 'clr_choice' },
  );
  assert.strictEqual(application.complete, true);
  assert.strictEqual(application.selectedParameters.color, 'red');
  assert.deepStrictEqual(application.remainingSlots, []);

  const pending = clarificationAnswer.createPendingClarification({
    messages: [{ role: 'user', content: '换个颜色' }],
    clarificationText: '想换成哪种颜色？',
    routeInfo: { clarificationSlots: [slot] },
    id: 'clr_choice',
  });
  const advanced = clarificationAnswer.advancePendingState(pending);
  assert.strictEqual(advanced.state_version, 2);
  assert.strictEqual(advanced.idempotency_key, 'clr_choice:2');
}

// ── §8.1 Attachment Modality Preflight ────────────────────────────────────

function fileAttachment() {
  return [{ type: 'file', mime: 'application/pdf', name: 'report.pdf', file_id: 'f1', resource_id: 'res:file:f1', source: 'current' }];
}

function imageAttachment() {
  return [{ type: 'image', mime: 'image/png', name: 'pic.png', image_id: 'i1', resource_id: 'res:image:i1', reference_id: 'imgref_i1', source: 'current' }];
}

function testModalityPreflightNormalizesVisualToDocument() {
  // Model emits visual + inspect but the sole selector points at a confirmed
  // PDF: normalize to document + inspect (image_qa → file_qa).
  const plan = {
    operation: 'image_qa',
    relation: 'new',
    arguments: { prompt: '总结一下这个文件的内容' },
    bindings: [{ key: 'r1', type: 'file', role: 'attachment', resource_id: 'res:file:f1', source: 'current' }],
    constraints: [],
  };
  const route = compile(plan, { input: '总结一下这个文件的内容', attachments: fileAttachment() });
  assert.strictEqual(route.dispatchContract.operation, 'file_qa');
  assert.strictEqual(route.executionResources.operation, 'file_qa');
  assert.strictEqual(route.needClarification, false);
}

function testModalityPreflightNormalizesDocumentToVisual() {
  // Symmetric case: document + inspect with a sole image attachment and an
  // unambiguous selector normalizes to image_qa.
  const plan = {
    operation: 'file_qa',
    relation: 'new',
    arguments: { prompt: '描述一下这个内容' },
    bindings: [{ key: 'r1', type: 'image', role: 'source', resource_id: 'res:image:i1', source: 'current' }],
    constraints: [],
  };
  const route = compile(plan, { input: '描述一下这个内容', attachments: imageAttachment() });
  assert.strictEqual(route.dispatchContract.operation, 'image_qa');
  assert.strictEqual(route.needClarification, false);
}

function testModalityPreflightKeepsUserSemanticConflict() {
  // The user explicitly asked for an image while the only attachment is a
  // document: that is a user-vs-resource conflict, not a model domain slip.
  // The normalization must not fire; the conflict stays visible.
  const plan = {
    operation: 'image_qa',
    relation: 'new',
    arguments: { prompt: '分析这张图' },
    bindings: [{ key: 'r1', type: 'file', role: 'attachment', resource_id: 'res:file:f1', source: 'current' }],
    constraints: [],
  };
  const route = compile(plan, { input: '分析这张图', attachments: fileAttachment() });
  assert.notStrictEqual(route.dispatchContract && route.dispatchContract.operation, 'file_qa');
  assert.strictEqual(route.needClarification, true);
}

function testModalityPreflightSkipsMixedAttachments() {
  // Current attachments contain both an image and a file: no deterministic
  // normalization is allowed.
  const plan = {
    operation: 'image_qa',
    relation: 'new',
    arguments: { prompt: '对比一下' },
    bindings: [{ key: 'r1', type: 'file', role: 'attachment', resource_id: 'res:file:f1', source: 'current' }],
    constraints: [],
  };
  const attachments = [...fileAttachment(), ...imageAttachment()];
  const route = compile(plan, { input: '对比一下', attachments });
  assert.notStrictEqual(route.dispatchContract && route.dispatchContract.operation, 'file_qa');
}

function testModalityPreflightSkipsUnresolvedSelector() {
  // No binding means the selector is not unambiguous: keep the original plan.
  const plan = {
    operation: 'image_qa',
    relation: 'new',
    arguments: { prompt: '总结一下这个文件的内容' },
    bindings: [],
    constraints: [],
  };
  const route = compile(plan, { input: '总结一下这个文件的内容', attachments: fileAttachment() });
  assert.notStrictEqual(route.dispatchContract && route.dispatchContract.operation, 'file_qa');
}

function testModalityPreflightSkipsCreateAndEditOperations() {
  // create/transform/reference/edit must never be normalized by modality
  // preflight; only analysis operations are eligible. Use a concrete
  // generation prompt so the empty-generation clarification does not fire.
  const plan = {
    operation: 'text_to_image',
    relation: 'new',
    arguments: { prompt: '画一张红色猫咪海报，主体是猫' },
    bindings: [],
    constraints: [],
  };
  const route = compile(plan, { input: '画一张红色猫咪海报，主体是猫', attachments: fileAttachment() });
  assert.strictEqual(route.dispatchContract && route.dispatchContract.operation, 'text_to_image');
}

// ── §11.1 durable pending fields ──────────────────────────────────────────

function testPendingClarificationCarriesDurableFields() {
  const before = Date.now();
  const pending = clarificationAnswer.createPendingClarification({
    messages: [{ role: 'user', content: '生成一张图' }],
    clarificationText: '请选择',
    routeInfo: { clarificationSlots: [] },
    id: 'clr_durable',
  });
  assert.strictEqual(pending.schema_version, 'pending_clarification.v2.1');
  assert.strictEqual(pending.id, 'clr_durable');
  assert.strictEqual(pending.state_version, 1);
  assert.strictEqual(pending.status, 'pending');
  assert.strictEqual(pending.idempotency_key, 'clr_durable:1');
  assert.strictEqual(pending.consumed_at, null);
  assert.strictEqual(pending.created_at, pending.createdAt);
  assert.ok(pending.created_at >= before);
  assert.ok(pending.expires_at > pending.created_at);
}

function testAdvancePendingStateBumpsVersionAndRefreshesKey() {
  const pending = clarificationAnswer.createPendingClarification({
    messages: [{ role: 'user', content: '生成一张图' }],
    clarificationText: '请选择',
    routeInfo: { clarificationSlots: [] },
    id: 'clr_advance',
  });
  const advanced = clarificationAnswer.advancePendingState(pending);
  assert.strictEqual(advanced.state_version, 2);
  assert.strictEqual(advanced.idempotency_key, 'clr_advance:2');
  assert.strictEqual(advanced.status, 'pending');
  const third = clarificationAnswer.advancePendingState(advanced);
  assert.strictEqual(third.state_version, 3);
  assert.strictEqual(third.idempotency_key, 'clr_advance:3');
}

function testConsumePendingClarificationMarksConsumed() {
  const pending = clarificationAnswer.createPendingClarification({
    messages: [{ role: 'user', content: '生成一张图' }],
    clarificationText: '请选择',
    routeInfo: { clarificationSlots: [] },
    id: 'clr_consume',
  });
  assert.strictEqual(clarificationAnswer.isPendingConsumed(pending), false);
  const consumed = clarificationAnswer.consumePendingClarification(pending, { consumedAt: 12345 });
  assert.strictEqual(consumed.status, 'consumed');
  assert.strictEqual(consumed.consumed_at, 12345);
  assert.strictEqual(clarificationAnswer.isPendingConsumed(consumed), true);
}

function testExpiredPendingReportsExpiredStatus() {
  const pending = clarificationAnswer.createPendingClarification({
    messages: [{ role: 'user', content: '生成一张图' }],
    clarificationText: '请选择',
    routeInfo: { clarificationSlots: [] },
    id: 'clr_expire',
  });
  const expired = clarificationAnswer.normalizePendingClarification({
    ...pending,
    expires_at: Date.now() - 1000,
    status: 'pending',
    consumed_at: null,
  });
  assert.strictEqual(expired.status, 'expired');
}

function testPendingStateChangePointsAdvanceVersion() {
  // Every state mutation point must route through advancePendingState so the
  // idempotency key never repeats: applyPendingClarificationAnswer,
  // mergePendingInput, createPendingRelationClarification and
  // applyPendingRelationAnswer.
  const pending = clarificationAnswer.createPendingClarification({
    messages: [{ role: 'user', content: '生成一张图' }],
    clarificationText: '请选择',
    routeInfo: { clarificationSlots: [] },
    id: 'clr_points',
  });
  const merged = clarificationAnswer.mergePendingInput(pending, { promptText: '补充说明' });
  assert.strictEqual(merged.pending.state_version, 2);
  assert.strictEqual(merged.pending.idempotency_key, 'clr_points:2');

  const answer = clarificationAnswer.createClarificationAnswer({
    clarificationId: 'clr_points',
    answers: [],
  });
  const applied = clarificationAnswer.applyPendingClarificationAnswer(pending, answer);
  assert.strictEqual(applied.pending.state_version, 2);
  assert.strictEqual(applied.pending.idempotency_key, 'clr_points:2');
}

// ── §9 Visual Task changes log ────────────────────────────────────────────

function testChangesLogIsAppendOnlyAndBoundedByRetention() {
  let log = [];
  for (let index = 1; index <= 25; index += 1) {
    log = changesLog.appendChangesEntry(log, {
      state_version: index,
      changes: [{ path: 'subject.color', op: 'set', value: `c${index}` }],
      source: 'intent',
    });
  }
  // 25 entries with retention 20 → 1 folded summary + 20 live entries.
  assert.strictEqual(log.length, 21);
  assert.strictEqual(log[0].folded, true);
  assert.strictEqual(log[log.length - 1].state_version, 25);
  const latest = changesLog.latestChangesFor(log);
  assert.deepStrictEqual(latest.changes, [{ path: 'subject.color', op: 'set', value: 'c25' }]);
}

function testChangesLogFoldsOlderEntriesIntoFinalMergedResult() {
  let log = [];
  for (let index = 1; index <= 22; index += 1) {
    log = changesLog.appendChangesEntry(log, {
      state_version: index,
      changes: [{ path: 'subject.color', op: 'set', value: `c${index}` }],
      source: index % 2 === 0 ? 'clarification' : 'intent',
    });
  }
  const folded = log[0];
  assert.strictEqual(folded.folded, true);
  // Folded summary keeps only the final merged result (last write wins).
  assert.deepStrictEqual(folded.changes, [{ path: 'subject.color', op: 'set', value: 'c2' }]);
}

function testChangesLogLocatesPreviousRoundForCorrection() {
  let log = [];
  log = changesLog.appendChangesEntry(log, {
    state_version: 1,
    changes: [{ path: 'subject.color', op: 'set', value: 'red' }],
    source: 'intent',
  });
  log = changesLog.appendChangesEntry(log, {
    state_version: 2,
    changes: [{ path: 'subject.style', op: 'set', value: 'watercolor' }],
    preserve: ['subject'],
    source: 'clarification',
  });
  // "刚才说的颜色不对" style corrections locate the previous round through the
  // log instead of guessing from a merged snapshot.
  const previous = changesLog.latestChangesFor(log);
  assert.strictEqual(previous.state_version, 2);
  assert.deepStrictEqual(previous.changes, [{ path: 'subject.style', op: 'set', value: 'watercolor' }]);
  assert.deepStrictEqual(previous.preserve, ['subject']);
  assert.strictEqual(previous.source, 'clarification');
}

function testChangesLogRejectsSensitiveContent() {
  const sanitized = changesLog.sanitizeChangesEntry({
    state_version: 1,
    changes: [
      { path: 'subject.color', op: 'set', value: 'red' },
      { path: 'prompt', op: 'set', value: 'forbidden prompt' },
      { path: 'subject.style', op: 'set', value: 'api_key=sk-123' },
      { path: 'subject.detail', op: 'set', value: { token: 'secret', color: 'blue' } },
    ],
    source: 'intent',
  });
  assert.ok(sanitized);
  assert.deepStrictEqual(sanitized.changes, [
    { path: 'subject.color', op: 'set', value: 'red' },
    { path: 'subject.detail', op: 'set', value: { color: 'blue' } },
  ]);
}

module.exports = [
  testSemanticChoiceEnumeratesColorCandidates,
  testSemanticChoiceEnumeratesStyleCandidates,
  testSemanticChoiceSkipsConcreteValueAlreadyNamed,
  testSemanticChoiceFallsBackToSemanticTextForNonEnumerableAsk,
  testSemanticChoiceAnswerBindsParameterWithoutModelCalls,
  testModalityPreflightNormalizesVisualToDocument,
  testModalityPreflightNormalizesDocumentToVisual,
  testModalityPreflightKeepsUserSemanticConflict,
  testModalityPreflightSkipsMixedAttachments,
  testModalityPreflightSkipsUnresolvedSelector,
  testModalityPreflightSkipsCreateAndEditOperations,
  testPendingClarificationCarriesDurableFields,
  testAdvancePendingStateBumpsVersionAndRefreshesKey,
  testConsumePendingClarificationMarksConsumed,
  testExpiredPendingReportsExpiredStatus,
  testPendingStateChangePointsAdvanceVersion,
  testChangesLogIsAppendOnlyAndBoundedByRetention,
  testChangesLogFoldsOlderEntriesIntoFinalMergedResult,
  testChangesLogLocatesPreviousRoundForCorrection,
  testChangesLogRejectsSensitiveContent,
];
