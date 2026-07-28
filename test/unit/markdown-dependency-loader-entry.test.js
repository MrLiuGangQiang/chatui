'use strict';

const assert = require('assert');
const fs = require('fs');
const path = require('path');

const projectRoot = path.resolve(__dirname, '..', '..');

function testMarkdownBrowserDependencyLoaderIsTheOnlySupportedEntry() {
  const markdownEngine = require('../../client/app/markdown/markdown-engine');
  const dependencyLoader = require('../../client/app/markdown/dependency-loader');
  const indexHtml = fs.readFileSync(path.join(projectRoot, 'index.html'), 'utf8');

  assert.strictEqual(typeof markdownEngine.createMarkdownEngine, 'function', 'the directly consumed CommonJS markdown engine should remain available');
  assert.strictEqual(typeof dependencyLoader.createBrowserLoader, 'function', 'the browser dependency loader should remain directly testable');
  assert.match(indexHtml, /client\/app\/markdown\/dependency-loader\.js/, 'the browser entry should load the browser dependency loader');
  assert.strictEqual(fs.existsSync(path.join(projectRoot, 'client', 'app', 'markdown', 'index.js')), false, 'the unused markdown aggregate entry should stay removed');
  assert.doesNotMatch(indexHtml, /resource-loader\.js/, 'the browser entry should not reference the retired CommonJS loader');
  assert.strictEqual(fs.existsSync(path.join(projectRoot, 'client', 'app', 'markdown', 'resource-loader.js')), false, 'the retired CommonJS loader should stay removed');
}

module.exports = [
  testMarkdownBrowserDependencyLoaderIsTheOnlySupportedEntry,
];
