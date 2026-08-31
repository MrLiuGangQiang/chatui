'use strict';

const assert = require('assert');
const routeService = require('../../client/services/route-service');
const chatService = require('../../client/services/chat-service');
const imageInstruction = require('../../shared/image-instruction');
const compatibility = require('../../client/services/request-compatibility');
const capabilities = require('../../shared/model-capabilities');
const fs = require('fs');
const path = require('path');

async function testDeepSeekIntentPayloadStartsWithJsonObject() {
  const payload = routeService.buildRoutePayload({
    model: 'deepseek-v4-flash', input: '总结这段文字', attachments: [], context: {},
  });
  assert.strictEqual(payload.text.format.type, 'json_schema', 'the local route protocol remains fully specified');
  const attempts = [];
  await compatibility.requestJsonWithStructuredOutputFallback(async body => {
    attempts.push(body);
    return { output_text: '{}' };
  }, payload, {}, { modelId: 'deepseek-v4-flash' });
  assert.strictEqual(attempts.length, 1, 'DeepSeek must not first receive json_schema and fail a route request');
  assert.deepStrictEqual(attempts[0].text.format, { type: 'json_object' });
  assert.match(attempts[0].input.at(-1).content, /JSON Schema/);
}

async function testDeepSeekFallbackInstructionRetainsCanonicalImageProtocol() {
  const payload = chatService.buildResponsesPayload('deepseek-v4-flash', [
    { role: 'system', content: '物化图片执行指令。' },
    { role: 'user', content: '{"output_format":"json"}' },
  ], {
    stream: false,
    noReasoning: true,
    responseFormat: imageInstruction.IMAGE_INSTRUCTION_RESPONSE_FORMAT,
  });
  const attempts = [];
  await compatibility.requestJsonWithStructuredOutputFallback(async body => {
    attempts.push(body);
    return { output_text: JSON.stringify({
      schema_version: 'image_instruction.v1',
      status: 'ready',
      instruction: '完整的图片执行指令。',
      clarification: '',
    }) };
  }, payload, {}, { modelId: 'deepseek-v4-flash' });

  assert.strictEqual(attempts.length, 1);
  assert.deepStrictEqual(attempts[0].text.format, { type: 'json_object' },
    'DeepSeek may receive json_object on the wire, but the local protocol remains canonical');
  const fallbackInstruction = String(attempts[0].input.at(-1)?.content || '');
  assert.match(fallbackInstruction, /image_instruction\.v1/);
  assert.match(fallbackInstruction, /schema_version/);
  assert.match(fallbackInstruction, /const/);
  assert.match(fallbackInstruction, /instruction/);
  assert.match(fallbackInstruction, /clarification/);
}

function testOnlyDeepSeekGetsTheEagerJsonObjectCompatibilityMode() {
  assert.strictEqual(capabilities.initialStructuredOutputMode('deepseek-v4-pro'), 'json_object');
  assert.strictEqual(capabilities.initialStructuredOutputMode('gpt-5.6-terra'), '');
}

function testRouteWorkflowPassesTheSelectedIntentModelToCompatibility() {
  const source = fs.readFileSync(path.join(__dirname, '../../client/app/route-intent-workflow.js'), 'utf8');
  assert.match(source, /requestJsonWithStructuredOutputFallback\(inner, body, compatibilityProfile, \{ modelId: body\?\.model \}\)/);
}

module.exports = [
  testDeepSeekIntentPayloadStartsWithJsonObject,
  testOnlyDeepSeekGetsTheEagerJsonObjectCompatibilityMode,
  testDeepSeekFallbackInstructionRetainsCanonicalImageProtocol,
  testRouteWorkflowPassesTheSelectedIntentModelToCompatibility,
];
