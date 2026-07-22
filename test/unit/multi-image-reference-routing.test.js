'use strict';

const assert = require('assert');
const imageReferences = require('../../client/core/image-references');
const routeContext = require('../../client/core/image-route-context');
const routeService = require('../../client/services/route-service');
const imageContextWorkflow = require('../../client/app/image-context-workflow');

function assistantImageMessage(displayItemId, prompt, src) {
  return {
    role: 'assistant',
    displayItemId,
    content: `[图片生成完成] ${prompt}`,
    rawText: `[图片生成完成] ${prompt}`,
    imageContext: JSON.stringify({
      prompt,
      mode: 'image',
      target: 'previous',
      attachments: [{ name: `${displayItemId}.png`, type: 'image/png', src }],
    }),
  };
}

function plainChatContract() {
  return {
    schema_version: 'task_contract.v3',
    operation: 'plain_chat',
    relation: 'new',
    resources: [],
    directive: { mode: 'standalone', base_resource_keys: [], unmentioned_policy: 'allow_change', operations: [], constraints: [] },
    clarification: { question: '', missing_resource_keys: [] },
    confidence: 0.92,
    review_reasons: [],
    rationale: 'current request is a standalone text request',
  };
}

function imageReferenceContract(candidates) {
  const resources = candidates.map((candidate, index) => ({
    key: `r${index + 1}`,
    type: 'image',
    source: candidate.source,
    role: 'reference',
    index: candidate.index,
    id: candidate.image_id,
    reference_id: candidate.reference_id,
    missing: false,
  }));
  return {
    schema_version: 'task_contract.v3',
    operation: 'image_reference_gen',
    relation: 'followup',
    resources,
    directive: {
      mode: 'patch',
      base_resource_keys: resources.map(resource => resource.key),
      unmentioned_policy: 'allow_change',
      operations: [{ op: 'add', target: 'composition', value: 'combine the selected references' }],
      constraints: [],
    },
    clarification: { question: '', missing_resource_keys: [] },
    confidence: 0.95,
    review_reasons: [],
    rationale: 'model selected the referenced images from route context',
  };
}

function canonicalAnimalHistory(extra = []) {
  return [
    { role: 'user', content: '画一只猫' },
    assistantImageMessage('cat-result', '一只猫', 'indexeddb://cat'),
    { role: 'user', content: '画一头牛' },
    assistantImageMessage('cow-result', '一头牛', 'indexeddb://cow'),
    ...extra,
  ];
}

function collectAnimalContext(messages = canonicalAnimalHistory()) {
  const references = routeContext.collectRecentImageReferences({ messages, limit: 10 });
  return routeContext.buildRouteContext({ messages, recentImageReferences: references });
}

function candidateByPrompt(context, prompt) {
  const candidate = context.image_candidates.find(item => item.prompt === prompt);
  assert.ok(candidate, `missing image candidate: ${prompt}`);
  return candidate;
}

function testCanonicalHistoryKeepsSemanticMetadataWhenHtmlAlsoContainsImageRefs() {
  const message = assistantImageMessage('semantic-result', '一辆红色消防车', 'indexeddb://fire-engine');
  const context = JSON.parse(message.imageContext);
  context.attachments[0].description = '红色消防车';
  context.attachments[0].semantic_text = '红色消防车 | emergency vehicle';
  message.imageContext = JSON.stringify(context);
  message.html = '<img data-persisted-src="indexeddb://fire-engine" data-filename="fire-engine.png">';
  const references = routeContext.collectRecentImageReferences({ messages: [message], limit: 10 });
  const route = routeContext.buildRouteContext({ messages: [message], recentImageReferences: references });
  assert.strictEqual(route.image_candidates[0].description, '红色消防车');
  assert.ok(route.image_candidates[0].semantic_text.includes('emergency vehicle'));
}

function testCanonicalHistoryExposesEveryCompletedImageWithStableIds() {
  const context = collectAnimalContext();
  assert.strictEqual(context.image_candidates.length, 2);
  assert.deepStrictEqual(new Set(context.image_candidates.flatMap(item => item.labels)), new Set(['cow', 'cat']));
  assert.strictEqual(new Set(context.image_candidates.map(item => item.reference_id)).size, 2);
  assert.ok(context.image_candidates.every(item => item.image_id.startsWith(`img_${item.reference_id}_`)));
}

function testStandaloneBusinessRequestIsNeverOverriddenByImageKeywordHeuristics() {
  const context = collectAnimalContext();
  const input = [
    '咨询下面几个问题，确定是不是要做二开：',
    '1、根据页面配置自动创建并关联底层数据模型，支持一对一、一对多、多对多关系。',
    '2、数据列表视图下支持子表数据自动合并行展示/分组。',
    '帮我生成一个回复模板，不需要内容。',
  ].join('\n');
  const parsed = routeService.parseRouteResult(JSON.stringify(plainChatContract()), { input, attachments: [], context });

  assert.ok(parsed);
  assert.strictEqual(parsed.mode, 'chat');
  assert.strictEqual(parsed.operationType, 'plain_chat');
  assert.strictEqual(parsed.needClarification, false);
  assert.strictEqual(parsed.clarificationQuestion, '');
  assert.deepStrictEqual(parsed.taskContract, plainChatContract());
}

function testModelDeclaredCompositionSelectsOnlyItsContractResources() {
  const messages = canonicalAnimalHistory([
    { role: 'user', content: '画一只狗' },
    assistantImageMessage('dog-result', '一只狗', 'indexeddb://dog'),
    { role: 'user', content: '画一辆汽车' },
    assistantImageMessage('car-result', '一辆汽车', 'indexeddb://car'),
  ]);
  const context = collectAnimalContext(messages);
  const selected = [candidateByPrompt(context, '一只猫'), candidateByPrompt(context, '一只狗')];
  const input = '把猫和狗合并成一张图，不要牛';
  const parsed = routeService.parseRouteResult(JSON.stringify(imageReferenceContract(selected)), { input, attachments: [], context });

  assert.ok(parsed);
  assert.strictEqual(parsed.operationType, 'image_reference_gen');
  assert.strictEqual(parsed.needClarification, false);
  assert.deepStrictEqual(new Set(parsed.selectedImageIds), new Set(selected.map(item => item.image_id)));
  assert.deepStrictEqual(new Set(parsed.taskContract.directive.base_resource_keys), new Set(['r1', 'r2']));
  assert.strictEqual(parsed.contextualImagePrompt, input);
}

function createWorkflow(messages) {
  const state = { activeSessionId: 's1', lastGeneratedImage: null, sessions: [{ id: 's1', messages }] };
  return imageContextWorkflow.createImageContextWorkflow({
    getState: () => state,
    getActiveSession: () => state.sessions[0],
    isImageFile: item => String(item?.type || '').startsWith('image/'),
    imageRefToFile: async (src, name) => ({ name, type: 'image/png', size: 1, src }),
    normalizeLastGeneratedImage: routeContext.normalizeLastGeneratedImage,
    findImageReferenceById: (sessionId, referenceId) => routeContext.findImageReferenceById({ messages, referenceId }),
    makeImageReferenceId: imageReferences.makeImageReferenceId,
    parseImageReferenceId: imageReferences.parseImageReferenceId,
    makeImageItemId: imageReferences.makeImageItemId,
    parseImageItemId: imageReferences.parseImageItemId,
    normalizeImageSelection: imageReferences.normalizeImageSelection,
    normalizeSelectedImageIds: imageReferences.normalizeSelectedImageIds,
  });
}

async function testSelectedImageIdsRestoreAcrossMultipleHistoricalReferences() {
  const messages = canonicalAnimalHistory();
  const context = collectAnimalContext(messages);
  const workflow = createWorkflow(messages);
  const ids = context.image_candidates.map(item => item.image_id);
  const attachments = await workflow.getPreviousImageAttachments('s1', null, context.image_candidates[0].reference_id, ids);
  assert.strictEqual(attachments.length, 2);
  assert.deepStrictEqual(attachments.map(item => item.imageId), ids);
  assert.deepStrictEqual(new Set(attachments.map(item => item.dataUrl)), new Set(['indexeddb://cat', 'indexeddb://cow']));
  assert.strictEqual(new Set(attachments.map(item => item.referenceId)).size, 2);
}

async function testMissingSelectedHistoricalImageFailsInsteadOfSilentlyUsingOneImage() {
  const messages = canonicalAnimalHistory();
  const context = collectAnimalContext(messages);
  const workflow = createWorkflow(messages);
  const ids = [context.image_candidates[0].image_id, 'img_imgref_missing-result_1'];
  await assert.rejects(
    () => workflow.getPreviousImageAttachments('s1', null, context.image_candidates[0].reference_id, ids),
    /历史图片已丢失/
  );
}

module.exports = [
  testCanonicalHistoryKeepsSemanticMetadataWhenHtmlAlsoContainsImageRefs,
  testCanonicalHistoryExposesEveryCompletedImageWithStableIds,
  testStandaloneBusinessRequestIsNeverOverriddenByImageKeywordHeuristics,
  testModelDeclaredCompositionSelectsOnlyItsContractResources,
  testSelectedImageIdsRestoreAcrossMultipleHistoricalReferences,
  testMissingSelectedHistoricalImageFailsInsteadOfSilentlyUsingOneImage,
];
