'use strict';

const assert = require('assert');
const imageReferences = require('../../client/core/image-references');
const routeContext = require('../../client/core/image-route-context');
const routeService = require('../../client/services/route-service');
const imageContextWorkflow = require('../../client/app/image-context-workflow');

function assistantImageMessage(displayItemId, prompt, src, labels = []) {
  return {
    role: 'assistant',
    displayItemId,
    content: `[图片生成完成] ${prompt}`,
    rawText: `[图片生成完成] ${prompt}`,
    imageContext: JSON.stringify({
      prompt,
      mode: 'image',
      target: 'previous',
      attachments: [{ name: `${displayItemId}.png`, type: 'image/png', src, labels }],
    }),
  };
}

function canonicalAnimalHistory(extra = []) {
  return [
    { role: 'user', content: '画一只猫' },
    assistantImageMessage('cat-result', '一只猫', 'indexeddb://cat', ['cat']),
    { role: 'user', content: '画一头牛' },
    assistantImageMessage('cow-result', '一头牛', 'indexeddb://cow', ['cow']),
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


function testRefreshRebuildsGeneratedImageCandidatesWithoutReferenceCache() {
  const sourceImages = Array.from({ length: 13 }, (_, index) => ({
    name: `image-${index + 1}.png`,
    type: 'image/png',
    src: `indexeddb://image-${index + 1}`,
  }));
  const messages = [
    { role: 'user', content: '生成一组图片' },
    {
      role: 'assistant',
      content: '[图片生成完成] 生成一组图片',
      imageContext: JSON.stringify({
        schema_version: 'image_result.v1',
        resultId: 'refresh-result',
        referenceId: 'imgref_refresh-result',
        mode: 'image',
        target: 'previous',
        attachments: sourceImages,
      }),
    },
  ];

  // Simulate a browser refresh: only canonical session messages are restored;
  // the derived recentImageReferences cache is not.
  const context = routeContext.buildRouteContext({ messages });
  assert.strictEqual(context.image_candidates.length, 13);
  assert.strictEqual(context.image_candidates[2].image_id, 'img_imgref_refresh-result_3');
  assert.strictEqual(context.image_candidates[12].image_id, 'img_imgref_refresh-result_13');

  const selected = context.image_candidates.find(item => item.source_index === 3);
  const inspected = routeService.inspectModelRouteResult(JSON.stringify({
    operation: 'edit_image',
    relation: 'followup',
    goal: '将第三张图片转换为真实风格',
    task_shape: 'single',
    resource_refs: [{ candidate_key: `i${selected.index}`, role: 'target' }],
  }), {
    input: '将第三张换成真实风格的图片',
    context,
  });
  assert.strictEqual(inspected.reason, '');
  assert.ok(inspected.route);
  assert.strictEqual(inspected.route.needClarification, false);
  assert.strictEqual(inspected.route.executionResources.targets[0].id, 'img_imgref_refresh-result_3');
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
  const intent = {
    operation: 'plain_chat',
    relation: 'new',
    goal: '测试用户目标',
    task_shape: 'single',
    resource_refs: [],
  };
  const inspected = routeService.inspectModelRouteResult(JSON.stringify(intent), { input, attachments: [], context });
  const parsed = inspected.route;

  assert.strictEqual(inspected.reason, '');
  assert.ok(parsed);
  assert.strictEqual(parsed.mode, 'chat');
  assert.strictEqual(parsed.operationType, 'plain_chat');
  assert.strictEqual(parsed.needClarification, false);
  assert.strictEqual(parsed.clarificationQuestion, '');
  assert.deepStrictEqual(parsed.imageRefs, []);
  assert.deepStrictEqual(parsed.dispatchContract.bindings, []);
  assert.strictEqual(parsed.dispatchContract.context_policy.unbound_resources, 'deny');
  assert.strictEqual(routeService.isRouteDispatchable(parsed), true);
}

function testModelSelectedHistoricalImageEditSurvivesInterveningTextReply() {
  const messages = [
    { role: 'user', content: '画一只猫' },
    assistantImageMessage('cat-result', '一只猫', 'indexeddb://cat', ['猫']),
    { role: 'user', content: '这是什么品种' },
    { role: 'assistant', content: '看起来是家猫。' },
  ];
  const context = collectAnimalContext(messages);
  const cat = candidateByPrompt(context, '一只猫');
  const input = '帮我把猫的颜色换一下';
  const candidate = routeService.wireResourceCandidates([], context, input)
    .find(item => item.id === cat.image_id);
  assert.ok(candidate, 'the named historical image must cross the model candidate boundary');
  const goal = '修改所选猫图片的颜色。';
  const intent = {
    operation: 'edit_image',
    relation: 'followup',
    goal,
    task_shape: 'single',
    resource_refs: [{ candidate_key: candidate.candidate_key, role: 'target' }],
  };

  const inspected = routeService.inspectModelRouteResult(JSON.stringify(intent), {
    input,
    attachments: [],
    context,
  });
  const route = inspected.route;

  assert.ok(route, inspected.error || inspected.reason);
  assert.strictEqual(context.conversation_focus.kind, 'text', 'the intervening breed answer establishes text focus');
  assert.strictEqual(route.operationType, 'edit_image');
  assert.strictEqual(route.api, 'image_edit');
  assert.strictEqual(route.relation, 'followup');
  assert.strictEqual(route.readiness, 'ready');
  assert.strictEqual(route.dispatchContract.arguments.prompt, goal);
  assert.strictEqual(route.dispatchContract.bindings.length, 1);
  assert.strictEqual(route.dispatchContract.bindings[0].role, 'target');
  assert.strictEqual(route.dispatchContract.bindings[0].resource_id, `res:image:${encodeURIComponent(cat.image_id)}`);
}

function testOlderNamedImageMemoryCardCanBeSelectedByTheModel() {
  const messages = [];
  for (let index = 0; index < 8; index += 1) {
    const prompt = index === 0 ? '橘猫坐在窗边' : `第${index + 1}张无关图片`;
    messages.push({ role: 'user', content: `画${prompt}` });
    messages.push(assistantImageMessage(`result-${index + 1}`, prompt, `indexeddb://result-${index + 1}`, index === 0 ? ['橘猫', '窗边'] : ['无关']));
  }
  const recentReferences = routeContext.collectRecentImageReferences({ messages, limit: 6 });
  const context = routeContext.buildRouteContext({ messages, recentImageReferences: recentReferences });
  assert.strictEqual(context.image_candidates.length, 6, 'the normal route window stays compact');
  assert.strictEqual(context.image_candidates.some(item => item.prompt === '橘猫坐在窗边'), false);

  const memoryCards = routeContext.buildImageMemoryCards({ messages, recentImageReferences: recentReferences });
  assert.strictEqual(memoryCards.length, 8, 'local image memory retains every historical image card');
  const oldCat = memoryCards.find(item => item.prompt === '橘猫坐在窗边');
  assert.ok(oldCat, 'the older named image must remain recoverable in the candidate catalog');
  Object.defineProperty(context, 'image_memory_cards', { value: memoryCards, enumerable: false });

  const input = '把前面窗边的橘猫背景改成雪山';
  const candidate = routeService.wireResourceCandidates([], context, input)
    .find(item => item.id === oldCat.image_id);
  assert.ok(candidate, 'the retrieved memory card must be published to the intent model');
  const result = routeService.inspectModelRouteResult(JSON.stringify({
    operation: 'edit_image',
    relation: 'followup',
    goal: '把所选橘猫图片的背景改成雪山。',
    task_shape: 'single',
    resource_refs: [{ candidate_key: candidate.candidate_key, role: 'target' }],
  }), { input, attachments: [], context });

  assert.ok(result.route, result.error || result.reason);
  assert.strictEqual(result.route.operationType, 'edit_image');
  assert.strictEqual(result.route.readiness, 'ready');
  assert.strictEqual(result.route.dispatchContract.bindings[0].resource_id, `res:image:${encodeURIComponent(oldCat.image_id)}`);
}

function testImageMemoryCardsKeepVersionRelationship() {
  const base = assistantImageMessage('base-cat', '橘猫坐在窗边', 'indexeddb://base-cat', ['橘猫']);
  const baseReferenceId = imageReferences.makeImageReferenceId('base-cat');
  const edited = assistantImageMessage('edited-cat', '把背景改成雪山', 'indexeddb://edited-cat', ['橘猫', '雪山']);
  const editedContext = JSON.parse(edited.imageContext);
  editedContext.mode = 'edit_image';
  editedContext.selectedReferenceId = baseReferenceId;
  editedContext.selectedImageIds = [imageReferences.makeImageItemId(baseReferenceId, 1)];
  edited.imageContext = JSON.stringify(editedContext);

  const cards = routeContext.buildImageMemoryCards({ messages: [base, edited] });
  const editedCard = cards.find(item => item.prompt === '把背景改成雪山');
  assert.strictEqual(editedCard.operation, 'edit_image');
  assert.strictEqual(editedCard.parent_reference_id, baseReferenceId);
  assert.deepStrictEqual(editedCard.parent_image_ids, [imageReferences.makeImageItemId(baseReferenceId, 1)]);
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
  const catalog = routeService.buildResourceCandidates([], context);
  const intent = {
    operation: 'image_reference_gen',
    relation: 'followup',
    goal: '把所选猫和狗合并成一张新图，并排除牛。',
    task_shape: 'single',
    resource_refs: selected.map(candidate => ({
      candidate_key: catalog.find(item => item.id === candidate.image_id).candidate_key,
      role: 'reference',
    })),
  };
  const inspected = routeService.inspectModelRouteResult(JSON.stringify(intent), { input, attachments: [], context });
  const parsed = inspected.route;

  assert.strictEqual(inspected.reason, '');
  assert.ok(parsed);
  assert.strictEqual(parsed.operationType, 'image_reference_gen');
  assert.strictEqual(parsed.needClarification, false);
  assert.deepStrictEqual(new Set(parsed.selectedImageIds), new Set(selected.map(item => item.image_id)));
  assert.deepStrictEqual(new Set(parsed.dispatchContract.bindings.map(binding => binding.key)), new Set(['r1', 'r2']));
  assert.deepStrictEqual(
    new Set(parsed.dispatchContract.bindings.map(binding => binding.resource_id)),
    new Set(selected.map(candidate => `res:image:${encodeURIComponent(candidate.image_id)}`)),
  );
  assert.strictEqual(parsed.dispatchContract.context_policy.unbound_resources, 'deny');
  assert.strictEqual(routeService.isRouteDispatchable(parsed), true);
  assert.strictEqual(parsed.editInstruction, '把所选猫和狗合并成一张新图，并排除牛。');
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
    parseImageContext: value => typeof value === 'string' ? JSON.parse(value) : value,
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

async function testSelectedHistoricalUploadedImageRestoresByItsExactRouteId() {
  const uploadedReferenceId = routeContext.uploadedReferenceIdForMessageIndex(0);
  const messages = [{
    role: 'user',
    content: 'Please use this uploaded image later.',
    imageContext: JSON.stringify({
      target: 'uploaded',
      mode: 'edit_image',
      attachments: [
        { id: 'upload-one', name: 'one.png', type: 'image/png', src: 'indexeddb://one' },
        { id: 'upload-two', name: 'two.png', type: 'image/png', src: 'indexeddb://two' },
      ],
    }),
  }];
  const workflow = createWorkflow(messages);
  const selectedId = imageReferences.makeImageItemId(uploadedReferenceId, 2);
  const attachments = await workflow.getPreviousImageAttachments('s1', null, uploadedReferenceId, [selectedId]);

  assert.strictEqual(attachments.length, 1);
  assert.strictEqual(attachments[0].imageId, selectedId);
  assert.strictEqual(attachments[0].referenceId, uploadedReferenceId);
  assert.strictEqual(attachments[0].dataUrl, 'indexeddb://two');
}


function testModelSelectedIndependentTargetsEnterMultiImagePlanningWithoutMissingImageClarification() {
  const labels = ['助理', '总控', '老板', '前端'];
  const messages = [
    { role: 'user', content: '第一张图什么颜色' },
    {
      role: 'assistant',
      content: '[图片生成完成] 第一张图什么颜色',
      rawText: '[图片生成完成] 第一张图什么颜色',
      displayItemId: 'color-result',
      imageContext: JSON.stringify({
        referenceId: 'color-result',
        prompt: '第一张图什么颜色',
        mode: 'image',
        attachments: labels.map((label, index) => ({
          id: `color-${index + 1}`,
          imageId: `color-${index + 1}`,
          src: `indexeddb://color-${index + 1}`,
          name: `${label}.png`,
          type: 'image/png',
          description: label,
          semantic_text: label,
        })),
      }),
    },
  ];
  const context = routeContext.buildRouteContext({ messages });
  const input = '把上一条消息中的第一张和最后一张图片，分别做成长通风格';
  const inspected = routeService.inspectModelRouteResult(JSON.stringify({
    operation: 'edit_image',
    relation: 'followup',
    goal: '分别将第一张图片和最后一张图片转换为卡通风格，保留各自原有的主体、构图、姿态、背景和主要色彩不变，仅进行卡通化处理。',
    task_shape: 'multi',
    resource_refs: [
      { candidate_key: 'i1', role: 'target' },
      { candidate_key: 'i4', role: 'target' },
    ],
  }), { input, attachments: [], context });

  assert.strictEqual(inspected.reason, '');
  assert.ok(inspected.route);
  assert.strictEqual(inspected.route.needClarification, false);
  assert.strictEqual(inspected.route.readiness, 'ready');
  assert.strictEqual(inspected.route.operationType, 'edit_image');
  assert.strictEqual(routeService.shouldRequestImagePlan(inspected.route), true);
  assert.deepStrictEqual(inspected.route.selectedImageIndexes, [1, 4]);
}


function multiImageCandidateContext(count = 5, messageIndex = 10) {
  return {
    image_candidates: Array.from({ length: count }, (_, index) => ({
      candidate_key: `i${index + 1}`,
      type: 'image',
      source: 'history',
      message_index: messageIndex,
      index: index + 1,
      id: `multi-image-${index + 1}`,
      resource_id: `res:image:multi-image-${index + 1}`,
      reference_id: 'imgref-multi',
      identity_aliases: [],
      index_aliases: [index + 1],
      label: `候选图 ${index + 1}`,
      availability: 'available',
    })),
  };
}

function testRouteCatalogKeepsDistinctSiblingImagesWithinOneReferenceGroup() {
  const referenceId = 'imgref-product-posters';
  const catalog = routeService.buildResourceCandidates([], {
    image_candidates: [
      { index: 1, source: 'history', image_id: 'poster-a', reference_id: referenceId, description: 'warm poster' },
      { index: 2, source: 'history', image_id: 'poster-b', reference_id: referenceId, description: 'cool poster' },
    ],
  });

  assert.deepStrictEqual(
    catalog.map(candidate => [candidate.candidate_key, candidate.id, candidate.index, candidate.reference_id]),
    [
      ['i1', 'poster-a', 1, referenceId],
      ['i2', 'poster-b', 2, referenceId],
    ],
    'a shared result reference is group lineage and must not collapse distinct sibling images',
  );

  const restoredAliasCatalog = routeService.buildResourceCandidates([], {
    image_candidates: [
      { index: 1, source: 'history', image_id: 'legacy-poster', reference_id: 'imgref-one-poster', availability: 'unavailable' },
      {
        index: 1, source: 'history', image_id: 'durable-poster', reference_id: 'imgref-one-poster',
        identity_aliases: ['res:image:legacy-poster', 'legacy-poster'], availability: 'available',
      },
    ],
  });
  assert.strictEqual(restoredAliasCatalog.length, 1,
    'two representations connected by an explicit resource identity alias must still deduplicate');
  assert.strictEqual(restoredAliasCatalog[0].availability, 'available');
}
function testNaturalLanguageImageSetSelectionSupportsAllAndDisjointOrdinals() {
  const context = multiImageCandidateContext();
  const cases = [
    ['全都要改成卡通风格', [1, 2, 3, 4, 5]],
    ['把第一张和第五张改成卡通风格', [1, 5]],
    ['把第一张到第五张改成卡通风格', [1, 2, 3, 4, 5]],
    ['把第2-4张改成卡通风格', [2, 3, 4]],
  ];
  for (const [input, expectedIndexes] of cases) {
    const inspected = routeService.compileLocalRoute({
      operation: 'edit_image',
      relation: 'followup',
      arguments: { prompt: input },
      bindings: [],
      constraints: [],
    }, { input, attachments: [], context });
    assert.strictEqual(inspected.needClarification, false, input);
    assert.strictEqual(inspected.taskShape, 'multi', input);
    assert.deepStrictEqual(inspected.selectedImageIndexes, expectedIndexes, input);
    assert.strictEqual(routeService.shouldRequestImagePlan(inspected), true, input);
  }
}

function testNaturalLanguageImageSetSelectionUsesLatestImageGroupInsteadOfMixedHistory() {
  const context = {
    image_candidates: [
      ...multiImageCandidateContext(3, 8).image_candidates,
      ...multiImageCandidateContext(5, 12).image_candidates.map(candidate => ({
        ...candidate,
        id: `${candidate.id}-latest`,
        resource_id: `${candidate.resource_id}-latest`,
        reference_id: 'imgref-latest',
      })),
    ],
  };
  const input = '把上一条消息中的第一张和最后一张图片改成卡通风格';
  const route = routeService.compileLocalRoute({
    operation: 'edit_image',
    relation: 'followup',
    arguments: { prompt: input },
    bindings: [],
    constraints: [],
  }, { input, attachments: [], context });
  assert.strictEqual(route.needClarification, false);
  assert.deepStrictEqual(route.selectedImageIndexes, [1, 5]);
  assert.deepStrictEqual(route.imageRefs.map(item => item.reference_id), ['imgref-latest', 'imgref-latest']);

  const allInput = '上一条消息中的图片全都要改成卡通风格';
  const allRoute = routeService.compileLocalRoute({
    operation: 'edit_image',
    relation: 'followup',
    arguments: { prompt: allInput },
    bindings: [],
    constraints: [],
  }, { input: allInput, attachments: [], context });
  assert.strictEqual(allRoute.needClarification, false);
  assert.deepStrictEqual(allRoute.selectedImageIndexes, [1, 2, 3, 4, 5]);
  assert.ok(allRoute.imageRefs.every(item => item.reference_id === 'imgref-latest'));
}

module.exports = [
  testRefreshRebuildsGeneratedImageCandidatesWithoutReferenceCache,
  testCanonicalHistoryKeepsSemanticMetadataWhenHtmlAlsoContainsImageRefs,
  testCanonicalHistoryExposesEveryCompletedImageWithStableIds,
  testStandaloneBusinessRequestIsNeverOverriddenByImageKeywordHeuristics,
  testModelSelectedHistoricalImageEditSurvivesInterveningTextReply,
  testOlderNamedImageMemoryCardCanBeSelectedByTheModel,
  testImageMemoryCardsKeepVersionRelationship,
  testModelDeclaredCompositionSelectsOnlyItsContractResources,
  testSelectedImageIdsRestoreAcrossMultipleHistoricalReferences,
  testMissingSelectedHistoricalImageFailsInsteadOfSilentlyUsingOneImage,
  testSelectedHistoricalUploadedImageRestoresByItsExactRouteId,
  testModelSelectedIndependentTargetsEnterMultiImagePlanningWithoutMissingImageClarification,
  testRouteCatalogKeepsDistinctSiblingImagesWithinOneReferenceGroup,
  testNaturalLanguageImageSetSelectionSupportsAllAndDisjointOrdinals,
  testNaturalLanguageImageSetSelectionUsesLatestImageGroupInsteadOfMixedHistory,
];
