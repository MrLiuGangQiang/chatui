'use strict';

const assert = require('assert');
const prompts = require('../../client/services/route-prompts');
const routeService = require('../../client/services/route-service');
const routeIntentWorkflow = require('../../client/app/route-intent-workflow');

const COMPACT_PROMPT = prompts.ROUTE_NODE_SYSTEM_PROMPT_COMPACT_LINES.join('\n');
const FULL_PROMPT = prompts.ROUTE_NODE_SYSTEM_PROMPT_LINES.join('\n');

const UNDERSTANDING_OUTPUT = JSON.stringify({
  schema_version: 'intent_understanding.v1',
  dependency: 'followup',
  actions: [{
    index: 1,
    kind: 'plain_text',
    target: '解释上一张图',
    resolved_refs: [],
  }],
});

const ROUTE_OUTPUT = overrides => JSON.stringify(Object.assign({
  operation: 'plain_chat',
  relation: 'new',
  goal: '解释上一张图',
  goal_mode: 'replace',
  resource_refs: [],
  task_shape: 'single',
}, overrides));

function systemPromptOf(call) {
  const system = (call?.payload?.input || []).find(message => message && message.role === 'system');
  return system ? system.content : null;
}

function workflowHarness({ understanding = 'ok', routeOutputs = [] } = {}) {
  const calls = [];
  let routeIndex = 0;
  const workflow = routeIntentWorkflow.createRouteIntentWorkflow({
    state: { mode: 'chat', autoMode: true, sessions: [], messages: [] },
    getConfig: () => ({
      baseUrl: 'https://gateway.example/v1',
      apiKey: 'route-secret',
      routeModel: 'route-model',
      chatModel: 'chat-model',
    }),
    getSessionRouteModel: () => 'route-model',
    getSessionChatModel: () => 'chat-model',
    requestJson: async (url, payload, apiKey, options = {}) => {
      const name = payload?.text?.format?.name;
      calls.push({ name, payload, options });
      if (name === 'chatui_intent_understanding_v1') {
        if (understanding === 'fail') throw new Error('understanding unavailable');
        return { output_text: UNDERSTANDING_OUTPUT };
      }
      if (name === 'chatui_route_intent_v3') {
        const output = routeOutputs[routeIndex] || { relation: 'followup' };
        routeIndex += 1;
        return { output_text: ROUTE_OUTPUT(output) };
      }
      if (name === 'chatui_route_repair_v1') {
        return { output_text: ROUTE_OUTPUT({ relation: 'followup' }) };
      }
      throw new Error('unexpected request ' + String(name || '<missing>'));
    },
  });
  return { workflow, calls };
}

async function testCoTPathUsesCompactRouteNodePrompt() {
  const previous = globalThis.ChatUIRouteService;
  globalThis.ChatUIRouteService = routeService;
  try {
    const harness = workflowHarness({
      routeOutputs: [{ relation: 'new' }, { relation: 'followup' }],
    });
    const route = await harness.workflow.getEffectiveRoute(
      '这个效果怎么样', [], 'session-1', null,
      { quoted_message: { role: 'user', content: '上一张图', id: 'quoted-1' } },
    );
    assert.strictEqual(route.outcome, 'ready');
    const routeCalls = harness.calls.filter(call => call.name === 'chatui_route_intent_v3');
    assert.ok(routeCalls.length >= 1, 'the understand -> route path must run the route node');
    for (const call of routeCalls) {
      assert.strictEqual(systemPromptOf(call), routeService.ROUTE_NODE_SYSTEM_PROMPT_COMPACT,
        'the CoT path must send the compact route-node prompt, not the full standalone prompt');
    }
    const repairCall = harness.calls.find(call => call.name === 'chatui_route_repair_v1'
      && (call.payload?.input || []).some(message => String(message.content).includes('repair_request')));
    assert.ok(repairCall, 'the semantic repair round must run inside the CoT path');
    assert.strictEqual(systemPromptOf(repairCall), routeService.ROUTE_REPAIR_SYSTEM_PROMPT,
      'a semantic repair must use the constrained repair contract prompt');
  } finally {
    if (previous === undefined) delete globalThis.ChatUIRouteService;
    else globalThis.ChatUIRouteService = previous;
  }
}

async function testSimplePathKeepsFullRouteNodePrompt() {
  const previous = globalThis.ChatUIRouteService;
  globalThis.ChatUIRouteService = routeService;
  try {
    const harness = workflowHarness();
    const route = await harness.workflow.getEffectiveRoute('画一只猫', [], 'session-1');
    assert.strictEqual(route.outcome, 'ready');
    const routeCalls = harness.calls.filter(call => call.name === 'chatui_route_intent_v3');
    assert.strictEqual(harness.calls.filter(call => call.name === 'chatui_intent_understanding_v1').length, 0,
      'a plain standalone request must not run the understand node');
    assert.strictEqual(routeCalls.length, 1);
    assert.strictEqual(systemPromptOf(routeCalls[0]), routeService.ROUTE_NODE_SYSTEM_PROMPT_SIMPLE,
      'the simple path must use the lean standalone prompt instead of the full fallback prompt');
    assert.notStrictEqual(systemPromptOf(routeCalls[0]), routeService.ROUTE_NODE_SYSTEM_PROMPT);
  } finally {
    if (previous === undefined) delete globalThis.ChatUIRouteService;
    else globalThis.ChatUIRouteService = previous;
  }
}

async function testFailedUnderstandingFallsBackToFullRouteNodePrompt() {
  const previous = globalThis.ChatUIRouteService;
  globalThis.ChatUIRouteService = routeService;
  try {
    const harness = workflowHarness({ understanding: 'fail' });
    const route = await harness.workflow.getEffectiveRoute(
      '这个效果怎么样', [], 'session-1', null,
      { quoted_message: { role: 'user', content: '上一张图', id: 'quoted-1' } },
    );
    assert.strictEqual(route.outcome, 'ready');
    const routeCalls = harness.calls.filter(call => call.name === 'chatui_route_intent_v3');
    assert.strictEqual(routeCalls.length, 1, 'a failed understand node must run the route node once without evidence');
    assert.strictEqual(systemPromptOf(routeCalls[0]), routeService.ROUTE_NODE_SYSTEM_PROMPT,
      'the standalone fallback after a failed understand node must use the full prompt');
  } finally {
    if (previous === undefined) delete globalThis.ChatUIRouteService;
    else globalThis.ChatUIRouteService = previous;
  }
}

function testCompactPromptCarriesTheCoTMappingContract() {
  assert.strictEqual(routeService.ROUTE_NODE_SYSTEM_PROMPT_COMPACT, prompts.ROUTE_NODE_SYSTEM_PROMPT_COMPACT,
    'route-service must re-export the compact prompt without divergence');
  assert.ok(COMPACT_PROMPT.length <= 7400, `complex-path route prompt must stay bounded, got ${COMPACT_PROMPT.length}`);
  assert.match(COMPACT_PROMPT, /route_intent\.v3/);
  assert.match(COMPACT_PROMPT, /context\.understanding/);
  assert.match(COMPACT_PROMPT, /image_generate→text_to_image/,
    'the CoT prompt must map understanding action kinds onto operations');
  assert.match(COMPACT_PROMPT, /understanding\.dependency[^。；]*(候选|证据)/,
    'the complex-path prompt must treat understanding.dependency as evidence, not the final relation');
  assert.match(COMPACT_PROMPT, /quoted\s*正文作事实[^。；]*followup/,
    'the CoT prompt must re-check the relation rules instead of trusting dependency blindly');
  assert.match(COMPACT_PROMPT, /压过“继续”语义/);
  assert.match(COMPACT_PROMPT, /【goal_mode】/);
  assert.match(COMPACT_PROMPT, /【输出示例】\{"operation":"text_to_image"/);
  assert.match(COMPACT_PROMPT, /基于这个生成\/参考上述内容生成\/继续生成/,
    'the compact prompt must keep the standalone image-goal guardrail');
  assert.match(COMPACT_PROMPT, /不得把资源选择的对话控制语当\s*goal/);
  assert.match(COMPACT_PROMPT, /短视觉约束紧接图片设计/,
    'the compact prompt must keep the image-design delta guardrail');
  // Regression: a slimmed CoT prompt that omitted the standalone resource and
  // delivery families measurably misrouted complex turns (merge->edit,
  // style_reference->reference, undelivered visual constraints). The complex
  // path must carry the complete decision set, so these families are present.
  assert.match(COMPACT_PROMPT, /P1名称\/索引/,
    'the complex path must keep the candidate-selection rules');
  assert.match(COMPACT_PROMPT, /【图片交付事实】/,
    'the complex path must keep the delivery-evidence rule');
  assert.match(COMPACT_PROMPT, /quoted\s*正文作事实也\s*followup/,
    'the CoT prompt must preserve the current-input-first quoted relation boundary');
  assert.strictEqual(COMPACT_PROMPT, FULL_PROMPT,
  'the complex path must carry the complete rule set (COMPACT == FULL)');
}

async function testEmptyUnderstandingActionsDropToFullRoutePrompt() {
  const previous = globalThis.ChatUIRouteService;
  globalThis.ChatUIRouteService = routeService;
  try {
    const calls = [];
    const workflow = routeIntentWorkflow.createRouteIntentWorkflow({
      state: { mode: 'chat', autoMode: true, sessions: [], messages: [] },
      getConfig: () => ({ baseUrl: 'https://gateway.example/v1', apiKey: 'route-secret', routeModel: 'route-model', chatModel: 'chat-model' }),
      getSessionRouteModel: () => 'route-model',
      getSessionChatModel: () => 'chat-model',
      requestJson: async (url, payload, apiKey, options = {}) => {
        const name = payload?.text?.format?.name;
        calls.push({ name, payload });
        if (name === 'chatui_intent_understanding_v1') {
          return { output_text: JSON.stringify({ schema_version: 'intent_understanding.v1', dependency: 'followup', actions: [] }) };
        }
        if (name === 'chatui_route_intent_v3') return { output_text: ROUTE_OUTPUT({ relation: 'followup' }) };
        throw new Error('unexpected request ' + String(name || '<missing>'));
      },
    });
    const route = await workflow.getEffectiveRoute(
      '这个效果怎么样', [], 'session-1', null,
      { quoted_message: { role: 'user', content: '上一张图', id: 'quoted-1' } },
    );
    assert.strictEqual(route.outcome, 'ready');
    const routeCall = calls.find(call => call.name === 'chatui_route_intent_v3');
    assert.ok(routeCall, 'the route node must still run after an empty understanding output');
    assert.strictEqual(systemPromptOf(routeCall), routeService.ROUTE_NODE_SYSTEM_PROMPT,
      'valid-but-empty understanding actions are not usable evidence and must fall back to the full prompt');
  } finally {
    if (previous === undefined) delete globalThis.ChatUIRouteService;
    else globalThis.ChatUIRouteService = previous;
  }
}

async function testFallbackModelRunsTheSameSemanticRepairPath() {
  const previous = globalThis.ChatUIRouteService;
  globalThis.ChatUIRouteService = routeService;
  try {
    const calls = [];
    let fallbackRouteCalls = 0;
    const workflow = routeIntentWorkflow.createRouteIntentWorkflow({
      state: { mode: 'chat', autoMode: true, sessions: [], messages: [] },
      getConfig: () => ({ baseUrl: 'https://gateway.example/v1', apiKey: 'route-secret', routeModel: 'route-model', chatModel: 'chat-model' }),
      getSessionRouteModel: () => 'route-model',
      getSessionChatModel: () => 'chat-model',
      requestJson: async (url, payload, apiKey, options = {}) => {
        const name = payload?.text?.format?.name;
        calls.push({ name, model: payload?.model, payload });
        if (name === 'chatui_intent_understanding_v1') return { output_text: UNDERSTANDING_OUTPUT };
        if (name === 'chatui_route_intent_v3' || name === 'chatui_route_repair_v1') {
          if (payload.model === 'route-model') {
            const error = new Error('primary gateway reset');
            error.code = 'ECONNRESET';
            throw error;
          }
          fallbackRouteCalls += 1;
          return { output_text: ROUTE_OUTPUT({ relation: fallbackRouteCalls === 1 ? 'new' : 'followup' }) };
        }
        throw new Error('unexpected request ' + String(name || '<missing>'));
      },
    });
    const route = await workflow.getEffectiveRoute(
      '这个效果怎么样', [], 'session-1', null,
      { quoted_message: { role: 'user', content: '锟斤拷一锟斤拷图', id: 'quoted-1' } },
      { enableRouteFallback: true },
    );
    assert.strictEqual(route.outcome, 'ready');
    assert.strictEqual(route.relation, 'followup',
      'the fallback model must be repaired from a contradictory relation instead of being trusted blindly');
    const repairCall = calls.find(call => call.name === 'chatui_route_repair_v1'
      && call.model === 'chat-model'
      && (call.payload?.input || []).some(message => String(message.content).includes('repair_request')));
    assert.ok(repairCall, 'the fallback model must go through the same semantic repair round as the primary model');
    const repairMessage = repairCall.payload.input.find(message => String(message.content).includes('repair_request'));
    assert.strictEqual(JSON.parse(repairMessage.content).repair_request.reasons[0].code,
      'quoted_evidence_requires_followup');
  } finally {
    if (previous === undefined) delete globalThis.ChatUIRouteService;
    else globalThis.ChatUIRouteService = previous;
  }
}

module.exports = [
  testCoTPathUsesCompactRouteNodePrompt,
  testSimplePathKeepsFullRouteNodePrompt,
  testFailedUnderstandingFallsBackToFullRouteNodePrompt,
  testEmptyUnderstandingActionsDropToFullRoutePrompt,
  testFallbackModelRunsTheSameSemanticRepairPath,
  testCompactPromptCarriesTheCoTMappingContract,
];
