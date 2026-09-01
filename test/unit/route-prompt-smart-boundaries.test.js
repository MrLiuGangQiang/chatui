'use strict';

const assert = require('assert');
const routeService = require('../../client/services/route-service');


function testRoutePromptMakesModelSemanticsPrimaryAndClarificationSelective() {
  const prompt = routeService.UNDERSTAND_SYSTEM_PROMPT;
  assert.match(prompt, /证据优先/);
  assert.match(prompt, /不得猜测、修改或编造证据/);
  assert.match(prompt, /优先级/);
  assert.doesNotMatch(prompt, /Model-first:|repair evidence/);
}

function testRoutePromptDefinesMultiImageMergeAndStyleReferenceRoles() {
  const prompt = routeService.ROUTE_SYSTEM_PROMPT;
  assert.match(prompt, /合并\/融合\/组合成一张新图/);
  assert.match(prompt, /image_reference_gen/);
  assert.match(prompt, /所有输入图都用 reference/);
  assert.match(prompt, /只提供配色\/色调\/颜色时角色必须是 style_reference/);
  assert.match(prompt, /主体、结构、构图或内容参考才用 reference/);
  assert.match(prompt, /沿用参考图生成新版本（即使改色）用reference.*goal写画面主体\/类型\+本轮变化.*非edit target/);
  assert.match(prompt, /goal还须保留蒙版、target、reference等?角色语义/);
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
  assert.ok(prompt.includes('没有交付时'));
  assert.ok(prompt.includes('保留前序主体/任务类型'));
  assert.ok(prompt.includes('保留前序主体/任务类型和本轮约束'));
}

function testRoutePromptDoesNotInventHistoricalDependencyForSelfContainedInputs() {
  const prompt = routeService.ROUTE_SYSTEM_PROMPT;
  assert.match(prompt, /当前输入已自足且未明确指向历史资源时不绑历史资源/);
  assert.match(prompt, /plain_chat仅在不依赖当前附件时可refs=\[\]/);
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
