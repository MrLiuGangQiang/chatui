'use strict';

// Regression: multi-image plans that express an explicit background color
// (e.g. "white background") were rejected by image_plan.v1's enum, so the
// route was reported as "路由任务尚未完成资源确认，已停止发送" (ROUTE_NOT_READY).
// The planning prompt directs the model to put background into the task
// `background` field (never into `prompt`), so `background: "white"` is the
// model's correct output for a user asking for a white background. The enum
// must accept white/black (the OpenAI gpt-image background vocabulary) and
// every compiled sub-task must stay dispatchable.

const assert = require('assert');
const imagePlan = require('../../shared/image-plan');
const capabilityRegistry = require('../../shared/capability-registry');
const routeService = require('../../client/services/route-service');

function planWithBackground(background) {
  return {
    schema_version: 'image_plan.v1',
    tasks: [{
      label: '主图',
      prompt: '一只橙色条纹的猫，正面视图',
      task_type: 'generate',
      input_images: [],
      quality: 'auto',
      background,
      output_format: 'auto',
    }],
  };
}

function testBackgroundEnumAcceptsExplicitColors() {
  assert.ok(Array.isArray(capabilityRegistry.IMAGE_BACKGROUNDS), 'capability registry must expose backgrounds');
  assert.ok(capabilityRegistry.IMAGE_BACKGROUNDS.includes('white'), 'white must be a valid background');
  assert.ok(capabilityRegistry.IMAGE_BACKGROUNDS.includes('black'), 'black must be a valid background');
  assert.strictEqual(imagePlan.hasExactImagePlan(planWithBackground('white')), true,
    'a plan with background "white" must pass protocol validation');
  assert.strictEqual(imagePlan.hasExactImagePlan(planWithBackground('black')), true,
    'a plan with background "black" must pass protocol validation');
  assert.doesNotThrow(() => imagePlan.assertImagePlan(planWithBackground('white')));
}

function testBackgroundEnumStillRejectsUnknownColors() {
  assert.strictEqual(imagePlan.hasExactImagePlan(planWithBackground('glass')), false,
    'unknown background values must still be rejected');
}

function testMultiImagePlanWithWhiteBackgroundCompilesAndDispatches() {
  const plan = {
    schema_version: 'image_plan.v1',
    tasks: [
      { label: '加菲猫正面视图', prompt: '一只橙色条纹的加菲猫，正面全身视图，站立姿势，表情慵懒，卡通风格，白色背景', task_type: 'generate', input_images: [], quality: 'auto', background: 'white', output_format: 'auto' },
      { label: '加菲猫侧面视图', prompt: '一只橙色条纹的加菲猫，左侧面全身视图，站立姿势，展示身体轮廓，卡通风格，白色背景', task_type: 'generate', input_images: [], quality: 'auto', background: 'white', output_format: 'auto' },
      { label: '加菲猫背面视图', prompt: '一只橙色条纹的加菲猫，背面全身视图，站立姿势，展示背部条纹和尾巴，卡通风格，白色背景', task_type: 'generate', input_images: [], quality: 'auto', background: 'white', output_format: 'auto' },
      { label: '加菲猫俯视视图', prompt: '一只橙色条纹的加菲猫，正上方俯视视角，蜷缩在地面上，卡通风格，白色背景', task_type: 'generate', input_images: [], quality: 'auto', background: 'white', output_format: 'auto' },
      { label: '加菲猫仰视视图', prompt: '一只橙色条纹的加菲猫，低角度仰视视角，坐着抬头看镜头，卡通风格，白色背景', task_type: 'generate', input_images: [], quality: 'auto', background: 'white', output_format: 'auto' },
    ],
  };
  const compiled = routeService.compileImagePlan(plan, {
    input: '分别生成加菲猫的正面、侧面、背面、俯视、仰视视图',
    attachments: [],
    context: {},
    currentMode: 'image',
    autoMode: true,
    relation: 'new',
    currentTurn: null,
  });
  assert.strictEqual(compiled.ok, true, `plan must compile, got: ${compiled.code || ''} ${compiled.question || ''}`);
  assert.strictEqual(compiled.kind, 'batch');
  assert.strictEqual(compiled.items.length, 5);
  for (const [index, item] of compiled.items.entries()) {
    assert.strictEqual(routeService.isRouteDispatchable(item.route), true,
      `sub-task ${index} must be dispatchable after the fix`);
    assert.strictEqual(item.route.dispatchContract, item.dispatchContract,
      `sub-task ${index} must carry its own dispatch contract`);
  }
}

module.exports = [
  testBackgroundEnumAcceptsExplicitColors,
  testBackgroundEnumStillRejectsUnknownColors,
  testMultiImagePlanWithWhiteBackgroundCompilesAndDispatches,
];