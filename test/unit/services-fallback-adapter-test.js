#!/usr/bin/env node
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const root = path.resolve(__dirname, '../..');
const files = [
  'client/services/model-service.js',
  'client/services/job-service.js',
  'client/services/chat-service.js',
  'client/services/route-service.js',
  'client/services/image-generation-service.js',
  'client/services/image-service.js',
  'client/services/composition.js',
];
const compositionSource = fs.readFileSync(path.join(root, 'client/services/composition.js'), 'utf8');

assert.ok(compositionSource.includes('window.ChatUIServicesComposition'), 'composition exposes explicit browser namespace');
assert.ok(compositionSource.includes('window.ChatUIServicesFallback = api'), 'composition preserves legacy fallback alias');

const calls = [];
const context = {
  console,
  setTimeout,
  clearTimeout,
  DOMException,
  XMLHttpRequest: function XMLHttpRequest() {},
  fetch: async (url, options = {}) => {
    calls.push({ url, options });
    return {
      ok: true,
      text: async () => JSON.stringify({ ok: true, data: [{ url: 'https://example.test/image.png' }] }),
    };
  },
  window: {
    fetch: async (url, options = {}) => {
      calls.push({ url, options });
      return {
        ok: true,
        text: async () => JSON.stringify({ ok: true, data: [{ url: 'https://example.test/image.png' }] }),
      };
    },
    ChatUICore: {
      http: {
        parseResponseJson: async response => JSON.parse(await response.text()),
        normalizeError: (_err, payload) => payload?.message || 'failed',
        toProxyUrl: (url, baseUrl) => `/api${String(url).slice(String(baseUrl || '').length)}`,
      },
      reasoning: { extractStreamDelta: data => data?.choices?.[0]?.delta?.content || '' },
      imageRouteContext: {
        normalizeRoute: route => ({ mode: route.mode || 'chat', target: route.target || 'none' }),
      },
      imageReferences: { makeImageItemId: (ref, index) => `img_${ref}_${index}` },
      attachments: { isImageFile: item => /^image\//.test(item?.type || '') },
    },
  },
};
context.globalThis = context;
vm.createContext(context);
for (const file of files) {
  vm.runInContext(fs.readFileSync(path.join(root, file), 'utf8'), context, { filename: file });
}

const fallback = context.window.ChatUIServicesFallback;
assert.ok(context.window.ChatUIServicesComposition, 'composition namespace exists');
assert.strictEqual(fallback, context.window.ChatUIServicesComposition, 'legacy fallback namespace aliases composition');
assert.strictEqual(typeof fallback.models.requestModels, 'function');
assert.strictEqual(typeof fallback.jobs.startChatJob, 'function');
assert.strictEqual(typeof fallback.chat.extractChatJobText, 'function');
assert.strictEqual(typeof fallback.route.parseRouteResult, 'function');
assert.strictEqual(typeof fallback.images.extractImageResult, 'function');

assert.deepStrictEqual(fallback.chat.extractChatJobText({ output_text: 'ok' }).content, 'ok');
assert.strictEqual(fallback.chat.parseSseLine('data: {"choices":[{"delta":{"content":"你"}}]}').delta, '你');
assert.strictEqual(fallback.route.parseRouteResult('image'), null);
assert.strictEqual(fallback.route.inferLocalImageRoute, undefined, 'service composition must not expose local route fallback');
assert.strictEqual(fallback.images.extractImageResult({ data: [{ url: 'u' }] }).src, 'u');
assert.strictEqual(fallback.images.buildImagePromptWithStylePrompt('猫', '水彩'), '猫\n\n图片样式要求：\n水彩');
assert.strictEqual(fallback.images.createImageContext({ attachments: [{}], selectedReferenceId: 'latest' }).attachments[0].imageId, 'img_latest_1');

(async () => {
  const modelPayload = await fallback.models.requestModels({ baseUrl: 'https://api.example.test/v1', apiKey: 'k' });
  assert.strictEqual(modelPayload.ok, true);
  const chatPayload = await fallback.chat.requestJson({ url: 'https://api.example.test/v1/chat/completions', baseUrl: 'https://api.example.test/v1', payload: { a: 1 } });
  assert.strictEqual(chatPayload.ok, true);
  assert.ok(calls.some(call => call.url === '/api/models'), 'model request delegates through shared model service');
  assert.ok(calls.some(call => call.url === '/api/chat/completions'), 'chat request delegates through shared chat service');
  console.log('services composition adapter ok');
})().catch(err => {
  console.error(err);
  process.exit(1);
});
