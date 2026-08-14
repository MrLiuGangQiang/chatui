'use strict';

const assert = require('assert');
const imagePlan = require('../../shared/image-plan');

function task(overrides = {}) {
  return {
    task_type: 'generate',
    prompt: '一只猫',
    input_images: [],
    ...overrides,
  };
}

function plan(tasks) {
  return { schema_version: 'image_plan.v1', tasks };
}

function testImagePlanAcceptsValidGeneratePlanUpToFiveTasks() {
  const value = plan([1, 2, 3, 4, 5].map(index => task({ prompt: `图${index}` })));
  assert.strictEqual(imagePlan.hasExactImagePlan(value), true);
  assert.strictEqual(imagePlan.assertImagePlan(value), true);
}

function testImagePlanRejectsInvalidEnvelope() {
  assert.strictEqual(imagePlan.hasExactImagePlan(plan([task()])), true);
  assert.strictEqual(imagePlan.hasExactImagePlan({ ...plan([task()]), schema_version: 'image_plan.v2' }), false);
  assert.strictEqual(imagePlan.hasExactImagePlan({ ...plan([task()]), extra: true }), false);
  assert.strictEqual(imagePlan.hasExactImagePlan({ schema_version: 'image_plan.v1' }), false);
  assert.strictEqual(imagePlan.hasExactImagePlan(plan([])), false);
  assert.strictEqual(imagePlan.hasExactImagePlan(plan(Array.from({ length: 6 }, (_, i) => task({ prompt: `图${i}` })))), true,
    'slightly over-limit output stays parseable so the compiler can report the specific over-limit prompt');
  assert.strictEqual(imagePlan.hasExactImagePlan(plan(Array.from({ length: 51 }, (_, i) => task({ prompt: `图${i}` })))), false,
    'the absolute structural ceiling must fail closed at the protocol boundary');
}

function testImagePlanRejectsInvalidTaskShape() {
  assert.strictEqual(imagePlan.hasExactImagePlan(plan([task({ task_type: 'unknown' })])), false);
  assert.strictEqual(imagePlan.hasExactImagePlan(plan([task({ prompt: '' })])), false);
  assert.strictEqual(imagePlan.hasExactImagePlan(plan([task({ prompt: 'x', input_images: undefined })])), false);
  assert.strictEqual(imagePlan.hasExactImagePlan(plan([task({
    input_images: [{ candidate_key: 'i1', role: 'unknown' }],
  })])), false);
  assert.strictEqual(imagePlan.hasExactImagePlan(plan([task({
    input_images: [{ candidate_key: 'res:image:cat', role: 'target' }],
  })])), false);
  assert.strictEqual(imagePlan.hasExactImagePlan(plan([task({
    input_images: [
      { candidate_key: 'i1', role: 'target' },
      { candidate_key: 'i1', role: 'target' },
    ],
  })])), false, 'duplicate role bindings inside one task must fail');
  assert.strictEqual(imagePlan.hasExactImagePlan(plan([task({ size: '999x999' })])), false);
  assert.strictEqual(imagePlan.hasExactImagePlan(plan([task({ quality: 'ultra' })])), false);
  assert.strictEqual(imagePlan.hasExactImagePlan(plan([task({ background: 'glass' })])), false);
  assert.strictEqual(imagePlan.hasExactImagePlan(plan([task({ output_format: 'gif' })])), false);
  assert.strictEqual(imagePlan.hasExactImagePlan(plan([task({ count: 0 })])), false);
  assert.strictEqual(imagePlan.hasExactImagePlan(plan([task({ count: 5 })])), false);
  assert.strictEqual(imagePlan.hasExactImagePlan(plan([task({ count: 1.5 })])), false);
}

function testImagePlanAcceptsOneTaskForSingleFallback() {
  const value = plan([task({ prompt: '只生成这一张' })]);
  assert.strictEqual(imagePlan.hasExactImagePlan(value), true);
}

function testImagePlanResponseFormatDeclaresStructuralTaskLimit() {
  const format = imagePlan.IMAGE_PLAN_RESPONSE_FORMAT;
  assert.strictEqual(format.type, 'json_schema');
  assert.strictEqual(format.json_schema.name, 'chatui_image_plan_v1');
  assert.strictEqual(format.json_schema.strict, true);
  const schema = format.json_schema.schema;
  assert.deepStrictEqual(schema.required, ['schema_version', 'tasks']);
  assert.strictEqual(schema.additionalProperties, false);
  assert.strictEqual(schema.properties.schema_version.enum[0], 'image_plan.v1');
  assert.strictEqual(schema.properties.tasks.minItems, 1);
  assert.strictEqual(schema.properties.tasks.maxItems, imagePlan.IMAGE_PLAN_ABSOLUTE_MAX_TASKS);
  assert.deepStrictEqual(
    schema.properties.tasks.items.required,
    Object.keys(schema.properties.tasks.items.properties),
    'strict provider schemas must require every declared task property',
  );
  assert.strictEqual(schema.properties.tasks.items.properties.task_type.enum.length, 2);
  assert.deepStrictEqual(schema.properties.tasks.items.properties.count, { type: 'integer', minimum: 1, maximum: 4 });
  assert.deepStrictEqual(schema.properties.tasks.items.properties.label, { type: 'string', minLength: 1, maxLength: 120 });
}

function testImagePlanAcceptsOptionalLabelAndRejectsInvalidLabel() {
  assert.strictEqual(imagePlan.hasExactImagePlan(plan([task({ label: '一只橘色小猫' })])), true, 'optional label is allowed');
  assert.strictEqual(imagePlan.hasExactImagePlan(plan([task({ label: '' })])), false, 'empty label is rejected');
  assert.strictEqual(imagePlan.hasExactImagePlan(plan([task({ label: 'x'.repeat(121) })])), false, 'over-long label is rejected');
}

function testImagePlanValidatorFailureCarriesStableErrorCode() {
  assert.throws(() => imagePlan.assertImagePlan({ schema_version: 'image_plan.v1', tasks: [] }), error => (
    error instanceof TypeError && error.code === 'IMAGE_PLAN_INVALID'
  ));
}

module.exports = [
  testImagePlanAcceptsValidGeneratePlanUpToFiveTasks,
  testImagePlanRejectsInvalidEnvelope,
  testImagePlanRejectsInvalidTaskShape,
  testImagePlanAcceptsOneTaskForSingleFallback,
  testImagePlanResponseFormatDeclaresStructuralTaskLimit,
  testImagePlanAcceptsOptionalLabelAndRejectsInvalidLabel,
  testImagePlanValidatorFailureCarriesStableErrorCode,
];
