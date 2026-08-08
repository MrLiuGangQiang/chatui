'use strict';

const assert = require('assert');
const routeService = require('../../client/services/route-service');
const submitHelpers = require('../../client/app/submit-workflow.helpers');
const chatService = require('../../client/services/chat-service');
const dispatchContract = require('../../shared/dispatch-contract');

function routeIntent(operation, relation = 'new', resourceRefs = [], goal = `处理当前 ${operation} 请求`) {
  return {
    operation,
    relation,
    goal,
    resource_refs: resourceRefs,
  };
}

function currentImages(count = 3) {
  return Array.from({ length: count }, (_, index) => ({
    id: `upload-${index + 1}`,
    imageId: `upload-${index + 1}`,
    type: 'image/png',
    name: `product-${index + 1}.png`,
    dataUrl: `data:image/png;base64,IMAGE${index + 1}`,
  }));
}

function sameIndexHistory() {
  return {
    image_candidates: [
      { image_id: 'history-1', source: 'history', index: 1, description: 'historical product 1' },
      { image_id: 'history-2', source: 'history', index: 2, description: 'historical product 2' },
      { image_id: 'history-3', source: 'history', index: 3, description: 'historical product 3' },
    ],
  };
}

function testModelSelectedCurrentImagesAreAuthoritativeForComparison() {
  const result = routeService.inspectModelRouteResult(
    JSON.stringify(routeIntent('image_compare', 'new', [
      { candidate_key: 'i1', role: 'compare_a' },
      { candidate_key: 'i3', role: 'compare_b' },
    ], '比较所选两张产品图的构图与色调差异。')),
    {
      input: '比较第一张和第三张产品图的构图与色调差异。',
      attachments: currentImages(),
      context: sameIndexHistory(),
    },
  );

  assert.ok(result.route, result.error || result.reason);
  assert.strictEqual(result.route.operationType, 'image_compare');
  assert.strictEqual(result.route.relation, 'new');
  assert.strictEqual(result.route.needClarification, false);
  assert.deepStrictEqual(
    result.route.resources.map(resource => [resource.id, resource.source, resource.role]),
    [
      ['upload-1', 'current', 'compare_a'],
      ['upload-3', 'current', 'compare_b'],
    ],
  );
  assert.strictEqual(result.route.dispatchContract.arguments.prompt, '比较所选两张产品图的构图与色调差异。');
  assert.strictEqual(routeService.isRouteDispatchable(result.route), true);
}

function testLocalOrdinalParsingCannotRewriteModelSelections() {
  const result = routeService.inspectModelRouteResult(
    JSON.stringify(routeIntent('image_compare', 'new', [
      { candidate_key: 'i2', role: 'compare_a' },
      { candidate_key: 'i4', role: 'compare_b' },
    ], '比较所选两张产品图。')),
    {
      input: '比较最开始这一张和倒数第二张产品图。',
      attachments: currentImages(4),
      context: sameIndexHistory(),
    },
  );

  assert.ok(result.route, result.error || result.reason);
  assert.strictEqual(result.route.needClarification, false);
  assert.deepStrictEqual(
    result.route.resources.map(resource => [resource.id, resource.index, resource.role]),
    [
      ['upload-2', 2, 'compare_a'],
      ['upload-4', 4, 'compare_b'],
    ],
    'the compiler must project the model refs exactly instead of reparsing current_input',
  );
}

function testStartAndPenultimateOcrUsesResolvedGoalAndTwoSelectedImages() {
  const attachments = currentImages(4);
  const input = '最开始这一张后倒数第二张图片分别是什么文字';
  const goal = '分别逐字提取所选两张图片中的文字，并按图片附件顺序列出结果。';
  const intent = routeIntent('ocr', 'new', [
    { candidate_key: 'i1', role: 'source' },
    { candidate_key: 'i3', role: 'source' },
  ], goal);

  const result = routeService.inspectModelRouteResult(JSON.stringify(intent), {
    input,
    attachments,
    context: {},
  });

  assert.ok(result.route, result.error || result.reason);
  assert.strictEqual(result.route.operationType, 'ocr');
  assert.strictEqual(result.route.needClarification, false);
  assert.deepStrictEqual(
    result.route.resources.map(resource => [resource.id, resource.index, resource.role]),
    [
      ['upload-1', 1, 'source'],
      ['upload-3', 3, 'source'],
    ],
  );
  assert.strictEqual(result.route.executionPrompt, goal);
  assert.strictEqual(result.route.dispatchContract.arguments.prompt, goal);
  assert.ok(!result.route.dispatchContract.arguments.prompt.includes('倒数第二张'));

  const pools = submitHelpers.buildExecutionResourcePools({ current: attachments }, {
    isImageFile: item => String(item?.type || '').startsWith('image/'),
  });
  const executionMedia = submitHelpers.projectRouteExecutionMedia(result.route, pools);
  assert.deepStrictEqual(executionMedia.chatImages.map(item => item.imageId), ['upload-1', 'upload-3']);

  const content = chatService.buildUserContentWithAttachments(goal, executionMedia.chatImages);
  assert.strictEqual(content.filter(part => part.type === 'image_url').length, 2);
  const bindingEvidence = dispatchContract.bindingEvidenceFromMedia({ images: executionMedia.chatImages });
  assert.strictEqual(dispatchContract.assertPayloadMatchesDispatchContract(result.route.dispatchContract, {
    payload: { messages: [{ role: 'user', content }] },
    transportApi: 'chat',
    bindingEvidence,
  }), true);
}

function testModelOperationIsNotOverriddenByLocalIntentRules() {
  const result = routeService.inspectModelRouteResult(
    JSON.stringify(routeIntent('plain_chat', 'followup', [], '回答用户当前的文本问题。')),
    {
      input: '提取这图里面的文字',
      attachments: currentImages(1),
      context: sameIndexHistory(),
    },
  );

  assert.ok(result.route, result.error || result.reason);
  assert.strictEqual(result.route.operationType, 'plain_chat');
  assert.strictEqual(result.route.relation, 'followup');
  assert.deepStrictEqual(result.route.resources, []);
  assert.strictEqual(result.route.dispatchContract.arguments.prompt, '提取这图里面的文字');
  assert.strictEqual(routeService.isRouteDispatchable(result.route), true);
}

function testModelOmissionDoesNotTriggerLocalResourceSelection() {
  const result = routeService.inspectModelRouteResult(
    JSON.stringify(routeIntent('ocr', 'new', [], '提取用户指定图片中的文字。')),
    {
      input: '提取第一张和第三张图片里的文字',
      attachments: currentImages(3),
      context: {},
    },
  );

  assert.ok(result.route, result.error || result.reason);
  assert.strictEqual(result.route.operationType, 'ocr');
  assert.strictEqual(result.route.needClarification, true);
  assert.strictEqual(result.route.dispatchAuthorized, false);
  assert.deepStrictEqual(result.route.resources, []);
}

function testVariadicModelSelectionsSurviveProjection() {
  const result = routeService.inspectModelRouteResult(
    JSON.stringify(routeIntent('ocr', 'new', [
      { candidate_key: 'i1', role: 'source' },
      { candidate_key: 'i3', role: 'source' },
    ], '提取所选图片中的文字。')),
    {
      input: '提取这些图片里的文字',
      attachments: currentImages(3),
      context: {},
    },
  );

  assert.ok(result.route, result.error || result.reason);
  assert.strictEqual(result.route.needClarification, false);
  assert.deepStrictEqual(result.route.resources.map(resource => resource.id), ['upload-1', 'upload-3']);
  assert.strictEqual(result.route.dispatchContract.bindings.length, 2);
}

function testUnknownModelCandidateFailsClosed() {
  const result = routeService.inspectModelRouteResult(
    JSON.stringify(routeIntent('ocr', 'new', [
      { candidate_key: 'i9', role: 'source' },
    ], '提取所选图片中的文字。')),
    {
      input: '提取图片文字',
      attachments: currentImages(2),
      context: {},
    },
  );

  assert.ok(result.route, result.error || result.reason);
  assert.strictEqual(result.route.needClarification, true);
  assert.strictEqual(result.route.dispatchAuthorized, false);
  assert.strictEqual(result.route.dispatchContract, null);
}

function testModelCanSelectPriorImageWhenCurrentUploadExists() {
  const result = routeService.inspectModelRouteResult(
    JSON.stringify(routeIntent('ocr', 'followup', [
      { candidate_key: 'i2', role: 'source' },
    ], '提取所选历史图片中的文字。')),
    {
      input: '提取上一张图里的文字',
      attachments: currentImages(1),
      context: { image_candidates: [{ image_id: 'history-image', source: 'history', index: 1 }] },
    },
  );

  assert.ok(result.route, result.error || result.reason);
  assert.strictEqual(result.route.operationType, 'ocr');
  assert.deepStrictEqual(
    result.route.resources.map(resource => [resource.id, resource.source, resource.role]),
    [['history-image', 'history', 'source']],
  );
}

module.exports = [
  testModelSelectedCurrentImagesAreAuthoritativeForComparison,
  testLocalOrdinalParsingCannotRewriteModelSelections,
  testStartAndPenultimateOcrUsesResolvedGoalAndTwoSelectedImages,
  testModelOperationIsNotOverriddenByLocalIntentRules,
  testModelOmissionDoesNotTriggerLocalResourceSelection,
  testVariadicModelSelectionsSurviveProjection,
  testUnknownModelCandidateFailsClosed,
  testModelCanSelectPriorImageWhenCurrentUploadExists,
];
