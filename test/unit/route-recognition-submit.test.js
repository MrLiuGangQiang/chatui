'use strict';

const assert = require('assert');
const fs = require('fs');
const path = require('path');
const clarificationService = require('../../client/services/clarification-service');

function testRouteRecognitionPassesHeadersAndContextWithoutArgumentShift() {
  const submit = fs.readFileSync(path.join(__dirname, '../../client/app/submit-workflow.js'), 'utf8');
  const regenerate = fs.readFileSync(path.join(__dirname, '../../client/app/regenerate-workflow.js'), 'utf8');
  const chat = fs.readFileSync(path.join(__dirname, '../../client/app/chat-workflow.js'), 'utf8');
  const app = fs.readFileSync(path.join(__dirname, '../../app.js'), 'utf8');
  const index = fs.readFileSync(path.join(__dirname, '../../index.html'), 'utf8');

  assert.ok(
    submit.includes('const getEffectiveRouteWithSlowNotice=(input,routeAttachments,headers,context)=>routeUi.getEffectiveRouteWithSlowNotice(input,routeAttachments,headers,context);'),
    'the route UI wrapper must accept exactly the headers and route-context arguments it forwards'
  );
  assert.ok(
    submit.includes('getEffectiveRouteWithSlowNotice(effectivePromptText,requestAttachments,buildRequestHeaders("message",sessionId),null)'),
    'normal submissions must pass request headers as the third route argument, not the session ID'
  );
  assert.ok(
    submit.includes('getEffectiveRouteWithSlowNotice(promptText,[],buildRequestHeaders("message",sessionId),buildQuotedRouteContext())'),
    'quoted submissions must preserve their route context while passing valid request headers'
  );
  assert.ok(submit.includes('quoted_message:{index:1,role:quotedMessage?.role||"user",id:quotedMessage?.displayItemId||""}'), 'an explicit quote must be forwarded as a structured route binding, not only as background history');
  assert.ok(regenerate.includes('quoted_message:{index:1,role:quotedMessage?.role||"user",id:quotedMessage?.displayItemId||""}'), 'regenerating from a quote must preserve the same structured route binding');
  assert.ok(regenerate.includes('const routeMessageProjection=submitHelpers.projectRouteMessageContext?.(p,state.messages||[],quotedMessage)||null'), 'regeneration must use the same route-message execution projection as normal submission');
  assert.ok(
    !submit.includes('getEffectiveRouteWithSlowNotice(effectivePromptText,requestAttachments,sessionId,'),
    'a session ID must never be shifted into the route request headers slot'
  );
  assert.ok(
    !submit.includes('getEffectiveRouteWithSlowNotice(promptText,[],sessionId,'),
    'quoted routes must not shift the session ID into the headers slot'
  );
  assert.ok(
    index.includes('submit-workflow.js?v=1.2.97-explicit-quote-binding'),
    'the browser must fetch the explicit-quote workflow instead of a cached version'
  );
  assert.ok(submit.includes('signal:run.abortController?.signal'), 'a normal submission must pass its live-run signal into intent recognition');
  assert.ok(regenerate.includes('signal:d.abortController?.signal'), 'regeneration must pass its live-run signal into intent recognition');
  assert.ok(app.includes('getEffectiveRoute(t,s,e,n,a,{onSlow:l,onStage:l,signal:u})'), 'the root route UI must forward the signal to every route request');
  assert.ok(submit.includes('const needsHistoricalChatImages=()=>"chat"===routeMode&&historicalRouteImageRefs().length>0'), 'chat tasks with an explicitly selected historical image must request its durable media');
  assert.ok(submit.includes('getPreviousImageAttachments(sessionId,historicalRouteImageIndexes(),historicalRouteReferenceId(),historicalRouteImageIds())'), 'historical chat images must be restored by their exact historical route bindings without duplicating current uploads');
  assert.ok(submit.includes('const routeMessageProjection=submitHelpers.projectRouteMessageContext?.(routeInfo,targetSession.messages||state.messages||[],quotedMessage)||null'), 'every selected message resource must be projected into the outgoing chat base');
  assert.ok(submit.includes('if(hasRouteMessageRefs&&!routeMessageProjection)throw new Error('), 'a stale selected message must fail closed instead of falling back to arbitrary session history');
  assert.ok(submit.includes('routeContextMessageCount:routeMessageProjection?.protectedMessageCount||0'), 'the execution projection must mark route-selected messages as protected during context budgeting');
  assert.ok(chat.includes('protectedHistoryIndexes(messages, nextRequestProtectedMessageCount)'), 'chat context budgeting must preserve selected message bases');
  assert.ok(submit.includes('if(needsHistoricalChatImages()&&!previous.length)throw new Error("已选择的历史参考图片无法恢复，不能在未附图的情况下继续执行")'), 'a selected history image must never silently degrade into a text-only request');
  assert.ok(submit.includes('if(needsHistoricalChatImages()&&!chatAttachments.some(isImageAttachment))throw new Error("已选择的历史参考图片无法作为聊天附件发送，不能在未附图的情况下继续执行")'), 'the final chat attachment list must retain the selected history image');
  assert.ok(submit.includes('if(createdPending&&!routeInfo.localClarification)'), 'a local contract-failure notice must not create a fake pending user clarification');
  assert.ok(!submit.includes('我需要确认你的目标：你希望我处理这段内容、生成图片/PPT，还是进行其他操作？'), 'a model contract failure must not be presented as user ambiguity');
}

function testImageGenerationDoesNotShadowSubmitOptions() {
  const image = fs.readFileSync(path.join(__dirname, '../../client/app/image-workflow.js'), 'utf8');
  const index = fs.readFileSync(path.join(__dirname, '../../index.html'), 'utf8');

  assert.ok(
    image.includes('const imageJob=await startImageGenerationJob(u,s,e,{signal:a.abortController.signal,headers:q,sessionId:n});'),
    'plain image generation must store the created job without shadowing the sendImage options parameter'
  );
  assert.ok(
    !image.includes('const t=await startImageGenerationJob(u,s,e,{signal:a.abortController.signal,headers:q,sessionId:n});'),
    'the image job response must not create a temporal-dead-zone for t.submissionId'
  );
  assert.ok(
    image.includes('const refBindings=Array.isArray(t.referenceImageBindings)?t.referenceImageBindings:[],directReferenceBindings=refBindings.filter(e=>["current","quoted"].includes(String(e?.source||""))),historicalReferenceIds=refBindings.filter(e=>["history","context"].includes(String(e?.source||""))).map(e=>String(e?.imageId||"")).filter(Boolean);'),
    'reference generation must keep direct and historical route-media bindings distinct'
  );
  assert.ok(
    image.includes('if(f.length!==directReferenceBindings.length)throw new Error("已选择的参考图片无法作为输入附件发送，不能在未附图的情况下继续执行")') && image.includes('if(e.length!==historicalReferenceIds.length)throw new Error("已选择的参考图片无法恢复，不能在未附图的情况下继续执行")'),
    'missing direct or historical reference images must fail closed instead of silently generating without them'
  );
  assert.ok(
    index.includes('image-workflow.js?v=1.3.22-reference-media'),
    'the browser must fetch the image workflow with exact reference-media recovery'
  );
}

function testPendingContinuationRequiresStrictModelContract() {
  assert.strictEqual(clarificationService.shouldApplyPending, undefined, 'the continuation service must not expose a local heuristic fallback');
  const taskContract = {
    schema_version: 'task_contract.v3', operation: 'plain_chat', relation: 'new', resources: [],
    directive: { mode: 'standalone', base_resource_keys: [], unmentioned_policy: 'allow_change', operations: [], constraints: [] },
    clarification: { question: '', missing_resource_keys: [] }, confidence: 1, review_reasons: [], rationale: 'independent request',
  };
  assert.strictEqual(clarificationService.parseContinuationClassifierResult(JSON.stringify(taskContract)), null, 'a route task_contract must never be misread as permission to merge a pending task');

  const newTask = clarificationService.parseContinuationClassifierResult(JSON.stringify({
    schema_version: clarificationService.CONTINUATION_SCHEMA_VERSION,
    relation: 'new_task', confidence: 1, final_prompt: '', final_task_mode: 'unknown', selected_indexes: [], should_merge: false, should_clear_pending: true, reason: 'complete independent request',
  }));
  assert.ok(newTask);
  assert.strictEqual(newTask.shouldMerge, false);

  const continuation = clarificationService.parseContinuationClassifierResult(JSON.stringify({
    schema_version: clarificationService.CONTINUATION_SCHEMA_VERSION,
    relation: 'pending_answer', confidence: 0.95, final_prompt: '\u751f\u6210\u7ea2\u8272\u80cc\u666f\u7684\u4ea7\u54c1\u56fe', final_task_mode: 'image', selected_indexes: [], should_merge: true, should_clear_pending: true, reason: 'answers the pending question',
  }));
  assert.ok(continuation, 'only a complete, high-confidence continuation contract may authorize a merge');

  const submit = fs.readFileSync(path.join(__dirname, '../../client/app/submit-workflow.js'), 'utf8');
  const app = fs.readFileSync(path.join(__dirname, '../../app.js'), 'utf8');
  assert.ok(submit.includes('shouldMergePending=["pending_answer","revision","continuation"].includes(pendingDecision?.relation)&&pendingDecision?.shouldMerge===!0'), 'only a valid continuation model decision may merge pending state');
  assert.ok(!submit.includes('shouldApplyPending?.('), 'no local continuation fallback may be invoked');
  assert.ok(!submit.includes('fallback to local pending rules'), 'runtime diagnostics must not imply a local fallback exists');
  assert.ok(app.includes('async function onSubmit(e){return getSubmitWorkflow().onSubmit(e)}'), 'the root entry must delegate submission to the canonical workflow');
  assert.ok(!app.includes('function initChatUIAppSubmitWorkflow'), 'the root entry must not embed a second submit workflow');
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

module.exports = [
  testRouteRecognitionPassesHeadersAndContextWithoutArgumentShift,
  testPendingContinuationRequiresStrictModelContract,
  testImageGenerationDoesNotShadowSubmitOptions,
  testChatRerouteAllocatesRecoveryIdAfterImageMode,
];
