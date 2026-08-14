'use strict';

const assert = require('assert');
const routeService = require('../../client/services/route-service');

function testCorrectionRelationPrecedesExplicitContinuationLanguage() {
  const prompt = routeService.ROUTE_SYSTEM_PROMPT;
  const correction = prompt.indexOf('followup=否定/不满/纠正/改选');
  const continuation = prompt.indexOf('continuation=');
  assert.ok(correction >= 0, 'the route contract must define correction/resource-reselection as followup');
  assert.ok(continuation >= 0, 'the route contract must define continuation');
  assert.ok(correction < continuation, 'correction must be evaluated before continuation language');
  assert.match(prompt, /即使含(?:继续|沿用|重试)[^。\n]*followup/,
    'correction must remain followup even when the user also says continue/reuse/retry');
}

function testContinuationRequiresProgressSemanticsInsteadOfResourceReuseAlone() {
  const prompt = routeService.ROUTE_SYSTEM_PROMPT;
  assert.match(prompt, /continuation[^。\n]*(?:继续|重复|重试|下一项)[^。\n]*语义/,
    'continuation must require an explicit progress directive');
  assert.match(prompt, /再\+(?:生成)?动作/,
    'generic repeat-action wording must cover self-contained requests such as 再 followed by an operation verb');
  assert.match(prompt, /再\+生成动作[^。\n]*内容变化[^。\n]*continuation[^。\n]*不算改既有成果/,
    'repeating generation with new self-contained content is continuation, not mutation of an existing result');
  assert.match(prompt, /P5 history[^。\n]*默认followup/,
    'a history binding without stronger continuation evidence must default to followup');
}

function testHistoricalDependencyRemainsFollowupWhenBindingIsAmbiguous() {
  const prompt = routeService.ROUTE_SYSTEM_PROMPT;
  assert.match(prompt, /relation只表示执行依赖[^。\n]*非请求是否新/,
    'relation must describe execution dependency rather than whether the utterance looks like a new request');
  assert.match(prompt, /candidate_key回查source[^。\n]*任一≠current→followup/,
    'relation must dereference each selected candidate key back to its published source');
  assert.match(prompt, /需非current[^。\n]*歧义未绑[^。\n]*也同/,
    'an unresolved non-current resource must follow the same relation rule as a selected one');
  assert.match(prompt, /(?:绝不|不得)new/,
    'historical dependency must never be downgraded to new');
  assert.match(prompt, /new=[^。\n]*refs(?:为空或全current|空\/全current)/,
    'new is permitted only when no selected resource comes from historical provenance');
}

function testComposableSameApiRequirementsRemainOneTaskShape() {
  const prompt = routeService.ROUTE_SYSTEM_PROMPT;
  assert.match(prompt, /同operation\+同资源集[^。\n]*一次回答可合并[^。\n]*single/,
    'parallel requirements that share one API and resource set must remain one dispatch');
  assert.match(prompt, /multi=独立dispatch\/结果/,
    'multi must be reserved for independently dispatched or independently returned work');
  assert.doesNotMatch(prompt, /同轮多步骤即multi/,
    'the old blanket rule incorrectly split one composable request into multiple tasks');
}

function testResourceOnlyCorrectionInheritsThePriorExecutableGoal() {
  const prompt = routeService.ROUTE_SYSTEM_PROMPT;
  assert.match(prompt, /仅纠正\/改选资源[^。\n]*goal继承previous_execution\.input/,
    'resource-only corrections need the previous executable instruction as goal authority');
  assert.match(prompt, /不得把[^。\n]*对话控制语[^。\n]*goal/,
    'resource-selection control language must not become the execution goal');
}

function testQuotedTextTransformGoalStaysAnInstructionRatherThanAnAnswer() {
  const prompt = routeService.ROUTE_SYSTEM_PROMPT;
  assert.match(prompt, /改写\/摘要\/翻译[^。\n]*goal[^。\n]*动作/,
    'quoted/history text transformations must retain the requested action in goal');
  assert.match(prompt, /不得直接输出[^。\n]*(?:成品|答案)/,
    'the intent router must not execute the transformation itself');
}

module.exports = [
  testCorrectionRelationPrecedesExplicitContinuationLanguage,
  testContinuationRequiresProgressSemanticsInsteadOfResourceReuseAlone,
  testHistoricalDependencyRemainsFollowupWhenBindingIsAmbiguous,
  testComposableSameApiRequirementsRemainOneTaskShape,
  testResourceOnlyCorrectionInheritsThePriorExecutableGoal,
  testQuotedTextTransformGoalStaysAnInstructionRatherThanAnAnswer,
];
