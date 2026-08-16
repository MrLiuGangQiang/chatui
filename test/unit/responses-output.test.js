'use strict';

const assert = require('assert');
const sharedResponsesOutput = require('../../shared/responses-output');
const serverResponsesOutput = require('../../server/proxy/responses-output');

function providerEnvelope(outputText) {
  return {
    id: 'resp-provider-envelope',
    object: 'response',
    status: 'completed',
    text: {
      format: {
        type: 'json_schema',
        name: 'chatui_route_intent_v3',
        schema: { type: 'object' },
        strict: true,
      },
      verbosity: 'low',
    },
    output: [
      {
        type: 'reasoning',
        content: [{ type: 'reasoning_text', text: 'private reasoning must not be selected' }],
        encrypted_content: 'private-encrypted-reasoning',
      },
      {
        type: 'message',
        role: 'assistant',
        status: 'completed',
        content: [{ type: 'output_text', text: outputText }],
      },
    ],
  };
}

function testResponsesOutputUsesFinalMessageInsteadOfTopLevelTextConfiguration() {
  const routeJson = '{"operation":"plain_chat","relation":"new","goal":"hello","goal_mode":"replace","resource_refs":[],"task_shape":"single"}';
  const extracted = sharedResponsesOutput.responseOutputText(providerEnvelope(routeJson));
  assert.strictEqual(extracted, routeJson);
  assert.ok(!extracted.includes('json_schema'));
  assert.ok(!extracted.includes('private reasoning'));
}

function testResponsesOutputSupportsChatCompletionContentParts() {
  const routeJson = '{"operation":"plain_chat"}';
  assert.strictEqual(sharedResponsesOutput.responseOutputText({
    choices: [{
      message: {
        role: 'assistant',
        content: [{ type: 'text', text: routeJson }],
      },
    }],
  }), routeJson);
}

function testResponsesOutputRejectsReasoningOnlyEnvelope() {
  assert.strictEqual(sharedResponsesOutput.responseOutputText({
    text: { format: { type: 'json_schema' } },
    output: [{
      type: 'reasoning',
      content: [{ type: 'reasoning_text', text: 'not final output' }],
    }],
  }), '');
}

function testServerProxyReexportsSharedResponsesOutputInterpreter() {
  assert.strictEqual(serverResponsesOutput.extractResponsesOutputText, sharedResponsesOutput.extractResponsesOutputText);
  assert.strictEqual(serverResponsesOutput.responseOutputText, sharedResponsesOutput.responseOutputText);
}

module.exports = [
  testResponsesOutputUsesFinalMessageInsteadOfTopLevelTextConfiguration,
  testResponsesOutputSupportsChatCompletionContentParts,
  testResponsesOutputRejectsReasoningOnlyEnvelope,
  testServerProxyReexportsSharedResponsesOutputInterpreter,
];
