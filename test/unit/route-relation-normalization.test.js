'use strict';

const assert = require('assert');
const routeService = require('../../client/services/route-service');

function imageContext() {
  return {
    recent_messages: [{ index: 1, role: 'assistant', content: '已完成日间版本' }],
    image_candidates: [{
      index: 1,
      source_index: 1,
      source: 'history',
      image_id: 'img-history-sketch',
      resource_id: 'res:image:img-history-sketch',
      reference_id: 'imgref-history-sketch',
      description: '建筑日间草图',
    }],
    file_candidates: [],
  };
}

function imagePlan(input, relation = 'followup') {
  return {
    operation: 'image_reference_gen',
    relation,
    arguments: { prompt: input },
    bindings: [{ key: 'r1', type: 'image', role: 'reference', resource_id: 'i1', source: 'history' }],
    constraints: [],
  };
}

function filePlan(input) {
  return {
    operation: 'file_qa',
    relation: 'followup',
    arguments: { prompt: input },
    bindings: [{ key: 'r1', type: 'file', role: 'attachment', resource_id: 'f1', source: 'history' }],
    constraints: [],
  };
}

function inspect(plan, input, context) {
  const route = routeService.compileLocalRoute(plan, {
    input,
    attachments: [],
    context,
    currentMode: 'chat',
    autoMode: true,
  });
  assert.ok(route, 'route compilation failed');
  return route;
}

function testImageContinuationCueIsCanonicalizedAtTrustBoundary() {
  const input = '继续用刚才那张草图，再生成一个夜间版本。';
  const route = inspect(imagePlan(input, 'followup'), input, imageContext());
  assert.strictEqual(route.operationType, 'image_reference_gen');
  assert.strictEqual(route.relation, 'continuation');
  assert.strictEqual(route.dispatchContract.relation, 'continuation');
  assert.strictEqual(route.dispatchAuthorized, true);
}

function testCorrectionCueWinsOverContinuationWording() {
  const input = '上次参考图生成的版本还是不对，请继续沿用那张参考图，把主色改为墨绿，其他结构保留。';
  const route = inspect(imagePlan(input, 'followup'), input, imageContext());
  assert.strictEqual(route.relation, 'correction');
  assert.strictEqual(route.dispatchContract.relation, 'correction');
}

function testNonVisualFollowupIsNotReclassifiedAsContinuation() {
  const input = '继续总结刚才那个扫描合同。';
  const context = {
    recent_messages: [{ index: 1, role: 'user', content: '刚才上传了一份合同' }],
    image_candidates: [],
    file_candidates: [{
      index: 1,
      source_index: 1,
      source: 'history',
      file_id: 'file-history-scan',
      name: 'scan-contract.pdf',
      has_extracted_text: false,
    }],
  };
  const route = inspect(filePlan(input), input, context);
  assert.strictEqual(route.operationType, 'file_qa');
  assert.strictEqual(route.relation, 'followup');
}

function testConcreteImageEditCannotFallBackToPlainChatWithoutTarget() {
  const input = '把这张图的背景换成蓝色。';
  const route = inspect({
    ...imagePlan(input, 'new'),
    operation: 'plain_chat',
    bindings: [],
  }, input, { recent_messages: [], image_candidates: [], file_candidates: [] });
  assert.strictEqual(route.operationType, 'edit_image');
  assert.strictEqual(route.readiness, 'needs_clarification');
  assert.strictEqual(route.dispatchAuthorized, false);
  assert.strictEqual(route.dispatchContract, null);
  assert.strictEqual(route.clarificationSlots[0].role, 'target');
  assert.strictEqual(route.clarificationSlots[0].reason, 'missing');
}

function testHistoricalImageEditWithoutModelBindingShowsAvailableImageChoices() {
  const input = '将历史中的猫的图片换成纯白色';
  const route = inspect({
    operation: 'edit_image',
    relation: 'new',
    arguments: { prompt: input },
    bindings: [],
    constraints: [],
  }, input, {
    recent_messages: [],
    image_candidates: [
      {
        index: 1,
        source_index: 1,
        source: 'history',
        image_id: 'img-history-cat-a',
        resource_id: 'res:image:img-history-cat-a',
        description: '猫换一个品种',
      },
      {
        index: 2,
        source_index: 2,
        source: 'history',
        image_id: 'img-history-cat-b',
        resource_id: 'res:image:img-history-cat-b',
        description: '画一只猫',
      },
    ],
    file_candidates: [],
  });

  assert.strictEqual(route.relation, 'followup');
  assert.strictEqual(route.readiness, 'needs_clarification');
  assert.strictEqual(route.clarificationQuestion, '没有明确要编辑哪张图片，请从下列图片中选择目标图片。');
  const [slot] = route.clarificationSlots;
  assert.strictEqual(slot.type, 'image');
  assert.strictEqual(slot.role, 'target');
  assert.strictEqual(slot.reason, 'ambiguous');
  assert.deepStrictEqual(slot.choices.map(choice => choice.id), [
    'img-history-cat-a',
    'img-history-cat-b',
  ]);
}

function testConcreteImageEditSelectsTheOnlyAvailableTarget() {
  const input = '把刚才那张图的背景换成蓝色。';
  const context = imageContext();
  const route = inspect({
    ...imagePlan(input, 'followup'),
    operation: 'plain_chat',
    bindings: [],
  }, input, context);
  assert.strictEqual(route.operationType, 'edit_image');
  assert.strictEqual(route.readiness, 'ready');
  assert.strictEqual(route.executionResources.targets.length, 1);
  assert.strictEqual(route.executionResources.targets[0].resource_id, 'res:image:img-history-sketch');
  assert.strictEqual(route.dispatchContract.bindings[0].role, 'target');
  assert.strictEqual(route.dispatchAuthorized, true);
}

function testConcreteMutationWithMultipleMatchedImagesClarifiesInsteadOfKeepingReadOnlyBindings() {
  const input = '把猫的背景改成白色。';
  const context = {
    recent_messages: [{ index: 1, role: 'assistant', content: '有两张猫咪图片可供后续编辑' }],
    image_candidates: [
      {
        index: 1,
        source_index: 1,
        source: 'history',
        image_id: 'img-history-cat-a',
        reference_id: 'imgref-history-cats',
        description: '一只橘猫',
      },
      {
        index: 2,
        source_index: 2,
        source: 'history',
        image_id: 'img-history-cat-b',
        reference_id: 'imgref-history-cats',
        description: '一只黑猫',
      },
    ],
    file_candidates: [],
  };
  const route = inspect({
    operation: 'image_qa',
    relation: 'new',
    arguments: { prompt: input },
    bindings: [
      { key: 'r1', type: 'image', role: 'source', resource_id: 'i1', source: 'history' },
      { key: 'r2', type: 'image', role: 'source', resource_id: 'i2', source: 'history' },
    ],
    constraints: ['存在两张候选猫咪图片，需先确认要编辑哪一张。'],
  }, input, context);

  assert.strictEqual(route.operationType, 'edit_image');
  assert.strictEqual(route.relation, 'followup');
  assert.strictEqual(route.readiness, 'needs_clarification');
  assert.strictEqual(route.dispatchAuthorized, false);
  assert.deepStrictEqual(route.resources, [], 'bindings from the rejected read-only operation must not survive the operation change');
  assert.strictEqual(route.dispatchContract, null);
  const [slot] = route.clarificationSlots;
  assert.strictEqual(slot.type, 'image');
  assert.strictEqual(slot.role, 'target');
  assert.strictEqual(slot.reason, 'ambiguous');
  assert.deepStrictEqual(slot.choices.map(choice => choice.id), ['img-history-cat-a', 'img-history-cat-b']);
}

function testCurrentFileRequestRemainsAStandaloneNewTask() {
  const input = '总结这个合同中的付款节点和违约责任。';
  const route = inspect({
    operation: 'file_qa',
    relation: 'new',
    arguments: { prompt: input },
    bindings: [{ key: 'r1', type: 'file', role: 'attachment', resource_id: 'f1', source: 'current' }],
    constraints: [],
  }, input, {
    recent_messages: [{ index: 1, role: 'user', content: input }],
    image_candidates: [],
    file_candidates: [{
      index: 1,
      source_index: 1,
      source: 'current',
      file_id: 'file-current-contract',
      name: 'contract.pdf',
      has_extracted_text: true,
    }],
  });

  assert.strictEqual(route.operationType, 'file_qa');
  assert.strictEqual(route.relation, 'new');
  assert.strictEqual(route.readiness, 'ready');
  assert.strictEqual(route.dispatchContract.context_policy.history, 'none');
  assert.strictEqual(route.executionResources.files[0].source, 'current');
}

function testExplicitPriorFileReferenceCannotDegradeToPlainChat() {
  const input = '总结刚才那个文件的结论。';
  const route = inspect({
    operation: 'plain_chat',
    relation: 'followup',
    arguments: { prompt: input },
    bindings: [],
    constraints: ['当前没有可用文件附件，无法总结文件内容；请重新上传文件。'],
  }, input, {
    recent_messages: [{ index: 1, role: 'user', content: '之前提到过一个文件，但当前没有可用附件' }],
    image_candidates: [],
    file_candidates: [],
  });

  assert.strictEqual(route.operationType, 'file_qa');
  assert.strictEqual(route.relation, 'followup');
  assert.strictEqual(route.readiness, 'needs_clarification');
  assert.strictEqual(route.dispatchAuthorized, false);
  assert.deepStrictEqual(route.resources, []);
  assert.strictEqual(route.dispatchContract, null);
  const [slot] = route.clarificationSlots;
  assert.strictEqual(slot.type, 'file');
  assert.strictEqual(slot.role, 'attachment');
  assert.strictEqual(slot.reason, 'missing');
}

module.exports = [
  testImageContinuationCueIsCanonicalizedAtTrustBoundary,
  testCorrectionCueWinsOverContinuationWording,
  testNonVisualFollowupIsNotReclassifiedAsContinuation,
  testConcreteImageEditCannotFallBackToPlainChatWithoutTarget,
  testHistoricalImageEditWithoutModelBindingShowsAvailableImageChoices,
  testConcreteImageEditSelectsTheOnlyAvailableTarget,
  testConcreteMutationWithMultipleMatchedImagesClarifiesInsteadOfKeepingReadOnlyBindings,
  testCurrentFileRequestRemainsAStandaloneNewTask,
  testExplicitPriorFileReferenceCannotDegradeToPlainChat,
];
