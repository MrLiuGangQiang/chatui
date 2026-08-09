'use strict';

const assert = require('assert');
const routeIntentWorkflow = require('../../client/app/route-intent-workflow');
const submitWorkflowPolicy = require('../../client/app/submit-workflow-policy');

function readyRoute() {
  return Object.freeze({
    mode: 'chat',
    api: 'chat',
    operationType: 'plain_chat',
    operationApi: 'chat',
    operationMode: 'chat',
    relation: 'new',
    readiness: 'ready',
    dispatchAuthorized: true,
    needClarification: false,
  });
}

function routeService(route = readyRoute()) {
  return {
    buildRoutePayload: ({ model, input }) => ({
      model,
      messages: [{ role: 'user', content: String(input || '') }],
      response_format: {
        type: 'json_schema',
        json_schema: { name: 'route_test', strict: true, schema: { type: 'object' } },
      },
    }),
    extractRouteText: response => String(response?.text || ''),
    inspectModelRouteResult: text => text === 'valid' ? { route } : { route: null },
  };
}

function makeWorkflow({
  requestJson,
  state = { mode: 'chat', autoMode: true, activeSessionId: 'session-a', sessions: [], messages: [] },
  primaryModel = 'route-primary',
  fallbackModel = 'route-fallback',
} = {}) {
  return routeIntentWorkflow.createRouteIntentWorkflow({
    state,
    getConfig: () => ({
      baseUrl: 'https://gateway.example/v1',
      apiKey: 'route-secret',
      routeModel: primaryModel,
      chatModel: fallbackModel,
    }),
    getSessionRouteModel: () => primaryModel,
    getSessionChatModel: () => fallbackModel,
    buildRouteAttachmentMetadata: () => [],
    requestJson,
  });
}

function replaceGlobal(key, value) {
  const previous = globalThis[key];
  if (value === undefined) delete globalThis[key];
  else globalThis[key] = value;
  return () => {
    if (previous === undefined) delete globalThis[key];
    else globalThis[key] = previous;
  };
}

function httpError(statusCode, code = '') {
  const error = new Error(`HTTP ${statusCode}`);
  error.statusCode = statusCode;
  error.status = statusCode;
  if (code) error.code = code;
  return error;
}

async function testExpiredDeadlineAbortsSignalAndObservesCreatedAttempt() {
  const deadline = submitWorkflowPolicy.createBoundedIntentRequest(null, Date.now() - 1);
  let signalAborted = false;
  let thenableObserved = false;
  deadline.signal?.addEventListener?.('abort', () => { signalAborted = true; }, { once: true });
  const alreadyCreatedAttempt = {
    then(_resolve, reject) {
      thenableObserved = true;
      reject(new Error('late provider rejection'));
    },
  };
  try {
    await assert.rejects(
      deadline.race(alreadyCreatedAttempt),
      error => error?.code === 'ROUTE_INTENT_TIMEOUT',
    );
    await new Promise(resolve => setImmediate(resolve));
    assert.strictEqual(signalAborted, true, 'synchronous expiry must abort the provider signal');
    assert.strictEqual(thenableObserved, true, 'an already-created attempt must be observed after timeout');
  } finally {
    deadline.dispose();
  }
}

async function testExpiredDeadlineFactoryDoesNotCreateAnotherAttempt() {
  const deadline = submitWorkflowPolicy.createBoundedIntentRequest(null, Date.now() - 1);
  let factoryCalls = 0;
  try {
    await assert.rejects(
      deadline.raceFactory(() => {
        factoryCalls += 1;
        return Promise.resolve('late');
      }),
      error => error?.code === 'ROUTE_INTENT_TIMEOUT',
    );
    assert.strictEqual(factoryCalls, 0, 'an expired deadline must not create a provider attempt');
  } finally {
    deadline.dispose();
  }
}
async function testExpiredAbsoluteRouteDeadlineBlocksTheRequest() {
  const restore = replaceGlobal('ChatUIRouteService', routeService());
  let calls = 0;
  try {
    const workflow = makeWorkflow({
      requestJson: async () => {
        calls += 1;
        return { text: 'valid' };
      },
    });
    const route = await workflow.getEffectiveRoute('hello', [], 'session-a', null, null, {
      deadlineAt: Date.now() - 1,
    });
    assert.strictEqual(calls, 0, 'an already-expired absolute deadline must block the upstream request');
    assert.strictEqual(route.evidence, 'route_model_timeout');
    assert.strictEqual(route.dispatchAuthorized, false);
  } finally {
    restore();
  }
}

async function testRouteDeadlineSettlesEvenWhenTheAdapterIgnoresAbort() {
  const restore = replaceGlobal('ChatUIRouteService', routeService());
  try {
    const workflow = makeWorkflow({
      requestJson: async () => {
        await new Promise(resolve => setTimeout(resolve, 90));
        return { text: 'valid' };
      },
    });
    const startedAt = Date.now();
    const route = await workflow.getEffectiveRoute('hello', [], 'session-a', null, null, {
      deadlineAt: Date.now() + 10,
    });
    const elapsedMs = Date.now() - startedAt;
    assert.ok(elapsedMs < 70, `the workflow must settle on its own deadline, got ${elapsedMs} ms`);
    assert.strictEqual(route.evidence, 'route_model_timeout');
    assert.strictEqual(route.dispatchAuthorized, false);
  } finally {
    restore();
  }
}


async function testStructuredOutputCompatibilityDoesNotRetryAfterDeadline() {
  const restore = replaceGlobal('ChatUIRouteService', routeService());
  let rejectFirstRequest;
  let calls = 0;
  try {
    const workflow = makeWorkflow({
      fallbackModel: 'route-primary',
      requestJson: async () => {
        calls += 1;
        if (calls === 1) {
          return new Promise((_resolve, reject) => { rejectFirstRequest = reject; });
        }
        return { text: 'valid' };
      },
    });
    const route = await workflow.getEffectiveRoute('hello', [], 'session-a', null, null, {
      deadlineAt: Date.now() + 5,
    });
    assert.strictEqual(route.evidence, 'route_model_timeout');
    assert.strictEqual(calls, 1);

    const lateError = new Error('response_format json_schema is unsupported');
    lateError.statusCode = 400;
    rejectFirstRequest(lateError);
    await new Promise(resolve => setImmediate(resolve));
    await new Promise(resolve => setImmediate(resolve));
    assert.strictEqual(calls, 1,
      'a late compatibility failure must not start another provider request after the absolute deadline');
  } finally {
    restore();
  }
}

async function testRouteDeadlineIncludesSynchronousResponseValidation() {
  const slowRouteService = routeService();
  slowRouteService.inspectModelRouteResult = () => {
    const stopAt = Date.now() + 25;
    while (Date.now() < stopAt) { /* deterministic CPU-bound validation delay */ }
    return { route: readyRoute() };
  };
  const restore = replaceGlobal('ChatUIRouteService', slowRouteService);
  try {
    const workflow = makeWorkflow({ requestJson: async () => ({ text: 'valid' }) });
    const route = await workflow.getEffectiveRoute('hello', [], 'session-a', null, null, {
      deadlineAt: Date.now() + 5,
    });
    assert.strictEqual(route.evidence, 'route_model_timeout');
    assert.strictEqual(route.dispatchAuthorized, false);
  } finally {
    restore();
  }
}

async function testPrimaryAndFallbackShareOneAbsoluteRouteBudget() {
  const restore = replaceGlobal('ChatUIRouteService', routeService());
  const calls = [];
  try {
    const workflow = makeWorkflow({
      requestJson: async (_url, payload) => {
        calls.push(payload.model);
        if (payload.model === 'route-primary') {
          await new Promise(resolve => setTimeout(resolve, 25));
          throw httpError(503, 'UPSTREAM_UNAVAILABLE');
        }
        await new Promise(resolve => setTimeout(resolve, 35));
        return { text: 'valid' };
      },
    });
    const startedAt = Date.now();
    const route = await workflow.getEffectiveRoute('hello', [], 'session-a', null, null, {
      deadlineAt: Date.now() + 40,
    });
    const elapsedMs = Date.now() - startedAt;
    assert.deepStrictEqual(calls, ['route-primary', 'route-fallback']);
    assert.ok(elapsedMs < 65, `fallback must not receive a fresh timeout budget, got ${elapsedMs} ms`);
    assert.strictEqual(route.evidence, 'route_model_timeout');
    assert.strictEqual(route.dispatchAuthorized, false);
  } finally {
    restore();
  }
}

async function testParentCancellationPropagatesInsteadOfBecomingTimeout() {
  const restore = replaceGlobal('ChatUIRouteService', routeService());
  const parent = new AbortController();
  try {
    const workflow = makeWorkflow({
      requestJson: async () => {
        await new Promise(resolve => setTimeout(resolve, 90));
        return { text: 'valid' };
      },
    });
    setTimeout(() => parent.abort(), 5);
    const startedAt = Date.now();
    await assert.rejects(
      workflow.getEffectiveRoute('hello', [], 'session-a', null, null, {
        signal: parent.signal,
        deadlineAt: Date.now() + 200,
      }),
      error => error?.name === 'AbortError' && error?.code === 'ROUTE_INTENT_CANCELLED',
    );
    assert.ok(Date.now() - startedAt < 70, 'parent cancellation must settle even if the request adapter ignores abort');
  } finally {
    restore();
  }
}

async function testCoreRouteContextFailureStopsBeforeModelInvocation() {
  const restoreRoute = replaceGlobal('ChatUIRouteService', routeService());
  const restoreCore = replaceGlobal('ChatUICore', {
    imageRouteContext: {
      buildRouteContext() { throw new Error('context store failed'); },
      trimRouteContextToSize: context => context,
    },
  });
  let calls = 0;
  try {
    const state = {
      mode: 'chat', autoMode: true, activeSessionId: 'session-a',
      sessions: [{ id: 'session-a', messages: [{ role: 'user', content: 'prior turn' }] }],
      messages: [{ role: 'user', content: 'prior turn' }],
    };
    const workflow = makeWorkflow({
      state,
      requestJson: async () => { calls += 1; return { text: 'valid' }; },
    });
    assert.throws(
      () => workflow.buildRouteContext('session-a'),
      error => error?.code === 'ROUTE_CONTEXT_BUILD_FAILED',
    );
    const route = await workflow.getEffectiveRoute('follow up', [], 'session-a');
    assert.strictEqual(calls, 0, 'a broken core context must fail closed before the route model is called');
    assert.strictEqual(route.evidence, 'route_context_unavailable');
    assert.strictEqual(route.dispatchAuthorized, false);
  } finally {
    restoreCore();
    restoreRoute();
  }
}

async function testRouteContextCompactionFailureStopsBeforeModelInvocation() {
  const restoreCore = replaceGlobal('ChatUICore', {
    imageRouteContext: {
      buildRouteContext: ({ messages }) => ({
        recent_messages: messages.map((message, index) => ({ index: index + 1, role: message.role, content: message.content })),
      }),
      trimRouteContextToSize() { throw new Error('core compaction failed'); },
    },
  });
  const restoreRoute = replaceGlobal('ChatUIRouteService', routeService());
  let calls = 0;
  try {
    const workflow = makeWorkflow({
      state: {
        mode: 'chat', autoMode: true, activeSessionId: 'session-a', sessions: [],
        messages: [{ role: 'user', content: 'preserve this context' }],
      },
      requestJson: async () => {
        calls += 1;
        return { text: 'valid' };
      },
    });
    const route = await workflow.getEffectiveRoute('follow up', [], 'session-a');
    assert.strictEqual(calls, 0, 'a failed core compaction must stop before the route model is called');
    assert.strictEqual(route.evidence, 'route_context_unavailable');
    assert.strictEqual(route.dispatchAuthorized, false);
  } finally {
    restoreRoute();
    restoreCore();
  }
}

function testOptionalImageMemoryFailurePreservesCoreRouteContext() {
  const restoreCore = replaceGlobal('ChatUICore', {
    imageRouteContext: {
      buildRouteContext: ({ messages }) => ({
        recent_messages: messages.map((message, index) => ({ index: index + 1, role: message.role, content: message.content })),
      }),
      trimRouteContextToSize: context => context,
      buildImageMemoryCards() { throw new Error('optional memory unavailable'); },
    },
  });
  try {
    const workflow = makeWorkflow({
      state: {
        mode: 'chat', autoMode: true, activeSessionId: 'session-a', sessions: [],
        messages: [{ role: 'user', content: 'keep this context', displayItemId: 'message-a' }],
      },
      requestJson: async () => ({ text: 'valid' }),
    });
    const context = workflow.buildRouteContext('session-a');
    assert.strictEqual(context.recent_messages.length, 1);
    assert.strictEqual(context.recent_messages[0].content, 'keep this context');
  } finally {
    restoreCore();
  }
}

async function testNonRetryableRouteErrorsFailFastWithSpecificEvidence() {
  const restore = replaceGlobal('ChatUIRouteService', routeService());
  const calls = [];
  try {
    const workflow = makeWorkflow({
      requestJson: async (_url, payload) => {
        calls.push(payload.model);
        throw httpError(401, 'INVALID_API_KEY');
      },
    });
    const route = await workflow.getEffectiveRoute('hello', [], 'session-a');
    assert.deepStrictEqual(calls, ['route-primary'], 'authentication failures must not invoke a second model');
    assert.strictEqual(route.evidence, 'route_model_auth_error');
    assert.strictEqual(route.dispatchAuthorized, false);
  } finally {
    restore();
  }
}


async function testRateLimitedPrimaryDoesNotInvokeFallbackModel() {
  const restore = replaceGlobal('ChatUIRouteService', routeService());
  const calls = [];
  try {
    const workflow = makeWorkflow({
      requestJson: async (_url, payload) => {
        calls.push(payload.model);
        const error = httpError(429, 'RATE_LIMITED');
        error.retryable = true;
        throw error;
      },
    });
    const route = await workflow.getEffectiveRoute('hello', [], 'session-a');
    assert.deepStrictEqual(calls, ['route-primary'], 'rate limiting must not multiply requests through the fallback model');
    assert.strictEqual(route.evidence, 'route_model_rate_limited');
  } finally {
    restore();
  }
}

async function testFallbackFailureKeepsItsRateLimitIdentity() {
  const restore = replaceGlobal('ChatUIRouteService', routeService());
  const calls = [];
  try {
    const workflow = makeWorkflow({
      requestJson: async (_url, payload) => {
        calls.push(payload.model);
        if (payload.model === 'route-primary') throw httpError(503, 'UPSTREAM_UNAVAILABLE');
        throw httpError(429, 'RATE_LIMITED');
      },
    });
    const route = await workflow.getEffectiveRoute('hello', [], 'session-a');
    assert.deepStrictEqual(calls, ['route-primary', 'route-fallback']);
    assert.strictEqual(route.evidence, 'route_model_rate_limited');
    assert.strictEqual(route.dispatchAuthorized, false);
  } finally {
    restore();
  }
}

module.exports = [
  testExpiredDeadlineAbortsSignalAndObservesCreatedAttempt,
  testExpiredDeadlineFactoryDoesNotCreateAnotherAttempt,
  testExpiredAbsoluteRouteDeadlineBlocksTheRequest,
  testRouteDeadlineSettlesEvenWhenTheAdapterIgnoresAbort,
  testStructuredOutputCompatibilityDoesNotRetryAfterDeadline,
  testRouteDeadlineIncludesSynchronousResponseValidation,
  testPrimaryAndFallbackShareOneAbsoluteRouteBudget,
  testParentCancellationPropagatesInsteadOfBecomingTimeout,
  testCoreRouteContextFailureStopsBeforeModelInvocation,
  testRouteContextCompactionFailureStopsBeforeModelInvocation,
  testOptionalImageMemoryFailurePreservesCoreRouteContext,
  testNonRetryableRouteErrorsFailFastWithSpecificEvidence,
  testRateLimitedPrimaryDoesNotInvokeFallbackModel,
  testFallbackFailureKeepsItsRateLimitIdentity,
];
