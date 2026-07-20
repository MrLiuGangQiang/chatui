'use strict';

const assert = require('assert');
const fs = require('fs');
const path = require('path');

const configWorkflow = require('../../client/app/config-workflow');
const sessionConfig = require('../../client/app/session-config');
const routeService = require('../../client/services/route-service');
const routeDecisionWorkflow = require('../../client/app/route-decision-workflow');

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

function testSubmitPreflightUsesEffectiveSessionRouteModel() {
  const root = path.join(__dirname, '../..');
  const submit = fs.readFileSync(path.join(root, 'client/app/submit-workflow.js'), 'utf8');
  const app = fs.readFileSync(path.join(root, 'app.js'), 'utf8');
  const resolution = 'if(typeof getSessionRouteModel==="function"&&!String(preflightConfig.routeModel||"").trim())preflightConfig.routeModel=getSessionRouteModel(sessionId,preflightConfig)';
  assert.ok(submit.includes(resolution), 'submit preflight must resolve follow mode against the target session before checking route availability');
  assert.ok(app.includes(resolution), 'root fallback submit workflow must preserve session-aware route preflight');
  assert.ok(app.includes('getSessionChatModel,getSessionRouteModel,buildRequestHeaders'), 'route workflow dependencies must receive both canonical session model resolvers');
  const index = fs.readFileSync(path.join(root, 'index.html'), 'utf8');
  assert.ok(index.includes('session-config.js?v=1.2.66-session-route-model'));
  assert.ok(index.includes('config-workflow.js?v=1.2.75-visible-model-selection'));
  assert.ok(index.includes('submit-workflow.js?v=1.2.88-session-route-model'));
  assert.ok(index.includes('route-decision-workflow.js?v=2.0.1-session-route-model'));
  assert.ok(index.includes('app.js?v=2.1.45-welcome-globe-only'));
  assert.ok(index.includes('chatui.bundle.js?v=1.3.138-welcome-globe-only'));
}

module.exports = [
  testFollowSelectionClearsPersistedExplicitRouteModel,
  testEmptyVisibleModelSelectionsOverrideStaleStoredModels,
  testSessionRouteModelResolutionUsesOneCanonicalRule,
  testFollowRouteUsesRequestedSessionsChatModelInActualPayload,
  testExplicitRouteFallbackUsesSessionsChatModelNotGlobalChatModel,
  testSubmitPreflightUsesEffectiveSessionRouteModel,
];
