'use strict';

const assert = require('assert');
const prompts = require('../../client/services/route-prompts');
const routeService = require('../../client/services/route-service');
const understanding = require('../../shared/intent-understanding');

const UNDERSTAND_PROMPT = prompts.UNDERSTAND_SYSTEM_PROMPT_LINES.join('\n');
const ROUTE_NODE_PROMPT = prompts.ROUTE_NODE_SYSTEM_PROMPT_LINES.join('\n');

function walkSchema(node, visit) {
  if (!node || typeof node !== 'object') return;
  visit(node);
  Object.values(node).forEach(value => walkSchema(value, visit));
}

function testUnderstandingSchemaUsesGatewayCompatibleConstraints() {
  const schema = understanding.UNDERSTANDING_RESPONSE_FORMAT.json_schema.schema;
  walkSchema(schema, node => {
    for (const key of ['minimum', 'maximum', 'exclusiveMinimum', 'exclusiveMaximum']) {
      assert.ok(!Object.prototype.hasOwnProperty.call(node, key),
        `understanding structured output must not use the unsupported numeric bound ${key}`);
    }
  });
  assert.deepStrictEqual(schema.properties.schema_version, {
    type: 'string',
    const: 'intent_understanding.v1',
  });
}

function testUnderstandingPromptDropsUnconsumedFieldsAndOwnsDeliveryRecovery() {
  assert.doesNotMatch(UNDERSTAND_PROMPT, /ordering|verb/,
    'the understand prompt must not demand fields the strict schema no longer declares');
  assert.match(UNDERSTAND_PROMPT, /dependency：本轮与前序执行的关系/);
  assert.match(UNDERSTAND_PROMPT, /delivery_evidence/,
    'the understand node must see delivery facts for missing-image recovery');
  assert.match(UNDERSTAND_PROMPT, /对上一张图交付状态的追问/);
  assert.match(UNDERSTAND_PROMPT, /dependency=followup/);
}

function testUnderstandingPromptOwnsItsProtocolAndSplitsIndependentImageActions() {
  assert.match(UNDERSTAND_PROMPT, /intent_understanding\.v1/);
  assert.match(UNDERSTAND_PROMPT, /上传图片\/文件只是回答依据，不是独立任务/);
  assert.match(UNDERSTAND_PROMPT, /每个独立执行结果一条 action/);
  assert.match(UNDERSTAND_PROMPT, /只有独立输出才拆分/);
  assert.match(UNDERSTAND_PROMPT, /否定\/排除.*不是 action/);
  assert.match(UNDERSTAND_PROMPT, /"index":1,"kind":"image_generate"/);
  assert.match(UNDERSTAND_PROMPT, /"index":2,"kind":"image_generate"/);
  assert.doesNotMatch(UNDERSTAND_PROMPT, /【判断顺序】/,
    'the understand node must not reuse the route node decision-order prompt');
  assert.doesNotMatch(UNDERSTAND_PROMPT, /goal_mode/,
    'the understand node must not write route goal-mode decisions');
  assert.ok(UNDERSTAND_PROMPT.length <= 2800, `understand prompt must stay bounded, got ${UNDERSTAND_PROMPT.length}`);
}

function testRuntimePayloadsStopSendingTheLegacyMonolith() {
  const routePayload = routeService.buildRoutePayload({
    model: 'route-model', input: '画一只猫', attachments: [], context: {},
  });
  const routeSystem = routePayload.input.find(message => message.role === 'system');
  assert.strictEqual(routeSystem.content, ROUTE_NODE_PROMPT);
  assert.doesNotMatch(routeSystem.content, /Model-first:/);
  assert.match(routeSystem.content, /意图路由节点/);

  const understandPayload = routeService.buildUnderstandingPayload({
    model: 'route-model', input: '分别生成两只猫', attachments: [], context: {},
  });
  const understandSystem = understandPayload.input.find(message => message.role === 'system');
  assert.strictEqual(understandSystem.content, UNDERSTAND_PROMPT);
  assert.match(understandSystem.content, /intent_understanding\.v1/);
  assert.doesNotMatch(understandSystem.content, /【operation】/,
    'the understand node must not send the old operation classification prompt');
}

module.exports = [
  testUnderstandingSchemaUsesGatewayCompatibleConstraints,
  testUnderstandingPromptDropsUnconsumedFieldsAndOwnsDeliveryRecovery,
  testUnderstandingPromptOwnsItsProtocolAndSplitsIndependentImageActions,
  testRuntimePayloadsStopSendingTheLegacyMonolith,
];
