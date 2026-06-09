#!/usr/bin/env node
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const root = path.resolve(__dirname, '../..');
const browserApp = fs.readFileSync(path.join(root, 'client/app/browser.js'), 'utf8');

for (const fn of [
  'getEffectiveImageStylePrompt',
  'getSessionChatModel',
  'sessionChatModelValue',
  'sessionModelOptions',
  'normalizeSessionChatModel',
  'normalizeHeaderParamConfig',
  'generateShortUuid',
  'buildRequestHeadersFromParams',
  'formatElapsed',
  'firstTokenTimeText',
  'escapeHtml',
  'escapeAttr',
  'renderStreamingText',
  'pendingFeedbackHtml',
  'isChatStatusText',
]) {
  assert.ok(!browserApp.includes(`function ${fn}`), `browser app must not duplicate ${fn}`);
}

for (const globalName of ['ChatUIAppSessionConfig', 'ChatUIAppFormatting']) {
  assert.ok(browserApp.includes(`window.${globalName}`), `browser app should reuse ${globalName}`);
}
// header-params module removed, so ChatUIAppHeaderParams is no longer expected

const context = { window: {}, AbortController, Date, Math };
vm.createContext(context);
for (const file of [
  'client/app/session-config.js',
  'client/app/formatting.js',
  'client/app/markdown-utils.js',
  'client/app/display-items.js',
  'client/app/persistence.js',
  'client/app/runs.js',
  'client/app/browser.js',
]) {
  vm.runInContext(fs.readFileSync(path.join(root, file), 'utf8'), context, { filename: file });
}

assert.strictEqual(context.window.ChatUIApp.sessionConfig, context.window.ChatUIAppSessionConfig);
assert.strictEqual(context.window.ChatUIApp.formatting, context.window.ChatUIAppFormatting);
assert.strictEqual(context.window.ChatUIApp.formatting.escapeHtml('<x>'), '&lt;x&gt;');
assert.strictEqual(context.window.ChatUIApp.sessionConfig.getSessionChatModel({ session: { chatModel: 'm1' }, config: { chatModel: 'm0' }, models: ['m1'] }), 'm1');

console.log('app browser shared adapters ok');
