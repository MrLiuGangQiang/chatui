'use strict';

const assert = require('assert');
const fs = require('fs');
const path = require('path');
const routeService = require('../../client/services/route-service');
const routeIntentWorkflow = require('../../client/app/route-intent-workflow');

function testRouteDeadlineAllowsSlowContextComposition() {
  const workflowSource = fs.readFileSync(path.join(__dirname, '../../client/app/route-intent-workflow.js'), 'utf8');
  const policySource = fs.readFileSync(path.join(__dirname, '../../client/app/submit-workflow-policy.js'), 'utf8');
  assert.ok(policySource.includes('const INTENT_PIPELINE_DEADLINE_MS = 60000;'),
    'the canonical route pipeline budget must remain long enough for grounded prompt composition');
  assert.ok(workflowSource.includes('submitWorkflowPolicy.INTENT_PIPELINE_DEADLINE_MS'),
    'the route workflow must consume the shared pipeline deadline');
  assert.strictEqual((workflowSource.match(/\b60000\b/g) || []).length, 0,
    'the route workflow must not duplicate the canonical deadline literal');
  assert.ok(!workflowSource.includes("error.code = 'ROUTE_INTENT_CANCELLED'"),
    'the route workflow must not duplicate the canonical cancellation error factory');
}

function testWorkflowContainsNoLocalIntentFallback() {
  const workflowSource = fs.readFileSync(path.join(__dirname, '../../client/app/route-intent-workflow.js'), 'utf8');
  const routeSource = fs.readFileSync(path.join(__dirname, '../../client/services/route-service.js'), 'utf8');
  assert.ok(!workflowSource.includes('createDeterministicRoute'));
  assert.ok(!workflowSource.includes('localChatFallbackRoute'));
  assert.ok(!workflowSource.includes('defaultPlainChatRoute'));
  assert.ok(!routeSource.includes('function createDeterministicRoute'));
  assert.ok(!routeSource.includes('function createExplicitQuotedImageChatRoute'));
}

async function testUnconfiguredIntentModelFailsClosed() {
  const previousRouteService = globalThis.ChatUIRouteService;
  globalThis.ChatUIRouteService = routeService;
  try {
    const workflow = routeIntentWorkflow.createRouteIntentWorkflow({
      state: { mode: 'chat', autoMode: true },
      getConfig: () => ({ baseUrl: '', routeModel: '', chatModel: '' }),
      getSessionRouteModel: () => '',
      getSessionChatModel: () => '',
      buildRouteAttachmentMetadata: () => [],
    });

    const route = await workflow.getEffectiveRoute('把背景改成雪山', [], 'session-a', null, {
      image_candidates: [{
        index: 1,
        image_id: 'img_history_cat_1',
        resource_id: 'res:image:img_history_cat_1',
        reference_id: 'imgref_history_cat',
        source: 'history',
      }],
    });

    assert.strictEqual(route.readiness, 'needs_clarification');
    assert.strictEqual(route.dispatchAuthorized, false);
    assert.strictEqual(route.dispatchContract, null);
    assert.strictEqual(route.evidence, 'route_model_unconfigured');
    assert.deepStrictEqual(route.resources, []);
    assert.deepStrictEqual(route.clarificationSlots, []);
  } finally {
    if (previousRouteService === undefined) delete globalThis.ChatUIRouteService;
    else globalThis.ChatUIRouteService = previousRouteService;
  }
}

async function testUnconfiguredIntentModelAlsoBlocksPlainChat() {
  const previousRouteService = globalThis.ChatUIRouteService;
  globalThis.ChatUIRouteService = routeService;
  try {
    const workflow = routeIntentWorkflow.createRouteIntentWorkflow({
      state: { mode: 'chat', autoMode: true },
      getConfig: () => ({ baseUrl: '', routeModel: '', chatModel: '' }),
      getSessionRouteModel: () => '',
      getSessionChatModel: () => '',
      buildRouteAttachmentMetadata: () => [],
    });

    const route = await workflow.getEffectiveRoute('解释一下什么是向量数据库', [], 'session-plain');
    assert.strictEqual(route.operationType, 'plain_chat');
    assert.strictEqual(route.api, 'clarify');
    assert.strictEqual(route.readiness, 'needs_clarification');
    assert.strictEqual(route.dispatchAuthorized, false);
    assert.strictEqual(route.dispatchContract, null);
    assert.strictEqual(route.evidence, 'route_model_unconfigured');
    assert.deepStrictEqual(route.clarificationSlots, []);
  } finally {
    if (previousRouteService === undefined) delete globalThis.ChatUIRouteService;
    else globalThis.ChatUIRouteService = previousRouteService;
  }
}

async function testIntentTimeoutFailsClosedWithoutSelectingQuotedOrHistoricalMedia() {
  const previousRouteService = globalThis.ChatUIRouteService;
  globalThis.ChatUIRouteService = routeService;
  let requestAborted = false;
  try {
    const workflow = routeIntentWorkflow.createRouteIntentWorkflow({
      state: { mode: 'chat', autoMode: true },
      getConfig: () => ({
        baseUrl: 'https://gateway.example/v1', apiKey: 'route-secret', routeModel: 'route-model', chatModel: 'route-model',
      }),
      getSessionRouteModel: () => 'route-model',
      getSessionChatModel: () => 'route-model',
      buildRouteAttachmentMetadata: () => [],
      requestJson: (_url, _payload, _apiKey, options = {}) => new Promise((resolve, reject) => {
        const rejectAsAborted = () => {
          requestAborted = true;
          const error = new Error('aborted');
          error.name = 'AbortError';
          reject(error);
        };
        if (options.signal?.aborted) rejectAsAborted();
        else options.signal?.addEventListener?.('abort', rejectAsAborted, { once: true });
      }),
    });

    const route = await workflow.getEffectiveRoute('这个呢', [], 'session-a', null, {
      quoted_message: { index: 1, role: 'assistant', id: 'quoted-message' },
      image_candidates: [{
        index: 1,
        image_id: 'quoted-image',
        resource_id: 'res:image:quoted-image',
        reference_id: 'quoted-ref',
        source: 'quoted',
      }],
    }, { deadlineMs: 5 });

    assert.strictEqual(requestAborted, true);
    assert.strictEqual(route.readiness, 'needs_clarification');
    assert.strictEqual(route.dispatchAuthorized, false);
    assert.strictEqual(route.dispatchContract, null);
    assert.strictEqual(route.evidence, 'route_model_timeout');
    assert.deepStrictEqual(route.resources, []);
  } finally {
    if (previousRouteService === undefined) delete globalThis.ChatUIRouteService;
    else globalThis.ChatUIRouteService = previousRouteService;
  }
}

module.exports = [
  testRouteDeadlineAllowsSlowContextComposition,
  testWorkflowContainsNoLocalIntentFallback,
  testUnconfiguredIntentModelFailsClosed,
  testUnconfiguredIntentModelAlsoBlocksPlainChat,
  testIntentTimeoutFailsClosedWithoutSelectingQuotedOrHistoricalMedia,
];
