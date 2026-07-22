'use strict';

const assert = require('assert');
const fs = require('fs');
const path = require('path');

const configWorkflow = require('../../client/app/config-workflow');
const sessionConfig = require('../../client/app/session-config');
const routeService = require('../../client/services/route-service');
const routeDecisionWorkflow = require('../../client/app/route-decision-workflow');
const sessionUiWorkflow = require('../../client/app/session-ui-workflow');

function plainChatContract() {
  return {
    schema_version: 'task_contract.v3',
    operation: 'plain_chat',
    relation: 'new',
    resources: [],
    directive: { mode: 'standalone', base_resource_keys: [], unmentioned_policy: 'allow_change', operations: [], constraints: [] },
    clarification: { question: '', missing_resource_keys: [] },
    confidence: 0.95,
    review_reasons: [],
    rationale: 'route model follow-session test',
  };
}

function responseFor(contract = plainChatContract()) {
  return { choices: [{ message: { content: JSON.stringify(contract) } }] };
}

function makeStorage(initial = {}) {
  const values = new Map(Object.entries(initial));
  return {
    values,
    getItem: key => values.has(key) ? values.get(key) : null,
    setItem: (key, value) => values.set(key, String(value)),
    removeItem: key => values.delete(key),
  };
}

function testFollowSelectionClearsPersistedExplicitRouteModel() {
  const storage = makeStorage({ config: JSON.stringify({
    baseUrl: 'https://example.test/v1',
    chatModel: 'deepseek-v4-flash',
    routeModel: 'deepseek-v4-flash',
    imageModel: 'image-model',
    imageSize: 'auto',
    models: ['deepseek-v4-flash', 'gpt-session'],
  }) });
  const elements = new Map([
    ['baseUrl', { value: 'https://example.test/v1' }],
    ['apiKey', { value: '' }],
    ['chatModel', { value: 'deepseek-v4-flash' }],
    ['routeModel', { value: '' }],
    ['imageModel', { value: 'image-model' }],
    ['imageSize', { value: 'auto' }],
    ['systemPrompt', { value: '' }],
    ['imageStylePrompt', { value: '' }],
  ]);
  const state = { models: ['deepseek-v4-flash', 'gpt-session'], modelMeta: {}, sessions: [], activeSessionId: '' };
  const workflow = configWorkflow.createConfigWorkflow({
    state,
    getElement: id => elements.get(id),
    localStorage: storage,
    sessionStorage: storage,
    document: { body: { classList: { add() {}, remove() {} } } },
    window: { sessionStorage: storage, setTimeout },
    crypto: { getRandomValues() {} },
    CONFIG_KEY: 'config',
    renderModelOptions() {},
    updateCustomSelect() {},
    enhanceConfigSelects() {},
    closeAllCustomSelects() {},
    getActiveSession: () => ({ headerValues: {} }),
    saveSessionsMeta() {},
    toast() {},
  });

  assert.strictEqual(workflow.getConfig().routeModel, '', 'the visible follow option must override a stale stored route model');
  workflow.saveConfig(true);
  assert.strictEqual(JSON.parse(storage.values.get('config')).routeModel, '', 'saving follow mode must remove the stale explicit route model');
}

function testEmptyVisibleModelSelectionsOverrideStaleStoredModels() {
  const storage = makeStorage({ config: JSON.stringify({
    baseUrl: 'https://example.test/v1',
    chatModel: 'stale-chat-model',
    imageModel: 'gpt-image-2',
    models: ['stale-chat-model', 'gpt-image-2'],
  }) });
  const elements = new Map([
    ['baseUrl', { value: 'https://example.test/v1' }],
    ['apiKey', { value: '' }],
    ['chatModel', { value: '' }],
    ['routeModel', { value: '' }],
    ['imageModel', { value: '' }],
    ['imageSize', { value: 'auto' }],
    ['systemPrompt', { value: '' }],
    ['imageStylePrompt', { value: '' }],
  ]);
  const workflow = configWorkflow.createConfigWorkflow({
    state: { models: ['stale-chat-model', 'gpt-image-2'], modelMeta: {}, sessions: [], activeSessionId: '' },
    getElement: id => elements.get(id),
    localStorage: storage,
    sessionStorage: storage,
    document: { body: { classList: { add() {}, remove() {} } } },
    window: { sessionStorage: storage, setTimeout },
    crypto: { getRandomValues() {} },
    CONFIG_KEY: 'config',
    renderModelOptions() {},
    updateCustomSelect() {},
    enhanceConfigSelects() {},
    closeAllCustomSelects() {},
    getActiveSession: () => ({ headerValues: {} }),
    saveSessionsMeta() {},
    toast() {},
  });

  assert.strictEqual(workflow.getConfig().chatModel, '', 'an empty visible chat selection must not revive a stale stored model');
  assert.strictEqual(workflow.getConfig().imageModel, '', 'an empty visible image selection must not revive stale gpt-image-2');
  workflow.saveConfig(true);
  const saved = JSON.parse(storage.values.get('config'));
  assert.strictEqual(saved.chatModel, '');
  assert.strictEqual(saved.imageModel, '');
}

function testSessionRouteModelResolutionUsesOneCanonicalRule() {
  const models = ['deepseek-v4-flash', 'gpt-session'];
  const session = { chatModel: 'gpt-session' };
  assert.strictEqual(sessionConfig.getSessionRouteModel({ session, config: { chatModel: 'deepseek-v4-flash', routeModel: '' }, models }), 'gpt-session');
  assert.strictEqual(sessionConfig.getSessionRouteModel({ session, config: { chatModel: 'deepseek-v4-flash', routeModel: 'router-special' }, models }), 'router-special');
  assert.strictEqual(sessionConfig.getSessionRouteModel({ session: { chatModel: 'removed-model' }, config: { chatModel: 'deepseek-v4-flash', routeModel: '' }, models }), 'deepseek-v4-flash');
}

function createRouteHarness({ config, sessions, requestJson }) {
  const previousWindow = global.window;
  global.window = { ChatUIServices: { route: routeService }, ChatUIRouteService: routeService };
  const state = {
    activeSessionId: sessions[0].id,
    sessions,
    messages: sessions[0].messages || [],
    attachments: [],
    mode: 'chat',
    autoMode: true,
  };
  const getSession = sessionId => sessions.find(session => session.id === sessionId) || sessions[0];
  const workflow = routeDecisionWorkflow.createRouteDecisionWorkflow({
    state,
    loadPublicContext: async () => {},
    getConfig: () => ({ ...config }),
    getSessionChatModel: (sessionId, currentConfig) => sessionConfig.getSessionChatModel({ session: getSession(sessionId), config: currentConfig, models: config.models }),
    getSessionRouteModel: (sessionId, currentConfig) => sessionConfig.getSessionRouteModel({ session: getSession(sessionId), config: currentConfig, models: config.models }),
    buildRequestHeaders: () => ({}),
    buildRouteAttachmentMetadata: () => [],
    requestJson,
    parseRouteResult: routeService.parseRouteResult,
  });
  return { workflow, restore: () => { global.window = previousWindow; } };
}

async function testFollowRouteUsesRequestedSessionsChatModelInActualPayload() {
  const models = ['deepseek-v4-flash', 'gpt-session-a', 'gpt-session-b'];
  const sessions = [
    { id: 'session-a', chatModel: 'gpt-session-a', messages: [] },
    { id: 'session-b', chatModel: 'gpt-session-b', messages: [] },
  ];
  const requestedModels = [];
  const harness = createRouteHarness({
    config: { baseUrl: 'https://example.test/v1', apiKey: 'key', chatModel: 'deepseek-v4-flash', routeModel: '', models },
    sessions,
    requestJson: async (_url, payload) => { requestedModels.push(payload.model); return responseFor(); },
  });
  try {
    await harness.workflow.getEffectiveRoute('question a', [], 'session-a', {}, {});
    await harness.workflow.getEffectiveRoute('question b', [], 'session-b', {}, {});
    assert.deepStrictEqual(requestedModels, ['gpt-session-a', 'gpt-session-b']);
    assert.strictEqual(global.__CHATUI_LAST_INTENT_TRACE__?.model, 'gpt-session-b');
  } finally {
    harness.restore();
    delete global.__CHATUI_LAST_INTENT_TRACE__;
  }
}

async function testRouteResolutionReadsLatestSessionModelAfterSwitch() {
  const models = ['gpt-before-switch', 'gpt-after-switch'];
  const sessions = [{ id: 'session-a', chatModel: 'gpt-before-switch', messages: [] }];
  const requestedModels = [];
  const harness = createRouteHarness({
    config: { baseUrl: 'https://example.test/v1', apiKey: 'key', chatModel: 'gpt-before-switch', routeModel: '', models },
    sessions,
    requestJson: async (_url, payload) => { requestedModels.push(payload.model); return responseFor(); },
  });
  try {
    await harness.workflow.getEffectiveRoute('before switch', [], 'session-a', {}, {});
    sessions[0].chatModel = 'gpt-after-switch';
    await harness.workflow.getEffectiveRoute('after switch', [], 'session-a', {}, {});
    assert.deepStrictEqual(requestedModels, ['gpt-before-switch', 'gpt-after-switch'], 'route resolution must read the current session model for every submission instead of caching the previous selection');
  } finally {
    harness.restore();
    delete global.__CHATUI_LAST_INTENT_TRACE__;
  }
}

async function testExplicitRouteModelSwitchUsesLatestSelection() {
  const models = ['chat-model', 'router-before', 'router-after'];
  const sessions = [{ id: 'session-a', chatModel: 'chat-model', messages: [] }];
  const config = { baseUrl: 'https://example.test/v1', apiKey: 'key', chatModel: 'chat-model', routeModel: 'router-before', models };
  const requestedModels = [];
  const previousWindow = global.window;
  global.window = { ChatUIServices: { route: routeService }, ChatUIRouteService: routeService };
  const state = { activeSessionId: 'session-a', sessions, messages: [], attachments: [], mode: 'chat', autoMode: true };
  const workflow = routeDecisionWorkflow.createRouteDecisionWorkflow({
    state,
    loadPublicContext: async () => {},
    getConfig: () => ({ ...config }),
    getSessionChatModel: () => 'chat-model',
    getSessionRouteModel: (_sessionId, currentConfig) => currentConfig.routeModel || currentConfig.chatModel,
    buildRequestHeaders: () => ({}),
    buildRouteAttachmentMetadata: () => [],
    requestJson: async (_url, payload) => { requestedModels.push(payload.model); return responseFor(); },
    parseRouteResult: routeService.parseRouteResult,
  });
  try {
    await workflow.getEffectiveRoute('before route switch', [], 'session-a', {}, {});
    config.routeModel = 'router-after';
    await workflow.getEffectiveRoute('after route switch', [], 'session-a', {}, {});
    assert.deepStrictEqual(requestedModels, ['router-before', 'router-after'], 'each submission must read the latest explicit intent-recognition model');
  } finally {
    global.window = previousWindow;
    delete global.__CHATUI_LAST_INTENT_TRACE__;
  }
}

async function testExplicitRouteFallbackUsesSessionsChatModelNotGlobalChatModel() {
  const models = ['deepseek-v4-flash', 'gpt-session'];
  const sessions = [{ id: 'session-a', chatModel: 'gpt-session', messages: [] }];
  const requestedModels = [];
  const harness = createRouteHarness({
    config: { baseUrl: 'https://example.test/v1', apiKey: 'key', chatModel: 'deepseek-v4-flash', routeModel: 'router-special', models },
    sessions,
    requestJson: async (_url, payload) => {
      requestedModels.push(payload.model);
      if (payload.model === 'router-special') throw new Error('primary route unavailable');
      return responseFor();
    },
  });
  const originalWarn = console.warn;
  console.warn = () => {};
  try {
    const route = await harness.workflow.getEffectiveRoute('question', [], 'session-a', {}, {});
    assert.strictEqual(route.operationType, 'plain_chat');
    assert.deepStrictEqual(requestedModels, ['router-special', 'gpt-session']);
    assert.strictEqual(global.__CHATUI_LAST_INTENT_TRACE__?.model, 'gpt-session');
    assert.strictEqual(global.__CHATUI_LAST_INTENT_TRACE__?.fallbackAi, true);
  } finally {
    console.warn = originalWarn;
    harness.restore();
    delete global.__CHATUI_LAST_INTENT_TRACE__;
  }
}

async function testFollowRouteDoesNotRetrySameSessionModelAfterFailure() {
  const models = ['deepseek-v4-flash', 'gpt-session'];
  const sessions = [{ id: 'session-a', chatModel: 'gpt-session', messages: [] }];
  const requestedModels = [];
  const harness = createRouteHarness({
    config: { baseUrl: 'https://example.test/v1', apiKey: 'key', chatModel: 'deepseek-v4-flash', routeModel: '', models },
    sessions,
    requestJson: async (_url, payload) => {
      requestedModels.push(payload.model);
      throw new Error('selected model unavailable');
    },
  });
  const originalWarn = console.warn;
  console.warn = () => {};
  try {
    await assert.rejects(
      () => harness.workflow.getEffectiveRoute('question after model switch', [], 'session-a', {}, {}),
      err => err?.code === 'ROUTE_COMPLETE_FAILURE',
    );
    assert.deepStrictEqual(requestedModels, ['gpt-session'], 'follow mode must not send the identical route request twice');
  } finally {
    console.warn = originalWarn;
    harness.restore();
    delete global.__CHATUI_LAST_INTENT_TRACE__;
  }
}

async function testInvalidPrimaryRouteFailsWithoutChangingModels() {
  const models = ['deepseek-v4-flash', 'gpt-session', 'router-special'];
  const sessions = [{ id: 'session-a', chatModel: 'gpt-session', messages: [] }];
  const requestedModels = [];
  const harness = createRouteHarness({
    config: { baseUrl: 'https://example.test/v1', apiKey: 'key', chatModel: 'deepseek-v4-flash', routeModel: 'router-special', models },
    sessions,
    requestJson: async (_url, payload) => {
      requestedModels.push(payload.model);
      return { choices: [{ message: { content: 'not a valid task contract' } }] };
    },
  });
  const originalWarn = console.warn;
  console.warn = () => {};
  try {
    await assert.rejects(
      () => harness.workflow.getEffectiveRoute('question', [], 'session-a', {}, {}),
      err => err?.code === 'ROUTE_COMPLETE_FAILURE',
    );
    assert.deepStrictEqual(requestedModels, ['router-special'], 'an invalid contract must fail deterministically instead of silently changing route models');
  } finally {
    console.warn = originalWarn;
    harness.restore();
    delete global.__CHATUI_LAST_INTENT_TRACE__;
  }
}

function testBusyTaskCannotSwitchGlobalRouteModel() {
  const storedConfig = { baseUrl: 'https://example.test/v1', chatModel: 'chat-model', routeModel: 'router-before', imageModel: 'image-model', imageSize: 'auto', models: ['chat-model', 'router-before', 'router-after', 'image-model'] };
  const storage = makeStorage({ config: JSON.stringify(storedConfig) });
  const elements = new Map([
    ['baseUrl', { value: storedConfig.baseUrl }],
    ['apiKey', { value: '' }],
    ['chatModel', { value: 'chat-model' }],
    ['routeModel', { value: 'router-after' }],
    ['imageModel', { value: 'image-model' }],
    ['imageSize', { value: 'auto' }],
    ['systemPrompt', { value: '' }],
    ['imageStylePrompt', { value: '' }],
  ]);
  const notices = [];
  const workflow = configWorkflow.createConfigWorkflow({
    state: { models: storedConfig.models, modelMeta: {}, sessions: [{ id: 'session-a' }], activeSessionId: 'session-a' },
    getElement: id => elements.get(id),
    localStorage: storage,
    sessionStorage: storage,
    document: { body: { classList: { add() {}, remove() {} } } },
    window: { sessionStorage: storage, setTimeout },
    crypto: { getRandomValues() {} },
    CONFIG_KEY: 'config',
    renderModelOptions() {},
    updateCustomSelect() {},
    enhanceConfigSelects() {},
    closeAllCustomSelects() {},
    getActiveSession: () => ({ headerValues: {} }),
    saveSessionsMeta() {},
    isSessionBusy: () => true,
    toast: message => notices.push(message),
  });

  assert.strictEqual(workflow.saveConfig(true), false);
  assert.strictEqual(JSON.parse(storage.values.get('config')).routeModel, 'router-before', 'busy tasks must keep the persisted intent-recognition model');
  assert.strictEqual(elements.get('routeModel').value, 'router-before', 'a blocked route-model switch must restore the visible selection');
  assert.deepStrictEqual(notices, ['\u4efb\u52a1\u8fdb\u884c\u4e2d\uff0c\u8bf7\u505c\u6b62\u6216\u7b49\u5f85\u6240\u6709\u4efb\u52a1\u5b8c\u6210\u540e\u518d\u5207\u6362\u804a\u5929\u6216\u610f\u56fe\u8bc6\u522b\u6a21\u578b']);
}

function testBusySessionCannotSwitchModelMidSubmission() {
  const session = { id: 'session-a', chatModel: 'model-before' };
  const state = { sessions: [session], activeSessionId: 'session-a', models: ['model-before', 'model-after'] };
  let saves = 0;
  const notices = [];
  const workflow = sessionUiWorkflow.createSessionUiWorkflow({
    getState: () => state,
    getElement: () => null,
    getActiveSession: () => session,
    getConfig: () => ({ chatModel: 'model-before' }),
    isSessionBusy: () => true,
    saveSessionsMeta: () => { saves += 1; },
    toast: message => notices.push(message),
    sessionConfig,
  });

  workflow.setSessionChatModel('model-after');

  assert.strictEqual(session.chatModel, 'model-before', 'a running submission must keep the model it started with');
  assert.strictEqual(saves, 0, 'blocked model switches must not be persisted');
  assert.deepStrictEqual(notices, ['\u5f53\u524d\u4f1a\u8bdd\u4efb\u52a1\u8fdb\u884c\u4e2d\uff0c\u8bf7\u505c\u6b62\u6216\u7b49\u5f85\u5b8c\u6210\u540e\u518d\u5207\u6362\u6a21\u578b']);
}

function testSubmitPreflightUsesEffectiveSessionRouteModel() {
  const root = path.join(__dirname, '../..');
  const submit = fs.readFileSync(path.join(root, 'client/app/submit-workflow.js'), 'utf8');
  const app = fs.readFileSync(path.join(root, 'app.js'), 'utf8');
  const resolution = 'if(typeof getSessionRouteModel==="function"&&!String(preflightConfig.routeModel||"").trim())preflightConfig.routeModel=getSessionRouteModel(sessionId,preflightConfig)';
  assert.ok(submit.includes(resolution), 'submit preflight must resolve follow mode against the target session before checking route availability');
  assert.ok(app.includes(resolution), 'root fallback submit workflow must preserve session-aware route preflight');
  assert.ok(app.includes('getSessionChatModel,getSessionRouteModel,buildRequestHeaders'), 'route workflow dependencies must receive both canonical session model resolvers');
  const continuationResolution = 'const cfg=getConfig(),model=typeof getSessionRouteModel==="function"?getSessionRouteModel(sessionId,cfg):cfg.routeModel||cfg.chatModel';
  assert.ok(submit.includes(continuationResolution), 'pending clarification classification must use the target session route model');
  assert.ok(app.includes(continuationResolution), 'root submit fallback must preserve session-aware pending clarification classification');
  assert.ok(!submit.includes('const cfg=getConfig(),model=cfg.routeModel||cfg.chatModel'), 'pending clarification classification must not fall back to the stale global model rule');
  const chatWorkflowSource = fs.readFileSync(path.join(root, 'client/app/chat-workflow.js'), 'utf8');
  assert.ok(chatWorkflowSource.includes('const sessionChatModel=getSessionChatModel(n.sessionId||state.activeSessionId,a)') && chatWorkflowSource.includes('buildChatPayload(sessionChatModel') && chatWorkflowSource.includes('buildResponsesPayload(sessionChatModel'), 'final chat dispatch must use the target session model for both Chat Completions and Responses APIs');
  const index = fs.readFileSync(path.join(root, 'index.html'), 'utf8');
  assert.ok(index.includes('session-config.js?v=1.2.66-session-route-model'));
  assert.ok(index.includes('config-workflow.js?v=1.2.76-busy-route-model-guard'));
  assert.ok(index.includes('submit-workflow.js?v=1.2.91-strict-model-only-continuation'));
  assert.ok(index.includes('route-decision-workflow.js?v=2.0.3-route-fallback-guard'));
  assert.ok(index.includes('app.js?v=2.1.49-strict-model-only-continuation'));
  assert.ok(index.includes('chatui.bundle.js?v=1.3.147-interface-completion'));
}

module.exports = [
  testFollowSelectionClearsPersistedExplicitRouteModel,
  testEmptyVisibleModelSelectionsOverrideStaleStoredModels,
  testSessionRouteModelResolutionUsesOneCanonicalRule,
  testFollowRouteUsesRequestedSessionsChatModelInActualPayload,
  testRouteResolutionReadsLatestSessionModelAfterSwitch,
  testExplicitRouteModelSwitchUsesLatestSelection,
  testExplicitRouteFallbackUsesSessionsChatModelNotGlobalChatModel,
  testFollowRouteDoesNotRetrySameSessionModelAfterFailure,
  testInvalidPrimaryRouteFailsWithoutChangingModels,
  testBusyTaskCannotSwitchGlobalRouteModel,
  testBusySessionCannotSwitchModelMidSubmission,
  testSubmitPreflightUsesEffectiveSessionRouteModel,
];
