"use strict";

const assert = require('assert');
const taskContinuity = require('../../shared/task-continuity');
const coreAttachments = require('../../client/core/attachments');
const imageGenerationService = require('../../client/services/image-generation-service');
const imageContextWorkflow = require('../../client/app/image-context-workflow');
const imageResultWorkflow = require('../../client/app/image-result-workflow');
const imageRouteContext = require('../../client/core/image-route-context');
const messageRecords = require('../../client/app/message-records');
const routeService = require('../../client/services/route-service');

function isImageFile(item = {}) {
  return String(item.type || '').startsWith('image/') || /\.(?:png|jpe?g|webp)$/i.test(String(item.name || item.filename || ''));
}

function contextWorkflow() {
  return imageContextWorkflow.createImageContextWorkflow({
    getState: () => ({ activeSessionId: 'task-state-session', sessions: [] }),
    getActiveSession: () => ({}),
    isImageFile,
    imageRefToFile: async (src, name) => ({ name, type: 'image/png', size: 1, src }),
    imageRefToDataUrl: async src => src,
    makeImageItemId: (reference, index) => `img_${reference}_${index}`,
    normalizeImageSelection: value => Array.isArray(value) ? value : [],
    normalizeSelectedImageIds: value => Array.isArray(value) ? value : [],
  });
}

function imageResultDeps() {
  let persistedCount = 0;
  return {
    extractImageResult: value => value,
    getConfig: () => ({}),
    persistImageSrc: async (_src, filename) => ({
      persistedSrc: `indexeddb://result-${++persistedCount}-${filename}`,
      displaySrc: `blob:result-${persistedCount}-${filename}`,
    }),
    settleWithin: async value => value,
    imageSrcSize: async () => ({ width: 1024, height: 768 }),
    splitPromptSubjects: () => [],
    imageCandidateLabels: () => [],
    makeImageItemId: (referenceId, ordinal) => `img_${referenceId}_${ordinal}`,
    escapeHtml: value => String(value),
    downloadAllImagesButtonHtml: () => '',
    saveLatestGeneratedImage: () => {},
  };
}

function completedResultMessage(imageContext, prompt = '') {
  return {
    id: 'task-state-session:assistant:2',
    role: 'assistant',
    content: `[图片生成完成] ${prompt}`,
    rawText: `[图片生成完成] ${prompt}`,
    responseIndex: '2',
    kind: 'image',
    imageContext: JSON.stringify(imageContext),
  };
}

function routeContextForImageResult(imageContext, prompt = '') {
  const messages = [
    { id: 'task-state-session:user:1', role: 'user', content: prompt, rawText: prompt, responseIndex: '1' },
    completedResultMessage(imageContext, prompt),
  ];
  const first = imageContext.attachments[0];
  const lastGeneratedImage = {
    resultId: imageContext.resultId,
    referenceId: imageContext.referenceId,
    src: first?.src || '',
    prompt,
    taskState: imageContext.taskState,
    taskLineage: imageContext.taskLineage,
    images: imageContext.attachments.map(item => ({ ...item })),
  };
  return imageRouteContext.buildRouteContext({
    messages,
    lastGeneratedImage,
    recentImageReferences: imageRouteContext.collectRecentImageReferences({
      messages,
      lastGeneratedImage,
      limit: 12,
    }),
    latestImageReference: {
      target: 'previous',
      usePreviousImage: true,
      count: imageContext.attachments.length,
      selection: 'all',
      reason: 'last-generated-image',
      reference_id: imageContext.referenceId,
    },
  });
}

async function testSingleImageTaskStateSurvivesGenerationStorageRefreshAndNextRoute() {
  const base = '18米×8米住宅户型，严格左右镜像，中央堂屋，底部双开主入口。';
  const firstRevision = '堂屋入口保持无遮挡，卫生间与餐厅不得相邻。';
  const taskState = taskContinuity.transitionTaskContinuity({
    goalMode: 'amend',
    goal: firstRevision,
    previousState: taskContinuity.transitionTaskContinuity({ goalMode: 'replace', goal: base }),
  });
  const resolvedGoal = taskContinuity.renderTaskContinuity(taskState);

  const requestContext = imageGenerationService.createImageContext({
    prompt: resolvedGoal,
    routePrompt: firstRevision,
    resolvedGoal,
    taskState,
    mode: 'image',
    target: 'new',
  });
  assert.deepStrictEqual(requestContext.taskState, taskState);

  const workflow = contextWorkflow();
  const appStoredRequest = workflow.normalizeImageContextForStorage(requestContext);
  const coreStoredRequest = coreAttachments.normalizeImageContextForStorage(appStoredRequest);
  assert.deepStrictEqual(coreStoredRequest.taskState, taskState);
  assert.strictEqual(coreStoredRequest.resolvedGoal, resolvedGoal);

  const rendered = await imageResultWorkflow.imageResultToHtml({
    kind: 'image',
    images: [{ src: 'data:image/png;base64,result' }],
  }, '1s', {
    resultId: 'imgres-task-state',
    prompt: resolvedGoal,
    routePrompt: firstRevision,
    resolvedGoal,
    taskState,
    sessionId: 'task-state-session',
  }, imageResultDeps());
  assert.deepStrictEqual(rendered.imageContext.taskState, taskState);
  assert.strictEqual(rendered.imageContext.taskLineage.entries.length, 1);
  assert.deepStrictEqual(rendered.imageContext.taskLineage.entries[0].task_state, taskState);

  const persisted = coreAttachments.normalizeImageContextForStorage(
    workflow.normalizeImageContextForStorage(rendered.imageContext),
  );
  const canonical = messageRecords.normalizeCanonicalMessage(completedResultMessage(persisted, resolvedGoal), {
    sessionId: 'task-state-session',
    sequence: 2,
  });
  const restored = JSON.parse(canonical.imageContext);
  assert.deepStrictEqual(restored.taskState, taskState);
  assert.deepStrictEqual(restored.taskLineage, rendered.imageContext.taskLineage);

  const context = routeContextForImageResult(restored, resolvedGoal);
  assert.deepStrictEqual(context.previous_execution.task_state, taskState);
  assert.strictEqual(context.previous_execution.resolved_goal, resolvedGoal);

  const payload = routeService.buildRoutePayload({
    model: 'route-model',
    input: '卧室1入口前移走全部家具。',
    attachments: [],
    context,
  });
  const publicInput = JSON.parse(payload.input[1].content);
  assert.deepStrictEqual(publicInput.context.previous_execution.task_state, taskState);
  assert.strictEqual(publicInput.context.previous_execution.resolved_goal, undefined);

  const next = routeService.inspectModelRouteResult(JSON.stringify({
    operation: 'text_to_image',
    relation: 'followup',
    goal: '卧室1入口前移走全部家具。',
    goal_mode: 'amend',
    resource_refs: [],
    task_shape: 'single',
  }), {
    input: '卧室1入口前移走全部家具。',
    attachments: [],
    context,
  });
  assert.ok(next.route, next.reason || next.error);
  assert.strictEqual(next.route.operationType, 'text_to_image');
  assert.strictEqual(next.route.goalMode, 'amend');
  assert.deepStrictEqual(next.route.resources, []);
  assert.strictEqual(next.route.imageTaskState.segments.length, 3);
  assert.match(next.route.executionPrompt, /18米×8米住宅户型/);
  assert.match(next.route.executionPrompt, /堂屋入口保持无遮挡/);
  assert.match(next.route.executionPrompt, /卧室1入口前移走全部家具/);
}

async function testHeterogeneousBatchKeepsChildTaskStatesWithoutInventingOnePreviousTask() {
  const dayState = taskContinuity.transitionTaskContinuity({ goalMode: 'replace', goal: '生成日间自然光户型材质方案。' });
  const nightState = taskContinuity.transitionTaskContinuity({ goalMode: 'replace', goal: '生成夜间暖光户型材质方案。' });
  const deps = imageResultDeps();
  const day = await imageResultWorkflow.imageResultToHtml({ kind: 'image', images: [{ src: 'data:image/png;base64,day' }] }, '', {
    resultId: 'imgres-day', prompt: '日间方案', resolvedGoal: '生成日间自然光户型材质方案。', taskState: dayState,
  }, deps);
  const night = await imageResultWorkflow.imageResultToHtml({ kind: 'image', images: [{ src: 'data:image/png;base64,night' }] }, '', {
    resultId: 'imgres-night', prompt: '夜间方案', resolvedGoal: '生成夜间暖光户型材质方案。', taskState: nightState,
  }, deps);

  const merged = imageResultWorkflow.mergeImageResultContexts(day.imageContext, night.imageContext);
  assert.strictEqual(merged.taskLineage.entries.length, 2);
  assert.strictEqual(Object.hasOwn(merged, 'taskState'), false);
  assert.strictEqual(merged.resolvedGoal, '');
  assert.deepStrictEqual(
    taskContinuity.taskContinuityFromImageTaskLineage(merged.taskLineage, { referenceId: day.imageContext.referenceId }),
    dayState,
  );
  assert.deepStrictEqual(
    taskContinuity.taskContinuityFromImageTaskLineage(merged.taskLineage, { imageId: night.imageContext.attachments[0].imageId }),
    nightState,
  );

  const persisted = coreAttachments.normalizeImageContextForStorage(
    contextWorkflow().normalizeImageContextForStorage(merged),
  );
  assert.strictEqual(persisted.taskLineage.entries.length, 2);
  const context = routeContextForImageResult(persisted, '分别生成日间和夜间两张方案。');
  assert.strictEqual(context.previous_execution, null,
    'independent batch children must not collapse into the last child as one implicit previous task');
  assert.strictEqual(context.image_candidates.length >= 2, true,
    'batch images remain addressable as explicit resource candidates');
}

function testReferenceGenerationStartsReplacementStateEvenWithPriorTaskState() {
  const previousState = taskContinuity.transitionTaskContinuity({ goalMode: 'replace', goal: '旧住宅户型任务。' });
  const context = {
    previous_execution: {
      operation: 'text_to_image', family: 'generate', input: '旧住宅户型任务。',
      task_state: previousState, result_kind: 'image', result_reference_id: 'imgref-old',
    },
    recent_messages: [],
    image_candidates: [{
      index: 1, source_index: 1, source: 'current', image_id: 'img-current-ref',
      reference_id: 'imgref-current-ref', target: 'uploaded', description: '青绿山水画',
    }],
    file_candidates: [],
  };
  const candidate = routeService.buildRouteResourceCandidates({
    attachments: [{ index: 1, id: 'img-current-ref', image_id: 'img-current-ref', name: 'ref.png', type: 'image/png', is_image: true }],
    context,
    input: '参考这张图生成极简茶叶海报。',
  }).find(item => item.id === 'img-current-ref');
  const inspected = routeService.inspectModelRouteResult(JSON.stringify({
    operation: 'image_reference_gen',
    relation: 'followup',
    goal: '参考青绿山水配色生成极简茶叶包装海报。',
    goal_mode: 'replace',
    resource_refs: [{ candidate_key: candidate.candidate_key, role: 'style_reference' }],
    task_shape: 'single',
  }), {
    input: '参考这张图生成极简茶叶海报。',
    attachments: [],
    context,
  });
  assert.ok(inspected.route, inspected.reason || inspected.error);
  assert.deepStrictEqual(inspected.route.imageTaskState, {
    schema_version: 'task_continuity.v1',
    goal_mode: 'replace',
    segments: [{ kind: 'base', text: '参考青绿山水配色生成极简茶叶包装海报。' }],
  });
}

async function testCorruptTaskStateFailsAtEveryPersistenceBoundary() {
  const corrupt = { schema_version: 'task_continuity.v1', goal_mode: 'amend', segments: [] };
  assert.throws(() => imageGenerationService.createImageContext({ prompt: 'x', taskState: corrupt }),
    error => error?.code === 'TASK_CONTINUITY_INVALID');
  assert.throws(() => contextWorkflow().normalizeImageContextForStorage({ prompt: 'x', taskState: corrupt }),
    error => error?.code === 'TASK_CONTINUITY_INVALID');
  assert.throws(() => coreAttachments.normalizeImageContextForStorage({ prompt: 'x', taskState: corrupt }),
    error => error?.code === 'TASK_CONTINUITY_INVALID');
  await assert.rejects(() => imageResultWorkflow.imageResultToHtml({}, '', { taskState: corrupt }, {}),
    error => error?.code === 'TASK_CONTINUITY_INVALID');
  assert.throws(() => routeService.compileLocalRoute({
    operation: 'text_to_image',
    relation: 'new',
    arguments: { prompt: '生成一张猫图。' },
    bindings: [],
    constraints: [],
  }, {
    input: '生成一张猫图。',
    taskShape: 'single',
    goalMode: 'replace',
    imageTaskState: corrupt,
    semanticAuthority: 'route_intent.v3',
  }), error => error?.code === 'TASK_CONTINUITY_INVALID');
}

function testDynamicRouteSchemaExposesAmendOnlyWhenTaskStateExists() {
  const withoutState = routeService.buildRoutePayload({
    model: 'route-model', input: '生成一张猫图。', attachments: [], context: {},
  });
  assert.deepStrictEqual(withoutState.text.format.schema.properties.goal_mode.enum, ['replace']);

  const taskState = taskContinuity.transitionTaskContinuity({ goalMode: 'replace', goal: '生成一张猫图。' });
  const withState = routeService.buildRoutePayload({
    model: 'route-model',
    input: '把背景改成蓝色。',
    attachments: [],
    context: { previous_execution: { task_state: taskState } },
  });
  assert.deepStrictEqual(withState.text.format.schema.properties.goal_mode.enum, ['replace', 'amend']);

  assert.throws(() => routeService.buildRoutePayload({
    model: 'route-model',
    input: '继续修改。',
    attachments: [],
    context: { previous_execution: { task_state: { schema_version: 'task_continuity.v1', goal_mode: 'amend', segments: [] } } },
  }), error => error?.code === 'TASK_CONTINUITY_INVALID');
}

module.exports = [
  testSingleImageTaskStateSurvivesGenerationStorageRefreshAndNextRoute,
  testHeterogeneousBatchKeepsChildTaskStatesWithoutInventingOnePreviousTask,
  testReferenceGenerationStartsReplacementStateEvenWithPriorTaskState,
  testCorruptTaskStateFailsAtEveryPersistenceBoundary,
  testDynamicRouteSchemaExposesAmendOnlyWhenTaskStateExists,
];
