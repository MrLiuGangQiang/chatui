'use strict';

const assert = require('assert');
const prompts = require('../../client/services/route-prompts');

const CRITIC_REASON_CODES = Object.freeze([
  'route_goal_missing_explicit_claim',
  'route_operation_mismatch',
  'route_resource_mismatch',
  'route_exclusion_violated',
  'route_unsupported_assumption',
  'route_unnecessary_clarification',
  'route_dependency_lost',
]);

function testIntentCriticPromptEnumeratesEveryAllowedReasonCode() {
  const prompt = prompts.INTENT_CRITIC_SYSTEM_PROMPT;
  for (const code of CRITIC_REASON_CODES) {
    assert.ok(prompt.includes(code), `intent critic must enumerate allowed reason code ${code}`);
  }
}

function testImageInstructionPromptDeclaresTheStatusEnumeration() {
  const prompt = prompts.IMAGE_INSTRUCTION_SYSTEM_PROMPT;
  assert.match(prompt, /status只能是ready或needs_clarification/);
  assert.match(prompt, /needs_clarification时只给简短追问、不输出instruction/);
}

function testImagePlanPromptSeparatesStructuralCeilingFromExecutionBatchLimit() {
  const prompt = prompts.IMAGE_PLAN_SYSTEM_PROMPT;
  assert.match(prompt, /执行批次上限 \d+/);
  assert.match(prompt, /执行层按批处理，本节点只按用户要求拆分/,
    'the planner must not silently truncate to the execution batch limit');
  const custom = prompts.createRoutePromptSet({ imagePlanMaxTasks: 3 });
  assert.match(custom.IMAGE_PLAN_SYSTEM_PROMPT, /执行批次上限 3/,
    'the execution batch limit must stay parameterized');
}

module.exports = [
  testIntentCriticPromptEnumeratesEveryAllowedReasonCode,
  testImageInstructionPromptDeclaresTheStatusEnumeration,
  testImagePlanPromptSeparatesStructuralCeilingFromExecutionBatchLimit,
];
