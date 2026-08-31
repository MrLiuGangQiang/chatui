'use strict';

// Regression: the default intent path must remain latency-bounded. Simple
// requests send an explicit reasoning effort "none", while the adaptive high-risk
// path may opt into a bounded reasoning summary. The directive is translated to
// reasoning_effort on the Chat Completions compatibility path and remains
// strippable by the reasoning fallback for gateways that reject it.

const assert = require('assert');
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

function testNoReasoningDoesNotAlterChatReasoningGate() {
  const messages = [{ role: 'user', content: 'hello' }];
  const disabled = chatService.buildResponsesPayload('m', messages, { noReasoning: true, stream: false });
  assert.deepStrictEqual(disabled.reasoning, { effort: 'none' }, 'noReasoning must emit the none directive without a summary field');

  // The user-facing chat gate keeps its existing meaning: no reasoning field
  // unless reasoningEnabled, even when an effort value is present.
  const gated = chatService.buildResponsesPayload('m', messages, { reasoningEnabled: false, reasoningEffort: 'high', stream: false });
  assert.strictEqual(Object.hasOwn(gated, 'reasoning'), false, 'chat reasoning gate must stay unchanged');

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
  testRouteIntentPayloadDisablesReasoning,
  testImageInstructionPayloadDisablesReasoning,
  testImagePlanPayloadDisablesReasoning,
  testNoReasoningDoesNotAlterChatReasoningGate,
  testNoThinkDirectiveSurvivesChatCompletionsFallback,
  testNoThinkDirectiveIsStrippedWhenGatewayRejectsIt,
  testHighRiskRouteIntentPayloadEnablesBoundedReasoning,
];