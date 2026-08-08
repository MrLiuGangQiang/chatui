'use strict';

const assert = require('assert');
const imageRouteContext = require('../../client/core/image-route-context');
const routeService = require('../../client/services/route-service');

function completedImageMessage() {
  return {
    id: 'visual-lineage-session:assistant:1',
    role: 'assistant',
    content: '[图片生成完成] 画一只猫',
    rawText: '[图片生成完成] 画一只猫',
    responseIndex: '1',
    kind: 'image',
    imageContext: JSON.stringify({
      schema_version: 'image_result.v1',
      resultId: 'cat-result',
      referenceId: 'imgref_cat-result',
      selectedReferenceId: 'imgref_cat-result',
      prompt: '画一只猫',
      routePrompt: '画一只猫',
      mode: 'image',
      target: 'previous',
      usePreviousImage: true,
      updatedAt: 100,
      attachments: [{
        id: 'img_imgref_cat-result_1',
        imageId: 'img_imgref_cat-result_1',
        referenceId: 'imgref_cat-result',
        src: 'indexeddb://cat-result',
        name: 'cat.png',
        type: 'image/png',
        sourceIndex: 1,
      }],
    }),
  };
}

function buildContext(messages) {
  const lastGeneratedImage = {
    resultId: 'cat-result',
    referenceId: 'imgref_cat-result',
    src: 'indexeddb://cat-result',
    prompt: '画一只猫',
    updatedAt: 100,
    images: [{
      id: 'img_imgref_cat-result_1',
      imageId: 'img_imgref_cat-result_1',
      referenceId: 'imgref_cat-result',
      src: 'indexeddb://cat-result',
      filename: 'cat.png',
      prompt: '画一只猫',
    }],
  };
  return imageRouteContext.buildRouteContext({
    messages,
    lastGeneratedImage,
    recentImageReferences: imageRouteContext.collectRecentImageReferences({
      messages,
      lastGeneratedImage,
      limit: 6,
    }),
    latestImageReference: {
      target: 'previous',
      usePreviousImage: true,
      count: 1,
      selection: 'all',
      reason: 'last-generated-image',
      reference_id: 'imgref_cat-result',
    },
  });
}

function publicRouteInput({ input, context, currentTurn }) {
  const payload = routeService.buildRoutePayload({
    model: 'route-model',
    input,
    attachments: [],
    context,
    currentTurn,
  });
  return JSON.parse(payload.messages[1].content);
}

function testSubjectlessImageEditKeepsLatestVisualLineageAddressable() {
  const messages = [
    { id: 'visual-lineage-session:user:0', role: 'user', content: '画一只猫', rawText: '画一只猫', messageIndex: '0' },
    completedImageMessage(),
    { id: 'visual-lineage-session:user:2', role: 'user', content: '换个颜色', rawText: '换个颜色', messageIndex: '2' },
  ];
  const context = buildContext(messages);
  const publicInput = publicRouteInput({
    input: '换个颜色',
    context,
    currentTurn: { messageIndex: 3 },
  });

  assert.deepStrictEqual(publicInput.resource_candidates.map(candidate => [candidate.candidate_key, candidate.type, candidate.label]), [
    ['i1', 'image', '画一只猫'],
    ['m1', 'message', '画一只猫'],
    ['m2', 'message', '[图片生成完成] 画一只猫'],
  ]);
  assert.deepStrictEqual(publicInput.context.previous_execution, {
    operation: 'text_to_image',
    family: 'generate',
    result_kind: 'image',
    source_message_index: 2,
    source_user_message_index: 1,
  });
  assert.strictEqual(publicInput.context.conversation_focus.kind, 'image');

  const inspected = routeService.inspectModelRouteResult(JSON.stringify({
    operation: 'edit_image',
    relation: 'continuation',
    goal: '把上一张生成的猫图片换一个颜色，但未指定目标颜色',
    resource_refs: [{ candidate_key: 'i1', role: 'target' }],
  }), {
    input: '换个颜色',
    attachments: [],
    context,
    currentTurn: { messageIndex: 3 },
  });
  assert.ok(inspected.route, `${inspected.reason}: ${inspected.error || ''}`);
  assert.strictEqual(inspected.route.operationType, 'edit_image');
  assert.deepStrictEqual(inspected.route.resources.map(resource => [resource.type, resource.role, resource.id]), [
    ['image', 'target', 'img_imgref_cat-result_1'],
  ]);
}

function testLaterOrdinaryTextResponseDoesNotHideBoundedVisualEvidence() {
  const messages = [
    { id: 'visual-lineage-session:user:0', role: 'user', content: '画一只猫', rawText: '画一只猫', messageIndex: '0' },
    completedImageMessage(),
    { id: 'visual-lineage-session:user:2', role: 'user', content: '输出一个 Markdown 示例', rawText: '输出一个 Markdown 示例', messageIndex: '2' },
    { id: 'visual-lineage-session:assistant:3', role: 'assistant', content: '# 示例\n\n这是普通文本回复。', rawText: '# 示例\n\n这是普通文本回复。', responseIndex: '3' },
    { id: 'visual-lineage-session:user:4', role: 'user', content: '换个颜色', rawText: '换个颜色', messageIndex: '4' },
  ];
  const context = buildContext(messages);
  assert.strictEqual(context.previous_execution, null);
  assert.strictEqual(context.conversation_focus.kind, 'text');

  const publicInput = publicRouteInput({
    input: '换个颜色',
    context,
    currentTurn: { messageIndex: 5 },
  });
  assert.ok(publicInput.resource_candidates.some(candidate => candidate.type === 'image'),
    'bounded images must remain available for the model even when newer text focus exists');
  assert.strictEqual(publicInput.context.previous_execution, undefined);
  assert.strictEqual(publicInput.context.conversation_focus.kind, 'text');
}

module.exports = [
  testSubjectlessImageEditKeepsLatestVisualLineageAddressable,
  testLaterOrdinaryTextResponseDoesNotHideBoundedVisualEvidence,
];

