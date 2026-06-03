#!/usr/bin/env node
const assert = require('assert');
const fs = require('fs');
const path = require('path');

const root = path.resolve(__dirname, '../..');
const appJs = fs.readFileSync(path.join(root, 'app.js'), 'utf8');
const indexHtml = fs.readFileSync(path.join(root, 'index.html'), 'utf8');
const browserMarkdown = fs.readFileSync(path.join(root, 'client/app/markdown/browser.js'), 'utf8');
const dependencyLoader = fs.readFileSync(path.join(root, 'client/app/markdown/dependency-loader.js'), 'utf8');

assert.ok(indexHtml.includes('client/app/markdown/dependency-loader.js'), 'dependency loader is loaded');
assert.ok(indexHtml.includes('client/app/markdown/browser.js'), 'browser renderer is loaded');
assert.ok(indexHtml.indexOf('client/app/markdown/dependency-loader.js') < indexHtml.indexOf('client/app/markdown/browser.js'), 'dependency loader loads before browser renderer');
assert.ok(!indexHtml.includes('cdn.jsdelivr.net/npm/markdown-it@14.2.0'), 'old hard-coded markdown-it CDN script removed from index');
assert.ok(dependencyLoader.includes('registry.npmmirror.com/markdown-it/14.2.0'), 'loader owns markdown-it domestic CDN');
assert.ok(dependencyLoader.includes("local: './vendor/markdown-it.min.js'"), 'loader owns markdown-it local fallback');
assert.ok(dependencyLoader.includes('registry.npmmirror.com/dompurify/3.4.7'), 'loader owns DOMPurify CDN/fallback');

assert.match(appJs, /function renderMarkdown\(e\)\{[^}]*window\.ChatUIApp\?\.markdown\?\.renderMarkdown/, 'main assistant markdown path uses new renderer API');
assert.match(appJs, /renderMarkdownLegacy\?window\.ChatUIApp\.markdownUtils\.renderMarkdownLegacy/, 'legacy renderer remains only as emergency fallback');
assert.match(appJs, /"user"===e\?renderUserMessageContent\(String\(t\|\|""\)\):renderMarkdown\(String\(t\|\|""\)\)/, 'addMessage keeps user plain and assistant markdown');
assert.match(appJs, /e\.classList\?\.contains\("user"\)\?renderUserMessageContent\(String\(t\|\|""\)\):renderMarkdown\(String\(t\|\|""\)\)/, 'updateMessage keeps user plain and assistant final markdown');
assert.match(appJs, /renderMessageFromCanonical\([\s\S]*addMessage\("assistant"===t\.role\?"assistant":"user",o/, 'history restore uses addMessage path');

assert.ok(browserMarkdown.includes('renderMarkdownInto'), 'browser markdown API exposes renderMarkdownInto');
assert.match(browserMarkdown, /async function loadMermaid\(\)/, 'browser runtime defines default mermaid loader');
assert.match(browserMarkdown, /renderMermaidBlocks\(root, loader = loadMermaid, options = \{\}\)/, 'browser mermaid renderer uses the default loader when none is injected and accepts render options');
assert.ok(browserMarkdown.includes('enhanceCodeCopy'), 'browser renderer enhances code copy');
assert.ok(browserMarkdown.includes('markdown-mermaid-pending'), 'browser renderer keeps mermaid placeholder');

console.log('markdown v2 app contract ok');
