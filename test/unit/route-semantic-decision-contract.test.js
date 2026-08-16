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

function testQuotedFactsOverrideContinuationSemantics() {
  const prompt = routeService.ROUTE_SYSTEM_PROMPT;
  const quotedFollowup = prompt.indexOf('quoted正文作事实也followup');
  const continuation = prompt.indexOf('2 continuation=');
  assert.ok(quotedFollowup >= 0, 'quoted fact grounding must be explicitly classified as followup');
  assert.ok(continuation >= 0, 'the route contract must define continuation');
  assert.ok(quotedFollowup < continuation, 'quoted grounding must take precedence over continuation wording');
  assert.match(prompt, /quoted正文作事实也followup，压过继续语义/);
  assert.match(prompt, /2 continuation=无1且明确仍是同一任务\/主题\/设计维度的继续、重复、重试或下一项，且非quoted/);
}

function testContinuationRequiresSameTaskAndExplicitlyAllowsAThemeReset() {
  const prompt = routeService.ROUTE_SYSTEM_PROMPT;
  assert.match(prompt, /continuation=无1且明确仍是同一任务\/主题\/设计维度的继续、重复、重试或下一项/,
    'continuation must stay inside one task rather than following generic repeat wording');
  assert.match(prompt, /仅有“再\+生成动作”不足以继承旧任务/,
    'generic repeat-action wording alone cannot cause an unrelated task to inherit a previous design');
  assert.match(prompt, /明确换主题、不要原要求、完全从零开始，则是new/,
    'an explicit theme reset must cut the historical task relationship');
  assert.match(prompt, /P5历史名称\/主体\/特征相似不自动绑定[^。\n]*无明确依据不绑定/,
    'a history binding without stronger continuation evidence must default to followup');
}

function testHistoricalDependencyRemainsFollowupWhenBindingIsAmbiguous() {
  const prompt = routeService.ROUTE_SYSTEM_PROMPT;
  assert.match(prompt, /relation只表示执行依赖[^。\n]*非请求新旧/,
    'relation must describe execution dependency rather than whether the utterance looks like a new request');
  assert.match(prompt, /任一ref的source≠current[^。\n]*绝不new/,
    'relation must dereference each selected candidate key back to its published source');
  assert.match(prompt, /明确依赖quoted\/history\/previous_\*execution/,
    'an explicit historical dependency must be a followup');
  assert.match(prompt, /需非current资源但歧义\/缺失未绑/,
    'an unresolved historical resource requirement must also remain a followup');
  assert.match(prompt, /(?:绝不|不得)new/,
    'historical dependency must never be downgraded to new');
  assert.match(prompt, /4 new=仅?无历史依赖[^。\n]*refs空\/全current/,
    'new is permitted only when no selected resource comes from historical provenance');
}

function testComposableSameApiRequirementsRemainOneTaskShape() {
  const prompt = routeService.ROUTE_SYSTEM_PROMPT;
  assert.match(prompt, /同operation\+同资源集可一次回答.*single/,
    'parallel requirements that share one API and resource set must remain one dispatch');
  assert.match(prompt, /task_shape描述本轮需要几次独立执行，而不是资源数量/,
    'task shape must describe independent executions, not the number of resources');
  assert.match(prompt, /task_shape：multi=多个独立执行/,
    'multi must represent multiple independent executions across task types');
  assert.match(prompt, /对于可直接执行的图片生成\/编辑任务，multi=多个独立图片结果/,
    'only image generation and editing may turn multi into a directly executable image batch');
  assert.match(prompt, /非图片或跨operation的多个必做步骤.*需要拆分.*不会进入图片规划或授权图片批次/,
    'non-image or cross-operation multi requests must be marked for splitting, not image planning');
  assert.match(prompt, /多图看\/比\/OCR\/汇总→single/,
    'read-only multi-image aggregation must remain one dispatch');
  assert.doesNotMatch(prompt, /同轮多步骤即multi/,
    'the old blanket rule incorrectly split one composable request into multiple tasks');
}
function testResourceOnlyCorrectionInheritsThePriorExecutableGoal() {
  const prompt = routeService.ROUTE_SYSTEM_PROMPT;
  assert.match(prompt, /仅纠正\/改选资源[^。\n]*继承previous_execution\.input/,
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
  testQuotedFactsOverrideContinuationSemantics,
  testContinuationRequiresSameTaskAndExplicitlyAllowsAThemeReset,
  testHistoricalDependencyRemainsFollowupWhenBindingIsAmbiguous,
  testComposableSameApiRequirementsRemainOneTaskShape,
  testResourceOnlyCorrectionInheritsThePriorExecutableGoal,
  testQuotedTextTransformGoalStaysAnInstructionRatherThanAnAnswer,
];
