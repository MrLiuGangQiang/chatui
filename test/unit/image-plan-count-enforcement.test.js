'use strict';

const assert = require('assert');
const routeService = require('../../client/services/route-service');

const INPUT = '画一只加菲猫，分别生成五个视角的图片 是五张图';
const GOAL = INPUT;

function testImagePlanPayloadCarriesExpectedTaskCount() {
  const payload = routeService.buildImagePlanPayload({
    model: 'test-model',
    input: INPUT,
    goal: GOAL,
    expectedTaskCount: 5,
  });
  const user = payload.input.find(message => message.role === 'user');
  assert.ok(user, 'image plan payload must include a user message');
  const parsed = JSON.parse(user.content);
  assert.strictEqual(parsed.expected_task_count, 5,
    'the planner must receive the deterministic expected task count');
}

function testImagePlanRepairPayloadRejectsWrongTaskCount() {
  const rejected = {
    schema_version: 'image_plan.v1',
    tasks: [{ label: '一张图', prompt: '一只加菲猫', task_type: 'generate', input_images: [], quality: 'auto', background: 'auto', output_format: 'auto' }],
  };
  const payload = routeService.buildImagePlanRepairPayload({
    model: 'test-model',
    input: INPUT,
    goal: GOAL,
    expectedTaskCount: 5,
    rejectedPlan: rejected,
  });
  const user = payload.input.find(message => message.role === 'user' && message.content.includes('repair_request'));
  assert.ok(user, 'repair payload must include a repair user message');
  const parsed = JSON.parse(user.content);
  assert.strictEqual(parsed.repair_request.expected_task_count, 5);
  assert.deepStrictEqual(parsed.repair_request.rejected_plan, rejected);
  assert.match(parsed.repair_request.instruction, /expected_task_count/);
}

module.exports = [
  testImagePlanPayloadCarriesExpectedTaskCount,
  testImagePlanRepairPayloadRejectsWrongTaskCount,
];
