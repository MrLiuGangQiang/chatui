'use strict';

const assert = require('assert');
const { JSDOM } = require('jsdom');
const modelService = require('../../client/services/model-service');
const modelUi = require('../../client/app/model-ui');
const modelCore = require('../../client/core/models');

async function testModelServiceBuildsCanonicalProxyRequest() {
  const calls = [];
  const payload = { data: [{ id: 'gpt-5', type: 'chat' }] };
  const result = await modelService.requestModels({
    baseUrl: 'https://example.test/v1',
    apiKey: 'sk-test',
    fetchImpl: async (url, init) => {
      calls.push({ url, init });
      return { ok: true, text: async () => JSON.stringify(payload) };
    },
    parseResponseJson: async response => JSON.parse(await response.text()),
    normalizeError: () => 'unexpected',
  });
  assert.deepStrictEqual(result, payload);
  assert.strictEqual(calls.length, 1);
  assert.strictEqual(calls[0].url, '/api/models');
  assert.strictEqual(calls[0].init.method, 'POST');
  assert.deepStrictEqual(JSON.parse(calls[0].init.body), {
    baseUrl: 'https://example.test/v1',
    apiKey: 'sk-test',
    query: {},
    payload: {},
    method: 'GET',
  });
}

async function testModelServiceReportsConfigurationNetworkAndUpstreamFailures() {
  const deps = {
    parseResponseJson: async response => response.payload,
    normalizeError: (_error, payload) => payload.error.message,
  };
  await assert.rejects(modelService.requestModels({ ...deps, baseUrl: '' }), /请先配置 Endpoint Base URL/);
  await assert.rejects(
    modelService.requestModels({ ...deps, baseUrl: 'https://example.test/v1', fetchImpl: async () => { throw new Error('offline'); } }),
    /连接接口失败：offline/,
  );
  await assert.rejects(
    modelService.requestModels({
      ...deps,
      baseUrl: 'https://example.test/v1',
      fetchImpl: async () => ({ ok: false, payload: { error: { message: 'denied' } } }),
    }),
    /denied/,
  );
}

function testModelUiRendersTypedDeduplicatedOptionsAndSelections() {
  const dom = new JSDOM('<select id="chatModel"></select><select id="routeModel"></select><select id="imageModel"></select>');
  const updates = [];
  const refreshes = [];
  const getElement = id => dom.window.document.getElementById(id);
  const result = modelUi.renderModelOptions({
    models: ['chat-main', 'image-main', 'chat-main', '', 'unknown-model'],
    modelMeta: {
      'chat-main': { type: 'chat' },
      'image-main': { type: 'image' },
      'unknown-model': { unrecognized: true },
    },
    values: { chatModel: 'chat-main', routeModel: 'missing', imageModel: 'image-main' },
    getElement,
    isModelAllowedFor: (id, type) => {
      const actual = id.startsWith('chat') ? 'chat' : id.startsWith('image') ? 'image' : '';
      return !actual || actual === type;
    },
    escapeHtml: value => String(value).replace(/</g, '&lt;'),
    updateCustomSelect: select => updates.push(select.id),
    refreshCustomSelectOptions: select => refreshes.push(select.id),
  });
  assert.deepStrictEqual(result, {
    chatModels: ['chat-main', 'unknown-model'],
    imageModels: ['image-main', 'unknown-model'],
  });
  assert.strictEqual(getElement('chatModel').value, 'chat-main');
  assert.strictEqual(getElement('routeModel').value, '');
  assert.strictEqual(getElement('imageModel').value, 'image-main');
  assert.ok(getElement('chatModel').textContent.includes('unknown-model（未知类型）'));
  assert.deepStrictEqual(updates, ['chatModel', 'routeModel', 'imageModel']);
  assert.deepStrictEqual(refreshes, ['chatModel', 'routeModel', 'imageModel']);
}

async function testModelUiControllerCommitsSuccessAndRecoversFailureState() {
  const dom = new JSDOM(`
    <button id="loadModelsBtn"></button><div id="modelLoadStatus"></div>
    <select id="chatModel"><option value="old" selected>old</option></select>
    <select id="routeModel"></select><select id="imageModel"></select>
  `);
  const state = { models: [], modelMeta: {} };
  const calls = [];
  const getElement = id => dom.window.document.getElementById(id);
  const controller = modelUi.createModelUiController({
    getState: () => state,
    getElement,
    requestModels: async () => ({ data: [{ id: 'chat-main', type: 'chat' }, { id: 'mystery' }] }),
    extractModels: payload => ({
      models: payload.data.map(item => item.id),
      meta: { 'chat-main': { type: 'chat' }, mystery: { unrecognized: true } },
    }),
    isModelAllowedFor: () => true,
    renderSessionModelArea: () => calls.push('render-session'),
    saveConfig: silent => calls.push(['save', silent]),
  });
  await controller.loadModels();
  assert.deepStrictEqual(state.models, ['chat-main', 'mystery']);
  assert.strictEqual(state.modelMeta.mystery.unrecognized, true);
  assert.strictEqual(getElement('modelLoadStatus').textContent, '已加载 2 个，1 个未知类型');
  assert.strictEqual(getElement('loadModelsBtn').disabled, false);
  assert.deepStrictEqual(calls, ['render-session', ['save', true]]);

  const failing = modelUi.createModelUiController({
    getState: () => state,
    getElement,
    requestModels: async () => ({ data: [] }),
    extractModels: () => ({ models: [], meta: {} }),
  });
  await failing.loadModels();
  assert.strictEqual(getElement('modelLoadStatus').textContent, '未从 /models 返回中识别到模型列表');
  assert.strictEqual(getElement('loadModelsBtn').disabled, false);
}

function testModelCoreClassifiesExplicitInferredAndUnknownCapabilities() {
  assert.strictEqual(modelCore.normalizeModelType('image_generation'), 'image');
  assert.strictEqual(modelCore.inferModelType({ id: 'text-embedding-3-large' }), 'embedding');
  assert.strictEqual(modelCore.inferModelType({ id: 'gpt-image-1' }), 'image');
  assert.strictEqual(modelCore.inferModelType({ id: 'custom-model' }), '');
  assert.strictEqual(modelCore.inferModelType({ id: 'custom-model', type: 'audio' }), '');
  assert.deepStrictEqual(modelCore.extractModels({ data: ['gpt-5', { id: 'flux-1', type: 'image_generation' }, {}] }), [
    { id: 'gpt-5', type: 'chat', inferred: true, unrecognized: false },
    { id: 'flux-1', type: 'image', inferred: false, unrecognized: false },
  ]);
}

function testBrowserModelFacadeKeepsUnknownModelsAvailableToBothSelectors() {
  const previousModels = global.ChatUICoreModels;
  const previousCore = global.ChatUICore;
  const modulePath = require.resolve('../../client/core/browser');
  delete require.cache[modulePath];
  global.ChatUICoreModels = modelCore;
  try {
    require('../../client/core/browser');
    const extracted = global.ChatUICore.models.extractModels({ data: [
      { id: 'gpt-5' },
      { id: 'gpt-image-1' },
      { id: 'text-embedding-3-large' },
      { id: 'vendor-special-model' },
    ] });
    assert.deepStrictEqual(extracted.models, ['gpt-5', 'gpt-image-1', 'text-embedding-3-large', 'vendor-special-model']);
    assert.deepStrictEqual(extracted.meta['gpt-5'], { id: 'gpt-5', type: 'chat', unrecognized: false, inferred: true });
    assert.deepStrictEqual(extracted.meta['gpt-image-1'], { id: 'gpt-image-1', type: 'image', unrecognized: false, inferred: true });
    assert.deepStrictEqual(extracted.meta['text-embedding-3-large'], { id: 'text-embedding-3-large', type: 'embedding', unrecognized: false, inferred: true });
    assert.deepStrictEqual(extracted.meta['vendor-special-model'], { id: 'vendor-special-model', type: '', unrecognized: true, inferred: false });
    assert.strictEqual(global.ChatUICore.models.isModelAllowedFor('text-embedding-3-large', 'chat', extracted.meta), false);
    assert.strictEqual(global.ChatUICore.models.isModelAllowedFor('text-embedding-3-large', 'image', extracted.meta), false);
    assert.strictEqual(global.ChatUICore.models.isModelAllowedFor('vendor-special-model', 'chat', extracted.meta), true);
    assert.strictEqual(global.ChatUICore.models.isModelAllowedFor('vendor-special-model', 'image', extracted.meta), true);
  } finally {
    delete require.cache[modulePath];
    if (previousModels === undefined) delete global.ChatUICoreModels;
    else global.ChatUICoreModels = previousModels;
    if (previousCore === undefined) delete global.ChatUICore;
    else global.ChatUICore = previousCore;
  }
}

module.exports = [
  testModelServiceBuildsCanonicalProxyRequest,
  testModelServiceReportsConfigurationNetworkAndUpstreamFailures,
  testModelUiRendersTypedDeduplicatedOptionsAndSelections,
  testModelUiControllerCommitsSuccessAndRecoversFailureState,
  testModelCoreClassifiesExplicitInferredAndUnknownCapabilities,
  testBrowserModelFacadeKeepsUnknownModelsAvailableToBothSelectors,
];
