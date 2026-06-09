#!/usr/bin/env node
const assert = require('assert');
const { JSDOM } = require('jsdom');
const { createConfigWorkflow } = require('../../client/app/config-workflow');

const dom = new JSDOM(`<!doctype html><body>
<input id="baseUrl"><input id="apiKey"><select id="imageSize"><option value="auto">auto</option></select>
<textarea id="systemPrompt"></textarea><textarea id="imageStylePrompt"></textarea>
<select id="chatModel"><option value="m1">m1</option></select><select id="routeModel"><option value="m1">m1</option></select><select id="imageModel"><option value="m1">m1</option></select>
<div id="configModal"><div class="config-dialog"></div></div>
</body>`);
const { document } = dom.window;
const storage = new Map();
const state = { activeSessionId: 's1', sessions: [{ id: 's1' }], models: [], modelMeta: {} };
const workflow = createConfigWorkflow({
  state,
  getElement: id => document.getElementById(id),
  localStorage: { getItem: k => storage.get(k) || null, setItem: (k, v) => storage.set(k, v), removeItem: k => storage.delete(k) },
  document,
  window: { matchMedia: () => ({ matches: true }), visualViewport: { width: 800, height: 600 }, innerWidth: 800, innerHeight: 600, ChatUIApp: { headerParams: {} } },
  crypto: { getRandomValues: arr => { arr.fill(1); return arr; } },
  setTimeout: cb => { cb(); return 1; },
  CONFIG_KEY: 'cfg',
  renderModelOptions: () => {},
  updateCustomSelect: () => {},
  enhanceConfigSelects: () => {},
  closeAllCustomSelects: () => {},
  getActiveSession: () => state.sessions[0],
  saveSessionsMeta: () => {},
  toast: () => {},
});

storage.set('cfg', JSON.stringify({ baseUrl: 'http://x/', apiKey: 'k', models: ['m1'], chatModel: 'm1', routeModel: 'm1', imageModel: 'm1', headerParams: [{ name: 'X-Trace', mode: 'session_short_uuid', value: '' }] }));
workflow.loadConfig();
assert.strictEqual(document.getElementById('baseUrl').value, 'http://x/');
assert.strictEqual(workflow.getConfig().baseUrl, 'http://x');
const headers1 = workflow.buildRequestHeaders();
const headers2 = workflow.buildRequestHeaders();
assert.strictEqual(headers1['X-Trace'], headers2['X-Trace']);
workflow.openConfigModal();
assert.ok(document.body.classList.contains('modal-open'));
workflow.closeConfigModal();
assert.ok(!document.body.classList.contains('modal-open'));
console.log('app config workflow ok');
