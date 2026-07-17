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
  assert.ok(source.includes('if(!shouldRetryStreamFailure({requestAccepted:streamRequestAccepted,answerStarted}))throw e;let t;'), 'the fallback request must be blocked after acceptance or visible output');
}

module.exports = [
  testAcceptedStreamFailureDoesNotStartFallbackRequest,
  testChatWorkflowGuardsFallbackAfterAcceptance,
];
