'use strict';

const assert = require('assert');
const routeIntentWorkflow = require('../../client/app/route-intent-workflow');

function replaceGlobal(key, value) {
  const previous = globalThis[key];
  if (value === undefined) delete globalThis[key];
  else globalThis[key] = value;
  return () => {
    if (previous === undefined) delete globalThis[key];
    else globalThis[key] = previous;
  };
}

function readyRoute() {
  return {
    mode: 'chat', api: 'chat', target: 'none', intent: 'plain_chat',
    needClarification: false, dispatchAuthorized: true, readiness: 'ready',
    operationType: 'plain_chat', operationApi: 'chat', operationMode: 'chat', relation: 'new',
    resources: [], executionResources: { version: 'execution_resources.v2', operation: 'plain_chat', api: 'chat', relation: 'new', images: [], files: [], messages: [] },
    dispatchContract: {},
  };
}

function clarificationRoute() {
  return {
    ...readyRoute(),
    api: 'clarify', intent: 'clarify', needClarification: true,
    dispatchAuthorized: false, readiness: 'needs_clarification',
    clarificationQuestion: '请选择目标图片。', clarificationSlots: [],
    executionResources: null, dispatchContract: null,
  };
}

function fakeRouteService() {
  return {
    buildRoutePayload: ({ model, input }) => ({
      model,
      reasoning: { effort: 'low', summary: 'auto' },
      text: {
        format: { type: 'json_schema', name: 'route_attempt_test', strict: true, schema: { type: 'object' } },
      },
      input: [{ role: 'user', content: String(input || '') }],
      stream: false,
    }),
    extractRouteText: response => String(response?.output_text || response?.text || ''),
    inspectModelRouteResult: text => ({
      route: text === 'valid' ? readyRoute() : text === 'clarify' ? clarificationRoute() : null,
    }),
  };
}

function makeWorkflow(requestJson) {
  return routeIntentWorkflow.createRouteIntentWorkflow({
    state: { mode: 'chat', autoMode: true, activeSessionId: 'session-attempts', sessions: [], messages: [] },
    getConfig: () => ({
      baseUrl: 'https://gateway.example/v1', apiKey: 'route-secret',
      routeModel: 'route-primary', chatModel: 'route-fallback',
    }),
    getSessionRouteModel: () => 'route-primary',
    getSessionChatModel: () => 'route-fallback',
    buildRouteAttachmentMetadata: () => [],
    requestJson,
  });
}

async function testCompatibilityNegotiationAvoidsCartesianRetriesAndCachesWorkingProfile() {
  const restore = replaceGlobal('ChatUIRouteService', fakeRouteService());
  const payloads = [];
  try {
    const workflow = makeWorkflow(async (_url, payload) => {
      payloads.push(payload);
      if (payload.reasoning) throw new Error('reasoning is not supported by this endpoint');
      if (payload.text?.format) throw new Error(`text.format ${payload.text.format.type} unsupported`);
      return { output_text: 'valid' };
    });
    const first = await workflow.getEffectiveRoute('hello', [], 'session-attempts');
    const second = await workflow.getEffectiveRoute('hello again', [], 'session-attempts');

    assert.strictEqual(payloads.length, 5,
      'one negotiation must use four non-duplicated variants, then the cached endpoint/model profile must make the next logical route request once');
    assert.deepStrictEqual(payloads.slice(0, 4).map(payload => [!!payload.reasoning, payload.text?.format?.type || 'plain']), [
      [true, 'json_schema'],
      [false, 'json_schema'],
      [false, 'json_object'],
      [false, 'plain'],
    ], 'a format fallback must never reintroduce a rejected reasoning parameter');
    assert.deepStrictEqual(payloads.slice(4).map(payload => [!!payload.reasoning, payload.text?.format?.type || 'plain']), [
      [false, 'plain'],
    ], 'later planning/routing stages for the same endpoint/model must reuse the learned compatible profile');
    assert.deepStrictEqual(first.modelAttemptLedger, {
      schema_version: 'route_model_attempt_ledger.v1',
      max_provider_attempts: 6,
      logical_rounds: 1,
      provider_attempts: 4,
      primary_attempts: 4,
      fallback_attempts: 0,
      planning_attempts: 0,
      compatibility_attempts: 3,
      reasoning_fallback_attempts: 3,
      format_fallback_attempts: 2,
    });
    assert.strictEqual(second.modelAttemptLedger.provider_attempts, 1,
      'a fresh task ledger still reports the single cached-profile provider attempt');
  } finally {
    restore();
  }
}

async function testResponsesGatewayTransportFallbackCountsBothNonStreamingAttempts() {
  const restore = replaceGlobal('ChatUIRouteService', fakeRouteService());
  const calls = [];
  try {
    const workflow = makeWorkflow(async (url, payload) => {
      calls.push({ url, payload });
      if (calls.length === 1) {
        const error = new Error('failed to do request: empty stream chunks');
        error.statusCode = 500;
        error.code = 'internal_error';
        throw error;
      }
      assert.match(url, /\/chat\/completions$/);
      assert.strictEqual(payload.stream, false);
      return { output_text: 'valid' };
    });
    const route = await workflow.getEffectiveRoute('hello', [], 'session-attempts');

    assert.strictEqual(calls.length, 2);
    assert.match(calls[0].url, /\/responses$/);
    assert.match(calls[1].url, /\/chat\/completions$/);
    assert.deepStrictEqual(route.modelAttemptLedger, {
      schema_version: 'route_model_attempt_ledger.v1',
      max_provider_attempts: 6,
      logical_rounds: 1,
      provider_attempts: 2,
      primary_attempts: 2,
      fallback_attempts: 0,
      planning_attempts: 0,
      compatibility_attempts: 1,
      reasoning_fallback_attempts: 0,
      format_fallback_attempts: 0,
    }, 'the transport fallback must be counted as two real provider attempts');
  } finally {
    restore();
  }
}

async function testProviderBudgetBlocksTheSeventhCompatibilityAttempt() {
  const restore = replaceGlobal('ChatUIRouteService', fakeRouteService());
  let calls = 0;
  try {
    const workflow = makeWorkflow(async (_url, payload) => {
      calls += 1;
      if (payload.reasoning) throw new Error('reasoning is not supported by this endpoint');
      return { output_text: 'valid' };
    });
    const route = await workflow.getEffectiveRoute('hello', [], 'session-attempts', null, null, {
      modelAttemptLedger: {
        schema_version: 'route_model_attempt_ledger.v1',
        max_provider_attempts: 6,
        logical_rounds: 2,
        provider_attempts: 5,
        primary_attempts: 3,
        fallback_attempts: 1,
        planning_attempts: 1,
        compatibility_attempts: 2,
        reasoning_fallback_attempts: 1,
        format_fallback_attempts: 1,
      },
    });

    assert.strictEqual(calls, 1, 'attempt seven must be rejected before another HTTP request is sent');
    assert.strictEqual(route.evidence, 'model_calls_exceeded');
    assert.strictEqual(route.modelAttemptLedger.provider_attempts, 6);
    assert.strictEqual(route.modelAttemptLedger.logical_rounds, 3);
  } finally {
    restore();
  }
}

async function testClarificationRerouteContinuesTheSameAttemptLedger() {
  const restore = replaceGlobal('ChatUIRouteService', fakeRouteService());
  const responses = ['clarify', 'valid'];
  try {
    const workflow = makeWorkflow(async () => ({ text: responses.shift() }));
    const first = await workflow.getEffectiveRoute('edit this', [], 'session-attempts');
    const second = await workflow.getEffectiveRoute('the second image', [], 'session-attempts', null, null, {
      modelAttemptLedger: first.modelAttemptLedger,
    });

    assert.strictEqual(first.modelAttemptLedger.provider_attempts, 1);
    assert.strictEqual(second.modelAttemptLedger.provider_attempts, 2,
      'a clarification answer must continue the task ledger instead of starting from zero');
    assert.strictEqual(second.modelAttemptLedger.logical_rounds, 2);
    assert.strictEqual(second.modelCalls, 2);
  } finally {
    restore();
  }
}

module.exports = [
  testCompatibilityNegotiationAvoidsCartesianRetriesAndCachesWorkingProfile,
  testResponsesGatewayTransportFallbackCountsBothNonStreamingAttempts,
  testProviderBudgetBlocksTheSeventhCompatibilityAttempt,
  testClarificationRerouteContinuesTheSameAttemptLedger,
];
