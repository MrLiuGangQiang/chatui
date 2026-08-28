'use strict';

const assert = require('assert');
const clarificationAnswer = require('../../shared/clarification-answer');

function slots() {
  return [
    {
      key: 'r1', type: 'image', role: 'target', reason: 'ambiguous', choices: [
        { key: 'c1', source: 'history', index: 1, id: 'img-a', resource_id: 'res:image:img-a', reference_id: 'ref-a', label: '图片 A' },
        { key: 'c2', source: 'history', index: 2, id: 'img-b', resource_id: 'res:image:img-b', reference_id: 'ref-b', label: '图片 B' },
      ],
    },
    {
      key: 'p1', type: 'parameter', role: 'argument', reason: 'ambiguous', parameter_name: 'quality', choices: [
        { key: 'v1', label: '低质量', value: 'low' },
        { key: 'v2', label: '高质量', value: 'high' },
      ],
    },
  ];
}

function testClarificationAnswerUsesAnExactVersionedShape() {
  const answer = clarificationAnswer.createClarificationAnswer({
    clarificationId: 'clarify-1',
    answers: [{ resource_key: 'r1', choice_key: 'c2' }],
    freeText: '选择第二张',
  });
  assert.strictEqual(clarificationAnswer.hasExactClarificationAnswer(answer), true);
  assert.strictEqual(Object.isFrozen(answer), true);
  assert.strictEqual(Object.isFrozen(answer.answers), true);
  assert.strictEqual(clarificationAnswer.hasExactClarificationAnswer({ ...answer, extra: true }), false);
  assert.throws(() => clarificationAnswer.createClarificationAnswer({
    clarificationId: 'clarify-1',
    answers: [{ resource_key: 'r1', choice_key: 'c1' }, { resource_key: 'r1', choice_key: 'c2' }],
  }), error => error?.code === 'CLARIFICATION_ANSWER_INVALID');
}

function testClarificationAnswerRejectsAStaleClarificationId() {
  const answer = clarificationAnswer.createClarificationAnswer({
    clarificationId: 'clarify-old', answers: [{ resource_key: 'r1', choice_key: 'c1' }],
  });
  assert.throws(
    () => clarificationAnswer.assertClarificationId(answer, 'clarify-current'),
    error => error?.code === 'CLARIFICATION_ANSWER_ID_MISMATCH',
  );
}

function testSingleChoiceNumericAnswerIsDeterministic() {
  const answer = clarificationAnswer.parseClarificationAnswer('第 2 张', {
    clarificationId: 'clarify-1', slots: [slots()[0]],
  });
  assert.deepStrictEqual(answer.answers, [{ resource_key: 'r1', choice_key: 'c2' }]);
  assert.strictEqual(clarificationAnswer.parseClarificationAnswer('第二张看起来更好', {
    clarificationId: 'clarify-1', slots: [slots()[0]],
  }), null, 'free-form text must not be guessed into a structured choice');
}

function testSingleChoiceLastPositionAnswerIsDeterministic() {
  const imageSlot = {
    key: 'r1', type: 'image', role: 'target', reason: 'ambiguous',
    choices: Array.from({ length: 22 }, (_, index) => ({
      key: `c${index + 1}`, source: 'history', index: index + 1,
      id: `img-${index + 1}`, resource_id: `res:image:img-${index + 1}`,
      reference_id: `ref-${index + 1}`, label: `候选图片 ${index + 1}`,
    })),
  };
  const input = '最后一张呢';
  assert.strictEqual(clarificationAnswer.clarificationAnswerInputKind(input, { slots: [imageSlot] }), 'single_selection',
    'a last-position reply must stay in the active clarification flow');
  const answer = clarificationAnswer.parseClarificationAnswer(input, {
    clarificationId: 'clarify-last', slots: [imageSlot],
  });
  assert.deepStrictEqual(answer.answers, [{ resource_key: 'r1', choice_key: 'c22' }],
    'the last-position reply must select the final presented candidate');
  assert.strictEqual(clarificationAnswer.parseClarificationAnswer('最后一张看起来更好', {
    clarificationId: 'clarify-last', slots: [imageSlot],
  }), null, 'free-form commentary must not be guessed into a structured choice');
  assert.strictEqual(clarificationAnswer.parseClarificationAnswer(input, {
    clarificationId: 'clarify-last', slots: [imageSlot, slots()[1]],
  }), null, 'a relative position cannot choose across multiple clarification slots');
}

function testMultipleChoiceSlotsRequireExplicitKeysOrGroups() {
  const keyed = clarificationAnswer.parseClarificationAnswer('r1=c2 p1=v1', {
    clarificationId: 'clarify-1', slots: slots(),
  });
  assert.deepStrictEqual(keyed.answers, [
    { resource_key: 'r1', choice_key: 'c2' },
    { resource_key: 'p1', choice_key: 'v1' },
  ]);
  const grouped = clarificationAnswer.parseClarificationAnswer('第1组选2，第2组选1', {
    clarificationId: 'clarify-1', slots: slots(),
  });
  assert.deepStrictEqual(grouped.answers, [
    { resource_key: 'r1', choice_key: 'c2' },
    { resource_key: 'p1', choice_key: 'v1' },
  ]);
  assert.strictEqual(clarificationAnswer.parseClarificationAnswer('2', {
    clarificationId: 'clarify-1', slots: slots(),
  }), null, 'one bare ordinal cannot choose across multiple slots');
}

function testApplyingAnswerSeparatesResourceAndParameterSelections() {
  const answer = clarificationAnswer.parseClarificationAnswer('r1=c2 p1=v2', {
    clarificationId: 'clarify-1', slots: slots(),
  });
  const applied = clarificationAnswer.applyClarificationAnswer(answer, slots(), { clarificationId: 'clarify-1' });
  assert.strictEqual(applied.complete, true);
  assert.deepStrictEqual(applied.selectedParameters, { quality: 'high' });
  assert.deepStrictEqual(applied.selectedResources, [{
    resource_key: 'r1', choice_key: 'c2', type: 'image', role: 'target', source: 'history', index: 2,
    id: 'img-b', resource_id: 'res:image:img-b', reference_id: 'ref-b', label: '图片 B',
  }]);
}

function testClarificationContextSeparatesEstablishedAndSelectedResources() {
  const established = {
    key: 'r1', type: 'image', role: 'reference', source: 'history', index: 1,
    id: 'img-cat', resource_id: 'res:image:img-cat', reference_id: 'ref-cat', label: '猫',
  };
  const pending = clarificationAnswer.createPendingClarification({
    id: 'clarify-compose',
    messages: [{ role: 'user', content: '把猫和鱼合并成一张图' }],
    clarificationText: '请选择鱼。',
    routeInfo: {
      operationType: 'image_reference_gen',
      relation: 'followup',
      resources: [established],
      clarificationSlots: [{
        key: 'r2', type: 'image', role: 'reference', reason: 'ambiguous', choices: [{
          key: 'c1', source: 'history', index: 2, id: 'img-fish',
          resource_id: 'res:image:img-fish', reference_id: 'ref-fish', label: '彩色鱼',
        }],
      }],
    },
  });
  const answer = clarificationAnswer.createClarificationAnswer({
    clarificationId: pending.id,
    answers: [{ resource_key: 'r2', choice_key: 'c1' }],
    freeText: '彩色鱼',
  });
  const applied = clarificationAnswer.applyPendingClarificationAnswer(pending, answer);
  const context = clarificationAnswer.buildClarificationRouteContext({ pending: applied.pending });

  assert.deepStrictEqual(context.clarification_context.established_resources, [established]);
  assert.deepStrictEqual(context.clarification_context.selected_resources.map(resource => resource.id), ['img-fish']);
  assert.deepStrictEqual(context.image_candidates.map(candidate => candidate.image_id), ['img-fish', 'img-cat'],
    'new selections and pre-clarification bindings must both survive the reroute handoff');
}

function testAnswerBuildsAResolvedClarificationContext() {
  const pending = clarificationAnswer.createPendingClarification({
    id: 'clarify-1',
    messages: [{ role: 'user', content: '把背景改成蓝色' }],
    clarificationText: '请选择目标图片。',
    routeInfo: {
      operationType: 'edit_image',
      relation: 'followup',
      resources: [],
      clarificationSlots: [slots()[0]],
    },
  });
  const answer = clarificationAnswer.parseClarificationAnswer('2', {
    clarificationId: 'clarify-1', slots: [slots()[0]],
  });
  const applied = clarificationAnswer.applyPendingClarificationAnswer(pending, answer);
  const context = clarificationAnswer.buildClarificationRouteContext({ pending: applied.pending });
  assert.strictEqual(context.clarification_context.schema_version, 'clarification_context.v4');
  assert.strictEqual(context.clarification_context.operation, 'edit_image');
  assert.strictEqual(context.clarification_context.relation, 'followup');
  assert.strictEqual(context.clarification_context.answer_complete, true);
  assert.deepStrictEqual(context.clarification_context.selected_parameters, {});
  assert.deepStrictEqual(context.clarification_context.selected_resources, [{
    resource_key: 'r1', choice_key: 'c2', type: 'image', role: 'target', source: 'history', index: 2,
    id: 'img-b', resource_id: 'res:image:img-b', reference_id: 'ref-b', label: '图片 B',
  }]);
}

function testFreeTextAnswerResolvesTextOnlyClarificationSlots() {
  // An image-instruction materialization clarification asks an open-ended
  // question ("what kind of cat?") with a free-text slot that has no choices.
  // The user's free-text reply (including delegation such as "你随机") must
  // resolve that slot; otherwise the system re-asks forever because no answer
  // is ever recorded and the clarification round counter never advances.
  const textSlot = { key: 'r1', type: 'text', role: 'source', reason: 'missing', choices: [] };
  const pending = clarificationAnswer.createPendingClarification({
    id: 'clarify-free-text',
    messages: [{ role: 'user', content: '继续画一只猫' }],
    clarificationText: '请问您希望我继续画一只什么样的猫？例如：品种、毛色、姿态、场景或风格等，请提供具体要求。',
    routeInfo: {
      operationType: 'text_to_image',
      relation: 'continuation',
      clarificationSlots: [textSlot],
    },
  });
  const answer = clarificationAnswer.parseClarificationAnswer('你随机', {
    clarificationId: pending.id,
    slots: [textSlot],
  });
  assert.ok(answer, 'a free-text answer must be parsed when the clarification has only text slots');
  assert.strictEqual(answer.free_text, '你随机');
  assert.deepStrictEqual(answer.answers, [], 'a free-text answer must not fabricate structured choices');

  const applied = clarificationAnswer.applyPendingClarificationAnswer(pending, answer);
  assert.strictEqual(applied.complete, true, 'a free-text answer must complete a text-only clarification');

  const context = clarificationAnswer.buildClarificationRouteContext({ pending: applied.pending });
  assert.strictEqual(context.clarification_context.answer_complete, true);
  assert.strictEqual(context.clarification_context.free_text, '你随机');
  assert.deepStrictEqual(context.clarification_context.unresolved_resources, [],
    'a resolved text slot must not remain in unresolved_resources');
}

function testConcreteFreeTextAnswerAlsoResolvesTextOnlyClarificationSlots() {
  const textSlot = { key: 'r1', type: 'text', role: 'source', reason: 'missing', choices: [] };
  const pending = clarificationAnswer.createPendingClarification({
    id: 'clarify-free-text-2',
    messages: [{ role: 'user', content: '继续画一只猫' }],
    clarificationText: '请问您希望我继续画一只什么样的猫？',
    routeInfo: {
      operationType: 'text_to_image',
      relation: 'continuation',
      clarificationSlots: [textSlot],
    },
  });
  const answer = clarificationAnswer.parseClarificationAnswer('橘猫', {
    clarificationId: pending.id,
    slots: [textSlot],
  });
  assert.ok(answer, 'a concrete free-text answer must also resolve a text-only clarification');
  const applied = clarificationAnswer.applyPendingClarificationAnswer(pending, answer);
  assert.strictEqual(applied.complete, true);
}

function testFreeFormCommentaryStillNeverGuessesIntoChoiceSlots() {
  // Regression guard: free-form commentary against choice-bearing slots must
  // stay null; only pure free-text slots may accept a free-text answer.
  const choiceSlot = { key: 'r1', type: 'image', role: 'target', reason: 'ambiguous', choices: [{ key: 'c1', label: 'A' }, { key: 'c2', label: 'B' }] };
  assert.strictEqual(clarificationAnswer.parseClarificationAnswer('第二张看起来更好', {
    clarificationId: 'clarify-1', slots: [choiceSlot],
  }), null, 'free-form commentary must not be guessed into a structured choice');
  assert.strictEqual(clarificationAnswer.parseClarificationAnswer('你随机', {
    clarificationId: 'clarify-1', slots: [choiceSlot],
  }), null, 'a delegation phrase must not silently pick a structured choice');
}

module.exports = [
  testClarificationAnswerUsesAnExactVersionedShape,
  testClarificationAnswerRejectsAStaleClarificationId,
  testSingleChoiceNumericAnswerIsDeterministic,
  testSingleChoiceLastPositionAnswerIsDeterministic,
  testMultipleChoiceSlotsRequireExplicitKeysOrGroups,
  testApplyingAnswerSeparatesResourceAndParameterSelections,
  testClarificationContextSeparatesEstablishedAndSelectedResources,
  testAnswerBuildsAResolvedClarificationContext,
  testFreeTextAnswerResolvesTextOnlyClarificationSlots,
  testConcreteFreeTextAnswerAlsoResolvesTextOnlyClarificationSlots,
  testFreeFormCommentaryStillNeverGuessesIntoChoiceSlots,
];
