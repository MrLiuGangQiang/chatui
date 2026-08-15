'use strict';

const assert = require('assert');
const fs = require('fs');
const path = require('path');
const capabilityRegistry = require('../../shared/capability-registry');
const routeIntent = require('../../shared/route-intent');
const dispatchContract = require('../../shared/dispatch-contract');
const chatService = require('../../client/services/chat-service');
const chatWorkflow = require('../../client/app/chat-workflow');
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
  testResponsesPayloadAddsOnlyTheAuthorizedWebSearchTool,
  testOrdinaryChatCannotInjectWebSearchTool,
  testChatWorkflowForcesResponsesForAuthorizedWebSearch,
  testWebSearchResumeFallbackRestoresTheAuthorizedTool,
  testUnsupportedProviderGetsExplicitWebSearchError,
  testRouteCompilerAcceptsWebSearchIntentWithoutResourceClarification,
];
