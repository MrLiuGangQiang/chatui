#!/usr/bin/env node
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const root = path.resolve(__dirname, '../..');
const browserServicesPath = path.join(root, 'client/services/browser.js');
const browserServices = fs.readFileSync(browserServicesPath, 'utf8');

assert.ok(browserServices.includes('window.ChatUIServicesFallback'), 'browser services adapter uses fallback namespace');
assert.ok(!browserServices.includes('ROUTE_SYSTEM_PROMPT ='), 'route prompt is not duplicated in browser adapter');
assert.ok(!browserServices.includes('function requestModels'), 'model service logic is not duplicated in browser adapter');
assert.ok(!browserServices.includes('function extractChatJobText'), 'chat service logic is not duplicated in browser adapter');

const fallback = {
  models: { requestModels: () => 'models' },
  jobs: { makeClientChatJobId: () => 'chatjob-test' },
  chat: { extractChatJobText: data => ({ content: data.output_text || '' }) },
  route: { parseRouteResult: () => ({ target: 'new' }) },
  images: { buildImagePromptWithStylePrompt: (prompt, style) => `${prompt}:${style}` },
};
const context = { window: { ChatUIServicesFallback: fallback } };
vm.createContext(context);
vm.runInContext(browserServices, context, { filename: browserServicesPath });

assert.strictEqual(context.window.ChatUIServices.models.requestModels(), 'models');
assert.strictEqual(context.window.ChatUIServices.jobs.makeClientChatJobId(), 'chatjob-test');
assert.strictEqual(context.window.ChatUIServices.chat.extractChatJobText({ output_text: 'ok' }).content, 'ok');
assert.strictEqual(context.window.ChatUIServices.route.parseRouteResult('image').target, 'new');
assert.strictEqual(context.window.ChatUIServices.images.buildImagePromptWithStylePrompt('猫', '水彩'), '猫:水彩');

const existing = { custom: { ok: true }, models: { requestModels: () => 'current' } };
const contextWithCurrent = { window: { ChatUIServices: existing, ChatUIServicesFallback: fallback } };
vm.createContext(contextWithCurrent);
vm.runInContext(browserServices, contextWithCurrent, { filename: browserServicesPath });
assert.strictEqual(contextWithCurrent.window.ChatUIServices.custom.ok, true);
assert.strictEqual(contextWithCurrent.window.ChatUIServices.models.requestModels(), 'current');
assert.strictEqual(contextWithCurrent.window.ChatUIServices.jobs.makeClientChatJobId(), 'chatjob-test');

console.log('browser services bundle ok');
