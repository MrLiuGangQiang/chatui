'use strict';

const assert = require('assert');
const routeService = require('../../client/services/route-service');
const compatibility = require('../../client/services/request-compatibility');

async function assertFirstStructuredAttemptContainsJson(payload, label) {
  let calls = 0;
  const result = await compatibility.requestJsonWithStructuredOutputFallback(async body => {
    calls += 1;
    const messages = Array.isArray(body.input)
      ? body.input
      : (Array.isArray(body.messages) ? body.messages : []);
    const input = messages.map(message => String(message?.content || '')).join('\n');
    const userInput = messages
      .filter(message => message?.role === 'user')
      .map(message => String(message?.content || ''))
      .join('\n');
    assert.ok(/\bjson\b/i.test(userInput),
      `${label} must carry the JSON-mode marker in the user message for gateways that drop system messages`);
    if (!/\bjson\b/.test(input)) {
      const error = new Error("Response input messages must contain the word 'json' in some form to use 'text.format' of type 'json_object'.");
      error.code = 'invalid_request_error';
      throw error;
    }
    return { ok: true };
  }, payload);

  assert.deepStrictEqual(result, { ok: true });
  assert.strictEqual(calls, 1, `${label} must satisfy the Responses json_object input contract on the first request`);
}

async function testRouteIntentPromptSatisfiesJsonObjectInputContractInitially() {
  const payload = routeService.buildRoutePayload({
    model: 'route-model',
    input: '你好',
    attachments: [],
    context: {},
  });
  assert.ok(Array.isArray(payload.input));
  assert.ok(payload.text?.format);
  assert.strictEqual(Object.hasOwn(payload, 'messages'), false);
  await assertFirstStructuredAttemptContainsJson(payload, 'route intent');
}

async function testImagePlanPromptSatisfiesJsonObjectInputContractInitially() {
  const payload = routeService.buildImagePlanPayload({
    model: 'route-model',
    input: '分别画一只猫和一只狗',
    goal: '分别生成一张猫图和一张狗图',
    attachments: [],
    context: {},
  });
  assert.ok(Array.isArray(payload.input));
  assert.ok(payload.text?.format);
  assert.strictEqual(Object.hasOwn(payload, 'messages'), false);
  await assertFirstStructuredAttemptContainsJson(payload, 'image plan');
}

function testImagePlanStrictSchemaRequiresEveryDeclaredTaskField() {
  const taskSchema = routeService.IMAGE_PLAN_RESPONSE_FORMAT.json_schema.schema.properties.tasks.items;
  assert.deepStrictEqual(
    taskSchema.required,
    Object.keys(taskSchema.properties),
    'strict json_schema task objects must require every declared property on the first provider request',
  );
}

module.exports = [
  testRouteIntentPromptSatisfiesJsonObjectInputContractInitially,
  testImagePlanPromptSatisfiesJsonObjectInputContractInitially,
  testImagePlanStrictSchemaRequiresEveryDeclaredTaskField,
];
