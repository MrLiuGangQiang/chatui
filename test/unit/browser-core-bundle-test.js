#!/usr/bin/env node
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const root = path.resolve(__dirname, '../..');
const coreFiles = [
  'client/core/http.js',
  'client/core/reasoning.js',
  'client/core/models.js',
  'client/core/image-references.js',
  'client/core/image-route-context.js',
  'client/core/attachments.js',
  'client/core/browser.js',
];

const context = { window: {} };
context.window.window = context.window;
vm.createContext(context);
for (const file of coreFiles) {
  vm.runInContext(fs.readFileSync(path.join(root, file), 'utf8'), context, { filename: file });
}

const core = context.window.ChatUICore;
assert.ok(core, 'browser core namespace exists');
assert.strictEqual(core.http, context.window.ChatUICoreHttp, 'browser core reuses shared http module');
assert.strictEqual(core.reasoning, context.window.ChatUICoreReasoning, 'browser core reuses shared reasoning module');
assert.strictEqual(core.models.normalizeModelType, context.window.ChatUICoreModels.normalizeModelType, 'browser core reuses shared model normalization');
assert.ok(core.http?.normalizeError, 'http helpers are exported');
assert.ok(core.reasoning?.extractStreamDelta, 'reasoning helpers are exported');
assert.ok(core.models?.extractModels, 'model helpers are exported');
assert.ok(core.imageReferences?.makeImageReferenceId, 'image reference helpers are exported');
assert.ok(core.imageRouteContext?.buildRouteContext, 'image route context helpers are exported');
assert.ok(core.attachments?.isImageFile, 'attachment helpers are exported');

assert.strictEqual(core.http.normalizeError(null, { error: { code: 'X' } }), 'X');
assert.strictEqual(core.reasoning.extractStreamDelta({ choices: [{ delta: { content: 'hi', reasoning_content: 'why' } }] }).reasoning, 'why');
assert.strictEqual(core.models.normalizeModelType('gpt-image'), 'image');
assert.strictEqual(core.models.inferModelType({ id: 'text-embedding-3-large' }), 'embedding');
assert.strictEqual(JSON.stringify(core.models.extractModels({ data: [{ id: 'b', type: 'chat' }, { id: 'a', type: 'image' }] }).models), '["a","b"]');
assert.strictEqual(core.models.isModelAllowedFor('gpt-image-2', 'image', { 'gpt-image-2': { type: 'image_generation' } }), true);
assert.strictEqual(core.models.isModelAllowedFor('gpt-image-2', 'chat', { 'gpt-image-2': { type: 'image_generation' } }), false);
assert.strictEqual(core.attachments.isImageFile({ name: 'a.png', type: '' }), true);
assert.strictEqual(core.attachments.isCompressibleRasterImage({ name: 'a.svg', type: 'image/svg+xml' }), false);
assert.strictEqual(core.imageReferences, context.window.ChatUICoreImageReferences, 'browser core reuses shared image references module');
assert.strictEqual(core.imageRouteContext, context.window.ChatUICoreImageRouteContext, 'browser core reuses shared image route context module');
assert.strictEqual(core.attachments, context.window.ChatUICoreAttachments, 'browser core reuses shared attachments module');
assert.strictEqual(core.imageReferences.makeImageReferenceId('display 1'), 'imgref_display_1');
assert.strictEqual(core.imageReferences.makeImageItemId('latest', 2), 'img_imgref_latest_2');

const refs = core.imageRouteContext.collectRecentImageReferences({
  display: [{ id: 'd1', role: 'assistant', rawText: '一只猫', html: '<img data-persisted-src="indexeddb://x" data-filename="x.png" />' }],
});
assert.strictEqual(refs.length, 1);
assert.strictEqual(refs[0].reference_id, 'imgref_d1');
assert.strictEqual(refs[0].candidates[0].image_id, 'img_imgref_d1_1');
assert.strictEqual(
  core.imageRouteContext.routeContextSize(core.imageRouteContext.buildRouteContext({
    messages: Array.from({ length: 200 }, (_, i) => ({ role: 'user', content: 'x'.repeat(2000) + i })),
    maxChars: 262144,
  })) <= 262144,
  true,
);

console.log('browser core bundle ok');
