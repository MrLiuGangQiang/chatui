'use strict';

const assert = require('assert');
const fs = require('fs');
const path = require('path');

const projectRoot = path.resolve(__dirname, '..', '..');

function testMarkdownBrowserDependencyLoaderIsTheOnlySupportedEntry() {
  const markdown = require('../../client/app/markdown');
  const indexHtml = fs.readFileSync(path.join(projectRoot, 'index.html'), 'utf8');

  assert.ok(markdown.createMarkdownRenderer, 'the markdown public API should remain available');
  assert.ok(!Object.hasOwn(markdown, 'dependencyLoader'), 'the unused CommonJS dependency loader should not remain part of the public API');
  assert.match(indexHtml, /client\/app\/markdown\/dependency-loader\.js/, 'the browser entry should load the browser dependency loader');
  assert.doesNotMatch(indexHtml, /resource-loader\.js/, 'the browser entry should not reference the retired CommonJS loader');
  assert.strictEqual(fs.existsSync(path.join(projectRoot, 'client', 'app', 'markdown', 'resource-loader.js')), false, 'the retired CommonJS loader should stay removed');
}

module.exports = [
  testMarkdownBrowserDependencyLoaderIsTheOnlySupportedEntry,
];
