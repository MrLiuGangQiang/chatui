'use strict';

const assert = require('assert');
const fs = require('fs');
const path = require('path');
const prompts = require('../../client/services/route-prompts');
const routeService = require('../../client/services/route-service');

function testRoutePromptModuleOwnsPromptTextAndPreservesServiceCompatibility() {
  assert.strictEqual(routeService.ROUTE_SYSTEM_PROMPT, prompts.ROUTE_SYSTEM_PROMPT);
  assert.strictEqual(routeService.IMAGE_PLAN_SYSTEM_PROMPT, prompts.IMAGE_PLAN_SYSTEM_PROMPT);
  assert.strictEqual(routeService.IMAGE_INSTRUCTION_SYSTEM_PROMPT, prompts.IMAGE_INSTRUCTION_SYSTEM_PROMPT);
  assert.match(prompts.ROUTE_SYSTEM_PROMPT, /只分类/);
  assert.match(prompts.ROUTE_SYSTEM_PROMPT, /【文件任务】[\s\S]*file_qa[\s\S]*attachment/,
    'intent recognition must classify current-file reads as file_qa with an attachment binding');
  assert.match(prompts.IMAGE_PLAN_SYSTEM_PROMPT, /image_plan\.v1/);
  assert.match(prompts.IMAGE_INSTRUCTION_SYSTEM_PROMPT, /image_instruction\.v1/);
}

function testRoutePromptModuleParameterizesImagePlanTaskLimitWithoutChangingRoutePrompt() {
  const custom = prompts.createRoutePromptSet({ imagePlanAbsoluteMaxTasks: 7 });
  assert.match(custom.IMAGE_PLAN_SYSTEM_PROMPT, /范围 1\.\.7/);
  assert.strictEqual(custom.ROUTE_SYSTEM_PROMPT, prompts.ROUTE_SYSTEM_PROMPT);
  assert.strictEqual(custom.IMAGE_INSTRUCTION_SYSTEM_PROMPT, prompts.IMAGE_INSTRUCTION_SYSTEM_PROMPT);
}

function testUnderstandPromptForbidsSplittingMultiImageReadQuestions() {
  const understand = prompts.UNDERSTAND_SYSTEM_PROMPT_LINES.join('\n');
  assert.match(understand, /第二张和最后一张是什么颜色/);
  assert.match(understand, /合并为一个 action/);
  assert.match(understand, /不得拆成多个独立 action/);
}

function testRelationSegmentGroupsRelationRules() {
  assert.strictEqual(prompts.RELATION_SYSTEM_PROMPT_LINES.length, 5, 'the relation segment must contain the relation preamble and the four relation rules');
  const routeNodeText = prompts.ROUTE_NODE_SYSTEM_PROMPT_LINES.join('\n');
  const first = routeNodeText.indexOf(prompts.RELATION_SYSTEM_PROMPT_LINES[0]);
  const last = routeNodeText.indexOf(prompts.RELATION_SYSTEM_PROMPT_LINES[4]);
  assert.ok(first >= 0 && last > first, 'the relation rules must stay grouped inside the route node prompt');
  assert.strictEqual(prompts.RELATION_SYSTEM_PROMPT_LINES.every(line => routeNodeText.includes(line)), true);
}

function testNodePromptsStayBounded() {
  assert.ok(prompts.UNDERSTAND_SYSTEM_PROMPT_LINES.join('\n').length <= 1500,
    'the understand node prompt must stay short and focused');
  assert.ok(prompts.ROUTE_NODE_SYSTEM_PROMPT_LINES.join('\n').length <= 5600,
    'the route node prompt must stay within the bounded window');
}

function testRoutePromptSegmentsPartitionPromptLinesWithoutChangingText() {
  const parts = [...prompts.UNDERSTAND_SYSTEM_PROMPT_LINES, ...prompts.ROUTE_NODE_SYSTEM_PROMPT_LINES];
  assert.strictEqual(parts.length, prompts.ROUTE_PROMPT_LINES.length, 'the node segments must partition the prompt lines');
  assert.strictEqual(new Set(parts).size, prompts.ROUTE_PROMPT_LINES.length, 'the node segments must not duplicate or drop any line');
  assert.ok(prompts.ROUTE_PROMPT_LINES.every(line => parts.includes(line)));
  assert.strictEqual(prompts.ROUTE_SYSTEM_PROMPT, prompts.ROUTE_PROMPT_LINES.join('\n'), 'the joined route prompt must stay byte-for-byte identical');
}

function testRouteServiceDoesNotReembedPromptOwnershipOrGrowABrowserGlobal() {
  const routeSource = fs.readFileSync(path.join(__dirname, '../../client/services/route-service.js'), 'utf8');
  const promptSource = fs.readFileSync(path.join(__dirname, '../../client/services/route-prompts.js'), 'utf8');
  assert.doesNotMatch(routeSource, /const ROUTE_SYSTEM_PROMPT\s*=\s*\[/);
  assert.doesNotMatch(routeSource, /【operation】/);
  assert.match(routeSource, /require\('\.\/route-prompts'\)/);
  assert.match(promptSource, /const ROUTE_PROMPT_LINES\s*=\s*\[/);
  assert.match(promptSource, /const ROUTE_SYSTEM_PROMPT\s*=\s*ROUTE_PROMPT_LINES\.join/);
  assert.doesNotMatch(promptSource, /root\.ChatUIRoutePrompts\s*=/,
    'the extracted module must use the registry rather than grow the browser global namespace');
}

module.exports = [
  testRoutePromptModuleOwnsPromptTextAndPreservesServiceCompatibility,
  testRoutePromptModuleParameterizesImagePlanTaskLimitWithoutChangingRoutePrompt,
  testUnderstandPromptForbidsSplittingMultiImageReadQuestions,
  testRelationSegmentGroupsRelationRules,
  testNodePromptsStayBounded,
  testRoutePromptSegmentsPartitionPromptLinesWithoutChangingText,
  testRouteServiceDoesNotReembedPromptOwnershipOrGrowABrowserGlobal,
];