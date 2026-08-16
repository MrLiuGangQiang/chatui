'use strict';

const assert = require('assert');
const compatibility = require('../../client/services/request-compatibility');

function responsesRoutePayload(overrides = {}) {
  return {
    model: 'route-model',
    text: {
      format: {
        type: 'json_schema',
        name: 'chatui_route_intent_v2',
        strict: true,
        schema: { type: 'object', additionalProperties: false },
      },
    },
    input: [
      { role: 'system', content: 'Return route_intent.v2 as json.' },
      { role: 'user', content: '{"output_format":"json"}' },
    ],
    ...overrides,
  };
}

async function testResponsesStructuredOutputFallbackUsesJsonObjectAndPlainJsonInOrder() {
  const payload = responsesRoutePayload();
  const attempts = [];
  const result = await compatibility.requestJsonWithStructuredOutputFallback(async body => {
    attempts.push(body);
    if (attempts.length < 3) throw new Error(`text.format ${body.text?.format?.type || 'plain'} unsupported`);
    return { ok: true };
  }, payload);

  assert.deepStrictEqual(result, { ok: true });
  assert.strictEqual(attempts.length, 3);
  assert.strictEqual(attempts[0], payload);
  assert.deepStrictEqual(attempts[1].text.format, { type: 'json_object' });
  assert.strictEqual(Object.hasOwn(attempts[2], 'text'), false);
  assert.ok(attempts[1].input.at(-1).content.includes('JSON Schema'));
  assert.ok(attempts[2].input.at(-1).content.includes('JSON Schema'));
  assert.deepStrictEqual(payload.text.format, {
    type: 'json_schema',
    name: 'chatui_route_intent_v2',
    strict: true,
    schema: { type: 'object', additionalProperties: false },
  });
  assert.strictEqual(payload.input.length, 2, 'the original Responses payload must not be mutated');
}

async function testLegacyChatStructuredOutputFallbackRemainsAvailableForRecoveredJobs() {
  const payload = {
    model: 'legacy-model',
    response_format: { type: 'json_schema', json_schema: { name: 'route' } },
    messages: [{ role: 'user', content: 'return json' }],
  };
  const attempts = [];
  const result = await compatibility.requestJsonWithStructuredOutputFallback(async body => {
    attempts.push(body);
    if (attempts.length < 3) throw new Error(`response_format ${body.response_format?.type || 'plain'} unsupported`);
    return { ok: true };
  }, payload);

  assert.deepStrictEqual(result, { ok: true });
  assert.deepStrictEqual(attempts[1].response_format, { type: 'json_object' });
  assert.strictEqual(Object.hasOwn(attempts[2], 'response_format'), false);
  assert.deepStrictEqual(payload.response_format, { type: 'json_schema', json_schema: { name: 'route' } });
}

async function testStructuredOutputFallbackDoesNotRetryOrdinaryFailures() {
  let calls = 0;
  await assert.rejects(
    () => compatibility.requestJsonWithStructuredOutputFallback(async () => {
      calls += 1;
      throw new Error('network unavailable');
    }, responsesRoutePayload()),
    /network unavailable/,
  );
  assert.strictEqual(calls, 1);
}

async function testResponsesStructuredOutputFallbackRetriesUnavailableFormat() {
  const attempts = [];
  const result = await compatibility.requestJsonWithStructuredOutputFallback(async payload => {
    attempts.push(payload);
    if (attempts.length < 3) throw new Error('This text.format type is unavailable now');
    return { output_text: '{}' };
  }, responsesRoutePayload());

  assert.strictEqual(attempts.length, 3);
  assert.deepStrictEqual(attempts[1].text.format, { type: 'json_object' });
  assert.strictEqual(Object.hasOwn(attempts[2], 'text'), false);
  assert.strictEqual(result.output_text, '{}');
}

async function testResponsesJsonObjectFallbackCarriesLowercaseJsonKeyword() {
  const attempts = [];
  const result = await compatibility.requestJsonWithStructuredOutputFallback(async payload => {
    attempts.push(payload);
    if (attempts.length === 1) {
      const error = new Error("Invalid schema for text.format 'chatui_route_intent_v2': additionalProperties is required to be supplied and to be false.");
      error.code = 'invalid_json_schema';
      throw error;
    }
    assert.deepStrictEqual(payload.text.format, { type: 'json_object' });
    const userText = payload.input.filter(item => item.role === 'user').map(item => String(item.content || '')).join('\n');
    assert.match(userText, /\bjson\b/i);
    assert.match(payload.input.at(-1).content, /JSON Schema/);
    return { output_text: '{}' };
  }, responsesRoutePayload({
    text: { format: { type: 'json_schema', name: 'chatui_route_intent_v2', schema: { type: 'object' } } },
  }));

  assert.strictEqual(result.output_text, '{}');
  assert.strictEqual(attempts.length, 2);
}

async function testResponsesStructuredOutputFallbackRetriesInvalidProviderSchema() {
  const attempts = [];
  const result = await compatibility.requestJsonWithStructuredOutputFallback(async payload => {
    attempts.push(payload);
    if (attempts.length === 1) {
      const error = new Error("Invalid schema for text.format 'chatui_route_intent_v2': 'uniqueItems' is not permitted.");
      error.code = 'invalid_json_schema';
      throw error;
    }
    return { output_text: '{}' };
  }, responsesRoutePayload());
  assert.strictEqual(attempts.length, 2);
  assert.deepStrictEqual(attempts[1].text.format, { type: 'json_object' });
  assert.ok(attempts[1].input.at(-1).content.includes('JSON Schema'));
  assert.strictEqual(result.output_text, '{}');
}

function testStructuredOutputFallbackClassifierRecognizesOnlyProtocolCapabilityErrors() {
  assert.strictEqual(compatibility.structuredOutputUnsupported(new Error('response_format json_schema unsupported')), true);
  assert.strictEqual(compatibility.structuredOutputUnsupported(new Error('This text.format type is unavailable now')), true);
  assert.strictEqual(compatibility.structuredOutputUnsupported(new Error('invalid parameter text.format')), true);
  assert.strictEqual(compatibility.structuredOutputUnsupported({
    code: 'invalid_json_schema',
    message: "Invalid schema for text.format 'chatui_route_intent_v2': 'uniqueItems' is not permitted.",
  }), true);
  assert.strictEqual(compatibility.structuredOutputUnsupported(new Error('json_schema is not allowed by this endpoint')), true);
  assert.strictEqual(compatibility.structuredOutputUnsupported({
    code: 'invalid_json_schema',
    message: "Invalid schema for response_format 'chatui_route_intent_v2': In context=('properties', 'goal'), is not allowed in string literals for structured outputs (strict=true).",
  }), true, 'the reported strict goal-string schema rejection must enter the structured-output fallback path');
  assert.strictEqual(compatibility.structuredOutputUnsupported(new Error("Response input messages must contain the word 'json' in some form to use 'text.format' of type 'json_object'.")), true);
  assert.strictEqual(compatibility.structuredOutputUnsupported(new Error('invalid schema for unrelated request body')), false);
  assert.strictEqual(compatibility.structuredOutputUnsupported(new Error('timeout while waiting')), false);
  assert.deepStrictEqual(compatibility.fallbackPayloads({ answer: 1 }), []);
}

async function testReasoningParamFallbackRetriesResponsesOnceWithoutReasoning() {
  const payload = responsesRoutePayload({
    model: 'gpt-5.6-luna',
    reasoning: { effort: 'low', summary: 'auto' },
  });
  const attempts = [];
  const result = await compatibility.requestJsonWithReasoningParamFallback(async body => {
    attempts.push(body);
    if (attempts.length === 1) throw new Error('reasoning is not supported by this endpoint');
    return { output_text: '{}' };
  }, payload);
  assert.strictEqual(attempts.length, 2);
  assert.deepStrictEqual(attempts[0].reasoning, { effort: 'low', summary: 'auto' });
  assert.strictEqual(attempts[1].reasoning, undefined);
  assert.ok(attempts[1].text?.format, 'structured output must be preserved on the reasoning retry');
  assert.strictEqual(result.output_text, '{}');
  assert.deepStrictEqual(payload.reasoning, { effort: 'low', summary: 'auto' }, 'the original payload must not be mutated');
}

async function testReasoningParamFallbackDoesNotRetryOrdinaryFailures() {
  let calls = 0;
  await assert.rejects(
    () => compatibility.requestJsonWithReasoningParamFallback(async () => {
      calls += 1;
      throw new Error('network unavailable');
    }, responsesRoutePayload({ reasoning: { effort: 'low' } })),
    /network unavailable/,
  );
  assert.strictEqual(calls, 1);
}

async function testReasoningParamFallbackSkipsWhenNoReasoningParam() {
  let calls = 0;
  const result = await compatibility.requestJsonWithReasoningParamFallback(async payload => {
    calls += 1;
    return payload;
  }, { model: 'deepseek-chat', input: [] });
  assert.strictEqual(calls, 1);
  assert.strictEqual(result.model, 'deepseek-chat');
}

function testNonStreamingResponsesPayloadConvertsToStrictChatCompletionsPayload() {
  const payload = responsesRoutePayload({
    stream: false,
    temperature: 0,
    reasoning: { effort: 'low' },
  });
  const original = JSON.parse(JSON.stringify(payload));
  const converted = compatibility.chatCompletionsPayloadFromResponsesPayload(payload);

  assert.deepStrictEqual(converted, {
    model: 'route-model',
    stream: false,
    temperature: 0,
    messages: [
      { role: 'system', content: 'Return route_intent.v2 as json.' },
      { role: 'user', content: '{"output_format":"json"}' },
    ],
    response_format: {
      type: 'json_schema',
      json_schema: {
        name: 'chatui_route_intent_v2',
        strict: true,
        schema: { type: 'object', additionalProperties: false },
      },
    },
  });
  assert.strictEqual(Object.hasOwn(converted, 'input'), false);
  assert.strictEqual(Object.hasOwn(converted, 'text'), false);
  assert.strictEqual(Object.hasOwn(converted, 'reasoning'), false);
  assert.deepStrictEqual(payload, original, 'conversion must not mutate the Responses payload');

  const jsonObject = compatibility.chatCompletionsPayloadFromResponsesPayload({
    model: 'route-model', stream: false, input: [{ role: 'user', content: 'return json' }],
    text: { format: { type: 'json_object' } },
  });
  assert.deepStrictEqual(jsonObject.response_format, { type: 'json_object' });
  assert.strictEqual(compatibility.chatCompletionsPayloadFromResponsesPayload({
    model: 'route-model', stream: true, input: [{ role: 'user', content: 'streaming must stay unsupported here' }],
  }), null, 'the converter must never create a Chat Completions streaming fallback');
}

function testEmptyStreamChunksClassifierIsExactAndNonStreamingOnly() {
  const gatewayError = new Error('failed to do request: empty stream chunks');
  gatewayError.statusCode = 500;
  gatewayError.code = 'internal_error';
  assert.strictEqual(compatibility.isNonStreamingResponsesEmptyStreamChunks(gatewayError), true);

  const nestedGatewayError = { status: 500, error: { message: 'Empty stream chunks' } };
  assert.strictEqual(compatibility.isNonStreamingResponsesEmptyStreamChunks(nestedGatewayError), true);

  const ordinary500 = new Error('upstream unavailable');
  ordinary500.statusCode = 500;
  const status429 = new Error('failed to do request: empty stream chunks');
  status429.statusCode = 429;
  const status501 = new Error('failed to do request: empty stream chunks');
  status501.statusCode = 501;
  assert.strictEqual(compatibility.isNonStreamingResponsesEmptyStreamChunks(ordinary500), false);
  assert.strictEqual(compatibility.isNonStreamingResponsesEmptyStreamChunks(status429), false);
  assert.strictEqual(compatibility.isNonStreamingResponsesEmptyStreamChunks(status501), false);
  assert.strictEqual(compatibility.isNonStreamingResponsesEmptyStreamChunks(new Error('network timeout')), false);
}


async function testToolChoiceParamFallbackRetriesOnceWithoutToolChoice() {
  const payload = responsesRoutePayload({ tool_choice: 'none' });
  const attempts = [];
  const result = await compatibility.requestJsonWithToolChoiceParamFallback(async body => {
    attempts.push(body);
    if (attempts.length === 1) throw new Error('tool_choice is not supported by this endpoint');
    return { output_text: '{}' };
  }, payload);

  assert.deepStrictEqual(result, { output_text: '{}' });
  assert.strictEqual(attempts.length, 2);
  assert.strictEqual(attempts[0], payload);
  assert.strictEqual(Object.hasOwn(attempts[1], 'tool_choice'), false);
  assert.strictEqual(payload.tool_choice, 'none', 'the original payload must remain immutable across the retry');
}

function testToolChoiceParamClassifierRecognizesOnlyCapabilityErrors() {
  assert.strictEqual(compatibility.toolChoiceParamUnsupported(new Error('tool_choice is not supported by this endpoint')), true);
  assert.strictEqual(compatibility.toolChoiceParamUnsupported(new Error('invalid parameter: tools are not allowed')), true);
  assert.strictEqual(compatibility.toolChoiceParamUnsupported(new Error('timeout while waiting for tool choice')), false);
  assert.strictEqual(compatibility.toolChoiceParamUnsupported(new Error('network unavailable')), false);
}

function testReasoningParamClassifierRecognizesOnlyCapabilityErrors() {
  assert.strictEqual(compatibility.reasoningParamUnsupported(new Error('reasoning is not supported by this endpoint')), true);
  assert.strictEqual(compatibility.reasoningParamUnsupported(new Error('invalid parameter: reasoning.effort is not allowed')), true);
  assert.strictEqual(compatibility.reasoningParamUnsupported(new Error('unknown parameter reasoning')), true);
  assert.strictEqual(compatibility.reasoningParamUnsupported(new Error('the upstream model rejected reasoning')), true);
  assert.strictEqual(compatibility.reasoningParamUnsupported(new Error('timeout while waiting for reasoning tokens')), false);
  assert.strictEqual(compatibility.reasoningParamUnsupported(new Error('network unavailable')), false);
}

module.exports = [
  testResponsesStructuredOutputFallbackUsesJsonObjectAndPlainJsonInOrder,
  testLegacyChatStructuredOutputFallbackRemainsAvailableForRecoveredJobs,
  testStructuredOutputFallbackDoesNotRetryOrdinaryFailures,
  testResponsesStructuredOutputFallbackRetriesUnavailableFormat,
  testResponsesJsonObjectFallbackCarriesLowercaseJsonKeyword,
  testResponsesStructuredOutputFallbackRetriesInvalidProviderSchema,
  testStructuredOutputFallbackClassifierRecognizesOnlyProtocolCapabilityErrors,
  testReasoningParamFallbackRetriesResponsesOnceWithoutReasoning,
  testReasoningParamFallbackDoesNotRetryOrdinaryFailures,
  testReasoningParamFallbackSkipsWhenNoReasoningParam,
  testNonStreamingResponsesPayloadConvertsToStrictChatCompletionsPayload,
  testEmptyStreamChunksClassifierIsExactAndNonStreamingOnly,
  testToolChoiceParamFallbackRetriesOnceWithoutToolChoice,
  testToolChoiceParamClassifierRecognizesOnlyCapabilityErrors,
  testReasoningParamClassifierRecognizesOnlyCapabilityErrors,
];
