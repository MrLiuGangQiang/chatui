'use strict';

const assert = require('assert');
const understanding = require('../../shared/intent-understanding');

function action(kind, index = 1, target = '') {
  return { index, kind, verb: '', target, resolved_refs: [] };
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

function testShapeCompilerSingleAndAggregate() {
  const single = understanding.compileUnderstandingShape([action('file_read', 1, '这个文件')]);
  assert.strictEqual(single.taskShape, 'single');
  assert.strictEqual(single.operation, 'file_qa');
  assert.strictEqual(single.branch, 'route');

  const aggregate = understanding.compileUnderstandingShape([
    action('image_read', 1, '第一张图'), action('image_read', 2, '第二张图'),
  ]);
  assert.strictEqual(aggregate.taskShape, 'single');
  assert.strictEqual(aggregate.operation, 'image_qa');
  assert.strictEqual(aggregate.aggregate, true);
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
  assert.strictEqual(understanding.hasExactUnderstanding({
    schema_version: 'intent_understanding.v1',
    actions: [action('file_read', 1, '这个文件')],
  }), true);
  assert.strictEqual(understanding.hasExactUnderstanding({ schema_version: 'intent_understanding.v1', actions: [] }), true);
  assert.strictEqual(understanding.hasExactUnderstanding({ schema_version: 'intent_understanding.v1', actions: [{ index: 1, kind: 'bogus', target: 'x', resolved_refs: [] }] }), false);
  assert.throws(() => understanding.assertUnderstanding({ schema_version: 'other', actions: [] }), /intent_understanding.v1/);
}

module.exports = [
  testKindEnumMapsToOperations,
  testRequiredResourceRolesAreDeterministic,
  testShapeCompilerSingleAndAggregate,
  testShapeCompilerBranchesImageAndNonImageMulti,
  testShapeCompilerEmptyActionsClarify,
  testExpectedPlanTasksProjectsOperationAndRoles,
  testPlanCoversExpectedIsOneToOne,
  testUnderstandingSchemaValidation,
];
