'use strict';

const assert = require('assert');
const fs = require('fs');
const path = require('path');
const { createSessionPanelWorkflow } = require('../../client/app/session-panel-workflow');

function createElement(value = '') {
  const classes = new Set();
  const attributes = new Map();
  return {
    value,
    focusCount: 0,
    classList: {
      add(name) { classes.add(name); },
      remove(name) { classes.delete(name); },
      contains(name) { return classes.has(name); },
    },
    setAttribute(name, value) { attributes.set(name, value); },
    getAttribute(name) { return attributes.get(name); },
    focus() { this.focusCount += 1; },
  };
}

function createWorkflowFixture() {
  const elements = {
    sessionPromptInput: createElement('  session prompt  '),
    sessionImageStyleInput: createElement('  image style  '),
    sessionPromptPanel: createElement(),
    sessionImageStylePanel: createElement(),
    sessionModelPanel: createElement(),
    sessionModelBtn: createElement(),
  };
  const session = {};
  const calls = { renderPrompt: 0, renderModel: 0, saveMeta: 0, setModel: [], timers: [] };
  const browserWindow = {
    setTimeout(callback, delay) {
      assert.strictEqual(this, browserWindow, 'timer must retain its browser receiver');
      calls.timers.push(delay);
      callback();
      return calls.timers.length;
    },
  };
  const workflow = createSessionPanelWorkflow({
    $: id => elements[id],
    getActiveSession: () => session,
    getConfig: () => ({ systemPrompt: 'global prompt', imageStylePrompt: 'global style' }),
    getSessionUiWorkflow: () => ({ renderSessionModelArea: () => { calls.renderModel += 1; } }),
    renderSessionPromptArea: () => { calls.renderPrompt += 1; },
    saveSessionsMeta: () => { calls.saveMeta += 1; },
    setSessionChatModel: value => { calls.setModel.push(value); },
    window: browserWindow,
  });
  return { workflow, elements, session, calls };
}

function testSessionPanelWorkflowUsesExplicitDependenciesAndSavesSessionOverrides() {
  const source = fs.readFileSync(path.join(__dirname, '..', '..', 'client', 'app', 'session-panel-workflow.js'), 'utf8');
  assert.ok(!/\bwith\s*\(/.test(source), 'session panel workflow should not use a dynamic with-scope');

  const { workflow, elements, session, calls } = createWorkflowFixture();
  workflow.saveSessionPrompt();
  assert.deepStrictEqual(session, { systemPrompt: 'session prompt', hasSystemPromptOverride: true });
  assert.strictEqual(calls.saveMeta, 1);
  assert.strictEqual(elements.sessionPromptPanel.getAttribute('aria-hidden'), 'true');

  workflow.saveSessionImageStyle();
  assert.deepStrictEqual(session, {
    systemPrompt: 'session prompt',
    hasSystemPromptOverride: true,
    imageStylePrompt: 'image style',
    hasImageStylePromptOverride: true,
  });
  assert.strictEqual(calls.saveMeta, 2);
  workflow.saveSessionModel();
  assert.deepStrictEqual(calls.setModel, ['']);
}

function testSessionPanelWorkflowControlsPanelAccessibilityAndFocus() {
  const { workflow, elements, calls } = createWorkflowFixture();
  workflow.openSessionPromptPanel();
  assert.strictEqual(elements.sessionPromptPanel.classList.contains('show'), true);
  assert.strictEqual(elements.sessionPromptPanel.getAttribute('aria-hidden'), 'false');
  assert.strictEqual(elements.sessionPromptInput.focusCount, 1);
  assert.deepStrictEqual(calls.timers, [60]);

  workflow.openSessionModelPanel();
  assert.strictEqual(elements.sessionPromptPanel.getAttribute('aria-hidden'), 'true');
  assert.strictEqual(elements.sessionModelPanel.getAttribute('aria-hidden'), 'false');
  assert.strictEqual(elements.sessionModelBtn.getAttribute('aria-expanded'), 'true');
  workflow.closeSessionModelPanel();
  assert.strictEqual(elements.sessionModelPanel.getAttribute('aria-hidden'), 'true');
  assert.strictEqual(elements.sessionModelBtn.getAttribute('aria-expanded'), 'false');
  assert.ok(calls.renderPrompt > 0);
  assert.ok(calls.renderModel > 0);
}

module.exports = [
  testSessionPanelWorkflowUsesExplicitDependenciesAndSavesSessionOverrides,
  testSessionPanelWorkflowControlsPanelAccessibilityAndFocus,
];
