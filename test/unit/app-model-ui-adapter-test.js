#!/usr/bin/env node
const assert = require('assert');
const fs = require('fs');
const path = require('path');

const root = path.resolve(__dirname, '../..');
const appJs = fs.readFileSync(path.join(root, 'app.js'), 'utf8');
const indexHtml = fs.readFileSync(path.join(root, 'index.html'), 'utf8');
const modelUi = fs.readFileSync(path.join(root, 'client/app/model-ui.js'), 'utf8');

function extractFunctionSource(name) {
  const start = appJs.indexOf(`function ${name}(`);
  assert.ok(start >= 0, `${name} exists`);
  const bodyStart = appJs.indexOf('{', start);
  let depth = 0;
  for (let i = bodyStart; i < appJs.length; i += 1) {
    if (appJs[i] === '{') depth += 1;
    else if (appJs[i] === '}') {
      depth -= 1;
      if (depth === 0) return appJs.slice(start, i + 1);
    }
  }
  throw new Error(`failed to extract ${name}`);
}

function extractAsyncFunctionSource(name) {
  const marker = `async function ${name}(`;
  const start = appJs.indexOf(marker);
  assert.ok(start >= 0, `${name} exists`);
  const bodyStart = appJs.indexOf('{', start);
  let depth = 0;
  for (let i = bodyStart; i < appJs.length; i += 1) {
    if (appJs[i] === '{') depth += 1;
    else if (appJs[i] === '}') {
      depth -= 1;
      if (depth === 0) return appJs.slice(start, i + 1);
    }
  }
  throw new Error(`failed to extract ${name}`);
}

assert.ok(indexHtml.includes('client/app/model-ui.js'), 'model ui shared module is loaded');
assert.ok(indexHtml.indexOf('client/app/model-ui.js') < indexHtml.indexOf('./app.js'), 'model ui loads before app.js');
assert.ok(modelUi.includes('createModelUiController'), 'model ui owns controller implementation');
assert.ok(appJs.includes('function getModelUiController()'), 'app.js keeps model ui controller adapter');

const renderModelOptions = extractFunctionSource('renderModelOptions');
const loadModels = extractAsyncFunctionSource('loadModels');
const modelOptionHtml = extractFunctionSource('modelOptionHtml');
const setSelectValue = extractFunctionSource('setSelectValue');

assert.ok(renderModelOptions.includes('return getModelUiController().renderModelOptions('), 'app renderModelOptions delegates only to model ui controller');
assert.ok(loadModels.includes('return getModelUiController().loadModels()'), 'app loadModels delegates only to model ui controller');
assert.ok(modelOptionHtml.includes('window.ChatUIAppModelUi.modelOptionHtml'), 'app modelOptionHtml delegates to shared module without fallback');
assert.ok(setSelectValue.includes('window.ChatUIAppModelUi.setSelectValue'), 'app setSelectValue delegates to shared module without fallback');
assert.ok(!renderModelOptions.includes('请选择模型'), 'app renderModelOptions no longer keeps option rendering fallback');
assert.ok(!loadModels.includes('未从 /models 返回中识别到模型列表'), 'app loadModels no longer keeps model loading fallback');

console.log('app model ui adapter ok');
