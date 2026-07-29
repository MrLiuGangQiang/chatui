'use strict';

const assert = require('assert');
const fs = require('fs');
const path = require('path');

const configWorkflow = require('../../client/app/config-workflow');
const sessionConfig = require('../../client/app/session-config');
const routeService = require('../../client/services/route-service');
const clarificationService = require('../../client/services/clarification-service');
const routeDecisionWorkflow = require('../../client/app/route-decision-workflow');
const sessionUiWorkflow = require('../../client/app/session-ui-workflow');

function plainChatContract() {
  return {
    schema_version: 'task_contract.v4',
    operation: 'plain_chat',
    relation: 'new',
    resources: [],
    directive: { mode: 'standalone', base_resource_keys: [], unmentioned_policy: 'allow_change', operations: [], constraints: [] },
    clarification: { question: '', resume_operation: '', unresolved_resources: [] },
    confidence: 0.95,
    review_reasons: [],
    rationale: 'route model follow-session test',
  };
}

function conversationalFollowupContract() {
  return {
    ...plainChatContract(),
    relation: 'followup',
    rationale: 'the short acknowledgement responds to the preceding conversation without selecting a resource',
  };
}

function quotedFollowupWithoutBindingContract() {
  return {
    schema_version: 'task_contract.v4',
    operation: 'plain_chat',
    relation: 'followup',
    resources: [],
    directive: { mode: 'patch', base_resource_keys: [], unmentioned_policy: 'allow_change', operations: [], constraints: [] },
    clarification: { question: '', resume_operation: '', unresolved_resources: [] },
    confidence: 0.95,
    review_reasons: [],
    rationale: 'follow up on the visible quoted message',
  };
}

function responseFor(contract = plainChatContract()) {
  return { choices: [{ message: { content: JSON.stringify(contract) } }] };
}

function currentTextToImageDecision() {
  return {
    schema_version: 'route_decision.v1',
    readiness: 'ready',
    operation: 'text_to_image',
    relation: 'new',
    bindings: [],
    changes: [],
    constraints: ['16:9'],
    clarification: { question: '', unresolved: [] },
    confidence: 0.99,
    rationale: 'the current text completely describes the image to generate',
  };
}

function reviewedImageEditContract() {
  return {
    schema_version: 'task_contract.v4',
    operation: 'edit_image',
    relation: 'followup',
    resources: [{ key: 'r1', type: 'image', source: 'history', role: 'target', index: 1, id: 'img-product', reference_id: 'imgref-product', missing: false }],
    directive: { mode: 'patch', base_resource_keys: ['r1'], unmentioned_policy: 'preserve', operations: [{ op: 'replace', target: 'background', value: 'white' }], constraints: [] },
    clarification: { question: '', resume_operation: '', unresolved_resources: [] },
    confidence: 0.6,
    review_reasons: ['ambiguous target'],
    rationale: 'review is required before editing',
  };
}

function structuredCompositionClarificationContract() {
  return {
    schema_version: 'task_contract.v5',
    readiness: 'needs_clarification',
    operation: 'image_reference_gen',
    relation: 'followup',
    resources: [{ key: 'r1', type: 'image', source: 'history', role: 'reference', index: 4, id: 'img-cat', reference_id: 'imgref-cat', missing: false }],
    directive: { mode: 'patch', base_resource_keys: ['r1', 'r2'], unmentioned_policy: 'preserve', operations: [{ op: 'add', target: 'composition', value: 'combine cat and fish' }], constraints: [] },
    clarification: {
      question: 'Which fish should be used?',
      unresolved_resources: [{ key: 'r2', type: 'image', role: 'reference', reason: 'ambiguous', choices: [
        { key: 'c1', source: 'history', index: 1, id: 'img-fish-a', reference_id: 'imgref-fish-a', label: 'sketched fish' },
        { key: 'c2', source: 'history', index: 2, id: 'img-fish-b', reference_id: 'imgref-fish-b', label: 'colorful fish' },
      ] }],
    },
    confidence: 0.9,
    review_reasons: [],
    rationale: 'two fish candidates remain',
  };
}

function operationPreservingClarificationContract() {
  const current = structuredCompositionClarificationContract();
  const { readiness: _readiness, ...legacy } = current;
  return {
    ...legacy,
    schema_version: 'task_contract.v4',
    clarification: { ...current.clarification, resume_operation: current.operation },
  };
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

function createRouteHarness({ config, sessions, requestJson, buildRouteAttachmentMetadata = () => [] }) {
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
    buildRouteAttachmentMetadata,
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

async function testInvalidPrimaryRouteRetriesDistinctSessionModelAndReturnsSafeClarification() {
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
    const route = await harness.workflow.getEffectiveRoute('question', [], 'session-a', {}, {});
    assert.deepStrictEqual(requestedModels, ['router-special', 'gpt-session'], 'output without a complete semantic invariant snapshot must skip repair and fail over without asking a model to invent missing intent');
    assert.strictEqual(route.needClarification, true);
    assert.strictEqual(route.api, 'clarify');
    assert.strictEqual(route.intent, 'clarify');
    assert.strictEqual(route.taskContract, null);
    assert.strictEqual(route.localClarification, true);
    assert.match(route.clarificationQuestion, /意图模型返回了无效的任务结构/);
    assert.doesNotMatch(route.clarificationQuestion, /我需要确认你的目标/);
    assert.strictEqual(route.selectedIndexes.length, 0, 'invalid contracts must not select resources locally');
  } finally {
    console.warn = originalWarn;
    harness.restore();
    delete global.__CHATUI_LAST_INTENT_TRACE__;
  }
}

async function testValidCurrentTextImageRouteDoesNotTriggerFallbackRecognition() {
  const requestedModels = [];
  const harness = createRouteHarness({
    config: { baseUrl: 'https://example.test/v1', apiKey: 'key', chatModel: 'chat-model', routeModel: 'route-model', models: ['route-model', 'chat-model'] },
    sessions: [{ id: 'session-a', chatModel: 'chat-model', messages: [] }],
    requestJson: async (_url, payload) => {
      requestedModels.push(payload.model);
      return responseFor(currentTextToImageDecision());
    },
  });
  try {
    const route = await harness.workflow.getEffectiveRoute('Generate a 16:9 presentation image.', [], 'session-a', {}, {});
    assert.deepStrictEqual(requestedModels, ['route-model'], 'a valid current-text image contract must execute from the primary route result without a second recognition request');
    assert.strictEqual(route.mode, 'image');
    assert.strictEqual(route.api, 'image_generation');
  } finally {
    harness.restore();
    delete global.__CHATUI_LAST_INTENT_TRACE__;
  }
}

async function testNativeMarkdownFileQaDecisionIsPrimarySingleFlight() {
  const requestedModels = [];
  const name = '\u516c\u53f8OpenClaw\u5b89\u88c5\u8fc7\u7a0b.md';
  const attachment = {
    attachmentId: 'current-native-markdown',
    name,
    type: 'text/markdown',
    size: 128,
    inputFile: true,
    text: '',
  };
  const semantic = {
    schema_version: 'route_decision.v1',
    readiness: 'ready',
    operation: 'file_qa',
    relation: 'new',
    bindings: [{ candidate_key: 'f1', role: 'attachment' }],
    changes: [],
    constraints: [],
    clarification: { question: '', unresolved: [] },
    confidence: 0.99,
    rationale: '\u7528\u6237\u8bf7\u6c42\u603b\u7ed3\u672c\u8f6e\u4e0a\u4f20\u7684 Markdown \u6587\u4ef6\u5185\u5bb9\u3002',
  };
  const harness = createRouteHarness({
    config: { baseUrl: 'https://example.test/v1', apiKey: 'key', chatModel: 'chat-model', routeModel: 'route-model', models: ['route-model', 'chat-model'] },
    sessions: [{ id: 'session-a', chatModel: 'chat-model', messages: [] }],
    buildRouteAttachmentMetadata: received => {
      assert.deepStrictEqual(received, [attachment]);
      return [{
        index: 1,
        source_index: 1,
        media_index: 1,
        id: 'current-native-markdown',
        file_id: 'current-native-markdown',
        name,
        type: 'text/markdown',
        size: 128,
        is_image: false,
        has_extracted_text: false,
        input_file_available: true,
      }];
    },
    requestJson: async (_url, payload) => {
      requestedModels.push(payload.model);
      if (requestedModels.length > 1) throw new Error('a valid native file decision must not enter repair or fallback routing');
      const user = JSON.parse(payload.messages[1].content);
      assert.ok(user.resource_candidates.some(candidate => candidate.candidate_key === 'f1'
        && candidate.type === 'file'
        && candidate.source === 'current'));
      return responseFor(semantic);
    },
  });

  try {
    const route = await harness.workflow.getEffectiveRoute('\u603b\u7ed3\u5185\u5bb9', [attachment], 'session-a', {}, {});
    assert.deepStrictEqual(requestedModels, ['route-model']);
    assert.strictEqual(route.operationType, 'file_qa');
    assert.strictEqual(route.api, 'chat');
    assert.strictEqual(route.dispatchAuthorized, true);
    assert.strictEqual(route.taskContract.resources[0].id, 'current-native-markdown');
    assert.strictEqual(global.__CHATUI_LAST_INTENT_TRACE__?.fallbackAi, false);
  } finally {
    harness.restore();
    delete global.__CHATUI_LAST_INTENT_TRACE__;
  }
}

async function testSelfContainedImageFollowupIsPrimarySingleFlight() {
  const requestedModels = [];
  const context = {
    recent_messages: [{ index: 1, id: 'prior-dog-prompt', role: 'user', content: '画一只狗' }],
  };
  const semantic = {
    ...currentTextToImageDecision(),
    relation: 'followup',
    bindings: [],
    constraints: [],
  };
  const harness = createRouteHarness({
    config: { baseUrl: 'https://example.test/v1', apiKey: 'key', chatModel: 'chat-model', routeModel: 'route-model', models: ['route-model', 'chat-model'] },
    sessions: [{ id: 'session-a', chatModel: 'chat-model', messages: [] }],
    requestJson: async (_url, payload) => {
      requestedModels.push(payload.model);
      if (requestedModels.length > 1) throw new Error('self-contained image followup must not trigger repair or fallback');
      return responseFor(semantic);
    },
  });
  try {
    const input = '再画一只狗，换个品种';
    const route = await harness.workflow.getEffectiveRoute(input, [], 'session-a', {}, context);
    assert.deepStrictEqual(requestedModels, ['route-model']);
    assert.strictEqual(route.relation, 'followup');
    assert.deepStrictEqual(route.taskContract.resources, []);
    assert.strictEqual(route.contextualImagePrompt, input);
    assert.deepStrictEqual(route.taskContract.review_reasons, []);
  } finally {
    harness.restore();
    delete global.__CHATUI_LAST_INTENT_TRACE__;
  }
}

async function testValidQuotedTextImageDecisionIsPrimarySingleFlight() {
  const requestedModels = [];
  let firstUserPayload = null;
  const context = {
    quoted_message: { index: 1, id: 'quoted-cat', role: 'assistant', content: '银白色带灰色条纹的小猫坐在木地板上。' },
    recent_messages: [{ index: 1, id: 'quoted-cat', role: 'assistant', content: '银白色带灰色条纹的小猫坐在木地板上。' }],
  };
  const semantic = {
    ...currentTextToImageDecision(),
    relation: 'followup',
    bindings: [{ candidate_key: 'm1', role: 'context' }],
    constraints: [],
  };
  const harness = createRouteHarness({
    config: { baseUrl: 'https://example.test/v1', apiKey: 'key', chatModel: 'chat-model', routeModel: 'route-model', models: ['route-model', 'chat-model'] },
    sessions: [{ id: 'session-a', chatModel: 'chat-model', messages: [] }],
    requestJson: async (_url, payload) => {
      requestedModels.push(payload.model);
      firstUserPayload = JSON.parse(payload.messages[1].content);
      return responseFor(semantic);
    },
  });
  try {
    const route = await harness.workflow.getEffectiveRoute('基于这个描述再生成一张图片', [], 'session-a', {}, context);
    assert.deepStrictEqual(requestedModels, ['route-model'], 'a valid quoted-text decision must not trigger format repair or fallback recognition');
    assert.deepStrictEqual(firstUserPayload.resource_candidates, [{ candidate_key: 'm1', type: 'message', source: 'quoted', label: '银白色带灰色条纹的小猫坐在木地板上。' }]);
    assert.strictEqual(route.taskContract.resources[0].id, 'quoted-cat');
    assert.ok(route.contextualImagePrompt.includes('银白色带灰色条纹的小猫坐在木地板上。'));
  } finally {
    harness.restore();
    delete global.__CHATUI_LAST_INTENT_TRACE__;
  }
}

async function testAmbiguousEditIsClarifiedByFirstRoute() {
  const requestedModels = [];
  const semantic = {
    schema_version: 'route_decision.v1',
    readiness: 'needs_clarification',
    operation: 'edit_image',
    relation: 'followup',
    bindings: [],
    changes: [],
    constraints: [],
    clarification: {
      question: '检测到两张狗的图片，请选择要修改的一张，并补充目标颜色。',
      unresolved: [
        { type: 'image', role: 'target', reason: 'ambiguous', candidate_keys: ['i1', 'i2'] },
        { type: 'text', role: 'source', reason: 'missing', candidate_keys: [] },
      ],
    },
    confidence: 0.95,
    rationale: 'the target image and destination color both need clarification',
  };
  const context = {
    image_candidates: [
      { index: 1, source_index: 1, source: 'history', target: 'previous', image_id: 'dog-a', reference_id: 'dog-a-ref', description: '草地上的金毛犬', labels: ['dog'] },
      { index: 2, source_index: 1, source: 'history', target: 'previous', image_id: 'dog-b', reference_id: 'dog-b-ref', description: '客厅里的拉布拉多犬', labels: ['dog'] },
    ],
  };
  const harness = createRouteHarness({
    config: { baseUrl: 'https://example.test/v1', apiKey: 'key', chatModel: 'chat-model', routeModel: 'route-model', models: ['route-model', 'chat-model'] },
    sessions: [{ id: 'session-a', chatModel: 'chat-model', messages: [] }],
    requestJson: async (_url, payload) => {
      requestedModels.push(payload.model);
      return responseFor(semantic);
    },
  });
  try {
    const route = await harness.workflow.getEffectiveRoute('把狗的颜色换一下', [], 'session-a', {}, context);
    assert.deepStrictEqual(requestedModels, ['route-model'], 'the first route must return the final clarification without repair or fallback routing');
    assert.strictEqual(route.api, 'clarify');
    assert.strictEqual(route.dispatchAuthorized, false);
    assert.deepStrictEqual(route.taskContract.clarification.unresolved_resources[0].choices.map(choice => choice.id), ['dog-a', 'dog-b']);
  } finally {
    harness.restore();
    delete global.__CHATUI_LAST_INTENT_TRACE__;
  }
}

async function testMissingEditDetailIsClarifiedByFirstRoute() {
  const requestedModels = [];
  const clarificationDecision = {
    schema_version: 'route_decision.v1',
    readiness: 'needs_clarification',
    operation: 'edit_image',
    relation: 'correction',
    bindings: [{ candidate_key: 'i1', role: 'target' }],
    changes: [],
    constraints: [],
    clarification: {
      question: '请补充目标颜色或具体效果。',
      unresolved: [{ type: 'text', role: 'source', reason: 'missing', candidate_keys: [] }],
    },
    confidence: 0.95,
    rationale: 'the target image is clear but the destination color is missing',
  };
  const harness = createRouteHarness({
    config: { baseUrl: 'https://example.test/v1', apiKey: 'key', chatModel: 'chat-model', routeModel: 'route-model', models: ['route-model', 'chat-model'] },
    sessions: [{ id: 'session-a', chatModel: 'chat-model', messages: [] }],
    requestJson: async (_url, payload) => {
      requestedModels.push(payload.model);
      if (requestedModels.length > 1) throw new Error('missing edit detail must not invoke repair or fallback');
      return responseFor(clarificationDecision);
    },
  });
  try {
    const route = await harness.workflow.getEffectiveRoute('change the cat color', [], 'session-a', {}, {
      image_candidates: [{
        index: 1, source: 'history', image_id: 'img-cat', reference_id: 'imgref-cat',
        description: 'cat', labels: ['cat'],
      }],
    });
    assert.deepStrictEqual(requestedModels, ['route-model'], 'the primary response must terminate routing without repair or chat-model fallback');
    assert.strictEqual(route.api, 'clarify');
    assert.strictEqual(route.dispatchAuthorized, false);
    assert.strictEqual(route.taskContract.operation, 'edit_image');
    assert.strictEqual(route.taskContract.relation, 'correction');
    assert.deepStrictEqual(route.taskContract.directive.operations, []);
    assert.deepStrictEqual(route.taskContract.review_reasons, []);
    assert.strictEqual(global.__CHATUI_LAST_INTENT_TRACE__?.fallbackAi, false);
  } finally {
    harness.restore();
    delete global.__CHATUI_LAST_INTENT_TRACE__;
  }
}

async function testValidStructuredClarificationDoesNotTriggerRepairOrFallback() {
  const requestedModels = [];
  const harness = createRouteHarness({
    config: { baseUrl: 'https://example.test/v1', apiKey: 'key', chatModel: 'chat-model', routeModel: 'route-model', models: ['route-model', 'chat-model'] },
    sessions: [{ id: 'session-a', chatModel: 'chat-model', messages: [] }],
    requestJson: async (_url, payload) => {
      requestedModels.push(payload.model);
      return responseFor(structuredCompositionClarificationContract());
    },
  });
  try {
    const route = await harness.workflow.getEffectiveRoute('combine the cat and fish', [], 'session-a', {}, {
      image_candidates: [
        { index: 4, source: 'history', image_id: 'img-cat', reference_id: 'imgref-cat', target: 'previous' },
        { index: 1, source: 'history', image_id: 'img-fish-a', reference_id: 'imgref-fish-a', target: 'previous' },
        { index: 2, source: 'history', image_id: 'img-fish-b', reference_id: 'imgref-fish-b', target: 'previous' },
      ],
    });
    assert.deepStrictEqual(requestedModels, ['route-model'], 'a valid clarification is a successful primary route and must not be repaired or sent to a fallback recognizer');
    assert.strictEqual(route.needClarification, true);
    assert.strictEqual(route.resumeOperation, 'image_reference_gen');
    assert.strictEqual(global.__CHATUI_LAST_INTENT_TRACE__?.fallbackAi, false);
  } finally {
    harness.restore();
    delete global.__CHATUI_LAST_INTENT_TRACE__;
  }
}

async function testOperationPreservingClarificationIsPrimaryTerminalOutcome() {
  const requestedModels = [];
  const harness = createRouteHarness({
    config: { baseUrl: 'https://example.test/v1', apiKey: 'key', chatModel: 'chat-model', routeModel: 'route-model', models: ['route-model', 'chat-model'] },
    sessions: [{ id: 'session-a', chatModel: 'chat-model', messages: [] }],
    requestJson: async (_url, payload) => {
      requestedModels.push(payload.model);
      if (requestedModels.length > 1) throw new Error('a declared clarification must not reach repair or fallback');
      return responseFor(operationPreservingClarificationContract());
    },
  });
  try {
    const route = await harness.workflow.getEffectiveRoute('combine the cat and fish', [], 'session-a', {}, {
      image_candidates: [
        { index: 4, source: 'history', image_id: 'img-cat', reference_id: 'imgref-cat', target: 'previous' },
        { index: 1, source: 'history', image_id: 'img-fish-a', reference_id: 'imgref-fish-a', target: 'previous' },
        { index: 2, source: 'history', image_id: 'img-fish-b', reference_id: 'imgref-fish-b', target: 'previous' },
      ],
    });
    assert.deepStrictEqual(requestedModels, ['route-model']);
    assert.strictEqual(route.needClarification, true);
    assert.strictEqual(route.operationType, 'image_reference_gen');
    assert.strictEqual(route.taskContract.readiness, 'needs_clarification');
    assert.strictEqual(route.taskContract.schema_version, 'task_contract.v5');
  } finally {
    harness.restore();
    delete global.__CHATUI_LAST_INTENT_TRACE__;
  }
}

async function testStableClarificationIdentityPreventsFallbackFromChoosingForTheUser() {
  const staleIndexes = operationPreservingClarificationContract();
  staleIndexes.resources[0].index = 10;
  staleIndexes.clarification.unresolved_resources[0].choices[0].index = 20;
  staleIndexes.clarification.unresolved_resources[0].choices[1].index = 18;
  const guessedExecutable = structuredClone(routeService.decodeTaskContract(staleIndexes));
  guessedExecutable.readiness = 'ready';
  guessedExecutable.resources.push({
    key: 'r2', type: 'image', source: 'history', role: 'reference', index: 2,
    id: 'img-fish-b', reference_id: 'imgref-fish-b', missing: false,
  });
  guessedExecutable.clarification = { question: '', unresolved_resources: [] };
  const requests = [];
  const harness = createRouteHarness({
    config: { baseUrl: 'https://example.test/v1', apiKey: 'key', chatModel: 'chat-model', routeModel: 'route-model', models: ['route-model', 'chat-model'] },
    sessions: [{ id: 'session-a', chatModel: 'chat-model', messages: [] }],
    requestJson: async (_url, payload) => {
      requests.push(payload);
      return responseFor(requests.length === 1 ? staleIndexes : guessedExecutable);
    },
  });
  try {
    const route = await harness.workflow.getEffectiveRoute('combine the cat and fish', [], 'session-a', {}, {
      image_candidates: [
        { index: 4, source: 'history', image_id: 'img-cat', reference_id: 'imgref-cat', target: 'previous' },
        { index: 1, source: 'history', image_id: 'img-fish-a', reference_id: 'imgref-fish-a', target: 'previous' },
        { index: 2, source: 'history', image_id: 'img-fish-b', reference_id: 'imgref-fish-b', target: 'previous' },
      ],
    });
    assert.deepStrictEqual(requests.map(payload => payload.model), ['route-model'], 'a stable-id clarification must terminate primary routing even when its display indexes are stale');
    assert.strictEqual(route.needClarification, true);
    assert.strictEqual(route.api, 'clarify');
    assert.strictEqual(route.dispatchAuthorized, false);
    assert.strictEqual(route.taskContract.resources[0].index, 4);
    assert.deepStrictEqual(route.taskContract.clarification.unresolved_resources[0].choices.map(choice => choice.index), [1, 2]);
  } finally {
    harness.restore();
    delete global.__CHATUI_LAST_INTENT_TRACE__;
  }
}

async function testDerivedClarificationMetadataCannotTriggerRepairOrFallback() {
  const incompleteDirective = structuredCompositionClarificationContract();
  incompleteDirective.directive.base_resource_keys = ['r1'];
  incompleteDirective.directive.operations = [];
  incompleteDirective.directive.unmentioned_policy = 'allow_change';
  const requests = [];
  const harness = createRouteHarness({
    config: { baseUrl: 'https://example.test/v1', apiKey: 'key', chatModel: 'chat-model', routeModel: 'route-model', models: ['route-model', 'chat-model'] },
    sessions: [{ id: 'session-a', chatModel: 'chat-model', messages: [] }],
    requestJson: async (_url, payload) => {
      requests.push(payload);
      if (requests.length > 1) throw new Error('declared clarification must be terminal');
      return responseFor(incompleteDirective);
    },
  });
  try {
    const route = await harness.workflow.getEffectiveRoute('combine the cat and fish', [], 'session-a', {}, {
      image_candidates: [
        { index: 4, source: 'history', image_id: 'img-cat', reference_id: 'imgref-cat', target: 'previous' },
        { index: 1, source: 'history', image_id: 'img-fish-a', reference_id: 'imgref-fish-a', target: 'previous' },
        { index: 2, source: 'history', image_id: 'img-fish-b', reference_id: 'imgref-fish-b', target: 'previous' },
      ],
    });
    assert.deepStrictEqual(requests.map(payload => payload.model), ['route-model'], 'derived execution metadata must never cause a second model to reinterpret a declared clarification');
    assert.deepStrictEqual(route.taskContract.directive.base_resource_keys, ['r1', 'r2'], 'the runtime must derive every declared resource-slot baseline without choosing a candidate');
    assert.strictEqual(route.needClarification, true);
    assert.strictEqual(route.api, 'clarify');
    assert.strictEqual(route.dispatchAuthorized, false);
    const pending = clarificationService.createPendingClarification({
      messages: [{ role: 'user', content: 'combine the cat and fish' }],
      clarificationText: route.clarificationQuestion,
      routeInfo: route,
    });
    const rerouteContext = clarificationService.buildClarificationRouteContext({
      baseContext: {
        image_candidates: [
          { index: 4, source: 'history', image_id: 'img-cat', reference_id: 'imgref-cat' },
          { index: 1, source: 'history', image_id: 'img-fish-a', reference_id: 'imgref-fish-a' },
          { index: 2, source: 'history', image_id: 'img-fish-b', reference_id: 'imgref-fish-b' },
        ],
      },
      pending,
      currentInput: 'the second fish',
      resolvedInput: 'combine the cat and the second fish',
      selections: [{ resource_key: 'r2', choice_key: 'c2' }],
    });
    assert.ok(rerouteContext);
    assert.strictEqual(rerouteContext.clarification_context.selected_choices[0].id, 'img-fish-b');
    assert.strictEqual(route.dispatchAuthorized, false, 'choice metadata must not mutate the prior route into an executable route');
  } finally {
    harness.restore();
    delete global.__CHATUI_LAST_INTENT_TRACE__;
  }
}

async function testMalformedClarificationIsTerminalWithoutRepairOrFallback() {
  const valid = structuredCompositionClarificationContract();
  const malformed = structuredClone(valid);
  malformed.clarification.unresolved_resources[0].choices = [malformed.clarification.unresolved_resources[0].choices[0]];
  const requests = [];
  const harness = createRouteHarness({
    config: { baseUrl: 'https://example.test/v1', apiKey: 'key', chatModel: 'chat-model', routeModel: 'route-model', models: ['route-model', 'chat-model'] },
    sessions: [{ id: 'session-a', chatModel: 'chat-model', messages: [] }],
    requestJson: async (_url, payload) => {
      requests.push(payload);
      if (requests.length > 1) throw new Error('a declared clarification must not be repaired or rerouted');
      return responseFor(malformed);
    },
  });
  try {
    const route = await harness.workflow.getEffectiveRoute('combine the cat and fish', [], 'session-a', {}, {
      image_candidates: [
        { index: 4, source: 'history', image_id: 'img-cat', reference_id: 'imgref-cat', target: 'previous' },
        { index: 1, source: 'history', image_id: 'img-fish-a', reference_id: 'imgref-fish-a', target: 'previous' },
        { index: 2, source: 'history', image_id: 'img-fish-b', reference_id: 'imgref-fish-b', target: 'previous' },
      ],
    });
    assert.deepStrictEqual(requests.map(payload => payload.model), ['route-model']);
    assert.strictEqual(route.needClarification, true);
    assert.strictEqual(route.api, 'clarify');
    assert.strictEqual(route.dispatchAuthorized, false);
    assert.strictEqual(route.operationType, 'image_reference_gen');
    assert.strictEqual(route.resumeOperation, 'image_reference_gen');
    assert.strictEqual(route.taskContract, null, 'unsafe structured choices must not be persisted as an executable contract');
    assert.strictEqual(route.clarificationDegraded, true);
    assert.strictEqual(route.requiresRerouteAfterClarification, true, 'the customer answer must return to normal routing instead of local execution');
    assert.strictEqual(route.clarificationQuestion, malformed.clarification.question, 'the original clarification content must be shown to the customer');
    assert.strictEqual(global.__CHATUI_LAST_INTENT_TRACE__?.fallbackAi, false);
  } finally {
    harness.restore();
    delete global.__CHATUI_LAST_INTENT_TRACE__;
  }
}

async function testResourceFreePlainChatFollowupIsSingleFlight() {
  const requestedModels = [];
  const harness = createRouteHarness({
    config: { baseUrl: 'https://example.test/v1', apiKey: 'key', chatModel: 'chat-model', routeModel: 'route-model', models: ['route-model', 'chat-model'] },
    sessions: [{ id: 'session-a', chatModel: 'chat-model', messages: [] }],
    requestJson: async (_url, payload) => {
      requestedModels.push(payload.model);
      return responseFor(conversationalFollowupContract());
    },
  });
  try {
    const route = await harness.workflow.getEffectiveRoute('可以啊', [], 'session-a', {}, {
      recent_messages: [{ index: 1, role: 'assistant', content: 'Would you like me to continue?' }],
    });
    assert.deepStrictEqual(requestedModels, ['route-model'], 'resource-free conversational followup must not trigger contract repair or fallback routing');
    assert.strictEqual(route.relation, 'followup');
    assert.strictEqual(route.taskContract.directive.mode, 'standalone');
    assert.strictEqual(global.__CHATUI_LAST_INTENT_TRACE__?.fallbackAi, false);
  } finally {
    harness.restore();
    delete global.__CHATUI_LAST_INTENT_TRACE__;
  }
}

async function testExplicitQuoteMakesAnIncompletePlainChatFollowupSingleFlight() {
  const requestedModels = [];
  const harness = createRouteHarness({
    config: { baseUrl: 'https://example.test/v1', apiKey: 'key', chatModel: 'chat-model', routeModel: 'route-model', models: ['route-model', 'chat-model'] },
    sessions: [{ id: 'session-a', chatModel: 'chat-model', messages: [] }],
    requestJson: async (_url, payload) => {
      requestedModels.push(payload.model);
      return responseFor(quotedFollowupWithoutBindingContract());
    },
  });
  try {
    const route = await harness.workflow.getEffectiveRoute('Can this be improved?', [], 'session-a', {}, {
      quoted_message: { index: 1, role: 'assistant', id: 'quoted-answer-1' },
      recent_messages: [{ index: 1, role: 'assistant', content: 'The quoted answer.' }],
    });
    assert.deepStrictEqual(requestedModels, ['route-model'], 'a visible quote must complete the primary plain-chat route instead of falling back to a second recognizer');
    assert.strictEqual(route.relation, 'followup');
    assert.deepStrictEqual(route.taskContract.directive.base_resource_keys, ['r1']);
  } finally {
    harness.restore();
    delete global.__CHATUI_LAST_INTENT_TRACE__;
  }
}

async function testRouteCancellationStopsTheCurrentIntentRequestWithoutFallback() {
  const models = ['router-special', 'gpt-session'];
  const sessions = [{ id: 'session-a', chatModel: 'gpt-session', messages: [] }];
  const requestedModels = [];
  let requestSignal = null;
  let notifyRequestStarted;
  const requestStarted = new Promise(resolve => { notifyRequestStarted = resolve; });
  const harness = createRouteHarness({
    config: { baseUrl: 'https://example.test/v1', apiKey: 'key', chatModel: 'router-special', routeModel: 'router-special', models },
    sessions,
    requestJson: async (_url, payload, _apiKey, options = {}) => {
      requestedModels.push(payload.model);
      requestSignal = options.signal;
      notifyRequestStarted();
      return await new Promise((_resolve, reject) => {
        options.signal?.addEventListener('abort', () => {
          const error = new Error('aborted');
          error.name = 'AbortError';
          reject(error);
        }, { once: true });
      });
    },
  });
  const controller = new AbortController();
  try {
    const pending = harness.workflow.getEffectiveRoute('cancel this route', [], 'session-a', {}, {}, { signal: controller.signal });
    await requestStarted;
    controller.abort();
    await assert.rejects(pending, error => error?.code === 'ROUTE_CANCELLED');
    assert.deepStrictEqual(requestedModels, ['router-special']);
    assert.strictEqual(requestSignal?.aborted, true, 'the live route request must receive the submission abort signal');
  } finally {
    harness.restore();
    delete global.__CHATUI_LAST_INTENT_TRACE__;
  }
}

async function testValidHighRiskRouteExecutesWithoutIndependentReview() {
  const models = ['router-special'];
  const sessions = [{ id: 'session-a', chatModel: 'router-special', messages: [] }];
  let requestCount = 0;
  const harness = createRouteHarness({
    config: { baseUrl: 'https://example.test/v1', apiKey: 'key', chatModel: 'router-special', routeModel: 'router-special', models },
    sessions,
    requestJson: async () => {
      requestCount += 1;
      if (requestCount === 1) return responseFor(reviewedImageEditContract());
      throw new Error('a valid first route must not make another route request');
    },
  });
  const originalWarn = console.warn;
  console.warn = () => {};
  try {
    const route = await harness.workflow.getEffectiveRoute('change the product background', [], 'session-a', {}, {
      image_candidates: [{ index: 1, source: 'history', image_id: 'img-product', reference_id: 'imgref-product', target: 'previous' }],
    });
    assert.strictEqual(requestCount, 1, 'a valid first route must execute without an independent review request');
    assert.strictEqual(route.operationType, 'edit_image');
  } finally {
    console.warn = originalWarn;
    harness.restore();
    delete global.__CHATUI_LAST_INTENT_TRACE__;
  }
}

async function testInvalidPrimaryContractUsesSameModelRepairBeforeFallback() {
  const models = ['router-special', 'chat-model'];
  const sessions = [{ id: 'session-a', chatModel: 'chat-model', messages: [] }];
  const requested = [];
  const valid = {
    ...plainChatContract(),
    schema_version: 'task_contract.v5',
    readiness: 'ready',
    clarification: { question: '', unresolved_resources: [] },
  };
  const invalid = { ...valid, accidental_field: 'must be rejected' };
  const harness = createRouteHarness({
    config: { baseUrl: 'https://example.test/v1', apiKey: 'key', chatModel: 'chat-model', routeModel: 'router-special', models },
    sessions,
    requestJson: async (_url, payload) => {
      requested.push(payload);
      return requested.length === 1 ? responseFor(invalid) : responseFor(valid);
    },
  });
  try {
    const route = await harness.workflow.getEffectiveRoute('Explain this request.', [], 'session-a', {}, {});
    assert.strictEqual(route.operationType, 'plain_chat');
    assert.deepStrictEqual(requested.map(payload => payload.model), ['router-special', 'router-special']);
    assert.ok(requested[1].messages[0].content.startsWith(routeService.INTENT_REPAIR_SYSTEM_PROMPT), 'repair must keep the same model and explicitly repair only the rejected contract');
    assert.ok(requested[1].messages[0].content.includes(routeService.ROUTE_OUTPUT_CONTRACT_CHECK), 'repair must receive the complete current contract instead of relying on an obsolete schema memory');
    assert.strictEqual(requested[1].response_format?.json_schema?.strict, true);
    const repairInput = JSON.parse(requested[1].messages[1].content);
    assert.deepStrictEqual(repairInput.repair_invariants, routeService.repairInvariantSnapshot(invalid));
  } finally {
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
  assert.ok(!app.includes(resolution), 'the root entry must not retain a duplicate submit preflight implementation');
  assert.ok(app.includes('async function onSubmit(e){return getSubmitWorkflow().onSubmit(e)}'), 'the root entry must delegate to the canonical submit workflow');
  assert.ok(app.includes('getSessionChatModel,getSessionRouteModel,buildRequestHeaders'), 'route workflow dependencies must receive both canonical session model resolvers');
  const continuationResolution = 'const cfg=getConfig(),model=typeof getSessionRouteModel==="function"?getSessionRouteModel(sessionId,cfg):cfg.routeModel||cfg.chatModel';
  assert.ok(submit.includes(continuationResolution), 'pending clarification classification must use the target session route model');
  assert.ok(!app.includes(continuationResolution), 'the root entry must not retain a duplicate pending-clarification classifier');
  assert.ok(!submit.includes('const cfg=getConfig(),model=cfg.routeModel||cfg.chatModel'), 'pending clarification classification must not fall back to the stale global model rule');
  const chatWorkflowSource = fs.readFileSync(path.join(root, 'client/app/chat-workflow.js'), 'utf8');
  assert.ok(chatWorkflowSource.includes('const sessionChatModel=getSessionChatModel(n.sessionId||state.activeSessionId,a)') && chatWorkflowSource.includes('buildChatPayload(sessionChatModel') && chatWorkflowSource.includes('buildResponsesRequestPayload(sessionChatModel'), 'final chat dispatch must use the target session model for both Chat Completions and Responses APIs');
  const index = fs.readFileSync(path.join(root, 'index.html'), 'utf8');
  assert.ok(index.includes('session-config.js?v=1.2.66-session-route-model'));
  assert.ok(index.includes('config-workflow.js?v=1.2.78-secret-free-backup'));
  assert.ok(index.includes('submit-workflow.js?v=1.4.4-clarification-identity'));
  assert.ok(index.includes('route-decision-workflow.js?v=3.4.0-decision-compiler'));
  assert.ok(index.includes('app.js?v=2.2.0-native-file-inputs'));
  assert.ok(index.includes('chatui.bundle.js?v=1.3.160-code-action-motion'));
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
  testInvalidPrimaryRouteRetriesDistinctSessionModelAndReturnsSafeClarification,
  testValidCurrentTextImageRouteDoesNotTriggerFallbackRecognition,
  testNativeMarkdownFileQaDecisionIsPrimarySingleFlight,
  testSelfContainedImageFollowupIsPrimarySingleFlight,
  testValidQuotedTextImageDecisionIsPrimarySingleFlight,
  testAmbiguousEditIsClarifiedByFirstRoute,
  testMissingEditDetailIsClarifiedByFirstRoute,
  testValidStructuredClarificationDoesNotTriggerRepairOrFallback,
  testOperationPreservingClarificationIsPrimaryTerminalOutcome,
  testStableClarificationIdentityPreventsFallbackFromChoosingForTheUser,
  testDerivedClarificationMetadataCannotTriggerRepairOrFallback,
  testMalformedClarificationIsTerminalWithoutRepairOrFallback,
  testResourceFreePlainChatFollowupIsSingleFlight,
  testExplicitQuoteMakesAnIncompletePlainChatFollowupSingleFlight,
  testRouteCancellationStopsTheCurrentIntentRequestWithoutFallback,
  testValidHighRiskRouteExecutesWithoutIndependentReview,
  testInvalidPrimaryContractUsesSameModelRepairBeforeFallback,
  testBusyTaskCannotSwitchGlobalRouteModel,
  testBusySessionCannotSwitchModelMidSubmission,
  testSubmitPreflightUsesEffectiveSessionRouteModel,
];
