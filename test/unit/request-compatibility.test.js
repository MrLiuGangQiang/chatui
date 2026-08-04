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

function testStructuredOutputFallbackClassifierRecognizesOnlyProtocolCapabilityErrors() {
  assert.strictEqual(compatibility.structuredOutputUnsupported(new Error('response_format json_schema unsupported')), true);
  assert.strictEqual(compatibility.structuredOutputUnsupported(new Error('invalid parameter response_format')), true);
  assert.strictEqual(compatibility.structuredOutputUnsupported(new Error('timeout while waiting')), false);
  assert.deepStrictEqual(compatibility.fallbackPayloads({ answer: 1 }), []);
}

module.exports = [
  testStructuredOutputFallbackUsesStrictJsonObjectAndPlainJsonInOrder,
  testStructuredOutputFallbackDoesNotRetryOrdinaryFailures,
  testStructuredOutputFallbackClassifierRecognizesOnlyProtocolCapabilityErrors,
];
