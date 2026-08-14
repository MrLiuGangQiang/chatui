'use strict';

const assert = require('assert');
const fs = require('fs');
const path = require('path');
const chatWorkflow = require('../../client/app/chat-workflow');

function testAcceptedStreamFailureDoesNotStartFallbackRequest() {
  assert.strictEqual(
    chatWorkflow.shouldRetryStreamFailure({ requestAccepted: true, answerStarted: false }),
    false,
    'once the upstream has accepted the stream, a later transport or UI failure must not create a second completion request',
  );
  assert.strictEqual(
    chatWorkflow.shouldRetryStreamFailure({ requestAccepted: false, answerStarted: true }),
    false,
    'once answer output has started, the workflow must not create a second completion request',
  );
  assert.strictEqual(
    chatWorkflow.shouldRetryStreamFailure({ requestAccepted: false, answerStarted: false }),
    true,
    'fallback remains available only when the initial stream failed before it was accepted or produced output',
  );
}

function testChatWorkflowGuardsFallbackAfterAcceptance() {
  const source = fs.readFileSync(path.join(__dirname, '../../client/app/chat-workflow.js'), 'utf8');
  assert.ok(source.includes('streamRequestAccepted=!0;if(!n.deferReplacementClear)return'), 'the accepted callback must record acceptance independently of replacement rendering');
  assert.ok(source.includes('if(streamRetries>=2||!shouldRetryStreamFailure({requestAccepted:streamRequestAccepted,answerStarted}))throw e;streamRetries+=1;let t;'), 'the fallback request must be blocked after acceptance or visible output and the retry loop must be capped so failures always surface');
}

function testWaitingStatusBridgesTheGapBeforeThinkingOrAnswerOutput() {
  const source = fs.readFileSync(path.join(__dirname, '../../client/app/chat-workflow.js'), 'utf8');
  assert.ok(
    source.includes("const pendingStatus = executionStatus.operationStatusText?.(executionAuthorization.plan, 'execute') || '正在等待模型生成回答';"),
    'the initial placeholder must use the canonical operation status instead of a fixed execution map'
  );
  assert.ok(
    source.includes('g?.isConnected&&!n.deferReplacementClear&&setPendingFeedback(g,pendingStatus'),
    'reasoning-enabled streams must keep the pending placeholder until thinking or answer text actually arrives'
  );
  assert.ok(
    !source.includes('reasoningEnabled?(clearPendingFeedback(g),updateMessageContentLight(g,""'),
    'the initial reasoning path must not clear the pending placeholder into an empty content region'
  );
}


function testReasoningFinishesWhenAnswerStarts() {
  const source = fs.readFileSync(path.join(__dirname, '../../client/app/chat-workflow.js'), 'utf8');
  assert.ok(source.includes('let answerStarted=!1,reasoningCompleted=!1,streamRequestAccepted=!1'), 'the stream should track reasoning completion separately from answer completion');
  assert.ok(source.includes('if(!reasoningCompleted){reasoningCompleted=!0;if(reasoningEnabled&&reasoningText&&g?.isConnected)updateReasoning(g,reasoningText,{done:!0'), 'the reasoning panel must switch to completed as soon as answer output starts');
}

module.exports = [
  testAcceptedStreamFailureDoesNotStartFallbackRequest,
  testChatWorkflowGuardsFallbackAfterAcceptance,
  testWaitingStatusBridgesTheGapBeforeThinkingOrAnswerOutput,
  testReasoningFinishesWhenAnswerStarts,
];
