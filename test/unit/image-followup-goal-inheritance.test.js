'use strict';

const assert = require('assert');
const imageRouteContext = require('../../client/core/image-route-context');
const routeService = require('../../client/services/route-service');

function imageResult({ operation = 'text_to_image', prompt, resolvedGoal = '', taskState = null, referenceId }) {
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
      ...(taskState ? { taskState } : {}),
      referenceId,
      attachments: [{ src: `indexeddb://${referenceId}.png`, name: `${referenceId}.png` }],
    }),
  };
}

function inspect(intent, input, context) {
  const result = routeService.inspectModelRouteResult(JSON.stringify({
    ...intent,
    goal_mode: intent.goal_mode || 'replace',
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
    goal_mode: 'amend',
    resource_refs: [{ candidate_key: 'i1', role: 'target' }],
  }, editGoal, context);

  const mergedGoal = `任务基础要求：\n${baseGoal}\n\n修订要求（按顺序应用，后者优先）：\n1. ${editGoal}`;
  assert.ok(route.dispatchContract.arguments.prompt.endsWith(editGoal),
    'an image-edit provider request must retain the model-selected edit delta even when semantic context carries its inherited goal');
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
  const firstResolvedGoal = `任务基础要求：\n${baseGoal}\n\n修订要求（按顺序应用，后者优先）：\n1. ${firstEdit}`;
  const secondEdit = '重新布置堂屋门的位置和使用区域，确保门前有连续可通行空间。';
  const secondResolvedGoal = `任务基础要求：\n${baseGoal}\n\n修订要求（按顺序应用，后者优先）：\n1. ${firstEdit}\n2. ${secondEdit}`;
  const messages = [
    { role: 'user', content: baseGoal },
    imageResult({ operation: 'text_to_image', prompt: baseGoal, referenceId: 'imgref-home-1' }),
    { role: 'user', content: firstEdit },
    imageResult({ operation: 'edit_image', prompt: firstEdit, resolvedGoal: firstResolvedGoal, taskState: { schema_version: 'task_continuity.v1', goal_mode: 'amend', segments: [{ kind: 'base', text: baseGoal }, { kind: 'amendment', text: firstEdit }] }, referenceId: 'imgref-home-2' }),
    { role: 'user', content: secondEdit },
    imageResult({ operation: 'edit_image', prompt: secondEdit, resolvedGoal: secondResolvedGoal, taskState: { schema_version: 'task_continuity.v1', goal_mode: 'amend', segments: [{ kind: 'base', text: baseGoal }, { kind: 'amendment', text: firstEdit }, { kind: 'amendment', text: secondEdit }] }, referenceId: 'imgref-home-3' }),
  ];
  const context = imageRouteContext.buildRouteContext({ messages });
  const currentGoal = '重新设计住宅户型；堂屋主入口通道不得被沙发遮挡，卧室1入口通道不得被家具遮挡；厕所与餐厅必须分开布置，不能相邻或合并；不参照旧图。';
  const route = inspect({
    operation: 'text_to_image',
    relation: 'followup',
    goal: currentGoal,
    goal_mode: 'amend',
    resource_refs: [],
  }, '你这布局就不对，不用参照旧图重新设计吧。', context);

  const expected = `任务基础要求：\n${baseGoal}\n\n修订要求（按顺序应用，后者优先）：\n1. ${firstEdit}\n2. ${secondEdit}\n3. ${currentGoal}`;
  assert.strictEqual(context.previous_execution.family, 'edit');
  assert.strictEqual(context.previous_execution.resolved_goal, secondResolvedGoal,
    'the latest edit must retain the whole earlier design specification, not only its short edit instruction');
  assert.strictEqual(route.operationType, 'text_to_image');
  assert.deepStrictEqual(route.resources, [], 'not referencing the old image must keep image bindings empty');
  assert.strictEqual(route.userGoal, currentGoal, 'the model-owned goal remains the current change request');
  assert.ok(route.executionPrompt.endsWith(expected),
    'the execution envelope must retain the complete inherited specification and the current correction');
  assert.strictEqual(route.executionPrompt, expected,
    'the provider prompt must be the natural resolved task instruction, without an internal envelope');
  assert.ok(route.dispatchContract.arguments.prompt.endsWith(expected),
    'the actual image request must retain the complete inherited design goal after semantic context is compiled');
  assert.strictEqual(route.dispatchContract.arguments.prompt, expected,
    'the dispatched prompt must be the natural resolved task instruction');
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
    goal_mode: 'replace',
    resource_refs: [],
  }, '不要原来的住宅要求，从零开始生成赛博朋克咖啡店。', context);

  assert.ok(route.executionPrompt.endsWith(newGoal));
  assert.ok(route.dispatchContract.arguments.prompt.endsWith(newGoal));
  assert.ok(!route.executionPrompt.includes(baseGoal) && !route.dispatchContract.arguments.prompt.includes(baseGoal),
    'an explicit new image task must not inherit the previous task goal, even when raw input is preserved in a semantic envelope');
}

function testRoutePromptSeparatesTextGoalInheritanceFromOldImageReference() {
  const prompt = routeService.ROUTE_SYSTEM_PROMPT;
  assert.match(prompt, /goal_mode只控制图片任务的文字任务状态，与relation和resource_refs相互独立/);
  assert.match(prompt, /当前goal完整、自足、可单独定义新任务时用replace/);
  assert.match(prompt, /当前输入只改变前序图片文字任务的一部分时用amend/);
  assert.match(prompt, /goal_mode=amend只写当前具体delta.*不复述前序base/);
  assert.match(prompt, /拒绝使用历史资源只影响resource_refs，不直接决定goal_mode/);
}

module.exports = [
  testImageEditKeepsItsProviderInstructionButPersistsTheMergedTaskGoal,
  testTextOnlyRedesignInheritsTheOriginalGoalAcrossImageEdits,
  testExplicitNewImageTaskDoesNotInheritThePreviousGoal,
  testRoutePromptSeparatesTextGoalInheritanceFromOldImageReference,
];
