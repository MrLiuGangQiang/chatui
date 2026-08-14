'use strict';

const assert = require('assert');
const fs = require('fs');
const path = require('path');
const imageRouteContext = require('../../client/core/image-route-context');
const routeService = require('../../client/services/route-service');
const routeIntentWorkflow = require('../../client/app/route-intent-workflow');

function testRouteWorkflowOwnsNoSecondBudgetOrSummaryStrategy() {
  const source = fs.readFileSync(path.join(__dirname, '../../client/app/route-intent-workflow.js'), 'utf8');
  assert.doesNotMatch(source, /ROUTE_CONTEXT_MAX_CHARS|ROUTE_CONTEXT_TOKEN_BUDGET|semanticCompressRecentMessages|\[历史摘要\]/,
    'route workflow must delegate all context budgeting to the canonical core policy');
  assert.match(source, /applyRouteContextPolicy/,
    'route-context overrides must pass through the same canonical policy as normal context');
}

function testCanonicalPolicyEvictsOptionalHistoryWithoutChangingProtectedQuote() {
  const quotedContent = `受保护的引用原文 ${'引用'.repeat(180)}`;
  const context = {
    quoted_message: { index: 2, id: 'quoted-message', role: 'assistant', content: quotedContent },
    recent_messages: [
      ...Array.from({ length: 24 }, (_, index) => ({
        index: index + 1,
        id: `history-${index + 1}`,
        role: index % 2 === 0 ? 'user' : 'assistant',
        content: `历史 ${index + 1} ${'旧'.repeat(120)}`,
      })),
      { index: 25, id: 'quoted-message', role: 'assistant', content: quotedContent },
    ],
    image_candidates: [],
    file_candidates: [],
    recent_image_references: [],
    recent_uploaded_image_references: [],
  };

  const bounded = imageRouteContext.applyRouteContextPolicy(context, {
    maxChars: 2200,
    contextWindowTokens: 262144,
  });
  assert.strictEqual(bounded.quoted_message.content, quotedContent,
    'protected quoted content must remain byte-for-byte unchanged');
  assert.ok(bounded.recent_messages.some(message => message.id === 'quoted-message'),
    'the quoted message entry must survive optional-history eviction');
  assert.ok(bounded.recent_messages.length < context.recent_messages.length,
    'old optional history must be evicted when the shared budget is exceeded');
  assert.ok(!JSON.stringify(bounded).includes('[历史摘要]'),
    'route context must never invent a synthetic history summary');
}

function testCanonicalPolicyRejectsRequiredOverflowInsteadOfTruncatingIt() {
  const quotedContent = `不可截断 ${'保留'.repeat(1000)}`;
  assert.throws(
    () => imageRouteContext.applyRouteContextPolicy({
      quoted_message: { index: 1, id: 'quoted-message', role: 'user', content: quotedContent },
      recent_messages: [{ index: 1, id: 'quoted-message', role: 'user', content: quotedContent }],
      image_candidates: [],
      file_candidates: [],
    }, { maxChars: 800, contextWindowTokens: 262144 }),
    error => error?.code === 'ROUTE_CONTEXT_REQUIRED_CONTENT_TOO_LARGE',
    'required context overflow must be explicit rather than silently truncated or summarized',
  );
}

function testCurrentInputRemainsExactAfterHistoryPolicy() {
  const currentInput = `当前输入 ${'必须完整保留'.repeat(400)}`;
  const bounded = imageRouteContext.applyRouteContextPolicy({
    recent_messages: Array.from({ length: 30 }, (_, index) => ({
      index: index + 1,
      role: index % 2 === 0 ? 'user' : 'assistant',
      content: `历史消息 ${index + 1} ${'旧'.repeat(100)}`,
    })),
    image_candidates: [],
    file_candidates: [],
  }, { maxChars: 1200, contextWindowTokens: 262144 });
  const payload = JSON.parse(routeService.buildRoutePayload({
    model: 'route-model',
    input: currentInput,
    context: bounded,
  }).messages[1].content);
  assert.strictEqual(payload.current_input, currentInput,
    'the current input is a required top-level field and must bypass history eviction unchanged');
}


async function testRequiredContextOverflowBecomesTypedFailureBeforeProviderCall() {
  const previousRouteService = globalThis.ChatUIRouteService;
  let providerCalls = 0;
  globalThis.ChatUIRouteService = {
    buildRoutePayload: () => ({ model: 'route-model', messages: [] }),
    extractRouteText: () => '',
    inspectModelRouteResult: () => ({ route: null }),
  };
  const workflow = routeIntentWorkflow.createRouteIntentWorkflow({
    state: { mode: 'chat', autoMode: true, sessions: [], messages: [] },
    getConfig: () => ({
      baseUrl: 'https://gateway.example/v1',
      apiKey: 'route-secret',
      routeModel: 'route-model',
      chatModel: 'route-model',
      context: { windowTokens: 64 },
    }),
    getSessionRouteModel: () => 'route-model',
    getSessionChatModel: () => 'route-model',
    requestJson: async () => { providerCalls += 1; return {}; },
  });
  const routeContextOverride = {
    quoted_message: {
      index: 1,
      id: 'quoted-message',
      role: 'user',
      content: `必须完整保留 ${'引用'.repeat(4000)}`,
    },
    recent_messages: [],
    image_candidates: [],
    file_candidates: [],
  };

  try {
    const result = await workflow.getEffectiveRoute(
      '继续处理引用内容',
      [],
      'session-1',
      null,
      routeContextOverride,
    );
    assert.strictEqual(providerCalls, 0, 'required-context overflow must stop before any provider request');
    assert.strictEqual(result.outcome, 'configuration_error');
    assert.strictEqual(result.evidence, 'route_context_too_large');
    assert.strictEqual(result.needClarification, false);
    assert.strictEqual(result.api, 'route_error');
  } finally {
    if (previousRouteService === undefined) delete globalThis.ChatUIRouteService;
    else globalThis.ChatUIRouteService = previousRouteService;
  }
}

module.exports = [
  testRouteWorkflowOwnsNoSecondBudgetOrSummaryStrategy,
  testCanonicalPolicyEvictsOptionalHistoryWithoutChangingProtectedQuote,
  testCanonicalPolicyRejectsRequiredOverflowInsteadOfTruncatingIt,
  testCurrentInputRemainsExactAfterHistoryPolicy,
  testRequiredContextOverflowBecomesTypedFailureBeforeProviderCall,
];
