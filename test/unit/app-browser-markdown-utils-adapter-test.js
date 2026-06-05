#!/usr/bin/env node
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const root = path.resolve(__dirname, '../..');
const markdownUtilsPath = path.join(root, 'client/app/markdown-utils.js');
const browserAppPath = path.join(root, 'client/app/browser.js');
const markdownUtils = fs.readFileSync(markdownUtilsPath, 'utf8');
const browserApp = fs.readFileSync(browserAppPath, 'utf8');

assert.ok(!browserApp.includes('function extractMathSegments'), 'browser app must not duplicate markdown math extraction');
assert.ok(!browserApp.includes('function normalizeExtendedMarkdown'), 'browser app must not duplicate extended markdown normalization');
assert.ok(!browserApp.includes('function renderMarkdownLegacy'), 'browser app must not duplicate legacy markdown fallback');
assert.ok(!browserApp.includes('function renderLists'), 'browser app must not duplicate markdown list parser');
assert.ok(!browserApp.includes('function renderTables'), 'browser app must not duplicate markdown table parser');
assert.ok(browserApp.includes('window.ChatUIAppMarkdownUtils'), 'browser app should mount shared markdown utils');

const context = { window: {}, AbortController };
vm.createContext(context);
vm.runInContext(markdownUtils, context, { filename: markdownUtilsPath });
vm.runInContext(browserApp, context, { filename: browserAppPath });

assert.strictEqual(context.window.ChatUIApp.markdownUtils, context.window.ChatUIAppMarkdownUtils, 'browser app reuses shared markdown utils object');
assert.strictEqual(context.window.ChatUIApp.markdownUtils.renderMarkdownPlainTextFallback('**b**'), '<p>**b**</p>');
assert.strictEqual(context.window.ChatUIApp.markdownUtils.slugifyHeading('Hello, ChatUI!'), 'hello-chatui');
assert.strictEqual(context.window.ChatUIApp.markdownUtils.renderMarkdownLegacy, undefined);
assert.strictEqual(context.window.ChatUIApp.markdownUtils.renderLists, undefined);
assert.strictEqual(context.window.ChatUIApp.markdownUtils.renderTables, undefined);
assert.strictEqual(context.window.ChatUIApp.markdownUtils.extractMathSegments, undefined);
assert.strictEqual(context.window.ChatUIApp.markdownUtils.normalizeExtendedMarkdown, undefined);
console.log('app browser markdown utils adapter ok');
