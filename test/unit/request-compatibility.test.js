'use strict';

const assert = require('assert');
const compatibility = require('../../client/services/request-compatibility');

function testStructuredOutputFallbackUsesStrictJsonObjectAndPlainJsonInOrder() {
  const payload = {
    model: 'route-model',
    response_format: { type: 'json_schema', json_schema: { name: 'route' } },
    messages: [],
  };
  const attempts = [];
  const response = compatibility.requestJsonWithStructuredOutputFallback(async body => {
    attempts.push(body);
    if (attempts.length < 3) throw new Error(`response_format ${body.response_format?.type || 'plain'} unsupported`);
    return { ok: true };
  }, payload);
  return response.then(result => {
    assert.deepStrictEqual(result, { ok: true });
    assert.strictEqual(attempts.length, 3);
    assert.strictEqual(attempts[0], payload);
    assert.deepStrictEqual(attempts[1].response_format, { type: 'json_object' });
    assert.strictEqual(Object.prototype.hasOwnProperty.call(attempts[2], 'response_format'), false);
    assert.deepStrictEqual(payload.response_format, { type: 'json_schema', json_schema: { name: 'route' } });
  });
}

async function testStructuredOutputFallbackDoesNotRetryOrdinaryFailures() {
  let calls = 0;
  await assert.rejects(
    () => compatibility.requestJsonWithStructuredOutputFallback(async () => {
      calls += 1;
      throw new Error('network unavailable');
    }, { response_format: { type: 'json_schema' } }),
    /network unavailable/,
  );
  assert.strictEqual(calls, 1);
}

async function testStructuredOutputFallbackRetriesUnavailableResponseFormat() {
  const attempts = [];
  const result = await compatibility.requestJsonWithStructuredOutputFallback(async payload => {
    attempts.push(payload);
    if (attempts.length < 3) throw new Error('This response_format type is unavailable now');
    return { choices: [{ message: { content: '{}' } }] };
  }, {
    model: 'route-model',
    response_format: { type: 'json_schema', json_schema: { name: 'chatui_semantic_task_v2' } },
    messages: [],
  });

  assert.strictEqual(attempts.length, 3);
  assert.deepStrictEqual(attempts[1].response_format, { type: 'json_object' });
  assert.strictEqual(Object.prototype.hasOwnProperty.call(attempts[2], 'response_format'), false);
  assert.deepStrictEqual(result.choices[0].message.content, '{}');
}

async function testJsonObjectFallbackIncludesRequiredLowercaseJsonKeyword() {
  const attempts = [];
  const result = await compatibility.requestJsonWithStructuredOutputFallback(async payload => {
    attempts.push(payload);
    if (attempts.length === 1) {
      const error = new Error("Invalid schema for response_format 'chatui_semantic_task_v2': additionalProperties is required to be supplied and to be false.");
      error.code = 'invalid_json_schema';
      throw error;
    }
    if (attempts.length === 2) {
      throw new Error("Response input messages must contain the word 'json' in some form to use 'text.format' of type 'json_object'.");
    }
    return { choices: [{ message: { content: '{}' } }] };
  }, {
    model: 'route-model',
    response_format: { type: 'json_schema', json_schema: { name: 'chatui_semantic_task_v2', schema: { type: 'object' } } },
    messages: [{ role: 'system', content: 'return json' }],
  });

  assert.deepStrictEqual(result.choices[0].message.content, '{}');
  assert.strictEqual(attempts.length, 3);
  assert.deepStrictEqual(attempts[1].response_format, { type: 'json_object' });
  assert.match(attempts[1].messages.at(-1).content, /\bjson\b/);
  assert.strictEqual(Object.prototype.hasOwnProperty.call(attempts[2], 'response_format'), false);
}

async function testStructuredOutputFallbackRetriesInvalidProviderSchema() {
  const attempts = [];
  const result = await compatibility.requestJsonWithStructuredOutputFallback(async payload => {
    attempts.push(payload);
    if (attempts.length === 1) {
      const error = new Error("Invalid schema for response_format 'chatui_semantic_task_v2': 'uniqueItems' is not permitted.");
      error.code = 'invalid_json_schema';
      throw error;
    }
    return { choices: [{ message: { content: '{}' } }] };
  }, {
    model: 'route-model',
    response_format: { type: 'json_schema', json_schema: { name: 'chatui_semantic_task_v2', schema: { type: 'object' } } },
    messages: [],
  });
  assert.strictEqual(attempts.length, 2);
  assert.deepStrictEqual(attempts[1].response_format, { type: 'json_object' });
  assert.ok(attempts[1].messages.at(-1).content.includes('JSON Schema'));
  assert.deepStrictEqual(result.choices[0].message.content, '{}');
}

function testStructuredOutputFallbackClassifierRecognizesOnlyProtocolCapabilityErrors() {
  assert.strictEqual(compatibility.structuredOutputUnsupported(new Error('response_format json_schema unsupported')), true);
  assert.strictEqual(compatibility.structuredOutputUnsupported(new Error('This response_format type is unavailable now')), true);
  assert.strictEqual(compatibility.structuredOutputUnsupported(new Error('invalid parameter response_format')), true);
  assert.strictEqual(compatibility.structuredOutputUnsupported({
    code: 'invalid_json_schema',
    message: "Invalid schema for response_format 'chatui_semantic_task_v2': 'uniqueItems' is not permitted.",
  }), true);
  assert.strictEqual(compatibility.structuredOutputUnsupported(new Error('json_schema is not allowed by this endpoint')), true);
  assert.strictEqual(compatibility.structuredOutputUnsupported(new Error("Response input messages must contain the word 'json' in some form to use 'text.format' of type 'json_object'.")), true);
  assert.strictEqual(compatibility.structuredOutputUnsupported(new Error('invalid schema for unrelated request body')), false);
  assert.strictEqual(compatibility.structuredOutputUnsupported(new Error('timeout while waiting')), false);
  assert.deepStrictEqual(compatibility.fallbackPayloads({ answer: 1 }), []);
}

module.exports = [
  testStructuredOutputFallbackUsesStrictJsonObjectAndPlainJsonInOrder,
  testStructuredOutputFallbackDoesNotRetryOrdinaryFailures,
  testStructuredOutputFallbackRetriesUnavailableResponseFormat,
  testJsonObjectFallbackIncludesRequiredLowercaseJsonKeyword,
  testStructuredOutputFallbackRetriesInvalidProviderSchema,
  testStructuredOutputFallbackClassifierRecognizesOnlyProtocolCapabilityErrors,
];
