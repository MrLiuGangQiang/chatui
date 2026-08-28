'use strict';

const assert = require('assert');
const routeService = require('../../client/services/route-service');


function testRoutePromptMakesModelSemanticsPrimaryAndClarificationSelective() {
  const prompt = routeService.UNDERSTAND_SYSTEM_PROMPT;
  assert.match(prompt, /Model-first:/);
  assert.match(prompt, /repair evidence/);
  assert.match(prompt, /优先级/);
}

function testRoutePromptDefinesMultiImageMergeAndStyleReferenceRoles() {
  const prompt = routeService.ROUTE_SYSTEM_PROMPT;
  assert.match(prompt, /合并\/融合\/组合成一张新图/);
  assert.match(prompt, /image_reference_gen/);
  assert.match(prompt, /所有输入图都用 reference/);
  assert.match(prompt, /只提供配色\/色调\/颜色时角色必须是 style_reference/);
  assert.match(prompt, /主体、结构、构图或内容参考才用 reference/);
  assert.match(prompt, /沿用参考图生成新版本（即使改色）用reference.*goal写description主体\/类型\+本轮变化.*非edit target/);
  assert.match(prompt, /goal还须保留蒙版、target、reference等执行角色语义/);
}

function testRoutePromptSeparatesHistoricalFollowupFromContinuationAmendment() {
  const prompt = routeService.ROUTE_SYSTEM_PROMPT;
  assert.match(prompt, /明确比较、评价或使用 history\/quoted\/context 资源，relation 不得为 new/);
  assert.match(prompt, /沿用共同文字要求追加独立结果，仍选 continuation/);
  assert.match(prompt, /沿用上一版完整文字要求.*relation=continuation、goal_mode=amend.*goal只写新增A\/B差异，不复述previous base/);
  assert.match(prompt, /独立新主题且未否定\/引用前序才new；“不要继续刚才的…改为…”按1为followup/);
  assert.match(prompt, /goal_mode=amend/);
}

function testRoutePromptPreservesVisualTaskContextAfterUndeliveredDesign() {
  const prompt = routeService.ROUTE_SYSTEM_PROMPT;
  assert.match(prompt, /没有 verified image result/);
  assert.match(prompt, /保留前序用户已明确的主体\/任务类型/);
  assert.match(prompt, /不得只输出孤立 delta/);
}

function testRoutePromptDoesNotInventHistoricalDependencyForSelfContainedInputs() {
  const prompt = routeService.ROUTE_SYSTEM_PROMPT;
  assert.match(prompt, /current_input已含主体\/动作则历史同义正文非必需、不绑mN/);
  assert.match(prompt, /plain_chat自足时refs=\[\]/);
  assert.match(prompt, /无历史证据且只缺current必需角色也new/);
  assert.match(prompt, /edit_image仅有多个history候选且未选定→followup\+ambiguous，省略target/);
}

function testRoutePromptDoesNotLetFixedImageModeForceEditForMerge() {
  const prompt = routeService.ROUTE_SYSTEM_PROMPT;
  assert.match(prompt, /auto_mode=false\/current_mode=image/);
  assert.match(prompt, /不得把“合并\/融合多张图生成一张新图”强行改成 edit_image/);
}

module.exports = [
  testRoutePromptMakesModelSemanticsPrimaryAndClarificationSelective,
  testRoutePromptDefinesMultiImageMergeAndStyleReferenceRoles,
  testRoutePromptSeparatesHistoricalFollowupFromContinuationAmendment,
  testRoutePromptPreservesVisualTaskContextAfterUndeliveredDesign,
  testRoutePromptDoesNotInventHistoricalDependencyForSelfContainedInputs,
  testRoutePromptDoesNotLetFixedImageModeForceEditForMerge,
];
