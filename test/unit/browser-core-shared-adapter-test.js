#!/usr/bin/env node
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const root = path.resolve(__dirname, '../..');
const browserCore = fs.readFileSync(path.join(root, 'client/core/browser.js'), 'utf8');

assert.ok(browserCore.includes('ChatUICoreHttp'), 'browser core should reuse shared http module');
assert.ok(browserCore.includes('ChatUICoreReasoning'), 'browser core should reuse shared reasoning module');
assert.ok(browserCore.includes('ChatUICoreModels'), 'browser core should reuse shared models module');
assert.ok(browserCore.includes('ChatUICoreImageReferences'), 'browser core should reuse shared image references module');
assert.ok(browserCore.includes('ChatUICoreImageRouteContext'), 'browser core should reuse shared image route context module');
assert.ok(browserCore.includes('ChatUICoreAttachments'), 'browser core should reuse shared attachments module');

const context = { window: {} };
context.window.window = context.window;
vm.createContext(context);
for (const file of ['client/core/http.js', 'client/core/reasoning.js', 'client/core/models.js', 'client/core/image-references.js', 'client/core/image-route-context.js', 'client/core/attachments.js', 'client/core/browser.js']) {
  vm.runInContext(fs.readFileSync(path.join(root, file), 'utf8'), context, { filename: file });
}

assert.strictEqual(context.window.ChatUICore.http, context.window.ChatUICoreHttp);
assert.strictEqual(context.window.ChatUICore.reasoning, context.window.ChatUICoreReasoning);
assert.strictEqual(context.window.ChatUICore.models.normalizeModelType, context.window.ChatUICoreModels.normalizeModelType);
assert.strictEqual(context.window.ChatUICore.imageReferences, context.window.ChatUICoreImageReferences);
assert.strictEqual(context.window.ChatUICore.imageRouteContext, context.window.ChatUICoreImageRouteContext);
assert.strictEqual(context.window.ChatUICore.attachments, context.window.ChatUICoreAttachments);
assert.strictEqual(context.window.ChatUICore.http.normalizeError(null, { error: { code: 'X' } }), 'X');
assert.strictEqual(context.window.ChatUICore.reasoning.extractStreamDelta({ choices: [{ delta: { content: 'hi', reasoning_content: 'why' } }] }).reasoning, 'why');
assert.strictEqual(context.window.ChatUICore.models.normalizeModelType('gpt-image'), 'image');

console.log('browser core shared adapter ok');
