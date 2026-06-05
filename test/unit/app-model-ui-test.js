#!/usr/bin/env node
const assert = require('assert');
const { JSDOM } = require('jsdom');
const { modelOptionHtml, setSelectValue, renderModelOptions, createModelUiController } = require('../../client/app/model-ui');

assert.strictEqual(modelOptionHtml('gpt-4', { escapeHtml: value => value, modelMeta: {} }), '<option value="gpt-4" data-unrecognized="0">gpt-4</option>');
assert.strictEqual(modelOptionHtml('x', { escapeHtml: value => value, modelMeta: { x: { unrecognized: true } } }), '<option value="x" data-unrecognized="1">x（未知类型）</option>');

const dom = new JSDOM('<select id="chatModel"></select><select id="routeModel"></select><select id="imageModel"></select><button id="loadModelsBtn"></button><span id="modelLoadStatus"></span>');
const document = dom.window.document;
const getElement = id => document.getElementById(id);
let refreshed = [];
let updated = [];
const state = { models: ['gpt-4', 'gpt-image-1'], modelMeta: { 'gpt-4': { type: 'chat' }, 'gpt-image-1': { type: 'image' } } };
renderModelOptions({
  models: state.models,
  modelMeta: state.modelMeta,
  values: { chatModel: 'gpt-4', imageModel: 'gpt-image-1' },
  getElement,
  isModelAllowedFor: (model, type) => state.modelMeta[model]?.type === type,
  escapeHtml: value => String(value),
  updateCustomSelect: select => updated.push(select.id),
  refreshCustomSelectOptions: select => refreshed.push(select.id),
});
assert.strictEqual(getElement('chatModel').value, 'gpt-4');
assert.strictEqual(getElement('imageModel').value, 'gpt-image-1');
assert.strictEqual(getElement('routeModel').querySelectorAll('option').length, 2);
assert.deepStrictEqual(refreshed, ['chatModel', 'routeModel', 'imageModel']);

setSelectValue(getElement('chatModel'), 'missing', () => {});
assert.strictEqual(getElement('chatModel').value, '');

let sessionRendered = false;
let saved = false;
const controller = createModelUiController({
  getState: () => state,
  getElement,
  escapeHtml: value => String(value),
  isModelAllowedFor: (model, type) => state.modelMeta[model]?.type === type,
  updateCustomSelect: () => {},
  refreshCustomSelectOptions: () => {},
  requestModels: async () => ({ data: [{ id: 'gpt-4', type: 'chat' }, { id: 'gpt-image-1', type: 'image' }] }),
  extractModels: () => ({ models: ['gpt-4', 'gpt-image-1'], meta: state.modelMeta }),
  renderSessionModelArea: () => { sessionRendered = true; },
  saveConfig: value => { saved = value; },
});
(async () => {
  await controller.loadModels();
  assert.strictEqual(getElement('loadModelsBtn').disabled, false);
  assert.strictEqual(getElement('modelLoadStatus').textContent, '已加载 2 个');
  assert.strictEqual(sessionRendered, true);
  assert.strictEqual(saved, true);
  console.log('app model ui ok');
})().catch(err => { console.error(err); process.exit(1); });
