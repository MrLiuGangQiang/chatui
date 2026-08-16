'use strict';

const assert = require('assert');
const routeIntent = require('../../shared/route-intent');
const routeService = require('../../client/services/route-service');

function testQuotedContentGroundingSeparatesContextBindingFromRelationPriority() {
  const schema = routeIntent.ROUTE_INTENT_RESPONSE_FORMAT.json_schema.schema;
  const prompt = routeService.ROUTE_SYSTEM_PROMPT;

  assert.strictEqual(Object.hasOwn(schema.properties.relation, 'description'), false,
    'the strict wire schema must not duplicate route policy prose');
  assert.match(prompt, /P3 quoted正文是消息证据来源：只有 quoted\/history 正文为goal提供必需事实时，才绑定对应mN=context/,
    'a quoted message is a context resource only when its body supplies facts needed by the goal');
  assert.match(prompt, /仅仅存在quoted不绑定/,
    'the mere presence of quoted content must not create a context binding');
  assert.match(prompt, /若goal使用quoted\/history正文事实，必须绑定相应mN=context/,
    'message facts copied into goal must retain an explicit context binding');
  assert.match(prompt, /quoted正文作事实也followup，压过继续语义/,
    'relation priority must separately classify actual quoted fact use as followup');
  assert.match(prompt, /continuation=无1且明确仍是同一任务\/主题\/设计维度的继续、重复、重试或下一项/,
    'continuation wording remains a separate decision after the quoted-fact priority rule');
  assert.doesNotMatch(prompt, /P3 quoted→followup/,
    'resource evidence selection must not be mislabeled as a relation rule');
}
function testMultiTaskGoalPreservesEveryRequestedStepInsteadOfOnlyTheFirstOperation() {
  const schema = routeIntent.ROUTE_INTENT_RESPONSE_FORMAT.json_schema.schema;
  const prompt = routeService.ROUTE_SYSTEM_PROMPT;

  assert.strictEqual(Object.hasOwn(schema.properties.goal, 'description'), false,
    'the compact wire schema should contain validation, not duplicated policy prose');
  assert.match(prompt, /task_shape描述本轮需要几次独立执行，而不是资源数量/);
  assert.match(prompt, /task_shape：multi=多个独立执行/);
  assert.match(prompt, /对于可直接执行的图片生成\/编辑任务，multi=多个独立图片结果/);
  assert.match(prompt, /多图看\/比\/OCR\/汇总→single/);
  assert.match(prompt, /非图片或跨operation的多个必做步骤.*task_shape=multi.*需要拆分/);
  assert.match(prompt, /operation 填第一个必做步骤.*goal 保留全部任务/,
    'selecting the first operation must not erase later requested tasks from goal');
}
module.exports = [
  testQuotedContentGroundingSeparatesContextBindingFromRelationPriority,
  testMultiTaskGoalPreservesEveryRequestedStepInsteadOfOnlyTheFirstOperation,
];
