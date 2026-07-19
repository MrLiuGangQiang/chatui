'use strict';

const assert = require('assert');
const fs = require('fs');
const path = require('path');

function testRouteRecognitionPassesHeadersAndContextWithoutArgumentShift() {
  const submit = fs.readFileSync(path.join(__dirname, '../../client/app/submit-workflow.js'), 'utf8');
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
  assert.ok(
    !submit.includes('getEffectiveRouteWithSlowNotice(effectivePromptText,requestAttachments,sessionId,'),
    'a session ID must never be shifted into the route request headers slot'
  );
  assert.ok(
    !submit.includes('getEffectiveRouteWithSlowNotice(promptText,[],sessionId,'),
    'quoted routes must not shift the session ID into the headers slot'
  );
  assert.ok(
    index.includes('submit-workflow.js?v=1.2.86-message-projection'),
    'the browser must fetch the fixed submit workflow instead of a cached broken version'
  );
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
    index.includes('image-workflow.js?v=1.3.20-edit-resend-tdz'),
    'the browser must fetch the image workflow with the TDZ fix'
  );
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
  assert.ok(app.includes(fixedHelper) && app.includes(fixedDispatch), 'the root fallback submit workflow must match the module fix');
}

module.exports = [
  testRouteRecognitionPassesHeadersAndContextWithoutArgumentShift,
  testImageGenerationDoesNotShadowSubmitOptions,
  testChatRerouteAllocatesRecoveryIdAfterImageMode,
];
