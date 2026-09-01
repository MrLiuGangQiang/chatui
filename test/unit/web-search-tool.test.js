'use strict';

const assert = require('assert');
const fs = require('fs');
const path = require('path');
const capabilityRegistry = require('../../shared/capability-registry');
const routeIntent = require('../../shared/route-intent');
const dispatchContract = require('../../shared/dispatch-contract');
const chatService = require('../../client/services/chat-service');
const chatWorkflow = require('../../client/app/chat-workflow');
const routeIntentWorkflow = require('../../client/app/route-intent-workflow');
const routeService = require('../../client/services/route-service');
const { normalizeWebSearchJobError } = require('../../server/jobs/chat');

function testWebSearchCapabilityIsRegistered() {
  const capability = capabilityRegistry.capabilityFor('web_search');
  assert.deepStrictEqual({ api: capability.api, mode: capability.mode }, { api: 'chat', mode: 'chat' });
  assert.strictEqual(capabilityRegistry.resourceRequirementsFor('web_search').length, 1);
  assert.strictEqual(routeIntent.ROUTE_INTENT_RESPONSE_FORMAT.json_schema.schema.properties.operation.enum.includes('web_search'), true);
}

function testExplicitWebSearchDirectiveRecognizesDirectRequests() {
  const directive = capabilityRegistry.explicitRouteDirectiveFor({
    input: '请联网搜索今天的人工智能新闻',
    candidates: [],
  });
  assert.deepStrictEqual(directive, {
    operation: 'web_search',
    relation: 'new',
    resource_scope: 'none',
  });
}

function testExplicitWebSearchDirectiveRecognizesLatestLookupPhrasings() {
  for (const input of [
    '查查最新信息',
    '帮我查查最新的GPT信息',
    '查一下最近的消息',
    '看看最新新闻',
    '了解下最近的行情',
    '查查最新天气',
    '查查最新版本',
    '最近有什么新闻',
    '最新消息',
    '查查最新的房价报告',
    'check the latest news',
    'look up the latest prices',
    'what is the latest news',
  ]) {
    const directive = capabilityRegistry.explicitRouteDirectiveFor({ input, candidates: [] });
    assert.deepStrictEqual(directive, {
      operation: 'web_search',
      relation: 'new',
      resource_scope: 'none',
    }, `explicit online lookup must map to web_search: ${input}`);
  }
}

function testExplicitWebSearchDirectiveExcludesLocalFileAndImageLookups() {
  for (const input of [
    '查一下最新的文档',
    '查查文件里的最新信息',
    '看看最新生成的图',
    '查查这个报告',
    '查查这份报告',
    '把最新版本发我',
    '下载最新版本',
    '现在状态不错',
    '今天天气很好',
    '解释一下什么是闭包',
    '检查一下代码里的变量',
    '查一下这个文件',
    '把第二张图改成黑白',
    '画一只狗',
  ]) {
    const directive = capabilityRegistry.explicitRouteDirectiveFor({ input, candidates: [] });
    assert.ok(!directive || directive.operation !== 'web_search',
      `local/statement phrasing must not map to web_search: ${input}`);
  }
}

function testWebSearchRequestClaimIsExtractedForExplicitLatestLookups() {
  const claims = require('../../shared/intent-claims');
  const extracted = claims.extractClaims('查查最新信息');
  assert.ok(extracted.some(claim => claim.type === 'web_search_request' && claim.critical === true),
    'an explicit latest-info lookup must publish a critical web_search_request claim');
  assert.ok(extracted.some(claim => claim.value.operation === 'web_search'));
  assert.ok(!claims.extractClaims('画一只狗').some(claim => claim.type === 'web_search_request'));
  assert.ok(!claims.extractClaims('查一下最新的文档').some(claim => claim.type === 'web_search_request'));
}

function testWebSearchClaimAndDirectiveStayOneFactSource() {
  const claims = require('../../shared/intent-claims');
  const samples = [
    '查查最新信息', '帮我查查最新的GPT信息', '查一下最近的消息', '看看最新新闻',
    '了解下最近的行情', '查查最新天气', '查查最新版本', '最近有什么新闻', '最新消息',
    '查查最新的房价报告', 'check the latest news', 'look up the latest prices',
    '查一下最新的文档', '查查文件里的最新信息', '看看最新生成的图', '查查这个报告',
    '把最新版本发我', '下载最新版本', '现在状态不错', '今天天气很好', '解释一下什么是闭包',
    '检查一下代码里的变量', '查一下这个文件', '画一只狗', '把第二张图改成黑白',
  ];
  for (const sample of samples) {
    const directiveOperation = capabilityRegistry.explicitRouteDirectiveFor({ input: sample, candidates: [] })?.operation || '';
    const claimed = claims.hasWebSearchRequest(sample);
    assert.strictEqual(claimed, directiveOperation === 'web_search',
      `the web_search_request claim must agree with the capability directive: ${sample}`);
  }
}

function testRouteCompilerKeepsExplicitLookupAsWebSearchWhenModelSaysPlainChat() {
  for (const input of ['查查最新信息', '请联网搜索最新的人工智能新闻']) {
    const inspected = routeService.inspectModelRouteResult(JSON.stringify({
      operation: 'plain_chat',
      relation: 'new',
      goal: input,
      task_shape: 'single',
      resource_refs: [],
    }), {
      input,
      attachments: [],
      context: {},
    });
    assert.ok(inspected.route, inspected.reason || inspected.error || 'route compilation failed');
    assert.strictEqual(inspected.route.operationType, 'web_search',
      `an explicit lookup must not be downgraded to plain_chat: ${input}`);
    assert.strictEqual(inspected.route.dispatchContract.operation, 'web_search');
    assert.strictEqual(inspected.route.needClarification, false);
  }
  const localFileLookup = routeService.inspectModelRouteResult(JSON.stringify({
    operation: 'plain_chat',
    relation: 'new',
    goal: '查一下最新的文档',
    task_shape: 'single',
    resource_refs: [],
  }), {
    input: '查一下最新的文档',
    attachments: [],
    context: {},
  });
  assert.strictEqual(localFileLookup.route.operationType, 'plain_chat',
    'a local file lookup must keep the model operation');
}

async function testWorkflowDispatchesExplicitLatestLookupAsWebSearch() {
  const previousServices = globalThis.ChatUIRouteService;
  globalThis.ChatUIRouteService = routeService;
  const requests = [];
  try {
    const workflow = routeIntentWorkflow.createRouteIntentWorkflow({
      state: { mode: 'chat', autoMode: true, sessions: [], messages: [] },
      getConfig: () => ({ baseUrl: 'https://gateway.example/v1', apiKey: 'test-key', routeModel: 'route-model', chatModel: 'route-model' }),
      getSessionRouteModel: () => 'route-model',
      getSessionChatModel: () => 'route-model',
      buildRouteAttachmentMetadata: items => items,
      requestJson: async (_url, payload, _apiKey, options = {}) => {
        requests.push(options.requestPurpose);
        if (payload?.text?.format?.name === 'chatui_route_intent_v3') {
          return { output_text: JSON.stringify({
            operation: 'plain_chat',
            relation: 'new',
            goal: '查查最新信息',
            goal_mode: 'replace',
            resource_refs: [],
            task_shape: 'single',
          }) };
        }
        throw new Error(`unexpected structured request: ${payload?.text?.format?.name || '<missing>'}`);
      },
    });
    const result = await workflow.getEffectiveRoute('查查最新信息', [], 'session-1', null, {});
    assert.deepStrictEqual(requests, ['intent_recognition'], 'the explicit lookup must stay a single route-model call');
    assert.strictEqual(result.operationType, 'web_search');
    assert.strictEqual(result.dispatchContract.operation, 'web_search');
    assert.strictEqual(result.dispatchAuthorized, true);
  } finally {
    if (previousServices === undefined) delete globalThis.ChatUIRouteService;
    else globalThis.ChatUIRouteService = previousServices;
  }
}

function testResponsesPayloadAddsOnlyTheAuthorizedWebSearchTool() {
  const payload = chatService.buildResponsesPayload('search-model', [
    { role: 'user', content: '搜索最新的人工智能新闻' },
  ], { stream: true, webSearch: true });
  assert.deepStrictEqual(payload.tools, [{ type: 'web_search' }]);
  assert.strictEqual(payload.stream, true);

  const plan = dispatchContract.compileDispatchContract({
    operation: 'web_search',
    input: '搜索最新的人工智能新闻',
  });
  assert.strictEqual(dispatchContract.assertPayloadMatchesDispatchContract(plan, {
    payload,
    transportApi: 'responses',
    enforceContextPolicy: true,
  }), true);
  assert.throws(() => dispatchContract.assertPayloadMatchesDispatchContract(plan, {
    payload: { ...payload, tools: [] },
    transportApi: 'responses',
    enforceContextPolicy: true,
  }), error => error.code === 'EXECUTION_CONTEXT_TOOL_MISMATCH');
}

function testOrdinaryChatCannotInjectWebSearchTool() {
  const plan = dispatchContract.compileDispatchContract({
    operation: 'plain_chat',
    input: '解释一下什么是闭包',
  });
  const payload = chatService.buildResponsesPayload('chat-model', [
    { role: 'user', content: '解释一下什么是闭包' },
  ], { stream: true, webSearch: true });
  assert.throws(() => dispatchContract.assertPayloadMatchesDispatchContract(plan, {
    payload,
    transportApi: 'responses',
    enforceContextPolicy: true,
  }), error => error.code === 'EXECUTION_CONTEXT_CONTROL_FORBIDDEN');
}

async function testChatWorkflowForcesResponsesForAuthorizedWebSearch() {
  const previousServices = globalThis.ChatUIServices;
  let responseBuildOptions = null;
  let savedJob = null;
  let streamedRequest = null;
  const wrappedChatService = Object.freeze({
    ...chatService,
    buildResponsesPayload(model, messages, options) {
      responseBuildOptions = { ...options };
      return chatService.buildResponsesPayload(model, messages, options);
    },
  });
  globalThis.ChatUIServices = { ...(previousServices || {}), chat: wrappedChatService };

  try {
    const prompt = '请联网搜索最新的人工智能新闻';
    const session = { id: 'session-web-search', messages: [], display: [], reasoningMode: false, reasoningType: 'high' };
    const state = {
      sessions: [session],
      activeSessionId: session.id,
      messages: session.messages,
      reasoningMode: false,
      reasoningType: 'high',
    };
    const run = { token: 'run-web-search', stopped: false, abortController: new AbortController() };
    const liveItem = { id: 'display-web-search', role: 'assistant', pending: '1', responseIndex: '1' };
    const config = { baseUrl: 'https://api.example.test/v1', apiKey: 'secret' };
    const workflow = chatWorkflow.createChatWorkflow({
      state,
      loadPublicContext: async () => {},
      getConfig: () => config,
      getSessionChatModel: () => 'search-model',
      ensureActiveRun: () => run,
      getActiveSession: () => session,
      prepareChatAttachments: async (attachments, options) => {
        assert.deepStrictEqual(attachments, []);
        assert.strictEqual(options.operation, 'web_search');
        return [];
      },
      shouldUseResponsesReasoning: () => false,
      buildChatPayload: () => { throw new Error('web_search must not use Chat Completions'); },
      saveChatHistory: async () => {},
      saveSessionMessages: async () => {},
      addMessage: () => ({ isConnected: false, dataset: {} }),
      pendingFeedbackHtml: text => text,
      appendSessionDisplayMessage: () => liveItem,
      persistSessionDisplay: () => {},
      armStreamingOutputFocus: () => {},
      makeClientChatJobId: () => 'chatjob-web-search',
      addActiveRunJob: () => {},
      makeDisplayItemId: () => 'display-generated',
      saveChatJobWithMedia: async (sessionId, job) => {
        savedJob = { sessionId, ...structuredClone(job) };
        return savedJob;
      },
      createRealtimeRenderer: callback => ({ set: callback, final: callback }),
      shouldSuppressRunUi: () => false,
      updateLiveDisplay: () => {},
      shouldFollowScroll: () => false,
      streamManagedChatCompletions: async (payload, requestConfig, jobId, onChunk, options) => {
        streamedRequest = {
          payload: structuredClone(payload),
          requestConfig,
          jobId,
          options: { ...options, signal: null, onAccepted: null },
        };
        onChunk({ content: '搜索完成。', reasoning: '' });
        return { content: '搜索完成。', reasoning: '', firstTokenMs: 5, durationMs: 9 };
      },
      normalizeReasoningText: value => String(value || ''),
      normalizeContentText: value => String(value || ''),
      compactAdjacentDuplicateMessages: items => items,
      cloneMessageList: items => items.map(item => ({ ...item })),
      clearPendingFeedback: () => {},
      clearReasoning: () => {},
      updateReasoning: () => {},
      showReasoningUnavailable: () => {},
      setPendingFeedback: () => {},
      updateMessageContentLight: () => {},
      updateMessage: () => {},
      settleActiveOutput: () => {},
      finishReasoning: () => {},
      firstTokenTimeText: () => '',
      setMessageMetaText: () => {},
      playDoneSound: () => {},
      clearChatJob: () => {},
      isRunStopped: () => false,
      isAbortLikeError: () => false,
      formatElapsed: value => String(value),
    });
    const resolvedPrompt = '查找并汇总最新的 AI 相关新闻。';
    const plan = dispatchContract.compileDispatchContract({
      operation: 'web_search',
      relation: 'followup',
      input: resolvedPrompt,
    });

    await workflow.sendChat(prompt, [], null, {
      sessionId: session.id,
      requestPurpose: 'final_execution',
      dispatchContract: plan,
      bindingEvidence: [],
    });

    assert.deepStrictEqual(responseBuildOptions, {
      stream: true,
      reasoningEnabled: false,
      reasoningEffort: 'none',
      webSearch: true,
    });
    assert.strictEqual(savedJob.api, 'responses');
    assert.deepStrictEqual(savedJob.payload.tools, [{ type: 'web_search' }]);
    assert.strictEqual(streamedRequest.options.api, 'responses');
    assert.strictEqual(streamedRequest.jobId, 'chatjob-web-search');
    assert.deepStrictEqual(streamedRequest.payload.tools, [{ type: 'web_search' }]);
    const finalInput = streamedRequest.payload.input[streamedRequest.payload.input.length - 1];
    assert.strictEqual(finalInput.role, 'user');
    assert.strictEqual(finalInput.content, resolvedPrompt,
      'the wire instruction must use the resolved execution prompt authorized by the dispatch contract');
    assert.strictEqual(state.messages[0].content, prompt,
      "conversation history must preserve the user's original composer text");
  } finally {
    if (previousServices === undefined) delete globalThis.ChatUIServices;
    else globalThis.ChatUIServices = previousServices;
  }
}

function testWebSearchResumeFallbackRestoresTheAuthorizedTool() {
  const app = fs.readFileSync(path.join(__dirname, '../../app.js'), 'utf8');
  const start = app.indexOf('function buildResumeChatPayload');
  const end = app.indexOf('function getJobResumeWorkflow', start);
  assert.ok(start >= 0 && end > start, 'app.js must define the chat resume payload builder');
  const source = app.slice(start, end);
  assert.ok(source.includes('webSearch:"web_search"===t?.dispatchContract?.operation'),
    'a web-search job reconstructed after refresh must restore its authorized Responses tool');
}

function testUnsupportedProviderGetsExplicitWebSearchError() {
  const job = { payload: { tools: [{ type: 'web_search' }] } };
  assert.strictEqual(
    normalizeWebSearchJobError(job, new Error('Unknown tool: web_search')),
    '当前 Endpoint 或模型不支持 Responses API 的 web_search 工具，请更换支持联网搜索的模型或服务。',
  );
  assert.strictEqual(
    normalizeWebSearchJobError({ payload: {} }, new Error('upstream failed')),
    'upstream failed',
  );
}

function testRouteCompilerAcceptsWebSearchIntentWithoutResourceClarification() {
  const inspected = routeService.inspectModelRouteResult(JSON.stringify({
    operation: 'web_search',
    relation: 'new',
    goal: '搜索最新的人工智能新闻',
    task_shape: 'single',
    resource_refs: [],
  }), {
    input: '请联网搜索最新的人工智能新闻',
    attachments: [],
    context: {},
  });
  assert.ok(inspected.route, inspected.reason || inspected.error || 'web_search route compilation failed');
  assert.strictEqual(inspected.route.operationType, 'web_search');
  assert.strictEqual(inspected.route.needClarification, false);
  assert.strictEqual(inspected.route.dispatchContract.operation, 'web_search');
}

module.exports = [
  testWebSearchCapabilityIsRegistered,
  testExplicitWebSearchDirectiveRecognizesDirectRequests,
  testExplicitWebSearchDirectiveRecognizesLatestLookupPhrasings,
  testExplicitWebSearchDirectiveExcludesLocalFileAndImageLookups,
  testWebSearchRequestClaimIsExtractedForExplicitLatestLookups,
  testWebSearchClaimAndDirectiveStayOneFactSource,
  testRouteCompilerKeepsExplicitLookupAsWebSearchWhenModelSaysPlainChat,
  testWorkflowDispatchesExplicitLatestLookupAsWebSearch,
  testResponsesPayloadAddsOnlyTheAuthorizedWebSearchTool,
  testOrdinaryChatCannotInjectWebSearchTool,
  testChatWorkflowForcesResponsesForAuthorizedWebSearch,
  testWebSearchResumeFallbackRestoresTheAuthorizedTool,
  testUnsupportedProviderGetsExplicitWebSearchError,
  testRouteCompilerAcceptsWebSearchIntentWithoutResourceClarification,
];
