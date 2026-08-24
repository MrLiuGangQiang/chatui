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
  assert.match(prompts.IMAGE_PLAN_SYSTEM_PROMPT, /image_plan\.v1/);
  assert.match(prompts.IMAGE_INSTRUCTION_SYSTEM_PROMPT, /image_instruction\.v1/);
}

function testRoutePromptModuleParameterizesImagePlanTaskLimitWithoutChangingRoutePrompt() {
  const custom = prompts.createRoutePromptSet({ imagePlanAbsoluteMaxTasks: 7 });
  assert.match(custom.IMAGE_PLAN_SYSTEM_PROMPT, /范围 1\.\.7/);
  assert.strictEqual(custom.ROUTE_SYSTEM_PROMPT, prompts.ROUTE_SYSTEM_PROMPT);
  assert.strictEqual(custom.IMAGE_INSTRUCTION_SYSTEM_PROMPT, prompts.IMAGE_INSTRUCTION_SYSTEM_PROMPT);
}

function testRouteServiceDoesNotReembedPromptOwnershipOrGrowABrowserGlobal() {
  const routeSource = fs.readFileSync(path.join(__dirname, '../../client/services/route-service.js'), 'utf8');
  const promptSource = fs.readFileSync(path.join(__dirname, '../../client/services/route-prompts.js'), 'utf8');
  assert.doesNotMatch(routeSource, /const ROUTE_SYSTEM_PROMPT\s*=\s*\[/);
  assert.doesNotMatch(routeSource, /【operation】/);
  assert.match(routeSource, /require\('\.\/route-prompts'\)/);
  assert.match(promptSource, /const ROUTE_SYSTEM_PROMPT\s*=\s*\[/);
  assert.doesNotMatch(promptSource, /root\.ChatUIRoutePrompts\s*=/,
    'the extracted module must use the registry rather than grow the browser global namespace');
}

module.exports = [
  testRoutePromptModuleOwnsPromptTextAndPreservesServiceCompatibility,
  testRoutePromptModuleParameterizesImagePlanTaskLimitWithoutChangingRoutePrompt,
  testRouteServiceDoesNotReembedPromptOwnershipOrGrowABrowserGlobal,
];