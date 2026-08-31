'use strict';

const assert = require('assert');
const routeService = require('../../client/services/route-service');

function understanding(dependency, candidateKey = 'i5', kind = 'image_read', target = '第五张') {
  return {
    schema_version: 'intent_understanding.v1',
    dependency,
    actions: [{
      index: 1,
      kind,
      target,
      resolved_refs: candidateKey ? [{ candidate_key: candidateKey, text: target }] : [],
    }],
  };
}

function historyCatalog() {
  return [
    { candidate_key: 'i1', source: 'history', type: 'image', index: 1 },
    { candidate_key: 'i5', source: 'history', type: 'image', index: 5 },
  ];
}

function anchoredContext() {
  return {
    recent_messages: [
      { index: 1, role: 'user', content: '第一张是什么颜色？' },
      { index: 2, role: 'assistant', content: '第一张是蓝色。' },
    ],
    previous_resource_execution: {
      operation: 'image_qa',
      image_count: 1,
      file_count: 0,
      source_message_index: 1,
      response_message_index: 2,
      images: [{ image_id: 'img-1', reference_id: 'imgref-1', index: 1 }],
      files: [],
    },
    image_candidates: Array.from({ length: 5 }, (_, index) => ({
      index: index + 1,
      source_index: index + 1,
      source: 'history',
      image_id: `img-${index + 1}`,
      reference_id: `imgref-${index + 1}`,
      description: `产品图 ${index + 1}`,
    })),
    file_candidates: [],
  };
}

function testReconcilePreservesContinuationForNonCurrentResources() {
  assert.strictEqual(
    routeService.reconcileUnderstandingDependency(understanding('continuation'), historyCatalog(), {}),
    'continuation',
    'a non-current resource does not by itself turn continuation into followup',
  );
}

function testReconcilePromotesOnlyNewDependencyForNonCurrentResources() {
  assert.strictEqual(
    routeService.reconcileUnderstandingDependency(understanding('new'), historyCatalog(), {}),
    'followup',
    'new plus a non-current resource must be reconciled to followup',
  );
}

function testReconcileStillForcesFollowupForQuotedEvidence() {
  assert.strictEqual(
    routeService.reconcileUnderstandingDependency(understanding('continuation'), historyCatalog(), {
      quoted_message: { role: 'user', content: '上一张图', id: 'quoted-1' },
    }),
    'followup',
    'quoted evidence still overrides continuation',
  );
}

function testBuildRoutePayloadAlignsUnderstandingDependencyWithDeterministicRelation() {
  const payload = routeService.buildRoutePayload({
    model: 'route-model',
    input: '第五张呢',
    context: anchoredContext(),
    understanding: understanding('followup'),
  });
  const userPayload = JSON.parse(payload.input.find(message => message.role === 'user').content);
  assert.strictEqual(userPayload.understanding.dependency, 'continuation',
    'when the schema narrows relation to continuation, the understanding evidence must agree');
  assert.deepStrictEqual(payload.text.format.schema.properties.relation.enum, ['continuation']);
}

function testBuildRoutePayloadPreservesContinuationWhenNoDeterministicConstraint() {
  const context = anchoredContext();
  delete context.previous_resource_execution;
  const payload = routeService.buildRoutePayload({
    model: 'route-model',
    input: '第五张呢',
    context,
    understanding: understanding('continuation'),
  });
  const userPayload = JSON.parse(payload.input.find(message => message.role === 'user').content);
  assert.strictEqual(userPayload.understanding.dependency, 'continuation',
    'without a deterministic relation constraint, a continuation dependency must not be rewritten');
  assert.deepStrictEqual(
    payload.text.format.schema.properties.relation.enum.slice().sort(),
    ['continuation', 'followup', 'new'].sort(),
  );
}

function testExplicitHistoricalReadAndCorrectionRelationsAreNarrowed() {
  const historyFile = routeService.buildRoutePayload({
    model: 'route-model',
    input: '总结刚才那份合同中的付款条款。',
    context: { file_candidates: [{ source: 'history', type: 'file', index: 1, file_id: 'f-old' }] },
  });
  assert.deepStrictEqual(historyFile.text.format.schema.properties.relation.enum, ['followup']);
  const continuation = routeService.buildRoutePayload({
    model: 'route-model',
    input: '继续用刚才那张草图，再生成一个夜间版本。',
    context: { image_candidates: [{ source: 'history', type: 'image', index: 1, image_id: 'i-old' }] },
  });
  assert.deepStrictEqual(continuation.text.format.schema.properties.relation.enum, ['new', 'followup', 'continuation']);
}

function testPriorSpecificationContinuationConstrainsGoalModeToAmend() {
  const payload = routeService.buildRoutePayload({
    model: 'route-model',
    input: '不使用旧图，沿用上一版完整户型文字要求，再分别生成日间自然光和夜间暖光两张材质方案。',
    context: {
      previous_execution: { operation: 'text_to_image', task_state: { schema_version: 'task_continuity.v1', goal_mode: 'replace', segments: [{ kind: 'base', text: '户型要求' }] } },
      image_candidates: [{ source: 'history', type: 'image', index: 1, image_id: 'old' }],
    },
  });
  assert.deepStrictEqual(payload.text.format.schema.properties.goal_mode.enum, ['amend']);
}

module.exports = [
  testPriorSpecificationContinuationConstrainsGoalModeToAmend,
  testExplicitHistoricalReadAndCorrectionRelationsAreNarrowed,
  testReconcilePreservesContinuationForNonCurrentResources,
  testReconcilePromotesOnlyNewDependencyForNonCurrentResources,
  testReconcileStillForcesFollowupForQuotedEvidence,
  testBuildRoutePayloadAlignsUnderstandingDependencyWithDeterministicRelation,
  testBuildRoutePayloadPreservesContinuationWhenNoDeterministicConstraint,
];
