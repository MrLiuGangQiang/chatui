'use strict';

const assert = require('assert');
const fs = require('fs');
const path = require('path');
const clarificationService = require('../../client/services/clarification-service');
const submitWorkflow = require('../../client/app/submit-workflow');

function testRouteRecognitionPassesHeadersAndContextWithoutArgumentShift() {
  const submit = fs.readFileSync(path.join(__dirname, '../../client/app/submit-workflow.js'), 'utf8');
  const regenerate = fs.readFileSync(path.join(__dirname, '../../client/app/regenerate-workflow.js'), 'utf8');
  const chat = fs.readFileSync(path.join(__dirname, '../../client/app/chat-workflow.js'), 'utf8');
  const app = fs.readFileSync(path.join(__dirname, '../../app.js'), 'utf8');
  const index = fs.readFileSync(path.join(__dirname, '../../index.html'), 'utf8');

  assert.ok(
    submit.includes('const getEffectiveRouteWithSlowNotice=(input,routeAttachments,headers,context,intentOptions={})=>{routeUi.startSlowNotice();return getEffectiveRoute(input,routeAttachments,sessionId,headers,context,{...intentOptions,onSlow:routeUi.showSlowNotice,onStage:routeUi.showSlowNotice,signal:run.abortController?.signal})'),
    'the route UI wrapper must forward headers, context, cancellation, and the absolute pipeline deadline without an argument shift'
  );
  assert.ok(
    submit.includes('getEffectiveRouteWithSlowNotice(effectivePromptText,requestAttachments,{},null,{deadlineAt:intentDeadlineAt,currentTurn:currentRouteTurn})'),
    'normal submissions must pass request headers as the third route argument, not the session ID'
  );
  assert.ok(
    submit.includes('getEffectiveRouteWithSlowNotice(promptText,currentTurnAttachments,{},buildQuotedRouteContext(),{deadlineAt:intentDeadlineAt,currentTurn:currentRouteTurn})'),
    'quoted submissions must preserve both their structured quote context and the current-turn attachment candidates'
  );
  assert.ok(submit.includes('submitHelpers.buildQuotedRouteContext({quotedMessage'), 'an explicit quote must be normalized by the shared route-context helper');
  assert.ok(regenerate.includes('submitHelpers.buildQuotedRouteContext({quotedMessage'), 'regenerating from a quote must use the same route-context helper');
  assert.ok(regenerate.includes('const routeMessageProjection=submitHelpers.projectRouteMessageContext?.(p,state.messages||[],quotedMessage)||null'), 'regeneration must use the same route-message execution projection as normal submission');
  assert.ok(!submit.includes('getEffectiveRouteWithSlowNotice(effectivePromptText,requestAttachments,sessionId,'));
  assert.ok(!submit.includes('getEffectiveRouteWithSlowNotice(promptText,[],sessionId,'));
  assert.ok(index.includes('submit-workflow.js?v=1.5.2-pending-transaction') && index.includes('semantic-task-v2-single-router'), 'the browser must fetch the single semantic router workflow');
  assert.ok(submit.includes('signal:run.abortController?.signal'), 'a normal submission must pass its live-run signal into intent recognition');
  assert.ok(submit.includes('{deadlineAt:intentDeadlineAt,currentTurn:currentRouteTurn}'), 'every full-router branch must inherit the same absolute intent deadline and current-turn identity');
  assert.ok(!submit.includes('classifierDeadline') && !submit.includes('requestClassifier') && !submit.includes('buildContinuationClassifierPayload'), 'pending replies must not create a second classifier request');
  assert.ok(regenerate.includes('signal:d.abortController?.signal'), 'regeneration must pass its live-run signal into intent recognition');
  assert.ok(app.includes('getEffectiveRoute(t,s,e,n,a,{onSlow:l,onStage:l,signal:u})'), 'the root route UI must forward the signal to every route request');
  assert.ok(submit.includes('const routeMessageProjection=submitHelpers.projectRouteMessageContext?.(routeInfo,targetSession.messages||state.messages||[],quotedMessage)||null'), 'every selected message resource must be projected into the outgoing chat base');
  assert.ok(submit.includes('if(hasRouteMessageRefs&&!routeMessageProjection)throw new Error('), 'a stale selected message must fail closed instead of falling back to arbitrary session history');
  assert.ok(submit.includes('routeContextMessageCount:routeMessageProjection?.protectedMessageCount||0'), 'the execution projection must mark route-selected messages as protected during context budgeting');
  assert.ok(chat.includes('protectedHistoryIndexes(rawMessages,protectedContextMessageCount(n))'), 'chat context budgeting must preserve selected messages and explicit quotes without shared mutable state');
  assert.ok(!chat.includes('nextRequestProtectedMessageCount'), 'concurrent chat requests must not share context-protection state');
  assert.ok(submit.includes('const pendingSourcePools=pendingMerge?.merged') && submit.includes('partitionExecutionAttachmentsBySource') && submit.includes('current:pendingSourcePools?.current||currentTurnAttachments') && submit.includes('history:mergeSourcePool'), 'all attachment sources must enter distinct execution pools, with a continuation retaining its source attachments');
  assert.ok(submit.includes('const executionMedia=submitHelpers.projectRouteExecutionMedia(routeInfo,executionPools)'), 'the validated route contract must create the one canonical media projection');
  assert.ok(submit.includes('prepareChatImageAttachments([...executionMedia.chatFiles,...executionMedia.chatImages])'), 'chat dispatch must use only contract-selected files and images');
  assert.ok(submit.includes('const editAttachments=executionMedia.imageInputs'), 'image dispatch must use only contract-selected image inputs');
  assert.ok(submit.includes('maskAttachments:executionMedia.masks'), 'mask bindings must remain separate from edit targets at dispatch');
  assert.ok(!submit.includes('needsHistoricalChatImages'), 'historical media must not use a parallel keyword-driven selection path');
  assert.ok(submit.includes('if(createdPending&&!routeInfo.localClarification)'), 'a local contract-failure notice must not create a fake pending user clarification');
  assert.ok(!submit.includes('我需要确认你的目标：你希望我处理这段内容、生成图片/PPT，还是进行其他操作？'), 'a model contract failure must not be presented as user ambiguity');
}
async function testUnifiedIntentDeadlineFailsClosed() {
  assert.strictEqual(submitWorkflow.INTENT_PIPELINE_DEADLINE_MS, 60000);
  const bounded = submitWorkflow.createBoundedIntentRequest(null, Date.now() + 30);
  const started = Date.now();
  try {
    await assert.rejects(
      () => bounded.race(new Promise(() => {})),
      error => error?.code === 'ROUTE_INTENT_TIMEOUT' && error?.timeoutMs === 60000,
    );
    assert.ok(Date.now() - started < 500, 'the unified intent deadline must reject promptly instead of waiting for an unbounded model request');
  } finally {
    bounded.dispose();
  }
}

async function testStructuredOutputCompatibilityFallbackPreservesJsonMode() {
  const strictPayload = {
    model: 'route-model',
    response_format: { type: 'json_schema', json_schema: { name: 'chatui_semantic_task_v2' } },
    messages: [],
  };
  const attempts = [];
  const unsupported = type => {
    const error = new Error(`response_format ${type} unsupported`);
    return error;
  };
  const response = await submitWorkflow.requestJsonWithStructuredOutputFallback(async payload => {
    attempts.push(payload);
    if (attempts.length === 1) throw unsupported('json_schema');
    return { ok: true };
  }, strictPayload);
  assert.deepStrictEqual(response, { ok: true });
  assert.strictEqual(attempts.length, 2);
  assert.strictEqual(attempts[0].response_format.type, 'json_schema');
  assert.deepStrictEqual(attempts[1].response_format, { type: 'json_object' });
  assert.strictEqual(strictPayload.response_format.type, 'json_schema', 'fallback must not mutate the canonical payload');

  const plainAttempts = [];
  await submitWorkflow.requestJsonWithStructuredOutputFallback(async payload => {
    plainAttempts.push(payload);
    if (plainAttempts.length < 3) throw unsupported(payload.response_format?.type || 'plain');
    return { ok: 'plain' };
  }, strictPayload);
  assert.strictEqual(plainAttempts.length, 3);
  assert.strictEqual(plainAttempts[1].response_format.type, 'json_object');
  assert.strictEqual(Object.prototype.hasOwnProperty.call(plainAttempts[2], 'response_format'), false, 'plain JSON is only the final compatibility fallback');

  let nonCompatibilityCalls = 0;
  await assert.rejects(
    () => submitWorkflow.requestJsonWithStructuredOutputFallback(async () => {
      nonCompatibilityCalls += 1;
      throw new Error('network unavailable');
    }, strictPayload),
    /network unavailable/,
  );
  assert.strictEqual(nonCompatibilityCalls, 1, 'ordinary transport failures must not trigger protocol retries');
}

function testPendingTransitionCommitsOnlyAfterHandoff() {
  const pending = { id: 'pending-1' };
  const consume = submitWorkflow.createPendingTransition(pending, { shouldClearPending: true });
  assert.deepStrictEqual(consume, { pendingId: 'pending-1', consumeOnHandoff: true });
  assert.strictEqual(Object.isFrozen(consume), true);
  assert.deepStrictEqual(
    submitWorkflow.createPendingTransition(pending, { shouldClearPending: false }),
    { pendingId: 'pending-1', consumeOnHandoff: false },
  );
  assert.deepStrictEqual(
    submitWorkflow.createPendingTransition(null, { shouldClearPending: true }),
    { pendingId: '', consumeOnHandoff: false },
  );

  const submit = fs.readFileSync(path.join(__dirname, '../../client/app/submit-workflow.js'), 'utf8');
  assert.ok(submit.includes('let pendingTransition=createPendingTransition(storedPending,{shouldClearPending:false})'));
  assert.ok(submit.includes('pendingTransition=createPendingTransition(storedPending,{shouldClearPending:true})'));
  assert.ok(submit.includes('pendingTransition.consumeOnHandoff&&clearStoredPendingClarification()'));
  assert.strictEqual((submit.match(/clearStoredPendingClarification\(\)/g) || []).length, 1, 'pending may only be consumed by the durable handoff callback');
}

function testImageGenerationDoesNotShadowSubmitOptions() {
  const image = fs.readFileSync(path.join(__dirname, '../../client/app/image-workflow.js'), 'utf8');
  const index = fs.readFileSync(path.join(__dirname, '../../index.html'), 'utf8');

  assert.ok(
    /const imageJob\s*=\s*await startImageGenerationJob\(u,\s*s,\s*e,\s*\{[\s\S]*?signal:\s*a\.abortController\.signal,[\s\S]*?headers:\s*q,[\s\S]*?sessionId:\s*n,[\s\S]*?\}\);/.test(image),
    'plain image generation must store the created job without shadowing the sendImage options parameter'
  );
  assert.ok(
    !/const t\s*=\s*await startImageGenerationJob\(u,\s*s,\s*e/.test(image),
    'the image job response must not create a temporal-dead-zone for t.submissionId'
  );
  assert.ok(
    image.includes('const canonicalExecution = requireCanonicalImageExecution(t.taskContract, t.executionMedia)') && image.includes('m = canonicalExecution.imageInputs'),
    'canonical image execution must require a matching v5 contract and execution-resource projection'
  );
  assert.ok(
    !image.includes('t.referenceImageBindings') && !image.includes('t.selectedImageIds') && !image.includes('t.usePreviousImage'),
    'image execution must not retain a second resource-selection path'
  );
  assert.ok(
    !image.includes('getPreviousImageAttachments(') && !image.includes('getLatestUploadedImageContext('),
    'sendImage must not restore or infer resources after canonical projection'
  );
  assert.ok(
    index.includes('image-workflow.js?v=1.6.1-precise-role-prompt'),
    'the browser must fetch the image workflow with exact reference-media recovery'
  );
}

function testPendingRepliesUseUnifiedSemanticRouteContract() {
  for (const name of [
    'buildContinuationClassifierPayload', 'buildContinuationRepairPayload',
    'parseContinuationClassifierResult', 'CONTINUATION_SCHEMA_VERSION',
  ]) {
    assert.strictEqual(clarificationService[name], undefined, `${name} must not remain as a second semantic router`);
  }

  const pending = clarificationService.createPendingClarification({
    messages: [{ role: 'user', content: '画一只狗' }],
    clarificationText: '你想换成什么品种？',
  });
  const merged = clarificationService.mergePendingInput(pending, {
    promptText: '柴犬',
    resolvedInput: '模型不得改写成其它任务',
  });
  assert.strictEqual(merged.promptText, '画一只狗\n\n柴犬');
  const retained = clarificationService.retainPendingAfterAssistance(pending, {
    promptText: '列举一些犬种',
    assistantReply: '可选犬种：沙皮狗、柴犬、金毛、拉布拉多。请选择一种。',
  });
  assert.strictEqual(retained.originalText, '画一只狗');
  assert.strictEqual(retained.assistanceHistory[0].reply.includes('沙皮狗'), true);

  const submit = fs.readFileSync(path.join(__dirname, '../../client/app/submit-workflow.js'), 'utf8');
  const app = fs.readFileSync(path.join(__dirname, '../../app.js'), 'utf8');
  assert.ok(!submit.includes('buildContinuationClassifierPayload') && !submit.includes('parseContinuationClassifierResult'));
  assert.ok(!submit.includes('pendingDecision') && !submit.includes('requestClassifier'));
  assert.ok(!submit.includes('resolveExplicitImageChoiceAnswer'), 'numbered choices must not bypass semantic recognition');
  assert.ok(submit.includes('clarification.buildClarificationRouteContext?.('), 'a pending reply must become explicit context for the same full router');
  assert.ok(submit.includes('getEffectiveRouteWithSlowNotice(effectivePromptText,continuationRequestAttachments'), 'a pending reply must reroute with restored original attachments');
  assert.ok(submit.includes('const semanticTask=routeInfo?.semanticTask||null'));
  assert.ok(submit.includes('const continuationEffects=new Set(["answer","partial","revision","continuation"])'));
  assert.ok(submit.includes('semanticPendingEffect==="assistance"') && submit.includes('semanticPendingEffect==="new_task"'));
  assert.ok(submit.includes('semanticPendingEffect==="unclear"') && submit.includes('原任务已保留'), 'an unclear semantic relation must fail closed and preserve pending state');
  assert.ok(submit.includes('pendingTransition.consumeOnHandoff&&clearStoredPendingClarification()'), 'pending state must be consumed only after durable request handoff');
  assert.strictEqual((submit.match(/clearStoredPendingClarification\(\)/g) || []).length, 1, 'no route or preflight stage may consume pending state before durable handoff');
  assert.ok(!submit.includes('shouldApplyPending?.(') && !submit.includes('expectedAnswerTypes'), 'no local pending heuristic may be invoked');
  assert.ok(!submit.includes('resolveClarificationRoute') && !submit.includes('pendingResolvedRoute'), 'a structured choice must never bypass canonical intent routing');
  assert.ok(submit.includes('clarification.collectPendingAttachmentContexts?.('), 'a continuation must recover the attachments selected by its pending task snapshot');
  assert.ok(submit.includes('const pendingSourcePools=pendingMerge?.merged') && submit.includes('current:pendingSourcePools?.current||currentTurnAttachments'), 'the final execution pool must use the same restored attachment list that the full router saw');
  assert.ok(submit.includes('if(routeUtils.isRouteDispatchable?.(routeInfo)!==!0)'), 'submit must always apply the canonical execution gate');
  assert.ok(!submit.includes('if(routeInfo.taskContract&&routeUtils.isRouteDispatchable'));
  assert.ok(app.includes('async function onSubmit(e){return getSubmitWorkflow().onSubmit(e)}'));
  assert.ok(!app.includes('function initChatUIAppSubmitWorkflow'));
}
function testChatRerouteAllocatesRecoveryIdAfterImageMode() {
  const submit = fs.readFileSync(path.join(__dirname, '../../client/app/submit-workflow.js'), 'utf8');
  const app = fs.readFileSync(path.join(__dirname, '../../app.js'), 'utf8');
  const fixedHelper = 'const prepareManagedChatJobForLiveItem=(jobMode=submitMode)=>{if("chat"!==jobMode)return"";';
  const fixedDispatch = 'if("chat"===dispatchMode){prepareManagedChatJobForLiveItem("chat");if(!preparedChatJobId)';

  assert.ok(submit.includes(fixedHelper), 'managed chat job preparation must accept the final dispatch mode');
  assert.ok(submit.includes(fixedDispatch), 'a route that changes image mode back to chat must still allocate a recovery id');
  assert.ok(submit.includes('generatedJobId||`chatjob-${Date.now().toString(36)}-${Math.random().toString(36).slice(2,10)}`'), 'a missing local recovery record must create a fresh client job id');
  assert.ok(!submit.includes('typeof shouldPrepareManagedChatJob==="function"&&!shouldPrepareManagedChatJob(sessionId)'), 'job-id creation must not depend on stale model or local-database state');
  assert.ok(!app.includes(fixedHelper) && !app.includes(fixedDispatch), 'the root entry must not retain a stale copy of submit dispatch logic');
}

function testForceImageUsesExplicitCanonicalContract() {
  const regenerate = fs.readFileSync(path.join(__dirname, '../../client/app/regenerate-workflow.js'), 'utf8');
  assert.ok(regenerate.includes('routeUtils.createExplicitTextToImageRoute?.(replayPrompt)'), 'the force-image action must create an explicit v5 task contract from the durable resolved task');
  assert.ok(regenerate.includes('routeUtils.isRouteDispatchable?.(routeInfo)!==!0'), 'the force-image action must pass the same execution gate as routed requests');
  assert.ok(regenerate.includes('const executionMedia=submitHelpers.projectRouteExecutionMedia(routeInfo,executionPools)'), 'the force-image action must use the canonical execution-resource projection');
  assert.ok(regenerate.includes('taskContract:routeInfo.taskContract'), 'the validated force-image contract must reach image dispatch');
  assert.ok(!regenerate.includes('attachments:c.filter(item=>!isImageFile(item))'), 'force-image dispatch must not leak unrelated message attachments into text-to-image execution');
}

module.exports = [
  testRouteRecognitionPassesHeadersAndContextWithoutArgumentShift,
  testUnifiedIntentDeadlineFailsClosed,
  testStructuredOutputCompatibilityFallbackPreservesJsonMode,
  testPendingRepliesUseUnifiedSemanticRouteContract,
  testPendingTransitionCommitsOnlyAfterHandoff,
  testImageGenerationDoesNotShadowSubmitOptions,
  testChatRerouteAllocatesRecoveryIdAfterImageMode,
  testForceImageUsesExplicitCanonicalContract,
];




