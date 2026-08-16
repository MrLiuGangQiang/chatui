
'use strict';

const assert = require('assert');
const imagePlan = require('../../shared/image-plan');
const routeService = require('../../client/services/route-service');

function task(index) {
  return {
    task_type: 'generate',
    prompt: `生成第 ${index + 1} 张图片`,
    input_images: [],
    quality: 'auto',
    background: 'auto',
    output_format: 'auto',
    count: 1,
  };
}

function plan(count) {
  return {
    schema_version: imagePlan.IMAGE_PLAN_VERSION,
    tasks: Array.from({ length: count }, (_, index) => task(index)),
  };
}

function testImagePlanSchemaPublishesTheStructuralCeilingNotTheProductLimit() {
  const schema = imagePlan.IMAGE_PLAN_RESPONSE_FORMAT.json_schema.schema;
  assert.strictEqual(imagePlan.IMAGE_PLAN_MAX_TASKS, 5);
  assert.strictEqual(imagePlan.IMAGE_PLAN_ABSOLUTE_MAX_TASKS, 50);
  assert.strictEqual(schema.properties.tasks.maxItems, imagePlan.IMAGE_PLAN_ABSOLUTE_MAX_TASKS);
  assert.notStrictEqual(schema.properties.tasks.maxItems, imagePlan.IMAGE_PLAN_MAX_TASKS,
    'structured output must not hide an over-limit request from the local compiler');
}

function testImagePlanProtocolAcceptsSixAndFiftyTasksButRejectsFiftyOne() {
  assert.strictEqual(imagePlan.hasExactImagePlan(plan(6)), true);
  assert.strictEqual(imagePlan.hasExactImagePlan(plan(50)), true);
  assert.strictEqual(imagePlan.hasExactImagePlan(plan(51)), false);
  assert.ok(routeService.inspectImagePlanResult(JSON.stringify(plan(6))).plan,
    'a six-task model response must reach the product-limit compiler');
}

function testImagePlanCompilerOwnsTheFiveTaskProductLimit() {
  for (const count of [6, 50]) {
    const result = routeService.compileImagePlan(plan(count), {
      input: `生成 ${count} 张图片`,
      attachments: [],
      context: {},
    });
    assert.strictEqual(result.ok, false);
    assert.strictEqual(result.code, 'IMAGE_PLAN_OVER_LIMIT');
    assert.strictEqual(result.taskCount, count);
    assert.strictEqual(result.maxTasks, imagePlan.IMAGE_PLAN_MAX_TASKS);
    assert.match(result.question, /最多生成 5 张/);
  }
}

function testImagePlanPromptRequiresFaithfulEnumerationBeforeLimitEnforcement() {
  const prompt = routeService.IMAGE_PLAN_SYSTEM_PROMPT;
  assert.match(prompt, /任务数必须等于用户明确要求的独立结果数/);
  assert.match(prompt, /范围 1\.\.50/);
  assert.match(prompt, /不得因产品执行上限自行截断、合并或遗漏/);
  assert.doesNotMatch(prompt, /任务数 1\.\.5/);
}

module.exports = [
  testImagePlanSchemaPublishesTheStructuralCeilingNotTheProductLimit,
  testImagePlanProtocolAcceptsSixAndFiftyTasksButRejectsFiftyOne,
  testImagePlanCompilerOwnsTheFiveTaskProductLimit,
  testImagePlanPromptRequiresFaithfulEnumerationBeforeLimitEnforcement,
];
