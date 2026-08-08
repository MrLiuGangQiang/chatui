'use strict';

const assert = require('assert');
const chatWorkflow = require('../../client/app/chat-workflow');

function testRetryOnlyBeforeAcceptanceOrAnswer() {
  assert.strictEqual(chatWorkflow.shouldRetryStreamFailure({ requestAccepted: false, answerStarted: false }), true,
    'a failure before the upstream accepted the stream may retry');
  assert.strictEqual(chatWorkflow.shouldRetryStreamFailure({ requestAccepted: true, answerStarted: false }), false,
    'an accepted stream must surface its failure instead of retrying');
  assert.strictEqual(chatWorkflow.shouldRetryStreamFailure({ requestAccepted: false, answerStarted: true }), false,
    'a stream that already answered must surface its failure instead of retrying');
}

module.exports = [
  testRetryOnlyBeforeAcceptanceOrAnswer,
];
