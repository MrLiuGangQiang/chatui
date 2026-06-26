const assert = require('assert');
const fs = require('fs');
const path = require('path');
const { JSDOM } = require('jsdom');

const routeContext = require('../client/core/image-route-context');
const routeDecision = require('../client/core/route-decision');
const routeService = require('../client/services/route-service');
const imageGeneration = require('../client/services/image-generation-service');
const imageService = require('../client/services/image-service');
const imageJobs = require('../server/jobs/image');
const imageEditPayloadService = require('../server/services/image-edit-payload.service');
const serverConfig = require('../server/config');
const clarificationService = require('../client/services/clarification-service');
const sessionPersistence = require('../client/app/session-persistence');
const chatWorkflow = require('../client/app/chat-workflow');
const imageContextWorkflow = require('../client/app/image-context-workflow');
const messageModel = require('../client/features/messages/message-model');
const messageWorkflow = require('../client/app/message-workflow');
const scrollMetrics = require('../client/ui/scroll-metrics');
const extractApi = require('../server/extract');
const officeExtract = require('../server/extract/office');
const responsesStream = require('../server/proxy/responses-stream');
const appState = require('../client/app/state');
const appContext = require('../client/app/app-context');
const sessionDisplay = require('../client/app/session-display');
const formatting = require('../client/app/formatting');
const markdownEngine = require('../client/app/markdown/markdown-engine');
const markdownSourceNormalizer = require('../client/app/markdown/source-normalizer');
const sourceAssertions = require('../client/testing/source-assertions');
const usageTests = require('./unit/usage.test');
const serverHardeningTests = require('./unit/server-hardening.test');
const staticBundleTests = require('./unit/static-bundle.test');
const apiContractTests = require('./unit/api-contract.test');
const jobRouteTests = require('./unit/job-routes.test');
const chatStreamParserTests = require('./unit/chat-stream-parser.test');
const imageJobContractTests = require('./unit/image-job-contract.test');
const imageEditPayloadContractTests = require('./unit/image-edit-payload-contract.test');
const imageServiceContractTests = require('./unit/image-service-contract.test');
const clientContractTests = require('./unit/client-contract.test');
const submitWorkflowHelperTests = require('./unit/submit-workflow-helpers.test');
const serverSmokeTests = require('./smoke/server-smoke.test');

function stripLargeDataUrlsFromText(text = '') {
  return String(text || '').replace(/data:[^\s"'<>`]+;base64,[A-Za-z0-9+/=\r\n]+/g, '[image-data-omitted]');
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
  assert.ok(payload.messages[0].content.includes('"route":"chat|vision|image_generate|image_edit|unclear|unsafe"'));
  assert.ok(payload.messages[0].content.includes('image_source'));
  const payloadJson = JSON.stringify(payload);
  assert.ok(!/(reasoning|thinking|reasoning_effort|enable_thinking|thinking_budget|thinkingConfig)/i.test(payloadJson), 'route recognition payload should not send thinking/reasoning params');
  const minimalPayload = routeService.buildRoutePayload({ model: 'deepseek-v4-pro', input: '解释一下 JavaScript 里的 Promise 是什么。', attachments: [], context: {}, currentMode: 'chat', autoMode: true });
  assert.strictEqual(minimalPayload.messages[1].content, JSON.stringify({ current_input: '解释一下 JavaScript 里的 Promise 是什么。' }));
  assert.ok(minimalPayload.messages[0].content.length < 2600, `route system prompt too large: ${minimalPayload.messages[0].content.length}`);
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
    selected_indexes: [1],
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
  const submit = fs.readFileSync(path.join(__dirname, '../client/app/submit-workflow.js'), 'utf8');
  assert.ok(!submit.includes('targetSession.pendingClarification=pendingMerge.pending'), 'merged clarification should not stay pending after the answer has been sent');
  assert.ok(submit.includes('if(pendingMerge?.merged&&targetSession.pendingClarification){delete targetSession.pendingClarification'), 'merged clarification should be cleared immediately after routing succeeds');
  assert.ok(!submit.includes('findPendingFromHistory?.(targetSession.messages||state.messages||[])'), 'pending clarification must be an explicit one-shot state, not inferred repeatedly from history');
  assert.ok(submit.includes('const storedPending=clarification.normalizePendingClarification?.(targetSession.pendingClarification)||null'), 'pending clarification should only come from explicit session state');
  assert.ok(submit.includes('if(storedPending&&targetSession.pendingClarification){delete targetSession.pendingClarification'), 'pending clarification state should be consumed/cleared as soon as the next message is submitted');
  const index = fs.readFileSync(path.join(__dirname, '../index.html'), 'utf8');
  assert.ok(index.includes('submit-workflow.js?v=1.3.61'), 'submit workflow cache version should be bumped for pending clarification fix');
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
  const submit = fs.readFileSync(path.join(__dirname, '../client/app/submit-workflow.js'), 'utf8');
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
  assert.strictEqual(multipart.headers['Content-Length'], String(multipart.body.length));
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
  assert.strictEqual((multiImage.body.toString('latin1').match(/name="image"; filename=/g) || []).length, 2);
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
  assert.ok(system.includes('file_candidates'));
  assert.ok(body.includes('"is_image":false'));
  assert.ok(body.includes('"file_candidates"'));
  assert.ok(body.includes('"has_extracted_text":true'));
  assert.ok(!body.includes('CREATE TABLE users'));
  const submitSource = require('fs').readFileSync(require('path').join(__dirname, '../client/app/submit-workflow.js'), 'utf8');
  const appSource = require('fs').readFileSync(require('path').join(__dirname, '../app.js'), 'utf8');
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
  const parsed = require('../client/core/attachments').parseImageContext(JSON.stringify(attachmentContext));
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
  const parsed = routeService.parseRouteResult('{"route":"chat","need_file_input":false,"confidence":0.9}', routeContext.normalizeRoute, {
    input: '从文件中提取最后一个邮箱',
    attachments: [],
    context,
  });
  assert.strictEqual(parsed.mode, 'chat');
  assert.strictEqual(parsed.operation.type, 'file_qa');
  assert.strictEqual(parsed.operation.scope, 'history');
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

function testExistingImageEditGateAllowsPreviousSelection() {
  const submitSource = fs.readFileSync(path.join(__dirname, '../client/app/submit-workflow.js'), 'utf8');
  const appSource = fs.readFileSync(path.join(__dirname, '../app.js'), 'utf8');
  assert.ok(submitSource.includes('canResolveExistingEditImage'), 'submit workflow must allow previous/uploaded image resolver before blocking edit');
  assert.ok(submitSource.includes('!!routeInfo.usePreviousImage') && submitSource.includes('routeInfo.target==="previous"'));
  assert.ok(appSource.includes('canResolveExistingEditImage'), 'regenerate/app workflow must allow previous/uploaded image resolver before blocking edit');
  assert.ok(appSource.includes('!!p.usePreviousImage') && appSource.includes('p.target==="previous"'));
}

function testLightweightIntentClassifierAdapters() {
  const unsafeApi = routeContext.normalizeRoute(routeService.apiRouteToExecutionRoute({
    route: 'unsafe', reply_to_user: '抱歉，这个请求我不能帮助处理。', confidence: 1, reason: 'route model unsafe',
  }, { input: '帮我盗取别人的账号密码', attachments: [], context: {} }), 'chat');
  assert.strictEqual(unsafeApi.mode, 'chat');
  assert.strictEqual(unsafeApi.needClarification, true);
  assert.ok(unsafeApi.clarificationQuestion.includes('不能帮助'));

  const currentImage = [{ name: 'room.png', type: 'image/png', is_image: true }];
  const currentContext = { image_candidates: [] };
  const editCurrent = routeService.parseRouteResult(JSON.stringify({
    route: 'image_edit',
    need_image_input: false,
    need_file_input: false,
    need_clarification: false,
    image_source: 'current',
    selected_indexes: [1],
    use_previous_image: false,
    instruction: '把背景换成海边，保持主体不变',
    reply_to_user: '',
    confidence: 0.95,
    reason: '修改当前上传图片',
  }), routeContext.normalizeRoute, { input: '把背景换成海边', attachments: currentImage, context: currentContext });
  assert.strictEqual(editCurrent.mode, 'edit_image');
  assert.strictEqual(editCurrent.operation.type, 'image_edit');
  assert.strictEqual(editCurrent.target, 'uploaded');
  assert.strictEqual(editCurrent.usePreviousImage, false);
  assert.deepStrictEqual(editCurrent.selectedIndexes, [1]);
  assert.strictEqual(editCurrent.editInstruction, '把背景换成海边，保持主体不变');

  const apiEditCurrent = routeService.parseRouteResult(JSON.stringify({
    route: 'image_edit',
    need_image_input: false,
    need_file_input: false,
    need_clarification: false,
    image_source: 'current',
    selected_indexes: [1],
    use_previous_image: false,
    instruction: '参考这个图做一个后端',
    reply_to_user: '',
    confidence: 0.95,
    reason: '改图接口',
  }), routeContext.normalizeRoute, { input: '参考这个图做一个后端', attachments: currentImage, context: currentContext });
  assert.strictEqual(apiEditCurrent.mode, 'edit_image');
  assert.strictEqual(apiEditCurrent.operation.type, 'image_edit');
  assert.strictEqual(apiEditCurrent.target, 'uploaded');
  assert.strictEqual(apiEditCurrent.editInstruction, '参考这个图做一个后端');

  const apiVisionCurrent = routeService.parseRouteResult(JSON.stringify({
    route: 'vision', image_source: 'current', selected_indexes: [1], confidence: 0.95,
  }), routeContext.normalizeRoute, { input: '提取图片文字', attachments: currentImage, context: currentContext });
  assert.strictEqual(apiVisionCurrent.mode, 'chat');
  assert.strictEqual(apiVisionCurrent.operation.type, 'image_qa');
  assert.strictEqual(apiVisionCurrent.target, 'none');

  const apiTextImage = routeService.parseRouteResult(JSON.stringify({
    route: 'image_generate', instruction: '画一只猫', confidence: 0.95,
  }), routeContext.normalizeRoute, { input: '画一只猫', attachments: [], context: {} });
  assert.strictEqual(apiTextImage.mode, 'image');
  assert.strictEqual(apiTextImage.operation.type, 'text_to_image');
  assert.strictEqual(apiTextImage.target, 'new');

  const promptOptimize = routeService.parseRouteResult(JSON.stringify({
    route: 'image_generate', instruction: '一只猫坐在窗边，温暖阳光，电影感', confidence: 0.95,
  }), routeContext.normalizeRoute, { input: '帮我优化这个生图 prompt：一只猫坐在窗边，阳光很好', attachments: [], context: {} });
  assert.strictEqual(promptOptimize.mode, 'chat');
  assert.strictEqual(promptOptimize.operation.type, 'plain_chat');
  assert.strictEqual(promptOptimize.target, 'none');

  const promptGenerate = routeService.parseRouteResult(JSON.stringify({
    route: 'image_generate', instruction: '极简蓝色机器人头像，白底', confidence: 0.95,
  }), routeContext.normalizeRoute, { input: '帮我生成一个机器人头像的生图提示词，不要画图', attachments: [], context: {} });
  assert.strictEqual(promptGenerate.mode, 'chat');
  assert.strictEqual(promptGenerate.operation.type, 'plain_chat');
  assert.strictEqual(promptGenerate.target, 'none');

  const apiRefImage = routeService.parseRouteResult(JSON.stringify({
    route: 'image_generate', image_source: 'current', selected_indexes: [1], instruction: '参考当前图片风格生成海报', confidence: 0.9,
  }), routeContext.normalizeRoute, { input: '参考这张图的风格生成一张海报', attachments: currentImage, context: currentContext });
  assert.strictEqual(apiRefImage.mode, 'image');
  assert.strictEqual(apiRefImage.operation.type, 'image_reference_gen');
  assert.strictEqual(apiRefImage.target, 'new');

  const quotedContext = { image_candidates: [{ index: 1, image_id: 'img_quote_1', reference_id: 'imgref_quote', target: 'previous', source: 'quoted' }] };
  const editQuoted = routeService.parseRouteResult(JSON.stringify({
    route: 'image_edit', image_source: 'quoted', selected_indexes: [1], instruction: '改成漫画风', confidence: 0.9,
  }), routeContext.normalizeRoute, { input: '改成漫画风', attachments: [], context: quotedContext });
  assert.strictEqual(editQuoted.mode, 'edit_image');
  assert.strictEqual(editQuoted.target, 'previous');
  assert.strictEqual(editQuoted.selectedReferenceId, 'imgref_quote');
  assert.deepStrictEqual(editQuoted.selectedImageIds, ['img_quote_1']);

  const historyContext = { image_candidates: [{ index: 1, image_id: 'img_imgref_latest_1', reference_id: 'imgref_latest', target: 'previous', source: 'history' }], latest_image_reference: { reference_id: 'imgref_latest', target: 'previous' } };
  const editHistory = routeService.parseRouteResult(JSON.stringify({
    route: 'image_edit', image_source: 'history', selected_indexes: [1], use_previous_image: true, instruction: '改成黑白', confidence: 0.9,
  }), routeContext.normalizeRoute, { input: '把上一张改成黑白', attachments: [], context: historyContext });
  assert.strictEqual(editHistory.mode, 'edit_image');
  assert.strictEqual(editHistory.target, 'previous');
  assert.strictEqual(editHistory.usePreviousImage, true);
  assert.strictEqual(editHistory.selectedReferenceId, 'imgref_latest');

  const refGen = routeService.parseRouteResult(JSON.stringify({
    route: 'image_generate', image_source: 'current', selected_indexes: [1], instruction: '参考当前图片风格生成海报', confidence: 0.9,
  }), routeContext.normalizeRoute, { input: '参考这张图的风格生成一张海报', attachments: currentImage, context: currentContext });
  assert.strictEqual(refGen.mode, 'image');
  assert.strictEqual(refGen.operation.type, 'image_reference_gen');
  assert.strictEqual(refGen.target, 'new');
  assert.strictEqual(refGen.intent, 'image_reference_gen');
  assert.deepStrictEqual(refGen.selectedIndexes, [1]);

  const promptFromImage = routeService.parseRouteResult(JSON.stringify({
    route: 'vision', image_source: 'current', selected_indexes: [1], confidence: 1,
  }), routeContext.normalizeRoute, { input: '根据这张图片生成提示词', attachments: currentImage, context: currentContext });
  assert.strictEqual(promptFromImage.mode, 'chat');
  assert.strictEqual(promptFromImage.operation.type, 'image_qa');
  assert.strictEqual(promptFromImage.target, 'none');
  assert.strictEqual(promptFromImage.intent, 'unknown');

  const multiAmbiguous = routeService.parseRouteResult(JSON.stringify({
    route: 'image_edit', image_source: 'current', selected_indexes: [], instruction: '改一下', confidence: 0.6,
  }), routeContext.normalizeRoute, { input: '把这张图改一下', attachments: [{ name: 'a.png', type: 'image/png', is_image: true }, { name: 'b.png', type: 'image/png', is_image: true }], context: { image_candidates: [] } });
  assert.strictEqual(multiAmbiguous.mode, 'chat');
  assert.strictEqual(multiAmbiguous.needClarification, true);
  assert.ok(multiAmbiguous.clarificationQuestion.includes('第几张'));
}

function testRouteDecisionHelpersArePureAndReusedByService() {
  assert.ok(routeDecision.API_ROUTES.has('image_edit'));
  assert.ok(routeDecision.IMAGE_SOURCES.has('quoted'));
  assert.strictEqual(routeService.cleanQuotedContent, routeDecision.cleanQuotedContent);
  assert.strictEqual(routeService.isPromptWritingInput, routeDecision.isPromptWritingInput);
  assert.strictEqual(routeService.isImagePromptExtractionInput, routeDecision.isImagePromptExtractionInput);

  assert.deepStrictEqual(routeDecision.normalizeSelectedIndexes(['2', 1, 2, 0, -1, 'x', 3.5, 1]), [2, 1]);
  assert.strictEqual(routeDecision.currentImageCount([{ is_image: true }, { is_image: false }, null, { is_image: true }]), 2);
  assert.strictEqual(routeDecision.currentFileCount([{ is_image: true }, { is_image: false }, {}, null]), 2);
  assert.strictEqual(routeDecision.cleanQuotedContent('[图片生成完成] 猫\n\n\n耗时：1s\n[base64 image]').trim(), '猫');
  assert.ok(routeDecision.isPromptWritingInput('帮我优化这个图片提示词'));
  assert.strictEqual(routeDecision.isPromptWritingInput('用这个提示词画一张图'), false);
  assert.ok(routeDecision.isImagePromptExtractionInput('根据这张图片生成提示词'));
  assert.strictEqual(routeDecision.isPlainTextChatInput('解释一下 Promise 是什么', []), true);
  assert.strictEqual(routeDecision.isPlainTextChatInput('画一张猫图', []), false);

  const context = { image_candidates: [
    { index: 1, source: 'quoted', target: 'previous', image_id: 'q1' },
    { index: 2, source: 'history', target: 'previous', image_id: 'h1', reference_id: 'imgref_h1' },
  ] };
  assert.strictEqual(routeDecision.inferSourceFromContext('image_edit', 'none', [], context), 'quoted');
  assert.deepStrictEqual(routeDecision.contextImageCandidates(context, 'history').map(item => item.image_id), ['h1']);
  assert.strictEqual(routeDecision.referenceIdForSource('history', routeDecision.contextImageCandidates(context, 'history')), 'imgref_h1');
}

function testStructuredRouteDecisionCarriesRefs() {
  const imageRoute = routeContext.normalizeRoute({
    mode: 'edit_image',
    operation: { type: 'image_edit', scope: 'history', edit_instruction: '变成黑白色' },
    image_refs: [{ role: 'target', image_id: 'img_imgref_latest_1', reference_id: 'imgref_latest', index: 1, target: 'previous', source: 'history' }],
    edit_instruction: '变成黑白色',
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
    file_refs: [{ role: 'source', file_id: 'att_1', index: 1, name: 'mail.txt', source: 'current' }],
    confidence: 0.9,
  }, 'chat');
  assert.strictEqual(fileRoute.mode, 'chat');
  assert.strictEqual(fileRoute.operation.type, 'file_qa');
  assert.strictEqual(fileRoute.fileRefs[0].file_id, 'att_1');
}

function testImagePromptExtractionStaysChatWithCurrentImage() {
  const parsed = routeService.parseRouteResult(JSON.stringify({
    mode: 'image',
    intent: 'image_reference_gen',
    operation: { type: 'image_reference_gen', scope: 'current', prompt: '根据图片生成提示词' },
    confidence: 0.9,
  }), routeContext.normalizeRoute, {
    input: '根据图片生成提示词',
    attachments: [{ name: 'room.png', type: 'image/png', is_image: true }],
    context: { image_candidates: [] },
  });
  assert.strictEqual(parsed.mode, 'chat');
  assert.strictEqual(parsed.operation.type, 'image_qa');
  assert.strictEqual(parsed.imageRefs.length, 1);
  assert.strictEqual(parsed.imageRefs[0].source, 'current');
  assert.strictEqual(parsed.imageRefs[0].target, 'uploaded');
  assert.deepStrictEqual(parsed.selectedIndexes, [1]);
}

function testImplicitImagePromptExtractionStaysChatWithCurrentImage() {
  assert.ok(routeService.isImplicitImagePromptExtractionInput('逆向生成提示词尽量详细'));
  const parsed = routeService.parseRouteResult(JSON.stringify({
    mode: 'edit_image',
    intent: 'image_edit',
    operation: { type: 'image_edit', scope: 'current', edit_instruction: '逆向生成提示词尽量详细' },
    confidence: 0.82,
  }), routeContext.normalizeRoute, {
    input: '逆向生成提示词尽量详细',
    attachments: [{ name: 'sunset.jpg', type: 'image/jpeg', is_image: true }],
    context: { image_candidates: [] },
  });
  assert.strictEqual(parsed.mode, 'chat');
  assert.strictEqual(parsed.operation.type, 'image_qa');
  assert.strictEqual(parsed.imageRefs.length, 1);
  assert.strictEqual(parsed.imageRefs[0].source, 'current');
  assert.strictEqual(parsed.imageRefs[0].target, 'uploaded');
}

function testNormalizeRouteKeepsExplicitImageQaChatDespiteImageIntent() {
  const parsed = routeContext.normalizeRoute({
    mode: 'chat',
    operation: { type: 'image_qa', scope: 'current', prompt: '逆向生成提示词要详细', edit_instruction: '' },
    image_refs: [{ role: 'reference', image_id: 'img_imgref_uploaded_3_1', reference_id: 'imgref_uploaded_3', index: 1, target: 'uploaded', source: 'current' }],
    file_refs: [],
    target: 'none',
    use_previous_image: false,
    selected_reference_id: 'imgref_uploaded_3',
    selected_indexes: [1],
    selected_image_ids: ['img_imgref_uploaded_3_1'],
    need_clarification: false,
    intent: 'image_reference_gen',
    contextual_image_prompt: '',
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
    image_refs: [{ image_id: 'img_imgref_uploaded_3_1', reference_id: 'imgref_uploaded_3', index: 1, target: 'uploaded', source: 'current' }],
    target: 'new',
  }, 'chat');
  assert.strictEqual(imageQa.mode, 'chat');
  assert.strictEqual(imageQa.intent, 'unknown');
  assert.strictEqual(imageQa.target, 'none');
  assert.strictEqual(imageQa.operation.type, 'image_qa');

  const imageEdit = routeContext.normalizeRoute({
    mode: 'chat',
    intent: 'unknown',
    operation: { type: 'image_edit', scope: 'current', edit_instruction: '把背景改成蓝色' },
    image_refs: [{ image_id: 'img_imgref_uploaded_1_1', reference_id: 'imgref_uploaded_1', index: 1, target: 'uploaded', source: 'current' }],
  }, 'chat');
  assert.strictEqual(imageEdit.mode, 'edit_image');
  assert.strictEqual(imageEdit.intent, 'image_edit');
  assert.strictEqual(imageEdit.operation.type, 'image_edit');
}

function testRoutePromptUsesChineseCompactRules() {
  const system = routeService.ROUTE_SYSTEM_PROMPT;
  assert.ok(system.includes('只返回 JSON'));
  ['chat', 'vision', 'image_generate', 'image_edit', 'unclear', 'unsafe'].forEach(type => assert.ok(system.includes(type), `route protocol should define ${type}`));
  ['text_chat', 'file_qa', 'image_reference_generate', 'image_analyze', 'ocr', 'prompt_optimize', 'target_model', 'image_role', 'rewritten_prompt'].forEach(type => assert.ok(!system.includes(type), `route prompt should not expose legacy field/type ${type}`));
  assert.ok(system.includes('image_source'));
  assert.ok(system.includes('selected_indexes'));
  assert.ok(system.includes('use_previous_image'));
  assert.ok(system.includes('current_input 是最新用户输入，优先级最高'), 'route prompt should make latest user input the highest-priority intent');
  assert.ok(system.includes('context 只用于解析明确引用'), 'route prompt should keep history as reference-only background');
  assert.ok(system.includes('历史不能覆盖新任务'), 'route prompt should prevent older context from overriding the new user intent');
  assert.ok(system.includes('上一张') && system.includes('那个文件'), 'route prompt should allow context only for explicit references');
  assert.ok(system.includes('必须返回'));
  assert.ok(system.includes('chat：文字聊天'));
  assert.ok(system.includes('不要猜图片或文件内容'));
  assert.ok(system.length < 1600, `route prompt should stay compact: ${system.length}`);
  const payload = routeService.compactRouteUserPayload({
    input: '重新写一段产品介绍，不要画图',
    context: { recent_messages: [{ role: 'user', content: '上一轮：画一张猫图' }, { role: 'assistant', content: '[图片生成完成] 猫图' }] },
  });
  assert.strictEqual(payload.current_input, '重新写一段产品介绍，不要画图', 'route payload should keep latest user input as a separate primary field');
  assert.ok(payload.context.recent_messages.some(item => item.content.includes('画一张猫图')), 'history can still be present only as background context');
}

function testChatAnswerStreamingFlushesQuickly() {
  const source = fs.readFileSync(path.join(__dirname, '../client/app/chat-workflow.js'), 'utf8');
  assert.ok(source.includes('},{minIntervalMs:40}),S=createRealtimeRenderer'), 'answer stream renderer should flush faster than the old 140ms cadence');
  assert.ok(!source.includes('},{minIntervalMs:140}),S=createRealtimeRenderer'), 'answer stream renderer should not use the old 140ms cadence');
}

function testStreamingTailRendersLightweightCursor() {
  const css = fs.readFileSync(path.join(__dirname, '../styles/flat-theme.css'), 'utf8');
  const renderer = fs.readFileSync(path.join(__dirname, '../client/app/markdown/browser-streaming-renderer.js'), 'utf8');
  const sanitizer = fs.readFileSync(path.join(__dirname, '../client/app/markdown/browser-sanitizer.js'), 'utf8');
  const message = fs.readFileSync(path.join(__dirname, '../client/app/message-workflow.js'), 'utf8');
  const index = fs.readFileSync(path.join(__dirname, '../index.html'), 'utf8');
  assert.ok(renderer.includes('markdown-stream-tail') && renderer.includes('data-markdown-streaming-tail'), 'streaming renderer should keep the unstable tail in one lightweight DOM node');
  assert.ok(renderer.includes('tailTextNode.nodeValue !== next') && renderer.includes('container.appendChild(node)'), 'streaming tail should update a text node and move the caret instead of rerendering the whole tail DOM');
  assert.ok(renderer.includes('removeTailNode();') && renderer.includes('final(container'), 'streaming cursor should be removed during final render');
  assert.ok(sanitizer.includes('ALLOW_DATA_ATTR: true'), 'sanitizer should still allow data attributes if streamed Markdown is sanitized elsewhere');
  assert.ok(css.includes('.markdown-stream-caret') && css.includes('@keyframes markdown-stream-caret-pulse'), 'flat theme should define a visible streaming caret');
  assert.ok(css.includes('prefers-reduced-motion:reduce'), 'streaming caret animation should respect reduced motion');
  assert.ok(!css.includes('@keyframes streaming-caret-neon') && !css.includes('animation: streaming-caret-neon'), 'streaming caret should avoid the old heavy neon animation');
  assert.ok(message.includes('dataset.lastStreamingRaw') && message.includes('e.dataset.lastStreamingRaw === rawValue'), 'message workflow should skip duplicate streaming payloads before touching Markdown DOM');
  assert.ok(index.includes('browser-streaming-renderer.js?v=1.2.89') && index.includes('message-workflow.js?v=1.3.29') && index.includes('flat-theme.css?v=2.1.53'), 'cache-busting versions should be bumped for streaming cursor fixes');
}


function testSessionTailFocusPreservesBottomGapDuringDynamicLayout() {
  const source = fs.readFileSync(path.join(__dirname, '../client/app/scroll-focus-workflow.js'), 'utf8');
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
  const source = fs.readFileSync(path.join(__dirname, '../client/app/session-ui-workflow.js'), 'utf8');
  const app = fs.readFileSync(path.join(__dirname, '../app.js'), 'utf8');
  const index = fs.readFileSync(path.join(__dirname, '../index.html'), 'utf8');
  const css = fs.readFileSync(path.join(__dirname, '../styles/flat-theme.css'), 'utf8');
  assert.ok(source.includes('switchSession(session.id)'), 'session tabs should use the normal v1.3.25 switchSession path instead of an extra override layer');
  assert.ok(!source.includes('switchSessionToBottom'), 'session-ui should not contain the later switch-bottom wrapper');
  const removedOverride = ['session', 'switch', 'override'].join('-') + '.js';
  assert.ok(!index.includes(removedOverride), 'the extra capture-phase session switch override should not be loaded');
  assert.ok(app.includes('scheduleSessionTailFocusAfterLayout') && app.includes('reason:"switch-bottom"'), 'renderActiveSession should still pin the latest tail after a switch');
  assert.ok(css.includes('scroll-behavior:auto!important;'), 'session switch should disable smooth scroll behavior');
}

function testLegacyWelcomeScreenIsRestored() {
  const app = fs.readFileSync(path.join(__dirname, '../app.js'), 'utf8');
  const index = fs.readFileSync(path.join(__dirname, '../index.html'), 'utf8');
  const css = fs.readFileSync(path.join(__dirname, '../styles/flat-theme.css'), 'utf8');
  assert.ok(index.includes('<section id="messages" class="messages"></section>'), 'initial HTML should keep messages empty to avoid welcome flash on refresh');
  assert.ok(!index.includes('empty-welcome'), 'static HTML should not include welcome markup before session restore');
  assert.ok(app.includes('function renderEmptyWelcome'), 'empty session renderer should recreate the old welcome screen after session switches');
  assert.ok(app.includes('ChatUI奥哲AI小助手'), 'old welcome title should be restored in dynamic renderer');
  assert.ok(!app.includes('AI Workspace'), 'welcome screen should not include the removed AI Workspace label');
  assert.ok(app.includes('智能路由') && app.includes('文件理解') && app.includes('图像生成'), 'welcome screen should include the polished AI accents without English label or extra icon');
  assert.ok(!app.includes('welcome-orbit'), 'welcome screen should not include the removed orbit icon');
  assert.ok(app.includes('专注对话 · 智能思考 · 灵感生图 · 高效创作'), 'old welcome subtitle should be restored');
  assert.ok(app.includes('本项目使用openclaw开发 手工编码量为零'), 'old welcome note should use the requested wording');
  assert.ok(app.includes('document.querySelector(".empty-welcome")?.remove()'), 'sending the first message should remove the welcome screen');
  assert.ok(app.includes('function shouldShowEmptyWelcome'), 'welcome renderer should gate on real empty session state');
  assert.ok(app.includes('!s&&!n&&!a'), 'welcome should render only when messages, pending display items, and non-welcome DOM are all empty');
  assert.ok(index.includes('./app.js?v=1.3.49-noflash2'), 'app.js cache version should change after welcome no-flash logic updates');
  assert.ok(css.includes('.empty-welcome') && css.includes('.welcome-title') && css.includes('.welcome-note') && css.includes('.welcome-chips') && css.includes('font-weight:820') && css.includes('repeating-linear-gradient(90deg,transparent 0 26px') && css.includes('linear-gradient(100deg,#111827 0%,#1d2b5f 26%,#4d6bfe 52%,#18b9ee 72%,#111827 100%)') && !css.includes('conic-gradient(from 210deg') && !css.includes('content:"AI"'), 'welcome screen should be cooler and more premium while still matching the calm flat theme');
  assert.ok(!css.includes('.welcome-orbit'), 'removed orbit icon styles should not remain');
}

function testHistoryRenderLoadsNewestMessagesFirst() {
  const source = fs.readFileSync(path.join(__dirname, '../app.js'), 'utf8');
  assert.ok(source.includes('function renderCanonicalMessagesNewestFirst'), 'history render should have a newest-first loader');
  assert.ok(source.includes('for(let a=i;a<n.length;a+=1)renderMessageFromCanonical(e,n[a],a)'), 'initial history render should render the latest tail first');
  assert.ok(source.includes('chooseHistoryTailStart'), 'initial history render should choose a bounded tail window instead of rendering all history');
  assert.ok(source.includes('requestAnimationFrame?requestAnimationFrame(()=>requestAnimationFrame(u)):u()') && source.includes('addEventListener("scroll",d,{passive:!0})'), 'older history listener should be attached only after initial bottom pin frames settle');
  assert.ok(source.includes('for(let t=r-1;t>=m;t-=1)prependRenderedCanonicalMessage(renderMessageFromCanonical(e,n[t],t))'), 'older history should be prepended backwards from the current tail start');
  assert.ok(source.includes('s.scrollTop=q+e'), 'prepended history should compensate scrollTop by the scrollHeight delta');
  assert.ok(source.includes('const c=()=>') && source.includes('s.innerHTML="",markMessagesSession(e)'), 'history tail render should self-repair if boot-time welcome rendering races it');
  assert.ok(source.includes('const q=t.role==="user"?t.messageIndex'), 'display cache matching should use canonical message/response indexes, not tail-window offsets');
  assert.ok(source.includes('displayLookupCache=new WeakMap') && source.includes('displayLookupForSession'), 'display cache matching should pre-index display items instead of rescanning display for every canonical message');
  assert.ok(source.includes('data-history-detached-anchor="1"') && !source.includes('forceRenderCanonicalMessages(o);i=[...t?.querySelectorAll?.(".message.user")'), 'history anchor jump should materialize the requested item without a full canonical rebuild');
  assert.ok(source.includes('renderCanonicalMessagesNewestFirst(t,state.messages),restorePendingDisplayItems'), 'loadChatHistory should use newest-first render instead of full chronological render');
  assert.ok(source.includes('dataset?.tailFirstHistory==="1")return'), 'canonical repair should not fight tail-first history rendering');
  assert.ok(source.includes('dataset?.historyBackfill==="1")return'), 'canonical repair should not fight in-progress reverse backfill');
  const perf = fs.readFileSync(path.join(__dirname, '../client/app/performance-workflow.js'), 'utf8');
  assert.ok(perf.includes('virtualMessages: false'), 'legacy virtualizer should be disabled for deterministic tail-first history rendering');
  const css = fs.readFileSync(path.join(__dirname, '../styles/flat-theme.css'), 'utf8');
  assert.ok(css.includes('min-height:0!important;') && css.includes('height:100%!important;') && css.includes('overflow-y:auto!important;'), 'messages container should be constrained as an internal scroller');
}

function testStreamingAllowsManualScroll() {
  const source = fs.readFileSync(path.join(__dirname, '../client/app/scroll-focus-workflow.js'), 'utf8');
  const bootstrap = fs.readFileSync(path.join(__dirname, '../client/app/bootstrap-workflow.js'), 'utf8');
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

  const workflow = fs.readFileSync(path.join(__dirname, '../client/app/scroll-focus-workflow.js'), 'utf8');
  const index = fs.readFileSync(path.join(__dirname, '../index.html'), 'utf8');
  assert.ok(workflow.includes('loadScrollMetrics') && workflow.includes('root?.ChatUIScrollMetrics') && workflow.includes("require('../ui/scroll-metrics')"), 'scroll focus workflow should load the pure scroll metrics helper with browser/CommonJS fallback');
  assert.ok(!workflow.includes('function distanceToBottom(el)'), 'distanceToBottom should be extracted from the workflow body');
  assert.ok(workflow.includes('nextScrollTopForBottom(el)') && workflow.includes('normalizeThreshold(options.bottomThreshold, BOTTOM_THRESHOLD)'), 'bottom target and threshold math should use the pure helper');
  assert.ok(workflow.includes('manualIntent && event?.type === "scroll" && gap > threshold'), 'manual scroll release condition should remain visibly unchanged');
  assert.ok(index.indexOf('client/ui/scroll-metrics.js') < index.indexOf('client/app/scroll-focus-workflow.js'), 'scroll metrics helper should load before scroll focus workflow');
  assert.ok(index.includes('scroll-focus-workflow.js?v=1.3.33'), 'scroll behavior cache version should remain unchanged for a pure-helper extraction');
}

function testMessageDomainIsFeatureModule() {
  const domain = require('../client/features/messages/message-domain');
  assert.strictEqual(domain.messageRoleLabel('user'), '我');
  assert.strictEqual(domain.messageRoleLabel('assistant'), 'AI');
  assert.strictEqual(domain.normalizeQuoteText('[图片生成完成] hello   TTFT 1s', 20), 'hello');
  assert.deepStrictEqual(domain.readQuoteContext({ role: 'assistant', content: ' ok ', responseIndex: 2 }), { role: 'assistant', content: 'ok', responseIndex: '2' });
  const workflow = fs.readFileSync(path.join(__dirname, '../client/app/message-workflow.js'), 'utf8');
  const index = fs.readFileSync(path.join(__dirname, '../index.html'), 'utf8');
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
  const workflow = fs.readFileSync(path.join(__dirname, '../client/app/message-workflow.js'), 'utf8');
  const domain = fs.readFileSync(path.join(__dirname, '../client/features/messages/message-domain.js'), 'utf8');
  const index = fs.readFileSync(path.join(__dirname, '../index.html'), 'utf8');
  assert.ok(workflow.includes('root.ChatUIFeaturesMessagesModel || messageDomain'), 'message workflow should use the message model helper facade when available');
  assert.ok(workflow.includes('messageModel.hasUsableImageContext'), 'image context usability should be delegated to the model helper');
  assert.ok(workflow.includes('messageModel.resolveDisplayItemKey'), 'display/message key extraction should be delegated to the model helper');
  assert.ok(!workflow.includes('function hasUsableImageContext(value)'), 'message workflow should not keep a duplicate image-context helper');
  assert.ok(domain.includes("require('./message-model')") && domain.includes('messageModel.normalizeQuoteContext'), 'message domain should share quote normalization with the model helper');
  assert.ok(index.indexOf('client/features/messages/message-model.js') < index.indexOf('client/features/messages/message-domain.js'), 'message model should load before message domain');
}

function testQuotePreviewIsFeatureModule() {
  const domain = require('../client/features/messages/message-domain');
  const quotePreviewFactory = require('../client/features/messages/quote-preview');
  const quotePreview = quotePreviewFactory.createQuotePreview({
    readQuoteContext: domain.readQuoteContext,
    normalizeQuoteText: domain.normalizeQuoteText,
    escapeHtml: domain.escapeHtmlLocal,
  });
  const html = quotePreview.renderSentQuotePreview({ role: 'assistant', content: 'hello <b>', responseIndex: 3 });
  assert.ok(html.includes('sent-quote-preview'), 'quote preview feature should render the sent quote button');
  assert.ok(html.includes('hello &lt;b&gt;'), 'quote preview feature should escape quote text');
  assert.ok(quotePreview.withSentQuotePreview('<p>x</p>', { role: 'user', content: 'quote' }).includes('sent-quote-preview'), 'quote preview feature should prepend preview to user html');
  const workflow = fs.readFileSync(path.join(__dirname, '../client/app/message-workflow.js'), 'utf8');
  const index = fs.readFileSync(path.join(__dirname, '../index.html'), 'utf8');
  assert.ok(workflow.includes('ChatUIFeaturesMessagesQuotePreview?.createQuotePreview'), 'message workflow should delegate sent quote preview rendering to the feature module');
  assert.ok(!workflow.includes('function renderSentQuotePreview(value)'), 'message workflow should not keep duplicate sent quote preview HTML generation');
  assert.ok(!workflow.includes('classList.add(\'quoted\')') && !workflow.includes('classList.add("quoted")'), 'selecting a quote source should not add a persistent quoted border class');
  assert.ok(workflow.includes('function scrollQuotedMessageToStart') && workflow.includes("block: 'start'") && !workflow.includes("block: 'center', behavior: 'smooth'"), 'quote preview jumps should align the referenced message start/top, not center it');
  const messageCss = fs.readFileSync(path.join(__dirname, '../styles/messages.css'), 'utf8');
  const flatCss = fs.readFileSync(path.join(__dirname, '../styles/flat-theme.css'), 'utf8');
  assert.ok(!messageCss.includes('.message.quoted') && !flatCss.includes('.message.quoted'), 'quote source/target styling should use one jump flash path, not a separate quoted border path');
  assert.ok(messageCss.includes('.message.quote-target-flash::before') && messageCss.includes('left:-8px!important') && !messageCss.includes('padding-left:12px!important') && messageCss.includes('linear-gradient(180deg,#4d6bfe 0%,#14b8a6 100%)'), 'quote jump target should use a visible gradient side bar outside the message flow so it does not cover or shift content');
  assert.ok(!messageCss.includes('.message.quote-target-flash .bubble::after') && !messageCss.includes('content:"引用位置"'), 'quote jump target should not render a label that covers metadata');
  assert.ok(workflow.includes('setTimeout(clearFlash, 3000)'), 'quote jump target marker should disappear after 3 seconds');
  assert.ok(!messageCss.includes('quote-target-ring') && !messageCss.includes('outline:2px solid'), 'quote jump target should avoid heavy ring/outline effects');
  assert.ok(workflow.includes('function quoteContentTextFromNode') && workflow.includes("'.reasoning-panel,.reasoning-head,.reasoning-content'") && workflow.includes("node?.querySelector?.('.content')"), 'quote content should be resolved from message body and exclude reasoning panels');
  assert.ok(domain.normalizeQuoteText('思考中 推理内容 思考完成 正文', 1200) === '推理内容 正文', 'quote text normalization should remove reasoning status labels');
  assert.ok(index.includes('message-workflow.js?v=1.3.29') && index.includes('message-model.js?v=1.0.1') && index.includes('message-domain.js?v=1.0.1') && index.includes('styles/messages.css?v=1.3.12') && index.includes('chatui.bundle.js?v=1.3.48-arch68'), 'quote filtering and jump flash changes should bump cache versions');
  assert.ok(index.indexOf('client/features/messages/message-domain.js') < index.indexOf('client/features/messages/quote-preview.js'), 'quote preview should load after message domain');  assert.ok(index.indexOf('client/features/messages/quote-preview.js') < index.indexOf('client/app/message-workflow.js'), 'quote preview should load before message workflow');
}

function testMarkdownFinalRendererIsFeatureModule() {
  const feature = fs.readFileSync(path.join(__dirname, '../client/features/messages/markdown-final-renderer.js'), 'utf8');
  const workflow = fs.readFileSync(path.join(__dirname, '../client/app/message-workflow.js'), 'utf8');
  const index = fs.readFileSync(path.join(__dirname, '../index.html'), 'utf8');
  assert.ok(feature.includes('function createMarkdownFinalRenderer'), 'large Markdown final renderer should live in the messages feature module');
  assert.ok(feature.includes('content.replaceChildren(...[...stageContent.childNodes])'), 'feature renderer should still replace visible content only once after offscreen rendering');
  assert.ok(feature.includes('stageContent.append(...batch)'), 'offscreen stage may batch append final HTML away from the visible message');
  assert.ok(workflow.includes('ChatUIFeaturesMessagesMarkdownFinalRenderer?.createMarkdownFinalRenderer'), 'message workflow should delegate final Markdown rendering to the feature module');
  assert.ok(!workflow.includes('function splitMarkdownRenderChunks'), 'message workflow should not keep a duplicate Markdown chunk splitter');
  assert.ok(!workflow.includes('content.replaceChildren(...[...stageContent.childNodes])'), 'message workflow should not own final Markdown DOM replacement details');
  assert.ok(index.indexOf('client/features/messages/markdown-final-renderer.js') < index.indexOf('client/app/message-workflow.js'), 'feature renderer should load before message workflow');
}

function testMarkdownPreviewIsFeatureModule() {
  const preview = require('../client/features/messages/markdown-preview');
  const html = preview.renderMarkdownPreview('## 标题\n\n这是一段 **加粗** 内容。\n\n- 第一项\n- 第二项\n\n```js\nconsole.log(1)\n```');
  assert.ok(html.includes('markdown-preview-lite'), 'large Markdown preview should use a dedicated lightweight preview container');
  assert.ok(html.includes('<h3>标题</h3>'), 'large Markdown preview should render headings without raw markdown markers');
  assert.ok(html.includes('<strong>加粗</strong>'), 'large Markdown preview should render common inline emphasis');
  assert.ok(preview.renderMarkdownPreview('包含 `inline` 代码').includes('<code>inline</code>'), 'large Markdown preview should render inline code without backticks');
  assert.ok(html.includes('<ul>') && html.includes('<li>第一项</li>'), 'large Markdown preview should render lists without raw list markers');
  assert.ok(html.includes('<pre class="markdown-preview-code"><code>console.log(1)</code></pre>'), 'large Markdown preview should render fenced code without backtick fences');
  assert.ok(!html.includes('```'), 'large Markdown preview should not expose code fence markers');

  const workflow = fs.readFileSync(path.join(__dirname, '../client/app/message-workflow.js'), 'utf8');
  const index = fs.readFileSync(path.join(__dirname, '../index.html'), 'utf8');
  assert.ok(workflow.includes('root.ChatUIFeaturesMessagesMarkdownPreview?.renderMarkdownPreview'), 'message workflow should delegate initial large Markdown preview to the feature module');
  assert.ok(index.indexOf('client/features/messages/markdown-preview.js') < index.indexOf('client/app/message-workflow.js'), 'preview feature should load before message workflow');
}

function testMarkdownLiveStreamIsFeatureModule() {
  const feature = fs.readFileSync(path.join(__dirname, '../client/features/messages/markdown-live-stream.js'), 'utf8');
  const message = fs.readFileSync(path.join(__dirname, '../client/app/message-workflow.js'), 'utf8');
  const browserStreaming = fs.readFileSync(path.join(__dirname, '../client/app/markdown/browser-streaming-renderer.js'), 'utf8');
  const index = fs.readFileSync(path.join(__dirname, '../index.html'), 'utf8');
  assert.ok(feature.includes('function createMarkdownLiveStream'), 'large Markdown live streaming should live in a feature module');
  assert.ok(feature.includes('createStreamingRenderer') && feature.includes('active.set(next, container)'), 'live stream feature should reuse stable-boundary incremental Markdown renderer');
  assert.ok(feature.includes('const minIntervalMs = Number.isFinite(options.minIntervalMs) ? options.minIntervalMs : 90') && feature.includes('active.preview?.(next, container)') && feature.includes('deltaLength > 3000'), 'large live stream should keep Markdown commit cadence stable and use lightweight tail previews between commits');
  assert.ok(feature.includes('if (phase.final || phase.reset)') && feature.includes('if (phase.streaming && !phase.final'), 'live stream should avoid expensive enhancement while tokens are arriving');
  assert.ok(message.includes('function updateLiveMarkdownStream'), 'message workflow should use a live Markdown stream path');
  assert.ok(message.includes('messageNode.__markdownLiveStream') && message.includes('liveStream.append(contentNode, next'), 'large streaming Markdown should incrementally append rendered Markdown, not plain text');
  assert.ok(message.includes('e.__markdownLiveStream.final(contentNode, rawValue)'), 'large streaming Markdown should finalize through the incremental stream when possible');
  assert.ok(!message.includes('function updatePlainMarkdownStream'), 'plain-text streaming path should not remain as a duplicate large Markdown implementation');
  assert.ok(!message.includes('streamingPlainMarkdown'), 'large streaming Markdown should not be marked as plain streaming');
  assert.ok(browserStreaming.includes('splitStableTailIncremental') && browserStreaming.includes('scanOffset') && browserStreaming.includes('scanInFence'), 'streaming Markdown should scan stable boundaries incrementally instead of rescanning the whole response every frame');
  assert.ok(browserStreaming.includes('preview(value, container)') && browserStreaming.includes('syncTailNode(container, tail'), 'streaming Markdown should expose lightweight tail preview updates without forcing full Markdown commits');
  assert.ok(browserStreaming.includes("let first = '', second = '', count = 0") && browserStreaming.includes("lastIndexOf('\\n\\n', Math.max(0, beforeTailEnd - 1))"), 'streaming table detection should avoid allocating/splitting the whole tail block on each chunk');
  assert.ok(browserStreaming.includes('const inlineMathTail = hasConservativeInlineMathTail(raw)') && browserStreaming.includes('if (inlineMathTail)'), 'streaming boundary scan should reuse inline-math tail detection within a frame');
  assert.ok(browserStreaming.includes('activeTableBlockStart') && browserStreaming.includes('isMarkdownTableDivider') && browserStreaming.includes('tableStart >= 0'), 'streaming Markdown should keep table blocks unstable until final render so tables are not split into paragraphs');
  assert.ok(index.indexOf('client/features/messages/markdown-live-stream.js') < index.indexOf('client/app/message-workflow.js'), 'live stream feature should load before message workflow');
  assert.ok(index.includes('browser-streaming-renderer.js?v=1.2.89') && index.includes('markdown-live-stream.js?v=1.0.2') && index.includes('message-workflow.js?v=1.3.29'), 'streaming table/smoothness fixes should bump browser cache versions');
}

function testStreamingMarkdownTablesRemainAtomicUntilFinal() {
  const previousWindow = global.window;
  const previousDocument = global.document;
  const dom = new JSDOM('<!doctype html><div id="content"></div>');
  global.window = dom.window;
  global.document = dom.window.document;
  try {
    const streaming = require('../client/app/markdown/browser-streaming-renderer');
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

function testLiveMarkdownStreamPreviewsChunksWithoutLoweringCommitCadence() {
  const previousWindow = global.window;
  const previousDocument = global.document;
  const dom = new JSDOM('<!doctype html><div id="content"></div>');
  global.window = dom.window;
  global.document = dom.window.document;
  try {
    const streaming = require('../client/app/markdown/browser-streaming-renderer');
    const live = require('../client/features/messages/markdown-live-stream').createMarkdownLiveStream({
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

function testStreamingOutputSmoothnessOptimizations() {
  const realtime = fs.readFileSync(path.join(__dirname, '../client/ui/realtime-renderer.js'), 'utf8');
  const message = fs.readFileSync(path.join(__dirname, '../client/app/message-workflow.js'), 'utf8');
  const scroll = fs.readFileSync(path.join(__dirname, '../client/app/scroll-focus-workflow.js'), 'utf8');
  const app = fs.readFileSync(path.join(__dirname, '../app.js'), 'utf8');
  assert.ok(realtime.includes('const requestedIntervalMs') && realtime.includes('Math.max(16, requestedIntervalMs)'), 'explicit realtime render intervals such as 40ms should not be clamped back to the old 80ms default');
  assert.ok(!realtime.includes('Math.max(lowerBoundMs'), 'realtime renderer should not let the default lower bound override a tighter explicit stream interval');
  assert.ok(message.includes("const rawHash = chatStream ? '' : chatuiContentHash(rawValue)") && message.includes('dataset.streamingRawLength'), 'chat streaming updates should avoid full-response hash calculation on every chunk');
  assert.ok(scroll.includes('let activeOutputRaf') && scroll.includes('pendingActiveOutput') && scroll.includes('lockToStreamingOutput(pending.node, pending.options)'), 'streaming output scroll follow should be coalesced into one rAF update');
  assert.ok(app.includes('if(!0===a.deferDomUpdate&&e===state.activeSessionId&&a.skipDisplayUpdate)return;let i=null'), 'active streaming chunks should not rescan the whole message DOM when the visible node and display update are already handled');
}

function testResumeStreamButtonAnchorsAboveComposer() {
  const scroll = fs.readFileSync(path.join(__dirname, '../client/app/scroll-focus-workflow.js'), 'utf8');
  const css = fs.readFileSync(path.join(__dirname, '../styles/composer.css'), 'utf8');
  const index = fs.readFileSync(path.join(__dirname, '../index.html'), 'utf8');
  assert.ok(scroll.includes('button.style.setProperty("--resume-stream-left"'), 'resume stream button should still align horizontally with the composer');
  assert.ok(scroll.includes('button.style.setProperty("--resume-stream-bottom"') && scroll.includes('viewportHeight - composer.top + 10'), 'resume stream button should anchor from the live composer top, not a stale safe-area fallback');
  assert.ok(scroll.includes('state.userScrollLocked && away') && !scroll.includes('!state.streamFocusLocked || away'), 'resume stream button should only show after a real user scroll-away, not flicker during normal streaming auto-follow');
  assert.ok(css.includes('.resume-stream-btn') && css.includes('bottom:var(--resume-stream-bottom'), 'composer stylesheet should place the resume button above the input composer');
  assert.ok(index.includes('styles/composer.css?v=1.3.1') && index.includes('scroll-focus-workflow.js?v=1.3.33'), 'cache-busting versions should be bumped for resume button positioning fixes');
}

function testHistoryAnchorLastQuestionSpacerClearsOnSubmit() {
  const featureSource = fs.readFileSync(path.join(__dirname, '../client/features/history-anchor-nav.js'), 'utf8');
  const submit = fs.readFileSync(path.join(__dirname, '../client/app/submit-workflow.js'), 'utf8');
  const index = fs.readFileSync(path.join(__dirname, '../index.html'), 'utf8');
  const bundleSource = fs.readFileSync(path.join(__dirname, '../server/services/static-bundle.service.js'), 'utf8');
  assert.ok(featureSource.includes('const isLastQuestionNode = node =>') && featureSource.includes('const pinLastQuestionToTop = isLastQuestionNode(node)'), 'history anchor should only add tail spacer when the clicked directory item is the last question that needs top pinning');
  assert.ok(featureSource.includes('if (pinLastQuestionToTop) ensureJumpScrollSpace(node, 18)') && featureSource.includes('if (!pinLastQuestionToTop) clearJumpScrollSpace()'), 'older directory jumps should not leave artificial tail space behind');
  assert.ok(featureSource.includes("markManualScroll?.({ type: 'history-anchor-nav', tailSpacer: pinLastQuestionToTop })"), 'history anchor should expose whether the jump used a tail spacer for debugging/state logic');
  assert.ok(submit.includes('root.ChatUIHistoryAnchorNav?.cancelPendingJump?.({ clearSpacer: true })'), 'submitting a new message should clear directory jump spacer and cancel delayed corrections before dynamic rendering');
  assert.ok(index.includes('history-anchor-nav.js?v=1.0.16') && index.includes('submit-workflow.js?v=1.3.61') && index.includes('chatui.bundle.js?v=1.3.48-arch68'), 'history spacer submit fix should bump browser cache versions');
  assert.ok(bundleSource.includes("BUNDLE_VERSION = '1.3.48-arch68'"), 'server bundle version should match the directory spacer fix cache-busting');
}

function testHistoryAnchorNavFeature() {
  const feature = require('../client/features/history-anchor-nav');
  assert.strictEqual(feature.normalizeQuestionTitle('## cursor 返回的以下几种事件...', 40), 'cursor 返回的以下几种事件...', 'question anchors should strip markdown heading markers');
  assert.strictEqual(feature.normalizeQuestionTitle('```js\nconsole.log(1)\n```\nMYSQL 如何查看表的所有列', 40), 'MYSQL 如何查看表的所有列', 'question anchors should ignore fenced code blocks in titles');

  const index = fs.readFileSync(path.join(__dirname, '../index.html'), 'utf8');
  const bootstrap = fs.readFileSync(path.join(__dirname, '../client/app/bootstrap-workflow.js'), 'utf8');
  const featureSource = fs.readFileSync(path.join(__dirname, '../client/features/history-anchor-nav.js'), 'utf8');
  const css = fs.readFileSync(path.join(__dirname, '../styles/flat-theme.css'), 'utf8');
  const app = fs.readFileSync(path.join(__dirname, '../app.js'), 'utf8');
  const scroll = fs.readFileSync(path.join(__dirname, '../client/app/scroll-focus-workflow.js'), 'utf8');
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
  const message = fs.readFileSync(path.join(__dirname, '../client/app/message-workflow.js'), 'utf8');
  const perf = fs.readFileSync(path.join(__dirname, '../client/app/performance-workflow.js'), 'utf8');
  const css = fs.readFileSync(path.join(__dirname, '../styles/flat-theme.css'), 'utf8');
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
  const scroll = fs.readFileSync(path.join(__dirname, '../client/app/scroll-focus-workflow.js'), 'utf8');
  assert.ok(scroll.includes('raf(() => requestBottomScroll({ ...options, force: false, beforePaint: true, ignoreManualSuppress: false'), 'delayed bottom-lock correction should respect manual scroll suppression');
  assert.ok(scroll.includes('if (wheelDelta < -1 || event?.type === "touchmove")'), 'manual upward wheel/touch movement should be detected before async Markdown layout compensation runs');
  assert.ok(scroll.includes('releaseBottomScrollLock({ bumpVersion: true, suppressMs: 1600 })'), 'manual upward wheel/touch movement should immediately release bottom lock');
  assert.ok(message.includes('addMessage: addMessageProgressive'), 'workflow should export the progressive addMessage implementation');
  assert.ok(!perf.includes("if (raw.length > 8000 || raw.split('\\n').length > 180) return true;"), 'large Markdown should not be forced into lazy placeholder rendering');
}

function testEnglishImagePromptExtractionStaysChatWithCurrentImage() {
  const parsed = routeService.parseRouteResult(JSON.stringify({
    mode: 'image',
    intent: 'image_reference_gen',
    operation: { type: 'image_reference_gen', scope: 'current', prompt: 'generate a prompt from this image' },
    confidence: 0.9,
  }), routeContext.normalizeRoute, {
    input: 'generate a prompt from this image',
    attachments: [{ name: 'room.png', type: 'image/png', is_image: true }],
    context: { image_candidates: [] },
  });
  assert.strictEqual(parsed.mode, 'chat');
  assert.strictEqual(parsed.operation.type, 'image_qa');
  assert.strictEqual(parsed.imageRefs.length, 1);
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
        { role: 'assistant', content: '[图片生成完成]', rawText: '[base64 image] RT 1s', imageContext },
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

function testSessionPromptDraftPersistsPerSession() {
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
  workflow.loadSessions();
  assert.strictEqual(state.sessions.find(item => item.id === 'session-a').promptDraft, 'A 草稿');
  assert.strictEqual(state.sessions.find(item => item.id === 'session-b').promptDraft, 'B 草稿');
}

function testLegacyDocSupportIsRoutedToWordExtractor() {
  assert.strictEqual(extractApi.fileKind('Mysql实用手册.doc', 'application/msword'), 'office');
  assert.strictEqual(require('../client/app/attachments-workflow').canExtractOfficeText({ name: 'Mysql实用手册.doc', type: 'application/msword' }), true);
  assert.strictEqual(typeof officeExtract.extractLegacyDocWithWordExtractor, 'function');
}

function testResponseMetricsTextIsUnified() {
  assert.strictEqual(formatting.responseMetricsText({ firstTokenMs: 37, durationMs: 5678 }), 'TTFT 37ms · RT 5.7s');
  assert.strictEqual(formatting.responseMetricsText({ firstTokenMs: 1234, durationMs: 5678 }), 'TTFT 1.2s · RT 5.7s');
  assert.strictEqual(formatting.responseMetricsText({ durationMs: 61000, includeFirstToken: false }), 'RT 1m 1s');
  const metrics = require('../client/services/chat-service').extractChatJobText({ metrics: { firstTokenMs: 100, durationMs: 220 }, choices: [{ message: { content: 'ok' } }] });
  assert.strictEqual(metrics.firstTokenMs, 100);
  assert.strictEqual(metrics.durationMs, 220);
}

function testResponsesDirectDoesNotRegisterManagedChatJob() {
  const source = fs.readFileSync(path.join(__dirname, '../client/app/chat-workflow.js'), 'utf8');
  assert.ok(source.includes('useResponsesDirect=shouldUseResponsesReasoning'), 'Responses path should be decided before chat-job allocation');
  assert.ok(source.includes('useManagedChatJob=!useResponsesDirect'), 'Responses direct stream must not use managed chat-job lifecycle');
  assert.ok(source.includes('let f=useManagedChatJob?(n.clientJobId||u?.jobId||makeClientChatJobId()):null'), 'chat job id should only exist for managed chat/completions stream');
  assert.ok(source.includes('if(useResponsesDirect){f&&(delete u.jobId,persistSessionDisplay(i),clearChatJob?.(i));const Q=async e=>streamChatCompletions'), 'Responses stream should use the direct stream branch');
  assert.ok(source.includes('N=useResponsesDirect'), 'fallback branch should keep the same transport family and avoid recomputing into another job path');
}

function testTtftStartsAtServerForwardStart() {
  const serverSource = fs.readFileSync(path.join(__dirname, '../server/jobs/chat.js'), 'utf8');
  const parserSource = fs.readFileSync(path.join(__dirname, '../server/jobs/chat-stream-parser.js'), 'utf8');
  const appSource = fs.readFileSync(path.join(__dirname, '../app.js'), 'utf8');
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
  const bootstrapSource = fs.readFileSync(path.join(__dirname, '../client/app/bootstrap-workflow.js'), 'utf8');
  const attachmentSource = fs.readFileSync(path.join(__dirname, '../client/app/attachments-workflow.js'), 'utf8');
  assert.ok(bootstrapSource.includes('e.target.value="",updateSendAvailability?.();const t=$("prompt"),s=$("sendBtn"),n=t&&!t.disabled?t:s,o=()=>n?.focus?.();(window.requestAnimationFrame||window.setTimeout).call(window,o,0),window.setTimeout.call(window,o,80)'), 'file input change should move focus away from file button/input to prompt or send button with browser-bound timers');
  assert.ok(attachmentSource.includes('root.requestAnimationFrame.call(root, focus)'), 'attachment workflow should call requestAnimationFrame with the window/root binding');
  assert.ok(attachmentSource.includes('function focusComposerSubmitTarget()'), 'attachment workflow should centralize post-upload focus restore');
  assert.ok(attachmentSource.includes('finishUploadProgressSoon();\n      focusComposerSubmitTarget();'), 'addFiles completion should restore focus to composer submit target');
}

function testImageBubblesAreShrinkWrapped() {
  const source = fs.readFileSync(path.join(__dirname, '../styles/flat-theme.css'), 'utf8');
  assert.ok(source.includes('.message .content:has(.user-attachment-preview-grid),') && source.includes('.message .content:has(.generated-image-grid){') && source.includes('width:fit-content!important;'), 'image message content should be shrink-wrapped instead of full-width');
  assert.ok(source.includes('.message.user .bubble:has(.user-attachment-preview-grid),') && source.includes('.message.assistant .bubble:has(.generated-image-grid),') && source.includes('.message.error .bubble:has(.generated-image-grid){'), 'image bubbles should be shrink-wrapped to the image grid');
  assert.ok(source.includes('width:fit-content!important;') && source.includes('max-width:100%!important;') && source.includes('min-width:0!important;'), 'image grids should use fit-content width with max-width guard');
}

function testMarkdownTablesShrinkToContent() {
  const source = fs.readFileSync(path.join(__dirname, '../styles/flat-theme.css'), 'utf8');
  assert.ok(source.includes('.markdown-body .table-wrapper') && source.includes('width:100%!important;') && source.includes('overflow-x:auto!important;'), 'table wrapper should fill the message width and scroll when needed');
  assert.ok(source.includes('.markdown-body table') && source.includes('width:max-content!important;') && source.includes('min-width:100%!important;'), 'tables should fill available width while allowing wider content to scroll');
}

function testMarkdownTableAlignmentUsesRendererSemantics() {
  const html = markdownEngine.renderMarkdown('| Left | Center | Right |\n|:---|:---:|---:|\n| a | b | c |');
  assert.ok(html.includes('class="md-align-left"'), 'left-aligned markdown table cells should keep semantic alignment class');
  assert.ok(html.includes('class="md-align-center"'), 'center-aligned markdown table cells should keep semantic alignment class');
  assert.ok(html.includes('class="md-align-right"'), 'right-aligned markdown table cells should keep semantic alignment class');
  assert.ok(!/text-align\s*:/i.test(html), 'renderer should not rely on inline text-align styles after normalization');
  const css = fs.readFileSync(path.join(__dirname, '../styles/flat-theme.css'), 'utf8');
  assert.ok(css.includes('.markdown-body th.md-align-center') && css.includes('text-align:center!important;'), 'theme should map md-align-center to centered cells');
  assert.ok(css.includes('.markdown-body th.md-align-right') && css.includes('text-align:right!important;'), 'theme should map md-align-right to right-aligned cells');
  assert.ok(css.indexOf('.markdown-body th.md-align-center') < css.indexOf('/* User actions belong under the user bubble'), 'markdown table alignment should live with the table theme rules, not as a late tail override');
  assert.ok(!css.includes('text-align:left!important;\n  vertical-align:top!important;'), 'theme must not force every markdown table cell to left alignment');
}

function testMarkdownDetailsPreserveOpenAttribute() {
  const browserSanitizer = fs.readFileSync(path.join(__dirname, '../client/app/markdown/browser-sanitizer.js'), 'utf8');
  const nodeSanitizer = fs.readFileSync(path.join(__dirname, '../client/app/markdown/sanitizer.js'), 'utf8');
  assert.ok(browserSanitizer.includes("'details', 'summary'") && browserSanitizer.includes("'open'"), 'browser sanitizer should preserve details/summary and open attribute');
  assert.ok(nodeSanitizer.includes("'details', 'summary'") && nodeSanitizer.includes("'open'"), 'node sanitizer should preserve details/summary and open attribute');
}

function testMarkdownDetailsUseNativeCollapsedSemantics() {
  const shorthand = markdownSourceNormalizer.normalizeMarkdownSource('::: details 点击展开详情\n这里是折叠内容。\n\n- 可以包含 **Markdown**\n:::');
  assert.ok(shorthand.includes('<details>') && shorthand.includes('<summary>点击展开详情</summary>') && shorthand.includes('</details>'), 'details container shorthand should normalize into native details/summary tags');
  const html = markdownEngine.renderMarkdown('<details>\n<summary>点击展开详情</summary>\n这里是折叠内容。\n\n- 可以包含 **Markdown**\n</details>');
  assert.ok(html.includes('<details>') && html.includes('<summary>点击展开详情</summary>'), 'renderer should preserve native details and summary');
  assert.ok(html.includes('<strong>Markdown</strong>'), 'markdown inside details should still render after normalization inserts the required blank line');
  const css = fs.readFileSync(path.join(__dirname, '../styles/flat-theme.css'), 'utf8');
  assert.ok(css.includes('.markdown-body details:not([open]) > :not(summary)') && css.includes('display:none!important;'), 'closed details should hide non-summary children with component semantics');
}

function testMermaidAutoRenderIsDefaultForFinalMarkdown() {
  const workflow = fs.readFileSync(path.join(__dirname, '../client/app/message-workflow.js'), 'utf8');
  const performance = fs.readFileSync(path.join(__dirname, '../client/app/performance-workflow.js'), 'utf8');
  const app = fs.readFileSync(path.join(__dirname, '../app.js'), 'utf8');
  assert.ok(workflow.includes('autoRenderMermaid: true'), 'message workflow should request Mermaid auto rendering for final assistant markdown');
  assert.ok(workflow.includes('forceMermaid: true'), 'final assistant markdown should render all Mermaid diagrams by default, not only visible ones');
  assert.ok(workflow.includes('autoRenderMermaid: !!phase.final') && workflow.includes('forceMermaid: !!phase.final'), 'streaming renderer should defer Mermaid during streaming and auto render all diagrams on final');
  assert.ok(performance.includes('autoRenderMermaid: true') && performance.includes('forceMermaid: true'), 'lazy markdown rendering should auto render Mermaid once materialized');
  assert.ok(app.includes('autoRenderMermaid:!0') && app.includes('forceMermaid:!0'), 'visible markdown rerender should keep Mermaid default rendering behavior');
  assert.ok(!workflow.includes('enhanceRenderedMarkdown(n,{skipMermaid:!0,allowResourceLoad:!0})'), 'final addMessage path must not hard-disable Mermaid rendering');
}

function testLargeMarkdownCompletionRefocusesTail() {
  const workflow = fs.readFileSync(path.join(__dirname, '../client/app/message-workflow.js'), 'utf8');
  const feature = fs.readFileSync(path.join(__dirname, '../client/features/messages/markdown-final-renderer.js'), 'utf8');
  const enhancer = fs.readFileSync(path.join(__dirname, '../client/app/markdown/enhancer.js'), 'utf8');
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
  const css = fs.readFileSync(path.join(__dirname, '../styles/flat-theme.css'), 'utf8');
  assert.ok(css.includes('.message[data-streaming="1"] .download-answer-btn'), 'download button should be hidden while streaming');
  assert.ok(css.includes('pointer-events:none!important;'), 'streaming actions should not receive pointer events');
}

function testResumeStreamingDoesNotUseStatusTextAsOffset() {
  const source = fs.readFileSync(path.join(__dirname, '../client/app/job-resume-workflow.js'), 'utf8');
  const app = fs.readFileSync(path.join(__dirname, '../app.js'), 'utf8');
  assert.ok(source.includes('isChatStatusText(e)?"":e'), 'resume offsets should ignore transient status text');
  assert.ok(source.includes('r();try{const t=getConfig()'), 'resume should immediately paint a non-empty status instead of waiting blank');
  assert.ok(source.includes('if(!m.content&&!m.reasoning){try{const e=l(await getChatJob(s.id,{resumeOffsets:R()}))'), 'empty compact done events should refetch the final job snapshot');
  assert.ok(app.includes('resumeSessionJobs(t.id)}'), 'session render should always attempt to rebind or resume pending jobs after switch/render');
  assert.ok(app.includes('state.pageUnloading=!1;const t=loadImageJob'), 'resume should clear stale page-unloading state after refresh/pageshow');
  assert.ok(app.includes('if(s?.id){if(sessionHasCompletedAssistantForResponse(n,s.responseIndex))return clearChatJob(e);return void setTimeout(()=>resumeChatJob(e),0)}'), 'chat resume should be keyed by the stored job response index, not only by user/assistant counts');
  assert.ok(app.includes('pendingJob&&resumeSessionJobs(e);try{'), 'foreground refresh should resume pending jobs even when busy state was lost after reload');
}

function testRestorePendingReusesExistingAssistantNodeByResponseIndex() {
  const source = fs.readFileSync(path.join(__dirname, '../client/app/display-history-workflow.js'), 'utf8');
  assert.ok(source.includes("node = nodes.find(candidate => candidate.classList.contains('assistant') && candidate.dataset.responseIndex === String(responseIndex))"), 'pending restore should find an existing assistant node by responseIndex before adding a new node');
  assert.ok(source.includes('node.__displayItem = item;'), 'pending restore should rebind the pending display item to the existing node');
  assert.ok(!source.includes('dataset.displayItemId!==t.id'), 'pending restore must not remove/recreate the assistant node only because displayItemId changed');
}

async function testManagedJobAbortUsesJobService() {
  const jobService = require('../client/services/job-service');
  const calls = [];
  const response = await jobService.abortManagedJob({ kind: 'image', jobId: 'abc/123', fetchImpl: async (...args) => { calls.push(args); return { ok: true, status: 200 }; } });
  assert.strictEqual(response.ok, true);
  assert.strictEqual(calls[0][0], '/api/image-jobs/abc%2F123/abort');
  assert.deepStrictEqual(calls[0][1], { method: 'POST' });
  await jobService.abortManagedJob({ kind: 'chat', jobId: '', fetchImpl: async () => { throw new Error('should not call fetch'); } });
  const composition = fs.readFileSync(path.join(__dirname, '../client/services/composition.js'), 'utf8');
  assert.ok(composition.includes('abortManagedJob: options => jobService.abortManagedJob(withHttpDeps(options))'), 'composition should expose job abort through ChatUIServices.jobs');
  const appSource = fs.readFileSync(path.join(__dirname, '../app.js'), 'utf8');
  assert.ok(appSource.includes('window.ChatUIServices?.jobs||window.ChatUIJobService'), 'app abort path should use job service first');
  assert.ok(appSource.includes('s.abortManagedJob({kind:e,jobId:t,fetchImpl:fetch})'), 'app abort path should delegate to job-service abort API');
}

async function testAttachmentTextExtractionUsesService() {
  const attachmentService = require('../client/services/attachment-service');
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

  const workflow = fs.readFileSync(path.join(__dirname, '../client/app/attachments-workflow.js'), 'utf8');
  const composition = fs.readFileSync(path.join(__dirname, '../client/services/composition.js'), 'utf8');
  const browser = fs.readFileSync(path.join(__dirname, '../client/services/browser.js'), 'utf8');
  const index = fs.readFileSync(path.join(__dirname, '../index.html'), 'utf8');
  assert.ok(workflow.includes('root.ChatUIServices?.attachments || root.ChatUIAttachmentService'), 'attachments workflow should prefer the attachment service boundary');
  assert.ok(workflow.includes('attachmentService.extractFileText({ item, fetchImpl: root.fetch?.bind(root), parseResponseJson, normalizeError })'), 'attachment text extraction should delegate to service');
  assert.ok(composition.includes('attachments: attachmentsApi'), 'service composition should expose attachment APIs');
  assert.ok(browser.includes('attachments: Object.freeze(attachments)'), 'browser service facade should expose attachments namespace');
  sourceAssertions.assertInOrder(index, './client/services/attachment-service.js', './client/services/composition.js', 'attachment service should load before service composition');
  sourceAssertions.assertInOrder(index, './client/services/browser.js', './client/app/attachments-workflow.js', 'service browser facade should load before attachment workflow');
}

async function testRuntimeVersionUsesService() {
  const runtimeService = require('../client/services/runtime-service');
  const calls = [];
  const version = await runtimeService.requestAppVersion({
    fetchImpl: async (...args) => { calls.push(args); return { ok: true, json: async () => ({ version: '1.2.3' }) }; },
  });
  assert.strictEqual(version, '1.2.3');
  assert.strictEqual(calls[0][0], '/api/version');
  assert.deepStrictEqual(calls[0][1], { cache: 'no-store' });

  const runtime = fs.readFileSync(path.join(__dirname, '../client/app/runtime.js'), 'utf8');
  const composition = fs.readFileSync(path.join(__dirname, '../client/services/composition.js'), 'utf8');
  const browser = fs.readFileSync(path.join(__dirname, '../client/services/browser.js'), 'utf8');
  const index = fs.readFileSync(path.join(__dirname, '../index.html'), 'utf8');
  assert.ok(runtime.includes('runtimeService = window.ChatUIServices?.runtime || window.ChatUIRuntimeService'), 'runtime app should prefer the runtime service boundary');
  assert.ok(runtime.includes('runtimeService.requestAppVersion({ fetchImpl })'), 'version loading should delegate to runtime service');
  assert.ok(composition.includes('requestAppVersion: options => runtimeService.requestAppVersion(withHttpDeps(options))'), 'service composition should expose runtime version API');
  assert.ok(browser.includes('runtime: Object.freeze(runtime)'), 'browser service facade should expose runtime namespace');
  sourceAssertions.assertInOrder(index, './client/services/runtime-service.js', './client/services/composition.js', 'runtime service should load before service composition');
  sourceAssertions.assertInOrder(index, './client/services/browser.js', './client/app/runtime.js', 'service browser facade should load before runtime app workflow');
}

function testChatJobIdIsPersistedBeforeRouteResolution() {
  const submit = fs.readFileSync(path.join(__dirname, '../client/app/submit-workflow.js'), 'utf8');
  const chat = fs.readFileSync(path.join(__dirname, '../client/app/chat-workflow.js'), 'utf8');
  const app = fs.readFileSync(path.join(__dirname, '../app.js'), 'utf8');
  const prepareIndex = submit.indexOf('const prepareManagedChatJobForLiveItem=()=>');
  const routeIndex = submit.indexOf('routeInfo=await getEffectiveRoute');
  assert.ok(prepareIndex >= 0 && routeIndex > prepareIndex, 'submit should prepare and persist a managed chat job id before route resolution can be interrupted by refresh');
  assert.ok(submit.includes('saveChatJob(sessionId,{id:preparedChatJobId,prompt:promptText,startedAt:Date.now(),displayItemId:liveItem.id||"",responseIndex,mode:"chat"})'), 'submit should immediately save the client chat job id with display item and response index');
  assert.ok(submit.includes('await sendChat(chatPrompt,chatAttachments,assistantNode,{sessionId,userAlreadyAdded:!0,liveItem,replaceAssistantIndex:replacement?.responseIndex,requestBaseMessages,quotedMessage:pendingMerge?.merged?null:quotedMessage,clientJobId:preparedChatJobId})'), 'sendChat should receive the pre-persisted job id and ignore unrelated quoted messages when a pending clarification was merged');
  assert.ok(chat.includes('let f=useManagedChatJob?(n.clientJobId||u?.jobId||makeClientChatJobId()):null'), 'chat workflow should reuse the pre-persisted job id and only allocate a fallback when absent');
  assert.ok(chat.includes('persistChatJobSnapshot') && chat.includes('deps.saveChatJobWithMedia(sessionId, { ...job, payload })'), 'chat workflow should enrich the same job record with payload once the final payload exists');
  assert.ok(app.includes('makeClientChatJobId,saveChatJob,clearChatJob,shouldPrepareManagedChatJob'), 'app bootstrap should inject the single chat job id lifecycle into submit workflow');
}

function testSessionDisplayUpdatesFinalClarificationHtml() {
  const source = fs.readFileSync(path.join(__dirname, '../client/app/session-display.js'), 'utf8');
  assert.ok(source.includes('if (options.deferPersist !== true) item.html ='), 'final display updates should refresh item html');
  assert.ok(!source.includes('options.deferPersist !== true && options.pending !== false'), 'final pending=false updates must not skip html refresh');
}

function testClarificationAssistantNodeKeepsStableDisplayIdentity() {
  const submit = fs.readFileSync(path.join(__dirname, '../client/app/submit-workflow.js'), 'utf8');
  const image = fs.readFileSync(path.join(__dirname, '../client/app/image-workflow.js'), 'utf8');
  assert.ok(submit.includes('assistantNode&&(assistantNode.__displayItem=liveItem,liveItem?.id&&(assistantNode.dataset.displayItemId=liveItem.id),assistantNode.dataset.responseIndex=String(responseIndex))'), 'assistant placeholders should persist displayItemId and responseIndex on the DOM node');
  assert.ok(submit.includes('updateMessage(assistantNode,e,{rawText:e,responseIndex})'), 'clarification final message should keep its responseIndex on the DOM node');
  assert.ok(image.includes('if((e&&s&&e!==s)||(t&&a&&t!==a))d=null;'), 'image workflow should reject stale loading nodes from a different display item/response');
}

function testReasoningPreferenceIsSessionScoped() {
  const session = appState.createSession('A', () => 1000, () => 0.123456);
  assert.strictEqual(session.reasoningMode, false);
  assert.strictEqual(session.reasoningType, 'medium');
  assert.strictEqual(session.reasoningProvider, 'auto');

  const displaySource = fs.readFileSync(path.join(__dirname, '../client/app/session-display.js'), 'utf8');
  assert.ok(displaySource.includes('reasoningMode: session.reasoningMode === undefined ? null : !!session.reasoningMode'), 'session metadata should persist reasoningMode per session');
  assert.ok(displaySource.includes("reasoningType: ['low', 'medium', 'high', 'xhigh'].includes(session.reasoningType) ? session.reasoningType : ''"), 'session metadata should persist reasoningType per session');
  assert.ok(displaySource.includes('reasoningProvider: String(session.reasoningProvider ||'), 'session metadata should persist reasoningProvider per session');

  const reasoningSource = fs.readFileSync(path.join(__dirname, '../client/app/reasoning-workflow.js'), 'utf8');
  assert.ok(reasoningSource.includes('session.reasoningMode = state.reasoningMode'), 'reasoning mode changes should write active session');
  assert.ok(reasoningSource.includes('session.reasoningType = state.reasoningType'), 'reasoning type changes should write active session');
  assert.ok(reasoningSource.includes('session.reasoningProvider = state.reasoningProvider'), 'reasoning provider changes should write active session');
  assert.ok(reasoningSource.includes('typeof saveSessionsMeta === "function" && saveSessionsMeta()'), 'reasoning preference changes should save session metadata');

  const uiSource = fs.readFileSync(path.join(__dirname, '../client/app/session-ui-workflow.js'), 'utf8');
  assert.ok(uiSource.includes('loadReasoningPreference();\n        renderActiveSession();'), 'switching sessions should reload reasoning preference before rendering active session');
}

function testReasoningCompletionEmptyStateText() {
  const reasoningSource = fs.readFileSync(path.join(__dirname, '../client/app/reasoning-workflow.js'), 'utf8');
  assert.ok(reasoningSource.includes('done?"思考完成":"思考中"'), 'completed reasoning should show 思考完成');
  assert.ok(reasoningSource.includes('unavailable?"未返回思考内容"'), 'missing reasoning should show 未返回思考内容');
  assert.ok(reasoningSource.includes('showReasoningUnavailable(e)'), 'finishReasoning should route empty reasoning to unavailable state');
  assert.ok(reasoningSource.includes('keepEmpty:!0,unavailable:!0'), 'unavailable reasoning state should render immediately even with empty body');
}

function testReasoningCompletesBeforeAnswerStreaming() {
  const chatSource = fs.readFileSync(path.join(__dirname, '../client/app/chat-workflow.js'), 'utf8');
  assert.ok(chatSource.includes('if(state.reasoningMode&&!s){s=!0;'), 'answer streaming should immediately leave thinking state when answer starts');
  assert.ok(chatSource.includes('updateReasoning(g,reasoningText,{done:!0'), 'answer streaming should update existing reasoning title to done before rendering answer text');
  assert.ok(chatSource.includes('S.set(mergeReasoning(e.reasoning||"")),I.set(mergeAnswer'), 'stream callbacks should process reasoning before answer content in the same chunk');
  const index = fs.readFileSync(path.join(__dirname, '../index.html'), 'utf8');
  assert.ok(index.includes('chat-workflow.js?v=1.3.16') && index.includes('chatui.bundle.js?v=1.3.48-arch68'), 'chat stream reasoning-state fix should bump cache versions');
}

function testReasoningUnavailableWhenAnswerStartsWithoutReasoning() {
  const chatSource = fs.readFileSync(path.join(__dirname, '../client/app/chat-workflow.js'), 'utf8');
  assert.ok(chatSource.includes('answerStarted=!0'), 'chat streaming should track when answer content starts');
  assert.ok(chatSource.includes('showReasoningUnavailable(g)'), 'answer streaming without reasoning should immediately mark reasoning as unavailable');
  assert.ok(chatSource.includes('s=!!answerStarted'), 'late reasoning after answer start should render as completed, not thinking');
  const index = fs.readFileSync(path.join(__dirname, '../index.html'), 'utf8');
  assert.ok(index.includes('chat-workflow.js?v=1.3.16') && index.includes('chatui.bundle.js?v=1.3.48-arch68'), 'empty-reasoning stream fix should bump cache versions');
}

function testReasoningMenuCloseReleasesFocusBeforeAriaHidden() {
  const reasoningSource = fs.readFileSync(path.join(__dirname, '../client/app/reasoning-workflow.js'), 'utf8');
  assert.ok(reasoningSource.includes('active&&e.contains?.(active)'), 'closing reasoning menu should detect focused descendants before hiding');
  assert.ok(reasoningSource.includes('t.focus?.({preventScroll:!0})') && reasoningSource.includes('active.blur?.()'), 'closing reasoning menu should move or clear focus before aria-hidden=true');
  assert.ok(reasoningSource.indexOf('active&&e.contains?.(active)') < reasoningSource.indexOf('e.setAttribute("aria-hidden","true")'), 'focus should be released before setting aria-hidden on reasoning menu');
  const index = fs.readFileSync(path.join(__dirname, '../index.html'), 'utf8');
  assert.ok(index.includes('reasoning-workflow.js?v=1.3.29-ds3') && index.includes('chatui.bundle.js?v=1.3.48-arch68'), 'reasoning menu accessibility fix should bump cache versions');
}

function testCodeActionHoverAndHistoryAnchorActivePolish() {
  const css = fs.readFileSync(path.join(__dirname, '../styles/flat-theme.css'), 'utf8');
  assert.ok(css.includes('.markdown-body .code-block .code-copy-icon:hover') && css.includes('transform:none !important'), 'code block action hover should not move the absolute-positioned button');
  const activeBlock = css.match(/\.history-anchor-item\.active\{[\s\S]*?\}/)?.[0] || '';
  assert.ok(activeBlock.includes('background:linear-gradient(90deg,rgba(37,99,235,.10),rgba(6,182,212,.06))'), 'active history item should use a light blue-green active wash');
  assert.ok(activeBlock.includes('box-shadow:inset 0 0 0 1px rgba(37,99,235,.10)'), 'active history item should use a subtle inset boundary');
  const activeBeforeBlock = css.match(/\.history-anchor-item\.active::before\{[\s\S]*?\}/)?.[0] || '';
  assert.ok(activeBeforeBlock.includes('linear-gradient(180deg,var(--history-anchor-accent),var(--history-anchor-accent-2))'), 'active history item should use a slim gradient marker');
  const railBlock = css.match(/\.history-anchor-rail-bar\.active::before,\n\.history-anchor-rail-bar\.hover::before\{[\s\S]*?\}/)?.[0] || '';
  assert.ok(railBlock.includes('rgba(37,99,235,.08)'), 'active history rail should use a very light focus halo');

  const index = fs.readFileSync(path.join(__dirname, '../index.html'), 'utf8');
  assert.ok(index.includes('styles/flat-theme.css?v=2.1.53') && index.includes('assets/chatui.bundle.css?v=1.3.48-arch67'), 'CSS bundle cache versions should be bumped for visual fixes');
}

function testArchitectureBoundaryScaffolding() {
  const storageKeys = require('../client/config/storage-keys');
  const featureFlags = require('../client/config/feature-flags');
  const domainTypes = require('../client/domain/types');
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

  const target = {};
  let lazyCalls = 0;
  appContext.defineLazyWorkflowGetter(target, 'workflow', () => ({ id: ++lazyCalls }));
  assert.strictEqual(target.workflow.id, 1);
  assert.strictEqual(target.workflow.id, 1);
  assert.strictEqual(lazyCalls, 1);

  const app = fs.readFileSync(path.join(__dirname, '../app.js'), 'utf8');
  const index = fs.readFileSync(path.join(__dirname, '../index.html'), 'utf8');
  assert.ok(app.includes('appContext=window.ChatUIApp?.appContext||{}'), 'app bootstrap should read the app-context helper without becoming a module');
  assert.ok(app.includes('appContext.resolveRuntimeDependencies?appContext.resolveRuntimeDependencies(window)'), 'app bootstrap should delegate runtime dependency resolution to app-context when present');
  sourceAssertions.assertInOrder(index, './client/app/state.js', './client/app/app-context.js', 'app context should load after app state');
  sourceAssertions.assertInOrder(index, './client/app/app-context.js', './app.js', 'app context should load before app bootstrap');
}

function testConfigBaseUrlDefault() {
  const configWorkflow = require('../client/app/config-workflow');
  const configSource = fs.readFileSync(path.join(__dirname, '../client/app/config-workflow.js'), 'utf8');
  const index = fs.readFileSync(path.join(__dirname, '../index.html'), 'utf8');
  const bundleSource = fs.readFileSync(path.join(__dirname, '../server/services/static-bundle.service.js'), 'utf8');
  assert.strictEqual(configWorkflow.DEFAULT_BASE_URL, 'https://ingress.lfans.cn/v1', 'config workflow should expose the default Endpoint Base URL');
  assert.strictEqual(configWorkflow.defaults.baseUrl, 'https://ingress.lfans.cn/v1', 'new installs should default Endpoint Base URL to ingress.lfans.cn');
  assert.ok(configSource.includes('getElement("baseUrl").value=t.baseUrl||defaults.baseUrl'), 'loadConfig should populate the Endpoint field with the default when storage is empty');
  assert.ok(configSource.includes('(getElement("baseUrl").value.trim()||defaults.baseUrl).replace'), 'getConfig should fall back to the default Endpoint when the field is blank');
  assert.ok(index.includes('placeholder="https://ingress.lfans.cn/v1"') && index.includes('默认使用 <code>https://ingress.lfans.cn/v1</code>'), 'settings UI should show the new default Endpoint to users');
  assert.ok(index.includes('config-workflow.js?v=1.2.69') && index.includes('chatui.bundle.js?v=1.3.48-arch68'), 'config default change should bump cache-busting versions');
  assert.ok(bundleSource.includes("BUNDLE_VERSION = '1.3.48-arch68'"), 'server bundle version should match the index cache-busting version');
}

function testOmittedAttachmentDataDoesNotRenderAsImageUrl() {
  const html = '<div><img src="[attachment-data-omitted]" data-persisted-src="[image-data-omitted]" alt="bad.png"></div>';
  const clean = sessionPersistence.sanitizeStoredDisplayItem({ role: 'user', html }, { stripLargeDataUrlsFromText });
  assert.ok(!clean.html.includes('src="[attachment-data-omitted]"'), 'sanitizer should remove omitted attachment placeholders from img src');
  assert.ok(!clean.html.includes('data-persisted-src="[image-data-omitted]"'), 'sanitizer should remove omitted attachment placeholders from persisted image src');
  assert.ok(!clean.html.includes('attachment-data-omitted') && !clean.html.includes('image-data-omitted'), 'omitted placeholders should not remain in image markup');
}

function testRegenerateRemovesOldAssistantImmediately() {
  const app = fs.readFileSync(path.join(__dirname, '../app.js'), 'utf8');
  assert.ok(app.includes('const c=prepareRegeneratedResponse(t,e,l,a,"已收到，马上处理")'), 'regenerate click should remove the old assistant node immediately and insert a fresh live placeholder');
  assert.ok(!app.includes('prepareReplacementResponse({node:t,responseNode:e,index:n,responseIndex:a},l,"已收到，马上处理",{deferClear:!0})'), 'regenerate should not reuse/update the old assistant node as the loading placeholder');
}

function testForceImageButtonOnUserMessages() {
  const index = fs.readFileSync(path.join(__dirname, '../index.html'), 'utf8');
  const app = fs.readFileSync(path.join(__dirname, '../app.js'), 'utf8');
  const messageWorkflow = fs.readFileSync(path.join(__dirname, '../client/app/message-workflow.js'), 'utf8');
  const bundleSource = fs.readFileSync(path.join(__dirname, '../server/services/static-bundle.service.js'), 'utf8');
  assert.ok(index.includes('class="force-image-btn icon-action-btn"') && index.includes('title="强制生图"'), 'message actions should include a force-image button in the user message button area');
  assert.ok(messageWorkflow.includes('const forceImage = node.querySelector(".force-image-btn")'), 'message workflow should bind the force-image button');
  assert.ok(messageWorkflow.includes('if (role === "user") forceImage?.addEventListener("click", () => forceImageFromUserMessage(node));') && messageWorkflow.includes('else forceImage?.remove();'), 'force-image button should only be available on user messages');
  assert.ok(app.includes('forceImageFromUserMessage'), 'app should expose force-image action to the message workflow');
  assert.ok(app.includes('prepareRegeneratedResponse(e,o,a,n,"已收到，正在准备图片")'), 'force-image action should remove/replace the old assistant response like regenerate');
  assert.ok(app.includes('await sendImage(t,{loadingNode:l.node,attachments:c.filter(item=>!isImageFile(item)),routePrompt:t,originalPrompt:t,sessionId:a,userAlreadyAdded:!0,liveItem:l.liveItem,replaceAssistantIndex:n})'), 'force-image action should send the current user message directly to image generation and replace the original response');
  assert.ok(index.includes('force-image-wand') && index.includes('force-image-sparkle') && index.includes('force-image-frame'), 'force-image button should use the refined wand/image icon instead of the old heavy image-box icon');
  assert.ok(index.includes('message-workflow.js?v=1.3.29') && index.includes('app.js?v=1.3.49-noflash2') && index.includes('assets/chatui.bundle.css?v=1.3.48-arch67') && index.includes('chatui.bundle.js?v=1.3.48-arch68') && index.includes('styles/flat-theme.css?v=2.1.53'), 'force-image UI and action changes should bump cache-busting versions');
  assert.ok(bundleSource.includes("BUNDLE_VERSION = '1.3.48-arch68'"), 'server bundle version should match the force-image bundle cache-busting version');
}

function testImagePreviewWheelZoom() {
  const workflow = fs.readFileSync(path.join(__dirname, '../client/app/image-preview-workflow.js'), 'utf8');
  const css = fs.readFileSync(path.join(__dirname, '../styles.css'), 'utf8');
  const flatCss = fs.readFileSync(path.join(__dirname, '../styles/flat-theme.css'), 'utf8');
  const index = fs.readFileSync(path.join(__dirname, '../index.html'), 'utf8');
  const bundleSource = fs.readFileSync(path.join(__dirname, '../server/services/static-bundle.service.js'), 'utf8');
  assert.ok(workflow.includes('MIN_PREVIEW_SCALE = 0.5') && workflow.includes('MAX_PREVIEW_SCALE = 5'), 'image preview zoom should clamp wheel scale to a safe range');
  assert.ok(workflow.includes('addEventListener("wheel"') && workflow.includes('event.preventDefault()') && workflow.includes('zoomImagePreview(event.deltaY)') && workflow.includes('{passive:!1}'), 'image preview should handle wheel gestures for zoom without page scrolling');
  assert.ok(workflow.includes('resetPreviewZoom()') && workflow.includes('applyPreviewScale(1)'), 'opening and closing preview should reset zoom state');
  assert.ok(workflow.includes('img.style.transform=`scale(${previewScale})`') && workflow.includes('dataset.previewScale') && workflow.includes('classList.toggle("is-zoomed"'), 'zoom should update the preview image transform and state class');
  assert.ok(workflow.includes('dblclick') && workflow.includes('resetPreviewZoom()'), 'double click should provide a quick reset path');
  assert.ok(css.includes('cursor:zoom-in') && css.includes('.image-preview img.is-zoomed{cursor:zoom-out}'), 'base CSS should no longer show zoom-out before the image is actually zoomed');
  assert.ok(flatCss.includes('.image-preview img') && flatCss.includes('cursor: zoom-in !important') && flatCss.includes('.image-preview img.is-zoomed') && flatCss.includes('cursor: zoom-out !important'), 'flat theme should mirror the functional zoom cursor states');
  assert.ok(index.includes('image-preview-workflow.js?v=1.2.66') && index.includes('chatui.bundle.js?v=1.3.48-arch68') && index.includes('styles/flat-theme.css?v=2.1.53'), 'image preview zoom should bump cache-busting versions');
  assert.ok(bundleSource.includes("BUNDLE_VERSION = '1.3.48-arch68'"), 'server bundle version should match image preview zoom bundle cache-busting');
}

function testMessageActionButtonsUsePolishedStyle() {
  const flatCss = fs.readFileSync(path.join(__dirname, '../styles/flat-theme.css'), 'utf8');
  const index = fs.readFileSync(path.join(__dirname, '../index.html'), 'utf8');
  const bundleSource = fs.readFileSync(path.join(__dirname, '../server/services/static-bundle.service.js'), 'utf8');
  const messageWorkflow = fs.readFileSync(path.join(__dirname, '../client/app/message-workflow.js'), 'utf8');
  assert.ok(flatCss.includes('Final message action polish: glassy rounded buttons with subtle per-action accents'), 'message actions should document the shared polished style layer');
  assert.ok(flatCss.includes('.message:not([data-streaming="1"]) .msg-actions:not(:hover)') && flatCss.includes('opacity:.34!important') && flatCss.includes('.message:not([data-streaming="1"]):hover .msg-actions') && flatCss.includes('opacity:.95!important') && !flatCss.includes('.message:hover .msg-actions'), 'message action groups should stay less visually prominent until the pointer moves over non-streaming messages');
  assert.ok(flatCss.includes('.messages>.message:not([data-streaming="1"]) .bubble-wrap') && flatCss.includes('.messages>.message:not([data-streaming="1"]) .content') && flatCss.includes('pointer-events:auto!important'), 'non-streaming message hover should be active across the full bubble/content area, not only the message start');
  assert.ok(flatCss.includes('.message[data-streaming="1"] .msg-actions') && flatCss.includes('transition:none!important') && flatCss.includes('.message[data-streaming="1"] .bubble-wrap') && flatCss.includes('padding-bottom:0!important'), 'streaming messages should suppress action hover transitions and reserved action space to avoid flicker');
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
  assert.ok(index.includes('assets/chatui.bundle.css?v=1.3.48-arch67') && index.includes('chatui.bundle.js?v=1.3.48-arch68') && index.includes('styles/flat-theme.css?v=2.1.53'), 'message action visual polish should bump cache-busting versions');
  assert.ok(bundleSource.includes("BUNDLE_VERSION = '1.3.48-arch68'"), 'server bundle version should match message action polish cache-busting');
}

function testPendingFeedbackDoesNotWrapOnMobile() {
  const flatCss = fs.readFileSync(path.join(__dirname, '../styles/flat-theme.css'), 'utf8');
  const index = fs.readFileSync(path.join(__dirname, '../index.html'), 'utf8');
  const bundleSource = fs.readFileSync(path.join(__dirname, '../server/services/static-bundle.service.js'), 'utf8');
  assert.ok(flatCss.includes('.pending-feedback{') && flatCss.includes('flex-wrap:nowrap!important') && flatCss.includes('white-space:nowrap!important'), 'pending feedback should keep waiting text on one line');
  assert.ok(flatCss.includes('.pending-text,') && flatCss.includes('.pending-dots{') && flatCss.includes('flex:0 0 auto!important'), 'pending feedback text and dots should not shrink into wrapped fragments');
  assert.ok(flatCss.includes('@media (max-width:640px)') && flatCss.includes('font-size:14px!important') && flatCss.includes('gap:6px!important'), 'mobile pending feedback should be compact enough to avoid wrapping');
  assert.ok(index.includes('assets/chatui.bundle.css?v=1.3.48-arch67') && index.includes('chatui.bundle.js?v=1.3.48-arch68') && index.includes('styles/flat-theme.css?v=2.1.53'), 'pending feedback mobile nowrap fix should bump cache-busting versions');
  assert.ok(bundleSource.includes("BUNDLE_VERSION = '1.3.48-arch68'"), 'server bundle version should match pending feedback cache-busting');
}

function testRouteTimeoutShowsSlowNoticeThenManualChoice() {
  const routeWorkflow = fs.readFileSync(path.join(__dirname, '../client/app/route-decision-workflow.js'), 'utf8');
  const submitWorkflow = fs.readFileSync(path.join(__dirname, '../client/app/submit-workflow.js'), 'utf8');
  const flatCss = fs.readFileSync(path.join(__dirname, '../styles/flat-theme.css'), 'utf8');
  const index = fs.readFileSync(path.join(__dirname, '../index.html'), 'utf8');
  assert.ok(routeWorkflow.includes('setTimeout(()=>{slowNotified=!0') && routeWorkflow.includes('},10000)'), 'route recognition should update UI after 10 seconds');
  assert.ok(routeWorkflow.includes('},60000)') && routeWorkflow.includes('ROUTE_INTENT_TIMEOUT'), 'route recognition should timeout after 60 seconds with dedicated error');
  const app = fs.readFileSync(path.join(__dirname, '../app.js'), 'utf8');
  assert.ok(app.includes('routeOptions=null') && app.includes('routeContextOverride,routeOptions'), 'app route wrapper should forward routeOptions so slow UI callbacks fire');
  assert.ok(app.includes('上下文比较复杂，正在努力识别，请稍后。'), 'slow route notice text should be shown in pending assistant bubble');
  assert.ok(app.includes('function createRouteRecognitionUi') && app.includes('getEffectiveRouteWithSlowNotice') && app.includes('setTimeout(c,10000)') && submitWorkflow.includes('routeUi=createRouteRecognitionUi'), 'normal submit and regenerate should share one route recognition UX helper');
  assert.ok(app.includes('routeUi.waitManualIntentChoice(quotedMessage') && app.includes('const routeUi=createRouteRecognitionUi({sessionId:l'), 'regenerate should reuse the same slow notice and manual intent fallback');
  assert.ok(app.includes('内容过于复杂、意图识别耗时请手动选择意图'), 'route timeout should ask the user to choose manually');
  assert.ok(app.includes('data-manual-intent="chat"') && app.includes('data-manual-intent="image"') && app.includes('data-manual-intent="edit_image"'), 'manual intent chooser should include chat/image/edit options');
  assert.ok(flatCss.includes('.manual-intent-card') && flatCss.includes('.manual-intent-actions button'), 'manual intent chooser should match the flat theme');
  const imageWorkflow = fs.readFileSync(path.join(__dirname, '../client/app/image-workflow.js'), 'utf8');
  assert.ok(imageWorkflow.includes('clearReasoning?.(d)') && imageWorkflow.includes('delete c.reasoningText'), 'image generation should clear route/chat reasoning panel when it starts');
  assert.ok(app.includes('clearReasoning,setImageContext') && index.includes('image-workflow.js?v=1.3.15'), 'image reasoning cleanup should be wired and cache-busted');
  const sessionPanelWorkflow = fs.readFileSync(path.join(__dirname, '../client/app/session-panel-workflow.js'), 'utf8');
  assert.ok(sessionPanelWorkflow.includes('window.setTimeout.call(window,()=>n.focus(),a||60)'), 'session panel should bind native setTimeout to window to avoid Illegal invocation');

  const configWorkflow = fs.readFileSync(path.join(__dirname, '../client/app/config-workflow.js'), 'utf8');
  const dialogWorkflow = fs.readFileSync(path.join(__dirname, '../client/app/dialog-workflow.js'), 'utf8');
  const performanceWorkflow = fs.readFileSync(path.join(__dirname, '../client/app/performance-workflow.js'), 'utf8');
  const attachmentsWorkflow = fs.readFileSync(path.join(__dirname, '../client/app/attachments-workflow.js'), 'utf8');
  assert.ok(configWorkflow.includes('window.setTimeout.call(window,()=>getElement("baseUrl")?.focus(),0)'), 'config modal should bind native setTimeout to window');
  assert.ok(dialogWorkflow.includes('window.setTimeout.call(window') && dialogWorkflow.includes('window.clearTimeout.call(window'), 'dialog workflow should bind native timers to window');
  assert.ok(performanceWorkflow.includes('window.setTimeout.call(window') && performanceWorkflow.includes('window.clearTimeout.call(window'), 'performance workflow should bind native timers to window');
  assert.ok(attachmentsWorkflow.includes('window.setTimeout.call(window') && attachmentsWorkflow.includes('window.clearTimeout.call(window'), 'attachments workflow should bind native timers to window');

  assert.ok(index.includes('session-panel-workflow.js?v=1.2.67'), 'session panel Illegal invocation fix should bump cache version');
  assert.ok(!submitWorkflow.includes('stopRouteSlowNoticeTimer()') && submitWorkflow.includes('routeUi?.stopSlowNotice?.()'), 'submit cleanup should call the shared route UI timer cleanup instead of a removed local helper');
  assert.ok(!submitWorkflow.includes('state.reasoningMode&&assistantNode&&updateReasoning?.(assistantNode,"",{keepEmpty:!0,followActive:!0})'), 'submit should not show reasoning panel before route recognition returns');
  const chatWorkflow = fs.readFileSync(path.join(__dirname, '../client/app/chat-workflow.js'), 'utf8');
  assert.ok(chatWorkflow.includes('clearReplacementOnAccepted') && chatWorkflow.includes('state.reasoningMode?(updateMessageContentLight') && chatWorkflow.includes('updateReasoning(g,"",{keepEmpty:!0})'), 'reasoning waiting panel should only appear after the chat request is accepted');
  assert.ok(index.includes('submit-workflow.js?v=1.3.61') && index.includes('chat-workflow.js?v=1.3.16') && index.includes('route-decision-workflow.js?v=1.3.16') && index.includes('app.js?v=1.3.49-noflash2') && index.includes('flat-theme.css?v=2.1.53'), 'cache versions should be bumped for route timeout UX');
}

function testDockerfileIncludesSharedRuntimeModules() {
  const dockerfile = fs.readFileSync(path.join(__dirname, '../Dockerfile'), 'utf8');
  assert.ok(dockerfile.includes('COPY shared ./shared'), 'Docker image must include shared runtime modules used by server config/jobs');
}

const tests = [
  testDockerfileIncludesSharedRuntimeModules,
  testRouteContextIsCompactAndIndexed,
  testImageGenerationPayloadDoesNotRewritePromptOrAutoParams,
  testImageResultParsingSupportsMultipleImages,
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
  testLightweightIntentClassifierAdapters,
  testRouteDecisionHelpersArePureAndReusedByService,
  testStructuredRouteDecisionCarriesRefs,
  testImagePromptExtractionStaysChatWithCurrentImage,
  testImplicitImagePromptExtractionStaysChatWithCurrentImage,
  testNormalizeRouteKeepsExplicitImageQaChatDespiteImageIntent,
  testRouteOperationTypeDrivesCanonicalMode,
  testRoutePromptUsesChineseCompactRules,
  testChatAnswerStreamingFlushesQuickly,
  testStreamingTailRendersLightweightCursor,
  testSessionTailFocusPreservesBottomGapDuringDynamicLayout,
  testSessionSwitchFocusesBottom,
  testLegacyWelcomeScreenIsRestored,
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
  testStreamingOutputSmoothnessOptimizations,
  testResumeStreamButtonAnchorsAboveComposer,
  testHistoryAnchorLastQuestionSpacerClearsOnSubmit,
  testHistoryAnchorNavFeature,
  testLargeMarkdownInitialRenderIsProgressive,
  testEnglishImagePromptExtractionStaysChatWithCurrentImage,
  testImageOnlyAssistantMessageCanBeQuotedWithImageContext,
  testEmptyAssistantImageContextFallsBackToGeneratedThumbs,
  testQuoteResolverUsesCanonicalAndDisplayContext,
  ...usageTests,
  ...serverHardeningTests,
  ...staticBundleTests,
  ...apiContractTests,
  ...jobRouteTests,
  ...chatStreamParserTests,
  ...imageJobContractTests,
  ...imageEditPayloadContractTests,
  ...imageServiceContractTests,
  ...clientContractTests,
  ...submitWorkflowHelperTests,
  ...serverSmokeTests,
  testSessionPromptDraftPersistsPerSession,
  testLegacyDocSupportIsRoutedToWordExtractor,
  testResponseMetricsTextIsUnified,
  testResponsesDirectDoesNotRegisterManagedChatJob,
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
  testChatJobIdIsPersistedBeforeRouteResolution,
  testSessionDisplayUpdatesFinalClarificationHtml,
  testClarificationAssistantNodeKeepsStableDisplayIdentity,
  testReasoningPreferenceIsSessionScoped,
  testReasoningCompletionEmptyStateText,
  testReasoningCompletesBeforeAnswerStreaming,
  testReasoningUnavailableWhenAnswerStartsWithoutReasoning,
  testReasoningMenuCloseReleasesFocusBeforeAriaHidden,
  testCodeActionHoverAndHistoryAnchorActivePolish,
  testArchitectureBoundaryScaffolding,
  testAppBootstrapContextHelper,
  testConfigBaseUrlDefault,
  testOmittedAttachmentDataDoesNotRenderAsImageUrl,
  testRegenerateRemovesOldAssistantImmediately,
  testForceImageButtonOnUserMessages,
  testImagePreviewWheelZoom,
  testMessageActionButtonsUsePolishedStyle,
  testPendingFeedbackDoesNotWrapOnMobile,
  testRouteTimeoutShowsSlowNoticeThenManualChoice,
];

(async () => {
  for (const test of tests) {
    await test();
    console.log(`✓ ${test.name}`);
  }
  console.log(`All ${tests.length} tests passed.`);
})().catch(err => {
  console.error(err);
  process.exit(1);
});
