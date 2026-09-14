'use strict';

// Regression: the default intent path must remain latency-bounded. Simple
// requests send an explicit reasoning effort "none", while the adaptive high-risk
// path may opt into a bounded reasoning summary. The directive is translated to
// reasoning_effort on the Chat Completions compatibility path and remains
// strippable by the reasoning fallback for gateways that reject it.

const assert = require('assert');
const fs = require('fs');
const path = require('path');
const routeService = require('../../client/services/route-service');
const chatService = require('../../client/services/chat-service');
const compatibility = require('../../client/services/request-compatibility');
const taskContinuity = require('../../shared/task-continuity');

function readyImageRoute() {
  const context = {
    recent_messages: [{ index: 1, id: 'm1', resource_id: 'res:message:m1', role: 'assistant', content: '方案A' }],
    previous_execution: {
      operation: 'text_to_image',
      family: 'generate',
      task_state: taskContinuity.createReplacementTaskContinuity('旧版户型图'),
    },
  };
  const result = routeService.inspectModelRouteResult(JSON.stringify({
    operation: 'text_to_image',
    relation: 'followup',
    goal: '把户型图外墙拉直',
    goal_mode: 'replace',
    resource_refs: [],
    task_shape: 'single',
  }), { input: '把户型图外墙拉直', attachments: [], context });
  assert.strictEqual(result.reason, '');
  assert.ok(result.route, 'fixture route must compile');
  assert.strictEqual(routeService.requiresImageInstructionMaterialization(result.route), true);
  return result.route;
}

function testProductionIntentPipelineKeepsCriticAndReasoningDisabledByDefault() {
  const root = path.join(__dirname, '../..');
  const submitWorkflow = fs.readFileSync(path.join(root, 'client/app/submit-workflow.js'), 'utf8');
  const app = fs.readFileSync(path.join(root, 'app.js'), 'utf8');
  assert.match(submitWorkflow, /enableIntentCritic:!1/);
  assert.match(submitWorkflow, /enforceDeterministicPolicies:!1/);
  assert.match(app, /enableIntentCritic:!1/);
  assert.match(app, /enforceDeterministicPolicies:!1/);
  assert.doesNotMatch(submitWorkflow, /enableIntentReasoning:!0/);
  assert.doesNotMatch(app, /enableIntentReasoning:!0/);
}

function testRouteIntentPayloadDisablesReasoning() {
  const payload = routeService.buildRoutePayload({ model: 'route-model', input: '把户型图外墙拉直' });
  assert.deepStrictEqual(payload.reasoning, { effort: 'none' }, 'route intent must explicitly disable thinking');
  assert.strictEqual(payload.stream, false);
  assert.strictEqual(Object.hasOwn(payload, 'tool_choice'), false, 'with no tools, tool_choice must be omitted (strict gateways reject tool_choice without tools)');
}

function testImageInstructionPayloadDisablesReasoning() {
  const payload = routeService.buildImageInstructionPayload({
    model: 'route-model',
    input: '把户型图外墙拉直',
    route: readyImageRoute(),
    context: {},
  });
  assert.deepStrictEqual(payload.reasoning, { effort: 'none' }, 'instruction materialization must explicitly disable thinking');
  assert.strictEqual(payload.stream, false);
}

function testImagePlanPayloadDisablesReasoning() {
  const payload = routeService.buildImagePlanPayload({
    model: 'route-model',
    input: '把户型图外墙拉直',
    goal: '把户型图外墙拉直',
  });
  assert.deepStrictEqual(payload.reasoning, { effort: 'none' }, 'image planning must explicitly disable thinking');
  assert.strictEqual(payload.stream, false);
}

function testUserFacingReasoningDisabledPayloadsExplicitlyDisableThinking() {
  const messages = [{ role: 'user', content: 'hello' }];
  const disabled = chatService.buildResponsesPayload('m', messages, { noReasoning: true, stream: false });
  assert.deepStrictEqual(disabled.reasoning, { effort: 'none' }, 'noReasoning must emit the none directive without a summary field');

  // An explicit user-facing off selection must beat any stale effort value so
  // providers cannot fall back to their default thinking behavior.
  const gated = chatService.buildResponsesPayload('m', messages, { reasoningEnabled: false, reasoningEffort: 'high', stream: false });
  assert.deepStrictEqual(gated.reasoning, { effort: 'none' }, 'user-facing off must explicitly disable thinking');
  const overridden = chatService.buildResponsesPayload('m', messages, { reasoningEnabled: false, reasoning: { effort: 'high' }, stream: false });
  assert.deepStrictEqual(overridden.reasoning, { effort: 'none' }, 'explicit off must override stale reasoning options');

  const glm = chatService.buildResponsesPayload('glm-flash', messages, { reasoningEnabled: false, stream: true });
  assert.deepStrictEqual(glm.thinking, { type: 'disabled' }, 'GLM-family models must receive their explicit thinking-off field');
  const deepseek = chatService.buildResponsesPayload('deepseek-flash', messages, { reasoningEnabled: false, stream: true });
  assert.deepStrictEqual(deepseek.thinking, { type: 'disabled' }, 'DeepSeek-family models must receive their explicit thinking-off field');
  const kimi = chatService.buildResponsesPayload('kimi-k2', messages, { reasoningEnabled: false, stream: true });
  assert.deepStrictEqual(kimi.thinking, { type: 'disabled' }, 'Kimi-family models must receive their explicit thinking-off field');
  const qwen = chatService.buildResponsesPayload('qwen3-max', messages, { reasoningEnabled: false, stream: true });
  assert.strictEqual(qwen.enable_thinking, false, 'Qwen-family models must receive enable_thinking=false');
  assert.strictEqual(Object.hasOwn(qwen, 'thinking'), false, 'Qwen must not receive the GLM/Kimi thinking object');

  const enabled = chatService.buildResponsesPayload('m', messages, { reasoningEnabled: true, stream: true });
  assert.deepStrictEqual(enabled.reasoning, { effort: 'medium', summary: 'auto' }, 'chat reasoning default must stay unchanged');
}

function testNoThinkDirectiveSurvivesChatCompletionsFallback() {
  const converted = compatibility.chatCompletionsPayloadFromResponsesPayload({
    model: 'route-model',
    stream: false,
    reasoning: { effort: 'none' },
    input: [{ role: 'user', content: '{"output_format":"json"}' }],
  });
  assert.strictEqual(converted.reasoning_effort, 'none', 'the no-think directive must survive the Chat Completions fallback');
  assert.strictEqual(Object.hasOwn(converted, 'reasoning'), false, 'the Responses reasoning object must not leak');
}

async function testNoThinkDirectiveIsStrippedWhenGatewayRejectsIt() {
  const attempts = [];
  const payload = routeService.buildRoutePayload({ model: 'route-model', input: '把户型图外墙拉直' });
  const response = await compatibility.requestJsonWithReasoningParamFallback(async body => {
    attempts.push(body);
    if (attempts.length === 1) {
      const error = new Error('invalid parameter: reasoning.effort is not supported');
      error.statusCode = 400;
      throw error;
    }
    return { output_text: '{}' };
  }, payload);
  assert.deepStrictEqual(response, { output_text: '{}' });
  assert.strictEqual(attempts.length, 2, 'a capability rejection must retry exactly once');
  assert.deepStrictEqual(attempts[0].reasoning, { effort: 'none' });
  assert.strictEqual(Object.hasOwn(attempts[1], 'reasoning'), false, 'the retry must strip the rejected reasoning directive');
}

function testHighRiskRouteIntentPayloadEnablesBoundedReasoning() {
  const payload = routeService.buildRoutePayload({
    model: 'route-model',
    input: '请比较第二张和上一张图片，并保留第三段要求，不要使用旧图',
    intentReasoning: { enabled: true, effort: 'high' },
  });
  assert.deepStrictEqual(payload.reasoning, { effort: 'high', summary: 'auto' });
}

module.exports = [
  testProductionIntentPipelineKeepsCriticAndReasoningDisabledByDefault,
  testRouteIntentPayloadDisablesReasoning,
  testImageInstructionPayloadDisablesReasoning,
  testImagePlanPayloadDisablesReasoning,
  testUserFacingReasoningDisabledPayloadsExplicitlyDisableThinking,
  testNoThinkDirectiveSurvivesChatCompletionsFallback,
  testNoThinkDirectiveIsStrippedWhenGatewayRejectsIt,
  testHighRiskRouteIntentPayloadEnablesBoundedReasoning,
];