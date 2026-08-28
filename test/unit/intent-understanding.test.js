'use strict';

const assert = require('assert');
const understanding = require('../../shared/intent-understanding');

function action(kind, index = 1, target = '') {
  return { index, kind, target, resolved_refs: [] };
}

function testKindEnumMapsToOperations() {
  assert.strictEqual(understanding.operationForKind('plain_text'), 'plain_chat');
  assert.strictEqual(understanding.operationForKind('file_read'), 'file_qa');
  assert.strictEqual(understanding.operationForKind('image_generate'), 'text_to_image');
  assert.strictEqual(understanding.operationForKind('image_edit'), 'edit_image');
  assert.strictEqual(understanding.operationForKind('bogus'), '');
}

function testRequiredResourceRolesAreDeterministic() {
  assert.deepStrictEqual(understanding.requiredResourceRoles('file_read'), { file: ['attachment'] });
  assert.deepStrictEqual(understanding.requiredResourceRoles('image_compare'), { image: ['compare_a', 'compare_b'] });
  assert.deepStrictEqual(understanding.requiredResourceRoles('multimodal_qa'), { image: ['source'], file: ['attachment'] });
  assert.deepStrictEqual(understanding.requiredResourceRoles('image_generate'), {});
}

function testShapeCompilerSingleAndMergedReadQuestion() {
  const single = understanding.compileUnderstandingShape([action('file_read', 1, '这个文件')]);
  assert.strictEqual(single.taskShape, 'single');
  assert.strictEqual(single.operation, 'file_qa');
  assert.strictEqual(single.branch, 'route');

  // One question across several images arrives as ONE merged action; the
  // understand node is the only merge authority.
  const merged = understanding.compileUnderstandingShape([
    action('image_read', 1, '第二张和最后一张是什么颜色'),
  ]);
  assert.strictEqual(merged.taskShape, 'single');
  assert.strictEqual(merged.operation, 'image_qa');
  assert.strictEqual(merged.branch, 'route');
}

function testDistinctReadQuestionsStayIndependent() {
  const distinct = understanding.compileUnderstandingShape([
    action('image_read', 1, '第一张的颜色'), action('image_read', 2, '第二张的形状'),
  ]);
  assert.strictEqual(distinct.taskShape, 'multi');
  assert.strictEqual(distinct.branch, 'multi_task_plan');
  assert.ok(!Object.prototype.hasOwnProperty.call(distinct, 'aggregate'),
    'the compiler must not silently collapse distinct read questions');
}

function testShapeCompilerBranchesImageAndNonImageMulti() {
  const imageMulti = understanding.compileUnderstandingShape([
    action('image_generate', 1, '一只狗'), action('image_edit', 2, '把狗改成猫'),
  ]);
  assert.strictEqual(imageMulti.taskShape, 'multi');
  assert.strictEqual(imageMulti.branch, 'image_plan');

  const nonImageMulti = understanding.compileUnderstandingShape([
    action('file_read', 1, '这个文件'), action('image_generate', 2, '一只狗'), action('plain_text', 3, '一个笑话'),
  ]);
  assert.strictEqual(nonImageMulti.taskShape, 'multi');
  assert.strictEqual(nonImageMulti.branch, 'multi_task_plan');
}

function testShapeCompilerEmptyActionsClarify() {
  const shape = understanding.compileUnderstandingShape([]);
  assert.strictEqual(shape.taskShape, 'none');
  assert.strictEqual(shape.branch, 'clarification');
}

function testExpectedPlanTasksProjectsOperationAndRoles() {
  const expected = understanding.expectedPlanTasks([
    action('file_read', 1, '这个文件'), action('image_generate', 2, '一只狗'),
  ]);
  assert.strictEqual(expected.length, 2);
  assert.deepStrictEqual(expected[0], {
    index: 1, kind: 'file_read', operation: 'file_qa', resource_roles: { file: ['attachment'] },
  });
  assert.strictEqual(expected[1].operation, 'text_to_image');
}

function actionWithRef(kind, candidateKey, index = 1, target = '') {
  return { index, kind, target, resolved_refs: [{ candidate_key: candidateKey, text: target || candidateKey }] };
}

function testPlanCoversExpectedRejectsWrongResourceBinding() {
  const expected = understanding.expectedPlanTasks([actionWithRef('file_read', 'f1', 1, '文件A')]);
  assert.strictEqual(understanding.planCoversExpected({
    tasks: [{ operation: 'file_qa', resource_refs: [{ candidate_key: 'f1', role: 'attachment' }] }],
  }, expected), true, 'a plan binding the exact resolved file must be accepted');

  assert.strictEqual(understanding.planCoversExpected({
    tasks: [{ operation: 'file_qa', resource_refs: [{ candidate_key: 'f2', role: 'attachment' }] }],
  }, expected), false, 'a plan binding a different file must be rejected');

  const twoFiles = understanding.expectedPlanTasks([
    actionWithRef('file_read', 'f1', 1, '文件A'),
    actionWithRef('file_read', 'f2', 2, '文件B'),
  ]);
  assert.strictEqual(understanding.planCoversExpected({
    tasks: [
      { operation: 'file_qa', resource_refs: [{ candidate_key: 'f2', role: 'attachment' }] },
      { operation: 'file_qa', resource_refs: [{ candidate_key: 'f1', role: 'attachment' }] },
    ],
  }, twoFiles), true, 'same-operation tasks may be reordered as long as the resource set matches');

  assert.strictEqual(understanding.planCoversExpected({
    tasks: [
      { operation: 'file_qa', resource_refs: [{ candidate_key: 'f1', role: 'attachment' }] },
      { operation: 'file_qa', resource_refs: [{ candidate_key: 'f1', role: 'attachment' }] },
    ],
  }, twoFiles), false, 'duplicating one file and dropping the other must be rejected');
}

function testPlanCoversExpectedIsOneToOne() {
  const expected = understanding.expectedPlanTasks([action('file_read', 1, '文件'), action('image_generate', 2, '狗')]);
  assert.strictEqual(understanding.planCoversExpected({
    tasks: [{ operation: 'file_qa' }, { operation: 'text_to_image' }],
  }, expected), true);
  assert.strictEqual(understanding.planCoversExpected({
    tasks: [{ operation: 'file_qa' }],
  }, expected), false, 'a plan missing an expected task must be rejected');
  assert.strictEqual(understanding.planCoversExpected({
    tasks: [{ operation: 'file_qa' }, { operation: 'text_to_image' }, { operation: 'plain_chat' }],
  }, expected), false, 'a plan inventing an extra task must be rejected');
}

function testUnderstandingSchemaValidation() {
  const valid = { schema_version: 'intent_understanding.v1', dependency: 'new', actions: [action('file_read', 1, '这个文件')] };
  assert.strictEqual(understanding.hasExactUnderstanding(valid), true);
  assert.strictEqual(understanding.hasExactUnderstanding({ ...valid, actions: [] }), true);
  assert.strictEqual(understanding.hasExactUnderstanding({ ...valid, actions: [{ index: 1, kind: 'bogus', target: 'x', resolved_refs: [] }] }), false);
  assert.strictEqual(understanding.hasExactUnderstanding({ schema_version: 'intent_understanding.v1', actions: [action('file_read', 1, '这个文件')] }), false,
    'dependency is part of the wire contract and must be present');
  assert.strictEqual(understanding.hasExactUnderstanding({ ...valid, dependency: 'maybe' }), false,
    'dependency must stay inside the new/followup/continuation closure');
  assert.throws(() => understanding.assertUnderstanding({ schema_version: 'other', dependency: 'new', actions: [] }), /intent_understanding.v1/);
}

function testUnderstandingSchemaAndPromptShareOneContract() {
  const schema = understanding.UNDERSTANDING_RESPONSE_FORMAT.json_schema.schema;
  const properties = Object.keys(schema.properties);
  assert.deepStrictEqual(schema.required.slice().sort(), ['actions', 'dependency', 'schema_version'].sort());
  assert.ok(properties.includes('dependency') && !properties.includes('ordering') && !properties.includes('verb'),
    'the strict schema must only declare the consumed fields: schema_version/dependency/actions');
  assert.strictEqual(schema.additionalProperties, false);
}


function testSharedReferencesDoNotPromoteASingleResultToImagePlan() {
  const shape = understanding.compileUnderstandingShape(
    [action('image_reference', 1, '生成一张新图')],
    '共同参考两张图生成一张新图',
  );
  assert.strictEqual(shape.taskShape, 'single', 'two shared input references still produce one output image');
  assert.strictEqual(shape.branch, 'route');
}

function testShapeCompilerPromotesExplicitMultiImageViewToImagePlan() {
  const shape = understanding.compileUnderstandingShape(
    [action('image_generate', 1, '五个视角的加菲猫')],
    '画一只加菲猫，分别生成五个视角的图片 是五张图',
  );
  assert.strictEqual(shape.taskShape, 'multi', 'five views must be treated as multiple independent images');
  assert.strictEqual(shape.branch, 'image_plan');
  assert.strictEqual(shape.operation, 'text_to_image');
  assert.strictEqual(shape.actions.length, 1);

  const single = understanding.compileUnderstandingShape(
    [action('image_generate', 1, '一只猫')],
    '画一只猫',
  );
  assert.strictEqual(single.taskShape, 'single', 'a single requested image must stay single');

  const editMulti = understanding.compileUnderstandingShape(
    [action('image_edit', 1, '把两张图改成卡通风格')],
    '把第一张和第五张改成卡通风格',
  );
  assert.strictEqual(editMulti.taskShape, 'multi', 'editing two explicit images must stay multi');
}


function testExplicitImageResultCountRecognizesMultipleIndependentImages() {
  assert.strictEqual(understanding.explicitImageResultCount('画一只加菲猫，分别生成五个视角的图片 是五张图'), 5);
  assert.strictEqual(understanding.explicitImageResultCount('分别生成加菲猫的正面、侧面、背面、俯视、仰视视图'), 5);
  assert.strictEqual(understanding.explicitImageResultCount('把第一张和第五张改成卡通风格'), 2);
  assert.strictEqual(understanding.explicitImageResultCount('分别生成一只猫、一只狗、一只鸟'), 3);
  assert.strictEqual(understanding.explicitImageResultCount('画一只猫'), 0);
  assert.strictEqual(understanding.explicitImageResultCount('分别生成一张猫图'), 0);
}

function testMaxExplicitImageResultCountUsesGoalAndTargetEvidence() {
  assert.strictEqual(understanding.maxExplicitImageResultCount('继续生成', '五个视角的加菲猫', ''), 5,
    'a count resolved into the route goal must still drive the image-plan gate');
  assert.strictEqual(understanding.maxExplicitImageResultCount('继续生成', '', '五个视角的加菲猫'), 5,
    'a count resolved into the understanding action target must still drive the image-plan gate');
  assert.strictEqual(understanding.maxExplicitImageResultCount('画一只猫', '一只猫', '一只猫'), 0,
    'a single-image request must not be promoted to multi by the max helper');
  assert.strictEqual(understanding.maxExplicitImageResultCount('画三张猫', '三张猫', '一只猫'), 3,
    'the strongest explicit count source wins');
}

function testExplicitImageResultCountNeverCountsInputsOrSubjects() {
  assert.strictEqual(understanding.explicitImageResultCount('共同参考两张图生成一张新图'), 0,
    'input reference images must not be counted as output results');
  assert.strictEqual(understanding.explicitImageResultCount('画两只猫和一只狗'), 0,
    'in-picture subjects must not be counted as independent results');
  assert.strictEqual(understanding.explicitImageResultCount('把两张图改成黑白'), 2,
    'editing two listed targets produces two edited results');
  assert.strictEqual(understanding.explicitImageResultCount('分别参考两张图生成两张新图'), 2);
  assert.strictEqual(understanding.explicitImageResultCount('生成三张海报：春、夏、冬'), 3);
}

module.exports = [
  testKindEnumMapsToOperations,
  testRequiredResourceRolesAreDeterministic,
  testShapeCompilerSingleAndMergedReadQuestion,
  testDistinctReadQuestionsStayIndependent,
  testShapeCompilerBranchesImageAndNonImageMulti,
  testShapeCompilerEmptyActionsClarify,
  testExpectedPlanTasksProjectsOperationAndRoles,
  testPlanCoversExpectedIsOneToOne,
  testPlanCoversExpectedRejectsWrongResourceBinding,
  testUnderstandingSchemaValidation,
  testUnderstandingSchemaAndPromptShareOneContract,
  testSharedReferencesDoNotPromoteASingleResultToImagePlan,
  testShapeCompilerPromotesExplicitMultiImageViewToImagePlan,
  testExplicitImageResultCountRecognizesMultipleIndependentImages,
  testMaxExplicitImageResultCountUsesGoalAndTargetEvidence,
  testExplicitImageResultCountNeverCountsInputsOrSubjects,
];
