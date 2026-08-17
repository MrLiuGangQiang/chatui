'use strict';

const assert = require('assert');
const routeIntentWorkflow = require('../../client/app/route-intent-workflow');

function makeRouteService() {
  const route = {
    mode: 'chat',
    api: 'chat',
    operationType: 'plain_chat',
    operationApi: 'chat',
    operationMode: 'chat',
    relation: 'new',
    readiness: 'ready',
    dispatchAuthorized: true,
    needClarification: false,
  };
  return {
    route,
    service: {
      buildRoutePayload: ({ model, input }) => ({
        model,
        temperature: 0,
        text: {
          format: { type: 'json_schema', name: 'test', strict: true, schema: { type: 'object' } },
        },
        input: [{ role: 'user', content: String(input || '') }],
        stream: false,
      }),
      extractRouteText: response => response?.text || '',
      inspectModelRouteResult: () => ({ route }),
    },
  };
}


async function testAmbiguousRouteUsesDeterministicClarificationWithoutSecondModelCall() {
  const previousRouteService = globalThis.ChatUIRouteService;
  const clarificationRoute = {
    mode: 'chat', api: 'clarify', target: 'none', intent: 'clarify',
    operationType: 'image_reference_gen', operationApi: 'chat', operationMode: 'chat',
    relation: 'followup', readiness: 'needs_clarification', dispatchAuthorized: false,
    needClarification: true, localClarification: true,
    clarificationQuestion: '你想继续处理哪一个？请选择本轮要处理的对象（文字回复或图片），也可以直接补充说明。',
    clarificationSlots: [{
      key: 'p1', type: 'parameter', role: 'argument', reason: 'ambiguous',
      choices: [
        { key: 'v1', label: '上一段 Markdown 输出', value: 'text' },
        { key: 'v2', label: '上一张图片', value: 'image' },
      ],
    }],
    resources: [], executionResources: null, dispatchContract: null,
  };
  globalThis.ChatUIRouteService = {
    buildRoutePayload: ({ model, input }) => ({
      model, temperature: 0,
      text: { format: { type: 'json_schema', name: 'test', schema: { type: 'object' } } },
      input: [{ role: 'user', content: String(input || '') }],
    }),
    extractRouteText: response => response?.text || '',
    inspectModelRouteResult: () => ({ route: clarificationRoute }),
  };
  const calls = [];
  const workflow = routeIntentWorkflow.createRouteIntentWorkflow({
    state: { mode: 'chat', autoMode: true, sessions: [], messages: [] },
    getConfig: () => ({
      baseUrl: 'https://gateway.example/v1', apiKey: 'route-secret', routeModel: 'route-model', chatModel: 'route-model',
    }),
    getSessionRouteModel: () => 'route-model',
    getSessionChatModel: () => 'route-model',
    requestJson: async (url, payload, apiKey, options) => {
      calls.push({ url, payload, apiKey, options });
      return { text: '{"operation":"plain_chat"}' };
    },
  });
  try {
    const route = await workflow.getEffectiveRoute('这个呢', [], 'session-1');
    assert.strictEqual(calls.length, 1, 'clarification must reuse the deterministic local question without a second model request');
    assert.strictEqual(route.clarificationQuestion, clarificationRoute.clarificationQuestion);
    assert.deepStrictEqual(route.clarificationSlots, clarificationRoute.clarificationSlots);
  } finally {
    if (previousRouteService === undefined) delete globalThis.ChatUIRouteService;
    else globalThis.ChatUIRouteService = previousRouteService;
  }
}

async function testIntentRecognitionUsesTheResponsesProxyPath() {
  const previousRouteService = globalThis.ChatUIRouteService;
  const { route, service } = makeRouteService();
  globalThis.ChatUIRouteService = service;
  const calls = [];
  const state = { mode: 'chat', autoMode: true, sessions: [], messages: [] };
  const workflow = routeIntentWorkflow.createRouteIntentWorkflow({
    state,
    getConfig: () => ({
      baseUrl: 'https://gateway.example/v1',
      apiKey: 'route-secret',
      routeModel: 'route-model',
      chatModel: 'route-model',
    }),
    getSessionRouteModel: () => 'route-model',
    getSessionChatModel: () => 'route-model',
    requestJson: async (...args) => {
      calls.push(args);
      return { text: '{}' };
    },
  });

  try {
    const result = await workflow.getEffectiveRoute('画一只猫', [], 'session-1', { 'X-Test': 'yes' });
    assert.strictEqual(result, route);
    assert.strictEqual(calls.length, 1);
    assert.strictEqual(calls[0][0], 'https://gateway.example/v1/responses');
    assert.strictEqual(calls[0][1].model, 'route-model');
    assert.ok(Array.isArray(calls[0][1].input));
    assert.ok(calls[0][1].text?.format);
    assert.strictEqual(Object.hasOwn(calls[0][1], 'messages'), false);
    assert.strictEqual(calls[0][2], 'route-secret');
    assert.strictEqual(calls[0][3].method, 'POST');
    assert.deepStrictEqual(calls[0][3].headers, { 'X-Test': 'yes' });
    assert.ok(calls[0][3].signal, 'intent requests must carry the cancellation signal');
  } finally {
    if (previousRouteService === undefined) delete globalThis.ChatUIRouteService;
    else globalThis.ChatUIRouteService = previousRouteService;
  }
}


async function testIntentRecognitionFallsBackToNonStreamingChatForExactResponsesGatewayDefect() {
  const previousRouteService = globalThis.ChatUIRouteService;
  const { route, service } = makeRouteService();
  globalThis.ChatUIRouteService = service;
  const calls = [];
  const workflow = routeIntentWorkflow.createRouteIntentWorkflow({
    state: { mode: 'chat', autoMode: true, sessions: [], messages: [] },
    getConfig: () => ({
      baseUrl: 'https://gateway.example/v1',
      apiKey: 'route-secret',
      routeModel: 'route-model',
      chatModel: 'route-model',
    }),
    getSessionRouteModel: () => 'route-model',
    getSessionChatModel: () => 'route-model',
    requestJson: async (url, payload, apiKey, options) => {
      calls.push({ url, payload, apiKey, options });
      if (calls.length === 1) {
        const error = new Error('failed to do request: empty stream chunks');
        error.statusCode = 500;
        error.code = 'internal_error';
        throw error;
      }
      return { text: '{}' };
    },
  });

  try {
    const result = await workflow.getEffectiveRoute('画一只猫', [], 'session-1');
    assert.strictEqual(result, route);
    assert.strictEqual(calls.length, 2, 'the exact Responses gateway defect must receive one non-streaming Chat fallback');

    const [responsesCall, chatCall] = calls;
    assert.strictEqual(responsesCall.url, 'https://gateway.example/v1/responses');
    assert.strictEqual(responsesCall.payload.stream, false);
    assert.ok(Array.isArray(responsesCall.payload.input));
    assert.ok(responsesCall.payload.text?.format);
    assert.strictEqual(responsesCall.options.requestPurpose, 'intent_recognition');

    assert.strictEqual(chatCall.url, 'https://gateway.example/v1/chat/completions');
    assert.strictEqual(chatCall.payload.stream, false, 'the fallback must remain one-shot JSON, not SSE');
    assert.ok(Array.isArray(chatCall.payload.messages));
    assert.strictEqual(Object.hasOwn(chatCall.payload, 'input'), false);
    assert.strictEqual(Object.hasOwn(chatCall.payload, 'text'), false);
    assert.deepStrictEqual(chatCall.payload.response_format, {
      type: 'json_schema',
      json_schema: {
        name: 'test',
        strict: true,
        schema: { type: 'object' },
      },
    });
    assert.strictEqual(chatCall.options.requestPurpose, 'intent_recognition');
    assert.strictEqual(chatCall.options.method, 'POST');
  } finally {
    if (previousRouteService === undefined) delete globalThis.ChatUIRouteService;
    else globalThis.ChatUIRouteService = previousRouteService;
  }
}

async function testNonStreamingChatTransportFallbackUnwrapsContentPartsBeforeRouteValidation() {
  const previousRouteService = globalThis.ChatUIRouteService;
  const actualRouteService = require('../../client/services/route-service');
  globalThis.ChatUIRouteService = actualRouteService;
  const calls = [];
  const intent = {
    operation: 'plain_chat',
    relation: 'new',
    goal: '联苯苄唑溶液能上飞机么',
    resource_refs: [],
    task_shape: 'single',
  };
  const workflow = routeIntentWorkflow.createRouteIntentWorkflow({
    state: { mode: 'chat', autoMode: true, sessions: [], messages: [] },
    getConfig: () => ({
      baseUrl: 'https://gateway.example/v1',
      apiKey: 'route-secret',
      routeModel: 'route-model',
      chatModel: 'route-model',
    }),
    getSessionRouteModel: () => 'route-model',
    getSessionChatModel: () => 'route-model',
    requestJson: async (url, payload, apiKey, options) => {
      calls.push({ url, payload, apiKey, options });
      if (calls.length === 1) {
        const error = new Error('failed to do request: empty stream chunks');
        error.statusCode = 500;
        error.code = 'internal_error';
        throw error;
      }
      return {
        choices: [{
          message: {
            role: 'assistant',
            content: [{ type: 'text', text: JSON.stringify(intent) }],
          },
        }],
      };
    },
  });

  try {
    const route = await workflow.getEffectiveRoute(intent.goal, [], 'session-content-parts');
    assert.strictEqual(calls.length, 2, 'the exact gateway defect must take the one-shot Chat fallback');
    assert.strictEqual(calls[0].url, 'https://gateway.example/v1/responses');
    assert.strictEqual(calls[1].url, 'https://gateway.example/v1/chat/completions');
    assert.strictEqual(calls[1].payload.stream, false, 'the fallback must never enable streaming');
    assert.strictEqual(route.operationType, 'plain_chat', 'valid content parts must not be rejected as an invalid route');
    assert.strictEqual(route.readiness, 'ready');
  } finally {
    if (previousRouteService === undefined) delete globalThis.ChatUIRouteService;
    else globalThis.ChatUIRouteService = previousRouteService;
  }
}

async function testIntentRecognitionDoesNotChangeTransportForOrdinaryResponsesServerError() {
  const previousRouteService = globalThis.ChatUIRouteService;
  const { service } = makeRouteService();
  globalThis.ChatUIRouteService = service;
  const calls = [];
  const workflow = routeIntentWorkflow.createRouteIntentWorkflow({
    state: { mode: 'chat', autoMode: true, sessions: [], messages: [] },
    getConfig: () => ({
      baseUrl: 'https://gateway.example/v1',
      apiKey: 'route-secret',
      routeModel: 'route-model',
      chatModel: 'route-model',
    }),
    getSessionRouteModel: () => 'route-model',
    getSessionChatModel: () => 'route-model',
    requestJson: async (url, payload, apiKey, options) => {
      calls.push({ url, payload, apiKey, options });
      const error = new Error('upstream temporarily unavailable');
      error.statusCode = 500;
      error.code = 'internal_error';
      throw error;
    },
  });

  try {
    await workflow.getEffectiveRoute('画一只猫', [], 'session-1');
    assert.strictEqual(calls.length, 1, 'ordinary server errors must retain the existing model-error behavior');
    assert.strictEqual(calls[0].url, 'https://gateway.example/v1/responses');
    assert.strictEqual(calls[0].payload.stream, false);
  } finally {
    if (previousRouteService === undefined) delete globalThis.ChatUIRouteService;
    else globalThis.ChatUIRouteService = previousRouteService;
  }
}


async function testIntentWorkflowPreservesCanonicalResourceMetadata() {
  const previousRouteService = globalThis.ChatUIRouteService;
  const captured = [];
  const route = {
    mode: 'chat', api: 'chat', operationType: 'plain_chat', operationApi: 'chat', operationMode: 'chat',
    relation: 'new', readiness: 'ready', dispatchAuthorized: true, needClarification: false,
  };
  globalThis.ChatUIRouteService = {
    buildRoutePayload: options => {
      captured.push(options);
      return { model: options.model, input: [{ role: 'user', content: options.input }] };
    },
    extractRouteText: response => response?.text || '',
    inspectModelRouteResult: () => ({ route }),
  };
  const state = {
    activeSessionId: 'session-identity',
    mode: 'chat',
    autoMode: true,
    sessions: [{
      id: 'session-identity',
      messages: [{
        role: 'assistant',
        content: 'previous answer',
        displayItemId: 'message-runtime-1',
        resource_id: 'res:message:answer-1',
      }],
    }],
    messages: [{
      role: 'assistant',
      content: 'previous answer',
      displayItemId: 'message-runtime-1',
      resource_id: 'res:message:answer-1',
    }],
  };
  const workflow = routeIntentWorkflow.createRouteIntentWorkflow({
    state,
    getConfig: () => ({
      baseUrl: 'https://gateway.example/v1', apiKey: 'route-secret', routeModel: 'route-model', chatModel: 'route-model',
    }),
    getSessionRouteModel: () => 'route-model',
    getSessionChatModel: () => 'route-model',
    buildRouteAttachmentMetadata: () => [{
      type: 'image/png', image_id: 'upload-1', resource_id: 'res:image:upload-1',
      reference_id: 'upload-ref-1', source: 'current', source_index: 1,
    }],
    requestJson: async () => ({ text: '{}' }),
  });

  try {
    const result = await workflow.getEffectiveRoute('describe it', [{ name: 'upload.png', type: 'image/png' }], 'session-identity');
    assert.strictEqual(result, route);
    assert.strictEqual(captured.length, 1);
    assert.strictEqual(captured[0].attachments[0].resource_id, 'res:image:upload-1');
    assert.strictEqual(captured[0].attachments[0].reference_id, 'upload-ref-1');
    assert.strictEqual(captured[0].context.recent_messages[0].resource_id, 'res:message:answer-1');
    assert.strictEqual(captured[0].context.recent_messages[0].id, 'message-runtime-1');
  } finally {
    if (previousRouteService === undefined) delete globalThis.ChatUIRouteService;
    else globalThis.ChatUIRouteService = previousRouteService;
  }
}


async function testInvalidCanonicalRouteOutputFailsClosedInsteadOfDroppingBindings() {
  const previousRouteService = globalThis.ChatUIRouteService;
  globalThis.ChatUIRouteService = {
    buildRoutePayload: ({ model, input }) => ({ model, input: [{ role: 'user', content: input }] }),
    extractRouteText: response => response?.text || '',
    inspectModelRouteResult: () => ({ route: null, reason: 'route_compilation_failed' }),
  };
  const workflow = routeIntentWorkflow.createRouteIntentWorkflow({
    state: { mode: 'chat', autoMode: true, sessions: [], messages: [] },
    getConfig: () => ({
      baseUrl: 'https://gateway.example/v1', apiKey: 'route-secret', routeModel: 'route-model', chatModel: 'route-model',
    }),
    getSessionRouteModel: () => 'route-model',
    getSessionChatModel: () => 'route-model',
    requestJson: async () => ({ text: '{"schema_version":"dispatch_contract.v1"}' }),
  });
  try {
    const route = await workflow.getEffectiveRoute('edit this image', [], 'session-invalid');
    assert.strictEqual(route.needClarification, false);
    assert.strictEqual(route.api, 'route_error');
    assert.strictEqual(route.outcome, 'invalid_model_output');
    assert.strictEqual(route.readiness, 'failed');
    assert.strictEqual(route.dispatchContract, null);
    assert.strictEqual(route.dispatchAuthorized, false);
    assert.deepStrictEqual(route.resources, []);
  } finally {
    if (previousRouteService === undefined) delete globalThis.ChatUIRouteService;
    else globalThis.ChatUIRouteService = previousRouteService;
  }
}

async function testQuotedImageTimeoutFailsClosedWithoutLocalMediaSelection() {
  const previousRouteService = globalThis.ChatUIRouteService;
  const actualRouteService = require('../../client/services/route-service');
  globalThis.ChatUIRouteService = actualRouteService;
  let requestStarted = false;
  let requestAborted = false;
  const workflow = routeIntentWorkflow.createRouteIntentWorkflow({
    state: { mode: 'chat', autoMode: true, sessions: [], messages: [] },
    getConfig: () => ({
      baseUrl: 'https://gateway.example/v1', apiKey: 'route-secret', routeModel: 'route-model', chatModel: 'route-model',
    }),
    getSessionRouteModel: () => 'route-model',
    getSessionChatModel: () => 'route-model',
    requestJson: (_url, _payload, _apiKey, options = {}) => new Promise((resolve, reject) => {
      requestStarted = true;
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
  const context = {
    quoted_message: { index: 1, role: 'assistant', id: 'quoted-message-timeout' },
    recent_messages: [{ index: 1, role: 'assistant', content: '[图片消息]' }],
    image_candidates: [
      {
        index: 1,
        image_id: 'quoted-image-timeout',
        resource_id: 'res:image:quoted-image-timeout',
        reference_id: 'quoted-ref-timeout',
        source: 'quoted',
      },
      {
        index: 2,
        image_id: 'unrelated-history-image',
        resource_id: 'res:image:unrelated-history-image',
        reference_id: 'history-ref-timeout',
        source: 'history',
      },
    ],
  };

  try {
    const route = await workflow.getEffectiveRoute(
      '这个呢',
      [],
      'session-quoted-timeout',
      null,
      context,
      { deadlineMs: 100 },
    );
    assert.strictEqual(requestStarted, true, 'the test deadline must leave enough time to dispatch the request before testing cancellation');
    assert.strictEqual(requestAborted, true, 'the route request must hit the configured deadline');
    assert.strictEqual(route.readiness, 'failed');
    assert.strictEqual(route.outcome, 'transient_error');
    assert.strictEqual(route.dispatchAuthorized, false);
    assert.strictEqual(route.dispatchContract, null);
    assert.strictEqual(route.evidence, 'route_model_timeout');
    assert.deepStrictEqual(route.resources, []);
  } finally {
    if (previousRouteService === undefined) delete globalThis.ChatUIRouteService;
    else globalThis.ChatUIRouteService = previousRouteService;
  }
}



function testIntentPayloadUsesShortResourceKeysAndCompilesBindings() {
  const routeService = require('../../client/services/route-service');
  const payload = JSON.parse(routeService.buildRoutePayload({
    model: 'route-model',
    input: 'continue from the previous instruction',
    attachments: [],
    context: {
      recent_messages: [
        { index: 1, id: 'message-1', resource_id: 'res:message:message-1', role: 'user', content: 'please inspect this file' },
        { index: 2, id: 'message-2', role: 'assistant', content: 'ok' },
      ],
      image_candidates: [{
        index: 1, image_id: 'image-1', resource_id: 'res:image:image-1', reference_id: 'imgref-1',
        source: 'history', filename: 'history.png', description: 'a historical image',
      }],
      file_candidates: [],
    },
  }).input[1].content);

  const candidates = payload.resource_candidates;
  assert.deepStrictEqual(candidates.map(candidate => candidate.candidate_key), ['i1', 'm1', 'm2'],
    'wire payload must publish the complete bounded catalog with short resource keys');
  assert.ok(candidates.every(candidate => !('resource_id' in candidate) && !('reference_id' in candidate)),
    'wire candidates must not expose canonical or provider resource identities');
  assert.ok(candidates.every(candidate => !('identity_aliases' in candidate)
    && !('index_aliases' in candidate) && !('id' in candidate) && !('source_index' in candidate)),
    'wire candidates must not repeat long identity metadata');
  assert.ok(candidates.every(candidate => candidate.label !== undefined),
    'wire candidates keep the routing label');

  const plan = {
    operation: 'plain_chat',
    relation: 'followup',
    goal: '测试用户目标',
    task_shape: 'single',
    resource_refs: [{ candidate_key: 'm1', role: 'context' }],
  };
  const compiled = routeService.inspectModelRouteResult(JSON.stringify(plan), {
    input: 'continue from the previous instruction',
    attachments: [],
    context: {
      recent_messages: [
        { index: 1, id: 'message-1', resource_id: 'res:message:message-1', role: 'user', content: 'please inspect this file' },
        { index: 2, id: 'message-2', role: 'assistant', content: 'ok' },
      ],
    },
  });
  assert.ok(compiled.route, compiled.error || compiled.reason);
  assert.deepStrictEqual(compiled.route.executionResources.messages.map(resource => [resource.key, resource.resource_id]),
    [['r1', 'res:message:message-1']],
    'short binding keys must resolve back to the canonical resource identity');
  assert.strictEqual(compiled.route.dispatchContract.bindings[0].resource_id, 'res:message:message-1');
}

async function testStandaloneImageGenerationUsesTheIntentModel() {
  const previousRouteService = globalThis.ChatUIRouteService;
  const routeService = require('../../client/services/route-service');
  globalThis.ChatUIRouteService = routeService;
  let calls = 0;
  const workflow = routeIntentWorkflow.createRouteIntentWorkflow({
    state: { mode: 'chat', autoMode: true, sessions: [], messages: [] },
    getConfig: () => ({
      baseUrl: 'https://gateway.example/v1', apiKey: 'route-secret', routeModel: 'reasoning-route-model', chatModel: 'chat-model',
    }),
    getSessionRouteModel: () => 'reasoning-route-model',
    getSessionChatModel: () => 'chat-model',
    requestJson: async (_url, payload) => {
      calls += 1;
      const formatName = payload.text?.format?.name;
      if (formatName === 'chatui_route_intent_v3') {
        return {
          choices: [{ message: { content: JSON.stringify({
            operation: 'text_to_image',
            relation: 'new',
            goal: '画一只鸟',
            task_shape: 'single',
            resource_refs: [],
          }) } }],
        };
      }
      if (formatName === 'chatui_image_instruction_v1') {
        return {
          choices: [{ message: { content: JSON.stringify({
            schema_version: 'image_instruction.v1',
            status: 'ready',
            instruction: '一只白色海鸥在晴朗蓝天中展翅飞翔，写实野生动物摄影，清晰羽毛细节。',
            clarification: '',
          }) } }],
        };
      }
      throw new Error(`unexpected structured request: ${formatName || '<missing>'}`);
    },
  });

  try {
    const route = await workflow.getEffectiveRoute('画一只鸡', [], 'session-model-image');
    assert.strictEqual(calls, 2,
      'a ready image route must use the configured intent model once for semantics and once for execution-instruction materialization');
    assert.strictEqual(route.operationType, 'text_to_image');
    assert.strictEqual(route.relation, 'new');
    assert.strictEqual(routeService.isRouteDispatchable(route), true);
  } finally {
    if (previousRouteService === undefined) delete globalThis.ChatUIRouteService;
    else globalThis.ChatUIRouteService = previousRouteService;
  }
}


function testPromptReferenceKeepsTheCompleteBoundedTextWindow() {
  const routeService = require('../../client/services/route-service');
  const payload = JSON.parse(routeService.buildRoutePayload({
    model: 'route-model',
    input: '基于这个提示词帮我生成图片',
    context: {
      recent_messages: [
        { index: 1, id: 'message-1', resource_id: 'res:message:message-1', role: 'user', content: 'irrelevant oldest message' },
        { index: 2, id: 'message-2', resource_id: 'res:message:message-2', role: 'assistant', content: 'a sunset mountain landscape prompt' },
        { index: 3, id: 'message-3', resource_id: 'res:message:message-3', role: 'user', content: 'make it more cinematic' },
        { index: 4, id: 'message-4', resource_id: 'res:message:message-4', role: 'assistant', content: 'a cinematic sunset mountain landscape prompt' },
      ],
    },
  }).input[1].content);

  assert.deepStrictEqual(payload.context.recent_messages.map(item => item.index), [1, 2, 3, 4]);
  assert.deepStrictEqual(payload.resource_candidates.filter(item => item.type === 'message').map(item => item.candidate_key), ['m1', 'm2', 'm3', 'm4']);
  assert.strictEqual(payload.context.recent_messages.some(item => item.content.includes('irrelevant oldest')), true);
}

function testIntentPayloadIncludesBoundedTextHistoryWithoutHistoricalMediaBodies() {
  const routeService = require('../../client/services/route-service');
  const oldPrompt = '旧图片执行提示词 '.repeat(300);
  const payload = JSON.parse(routeService.buildRoutePayload({
    model: 'route-model',
    input: '再换一个场景',
    attachments: [],
    context: {
      recent_messages: [
        { index: 1, role: 'user', content: '旧对话 '.repeat(300) },
        { index: 2, role: 'assistant', content: oldPrompt },
      ],
      image_candidates: [{
        index: 1, image_id: 'history-image', resource_id: 'res:image:history-image', source: 'history', description: oldPrompt,
      }],
      last_generated_image: { prompt: oldPrompt, count: 1, candidates: [{ index: 1, prompt: oldPrompt }] },
      latest_assistant_image_result: { index: 2, content: oldPrompt },
      previous_execution: {
        operation: 'text_to_image', family: 'generate', result_kind: 'image', input: oldPrompt,
        source_message_index: 2, source_user_message_index: 1,
      },
      conversation_focus: { kind: 'image' },
    },
  }).input[1].content);

  assert.deepStrictEqual(payload.resource_candidates.map(candidate => [candidate.candidate_key, candidate.type]), [['i1', 'image']],
    'the active visual result must remain addressable even when the follow-up omits the word “图片”');
  assert.ok(payload.resource_candidates[0].label.length <= 144,
    'active visual metadata must stay compact and must not include media bodies');
  assert.deepStrictEqual(payload.context.recent_messages.map(item => item.index), [1, 2],
    'the router must receive the bounded text history even for a visual continuation');
  assert.strictEqual(payload.context.latest_assistant_image_result, undefined, 'execution output text must not be duplicated into route context');
  assert.strictEqual(payload.context.last_generated_image.prompt, undefined, 'the prior image prompt remains local execution state');
  assert.strictEqual(payload.context.previous_execution.input, undefined, 'the edit-only prior execution input remains local execution state');
  assert.strictEqual(payload.context.previous_execution.resolved_goal, undefined);
  assert.deepStrictEqual(payload.context.previous_execution.task_state, {
    schema_version: 'task_continuity.v1',
    goal_mode: 'replace',
    segments: [{ kind: 'base', text: oldPrompt.trim() }],
  }, 'the route model receives the exact structured image-task baseline needed for a later text-only redesign');
  assert.ok(JSON.stringify(payload).length < 10000, 'bounded text excerpts must replace the multi-kilobyte execution history');
}

function testIntentContextUsesCompactRecentWindowRegardlessOfConfiguredChatWindow() {
  const previousCore = globalThis.ChatUICore;
  const imageRouteContext = require('../../client/core/image-route-context');
  globalThis.ChatUICore = { ...(previousCore || {}), imageRouteContext };

  const messages = Array.from({ length: 100 }, (_, index) => ({
    role: index % 2 === 0 ? 'user' : 'assistant',
    displayItemId: `message-${index + 1}`,
    content: `historical message ${index + 1} ${'x'.repeat(580)}`,
  }));
  const workflow = routeIntentWorkflow.createRouteIntentWorkflow({
    state: {
      activeSessionId: 'long-session',
      mode: 'chat',
      autoMode: true,
      sessions: [],
      messages,
    },
    getConfig: () => ({
      context: { windowTokens: 262144 },
    }),
  });

  try {
    const context = workflow.buildRouteContext('long-session');
    const serializedSize = JSON.stringify(context).length;
    assert.ok(serializedSize <= 500000, `route context must stay compact, got ${serializedSize} chars`);
    assert.ok(context.recent_messages.length === messages.length, 'all history must be retained within budget');
    assert.ok(context.recent_messages.some(message => message.id === 'message-100'), 'latest message must be retained');
    assert.ok(context.recent_messages.some(message => message.id === 'message-1'), 'oldest message must be retained within budget');
  } finally {
    if (previousCore === undefined) delete globalThis.ChatUICore;
    else globalThis.ChatUICore = previousCore;
  }
}

function testIntentPayloadDoesNotRepeatResourceCatalogInsideContext() {
  const routeService = require('../../client/services/route-service');
  const payload = JSON.parse(routeService.buildRoutePayload({
    model: 'route-model',
    input: 'analyze the uploaded file',
    attachments: [],
    context: {
      recent_messages: [{
        index: 1,
        id: 'message-1',
        resource_id: 'res:message:message-1',
        role: 'user',
        content: 'please inspect this file',
      }],
      image_candidates: [{
        index: 1,
        image_id: 'image-1',
        resource_id: 'res:image:image-1',
        source: 'history',
        filename: 'history.png',
        description: 'a historical image',
      }],
      file_candidates: [{
        index: 1,
        file_id: 'file-1',
        resource_id: 'res:file:file-1',
        source: 'history',
        name: 'report.pdf',
      }],
    },
  }).input[1].content);

  assert.ok(!payload.context.image_candidates, 'image candidates should only appear in the canonical resource catalog');
  assert.ok(!payload.context.file_candidates, 'file candidates should only appear in the canonical resource catalog');
  assert.ok(payload.resource_candidates.some(candidate => candidate.type === 'image'), 'bounded historical images must remain available to the intent model');
  assert.ok(payload.resource_candidates.some(candidate => candidate.type === 'file'), 'bounded file candidates must remain available to the intent model');
}


module.exports = [
  testIntentRecognitionUsesTheResponsesProxyPath,
  testIntentRecognitionFallsBackToNonStreamingChatForExactResponsesGatewayDefect,
  testNonStreamingChatTransportFallbackUnwrapsContentPartsBeforeRouteValidation,
  testIntentRecognitionDoesNotChangeTransportForOrdinaryResponsesServerError,
  testAmbiguousRouteUsesDeterministicClarificationWithoutSecondModelCall,
  testIntentWorkflowPreservesCanonicalResourceMetadata,
  testInvalidCanonicalRouteOutputFailsClosedInsteadOfDroppingBindings,
  testQuotedImageTimeoutFailsClosedWithoutLocalMediaSelection,
  testStandaloneImageGenerationUsesTheIntentModel,
  testPromptReferenceKeepsTheCompleteBoundedTextWindow,
  testIntentPayloadIncludesBoundedTextHistoryWithoutHistoricalMediaBodies,
  testIntentContextUsesCompactRecentWindowRegardlessOfConfiguredChatWindow,
  testIntentPayloadUsesShortResourceKeysAndCompilesBindings,
  testIntentPayloadDoesNotRepeatResourceCatalogInsideContext,
];
