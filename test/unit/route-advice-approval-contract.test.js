'use strict';

const assert = require('assert');
const routeService = require('../../client/services/route-service');
const taskContinuity = require('../../shared/task-continuity');

function previousImageExecution(operation = 'text_to_image') {
  return {
    operation,
    task_state: taskContinuity.createReplacementTaskContinuity('生成一张住宅平面设计图'),
  };
}

function goalModeEnum(input, operation = 'text_to_image') {
  const payload = routeService.buildRoutePayload({
    model: 'route-model',
    input,
    attachments: [],
    context: { previous_execution: previousImageExecution(operation) },
  });
  return payload.text.format.schema.properties.goal_mode.enum;
}

function testPromptSeparatesAssistantAdviceFromConfirmedUserConstraints() {
  const understandPrompt = routeService.UNDERSTAND_SYSTEM_PROMPT;
  assert.match(understandPrompt, /assistant\s*的分析、推测、评价和建议默认只是候选信息，不是已确认的用户约束/);
  assert.match(understandPrompt, /按你的建议\/照你说的\/按照上一轮建议只允许继承上一轮明确写出的建议动作/);
  assert.match(understandPrompt, /不自动采纳其中的分析结论、原因、评价、推测或未确定数值/);
  assert.match(understandPrompt, /不得把可能\/建议\/可以考虑\/存在风险改成确定事实/);
  assert.match(understandPrompt, /不得从历史文本推导新的尺寸、布局、功能或风格要求/);
  const routePrompt = routeService.ROUTE_NODE_SYSTEM_PROMPT;
  assert.match(routePrompt, /goal只写明确建议的本轮delta/);
  assert.match(routePrompt, /不得写根据上一轮指出的某个分析结论/);
}

function testExplicitAdviceAcceptanceConstrainsAnImageRevisionToAmend() {
  assert.deepStrictEqual(
    goalModeEnum('好，按照你的建议修改，重新给我一个设计图纸'),
    ['amend'],
    'explicitly accepting prior advice must preserve the previous image task and emit only a revision delta',
  );
  assert.deepStrictEqual(
    goalModeEnum('好，照你说的调整后再生成一张'),
    ['amend'],
  );
}

function testIndependentImageRequestIsNotMistakenForAdviceAcceptance() {
  assert.deepStrictEqual(
    goalModeEnum('不要之前的要求，从零重新生成一张咖啡馆海报'),
    ['replace', 'amend'],
    'a fresh self-contained request must not be forced into amend merely because prior task state exists',
  );
}

function testReferenceGenerationKeepsReplacementSemantics() {
  assert.deepStrictEqual(
    goalModeEnum('按照你的建议重新生成一张参考图海报', 'image_reference_gen'),
    ['replace', 'amend'],
    'reference generation starts from its selected image baseline and cannot amend prior text state',
  );
}

module.exports = [
  testPromptSeparatesAssistantAdviceFromConfirmedUserConstraints,
  testExplicitAdviceAcceptanceConstrainsAnImageRevisionToAmend,
  testIndependentImageRequestIsNotMistakenForAdviceAcceptance,
  testReferenceGenerationKeepsReplacementSemantics,
];
