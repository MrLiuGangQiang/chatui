const assert = require('assert');
const fs = require('fs');
const path = require('path');
const { JSDOM } = require('jsdom');

const fileNames = require('../../shared/file-names');
const fileActions = require('../../client/ui/file-actions');
const routeContext = require('../../client/core/image-route-context');
const intentContract = require('../../client/core/intent-contract');
const preflightGuards = require('../../client/core/preflight-guards');
const httpCore = require('../../client/core/http');
const routeService = require('../../client/services/route-service');
const promptComposer = require('../../client/services/prompt-composer-service');
const imageGeneration = require('../../client/services/image-generation-service');
const imageService = require('../../client/services/image-service');
const imageResultWorkflow = require('../../client/app/image-result-workflow');
const imageJobs = require('../../server/jobs/image');
const imageEditPayloadService = require('../../server/services/image-edit-payload.service');
const serverConfig = require('../../server/config');
const clarificationService = require('../../client/services/clarification-service');
const sessionPersistence = require('../../client/app/session-persistence');
const chatWorkflow = require('../../client/app/chat-workflow');
const imageContextWorkflow = require('../../client/app/image-context-workflow');
const messageModel = require('../../client/features/messages/message-model');
const messageWorkflow = require('../../client/app/message-workflow');
const scrollMetrics = require('../../client/ui/scroll-metrics');
const extractApi = require('../../server/extract');
const officeExtract = require('../../server/extract/office');
const responsesStream = require('../../server/proxy/responses-stream');
const appState = require('../../client/app/state');
const appContext = require('../../client/app/app-context');
const sessionDisplay = require('../../client/app/session-display');
const messageRecords = require('../../client/app/message-records');
const sessionStore = require('../../client/app/session-store');
const displayHistoryWorkflow = require('../../client/app/display-history-workflow');
const formatting = require('../../client/app/formatting');
const routeDiagramWorkflow = require('../../client/app/route-diagram-workflow');
const markdownEngine = require('../../client/app/markdown/markdown-engine');
const markdownSourceNormalizer = require('../../client/app/markdown/source-normalizer');
const sourceAssertions = require('../../client/testing/source-assertions');
const usageTests = require('../unit/usage.test');
const serverHardeningTests = require('../unit/server-hardening.test');
const staticBundleTests = require('../unit/static-bundle.test');
const projectToolingTests = require('../unit/project-tooling.test');
const sessionJobRecoveryTests = require('../unit/session-job-recovery.test');
const sessionJobResumeReconciliationTests = require('../unit/session-job-resume-reconciliation.test');
const staticHttp = require('../../server/http/static');
const apiContractTests = require('../unit/api-contract.test');
const jobRouteTests = require('../unit/job-routes.test');
const chatStreamParserTests = require('../unit/chat-stream-parser.test');
const chatStreamFallbackTests = require('../unit/chat-stream-fallback.test');
const sessionSnapshotFormatTests = require('../unit/session-snapshot-format.test');
const sessionStoreRecoveryTests = require('../unit/session-store-recovery.test');
const imageJobContractTests = require('../unit/image-job-contract.test');
const imageEditPayloadContractTests = require('../unit/image-edit-payload-contract.test');
const imageServiceContractTests = require('../unit/image-service-contract.test');
const imageSessionSwitchMediaTests = require('../unit/image-session-switch-media.test');
const clientContractTests = require('../unit/client-contract.test');
const submitWorkflowHelperTests = require('../unit/submit-workflow-helpers.test');
const webPreviewTests = require('../unit/web-preview.test');
const reasoningWorkflowTests = require('../unit/reasoning-workflow.test');
const reasoningHistoryPersistenceTests = require('../unit/reasoning-history-persistence.test');
const routeRecognitionSubmitTests = require('../unit/route-recognition-submit.test');
const routeModelFollowSessionTests = require('../unit/route-model-follow-session.test');
const taskContextBoundaryTests = require('../unit/task-context-boundary.test');
const sessionRouteSwitchContinuityTests = require('../unit/session-route-switch-continuity.test');
const durableTaskLifecycleTests = require('../unit/durable-task-lifecycle.test');
const taskLifecycleStateMachineTests = require('../unit/task-lifecycle-state-machine.test');
const taskLifecycleTests = require('../unit/task-lifecycle.test');
const multiImageReferenceRoutingTests = require('../unit/multi-image-reference-routing.test');
const contentRegionDialogLayoutTests = require('../unit/content-region-dialog-layout.test');
const regenerateWorkflowTests = require('../unit/regenerate-workflow.test');
const taskStateTests = require('../unit/task-state.test');
const doneSoundTests = require('../unit/done-sound.test');
const messageOrderPersistenceTests = require('../unit/message-order-persistence.test');
const messageSizeGuardTests = require('../unit/message-size-guard.test');
const messageQuoteLayoutTests = require('../unit/message-quote-layout.test');
const promptImeSubmitGuardTests = require('../unit/prompt-ime-submit-guard.test');
const serverSmokeTests = require('../smoke/server-smoke.test');
const multiImageComposeFlowSmokeTests = require('../smoke/multi-image-compose-flow.test');

function stripLargeDataUrlsFromText(text = '') {
  return String(text || '').replace(/data:[^\s"'<>`]+;base64,[A-Za-z0-9+/=\r\n]+/g, '[image-data-omitted]');
}


function taskContractFixture({
  intent = 'chat',
  taskType = 'new_task',
  operation = 'plain_chat',
  resources = [],
  currentIntent = '',
  contextToPreserve = '',
  constraints = [],
  doNotAdd = [],
  finalInstruction = currentIntent,
  directive = null,
  clarification = null,
  confidence = 0.9,
  needsReview = false,
  reason = '',
} = {}) {
  const relation = taskType === 'new_task' ? 'new' : taskType;
  const patchRequired = intent !== 'clarify' && (relation !== 'new' || intent === 'image.edit' || operation === 'image_reference_gen');
  const sourceResources = resources.length ? resources : intent === 'clarify' ? [{ type: 'image', source: relation === 'new' ? 'current' : 'context', role: 'target', index: 1, missing: true }] : patchRequired ? [{
    type: intent === 'file.qa' ? 'file' : intent === 'chat' ? 'message' : 'image',
    source: 'history',
    role: intent === 'image.edit' ? 'target' : intent === 'file.qa' ? 'attachment' : 'reference',
    index: 1,
  }] : resources;
  const normalizedResources = sourceResources.map((resource, index) => ({
    key: `r${index + 1}`,
    type: resource.type || 'text',
    source: resource.source || 'current',
    role: resource.role || 'source',
    index: Number(resource.index) || index + 1,
    id: resource.id || '',
    reference_id: resource.reference_id || '',
    missing: resource.missing === true,
  }));
  const rawClarification = clarification || { needed: intent === 'clarify', question: intent === 'clarify' ? '请补充缺失的任务信息。' : '', missing_resource_keys: [] };
  const declaredMissingKeys = Array.isArray(rawClarification.missing_resource_keys) ? rawClarification.missing_resource_keys : [];
  const missingKeys = declaredMissingKeys.length ? declaredMissingKeys : normalizedResources.filter(resource => resource.missing).map(resource => resource.key);
  const defaultOperations = patchRequired ? [
    ...(contextToPreserve ? [{ op: 'preserve', target: contextToPreserve, value: '' }] : []),
    ...(finalInstruction ? [{ op: 'add', target: '当前请求', value: finalInstruction }] : []),
    ...doNotAdd.map(target => ({ op: 'remove', target, value: '' })),
  ] : [];
  return {
    schema_version: 'task_contract.v3',
    operation,
    relation,
    resources: normalizedResources,
    directive: directive || {
      mode: patchRequired ? 'patch' : 'standalone',
      base_resource_keys: patchRequired ? normalizedResources.filter(resource => !resource.missing).map(resource => resource.key) : [],
      unmentioned_policy: patchRequired ? 'preserve' : 'allow_change',
      operations: defaultOperations,
      constraints,
    },
    clarification: { question: rawClarification.question || '', missing_resource_keys: missingKeys },
    confidence,
    review_reasons: needsReview ? [reason || '需要复审'] : [],
    rationale: reason,
  };
}

function testHttpNormalizeUpstreamErrors() {
  assert.strictEqual(
    httpCore.normalizeError(null, { raw: 'failed to apply raw request middlewares: skip candidate by circuit breaker' }),
    '上游接口暂时不可用：请求被上游熔断或候选通道跳过，请稍后重试或检查 Endpoint 服务状态'
  );
  assert.strictEqual(
    httpCore.normalizeError(null, { error: { message: 'The image data you provided does not represent a valid image. Please check your input and try again.' } }),
    '图片数据无效：请重新上传有效的 PNG/JPG 图片后再试'
  );
}

function testPreflightGuardsOnlyHandleDeterministicConditions() {
  const baseConfig = { baseUrl: 'https://api.example.com/v1', chatModel: 'gpt-5.5', imageModel: 'gpt-image-2', apiKey: 'ok' };
  assert.strictEqual(preflightGuards.buildPreflightDecision({ input: '', attachments: [], config: baseConfig })?.code, 'missing_input');
  assert.strictEqual(preflightGuards.buildPreflightDecision({ input: '解释 HTTP 304', config: { ...baseConfig, baseUrl: '' } })?.code, 'missing_base_url');
  assert.strictEqual(preflightGuards.buildPreflightDecision({ input: '解释 HTTP 304', config: { ...baseConfig, chatModel: '', routeModel: '' } })?.code, 'missing_route_model');
  assert.strictEqual(preflightGuards.buildPreflightDecision({ input: '继续', config: baseConfig }), null);
  assert.strictEqual(preflightGuards.buildPreflightDecision({ input: '总结这个文件', config: baseConfig }), null);
  assert.strictEqual(preflightGuards.buildPreflightDecision({ input: '帮我盗取别人的账号密码', config: baseConfig }), null);
  assert.strictEqual(preflightGuards.buildPreflightDecision({ input: '画一只猫', config: baseConfig }), null);
  assert.strictEqual(preflightGuards.buildPreflightDecision({ input: '写海报文案，不要生成图片', config: baseConfig }), null);
  assert.strictEqual(preflightGuards.buildPreflightDecision({ input: '极简蓝色', config: baseConfig }), null);
  assert.deepStrictEqual(preflightGuards.attachmentCounts([{ type: 'image/png' }, { type: 'text/plain' }]), { imageCount: 1, fileCount: 1 });
}

function testRouteKeepsSingleHistoryImageEditableForDeicticEdit() {
  const context = { image_candidates: [{ index: 1, source: 'history', target: 'previous', reference_id: 'imgref_latest', image_id: 'img_1' }] };
  const parsed = routeService.parseRouteResult(JSON.stringify(taskContractFixture({
    intent: 'image.edit',
    taskType: 'followup',
    operation: 'edit_image',
    resources: [{ type: 'image', source: 'history', role: 'target', index: 1, id: 'img_1', reference_id: 'imgref_latest' }],
    currentIntent: '把这张图改成红色背景',
    finalInstruction: '把背景改成红色',
    confidence: 0.93,
    reason: '单一历史图片可作为“这张图”的编辑目标',
  })), { input: '把这张图改成红色背景', attachments: [], context });
  assert.strictEqual(parsed.mode, 'edit_image');
  assert.strictEqual(parsed.usePreviousImage, true);
  assert.strictEqual(parsed.target, 'previous');
  assert.strictEqual(parsed.needClarification, false);
}

function testRouteClarifiesDeicticEditOnlyWithoutAnyImageCandidate() {
  const parsed = routeService.parseRouteResult(JSON.stringify(taskContractFixture({
    intent: 'clarify',
    taskType: 'followup',
    operation: 'clarify',
    currentIntent: '把这张图改成红色背景',
    finalInstruction: '',
    clarification: { needed: true, question: '请先上传图片，或说明要处理哪一张历史图片。', missing_resources: ['image target'] },
    confidence: 0.7,
    reason: '缺少可编辑图片',
  })), { input: '把这张图改成红色背景', attachments: [], context: {} });
  assert.strictEqual(parsed.mode, 'chat');
  assert.strictEqual(parsed.needClarification, true);
  assert.ok(parsed.clarificationQuestion.includes('请先上传图片'));
}

function testIntentContractStrictlyBuildsOneExecutionPlan() {
  const task = taskContractFixture({
    intent: 'image.generate',
    taskType: 'new_task',
    operation: 'text_to_image',
    currentIntent: '生成一张猫图',
    finalInstruction: '生成一张猫图',
    confidence: 0.91,
    reason: '视觉产物生成',
  });
  assert.strictEqual(intentContract.hasExactContractShape(task), true);
  const plan = intentContract.taskContractToExecutionPlan(task, { input: '生成一张猫图' });
  assert.strictEqual(plan.mode, 'image');
  assert.strictEqual(plan.operationType, 'text_to_image');
  assert.strictEqual(plan.relation, 'new');
  assert.strictEqual(plan.contextualImagePrompt, '生成一张猫图');
  assert.ok(!('taskType' in plan));
  assert.ok(!('operation' in plan));

  const edit = taskContractFixture({
    intent: 'image.edit',
    taskType: 'followup',
    operation: 'edit_image',
    resources: [{ type: 'image', source: 'history', role: 'target', index: 1 }],
    currentIntent: '把背景换成白色',
    finalInstruction: '把背景换成白色',
  });
  const editPlan = intentContract.taskContractToExecutionPlan(edit, { input: '把背景换成白色' });
  assert.strictEqual(editPlan.mode, 'edit_image');
  assert.strictEqual(editPlan.operationType, 'edit_image');
  assert.deepStrictEqual(editPlan.selectedIndexes, [1]);
  assert.strictEqual(editPlan.usePreviousImage, true);

  const compare = taskContractFixture({
    intent: 'vision_qa',
    taskType: 'followup',
    operation: 'image_compare',
    resources: [{ type: 'image', source: 'history', role: 'compare_a', index: 1 }, { type: 'image', source: 'current', role: 'compare_b', index: 1 }],
    currentIntent: '比较差异',
    finalInstruction: '比较差异',
  });
  const comparePlan = intentContract.taskContractToExecutionPlan(compare, { input: '比较差异' });
  assert.strictEqual(comparePlan.operationType, 'image_compare');
  assert.ok(comparePlan.imageRefs.some(item => item.source === 'history' && item.role === 'compare_a'));
  assert.ok(comparePlan.imageRefs.some(item => item.source === 'current' && item.role === 'compare_b'));
}

function testPromptComposerPreservesIntentWithoutOverOptimizing() {
  const context = { last_generated_image: { prompt: '生成一个可打印、可涂色、可裁剪组装的二年级学科骰子模板' } };
  const task = taskContractFixture({
    intent: 'image.generate',
    taskType: 'correction',
    operation: 'text_to_image',
    currentIntent: '正方体怎么都7个面了？',
    constraints: ['正方体只能有 6 个面'],
    doNotAdd: ['不要新增用户未要求的风格、对象、背景、文字或构图。'],
    finalInstruction: '重新生成并修正面数错误',
  });
  const prompt = promptComposer.composeImageGeneratePrompt(task, context, '正方体怎么都7个面了？');
  assert.ok(prompt.includes('骰子模板'));
  assert.ok(prompt.includes('正方体怎么都7个面了'));
  assert.ok(prompt.includes('正方体只能有 6 个面'));
  assert.ok(prompt.includes('不要新增用户未要求'));
  assert.ok(!/电影感|超现实|8k|赛博朋克/i.test(prompt), 'composer must not add unrelated style polish');
}

function testRouteResultCarriesTaskContractAndComposedPrompt() {
  const context = { last_generated_image: { prompt: '生成一个可打印骰子展开图' } };
  const parsed = routeService.parseRouteResult(JSON.stringify(taskContractFixture({
    intent: 'image.generate',
    taskType: 'correction',
    operation: 'text_to_image',
    currentIntent: '正方体怎么都7个面了？',
    contextToPreserve: '生成一个可打印骰子展开图',
    finalInstruction: '重新生成，修正正方体面数错误',
    confidence: 0.92,
    reason: '上一张图结构错误，需重做',
  })), { input: '正方体怎么都7个面了？', attachments: [], context });
  assert.strictEqual(parsed.mode, 'image');
  assert.strictEqual(parsed.taskContract.operation, 'text_to_image');
  assert.strictEqual(parsed.api, 'image_generation');
  assert.ok(parsed.contextualImagePrompt.includes('生成一个可打印骰子展开图'));
  assert.ok(parsed.contextualImagePrompt.includes('正方体怎么都7个面了'));
  assert.ok(!/电影感|超现实|8k|赛博朋克/i.test(parsed.contextualImagePrompt), 'route prompt must not add unrelated style polish');
}

function testRouteInstructionDoesNotPolluteImagePrompt() {
  const context = { last_generated_image: { prompt: '做一个可打印、可涂色、可裁剪组装的二年级学科骰子展开图模板' } };
  const parsed = routeService.parseRouteResult(JSON.stringify(taskContractFixture({
    intent: 'image.generate',
    taskType: 'correction',
    operation: 'text_to_image',
    currentIntent: '还是不对，面数错了',
    contextToPreserve: '做一个可打印、可涂色、可裁剪组装的二年级学科骰子展开图模板',
    finalInstruction: '还是不对，面数错了',
    confidence: 0.96,
    reason: '上一张图面数错误，需要重做',
  })), { input: '还是不对，面数错了', attachments: [], context });
  assert.strictEqual(parsed.mode, 'image');
  assert.strictEqual(parsed.api, 'image_generation');
  assert.ok(parsed.contextualImagePrompt.includes('骰子展开图模板'));
  assert.ok(parsed.contextualImagePrompt.includes('还是不对，面数错了'));
  assert.ok(!parsed.contextualImagePrompt.includes('粘贴边'), 'route model invented construction detail must not enter final image prompt');
  assert.ok(!/3D|高清|电影感/i.test(parsed.contextualImagePrompt), 'route model invented style detail must not enter final image prompt');
}

function testRouteContextUsesTokenWindowAndDropsOldestMessages() {
  const messages = [
    { role: 'user', content: 'oldest-' + '甲'.repeat(120) },
    { role: 'assistant', content: 'middle-' + '乙'.repeat(120) },
    { role: 'user', content: 'latest-' + '丙'.repeat(30) },
  ];
  const full = routeContext.buildRouteContext({ messages, contextWindowTokens: 10000 });
  assert.strictEqual(full.recent_messages.length, 3, 'history below the token window must be retained');
  const trimmed = routeContext.buildRouteContext({ messages, contextWindowTokens: 220 });
  assert.ok(trimmed.recent_messages.length < 3, 'history above the token window must be trimmed');
  assert.ok(!trimmed.recent_messages.some(item => String(item.content).startsWith('oldest-')), 'the oldest route message must be discarded first');
  assert.ok(trimmed.recent_messages.some(item => String(item.content).startsWith('latest-')), 'the latest user message must be retained');
}

function testRouteContextIsCompactAndIndexed() {
  const imageContext = JSON.stringify({
    target: 'uploaded',
    mode: 'edit_image',
    updatedAt: 1781176791027,
    attachments: [{ id: 'att_logo', name: 'logo.png', type: 'image/png', size: 51586, src: 'indexeddb://logo' }],
  });
  const attachmentContext = JSON.stringify({
    prompt: '提取文字',
    content: '提取文字\n\n[image id=att_logo name=logo.png type=image/png size=51586]',
    attachments: [{ id: 'att_logo', name: 'logo.png', type: 'image/png', size: 51586, src: 'indexeddb://logo' }],
  });
  const messages = [{ role: 'user', content: '提取文字\n\n[image id=att_logo name=logo.png type=image/png size=51586]', rawText: '提取文字', imageContext, attachmentContext }];
  const ctx = routeContext.buildRouteContext({
    messages,
    latestUploadedImage: { prompt: '提取文字', count: 1, target: 'uploaded', updatedAt: 1781176791027 },
    latestImageReference: { target: 'uploaded', usePreviousImage: false, count: 1, selection: 'all', reason: 'latest-uploaded-image' },
    recentImageReferences: [],
    maxChars: 262144,
  });
  assert.strictEqual(ctx.image_candidates.length, 1);
  assert.deepStrictEqual(ctx.recent_image_references, []);
  assert.deepStrictEqual(ctx.recent_uploaded_image_references, []);
  assert.ok(!JSON.stringify(ctx).includes('data:image'));
  assert.ok(!JSON.stringify(ctx).includes('base64'));

  const payload = routeService.buildRoutePayload({
    model: 'deepseek-v4-pro',
    input: '提取文字',
    attachments: [{ name: 'logo.png', type: 'image/png', size: 51586, is_image: true }],
    context: ctx,
    currentMode: 'chat',
    autoMode: true,
  });
  const body = payload.messages[1].content;
  assert.strictEqual((body.match(/"candidates"/g) || []).length, 0);
  assert.strictEqual((body.match(/"image_candidates"/g) || []).length, 1);
  const parsedRouteUser = JSON.parse(body);
  assert.ok(!(parsedRouteUser.context?.recent_messages || []).some(item => item.role === 'user' && String(item.content || '').startsWith('提取文字')), 'route payload should not duplicate current_input in recent_messages');
  assert.ok(body.length < 1600, `route body too large: ${body.length}`);
  assert.ok(payload.messages[0].content.includes('"schema_version":"task_contract.v3"'));
  assert.ok(payload.messages[0].content.includes('"resources"'));
  assert.ok(payload.messages[0].content.includes('"directive"'));
  assert.ok(payload.messages[0].content.includes('"operations"'));
  const payloadJson = JSON.stringify(payload);
  assert.ok(!/(reasoning|thinking|reasoning_effort|enable_thinking|thinking_budget|thinkingConfig)/i.test(payloadJson), 'route recognition payload should not send thinking/reasoning params');
  const minimalPayload = routeService.buildRoutePayload({ model: 'deepseek-v4-pro', input: '解释一下 JavaScript 里的 Promise 是什么。', attachments: [], context: {}, currentMode: 'chat', autoMode: true });
  assert.strictEqual(minimalPayload.messages[1].content, JSON.stringify({ current_input: '解释一下 JavaScript 里的 Promise 是什么。' }));
  assert.ok(minimalPayload.messages[0].content.length < 4000, `route system prompt too large: ${minimalPayload.messages[0].content.length}`);
}

function testImageCandidatesUseGlobalIndexesAndExecuteSourceIndexes() {
  const context = routeContext.buildRouteContext({
    messages: [],
    recentImageReferences: [
      {
        reference_id: 'imgref_latest',
        target: 'previous',
        source: 'history',
        prompt: '一张狗的图片',
        count: 1,
        candidates: [{ index: 1, image_id: 'img_imgref_latest_1', filename: 'dog.png', prompt: '一张狗的图片', labels: ['dog'] }],
      },
      {
        reference_id: 'imgref_cat_card',
        target: 'previous',
        source: 'history',
        prompt: '一张猫的图片',
        count: 1,
        candidates: [{ index: 1, image_id: 'img_imgref_cat_card_1', filename: 'cat.png', prompt: '一张猫的图片', labels: ['cat'] }],
      },
    ],
    latestImageReference: { reference_id: 'imgref_latest', target: 'previous' },
  });
  assert.deepStrictEqual(context.image_candidates.map(item => item.index), [1, 2], 'route-visible candidate indexes must be unique across history');
  assert.deepStrictEqual(context.image_candidates.map(item => item.source_index), [1, 1], 'execution source indexes must preserve per-reference image positions');

  const editCat = routeService.parseRouteResult(JSON.stringify(taskContractFixture({
    intent: 'image.edit',
    taskType: 'followup',
    operation: 'edit_image',
    resources: [{ type: 'image', source: 'history', role: 'target', index: 2, id: 'img_imgref_cat_card_1', reference_id: 'imgref_cat_card' }],
    currentIntent: '我要修改猫的图片',
    finalInstruction: '修改猫的图片',
    confidence: 0.94,
    reason: '用户指定猫图，匹配 image_candidates 中的 cat 候选',
  })), { input: '我要修改猫的图片', attachments: [], context });
  assert.strictEqual(editCat.mode, 'edit_image');
  assert.strictEqual(editCat.selectedReferenceId, 'imgref_cat_card', 'cat candidate must not fall back to latest reference');
  assert.deepStrictEqual(editCat.selectedIndexes, [1], 'execution should use the source index inside the selected reference');
  assert.deepStrictEqual(editCat.selectedImageIds, ['img_imgref_cat_card_1']);
  assert.strictEqual(editCat.imageRefs[0].reference_id, 'imgref_cat_card');
  assert.strictEqual(editCat.imageRefs[0].index, 1);
}

function testImageGenerationPayloadDoesNotRewritePromptOrAutoParams() {
  const payload = imageGeneration.buildImageRequestPayload({ model: 'gpt-image-2', prompt: '画一只猫', size: 'auto', quality: 'auto', background: 'auto', format: 'auto' });
  assert.deepStrictEqual(payload, { model: 'gpt-image-2', prompt: '画一只猫' });
}

function testImageResultParsingSupportsMultipleImages() {
  const result = imageService.extractImageResult({ data: [{ url: 'https://a/1.png' }, { b64_json: 'BBBB' }] });
  assert.strictEqual(result.kind, 'image');
  assert.strictEqual(result.images.length, 2);
}

function testImageResultRefusesNonDurablePersistence() {
  const deps = {
    extractImageResult: imageService.extractImageResult,
    getConfig: () => ({}),
    persistImageSrc: async () => ({ persistedSrc: 'data:image/png;base64,AAAA', displaySrc: 'data:image/png;base64,AAAA' }),
    settleWithin: async value => value,
    imageSrcSize: async () => ({ width: 10, height: 10 }),
    fitImageThumb: () => ({ width: 10, height: 10 }),
    splitPromptSubjects: () => [],
    imageCandidateLabels: () => [],
    makeImageItemId: (_reference, index) => `img_${index}`,
    escapeHtml: value => String(value),
    downloadAllImagesButtonHtml: () => '',
    saveLatestGeneratedImage: () => assert.fail('non-durable result must not update latest image state'),
  };
  return assert.rejects(
    () => imageResultWorkflow.imageResultToHtml({ data: [{ b64_json: 'AAAA' }] }, '1s', {}, deps),
    /本地持久化失败/
  );
}

async function testImageResultStoresOnlyDurableIndexedDbReferences() {
  let latest = null;
  const result = await imageResultWorkflow.imageResultToHtml({ data: [{ b64_json: 'AAAA' }] }, '1s', { prompt: '猫' }, {
    extractImageResult: imageService.extractImageResult,
    getConfig: () => ({}),
    persistImageSrc: async () => ({ persistedSrc: 'indexeddb://img-durable', displaySrc: 'blob:immediate' }),
    settleWithin: async value => value,
    imageSrcSize: async () => ({ width: 10, height: 10 }),
    fitImageThumb: () => ({ width: 10, height: 10 }),
    splitPromptSubjects: () => [],
    imageCandidateLabels: () => [],
    makeImageItemId: (_reference, index) => `img_${index}`,
    escapeHtml: value => String(value),
    downloadAllImagesButtonHtml: () => '',
    saveLatestGeneratedImage: (_sessionId, value) => { latest = value; },
  });
  assert.ok(result.html.includes('data-persisted-src="indexeddb://img-durable"'));
  assert.ok(!result.html.includes('data:image/png;base64,AAAA'));
  assert.strictEqual(latest.src, 'indexeddb://img-durable');
  assert.strictEqual(result.imageContext.attachments[0].src, 'indexeddb://img-durable');
}

function testDownloadFilenamesUseShanghaiTimestamp() {
  const date = new Date('2026-06-30T03:31:42Z');
  assert.strictEqual(fileNames.timestampPrefix(date), '20260630113142');
  assert.strictEqual(fileNames.timestampedFilename({ stem: '测试 报告', ext: 'md', date }), '20260630113142.md');
  assert.strictEqual(fileNames.timestampExistingFilename('generated-123.png', { date }), '20260630113142.png');
  assert.strictEqual(fileActions.answerFilename({ text: '第一行标题\n正文', date }), '20260630113142.md');

  const imageResultSource = fs.readFileSync(path.join(__dirname, '../../client/app/image-result-workflow.js'), 'utf8');
  const imageActionsSource = fs.readFileSync(path.join(__dirname, '../../client/app/image-actions-workflow.js'), 'utf8');
  const app = fs.readFileSync(path.join(__dirname, '../../app.js'), 'utf8');
  const index = fs.readFileSync(path.join(__dirname, '../../index.html'), 'utf8');
  const bundleSource = fs.readFileSync(path.join(__dirname, '../../server/services/static-bundle.service.js'), 'utf8');
  assert.ok(index.includes('./shared/file-names.js?v=1.0.1'), 'shared filename helper must load before download workflows');
  assert.ok(imageResultSource.includes('fileNames?.timestampedFilename') && imageResultSource.includes("ext: 'png'") && !imageResultSource.includes('generated-${Date.now()}'), 'generated image records should get Shanghai timestamp-only png filenames');
  assert.ok(imageActionsSource.includes('timestampExistingFilename') && imageActionsSource.includes('downloadFilename(e.dataset.filename,"generated-image","png")'), 'image download/share actions should timestamp existing generated image filenames');
  assert.ok(app.includes('window.ChatUIFileNames?.timestampedFilename') && app.includes('ext:"md"'), 'legacy app.js answer download fallback should also use Shanghai timestamped markdown filenames');
  assert.ok(index.includes('client/ui/file-actions.js?v=1.2.67') && index.includes('client/app/image-actions-workflow.js?v=1.2.68') && index.includes('client/app/image-result-workflow.js?v=1.7.1-image-semantics') && index.includes('app.js?v=2.1.48-route-model-switch-guard') && index.includes('chatui.bundle.js?v=1.3.145-resilient-snapshot-store'), 'browser cache versions should match the current static bundle');
  assert.ok(bundleSource.includes("BUNDLE_VERSION = '1.3.145-resilient-snapshot-store'"), 'server bundle version should match browser cache-busting');
}

function testPendingClarificationMergesFollowupSupplements() {
  const messages = [
    { role: 'user', rawText: '把这张图改成红色背景' },
    { role: 'assistant', rawText: '请上传要修改的图片。' },
  ];
  const pending = clarificationService.findPendingFromHistory(messages);
  assert.ok(pending, 'should find pending clarification from history');
  assert.strictEqual(pending.kind, 'image_edit');

  const merged = clarificationService.mergePendingInput(pending, {
    promptText: '',
    attachments: [{ name: 'photo.png', type: 'image/png' }],
  });
  assert.strictEqual(merged.merged, true);
  assert.ok(merged.promptText.includes('把这张图改成红色背景'));
  assert.ok(merged.promptText.includes('用户上传了 1 个附件'));

  const second = clarificationService.mergePendingInput(merged.pending, {
    promptText: '背景用深红色，保留主体',
    attachments: [],
  });
  assert.ok(second.promptText.includes('补充1'));
  assert.ok(second.promptText.includes('本轮补充：背景用深红色，保留主体'));
  assert.strictEqual(second.pending.rounds, 3);
}

function testPendingClarificationModelFinalPromptIsMinimalAndWins() {
  const pending = clarificationService.createPendingClarification({
    messages: [
      { role: 'user', rawText: '我要一个晚霞图' },
      { role: 'assistant', rawText: '[图片生成完成] 我要一个晚霞图', imageContext: JSON.stringify({ mode: 'image', target: 'previous', prompt: '我要一个晚霞图' }) },
      { role: 'user', rawText: '不满意，帮我改' },
      { role: 'assistant', rawText: '你想怎么改？' },
    ],
    clarificationText: '你想怎么改？',
    routeInfo: { mode: 'chat', intent: 'image_edit' },
  });
  assert.ok(pending);
  assert.strictEqual(pending.originalText, '我要一个晚霞图');
  assert.ok(pending.sourceImageContext, 'vague image feedback should carry previous generated image context');

  const payload = clarificationService.buildContinuationClassifierPayload({
    model: 'gpt-5.5',
    pending,
    currentInput: '山巅的',
  });
  assert.strictEqual(payload.temperature, 0);
  assert.ok(payload.messages[0].content.includes('你不是提示词优化器'));
  assert.ok(payload.messages[0].content.includes('最小语义补全'));
  assert.ok(!/高清|电影感|氛围感/.test(payload.messages[0].content), 'classifier prompt should not encourage creative embellishment');

  const decision = clarificationService.parseContinuationClassifierResult(JSON.stringify({
    relation: 'pending_answer',
    confidence: 0.97,
    answer_text: '山巅的',
    final_prompt: '山巅的晚霞图',
    final_task_mode: 'edit_image',
    selectedIndexes: [1],
    should_merge: true,
    should_clear_pending: true,
  }));
  assert.strictEqual(decision.finalPrompt, '山巅的晚霞图');
  const merged = clarificationService.mergePendingInput(pending, {
    promptText: '山巅的',
    finalPrompt: decision.finalPrompt,
    finalTaskMode: decision.finalTaskMode,
    selectedIndexes: decision.selectedIndexes,
  });
  assert.strictEqual(merged.promptText, '山巅的晚霞图');
  assert.ok(!merged.promptText.includes('本轮补充'), 'model final_prompt should prevent internal transaction text from entering image prompt');
  assert.ok(!merged.promptText.includes('突出'), 'minimal final_prompt must not add creative details');
}

function testPendingClarificationDoesNotTreatOrdinaryQuestionsAsFollowup() {
  const messages = [
    { role: 'user', rawText: '介绍一下 React useMemo' },
    { role: 'assistant', rawText: '可以，先说结论：useMemo 用来缓存计算结果。你平时主要用 React 还是 Vue？' },
  ];
  assert.strictEqual(clarificationService.isClarificationResponse(messages[1].rawText), false);
  assert.strictEqual(clarificationService.findPendingFromHistory(messages), null);
}

function testPendingClarificationCanMergeTextFileAndQuote() {
  const pending = clarificationService.createPendingClarification({
    messages: [
      { role: 'user', rawText: '总结这个文件' },
      { role: 'assistant', rawText: '请上传或引用要总结的文件。' },
    ],
    clarificationText: '请上传或引用要总结的文件。',
  });
  assert.ok(pending);
  assert.strictEqual(pending.kind, 'file_qa');
  const merged = clarificationService.mergePendingInput(pending, {
    promptText: '重点关注结论部分',
    attachments: [{ name: 'demo.txt', type: 'text/plain' }],
    quotedMessage: { role: 'user', content: '[附件消息]' },
    quoteText: '引用文件 demo.txt',
  });
  assert.ok(merged.promptText.includes('总结这个文件'));
  assert.ok(merged.promptText.includes('重点关注结论部分'));
  assert.ok(merged.promptText.includes('引用文件 demo.txt'));
}

function testPendingClarificationCarriesOriginalMultiImageContext() {
  const pending = clarificationService.createPendingClarification({
    messages: [
      { role: 'user', rawText: '把这张图改一下', attachmentContext: JSON.stringify({ attachments: [
        { id: 'img_1', name: '老板.png', type: 'image/png' },
        { id: 'img_2', name: '前端.png', type: 'image/png' },
        { id: 'img_3', name: '后端.png', type: 'image/png' },
      ] }) },
      { role: 'assistant', rawText: '您有三张上传的图片，请问您想编辑哪一张？请指定图片编号或描述。' },
    ],
    clarificationText: '您有三张上传的图片，请问您想编辑哪一张？请指定图片编号或描述。',
    sourceAttachmentContext: JSON.stringify({ attachments: [
      { id: 'img_1', name: '老板.png', type: 'image/png' },
      { id: 'img_2', name: '前端.png', type: 'image/png' },
      { id: 'img_3', name: '后端.png', type: 'image/png' },
    ] }),
  });
  assert.ok(pending);
  assert.strictEqual(pending.kind, 'image_edit');
  assert.ok(pending.sourceAttachmentContext.includes('老板.png'));
  assert.strictEqual(clarificationService.shouldApplyPending(pending, { promptText: '第一张', attachments: [] }), true);
  assert.strictEqual(clarificationService.shouldApplyPending(pending, { promptText: '今天天气怎么样', attachments: [] }), false);
  const merged = clarificationService.mergePendingInput(pending, {
    promptText: '第一张',
    attachments: [{ name: '老板.png', type: 'image/png' }, { name: '前端.png', type: 'image/png' }, { name: '后端.png', type: 'image/png' }],
  });
  assert.ok(merged.promptText.includes('把这张图改一下'));
  assert.ok(merged.promptText.includes('本轮补充：第一张'));
}

function testPendingClarificationAcceptsShortImageVariantAnswer() {
  const pending = clarificationService.createPendingClarification({
    messages: [
      { role: 'user', rawText: '窗帘的交叉轨道给我一个图片' },
      { role: 'assistant', rawText: '你想要哪一种窗帘交叉轨道图片？请补充一下具体样式或用途，比如：俯视结构图、安装示意图、实物照片风格、双轨交叉、弯轨交叉、酒店窗帘轨道等。' },
    ],
    clarificationText: '你想要哪一种窗帘交叉轨道图片？请补充一下具体样式或用途，比如：俯视结构图、安装示意图、实物照片风格、双轨交叉、弯轨交叉、酒店窗帘轨道等。',
  });
  assert.ok(pending);
  assert.ok(['image', 'image_edit'].includes(pending.kind));
  assert.strictEqual(clarificationService.shouldApplyPending(pending, { promptText: '弯轨交叉', attachments: [] }), true, 'short variant/style answer should continue the pending image generation request');
  const merged = clarificationService.mergePendingInput(pending, { promptText: '弯轨交叉', attachments: [] });
  assert.ok(merged.promptText.includes('窗帘的交叉轨道给我一个图片'));
  assert.ok(merged.promptText.includes('本轮补充：弯轨交叉'));
  assert.strictEqual(clarificationService.shouldApplyPending(pending, { promptText: '今天天气怎么样', attachments: [] }), false, 'unrelated ordinary question should not continue pending image request');
}

function testPendingClarificationStateMachineClearsNewTaskAndRecomputesMultiRound() {
  const pending = clarificationService.createPendingClarification({
    messages: [
      { role: 'user', rawText: '窗帘的交叉轨道给我一个图片' },
      { role: 'assistant', rawText: '你想要哪一种窗帘交叉轨道图片？请补充一下具体样式或用途，比如：俯视结构图、安装示意图、实物照片风格、双轨交叉、弯轨交叉、酒店窗帘轨道等。' },
    ],
    clarificationText: '你想要哪一种窗帘交叉轨道图片？请补充一下具体样式或用途，比如：俯视结构图、安装示意图、实物照片风格、双轨交叉、弯轨交叉、酒店窗帘轨道等。',
  });
  assert.ok(pending.expects.includes('image_variant'));
  assert.deepStrictEqual(clarificationService.classifyPendingTurn(pending, { promptText: '弯轨交叉', attachments: [] }).action, 'apply');
  const miss = clarificationService.classifyPendingTurn(pending, { promptText: '讲讲 useMemo', attachments: [] });
  assert.strictEqual(miss.action, 'clear', 'clear stale pending state when the next turn is clearly a new task');

  const firstAnswer = clarificationService.mergePendingInput(pending, { promptText: '弯轨交叉', attachments: [] });
  const nextQuestion = '弯轨交叉要做成什么风格？';
  const nextPending = {
    ...firstAnswer.pending,
    clarificationText: nextQuestion,
    expects: clarificationService.expectedAnswerTypes({ ...firstAnswer.pending, clarificationText: nextQuestion }),
  };
  assert.ok(nextPending.expects.includes('edit_detail'), 'new clarification question should recompute expected answer type for multi-round follow-up');
  assert.strictEqual(clarificationService.classifyPendingTurn(nextPending, { promptText: '实物照片风格', attachments: [] }).action, 'apply');
}

function testPendingClarificationUsesPreviousImageRequestForVagueFeedback() {
  const pending = clarificationService.createPendingClarification({
    messages: [
      { role: 'user', rawText: '窗帘的交叉轨道给我一个图片' },
      { role: 'assistant', rawText: '[图片生成完成] 生成一张清晰的窗帘交叉轨道示意图。' },
      { role: 'user', rawText: '不是这个啊' },
      { role: 'assistant', rawText: '你想要的是哪种窗帘交叉轨道图片？可以描述一下你要的样式，例如：实物产品图、安装结构图、顶装/侧装、双轨交叉、弯轨交叉，或发一张参考图。' },
    ],
    clarificationText: '你想要的是哪种窗帘交叉轨道图片？可以描述一下你要的样式，例如：实物产品图、安装结构图、顶装/侧装、双轨交叉、弯轨交叉，或发一张参考图。',
    routeInfo: { mode: 'chat', intent: 'image_edit' },
  });
  assert.ok(pending);
  assert.strictEqual(pending.originalText, '窗帘的交叉轨道给我一个图片', 'vague negative feedback should preserve the previous image request as pending origin');
  assert.strictEqual(clarificationService.classifyPendingTurn(pending, { promptText: '弯轨交叉', quotedMessage: { role: 'user', content: '不是这个啊' }, attachments: [] }).action, 'apply');
  const merged = clarificationService.mergePendingInput(pending, { promptText: '弯轨交叉', quotedMessage: { role: 'user', content: '不是这个啊' }, quoteText: '不是这个啊' });
  assert.ok(merged.promptText.includes('窗帘的交叉轨道给我一个图片'));
  assert.ok(merged.promptText.includes('本轮补充：弯轨交叉'));
  assert.ok(!merged.promptText.startsWith('不是这个啊'), 'merged prompt should not degrade to the vague feedback text');
}

function testPendingClarificationClearsAfterMergedSend() {
  const submit = fs.readFileSync(path.join(__dirname, '../../client/app/submit-workflow.js'), 'utf8');
  assert.ok(!submit.includes('targetSession.pendingClarification=pendingMerge.pending'), 'merged clarification should not stay pending after the answer has been sent');
  assert.ok(submit.includes('if(pendingMerge?.merged&&targetSession.pendingClarification){delete targetSession.pendingClarification'), 'merged clarification should be cleared immediately after routing succeeds');
  assert.ok(!submit.includes('findPendingFromHistory?.(targetSession.messages||state.messages||[])'), 'pending clarification must be an explicit one-shot state, not inferred repeatedly from history');
  assert.ok(submit.includes('const storedPending=clarification.normalizePendingClarification?.(targetSession.pendingClarification)||null'), 'pending clarification should only come from explicit session state');
  assert.ok(submit.includes('if(storedPending&&targetSession.pendingClarification){delete targetSession.pendingClarification'), 'pending clarification state should be consumed/cleared as soon as the next message is submitted');
  const index = fs.readFileSync(path.join(__dirname, '../../index.html'), 'utf8');
  assert.ok(index.includes('submit-workflow.js?v=1.2.89-session-model-routing'), 'submit workflow cache version should be bumped for pending clarification fix');
  assert.ok(index.includes('clarification-service.js?v=1.0.5'), 'clarification service cache version should be bumped for pending state machine fix');
  assert.ok(submit.includes('expects:clarification.expectedAnswerTypes?.({...pendingMerge.pending,clarificationText:e})'), 'multi-round clarification should recompute expected answer type from the new question');
}

function testPendingClarificationOneShotMissAndMultiRoundContinuity() {
  const pending = clarificationService.createPendingClarification({
    messages: [
      { role: 'user', rawText: '把这几张图改成头像' },
      { role: 'assistant', rawText: '请明确要处理第几张图片。' },
    ],
    clarificationText: '请明确要处理第几张图片。',
  });
  assert.ok(pending);
  assert.strictEqual(clarificationService.shouldApplyPending(pending, { promptText: '讲讲 useMemo', attachments: [] }), false, 'unrelated next turn should not be treated as a follow-up answer');

  const firstAnswer = clarificationService.mergePendingInput(pending, {
    promptText: '第一张',
    attachments: [],
  });
  assert.ok(firstAnswer.merged);
  assert.ok(firstAnswer.promptText.includes('把这几张图改成头像'));
  assert.ok(firstAnswer.promptText.includes('本轮补充：第一张'));

  const nextPending = {
    ...firstAnswer.pending,
    clarificationText: '第一张要改成什么风格？',
  };
  const secondAnswer = clarificationService.mergePendingInput(nextPending, {
    promptText: '改成漫画风，保留脸部特征',
    attachments: [],
  });
  assert.ok(secondAnswer.merged, 'a new explicit pending clarification should continue the multi-round chain');
  assert.ok(secondAnswer.promptText.includes('把这几张图改成头像'));
  assert.ok(secondAnswer.promptText.includes('补充1：第一张'));
  assert.ok(secondAnswer.promptText.includes('本轮补充：改成漫画风，保留脸部特征'));
}

function testPendingClarificationCoversImageEditFallbackBranch() {
  const submit = fs.readFileSync(path.join(__dirname, '../../client/app/submit-workflow.js'), 'utf8');
  const fallbackIndex = submit.indexOf('if("edit_image"===routeMode&&!editAttachments.length&&!canResolveExistingEditImage)');
  assert.ok(fallbackIndex >= 0, 'image edit missing-attachment fallback should exist');
  const fallbackBlock = submit.slice(fallbackIndex, submit.indexOf('if(pendingMerge?.merged&&targetSession.pendingClarification)', fallbackIndex));
  assert.ok(fallbackBlock.includes('clarification.createPendingClarification?.'), 'missing image/edit target fallback must create explicit one-shot pending clarification');
  assert.ok(fallbackBlock.includes('targetSession.pendingClarification=createdPending'), 'fallback pending clarification should be persisted to the session');
  assert.ok(fallbackBlock.includes('saveSessionsMeta?.()'), 'fallback pending clarification should persist session metadata before returning');

  const pending = clarificationService.createPendingClarification({
    messages: [
      { role: 'user', rawText: '把这张图改成红色背景' },
      { role: 'assistant', rawText: '没有可编辑的图片，请先上传图片，或明确说明要基于上一张图修改。' },
    ],
    clarificationText: '没有可编辑的图片，请先上传图片，或明确说明要基于上一张图修改。',
  });
  assert.ok(pending);
  assert.strictEqual(pending.kind, 'image_edit');
  assert.strictEqual(clarificationService.shouldApplyPending(pending, { promptText: '', attachments: [{ name: 'photo.png', type: 'image/png' }] }), true, 'uploading the requested image should answer the one-shot pending clarification');
  assert.strictEqual(clarificationService.shouldApplyPending(pending, { promptText: '', attachments: [{ name: 'note.txt', type: 'text/plain' }] }), false, 'non-image attachment should not answer image edit clarification');
}

function testImageEditPromptFallbackAndValidation() {
  const payload = imageJobs.ensureImageEditPrompt({ model: 'gpt-image-2', prompt: '', editInstruction: '把背景改成红色' }, {});
  assert.strictEqual(payload.prompt, '把背景改成红色');

  const payloadFromBody = imageJobs.ensureImageEditPrompt({ model: 'gpt-image-2', prompt: '' }, { originalPrompt: '改成漫画风' });
  assert.strictEqual(payloadFromBody.prompt, '改成漫画风');

  const openaiPayload = imageJobs.buildOpenAiImageEditPayload(payload, [{ name: 'a.png', type: 'image/png', data: 'QUJDRA==' }]);
  assert.strictEqual(openaiPayload.prompt, '把背景改成红色');
  assert.strictEqual(openaiPayload.images.length, 1);
}

function testImageJobTargetsAndMultipartSanitization() {
  assert.strictEqual(imageJobs.buildImageEditMultipartBody, imageEditPayloadService.buildImageEditMultipartBody, 'image job should keep exporting multipart builder from the service boundary');
  assert.strictEqual(imageJobs.buildOpenAiImageEditPayload, imageEditPayloadService.buildOpenAiImageEditPayload, 'image job should keep exporting OpenAI edit payload builder from the service boundary');
  assert.strictEqual(imageEditPayloadService.safeMultipartFilename({ name: '../bad\r\nname.jpg', type: 'image/png' }, 0), 'bad_name.jpg');
  assert.strictEqual(imageEditPayloadService.safeMultipartFilename({ name: 'data:image/png;base64,AAAA', type: 'image/png' }, 1), 'image-2.png');

  assert.strictEqual(imageJobs.imageJobTargetUrl('https://ingress.lfans.cn/v1', 'image', {}), 'https://ingress.lfans.cn/v1/images/generations');
  assert.strictEqual(imageJobs.imageJobTargetUrl('https://ingress.lfans.cn/v1', 'edit_image', {}), 'https://ingress.lfans.cn/v1/images/edits');

  const dataUrl = 'data:image/png;base64,' + 'A'.repeat(64);
  const editPayload = imageJobs.stripImageEditFileFields({ model: 'gpt-image-2', prompt: '改成黑白', n: 2, image: dataUrl, images: [{ data: 'xxx' }] });
  assert.ok(!('image' in editPayload));
  assert.ok(!('images' in editPayload));

  const openaiPayload = imageJobs.buildOpenAiImageEditPayload({ model: 'gpt-image-2', prompt: `改图 ${dataUrl}`, n: 2 }, [{ name: 'logo.png', type: 'image/png', data: 'QUJDRA==' }]);
  assert.ok(!('n' in openaiPayload));
  assert.ok(!String(openaiPayload.prompt).includes('data:image'));
  assert.strictEqual(openaiPayload.images.length, 1);

  const multipart = imageJobs.buildImageEditMultipartBody({ model: 'gpt-image-2', prompt: '改成黑白' }, [{ name: 'logo.png', type: 'image/png', data: 'QUJDRA==' }]);
  assert.ok(Buffer.isBuffer(multipart.body));
  assert.ok(multipart.headers['Content-Type'].includes('multipart/form-data; boundary='));
  assert.ok(!Object.prototype.hasOwnProperty.call(multipart.headers, 'Content-Length'), 'undici must infer Buffer multipart length; an explicit header is rejected before dispatch');
  const boundary = multipart.headers['Content-Type'].match(/boundary=(.+)$/)?.[1];
  assert.ok(boundary, 'multipart boundary should be present');
  const multipartText = multipart.body.toString('latin1');
  assert.ok(multipartText.includes('name="prompt"'));
  assert.ok(multipartText.includes('name="image"; filename="logo.png"'));
  assert.ok(multipartText.endsWith(`--${boundary}--\r\n`));

  const multiImage = imageJobs.buildImageEditMultipartBody({ model: 'gpt-image-2', prompt: '合成' }, [
    { name: 'a.png', type: 'image/png', data: 'QUJDRA==' },
    { name: 'b.png', type: 'image/png', data: 'QUJDRA==' },
  ]);
  assert.strictEqual((multiImage.body.toString('latin1').match(/name="image\[\]"; filename=/g) || []).length, 2);
  assert.throws(() => imageJobs.buildImageEditMultipartBody({ model: 'gpt-image-2', prompt: '坏图' }, [{ name: 'bad.png', type: 'image/png', data: '!!!!' }]), /图片附件数据无效/);
  assert.ok(serverConfig.ALLOWED_PROXY_PATHS.some(re => re.test('/images/edits')));
}

function testStorageSanitizesEmbeddedImageContent() {
  const clean = sessionPersistence.sanitizeStoredMessage({
    role: 'user',
    content: [{ type: 'image_url', image_url: { url: 'data:image/png;base64,AAAA' } }],
    imageContext: JSON.stringify({ attachments: [{ name: 'a.png', src: 'data:image/png;base64,BBBB' }] }),
  }, { stripLargeDataUrlsFromText });
  const serialized = JSON.stringify(clean);
  assert.ok(!serialized.includes('data:image'));
  assert.ok(serialized.includes('[image-data-omitted]') || !serialized.includes('AAAA'));
  const cleanWithDefaultStripper = sessionPersistence.sanitizeStoredMessage({
    role: 'user',
    content: [{ type: 'image_url', image_url: { url: 'data:image/png;base64,SMALL' } }],
  });
  assert.ok(!JSON.stringify(cleanWithDefaultStripper).includes('data:image'));
}

function testPersistedAttachmentPreviewSurvivesDataUrlStripping() {
  const html = '<div class="user-attachment-preview-grid"><img class="user-attachment-image" src="data:image/png;base64,' + 'A'.repeat(3000) + '" data-persisted-src="indexeddb://att-1" alt="a.png"></div>';
  const clean = sessionPersistence.sanitizeStoredDisplayItem({ role: 'user', html }, { stripLargeDataUrlsFromText });
  assert.ok(clean.html.includes('data-persisted-src="indexeddb://att-1"'), 'persisted IndexedDB image reference should survive sanitization');
  assert.ok(!clean.html.includes('data:image/png;base64'), 'large inline image payload should be stripped from stored HTML');
  assert.ok(!clean.html.includes('image-missing'), 'image should not be marked missing when persisted src remains');
}

function testFilePlaceholderSemanticsAndFileUnderstanding() {
  const payload = routeService.buildRoutePayload({
    model: 'route-model',
    input: '这是什么',
    attachments: [{ name: 'pg.sql', type: 'text/plain', size: 128, is_image: false, has_extracted_text: true }],
    context: { recent_messages: [{ role: 'user', content: '这是什么\n\n[file id=att_1 name=pg.sql type=text/plain size=128]' }], image_candidates: [] },
  });
  const system = payload.messages[0].content;
  const body = payload.messages[1].content;
  assert.ok(system.includes('候选元数据'));
  assert.ok(system.includes('不要猜图片或文件内容'));
  assert.ok(system.includes('resources'));
  assert.ok(body.includes('"is_image":false'));
  assert.ok(body.includes('"file_candidates"'));
  assert.ok(body.includes('"has_extracted_text":true'));
  assert.ok(!body.includes('CREATE TABLE users'));
  const submitSource = require('fs').readFileSync(require('path').join(__dirname, '../../client/app/submit-workflow.js'), 'utf8');
  const appSource = require('fs').readFileSync(require('path').join(__dirname, '../../app.js'), 'utf8');
  assert.ok(submitSource.includes('这是什么') && submitSource.includes('这个附件'));
  assert.ok(submitSource.includes('里面|其中|多少') && submitSource.includes('邮箱|邮件|地址'));
  assert.ok(appSource.includes('这是什么') && appSource.includes('这个附件'));
  assert.ok(appSource.includes('里面|其中|多少') && appSource.includes('邮箱|邮件|地址'));
}

function testQuotedFileAttachmentTextIsIncluded() {
  const workflow = chatWorkflow.createChatWorkflow({ state: {} });
  const attachmentContext = JSON.stringify({
    attachments: [{ id: 'att_doc', name: 'doc.txt', type: 'text/plain', text: '引用附件正文内容' }],
  });
  const messages = [{ role: 'user', content: '这是什么\n\n[file id=att_doc name=doc.txt type=text/plain size=12]', attachmentContext }];
  const base = workflow.normalizeQuotedBaseMessages(messages);
  assert.strictEqual(base.length, 1);
  assert.ok(base[0].content.includes('[引用附件：doc.txt]'));
  assert.ok(base[0].content.includes('引用附件正文内容'));
  assert.ok(base[0].content.includes('引用消息带有非图片文件附件'));
}

function testHistoryFileAttachmentTextIsIncludedInChatContext() {
  const workflow = chatWorkflow.createChatWorkflow({ state: {} });
  const attachmentContext = JSON.stringify({
    attachments: [{ id: 'att_doc', name: 'mail.txt', type: 'text/plain', text: '最后一个邮箱：boss@example.com' }],
  });
  const base = workflow.requestBaseMessagesForSend({}, [
    { role: 'user', content: '已发送附件\n\n[file id=att_doc name=mail.txt type=text/plain size=32]', rawText: '已发送附件', attachmentContext },
    { role: 'assistant', content: '请说明你的需求。' },
  ]);
  assert.strictEqual(base.length, 2);
  assert.ok(base[0].content.includes('[历史附件：mail.txt]'));
  assert.ok(base[0].content.includes('最后一个邮箱：boss@example.com'));
}

function testGenericAttachmentContextSurvivesCoreNormalizationForRegenerate() {
  const attachmentContext = {
    prompt: '提取这个文件里关于图片任务分类的内容',
    content: '提取这个文件里关于图片任务分类的内容\n\n[file id=att_doc name=ChatUI 人工复测用例文档.md type=text/markdown size=128]',
    attachments: [{
      id: 'att_doc',
      name: 'ChatUI 人工复测用例文档.md',
      type: 'text/markdown',
      size: 128,
      text: '图片任务分类：生图、改图、看图、OCR',
    }],
  };
  const parsed = require('../../client/core/attachments').parseImageContext(JSON.stringify(attachmentContext));
  assert.strictEqual(parsed.content, attachmentContext.content);
  assert.strictEqual(parsed.attachments[0].id, 'att_doc');
  assert.strictEqual(parsed.attachments[0].text, '图片任务分类：生图、改图、看图、OCR');
  const workflow = chatWorkflow.createChatWorkflow({ state: {} });
  const base = workflow.requestBaseMessagesForSend({}, [
    { role: 'user', content: parsed.content, rawText: attachmentContext.prompt, attachmentContext: JSON.stringify(parsed) },
  ]);
  assert.ok(base[0].content.includes('[历史附件：ChatUI 人工复测用例文档.md]'));
  assert.ok(base[0].content.includes('图片任务分类：生图、改图、看图、OCR'));
}

function testHistoryFileCandidatesRouteAsFileQa() {
  const context = routeContext.buildRouteContext({
    messages: [{
      role: 'user',
      content: '已发送附件\n\n[file id=att_doc name=mail.txt type=text/plain size=32]',
      attachmentContext: JSON.stringify({ attachments: [{ id: 'att_doc', name: 'mail.txt', type: 'text/plain', size: 32, text: '最后一个邮箱：boss@example.com' }] }),
    }],
  });
  assert.strictEqual(context.file_candidates.length, 1);
  assert.strictEqual(context.file_candidates[0].source, 'history');
  const parsed = routeService.parseRouteResult(JSON.stringify(taskContractFixture({
    intent: 'file.qa',
    taskType: 'followup',
    operation: 'file_qa',
    resources: [{ type: 'file', source: 'history', role: 'attachment', index: 1, id: 'att_doc', name: 'mail.txt' }],
    currentIntent: '????????????',
    finalInstruction: '????????????',
    confidence: 0.9,
  })), {
    input: '从文件中提取最后一个邮箱',
    attachments: [],
    context,
  });
  assert.strictEqual(parsed.mode, 'chat');
  assert.strictEqual(parsed.operationType, 'file_qa');
  assert.strictEqual(parsed.fileRefs[0].source, 'history');
}

function testUserAttachmentContextFallsBackToImageContextForRegenerate() {
  const imageContext = JSON.stringify({
    prompt: '把这张图改一下',
    mode: 'edit_image',
    target: 'uploaded',
    attachments: [{ id: 'img_1', name: '老板.png', type: 'image/png', src: 'indexeddb://boss' }],
  });
  const session = {
    messages: [{ role: 'user', rawText: '把这张图改一下', imageContext }],
    display: [],
  };
  const workflow = imageContextWorkflow.createImageContextWorkflow({ getActiveSession: () => session });
  const node = { dataset: { messageIndex: '0' }, __displayItem: null };
  const context = workflow.getUserAttachmentContextFromNode(node);
  assert.ok(context, 'should restore upload image context when attachmentContext is absent');
  assert.strictEqual(context.attachments[0].src, 'indexeddb://boss');
}

function testQuotedAssistantImageContextRestoresFromCanonicalMessage() {
  const imageContext = JSON.stringify({
    prompt: '画一只猫',
    mode: 'image',
    target: 'previous',
    attachments: [{ name: 'cat.png', type: 'image/png', src: 'indexeddb://cat', imageId: 'img_latest_1' }],
  });
  const session = {
    messages: [
      { role: 'user', content: '画一只猫' },
      { role: 'assistant', content: '[图片生成完成] 画一只猫', imageContext },
    ],
    display: [],
  };
  const workflow = imageContextWorkflow.createImageContextWorkflow({ getActiveSession: () => session });
  const node = { dataset: { responseIndex: '1' }, __displayItem: {}, querySelectorAll: () => [] };
  const restored = workflow.getAssistantImageContext(node);
  assert.ok(restored, 'assistant image context should restore from canonical message by responseIndex');
  assert.strictEqual(restored.attachments[0].src, 'indexeddb://cat');
}

async function testUploadedImageUsesOneDurableBlobAcrossMessageContexts() {
  const writes = [];
  const workflow = imageContextWorkflow.createImageContextWorkflow({
    isImageFile: item => String(item?.type || '').startsWith('image/'),
    dataUrlToBlob: async src => ({ src }),
    putImageBlob: async (key, blob) => { writes.push({ key, blob }); },
    makeImageItemId: (referenceId, index) => `img_${referenceId}_${index}`,
    normalizeImageSelection: value => value,
    normalizeSelectedImageIds: value => value,
  });
  const attachment = {
    attachmentId: 'att_one',
    name: 'one.png',
    type: 'image/png',
    size: 4,
    dataUrl: 'data:image/png;base64,AAAA',
  };

  const imageContext = await workflow.buildUploadedImageContext('inspect this', [attachment]);
  const attachmentContext = await workflow.buildUserAttachmentContext('inspect this', [attachment]);

  assert.strictEqual(writes.length, 1, 'one uploaded image must create only one IndexedDB Blob');
  assert.strictEqual(writes[0].key, 'attachment-att_one');
  assert.strictEqual(attachment.previewSrc, 'indexeddb://attachment-att_one', 'the first durable write must be cached on the attachment object');
  assert.strictEqual(attachment.persistedSrc, 'indexeddb://attachment-att_one');
  assert.strictEqual(imageContext.attachments[0].src, 'indexeddb://attachment-att_one');
  assert.strictEqual(attachmentContext.attachments[0].src, 'indexeddb://attachment-att_one', 'imageContext and attachmentContext must reuse the same Blob reference');

  const previewWrites = [];
  const previewWorkflow = imageContextWorkflow.createImageContextWorkflow({
    isImageFile: item => String(item?.type || '').startsWith('image/'),
    dataUrlToBlob: async src => ({ src }),
    putImageBlob: async (key, blob) => { previewWrites.push({ key, blob }); },
    makeImageItemId: (referenceId, index) => `img_${referenceId}_${index}`,
    normalizeImageSelection: value => value,
    normalizeSelectedImageIds: value => value,
  });
  const previewed = {
    attachmentId: 'att_previewed',
    name: 'previewed.png',
    type: 'image/png',
    dataUrl: 'data:image/png;base64,BBBB',
    previewSrc: 'indexeddb://already-persisted',
  };
  const previewImageContext = await previewWorkflow.buildUploadedImageContext('', [previewed]);
  const previewAttachmentContext = await previewWorkflow.buildUserAttachmentContext('', [previewed]);
  assert.strictEqual(previewWrites.length, 0, 'a preview-persisted image must not be written again while building contexts');
  assert.strictEqual(previewImageContext.attachments[0].src, 'indexeddb://already-persisted');
  assert.strictEqual(previewAttachmentContext.attachments[0].src, 'indexeddb://already-persisted');
}

function testExistingImageEditGateAllowsPreviousSelection() {
  const submitSource = fs.readFileSync(path.join(__dirname, '../../client/app/submit-workflow.js'), 'utf8');
  const appSource = fs.readFileSync(path.join(__dirname, '../../app.js'), 'utf8');
  assert.ok(submitSource.includes('canResolveExistingEditImage'), 'submit workflow must allow previous/uploaded image resolver before blocking edit');
  assert.ok(submitSource.includes('!!routeInfo.usePreviousImage') && submitSource.includes('routeInfo.target==="previous"'));
  assert.ok(appSource.includes('canResolveExistingEditImage'), 'regenerate/app workflow must allow previous/uploaded image resolver before blocking edit');
  assert.ok(appSource.includes('!!p.usePreviousImage') && appSource.includes('p.target==="previous"'));
}

function testStructuredRouteDecisionCarriesRefs() {
  const imageRoute = routeContext.normalizeRoute({
    mode: 'edit_image',
    operation: { type: 'image_edit', scope: 'history', editInstruction: '变成黑白色' },
    imageRefs: [{ role: 'target', image_id: 'img_imgref_latest_1', reference_id: 'imgref_latest', index: 1, target: 'previous', source: 'history' }],
    editInstruction: '变成黑白色',
    confidence: 0.92,
  }, 'chat');
  assert.strictEqual(imageRoute.mode, 'edit_image');
  assert.strictEqual(imageRoute.operation.type, 'image_edit');
  assert.strictEqual(imageRoute.imageRefs.length, 1);
  assert.deepStrictEqual(imageRoute.selectedIndexes, [1]);
  assert.deepStrictEqual(imageRoute.selectedImageIds, ['img_imgref_latest_1']);
  assert.strictEqual(imageRoute.selectedReferenceId, 'imgref_latest');
  assert.strictEqual(imageRoute.usePreviousImage, true);

  const fileRoute = routeContext.normalizeRoute({
    mode: 'chat',
    operation: { type: 'file_qa', scope: 'current' },
    fileRefs: [{ role: 'source', file_id: 'att_1', index: 1, name: 'mail.txt', source: 'current' }],
    confidence: 0.9,
  }, 'chat');
  assert.strictEqual(fileRoute.mode, 'chat');
  assert.strictEqual(fileRoute.operation.type, 'file_qa');
  assert.strictEqual(fileRoute.fileRefs[0].file_id, 'att_1');

  const taskRoute = routeService.parseRouteResult(JSON.stringify(taskContractFixture({
    intent: 'vision_qa',
    taskType: 'followup',
    operation: 'image_compare',
    resources: [
      { type: 'image', source: 'history', role: 'compare_a', index: 1, reference_id: 'imgref_latest' },
      { type: 'image', source: 'current', role: 'compare_b', index: 1 },
    ],
    currentIntent: '这张和上一张有什么不同',
    finalInstruction: '比较这张和上一张有什么不同',
    confidence: 0.93,
  })), { input: '这张和上一张有什么不同', attachments: [{ name: 'new.png', type: 'image/png', is_image: true }], context: { image_candidates: [{ index: 1, source: 'history', reference_id: 'imgref_latest', target: 'previous' }] } });
  assert.strictEqual(taskRoute.mode, 'chat');
  assert.strictEqual(taskRoute.operationType, 'image_compare');
  assert.strictEqual(taskRoute.taskContract.schema_version, 'task_contract.v3');
  assert.ok(taskRoute.taskContract.resources.some(item => item.source === 'history' && item.role === 'compare_a'));
  assert.ok(taskRoute.taskContract.resources.some(item => item.source === 'current' && item.role === 'compare_b'));
  assert.ok(taskRoute.imageRefs.some(ref => ref.source === 'history'));
  assert.ok(taskRoute.imageRefs.some(ref => ref.source === 'current'));
}

function testImagePromptExtractionFollowsAiRouteWithCurrentImage() {
  const parsed = routeService.parseRouteResult(JSON.stringify(taskContractFixture({
    intent: 'image.generate',
    taskType: 'new_task',
    operation: 'image_reference_gen',
    resources: [{ type: 'image', source: 'current', role: 'reference', index: 1 }],
    currentIntent: '根据图片生成提示词',
    finalInstruction: '根据图片生成提示词',
    confidence: 0.9,
  })), {
    input: '根据图片生成提示词',
    attachments: [{ name: 'room.png', type: 'image/png', is_image: true }],
    context: { image_candidates: [] },
  });
  assert.strictEqual(parsed.mode, 'image');
  assert.strictEqual(parsed.operationType, 'image_reference_gen');
  assert.strictEqual(parsed.imageRefs[0].source, 'current');
  assert.deepStrictEqual(parsed.selectedIndexes, [1]);
}

function testImplicitImagePromptExtractionFollowsAiRouteWithCurrentImage() {
  const parsed = routeService.parseRouteResult(JSON.stringify(taskContractFixture({
    intent: 'vision_qa',
    taskType: 'new_task',
    operation: 'image_qa',
    resources: [{ type: 'image', source: 'current', role: 'source', index: 1 }],
    currentIntent: '逆向生成提示词尽量详细',
    finalInstruction: '逆向生成提示词尽量详细',
    confidence: 0.82,
  })), {
    input: '逆向生成提示词尽量详细',
    attachments: [{ name: 'sunset.jpg', type: 'image/jpeg', is_image: true }],
    context: { image_candidates: [] },
  });
  assert.strictEqual(parsed.mode, 'chat', '反推图片提示词是视觉理解，不得执行图片编辑');
  assert.strictEqual(parsed.operationType, 'image_qa');
  assert.strictEqual(parsed.imageRefs[0].source, 'current');
}

function testNormalizeRouteKeepsExplicitImageQaChatDespiteImageIntent() {
  const parsed = routeContext.normalizeRoute({
    mode: 'chat',
    operation: { type: 'image_qa', scope: 'current', prompt: '逆向生成提示词要详细', editInstruction: '' },
    imageRefs: [{ role: 'reference', image_id: 'img_imgref_uploaded_3_1', reference_id: 'imgref_uploaded_3', index: 1, target: 'uploaded', source: 'current' }],
    fileRefs: [],
    target: 'none',
    usePreviousImage: false,
    selectedReferenceId: 'imgref_uploaded_3',
    selectedIndexes: [1],
    selectedImageIds: ['img_imgref_uploaded_3_1'],
    needClarification: false,
    intent: 'image_reference_gen',
    contextualImagePrompt: '',
    tasks: ['根据用户上传图片进行视觉理解', '逆向生成详细图像提示词'],
    confidence: 0.95,
    evidence: '用户上传了一张图片并要求“逆向生成提示词要详细”，属于从图片反推/生成详细提示词，应进行图片理解而非生成新图。',
  }, 'chat');
  assert.strictEqual(parsed.mode, 'chat');
  assert.strictEqual(parsed.target, 'none');
  assert.strictEqual(parsed.operation.type, 'image_qa');
  assert.strictEqual(parsed.intent, 'unknown');
  assert.deepStrictEqual(parsed.selectedIndexes, [1]);
  assert.deepStrictEqual(parsed.selectedImageIds, ['img_imgref_uploaded_3_1']);
}

function testRouteOperationTypeDrivesCanonicalMode() {
  const imageQa = routeContext.normalizeRoute({
    mode: 'image',
    intent: 'image_reference_gen',
    operation: { type: 'image_qa', scope: 'current', prompt: '逆向生成提示词要详细' },
    imageRefs: [{ image_id: 'img_imgref_uploaded_3_1', reference_id: 'imgref_uploaded_3', index: 1, target: 'uploaded', source: 'current' }],
    target: 'new',
  }, 'chat');
  assert.strictEqual(imageQa.mode, 'chat');
  assert.strictEqual(imageQa.intent, 'unknown');
  assert.strictEqual(imageQa.target, 'none');
  assert.strictEqual(imageQa.operation.type, 'image_qa');

  const imageEdit = routeContext.normalizeRoute({
    mode: 'chat',
    intent: 'unknown',
    operation: { type: 'image_edit', scope: 'current', editInstruction: '把背景改成蓝色' },
    imageRefs: [{ image_id: 'img_imgref_uploaded_1_1', reference_id: 'imgref_uploaded_1', index: 1, target: 'uploaded', source: 'current' }],
  }, 'chat');
  assert.strictEqual(imageEdit.mode, 'edit_image');
  assert.strictEqual(imageEdit.intent, 'image_edit');
  assert.strictEqual(imageEdit.operation.type, 'image_edit');
}

function testImageResultCorrectionRebuildsImagePrompt() {
  const originalPrompt = '生成一张 A4 竖版黑白线稿图片，内容是适合小学二年级学生打印、涂色、剪裁、折叠组装的骰子展开图。展开图由 6 个大小相同的正方形组成标准十字形结构。';
  const input = '正方体怎么都7个面了';
  const context = routeContext.buildRouteContext({
    messages: [
      { role: 'user', content: originalPrompt },
      { role: 'assistant', content: `[图片生成完成] ${originalPrompt}` },
      { role: 'user', content: input },
    ],
    lastGeneratedImage: { prompt: originalPrompt, images: [{ filename: 'dice.png' }], updatedAt: Date.now() },
    maxChars: 12000,
  });
  assert.strictEqual(context.last_generated_image.count, 1);
  assert.ok(context.last_generated_image.prompt.includes('骰子展开图'));

  const modelContract = taskContractFixture({
    intent: 'image.generate',
    taskType: 'correction',
    operation: 'text_to_image',
    currentIntent: input,
    contextToPreserve: originalPrompt,
    constraints: ['正方体不能有 7 个面'],
    finalInstruction: '重新生成骰子展开图并修正面数错误',
    confidence: 0.92,
    reason: '上一轮生成图被指出结构错误，应按原始目标重新生成',
  });
  const parsed = routeService.parseRouteResult(JSON.stringify(modelContract), { input, attachments: [], context });
  assert.strictEqual(parsed.mode, 'image');
  assert.strictEqual(parsed.operationType, 'text_to_image');
  assert.strictEqual(parsed.needClarification, false);
  assert.ok(parsed.contextualImagePrompt.includes(originalPrompt), 'context prompt should preserve original image goal');
  assert.ok(parsed.contextualImagePrompt.includes(input) || parsed.contextualImagePrompt.includes('7 个面'), 'context prompt should include latest correction');

  const currentCorrectionContext = routeContext.buildRouteContext({
    messages: [
      { role: 'user', content: originalPrompt },
      { role: 'assistant', content: `[图片生成完成] ${originalPrompt}` },
      { role: 'user', content: '这张图不对，面数错了' },
    ],
    lastGeneratedImage: { prompt: originalPrompt, images: [{ filename: 'dice.png' }] },
  });
  assert.strictEqual(promptComposer.resolveBaseText(modelContract.resources[0], currentCorrectionContext), originalPrompt, 'the selected historical base resource must resolve to the original image prompt');
  const parsedCurrentCorrection = routeService.parseRouteResult(JSON.stringify(taskContractFixture({
    intent: 'image.generate',
    taskType: 'correction',
    operation: 'text_to_image',
    currentIntent: '这张图不对，面数错了',
    contextToPreserve: originalPrompt,
    finalInstruction: '修正面数错误，重新生成',
    confidence: 0.9,
  })), { input: '这张图不对，面数错了', attachments: [], context: currentCorrectionContext });
  assert.strictEqual(parsedCurrentCorrection.mode, 'image');
  assert.ok(parsedCurrentCorrection.contextualImagePrompt.includes(originalPrompt));
  assert.ok(parsedCurrentCorrection.contextualImagePrompt.includes('面数错了') || parsedCurrentCorrection.contextualImagePrompt.includes('修正面数错误'));

  const legacyRoute = routeService.parseRouteResult(JSON.stringify({ route: 'chat', confidence: 0.8 }), { input: '这张图不对，面数错了', attachments: [], context: currentCorrectionContext });
  assert.strictEqual(legacyRoute, null, 'legacy route objects must be rejected instead of post-processed');
}

function testRoutePromptUsesChineseCompactRules() {
  const system = routeService.ROUTE_SYSTEM_PROMPT;
  assert.ok(system.includes('不要输出 Markdown'));
  ['plain_chat', 'file_qa', 'multimodal_qa', 'image_qa', 'image_compare', 'ocr', 'text_to_image', 'image_reference_gen', 'edit_image', 'clarify'].forEach(type => assert.ok(system.includes(type), `task contract should define ${type}`));
  assert.ok(!system.includes('multi_step'), 'route contract must not advertise an unimplemented multi-step dispatcher');
  assert.ok(!system.includes('"intent"') && !system.includes('"execution"') && !system.includes('"api"'), 'operation must be the only model-authored dispatch field');
  assert.ok(system.includes('"directive"'));
  assert.ok(system.includes('"operations"'));
  assert.ok(system.includes('image_compare'));
  assert.ok(system.includes('只理解 current_input'), 'route prompt should make the current input authoritative');
  assert.ok(system.includes('历史覆盖一个完整的新请求'), 'route prompt should prevent history contamination');
  assert.ok(system.includes('image_reference_gen') && system.includes('edit_image'), 'route prompt should classify visual artifacts semantically');
  assert.ok(system.includes('上一张') && system.includes('那个文件'), 'route prompt should allow explicit contextual references');
  assert.ok(system.includes('不要猜图片或文件内容'));
  assert.ok(system.includes('unmentioned_policy'));
  assert.ok(system.length < 4000, `route prompt should stay compact: ${system.length}`);
  const payload = routeService.compactRouteUserPayload({
    input: '重新写一段产品介绍，不要画图',
    context: { recent_messages: [{ role: 'user', content: '上一轮：画一张猫图' }, { role: 'assistant', content: '[图片生成完成] 猫图' }] },
  });
  assert.strictEqual(payload.current_input, '重新写一段产品介绍，不要画图', 'route payload should keep latest user input as a separate primary field');
  assert.ok(payload.context.recent_messages.some(item => item.content.includes('画一张猫图')), 'history can still be present only as background context');
}
function testChatAnswerStreamingFlushesQuickly() {
  const source = fs.readFileSync(path.join(__dirname, '../../client/app/chat-workflow.js'), 'utf8');
  const index = fs.readFileSync(path.join(__dirname, '../../index.html'), 'utf8');
  const bundle = fs.readFileSync(path.join(__dirname, '../../server/services/static-bundle.service.js'), 'utf8');
  const workflow = chatWorkflow.createChatWorkflow({ state: {} });
  assert.ok(source.includes('},{minIntervalMs:40}),S=createRealtimeRenderer'), 'answer stream renderer should flush faster than the old 140ms cadence');
  assert.ok(!source.includes('},{minIntervalMs:140}),S=createRealtimeRenderer'), 'answer stream renderer should not use the old 140ms cadence');
  assert.strictEqual(workflow.appendWithOverlap('hello ', 'hello world'), 'hello world', 'overlap helper should accept cumulative full-text stream updates');
  assert.strictEqual(workflow.appendWithOverlap('abcXYZ', 'XYZdef'), 'abcXYZdef', 'overlap helper should merge overlapping delta stream updates');
  assert.strictEqual(workflow.appendWithOverlap('abcXYZ', 'cXYZ'), 'abcXYZ', 'overlap helper should not duplicate repeated tail chunks');
  assert.strictEqual(workflow.appendWithOverlap('a'.repeat(5000), 'a'.repeat(5000) + 'b'), 'a'.repeat(5000) + 'b', 'overlap helper should keep long cumulative chunks correct without scanning the full response tail');
  assert.ok(source.includes('const maxOverlapScan = Math.min(left.length, right.length, 4096)'), 'overlap helper should cap per-chunk overlap scanning to avoid long-stream slowdown');
  assert.strictEqual(workflow.canShowChatWaiting(false), true, 'waiting feedback should remain available before the first answer token');
  assert.strictEqual(workflow.canShowChatWaiting(true), false, 'waiting feedback must be permanently disabled after answer output starts');
  assert.ok(source.includes('if(!canShowChatWaiting(answerStarted))return') && source.includes('canShowChatWaiting(answerStarted)&&setPendingFeedback'), 'accepted callbacks and non-stream fallback must not restore waiting feedback after answer output starts');
  assert.ok(source.includes('const responseStartedAt=metricNow();let answerStarted=!1,streamRequestAccepted=!1;try{let t="",s=!1,c=null,answerText="",reasoningText="",firstTokenMs=null;'), 'answer-start state must remain in scope for the streaming fallback catch');
  assert.ok(index.includes('chat-workflow.js?v=1.3.24-task-lifecycle-state-machine') && index.includes('chatui.bundle.js?v=1.3.145-resilient-snapshot-store') && bundle.includes("BUNDLE_VERSION = '1.3.145-resilient-snapshot-store'"), 'cache-busting versions should be bumped for streaming performance fixes');
}

function testStreamingTailRendersWithoutCursor() {
  const css = fs.readFileSync(path.join(__dirname, '../../styles/flat-theme.css'), 'utf8');
  const renderer = fs.readFileSync(path.join(__dirname, '../../client/app/markdown/browser-streaming-renderer.js'), 'utf8');
  const sanitizer = fs.readFileSync(path.join(__dirname, '../../client/app/markdown/browser-sanitizer.js'), 'utf8');
  const message = fs.readFileSync(path.join(__dirname, '../../client/app/message-workflow.js'), 'utf8');
  const index = fs.readFileSync(path.join(__dirname, '../../index.html'), 'utf8');
  assert.ok(renderer.includes('markdown-stream-tail') && renderer.includes('data-markdown-streaming-tail'), 'streaming renderer should keep the unstable tail in one lightweight DOM node');
  assert.ok(renderer.includes('tailTextNode.appendData') && renderer.includes('container.appendChild(node)'), 'streaming tail should update a text node instead of rerendering the whole tail DOM');
  assert.ok(renderer.includes('removeTailNode();') && renderer.includes('final(container'), 'streaming tail should be removed during final render');
  assert.ok(renderer.includes('tailNode.appendChild(tailTextNode)') && !renderer.includes('markdown-stream-caret') && !renderer.includes('keepCursor'), 'streaming renderer should contain only tail text and no cursor-specific DOM or options');
  assert.ok(sanitizer.includes('ALLOW_DATA_ATTR: true'), 'sanitizer should still allow data attributes if streamed Markdown is sanitized elsewhere');
  assert.ok(!css.includes('.markdown-stream-caret') && !css.includes('markdown-stream-caret-pulse'), 'flat theme should not contain streaming cursor styles or animation');
  assert.ok(!css.includes('.message[data-streaming="1"] .content::after'), 'streaming messages should not synthesize a cursor with a pseudo-element');
  assert.ok(message.includes('dataset.lastStreamingRaw') && message.includes('e.dataset.lastStreamingRaw === rawValue'), 'message workflow should skip duplicate streaming payloads before touching Markdown DOM');
  assert.ok(message.includes('streamRenderer.set(rawValue, contentNode)') && !message.includes('const deltaText = s.delta'), 'chat streaming renderer should reconcile from cumulative rawValue instead of appending realtime cumulative chunks as deltas');
  assert.ok(index.includes('browser-streaming-renderer.js?v=1.2.91') && index.includes('message-workflow.js?v=1.3.39-image-quote') && index.includes('flat-theme.css?v=2.1.95-welcome-globe-only'), 'cache-busting versions should be bumped after removing the streaming cursor');
}


function testSessionTailFocusPreservesBottomGapDuringDynamicLayout() {
  const source = fs.readFileSync(path.join(__dirname, '../../client/app/scroll-focus-workflow.js'), 'utf8');
  assert.ok(source.includes('function focusSessionTail') && source.includes('activateBottomScrollLock(options)'), 'tail focus should activate the bottom-lock implementation');
  assert.ok(source.includes('function activateBottomScrollLock') && source.includes('scrollMessagesToBottom') && source.includes('requestBottomScroll'), 'bottom lock should scroll to the real list bottom through a rAF-batched path');
  assert.ok(source.includes('function scheduleSessionTailFocusAfterLayout'), 'layout-settled tail focus scheduler should exist');
  assert.ok(source.includes('new ResizeObserver') && source.includes('requestBottomScroll({ reason: "resize-observer", beforePaint: true })'), 'ResizeObserver should keep the bottom locked before paint when async Markdown changes height');
  assert.ok(source.includes('function syncLockedBottomBeforePaint') && source.includes('heightChanged') && source.includes('writeThreshold: 0'), 'height changes should be compensated synchronously before the next paint to reduce visible jitter');
  assert.ok(source.includes('.markdown-mermaid-pending,svg,canvas'), 'layout observer should watch chart/svg/canvas height changes');
  assert.ok(source.includes('viewBox') && source.includes('data-mermaid-rendered'), 'mutation observer should catch chart render attribute changes');
  assert.ok(!/setTimeout\s*\(/.test(source), 'bottom lock should not depend on hard-coded setTimeout delays');
  assert.ok(source.includes('requestAnimationFrame') && source.includes('bottomLockRaf'), 'bottom scroll writes should still have a requestAnimationFrame final correction pass');
}

function testSessionSwitchFocusesBottom() {
  const source = fs.readFileSync(path.join(__dirname, '../../client/app/session-ui-workflow.js'), 'utf8');
  const app = fs.readFileSync(path.join(__dirname, '../../app.js'), 'utf8');
  const index = fs.readFileSync(path.join(__dirname, '../../index.html'), 'utf8');
  const css = fs.readFileSync(path.join(__dirname, '../../styles/flat-theme.css'), 'utf8');
  assert.ok(source.includes('switchSession(session.id)'), 'session tabs should use the normal v1.3.25 switchSession path instead of an extra override layer');
  assert.ok(!source.includes('switchSessionToBottom'), 'session-ui should not contain the later switch-bottom wrapper');
  const removedOverride = ['session', 'switch', 'override'].join('-') + '.js';
  assert.ok(!index.includes(removedOverride), 'the extra capture-phase session switch override should not be loaded');
  assert.ok(app.includes('scheduleSessionTailFocusAfterLayout') && app.includes('reason:"switch-bottom"'), 'renderActiveSession should still pin the latest tail after a switch');
  assert.ok(css.includes('scroll-behavior:auto!important;'), 'session switch should disable smooth scroll behavior');
}

async function testDeleteSessionCleansRuntimeResources() {
  const { createSessionUiWorkflow } = require('../../client/app/session-ui-workflow');
  const calls = [];
  const storage = new Map();
  const localStorage = {
    setItem: (key, value) => storage.set(key, value),
    removeItem: key => storage.delete(key),
  };
  const state = {
    sessions: [{ id: 'delete-me', messages: [] }, { id: 'keep-me', messages: [] }],
    activeSessionId: 'keep-me',
    busySessions: new Set(['delete-me']),
    activeOutputSessions: new Map([['delete-me', {}]]),
    activeRuns: new Map(),
    liveRuns: new Map([['delete-me', {}]]),
    stoppedSessions: new Map([['delete-me', 'token']]),
    promptDrafts: new Map([['delete-me', 'draft']]),
    resumingJobs: new Set(['chat:delete-me', 'image:delete-me']),
    followingChatJobs: new Set(['chat-job']),
    followingImageJobs: new Set(['image-job']),
  };
  const workflow = createSessionUiWorkflow({
    getState: () => state,
    getElement: () => null,
    document: { createElement: () => ({}) },
    localStorage,
    createSession: () => ({ id: 'new-session', messages: [] }),
    deriveSessionTitle: () => '待删除',
    sessionTitleHtml: () => '',
    getSessionReturnCount: () => 0,
    isSessionBusy: () => false,
    sessionStorageKey: (key, id) => `${key}:${id || 'default'}`,
    showConfirmDialog: async () => true,
    disposeSessions: async (sessions, remaining) => calls.push(`dispose:${sessions.map(item => item.id).join(',')}:${remaining.map(item => item.id).join(',')}`),
  });

  await workflow.deleteSession('delete-me');

  assert.deepStrictEqual(calls, ['dispose:delete-me:keep-me'], 'session deletion must use the single resource lifecycle boundary');
  assert.deepStrictEqual(state.sessions.map(session => session.id), ['keep-me']);
  const index = fs.readFileSync(path.join(__dirname, '../../index.html'), 'utf8');
  assert.ok(index.includes('session-ui-workflow.js?v=1.3.14-model-switch-guard'), 'session deletion cleanup should bump the browser cache version');
}

async function testSessionResourceDisposalDeletesSnapshotWithoutWaitingForJobNetwork() {
  const { createSessionResourceLifecycle } = require('../../client/app/session-resources');
  const deletedSnapshots = [];
  const state = {
    sessions: [{ id: 'delete-me', messages: [], display: [] }],
    disposedSessionIds: new Set(),
    busySessions: new Set(),
    activeOutputSessions: new Map(),
    activeRuns: new Map([['delete-me', { jobIds: new Set(['chat:slow-job']), abortController: { abort() {} } }]]),
    taskStates: new Map([['delete-me', { phase: 'running' }]]),
    liveRuns: new Map(),
    stoppedSessions: new Map(),
    promptDrafts: new Map(),
    resumingJobs: new Set(),
    followingChatJobs: new Set(['slow-job']),
    followingImageJobs: new Set(),
  };
  const lifecycle = createSessionResourceLifecycle({
    getState: () => state,
    document: { getElementById: () => null },
    localStorage: { getItem: () => null, removeItem: () => {} },
    collectSessionImageKeys: () => [],
    collectAllSessionImageKeys: () => new Set(),
    deleteImageDbKeys: async () => {},
    deleteOrphanImageBlobs: async () => {},
    deleteSessionSnapshot: async id => { deletedSnapshots.push(id); },
    disposeManagedJob: () => new Promise(() => {}),
    sessionStorageKey: (key, id) => `${key}:${id}`,
    sessionChatJobKey: id => `chat-job:${id}`,
    sessionImageJobKey: id => `image-job:${id}`,
  });
  await lifecycle.disposeSessions(state.sessions, []);
  assert.deepStrictEqual(deletedSnapshots, ['delete-me'], 'IndexedDB session deletion must start before a slow managed-job network disposal completes');
  assert.strictEqual(state.taskStates.has('delete-me'), false, 'session disposal must remove canonical task state');
}

function testEmptySessionRendersPremiumWelcome() {
  const app = fs.readFileSync(path.join(__dirname, '../../app.js'), 'utf8');
  const index = fs.readFileSync(path.join(__dirname, '../../index.html'), 'utf8');
  const css = fs.readFileSync(path.join(__dirname, '../../styles/flat-theme.css'), 'utf8');
  const welcomeStart = app.indexOf('function shouldShowEmptyWelcome');
  const welcomeEnd = app.indexOf('let configWorkflow=null;', welcomeStart);
  const welcomeSource = app.slice(welcomeStart, welcomeEnd);
  const jsUnicodeEscapes = value => [...value].map(char => {
    const code = char.charCodeAt(0);
    return code > 127 ? `\\u${code.toString(16).padStart(4, '0')}` : char;
  }).join('');

  assert.ok(index.includes('<section id="messages" class="messages"></section>'), 'initial HTML should keep messages empty until session restore completes');
  assert.ok(app.includes('function renderEmptyWelcome'), 'empty session renderer should remain responsible for session-switch rendering');
  assert.ok(welcomeSource.includes('class="empty-welcome"') && welcomeSource.includes(jsUnicodeEscapes('ChatUI \u5965\u54f2AI\u5c0f\u52a9\u624b')), 'empty sessions should render the redesigned branded welcome page');
  assert.ok(!/[^\x00-\x7f]/.test(welcomeSource) && !welcomeSource.includes('???'), 'welcome copy should remain ASCII-safe in source and avoid lossy question-mark replacements');
  assert.ok(!welcomeSource.includes('<iframe') && !welcomeSource.includes('route.html'), 'the welcome page must not embed the intent-recognition flow');
  assert.ok(welcomeSource.includes('AUTHINE AI WORKSPACE') && !welcomeSource.includes('AOZHE AI WORKSPACE'), 'the welcome workspace brand should use AUTHINE');
  assert.ok(welcomeSource.includes('class="welcome-feature-grid"') && welcomeSource.includes(jsUnicodeEscapes('\u667a\u80fd\u610f\u56fe\u8def\u7531')) && welcomeSource.includes(jsUnicodeEscapes('\u6df1\u5ea6\u601d\u8003\u534f\u4f5c')) && welcomeSource.includes(jsUnicodeEscapes('\u591a\u6a21\u6001\u5185\u5bb9\u521b\u4f5c')) && welcomeSource.includes(jsUnicodeEscapes('\u8fde\u7eed\u4f1a\u8bdd\u4e0e\u6062\u590d')), 'the welcome page should present the project capability highlights');
  assert.ok(welcomeSource.includes('class="welcome-guidelines"') && welcomeSource.includes(jsUnicodeEscapes('\u4f7f\u7528\u987b\u77e5')) && welcomeSource.includes(jsUnicodeEscapes('\u5185\u5bb9\u5b89\u5168')) && welcomeSource.includes(jsUnicodeEscapes('\u672c\u5730\u5b58\u50a8')) && welcomeSource.includes(jsUnicodeEscapes('\u5408\u89c4\u4f7f\u7528')), 'the usage notice should remain on the redesigned welcome page');
  assert.ok(app.includes('document.querySelector(".empty-welcome")?.remove()'), 'sending the first message should remove the welcome page');
  assert.ok(app.includes('function shouldShowEmptyWelcome') && app.includes('!e.classList?.contains("empty-welcome")'), 'the empty renderer should treat only the current welcome page as non-message content');
  assert.ok(app.includes('!s&&!n&&!a'), 'the welcome page should render only when messages, pending display items, and other DOM content are empty');
  assert.ok(app.includes(':scope > .empty-welcome:only-child') && app.includes('t.scrollTop=0'), 'empty welcome rendering should stay at the top instead of being focused to the message tail on mobile');
  assert.ok(index.includes('./app.js?v=2.1.48-route-model-switch-guard') && index.includes('flat-theme.css?v=2.1.95-welcome-globe-only'), 'welcome assets should use updated cache versions');
  assert.ok(css.includes('.messages:has(>.empty-welcome:only-child)') && css.includes('.welcome-hero{') && css.includes('.welcome-title{'), 'the redesigned welcome page should have a dedicated premium hero layout');
  assert.ok(welcomeSource.includes('class="welcome-globe"') && welcomeSource.includes('id="welcomeGlobeOcean"') && welcomeSource.includes('class="welcome-globe-land"') && !welcomeSource.includes('<strong>AI</strong>') && !welcomeSource.includes('<small>READY</small>'), 'the welcome orbit center should contain only the dedicated layered globe without extra labels');
  assert.ok(css.includes('.welcome-globe{') && css.includes('@keyframes welcome-globe-tilt') && css.includes('@keyframes welcome-globe-land-drift') && css.includes('.welcome-globe-atmosphere{') && css.includes('background:transparent!important;\n  box-shadow:none!important;'), 'the globe should use dimensional lighting and restrained motion without a card-shaped center pedestal');
  assert.ok(css.includes('.welcome-orbit-ring,.welcome-globe,.welcome-globe::before,.welcome-globe svg,.welcome-globe-land,.welcome-globe-atmosphere{animation:none!important;}'), 'the globe animation should respect reduced-motion preferences');
  assert.ok(css.includes('.welcome-feature-grid{') && css.includes('grid-template-columns:repeat(4,minmax(0,1fr))') && css.includes('.welcome-feature-card:hover'), 'capability highlights should use a responsive four-card desktop grid');
  assert.ok(css.includes('.welcome-guidelines{') && css.includes('.welcome-guidelines-list{') && css.includes('.welcome-guideline.is-critical{'), 'usage guidance should retain its dedicated integrated styling');
  assert.ok(css.includes('min-height:236px!important') && css.includes('min-height:148px!important'), 'the desktop hero and capability cards should use the compact density');
  assert.ok(css.includes('.messages:has(>.empty-welcome:only-child){\n  display:flex!important;\n  align-items:center!important') && css.includes('@media (max-width:760px){\n  .messages:has(>.empty-welcome:only-child){\n    align-items:flex-start!important'), 'the welcome page should sit lower within desktop space while mobile remains safely top-aligned');
  assert.ok(css.includes('@media (min-width:761px) and (max-height:900px)') && css.includes('align-items:center!important;\n    padding-top:10px!important;\n    padding-bottom:max(var(--composer-safe-bottom,168px),132px)!important') && css.includes('.welcome-feature-grid{grid-template-columns:repeat(4,minmax(0,1fr))!important;gap:8px!important;}'), 'low-height desktop displays should center the compact welcome page inside composer-safe space and preserve a four-column capability grid');
  assert.ok(css.includes('@media (min-width:761px) and (max-height:700px)') && css.includes('.welcome-orbit,.welcome-badges{display:none!important;}') && css.includes('.welcome-feature-card{min-height:92px!important;}'), 'very short desktop displays should remove secondary hero decoration and use the densest safe layout');
  assert.ok(css.includes('@media (min-width:761px) and (max-height:520px)') && css.includes('align-items:flex-start!important') && css.includes('.welcome-feature-card{min-height:86px!important;padding:8px!important;}'), 'extremely short desktop displays should top-align an extra-dense scroll-safe layout instead of clipping it');
  assert.ok(css.includes('@media (max-width:640px)') && css.includes('padding:6px 5px max(var(--composer-safe-bottom,142px),132px)!important') && css.includes('.welcome-feature-grid{grid-template-columns:repeat(2,minmax(0,1fr))!important;}') && css.includes('@media (max-width:360px)') && css.includes('.welcome-orbit{display:none!important;}'), 'the compact welcome page should keep scroll clearance above the mobile composer, use a two-column grid, and fall back to one column on narrow screens');
}

function testHistoryRenderLoadsNewestMessagesFirst() {
  const source = fs.readFileSync(path.join(__dirname, '../../app.js'), 'utf8');
  assert.ok(source.includes('function renderCanonicalMessagesNewestFirst'), 'history render should have a newest-first loader');
  assert.ok(source.includes('for(let a=i;a<n.length;a+=1)renderMessageFromCanonical(e,n[a],a)'), 'initial history render should render the latest tail first');
  assert.ok(source.includes('chooseHistoryTailStart'), 'initial history render should choose a bounded tail window instead of rendering all history');
  assert.ok(source.includes('requestAnimationFrame?requestAnimationFrame(()=>requestAnimationFrame(u)):u()') && source.includes('addEventListener("scroll",d,{passive:!0})'), 'older history listener should be attached only after initial bottom pin frames settle');
  assert.ok(source.includes('for(let t=r-1;t>=m;t-=1)prependRenderedCanonicalMessage(renderMessageFromCanonical(e,n[t],t))'), 'older history should be prepended backwards from the current tail start');
  assert.ok(source.includes('s.scrollTop=q+e'), 'prepended history should compensate scrollTop by the scrollHeight delta');
  assert.ok(source.includes('const c=()=>') && source.includes('findCanonicalMessageNode?.(s.querySelectorAll(".message"),t,r)') && source.includes('s.replaceChildren(),markMessagesSession(e)') && source.includes('restorePendingDisplayItems(e,compactDisplayItems([...e?.display||[]])'), 'history tail render should verify the canonical tail by identity and preserve a legitimate pending follower during any real repair');
  assert.ok(source.includes('const q=t.role==="user"?t.messageIndex'), 'display cache matching should use canonical message/response indexes, not tail-window offsets');
  assert.ok(source.includes('displayLookupCache=new WeakMap') && source.includes('displayLookupForSession'), 'display cache matching should pre-index display items instead of rescanning display for every canonical message');
  assert.ok(source.includes('if(Number.isFinite(n)){i=[...t?.querySelectorAll?.(".message.user")') && source.indexOf('if(Number.isFinite(n)){i=[...t?.querySelectorAll?.(".message.user")') < source.indexOf('if(Number.isFinite(a)){const e=[...t?.querySelectorAll?.(".message.user")'), 'history anchor materialization should resolve canonical messageIndex before falling back to DOM userIndex');
  assert.ok(source.includes('data-history-detached-anchor="1"') && !source.includes('forceRenderCanonicalMessages(o);i=[...t?.querySelectorAll?.(".message.user")'), 'history anchor jump should materialize the requested item without a full canonical rebuild');
  assert.ok(source.includes('const o=loadChatHistory({render:!0})') && source.includes('restorePendingDisplayItems(t,n)'), 'session restore should render canonical history newest-first, then overlay pending-only display items');
  assert.ok(source.includes('dataset?.tailFirstHistory==="1")return'), 'canonical repair should not fight tail-first history rendering');
  assert.ok(source.includes('dataset?.historyBackfill==="1")return'), 'canonical repair should not fight in-progress reverse backfill');
  const perf = fs.readFileSync(path.join(__dirname, '../../client/app/performance-workflow.js'), 'utf8');
  assert.ok(perf.includes('virtualMessages: false'), 'legacy virtualizer should be disabled for deterministic tail-first history rendering');
  const css = fs.readFileSync(path.join(__dirname, '../../styles/flat-theme.css'), 'utf8');
  assert.ok(css.includes('min-height:0!important;') && css.includes('height:100%!important;') && css.includes('overflow-y:auto!important;'), 'messages container should be constrained as an internal scroller');
}

function testStreamingAllowsManualScroll() {
  const source = fs.readFileSync(path.join(__dirname, '../../client/app/scroll-focus-workflow.js'), 'utf8');
  const bootstrap = fs.readFileSync(path.join(__dirname, '../../client/app/bootstrap-workflow.js'), 'utf8');
  assert.ok(source.includes('event?.type === "wheel"') && source.includes('event?.type === "touchstart"') && source.includes('event?.type === "pointerdown"'), 'wheel/touch/pointer gestures should be treated as manual scroll intent');
  assert.ok(source.includes('manualAutoFollowSuppressUntil') && source.includes('cancelBottomScrollFrame()'), 'upward manual intent should pause auto-follow immediately so wheel scrolling is not fought by layout corrections');
  assert.ok(source.includes('now() < state.programmaticScrollUntil'), 'programmatic scroll suppression window should exist');
  assert.ok(source.includes('manualIntent && event?.type === "scroll" && gap > threshold') && source.includes('releaseBottomScrollLock'), 'scroll events should release or restore the bottom lock by 24px distance');
  assert.ok(source.includes('state.streamFocusLocked = false') && source.includes('state.userScrollLocked = true'), 'manual scroll should release streaming follow and lock user position');
  assert.ok(bootstrap.includes('bindMessageScrollIntent') && bootstrap.includes('m.addEventListener(t,markManualMessageScroll') && bootstrap.includes('window.addEventListener(t,markManualMessageScroll'), 'message scroll intent must be bound to the scroll container and window gestures');
}

function testScrollMetricsHelpersArePureAndReusedByWorkflow() {
  const scroller = { scrollHeight: 320, scrollTop: 75, clientHeight: 120 };
  assert.strictEqual(scrollMetrics.distanceToBottom(scroller), 125);
  assert.strictEqual(scrollMetrics.distanceToBottom({ scrollHeight: 100, scrollTop: 120, clientHeight: 40 }), 0);
  assert.strictEqual(scrollMetrics.isNearBottom(scroller, 124), false);
  assert.strictEqual(scrollMetrics.isNearBottom(scroller, 125), true);
  assert.strictEqual(scrollMetrics.normalizeThreshold(-10, 24), 0);
  assert.strictEqual(scrollMetrics.normalizeThreshold(Number.NaN, 24), 24);
  assert.strictEqual(scrollMetrics.nextScrollTopForBottom({ scrollHeight: 80, clientHeight: 140 }), 0);
  assert.strictEqual(scrollMetrics.nextScrollTopForBottom(scroller), 200);
  assert.strictEqual(scrollMetrics.clampScrollTop(260, scroller), 200);
  assert.strictEqual(scrollMetrics.clampScrollTop(-4, scroller), 0);
  assert.strictEqual(scrollMetrics.clampScrollTop(12, 30), 12);
  assert.strictEqual(scrollMetrics.shouldRespectManualScroll({ gap: 25, threshold: 24, manualIntent: true, eventType: 'scroll' }), true);
  assert.strictEqual(scrollMetrics.shouldRespectManualScroll({ gap: 24, threshold: 24, manualIntent: true, eventType: 'scroll' }), false);
  assert.strictEqual(scrollMetrics.shouldRespectManualScroll({ gap: 25, threshold: 24, manualIntent: false, eventType: 'scroll' }), false);

  const workflow = fs.readFileSync(path.join(__dirname, '../../client/app/scroll-focus-workflow.js'), 'utf8');
  const index = fs.readFileSync(path.join(__dirname, '../../index.html'), 'utf8');
  assert.ok(workflow.includes('loadScrollMetrics') && workflow.includes('root?.ChatUIScrollMetrics') && workflow.includes("require('../ui/scroll-metrics')"), 'scroll focus workflow should load the pure scroll metrics helper with browser/CommonJS fallback');
  assert.ok(!workflow.includes('function distanceToBottom(el)'), 'distanceToBottom should be extracted from the workflow body');
  assert.ok(workflow.includes('nextScrollTopForBottom(el)') && workflow.includes('normalizeThreshold(options.bottomThreshold, BOTTOM_THRESHOLD)'), 'bottom target and threshold math should use the pure helper');
  assert.ok(workflow.includes('manualIntent && event?.type === "scroll" && gap > threshold'), 'manual scroll release condition should remain visibly unchanged');
  assert.ok(index.indexOf('client/ui/scroll-metrics.js') < index.indexOf('client/app/scroll-focus-workflow.js'), 'scroll metrics helper should load before scroll focus workflow');
  assert.ok(index.includes('scroll-focus-workflow.js?v=1.3.33'), 'scroll behavior cache version should remain unchanged for a pure-helper extraction');
}

function testMessageDomainIsFeatureModule() {
  const domain = require('../../client/features/messages/message-domain');
  assert.strictEqual(domain.messageRoleLabel('user'), '我');
  assert.strictEqual(domain.messageRoleLabel('assistant'), 'AI');
  assert.strictEqual(domain.normalizeQuoteText('[图片生成完成] hello   TTFT 1s', 20), 'hello');
  assert.deepStrictEqual(domain.readQuoteContext({ role: 'assistant', content: ' ok ', responseIndex: 2 }), { role: 'assistant', content: 'ok', responseIndex: '2' });
  const workflow = fs.readFileSync(path.join(__dirname, '../../client/app/message-workflow.js'), 'utf8');
  const index = fs.readFileSync(path.join(__dirname, '../../index.html'), 'utf8');
  assert.ok(workflow.includes('root.ChatUIFeaturesMessagesDomain || {}'), 'message workflow should read quote/role helpers from the message domain feature');
  assert.ok(!workflow.includes('function readQuoteContext(value)'), 'message workflow should not keep a duplicate quote-context parser');
  assert.ok(!workflow.includes('function normalizeQuoteText(text'), 'message workflow should not keep a duplicate quote text normalizer');
  assert.ok(index.indexOf('client/features/messages/message-domain.js') < index.indexOf('client/app/message-workflow.js'), 'message domain feature should load before message workflow');
}

function testMessageModelHelpersAreFeatureModule() {
  assert.strictEqual(messageModel.normalizeRole('assistant'), 'assistant');
  assert.strictEqual(messageModel.normalizeRole('error', 'user'), 'user');
  assert.deepStrictEqual(messageModel.parseMaybeJsonContext('{"attachments":[{"id":"a"}]}'), { attachments: [{ id: 'a' }] });
  assert.strictEqual(messageModel.parseMaybeJsonContext('{bad'), null);
  assert.strictEqual(messageModel.hasUsableImageContext(JSON.stringify({ attachments: [{ name: 'a.png' }] })), true);
  assert.strictEqual(messageModel.hasUsableImageContext(JSON.stringify({ attachments: [] })), false);
  assert.deepStrictEqual(messageModel.normalizeQuoteContext({ role: 'assistant', rawText: ' hi ', responseIndex: 4 }, { normalizeQuoteText: value => String(value).trim() }), { role: 'assistant', content: 'hi', responseIndex: '4' });
  assert.deepStrictEqual(messageModel.normalizeQuoteContext({ role: 'bad', image_context: { attachments: [{ id: 'img' }] } }), { role: 'user', content: '[图片消息]', imageContext: '{"attachments":[{"id":"img"}]}' });
  assert.deepStrictEqual(messageModel.resolveDisplayItemKey({ dataset: { displayItemId: 'd1' }, __displayItem: { responseIndex: 2, messageIndex: 1 } }), { displayItemId: 'd1', responseIndex: 2, messageIndex: 1 });
  const workflow = fs.readFileSync(path.join(__dirname, '../../client/app/message-workflow.js'), 'utf8');
  const domain = fs.readFileSync(path.join(__dirname, '../../client/features/messages/message-domain.js'), 'utf8');
  const index = fs.readFileSync(path.join(__dirname, '../../index.html'), 'utf8');
  assert.ok(workflow.includes('root.ChatUIFeaturesMessagesModel || messageDomain'), 'message workflow should use the message model helper facade when available');
  assert.ok(workflow.includes('messageModel.hasUsableImageContext'), 'image context usability should be delegated to the model helper');
  assert.ok(workflow.includes('messageModel.resolveDisplayItemKey'), 'display/message key extraction should be delegated to the model helper');
  assert.ok(!workflow.includes('function hasUsableImageContext(value)'), 'message workflow should not keep a duplicate image-context helper');
  assert.ok(domain.includes("require('./message-model')") && domain.includes('messageModel.normalizeQuoteContext'), 'message domain should share quote normalization with the model helper');
  assert.ok(index.indexOf('client/features/messages/message-model.js') < index.indexOf('client/features/messages/message-domain.js'), 'message model should load before message domain');
}

function testQuotePreviewIsFeatureModule() {
  const domain = require('../../client/features/messages/message-domain');
  const quotePreviewFactory = require('../../client/features/messages/quote-preview');
  const quotePreview = quotePreviewFactory.createQuotePreview({
    readQuoteContext: domain.readQuoteContext,
    normalizeQuoteText: domain.normalizeQuoteText,
    escapeHtml: domain.escapeHtmlLocal,
  });
  const html = quotePreview.renderSentQuotePreview({ role: 'assistant', content: 'hello <b>', responseIndex: 3 });
  assert.ok(html.includes('sent-quote-preview'), 'quote preview feature should render the sent quote button');
  assert.ok(html.includes('hello &lt;b&gt;'), 'quote preview feature should escape quote text');
  assert.ok(quotePreview.withSentQuotePreview('<p>x</p>', { role: 'user', content: 'quote' }).includes('sent-quote-preview'), 'quote preview feature should prepend preview to user html');
  const workflow = fs.readFileSync(path.join(__dirname, '../../client/app/message-workflow.js'), 'utf8');
  const index = fs.readFileSync(path.join(__dirname, '../../index.html'), 'utf8');
  assert.ok(workflow.includes('ChatUIFeaturesMessagesQuotePreview?.createQuotePreview'), 'message workflow should delegate sent quote preview rendering to the feature module');
  assert.ok(!workflow.includes('function renderSentQuotePreview(value)'), 'message workflow should not keep duplicate sent quote preview HTML generation');
  assert.ok(!workflow.includes('classList.add(\'quoted\')') && !workflow.includes('classList.add("quoted")'), 'selecting a quote source should not add a persistent quoted border class');
  assert.ok(workflow.includes('function scrollQuotedMessageToStart') && workflow.includes("block: 'start'") && !workflow.includes("block: 'center', behavior: 'smooth'"), 'quote preview jumps should align the referenced message start/top, not center it');
  const messageCss = fs.readFileSync(path.join(__dirname, '../../styles/messages.css'), 'utf8');
  const flatCss = fs.readFileSync(path.join(__dirname, '../../styles/flat-theme.css'), 'utf8');
  assert.ok(!messageCss.includes('.message.quoted') && !flatCss.includes('.message.quoted'), 'quote source/target styling should use one jump flash path, not a separate quoted border path');
  assert.ok(messageCss.includes('.message.quote-target-flash::before') && messageCss.includes('left:-8px!important') && !messageCss.includes('padding-left:12px!important') && messageCss.includes('linear-gradient(180deg,#4d6bfe 0%,#14b8a6 100%)'), 'quote jump target should use a visible gradient side bar outside the message flow so it does not cover or shift content');
  assert.ok(!messageCss.includes('.message.quote-target-flash .bubble::after') && !messageCss.includes('content:"引用位置"'), 'quote jump target should not render a label that covers metadata');
  assert.ok(workflow.includes('setTimeout(clearFlash, 3000)'), 'quote jump target marker should disappear after 3 seconds');
  assert.ok(!messageCss.includes('quote-target-ring') && !messageCss.includes('outline:2px solid'), 'quote jump target should avoid heavy ring/outline effects');
  assert.ok(workflow.includes('function quoteContentTextFromNode') && workflow.includes("'.reasoning-panel,.reasoning-head,.reasoning-content'") && workflow.includes("node?.querySelector?.('.content')"), 'quote content should be resolved from message body and exclude reasoning panels');
  assert.ok(domain.normalizeQuoteText('思考中 推理内容 思考完成 正文', 1200) === '推理内容 正文', 'quote text normalization should remove reasoning status labels');
  assert.ok(index.includes('message-workflow.js?v=1.3.39-image-quote') && index.includes('message-model.js?v=1.0.1') && index.includes('message-domain.js?v=1.0.1') && index.includes('styles/messages.css?v=1.3.18-followup-alignment') && index.includes('chatui.bundle.js?v=1.3.145-resilient-snapshot-store'), 'quote filtering and jump flash changes should bump cache versions');
  assert.ok(index.indexOf('client/features/messages/message-domain.js') < index.indexOf('client/features/messages/quote-preview.js'), 'quote preview should load after message domain');  assert.ok(index.indexOf('client/features/messages/quote-preview.js') < index.indexOf('client/app/message-workflow.js'), 'quote preview should load before message workflow');
}

function testMarkdownFinalRendererIsFeatureModule() {
  const feature = fs.readFileSync(path.join(__dirname, '../../client/features/messages/markdown-final-renderer.js'), 'utf8');
  const workflow = fs.readFileSync(path.join(__dirname, '../../client/app/message-workflow.js'), 'utf8');
  const index = fs.readFileSync(path.join(__dirname, '../../index.html'), 'utf8');
  assert.ok(feature.includes('function createMarkdownFinalRenderer'), 'large Markdown final renderer should live in the messages feature module');
  assert.ok(feature.includes('content.replaceChildren(...[...stageContent.childNodes])'), 'feature renderer should still replace visible content only once after offscreen rendering');
  assert.ok(feature.includes('stageContent.append(...batch)'), 'offscreen stage may batch append final HTML away from the visible message');
  assert.ok(workflow.includes('ChatUIFeaturesMessagesMarkdownFinalRenderer?.createMarkdownFinalRenderer'), 'message workflow should delegate final Markdown rendering to the feature module');
  assert.ok(!workflow.includes('function splitMarkdownRenderChunks'), 'message workflow should not keep a duplicate Markdown chunk splitter');
  assert.ok(!workflow.includes('content.replaceChildren(...[...stageContent.childNodes])'), 'message workflow should not own final Markdown DOM replacement details');
  assert.ok(index.indexOf('client/features/messages/markdown-final-renderer.js') < index.indexOf('client/app/message-workflow.js'), 'feature renderer should load before message workflow');
}

function testMarkdownPreviewIsFeatureModule() {
  const preview = require('../../client/features/messages/markdown-preview');
  const html = preview.renderMarkdownPreview('## 标题\n\n这是一段 **加粗** 内容。\n\n- 第一项\n- 第二项\n\n```js\nconsole.log(1)\n```');
  assert.ok(html.includes('markdown-preview-lite'), 'large Markdown preview should use a dedicated lightweight preview container');
  assert.ok(html.includes('<h3>标题</h3>'), 'large Markdown preview should render headings without raw markdown markers');
  assert.ok(html.includes('<strong>加粗</strong>'), 'large Markdown preview should render common inline emphasis');
  assert.ok(preview.renderMarkdownPreview('包含 `inline` 代码').includes('<code>inline</code>'), 'large Markdown preview should render inline code without backticks');
  assert.ok(html.includes('<ul>') && html.includes('<li>第一项</li>'), 'large Markdown preview should render lists without raw list markers');
  assert.ok(html.includes('<pre class="markdown-preview-code"><code>console.log(1)</code></pre>'), 'large Markdown preview should render fenced code without backtick fences');
  assert.ok(!html.includes('```'), 'large Markdown preview should not expose code fence markers');

  const workflow = fs.readFileSync(path.join(__dirname, '../../client/app/message-workflow.js'), 'utf8');
  const index = fs.readFileSync(path.join(__dirname, '../../index.html'), 'utf8');
  assert.ok(workflow.includes('root.ChatUIFeaturesMessagesMarkdownPreview?.renderMarkdownPreview'), 'message workflow should delegate initial large Markdown preview to the feature module');
  assert.ok(index.indexOf('client/features/messages/markdown-preview.js') < index.indexOf('client/app/message-workflow.js'), 'preview feature should load before message workflow');
}

function testMarkdownLiveStreamIsFeatureModule() {
  const feature = fs.readFileSync(path.join(__dirname, '../../client/features/messages/markdown-live-stream.js'), 'utf8');
  const message = fs.readFileSync(path.join(__dirname, '../../client/app/message-workflow.js'), 'utf8');
  const browserStreaming = fs.readFileSync(path.join(__dirname, '../../client/app/markdown/browser-streaming-renderer.js'), 'utf8');
  const index = fs.readFileSync(path.join(__dirname, '../../index.html'), 'utf8');
  assert.ok(feature.includes('function createMarkdownLiveStream'), 'large Markdown live streaming should live in a feature module');
  assert.ok(feature.includes('createStreamingRenderer') && feature.includes('active.set(next, target)'), 'live stream feature should reuse stable-boundary incremental Markdown renderer through the staged target');
  assert.ok(feature.includes('const minIntervalMs = Number.isFinite(options.minIntervalMs) ? options.minIntervalMs : 90') && feature.includes('active.preview?.(next, target)') && feature.includes('deltaLength > 3000'), 'large live stream should keep Markdown commit cadence stable and use lightweight tail previews between commits');
  assert.ok(feature.includes('if (phase.final || phase.reset)') && feature.includes('if (phase.streaming && !phase.final'), 'live stream should avoid expensive enhancement while tokens are arriving');
  assert.ok(message.includes('function updateLiveMarkdownStream'), 'message workflow should use a live Markdown stream path');
  assert.ok(message.includes('messageNode.__markdownLiveStream') && message.includes('liveStream.append(contentNode, next'), 'large streaming Markdown should incrementally append rendered Markdown, not plain text');
  assert.ok(message.includes('e.__markdownLiveStream.final(contentNode, rawValue)'), 'large streaming Markdown should finalize through the incremental stream when possible');
  assert.ok(!message.includes('function updatePlainMarkdownStream'), 'plain-text streaming path should not remain as a duplicate large Markdown implementation');
  assert.ok(!message.includes('streamingPlainMarkdown'), 'large streaming Markdown should not be marked as plain streaming');
  assert.ok(browserStreaming.includes('splitStableTailIncremental') && browserStreaming.includes('scanOffset') && browserStreaming.includes('scanInFence'), 'streaming Markdown should scan stable boundaries incrementally instead of rescanning the whole response every frame');
  assert.ok(browserStreaming.includes('preview(value, container)') && browserStreaming.includes('syncTailNode(container, tail'), 'streaming Markdown should expose lightweight tail preview updates without forcing full Markdown commits');
  assert.ok(browserStreaming.includes("let first = '', second = '', count = 0") && browserStreaming.includes("lastIndexOf('\\n\\n', Math.max(0, beforeTailEnd - 1))"), 'streaming table detection should avoid allocating/splitting the whole tail block on each chunk');
  assert.ok(browserStreaming.includes('const inlineMathTail = hasConservativeInlineMathTail(tailScan)') && browserStreaming.includes('boundedStreamingScanTail(raw)') && browserStreaming.includes('if (inlineMathTail)'), 'streaming boundary scan should reuse inline-math tail detection within a frame');
  assert.ok(browserStreaming.includes('activeTableBlockStart') && browserStreaming.includes('isMarkdownTableDivider') && browserStreaming.includes('tableStart >= 0'), 'streaming Markdown should keep table blocks unstable until final render so tables are not split into paragraphs');
  assert.ok(browserStreaming.includes('tailTextNode.appendData') && browserStreaming.includes('STREAMING_TAIL_SCAN_LIMIT'), 'streaming Markdown should append cumulative tail deltas and bound expensive tail scans for huge unstable blocks');
  assert.ok(index.indexOf('client/features/messages/markdown-live-stream.js') < index.indexOf('client/app/message-workflow.js'), 'live stream feature should load before message workflow');
  assert.ok(index.includes('browser-streaming-renderer.js?v=1.2.91') && index.includes('markdown-live-stream.js?v=1.0.3') && index.includes('message-workflow.js?v=1.3.39-image-quote'), 'streaming table/smoothness fixes should bump browser cache versions');
}

function testStreamingMarkdownTablesRemainAtomicUntilFinal() {
  const previousWindow = global.window;
  const previousDocument = global.document;
  const dom = new JSDOM('<!doctype html><div id="content"></div>');
  global.window = dom.window;
  global.document = dom.window.document;
  try {
    const streaming = require('../../client/app/markdown/browser-streaming-renderer');
    const renderer = streaming.createStreamingRenderer({
      renderMarkdown: markdownEngine.renderMarkdown,
      enhance: () => {},
    });
    const container = dom.window.document.getElementById('content');
    const chunks = ['| A | B |\n', '|---|---|\n', '| 1 | 2 |\n'];
    for (const chunk of chunks) renderer.append(chunk, container);
    assert.strictEqual(renderer.getConsumed(), 0, 'streaming table rows should remain uncommitted until the table block is complete');
    assert.ok(container.querySelector('[data-markdown-streaming-tail]'), 'active table block should stay in the lightweight tail while streaming');
    assert.ok(!container.querySelector('p') && !container.querySelector('table'), 'active table block should not be prematurely rendered as paragraphs or a partial table');
    const result = renderer.final(container);
    assert.strictEqual(result.mode, 'incremental-final', 'unchanged final text should still use incremental finalization');
    assert.ok(container.querySelector('table'), 'finalized streaming Markdown table should render as a table');
    assert.ok(container.querySelector('th')?.textContent.trim() === 'A', 'table header should be parsed from the streamed table block');
    assert.ok(!container.querySelector('[data-markdown-streaming-tail]'), 'streaming tail should be removed after final table render');
    assert.ok(!container.textContent.includes('|---|'), 'raw Markdown table divider should not remain visible after final render');
  } finally {
    global.window = previousWindow;
    global.document = previousDocument;
  }
}


function testStreamingTailAppendsCumulativeDeltas() {
  const previousWindow = global.window;
  const previousDocument = global.document;
  const dom = new JSDOM('<!doctype html><div id="content"></div>');
  global.window = dom.window;
  global.document = dom.window.document;
  try {
    const streaming = require('../../client/app/markdown/browser-streaming-renderer');
    const renderer = streaming.createStreamingRenderer({ renderMarkdown: markdownEngine.renderMarkdown, enhance: () => {} });
    const container = dom.window.document.getElementById('content');
    renderer.append('a'.repeat(10000), container);
    const textNode = container.querySelector('[data-markdown-streaming-tail]')?.firstChild;
    assert.ok(textNode, 'streaming tail should use a text node');
    let appended = '';
    const originalAppendData = textNode.appendData.bind(textNode);
    textNode.appendData = value => { appended += value; return originalAppendData(value); };
    renderer.append('b'.repeat(5000), container);
    assert.strictEqual(appended, 'b'.repeat(5000), 'cumulative tail growth should append only the delta instead of replacing the whole text node');
    assert.strictEqual(container.querySelector('[data-markdown-streaming-tail]')?.textContent.length, 15000, 'full streaming tail should remain visible while using delta append internally');
  } finally {
    global.window = previousWindow;
    global.document = previousDocument;
  }
}

function testLiveMarkdownStreamPreviewsChunksWithoutLoweringCommitCadence() {
  const previousWindow = global.window;
  const previousDocument = global.document;
  const dom = new JSDOM('<!doctype html><div id="content"></div>');
  global.window = dom.window;
  global.document = dom.window.document;
  try {
    const streaming = require('../../client/app/markdown/browser-streaming-renderer');
    const live = require('../../client/features/messages/markdown-live-stream').createMarkdownLiveStream({
      renderMarkdown: markdownEngine.renderMarkdown,
      createStreamingRenderer: streaming.createStreamingRenderer,
      now: () => 0,
    });
    const container = dom.window.document.getElementById('content');
    const first = live.append(container, '第一段');
    assert.ok(first.preview && first.skipped, 'first chunk before the commit interval should use a lightweight preview instead of forcing a Markdown commit');
    assert.strictEqual(container.textContent.replace(/\s+/g, ''), '第一段', 'lightweight preview should still show incoming text immediately');
    assert.strictEqual(container.querySelectorAll('p').length, 0, 'preview updates should not perform Markdown block rendering while cadence gate is closed');
    live.append(container, '第一段\n第二段');
    assert.ok(container.textContent.includes('第二段'), 'subsequent skipped chunks should update the tail text immediately');
    const final = live.final(container, '第一段\n第二段');
    assert.strictEqual(final.mode, 'incremental-final', 'finalization should commit the accumulated tail through the Markdown renderer');
    assert.ok(container.querySelector('p'), 'final content should still become rendered Markdown after the stream completes');
  } finally {
    global.window = previousWindow;
    global.document = previousDocument;
  }
}

function testLiveMarkdownStreamDoesNotBlankExistingContentBeforeFirstPaint() {
  const previousWindow = global.window;
  const previousDocument = global.document;
  const dom = new JSDOM('<!doctype html><div id="content"><div class="pending-feedback">等待中</div></div>');
  global.window = dom.window;
  global.document = dom.window.document;
  try {
    const streaming = require('../../client/app/markdown/browser-streaming-renderer');
    const live = require('../../client/features/messages/markdown-live-stream').createMarkdownLiveStream({
      renderMarkdown: markdownEngine.renderMarkdown,
      createStreamingRenderer: streaming.createStreamingRenderer,
      now: () => 0,
    });
    const container = dom.window.document.getElementById('content');
    let blanked = false;
    const originalReplaceChildren = container.replaceChildren.bind(container);
    container.replaceChildren = (...nodes) => {
      if (!nodes.length) blanked = true;
      return originalReplaceChildren(...nodes);
    };
    live.append(container, '正文已开始');
    assert.strictEqual(blanked, false, 'stream initialization should never clear the visible container to an empty frame');
    assert.strictEqual(container.textContent.trim(), '正文已开始', 'first streamed content should replace waiting feedback in one DOM commit');
  } finally {
    global.window = previousWindow;
    global.document = previousDocument;
  }
}

function testStreamingOutputSmoothnessOptimizations() {
  const realtime = fs.readFileSync(path.join(__dirname, '../../client/ui/realtime-renderer.js'), 'utf8');
  const message = fs.readFileSync(path.join(__dirname, '../../client/app/message-workflow.js'), 'utf8');
  const scroll = fs.readFileSync(path.join(__dirname, '../../client/app/scroll-focus-workflow.js'), 'utf8');
  const app = fs.readFileSync(path.join(__dirname, '../../app.js'), 'utf8');
  assert.ok(realtime.includes('const requestedIntervalMs') && realtime.includes('Math.max(16, requestedIntervalMs)'), 'explicit realtime render intervals such as 40ms should not be clamped back to the old 80ms default');
  assert.ok(!realtime.includes('Math.max(lowerBoundMs'), 'realtime renderer should not let the default lower bound override a tighter explicit stream interval');
  assert.ok(message.includes("const rawHash = chatStream ? '' : chatuiContentHash(rawValue)") && message.includes('dataset.streamingRawLength'), 'chat streaming updates should avoid full-response hash calculation on every chunk');
  assert.ok(message.includes("const managesStreamingOutput = !!(chatStream && streamSessionId)") && message.includes('setActiveOutputForSession(streamSessionId, e)') && message.includes('e.isConnected && !state.userScrollLocked && (!state.streamFocusLocked'), 'all chat streaming chunks should register the visible node as the active streaming output without rearming follow after manual scrolling');
  assert.ok(message.includes('s.noScroll && !managesStreamingOutput') && message.includes('else if (managesStreamingOutput)'), 'streaming updates should not run viewport-restore noScroll on every chunk; active-output follow should own scroll positioning');
  assert.ok(scroll.includes('let activeOutputRaf') && scroll.includes('pendingActiveOutput') && scroll.includes('lockToStreamingOutput(pending.node, pending.options)'), 'streaming output scroll follow should be coalesced into one rAF update');
  assert.ok(app.includes('if(!0===a.deferDomUpdate&&e===state.activeSessionId&&a.skipDisplayUpdate)return;let i=null'), 'active streaming chunks should not rescan the whole message DOM when the visible node and display update are already handled');
  const displayHistorySource = fs.readFileSync(path.join(__dirname, '../../client/app/display-history-workflow.js'), 'utf8');
  const sessionUiSource = fs.readFileSync(path.join(__dirname, '../../client/app/session-ui-workflow.js'), 'utf8');
  assert.ok(displayHistorySource.includes('const currentPending = (session.display || []).filter') && displayHistorySource.includes('const pendingIds = new Set') && displayHistorySource.includes('const pendingJobIds = new Set') && displayHistorySource.includes("node.__displayItem?.pending === '1'"), 'session switching must snapshot only canonical pending items while still capturing their latest DOM text/html/job fields');
  assert.ok(!displayHistorySource.includes("node.dataset.persist === '0'") && !displayHistorySource.includes('|| !!node.dataset.jobId'), 'completed nodes must never become pending again merely because they were created with skipSave or still carry a job id');
  assert.ok(sessionUiSource.includes('saveChatHistory(); saveDisplayHistory();'), 'new-session switching should persist canonical messages and pending tasks before replacing the visible DOM');
  assert.ok(app.includes('saveChatHistory(),saveDisplayHistory()'), 'root session switching should persist canonical messages and pending tasks without transient-display mode flags');
}

function testResumeStreamButtonAnchorsAboveComposer() {
  const scroll = fs.readFileSync(path.join(__dirname, '../../client/app/scroll-focus-workflow.js'), 'utf8');
  const css = fs.readFileSync(path.join(__dirname, '../../styles/composer.css'), 'utf8');
  const index = fs.readFileSync(path.join(__dirname, '../../index.html'), 'utf8');
  assert.ok(scroll.includes('button.style.setProperty("--resume-stream-left"'), 'resume stream button should still align horizontally with the composer');
  assert.ok(scroll.includes('button.style.setProperty("--resume-stream-bottom"') && scroll.includes('viewportHeight - composer.top + 10'), 'resume stream button should anchor from the live composer top, not a stale safe-area fallback');
  assert.ok(scroll.includes('state.userScrollLocked && away') && !scroll.includes('!state.streamFocusLocked || away'), 'resume stream button should only show after a real user scroll-away, not flicker during normal streaming auto-follow');
  assert.ok(css.includes('.resume-stream-btn') && css.includes('bottom:var(--resume-stream-bottom'), 'composer stylesheet should place the resume button above the input composer');
  assert.ok(index.includes('styles/composer.css?v=1.3.2-gpt5-reasoning-menu') && index.includes('scroll-focus-workflow.js?v=1.3.33'), 'cache-busting versions should be bumped for resume button positioning fixes');
}

function testHistoryAnchorLastQuestionSpacerClearsOnSubmit() {
  const featureSource = fs.readFileSync(path.join(__dirname, '../../client/features/history-anchor-nav.js'), 'utf8');
  const submit = fs.readFileSync(path.join(__dirname, '../../client/app/submit-workflow.js'), 'utf8');
  const index = fs.readFileSync(path.join(__dirname, '../../index.html'), 'utf8');
  const bundleSource = fs.readFileSync(path.join(__dirname, '../../server/services/static-bundle.service.js'), 'utf8');
  assert.ok(featureSource.includes('const isLastQuestionNode = node =>') && featureSource.includes('const pinLastQuestionToTop = isLastQuestionNode(node)'), 'history anchor should only add tail spacer when the clicked directory item is the last question that needs top pinning');
  assert.ok(featureSource.includes('if (pinLastQuestionToTop) ensureJumpScrollSpace(node, 18)') && featureSource.includes('if (!pinLastQuestionToTop) clearJumpScrollSpace()'), 'older directory jumps should not leave artificial tail space behind');
  assert.ok(featureSource.includes("markManualScroll?.({ type: 'history-anchor-nav', tailSpacer: pinLastQuestionToTop })"), 'history anchor should expose whether the jump used a tail spacer for debugging/state logic');
  assert.ok(submit.includes('root.ChatUIHistoryAnchorNav?.cancelPendingJump?.({ clearSpacer: true })'), 'submitting a new message should clear directory jump spacer and cancel delayed corrections before dynamic rendering');
  assert.ok(index.includes('history-anchor-nav.js?v=1.0.18') && index.includes('submit-workflow.js?v=1.2.89-session-model-routing') && index.includes('chatui.bundle.js?v=1.3.145-resilient-snapshot-store'), 'history spacer submit fix should bump browser cache versions');
  assert.ok(bundleSource.includes("BUNDLE_VERSION = '1.3.145-resilient-snapshot-store'"), 'server bundle version should match the directory spacer fix cache-busting');
}

function testHistoryAnchorNavFeature() {
  const feature = require('../../client/features/history-anchor-nav');
  assert.strictEqual(feature.normalizeQuestionTitle('## cursor 返回的以下几种事件...', 40), 'cursor 返回的以下几种事件...', 'question anchors should strip markdown heading markers');
  assert.strictEqual(feature.normalizeQuestionTitle('```js\nconsole.log(1)\n```\nMYSQL 如何查看表的所有列', 40), 'MYSQL 如何查看表的所有列', 'question anchors should ignore fenced code blocks in titles');

  const index = fs.readFileSync(path.join(__dirname, '../../index.html'), 'utf8');
  const bootstrap = fs.readFileSync(path.join(__dirname, '../../client/app/bootstrap-workflow.js'), 'utf8');
  const featureSource = fs.readFileSync(path.join(__dirname, '../../client/features/history-anchor-nav.js'), 'utf8');
  const css = fs.readFileSync(path.join(__dirname, '../../styles/flat-theme.css'), 'utf8');
  const app = fs.readFileSync(path.join(__dirname, '../../app.js'), 'utf8');
  const scroll = fs.readFileSync(path.join(__dirname, '../../client/app/scroll-focus-workflow.js'), 'utf8');
  assert.ok(index.includes('id="historyAnchorNav"'), 'history anchor nav container should be present in the main chat area');
  assert.ok(index.includes('history-anchor-nav is-empty'), 'history anchor nav should not reuse the legacy .empty placeholder class');
  assert.ok(index.indexOf('client/features/history-anchor-nav.js') < index.indexOf('client/app/bootstrap-workflow.js'), 'history anchor feature should load before bootstrap starts');
  assert.ok(bootstrap.includes('window.ChatUIHistoryAnchorNav?.init?.({messages:$(\'messages\'),nav:$(\'historyAnchorNav\')'), 'bootstrap should initialize the history anchor nav with the messages scroller');
  assert.ok(bootstrap.includes('getItems:()=>historyAnchorItemsFromState()') && bootstrap.includes('ensureItemNode:item=>ensureHistoryAnchorNode(item)'), 'history anchor nav should receive full session history items and a way to render missing nodes before jumping');
  assert.ok(bootstrap.includes('revealNode:revealNodeAboveComposer'), 'history anchor clicks should use the existing composer-aware reveal helper');
  assert.ok(featureSource.includes('const getItems = typeof options.getItems') && featureSource.includes('ensureItemNode') && featureSource.includes('fullItems.map'), 'history anchor nav should build the popup from full session history, not only currently rendered DOM nodes');
  assert.ok(featureSource.includes('isPopupOpen') && featureSource.includes('is-popup-hidden') && featureSource.includes('popupObserver'), 'history anchor nav should hide smoothly while app popups are open and restore after they close');
  assert.ok(featureSource.includes('const MIN_VISIBLE_ITEMS = 3') && featureSource.includes('items.length >= MIN_VISIBLE_ITEMS'), 'history anchor nav should stay hidden until there are at least three user message groups');
  assert.ok(featureSource.includes('const RAIL_MAX_HEIGHT_PX = 520') && featureSource.includes('const RAIL_VIEWPORT_RATIO = 0.66') && css.includes('--history-anchor-height:min(66vh,520px)'), 'history anchor nav should be tall enough for longer conversations');
  assert.ok(featureSource.includes('const railHeight = () => railMaxHeight()') && !featureSource.includes('count * RAIL_ROW_HEIGHT'), 'history anchor nav should use the maximum height as soon as it is visible instead of shrinking by item count');
  assert.ok(featureSource.includes('const RAIL_ROW_HEIGHT = 28') && featureSource.includes("nav.style.setProperty('--history-anchor-row-height'") && featureSource.includes('syncRailToList') && featureSource.includes('syncListToRail'), 'history anchor rail bars should align one-to-one with popup message rows and stay scroll-synced');
  assert.ok(featureSource.includes('history-anchor-toggle') && featureSource.includes("pointerenter', () => setExpanded(true)") && featureSource.includes("pointerleave', () => { if (!pinnedOpen) setExpanded(false); setHover(''); })") && featureSource.includes('let pinnedOpen = false'), 'history anchor nav should be collapsed by default and expand on hover/focus like a right-side document outline');
  assert.ok(!featureSource.includes('localStorage') && !featureSource.includes('chatui-history-anchor-open-v1'), 'history anchor nav should not persist expanded state; it should default to the collapsed right rail');
  assert.ok(featureSource.includes('let node = messageIndex ? userCache.byMessageIndex.get(messageIndex) || null : null;') && featureSource.includes('if (!node && id)') && featureSource.indexOf('let node = messageIndex ?') < featureSource.indexOf('if (!node && id)') && featureSource.indexOf('if (!node && id)') < featureSource.indexOf('if (!node && Number.isFinite(userIndex)'), 'history anchor item resolution should prefer stable messageIndex before anchor id and DOM userIndex so stale anchors cannot jump to the wrong question');
  assert.ok(featureSource.includes('root.ChatUIScrollDebug?.releaseBottomScrollLock'), 'history anchor jumps should release bottom lock before scrolling to older questions');
  assert.ok(app.includes('const t=e?.content??e?.rawText??e?.text??""'), 'history anchor titles should prefer canonical user message content before falling back to rawText');
  assert.ok(featureSource.includes('function normalizeQuestionTitle') && !featureSource.includes('title: ""'), 'history anchor titles should be normalized from real question text instead of empty fallback labels');
  assert.ok(featureSource.includes('messages.scrollTop = Math.max(0, offsetTopWithin(node) - 18)'), 'history anchor clicks should scroll the messages container directly, not the window');
  assert.ok(featureSource.includes('history-anchor-scroll-spacer') && featureSource.includes('ensureJumpScrollSpace(node, 18)') && featureSource.includes('setActive = id =>') && !featureSource.includes('id === activeId) return'), 'history anchor jumps should keep enough tail space and refresh active state even when the same id is clicked');
  assert.ok(featureSource.includes('let jumpScrollToken = 0') && featureSource.includes('cancelPendingJump') && featureSource.includes('clearJumpScrollSpace') && featureSource.includes('token !== jumpScrollToken') && scroll.includes('window.ChatUIHistoryAnchorNav?.cancelPendingJump?.({ clearSpacer: true })'), 'resume output focus should cancel any delayed history-anchor scroll corrections and spacer before pinning the active stream');
  assert.ok(app.includes('cleanupBottomScrollLock:()=>getScrollFocusWorkflow().cleanupBottomScrollLock()'), 'history anchor jumps should be able to clean up bottom-lock observers before scrolling upward');
  assert.ok(app.includes('releaseBottomScrollLock:e=>getScrollFocusWorkflow().releaseBottomScrollLock(e)'), 'history anchor jumps should be able to release bottom-lock state before scrolling upward');
  assert.ok(css.includes('--history-anchor-height') && css.includes('height:var(--history-anchor-height)') && css.includes('.history-anchor-nav') && css.includes('.history-anchor-nav.is-expanded .history-anchor-panel') && css.includes('.history-anchor-nav.is-popup-hidden') && css.includes('@media (max-width:840px)'), 'history anchor nav and popup should share identical height, hide smoothly under popups, and be hidden on mobile');
  assert.ok(featureSource.includes('history-anchor-head') && featureSource.includes('history-anchor-count') && featureSource.includes('消息目录'), 'history anchor popup should include a compact title/count header');
  assert.ok(css.includes('width:min(266px') && css.includes('border-radius:12px 0 0 12px') && css.includes('.history-anchor-head') && css.includes('.history-anchor-count') && css.includes('backdrop-filter:blur(18px)') && css.includes('--history-anchor-row-height') && css.includes('scrollbar-width:none'), 'history anchor nav should use a compact rounded translucent flat-theme panel with aligned rail rows');
  assert.ok(featureSource.includes('updateRailAlignment') && featureSource.includes("nav.style.setProperty('--history-anchor-rail-offset'") && featureSource.includes("nav.style.setProperty('--history-anchor-rail-bottom'"), 'history anchor rail should align its first/last bars to the popup list content area below the header');
  assert.ok(css.includes('--history-anchor-rail-offset') && css.includes('top:var(--history-anchor-rail-offset') && css.includes('bottom:var(--history-anchor-rail-bottom') && css.includes('.history-anchor-list') && css.includes('gap:0;'), 'history anchor rail/list should share the same vertical row grid without gap drift');
  assert.ok(css.includes('.history-anchor-toggle{') && css.includes('width:24px;') && css.includes('background:transparent;') && css.includes('border-radius:8px 0 0 8px;') && css.includes('border-radius .20s ease') && css.includes('.history-anchor-nav.is-expanded .history-anchor-toggle') && css.includes('width:32px;') && css.includes('border-radius:0 10px 10px 0'), 'history anchor rail should stay subtle and square while collapsed, then animate into the rounded expanded control');
  assert.ok(css.includes('.history-anchor-nav.is-expanded{') && !css.includes('.history-anchor-nav.is-expanded{\n  right:'), 'history anchor expansion should not move the fixed right edge, avoiding hover flicker at the rail boundary');
}

function testLargeMarkdownInitialRenderIsProgressive() {
  const message = fs.readFileSync(path.join(__dirname, '../../client/app/message-workflow.js'), 'utf8');
  const perf = fs.readFileSync(path.join(__dirname, '../../client/app/performance-workflow.js'), 'utf8');
  const css = fs.readFileSync(path.join(__dirname, '../../styles/flat-theme.css'), 'utf8');
  assert.ok(message.includes('function addMessageProgressive'), 'message creation should use a progressive render-capable addMessage path');
  assert.ok(message.includes('renderMarkdownProgressively(node, String(rawText || ""), node.dataset.rawHash)'), 'large initial assistant Markdown should render progressively after DOM insertion');
  assert.ok(message.includes('function renderMarkdownPreviewSnapshot'), 'large initial assistant Markdown should show a lightweight formatted preview immediately');
  assert.ok(message.includes('else if (progressive) renderMarkdownPreviewSnapshot(content, rawText);'), 'large initial assistant Markdown should not show a waiting/status placeholder before offscreen rendering finishes');
  assert.ok(!message.includes('正在分块挂载 Markdown'), 'large initial Markdown must not show a visible chunk-mounting status');
  assert.ok(!message.includes('markdown-progressive-status'), 'large initial Markdown must not use a visible progressive status placeholder');
  assert.ok(message.includes('function updateLiveMarkdownStream'), 'large streaming Markdown should have a live incremental Markdown path');
  assert.ok(message.includes('chatStream && shouldProgressiveRenderMarkdown(rawValue)'), 'large streaming Markdown should bypass per-token full Markdown rerendering while tokens arrive');
  assert.ok(message.includes('e.__markdownLiveStream.final(contentNode, rawValue)'), 'large streaming Markdown finalization should prefer incremental finalization');
  assert.ok(!message.includes('function updatePlainMarkdownStream'), 'large streaming Markdown should not degrade to a duplicate plain-text stream path');
  assert.ok(css.includes('.markdown-preview-lite') && css.includes('.markdown-preview-code'), 'lightweight Markdown preview should have dedicated stable preview styles');
  const scroll = fs.readFileSync(path.join(__dirname, '../../client/app/scroll-focus-workflow.js'), 'utf8');
  assert.ok(scroll.includes('raf(() => requestBottomScroll({ ...options, force: false, beforePaint: true, ignoreManualSuppress: false'), 'delayed bottom-lock correction should respect manual scroll suppression');
  assert.ok(scroll.includes('if (wheelDelta < -1 || event?.type === "touchmove")'), 'manual upward wheel/touch movement should be detected before async Markdown layout compensation runs');
  assert.ok(scroll.includes('releaseBottomScrollLock({ bumpVersion: true, suppressMs: 1600 })'), 'manual upward wheel/touch movement should immediately release bottom lock');
  assert.ok(message.includes('addMessage: addMessageProgressive'), 'workflow should export the progressive addMessage implementation');
  assert.ok(!perf.includes("if (raw.length > 8000 || raw.split('\\n').length > 180) return true;"), 'large Markdown should not be forced into lazy placeholder rendering');
}

function testEnglishImagePromptExtractionFollowsAiRouteWithCurrentImage() {
  const parsed = routeService.parseRouteResult(JSON.stringify(taskContractFixture({
    intent: 'image.generate',
    taskType: 'new_task',
    operation: 'image_reference_gen',
    resources: [{ type: 'image', source: 'current', role: 'reference', index: 1 }],
    currentIntent: 'generate a prompt from this image',
    finalInstruction: 'generate a prompt from this image',
    confidence: 0.9,
  })), {
    input: 'generate a prompt from this image',
    attachments: [{ name: 'room.png', type: 'image/png', is_image: true }],
    context: { image_candidates: [] },
  });
  assert.strictEqual(parsed.mode, 'image');
  assert.strictEqual(parsed.operationType, 'image_reference_gen');
  assert.strictEqual(parsed.imageRefs[0].source, 'current');
}

function testImageOnlyAssistantMessageCanBeQuotedWithImageContext() {
  const state = { activeSessionId: 's1', quotedMessage: null };
  const node = {
    classList: { contains: name => name === 'assistant', add: () => {}, remove: () => {} },
    dataset: { responseIndex: '1', rawText: '[base64 image] [base64 image] 耗时：1m 29s' },
    __displayItem: {},
    querySelector: () => null,
    textContent: '',
  };
  const workflow = messageWorkflow.createMessageWorkflow({
    state,
    document: { querySelectorAll: () => [] },
    $: id => id === 'prompt' ? ({ focus: () => {} }) : null,
    getAssistantImageContext: () => ({
      prompt: '生成两张圆形图片',
      mode: 'image',
      target: 'previous',
      referenceId: 'imgref_latest',
      attachments: [
        { name: 'red.png', type: 'image/png', src: 'indexeddb://red', imageId: 'img_imgref_latest_1', referenceId: 'imgref_latest' },
        { name: 'yellow.png', type: 'image/png', src: 'indexeddb://yellow', imageId: 'img_imgref_latest_2', referenceId: 'imgref_latest' },
      ],
    }),
  });
  workflow.selectQuotedMessage(node);
  assert.ok(state.quotedMessage, 'image-only assistant message should be quoteable');
  assert.strictEqual(state.quotedMessage.content, '[图片消息]');
  const parsed = JSON.parse(state.quotedMessage.imageContext);
  assert.strictEqual(parsed.attachments.length, 2);
  assert.strictEqual(parsed.attachments[1].imageId, 'img_imgref_latest_2');
}

function testEmptyAssistantImageContextFallsBackToGeneratedThumbs() {
  const state = { activeSessionId: 's1', quotedMessage: null, sessions: [{ id: 's1', messages: [], display: [] }] };
  const emptyImageContext = JSON.stringify({ prompt: '生成两张图', mode: 'image', target: 'new', attachments: [] });
  const node = {
    classList: { contains: name => name === 'assistant', add: () => {}, remove: () => {} },
    dataset: { responseIndex: '1', rawText: '[base64 image] 耗时：1s', imageContext: emptyImageContext },
    __displayItem: { imageContext: emptyImageContext },
    querySelector: () => null,
    textContent: '',
  };
  const workflow = messageWorkflow.createMessageWorkflow({
    state,
    document: { querySelectorAll: () => [] },
    $: () => null,
    getAssistantImageContext: () => ({
      prompt: '生成两张图',
      mode: 'image',
      target: 'previous',
      referenceId: 'imgref_latest',
      attachments: [
        { name: 'one.png', type: 'image/png', src: 'indexeddb://one', imageId: 'img_imgref_latest_1', referenceId: 'imgref_latest' },
        { name: 'two.png', type: 'image/png', src: 'indexeddb://two', imageId: 'img_imgref_latest_2', referenceId: 'imgref_latest' },
      ],
    }),
  });
  const quote = workflow.resolveQuoteContextForNode(node);
  assert.strictEqual(quote.content, '[图片消息]');
  const parsed = JSON.parse(quote.imageContext);
  assert.strictEqual(parsed.attachments.length, 2);
  assert.strictEqual(parsed.attachments[1].imageId, 'img_imgref_latest_2');
}

function testQuoteResolverUsesCanonicalAndDisplayContext() {
  const imageContext = JSON.stringify({
    prompt: '生成两张图',
    mode: 'image',
    target: 'previous',
    referenceId: 'imgref_latest',
    attachments: [{ name: 'second.png', type: 'image/png', src: 'indexeddb://second', imageId: 'img_imgref_latest_2', referenceId: 'imgref_latest' }],
  });
  const attachmentContext = JSON.stringify({ attachments: [{ id: 'att_1', name: 'a.txt', type: 'text/plain', text: 'hello' }] });
  const state = {
    activeSessionId: 's1',
    quotedMessage: null,
    sessions: [{
      id: 's1',
      messages: [
        { role: 'user', content: 'x' },
        { role: 'assistant', content: '[图片生成完成] 一只猫', rawText: '[图片生成完成] 一只猫 RT 1s', imageContext },
      ],
      display: [{ id: 'd1', role: 'assistant', responseIndex: '1', rawText: '[base64 image] TTFT 1s', attachmentContext }],
    }],
  };
  const workflow = messageWorkflow.createMessageWorkflow({ state, document: { querySelectorAll: () => [] }, $: () => null });
  const node = { classList: { contains: name => name === 'assistant', add: () => {}, remove: () => {} }, dataset: { displayItemId: 'd1', responseIndex: '1' }, __displayItem: null, querySelector: () => null, textContent: '' };
  const quote = workflow.resolveQuoteContextForNode(node);
  assert.strictEqual(quote.content, '[图片消息]');
  assert.strictEqual(JSON.parse(quote.imageContext).attachments[0].imageId, 'img_imgref_latest_2');
  assert.strictEqual(JSON.parse(quote.attachmentContext).attachments[0].id, 'att_1');
}


function testAttachmentPresentationRebuildsFromCanonicalDescriptors() {
  const attachmentContext = JSON.stringify({
    prompt: '',
    content: '[attachments]',
    attachments: [
      { id: 'mail', name: 'mail.txt', type: 'text/plain', src: 'indexeddb://attachment-mail' },
      { id: 'sheet', name: 'budget.xlsx', type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet', src: 'indexeddb://attachment-budget' },
    ],
  });
  const message = messageRecords.normalizeCanonicalMessage({
    role: 'user',
    content: '[attachments]',
    rawText: '\u5df2\u53d1\u9001\u9644\u4ef6',
    attachmentContext,
    messageIndex: '0',
  }, { sessionId: 'attachment-session', sequence: 0 });
  assert.strictEqual(message.presentation.kind, 'attachment');
  assert.strictEqual(message.presentation.displayText, '\u9644\u4ef6\uff1amail.txt\u3001budget.xlsx');
  assert.deepStrictEqual(message.presentation.attachments.map(item => item.name), ['mail.txt', 'budget.xlsx']);
  assert.notStrictEqual(message.presentation.displayText, '\u5df2\u53d1\u9001\u9644\u4ef6');
}

function testCanonicalRendererPrefersImageDescriptorsOverStaleHtml() {
  const calls = [];
  const state = { activeSessionId: 'renderer-session', reasoningMode: false };
  const workflow = displayHistoryWorkflow.createDisplayHistoryWorkflow({
    state,
    $: () => null,
    document: {},
    messageRecords,
    extractQuoteContextFromHtml: () => '',
    displayItemHasRichMedia: item => /generated-image-grid|generated-thumb/.test(String(item?.html || '')),
    addMessage: (role, content, options) => {
      calls.push({ role, content, options });
      return { dataset: {} };
    },
  });
  workflow.renderMessageFromCanonical({ id: state.activeSessionId }, {
    role: 'assistant',
    content: '[\u56fe\u7247\u751f\u6210\u5b8c\u6210] cat',
    rawText: '[base64 image] \u8017\u65f6\uff1a2m 6s',
    html: '<p>[base64 image] \u8017\u65f6\uff1a2m 6s</p>',
    responseIndex: '1',
    imageContext: JSON.stringify({
      prompt: 'cat',
      attachments: [{ name: 'cat.png', type: 'image/png', src: 'indexeddb://generated-cat', width: 512, height: 512 }],
    }),
  }, 1);
  assert.strictEqual(calls.length, 1);
  assert.strictEqual(calls[0].options.html, true);
  assert.ok(calls[0].content.includes('generated-image-grid'), 'durable image descriptors should rebuild the generated-image UI');
  assert.ok(calls[0].content.includes('indexeddb://generated-cat'), 'the descriptor-backed durable image reference must be rendered');
  assert.ok(!calls[0].content.includes('[base64 image]'), 'stale placeholder HTML must not override canonical image descriptors');
}

function testCanonicalRendererPrefersAttachmentDescriptorsOverGenericHtml() {
  const calls = [];
  const state = { activeSessionId: 'renderer-attachment-session', reasoningMode: false };
  const workflow = displayHistoryWorkflow.createDisplayHistoryWorkflow({
    state,
    $: () => null,
    document: {},
    messageRecords,
    extractQuoteContextFromHtml: () => '',
    displayItemHasRichMedia: () => true,
    renderUserMessageWithAttachments: (text, attachments) => `<div class="rebuilt-attachments">${text}|${attachments.map(item => item.name).join(',')}</div>`,
    addMessage: (role, content, options) => {
      calls.push({ role, content, options });
      return { dataset: {} };
    },
  });
  workflow.renderMessageFromCanonical({ id: state.activeSessionId }, {
    role: 'user',
    content: '[attachments]',
    rawText: '\u5df2\u53d1\u9001\u9644\u4ef6',
    html: '<p>\u5df2\u53d1\u9001\u9644\u4ef6</p>',
    messageIndex: '0',
    attachmentContext: JSON.stringify({
      attachments: [
        { id: 'mail', name: 'mail.txt', type: 'text/plain', src: 'indexeddb://attachment-mail' },
        { id: 'sheet', name: 'budget.xlsx', type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' },
      ],
    }),
  }, 0);
  assert.strictEqual(calls.length, 1);
  assert.strictEqual(calls[0].options.html, true);
  assert.ok(calls[0].content.includes('mail.txt,budget.xlsx'), 'attachment descriptors should restore file names even when persisted HTML is generic');
  assert.ok(!calls[0].content.includes('<p>\u5df2\u53d1\u9001\u9644\u4ef6</p>'), 'generic attachment HTML must remain only a compatibility fallback');
}

function testCanonicalBrowserRendererDependenciesAreSharedAndDefined() {
  const app = fs.readFileSync(path.join(__dirname, '../../app.js'), 'utf8');
  assert.ok(
    app.includes('function downloadAllImagesButtonHtml(){return downloadImageButtonHtml('),
    'the browser bundle must define the canonical image renderer dependency before wiring the workflow'
  );
  assert.ok(
    app.includes('renderUserMessageWithAttachments,downloadAllImagesButtonHtml}))'),
    'the canonical history workflow must receive the shared download-all action renderer'
  );
  assert.ok(
    app.includes('makeImageItemId,downloadAllImagesButtonHtml,saveLatestGeneratedImage'),
    'live and restored image rendering must use the same action renderer dependency'
  );
  assert.ok(
    !app.includes('downloadAllImagesButtonHtml:()=>downloadImageButtonHtml'),
    'the download-all renderer must not be duplicated as an anonymous live-only implementation'
  );
}

async function testActiveSessionMessagesUseOneCanonicalCommitBoundary() {
  const storage = { getItem: () => null, setItem: () => {}, removeItem: () => {} };
  const session = { ...appState.createSession('active'), id: 'active-session', messages: [{ role: 'user', content: 'old' }] };
  const state = { sessions: [session], activeSessionId: session.id, messages: [{ role: 'user', content: 'stale working copy' }], models: [], reasoningMode: false };
  const workflow = sessionDisplay.createSessionDisplayWorkflow({
    getState: () => state,
    getActiveSession: () => session,
    createSession: appState.createSession,
    deriveSessionTitle: item => item.title || '\u65b0\u5bf9\u8bdd',
    sessionStorageKey: (key, sessionId = state.activeSessionId) => `${key}:${sessionId}`,
    readJsonStorage: (_key, fallback) => fallback,
    safeSetJsonStorage: (_key, value) => value,
    compactDisplayItems: items => items,
    compactAdjacentDuplicateMessages: items => items,
    sanitizeStoredDisplayItem: item => item,
    sanitizeStoredMessage: item => item,
    renderSessionList: () => {},
    localStorage: storage,
    messageRecords,
    snapshotStore: { schedulePut: async () => {} },
    constants: { CHAT_KEY: 'chat', UI_KEY: 'ui', SESSIONS_KEY: 'sessions', ACTIVE_SESSION_KEY: 'active' },
  });
  const next = [
    { role: 'user', content: 'question', messageIndex: '0' },
    { role: 'assistant', content: 'answer', responseIndex: '1' },
  ];
  await workflow.saveSessionMessages(session.id, next);
  assert.strictEqual(state.messages, session.messages, 'active working state must point at the canonical list committed by saveSessionMessages');
  assert.deepStrictEqual(state.messages.map(item => item.content), ['question', 'answer']);
  const source = fs.readFileSync(path.join(__dirname, '../../app.js'), 'utf8');
  assert.ok(source.includes('function activeSessionMessages(){return Array.isArray(state.messages)?cloneMessageList(state.messages):[]}'), 'active-session saves should use the explicit working source');
  assert.ok(!source.includes('e.length>=s.length?e:s'), 'message ownership must not be selected by a longer-array heuristic');
  assert.ok(source.includes('function saveChatHistory(){const e=getActiveSession();if(e)return saveSessionMessages(e.id,activeSessionMessages())}'), 'saveChatHistory must delegate to the same canonical commit boundary without cloning a second owner');
  assert.match(source, /async function clearChat\(\)\{[^}]*await getSessionDisplayWorkflow\(\)\.commitSession\(e\)/, 'clearing a chat must commit the complete empty session body once');
  assert.ok(!source.includes('const s=saveSessionMessages(e.id,[]),n=persistSessionDisplay(e.id)'), 'clearing a chat must not enqueue duplicate snapshots');
}

function testCanonicalPresentationSanitizesTransientMediaReferences() {
  const durableContext = JSON.stringify({
    prompt: 'cat',
    mode: 'image',
    attachments: [{
      name: 'cat.png',
      type: 'image/png',
      src: 'indexeddb://cat-image',
      dataUrl: 'data:image/png;base64,temporary',
      objectUrl: 'blob:temporary-object',
    }],
  });
  const sanitized = sessionPersistence.sanitizeStoredMessage({
    role: 'assistant',
    content: '[\u56fe\u7247\u751f\u6210\u5b8c\u6210] cat',
    imageContext: durableContext,
    presentation: {
      kind: 'image-result',
      html: '<img src="blob:temporary-preview" data-persisted-src="indexeddb://cat-image">',
      images: [{ src: 'data:image/png;base64,temporary', url: 'indexeddb://cat-image', objectUrl: 'blob:temporary-object' }],
    },
  }, { stripLargeDataUrlsFromText });
  const parsedContext = JSON.parse(sanitized.imageContext);
  assert.strictEqual(parsedContext.attachments[0].src, 'indexeddb://cat-image');
  assert.strictEqual(parsedContext.attachments[0].dataUrl, '');
  assert.strictEqual(parsedContext.attachments[0].objectUrl, '');
  assert.ok(!sanitized.presentation.html.includes('blob:'), 'presentation HTML must not persist page-scoped blob URLs');
  assert.strictEqual(sanitized.presentation.images[0].src, '');
  assert.strictEqual(sanitized.presentation.images[0].url, 'indexeddb://cat-image');

  const normalized = messageRecords.normalizeCanonicalMessage(sanitized, { sessionId: 'sanitized-image', sequence: 0 });
  assert.strictEqual(normalized.presentation.images[0].src, 'indexeddb://cat-image', 'canonical presentation should rebuild from durable context rather than transient HTML');
}

function testSessionQuotaFailureNeverTruncatesCanonicalHistory() {
  let removed = 0;
  const storage = {
    setItem() {
      const error = new Error('Quota exceeded');
      error.name = 'QuotaExceededError';
      throw error;
    },
    removeItem() { removed += 1; },
  };
  const history = Array.from({ length: 120 }, (_, index) => ({ role: 'user', content: `message-${index}`, messageIndex: String(index) }));
  const originalWarn = console.warn;
  console.warn = () => {};
  try {
    const returned = sessionPersistence.safeSetJsonStorage('history', history, 5, storage);
    assert.strictEqual(returned, history);
    assert.strictEqual(returned.length, 120);
    assert.strictEqual(removed, 0, 'quota fallback must keep the previous backup instead of deleting it');
  } finally {
    console.warn = originalWarn;
  }
}

function testPendingDisplaySnapshotCannotOverwriteCanonicalMessages() {
  const dom = new JSDOM(`<!doctype html><div id="messages">
    <div class="message assistant" data-persist="0" data-display-item-id="completed-display" data-job-id="completed-job" data-raw-text="completed"><div class="content">completed</div></div>
    <div class="message assistant" data-persist="0" data-display-item-id="pending-display" data-job-id="pending-job" data-raw-text="latest pending"><div class="content">latest pending</div></div>
  </div>`);
  const document = dom.window.document;
  const completedNode = document.querySelector('[data-display-item-id="completed-display"]');
  const pendingNode = document.querySelector('[data-display-item-id="pending-display"]');
  completedNode.__displayItem = { id: 'completed-display', role: 'assistant', rawText: 'completed', jobId: 'completed-job', pending: '' };
  pendingNode.__displayItem = { id: 'pending-display', role: 'assistant', rawText: 'stale pending', html: 'stale pending', jobId: 'pending-job', responseIndex: '7', pending: '1' };
  const canonicalMessages = Array.from({ length: 18 }, (_, index) => ({ role: index % 2 ? 'assistant' : 'user', content: `canonical-${index}`, sequence: index }));
  const session = { id: 'pending-only', messages: canonicalMessages, display: [pendingNode.__displayItem], updatedAt: 1 };
  const before = JSON.parse(JSON.stringify(session.messages));
  let persisted = 0;
  const workflow = displayHistoryWorkflow.createDisplayHistoryWorkflow({
    state: { activeSessionId: session.id, reasoningMode: false },
    document,
    $: id => document.getElementById(id),
    getActiveSession: () => session,
    compactDisplayItems: items => items,
    makeDisplayItemId: () => 'generated-display-id',
    persistSessionDisplay: () => { persisted += 1; },
    sanitizeStoredDisplayItem: item => ({ ...item }),
    readMessageMetaText: () => '',
  });
  workflow.saveDisplayHistory();
  assert.deepStrictEqual(session.messages, before, 'DOM serialization must never replace or truncate canonical completed messages');
  assert.strictEqual(session.display.length, 1);
  assert.strictEqual(session.display[0].id, 'pending-display');
  assert.strictEqual(session.display[0].rawText, 'latest pending');
  assert.strictEqual(session.display[0].pending, '1');
  assert.strictEqual(completedNode.__displayItem.pending, '', 'a completed skipSave node must not be reclassified as pending');
  assert.strictEqual(persisted, 1);
}

async function testSessionSnapshotPersistsFullCanonicalHistoryAndPendingOnly() {
  const storageMap = new Map();
  const storage = {
    getItem: key => storageMap.get(key) || null,
    setItem: (key, value) => storageMap.set(key, String(value)),
    removeItem: key => storageMap.delete(key),
  };
  const messages = Array.from({ length: 64 }, (_, index) => ({
    role: index % 2 ? 'assistant' : 'user',
    content: `canonical-${index}`,
    ...(index % 2 ? { responseIndex: String(index) } : { messageIndex: String(index) }),
  }));
  const session = {
    ...appState.createSession('snapshot'),
    id: 'snapshot-session',
    messages: [],
    display: [
      { id: 'completed', role: 'assistant', rawText: 'done', pending: '' },
      { id: 'pending', role: 'assistant', rawText: 'running', jobId: 'job-running', pending: '1' },
    ],
  };
  const state = { sessions: [session], activeSessionId: session.id, messages: [], models: [], reasoningMode: false };
  let writtenSnapshot = null;
  const workflow = sessionDisplay.createSessionDisplayWorkflow({
    getState: () => state,
    getActiveSession: () => session,
    createSession: appState.createSession,
    deriveSessionTitle: item => item.title || '\u65b0\u5bf9\u8bdd',
    sessionStorageKey: (key, sessionId = state.activeSessionId) => `${key}:${sessionId}`,
    readJsonStorage: (key, fallback) => { try { return JSON.parse(storage.getItem(key) || ''); } catch { return fallback; } },
    safeSetJsonStorage: (key, value) => { storage.setItem(key, JSON.stringify(value)); return value; },
    compactDisplayItems: items => items,
    compactAdjacentDuplicateMessages: sessionPersistence.compactAdjacentDuplicateMessages,
    sanitizeStoredDisplayItem: item => sessionPersistence.sanitizeStoredDisplayItem(item, { stripLargeDataUrlsFromText }),
    sanitizeStoredMessage: message => sessionPersistence.sanitizeStoredMessage(message, { stripLargeDataUrlsFromText }),
    renderSessionList: () => {},
    makeDisplayItemId: () => 'display-id',
    localStorage: storage,
    messageRecords,
    sessionStoreApi: sessionStore,
    snapshotStore: { schedulePut: async snapshot => { writtenSnapshot = JSON.parse(JSON.stringify(snapshot)); } },
    constants: { CHAT_KEY: 'chat', UI_KEY: 'ui', SESSIONS_KEY: 'sessions', ACTIVE_SESSION_KEY: 'active' },
  });
  await workflow.saveSessionMessages(session.id, messages);
  assert.strictEqual(session.messages.length, 64);
  assert.strictEqual(writtenSnapshot.messages.length, 64, 'IndexedDB snapshot must store the complete canonical history, not a rendered tail');
  assert.deepStrictEqual(writtenSnapshot.pendingDisplay.map(item => item.id), ['pending']);
  assert.ok(writtenSnapshot.updatedAt === session.snapshotUpdatedAt && session.snapshotUpdatedAt > 0);
  assert.strictEqual(storageMap.has(`chat:${session.id}`), false, 'canonical session history must not be duplicated into localStorage');
  assert.strictEqual(storageMap.has(`ui:${session.id}`), false, 'pending display state must live in the same IndexedDB snapshot');
}

function createSessionRevisionTestWorkflow({ state, storage, snapshotStore }) {
  return sessionDisplay.createSessionDisplayWorkflow({
    getState: () => state,
    getActiveSession: () => state.sessions.find(item => item.id === state.activeSessionId),
    createSession: appState.createSession,
    deriveSessionTitle: item => item.title || '\u65b0\u5bf9\u8bdd',
    sessionStorageKey: (key, sessionId = state.activeSessionId) => `${key}:${sessionId}`,
    readJsonStorage: (key, fallback) => { try { return JSON.parse(storage.getItem(key) || ''); } catch { return fallback; } },
    compactDisplayItems: items => items,
    compactAdjacentDuplicateMessages: sessionPersistence.compactAdjacentDuplicateMessages,
    sanitizeStoredDisplayItem: item => item,
    sanitizeStoredMessage: message => message,
    renderSessionList: () => {},
    localStorage: storage,
    messageRecords,
    sessionStoreApi: sessionStore,
    snapshotStore,
    constants: { CHAT_KEY: 'chat', UI_KEY: 'ui', LAST_IMAGE_KEY: 'image', SESSIONS_KEY: 'sessions', ACTIVE_SESSION_KEY: 'active' },
  });
}

async function testUncommittedMetadataRevisionCannotHideLateSnapshot() {
  const values = new Map();
  const storage = {
    getItem: key => values.has(key) ? values.get(key) : null,
    setItem: (key, value) => values.set(key, String(value)),
    removeItem: key => values.delete(key),
  };
  const sessionId = 'late-snapshot-session';
  values.set('sessions', JSON.stringify([{
    id: sessionId,
    title: 'late snapshot',
    updatedAt: 5000,
    // 300 was requested before refresh, but neither local backup nor IndexedDB
    // had confirmed that revision when this page loaded.
    snapshotUpdatedAt: 300,
    persistenceUpdatedAt: 300,
    chatBackupUpdatedAt: 100,
    displayBackupUpdatedAt: 100,
  }]));
  values.set('active', sessionId);
  values.set(`chat:${sessionId}`, JSON.stringify({
    backupVersion: 2,
    updatedAt: 100,
    data: [{ role: 'user', content: 'very old local backup', messageIndex: '0' }],
  }));
  values.set(`ui:${sessionId}`, JSON.stringify({ backupVersion: 2, updatedAt: 100, data: [] }));
  let snapshot = {
    id: sessionId,
    snapshotVersion: 2,
    updatedAt: 200,
    messages: [{ role: 'user', content: 'durable before refresh', messageIndex: '0' }],
    pendingDisplay: [],
  };
  const state = { sessions: [], activeSessionId: '', messages: [], models: [], reasoningMode: false };
  const workflow = createSessionRevisionTestWorkflow({
    state,
    storage,
    snapshotStore: { supported: true, getSnapshot: async () => JSON.parse(JSON.stringify(snapshot)) },
  });

  await workflow.loadSessions();
  const loaded = state.sessions[0];
  assert.deepStrictEqual(loaded.messages.map(item => item.content), ['durable before refresh']);
  assert.strictEqual(loaded.snapshotUpdatedAt, 200, 'an attempted metadata revision must not masquerade as a durable snapshot revision');
  assert.strictEqual(loaded.persistenceUpdatedAt, 300, 'the requested revision is retained separately for monotonic future writes');

  snapshot = {
    ...snapshot,
    updatedAt: 300,
    messages: [
      { role: 'user', content: 'durable before refresh', messageIndex: '0' },
      { role: 'assistant', content: 'late committed answer', responseIndex: '1' },
    ],
  };
  const reloaded = await workflow.reloadSessionSnapshot(sessionId);
  assert.strictEqual(reloaded, true, 'a late IndexedDB commit must still be eligible after the page has loaded');
  assert.deepStrictEqual(loaded.messages.map(item => item.content), ['durable before refresh', 'late committed answer']);
  assert.strictEqual(loaded.updatedAt, 5000, 'snapshot revisions must remain independent from user-facing session metadata timestamps');
}

async function testSnapshotReloadUsesIndependentRevisionTimestamp() {
  const storage = { getItem: () => null, setItem: () => {}, removeItem: () => {} };
  const session = {
    ...appState.createSession('revision'),
    id: 'revision-session',
    messages: [{ role: 'user', content: 'old', messageIndex: '0' }],
    updatedAt: 5000,
    snapshotUpdatedAt: 100,
  };
  const state = { sessions: [session], activeSessionId: session.id, messages: [], models: [], reasoningMode: false };
  const workflow = sessionDisplay.createSessionDisplayWorkflow({
    getState: () => state,
    getActiveSession: () => session,
    createSession: appState.createSession,
    deriveSessionTitle: item => item.title || '\u65b0\u5bf9\u8bdd',
    sessionStorageKey: (key, sessionId = state.activeSessionId) => `${key}:${sessionId}`,
    readJsonStorage: (_key, fallback) => fallback,
    safeSetJsonStorage: (_key, value) => value,
    compactDisplayItems: items => items,
    compactAdjacentDuplicateMessages: sessionPersistence.compactAdjacentDuplicateMessages,
    sanitizeStoredDisplayItem: item => item,
    sanitizeStoredMessage: message => message,
    renderSessionList: () => {},
    localStorage: storage,
    messageRecords,
    snapshotStore: {
      getSnapshot: async () => ({
        id: session.id,
        snapshotVersion: 2,
        updatedAt: 200,
        messages: [
          { role: 'user', content: 'new question', messageIndex: '0' },
          { role: 'assistant', content: 'new answer', responseIndex: '1' },
        ],
        pendingDisplay: [],
      }),
    },
  });
  const reloaded = await workflow.reloadSessionSnapshot(session.id);
  assert.strictEqual(reloaded, true, 'new snapshots must be compared with snapshotUpdatedAt, not unrelated metadata updatedAt');
  assert.deepStrictEqual(session.messages.map(item => item.content), ['new question', 'new answer']);
  assert.strictEqual(session.snapshotUpdatedAt, 200);
  assert.strictEqual(session.updatedAt, 5000, 'newer metadata timestamps should remain intact after loading a message snapshot');
}

async function testSessionPromptDraftPersistsPerSession() {
  const store = new Map();
  const storage = {
    getItem: key => store.has(key) ? store.get(key) : null,
    setItem: (key, value) => store.set(key, String(value)),
    removeItem: key => store.delete(key),
  };
  const state = { sessions: [], activeSessionId: '', models: [] };
  const sessionA = { ...appState.createSession('A', () => 1000, () => 0.111111), id: 'session-a', promptDraft: 'A 草稿' };
  const sessionB = { ...appState.createSession('B', () => 2000, () => 0.222222), id: 'session-b', promptDraft: 'B 草稿' };
  state.sessions = [sessionA, sessionB];
  state.activeSessionId = sessionA.id;
  const workflow = sessionDisplay.createSessionDisplayWorkflow({
    getState: () => state,
    getActiveSession: () => state.sessions.find(item => item.id === state.activeSessionId),
    createSession: appState.createSession,
    deriveSessionTitle: session => session.title || '新对话',
    sessionStorageKey: (key, sessionId = state.activeSessionId) => `${key}:${sessionId}`,
    readJsonStorage: (key, fallback) => { try { return JSON.parse(storage.getItem(key) || ''); } catch { return fallback; } },
    safeSetJsonStorage: (key, value) => { storage.setItem(key, JSON.stringify(value)); return value; },
    compactDisplayItems: items => items,
    compactAdjacentDuplicateMessages: messages => messages,
    sanitizeStoredDisplayItem: item => item,
    sanitizeStoredMessage: message => message,
    renderSessionList: () => {},
    makeDisplayItemId: () => 'display-id',
    localStorage: storage,
    constants: { SESSIONS_KEY: 'sessions', ACTIVE_SESSION_KEY: 'active' },
  });
  workflow.saveSessionsMeta();
  const meta = JSON.parse(storage.getItem('sessions'));
  assert.strictEqual(meta.find(item => item.id === 'session-a').promptDraft, 'A 草稿');
  assert.strictEqual(meta.find(item => item.id === 'session-b').promptDraft, 'B 草稿');

  state.sessions = [];
  state.activeSessionId = '';
  await workflow.loadSessions();
  assert.strictEqual(state.sessions.find(item => item.id === 'session-a').promptDraft, 'A 草稿');
  assert.strictEqual(state.sessions.find(item => item.id === 'session-b').promptDraft, 'B 草稿');
}

function testLegacyDocSupportIsRoutedToWordExtractor() {
  assert.strictEqual(extractApi.fileKind('Mysql实用手册.doc', 'application/msword'), 'office');
  assert.strictEqual(require('../../client/app/attachments-workflow').canExtractOfficeText({ name: 'Mysql实用手册.doc', type: 'application/msword' }), true);
  assert.strictEqual(typeof officeExtract.extractLegacyDocWithWordExtractor, 'function');
}

function testResponseMetricsTextIsUnified() {
  assert.strictEqual(formatting.responseMetricsText({ firstTokenMs: 37, durationMs: 5678 }), 'TTFT 37ms · RT 5.7s');
  assert.strictEqual(formatting.responseMetricsText({ firstTokenMs: 1234, durationMs: 5678 }), 'TTFT 1.2s · RT 5.7s');
  assert.strictEqual(formatting.responseMetricsText({ durationMs: 61000, includeFirstToken: false }), 'RT 1m 1s');
  const metrics = require('../../client/services/chat-service').extractChatJobText({ metrics: { firstTokenMs: 100, durationMs: 220 }, choices: [{ message: { content: 'ok' } }] });
  assert.strictEqual(metrics.firstTokenMs, 100);
  assert.strictEqual(metrics.durationMs, 220);
}

function testRouteDiagramLauncherUsesModal() {
  const dom = new JSDOM(`<!doctype html><body>
    <button id="routeDiagramFab" aria-expanded="false"></button>
    <div id="routeDiagramModal" aria-hidden="true"><button id="closeRouteDiagramBtn" data-route-diagram-close></button><div data-route-diagram-close></div><iframe id="routeDiagramFrame"></iframe></div>
  </body>`, { url: 'http://localhost/' });
  const document = dom.window.document;
  const trigger = document.getElementById('routeDiagramFab');
  const modal = document.getElementById('routeDiagramModal');
  const frame = document.getElementById('routeDiagramFrame');
  const controller = routeDiagramWorkflow.createRouteDiagramWorkflow({ document });
  controller.init();
  trigger.focus();
  trigger.click();
  assert.strictEqual(controller.isOpen(), true);
  assert.ok(modal.classList.contains('show'));
  assert.strictEqual(modal.getAttribute('aria-hidden'), 'false');
  assert.strictEqual(trigger.getAttribute('aria-expanded'), 'true');
  assert.strictEqual(frame.getAttribute('src'), './route.html?v=1.1.3-title-map');
  document.dispatchEvent(new dom.window.KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
  assert.strictEqual(controller.isOpen(), false);
  assert.strictEqual(modal.getAttribute('aria-hidden'), 'true');
  assert.strictEqual(trigger.getAttribute('aria-expanded'), 'false');
  assert.strictEqual(document.activeElement, trigger);
  assert.ok(fs.existsSync(path.join(__dirname, '../../route.html')), 'the intent-recognition diagram page should be shipped with the app');
  assert.strictEqual(staticHttp.isPublicStaticPath('/route.html'), true, 'the diagram page should be available through the static server');
  assert.ok(fs.readFileSync(path.join(__dirname, '../../route.html'), 'utf8').includes('m17 14 10 10-10 10-10-10Z'), 'the first-pass route card should use a clear decision-and-branch icon');
  const routeDiagram = fs.readFileSync(path.join(__dirname, '../../route.html'), 'utf8');
  assert.ok(routeDiagram.includes('fallback stays inside the route card') && routeDiagram.includes('x="1041" y="572" width="208" height="18"'), 'the fallback route should stay inside the first-pass route card rather than covering another stage');
  assert.ok(!routeDiagram.includes('x="1023" y="346" width="244" height="56"'), 'the old floating fallback callout should not overlap the preceding stage');
  assert.ok(!formatting.pendingFeedbackHtml('?????????').includes('pending-route-link'), 'route preflight waiting text should stay focused on task status');
  const index = fs.readFileSync(path.join(__dirname, '../../index.html'), 'utf8');
  const css = fs.readFileSync(path.join(__dirname, '../../styles/flat-theme.css'), 'utf8');
  assert.ok(index.includes('id="routeDiagramFab"') && index.includes('id="routeDiagramModal"') && index.includes('route-diagram-workflow.js'), 'the page should ship the persistent flow entry and modal controller');
  assert.ok(css.includes('.route-diagram-fab{') && css.includes('.route-diagram-modal.show{'), 'the flow entry and modal should have dedicated responsive styles');
}

function testImageCompletionKeepsLiveMediaVisibleBeforeHydration() {
  const imageWorkflow = fs.readFileSync(path.join(__dirname, '../../client/app/image-workflow.js'), 'utf8');
  const messageWorkflow = fs.readFileSync(path.join(__dirname, '../../client/app/message-workflow.js'), 'utf8');
  assert.ok(imageWorkflow.includes('preserveLiveMedia:!0'), 'image completion should request immediate media rendering for the active message');
  assert.ok(messageWorkflow.includes('s.preserveLiveMedia ? String(t || "") : stripTransientBlobUrlsFromHtml(t)'), 'the message renderer should retain the live Blob URL until IndexedDB hydration replaces it');
}

function testResponsesUsesManagedDurableChatJob() {
  const source = fs.readFileSync(path.join(__dirname, '../../client/app/chat-workflow.js'), 'utf8');
  assert.ok(source.includes('chatApi=useResponses?"responses":"chat"'), 'Responses and chat/completions must select one durable managed-job API');
  assert.ok(source.includes('let f=n.clientJobId||u?.jobId||makeClientChatJobId()'), 'every chat request must own a stable client job id');
  assert.ok(source.includes('mode:"chat",api:chatApi,submissionId:n.submissionId||""') && source.includes('isRecoverableJobSnapshot(savedJob,{...durableJob,payload:p})'), 'the durable snapshot must record the exact payload, endpoint family, and submission identity before handoff');
  assert.ok(source.includes('streamManagedChatCompletions(p,a,f'), 'Responses must use the managed server stream rather than an unrecoverable browser-direct request');
  assert.ok(!source.includes('if(useResponsesDirect){'), 'the old direct Responses branch must be removed');
}

function testTtftStartsAtServerForwardStart() {
  const serverSource = fs.readFileSync(path.join(__dirname, '../../server/jobs/chat.js'), 'utf8');
  const parserSource = fs.readFileSync(path.join(__dirname, '../../server/jobs/chat-stream-parser.js'), 'utf8');
  const appSource = fs.readFileSync(path.join(__dirname, '../../app.js'), 'utf8');
  assert.ok(serverSource.includes('job.serverStartAtMs = performance.now()'), 'managed chat job should record high precision server forward start');
  assert.ok(serverSource.includes('elapsedSince') && serverSource.includes("require('./chat-stream-parser')"), 'managed chat job should pass elapsedSince into the stream parser boundary');
  assert.ok(parserSource.includes('job.firstTokenMs = elapsedSince(job.serverStartAtMs)'), 'managed chat job first token should be measured from server forward start');
  assert.ok(appSource.includes('serverFirstTokenMs=a.firstTokenMs'), 'Responses direct stream should preserve server-side firstTokenMs from compact SSE');
  assert.ok(appSource.includes('serverDurationMs=a.durationMs'), 'Responses direct stream should preserve server-side durationMs from compact SSE');
}

function testResponsesCompactFtIsNeverZero() {
  const normalizer = responsesStream.createResponsesCompactStreamNormalizer({ now: (() => {
    const values = [1000, 1000, 1050];
    return () => values.shift() ?? 1000;
  })() });
  const out = normalizer.push('event: response.reasoning_summary_text.delta\ndata: {"delta":"hello"}\n\n');
  const payload = JSON.parse(out.match(/data: (.+)/)[1]);
  assert.strictEqual(payload.r, 'hello');
  assert.strictEqual(payload.ft, 1);
  const done = normalizer.end();
  const donePayload = JSON.parse(done.match(/data: (.+)/)[1]);
  assert.strictEqual(donePayload.done, 1);
  assert.strictEqual(donePayload.rt, 50);
}

function testFileUploadReturnsFocusToComposerSubmitPath() {
  const bootstrapSource = fs.readFileSync(path.join(__dirname, '../../client/app/bootstrap-workflow.js'), 'utf8');
  const attachmentSource = fs.readFileSync(path.join(__dirname, '../../client/app/attachments-workflow.js'), 'utf8');
  assert.ok(bootstrapSource.includes('e.target.value="",updateSendAvailability?.();const t=$("prompt"),s=$("sendBtn"),n=t&&!t.disabled?t:s,o=()=>n?.focus?.();(window.requestAnimationFrame||window.setTimeout).call(window,o,0),window.setTimeout.call(window,o,80)'), 'file input change should move focus away from file button/input to prompt or send button with browser-bound timers');
  assert.ok(attachmentSource.includes('root.requestAnimationFrame.call(root, focus)'), 'attachment workflow should call requestAnimationFrame with the window/root binding');
  assert.ok(attachmentSource.includes('function focusComposerSubmitTarget()'), 'attachment workflow should centralize post-upload focus restore');
  assert.ok(attachmentSource.replace(/\r\n/g, '\n').includes('finishUploadProgressSoon();\n      focusComposerSubmitTarget();'), 'addFiles completion should restore focus to composer submit target');
}

function testImageBubblesAreShrinkWrapped() {
  const source = fs.readFileSync(path.join(__dirname, '../../styles/flat-theme.css'), 'utf8');
  assert.ok(source.includes('.message .content:has(.user-attachment-preview-grid),') && source.includes('.message .content:has(.generated-image-grid){') && source.includes('width:fit-content!important;'), 'image message content should be shrink-wrapped instead of full-width');
  assert.ok(source.includes('.message.user .bubble:has(.user-attachment-preview-grid),') && source.includes('.message.assistant .bubble:has(.generated-image-grid),') && source.includes('.message.error .bubble:has(.generated-image-grid){'), 'image bubbles should be shrink-wrapped to the image grid');
  assert.ok(source.includes('width:fit-content!important;') && source.includes('max-width:100%!important;') && source.includes('min-width:0!important;'), 'image grids should use fit-content width with max-width guard');
}

function testMarkdownTablesShrinkToContent() {
  const source = fs.readFileSync(path.join(__dirname, '../../styles/flat-theme.css'), 'utf8');
  assert.ok(source.includes('.markdown-body .table-wrapper') && source.includes('width:100%!important;') && source.includes('overflow-x:auto!important;'), 'table wrapper should fill the message width and scroll when needed');
  assert.ok(source.includes('.markdown-body table') && source.includes('width:max-content!important;') && source.includes('min-width:100%!important;'), 'tables should fill available width while allowing wider content to scroll');
}

function testMarkdownTableAlignmentUsesRendererSemantics() {
  const html = markdownEngine.renderMarkdown('| Left | Center | Right |\n|:---|:---:|---:|\n| a | b | c |');
  assert.ok(html.includes('class="md-align-left"'), 'left-aligned markdown table cells should keep semantic alignment class');
  assert.ok(html.includes('class="md-align-center"'), 'center-aligned markdown table cells should keep semantic alignment class');
  assert.ok(html.includes('class="md-align-right"'), 'right-aligned markdown table cells should keep semantic alignment class');
  assert.ok(!/text-align\s*:/i.test(html), 'renderer should not rely on inline text-align styles after normalization');
  const css = fs.readFileSync(path.join(__dirname, '../../styles/flat-theme.css'), 'utf8');
  assert.ok(css.includes('.markdown-body th.md-align-center') && css.includes('text-align:center!important;'), 'theme should map md-align-center to centered cells');
  assert.ok(css.includes('.markdown-body th.md-align-right') && css.includes('text-align:right!important;'), 'theme should map md-align-right to right-aligned cells');
  assert.ok(css.indexOf('.markdown-body th.md-align-center') < css.indexOf('/* User actions belong under the user bubble'), 'markdown table alignment should live with the table theme rules, not as a late tail override');
  assert.ok(!css.includes('text-align:left!important;\n  vertical-align:top!important;'), 'theme must not force every markdown table cell to left alignment');
}

function testMarkdownDetailsPreserveOpenAttribute() {
  const browserSanitizer = fs.readFileSync(path.join(__dirname, '../../client/app/markdown/browser-sanitizer.js'), 'utf8');
  const nodeSanitizer = fs.readFileSync(path.join(__dirname, '../../client/app/markdown/sanitizer.js'), 'utf8');
  assert.ok(browserSanitizer.includes("'details', 'summary'") && browserSanitizer.includes("'open'"), 'browser sanitizer should preserve details/summary and open attribute');
  assert.ok(nodeSanitizer.includes("'details', 'summary'") && nodeSanitizer.includes("'open'"), 'node sanitizer should preserve details/summary and open attribute');
}

function testMarkdownDetailsUseNativeCollapsedSemantics() {
  const shorthand = markdownSourceNormalizer.normalizeMarkdownSource('::: details 点击展开详情\n这里是折叠内容。\n\n- 可以包含 **Markdown**\n:::');
  assert.ok(shorthand.includes('<details>') && shorthand.includes('<summary>点击展开详情</summary>') && shorthand.includes('</details>'), 'details container shorthand should normalize into native details/summary tags');
  const html = markdownEngine.renderMarkdown('<details>\n<summary>点击展开详情</summary>\n这里是折叠内容。\n\n- 可以包含 **Markdown**\n</details>');
  assert.ok(html.includes('<details>') && html.includes('<summary>点击展开详情</summary>'), 'renderer should preserve native details and summary');
  assert.ok(html.includes('<strong>Markdown</strong>'), 'markdown inside details should still render after normalization inserts the required blank line');
  const css = fs.readFileSync(path.join(__dirname, '../../styles/flat-theme.css'), 'utf8');
  assert.ok(css.includes('.markdown-body details:not([open]) > :not(summary)') && css.includes('display:none!important;'), 'closed details should hide non-summary children with component semantics');
}

function testMermaidAutoRenderIsDefaultForFinalMarkdown() {
  const workflow = fs.readFileSync(path.join(__dirname, '../../client/app/message-workflow.js'), 'utf8');
  const performance = fs.readFileSync(path.join(__dirname, '../../client/app/performance-workflow.js'), 'utf8');
  const app = fs.readFileSync(path.join(__dirname, '../../app.js'), 'utf8');
  assert.ok(workflow.includes('autoRenderMermaid: true'), 'message workflow should request Mermaid auto rendering for final assistant markdown');
  assert.ok(workflow.includes('forceMermaid: true'), 'final assistant markdown should render all Mermaid diagrams by default, not only visible ones');
  assert.ok(workflow.includes('autoRenderMermaid: !!phase.final') && workflow.includes('forceMermaid: !!phase.final'), 'streaming renderer should defer Mermaid during streaming and auto render all diagrams on final');
  assert.ok(performance.includes('autoRenderMermaid: true') && performance.includes('forceMermaid: true'), 'lazy markdown rendering should auto render Mermaid once materialized');
  assert.ok(app.includes('autoRenderMermaid:!0') && app.includes('forceMermaid:!0'), 'visible markdown rerender should keep Mermaid default rendering behavior');
  assert.ok(!workflow.includes('enhanceRenderedMarkdown(n,{skipMermaid:!0,allowResourceLoad:!0})'), 'final addMessage path must not hard-disable Mermaid rendering');
}

function testLargeMarkdownCompletionRefocusesTail() {
  const workflow = fs.readFileSync(path.join(__dirname, '../../client/app/message-workflow.js'), 'utf8');
  const feature = fs.readFileSync(path.join(__dirname, '../../client/features/messages/markdown-final-renderer.js'), 'utf8');
  const enhancer = fs.readFileSync(path.join(__dirname, '../../client/app/markdown/enhancer.js'), 'utf8');
  assert.ok(feature.includes('refocusTailAfterMarkdownLayout'), 'large progressive markdown completion should refocus the session tail from the feature renderer');
  assert.ok(feature.includes('await Promise.resolve(enhancePromise)') && feature.includes('content.replaceChildren(...[...stageContent.childNodes])'), 'large markdown final rendering should complete offscreen before one visible replacement');
  assert.ok(feature.includes('progressiveOffscreen') && feature.includes('progressiveStage'), 'large markdown final rendering should use an offscreen stage instead of progressively mutating the visible bubble');
  assert.ok(feature.includes('deps.focusSessionTail?.({ margin: 18, threshold: 12 })'), 'tail refocus should use the same visual bottom target as session switching');
  assert.ok(feature.includes('shouldAutoRefocusTail') && feature.includes('!deps.state?.userScrollLocked'), 'progressive markdown completion must not refocus the tail after the user scrolls up');
  assert.ok(feature.includes('function releaseFollowIfViewportMovedAway'), 'progressive markdown completion should detect when the viewport moved away before final DOM replacement');
  assert.ok(feature.includes('deps.state.userScrollLocked = true'), 'progressive markdown completion should release auto-follow before final replacement if the user moved away');
  assert.ok(feature.includes('function preserveDistanceToBottom'), 'progressive markdown completion should preserve distance-to-bottom when user moved away');
  assert.ok(feature.includes('restoreMovedAwayGap?.()'), 'progressive markdown replacement should restore the moved-away viewport after DOM height changes');
  assert.ok(!feature.includes('deps.state.userScrollLocked = false'), 'progressive markdown completion must not forcibly clear the user scroll lock');
  assert.ok(!feature.includes('[80, 220, 520, 1000, 1800, 3200].forEach'), 'progressive markdown completion must not use delayed forced tail refocus timers');
  assert.ok(!workflow.includes('content.append(...batch)'), 'message workflow must not append final HTML batches into the visible message content');
  assert.ok(workflow.includes('getMarkdownFinalRenderer().renderProgressively'), 'message workflow should remain a thin final-render facade');
  assert.ok(enhancer.includes("chatui:markdown-layout-settled") && enhancer.includes("reason: 'mermaid-rendered'"), 'Mermaid rendering completion should emit a markdown layout settled event');
}

function testStreamingDownloadActionIsDisabled() {
  const css = fs.readFileSync(path.join(__dirname, '../../styles/flat-theme.css'), 'utf8');
  assert.ok(css.includes('.message[data-streaming="1"] .download-answer-btn'), 'download button should be hidden while streaming');
  assert.ok(css.includes('pointer-events:none!important;'), 'streaming actions should not receive pointer events');
}

function testResumeStreamingDoesNotUseStatusTextAsOffset() {
  const source = fs.readFileSync(path.join(__dirname, '../../client/app/job-resume-workflow.js'), 'utf8');
  const app = fs.readFileSync(path.join(__dirname, '../../app.js'), 'utf8');
  assert.ok(source.includes('isChatStatusText(e)?"":e'), 'resume offsets should ignore transient status text');
  assert.ok(source.includes('r();try{const t=getConfig()'), 'resume should immediately paint a non-empty status instead of waiting blank');
  assert.ok(source.includes('if(!m.content&&!m.reasoning){try{const e=l(await getChatJob(s.id,{resumeOffsets:R()}))'), 'empty compact done events should refetch the final job snapshot');
  assert.ok(app.includes('resumeSessionJobs(t.id)}'), 'session render should always attempt to rebind or resume pending jobs after switch/render');
  assert.ok(app.includes('state.pageUnloading=!1;const liveRun=getActiveRun(e);if(window.ChatUIApp?.runs?.isLiveRun?.(liveRun))') && app.includes('const liveImageJob=loadImageJob(e),liveChatJob=loadLatestChatJob(e)') && app.includes('return}const pendingSubmit='), 'resume should clear stale page-unloading state, rebind only the live run own job, and return before durable recovery replay');
  assert.ok(app.includes('if(selectedChatJob?.id){if(sessionHasCompletedAssistantForResponse(n,selectedChatJob.responseIndex))return clearChatJob(e),void settleSessionTask(e,{outcome:"completed"'), 'chat resume should settle canonical task state when the selected durable response is already complete');
  assert.ok(app.includes('const t=!!(loadImageJob(e)?.id||loadLatestChatJob(e)?.id)') && app.includes('t&&resumeSessionJobs(e);try{'), 'foreground refresh should resume pending jobs even when busy state was lost after reload');
}

function testRestorePendingReusesExistingAssistantNodeByResponseIndex() {
  const source = fs.readFileSync(path.join(__dirname, '../../client/app/display-history-workflow.js'), 'utf8');
  assert.ok(source.includes("node = nodes.find(candidate => candidate.classList.contains('assistant') && candidate.dataset.responseIndex === String(responseIndex))"), 'pending restore should find an existing assistant node by responseIndex before adding a new node');
  assert.ok(source.includes('node.__displayItem = item;'), 'pending restore should rebind the pending display item to the existing node');
  assert.ok(!source.includes('dataset.displayItemId!==t.id'), 'pending restore must not remove/recreate the assistant node only because displayItemId changed');
}

async function testManagedJobAbortUsesJobService() {
  const jobService = require('../../client/services/job-service');
  const calls = [];
  const response = await jobService.abortManagedJob({ kind: 'image', jobId: 'abc/123', fetchImpl: async (...args) => { calls.push(args); return { ok: true, status: 200 }; } });
  assert.strictEqual(response.ok, true);
  assert.strictEqual(calls[0][0], '/api/image-jobs/abc%2F123/abort');
  assert.deepStrictEqual(calls[0][1], { method: 'POST' });
  await jobService.abortManagedJob({ kind: 'chat', jobId: '', fetchImpl: async () => { throw new Error('should not call fetch'); } });
  const composition = fs.readFileSync(path.join(__dirname, '../../client/services/composition.js'), 'utf8');
  assert.ok(composition.includes('abortManagedJob: options => jobService.abortManagedJob(withHttpDeps(options))'), 'composition should expose job abort through ChatUIServices.jobs');
  const appSource = fs.readFileSync(path.join(__dirname, '../../app.js'), 'utf8');
  assert.ok(appSource.includes('window.ChatUIServices?.jobs||window.ChatUIJobService'), 'app abort path should use job service first');
  assert.ok(appSource.includes('s.abortManagedJob({kind:e,jobId:t,fetchImpl:fetch})'), 'app abort path should delegate to job-service abort API');
}

async function testAttachmentTextExtractionUsesService() {
  const attachmentService = require('../../client/services/attachment-service');
  const calls = [];
  const text = await attachmentService.extractFileText({
    item: { name: 'demo.pdf', type: 'application/pdf', dataUrl: 'data:application/pdf;base64,abc' },
    fetchImpl: async (...args) => { calls.push(args); return { ok: true, text: async () => JSON.stringify({ text: ' extracted text ' }) }; },
  });
  assert.strictEqual(text, 'extracted text');
  assert.strictEqual(calls[0][0], '/api/extract-file');
  assert.strictEqual(calls[0][1].method, 'POST');
  assert.strictEqual(calls[0][1].headers['Content-Type'], 'application/json');
  assert.deepStrictEqual(JSON.parse(calls[0][1].body), { filename: 'demo.pdf', type: 'application/pdf', dataUrl: 'data:application/pdf;base64,abc' });
  assert.strictEqual(await attachmentService.extractFileText({ item: { name: 'empty.pdf' }, fetchImpl: async () => { throw new Error('should not call fetch'); } }), '');

  const workflow = fs.readFileSync(path.join(__dirname, '../../client/app/attachments-workflow.js'), 'utf8');
  const composition = fs.readFileSync(path.join(__dirname, '../../client/services/composition.js'), 'utf8');
  const browser = fs.readFileSync(path.join(__dirname, '../../client/services/browser.js'), 'utf8');
  const index = fs.readFileSync(path.join(__dirname, '../../index.html'), 'utf8');
  assert.ok(workflow.includes('root.ChatUIServices?.attachments || root.ChatUIAttachmentService'), 'attachments workflow should prefer the attachment service boundary');
  assert.ok(workflow.includes('attachmentService.extractFileText({ item, fetchImpl: root.fetch?.bind(root), parseResponseJson, normalizeError })'), 'attachment text extraction should delegate to service');
  assert.ok(composition.includes('attachments: attachmentsApi'), 'service composition should expose attachment APIs');
  assert.ok(browser.includes('attachments: Object.freeze(attachments)'), 'browser service facade should expose attachments namespace');
  sourceAssertions.assertInOrder(index, './client/services/attachment-service.js', './client/services/composition.js', 'attachment service should load before service composition');
  sourceAssertions.assertInOrder(index, './client/services/browser.js', './client/app/attachments-workflow.js', 'service browser facade should load before attachment workflow');
}

async function testRuntimeVersionUsesService() {
  const runtimeService = require('../../client/services/runtime-service');
  const calls = [];
  const version = await runtimeService.requestAppVersion({
    fetchImpl: async (...args) => { calls.push(args); return { ok: true, json: async () => ({ version: '1.2.3' }) }; },
  });
  assert.strictEqual(version, '1.2.3');
  assert.strictEqual(calls[0][0], '/api/version');
  assert.deepStrictEqual(calls[0][1], { cache: 'no-store' });

  const runtime = fs.readFileSync(path.join(__dirname, '../../client/app/runtime.js'), 'utf8');
  const composition = fs.readFileSync(path.join(__dirname, '../../client/services/composition.js'), 'utf8');
  const browser = fs.readFileSync(path.join(__dirname, '../../client/services/browser.js'), 'utf8');
  const index = fs.readFileSync(path.join(__dirname, '../../index.html'), 'utf8');
  assert.ok(runtime.includes('runtimeService = window.ChatUIServices?.runtime || window.ChatUIRuntimeService'), 'runtime app should prefer the runtime service boundary');
  assert.ok(runtime.includes('runtimeService.requestAppVersion({ fetchImpl })'), 'version loading should delegate to runtime service');
  assert.ok(composition.includes('requestAppVersion: options => runtimeService.requestAppVersion(withHttpDeps(options))'), 'service composition should expose runtime version API');
  assert.ok(browser.includes('runtime: Object.freeze(runtime)'), 'browser service facade should expose runtime namespace');
  sourceAssertions.assertInOrder(index, './client/services/runtime-service.js', './client/services/composition.js', 'runtime service should load before service composition');
  sourceAssertions.assertInOrder(index, './client/services/browser.js', './client/app/runtime.js', 'service browser facade should load before runtime app workflow');
}

function testPendingSubmitHandsOffAtomicallyToDurableJob() {
  const submit = fs.readFileSync(path.join(__dirname, '../../client/app/submit-workflow.js'), 'utf8');
  const chat = fs.readFileSync(path.join(__dirname, '../../client/app/chat-workflow.js'), 'utf8');
  const app = fs.readFileSync(path.join(__dirname, '../../app.js'), 'utf8');
  assert.ok(!submit.includes('saveChatJob(sessionId,{id:preparedChatJobId'), 'route preflight must not create a payload-less job that can outrank pending-submit recovery');
  assert.ok(!submit.includes('clearPendingSubmit(sessionId);const replacementResponseIndex='), 'route ownership must not be cleared before a successor task is durable');
  assert.ok(submit.includes('completeDurableHandoff=(jobId,jobKind)=>{handoffCommitted=!0;emitTaskEvent(sessionId,taskEvents.HANDOFF_COMMITTED,{submissionId,jobId,jobKind});clearPendingSubmit(sessionId)}'));
  assert.ok(submit.includes('onDurableHandoff:()=>completeDurableHandoff(activeJobId,activeJobKind)'));
  assert.ok(chat.includes('await persistChatJobSnapshot') && chat.includes('n.onDurableHandoff?.()'), 'chat must acknowledge handoff only after its payload snapshot commits');
  assert.ok(chat.includes('let f=n.clientJobId||u?.jobId||makeClientChatJobId()'), 'chat should reuse the route-assigned id and allocate a stable fallback only when absent');
  assert.ok(app.includes('makeClientChatJobId,makeClientImageJobId,saveChatJob,clearChatJob,shouldPrepareManagedChatJob'), 'app bootstrap should retain stable chat and image job-id lifecycles');
}

function testSessionDisplayUpdatesFinalClarificationHtml() {
  const source = fs.readFileSync(path.join(__dirname, '../../client/app/session-display.js'), 'utf8');
  const chat = fs.readFileSync(path.join(__dirname, '../../client/app/chat-workflow.js'), 'utf8');
  assert.ok(source.includes('if (options.deferPersist !== true) item.html ='), 'final display updates should refresh item html');
  assert.ok(!source.includes('options.deferPersist !== true && options.pending !== false'), 'final pending=false updates must not skip html refresh');
  assert.ok(!chat.includes('pending:!1,responseIndex:m,metaText:M,reasoning:R,keepReasoning:!!R,deferDomUpdate'), 'chat final update must persist pending=false even when the DOM node was updated directly');
  const e2ePath = path.join(__dirname, '../../temp/run-final-full-e2e.js');
  if (!fs.existsSync(e2ePath)) return;
  const e2e = fs.readFileSync(e2ePath, 'utf8');
  assert.ok(e2e.includes('async function waitForCompletion(beforeLen, timeoutMs, expected = {})'), 'full E2E should pass case expectations into completion waiting');
  assert.ok(e2e.includes('if (gotAssistant && !data.pending && stableCount >= 1) break;'), 'full E2E should sample once after pending clears to avoid stale storage reads');
  assert.ok(e2e.includes('const transientDone = data?.newMessages?.some(m => m.role === \'assistant\')'), 'full E2E should distinguish persisted completed clarify/chat answers from transient pending snapshots');
  assert.ok(e2e.includes("assistantIncludes: ['baseUrl']"), 'error-handling E2E should require the visible invalid-baseUrl message');
}

function testClarificationAssistantNodeKeepsStableDisplayIdentity() {
  const submit = fs.readFileSync(path.join(__dirname, '../../client/app/submit-workflow.js'), 'utf8');
  const image = fs.readFileSync(path.join(__dirname, '../../client/app/image-workflow.js'), 'utf8');
  assert.ok(submit.includes('assistantNode.__displayItem=liveItem') && submit.includes('assistantNode.dataset.displayItemId=liveItem.id') && submit.includes('assistantNode.dataset.responseIndex=String(responseIndex)'), 'assistant placeholders should persist displayItemId and responseIndex on the DOM node');
  assert.ok(submit.includes('updateMessage(assistantNode,e,{rawText:e,responseIndex})'), 'clarification final message should keep its responseIndex on the DOM node');
  assert.ok(image.includes('if((e&&s&&e!==s)||(t&&a&&t!==a))d=null;'), 'image workflow should reject stale loading nodes from a different display item/response');
}

function testPendingSubmitResumeInsertsFallbackAtOriginalPosition() {
  const submit = fs.readFileSync(path.join(__dirname, '../../client/app/submit-workflow.js'), 'utf8');
  const app = fs.readFileSync(path.join(__dirname, '../../app.js'), 'utf8');
  const resumeBranch = submit.slice(submit.indexOf('if(resumePendingSubmit){'), submit.indexOf('else if(replacement)'));
  assert.ok(resumeBranch.includes('findMessageNodeByDisplayItem(liveItem)'), 'pending submit resume should first try to reuse the original display item DOM node');
  assert.ok(resumeBranch.includes('anchor?.parentNode?.insertBefore(assistantNode,anchor)'), 'pending submit resume fallback node must be inserted by responseIndex instead of appended to the tail');
  assert.ok(resumeBranch.indexOf('insertBefore(assistantNode,anchor)') > resumeBranch.indexOf('addMessage("assistant"'), 'fallback insertion should happen immediately after creating the fallback node');
  assert.ok(app.includes('function insertMessageNodeAtDisplayPosition'), 'runtime should expose a shared display-order insertion helper');
  assert.ok(app.includes('insertMessageNodeAtDisplayPosition(t,e),t}function removeDisplayItemNode'), 'addDisplayItemNode should insert recreated pending/live nodes back at their original display position');
  assert.ok(app.includes('i||(i=findMessageNodeByDisplayItem(t)),i||(i=addDisplayItemNode(t)),insertMessageNodeAtDisplayPosition(i,t)'), 'updateLiveDisplay fallback should not leave recreated resume nodes appended at the tail');
}

function testRegenerateSavesEarlyPendingSubmitBeforeRoute() {
  const app = fs.readFileSync(path.join(__dirname, '../../app.js'), 'utf8');
  const regenerate = fs.readFileSync(path.join(__dirname, '../../client/app/regenerate-workflow.js'), 'utf8');
  const submit = fs.readFileSync(path.join(__dirname, '../../client/app/submit-workflow.js'), 'utf8');
  const regenStart = regenerate.indexOf('async function regenerateAssistantMessage');
  const routeStart = regenerate.indexOf('routeUi.getEffectiveRouteWithSlowNotice', regenStart);
  const acceptStart = regenerate.indexOf('task.accept({capture:!0})', regenStart);
  assert.ok(acceptStart > regenStart && acceptStart < routeStart, 'regenerate should persist and accept a pending task before route recognition starts');
  assert.ok(regenerate.includes("if (!savePending({ stage: 'accepted' }))") && regenerate.includes('emitTaskEvent(sessionId, taskEvents.TASK_ACCEPTED'), 'regenerate task acceptance should couple durable pending ownership with the canonical event');
  assert.ok(regenerate.includes('requestBaseMessages:baseRequestMessages,regenerate:!0,replaceAssistantIndex:a'), 'regenerate pending-submit should keep base messages and original response index');
  assert.ok(app.includes('getWorkflowModule?.("regenerate")'), 'root app should resolve regenerate through explicit workflow composition');
  assert.ok(submit.includes('resumePendingSubmit?.attachmentContext&&typeof restoreUserAttachmentsFromContext'), 'pending-submit resume should restore persisted attachment context');
  assert.ok(submit.includes('requestBaseMessages=Array.isArray(resumePendingSubmit?.requestBaseMessages)?resumePendingSubmit.requestBaseMessages'), 'pending-submit resume should reuse regenerate base messages');
  assert.ok(submit.includes('const replacementResponseIndex=replacement?.responseIndex??(resumePendingSubmit?responseIndex:void 0),completeDurableHandoff=(jobId,jobKind)=>'), 'pending-submit resume should dispatch back to original response index even without a replacement object');
  const index = fs.readFileSync(path.join(__dirname, '../../index.html'), 'utf8');
  assert.ok(index.includes('regenerate-workflow.js?v=1.0.2-canonical-route-plan') && index.includes('app.js?v=2.1.48-route-model-switch-guard') && index.includes('chatui.bundle.js?v=1.3.145-resilient-snapshot-store'), 'cache versions should deliver the canonical regenerate workflow');
}

function testReasoningPreferenceIsSessionScoped() {
  const session = appState.createSession('A', () => 1000, () => 0.123456);
  assert.strictEqual(session.reasoningMode, false);
  assert.strictEqual(session.reasoningType, 'none');
  assert.strictEqual(Object.hasOwn(session, 'reasoningProvider'), false, 'sessions should not retain a provider compatibility setting');

  const displaySource = fs.readFileSync(path.join(__dirname, '../../client/app/session-display.js'), 'utf8');
  assert.ok(displaySource.includes('reasoningMode: session.reasoningMode === undefined ? null : !!session.reasoningMode'), 'session metadata should persist reasoningMode per session');
  assert.ok(displaySource.includes("reasoningType: ['none', 'low', 'medium', 'high', 'xhigh', 'max'].includes(session.reasoningType) ? session.reasoningType : ''"), 'session metadata should persist reasoningType per session');
  assert.ok(!displaySource.includes('reasoningProvider'), 'session metadata should not persist provider compatibility settings');

  const reasoningSource = fs.readFileSync(path.join(__dirname, '../../client/app/reasoning-workflow.js'), 'utf8');
  assert.ok(reasoningSource.includes('session.reasoningMode = state.reasoningMode'), 'reasoning mode changes should write active session');
  assert.ok(reasoningSource.includes('session.reasoningType = state.reasoningType'), 'reasoning type changes should write active session');
  assert.ok(reasoningSource.includes('isGpt5ReasoningModel'), 'reasoning should be restricted to GPT-5 model names');
  assert.ok(!reasoningSource.includes('setReasoningProvider'), 'reasoning workflow should not expose provider compatibility controls');
  assert.ok(!reasoningSource.includes('thinking_budget'), 'reasoning workflow should not emit compatibility payloads');
  assert.ok(reasoningSource.includes('typeof saveSessionsMeta === "function" && saveSessionsMeta()'), 'reasoning preference changes should save session metadata');

  const appSource = fs.readFileSync(path.join(__dirname, '../../app.js'), 'utf8');
  assert.ok(appSource.includes('function reasoningPayloadOptions(e={}){return getReasoningWorkflow().reasoningPayloadOptions(e)}'), 'the app runtime should bridge the GPT-5 reasoning payload helper into the chat workflow');
  const switchStart = appSource.indexOf('function switchSession');
  const switchReasoning = appSource.indexOf('loadReasoningPreference()', switchStart);
  const switchRender = appSource.indexOf('renderActiveSession({reason:"switch-bottom"', switchStart);
  assert.ok(switchStart >= 0 && switchReasoning > switchStart && switchRender > switchReasoning, 'switching sessions should reload reasoning preference before rendering active session');
}

function testReasoningCompletionEmptyStateText() {
  const reasoningSource = fs.readFileSync(path.join(__dirname, '../../client/app/reasoning-workflow.js'), 'utf8');
  assert.ok(reasoningSource.includes('done?"思考完成":"思考中"'), 'completed reasoning should show 思考完成');
  assert.ok(reasoningSource.includes('unavailable?"未返回思考内容"'), 'missing reasoning should show 未返回思考内容');
  assert.ok(reasoningSource.includes('showReasoningUnavailable(e)'), 'finishReasoning should route empty reasoning to unavailable state');
  assert.ok(reasoningSource.includes('keepEmpty:!0,unavailable:!0'), 'unavailable reasoning state should render immediately even with empty body');
}

function testReasoningCompletesBeforeAnswerStreaming() {
  const chatSource = fs.readFileSync(path.join(__dirname, '../../client/app/chat-workflow.js'), 'utf8');
  assert.ok(chatSource.includes('if(reasoningEnabled&&!s){s=!0;'), 'answer streaming should immediately leave thinking state when answer starts');
  assert.ok(chatSource.includes('updateReasoning(g,reasoningText,{done:!0'), 'answer streaming should update existing reasoning title to done before rendering answer text');
  assert.ok(chatSource.includes('S.set(mergeReasoning(e.reasoning||"")),I.set(mergeAnswer'), 'stream callbacks should process reasoning before answer content in the same chunk');
  const index = fs.readFileSync(path.join(__dirname, '../../index.html'), 'utf8');
  assert.ok(index.includes('chat-workflow.js?v=1.3.24-task-lifecycle-state-machine') && index.includes('chatui.bundle.js?v=1.3.145-resilient-snapshot-store'), 'chat stream reasoning-state fix should bump cache versions');
}

function testReasoningUnavailableWhenAnswerStartsWithoutReasoning() {
  const chatSource = fs.readFileSync(path.join(__dirname, '../../client/app/chat-workflow.js'), 'utf8');
  assert.ok(chatSource.includes('answerStarted=!0'), 'chat streaming should track when answer content starts');
  assert.ok(chatSource.includes('showReasoningUnavailable(g)'), 'answer streaming without reasoning should immediately mark reasoning as unavailable');
  assert.ok(chatSource.includes('s=!!answerStarted'), 'late reasoning after answer start should render as completed, not thinking');
  const index = fs.readFileSync(path.join(__dirname, '../../index.html'), 'utf8');
  assert.ok(index.includes('chat-workflow.js?v=1.3.24-task-lifecycle-state-machine') && index.includes('chatui.bundle.js?v=1.3.145-resilient-snapshot-store'), 'empty-reasoning stream fix should bump cache versions');
}

function testReasoningMenuCloseReleasesFocusBeforeAriaHidden() {
  const reasoningSource = fs.readFileSync(path.join(__dirname, '../../client/app/reasoning-workflow.js'), 'utf8');
  assert.ok(reasoningSource.includes('active && menu.contains?.(active)'), 'closing reasoning menu should detect focused descendants before hiding');
  assert.ok(reasoningSource.includes('menuButton.focus?.({ preventScroll: true })') && reasoningSource.includes('active.blur?.()'), 'closing reasoning menu should move or clear focus before aria-hidden=true');
  assert.ok(reasoningSource.indexOf('active && menu.contains?.(active)') < reasoningSource.indexOf('menu.setAttribute("aria-hidden", "true")'), 'focus should be released before setting aria-hidden on reasoning menu');
  const index = fs.readFileSync(path.join(__dirname, '../../index.html'), 'utf8');
  const composerCss = fs.readFileSync(path.join(__dirname, '../../styles/composer.css'), 'utf8');
  assert.ok(composerCss.includes('min-width:158px!important') && composerCss.includes('grid-template-columns:minmax(0,1fr)!important'), 'the single-section GPT-5 reasoning menu should not retain the obsolete two-column compatibility layout');
  assert.ok(index.includes('reasoning-workflow.js?v=1.3.35-reasoning-persistence') && index.includes('composer.css?v=1.3.2-gpt5-reasoning-menu') && index.includes('chatui.bundle.js?v=1.3.145-resilient-snapshot-store'), 'reasoning menu changes should bump cache versions');
}

function testModalCloseReleasesFocusBeforeAriaHidden() {
  const configSource = fs.readFileSync(path.join(__dirname, '../../client/app/config-workflow.js'), 'utf8');
  assert.ok(configSource.includes('e?.contains?.(t)'), 'closing config modal should detect focused descendants');
  assert.ok(configSource.indexOf('e?.contains?.(t)') < configSource.indexOf('e?.setAttribute("aria-hidden","true")'), 'config modal should release focus before aria-hidden=true');
  const previewSource = fs.readFileSync(path.join(__dirname, '../../client/app/image-preview-workflow.js'), 'utf8');
  assert.ok(previewSource.includes('r._returnFocus=document?.activeElement'), 'image preview should remember its trigger');
  assert.ok(previewSource.includes('r?.contains?.(a)'), 'closing image preview should detect focused descendants');
  assert.ok(previewSource.indexOf('r?.contains?.(a)') < previewSource.indexOf('r?.setAttribute("aria-hidden","true")'), 'image preview should release focus before aria-hidden=true');
}

function testCodeActionHoverAndHistoryAnchorActivePolish() {
  const css = fs.readFileSync(path.join(__dirname, '../../styles/flat-theme.css'), 'utf8');
  assert.ok(css.includes('.markdown-body .code-block .code-copy-icon:hover') && css.includes('transform:none !important'), 'code block action hover should not move the absolute-positioned button');
  const activeBlock = css.match(/\.history-anchor-item\.active\{[\s\S]*?\}/)?.[0] || '';
  assert.ok(activeBlock.includes('background:linear-gradient(90deg,rgba(37,99,235,.10),rgba(6,182,212,.06))'), 'active history item should use a light blue-green active wash');
  assert.ok(activeBlock.includes('box-shadow:inset 0 0 0 1px rgba(37,99,235,.10)'), 'active history item should use a subtle inset boundary');
  const activeBeforeBlock = css.match(/\.history-anchor-item\.active::before\{[\s\S]*?\}/)?.[0] || '';
  assert.ok(activeBeforeBlock.includes('linear-gradient(180deg,var(--history-anchor-accent),var(--history-anchor-accent-2))'), 'active history item should use a slim gradient marker');
  const railBlock = css.match(/\.history-anchor-rail-bar\.active::before,\r?\n\.history-anchor-rail-bar\.hover::before\{[\s\S]*?\}/)?.[0] || '';
  assert.ok(railBlock.includes('rgba(37,99,235,.08)'), 'active history rail should use a very light focus halo');

  const index = fs.readFileSync(path.join(__dirname, '../../index.html'), 'utf8');
  assert.ok(index.includes('styles/flat-theme.css?v=2.1.95-welcome-globe-only') && index.includes('assets/chatui.bundle.css?v=1.3.145-resilient-snapshot-store'), 'CSS bundle cache versions should be bumped for visual fixes');
}

function testArchitectureBoundaryScaffolding() {
  const storageKeys = require('../../client/config/storage-keys');
  const featureFlags = require('../../client/config/feature-flags');
  const domainTypes = require('../../client/domain/types');
  assert.strictEqual(storageKeys.storageKeys.CONFIG_KEY, 'openapi-chat-image-config-v2');
  assert.strictEqual(storageKeys.storageKeys.CHAT_JOB_KEY, 'openapi-chat-image-chat-job-v1');
  assert.strictEqual(featureFlags.featureFlags.virtualMessages, false);
  assert.ok(featureFlags.featureFlags.offscreenMarkdownFinalRender, 'offscreen Markdown final render should be an explicit architecture flag');
  assert.ok(domainTypes.typeNames.includes('ChatSession') && domainTypes.typeNames.includes('DisplayItem') && domainTypes.typeNames.includes('ChatJob'), 'domain typedef registry should document core client state shapes');

  const index = sourceAssertions.readSource('index.html');
  sourceAssertions.assertInOrder(index, './client/core/browser.js', './client/config/storage-keys.js', 'config should load after core browser primitives');
  sourceAssertions.assertInOrder(index, './client/config/storage-keys.js', './client/app/state.js', 'config should load before app state and app bootstrap');
  sourceAssertions.assertInOrder(index, './client/domain/types.js', './client/app/state.js', 'domain typedefs should load before app state and app bootstrap');

  const app = sourceAssertions.readSource('app.js');
  sourceAssertions.assertIncludes(app, 'storageKeys=window.ChatUIConfig?.storageKeys||{}', 'app should read storage keys through the config boundary with fallbacks');
  sourceAssertions.assertIncludes(app, 'CONFIG_KEY=storageKeys.CONFIG_KEY||"openapi-chat-image-config-v2"', 'app should keep literal storage-key fallback for safe rollback');

  const usageRoute = sourceAssertions.readSource('server/api/routes/usage.js');
  const usageController = sourceAssertions.readSource('server/api/controllers/usage.controller.js');
  sourceAssertions.assertIncludes(usageRoute, "require('../controllers/usage.controller')", 'usage route should delegate request handling to controller boundary');
  sourceAssertions.assertIncludes(usageRoute, 'function routeUsage(req, res)', 'usage route should keep only HTTP path dispatch');
  assert.ok(!usageRoute.includes('usageService.') && !usageRoute.includes('readBody('), 'usage route should not contain business service calls or body parsing');
  sourceAssertions.assertIncludes(usageController, 'usageService.getRanking', 'usage controller should own usage request handling');
}

function testAppBootstrapContextHelper() {
  let soundCreated = 0;
  const doneSound = { unlockDoneSound() {}, playDoneSound() {} };
  const deps = appContext.resolveRuntimeDependencies({ ChatUIApp: { runtime: { marker: true, createDoneSound: () => { soundCreated += 1; return doneSound; } } } });
  assert.strictEqual(deps.runtimeHelpers.marker, true);
  assert.strictEqual(deps.doneSound, doneSound);
  assert.strictEqual(soundCreated, 1);
  assert.deepStrictEqual(appContext.resolveRuntimeDependencies({}).runtimeHelpers, {});
  assert.strictEqual(appContext.resolveRuntimeDependencies({}).doneSound, null);

  const registryCalls = [];
  const registry = appContext.createWorkflowRegistry({ alpha: () => { registryCalls.push('alpha'); return { name: 'alpha' }; } });
  assert.strictEqual(registry.has('alpha'), true);
  assert.strictEqual(registry.has('missing'), false);
  assert.strictEqual(registry.get('alpha'), registry.get('alpha'));
  assert.deepStrictEqual(registryCalls, ['alpha']);
  assert.throws(() => registry.get('missing'), /not registered/);

  const moduleApi = { create() {} };
  assert.strictEqual(appContext.registerWorkflowModule('test-module', moduleApi), moduleApi);
  assert.strictEqual(appContext.getWorkflowModule('test-module'), moduleApi);
  assert.strictEqual(appContext.getWorkflowModule('missing-module'), null);
  assert.throws(() => appContext.registerWorkflowModule('', moduleApi), /requires name/);

  const target = {};
  let lazyCalls = 0;
  appContext.defineLazyWorkflowGetter(target, 'workflow', () => ({ id: ++lazyCalls }));
  assert.strictEqual(target.workflow.id, 1);
  assert.strictEqual(target.workflow.id, 1);
  assert.strictEqual(lazyCalls, 1);

  const app = fs.readFileSync(path.join(__dirname, '../../app.js'), 'utf8');
  const index = fs.readFileSync(path.join(__dirname, '../../index.html'), 'utf8');
  assert.ok(app.includes('appContext=window.ChatUIApp?.appContext||{}'), 'app bootstrap should read the app-context helper without becoming a module');
  assert.ok(app.includes('appContext.resolveRuntimeDependencies?appContext.resolveRuntimeDependencies(window)'), 'app bootstrap should delegate runtime dependency resolution to app-context when present');
  sourceAssertions.assertInOrder(index, './client/app/state.js', './client/app/app-context.js', 'app context should load after app state');
  sourceAssertions.assertInOrder(index, './client/app/app-context.js', './app.js', 'app context should load before app bootstrap');
}


function testChatAndRouteUsePublicContextWindow() {
  const chatSource = fs.readFileSync(path.join(__dirname, '../../client/app/chat-workflow.js'), 'utf8');
  const routeSource = fs.readFileSync(path.join(__dirname, '../../client/app/route-decision-workflow.js'), 'utf8');
  const appSource = fs.readFileSync(path.join(__dirname, '../../app.js'), 'utf8');
  assert.ok(chatSource.includes('await loadPublicContext?.();') && chatSource.includes('applyOutboundContextBudget(rawMessages,a)'), 'normal chat must refresh and apply the public context token window before building its request');
  assert.ok(routeSource.includes('await loadPublicContext?.();') && routeSource.includes('contextWindowTokens=config?.context?.windowTokens'), 'route decision must use the same public context token window');
  assert.ok(appSource.includes('createChatWorkflow({state,loadPublicContext,getConfig'), 'app bootstrap must provide public-context loading to normal chat');
}

function testConfigBaseUrlDefault() {
  const configWorkflow = require('../../client/app/config-workflow');
  const configSource = fs.readFileSync(path.join(__dirname, '../../client/app/config-workflow.js'), 'utf8');
  const index = fs.readFileSync(path.join(__dirname, '../../index.html'), 'utf8');
  assert.strictEqual(configWorkflow.DEFAULT_BASE_URL, 'https://ingress.lfans.cn/v1', 'config workflow should expose the fallback Endpoint Base URL');
  assert.strictEqual(configWorkflow.defaults.baseUrl, 'https://ingress.lfans.cn/v1', 'new installs should default Endpoint Base URL to ingress.lfans.cn');
  assert.ok(configSource.includes('getElement("baseUrl").value=t.baseUrl||defaults.baseUrl'), 'loadConfig should restore the saved Endpoint field and use the default only when storage is empty');
  assert.ok(configSource.includes(String.raw`baseUrl:(baseEl?.value.trim()||DEFAULT_BASE_URL).replace(/\/+$/, "")`) && configSource.includes('getElement("baseUrl").readOnly=!1'), 'config workflow should submit the editable Endpoint Base URL after removing a trailing slash');
  assert.ok(index.includes('id="baseUrl" value="https://ingress.lfans.cn/v1" />') && !index.includes('id="baseUrl" value="https://ingress.lfans.cn/v1" readonly'), 'settings UI should allow users to edit Endpoint Base URL');
  assert.ok(index.includes('config-workflow.js?v=1.2.76-busy-route-model-guard'), 'config workflow changes should bump browser cache-busting version');

  const values = new Map([['config', JSON.stringify({ baseUrl: 'https://gateway.example/v1/' })]]);
  const storage = { getItem: key => values.get(key) || null, setItem: (key, value) => values.set(key, String(value)), removeItem: key => values.delete(key) };
  const elements = new Map(['baseUrl', 'apiKey', 'chatModel', 'routeModel', 'imageModel', 'imageSize', 'systemPrompt', 'imageStylePrompt'].map(id => [id, { value: '', readOnly: false }]));
  const workflow = configWorkflow.createConfigWorkflow({
    state: { models: [], modelMeta: {}, sessions: [], activeSessionId: '' },
    getElement: id => elements.get(id), localStorage: storage, sessionStorage: storage,
    document: { body: { classList: { add() {}, remove() {} } } }, window: { sessionStorage: storage, setTimeout }, crypto: { getRandomValues() {} }, CONFIG_KEY: 'config',
    renderModelOptions() {}, updateCustomSelect() {}, enhanceConfigSelects() {}, closeAllCustomSelects() {}, getActiveSession: () => ({ headerValues: {} }), saveSessionsMeta() {}, toast() {},
  });
  workflow.loadConfig();
  assert.strictEqual(elements.get('baseUrl').value, 'https://gateway.example/v1/', 'loadConfig should preserve a saved Endpoint Base URL');
  assert.strictEqual(workflow.getConfig().baseUrl, 'https://gateway.example/v1', 'request config should use the saved Endpoint Base URL with its trailing slash normalized');
}

function testConfigCopyButtonsForBaseUrlAndApiKey() {
  const index = fs.readFileSync(path.join(__dirname, '../../index.html'), 'utf8');
  const configSource = fs.readFileSync(path.join(__dirname, '../../client/app/config-workflow.js'), 'utf8');
  const bootstrapSource = fs.readFileSync(path.join(__dirname, '../../client/app/bootstrap-workflow.js'), 'utf8');
  const app = fs.readFileSync(path.join(__dirname, '../../app.js'), 'utf8');
  const flatCss = fs.readFileSync(path.join(__dirname, '../../styles/flat-theme.css'), 'utf8');
  const bundleSource = fs.readFileSync(path.join(__dirname, '../../server/services/static-bundle.service.js'), 'utf8');
  assert.ok(index.includes('id="copyBaseUrlBtn"') && index.includes('data-copy-config-field="baseUrl"') && index.includes('aria-label="复制 Endpoint Base URL"'), 'Endpoint Base URL should have an accessible icon copy button');
  assert.ok(index.includes('id="copyApiKeyBtn"') && index.includes('data-copy-config-field="apiKey"') && index.includes('aria-label="复制 API Key"'), 'API Key should have an accessible icon copy button');
  assert.ok(!/id="copyBaseUrlBtn"[\s\S]*?>复制<\/button>/.test(index) && !/id="copyApiKeyBtn"[\s\S]*?>复制<\/button>/.test(index), 'config copy buttons should be icon-only without visible text');
  assert.ok(configSource.includes('async function copyConfigField') && configSource.includes('ChatUI?.actions?.copyText') && configSource.includes('toast?.("已复制")'), 'config workflow should copy current field value through shared copy helper and toast success');
  assert.ok(bootstrapSource.includes('$("copyBaseUrlBtn")?.addEventListener("click",()=>copyConfigField("baseUrl"))') && bootstrapSource.includes('$("copyApiKeyBtn")?.addEventListener("click",()=>copyConfigField("apiKey"))'), 'bootstrap should bind config copy buttons');
  assert.ok(app.includes('function copyConfigField(...args)') && app.includes('copyConfigField:copyConfigField'), 'legacy app bundle path should expose config copy action to bootstrap workflow');
  assert.ok(flatCss.includes('.config-field-actions') && flatCss.includes('.config-copy-btn') && flatCss.includes('.secret-field input') && flatCss.includes('Final config layout') && flatCss.includes('padding-right: 88px !important') && flatCss.includes('right: 43px !important') && flatCss.includes('right: 7px !important'), 'flat theme should keep URL and API-key copy icons inside inputs, with the API-key visibility icon beside copy');
  assert.ok(index.includes('config-workflow.js?v=1.2.76-busy-route-model-guard') && index.includes('bootstrap-workflow.js?v=2.1.2-ime-platform-guard') && index.includes('styles/flat-theme.css?v=2.1.95-welcome-globe-only') && index.includes('app.js?v=2.1.48-route-model-switch-guard') && index.includes('chatui.bundle.js?v=1.3.145-resilient-snapshot-store'), 'config copy UI changes should bump browser cache versions');
  assert.ok(bundleSource.includes("BUNDLE_VERSION = '1.3.145-resilient-snapshot-store'"), 'server bundle version should match config copy cache-busting');
}

function testSensitiveConfigAndIntentTraceAreNotPersisted() {
  const configSource = fs.readFileSync(path.join(__dirname, '../../client/app/config-workflow.js'), 'utf8');
  const configModule = require('../../client/app/config-workflow');
  const routeWorkflow = require('../../client/app/route-decision-workflow');
  assert.ok(!configSource.includes('apiKey:t.apiKey'), 'saveConfig must keep API keys outside the general JSON config object');
  assert.ok(configSource.includes('legacyApiKey=String(e.apiKey||"")') && configSource.includes('legacyApiKey&&delete e.apiKey'), 'loadConfig should migrate legacy API keys into the dedicated persistent key');
  assert.ok(configSource.includes('(legacyApiKey||t.chatModel!==a'), 'legacy API-key migration should immediately rewrite sanitized config');
  assert.ok(configSource.includes('API_KEY_STORAGE_KEY') && configSource.includes('writePersistedApiKey(t.apiKey)'), 'API keys should persist in a dedicated localStorage key so closing and reopening the browser keeps credentials');

  const localValues = new Map(), sessionValues = new Map();
  const makeStorage = values => ({ getItem: key => values.get(key) || null, setItem: (key, value) => values.set(key, String(value)), removeItem: key => values.delete(key) });
  const elements = new Map(['baseUrl','apiKey','chatModel','routeModel','imageModel','imageSize','systemPrompt','imageStylePrompt'].map(id => [id, { value: '' }]));
  const localStorage = makeStorage(localValues), sessionStorage = makeStorage(sessionValues);
  const config = configModule.createConfigWorkflow({
    state: { models: [], modelMeta: {}, sessions: [], activeSessionId: '' },
    getElement: id => elements.get(id), localStorage, sessionStorage, document: { body: { classList: { add() {}, remove() {} } } },
    window: { sessionStorage, setTimeout }, crypto: { getRandomValues() {} }, CONFIG_KEY: 'test-config',
    renderModelOptions() {}, updateCustomSelect() {}, enhanceConfigSelects() {}, closeAllCustomSelects() {}, getActiveSession: () => ({ headerValues: {} }), saveSessionsMeta() {}, toast() {},
  });
  elements.get('apiKey').value = 'sk-session-only';
  config.saveConfig(true);
  assert.strictEqual(localStorage.getItem('test-config:api-key'), 'sk-session-only');
  assert.ok(!localStorage.getItem('test-config').includes('sk-session-only'), 'general localStorage config must not contain the API key');
  elements.get('apiKey').value = '';
  assert.strictEqual(config.getConfig().apiKey, 'sk-session-only', 'API key should survive closing and reopening the browser through localStorage');

  const workflow = routeWorkflow.createRouteDecisionWorkflow({ state: { sessions: [], messages: [], activeSessionId: '', attachments: [] } });
  const summary = workflow.summarizeIntentTrace({
    input: 'private prompt',
    context: { recent_messages: [{ content: 'secret conversation' }] },
    firstRaw: '{"secret":"model output"}',
    finalApi: 'image_generation',
    reviewed: true,
    finalRoute: { mode: 'image', operationType: 'image_generate', confidence: 0.91, taskContract: { execution: { api: 'image_generation' } } },
  });
  assert.strictEqual(summary.mode, 'image');
  assert.strictEqual(summary.api, 'image_generation');
  assert.strictEqual(summary.reviewed, true);
  assert.ok(!JSON.stringify(summary).includes('private prompt'));
  assert.ok(!JSON.stringify(summary).includes('secret conversation'));
  assert.ok(!JSON.stringify(summary).includes('model output'));
}

function testOmittedAttachmentDataDoesNotRenderAsImageUrl() {
  const html = '<div><img src="[attachment-data-omitted]" data-persisted-src="[image-data-omitted]" alt="bad.png"></div>';
  const clean = sessionPersistence.sanitizeStoredDisplayItem({ role: 'user', html }, { stripLargeDataUrlsFromText });
  assert.ok(!clean.html.includes('src="[attachment-data-omitted]"'), 'sanitizer should remove omitted attachment placeholders from img src');
  assert.ok(!clean.html.includes('data-persisted-src="[image-data-omitted]"'), 'sanitizer should remove omitted attachment placeholders from persisted image src');
  assert.ok(!clean.html.includes('attachment-data-omitted') && !clean.html.includes('image-data-omitted'), 'omitted placeholders should not remain in image markup');
}

function testRegenerateRemovesOldAssistantImmediately() {
  const app = fs.readFileSync(path.join(__dirname, '../../app.js'), 'utf8');
  const regenerate = fs.readFileSync(path.join(__dirname, '../../client/app/regenerate-workflow.js'), 'utf8');
  assert.ok(regenerate.includes('const c=prepareRegeneratedResponse(t,e,l,a,"正在执行：路由预检")'), 'regenerate click should insert a route-stage live placeholder');
  assert.ok(app.includes('removeSessionDisplayItemForNode(s,t),removeAssistantHistoryAt(s,n),t?.remove()'), 'regenerate should remove the original assistant DOM and display item before inserting the replacement placeholder');
  assert.ok(regenerate.includes('liveItem:m,replaceAssistantIndex:a'), 'regenerate image dispatch should preserve the original live item and assistant response index');
  assert.ok(!regenerate.includes('prepareReplacementResponse({node:t,responseNode:e,index:n,responseIndex:a},l,"已收到，马上处理",{deferClear:!0})'), 'regenerate should not reuse/update the old assistant node as a generic loading placeholder');
}

function testForceImageButtonOnUserMessages() {
  const index = fs.readFileSync(path.join(__dirname, '../../index.html'), 'utf8');
  const app = fs.readFileSync(path.join(__dirname, '../../app.js'), 'utf8');
  const regenerate = fs.readFileSync(path.join(__dirname, '../../client/app/regenerate-workflow.js'), 'utf8');
  const messageWorkflow = fs.readFileSync(path.join(__dirname, '../../client/app/message-workflow.js'), 'utf8');
  const bundleSource = fs.readFileSync(path.join(__dirname, '../../server/services/static-bundle.service.js'), 'utf8');
  assert.ok(index.includes('class="force-image-btn icon-action-btn"') && index.includes('title="强制生图"'), 'message actions should include a force-image button in the user message button area');
  assert.ok(messageWorkflow.includes('const forceImage = node.querySelector(".force-image-btn")'), 'message workflow should bind the force-image button');
  assert.ok(messageWorkflow.includes('if (role === "user") forceImage?.addEventListener("click", () => forceImageFromUserMessage(node));') && messageWorkflow.includes('else forceImage?.remove();'), 'force-image button should only be available on user messages');
  assert.ok(app.includes('forceImageFromUserMessage'), 'app should expose force-image action to the message workflow');
  assert.ok(regenerate.includes('prepareRegeneratedResponse(e,o,a,n,"正在处理中 请稍后")'), 'force-image action should remove/replace the old assistant response like regenerate');
  assert.ok(regenerate.includes('await sendImage(t,{loadingNode:l.node,attachments:c.filter(item=>!isImageFile(item)),routePrompt:t,originalPrompt:t,sessionId:a,userAlreadyAdded:!0,liveItem:l.liveItem,replaceAssistantIndex:n,submissionId:task.submissionId,clientJobId:jobId'), 'force-image action should send the current user message through a durable canonical image handoff');
  assert.ok(index.includes('force-image-wand') && index.includes('force-image-sparkle') && index.includes('force-image-frame'), 'force-image button should use the refined wand/image icon instead of the old heavy image-box icon');
  assert.ok(index.includes('message-workflow.js?v=1.3.39-image-quote') && index.includes('regenerate-workflow.js?v=1.0.2-canonical-route-plan') && index.includes('app.js?v=2.1.48-route-model-switch-guard') && index.includes('assets/chatui.bundle.css?v=1.3.145-resilient-snapshot-store') && index.includes('chatui.bundle.js?v=1.3.145-resilient-snapshot-store') && index.includes('styles/flat-theme.css?v=2.1.95-welcome-globe-only'), 'force-image UI and action changes should bump cache-busting versions');
  assert.ok(bundleSource.includes("BUNDLE_VERSION = '1.3.145-resilient-snapshot-store'"), 'server bundle version should match force-image cache-busting');
}

function testImagePreviewWheelZoom() {
  const workflow = fs.readFileSync(path.join(__dirname, '../../client/app/image-preview-workflow.js'), 'utf8');
  const css = fs.readFileSync(path.join(__dirname, '../../styles.css'), 'utf8');
  const flatCss = fs.readFileSync(path.join(__dirname, '../../styles/flat-theme.css'), 'utf8');
  const index = fs.readFileSync(path.join(__dirname, '../../index.html'), 'utf8');
  const bundleSource = fs.readFileSync(path.join(__dirname, '../../server/services/static-bundle.service.js'), 'utf8');
  assert.ok(workflow.includes('MIN_PREVIEW_SCALE = 0.5') && workflow.includes('MAX_PREVIEW_SCALE = 5'), 'image preview zoom should clamp wheel scale to a safe range');
  assert.ok(workflow.includes('if(String(e).startsWith("blob:"))return{src:e,owned:!1}'), 'blob object URLs should be previewable instead of resolving to an empty src');
  assert.ok(workflow.includes('addEventListener("wheel"') && workflow.includes('event.preventDefault()') && workflow.includes('zoomImagePreview(event.deltaY)') && workflow.includes('{passive:!1}'), 'image preview should handle wheel gestures for zoom without page scrolling');
  assert.ok(workflow.includes('resetPreviewZoom()') && workflow.includes('applyPreviewScale(1)'), 'opening and closing preview should reset zoom state');
  assert.ok(workflow.includes('img.style.transform=`scale(${previewScale})`') && workflow.includes('dataset.previewScale') && workflow.includes('classList.toggle("is-zoomed"'), 'zoom should update the preview image transform and state class');
  assert.ok(workflow.includes('dblclick') && workflow.includes('resetPreviewZoom()'), 'double click should provide a quick reset path');
  assert.ok(css.includes('cursor:zoom-in') && css.includes('.image-preview img.is-zoomed{cursor:zoom-out}'), 'base CSS should no longer show zoom-out before the image is actually zoomed');
  assert.ok(flatCss.includes('.image-preview img') && flatCss.includes('cursor: zoom-in !important') && flatCss.includes('.image-preview img.is-zoomed') && flatCss.includes('cursor: zoom-out !important'), 'flat theme should mirror the functional zoom cursor states');
  assert.ok(index.includes('image-preview-workflow.js?v=1.2.67') && index.includes('chatui.bundle.js?v=1.3.145-resilient-snapshot-store') && index.includes('styles/flat-theme.css?v=2.1.95-welcome-globe-only'), 'image preview zoom should bump cache-busting versions');
  assert.ok(bundleSource.includes("BUNDLE_VERSION = '1.3.145-resilient-snapshot-store'"), 'server bundle version should match image preview zoom bundle cache-busting');
}

function testMessageActionButtonsUsePolishedStyle() {
  const flatCss = fs.readFileSync(path.join(__dirname, '../../styles/flat-theme.css'), 'utf8');
  const index = fs.readFileSync(path.join(__dirname, '../../index.html'), 'utf8');
  const bundleSource = fs.readFileSync(path.join(__dirname, '../../server/services/static-bundle.service.js'), 'utf8');
  const messageWorkflow = fs.readFileSync(path.join(__dirname, '../../client/app/message-workflow.js'), 'utf8');
  assert.ok(flatCss.includes('Final message action polish: glassy rounded buttons with subtle per-action accents'), 'message actions should document the shared polished style layer');
  assert.ok(flatCss.includes('.message:not([data-streaming="1"]) .msg-actions:not(:hover)') && flatCss.includes('opacity:.34!important') && flatCss.includes('.message:not([data-streaming="1"]):hover .msg-actions') && flatCss.includes('opacity:.95!important') && !flatCss.includes('.message:hover .msg-actions'), 'message action groups should stay less visually prominent until the pointer moves over non-streaming messages');
  assert.ok(flatCss.includes('.messages>.message:not([data-streaming="1"]) .bubble-wrap') && flatCss.includes('.messages>.message:not([data-streaming="1"]) .content') && flatCss.includes('pointer-events:auto!important'), 'non-streaming message hover should be active across the full bubble/content area, not only the message start');
  assert.ok(flatCss.includes('.message[data-streaming="1"] .msg-actions') && flatCss.includes('transition:none!important') && flatCss.includes('.message[data-streaming="1"] .bubble-wrap') && flatCss.includes('padding-bottom:0!important') && flatCss.includes('.message[data-streaming="1"] .message-meta') && flatCss.includes('position:static!important') && flatCss.includes('pointer-events:none!important'), 'streaming messages should suppress action hover transitions and keep TTFT metadata inert in stable flow to avoid hover flicker');
  assert.ok(flatCss.includes('@media (max-width:840px)') && flatCss.includes('opacity:.52!important'), 'mobile message actions should be visible enough on touch devices without hover');
  assert.ok(flatCss.includes('--msg-action-bg:rgba(255,255,255,.74)') && flatCss.includes('--msg-action-border:rgba(148,163,184,.22)') && flatCss.includes('--msg-action-shadow:0 6px 16px'), 'message actions should use the same glassy button surface as the force-image polish');
  assert.ok(flatCss.includes('backdrop-filter:blur(10px) saturate(145%)') && flatCss.includes('transition:color .14s ease'), 'message action buttons should have refined blur and motion polish');
  assert.ok(index.includes('class="mobile-more-btn icon-action-btn"') && index.includes('aria-expanded="false"'), 'message actions should include a mobile more button for compact touch layouts');
  assert.ok(messageWorkflow.includes('function bindMobileMoreActions') && messageWorkflow.includes("actions.classList.toggle('is-mobile-open')") && messageWorkflow.includes("more.setAttribute('aria-expanded'"), 'message workflow should expand/collapse mobile action buttons through the more button');
  assert.ok(flatCss.includes('.msg-actions:not(.is-mobile-open) .icon-action-btn:not(.mobile-more-btn)') && flatCss.includes('display:none!important') && flatCss.includes('.msg-actions.is-mobile-open .icon-action-btn:not(.mobile-more-btn)'), 'mobile should collapse secondary action buttons behind the more button');
  assert.ok(flatCss.includes('.msg-actions .quote-btn.icon-action-btn{') && flatCss.includes('.msg-actions .edit-btn.icon-action-btn{') && flatCss.includes('.msg-actions .refresh-btn.icon-action-btn{') && flatCss.includes('.msg-actions .copy-btn.icon-action-btn,') && flatCss.includes('.msg-actions .download-answer-btn.icon-action-btn{'), 'all message buttons should be colored in the normal state, not only on hover');
  assert.ok(flatCss.includes('background:var(--msg-action-bg)!important') && flatCss.includes('background: var(--msg-action-bg) !important'), 'message button backgrounds should stay unified while icons and borders carry color');
  assert.ok(!flatCss.includes('background:rgba(239,246,255,.74)!important') && !flatCss.includes('background:rgba(240,253,250,.74)!important') && !flatCss.includes('background:rgba(255,247,237,.78)!important') && !flatCss.includes('background:rgba(236,254,255,.74)!important'), 'message buttons should not use per-action tinted backgrounds');
  assert.ok(flatCss.includes('.msg-actions .quote-btn.icon-action-btn:hover') && flatCss.includes('.msg-actions .edit-btn.icon-action-btn:hover') && flatCss.includes('.msg-actions .refresh-btn.icon-action-btn:hover') && flatCss.includes('.msg-actions .copy-btn.icon-action-btn:hover') && flatCss.includes('.msg-actions .download-answer-btn.icon-action-btn:hover'), 'all message buttons should keep polished per-action hover accents');
  assert.ok(flatCss.includes('transform:translateY(-1px)!important') && flatCss.includes('transform:translateY(0) scale(.96)!important'), 'message action buttons should have subtle hover/active affordance');
  assert.ok(index.includes('assets/chatui.bundle.css?v=1.3.145-resilient-snapshot-store') && index.includes('chatui.bundle.js?v=1.3.145-resilient-snapshot-store') && index.includes('styles/flat-theme.css?v=2.1.95-welcome-globe-only'), 'message action visual polish should bump cache-busting versions');
  assert.ok(bundleSource.includes("BUNDLE_VERSION = '1.3.145-resilient-snapshot-store'"), 'server bundle version should match message action polish cache-busting');
}

function testPendingFeedbackDoesNotWrapOnMobile() {
  const flatCss = fs.readFileSync(path.join(__dirname, '../../styles/flat-theme.css'), 'utf8');
  const formatting = fs.readFileSync(path.join(__dirname, '../../client/app/formatting.js'), 'utf8');
  const imageWorkflow = fs.readFileSync(path.join(__dirname, '../../client/app/image-workflow.js'), 'utf8');
  const jobResumeWorkflow = fs.readFileSync(path.join(__dirname, '../../client/app/job-resume-workflow.js'), 'utf8');
  const index = fs.readFileSync(path.join(__dirname, '../../index.html'), 'utf8');
  const bundleSource = fs.readFileSync(path.join(__dirname, '../../server/services/static-bundle.service.js'), 'utf8');
  assert.ok(flatCss.includes('.pending-feedback{') && flatCss.includes('flex-wrap:nowrap!important') && flatCss.includes('white-space:nowrap!important'), 'pending feedback should keep waiting text on one line');
  assert.ok(flatCss.includes('.pending-text,') && flatCss.includes('.pending-dots{') && flatCss.includes('flex:0 0 auto!important'), 'pending feedback text and dots should not shrink into wrapped fragments');
  assert.ok(flatCss.includes('@media (max-width:640px)') && flatCss.includes('font-size:14px!important') && flatCss.includes('gap:6px!important'), 'mobile pending feedback should be compact enough to avoid wrapping');
  assert.ok(formatting.includes('function pendingFeedbackHtml(value)') && formatting.includes('class="pending-feedback"') && !formatting.includes('route-stage-feedback') && !formatting.includes('task-status-feedback'), 'all waiting prompts should be rendered through one pending feedback component class');
  assert.ok(!flatCss.includes('route-stage-feedback') && !flatCss.includes('task-status-feedback'), 'pending feedback CSS should not keep route-specific or duplicate status style classes');
  assert.ok(!imageWorkflow.includes('<div class="pending-feedback"') && !jobResumeWorkflow.includes('<div class="pending-feedback"'), 'image and resume workflows should use the shared pending feedback renderer instead of handcrafted HTML');
  assert.ok(!imageWorkflow.includes('IMG RUNNING') && !imageWorkflow.includes('setPendingFeedback(d,'), 'image running/waiting prompts should not use a special pending feedback branch');
  assert.ok(imageWorkflow.includes('pendingFeedbackHtml(`${e} 已等待 0 秒`)') && imageWorkflow.includes('pendingFeedbackHtml(`${e} 已等待 ${t} 秒`)') && imageWorkflow.includes('pendingFeedbackHtml(t)'), 'image generation, editing, and upload waits should use the shared pending feedback renderer');
  assert.ok(index.includes('assets/chatui.bundle.css?v=1.3.145-resilient-snapshot-store') && index.includes('chatui.bundle.js?v=1.3.145-resilient-snapshot-store') && index.includes('styles/flat-theme.css?v=2.1.95-welcome-globe-only'), 'pending feedback mobile nowrap fix should bump cache-busting versions');
  assert.ok(bundleSource.includes("BUNDLE_VERSION = '1.3.145-resilient-snapshot-store'"), 'server bundle version should match pending feedback cache-busting');
}

function testComposerWidthFollowsSidebarCollapsedMessageColumn() {
  const flatCss = fs.readFileSync(path.join(__dirname, '../../styles/flat-theme.css'), 'utf8');
  const index = fs.readFileSync(path.join(__dirname, '../../index.html'), 'utf8');
  const bundleSource = fs.readFileSync(path.join(__dirname, '../../server/services/static-bundle.service.js'), 'utf8');
  assert.ok(flatCss.includes('body:not(.session-sidebar-collapsed) .composer,') && flatCss.includes('width:var(--ds-chat-column)!important') && flatCss.includes('left:calc(var(--session-sidebar-width) + (100vw - var(--session-sidebar-width) - var(--ds-chat-column))/2)!important'), 'expanded desktop composer should match the same ds chat column as messages');
  assert.ok(flatCss.includes('--ds-collapsed-chat-column:min(1180px,calc(100vw - var(--session-rail-width) - 72px))!important') && flatCss.includes('body.session-sidebar-collapsed .messages>.message,') && flatCss.includes('body.session-sidebar-collapsed .empty{') && flatCss.includes('width:var(--ds-collapsed-chat-column)!important'), 'collapsed desktop messages should use a wider dedicated reading column after the sidebar frees space');
  assert.ok(flatCss.includes('body.session-sidebar-collapsed .composer,') && flatCss.includes('width:var(--ds-collapsed-chat-column)!important') && flatCss.includes('left:calc(var(--session-rail-width) + (100vw - var(--session-rail-width) - var(--ds-collapsed-chat-column))/2)!important'), 'collapsed desktop composer should be centered on the same wider collapsed reading column');
  assert.ok(index.includes('assets/chatui.bundle.css?v=1.3.145-resilient-snapshot-store') && index.includes('chatui.bundle.js?v=1.3.145-resilient-snapshot-store') && index.includes('styles/flat-theme.css?v=2.1.95-welcome-globe-only'), 'sidebar composer width fix should bump browser cache versions');
  assert.ok(bundleSource.includes("BUNDLE_VERSION = '1.3.145-resilient-snapshot-store'"), 'server bundle version should match sidebar composer cache-busting');
}

function testSubmitDispatchesCanonicalExecutionPlan() {
  const submitWorkflow = sourceAssertions.readSource('client/app/submit-workflow.js');
  const app = sourceAssertions.readSource('app.js');
  for (const source of [submitWorkflow, app]) {
    assert.ok(!source.includes('routeUtils.applyTaskContract'), 'submit flow must not keep the removed legacy RouteInfo-to-TaskContract adapter');
    assert.ok(source.includes('const executionApi=routeInfo.api||'), 'execution branch should dispatch from the canonical execution plan without re-reading or adapting model fields');
  }
}

function testRouteTimeoutShowsSlowNoticeThenFailsCleanly() {
  const routeWorkflow = fs.readFileSync(path.join(__dirname, '../../client/app/route-decision-workflow.js'), 'utf8');
  const submitWorkflow = fs.readFileSync(path.join(__dirname, '../../client/app/submit-workflow.js'), 'utf8');
  const regenerateWorkflow = fs.readFileSync(path.join(__dirname, '../../client/app/regenerate-workflow.js'), 'utf8');
  const flatCss = fs.readFileSync(path.join(__dirname, '../../styles/flat-theme.css'), 'utf8');
  const index = fs.readFileSync(path.join(__dirname, '../../index.html'), 'utf8');
  assert.ok(routeWorkflow.includes('slowNotified = true;') && routeWorkflow.includes('}, 10000);'), 'route recognition should update UI after 10 seconds');
  assert.ok(routeWorkflow.includes('}, 60000);') && routeWorkflow.includes('ROUTE_INTENT_TIMEOUT'), 'route recognition should timeout after 60 seconds with dedicated error');
  const app = fs.readFileSync(path.join(__dirname, '../../app.js'), 'utf8');
  assert.ok(app.includes('routeOptions=null') && app.includes('routeContextOverride,routeOptions'), 'app route wrapper should forward routeOptions so slow UI callbacks fire');
  assert.ok(app.includes('正在执行：路由模型意图识别'), 'slow route notice should show the current routing stage');
  assert.ok(app.includes('function createRouteRecognitionUi') && app.includes('getEffectiveRouteWithSlowNotice') && app.includes('setTimeout(()=>l(ROUTE_SLOW_TEXT),10000)') && submitWorkflow.includes('routeUi=createRouteRecognitionUi') && regenerateWorkflow.includes('createRouteRecognitionUi({sessionId:l'), 'normal submit and regenerate should share one route recognition UX helper');
  assert.ok(regenerateWorkflow.includes('const routeUi=createRouteRecognitionUi({sessionId:l') && app.includes('onStage:l'), 'normal submit and regenerate should reuse the same staged route recognition notice helper');
  assert.ok(routeWorkflow.includes(String.raw`\u6b63\u5728\u6267\u884c\uff1aAI \u590d\u5ba1\u8def\u7531\u5224\u65ad`) && routeWorkflow.includes(String.raw`\u6b63\u5728\u6267\u884c\uff1achat \u6a21\u578b\u5907\u7528\u8def\u7531\u5224\u65ad`), 'route stage notices should include review and fallback routing stages');
  assert.ok(!app.includes('manualIntentChoiceHtml') && !app.includes('data-manual-intent') && !submitWorkflow.includes('waitManualIntentChoice'), 'manual intent fallback UI should be fully removed');
  assert.ok(!flatCss.includes('.manual-intent-card') && !flatCss.includes('.manual-intent-actions'), 'manual intent chooser CSS should be removed');
  const imageWorkflow = fs.readFileSync(path.join(__dirname, '../../client/app/image-workflow.js'), 'utf8');
  assert.ok(imageWorkflow.includes('clearReasoning?.(d)') && imageWorkflow.includes('delete c.reasoningText'), 'image generation should clear route/chat reasoning panel when it starts');
  assert.ok(app.includes('clearReasoning,setImageContext') && index.includes('image-workflow.js?v=1.3.20-edit-resend-tdz'), 'image reasoning cleanup should be wired and cache-busted');
  const sessionPanelWorkflow = fs.readFileSync(path.join(__dirname, '../../client/app/session-panel-workflow.js'), 'utf8');
  assert.ok(sessionPanelWorkflow.includes('window.setTimeout.call(window,()=>n.focus(),a||60)'), 'session panel should bind native setTimeout to window to avoid Illegal invocation');

  const configWorkflow = fs.readFileSync(path.join(__dirname, '../../client/app/config-workflow.js'), 'utf8');
  const dialogWorkflow = fs.readFileSync(path.join(__dirname, '../../client/app/dialog-workflow.js'), 'utf8');
  const performanceWorkflow = fs.readFileSync(path.join(__dirname, '../../client/app/performance-workflow.js'), 'utf8');
  const attachmentsWorkflow = fs.readFileSync(path.join(__dirname, '../../client/app/attachments-workflow.js'), 'utf8');
  assert.ok(configWorkflow.includes('window.setTimeout.call(window,()=>getElement("apiKey")?.focus(),0)'), 'config modal should bind native setTimeout to window and focus the API Key field');
  assert.ok(dialogWorkflow.includes('window.setTimeout.call(window') && dialogWorkflow.includes('window.clearTimeout.call(window'), 'dialog workflow should bind native timers to window');
  assert.ok(performanceWorkflow.includes('window.setTimeout.call(window') && performanceWorkflow.includes('window.clearTimeout.call(window'), 'performance workflow should bind native timers to window');
  assert.ok(attachmentsWorkflow.includes('window.setTimeout.call(window') && attachmentsWorkflow.includes('window.clearTimeout.call(window'), 'attachments workflow should bind native timers to window');

  assert.ok(index.includes('session-panel-workflow.js?v=1.2.67'), 'session panel Illegal invocation fix should bump cache version');
  assert.ok(!submitWorkflow.includes('stopRouteSlowNoticeTimer()') && submitWorkflow.includes('routeUi?.stopSlowNotice?.()'), 'submit cleanup should call the shared route UI timer cleanup instead of a removed local helper');
  assert.ok(!submitWorkflow.includes('state.reasoningMode&&assistantNode&&updateReasoning?.(assistantNode,"",{keepEmpty:!0,followActive:!0})'), 'submit should not show reasoning panel before route recognition returns');
  const chatWorkflow = fs.readFileSync(path.join(__dirname, '../../client/app/chat-workflow.js'), 'utf8');
  assert.ok(chatWorkflow.includes('clearReplacementOnAccepted') && chatWorkflow.includes('reasoningEnabled?(updateMessageContentLight') && chatWorkflow.includes('updateReasoning(g,"",{keepEmpty:!0})'), 'reasoning waiting panel should only appear after the chat request is accepted');
  assert.ok(index.includes('submit-workflow.js?v=1.2.89-session-model-routing') && index.includes('chat-workflow.js?v=1.3.24-task-lifecycle-state-machine') && index.includes('route-decision-workflow.js?v=2.0.3-route-fallback-guard') && index.includes('app.js?v=2.1.48-route-model-switch-guard') && index.includes('flat-theme.css?v=2.1.95-welcome-globe-only'), 'cache versions should be bumped for route timeout UX');
}

function testImageSuccessResultReconciliation() {
  const reconciliation = require('../../client/app/image-result-reconciliation');
  const successDisplay = {
    id: 'display-success',
    role: 'assistant',
    responseIndex: '2',
    jobId: 'job-success',
    html: '<div><img class="generated-thumb" data-persisted-src="indexeddb://image-1"></div>',
    pending: false,
  };
  const staleError = { id: 'display-error', role: 'error', responseIndex: '2', rawText: 'late error' };
  const stalePending = { id: 'display-pending', role: 'assistant', jobId: 'job-success', pending: '1', rawText: '正在生成图片' };
  const unrelatedError = { id: 'display-other-error', role: 'error', responseIndex: '5', rawText: 'keep this error' };
  const successMessage = { role: 'assistant', responseIndex: '2', imageJobId: 'job-success', displayItemId: 'display-success', content: '[图片生成完成] cat' };
  const staleMessageError = { role: 'error', responseIndex: '2', content: 'late error' };
  const unrelatedMessageError = { role: 'error', responseIndex: '5', content: 'keep this error' };
  const session = {
    display: [staleError, stalePending, successDisplay, unrelatedError],
    messages: [{ role: 'user', content: 'cat' }, staleMessageError, successMessage, unrelatedMessageError],
  };

  const result = reconciliation.reconcileSuccessfulImageResult({
    session,
    currentItem: successDisplay,
    job: { id: 'job-success', displayItemId: 'display-success', responseIndex: 2 },
    responseIndex: 2,
  });

  assert.strictEqual(result.changed, true, 'successful image reconciliation should report removed stale records');
  assert.deepStrictEqual(session.display, [successDisplay, unrelatedError], 'same-anchor error/pending display records should be removed while success and unrelated error stay');
  assert.deepStrictEqual(session.messages, [{ role: 'user', content: 'cat' }, successMessage, unrelatedMessageError], 'same responseIndex error message should be removed while successful image and unrelated error stay');
  assert.strictEqual(reconciliation.hasSuccessfulImageResult({
    session,
    item: staleError,
    job: { id: 'job-success', displayItemId: 'display-success', responseIndex: 2 },
    responseIndex: 2,
  }), true, 'late error should detect the already persisted image success through the same anchor');

  const imageWorkflow = fs.readFileSync(path.join(__dirname, '../../client/app/image-workflow.js'), 'utf8');
  const resumeWorkflow = fs.readFileSync(path.join(__dirname, '../../client/app/job-resume-workflow.js'), 'utf8');
  const app = fs.readFileSync(path.join(__dirname, '../../app.js'), 'utf8');
  const index = fs.readFileSync(path.join(__dirname, '../../index.html'), 'utf8');
  assert.ok(imageWorkflow.includes('reconcileSuccessfulImageResult(n,c,'), 'normal image success path should call the shared reconciliation');
  assert.ok(resumeWorkflow.includes('reconcileSuccessfulImageResult(e,i,s,m)'), 'resumed image success path should call the shared reconciliation');
  assert.ok(resumeWorkflow.includes('if(hasSuccessfulImageResult(e,null,s,'), 'resume should discard a stale stored image job before it can recreate a completed image');
  assert.ok(app.includes('if(s&&hasSuccessfulImageResult(e,s,'), 'late showRunError should ignore errors after the same image result succeeded');
  assert.strictEqual((app.match(/reconcileSuccessfulImageResult(?=[,}])/g) || []).length, 2, 'app should inject reconciliation once into each image workflow without duplicate dependency entries');
  assert.ok(index.includes('image-result-reconciliation.js?v=1.0.0') && index.indexOf('image-result-reconciliation.js?v=1.0.0') < index.indexOf('app.js?v=2.1.48-route-model-switch-guard'), 'reconciliation module should load before app.js');
  assert.ok(index.includes('image-workflow.js?v=1.3.20-edit-resend-tdz') && index.includes('job-resume-workflow.js?v=1.2.76-background-settle') && index.includes('app.js?v=2.1.48-route-model-switch-guard'), 'image success reconciliation should bump workflow and app cache versions');
}

function testSessionPersistenceCompactsDuplicateRestoredMessagesByStableIndex() {
  const result = sessionPersistence.compactAdjacentDuplicateMessages([
    { role: 'user', content: '请上传合同截图', rawText: '请上传合同截图', messageIndex: 0 },
    { role: 'assistant', content: '正在处理中 请稍后', rawText: '正在处理中 请稍后', responseIndex: 1 },
    { role: 'assistant', content: '请上传“老客户H2合同盘面截图”', rawText: '请上传“老客户H2合同盘面截图”', responseIndex: 1, displayItemId: 'final-answer' },
  ]);
  assert.deepStrictEqual(result, [
    { role: 'user', content: '请上传合同截图', rawText: '请上传合同截图', messageIndex: '0' },
    { role: 'assistant', content: '请上传“老客户H2合同盘面截图”', rawText: '请上传“老客户H2合同盘面截图”', responseIndex: '1', displayItemId: 'final-answer' },
  ], 'a completed response must replace its stale pending record at the same restore index');
}

function testSessionPersistenceKeepsRichDisplayItemAtDuplicateRestoreIndex() {
  const result = sessionPersistence.compactDisplayItems([
    { id: 'text-fallback', role: 'assistant', rawText: '[base64 image]', responseIndex: '3' },
    { id: 'image-result', role: 'assistant', rawText: '[图片生成完成]', html: '<img data-persisted-src="indexeddb://images/final">', imageContext: '{"images":["indexeddb://images/final"]}', responseIndex: '3' },
  ]);
  assert.strictEqual(result.length, 1, 'duplicate display records must collapse to one restored response');
  assert.strictEqual(result[0].id, 'image-result', 'the durable rich-media record must win over the text fallback');
  assert.ok(result[0].html.includes('data-persisted-src'), 'the persisted image reference must survive compaction');
}
function testSessionPersistenceKeepsDurableImageWhenAStaleTextReplyCollides() {
  const result = sessionPersistence.compactAdjacentDuplicateMessages([
    { role: 'assistant', content: '[图片编辑完成] 客户经营策略信息图', html: '<img class="generated-thumb" data-persisted-src="indexeddb://img/final">', responseIndex: '6' },
    { role: 'assistant', content: '请上传或重新附加“客户H2的合同盘面截图”，当前未检测到可用的图片资源。', responseIndex: '6' },
  ]);
  assert.strictEqual(result.length, 1, 'colliding response records must compact to one message');
  assert.match(result[0].content, /^\[图片编辑完成\]/, 'the completed image canonical record must not be overwritten by a stale text response');
  assert.ok(result[0].html.includes('indexeddb://img/final'), 'the IndexedDB image reference must remain in canonical history');
}

function testSessionPersistenceKeepsDurableImageDisplayWhenAStaleTextReplyCollides() {
  const result = sessionPersistence.compactDisplayItems([
    { id: 'image-result', role: 'assistant', rawText: '[图片编辑完成]', html: '<div class="generated-image-grid"><img class="generated-thumb" data-persisted-src="indexeddb://img/final"></div>', responseIndex: '6', imageContext: '{"attachments":[{"src":"indexeddb://img/final"}]}' },
    { id: 'stale-clarification', role: 'assistant', rawText: '请上传或重新附加合同截图', html: '<div class="markdown-body">请上传或重新附加合同截图</div>', responseIndex: '6' },
  ]);
  assert.strictEqual(result.length, 1, 'colliding display records must compact to one item');
  assert.strictEqual(result[0].id, 'image-result', 'the IndexedDB-backed image display must win over stale text HTML');
  assert.ok(result[0].html.includes('indexeddb://img/final'), 'the result card must retain its persisted source');
}
function testDockerfileIncludesSharedRuntimeModules() {
  const dockerfile = fs.readFileSync(path.join(__dirname, '../../Dockerfile'), 'utf8');
  assert.ok(dockerfile.includes('COPY shared ./shared'), 'Docker image must include shared runtime modules used by server config/jobs');
  assert.ok(dockerfile.includes('COPY server.js index.html route.html app.js styles.css favicon.svg ./'), 'Docker image must include route.html required by the route-diagram modal');
  assert.ok(dockerfile.includes('npm ci --omit=dev --omit=optional --ignore-scripts --no-audit --no-fund'), 'Docker release build should omit optional native packages to avoid arm64 QEMU npm install crashes');
}

const tests = [
  testHttpNormalizeUpstreamErrors,
  testPreflightGuardsOnlyHandleDeterministicConditions,
  testRouteKeepsSingleHistoryImageEditableForDeicticEdit,
  testRouteClarifiesDeicticEditOnlyWithoutAnyImageCandidate,
  testIntentContractStrictlyBuildsOneExecutionPlan,
  testPromptComposerPreservesIntentWithoutOverOptimizing,
  testRouteResultCarriesTaskContractAndComposedPrompt,
  testRouteInstructionDoesNotPolluteImagePrompt,
  testSessionPersistenceCompactsDuplicateRestoredMessagesByStableIndex,
  testSessionPersistenceKeepsRichDisplayItemAtDuplicateRestoreIndex,
  testSessionPersistenceKeepsDurableImageWhenAStaleTextReplyCollides,
  testSessionPersistenceKeepsDurableImageDisplayWhenAStaleTextReplyCollides,
  testAttachmentPresentationRebuildsFromCanonicalDescriptors,
  testCanonicalRendererPrefersImageDescriptorsOverStaleHtml,
  testCanonicalRendererPrefersAttachmentDescriptorsOverGenericHtml,
  testCanonicalBrowserRendererDependenciesAreSharedAndDefined,
  testActiveSessionMessagesUseOneCanonicalCommitBoundary,
  testCanonicalPresentationSanitizesTransientMediaReferences,
  testSessionQuotaFailureNeverTruncatesCanonicalHistory,
  testPendingDisplaySnapshotCannotOverwriteCanonicalMessages,
  testSessionSnapshotPersistsFullCanonicalHistoryAndPendingOnly,
  testUncommittedMetadataRevisionCannotHideLateSnapshot,
  testSnapshotReloadUsesIndependentRevisionTimestamp,
  testDockerfileIncludesSharedRuntimeModules,
  testImageSuccessResultReconciliation,
  testRouteContextUsesTokenWindowAndDropsOldestMessages,
  testRouteContextIsCompactAndIndexed,
  testImageCandidatesUseGlobalIndexesAndExecuteSourceIndexes,
  testImageGenerationPayloadDoesNotRewritePromptOrAutoParams,
  testImageResultParsingSupportsMultipleImages,
  testImageResultRefusesNonDurablePersistence,
  testImageResultStoresOnlyDurableIndexedDbReferences,
  testDownloadFilenamesUseShanghaiTimestamp,
  testImageJobTargetsAndMultipartSanitization,
  testPendingClarificationMergesFollowupSupplements,
  testPendingClarificationModelFinalPromptIsMinimalAndWins,
  testPendingClarificationDoesNotTreatOrdinaryQuestionsAsFollowup,
  testPendingClarificationCanMergeTextFileAndQuote,
  testPendingClarificationCarriesOriginalMultiImageContext,
  testPendingClarificationAcceptsShortImageVariantAnswer,
  testPendingClarificationStateMachineClearsNewTaskAndRecomputesMultiRound,
  testPendingClarificationUsesPreviousImageRequestForVagueFeedback,
  testPendingClarificationClearsAfterMergedSend,
  testPendingClarificationOneShotMissAndMultiRoundContinuity,
  testPendingClarificationCoversImageEditFallbackBranch,
  testImageEditPromptFallbackAndValidation,
  testStorageSanitizesEmbeddedImageContent,
  testPersistedAttachmentPreviewSurvivesDataUrlStripping,
  testFilePlaceholderSemanticsAndFileUnderstanding,
  testQuotedFileAttachmentTextIsIncluded,
  testHistoryFileAttachmentTextIsIncludedInChatContext,
  testGenericAttachmentContextSurvivesCoreNormalizationForRegenerate,
  testHistoryFileCandidatesRouteAsFileQa,
  testUserAttachmentContextFallsBackToImageContextForRegenerate,
  testQuotedAssistantImageContextRestoresFromCanonicalMessage,
  testUploadedImageUsesOneDurableBlobAcrossMessageContexts,
  testStructuredRouteDecisionCarriesRefs,
  testImagePromptExtractionFollowsAiRouteWithCurrentImage,
  testImplicitImagePromptExtractionFollowsAiRouteWithCurrentImage,
  testNormalizeRouteKeepsExplicitImageQaChatDespiteImageIntent,
  testRouteOperationTypeDrivesCanonicalMode,
  testImageResultCorrectionRebuildsImagePrompt,
  testRoutePromptUsesChineseCompactRules,
  testChatAnswerStreamingFlushesQuickly,
  testStreamingTailRendersWithoutCursor,
  testSessionTailFocusPreservesBottomGapDuringDynamicLayout,
  testSessionSwitchFocusesBottom,
  testDeleteSessionCleansRuntimeResources,
  testSessionResourceDisposalDeletesSnapshotWithoutWaitingForJobNetwork,
  testEmptySessionRendersPremiumWelcome,
  testHistoryRenderLoadsNewestMessagesFirst,
  testStreamingAllowsManualScroll,
  testScrollMetricsHelpersArePureAndReusedByWorkflow,
  testMessageDomainIsFeatureModule,
  testMessageModelHelpersAreFeatureModule,
  testQuotePreviewIsFeatureModule,
  testMarkdownFinalRendererIsFeatureModule,
  testMarkdownPreviewIsFeatureModule,
  testMarkdownLiveStreamIsFeatureModule,
  testStreamingMarkdownTablesRemainAtomicUntilFinal,
  testLiveMarkdownStreamPreviewsChunksWithoutLoweringCommitCadence,
  testLiveMarkdownStreamDoesNotBlankExistingContentBeforeFirstPaint,
  testStreamingOutputSmoothnessOptimizations,
  testResumeStreamButtonAnchorsAboveComposer,
  testHistoryAnchorLastQuestionSpacerClearsOnSubmit,
  testHistoryAnchorNavFeature,
  testLargeMarkdownInitialRenderIsProgressive,
  testEnglishImagePromptExtractionFollowsAiRouteWithCurrentImage,
  testImageOnlyAssistantMessageCanBeQuotedWithImageContext,
  testEmptyAssistantImageContextFallsBackToGeneratedThumbs,
  testQuoteResolverUsesCanonicalAndDisplayContext,
  ...usageTests,
  ...serverHardeningTests,
  ...staticBundleTests,
  ...projectToolingTests,
  ...sessionJobRecoveryTests,
  ...sessionJobResumeReconciliationTests,
  ...apiContractTests,
  ...jobRouteTests,
  ...chatStreamParserTests,
  ...chatStreamFallbackTests,
  ...sessionSnapshotFormatTests,
  ...sessionStoreRecoveryTests,
  ...imageJobContractTests,
  ...imageEditPayloadContractTests,
  ...imageServiceContractTests,
  ...imageSessionSwitchMediaTests,
  ...clientContractTests,
  ...submitWorkflowHelperTests,
  ...webPreviewTests,
  ...reasoningWorkflowTests,
  ...reasoningHistoryPersistenceTests,
  ...routeRecognitionSubmitTests,
  ...routeModelFollowSessionTests,
  ...taskContextBoundaryTests,
  ...sessionRouteSwitchContinuityTests,
  ...durableTaskLifecycleTests,
  ...taskLifecycleStateMachineTests,
  ...taskLifecycleTests,
  ...multiImageReferenceRoutingTests,
  ...contentRegionDialogLayoutTests,
  ...regenerateWorkflowTests,
  ...taskStateTests,
  ...doneSoundTests,
  ...messageOrderPersistenceTests,
  ...messageSizeGuardTests,
  ...messageQuoteLayoutTests,
  ...promptImeSubmitGuardTests,
  ...serverSmokeTests,
  ...multiImageComposeFlowSmokeTests,
  testSessionPromptDraftPersistsPerSession,
  testLegacyDocSupportIsRoutedToWordExtractor,
  testResponseMetricsTextIsUnified,
  testRouteDiagramLauncherUsesModal,
  testImageCompletionKeepsLiveMediaVisibleBeforeHydration,
  testResponsesUsesManagedDurableChatJob,
  testTtftStartsAtServerForwardStart,
  testResponsesCompactFtIsNeverZero,
  testFileUploadReturnsFocusToComposerSubmitPath,
  testImageBubblesAreShrinkWrapped,
  testMarkdownTablesShrinkToContent,
  testMarkdownTableAlignmentUsesRendererSemantics,
  testMarkdownDetailsPreserveOpenAttribute,
  testMarkdownDetailsUseNativeCollapsedSemantics,
  testMermaidAutoRenderIsDefaultForFinalMarkdown,
  testLargeMarkdownCompletionRefocusesTail,
  testStreamingDownloadActionIsDisabled,
  testResumeStreamingDoesNotUseStatusTextAsOffset,
  testRestorePendingReusesExistingAssistantNodeByResponseIndex,
  testManagedJobAbortUsesJobService,
  testAttachmentTextExtractionUsesService,
  testRuntimeVersionUsesService,
  testPendingSubmitHandsOffAtomicallyToDurableJob,
  testSessionDisplayUpdatesFinalClarificationHtml,
  testClarificationAssistantNodeKeepsStableDisplayIdentity,
  testPendingSubmitResumeInsertsFallbackAtOriginalPosition,
  testRegenerateSavesEarlyPendingSubmitBeforeRoute,
  testReasoningPreferenceIsSessionScoped,
  testReasoningCompletionEmptyStateText,
  testReasoningCompletesBeforeAnswerStreaming,
  testReasoningUnavailableWhenAnswerStartsWithoutReasoning,
  testReasoningMenuCloseReleasesFocusBeforeAriaHidden,
  testModalCloseReleasesFocusBeforeAriaHidden,
  testCodeActionHoverAndHistoryAnchorActivePolish,
  testArchitectureBoundaryScaffolding,
  testAppBootstrapContextHelper,
  testChatAndRouteUsePublicContextWindow,
  testConfigBaseUrlDefault,
  testConfigCopyButtonsForBaseUrlAndApiKey,
  testSensitiveConfigAndIntentTraceAreNotPersisted,
  testOmittedAttachmentDataDoesNotRenderAsImageUrl,
  testRegenerateRemovesOldAssistantImmediately,
  testForceImageButtonOnUserMessages,
  testImagePreviewWheelZoom,
  testMessageActionButtonsUsePolishedStyle,
  testPendingFeedbackDoesNotWrapOnMobile,
  testComposerWidthFollowsSidebarCollapsedMessageColumn,
  testSubmitDispatchesCanonicalExecutionPlan,
  testRouteTimeoutShowsSlowNoticeThenFailsCleanly,
];


module.exports = tests;
