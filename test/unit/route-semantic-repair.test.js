'use strict';

const assert = require('assert');
const routeService = require('../../client/services/route-service');
const routeIntentWorkflow = require('../../client/app/route-intent-workflow');

function compiledRoute(overrides = {}) {
  return {
    operationType: 'text_to_image',
    relation: 'new',
    goalMode: 'replace',
    userGoal: '生成一只猫',
    readiness: 'ready',
    needClarification: false,
    resources: [],
    ...overrides,
  };
}

function testSemanticValidatorFlagsOnlyDeterministicContradictions() {
  assert.deepStrictEqual(routeService.routeIntentSemanticIssues(compiledRoute()), []);

  const nonCurrent = compiledRoute({
    relation: 'new',
    resources: [{ type: 'image', role: 'reference', source: 'history', resource_id: 'img-1' }],
  });
  assert.strictEqual(routeService.routeIntentSemanticIssues(nonCurrent)[0].code,
    'relation_new_with_noncurrent_resource');

  const quoted = compiledRoute({ relation: 'new' });
  const quotedIssues = routeService.routeIntentSemanticIssues(quoted, {
    context: { quoted_message: { role: 'user', content: '上一张图' } },
  });
  assert.strictEqual(quotedIssues[0].code, 'quoted_evidence_requires_followup');

  const quotedContinuation = compiledRoute({ relation: 'continuation' });
  assert.strictEqual(routeService.routeIntentSemanticIssues(quotedContinuation, {
    context: { quoted_message: { role: 'user', content: '上一张图' } },
  })[0].code, 'quoted_evidence_requires_followup',
    'quoted facts must override the continuation candidate too');

  const operationMismatch = compiledRoute({ operationType: 'text_to_image' });
  const mismatchIssues = routeService.routeIntentSemanticIssues(operationMismatch, {
    context: {},
    understandingShape: {
      taskShape: 'single',
      operation: 'image_qa',
      branch: 'route',
      actions: [{ index: 1, kind: 'image_read', target: '这张图', resolved_refs: [] }],
    },
  });
  assert.strictEqual(mismatchIssues[0].code, 'route_operation_mismatches_understanding',
    'the route operation must match the deterministic kind mapping');

  const amend = compiledRoute({ goalMode: 'amend', relation: 'followup', userGoal: '改成夜景' });
  const amendIssues = routeService.routeIntentSemanticIssues(amend, { context: {} });
  assert.strictEqual(amendIssues[0].code, 'amend_requires_previous_task_state');

  const clarifying = compiledRoute({ readiness: 'needs_clarification', needClarification: true });
  assert.deepStrictEqual(routeService.routeIntentSemanticIssues(clarifying), [],
    'business clarification must not be rewritten as a model repair');
}

function testRepairPayloadCarriesFieldSpecificReasons() {
  const payload = routeService.buildRouteRepairPayload({
    model: 'route-model',
    input: '画一只猫',
    attachments: [],
    context: {},
    rejectedOutput: JSON.stringify({ operation: 'text_to_image', relation: 'new', goal: '生成一只猫', goal_mode: 'replace', resource_refs: [], task_shape: 'single' }),
    reasons: [
      { code: 'relation_new_with_noncurrent_resource', field: 'relation', message: '存在历史资源时 relation 不得为 new。' },
      'route_intent_invalid',
    ],
  });
  const repairMessage = payload.input.find(message => String(message.content).includes('repair_request'));
  assert.ok(repairMessage, 'repair payload must append a repair request');
  const parsed = JSON.parse(repairMessage.content);
  assert.deepStrictEqual(parsed.repair_request.reasons, [
    { code: 'relation_new_with_noncurrent_resource', field: 'relation', message: '存在历史资源时 relation 不得为 new。' },
    'route_intent_invalid',
  ]);
}

async function testSemanticRepairRoundRewritesTheFlaggedField() {
  const previous = globalThis.ChatUIRouteService;
  globalThis.ChatUIRouteService = routeService;
  const calls = [];
  try {
    const workflow = routeIntentWorkflow.createRouteIntentWorkflow({
      state: { mode: 'chat', autoMode: true, sessions: [], messages: [] },
      getConfig: () => ({ baseUrl: 'https://gateway.example/v1', apiKey: 'route-secret', routeModel: 'route-model', chatModel: 'chat-model' }),
      getSessionRouteModel: () => 'route-model',
      getSessionChatModel: () => 'chat-model',
      requestJson: async (url, payload, apiKey, options = {}) => {
        const name = payload.text?.format?.name;
        calls.push({ name, purpose: options.requestPurpose, payload });
        if (name === 'chatui_route_intent_v3') {
          const routeCalls = calls.filter(item => item.name === 'chatui_route_intent_v3').length;
          if (routeCalls === 1) {
            return { output_text: JSON.stringify({
              operation: 'text_to_image', relation: 'new',
              goal: '生成一只橘白短毛猫', goal_mode: 'replace',
              resource_refs: [], task_shape: 'single',
            }) };
          }
          return { output_text: JSON.stringify({
            operation: 'text_to_image', relation: 'followup',
            goal: '生成一只橘白短毛猫', goal_mode: 'replace',
            resource_refs: [], task_shape: 'single',
          }) };
        }
        if (name === 'chatui_image_instruction_v1') {
          return { output_text: JSON.stringify({
            schema_version: 'image_instruction.v1',
            status: 'ready',
            instruction: '生成一只橘白短毛猫',
            clarification: '',
          }) };
        }
        throw new Error(`unexpected request ${name || '<missing>'}`);
      },
    });
    const route = await workflow.getEffectiveRoute('画一只猫', [], 'session-1', null, {
      quoted_message: { role: 'user', content: '上一张图', id: 'quoted-1' },
    });
    assert.strictEqual(route.outcome, 'ready');
    assert.strictEqual(route.readiness, 'ready');
    assert.strictEqual(route.relation, 'followup',
      'the flagged relation must be repaired from new to followup');
    const repairCall = calls.find(item => item.name === 'chatui_route_intent_v3'
      && Array.isArray(item.payload?.input) && item.payload.input.some(message => String(message.content).includes('repair_request')));
    assert.ok(repairCall, 'a targeted routing repair request must be sent');
    const repairPayload = repairCall.payload.input.find(message => String(message.content).includes('repair_request'));
    const parsed = JSON.parse(repairPayload.content);
    assert.deepStrictEqual(parsed.repair_request.reasons[0], {
      code: 'quoted_evidence_requires_followup',
      field: 'relation',
      message: '本轮存在 quoted 引用证据时，quoted 正文作事实属于 followup 且压过继续语义，relation 不得为 new/continuation。',
    });
  } finally {
    if (previous === undefined) delete globalThis.ChatUIRouteService;
    else globalThis.ChatUIRouteService = previous;
  }
}

module.exports = [
  testSemanticValidatorFlagsOnlyDeterministicContradictions,
  testRepairPayloadCarriesFieldSpecificReasons,
  testSemanticRepairRoundRewritesTheFlaggedField,
];
