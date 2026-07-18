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
    index.includes('submit-workflow.js?v=1.2.82-canonical-task-state'),
    'the browser must fetch the fixed submit workflow instead of a cached broken version'
  );
}

module.exports = [testRouteRecognitionPassesHeadersAndContextWithoutArgumentShift];
