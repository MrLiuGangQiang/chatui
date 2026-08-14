'use strict';

const assert = require('assert');
const routeService = require('../../client/services/route-service');
const compatibility = require('../../client/services/request-compatibility');

async function assertFirstStructuredAttemptContainsJson(payload, label) {
  let calls = 0;
  const result = await compatibility.requestJsonWithStructuredOutputFallback(async body => {
    calls += 1;
    const input = (Array.isArray(body.messages) ? body.messages : [])
      .map(message => String(message?.content || ''))
      .join('\n');
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
  await assertFirstStructuredAttemptContainsJson(routeService.buildRoutePayload({
    model: 'route-model',
    input: '你好',
    attachments: [],
    context: {},
  }), 'route intent');
}

async function testImagePlanPromptSatisfiesJsonObjectInputContractInitially() {
  await assertFirstStructuredAttemptContainsJson(routeService.buildImagePlanPayload({
    model: 'route-model',
    input: '分别画一只猫和一只狗',
    goal: '分别生成一张猫图和一张狗图',
    attachments: [],
    context: {},
  }), 'image plan');
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
