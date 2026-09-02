'use strict';

const assert = require('assert');
const prompts = require('../../client/services/route-prompts');

function testRoutePromptsDescribeMessageRecencyWithoutTheWireFieldName() {
  for (const [name, prompt] of [
    ['full', prompts.ROUTE_NODE_SYSTEM_PROMPT],
    ['simple', prompts.ROUTE_NODE_SYSTEM_PROMPT_SIMPLE],
  ]) {
    assert.match(prompt, /消息序号大者更新/,
      `${name} route prompt must teach recency from the message index signal`);
    assert.match(prompt, /模糊指代选最大/,
      `${name} route prompt must bind vague references to the newest candidate`);
    assert.doesNotMatch(prompt, /message_index大者更新/,
      `${name} route prompt must not reuse the resource_candidate wire field name as a routing output rule`);
  }
}

function testIntentCriticPromptExemplifiesClarifyAndRejectVerdicts() {
  const prompt = prompts.INTENT_CRITIC_SYSTEM_PROMPT;
  assert.match(prompt, /verdict=clarify/,
    'the critic must exemplify the clarify verdict');
  assert.match(prompt, /目标图候选缺失，需用户确认/,
    'the clarify example must carry a user-facing clarification reason');
  assert.match(prompt, /verdict=reject/,
    'the critic must exemplify the reject verdict');
  assert.match(prompt, /输入不可判断/,
    'the reject example must be limited to unjudgable inputs');
}

function testMultiTaskPlanPromptExemplifiesTheFirstStepRouteGoalHandoff() {
  const prompt = prompts.MULTI_TASK_PLAN_SYSTEM_PROMPT;
  assert.match(prompt, /【交接示例】route_goal只写第一步/,
    'the multi-task planner must explain the first-step-only route_goal handoff');
  assert.match(prompt, /不得以route_goal只含第一步为由漏掉后续动作/,
    'the planner must split every current_input action even when route_goal names only the first one');
}

module.exports = [
  testRoutePromptsDescribeMessageRecencyWithoutTheWireFieldName,
  testIntentCriticPromptExemplifiesClarifyAndRejectVerdicts,
  testMultiTaskPlanPromptExemplifiesTheFirstStepRouteGoalHandoff,
];
