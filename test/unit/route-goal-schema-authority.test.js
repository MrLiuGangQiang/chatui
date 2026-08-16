'use strict';

const assert = require('assert');
const routeService = require('../../client/services/route-service');

function goalSchemaFor(options) {
  return routeService.buildRoutePayload({ model: 'route-model', ...options })
    .text.format.schema.properties.goal;
}

function testStatelessCurrentOnlyRequestKeepsCurrentInputAsExactGoalAuthority() {
  const input = '把这两张图分别改成黑白效果，保持各自原有构图不变。';
  const attachments = [
    { type: 'image/png', is_image: true, image_id: 'img-a', name: 'a.png', index: 1 },
    { type: 'image/png', is_image: true, image_id: 'img-b', name: 'b.png', index: 2 },
  ];
  assert.deepStrictEqual(goalSchemaFor({ input, attachments, context: {} }).enum, [input],
    'without historical semantic state, current_input is the exact goal authority');
}

function testConcreteSequentialEditKeepsOnlyTheNewCurrentInstructionAsGoalAuthority() {
  const input = '把颜色改成蓝色。';
  const context = {
    recent_messages: [
      { index: 1, role: 'user', content: '把猫换成站立姿势。' },
      { index: 2, role: 'assistant', content: '已完成姿势修改。' },
    ],
    previous_execution: {
      schema_version: 'execution_continuity.v1',
      operation: 'edit_image',
      family: 'edit',
      input: '把猫换成站立姿势',
      result_kind: 'image',
      result_reference_id: 'imgref-standing-cat',
      source_message_index: 2,
      source_user_message_index: 1,
    },
    image_candidates: [{
      index: 1,
      source: 'history',
      image_id: 'img-standing-cat',
      reference_id: 'imgref-standing-cat',
      description: '刚完成姿势修改的猫图',
    }],
    file_candidates: [],
  };
  assert.deepStrictEqual(goalSchemaFor({ input, context }).enum, [input],
    'a new concrete edit instruction must not copy completed prior instructions into goal');
}

function testResourceOnlyCorrectionStillLetsTheModelResolveTheInheritedGoal() {
  const input = '你选错了猫，请改用这只猫继续处理上一项图片编辑请求。';
  const context = {
    previous_execution: {
      schema_version: 'execution_continuity.v1',
      operation: 'edit_image',
      family: 'edit',
      input: '把猫的背景改成白色',
      result_kind: 'image',
      result_reference_id: 'imgref-old',
    },
    image_candidates: [{
      index: 1,
      source: 'history',
      image_id: 'img-new-cat',
      reference_id: 'imgref-new-cat',
      description: '用户重新选择的猫图',
    }],
    file_candidates: [],
  };
  assert.strictEqual(Object.prototype.hasOwnProperty.call(goalSchemaFor({ input, context }), 'enum'), false,
    'resource-only corrections require model resolution against previous_execution.input');
}

module.exports = [
  testStatelessCurrentOnlyRequestKeepsCurrentInputAsExactGoalAuthority,
  testConcreteSequentialEditKeepsOnlyTheNewCurrentInstructionAsGoalAuthority,
  testResourceOnlyCorrectionStillLetsTheModelResolveTheInheritedGoal,
];