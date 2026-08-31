'use strict';
const fs = require('fs');
const path = require('path');
const assert = require('assert');
const prompts = require('../../client/services/route-prompts');
const routeService = require('../../client/services/route-service');

const UNDERSTAND_PROMPT = prompts.UNDERSTAND_SYSTEM_PROMPT_LINES.join('\n');
const ROUTE_NODE_PROMPT = prompts.ROUTE_NODE_SYSTEM_PROMPT_LINES.join('\n');

function testRoutePromptModuleOwnsPromptTextAndPreservesServiceCompatibility() {
  assert.strictEqual(routeService.ROUTE_SYSTEM_PROMPT, prompts.ROUTE_SYSTEM_PROMPT);
  assert.strictEqual(routeService.ROUTE_NODE_SYSTEM_PROMPT, prompts.ROUTE_NODE_SYSTEM_PROMPT);
  assert.strictEqual(routeService.IMAGE_PLAN_SYSTEM_PROMPT, prompts.IMAGE_PLAN_SYSTEM_PROMPT);
  assert.strictEqual(routeService.IMAGE_INSTRUCTION_SYSTEM_PROMPT, prompts.IMAGE_INSTRUCTION_SYSTEM_PROMPT);
  assert.match(ROUTE_NODE_PROMPT, /只分类/);
  assert.match(ROUTE_NODE_PROMPT, /【文件任务】[\s\S]*file_qa[\s\S]*attachment/,
    'intent recognition must classify current-file reads as file_qa with an attachment binding');
  assert.match(prompts.IMAGE_PLAN_SYSTEM_PROMPT, /image_plan\.v1/);
  assert.match(prompts.IMAGE_INSTRUCTION_SYSTEM_PROMPT, /image_instruction\.v1/);
}

function testRoutePromptModuleParameterizesImagePlanTaskLimitWithoutChangingNodePrompts() {
  const custom = prompts.createRoutePromptSet({ imagePlanAbsoluteMaxTasks: 7 });
  assert.match(custom.IMAGE_PLAN_SYSTEM_PROMPT, /范围 1\.\.7/);
  assert.strictEqual(custom.ROUTE_SYSTEM_PROMPT, prompts.ROUTE_SYSTEM_PROMPT);
  assert.strictEqual(custom.UNDERSTAND_SYSTEM_PROMPT_LINES.join('\n'), UNDERSTAND_PROMPT);
  assert.strictEqual(custom.IMAGE_INSTRUCTION_SYSTEM_PROMPT, prompts.IMAGE_INSTRUCTION_SYSTEM_PROMPT);
}

function testUnderstandNodeOwnsItsProtocolAndSplitsIndependentImageActions() {
  assert.match(UNDERSTAND_PROMPT, /intent_understanding\.v1/);
  assert.match(UNDERSTAND_PROMPT, /每个独立执行结果一条 action/);
  assert.match(UNDERSTAND_PROMPT, /只有独立输出才拆分/);
  assert.match(UNDERSTAND_PROMPT, /否定\/排除.*不是 action/);
  assert.match(UNDERSTAND_PROMPT, /第二张和最后一张是什么颜色/);
  assert.match(UNDERSTAND_PROMPT, /合并为一条 action/);
  assert.match(UNDERSTAND_PROMPT, /不得拆成多个独立 action/);
  assert.match(UNDERSTAND_PROMPT, /"index":1,"kind":"image_generate"/);
  assert.match(UNDERSTAND_PROMPT, /"index":2,"kind":"image_generate"/);
  assert.doesNotMatch(UNDERSTAND_PROMPT, /【判断顺序】/,
    'the understand node must not carry route decision-order instructions');
  assert.doesNotMatch(UNDERSTAND_PROMPT, /goal_mode/,
    'the understand node must not write route goal-mode decisions');
  assert.ok(UNDERSTAND_PROMPT.length <= 2500, `understand prompt must stay bounded, got ${UNDERSTAND_PROMPT.length}`);
}

function testRouteNodeOwnsItsProtocolAndKeepsRelationRulesGrouped() {
  assert.match(ROUTE_NODE_PROMPT, /route_intent\.v3/);
  assert.match(ROUTE_NODE_PROMPT, /operation、relation、goal、goal_mode、resource_refs、task_shape/);
  assert.strictEqual(prompts.RELATION_SYSTEM_PROMPT_LINES.length, 5,
    'the relation segment must contain the relation preamble and the four relation rules');
  const first = ROUTE_NODE_PROMPT.indexOf(prompts.RELATION_SYSTEM_PROMPT_LINES[0]);
  const last = ROUTE_NODE_PROMPT.indexOf(prompts.RELATION_SYSTEM_PROMPT_LINES[4]);
  assert.ok(first >= 0 && last > first, 'the relation rules must stay grouped inside the route node prompt');
  assert.strictEqual(prompts.RELATION_SYSTEM_PROMPT_LINES.every(line => ROUTE_NODE_PROMPT.includes(line)), true);
  assert.match(ROUTE_NODE_PROMPT, /【输出示例】\{"operation":"text_to_image"/);
  assert.ok(ROUTE_NODE_PROMPT.length <= 5800, `route node prompt must stay bounded, got ${ROUTE_NODE_PROMPT.length}`);
}

function testRuntimePayloadsUseNodePromptsInsteadOfTheLegacyMonolith() {
  const routePayload = routeService.buildRoutePayload({
    model: 'route-model', input: '画一只猫', attachments: [], context: {},
  });
  const routeSystem = routePayload.input.find(message => message.role === 'system');
  assert.strictEqual(routeSystem.content, routeService.ROUTE_NODE_SYSTEM_PROMPT,
    'the simple route path must use the node prompt rather than the pre-CoT monolith');
  assert.match(routeSystem.content, /意图路由节点/);
  assert.doesNotMatch(routeSystem.content, /Model-first:/);

  const understandPayload = routeService.buildUnderstandingPayload({
    model: 'route-model', input: '分别生成两只猫', attachments: [], context: {},
  });
  const understandSystem = understandPayload.input.find(message => message.role === 'system');
  assert.strictEqual(understandSystem.content, routeService.UNDERSTAND_SYSTEM_PROMPT);
  assert.match(understandSystem.content, /intent_understanding\.v1/);
  assert.doesNotMatch(understandSystem.content, /【operation】/,
    'the understand node must not reuse the old operation classification prompt');
}

function testRouteServiceDoesNotReembedPromptOwnershipOrGrowABrowserGlobal() {
  const routeSource = fs.readFileSync(path.join(__dirname, '../../client/services/route-service.js'), 'utf8');
  const promptSource = fs.readFileSync(path.join(__dirname, '../../client/services/route-prompts.js'), 'utf8');
  assert.doesNotMatch(routeSource, /const ROUTE_SYSTEM_PROMPT\s*=\s*\[/);
  assert.doesNotMatch(routeSource, /【operation】/);
  assert.match(routeSource, /require\('\.\/route-prompts'\)/);
  assert.match(promptSource, /const ROUTE_NODE_SYSTEM_PROMPT_LINES\s*=\s*Object\.freeze\(\[/);
  assert.match(promptSource, /const UNDERSTAND_SYSTEM_PROMPT_LINES\s*=\s*Object\.freeze\(\[/);
  assert.doesNotMatch(promptSource, /const ROUTE_PROMPT_LINES\s*=\s*\[/,
    'the legacy monolithic prompt assembly must be gone from the prompt module');
  assert.doesNotMatch(promptSource, /root\.ChatUIRoutePrompts\s*=/,
    'the extracted module must use the registry rather than grow the browser global namespace');
}


function testPromptsTeachMessageRefsAreNotFiles() {
  const compact = prompts.ROUTE_NODE_SYSTEM_PROMPT_COMPACT;
  const simple = prompts.ROUTE_NODE_SYSTEM_PROMPT_SIMPLE;
  assert.ok(UNDERSTAND_PROMPT.includes('消息（mN）是文字证据，不是文件/图片'),
    'the understand node must learn that quoted/history messages are text, not files');
  assert.match(UNDERSTAND_PROMPT, /统计字数.*plain_text/,
    'message character-count questions must be classified as plain_text');
  for (const [name, prompt] of [
    ['route full', ROUTE_NODE_PROMPT],
    ['route compact', compact],
    ['route simple', simple],
  ]) {
    assert.match(prompt, /消息（mN）只能绑 context/,
      name + ' route prompt must forbid binding a message as a file');
    assert.match(prompt, /file_qa[\s\S]*f=attachment/,
      name + ' route prompt must keep file_qa bound to a real fN file');
  }
}


function testMultiTaskPlanPromptKeepsExplicitImageRequests() {
  assert.match(prompts.MULTI_TASK_PLAN_SYSTEM_PROMPT, /不得为了[^。]*降级成 plain_chat/,
    'the multi-task planner must not degrade an explicit image request to plain_chat');
  assert.match(prompts.MULTI_TASK_PLAN_SYSTEM_PROMPT, /text_to_image\/image_reference_gen\/edit_image/,
    'the multi-task planner must route image requests to the image operations');
}

function testImageInstructionPromptRespectsExplicitDelegationAndAnsweredClarifications() {
  assert.match(prompts.IMAGE_INSTRUCTION_SYSTEM_PROMPT, /你随机|you choose|up to you/,
    'the materializer must know that an explicit user delegation authorizes choosing concrete details');
  assert.match(prompts.IMAGE_INSTRUCTION_SYSTEM_PROMPT, /answer_completes*=s*true/,
    'the materializer must treat an already-answered clarification as authority to proceed');
  assert.match(prompts.IMAGE_INSTRUCTION_SYSTEM_PROMPT, /needs_clarification/,
    'genuinely unresolved references must still ask for clarification');
}

function testRouteNodePromptsDefineGenerationContinuationNotAsEdit() {
  // Regression: "继续画一只狗" was misclassified as edit_image (with no target)
  // because "继续" + dog history looked like an edit request, forcing a
  // "which image to edit" candidate picker. Every route/understand prompt must
  // state that a generation-intent continuation with no edit verb and no
  // explicit target image is a new text_to_image / image_generate, never an
  // edit.
  assert.match(prompts.ROUTE_NODE_SYSTEM_PROMPT_SIMPLE, /把生成当成编辑/,
    'the simple route prompt must teach that a generation continuation is not an edit');
  assert.match(prompts.ROUTE_NODE_SYSTEM_PROMPT, /把生成当成编辑/,
    'the full route prompt must teach that a generation continuation is not an edit');
  assert.match(prompts.ROUTE_NODE_SYSTEM_PROMPT_COMPACT, /不得判成 edit_image/,
    'the CoT route prompt must keep generation continuations on text_to_image');
  assert.match(prompts.UNDERSTAND_SYSTEM_PROMPT_LINES.join('\n'), /非 image_edit/,
    'the understand prompt must classify generation continuations as image_generate, not image_edit');
}


function testUnderstandPromptUsesBoundedEvidenceLanguageInsteadOfCrypticEnglish() {
  const prompt = UNDERSTAND_PROMPT;
  assert.doesNotMatch(prompt, /Model-first:|repair evidence/,
    'cryptic english directives confuse small routing models');
  assert.match(prompt, /【证据优先】/);
  assert.match(prompt, /不得猜测、修改或编造证据/);
  assert.match(prompt, /有歧义保持歧义/);
}

function testUnderstandPromptExampleKeepsTheFullPictureDescription() {
  const prompt = UNDERSTAND_PROMPT;
  assert.match(prompt, /一只橘白短毛猫坐在木窗台上、午后阳光洒落、写实摄影风格/);
  assert.match(prompt, /一只金毛犬站在草地上、傍晚逆光、写实摄影风格/);
}

function testSimpleRoutePromptKeepsQualityRulesBeforeSizeOptimization() {
  // Quality and accuracy are the hard priority. The simple path must keep
  // every reachable decision rule; size can only be reduced by removing rules
  // the deterministic complexity gate proves unreachable.
  const simple = prompts.ROUTE_NODE_SYSTEM_PROMPT_SIMPLE;
  assert.ok(simple.length <= 4000, 'simple route prompt may not grow unbounded, got ' + simple.length);
  assert.match(simple, /把生成当成编辑/);
  assert.match(simple, /消息（mN）只能绑 context/);
  assert.match(simple, /file_qa[\s\S]*f=attachment/);
  assert.match(simple, /P1→P5/);
  assert.match(simple, /不得只写“基于这个生成/);
  assert.match(simple, /edit_image多history候选未选定→followup\+ambiguous省略target/,
    'vague edits must ask instead of guessing a target');
  assert.match(simple, /current_input已含主体\/动作则历史同义正文不绑/,
    'self-contained inputs must not over-bind historical message evidence');
  assert.match(simple, /message_index大者更新，模糊指代选最大/,
    'candidate recency rules must stay on the simple path');
  assert.match(simple, /“不使用旧图”不改operation\/goal_mode/,
    'negated resource policies must not rewrite operation/goal_mode');
  assert.match(simple, /拒绝使用历史资源只影响resource_refs/,
    'refusing historical resources must not silently change goal_mode');
  assert.match(simple, /auto_mode=false\/current_mode=image/,
    'manual image mode must keep the merge-vs-edit boundary');
}function testRouteRelationOrderReferencesTheNumberedRulesExplicitly() {
  const prompt = ROUTE_NODE_PROMPT;
  assert.match(prompt, /relation描述本轮主要言语行为与前序执行的关系[^\n]*必须按下方关系规则1→4顺序判断/);
  assert.doesNotMatch(prompt, /必须按1→4顺序判断/);
}

function testImagePlanPromptSeparatesPromptTextFromParameterFields() {
  const prompt = prompts.IMAGE_PLAN_SYSTEM_PROMPT;
  assert.match(prompt, /背景\/画布要求写入 background 字段/);
  assert.match(prompt, /只描述画面内容（主体、场景、风格、修改项）/);
  assert.match(prompt, /超过 [0-9]+ 个的请求会在上游被拦截/);
}

module.exports = [
  testMultiTaskPlanPromptKeepsExplicitImageRequests,
  testPromptsTeachMessageRefsAreNotFiles,
  testRoutePromptModuleOwnsPromptTextAndPreservesServiceCompatibility,
  testRoutePromptModuleParameterizesImagePlanTaskLimitWithoutChangingNodePrompts,
  testUnderstandNodeOwnsItsProtocolAndSplitsIndependentImageActions,
  testImageInstructionPromptRespectsExplicitDelegationAndAnsweredClarifications,
  testRouteNodePromptsDefineGenerationContinuationNotAsEdit,
  testUnderstandPromptUsesBoundedEvidenceLanguageInsteadOfCrypticEnglish,
  testUnderstandPromptExampleKeepsTheFullPictureDescription,
  testSimpleRoutePromptKeepsQualityRulesBeforeSizeOptimization,
  testRouteRelationOrderReferencesTheNumberedRulesExplicitly,
  testImagePlanPromptSeparatesPromptTextFromParameterFields,
  testRouteNodeOwnsItsProtocolAndKeepsRelationRulesGrouped,
  testRuntimePayloadsUseNodePromptsInsteadOfTheLegacyMonolith,
  testRouteServiceDoesNotReembedPromptOwnershipOrGrowABrowserGlobal,
];
