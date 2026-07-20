'use strict';

const assert = require('assert');
const imageReferences = require('../../client/core/image-references');
const routeContext = require('../../client/core/image-route-context');
const routeService = require('../../client/services/route-service');
const imageContextWorkflow = require('../../client/app/image-context-workflow');

const COMPOSE_TWO_ANIMALS = '\u628a\u4e24\u4e2a\u52a8\u7269\u5408\u5e76\u6210\u4e00\u5f20\u56fe';

function assistantImageMessage(displayItemId, prompt, src) {
  return {
    role: 'assistant',
    displayItemId,
    content: `[\u56fe\u7247\u751f\u6210\u5b8c\u6210] ${prompt}`,
    rawText: `[\u56fe\u7247\u751f\u6210\u5b8c\u6210] ${prompt}`,
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
    directive: {
      mode: 'standalone',
      base_resource_keys: [],
      unmentioned_policy: 'allow_change',
      operations: [],
      constraints: [],
    },
    clarification: { question: '', missing_resource_keys: [] },
    confidence: 0.92,
    review_reasons: [],
    rationale: 'model_misclassified_as_chat',
  };
}

function canonicalAnimalHistory(extra = []) {
  return [
    { role: 'user', content: '\u753b\u4e00\u53ea\u732b' },
    assistantImageMessage('cat-result', '\u4e00\u53ea\u732b', 'indexeddb://cat'),
    { role: 'user', content: '\u753b\u4e00\u5934\u725b' },
    assistantImageMessage('cow-result', '\u4e00\u5934\u725b', 'indexeddb://cow'),
    ...extra,
  ];
}

function collectAnimalContext(messages = canonicalAnimalHistory()) {
  const references = routeContext.collectRecentImageReferences({ messages, limit: 10 });
  return routeContext.buildRouteContext({ messages, recentImageReferences: references });
}

function testCanonicalHistoryKeepsSemanticMetadataWhenHtmlAlsoContainsImageRefs() {
  const message = assistantImageMessage('semantic-result', '\u4e00\u8f86\u7ea2\u8272\u6d88\u9632\u8f66', 'indexeddb://fire-engine');
  const context = JSON.parse(message.imageContext);
  context.attachments[0].description = '\u7ea2\u8272\u6d88\u9632\u8f66';
  context.attachments[0].semantic_text = '\u7ea2\u8272\u6d88\u9632\u8f66 | emergency vehicle';
  message.imageContext = JSON.stringify(context);
  message.html = '<img data-persisted-src="indexeddb://fire-engine" data-filename="fire-engine.png">';
  const references = routeContext.collectRecentImageReferences({ messages: [message], limit: 10 });
  const route = routeContext.buildRouteContext({ messages: [message], recentImageReferences: references });
  assert.strictEqual(route.image_candidates[0].description, '\u7ea2\u8272\u6d88\u9632\u8f66');
  assert.ok(route.image_candidates[0].semantic_text.includes('emergency vehicle'));
}

function testCanonicalHistoryExposesEveryCompletedImageWithStableIds() {
  const context = collectAnimalContext();
  assert.strictEqual(context.image_candidates.length, 2);
  assert.deepStrictEqual(new Set(context.image_candidates.flatMap(item => item.labels)), new Set(['cow', 'cat']));
  assert.strictEqual(new Set(context.image_candidates.map(item => item.reference_id)).size, 2);
  assert.ok(context.image_candidates.every(item => item.image_id.startsWith(`img_${item.reference_id}_`)));
}

function testPluralCompositionOverridesPlainChatAndSelectsBothHistoryImages() {
  const context = collectAnimalContext();
  const parsed = routeService.parseRouteResult(JSON.stringify(plainChatContract()), {
    input: COMPOSE_TWO_ANIMALS,
    attachments: [],
    context,
  });
  assert.ok(parsed);
  assert.strictEqual(parsed.mode, 'image');
  assert.strictEqual(parsed.operationType, 'image_reference_gen');
  assert.strictEqual(parsed.relation, 'followup');
  assert.strictEqual(parsed.selectedImageIds.length, 2);
  assert.deepStrictEqual(new Set(parsed.selectedImageIds), new Set(context.image_candidates.map(item => item.image_id)));
  assert.strictEqual(parsed.taskContract.directive.base_resource_keys.length, 2);
  assert.strictEqual(parsed.taskContract.directive.unmentioned_policy, 'allow_change');
  assert.strictEqual(parsed.contextualImagePrompt, COMPOSE_TWO_ANIMALS);
}

function testSemanticCompositionSelectsNamedImagesAmongManyCandidates() {
  const messages = canonicalAnimalHistory([
    { role: 'user', content: '画一只狗' },
    assistantImageMessage('dog-result', '一只狗', 'indexeddb://dog'),
    { role: 'user', content: '画一辆汽车' },
    assistantImageMessage('car-result', '一辆汽车', 'indexeddb://car'),
    { role: 'user', content: '画一座城堡' },
    assistantImageMessage('castle-result', '一座城堡', 'indexeddb://castle'),
  ]);
  const context = collectAnimalContext(messages);
  const parsed = routeService.parseRouteResult(JSON.stringify(plainChatContract()), {
    input: '把猫和狗合并成一张图，不要牛',
    attachments: [],
    context,
  });
  assert.ok(parsed);
  assert.strictEqual(parsed.operationType, 'image_reference_gen');
  assert.strictEqual(parsed.needClarification, false);
  const selected = context.image_candidates.filter(item => parsed.selectedImageIds.includes(item.image_id));
  assert.deepStrictEqual(new Set(selected.flatMap(item => item.labels)), new Set(['dog', 'cat']));
  assert.deepStrictEqual(new Set(selected.map(item => item.prompt)), new Set(['一只狗', '一只猫']));
}

function testSemanticCompositionWorksForSubjectsOutsideLegacyLabels() {
  const messages = [
    { role: 'user', content: '生成一辆红色消防车' },
    assistantImageMessage('fire-engine-result', '一辆红色消防车', 'indexeddb://fire-engine'),
    { role: 'user', content: '生成一个彩色热气球' },
    assistantImageMessage('balloon-result', '一个彩色热气球', 'indexeddb://balloon'),
    { role: 'user', content: '生成一座石头城堡' },
    assistantImageMessage('stone-castle-result', '一座石头城堡', 'indexeddb://stone-castle'),
  ];
  const context = collectAnimalContext(messages);
  assert.ok(context.image_candidates.every(item => item.semantic_text.includes(item.prompt)));
  const parsed = routeService.parseRouteResult(JSON.stringify(plainChatContract()), {
    input: '把消防车和热气球放在一起，合并成一张图',
    attachments: [],
    context,
  });
  const selected = context.image_candidates.filter(item => parsed.selectedImageIds.includes(item.image_id));
  assert.strictEqual(selected.length, 2);
  assert.deepStrictEqual(new Set(selected.map(item => item.prompt)), new Set(['一辆红色消防车', '一个彩色热气球']));
}

function testSemanticCompositionClarifiesOnlyWhenNamedSubjectIsNotUnique() {
  const messages = [
    { role: 'user', content: '画一只黑猫' },
    assistantImageMessage('black-cat-result', '一只猫', 'indexeddb://black-cat'),
    { role: 'user', content: '画一只白猫' },
    assistantImageMessage('white-cat-result', '一只猫', 'indexeddb://white-cat'),
    { role: 'user', content: '画一只狗' },
    assistantImageMessage('dog-result', '一只狗', 'indexeddb://dog'),
  ];
  const context = collectAnimalContext(messages);
  const parsed = routeService.parseRouteResult(JSON.stringify(plainChatContract()), {
    input: '把猫和狗合并成一张图',
    attachments: [],
    context,
  });
  assert.strictEqual(parsed.needClarification, true);
  assert.match(parsed.clarificationQuestion, /唯一确定|补充/);
}

function testPluralCompositionClarifiesWhenMoreThanTwoCandidatesAreAmbiguous() {
  const messages = canonicalAnimalHistory([
    { role: 'user', content: '\u753b\u4e00\u53ea\u72d7' },
    assistantImageMessage('dog-result', '\u4e00\u53ea\u72d7', 'indexeddb://dog'),
  ]);
  const context = collectAnimalContext(messages);
  const parsed = routeService.parseRouteResult(JSON.stringify(plainChatContract()), {
    input: COMPOSE_TWO_ANIMALS,
    attachments: [],
    context,
  });
  assert.ok(parsed);
  assert.strictEqual(parsed.needClarification, true);
  assert.strictEqual(parsed.mode, 'chat');
  assert.match(parsed.clarificationQuestion, /\u552f\u4e00\u786e\u5b9a|\u8865\u5145/);
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
    /\u5386\u53f2\u56fe\u7247\u5df2\u4e22\u5931/
  );
}

module.exports = [
  testCanonicalHistoryKeepsSemanticMetadataWhenHtmlAlsoContainsImageRefs,
  testCanonicalHistoryExposesEveryCompletedImageWithStableIds,
  testPluralCompositionOverridesPlainChatAndSelectsBothHistoryImages,
  testSemanticCompositionSelectsNamedImagesAmongManyCandidates,
  testSemanticCompositionWorksForSubjectsOutsideLegacyLabels,
  testSemanticCompositionClarifiesOnlyWhenNamedSubjectIsNotUnique,
  testPluralCompositionClarifiesWhenMoreThanTwoCandidatesAreAmbiguous,
  testSelectedImageIdsRestoreAcrossMultipleHistoricalReferences,
  testMissingSelectedHistoricalImageFailsInsteadOfSilentlyUsingOneImage,
];
