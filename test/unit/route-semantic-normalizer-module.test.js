'use strict';

const assert = require('assert');
const fs = require('fs');
const path = require('path');
const taskContinuity = require('../../shared/task-continuity');
const normalizerModule = require('../../client/services/route-semantic-normalizer');
const routeService = require('../../client/services/route-service');

function createNormalizer() {
  return normalizerModule.createRouteSemanticNormalizer({
    maxGoalLength: 1000,
    imageRelationOperations: ['text_to_image', 'image_reference_gen', 'edit_image'],
    imageTaskStateOperations: ['text_to_image', 'image_reference_gen', 'edit_image'],
    imageGenerationIntentPattern: /(?:生成|画|绘制|制作|创建|\bgenerate\b|\bdraw\b|\bcreate\b)/i,
    taskContinuityFromExecution: taskContinuity.taskContinuityFromExecution,
    renderTaskContinuity: taskContinuity.renderTaskContinuity,
  });
}

function previousExecution(base = '完整住宅户型平面图，18米×8米，中央设置堂屋。') {
  return {
    operation: 'text_to_image',
    task_state: taskContinuity.createReplacementTaskContinuity(base),
  };
}

function testSemanticNormalizerPreservesFirstAmendmentClause() {
  const normalizer = createNormalizer();
  const goal = normalizer.normalizeImageAmendmentGoal(
    '在上一版完整户型文字要求基础上，分别生成两张材质方案：一张采用日间自然光，一张采用夜间暖光；不使用旧图。',
    { context: { previous_execution: previousExecution() } },
  );
  assert.match(goal, /分别生成两张材质方案/);
  assert.match(goal, /日间自然光/);
  assert.match(goal, /夜间暖光/);
  assert.match(goal, /不使用旧图/);
  assert.doesNotMatch(goal, /18米×8米|中央设置堂屋/);
}

function testSemanticReconcilerRepairsOnlyStrongEvidence() {
  const normalizer = createNormalizer();
  const restored = normalizer.reconcileModelIntent({
    operation: 'plain_chat', relation: 'continuation', goal: '说明尚未交付', goal_mode: 'replace', resource_refs: [], task_shape: 'single',
  }, {
    input: '图片呢',
    context: { previous_execution: previousExecution(), delivery_evidence: { actual_image_result: { available: false } } },
  });
  assert.strictEqual(restored.operation, 'text_to_image');
  assert.strictEqual(restored.relation, 'followup');
  assert.match(restored.goal, /未交付/);
  assert.match(restored.goal, /未交付/);

  const semanticModelOutput = {
    operation: 'image_reference_gen', relation: 'continuation',
    goal: 'model-owned goal', goal_mode: 'replace',
    resource_refs: [{ candidate_key: 'i1', role: 'reference' }], task_shape: 'single',
  };
  const preserved = normalizer.reconcileModelIntent(
    semanticModelOutput,
    { input: "again", context: {} },
    [{ candidate_key: 'i1' }],
  );
  assert.strictEqual(preserved.operation, 'image_reference_gen');
  assert.strictEqual(preserved.relation, 'continuation');
  assert.strictEqual(preserved.resource_refs[0].role, 'reference');

  const plain = normalizer.reconcileModelIntent({
    operation: 'plain_chat', relation: 'followup', goal: '解释入户门宽度', goal_mode: 'replace',
    resource_refs: [{ candidate_key: 'm9', role: 'context' }], task_shape: 'single',
  }, { input: '入户门多宽？', context: {} }, []);
  assert.deepStrictEqual(plain.resource_refs, []);
}

function testSemanticReconcilerRemovesMediaRefsFromPlainChat() {
  const normalizer = createNormalizer();
  const result = normalizer.reconcileModelIntent({
    operation: 'plain_chat',
    relation: 'followup',
    goal: '解释上一个户型要求里的严格左右镜像对称。',
    goal_mode: 'replace',
    resource_refs: [{ candidate_key: 'i1', role: 'context' }],
    task_shape: 'single',
  }, {
    input: '上一个户型要求里的严格左右镜像对称具体是什么意思？',
    context: {},
  }, [{ candidate_key: 'i1', type: 'image', source: 'history' }]);
  assert.deepStrictEqual(result.resource_refs, []);
}

function testSemanticReconcilerMovesQuotedTextOnlyGenerationToTextToImage() {
  const normalizer = createNormalizer();
  const repaired = normalizer.reconcileModelIntent({
    operation: 'image_reference_gen',
    relation: 'followup',
    goal: '基于这个描述生成一张图片',
    goal_mode: 'replace',
    resource_refs: [{ candidate_key: 'm1', role: 'context' }],
    task_shape: 'single',
  }, {
    input: '基于这个描述再生成一张图片。',
    context: {},
  }, [{ candidate_key: 'm1', type: 'message', source: 'quoted' }]);

  assert.strictEqual(repaired.operation, 'text_to_image',
    'a quoted text-only description must not require a missing reference image');
  assert.deepStrictEqual(repaired.resource_refs, [{ candidate_key: 'm1', role: 'context' }]);
}

function testSemanticReconcilerRepairsStyleOnlyReferenceRole() {
  const normalizer = createNormalizer();
  const result = normalizer.reconcileModelIntent({
    operation: 'image_reference_gen',
    relation: 'followup',
    goal: '参考上传的山水画配色，生成一张极简茶叶包装海报。',
    goal_mode: 'replace',
    resource_refs: [{ candidate_key: 'i1', role: 'reference' }],
    task_shape: 'single',
  }, {
    input: '不要继续刚才的户型文字任务，改为参考这张上传的山水画配色，生成一张极简茶叶包装海报。',
    context: {},
  }, [{ candidate_key: 'i1', type: 'image', source: 'current' }]);
  assert.strictEqual(result.resource_refs[0].role, 'style_reference');
}

function testRouteServiceUsesSemanticNormalizerWithoutReembeddingRulesOrGlobals() {
  const routeSource = fs.readFileSync(path.join(__dirname, '../../client/services/route-service.js'), 'utf8');
  const normalizerSource = fs.readFileSync(path.join(__dirname, '../../client/services/route-semantic-normalizer.js'), 'utf8');
  assert.doesNotMatch(routeSource, /function reconcileModelIntent\s*\(/);
  assert.doesNotMatch(routeSource, /function normalizeImageAmendmentGoal\s*\(/);
  assert.match(routeSource, /require\('\.\/route-semantic-normalizer'\)/);
  assert.match(normalizerSource, /function reconcileModelIntent\s*\(/);
  assert.match(normalizerSource, /function normalizeImageAmendmentGoal\s*\(/);
  assert.doesNotMatch(normalizerSource, /root\.ChatUIRouteSemanticNormalizer\s*=/,
    'the normalizer must use the module registry rather than add a browser global');
  assert.strictEqual(typeof routeService.inspectModelRouteResult, 'function');
}

module.exports = [
  testSemanticNormalizerPreservesFirstAmendmentClause,
  testSemanticReconcilerRepairsOnlyStrongEvidence,
  testSemanticReconcilerMovesQuotedTextOnlyGenerationToTextToImage,
  testSemanticReconcilerRepairsStyleOnlyReferenceRole,
  testSemanticReconcilerRemovesMediaRefsFromPlainChat,
  testRouteServiceUsesSemanticNormalizerWithoutReembeddingRulesOrGlobals,
];
