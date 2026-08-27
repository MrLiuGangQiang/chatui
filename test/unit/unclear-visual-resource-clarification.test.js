'use strict';

const assert = require('assert');
const routeService = require('../../client/services/route-service');
const routeIntentWorkflow = require('../../client/app/route-intent-workflow');
const clarificationAnswer = require('../../shared/clarification-answer');

function editIntent(resourceRefs = [{ candidate_key: 'm1', role: 'target' }]) {
  return {
    operation: 'edit_image',
    relation: 'continuation',
    goal: '将目标图片换成黑色',
    task_shape: 'single',
    resource_refs: resourceRefs,
  };
}

function imageMemory(id, index, label) {
  return {
    type: 'image',
    image_id: id,
    resource_id: `res:image:${id}`,
    reference_id: `imgref-${id}`,
    source: 'history',
    memory_index: index,
    index,
    label,
    description: label,
  };
}

function contextWithMemory(images = []) {
  const context = {
    recent_messages: [{
      index: 1,
      id: 'message-1',
      resource_id: 'res:message:message-1',
      role: 'assistant',
      content: '[图片编辑完成] 换个颜色',
    }],
  };
  Object.defineProperty(context, 'image_memory_cards', {
    value: images,
    enumerable: false,
    configurable: true,
  });
  return context;
}

function inspect(intent = editIntent(), options = {}) {
  return routeService.inspectModelRouteResult(JSON.stringify(intent), {
    input: options.input || '换成黑色',
    attachments: options.attachments || [],
    context: options.context || contextWithMemory([]),
  });
}

function assertCanonicalImageSlot(slot, expectedChoiceCount) {
  assert.match(slot.key, /^r[1-9]\d*$/);
  assert.strictEqual(slot.type, 'image');
  assert.strictEqual(slot.role, 'target');
  assert.strictEqual(slot.choices.length, expectedChoiceCount);
  assert.deepStrictEqual(slot.choices.map(choice => choice.key),
    Array.from({ length: expectedChoiceCount }, (_, index) => `c${index + 1}`));
}

function testInvalidMessageTargetListsEveryRecoverableImageForClarification() {
  const context = contextWithMemory([
    imageMemory('cat-result', 1, '猫图片'),
    imageMemory('car-result', 2, '汽车图片'),
  ]);
  assert.deepStrictEqual(routeService.buildResourceCandidates([], context, '换成黑色')
    .filter(candidate => candidate.type === 'image'), [],
  'unrelated full image memory should remain outside the normal model-facing candidate catalog');

  const result = inspect(editIntent(), { context });
  assert.ok(result.route, `${result.reason}: ${result.error || ''}`);
  assert.strictEqual(result.route.operationType, 'edit_image');
  assert.strictEqual(result.route.api, 'clarify');
  assert.strictEqual(result.route.readiness, 'needs_clarification');
  assert.strictEqual(result.route.dispatchAuthorized, false);
  assert.strictEqual(routeService.isRouteDispatchable(result.route), false);
  assert.strictEqual(result.route.dispatchContract, null);
  assert.strictEqual(result.route.clarificationQuestion,
    '没有明确要编辑哪张图片，请从下列图片中选择目标图片。');
  assert.strictEqual(result.route.clarificationSlots.length, 1);
  assertCanonicalImageSlot(result.route.clarificationSlots[0], 2);
  assert.deepStrictEqual(result.route.clarificationSlots[0].choices.map(choice => choice.resource_id), [
    'res:image:cat-result',
    'res:image:car-result',
  ]);
}

function testInvalidMessageTargetStillRequiresConfirmationWithOneRecoverableImage() {
  const result = inspect(editIntent(), {
    context: contextWithMemory([imageMemory('only-result', 1, '唯一可恢复图片')]),
  });
  assert.ok(result.route, result.reason);
  assert.strictEqual(result.route.api, 'clarify');
  assert.strictEqual(result.route.dispatchAuthorized, false);
  assert.strictEqual(result.route.clarificationQuestion,
    '没有明确要编辑哪张图片，请从下列图片中选择目标图片。');
  assertCanonicalImageSlot(result.route.clarificationSlots[0], 1);
  assert.strictEqual(result.route.clarificationSlots[0].choices[0].resource_id, 'res:image:only-result');
}

function testRejectedImageTargetAsksForAnImageChoiceInsteadOfFreeText() {
  const route = {
    operationType: 'edit_image',
    api: 'image_edit',
    mode: 'edit_image',
    readiness: 'ready',
    dispatchAuthorized: true,
    needClarification: false,
    resources: [{
      key: 'r1',
      type: 'image',
      role: 'target',
      resource_id: 'res:image:wrong-target',
      source: 'history',
    }],
    dispatchContract: {},
  };
  const context = contextWithMemory([
    imageMemory('realistic-3d', 1, '真实立体效果图'),
    imageMemory('floor-plan', 2, '平面户型图'),
    imageMemory('render-replica', 3, '写实风格复刻图'),
  ]);
  const result = routeService.clarifyImageInstructionRoute(route, '请确认要修改的目标图片', {
    input: '不是这个图',
    attachments: [],
    context,
  });

  assert.strictEqual(result.api, 'clarify');
  assert.strictEqual(result.dispatchAuthorized, false);
  assert.strictEqual(result.clarificationQuestion,
    '没有明确要编辑哪张图片，请从下列图片中选择目标图片。');
  assertCanonicalImageSlot(result.clarificationSlots[0], 3);
  assert.deepStrictEqual(result.clarificationSlots[0].choices.map(choice => choice.label), [
    '真实立体效果图',
    '平面户型图',
    '写实风格复刻图',
  ]);
  assert.strictEqual(
    result.clarificationSlots[0].choices.some(choice => choice.resource_id === 'res:image:wrong-target'),
    false,
    'the rejected target must not be offered as the replacement choice',
  );
}

async function testMaterializerTargetAmbiguityRendersReplacementImageChoices() {
  const previousRouteService = globalThis.ChatUIRouteService;
  globalThis.ChatUIRouteService = routeService;
  const context = {
    recent_messages: [],
    image_candidates: [
      imageMemory('wrong-target', 1, '3D立体风格图'),
      imageMemory('realistic-3d', 2, '真实立体效果图'),
      imageMemory('floor-plan', 3, '平面户型图'),
    ],
  };
  const calls = [];
  const workflow = routeIntentWorkflow.createRouteIntentWorkflow({
    state: { mode: 'chat', autoMode: true, sessions: [], messages: [] },
    getConfig: () => ({
      baseUrl: 'https://gateway.example/v1', apiKey: 'test-key',
      routeModel: 'route-model', chatModel: 'route-model',
    }),
    getSessionRouteModel: () => 'route-model',
    getSessionChatModel: () => 'route-model',
    requestJson: async (_url, payload) => {
      calls.push(payload.text?.format?.name);
      if (payload.text?.format?.name === 'chatui_intent_understanding_v1') {
        return { choices: [{ message: { content: JSON.stringify({
          schema_version: 'intent_understanding.v1',
          ordering: 'sequential',
          dependency: 'followup',
          actions: [{ index: 1, kind: 'image_edit', verb: '改', target: '目标图片', resolved_refs: [{ candidate_key: 'i1', text: '目标图片' }] }],
        }) } }] };
      }
      if (payload.text?.format?.name === 'chatui_route_intent_v3') {
        return { choices: [{ message: { content: JSON.stringify(editIntent([{ candidate_key: 'i1', role: 'target' }])) } }] };
      }
      if (payload.text?.format?.name === 'chatui_image_instruction_v1') {
        return { choices: [{ message: { content: JSON.stringify({
          schema_version: 'image_instruction.v1',
          status: 'needs_clarification',
          instruction: '',
          clarification: '请确认要修改的目标图片。',
        }) } }] };
      }
      throw new Error(`unexpected structured request: ${payload.text?.format?.name || '<missing>'}`);
    },
  });

  try {
    const result = await workflow.getEffectiveRoute('不是这个图', [], 'materializer-target-ambiguity', null, context, {});
    assert.deepStrictEqual(calls, ['chatui_intent_understanding_v1', 'chatui_route_intent_v3', 'chatui_image_instruction_v1']);
    assert.strictEqual(result.api, 'clarify');
    assert.strictEqual(result.dispatchAuthorized, false);
    assert.strictEqual(result.clarificationQuestion,
      '没有明确要编辑哪张图片，请从下列图片中选择目标图片。');
    assertCanonicalImageSlot(result.clarificationSlots[0], 2);
    assert.deepStrictEqual(result.clarificationSlots[0].choices.map(choice => choice.resource_id), [
      'res:image:realistic-3d',
      'res:image:floor-plan',
    ]);
  } finally {
    if (previousRouteService === undefined) delete globalThis.ChatUIRouteService;
    else globalThis.ChatUIRouteService = previousRouteService;
  }
}

function testInvalidMessageTargetWithoutImagesRequestsUploadInsteadOfExecuting() {
  const result = inspect(editIntent(), { context: contextWithMemory([]) });
  assert.ok(result.route, result.reason);
  assert.strictEqual(result.route.api, 'clarify');
  assert.strictEqual(result.route.dispatchAuthorized, false);
  assert.strictEqual(result.route.clarificationQuestion,
    '没有找到可用图片，请重新上传或选择一张图片。');
  assertCanonicalImageSlot(result.route.clarificationSlots[0], 0);
}

function testValidImageTargetRemainsImmediatelyDispatchable() {
  const context = {
    conversation_focus: { kind: 'image' },
    image_candidates: [imageMemory('valid-result', 1, '明确目标图片')],
    recent_messages: [{ index: 1, role: 'assistant', content: '[图片编辑完成] 明确目标图片' }],
  };
  const result = inspect(editIntent([{ candidate_key: 'i1', role: 'target' }]), { context });
  assert.ok(result.route, `${result.reason}: ${result.error || ''}`);
  assert.strictEqual(result.route.readiness, 'ready');
  assert.strictEqual(result.route.dispatchAuthorized, true);
  assert.strictEqual(routeService.isRouteDispatchable(result.route), true);
  assert.deepStrictEqual(result.route.executionResources.targets.map(resource => resource.id), ['valid-result']);
}

function testExplicitSecondImageDoesNotOverrideAnInvalidModelTarget() {
  const context = {
    recent_messages: [{ index: 1, id: 'message-1', role: 'assistant', content: '[图片编辑完成] 上一轮' }],
    image_candidates: [
      imageMemory('first-result', 1, '第一张图片'),
      imageMemory('second-result', 2, '第二张图片'),
    ],
  };
  const result = inspect(editIntent(), {
    input: '编辑第二张图，把它换成黑色',
    context,
  });
  assert.ok(result.route, `${result.reason}: ${result.error || ''}`);
  assert.strictEqual(result.route.readiness, 'needs_clarification');
  assert.strictEqual(result.route.dispatchAuthorized, false);
  assert.deepStrictEqual(result.route.resources, []);
}

function testMalformedOrUnknownIntentStillUsesTheInvalidIntentFailurePath() {
  const malformed = routeService.inspectModelRouteResult('{not-json', {
    input: '换成黑色', attachments: [], context: contextWithMemory([]),
  });
  assert.ok(!malformed.route);
  assert.notStrictEqual(malformed.reason, '');

  const unknownOperation = routeService.inspectModelRouteResult(JSON.stringify({
    operation: 'delete_image',
    relation: 'new',
    goal: '删除图片',
    task_shape: 'single',
    resource_refs: [],
  }), {
    input: '删除图片', attachments: [], context: contextWithMemory([]),
  });
  assert.strictEqual(unknownOperation.route, null);
  assert.strictEqual(unknownOperation.reason, 'route_intent_invalid');
}

function testSelectingClarificationImageResumesOnlyWithTheChosenTarget() {
  const context = contextWithMemory([
    imageMemory('cat-result', 1, '猫图片'),
    imageMemory('car-result', 2, '汽车图片'),
  ]);
  const first = inspect(editIntent(), { context }).route;
  const pending = clarificationAnswer.createPendingClarification({
    id: 'clarify-unclear-target',
    messages: [{ role: 'user', content: '换成黑色' }],
    clarificationText: first.clarificationQuestion,
    routeInfo: first,
  });
  const answer = clarificationAnswer.createClarificationAnswer({
    clarificationId: pending.id,
    answers: [{ resource_key: 'r1', choice_key: 'c2' }],
    freeText: '第二张',
  });
  const applied = clarificationAnswer.applyPendingClarificationAnswer(pending, answer);
  const rerouteContext = clarificationAnswer.buildClarificationRouteContext({
    baseContext: context,
    pending: applied.pending,
  });

  const selectedCandidate = routeService.wireResourceCandidates([], rerouteContext, '换成黑色')
    .find(candidate => candidate.resource_id === 'res:image:car-result');
  assert.ok(selectedCandidate, 'the selected clarification resource must cross the next model boundary');
  const resumed = inspect(editIntent([{
    candidate_key: selectedCandidate.candidate_key,
    role: 'target',
  }]), { context: rerouteContext }).route;
  assert.strictEqual(resumed.readiness, 'ready');
  assert.strictEqual(resumed.dispatchAuthorized, true);
  assert.strictEqual(routeService.isRouteDispatchable(resumed), true);
  assert.deepStrictEqual(resumed.executionResources.targets.map(resource => resource.resource_id), [
    'res:image:car-result',
  ]);
}

async function testIntentWorkflowReturnsResourceChoicesInsteadOfGenericInvalidStructureError() {
  const imageRouteContext = require('../../client/core/image-route-context');
  const previousRouteService = globalThis.ChatUIRouteService;
  const previousCore = globalThis.ChatUICore;
  globalThis.ChatUIRouteService = routeService;
  globalThis.ChatUICore = { ...(previousCore || {}), imageRouteContext };
  const messages = [
    { role: 'user', content: '画一只猫' },
    {
      role: 'assistant',
      displayItemId: 'image-message-1',
      content: '[图片生成完成] 画一只猫',
      rawText: '[图片生成完成] 画一只猫',
      kind: 'image',
      imageContext: JSON.stringify({
        prompt: '画一只猫', mode: 'image', target: 'previous',
        attachments: [{ name: 'cat.png', type: 'image/png', src: 'indexeddb://cat', labels: ['猫'] }],
      }),
    },
    { role: 'user', content: '换个姿势' },
    {
      role: 'assistant',
      displayItemId: 'image-message-2',
      content: '[图片生成完成] 换个姿势',
      rawText: '[图片生成完成] 换个姿势',
      kind: 'image',
      imageContext: JSON.stringify({
        prompt: '换个姿势', mode: 'image', target: 'previous',
        attachments: [{ name: 'cat-pose.png', type: 'image/png', src: 'indexeddb://cat-pose', labels: ['猫', '姿势'] }],
      }),
    },
  ];
  const calls = [];
  const workflow = routeIntentWorkflow.createRouteIntentWorkflow({
    state: {
      activeSessionId: 'session-unclear-target',
      mode: 'chat',
      autoMode: true,
      sessions: [{ id: 'session-unclear-target', messages }],
      messages,
    },
    getConfig: () => ({
      baseUrl: 'https://gateway.example/v1', apiKey: 'test-key',
      routeModel: 'route-model', chatModel: 'route-model',
    }),
    getSessionRouteModel: () => 'route-model',
    getSessionChatModel: () => 'route-model',
    buildRouteAttachmentMetadata: () => [],
    requestJson: async () => {
      calls.push(true);
      return { choices: [{ message: { content: JSON.stringify(editIntent([{ candidate_key: 'm4', role: 'target' }])) } }] };
    },
  });

  try {
    const route = await workflow.getEffectiveRoute('换成黑色', [], 'session-unclear-target');
    assert.strictEqual(calls.length, 1);
    assert.strictEqual(route.api, 'clarify');
    assert.strictEqual(route.operationType, 'edit_image');
    assert.match(route.clarificationQuestion, /没有明确要编辑哪张图片/);
    assert.ok(route.clarificationSlots[0].choices.length >= 2);
    assert.doesNotMatch(route.clarificationQuestion, /意图模型返回了无效的任务结构/);
  } finally {
    if (previousRouteService === undefined) delete globalThis.ChatUIRouteService;
    else globalThis.ChatUIRouteService = previousRouteService;
    if (previousCore === undefined) delete globalThis.ChatUICore;
    else globalThis.ChatUICore = previousCore;
  }
}

module.exports = [
  testInvalidMessageTargetListsEveryRecoverableImageForClarification,
  testInvalidMessageTargetStillRequiresConfirmationWithOneRecoverableImage,
  testInvalidMessageTargetWithoutImagesRequestsUploadInsteadOfExecuting,
  testRejectedImageTargetAsksForAnImageChoiceInsteadOfFreeText,
  testMaterializerTargetAmbiguityRendersReplacementImageChoices,
  testValidImageTargetRemainsImmediatelyDispatchable,
  testExplicitSecondImageDoesNotOverrideAnInvalidModelTarget,
  testMalformedOrUnknownIntentStillUsesTheInvalidIntentFailurePath,
  testSelectingClarificationImageResumesOnlyWithTheChosenTarget,
  testIntentWorkflowReturnsResourceChoicesInsteadOfGenericInvalidStructureError,
];
