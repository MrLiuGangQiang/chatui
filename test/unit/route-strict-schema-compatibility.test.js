'use strict';

const assert = require('assert');
const fs = require('fs');
const path = require('path');
const routeService = require('../../client/services/route-service');
const compatibility = require('../../client/services/request-compatibility');

function testRouteIntentV3ProviderSchemaOmitsUnsupportedStringLiteralKeywords() {
  const payload = routeService.buildRoutePayload({
    model: 'route-model',
    input: '总结当前问题',
    attachments: [],
    context: {},
  });
  const goal = payload.text.format.schema.properties.goal;
  assert.deepStrictEqual(goal, { type: 'string', enum: ['总结当前问题'] },
    'strict provider schemas must not send minLength/maxLength for the route goal');
}

function testExactRouteIntentV3SchemaErrorTriggersCompatibilityFallback() {
  const error = new Error("Request failed: Bad Request, error: Invalid schema for response_format 'chatui_route_intent_v3': In context=('properties', 'goal'), is not allowed in string literals for structured outputs (strict=true).");
  error.code = 'invalid_json_schema';
  assert.strictEqual(compatibility.structuredOutputUnsupported(error), true);
}

function testStrictSchemaCompatibilityModulesUseFreshStaticCacheKeys() {
  const html = fs.readFileSync(path.join(__dirname, '../../index.html'), 'utf8');
  assert.match(html, /client\/services\/chat-service\.js\?v=1\.3\.2-strict-schema-subset/,
    'the schema sanitizer must not be hidden behind the previous cached script URL');
  assert.match(html, /client\/services\/request-compatibility\.js\?v=1\.0\.1-invalid-schema-fallback/,
    'the invalid-schema retry must use a fresh script URL');
}

module.exports = [
  testRouteIntentV3ProviderSchemaOmitsUnsupportedStringLiteralKeywords,
  testExactRouteIntentV3SchemaErrorTriggersCompatibilityFallback,
  testStrictSchemaCompatibilityModulesUseFreshStaticCacheKeys,
];
