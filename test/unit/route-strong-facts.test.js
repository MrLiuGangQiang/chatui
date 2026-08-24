'use strict';

const assert = require('assert');
const routeService = require('../../client/services/route-service');

function deliveryContext() {
  return {
    recent_messages: [
      { index: 1, role: 'user', content: '生成一张住宅户型平面图，中央设置堂屋。' },
      { index: 2, role: 'assistant', content: '可以将堂屋布置在住宅中央。' },
    ],
    delivery_evidence: {
      schema_version: 'delivery_evidence.v1',
      actual_image_result: { available: false },
      assistant_image_claim: { present: true, verified: false },
      image_delivery_confirmed: false,
    },
    image_candidates: [],
    file_candidates: [],
  };
}

function testUnverifiedImageDeliveryQuestionRestoresImageOperation() {
  const result = routeService.inspectModelRouteResult(JSON.stringify({
    operation: 'plain_chat',
    relation: 'continuation',
    goal: '说明图片尚未交付',
    goal_mode: 'replace',
    resource_refs: [],
    task_shape: 'single',
  }), { input: '图片呢', attachments: [], context: deliveryContext() });
  assert.ok(result.route, result.reason);
  assert.strictEqual(result.route.operationType, 'text_to_image');
  assert.strictEqual(result.route.relation, 'followup');
  assert.match(result.route.userGoal, /未交付/);
  assert.strictEqual(result.route.dispatchAuthorized, true);
}

function testTerseVisualConstraintIsRepairedFromConversationEvidence() {
  const result = routeService.inspectModelRouteResult(JSON.stringify({
    operation: 'text_to_image',
    relation: 'continuation',
    goal: '生成一张住宅户型平面图，中央设置堂屋，堂屋正中设置入户双开门。',
    goal_mode: 'replace',
    resource_refs: [],
    task_shape: 'single',
  }), { input: '堂屋正中的入户双开门', attachments: [], context: deliveryContext() });
  assert.ok(result.route, result.reason);
  assert.strictEqual(result.route.operationType, 'text_to_image');
  assert.strictEqual(result.route.relation, 'followup');
  assert.match(result.route.userGoal, /住宅户型平面图/);
}

function testInvalidPassiveMessageBindingDoesNotCreateClarificationForPlainQuestion() {
  const result = routeService.inspectModelRouteResult(JSON.stringify({
    operation: 'plain_chat',
    relation: 'followup',
    goal: '说明住宅户型中堂屋正中的入户双开门建议采用多宽',
    goal_mode: 'replace',
    resource_refs: [{ candidate_key: 'm2', role: 'context' }],
    task_shape: 'single',
  }), {
    input: '堂屋正中的入户双开门多宽？',
    attachments: [],
    context: deliveryContext(),
  });
  assert.ok(result.route, result.reason);
  assert.strictEqual(result.route.operationType, 'plain_chat');
  assert.strictEqual(result.route.needClarification, false);
  assert.deepStrictEqual(result.route.resources, []);
}

function testAmendGoalRepairsRepeatedBaseForProvider() {
  const context = {
    recent_messages: [{ index: 1, role: 'assistant', content: '图片已生成' }],
    previous_execution: {
      operation: 'text_to_image',
      family: 'generate',
      input: '旧任务',
      resolved_goal: '旧任务',
      task_state: {
        schema_version: 'task_continuity.v1',
        goal_mode: 'replace',
        segments: [{ kind: 'base', text: '高精度住宅户型平面图，总长18米、总宽8米，堂屋位于中央，旧方案采用L形交通走廊，餐厅与卫生间相邻。' }],
      },
    },
    image_candidates: [{ index: 1, source: 'history', image_id: 'old', reference_id: 'old-ref', description: '旧图' }],
    file_candidates: [],
  };
  const result = routeService.inspectModelRouteResult(JSON.stringify({
    operation: 'text_to_image',
    relation: 'continuation',
    goal: '沿用上一版完整户型要求：高精度住宅户型平面图，总长18米、总宽8米，堂屋位于中央，采用L形交通走廊，餐厅与卫生间相邻；分别生成两张材质方案，一张表现日间自然光，一张表现夜间暖光。',
    goal_mode: 'amend',
    resource_refs: [],
    task_shape: 'multi',
  }), {
    input: '不使用旧图，沿用上一版完整户型文字要求，再分别生成日间自然光和夜间暖光两张材质方案。',
    attachments: [],
    context,
  });
  assert.ok(result.route, result.reason);
  assert.strictEqual(result.route.goalMode, 'amend');
  assert.match(result.route.userGoal, /分别生成两张材质方案/);
  assert.match(result.route.userGoal, /日间自然光/);
  assert.match(result.route.userGoal, /夜间暖光/);
  assert.doesNotMatch(result.route.userGoal, /L形交通走廊|餐厅与卫生间相邻/);
}

function testAmendmentContextLeadDoesNotEraseFirstDeltaClause() {
  const context = {
    recent_messages: [],
    previous_execution: {
      operation: 'text_to_image',
      task_state: {
        schema_version: 'task_continuity.v1',
        goal_mode: 'replace',
        segments: [{ kind: 'base', text: '完整住宅户型平面图，18米×8米，中央设置堂屋。' }],
      },
    },
    image_candidates: [],
    file_candidates: [],
  };
  const result = routeService.inspectModelRouteResult(JSON.stringify({
    operation: 'text_to_image',
    relation: 'continuation',
    goal: '在上一版完整户型文字要求基础上，分别生成两张材质方案：一张采用日间自然光，一张采用夜间暖光；不使用旧图。',
    goal_mode: 'amend',
    resource_refs: [],
    task_shape: 'multi',
  }), {
    input: '不使用旧图，在上一版完整户型文字要求基础上，分别生成日间自然光和夜间暖光两张材质方案。',
    attachments: [], context,
  });
  assert.ok(result.route, result.reason);
  assert.strictEqual(result.route.goalMode, 'amend');
  assert.match(result.route.userGoal, /分别生成两张材质方案/);
  assert.match(result.route.userGoal, /日间自然光/);
  assert.match(result.route.userGoal, /夜间暖光/);
  assert.match(result.route.userGoal, /不使用旧图/);
  assert.ok(result.route.userGoal.length > 0);
  assert.notStrictEqual(result.route.userGoal, '不使用旧图。');
}

function testReplaceGoalNeverRunsAmendmentBaseStripping() {
  const base = '高精度住宅户型平面图，总长18米、总宽8米，堂屋位于中央。';
  const replacement = `${base} 分别生成两张材质方案：日间自然光与夜间暖光。`;
  const result = routeService.inspectModelRouteResult(JSON.stringify({
    operation: 'text_to_image',
    relation: 'continuation',
    goal: replacement,
    goal_mode: 'replace',
    resource_refs: [],
    task_shape: 'multi',
  }), {
    input: '完整重述户型要求，并分别生成日间自然光与夜间暖光两张材质方案。',
    attachments: [],
    context: {
      recent_messages: [],
      previous_execution: {
        operation: 'text_to_image',
        task_state: {
          schema_version: 'task_continuity.v1',
          goal_mode: 'replace',
          segments: [{ kind: 'base', text: base }],
        },
      },
      image_candidates: [],
      file_candidates: [],
    },
  });
  assert.ok(result.route, result.reason);
  assert.strictEqual(result.route.goalMode, 'replace');
  assert.strictEqual(result.route.resolvedImageGoal, replacement);
  assert.deepStrictEqual(result.route.imageTaskState.segments, [{ kind: 'base', text: replacement }]);
}

function testExplicitReferenceReuseRepairsOperationAndRole() {
  const result = routeService.inspectModelRouteResult(JSON.stringify({
    operation: 'edit_image',
    relation: 'followup',
    goal: '将主色改为墨绿色，保留原有结构不变。',
    goal_mode: 'replace',
    resource_refs: [{ candidate_key: 'i1', role: 'target' }],
    task_shape: 'single',
  }), {
    input: '上次参考图生成的版本还是不对，请继续沿用那张参考图，把主色改为墨绿，其他结构保留。',
    attachments: [],
    context: {
      recent_messages: [{ index: 1, role: 'assistant', content: '已生成上一版' }],
      image_candidates: [{ index: 1, source: 'history', image_id: 'layout', reference_id: 'layout-ref', description: '版式参考图' }],
      file_candidates: [],
    },
  });
  assert.ok(result.route, result.reason);
  assert.strictEqual(result.route.operationType, 'image_reference_gen');
  assert.deepStrictEqual(result.route.resources.map(resource => resource.role), ['reference']);
}

function testPartialAmendmentLeadKeepsEveryCurrentDelta() {
  const context = {
    previous_execution: {
      operation: 'text_to_image',
      task_state: {
        schema_version: 'task_continuity.v1',
        goal_mode: 'replace',
        segments: [{ kind: 'base', text: '旧户型要求。' }],
      },
    },
    recent_messages: [], image_candidates: [], file_candidates: [],
  };
  const result = routeService.inspectModelRouteResult(JSON.stringify({
    operation: 'text_to_image',
    relation: 'followup',
    goal: '在原完整户型文字要求上修订：堂屋主入口留出1.2米无遮挡通道；卧室1门口移走全部家具。不要沿用旧图。',
    goal_mode: 'amend',
    resource_refs: [],
    task_shape: 'single',
  }), {
    input: '不要沿用旧图，只在原完整户型文字要求上继续修订：堂屋主入口留出1.2米无遮挡通道，卧室1门口移走全部家具。',
    attachments: [], context,
  });
  assert.ok(result.route, result.reason);
  assert.match(result.route.userGoal, /堂屋主入口留出1.2米无遮挡通道/);
  assert.match(result.route.userGoal, /卧室1门口移走全部家具/);
}

module.exports = [
  testUnverifiedImageDeliveryQuestionRestoresImageOperation,
  testTerseVisualConstraintIsRepairedFromConversationEvidence,
  testInvalidPassiveMessageBindingDoesNotCreateClarificationForPlainQuestion,
  testAmendGoalRepairsRepeatedBaseForProvider,
  testAmendmentContextLeadDoesNotEraseFirstDeltaClause,
  testReplaceGoalNeverRunsAmendmentBaseStripping,
  testExplicitReferenceReuseRepairsOperationAndRole,
  testPartialAmendmentLeadKeepsEveryCurrentDelta,
];
