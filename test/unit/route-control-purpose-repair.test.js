'use strict';

const assert = require('assert');
const routeService = require('../../client/services/route-service');
const routeIntentWorkflow = require('../../client/app/route-intent-workflow');
const chatService = require('../../client/services/chat-service');

function understandingOutput(dependency = 'new') {
  return JSON.stringify({
    schema_version: 'intent_understanding.v1',
    ordering: 'independent',
    dependency,
    actions: [{ index: 1, kind: 'image_generate', verb: '生成', target: '一只猫', resolved_refs: [] }],
  });
}

function routeOutput(overrides = {}) {
  return JSON.stringify(Object.assign({
    operation: 'text_to_image', relation: 'new', goal: '生成一只猫',
    goal_mode: 'replace', resource_refs: [], task_shape: 'single',
  }, overrides));
}

function baseDeps(requestJson) {
  return {
    state: { mode: 'chat', autoMode: true, sessions: [], messages: [] },
    getConfig: () => ({ baseUrl: 'https://gateway.example/v1', apiKey: 'route-secret', routeModel: 'route-model', chatModel: 'chat-model' }),
    getSessionRouteModel: () => 'route-model',
    getSessionChatModel: () => 'chat-model',
    requestJson,
  };
}

async function testReconciledUnderstandingDependencyPreventsRouteRepairLoop() {
  const previous = globalThis.ChatUIRouteService;
  globalThis.ChatUIRouteService = routeService;
  const purposes = [];
  try {
    const workflow = routeIntentWorkflow.createRouteIntentWorkflow(baseDeps(async (url, payload, apiKey, options = {}) => {
      purposes.push(options.requestPurpose);
      const name = payload?.text?.format?.name;
      if (name === 'chatui_intent_understanding_v1') return { output_text: understandingOutput('new') };
      if (name === 'chatui_route_intent_v3') {
        // Simulate a route model that faithfully maps understanding.dependency.
        const userPayload = payload.input.find(message => message.role === 'user');
        const dependency = JSON.parse(userPayload.content).understanding.dependency;
        return { output_text: routeOutput({ relation: dependency }) };
      }
      if (name === 'chatui_image_instruction_v1') {
        return { output_text: JSON.stringify({ schema_version: 'image_instruction.v1', status: 'ready', instruction: '生成一只猫', clarification: '' }) };
      }
      throw new Error(`unexpected request ${name || '<missing>'}`);
    }));
    const route = await workflow.getEffectiveRoute(
      '画一只猫', [], 'session-1', null,
      { quoted_message: { role: 'user', content: '上一张图', id: 'quoted-1' } },
    );
    assert.strictEqual(route.outcome, 'ready');
    assert.strictEqual(route.relation, 'followup',
      'local quoted evidence must reconcile the contradictory new dependency before the route node');
    assert.deepStrictEqual(purposes, ['intent_understanding', 'intent_recognition', 'image_instruction_materialization'],
      'a reconciled dependency must converge in exactly one route call without repair or fallback');
  } finally {
    if (previous === undefined) delete globalThis.ChatUIRouteService;
    else globalThis.ChatUIRouteService = previous;
  }
}

async function testFallbackAndRepairCarryDistinctPurposesAndReasons() {
  const previous = globalThis.ChatUIRouteService;
  globalThis.ChatUIRouteService = routeService;
  const calls = [];
  let fallbackAttempts = 0;
  try {
    const workflow = routeIntentWorkflow.createRouteIntentWorkflow(baseDeps(async (url, payload, apiKey, options = {}) => {
      const name = payload?.text?.format?.name;
      if (name === 'chatui_intent_understanding_v1') return { output_text: understandingOutput('new') };
      if (name === 'chatui_route_intent_v3' || name === 'chatui_route_repair_v1') {
        if (payload.model === 'route-model') {
          const error = new Error('primary gateway reset');
          error.code = 'ECONNRESET';
          throw error;
        }
        calls.push({
          model: payload.model,
          purpose: options.requestPurpose,
          repairReasons: options.repairReasons,
        });
        fallbackAttempts += 1;
        return { output_text: routeOutput({ relation: fallbackAttempts === 1 ? 'new' : 'followup' }) };
      }
      if (name === 'chatui_image_instruction_v1') {
        return { output_text: JSON.stringify({ schema_version: 'image_instruction.v1', status: 'ready', instruction: '生成一只猫', clarification: '' }) };
      }
      throw new Error(`unexpected request ${name || '<missing>'}`);
    }));
    const route = await workflow.getEffectiveRoute(
      '画一只猫', [], 'session-1', null,
      { quoted_message: { role: 'user', content: '上一张图', id: 'quoted-1' } },

      { enableRouteFallback: true },    );
    assert.strictEqual(route.outcome, 'ready');
    assert.strictEqual(route.relation, 'followup');
    assert.strictEqual(calls[0].purpose, 'route_fallback', 'the fallback model gets its own request purpose');
    assert.strictEqual(calls[1].purpose, 'route_repair', 'the fallback repair round must be a repair purpose');
    assert.strictEqual(calls[1].repairReasons[0].code, 'quoted_evidence_requires_followup',
      'repair reason codes must travel with the request for access-log auditing');
  } finally {
    if (previous === undefined) delete globalThis.ChatUIRouteService;
    else globalThis.ChatUIRouteService = previous;
  }
}

async function testMultiTaskPlannerUsesPlanningPurposeNotIntentRecognition() {
  const previous = globalThis.ChatUIRouteService;
  globalThis.ChatUIRouteService = routeService;
  const purposes = [];
  try {
    const workflow = routeIntentWorkflow.createRouteIntentWorkflow(baseDeps(async (url, payload, apiKey, options = {}) => {
      purposes.push(options.requestPurpose);
      const name = payload?.text?.format?.name;
      if (name === 'chatui_intent_understanding_v1') {
        return { output_text: JSON.stringify({
          schema_version: 'intent_understanding.v1', ordering: 'independent', dependency: 'new',
          actions: [
            { index: 1, kind: 'file_read', verb: '总结', target: '这个文件', resolved_refs: [{ candidate_key: 'f1', text: '这个文件' }] },
            { index: 2, kind: 'image_generate', verb: '画', target: '一只狗', resolved_refs: [] },
          ],
        }) };
      }
      if (name === 'chatui_route_intent_v3') {
        return { output_text: JSON.stringify({
          operation: 'file_qa', relation: 'new', goal: '总结这个文件 同时 画一只狗',
          goal_mode: 'replace', task_shape: 'multi', resource_refs: [{ candidate_key: 'f1', role: 'attachment' }],
        }) };
      }
      if (name === 'chatui_multi_task_plan_v1') {
        return { output_text: JSON.stringify({ schema_version: 'multi_task_plan.v1', tasks: [
          { key: 't1', operation: 'file_qa', description: '总结这个文件', goal: '总结这个文件的内容', resource_refs: [{ candidate_key: 'f1', role: 'attachment' }] },
          { key: 't2', operation: 'text_to_image', description: '画一只狗', goal: '画一只狗', resource_refs: [] },
        ] }) };
      }
      throw new Error(`unexpected request ${name || '<missing>'}`);
    }));
    const route = await workflow.getEffectiveRoute('总结这个文件 同时 画一只狗', [{
      index: 1, source_index: 1, media_index: 1, id: 'file-current', file_id: 'file-current',
      name: 'plan.md', type: 'text/markdown', is_image: false, has_extracted_text: true,
    }], 'session-1');
    assert.strictEqual(route.needClarification, true);
    assert.deepStrictEqual(purposes, ['intent_understanding', 'intent_recognition', 'multi_task_planning'],
      'the multi-task planner must be audited separately from intent recognition');
  } finally {
    if (previous === undefined) delete globalThis.ChatUIRouteService;
    else globalThis.ChatUIRouteService = previous;
  }
}

async function testRequestJsonForwardsRepairReasonCodes() {
  let capturedBody = null;
  const parsed = await chatService.requestJson({
    fetchImpl: async (url, init) => {
      capturedBody = JSON.parse(init.body);
      return { ok: true, status: 200 };
    },
    url: 'https://gateway.example/v1/responses',
    baseUrl: 'https://gateway.example/v1',
    payload: { model: 'route-model' },
    toProxyUrl: () => '/api/responses',
    parseResponseJson: async () => ({ ok: true }),
    normalizeError: () => 'unexpected',
    repairReasons: [{ code: 'quoted_evidence_requires_followup', field: 'relation' }],
  });
  assert.deepStrictEqual(parsed, { ok: true });
  assert.deepStrictEqual(capturedBody.repairReasons,
    [{ code: 'quoted_evidence_requires_followup', field: 'relation' }],
    'the client must forward repair reason codes so the access audit can record them');
}

module.exports = [
  testReconciledUnderstandingDependencyPreventsRouteRepairLoop,
  testFallbackAndRepairCarryDistinctPurposesAndReasons,
  testMultiTaskPlannerUsesPlanningPurposeNotIntentRecognition,
  testRequestJsonForwardsRepairReasonCodes,
];
