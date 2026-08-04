'use strict';

const assert = require('assert');
const configModule = require('../../client/app/config-workflow');
const mediaWorkflowModule = require('../../client/app/media-workflow');
const chatService = require('../../client/services/chat-service');

function createStorage(initial = {}) {
  const values = new Map(Object.entries(initial));
  return {
    getItem: key => values.get(key) || null,
    setItem: (key, value) => values.set(key, String(value)),
    removeItem: key => values.delete(key),
  };
}

function createConfigHarness(stored = {}) {
  const storage = createStorage({ config: JSON.stringify(stored) });
  const elements = new Map(['baseUrl', 'apiKey', 'chatModel', 'routeModel', 'imageModel', 'imageSize', 'systemPrompt', 'imageStylePrompt']
    .map(id => [id, { value: id === 'baseUrl' ? 'https://gateway.example/v1' : '' }]));
  const workflow = configModule.createConfigWorkflow({
    state: { models: [], modelMeta: {}, sessions: [], activeSessionId: '' },
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
    getActiveSession: () => ({}),
    saveSessionsMeta() {},
    toast() {},
  });
  return { workflow, storage };
}

function testLegacyDirectModeIsIgnoredAndRemovedFromPersistedConfiguration() {
  const { workflow, storage } = createConfigHarness({ directMode: true });
  assert.strictEqual(Object.hasOwn(workflow.getConfig(), 'directMode'), false);
  workflow.saveConfig(true);
  assert.strictEqual(Object.hasOwn(JSON.parse(storage.getItem('config')), 'directMode'), false);
  assert.strictEqual(Object.hasOwn(configModule.defaults, 'directMode'), false);
}



async function testChatJsonRequestsAlwaysUseTheValidatedLocalProxy() {
  const calls = [];
  const payload = await chatService.requestJson({
    fetchImpl: async (url, init) => {
      calls.push({ url, init });
      return { ok: true, body: { ok: true } };
    },
    url: 'https://gateway.example/v1/chat/completions',
    payload: { model: 'gpt-5' },
    apiKey: 'sk-secret',
    directMode: true,
    baseUrl: 'https://gateway.example/v1',
    headers: { 'X-Trace': 'trace-1' },
    toProxyUrl: () => '/api/chat/completions',
    parseResponseJson: async response => response.body,
    normalizeError: () => 'unexpected',
  });
  assert.deepStrictEqual(payload, { ok: true });
  assert.strictEqual(calls[0].url, '/api/chat/completions');
  assert.strictEqual(calls[0].init.headers.Authorization, undefined);
  assert.strictEqual(calls[0].init.headers['X-Trace'], undefined);
  assert.deepStrictEqual(JSON.parse(calls[0].init.body), {
    baseUrl: 'https://gateway.example/v1',
    apiKey: 'sk-secret',
    payload: { model: 'gpt-5' },
    method: 'POST',
    headers: { 'X-Trace': 'trace-1' },
  });
}

async function testImageDownloadsNeverSendApiKeysFromTheBrowserToReturnedUrls() {
  const calls = [];
  const expectedBlob = { type: 'image/png', size: 4 };
  const workflow = mediaWorkflowModule.createMediaWorkflow({
    IMAGE_DB: 'test-db',
    IMAGE_STORE: 'images',
    TRANSPARENT_PIXEL: 'data:image/gif;base64,AAAA',
    URL: { createObjectURL: () => 'blob:test', revokeObjectURL() {} },
    state: { sessions: [], attachments: [], activeRuns: new Map(), liveRuns: new Map(), attachmentDrafts: new Map() },
    localStorage: { getItem: () => null },
    imageStoreHelpers: {
      createImageStore: () => ({
        openImageDb: async () => ({}),
        putImageBlob: async () => {},
        getImageBlob: async () => null,
        clearImageDb: async () => {},
        deleteImageDbKeys: async () => {},
        getImageDbKeys: async () => [],
      }),
      collectIndexedDbKeys: (_value, keys) => keys,
      dataUrlToBlob: async () => expectedBlob,
      imageBlobSize: async () => null,
      fitImageThumb: () => ({ width: 1, height: 1 }),
    },
    fetch: async (url, init) => {
      calls.push({ url, init });
      if (url === '/api/image') return { ok: true, blob: async () => expectedBlob };
      return {
        ok: false,
        headers: { get: () => 'text/plain' },
        blob: async () => { throw new Error('unexpected direct blob'); },
      };
    },
    parseResponseJson: async () => ({}),
    normalizeError: () => 'unexpected',
  });

  const result = await workflow.fetchImageBlob('https://cdn.example.test/result.png', {
    baseUrl: 'https://gateway.example/v1',
    apiKey: 'sk-secret',
    directMode: true,
  });
  assert.strictEqual(result, expectedBlob);
  assert.strictEqual(calls.length, 2);
  assert.strictEqual(calls[0].url, 'https://cdn.example.test/result.png');
  assert.strictEqual(calls[0].init.headers.Authorization, undefined);
  assert.deepStrictEqual(calls[0].init.headers, {}, 'the browser may try a public image URL only without credentials');
  assert.strictEqual(calls[1].url, '/api/image');
  assert.strictEqual(calls[1].init.headers.Authorization, undefined);
  assert.deepStrictEqual(JSON.parse(calls[1].init.body), {
    baseUrl: 'https://gateway.example/v1',
    apiKey: 'sk-secret',
    url: 'https://cdn.example.test/result.png',
  });
}

module.exports = [
  testLegacyDirectModeIsIgnoredAndRemovedFromPersistedConfiguration,

  testChatJsonRequestsAlwaysUseTheValidatedLocalProxy,
  testImageDownloadsNeverSendApiKeysFromTheBrowserToReturnedUrls,
];




