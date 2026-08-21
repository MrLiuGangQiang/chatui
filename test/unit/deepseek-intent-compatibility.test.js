'use strict';

const assert = require('assert');
const routeService = require('../../client/services/route-service');
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

function testOnlyDeepSeekGetsTheEagerJsonObjectCompatibilityMode() {
  assert.strictEqual(capabilities.initialStructuredOutputMode('deepseek-v4-pro'), 'json_object');
  assert.strictEqual(capabilities.initialStructuredOutputMode('gpt-5.6-luna'), '');
}

function testRouteWorkflowPassesTheSelectedIntentModelToCompatibility() {
  const source = fs.readFileSync(path.join(__dirname, '../../client/app/route-intent-workflow.js'), 'utf8');
  assert.match(source, /requestJsonWithStructuredOutputFallback\(inner, body, compatibilityProfile, \{ modelId: body\?\.model \}\)/);
}

module.exports = [
  testDeepSeekIntentPayloadStartsWithJsonObject,
  testOnlyDeepSeekGetsTheEagerJsonObjectCompatibilityMode,
  testRouteWorkflowPassesTheSelectedIntentModelToCompatibility,
];
