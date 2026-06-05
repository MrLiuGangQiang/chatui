#!/usr/bin/env node
const assert = require('assert');
const fs = require('fs');
const path = require('path');

const root = path.resolve(__dirname, '../..');
const appJs = fs.readFileSync(path.join(root, 'app.js'), 'utf8');
const indexHtml = fs.readFileSync(path.join(root, 'index.html'), 'utf8');
const browserMarkdown = fs.readFileSync(path.join(root, 'client/app/markdown/browser.js'), 'utf8');
const messageWorkflow = fs.readFileSync(path.join(root, 'client/app/message-workflow.js'), 'utf8');
const displayHistoryWorkflow = fs.readFileSync(path.join(root, 'client/app/display-history-workflow.js'), 'utf8');
const enhancer = fs.readFileSync(path.join(root, 'client/app/markdown/enhancer.js'), 'utf8');
const browserEnhancer = fs.readFileSync(path.join(root, 'client/app/markdown/browser-enhancer.js'), 'utf8');
const browserStreaming = fs.readFileSync(path.join(root, 'client/app/markdown/browser-streaming-renderer.js'), 'utf8');
const dependencyLoader = fs.readFileSync(path.join(root, 'client/app/markdown/dependency-loader.js'), 'utf8');

assert.ok(indexHtml.includes('client/app/markdown/dependency-loader.js'), 'dependency loader is loaded');
assert.ok(indexHtml.includes('client/app/markdown/source-normalizer.js'), 'source normalizer is loaded');
assert.ok(indexHtml.includes('client/app/markdown/link-policy.js'), 'link policy is loaded');
assert.ok(indexHtml.includes('client/app/markdown/mermaid-normalizer.js'), 'mermaid normalizer is loaded');
assert.ok(indexHtml.includes('client/app/markdown/browser-sanitizer.js'), 'browser sanitizer adapter is loaded');
assert.ok(indexHtml.includes('client/app/markdown/browser-engine.js'), 'browser engine adapter is loaded');
assert.ok(indexHtml.includes('client/app/markdown/enhancer.js'), 'shared markdown enhancer is loaded');
assert.ok(indexHtml.includes('client/app/markdown/browser-enhancer.js'), 'browser enhancer adapter is loaded');
assert.ok(indexHtml.includes('client/app/markdown/browser-streaming-renderer.js'), 'browser streaming renderer adapter is loaded');
assert.ok(indexHtml.includes('client/app/markdown/browser.js'), 'browser renderer is loaded');
assert.ok(indexHtml.indexOf('client/app/markdown/dependency-loader.js') < indexHtml.indexOf('client/app/markdown/browser.js'), 'dependency loader loads before browser renderer');
assert.ok(indexHtml.indexOf('client/app/markdown/browser-sanitizer.js') < indexHtml.indexOf('client/app/markdown/browser-engine.js'), 'browser sanitizer loads before browser engine');
assert.ok(indexHtml.indexOf('client/app/markdown/browser-engine.js') < indexHtml.indexOf('client/app/markdown/browser.js'), 'browser engine loads before browser renderer');
assert.ok(indexHtml.indexOf('client/app/markdown/enhancer.js') < indexHtml.indexOf('client/app/markdown/browser-enhancer.js'), 'shared enhancer loads before browser enhancer adapter');
assert.ok(indexHtml.indexOf('client/app/markdown/browser-enhancer.js') < indexHtml.indexOf('client/app/markdown/browser.js'), 'browser enhancer loads before browser renderer');
assert.ok(indexHtml.indexOf('client/app/markdown/browser-streaming-renderer.js') < indexHtml.indexOf('client/app/markdown/browser.js'), 'browser streaming renderer loads before browser renderer');
assert.ok(!indexHtml.includes('cdn.jsdelivr.net/npm/markdown-it@14.2.0'), 'old hard-coded markdown-it CDN script removed from index');
assert.ok(dependencyLoader.includes('registry.npmmirror.com/markdown-it/14.2.0'), 'loader owns markdown-it domestic CDN');
assert.ok(dependencyLoader.includes("local: './vendor/markdown-it.min.js'"), 'loader owns markdown-it local fallback');
assert.ok(dependencyLoader.includes('registry.npmmirror.com/dompurify/3.4.7'), 'loader owns DOMPurify CDN/fallback');

assert.match(appJs, /function renderMarkdown\(e\)\{[^}]*window\.ChatUIApp\?\.markdown\?\.renderMarkdown/, 'main assistant markdown path uses new renderer API');
assert.ok(!/renderMarkdownLegacy\?window\.ChatUIApp\.markdownUtils\.renderMarkdownLegacy/.test(appJs), 'main fallback no longer uses hand-written legacy markdown parser');
assert.match(messageWorkflow, /"user"===e\?renderUserMessageContent\(String\(t\|\|""\)\):renderMarkdown\(String\(t\|\|""\)\)/, 'addMessage keeps user plain and assistant markdown');
assert.match(messageWorkflow, /e\.classList\?\.contains\("user"\)\?renderUserMessageContent\(String\(t\|\|""\)\):renderMarkdown\(String\(t\|\|""\)\)/, 'updateMessage keeps user plain and assistant final markdown');
assert.match(appJs, /function addMessage\([^)]*\)\{return getMessageWorkflow\(\)\.addMessage\(e,t,s\)\}/, 'app addMessage is a thin adapter');
assert.match(appJs, /function updateMessage\([^)]*\)\{return getMessageWorkflow\(\)\.updateMessage\(e,t,s\)\}/, 'app updateMessage is a thin adapter');
assert.match(displayHistoryWorkflow, /renderMessageFromCanonical\([\s\S]*addMessage\("assistant"===t\.role\?"assistant":"user",o/, 'history restore uses addMessage path');
assert.match(appJs, /function renderMessageFromCanonical\([^)]*\)\{return getDisplayHistoryWorkflow\(\)\.renderMessageFromCanonical\(e,t,s\)\}/, 'app renderMessageFromCanonical is a thin adapter');

assert.ok(browserMarkdown.includes('renderMarkdownInto'), 'browser markdown API exposes renderMarkdownInto');
assert.match(enhancer, /async function defaultLoadMermaid\(\)/, 'shared enhancer defines default mermaid loader');
assert.match(enhancer, /renderMermaidBlocks\(root, loader = defaultLoadMermaid, options = \{\}\)/, 'shared mermaid renderer uses the default loader when none is injected and accepts render options');
assert.ok(browserMarkdown.includes('enhanceCodeCopy'), 'browser renderer enhances code copy');
assert.ok(enhancer.includes('enhanceCodeCopy'), 'shared enhancer owns code copy');
assert.ok(enhancer.includes('markdown-mermaid-pending'), 'shared enhancer keeps mermaid placeholder');
assert.ok(browserEnhancer.includes('ChatUIMarkdownEnhancer'), 'browser enhancer adapter delegates to shared enhancer');
assert.ok(!browserEnhancer.includes('function enhanceCodeCopy'), 'browser enhancer adapter does not duplicate code copy');
assert.ok(browserStreaming.includes('createStreamingRenderer'), 'browser streaming module owns streaming renderer');
assert.ok(browserMarkdown.includes('ChatUIMarkdownBrowserStreamingRenderer'), 'browser renderer uses streaming module');

console.log('markdown v2 app contract ok');
