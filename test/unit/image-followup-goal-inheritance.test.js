'use strict';

const assert = require('assert');
const imageRouteContext = require('../../client/core/image-route-context');
const routeService = require('../../client/services/route-service');

function imageResult({ operation = 'text_to_image', prompt, resolvedGoal = '', referenceId }) {
  return {
    role: 'assistant',
    content: `[图片${operation === 'edit_image' ? '编辑' : '生成'}完成] ${prompt}`,
    imageContext: JSON.stringify({
      schema_version: 'image_result.v1',
      operation,
      mode: operation === 'edit_image' ? 'edit_image' : 'image',
      prompt,
      routePrompt: prompt,
      ...(resolvedGoal ? { resolvedGoal } : {}),
      referenceId,
      attachments: [{ src: `indexeddb://${referenceId}.png`, name: `${referenceId}.png` }],
    }),
  };
}

function inspect(intent, input, context) {
  const result = routeService.inspectModelRouteResult(JSON.stringify({
    ...intent,
    task_shape: 'single',
  }), {
    input,
    attachments: [],
    context,
  });
  assert.ok(result.route, result.error || result.reason);
  return result.route;
}


function testImageEditKeepsItsProviderInstructionButPersistsTheMergedTaskGoal() {
  const baseGoal = '住宅户型：18米×8米，左右镜像，中央堂屋，两侧独立居住单元。';
  const editGoal = '把堂屋入口前的沙发移开，确保入口通道连续可通行。';
  const messages = [
    { role: 'user', content: baseGoal },
    imageResult({ operation: 'text_to_image', prompt: baseGoal, referenceId: 'imgref-edit-base' }),
  ];
  const context = imageRouteContext.buildRouteContext({ messages });
  const route = inspect({
    operation: 'edit_image',
    relation: 'followup',
    goal: editGoal,
    resource_refs: [{ candidate_key: 'i1', role: 'target' }],
  }, editGoal, context);

  const mergedGoal = `${baseGoal}\n\n本轮修改（以下要求优先）：\n${editGoal}`;
  assert.strictEqual(route.dispatchContract.arguments.prompt, editGoal,
    'an image-edit provider request must remain the model-selected edit delta');
  assert.strictEqual(route.resolvedImageGoal, mergedGoal,
    'the task state carried into the completed edit must retain the initial specification plus the edit');

  const persistedContext = imageRouteContext.buildRouteContext({
    messages: [...messages, { role: 'user', content: editGoal }, imageResult({
      operation: 'edit_image',
      prompt: editGoal,
      resolvedGoal: route.resolvedImageGoal,
      referenceId: 'imgref-edit-result',
    })],
  });
  assert.strictEqual(persistedContext.previous_execution.resolved_goal, mergedGoal,
    'the next image follow-up must recover the merged task goal rather than only the latest edit instruction');
}

function testTextOnlyRedesignInheritsTheOriginalGoalAcrossImageEdits() {
  const baseGoal = '住宅户型：总长18米、总宽8米，整体左右镜像对称；中央设置共享堂屋，底部中央为双开主入口；堂屋两侧为两套对称独立居住单元，每侧包含卧室1、卧室2、卧室3、客厅、餐厅、厨房、卫生间和杂物间。';
  const firstEdit = '调整堂屋后方区域和门前通道，避免沙发后方开门后无法通行，并消除无用途的大面积空白。';
  const firstResolvedGoal = `${baseGoal}\n\n本轮修改（以下要求优先）：\n${firstEdit}`;
  const secondEdit = '重新布置堂屋门的位置和使用区域，确保门前有连续可通行空间。';
  const secondResolvedGoal = `${firstResolvedGoal}\n\n本轮修改（以下要求优先）：\n${secondEdit}`;
  const messages = [
    { role: 'user', content: baseGoal },
    imageResult({ operation: 'text_to_image', prompt: baseGoal, referenceId: 'imgref-home-1' }),
    { role: 'user', content: firstEdit },
    imageResult({ operation: 'edit_image', prompt: firstResolvedGoal, referenceId: 'imgref-home-2' }),
    { role: 'user', content: secondEdit },
    imageResult({ operation: 'edit_image', prompt: secondResolvedGoal, referenceId: 'imgref-home-3' }),
  ];
  const context = imageRouteContext.buildRouteContext({ messages });
  const currentGoal = '重新设计住宅户型；堂屋主入口通道不得被沙发遮挡，卧室1入口通道不得被家具遮挡；厕所与餐厅必须分开布置，不能相邻或合并；不参照旧图。';
  const route = inspect({
    operation: 'text_to_image',
    relation: 'followup',
    goal: currentGoal,
    resource_refs: [],
  }, '你这布局就不对，不用参照旧图重新设计吧。', context);

  const expected = `${secondResolvedGoal}\n\n本轮修改（以下要求优先）：\n${currentGoal}`;
  assert.strictEqual(context.previous_execution.family, 'edit');
  assert.strictEqual(context.previous_execution.resolved_goal, secondResolvedGoal,
    'the latest edit must retain the whole earlier design specification, not only its short edit instruction');
  assert.strictEqual(route.operationType, 'text_to_image');
  assert.deepStrictEqual(route.resources, [], 'not referencing the old image must keep image bindings empty');
  assert.strictEqual(route.userGoal, currentGoal, 'the model-owned goal remains the current change request');
  assert.strictEqual(route.executionPrompt, expected);
  assert.strictEqual(route.dispatchContract.arguments.prompt, expected,
    'the actual image request must combine the historical specification and the current correction');
}

function testExplicitNewImageTaskDoesNotInheritThePreviousGoal() {
  const baseGoal = '左右镜像的住宅户型，中央堂屋，两侧居住单元。';
  const context = imageRouteContext.buildRouteContext({
    messages: [
      { role: 'user', content: baseGoal },
      imageResult({ operation: 'text_to_image', prompt: baseGoal, referenceId: 'imgref-home-new' }),
    ],
  });
  const newGoal = '生成一张赛博朋克雨夜咖啡店的室内概念图。';
  const route = inspect({
    operation: 'text_to_image',
    relation: 'new',
    goal: newGoal,
    resource_refs: [],
  }, '不要原来的住宅要求，从零开始生成赛博朋克咖啡店。', context);

  assert.strictEqual(route.executionPrompt, newGoal);
  assert.strictEqual(route.dispatchContract.arguments.prompt, newGoal);
}

function testRoutePromptSeparatesTextGoalInheritanceFromOldImageReference() {
  const prompt = routeService.ROUTE_SYSTEM_PROMPT;
  assert.match(prompt, /重新设计或重新生成也继承 previous_execution\.resolved_goal/);
  assert.match(prompt, /不参照\/不使用旧图.*不放弃其文字任务规格/);
  assert.match(prompt, /明确说不要原要求、换主题或从零开始才不继承/);
}

module.exports = [
  testImageEditKeepsItsProviderInstructionButPersistsTheMergedTaskGoal,
  testTextOnlyRedesignInheritsTheOriginalGoalAcrossImageEdits,
  testExplicitNewImageTaskDoesNotInheritThePreviousGoal,
  testRoutePromptSeparatesTextGoalInheritanceFromOldImageReference,
];
