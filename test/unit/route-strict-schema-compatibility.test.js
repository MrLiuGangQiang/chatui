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
  assert.deepStrictEqual(goal, { type: 'string' },
    'strict provider schemas must send the route goal as a plain string: no minLength/maxLength and no user-input enum literal');
}

function testLongRouteInputNeverBecomesAGoalEnumLiteral() {
  const longInput = '要求1，要求2，要求3，要求4，要求5，要求6，要求7，要求8，要求9，要求10，要求11，要求12，要求13，要求14，要求15，要求16，要求17，要求18，要求19，要求20，要求21，要求22，要求23，要求24，要求25，要求26，要求27，要求28，要求29，要求30，要求31，要求32，要求33，要求34，要求35，要求36，要求37，要求38，要求39，要求40';
  const payload = routeService.buildRoutePayload({
    model: 'route-model',
    input: longInput,
    attachments: [],
    context: {},
  });
  const goal = payload.text.format.schema.properties.goal;

  assert.strictEqual(Object.prototype.hasOwnProperty.call(goal, 'enum'), false,
    'a long user input must never be embedded as a goal enum string literal on the wire');
  assert.strictEqual(Object.prototype.hasOwnProperty.call(goal, 'minLength'), false);
  assert.strictEqual(Object.prototype.hasOwnProperty.call(goal, 'maxLength'), false);
  assert.deepStrictEqual(goal, { type: 'string' });
}
function testExactRouteIntentV3SchemaErrorTriggersCompatibilityFallback() {
  const error = new Error("Request failed: Bad Request, error: Invalid schema for response_format 'chatui_route_intent_v3': In context=('properties', 'goal'), is not allowed in string literals for structured outputs (strict=true).");
  error.code = 'invalid_json_schema';
  assert.strictEqual(compatibility.structuredOutputUnsupported(error), true);
}

function testStrictSchemaCompatibilityModulesUseFreshStaticCacheKeys() {
  const html = fs.readFileSync(path.join(__dirname, '../../index.html'), 'utf8');
  assert.match(html, /client\/services\/chat-service\.js\?v=1\.3\.4-adaptive-intent-reasoning/,
    'the schema sanitizer must not be hidden behind the previous cached script URL');
  assert.match(html, /client\/services\/request-compatibility\.js\?v=1\.0\.3-canonical-fallback-schema/,
    'the invalid-schema retry must use a fresh script URL');
}

module.exports = [
  testRouteIntentV3ProviderSchemaOmitsUnsupportedStringLiteralKeywords,
  testLongRouteInputNeverBecomesAGoalEnumLiteral,
  testExactRouteIntentV3SchemaErrorTriggersCompatibilityFallback,
  testStrictSchemaCompatibilityModulesUseFreshStaticCacheKeys,
];
