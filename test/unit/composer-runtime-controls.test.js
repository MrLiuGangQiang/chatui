'use strict';

const assert = require('assert');
const fs = require('fs');
const path = require('path');
const { JSDOM } = require('jsdom');
const { createSessionUiWorkflow } = require('../../client/app/session-ui-workflow');
const { createReasoningWorkflow } = require('../../client/app/reasoning-workflow');
const { createConfigWorkflow } = require('../../client/app/config-workflow');
const sessionConfig = require('../../client/app/session-config');

const root = path.join(__dirname, '..', '..');

function testComposerShowsRuntimeSwitcherBesideSendButton() {
  const html = fs.readFileSync(path.join(root, 'index.html'), 'utf8');
  const dom = new JSDOM(html);
  const document = dom.window.document;
  const right = document.querySelector('#composer .composer-action-right');

  assert.ok(right, 'the composer must expose a right-side action group');
  assert.ok(right.querySelector('#sessionModelBtn'), 'the session model segment must sit beside the send button');
  assert.ok(right.querySelector('#reasoningMenuBtn'), 'the reasoning segment must sit beside the send button');
  assert.ok(right.querySelector('#sendBtn'), 'the send button must belong to the same right-side action group');
  assert.strictEqual(document.querySelector('.composer-action-left #sessionModelBtn'), null, 'the model control must leave the left tool group');
  assert.ok(document.getElementById('sessionModelLabel'), 'the current session model must be visible without opening a menu');
  assert.ok(document.getElementById('reasoningTypeLabel'), 'the current reasoning effort must be visible without opening a menu');
  assert.ok(document.querySelector('[data-reasoning-type="none"]'), 'the reasoning menu must allow turning thinking off');

  const composerCss = fs.readFileSync(path.join(root, 'styles', 'composer.css'), 'utf8');
  assert.ok(composerCss.includes('.composer-action-right'), 'the right-side group must have an explicit layout contract');
  assert.ok(composerCss.includes('.composer-runtime-switch'), 'the model and reasoning segments must render as one visual switch');
}

function testSessionModelLabelShowsEffectiveModelForCurrentSession() {
  const dom = new JSDOM(`
    <button id="sessionModelBtn"><span id="sessionModelLabel"></span></button>
    <div id="sessionModelPanel"></div>
  `);
  const document = dom.window.document;
  const state = { models: ['gpt-5.2', 'gpt-5-mini'] };
  const session = { chatModel: '' };
  const config = { chatModel: 'gpt-5.2' };
  const workflow = createSessionUiWorkflow({
    getState: () => state,
    getElement: id => document.getElementById(id),
    document,
    getActiveSession: () => session,
    getConfig: () => config,
    isModelAllowedFor: () => true,
    escapeHtml: value => String(value || ''),
    sessionConfig,
  });

  workflow.renderSessionModelArea();
  assert.strictEqual(document.getElementById('sessionModelLabel').textContent, 'gpt-5.2');
  assert.strictEqual(document.getElementById('sessionModelBtn').dataset.modelSource, 'global');

  session.chatModel = 'gpt-5-mini';
  workflow.renderSessionModelArea();
  assert.strictEqual(document.getElementById('sessionModelLabel').textContent, 'gpt-5-mini');
  assert.strictEqual(document.getElementById('sessionModelBtn').dataset.modelSource, 'session');
  assert.match(document.getElementById('sessionModelBtn').title, /gpt-5-mini/);
}

function testReasoningLabelShowsCurrentEffortAndSupportsOff() {
  const dom = new JSDOM(`
    <button id="reasoningMenuBtn"><span id="reasoningTypeLabel"></span></button>
    <div id="reasoningMenu">
      <button data-reasoning-type="none"></button>
      <button data-reasoning-type="low"></button>
      <button data-reasoning-type="medium"></button>
      <button data-reasoning-type="high"></button>
      <button data-reasoning-type="xhigh"></button>
      <button data-reasoning-type="max"></button>
    </div>
  `);
  const document = dom.window.document;
  const state = { activeSessionId: 'session-a', reasoningMode: true, reasoningType: 'max' };
  const session = { id: 'session-a', reasoningMode: true, reasoningType: 'max' };
  const storage = new Map();
  const workflow = createReasoningWorkflow({
    state,
    $: id => document.getElementById(id),
    document,
    localStorage: { getItem: key => storage.get(key) ?? null, setItem: (key, value) => storage.set(key, String(value)) },
    getActiveSession: () => session,
    saveSessionsMeta: () => {},
    isSessionBusy: () => false,
  });

  workflow.updateReasoningControls();
  assert.strictEqual(document.getElementById('reasoningTypeLabel').textContent, '最高');
  assert.match(document.getElementById('reasoningMenuBtn').title, /max/);

  workflow.setReasoningType('none');
  assert.strictEqual(state.reasoningMode, false);
  assert.strictEqual(state.reasoningType, 'none');
  assert.strictEqual(document.getElementById('reasoningTypeLabel').textContent, '不思考');
  assert.strictEqual(document.querySelector('[data-reasoning-type="none"]').getAttribute('aria-checked'), 'true');
  assert.strictEqual(document.getElementById('reasoningMenuBtn').disabled, false);

  workflow.openReasoningMenu();
  assert.strictEqual(document.getElementById('reasoningMenu').classList.contains('show'), true, 'the effort menu must still open while thinking is off');
  assert.strictEqual(document.getElementById('reasoningMenu').getAttribute('aria-hidden'), 'false');
}

function testSavingGlobalModelRefreshesVisibleSessionModel() {
  const values = {
    baseUrl: 'https://example.test/v1',
    apiKey: '',
    chatModel: 'gpt-5.2',
    routeModel: '',
    imageModel: '',
    imageSize: 'auto',
    systemPrompt: '',
    imageStylePrompt: '',
  };
  const storage = new Map();
  const document = { activeElement: null };
  const localStorage = {
    getItem: key => storage.get(key) ?? null,
    setItem: (key, value) => storage.set(key, String(value)),
    removeItem: key => storage.delete(key),
  };
  let refreshCount = 0;
  const workflow = createConfigWorkflow({
    state: { models: ['gpt-5.2'], modelMeta: {} },
    CONFIG_KEY: 'test-config',
    getElement: id => id === 'configModal' ? { classList: { remove() {} }, setAttribute() {} } : (values[id] !== undefined ? { value: values[id] } : null),
    localStorage,
    sessionStorage: localStorage,
    document,
    window: { setTimeout: () => 0 },
    setTimeout: () => 0,
    renderModelOptions: () => {},
    updateCustomSelect: () => {},
    enhanceConfigSelects: () => {},
    closeAllCustomSelects: () => {},
    saveSessionsMeta: () => {},
    toast: () => {},
    renderSessionModelArea: () => { refreshCount += 1; },
  });

  assert.strictEqual(workflow.saveConfig(true), true);
  assert.strictEqual(refreshCount, 1, 'saving the global chat model must refresh the visible session model label');
}

module.exports = [
  testComposerShowsRuntimeSwitcherBesideSendButton,
  testSessionModelLabelShowsEffectiveModelForCurrentSession,
  testReasoningLabelShowsCurrentEffortAndSupportsOff,
  testSavingGlobalModelRefreshesVisibleSessionModel,
];