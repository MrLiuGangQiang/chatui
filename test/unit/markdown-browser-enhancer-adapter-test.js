#!/usr/bin/env node
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const root = path.resolve(__dirname, '../..');
const browserEnhancerPath = path.join(root, 'client/app/markdown/browser-enhancer.js');
const source = fs.readFileSync(browserEnhancerPath, 'utf8');

assert.ok(source.includes('ChatUIMarkdownEnhancer'), 'browser enhancer adapter reads shared enhancer');
assert.ok(source.includes('window.ChatUIMarkdownBrowserEnhancer'), 'browser enhancer adapter keeps stable namespace marker');
assert.ok(!source.includes('function enhanceCodeCopy'), 'browser enhancer adapter does not duplicate code copy logic');
assert.ok(!source.includes('function renderMermaidBlockOnDemand'), 'browser enhancer adapter does not duplicate mermaid render logic');
assert.ok(!source.includes('MERMAID_RENDER_ICON_SVG'), 'browser enhancer adapter does not duplicate mermaid icons');
assert.ok(!source.includes('COPY_SUCCESS_ICON_SVG'), 'browser enhancer adapter does not duplicate copy icons');

const shared = {
  enhanceCodeCopy: () => 'copy',
  renderMermaidBlockOnDemand: () => 'mermaid',
  defaultLoadMermaid: () => 'loader',
  isElementVisible: () => true,
};
const context = { window: { ChatUIMarkdownEnhancer: shared } };
context.globalThis = context;
vm.createContext(context);
vm.runInContext(source, context, { filename: browserEnhancerPath });

assert.strictEqual(context.window.ChatUIMarkdownBrowserEnhancer.enhanceCodeCopy(), 'copy');
assert.strictEqual(context.window.ChatUIMarkdownBrowserEnhancer.renderMermaidBlockOnDemand(), 'mermaid');
assert.strictEqual(context.window.ChatUIMarkdownBrowserEnhancer.loadMermaid(), 'loader');
assert.strictEqual(context.window.ChatUIMarkdownBrowserEnhancer.isVisible(), true);

console.log('markdown browser enhancer adapter ok');
